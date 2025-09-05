#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const inquirer = require('inquirer');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const { DataManager } = require('./dataManager');
const NotificationManager = require('./notificationManager');
const DaemonManager = require('./daemonManager');

const program = new Command();

// Initialize managers
const dataManager = new DataManager();
const notificationManager = new NotificationManager();
const daemonManager = new DaemonManager(dataManager, notificationManager);

program
    .name('pulse')
    .description('Pulse - Mindful productivity tracking with rhythmic check-ins')
    .version('1.0.0');

// Log command
program
    .command('log')
    .description('Log what you\'ve been working on')
    .argument('[activity]', 'Activity description')
    .option('--close', 'Close terminal after logging (useful when called from notifications)')
    .action(async (activity, options) => {
        try {
            let activityText = activity;

            // Interactive mode if no activity provided
            if (!activityText) {
                const answers = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'activity',
                        message: '📝 What have you been working on?',
                        validate: input => input.trim() !== '' || 'Activity cannot be empty'
                    }
                ]);
                activityText = answers.activity;
            }

            // Add the activity
            const newActivity = dataManager.addActivity(activityText);

            console.log(chalk.green('✅ Logged:'), activityText);
            console.log(chalk.gray('⏰ Time:'), newActivity.timestamp.toLocaleTimeString());

            // Show duration of previous activity if exists
            if (dataManager.activities.length > 1) {
                const prevActivity = dataManager.activities[dataManager.activities.length - 2];
                if (prevActivity.durationMinutes > 0) {
                    console.log(chalk.yellow('⏱️  Previous activity duration:'), `${prevActivity.durationMinutes} minutes`);
                }
            }

            // Close terminal if --close flag is used (useful for notification clicks)
            if (options.close) {
                console.log(chalk.gray('\n👋 Closing terminal...'));
                setTimeout(() => {
                    if (os.platform() === 'darwin') {
                        // On macOS, try to close the current terminal window/tab
                        require('child_process').exec('osascript -e "tell application \\"Terminal\\" to close front window"');
                    }
                    process.exit(0);
                }, 1000); // Give user a moment to see the confirmation
            }
        } catch (error) {
            console.error(chalk.red('❌ Error logging activity:'), error.message);
            
            // Still close terminal on error if --close flag is used
            if (options.close) {
                setTimeout(() => {
                    if (os.platform() === 'darwin') {
                        require('child_process').exec('osascript -e "tell application \\"Terminal\\" to close front window"');
                    }
                    process.exit(1);
                }, 1500);
            }
        }
    });

// Start command
program
    .command('start')
    .description('Start the pulse daemon')
    .option('-f, --foreground', 'Run in foreground (for testing)')
    .option('--daemon', 'Internal flag for daemon process (do not use manually)')
    .option('--safe', 'Use safe mode with enhanced error handling')
    .action(async (options) => {
        try {
            // Handle internal daemon flag
            if (options.daemon) {
                // This is the actual daemon process running in background
                await daemonManager.startDaemon();
                return;
            }

            if (daemonManager.isAlreadyRunning()) {
                console.log(chalk.yellow('⚠️  Tracker daemon is already running'));
                return;
            }

            console.log(chalk.blue('🚀 Starting pulse daemon...'));

            // Test notification first with enhanced error handling
            console.log('🧪 Testing notification system...');
            try {
                await notificationManager.testNotification();
            } catch (error) {
                console.warn(chalk.yellow('⚠️  Notification test had issues:'), error.message);
                console.log(chalk.gray('💡 Continuing with fallback notifications...'));
            }

            if (options.foreground) {
                await daemonManager.runForeground();
            } else {
                if (options.safe) {
                    console.log(chalk.blue('🛡️  Using safe mode...'));
                }
                
                await daemonManager.start();
                console.log(chalk.green('✅ Tracker daemon started successfully in background'));
                console.log(chalk.blue('📅 Notifications every'), `${dataManager.getConfig('notificationInterval')} minutes`);
                console.log(chalk.gray('💡 Use \'pulse log\' to manually log activities'));
                console.log(chalk.gray('🛑 Use \'pulse stop\' to stop the daemon'));
                console.log(chalk.gray('📊 Use \'pulse status\' to check daemon status'));
                
                // Platform-specific tips
                if (os.platform() === 'darwin') {
                    console.log(chalk.gray('🍎 macOS: If you see permission dialogs, click "Allow" for notifications'));
                }
            }
        } catch (error) {
            console.error(chalk.red('❌ Failed to start daemon:'), error.message);
            
            // Provide helpful troubleshooting
            console.log(chalk.yellow('\n🔧 Troubleshooting tips:'));
            console.log('• Try running in foreground mode: pulse start --foreground');
            console.log('• Check permissions: pulse troubleshoot');
            console.log('• Test notifications: pulse test-notification');
            
            if (os.platform() === 'darwin') {
                console.log('• macOS: Check System Preferences → Security & Privacy → Privacy → Accessibility');
                console.log('• macOS: Ensure your terminal app has notification permissions');
            }
        }
    });

// Stop command
program
    .command('stop')
    .description('Stop the pulse daemon')
    .option('-f, --force', 'Force stop the daemon')
    .action(async (options) => {
        try {
            if (options.force) {
                const stopped = await daemonManager.forceStop();
                if (stopped) {
                    console.log(chalk.green('🛑 Tracker daemon force stopped'));
                } else {
                    console.log(chalk.yellow('⚠️  No running daemon found'));
                }
            } else {
                if (!daemonManager.isAlreadyRunning()) {
                    console.log(chalk.yellow('⚠️  Tracker daemon is not running'));
                    return;
                }

                await daemonManager.stop();
                console.log(chalk.green('🛑 Tracker daemon stopped'));
            }
        } catch (error) {
            console.error(chalk.red('❌ Failed to stop daemon:'), error.message);
        }
    });

// Status command
program
    .command('status')
    .description('Show pulse status and recent activities')
    .action(async () => {
        try {
            const status = daemonManager.getStatus();

            // Daemon status
            if (status.isRunning || status.pidFileExists) {
                console.log(chalk.green('🟢 Tracker daemon is running'));
                if (status.nextRun) {
                    console.log(chalk.gray('⏰ Next notification:'), status.nextRun.toLocaleString());
                }
            } else {
                console.log(chalk.red('🔴 Tracker daemon is stopped'));
            }

            // Configuration
            const interval = dataManager.getConfig('notificationInterval');
            console.log(chalk.blue('⏰ Notification interval:'), `${interval} minutes`);

            // System info
            console.log(chalk.gray('💻 Platform:'), os.platform());
            console.log(chalk.gray('📁 Data directory:'), dataManager.dataDir);

            // Recent activities
            const recent = dataManager.getRecentActivities(8);
            if (recent.length > 0) {
                console.log(chalk.blue('\n📋 Recent activities (last 8 hours):'));
                recent.slice(-5).forEach(activity => {
                    const timeStr = activity.timestamp.toLocaleTimeString('en-US', { 
                        hour: '2-digit', 
                        minute: '2-digit' 
                    });
                    const durationStr = activity.durationMinutes > 0 ? 
                        chalk.gray(` (${activity.durationMinutes}m)`) : '';
                    console.log(`  ${chalk.gray(timeStr)} - ${activity.activity}${durationStr}`);
                });
            } else {
                console.log(chalk.gray('\n📋 No recent activities'));
            }
        } catch (error) {
            console.error(chalk.red('❌ Error getting status:'), error.message);
        }
    });

// Troubleshoot command
program
    .command('troubleshoot')
    .description('Run diagnostic checks and provide troubleshooting information')
    .action(async () => {
        console.log(chalk.blue('🔧 Running diagnostic checks...\n'));

        // System information
        console.log(chalk.blue('📋 System Information:'));
        console.log(`  Platform: ${os.platform()}`);
        console.log(`  Node.js: ${process.version}`);
        console.log(`  Architecture: ${os.arch()}`);
        console.log(`  Home directory: ${os.homedir()}`);
        console.log(`  Data directory: ${dataManager.dataDir}`);

        // Check data directory
        console.log(chalk.blue('\n📁 Data Directory Check:'));
        try {
            const exists = await fs.pathExists(dataManager.dataDir);
            console.log(`  Exists: ${exists ? '✅' : '❌'}`);
            
            if (exists) {
                const stats = await fs.stat(dataManager.dataDir);
                console.log(`  Writable: ${stats.isDirectory() ? '✅' : '❌'}`);
                
                const configExists = await fs.pathExists(path.join(dataManager.dataDir, 'config.json'));
                const activitiesExists = await fs.pathExists(path.join(dataManager.dataDir, 'activities.json'));
                console.log(`  Config file: ${configExists ? '✅' : '❌'}`);
                console.log(`  Activities file: ${activitiesExists ? '✅' : '❌'}`);
            }
        } catch (error) {
            console.log(`  Error: ${error.message}`);
        }

        // Test notification system
        console.log(chalk.blue('\n🔔 Notification System Check:'));
        try {
            await notificationManager.testNotification();
            console.log('  Notification test: ✅');
        } catch (error) {
            console.log(`  Notification test: ❌ (${error.message})`);
        }

        // Check daemon status
        console.log(chalk.blue('\n⚙️  Daemon Status Check:'));
        const status = daemonManager.getStatus();
        console.log(`  Running: ${status.isRunning ? '✅' : '❌'}`);
        console.log(`  PID file exists: ${status.pidFileExists ? '✅' : '❌'}`);

        // Platform-specific checks
        if (os.platform() === 'darwin') {
            console.log(chalk.blue('\n🍎 macOS Specific Checks:'));
            console.log('  • Check System Preferences → Notifications & Focus');
            console.log('  • Ensure your terminal app has notification permissions');
            console.log('  • Try running: pulse start --foreground');
        } else if (os.platform() === 'linux') {
            console.log(chalk.blue('\n🐧 Linux Specific Checks:'));
            console.log('  • Install libnotify-bin: sudo apt install libnotify-bin');
            console.log('  • Check if notify-send is available');
        }

        console.log(chalk.blue('\n💡 Common Solutions:'));
        console.log('  • Restart terminal and try again');
        console.log('  • Run: pulse start --foreground (for testing)');
        console.log('  • Run: pulse stop --force (if stuck)');
        console.log('  • Check file permissions in data directory');
    });

// Report command
program
    .command('report')
    .description('Generate time tracking reports')
    .option('-p, --period <period>', 'Report period (today, week, month)', 'today')
    .option('-e, --export <format>', 'Export format (csv, json)')
    .action(async (options) => {
        try {
            // Determine date range
            let days, title;
            switch (options.period) {
                case 'today':
                    days = 1;
                    title = "Today's Report";
                    break;
                case 'week':
                    days = 7;
                    title = "Weekly Report";
                    break;
                case 'month':
                    days = 30;
                    title = "Monthly Report";
                    break;
                default:
                    console.error(chalk.red('❌ Invalid period. Use: today, week, or month'));
                    return;
            }

            const summary = dataManager.getTimeSummary(days);

            if (options.export) {
                await exportReport(summary, options.period, options.export);
                return;
            }

            // Display report
            console.log(chalk.blue(`\n📊 ${title}`));
            console.log('='.repeat(40));

            const totalHours = summary.totalTimeMinutes / 60;
            console.log(chalk.green('⏱️  Total time tracked:'), `${totalHours.toFixed(1)} hours`);
            console.log(chalk.blue('📝 Total activities:'), summary.activityCount);

            if (summary.activities.length > 0) {
                console.log(chalk.blue('\n📋 Recent activities:'));
                summary.activities.slice(-10).forEach(activity => {
                    const timeStr = activity.timestamp.toLocaleTimeString('en-US', { 
                        hour: '2-digit', 
                        minute: '2-digit' 
                    });
                    const durationStr = activity.duration > 0 ? 
                        chalk.gray(` (${activity.duration}m)`) : '';
                    console.log(`  ${chalk.gray(timeStr)} - ${activity.activity}${durationStr}`);
                });
            }

            console.log(chalk.gray('\n💡 Use --export csv or --export json to export data'));
        } catch (error) {
            console.error(chalk.red('❌ Error generating report:'), error.message);
        }
    });

// Config command
program
    .command('config')
    .description('Configure pulse settings')
    .argument('<key>', 'Configuration key')
    .argument('<value>', 'Configuration value')
    .action(async (key, value) => {
        try {
            // Convert value to appropriate type
            if (key === 'notificationInterval') {
                const numValue = parseInt(value);
                if (isNaN(numValue) || numValue < 1) {
                    console.error(chalk.red('❌ Notification interval must be a positive number'));
                    return;
                }
                value = numValue;
            }

            if (dataManager.setConfig(key, value)) {
                console.log(chalk.green('✅ Set'), `${key} = ${value}`);

                // Restart daemon if it's running and interval changed
                if (key === 'notificationInterval' && daemonManager.isAlreadyRunning()) {
                    console.log(chalk.blue('🔄 Restarting daemon with new interval...'));
                    await daemonManager.stop();
                    await daemonManager.start();
                }
            } else {
                console.error(chalk.red('❌ Unknown configuration key:'), key);
                console.log('Available keys: notificationInterval, dataRetentionDays');
            }
        } catch (error) {
            console.error(chalk.red('❌ Error setting config:'), error.message);
        }
    });

// Test notification command
program
    .command('test-notification')
    .description('Test the notification system')
    .action(async () => {
        console.log('🧪 Testing notification system...');
        
        try {
            const success = await notificationManager.testNotification();
            
            if (success) {
                console.log(chalk.green('✅ Notification sent successfully!'));
                console.log(chalk.gray('💡 If you didn\'t see a notification, check your system settings'));
            } else {
                console.log(chalk.red('❌ Failed to send notification'));
            }
        } catch (error) {
            console.error(chalk.red('❌ Notification test error:'), error.message);
        }
    });

// Clear data command
program
    .command('clear')
    .description('Clear all activity data')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (options) => {
        try {
            if (!options.force) {
                const confirm = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'proceed',
                        message: '⚠️  Are you sure you want to delete ALL activity data? This cannot be undone.',
                        default: false
                    }
                ]);

                if (!confirm.proceed) {
                    console.log(chalk.yellow('Operation cancelled.'));
                    return;
                }
            }

            // Clear activities array and save
            dataManager.activities = [];
            dataManager.saveActivities();

            console.log(chalk.green('✅ All activity data cleared successfully!'));
            console.log(chalk.gray('💡 Configuration settings were preserved'));
        } catch (error) {
            console.error(chalk.red('❌ Error clearing data:'), error.message);
        }
    });

// Export function
async function exportReport(summary, period, format) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `productivity_report_${period}_${timestamp}.${format}`;

    try {
        if (format === 'json') {
            await fs.writeJson(filename, summary, { spaces: 2 });
        } else if (format === 'csv') {
            const csvContent = generateCSV(summary);
            await fs.writeFile(filename, csvContent);
        } else {
            console.error(chalk.red('❌ Invalid export format. Use: csv or json'));
            return;
        }

        console.log(chalk.green('📄 Report exported to:'), filename);
    } catch (error) {
        console.error(chalk.red('❌ Error exporting report:'), error.message);
    }
}

function generateCSV(summary) {
    const lines = ['Activity,Duration (minutes),Duration (hours),Timestamp'];
    
    summary.activities.forEach(activity => {
        const timeMinutes = activity.duration;
        const timeHours = (timeMinutes / 60).toFixed(1);
        const timestamp = activity.timestamp.toISOString();
        lines.push(`"${activity.activity}",${timeMinutes},${timeHours},${timestamp}`);
    });

    return lines.join('\n');
}

module.exports = program;

// If this file is run directly, parse command line arguments
if (require.main === module) {
    program.parseAsync();
}

