const schedule = require('node-schedule');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const EventEmitter = require('events');

class DaemonManager extends EventEmitter {
    constructor(dataManager, notificationManager) {
        super();
        this.dataManager = dataManager;
        this.notificationManager = notificationManager;
        this.job = null;
        this.isRunning = false;
        
        // PID file for daemon management
        this.pidFile = path.join(dataManager.dataDir, 'tracker.pid');
        // Status file for IPC communication
        this.statusFile = path.join(dataManager.dataDir, 'daemon_status.json');
        
        // Setup graceful shutdown
        this.setupSignalHandlers();
    }

    setupSignalHandlers() {
        try {
            process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));
            process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));
            process.on('SIGHUP', () => this.gracefulShutdown('SIGHUP'));
        } catch (error) {
            console.warn('Warning: Could not setup signal handlers:', error.message);
        }
    }

    async gracefulShutdown(signal) {
        console.log(`\nReceived ${signal}, shutting down gracefully...`);
        await this.stop();
        process.exit(0);
    }

    async start() {
        // Check if another instance is already running
        if (this.isAlreadyRunning()) {
            throw new Error('Another instance is already running');
        }

        try {
            // Spawn background daemon process
            const scriptPath = path.join(__dirname, '..', 'bin', 'pulse');
            const child = spawn('node', [scriptPath, 'start', '--daemon'], {
                detached: true,
                stdio: ['ignore', 'ignore', 'ignore']
            });

            // Write PID file with child process PID
            await fs.writeFile(this.pidFile, child.pid.toString());
            
            // Unref the child so parent can exit
            child.unref();

            return true;
        } catch (error) {
            try {
                await fs.remove(this.pidFile);
            } catch (cleanupError) {
                // Ignore cleanup errors
            }
            throw error;
        }
    }

    async startDaemon() {
        // This method runs the actual daemon logic in the background process
        if (this.isRunning) {
            throw new Error('Daemon is already running');
        }

        try {
            // Write PID file
            await fs.writeFile(this.pidFile, process.pid.toString());

            // Get notification interval
            const interval = this.dataManager.getConfig('notificationInterval', 30);
            
            // Schedule notifications using a simpler approach for macOS compatibility
            const cronExpression = `*/${interval} * * * *`; // Every N minutes
            
            this.job = schedule.scheduleJob(cronExpression, async () => {
                try {
                    await this.sendCheckInNotification();
                } catch (error) {
                    console.error('Error in scheduled notification:', error.message);
                }
            });

            this.isRunning = true;
            console.log(`Daemon started with ${interval}-minute intervals`);
            
            // Send initial notification with error handling
            try {
                await this.sendCheckInNotification();
            } catch (error) {
                console.warn('Initial notification failed:', error.message);
                // Continue anyway - not critical for startup
            }
            
            // Setup notification handlers with error handling
            try {
                this.notificationManager.setupNotificationHandlers(
                    () => this.handleLogActivityRequest(),
                    () => this.handleDismiss()
                );
            } catch (error) {
                console.warn('Could not setup notification handlers:', error.message);
                // Continue anyway - not critical
            }
            
            // Start session monitoring if lock/unlock features are enabled
            // We need to import SessionManager here since this runs in the daemon process
            const SessionManager = require('./sessionManager');
            const Logger = require('./logger');
            const logger = new Logger(this.dataManager);
            this.sessionManager = new SessionManager(this, this.dataManager, logger);
            
            const sessionConfig = this.sessionManager.getConfig();
            if (sessionConfig.autoStartOnUnlock || sessionConfig.autoStopOnLock) {
                console.log('🔒 Starting session monitoring for lock/unlock detection...');
                await this.sessionManager.startSessionMonitoring();
                console.log('✅ Session monitoring started in daemon process');
            }
            
            // Write initial status
            await this.writeStatus();
            
            // Update status periodically
            this.statusInterval = setInterval(async () => {
                await this.writeStatus();
            }, 5000); // Update every 5 seconds
            
            // Also write a simple status file for easy checking
            await fs.writeFile(path.join(this.dataManager.dataDir, 'daemon_active.txt'), 
                `Daemon running since: ${new Date().toISOString()}\nSession monitoring: ${this.sessionManager ? 'active' : 'inactive'}`);
            
            // Emit a daemon started event that can be used by other components
            this.emit('daemon_started');

            // Keep process alive
            return new Promise((resolve, reject) => {
                const cleanup = async () => {
                    console.log('Daemon shutting down...');
                    await this.stop();
                    resolve();
                };

                process.on('SIGINT', cleanup);
                process.on('SIGTERM', cleanup);
                process.on('SIGHUP', cleanup);
            });
        } catch (error) {
            // Cleanup on error
            this.isRunning = false;
            if (this.job) {
                this.job.cancel();
                this.job = null;
            }
            try {
                await fs.remove(this.pidFile);
            } catch (cleanupError) {
                // Ignore cleanup errors
            }
            throw error;
        }
    }

    async stop() {
        // For background processes, we need to signal the PID from the file
        if (!this.isRunning && fs.existsSync(this.pidFile)) {
            try {
                const pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'));
                try {
                    process.kill(pid, 'SIGTERM');
                    // Wait a bit for graceful shutdown
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // Remove PID file
                    await fs.remove(this.pidFile);
                    console.log('Daemon stopped');
                    return;
                } catch (error) {
                    // Process might already be stopped, just clean up PID file
                    await fs.remove(this.pidFile);
                    console.log('Daemon was not running, cleaned up PID file');
                    return;
                }
            } catch (error) {
                console.error('Error stopping daemon:', error.message);
                return;
            }
        }

        if (!this.isRunning) {
            console.log('Daemon is not running');
            return;
        }

        try {
            // Cancel scheduled job
            if (this.job) {
                this.job.cancel();
                this.job = null;
            }
            
            // Cancel status update interval
            if (this.statusInterval) {
                clearInterval(this.statusInterval);
                this.statusInterval = null;
            }

            // Remove PID file and status file
            try {
                await fs.remove(this.pidFile);
                await fs.remove(this.statusFile);
            } catch (error) {
                // Ignore errors when removing files
            }

            this.isRunning = false;
            console.log('Daemon stopped');
        } catch (error) {
            console.error('Error stopping daemon:', error.message);
            throw error;
        }
    }

    isAlreadyRunning() {
        try {
            if (!fs.existsSync(this.pidFile)) {
                return false;
            }

            const pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'));
            
            // Check if process is actually running
            try {
                process.kill(pid, 0); // Doesn't actually kill, just checks if process exists
                return true;
            } catch (error) {
                // Process doesn't exist, remove stale PID file
                try {
                    fs.removeSync(this.pidFile);
                } catch (removeError) {
                    // Ignore removal errors
                }
                return false;
            }
        } catch (error) {
            return false;
        }
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            pidFileExists: fs.existsSync(this.pidFile),
            interval: this.dataManager.getConfig('notificationInterval', 30),
            nextRun: this.job ? this.job.nextInvocation() : null,
            sessionMonitoringActive: this.sessionManager ? this.sessionManager.isSessionMonitoringActive() : false,
            sessionState: this.sessionManager ? this.sessionManager.getCurrentSessionState() : null,
            lockState: this.sessionManager ? this.sessionManager.getCurrentLockState() : null
        };
    }
    
    async writeStatus() {
        try {
            const status = this.getStatus();
            status.timestamp = new Date().toISOString();
            await fs.writeJson(this.statusFile, status, { spaces: 2 });
        } catch (error) {
            console.warn('Failed to write status file:', error.message);
        }
    }
    
    async readStatus() {
        try {
            if (await fs.pathExists(this.statusFile)) {
                return await fs.readJson(this.statusFile);
            }
        } catch (error) {
            console.warn('Failed to read status file:', error.message);
        }
        return null;
    }

    async sendCheckInNotification() {
        const interval = this.dataManager.getConfig('notificationInterval', 30);
        const recentActivities = this.dataManager.getRecentActivities(2);
        const lastActivity = recentActivities.length > 0 ? recentActivities[recentActivities.length - 1] : null;

        try {
            await this.notificationManager.sendCheckInNotification(interval, lastActivity);
        } catch (error) {
            console.error('Error sending check-in notification:', error.message);
            // Use fallback notification
            this.notificationManager.fallbackNotification(
                'Productivity Check-in',
                `What have you been working on for the past ${interval} minutes?`
            );
        }
    }

    handleLogActivityRequest() {
        console.log('User requested to log activity via notification');
        // This could trigger a CLI prompt or other action
        // For now, just log the request
    }

    handleDismiss() {
        console.log('User dismissed notification');
    }

    // Run daemon in foreground (for testing)
    async runForeground() {
        console.log('Running pulse daemon in foreground...');
        console.log('Press Ctrl+C to stop');

        const interval = this.dataManager.getConfig('notificationInterval', 30);
        console.log(`Notifications scheduled every ${interval} minutes`);

        try {
            // Send initial notification
            await this.sendCheckInNotification();

            // Schedule recurring notifications
            const cronExpression = `*/${interval} * * * *`;
            this.job = schedule.scheduleJob(cronExpression, async () => {
                try {
                    await this.sendCheckInNotification();
                } catch (error) {
                    console.error('Scheduled notification error:', error.message);
                }
            });

            // Keep process alive
            return new Promise((resolve) => {
                const cleanup = () => {
                    console.log('\nStopping daemon...');
                    if (this.job) {
                        this.job.cancel();
                    }
                    resolve();
                };

                process.on('SIGINT', cleanup);
                process.on('SIGTERM', cleanup);
            });
        } catch (error) {
            console.error('Error running foreground daemon:', error.message);
            throw error;
        }
    }

    // Force stop any running daemon
    async forceStop() {
        try {
            if (fs.existsSync(this.pidFile)) {
                const pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'));
                try {
                    process.kill(pid, 'SIGTERM');
                    // Wait a bit for graceful shutdown
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // If still running, force kill
                    try {
                        process.kill(pid, 0);
                        process.kill(pid, 'SIGKILL');
                    } catch (error) {
                        // Process already stopped
                    }
                } catch (error) {
                    // Process doesn't exist
                }
                
                await fs.remove(this.pidFile);
                console.log('Forced stop of running daemon');
                return true;
            }
        } catch (error) {
            console.warn('Error during force stop:', error.message);
        }
        return false;
    }
}

module.exports = DaemonManager;

