const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { spawn, exec } = require('child_process');
const EventEmitter = require('events');

class SessionManager extends EventEmitter {
    constructor(daemonManager, dataManager, logger = null) {
        super();
        this.daemonManager = daemonManager;
        this.dataManager = dataManager;
        this.logger = logger;
        this.platform = os.platform();
        this.isMonitoring = false;
        this.monitorProcess = null;
        this.lastSessionState = null;
        this.lastLockState = null; // null = unknown, true = locked, false = unlocked
        this.lockPollInterval = null;
        
        // Configuration
        this.config = {
            autoStart: this.dataManager.getConfig('autoStartOnLogin', false),
            autoStop: this.dataManager.getConfig('autoStopOnLogout', false),
            autoStartOnUnlock: this.dataManager.getConfig('autoStartOnUnlock', false),
            autoStopOnLock: this.dataManager.getConfig('autoStopOnLock', false),
            checkInterval: this.dataManager.getConfig('sessionCheckInterval', 30) // seconds
        };
        
        // Note: Event-based communication removed since daemon runs in separate process
        // Session monitoring is now started directly in the daemon process
    }

    async startSessionMonitoring() {
        if (this.isMonitoring) {
            if (this.logger) await this.logger.logSessionEvent('start_monitoring_skipped', { reason: 'already_running' });
            return;
        }

        console.log(`Starting session monitoring for ${this.platform}...`);
        if (this.logger) await this.logger.logSessionEvent('start_monitoring', { 
            platform: this.platform,
            config: this.config 
        });
        this.isMonitoring = true;

        // Start login/logout monitoring
        switch (this.platform) {
            case 'darwin':
                await this.startMacOSMonitoring();
                break;
            case 'linux':
                await this.startLinuxMonitoring();
                break;
            case 'win32':
                await this.startWindowsMonitoring();
                break;
            default:
                console.warn(`Session monitoring not implemented for platform: ${this.platform}`);
                if (this.logger) await this.logger.warn('session', `Platform ${this.platform} not fully supported, using fallback`);
                // Fallback to basic polling
                await this.startFallbackMonitoring();
        }
        
        // Start lock/unlock monitoring
        await this.startLockMonitoring();
    }

    async stopSessionMonitoring() {
        if (!this.isMonitoring) {
            if (this.logger) await this.logger.logSessionEvent('stop_monitoring_skipped', { reason: 'not_running' });
            return;
        }

        console.log('Stopping session monitoring...');
        if (this.logger) await this.logger.logSessionEvent('stop_monitoring', { platform: this.platform });
        this.isMonitoring = false;

        if (this.monitorProcess) {
            this.monitorProcess.kill();
            this.monitorProcess = null;
        }

        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        
        if (this.lockPollInterval) {
            clearInterval(this.lockPollInterval);
            this.lockPollInterval = null;
            if (this.logger) {
                await this.logger.logSessionEvent('macos_lock_monitoring_stopped', { 
                    reason: 'session_monitoring_stopped',
                    platform: this.platform 
                });
            }
        }
    }

    async startMacOSMonitoring() {
        // Monitor using 'who' command and system logs
        this.pollInterval = setInterval(async () => {
            try {
                await this.checkMacOSSession();
            } catch (error) {
                console.warn('Session check error:', error.message);
                if (this.logger) await this.logger.warn('session', 'macOS session check failed', { error: error.message });
            }
        }, this.config.checkInterval * 1000);

        // Initial check
        await this.checkMacOSSession();
    }

    async checkMacOSSession() {
        return new Promise((resolve) => {
            // Check if current user has active GUI session
            exec('who | grep console', (error, stdout) => {
                const hasActiveSession = !error && stdout.trim().length > 0;
                this.handleSessionStateChange(hasActiveSession);
                resolve();
            });
        });
    }

    async startLinuxMonitoring() {
        // Try systemd loginctl first
        if (await this.hasSystemd()) {
            await this.startSystemdMonitoring();
        } else {
            // Fallback to file monitoring
            await this.startLinuxFileMonitoring();
        }
    }

    async hasSystemd() {
        return new Promise((resolve) => {
            exec('command -v loginctl', (error) => {
                resolve(!error);
            });
        });
    }

    async startSystemdMonitoring() {
        this.pollInterval = setInterval(async () => {
            try {
                await this.checkLinuxSystemdSession();
            } catch (error) {
                console.warn('Systemd session check error:', error.message);
            }
        }, this.config.checkInterval * 1000);

        await this.checkLinuxSystemdSession();
    }

    async checkLinuxSystemdSession() {
        return new Promise((resolve) => {
            const userId = process.getuid();
            exec(`loginctl list-sessions --no-legend | grep ${userId}`, (error, stdout) => {
                const hasActiveSession = !error && stdout.trim().length > 0;
                this.handleSessionStateChange(hasActiveSession);
                resolve();
            });
        });
    }

    async startLinuxFileMonitoring() {
        // Monitor /var/run/utmp for login/logout events
        this.pollInterval = setInterval(async () => {
            try {
                await this.checkLinuxFileSession();
            } catch (error) {
                console.warn('File session check error:', error.message);
            }
        }, this.config.checkInterval * 1000);

        await this.checkLinuxFileSession();
    }

    async checkLinuxFileSession() {
        return new Promise((resolve) => {
            const username = os.userInfo().username;
            exec(`who | grep ${username}`, (error, stdout) => {
                const hasActiveSession = !error && stdout.trim().length > 0;
                this.handleSessionStateChange(hasActiveSession);
                resolve();
            });
        });
    }

    async startWindowsMonitoring() {
        // For Windows, we'll use a polling approach checking for active sessions
        this.pollInterval = setInterval(async () => {
            try {
                await this.checkWindowsSession();
            } catch (error) {
                console.warn('Windows session check error:', error.message);
            }
        }, this.config.checkInterval * 1000);

        await this.checkWindowsSession();
    }

    async checkWindowsSession() {
        return new Promise((resolve) => {
            // Check if there's an active user session
            exec('query user', (error, stdout) => {
                if (error) {
                    // Fallback: assume session is active if query fails
                    this.handleSessionStateChange(true);
                } else {
                    const hasActiveSession = stdout.includes('Active') || stdout.includes(os.userInfo().username);
                    this.handleSessionStateChange(hasActiveSession);
                }
                resolve();
            });
        });
    }

    async startFallbackMonitoring() {
        // Basic fallback monitoring - just check if process can access user resources
        this.pollInterval = setInterval(async () => {
            try {
                // Simple heuristic: if we can access the home directory, assume session is active
                const homeDir = os.homedir();
                const canAccess = await fs.pathExists(homeDir);
                this.handleSessionStateChange(canAccess);
            } catch (error) {
                console.warn('Fallback session check error:', error.message);
                this.handleSessionStateChange(true); // Assume active on error
            }
        }, this.config.checkInterval * 1000);
    }

    handleSessionStateChange(isActive) {
        if (this.lastSessionState === isActive) {
            return; // No change
        }

        const previousState = this.lastSessionState;
        this.lastSessionState = isActive;

        if (previousState === null) {
            // Initial state
            console.log(`Initial session state: ${isActive ? 'active' : 'inactive'}`);
            if (this.logger) {
                this.logger.logSessionEvent('initial_state_detected', { 
                    isActive, 
                    platform: this.platform 
                });
            }
            return;
        }

        if (isActive && !previousState) {
            // User logged in
            console.log('User session detected - login event');
            if (this.logger) {
                this.logger.logSessionEvent('login_detected', { 
                    previousState, 
                    currentState: isActive,
                    autoStartEnabled: this.config.autoStart
                });
            }
            this.emit('login');
            this.handleLogin();
        } else if (!isActive && previousState) {
            // User logged out
            console.log('User session ended - logout event');
            if (this.logger) {
                this.logger.logSessionEvent('logout_detected', { 
                    previousState, 
                    currentState: isActive,
                    autoStopEnabled: this.config.autoStop
                });
            }
            this.emit('logout');
            this.handleLogout();
        }
    }

    async handleLogin() {
        if (!this.config.autoStart) {
            if (this.logger) await this.logger.logSessionEvent('auto_start_skipped', { reason: 'disabled' });
            return;
        }

        try {
            if (!this.daemonManager.isAlreadyRunning()) {
                console.log('Auto-starting daemon on user login...');
                if (this.logger) await this.logger.logSessionEvent('auto_start_attempting', { trigger: 'login' });
                await this.daemonManager.start();
                console.log('Daemon auto-started successfully');
                if (this.logger) await this.logger.logSessionEvent('auto_start_success', { trigger: 'login' });
            } else {
                if (this.logger) await this.logger.logSessionEvent('auto_start_skipped', { reason: 'already_running' });
            }
        } catch (error) {
            console.error('Failed to auto-start daemon on login:', error.message);
            if (this.logger) await this.logger.logError('session', error, { action: 'auto_start', trigger: 'login' });
        }
    }

    async handleLogout() {
        if (!this.config.autoStop) {
            if (this.logger) await this.logger.logSessionEvent('auto_stop_skipped', { reason: 'disabled' });
            return;
        }

        try {
            if (this.daemonManager.isAlreadyRunning()) {
                console.log('Auto-stopping daemon on user logout...');
                if (this.logger) await this.logger.logSessionEvent('auto_stop_attempting', { trigger: 'logout' });
                
                // Enhanced data persistence before shutdown
                await this.ensureDataPersistence('user logged out');
                
                await this.daemonManager.stop();
                console.log('Daemon auto-stopped successfully');
                if (this.logger) await this.logger.logSessionEvent('auto_stop_success', { trigger: 'logout' });
            } else {
                if (this.logger) await this.logger.logSessionEvent('auto_stop_skipped', { reason: 'not_running' });
            }
        } catch (error) {
            console.error('Failed to auto-stop daemon on logout:', error.message);
            if (this.logger) await this.logger.logError('session', error, { action: 'auto_stop', trigger: 'logout' });
        }
    }

    updateConfig(key, value) {
        // Map external keys to internal config keys
        const configMap = {
            'autoStartOnLogin': 'autoStart',
            'autoStopOnLogout': 'autoStop',
            'autoStartOnUnlock': 'autoStartOnUnlock',
            'autoStopOnLock': 'autoStopOnLock',
            'sessionCheckInterval': 'checkInterval'
        };
        
        const internalKey = configMap[key];
        if (internalKey && internalKey in this.config) {
            const oldValue = this.config[internalKey];
            this.config[internalKey] = value;
            this.dataManager.setConfig(key, value); // Save with external key
            if (this.logger) {
                this.logger.logSessionEvent('config_updated', { 
                    key, 
                    internalKey,
                    newValue: value, 
                    oldValue 
                });
            }
            return true;
        }
        return false;
    }

    getConfig() {
        return { ...this.config };
    }

    isSessionMonitoringActive() {
        return this.isMonitoring;
    }

    getCurrentSessionState() {
        return this.lastSessionState;
    }
    
    getCurrentLockState() {
        return this.lastLockState;
    }
    
    // Lock/unlock monitoring implementation
    async startLockMonitoring() {
        console.log('Starting lock/unlock monitoring...');
        if (this.logger) await this.logger.logSessionEvent('lock_monitoring_started', { platform: this.platform });
        
        switch (this.platform) {
            case 'darwin':
                await this.startMacOSLockMonitoring();
                break;
            case 'linux':
                await this.startLinuxLockMonitoring();
                break;
            case 'win32':
                await this.startWindowsLockMonitoring();
                break;
            default:
                console.warn(`Lock monitoring not implemented for platform: ${this.platform}`);
                if (this.logger) await this.logger.warn('session', `Lock monitoring for platform ${this.platform} not supported`);
        }
    }
    
    async startMacOSLockMonitoring() {
        console.log('🔒 Starting macOS lock/unlock monitoring...');
        console.log(`🕒 Check interval: ${this.config.checkInterval} seconds`);
        
        // Log the start of monitoring
        if (this.logger) {
            await this.logger.logSessionEvent('macos_lock_monitoring_started', { 
                checkInterval: this.config.checkInterval,
                platform: this.platform 
            });
        }
        
        // On macOS, we can check the screensaver state using multiple methods
        this.lockPollInterval = setInterval(async () => {
            try {
                // Log each polling cycle to verify it's running
                if (this.logger) {
                    await this.logger.debug('session', 'macOS lock monitoring polling cycle started');
                }
                await this.checkMacOSLockState();
                if (this.logger) {
                    await this.logger.debug('session', 'macOS lock monitoring polling cycle completed');
                }
            } catch (error) {
                console.warn('Lock state check error:', error.message);
                if (this.logger) await this.logger.warn('session', 'macOS lock check failed', { error: error.message });
            }
        }, this.config.checkInterval * 1000);
        
        // Log that the interval has been set up
        if (this.logger) {
            await this.logger.logSessionEvent('macos_lock_polling_interval_set', { 
                intervalMs: this.config.checkInterval * 1000,
                intervalSeconds: this.config.checkInterval 
            });
        }
        
        // Initial check
        console.log('🔍 Performing initial lock state check...');
        if (this.logger) {
            await this.logger.debug('session', 'Performing initial macOS lock state check');
        }
        await this.checkMacOSLockState();
        
        // Log that monitoring is now active
        if (this.logger) {
            await this.logger.logSessionEvent('macos_lock_monitoring_active', { 
                status: 'running',
                nextCheckIn: this.config.checkInterval 
            });
        }
    }
    
    async checkMacOSLockState() {
        return new Promise((resolve) => {
            console.log('🔍 Checking macOS lock state...');
            
            // Simplified and more reliable lock detection
            // Use a combination of methods to determine lock state more accurately
            
            let lockCheckPromises = [];
            let lockCheckResults = [];
            
            // Method 1: Check if screensaver is running
            const screensaverCheck = new Promise((resolveCheck) => {
                exec('pgrep -x ScreenSaverEngine', (error, stdout) => {
                    const screensaverActive = !error && stdout.trim().length > 0;
                    console.log(`🔍 ScreenSaverEngine check: ${screensaverActive ? 'active' : 'inactive'}`);
                    resolveCheck({ method: 'screensaver', locked: screensaverActive, confidence: screensaverActive ? 0.9 : 0.1 });
                });
            });
            
            // Method 2: Check display brightness (more reliable than power state)
            const brightnessCheck = new Promise((resolveCheck) => {
                exec('brightness -l', (error, stdout) => {
                    if (error) {
                        // If brightness command fails, try system_profiler
                        exec('system_profiler SPDisplaysDataType | grep Resolution', (error2, stdout2) => {
                            const displaysDetected = !error2 && stdout2.trim().length > 0;
                            console.log(`🔍 Display detection: ${displaysDetected ? 'displays active' : 'no active displays'}`);
                            resolveCheck({ method: 'display', locked: !displaysDetected, confidence: 0.3 });
                        });
                    } else {
                        // If we can read brightness, screen is likely unlocked
                        const hasOutput = stdout.trim().length > 0;
                        console.log(`🔍 Brightness check: ${hasOutput ? 'readable' : 'not readable'}`);
                        resolveCheck({ method: 'brightness', locked: !hasOutput, confidence: hasOutput ? 0.7 : 0.5 });
                    }
                });
            });
            
            // Method 3: Check if we can access UI elements via AppleScript
            const uiAccessCheck = new Promise((resolveCheck) => {
                const quickUIScript = `
                tell application "System Events"
                    try
                        -- Try to get desktop items (only works when unlocked)
                        set desktopItems to count of desktop 1
                        return true
                    on error
                        return false
                    end try
                end tell`;
                
                exec(`osascript -e '${quickUIScript}'`, (error, stdout) => {
                    const canAccessUI = !error && stdout.trim() === 'true';
                    console.log(`🔍 UI access check: ${canAccessUI ? 'accessible' : 'blocked'}`);
                    resolveCheck({ method: 'ui_access', locked: !canAccessUI, confidence: canAccessUI ? 0.8 : 0.6 });
                });
            });
            
            lockCheckPromises.push(screensaverCheck, brightnessCheck, uiAccessCheck);
            
            // Wait for all checks to complete (with timeout)
            const checkTimeout = setTimeout(() => {
                console.log('⏰ Lock state check timeout, using available results');
                this.evaluateLockState(lockCheckResults, resolve);
            }, 5000); // 5 second timeout
            
            Promise.allSettled(lockCheckPromises).then((results) => {
                clearTimeout(checkTimeout);
                lockCheckResults = results.filter(r => r.status === 'fulfilled').map(r => r.value);
                this.evaluateLockState(lockCheckResults, resolve);
            });
        });
    }
    
    // Evaluate lock state based on multiple check results
    evaluateLockState(results, resolve) {
        console.log(`🔍 Evaluating lock state from ${results.length} checks:`, results);
        
        if (results.length === 0) {
            console.log('🤷 No lock check results available, assuming unlocked');
            this.handleLockStateChange(false);
            resolve();
            return;
        }
        
        // Calculate weighted score
        let lockedScore = 0;
        let totalConfidence = 0;
        
        results.forEach(result => {
            const weight = result.locked ? result.confidence : (1 - result.confidence);
            lockedScore += weight;
            totalConfidence += result.confidence;
        });
        
        const averageScore = lockedScore / results.length;
        const isLocked = averageScore > 0.5;
        
        console.log(`🔍 Lock state evaluation: score=${averageScore.toFixed(2)}, locked=${isLocked}`);
        
        // Log high-confidence results
        const highConfidenceResults = results.filter(r => r.confidence > 0.7);
        if (highConfidenceResults.length > 0) {
            const definitiveResult = highConfidenceResults.find(r => r.locked);
            if (definitiveResult) {
                console.log(`🔒 High confidence lock detection via ${definitiveResult.method}`);
                this.handleLockStateChange(true);
                resolve();
                return;
            }
        }
        
        this.handleLockStateChange(isLocked);
        resolve();
    }
    
    async startLinuxLockMonitoring() {
        // For Linux, we can use dbus-monitor to watch for lock/unlock signals
        // This is a simplified implementation - a real one would use proper dbus bindings
        this.lockPollInterval = setInterval(async () => {
            try {
                await this.checkLinuxLockState();
            } catch (error) {
                console.warn('Linux lock check error:', error.message);
            }
        }, this.config.checkInterval * 1000);
        
        // Initial check
        await this.checkLinuxLockState();
    }
    
    async checkLinuxLockState() {
        return new Promise((resolve) => {
            // Try to detect screen lock state using loginctl
            exec('loginctl show-session $(loginctl | grep $(whoami) | awk "{print $1}") -p Type -p Active', (error, stdout) => {
                let isLocked = false;
                
                if (!error && stdout.includes('Active=yes')) {
                    // Session is active, but we need to check if screen is locked
                    // This is a simplified check - real implementation would use dbus
                    exec('ps aux | grep -E "(i3lock|xscreensaver|gnome-screensaver|light-locker)" | grep -v grep', (err, out) => {
                        isLocked = !err && out.trim().length > 0;
                        this.handleLockStateChange(isLocked);
                        resolve();
                    });
                } else {
                    this.handleLockStateChange(true); // Assume locked if session check fails
                    resolve();
                }
            });
        });
    }
    
    async startWindowsLockMonitoring() {
        // For Windows, we can use a PowerShell script to check session lock state
        this.lockPollInterval = setInterval(async () => {
            try {
                await this.checkWindowsLockState();
            } catch (error) {
                console.warn('Windows lock check error:', error.message);
            }
        }, this.config.checkInterval * 1000);
        
        // Initial check
        await this.checkWindowsLockState();
    }
    
    async checkWindowsLockState() {
        return new Promise((resolve) => {
            // Check if workstation is locked using PowerShell
            const psScript = 'Add-Type -TypeDefinition "@\n' +
                'using System;\n' +
                'using System.Runtime.InteropServices;\n' +
                'public class Workstation {\n' +
                '    [DllImport(\"user32.dll\")]\n' +
                '    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);\n' +
                '    public struct LASTINPUTINFO {\n' +
                '        public uint cbSize;\n' +
                '        public uint dwTime;\n' +
                '    }\n' +
                '    public static DateTime GetLastInputTime() {\n' +
                '        LASTINPUTINFO lii = new LASTINPUTINFO();\n' +
                '        lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));\n' +
                '        GetLastInputInfo(ref lii);\n' +
                '        return DateTime.Now.AddMilliseconds(-(Environment.TickCount - lii.dwTime));\n' +
                '    }\n' +
                '}\n' +
                '@"; [Workstation]::GetLastInputTime()';
                
            exec(`powershell -Command "${psScript}"`, (error, stdout) => {
                if (error) {
                    // Assume locked on error
                    this.handleLockStateChange(true);
                } else {
                    try {
                        // If last input was more than 2 minutes ago, consider it locked
                        const lastInput = new Date(stdout.trim());
                        const now = new Date();
                        const diffMinutes = (now - lastInput) / (1000 * 60);
                        this.handleLockStateChange(diffMinutes > 2);
                    } catch (parseError) {
                        console.warn('Error parsing last input time:', parseError.message);
                        this.handleLockStateChange(false); // Default to unlocked on parse error
                    }
                }
                resolve();
            });
        });
    }
    
    handleLockStateChange(isLocked) {
        console.log(`🔍 handleLockStateChange called with isLocked=${isLocked}, previousState=${this.lastLockState}`);
        
        if (this.lastLockState === isLocked) {
            console.log('⏭️ No state change detected, skipping');
            return; // No change
        }
        
        const previousState = this.lastLockState;
        this.lastLockState = isLocked;
        
        console.log(`🔄 Lock state changed: ${previousState === null ? 'initial' : previousState ? 'locked' : 'unlocked'} -> ${isLocked ? 'locked' : 'unlocked'}`);
        
        if (previousState === null) {
            // Initial state
            console.log(`🔰 Initial lock state: ${isLocked ? 'locked' : 'unlocked'}`);
            if (this.logger) {
                this.logger.logSessionEvent('initial_lock_state_detected', { 
                    isLocked, 
                    platform: this.platform 
                });
            }
            return;
        }
        
        if (!isLocked && previousState) {
            // Screen unlocked
            console.log('🔓 Screen unlock transition detected');
            if (this.logger) {
                this.logger.logSessionEvent('unlock_detected', { 
                    previousState, 
                    currentState: isLocked,
                    autoStartEnabled: this.config.autoStartOnUnlock
                });
            }
            this.emit('unlock');
            this.handleUnlock();
        } else if (isLocked && !previousState) {
            // Screen locked
            console.log('🔒 Screen lock transition detected');
            if (this.logger) {
                this.logger.logSessionEvent('lock_detected', { 
                    previousState, 
                    currentState: isLocked,
                    autoStopEnabled: this.config.autoStopOnLock
                });
            }
            this.emit('lock');
            this.handleLock();
        }
    }
    
    async handleUnlock() {
        console.log(`🔓 [Process ${process.pid}] handleUnlock called - screen unlocked detected`);
        console.log(`🔧 autoStartOnUnlock config: ${this.config.autoStartOnUnlock}`);
        
        if (!this.config.autoStartOnUnlock) {
            console.log('❌ Auto-start on unlock is disabled in config, skipping');
            if (this.logger) await this.logger.logSessionEvent('auto_start_skipped', { reason: 'unlock_disabled' });
            return;
        }
        
        // CRITICAL FIX: Check if this process is itself a daemon process
        // If so, it should NOT spawn another daemon!
        const isDaemonProcess = this.daemonManager.isRunning || process.argv.includes('--daemon');
        console.log(`🔍 Is this process a daemon? ${isDaemonProcess}`);
        
        if (isDaemonProcess) {
            console.log('✅ This process is already the daemon - no need to start another');
            console.log('🔓 Daemon resumed from screen unlock');
            
            // Just log the resume activity since this daemon is continuing to run
            const recentActivities = this.dataManager.getRecentActivities(3);
            const lastActivity = recentActivities.length > 0 ? recentActivities[recentActivities.length - 1] : null;
            const lastIsResume = lastActivity && lastActivity.activity && 
                                lastActivity.activity.includes('Automatically resumed');
                                
            if (!lastIsResume) {
                this.dataManager.addActivity('Automatically resumed (screen unlocked)');
                console.log('📝 Added resume activity to current daemon process');
            }
            
            if (this.logger) await this.logger.logSessionEvent('daemon_resume_on_unlock', { trigger: 'unlock' });
            return;
        }
        
        try {
            // Add extra delay to ensure previous daemon has fully shut down
            console.log('⏳ Waiting for potential previous daemon shutdown...');
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            const isRunning = this.daemonManager.isAlreadyRunning();
            console.log(`🔍 Daemon running status: ${isRunning ? 'running' : 'not running'}`);
            
            if (!isRunning) {
                console.log('🚀 Auto-starting daemon on screen unlock...');
                if (this.logger) await this.logger.logSessionEvent('auto_start_attempting', { trigger: 'unlock' });
                
                // Check current data before starting
                console.log(`📊 Current activities count before restart: ${this.dataManager.activities.length}`);
                
                await this.daemonManager.start();
                
                console.log('✅ Daemon auto-started successfully on unlock');
                if (this.logger) await this.logger.logSessionEvent('auto_start_success', { trigger: 'unlock' });
            } else {
                console.log('⏩ Daemon already running, skipping auto-start');
                if (this.logger) await this.logger.logSessionEvent('auto_start_skipped', { reason: 'already_running', trigger: 'unlock' });
            }
        } catch (error) {
            console.error('❌ Failed to auto-start daemon on unlock:', error.message);
            if (this.logger) await this.logger.logError('session', error, { action: 'auto_start', trigger: 'unlock' });
        }
    }
    
    async handleLock() {
        console.log('🔒 handleLock called - screen lock detected');
        console.log(`🔧 autoStopOnLock config: ${this.config.autoStopOnLock}`);
        console.log(`🔧 autoStartOnUnlock config: ${this.config.autoStartOnUnlock}`);
        
        if (!this.config.autoStopOnLock) {
            console.log('❌ Auto-stop on lock is disabled in config, skipping');
            if (this.logger) await this.logger.logSessionEvent('auto_stop_skipped', { reason: 'lock_disabled' });
            return;
        }
        
        // CRITICAL FIX: If both auto-stop on lock AND auto-start on unlock are enabled,
        // the daemon should NOT actually stop - just pause activity tracking
        // Otherwise there would be no daemon running to detect unlock!
        const shouldKeepRunningForUnlock = this.config.autoStartOnUnlock;
        
        if (shouldKeepRunningForUnlock) {
            console.log('🔄 Both auto-stop and auto-start enabled - daemon will pause (not stop) to handle unlock');
            
            // Just log the pause activity and save data, but keep daemon running
            const recentActivities = this.dataManager.getRecentActivities(3);
            const lastActivity = recentActivities.length > 0 ? recentActivities[recentActivities.length - 1] : null;
            const lastIsPause = lastActivity && lastActivity.activity && 
                               lastActivity.activity.includes('Automatically paused');
            
            if (!lastIsPause) {
                console.log('📝 Adding pause activity (daemon continues running)');
                this.dataManager.addActivity('Automatically paused (screen locked)');
                this.dataManager.saveActivities();
                this.dataManager.saveConfig();
            }
            
            console.log('⏸️ Daemon paused for screen lock (will auto-resume on unlock)');
            if (this.logger) await this.logger.logSessionEvent('daemon_pause_on_lock', { trigger: 'lock' });
            return;
        }
        
        try {
            const isRunning = this.daemonManager.isAlreadyRunning();
            console.log(`🔍 Daemon running status: ${isRunning ? 'running' : 'not running'}`);
            
            if (isRunning) {
                console.log('🛑 Auto-stopping daemon on screen lock...');
                if (this.logger) await this.logger.logSessionEvent('auto_stop_attempting', { trigger: 'lock' });
                
                // Enhanced data persistence before shutdown
                await this.ensureDataPersistence('screen locked');
                
                await this.daemonManager.stop();
                console.log('✅ Daemon auto-stopped successfully on lock');
                if (this.logger) await this.logger.logSessionEvent('auto_stop_success', { trigger: 'lock' });
            } else {
                console.log('⏩ Daemon not running, skipping auto-stop');
                if (this.logger) await this.logger.logSessionEvent('auto_stop_skipped', { reason: 'not_running', trigger: 'lock' });
            }
        } catch (error) {
            console.error('❌ Failed to auto-stop daemon on lock:', error.message);
            if (this.logger) await this.logger.logError('session', error, { action: 'auto_stop', trigger: 'lock' });
        }
    }
    
    // Enhanced data persistence method to prevent data loss
    async ensureDataPersistence(reason) {
        console.log(`💾 [Process ${process.pid}] Ensuring data persistence before shutdown...`);
        console.log(`📊 Current activities count: ${this.dataManager.activities.length}`);
        
        try {
            // Check if the last activity is already a pause to prevent duplicates
            const recentActivities = this.dataManager.getRecentActivities(3);
            const lastActivity = recentActivities.length > 0 ? recentActivities[recentActivities.length - 1] : null;
            const lastIsPause = lastActivity && lastActivity.activity && 
                               lastActivity.activity.includes('Automatically paused');
            
            if (!lastIsPause) {
                console.log(`📝 Adding pause activity: "Automatically paused (${reason})"`);
                this.dataManager.addActivity(`Automatically paused (${reason})`);
                console.log(`📊 Activities count after adding pause: ${this.dataManager.activities.length}`);
            } else {
                console.log('⏩ Last activity is already a pause, skipping duplicate');
                console.log(`📊 Current activities count: ${this.dataManager.activities.length}`);
            }
            
            // Create emergency pre-shutdown backup with detailed state
            const emergencyBackup = {
                timestamp: new Date().toISOString(),
                processId: process.pid,
                reason: reason,
                activitiesCount: this.dataManager.activities.length,
                activities: this.dataManager.activities.map(a => a.toJSON()),
                config: this.dataManager.config
            };
            
            const emergencyFile = path.join(this.dataManager.dataDir, 'emergency_pre_shutdown.json');
            const fs = require('fs-extra');
            
            console.log('🚨 Creating emergency pre-shutdown backup...');
            await fs.writeJson(emergencyFile, emergencyBackup, { spaces: 2 });
            
            // Force immediate save with verification
            console.log('💾 Force saving activities and config...');
            this.dataManager.saveActivities();
            this.dataManager.saveConfig();
            
            // Multiple file system sync attempts
            for (let i = 0; i < 3; i++) {
                console.log(`🔄 File sync attempt ${i + 1}/3...`);
                
                // Force file system sync (platform-specific)
                try {
                    const { spawn } = require('child_process');
                    if (process.platform === 'darwin' || process.platform === 'linux') {
                        // Force filesystem sync on Unix-like systems
                        spawn('sync', { stdio: 'ignore' });
                    }
                } catch (error) {
                    console.warn('Could not force filesystem sync:', error.message);
                }
                
                await new Promise(resolve => setTimeout(resolve, 300));
                
                // Verify files were written correctly
                const activitiesExist = await this.verifyFileIntegrity(this.dataManager.activitiesFile);
                const configExists = await this.verifyFileIntegrity(this.dataManager.configFile);
                
                console.log(`🔍 File integrity check ${i + 1} - activities: ${activitiesExist}, config: ${configExists}`);
                
                if (activitiesExist && configExists) {
                    console.log(`✅ File integrity verified on attempt ${i + 1}`);
                    break;
                }
                
                if (i === 2) {
                    console.error('❌ All file integrity checks failed!');
                }
            }
            
            console.log('✅ Data persistence completed successfully');
            if (this.logger) {
                await this.logger.logSessionEvent('data_persistence_success', { reason });
            }
            
        } catch (error) {
            console.error('❌ Error during data persistence:', error.message);
            if (this.logger) {
                await this.logger.logError('session', error, { action: 'data_persistence', reason });
            }
        }
    }
    
    // Verify file exists and has content
    async verifyFileIntegrity(filePath) {
        try {
            const fs = require('fs-extra');
            if (await fs.pathExists(filePath)) {
                const stats = await fs.stat(filePath);
                return stats.size > 0; // File exists and has content
            }
            return false;
        } catch (error) {
            console.warn(`File integrity check failed for ${filePath}:`, error.message);
            return false;
        }
    }
}

module.exports = SessionManager;