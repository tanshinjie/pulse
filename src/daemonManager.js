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
        // Enhanced duplicate detection with cleanup
        await this.cleanupStaleDaemons();
        
        if (this.isAlreadyRunning()) {
            throw new Error('Another instance is already running');
        }

        // Create lock file to prevent race conditions
        const lockFile = path.join(this.dataManager.dataDir, 'daemon.lock');
        try {
            // Try to create lock file exclusively
            await fs.writeFile(lockFile, process.pid.toString(), { flag: 'wx' });
        } catch (error) {
            if (error.code === 'EEXIST') {
                throw new Error('Another daemon startup is in progress');
            }
            throw error;
        }

        try {
            // Double-check after acquiring lock
            if (this.isAlreadyRunning()) {
                throw new Error('Another instance is already running');
            }

            // Spawn background daemon process
            const scriptPath = path.join(__dirname, '..', 'bin', 'pulse');
            const child = spawn('node', [scriptPath, 'start', '--daemon'], {
                detached: true,
                stdio: ['ignore', 'ignore', 'ignore']
            });

            // Wait for child to start and write its own PID file
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Daemon startup timeout'));
                }, 5000);

                // Check every 100ms for PID file
                const checkInterval = setInterval(async () => {
                    if (fs.existsSync(this.pidFile)) {
                        clearTimeout(timeout);
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 100);
            });
            
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
        } finally {
            // Always cleanup lock file
            try {
                await fs.remove(lockFile);
            } catch (error) {
                // Ignore cleanup errors
            }
        }
    }

    async startDaemon() {
        // This method runs the actual daemon logic in the background process
        if (this.isRunning) {
            throw new Error('Daemon is already running');
        }

        try {
            console.log(`🚀 [Process ${process.pid}] Daemon starting up...`);
            
            // Check if this is an auto-restart after unlock by looking for recent pause activity
            const recentActivities = this.dataManager.getRecentActivities(5);
            const hasRecentLockPause = recentActivities.some(activity => 
                activity.activity && activity.activity.includes('Automatically paused (screen locked)')
            );
            
            // Also check if the last activity is already a resume to prevent duplicates
            const lastActivity = recentActivities.length > 0 ? recentActivities[recentActivities.length - 1] : null;
            const lastIsResume = lastActivity && lastActivity.activity && 
                                lastActivity.activity.includes('Automatically resumed (screen unlocked)');
            
            if (hasRecentLockPause && !lastIsResume) {
                console.log('🔓 Detected auto-restart after screen unlock, adding resume activity');
                this.dataManager.addActivity('Automatically resumed (screen unlocked)');
            } else if (lastIsResume) {
                console.log('⏩ Last activity is already a resume, skipping duplicate');
            }
            
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
            
            // Send initial test notification with error handling
            try {
                await this.notificationManager.testNotification();
            } catch (error) {
                console.warn('Initial test notification failed:', error.message);
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
        console.log('🛑 Stopping daemon(s)...');
        
        // Enhanced stop logic: Find and stop ALL daemon processes
        try {
            // First, find all running daemon processes
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            
            let stoppedProcesses = 0;
            
            try {
                const { stdout } = await execAsync('ps aux | grep "pulse.*--daemon" | grep -v grep');
                const processes = stdout.split('\n').filter(line => line.trim());
                
                if (processes.length > 0) {
                    console.log(`🔍 Found ${processes.length} daemon process(es) to stop`);
                    
                    // Parse PIDs and stop each process
                    const pids = processes.map(line => {
                        const parts = line.trim().split(/\s+/);
                        return parseInt(parts[1]); // PID is second column
                    }).filter(pid => !isNaN(pid));
                    
                    for (const pid of pids) {
                        try {
                            console.log(`🔫 Stopping daemon process ${pid}...`);
                            process.kill(pid, 'SIGTERM');
                            stoppedProcesses++;
                        } catch (error) {
                            console.warn(`Failed to stop process ${pid}:`, error.message);
                        }
                    }
                    
                    // Wait for graceful shutdown
                    if (stoppedProcesses > 0) {
                        console.log('⏳ Waiting for graceful shutdown...');
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        // Check if any are still running and force kill them
                        try {
                            const { stdout: stillRunning } = await execAsync('ps aux | grep "pulse.*--daemon" | grep -v grep');
                            const stillRunningProcesses = stillRunning.split('\n').filter(line => line.trim());
                            
                            if (stillRunningProcesses.length > 0) {
                                console.log(`💀 Force killing ${stillRunningProcesses.length} stubborn process(es)...`);
                                const stubborn_pids = stillRunningProcesses.map(line => {
                                    const parts = line.trim().split(/\s+/);
                                    return parseInt(parts[1]);
                                }).filter(pid => !isNaN(pid));
                                
                                for (const pid of stubborn_pids) {
                                    try {
                                        process.kill(pid, 'SIGKILL');
                                        console.log(`💀 Force killed process ${pid}`);
                                    } catch (error) {
                                        // Process already dead
                                    }
                                }
                            }
                        } catch (error) {
                            // No processes still running - that's good
                        }
                    }
                }
            } catch (error) {
                // No daemon processes found via ps
                console.log('ℹ️ No daemon processes found via ps command');
            }
            
            // Also handle the traditional single PID file approach
            if (fs.existsSync(this.pidFile)) {
                try {
                    const pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'));
                    try {
                        process.kill(pid, 'SIGTERM');
                        console.log(`🔫 Also stopped daemon from PID file: ${pid}`);
                        stoppedProcesses++;
                    } catch (error) {
                        // Process might already be stopped
                    }
                } catch (error) {
                    console.warn('Error reading PID file:', error.message);
                }
                
                // Clean up PID file
                await fs.remove(this.pidFile);
            }
            
            // Handle current process if it's a daemon
            if (this.isRunning) {
                console.log('🔫 Stopping current daemon process...');
                
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
                
                this.isRunning = false;
                stoppedProcesses++;
            }
            
            // Clean up status files
            try {
                await fs.remove(this.statusFile);
                await fs.remove(path.join(this.dataManager.dataDir, 'daemon_active.txt'));
            } catch (error) {
                // Ignore cleanup errors
            }
            
            if (stoppedProcesses > 0) {
                console.log(`✅ Successfully stopped ${stoppedProcesses} daemon process(es)`);
            } else {
                console.log('ℹ️ No daemon processes were running');
            }
            
        } catch (error) {
            console.error('❌ Error during daemon stop:', error.message);
            throw error;
        }
    }

    isAlreadyRunning() {
        try {
            // Enhanced daemon detection: check for ANY daemon processes
            const { execSync } = require('child_process');
            
            try {
                const stdout = execSync('ps aux | grep "pulse.*--daemon" | grep -v grep', { encoding: 'utf8' });
                const processes = stdout.split('\n').filter(line => line.trim());
                
                if (processes.length > 0) {
                    console.log(`🔍 Found ${processes.length} running daemon process(es)`);
                    return true;
                }
            } catch (error) {
                // No daemon processes found via ps
            }
            
            // Also check traditional PID file method as fallback
            if (fs.existsSync(this.pidFile)) {
                const pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'));
                
                // Check if process is actually running
                try {
                    process.kill(pid, 0); // Doesn't actually kill, just checks if process exists
                    console.log(`🔍 Found daemon via PID file: ${pid}`);
                    return true;
                } catch (error) {
                    // Process doesn't exist, remove stale PID file
                    try {
                        fs.removeSync(this.pidFile);
                        console.log('🗑️ Removed stale PID file');
                    } catch (removeError) {
                        // Ignore removal errors
                    }
                }
            }
            
            return false;
        } catch (error) {
            console.warn('Error checking if daemon is running:', error.message);
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
            // Send initial test notification
            await this.notificationManager.testNotification();

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
    
    // Clean up stale daemon processes and PID files
    async cleanupStaleDaemons() {
        try {
            console.log('🧹 Cleaning up stale daemon processes...');
            
            // Find all pulse daemon processes
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            
            try {
                const { stdout } = await execAsync('ps aux | grep "pulse.*--daemon" | grep -v grep');
                const processes = stdout.split('\n').filter(line => line.trim());
                
                console.log(`Found ${processes.length} daemon processes`);
                
                if (processes.length > 1) {
                    console.warn(`⚠️ Multiple daemon processes detected! Cleaning up duplicates...`);
                    
                    // Parse PIDs from ps output
                    const pids = processes.map(line => {
                        const parts = line.trim().split(/\s+/);
                        return parseInt(parts[1]); // PID is second column
                    }).filter(pid => !isNaN(pid));
                    
                    // Keep the oldest process (first in list) and kill the rest
                    const pidsToKill = pids.slice(1);
                    
                    for (const pid of pidsToKill) {
                        try {
                            console.log(`🔫 Killing duplicate daemon process ${pid}`);
                            process.kill(pid, 'SIGTERM');
                            
                            // Wait a bit, then force kill if needed
                            setTimeout(() => {
                                try {
                                    process.kill(pid, 0); // Check if still running
                                    process.kill(pid, 'SIGKILL');
                                    console.log(`💀 Force killed process ${pid}`);
                                } catch (error) {
                                    // Process already dead
                                }
                            }, 2000);
                            
                        } catch (error) {
                            console.warn(`Failed to kill process ${pid}:`, error.message);
                        }
                    }
                }
            } catch (error) {
                // No processes found or ps command failed - that's okay
                console.log('No duplicate daemon processes found');
            }
            
            // Clean up any orphaned PID files
            if (fs.existsSync(this.pidFile)) {
                try {
                    const pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'));
                    process.kill(pid, 0); // Check if process exists
                    console.log(`✅ PID file valid - process ${pid} is running`);
                } catch (error) {
                    // Process doesn't exist, remove stale PID file
                    console.log('🗑️ Removing stale PID file');
                    await fs.remove(this.pidFile);
                }
            }
            
        } catch (error) {
            console.warn('Error during stale daemon cleanup:', error.message);
        }
    }
}

module.exports = DaemonManager;

