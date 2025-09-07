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
                
                // Log automatic pause activity
                this.dataManager.addActivity('Automatically paused (user logged out)');
                
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
            
            // Log the start of lock state check
            if (this.logger) {
                this.logger.debug('session', 'Starting macOS lock state check - Method 1: ScreenSaverEngine');
            }
            
            // Method 1: Check if screensaver is running
            exec('pgrep -x ScreenSaverEngine', (error, stdout) => {
                const screensaverActive = !error && stdout.trim().length > 0;
                
                if (this.logger) {
                    this.logger.debug('session', 'ScreenSaverEngine check result', { 
                        error: error ? error.message : null,
                        stdout: stdout.trim(),
                        screensaverActive 
                    });
                }
                
                if (screensaverActive) {
                    console.log('🔒 ScreenSaverEngine detected - screen is locked');
                    if (this.logger) {
                        this.logger.logSessionEvent('lock_detected_via_screensaver', { method: 'ScreenSaverEngine' });
                    }
                    this.handleLockStateChange(true);
                    resolve();
                    return;
                }
                
                // Method 2: Check if loginwindow is showing lock screen (for Cmd+Ctrl+Q)
                // We need to check if loginwindow is running AND if it's showing the lock screen
                if (this.logger) {
                    this.logger.debug('session', 'Starting macOS lock state check - Method 2: LoginWindow');
                }
                
                exec('ps aux | grep loginwindow | grep -v grep', (error, stdout) => {
                    const loginWindowRunning = !error && stdout.trim().length > 0;
                    
                    if (this.logger) {
                        this.logger.debug('session', 'LoginWindow check result', { 
                            error: error ? error.message : null,
                            stdout: stdout.trim(),
                            loginWindowRunning 
                        });
                    }
                    
                    if (loginWindowRunning) {
                        console.log('🔍 Login window detected, checking if showing lock screen...');
                        if (this.logger) {
                            this.logger.debug('session', 'LoginWindow detected, checking lock screen visibility via AppleScript');
                        }
                        
                        // Use AppleScript to check if the lock screen is actually visible
                        const lockScreenScript = `
                        tell application "System Events"
                            try
                                -- Check if login window is the frontmost application
                                set frontApp to name of first application process whose frontmost is true
                                if frontApp is "loginwindow" then
                                    return true
                                end if
                                
                                -- Check if login window has any visible windows
                                set loginProcess to first application process whose name is "loginwindow"
                                set windowCount to count of windows of loginProcess
                                if windowCount > 0 then
                                    return true
                                end if
                                
                                return false
                            on error
                                return false
                            end try
                        end tell`;
                        
                        exec(`osascript -e '${lockScreenScript}'`, (error, stdout) => {
                            const isLockScreenVisible = !error && stdout.trim() === 'true';
                            console.log(`Lock screen visibility check: ${isLockScreenVisible ? 'visible' : 'not visible'}`);
                            
                            if (this.logger) {
                                this.logger.debug('session', 'AppleScript lock screen check result', { 
                                    error: error ? error.message : null,
                                    stdout: stdout.trim(),
                                    isLockScreenVisible 
                                });
                            }
                            
                            if (isLockScreenVisible) {
                                console.log('🔒 Lock screen is visible - screen is locked');
                                if (this.logger) {
                                    this.logger.logSessionEvent('lock_detected_via_loginwindow', { method: 'LoginWindow + AppleScript' });
                                }
                                this.handleLockStateChange(true);
                                resolve();
                                return;
                            }
                            
                            // Method 3: Check display power state as fallback
                            if (this.logger) {
                                this.logger.debug('session', 'Starting macOS lock state check - Method 3: Display Power State');
                            }
                            
                            exec('ioreg -n IODisplayWrangler | grep -i IOPowerManagement', (error, stdout) => {
                                let isLocked = false;
                                
                                if (this.logger) {
                                    this.logger.debug('session', 'Display power state check result', { 
                                        error: error ? error.message : null,
                                        stdout: stdout.trim(),
                                        hasOutput: !error && stdout.trim().length > 0
                                    });
                                }
                                
                                if (!error && stdout.trim().length > 0) {
                                    try {
                                        console.log('Display power state output:', stdout);
                                        const match = stdout.match(/"CurrentPowerState"\s*=\s*(\d+)/);
                                        if (match && match[1]) {
                                            // CurrentPowerState = 4 means display is on, 0 means off/locked
                                            isLocked = parseInt(match[1]) === 0;
                                            console.log(`Display power state: ${match[1]} (${isLocked ? 'locked' : 'unlocked'})`);
                                            
                                            if (this.logger) {
                                                this.logger.debug('session', 'Display power state parsed', { 
                                                    powerState: match[1],
                                                    isLocked,
                                                    method: 'Display Power State'
                                                });
                                            }
                                        }
                                    } catch (parseError) {
                                        console.warn('Error parsing display power state:', parseError.message);
                                        if (this.logger) {
                                            this.logger.warn('session', 'Error parsing display power state', { error: parseError.message });
                                        }
                                    }
                                }
                                
                                console.log(`Final lock state determination: ${isLocked ? 'locked' : 'unlocked'}`);
                                if (this.logger) {
                                    this.logger.debug('session', 'Final lock state determination', { 
                                        isLocked,
                                        method: 'Display Power State (fallback)'
                                    });
                                }
                                this.handleLockStateChange(isLocked);
                                resolve();
                            });
                        });
                    } else {
                        console.log('🔓 No lock indicators found - assuming unlocked');
                        if (this.logger) {
                            this.logger.debug('session', 'No lock indicators found, assuming unlocked', { 
                                method: 'No indicators found'
                            });
                        }
                        this.handleLockStateChange(false);
                        resolve();
                    }
                });
            });
        });
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
        console.log('🔓 handleUnlock called - screen unlocked detected');
        console.log(`🔧 autoStartOnUnlock config: ${this.config.autoStartOnUnlock}`);
        
        if (!this.config.autoStartOnUnlock) {
            console.log('❌ Auto-start on unlock is disabled in config, skipping');
            if (this.logger) await this.logger.logSessionEvent('auto_start_skipped', { reason: 'unlock_disabled' });
            return;
        }
        
        try {
            const isRunning = this.daemonManager.isAlreadyRunning();
            console.log(`🔍 Daemon running status: ${isRunning ? 'running' : 'not running'}`);
            
            if (!isRunning) {
                console.log('🚀 Auto-starting daemon on screen unlock...');
                if (this.logger) await this.logger.logSessionEvent('auto_start_attempting', { trigger: 'unlock' });
                await this.daemonManager.start();
                
                // Log resuming activity
                this.dataManager.addActivity('Automatically resumed (screen unlocked)');
                
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
        
        if (!this.config.autoStopOnLock) {
            console.log('❌ Auto-stop on lock is disabled in config, skipping');
            if (this.logger) await this.logger.logSessionEvent('auto_stop_skipped', { reason: 'lock_disabled' });
            return;
        }
        
        try {
            const isRunning = this.daemonManager.isAlreadyRunning();
            console.log(`🔍 Daemon running status: ${isRunning ? 'running' : 'not running'}`);
            
            if (isRunning) {
                console.log('🛑 Auto-stopping daemon on screen lock...');
                if (this.logger) await this.logger.logSessionEvent('auto_stop_attempting', { trigger: 'lock' });
                
                // Log automatic pause activity
                this.dataManager.addActivity('Automatically paused (screen locked)');
                
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
}

module.exports = SessionManager;