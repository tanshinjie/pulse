const path = require('path');
const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');
const notifier = require('node-notifier');

class NotificationManager {
    constructor() {
        this.platform = os.platform();
        this.appName = 'Pulse';
    }

    async sendNotification(title, message, options = {}) {
        const defaultOptions = {
            title: title,
            message: message,
            sound: false,
            timeout: 10,
            ...options
        };

        if (this.platform === 'darwin') {
            return this.sendMacOSNotification(title, message, defaultOptions);
        } else if (this.platform === 'linux') {
            return this.sendLinuxNotification(title, message, defaultOptions);
        } else if (this.platform === 'win32') {
            return this.sendWindowsNotification(title, message, defaultOptions);
        } else {
            this.fallbackNotification(title, message);
            return { success: true, usedFallback: true };
        }
    }

    // Check if terminal-notifier is available on macOS
    async checkTerminalNotifierAvailable() {
        if (this.platform !== 'darwin') return false;
        
        return new Promise((resolve) => {
            exec('which terminal-notifier', (error) => {
                resolve(!error);
            });
        });
    }

    // macOS-specific notification using terminal-notifier
    async sendMacOSNotification(title, message, options = {}) {
        const hasTerminalNotifier = await this.checkTerminalNotifierAvailable();
        
        if (hasTerminalNotifier) {
            return this.sendTerminalNotifierNotification(title, message, options);
        } else {
            return this.sendOSAScriptNotification(title, message, options);
        }
    }

    // Send notification using node-notifier with terminal-notifier
    async sendTerminalNotifierNotification(title, message, options = {}) {
        return new Promise((resolve) => {
            const nc = new notifier.NotificationCenter({
                customPath: '/opt/homebrew/bin/terminal-notifier'
            });

            const notificationOptions = {
                title: title,
                message: message,
                subtitle: options.subtitle || this.appName,
                sound: options.sound || false,
                wait: true
            };

            // Add execute command for check-in notifications
            if (options.isCheckIn) {
                notificationOptions.execute = `osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "pulse log --close"'`;
            }

            nc.notify(notificationOptions, (error, response, metadata) => {
                if (error) {
                    console.warn('node-notifier failed, falling back to osascript:', error.message);
                    this.sendOSAScriptNotification(title, message, options).then(resolve);
                } else {
                    console.log(`[${new Date().toLocaleTimeString()}] ✅ macOS notification sent via node-notifier`);
                    resolve({ success: true, method: 'node-notifier' });
                }
            });
        });
    }

    // Fallback to osascript if terminal-notifier is not available
    async sendOSAScriptNotification(title, message, options = {}) {
        return new Promise((resolve) => {
            const subtitle = options.subtitle || '';
            
            // Escape quotes in the message and title
            const escapedTitle = title.replace(/"/g, '\\"');
            const escapedMessage = message.replace(/"/g, '\\"');
            const escapedSubtitle = subtitle.replace(/"/g, '\\"');
            
            const script = `display notification "${escapedMessage}" with title "${escapedTitle}" ${subtitle ? `subtitle "${escapedSubtitle}"` : ''}`;
            
            exec(`osascript -e '${script}'`, (error, stdout, stderr) => {
                if (error) {
                    console.warn('osascript failed, using fallback notification:', error.message);
                    this.fallbackNotification(title, message);
                    resolve({ success: true, usedFallback: true });
                } else {
                    console.log(`[${new Date().toLocaleTimeString()}] ✅ macOS notification sent via osascript`);
                    resolve({ success: true, method: 'osascript' });
                }
            });
        });
    }

    // Linux notification using notify-send
    async sendLinuxNotification(title, message, options = {}) {
        return new Promise((resolve) => {
            const timeout = (options.timeout || 10) * 1000; // Convert to milliseconds
            const urgency = options.urgency || 'normal';
            
            const cmd = `notify-send "${title}" "${message}" --urgency=${urgency} --expire-time=${timeout} --app-name="${this.appName}"`;
            
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    console.warn('notify-send failed, using fallback notification:', error.message);
                    this.fallbackNotification(title, message);
                    resolve({ success: true, usedFallback: true });
                } else {
                    console.log(`[${new Date().toLocaleTimeString()}] ✅ Linux notification sent via notify-send`);
                    resolve({ success: true, method: 'notify-send' });
                }
            });
        });
    }

    // Windows notification (placeholder for future implementation)
    async sendWindowsNotification(title, message, options = {}) {
        console.warn('Windows notifications not implemented, using fallback');
        this.fallbackNotification(title, message);
        return { success: true, usedFallback: true };
    }

    fallbackNotification(title, message) {
        // Terminal-based fallback notification
        const border = '='.repeat(50);
        console.log(`\n${border}`);
        console.log(`🔔 ${title}`);
        console.log(`📝 ${message}`);
        console.log(`${border}\n`);
        
        // Try system bell (safe on all platforms)
        try {
            process.stdout.write('\u0007'); // ASCII bell character
        } catch (error) {
            // Ignore bell errors
        }
    }

    async testNotification() {
        console.log(`Testing notifications on ${this.platform}...`);
        
        try {
            const result = await this.sendNotification(
                'Pulse',
                'Notification system is working! 🎉',
                { sound: false }
            );

            if (result.success && !result.usedFallback) {
                if (result.method === 'terminal-notifier') {
                    console.log('✅ Native notifications working via terminal-notifier!');
                } else if (result.method === 'osascript') {
                    console.log('✅ Native notifications working via osascript!');
                } else if (result.method === 'notify-send') {
                    console.log('✅ Native notifications working via notify-send!');
                } else {
                    console.log('✅ Native notifications are working perfectly!');
                }
            } else if (result.success && result.usedFallback) {
                console.log('⚠️  Using fallback notifications (native notifications unavailable)');
                
                if (this.platform === 'darwin') {
                    const hasTerminalNotifier = await this.checkTerminalNotifierAvailable();
                    if (!hasTerminalNotifier) {
                        console.log('💡 To improve notifications on macOS:');
                        console.log('   • Install terminal-notifier: brew install terminal-notifier');
                        console.log('   • Or enable notifications for your terminal app in System Preferences');
                    }
                } else if (this.platform === 'linux') {
                    console.log('💡 For Linux: Install libnotify-bin for native notifications');
                    console.log('   • Ubuntu/Debian: sudo apt install libnotify-bin');
                    console.log('   • RHEL/CentOS: sudo yum install libnotify');
                }
            }

            return result.success;
        } catch (error) {
            console.warn('Test notification error:', error.message);
            this.fallbackNotification('Pulse', 'Notification system is working! 🎉');
            return true;
        }
    }

    // Send a check-in notification with context
    async sendCheckInNotification(interval, lastActivity = null) {
        const title = 'Check-in';
        let message = `What have you been working on for the past ${interval} minutes?`;
        
        if (lastActivity) {
            const timeSince = Math.floor((Date.now() - lastActivity.timestamp) / (1000 * 60));
            if (timeSince < interval * 2) {
                message += `\n\nLast logged: ${lastActivity.activity}`;
            }
        }

        // Add click interaction hint for supported platforms
        if (this.platform === 'darwin') {
            message += '\n\n(Click this notification to open pulse log command)';
        }

        const options = {
            timeout: 30, // Longer timeout for check-ins
            sound: false, // Disable sound to avoid permission issues
            isCheckIn: true // Flag to enable click action
        };

        const result = await this.sendNotification(title, message, options);
        
        // Log fallback usage for check-ins
        if (result.usedFallback && this.platform === 'darwin') {
            console.log('⏰ Check-in notification using fallback - consider installing terminal-notifier for better experience');
        }
        
        return result.success;
    }

    // Simplified notification handlers (terminal-notifier doesn't support callbacks like node-notifier)
    setupNotificationHandlers(onLogActivity, onDismiss) {
        // Note: terminal-notifier and osascript don't provide callback functionality
        // like node-notifier did. This method is kept for compatibility but is largely
        // a no-op now. Applications should handle user interaction through other means.
        console.log('Notification handlers setup (limited functionality with terminal-notifier/osascript)');
    }
}

module.exports = NotificationManager;

