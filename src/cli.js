#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const inquirer = require('inquirer');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const ms = require('ms');

const { DataManager } = require('./dataManager');
const NotificationManager = require('./notificationManager');
const DaemonManager = require('./daemonManager');
const SessionManager = require('./sessionManager');
const Logger = require('./logger');

const program = new Command();

// Initialize managers
const dataManager = new DataManager();
const logger = new Logger(dataManager);
const notificationManager = new NotificationManager();
const daemonManager = new DaemonManager(dataManager, notificationManager);
const sessionManager = new SessionManager(daemonManager, dataManager, logger);

program
    .name('pulse')
    .description('Pulse - Mindful productivity tracking with rhythmic check-ins')
    .version('1.0.1');

// Log command
program
    .command('log')
    .description('Log what you\'ve been working on')
    .argument('[activity]', 'Activity description')
    .option('--close', 'Close terminal after logging (useful when called from notifications)')
    .option('-t, --time <time>', 'Log activity at specific time (HH:MM or YYYY-MM-DD HH:MM)')
    .option('-d, --date <date>', 'Log activity on specific date (YYYY-MM-DD)')
    .option('--ago <duration>', 'Log activity X minutes/hours ago (e.g., "30m", "2h")')
    .option('--duration <duration>', 'Specify how long the activity lasted (e.g., "30m", "2h")')
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

            // Parse timestamp from options
            let timestamp = null;
            if (options.time || options.date || options.ago) {
                timestamp = parseTimestamp(options);
            }

            // Parse duration from options
            let durationMinutes = null;
            if (options.duration) {
                durationMinutes = parseDuration(options.duration);
            }

            // Add the activity
            const newActivity = dataManager.addActivity(activityText, timestamp, durationMinutes);
            
            // Log the activity
            await logger.logActivity('logged', activityText, {
                timestamp: newActivity.timestampEnd.toISOString(),
                duration: newActivity.durationMinutes,
                id: newActivity.id,
                ...(timestamp && { customTime: true })
            });

            console.log(chalk.green('✅ Logged:'), activityText);
            
            if (timestamp && timestamp < new Date(Date.now() - 60000)) { // More than 1 minute ago
                console.log(chalk.blue('⏰ Logged at:'), newActivity.timestampEnd.toLocaleString());
            } else {
                console.log(chalk.gray('⏰ Time:'), newActivity.timestampEnd.toLocaleTimeString());
            }

            // Show duration information for affected activities
            const activityIndex = dataManager.activities.findIndex(a => a.id === newActivity.id);
            if (activityIndex > 0) {
                const prevActivity = dataManager.activities[activityIndex - 1];
                if (prevActivity.durationMinutes > 0) {
                    console.log(chalk.yellow('⏱️  Previous activity duration:'), `${prevActivity.durationMinutes} minutes`);
                }
            }
            
            if (newActivity.durationMinutes > 0) {
                console.log(chalk.yellow('⏱️  This activity duration:'), `${newActivity.durationMinutes} minutes`);
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

// Edit command
program
    .command('edit')
    .description('Edit a previous activity entry')
    .action(async () => {
        try {
            // Get recent activities (last 20)
            const recentActivities = dataManager.activities
                .slice(-20)
                .reverse(); // Most recent first
            
            if (recentActivities.length === 0) {
                console.log(chalk.yellow('⚠️  No activities found to edit'));
                return;
            }

            // Select activity to edit
            const activityChoices = recentActivities.map((activity, index) => {
                const timeStr = activity.timestampEnd.toLocaleString();
                const durationStr = activity.durationMinutes > 0 ? ` (${activity.durationMinutes}m)` : '';
                return {
                    name: `${timeStr} - ${activity.activity}${durationStr}`,
                    value: activity.id,
                    short: activity.activity
                };
            });

            const { selectedId } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'selectedId',
                    message: '📝 Which activity would you like to edit?',
                    choices: activityChoices,
                    pageSize: 10
                }
            ]);

            const selectedActivity = recentActivities.find(a => a.id === selectedId);
            
            // Select what to edit
            const { editChoice } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'editChoice',
                    message: '✏️  What would you like to do?',
                    choices: [
                        { name: 'Edit Description', value: 'description' },
                        { name: 'Edit Time', value: 'time' },
                        { name: 'Edit Duration', value: 'duration' },
                        { name: 'Edit Everything', value: 'all' },
                        { name: '🗑️  Delete this activity', value: 'delete' }
                    ]
                }
            ]);

            // Handle delete option
            if (editChoice === 'delete') {
                const { confirmDelete } = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'confirmDelete',
                        message: `🗑️  Are you sure you want to delete "${selectedActivity.activity}"?`,
                        default: false
                    }
                ]);

                if (confirmDelete) {
                    dataManager.deleteActivity(selectedId);
                    
                    // Log the deletion
                    await logger.logActivity('deleted', selectedActivity.activity, {
                        id: selectedActivity.id,
                        timestamp: selectedActivity.timestampEnd.toISOString(),
                        duration: selectedActivity.durationMinutes
                    });

                    console.log(chalk.green('✅ Activity deleted successfully'));
                    console.log(chalk.gray('📝 Deleted:'), selectedActivity.activity);
                    console.log(chalk.gray('⏰ Was at:'), selectedActivity.timestampEnd.toLocaleString());
                } else {
                    console.log(chalk.yellow('❌ Deletion cancelled'));
                }
                return;
            }

            const updates = {};

            // Edit description
            if (editChoice === 'description' || editChoice === 'all') {
                const { newActivity } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'newActivity',
                        message: '📝 New description:',
                        default: selectedActivity.activity,
                        validate: input => input.trim() !== '' || 'Description cannot be empty'
                    }
                ]);
                updates.activity = newActivity;
            }

            // Edit timestamp
            if (editChoice === 'time' || editChoice === 'all') {
                // Show current time in local timezone
                const currentLocalTime = selectedActivity.timestampEnd.toLocaleString('sv-SE').replace(' ', 'T').slice(0, 16);
                
                const { timeEditChoice } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'timeEditChoice',
                        message: '⏰ How would you like to set the time?',
                        choices: [
                            { name: 'Specific date and time', value: 'datetime' },
                            { name: 'Just the time (keep same date)', value: 'time' },
                            { name: 'X minutes/hours ago', value: 'ago' },
                            { name: 'Keep current time', value: 'keep' }
                        ]
                    }
                ]);

                if (timeEditChoice !== 'keep') {
                    let newTimestamp;

                    if (timeEditChoice === 'datetime') {
                        const { newDatetime } = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'newDatetime',
                                message: '📅 New date and time (YYYY-MM-DD HH:MM):',
                                default: currentLocalTime.replace('T', ' '),
                                validate: input => {
                                    const date = new Date(input);
                                    return !isNaN(date.getTime()) || 'Invalid date/time format. Use YYYY-MM-DD HH:MM';
                                }
                            }
                        ]);
                        newTimestamp = new Date(newDatetime);
                    } 
                    else if (timeEditChoice === 'time') {
                        const currentTimeOnly = selectedActivity.timestampEnd.toLocaleTimeString('en-GB', { 
                            hour: '2-digit', 
                            minute: '2-digit',
                            hour12: false 
                        });
                        
                        const { newTime } = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'newTime',
                                message: '🕐 New time (HH:MM):',
                                default: currentTimeOnly,
                                validate: input => {
                                    const timeMatch = input.match(/^(\d{1,2}):(\d{2})$/);
                                    if (!timeMatch) return 'Invalid time format. Use HH:MM';
                                    
                                    const hours = parseInt(timeMatch[1]);
                                    const minutes = parseInt(timeMatch[2]);
                                    
                                    if (hours > 23 || minutes > 59) {
                                        return 'Invalid time values';
                                    }
                                    return true;
                                }
                            }
                        ]);
                        
                        // Create new timestamp with same date but new time
                        newTimestamp = new Date(selectedActivity.timestampEnd);
                        const [hours, minutes] = newTime.split(':').map(n => parseInt(n));
                        newTimestamp.setHours(hours, minutes, 0, 0);
                    }
                    else if (timeEditChoice === 'ago') {
                        const { agoInput } = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'agoInput',
                                message: '⏪ How long ago? (e.g., "30m", "2h", "1h 30m"):',
                                validate: input => {
                                    const duration = ms(input);
                                    return duration !== undefined || 'Invalid duration format. Use formats like "30m", "2h", "1h 30m"';
                                }
                            }
                        ]);
                        
                        const duration = ms(agoInput);
                        newTimestamp = new Date(Date.now() - duration);
                    }

                    updates.timestampEnd = newTimestamp;
                }
            }

            // Edit duration
            if (editChoice === 'duration' || editChoice === 'all') {
                const { newDuration } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'newDuration',
                        message: '⏱️  New duration (minutes):',
                        default: selectedActivity.durationMinutes.toString(),
                        validate: input => {
                            const num = parseInt(input);
                            return (!isNaN(num) && num >= 0) || 'Duration must be a non-negative number';
                        }
                    }
                ]);
                updates.durationMinutes = parseInt(newDuration);
            }

            // Update the activity
            const updatedActivity = dataManager.updateActivity(selectedId, updates);

            // Log the update
            await logger.logActivity('edited', updatedActivity.activity, {
                id: updatedActivity.id,
                timestamp: updatedActivity.timestampEnd.toISOString(),
                duration: updatedActivity.durationMinutes,
                changes: Object.keys(updates)
            });

            console.log(chalk.green('✅ Activity updated successfully:'));
            console.log(chalk.blue('📝 Description:'), updatedActivity.activity);
            console.log(chalk.blue('⏰ Time:'), updatedActivity.timestampEnd.toLocaleString());
            console.log(chalk.blue('⏱️  Duration:'), `${updatedActivity.durationMinutes} minutes`);

        } catch (error) {
            console.error(chalk.red('❌ Error editing activity:'), error.message);
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
            await logger.logDaemonEvent('start_requested', { foreground: options.foreground });

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
                await logger.logDaemonEvent('started', { mode: 'background' });
                
                console.log(chalk.green('✅ Tracker daemon started successfully in background'));
                console.log(chalk.blue('📅 Notifications every'), `${dataManager.getConfig('notificationInterval')} minutes`);
                
                // Check if lock/unlock features are enabled
                const sessionConfig = sessionManager.getConfig();
                if (sessionConfig.autoStartOnUnlock || sessionConfig.autoStopOnLock) {
                    console.log(chalk.blue('🔒 Lock/unlock monitoring will be started in the daemon process'));
                }
                
                console.log(chalk.gray('💡 Use \'pulse log\' to manually log activities'));
                console.log(chalk.gray('🛑 Use \'pulse stop\' to stop the daemon'));
                console.log(chalk.gray('📊 Use \'pulse status\' to check daemon status'));
                
                // Platform-specific tips
                if (os.platform() === 'darwin') {
                    console.log(chalk.gray('🍎 macOS: If you see permission dialogs, click "Allow" for notifications'));
                }
            }
        } catch (error) {
            await logger.logError('daemon', error, { action: 'start' });
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
    .option('--cleanup', 'Clean up all duplicate daemon processes')
    .action(async (options) => {
        try {
            if (options.cleanup) {
                console.log(chalk.blue('🧹 Cleaning up all daemon processes...'));
                await daemonManager.cleanupStaleDaemons();
                console.log(chalk.green('✅ Cleanup completed'));
                return;
            }
            
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
                await logger.logDaemonEvent('stopped', { method: 'normal' });
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
                const recentReversed = recent.slice(-5).reverse();
                recentReversed.forEach((activity, index) => {
                    const timeStr = activity.timestampEnd.toLocaleTimeString('en-US', { 
                        hour: '2-digit', 
                        minute: '2-digit' 
                    });
                    
                    // For reverse display, calculate duration from previous activity
                    let durationStr = '';
                    if (index < recentReversed.length - 1) {
                        const nextActivity = recentReversed[index + 1];
                        const duration = Math.floor((activity.timestampEnd - nextActivity.timestampEnd) / (1000 * 60));
                        if (duration > 0) {
                            durationStr = chalk.gray(` (${duration}m)`);
                        }
                    } else if (activity.durationMinutes > 0) {
                        // For the oldest activity in the display, use its stored duration
                        durationStr = chalk.gray(` (${activity.durationMinutes}m)`);
                    }
                    
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
    .option('-e, --export <format>', 'Export format (csv, json, ical)')
    .action(async (options) => {
        try {
            // Determine date range and get summary
            let summary, title;
            switch (options.period) {
                case 'today':
                    summary = dataManager.getTodaysSummary();
                    title = "Today's Report";
                    break;
                case 'week':
                    summary = dataManager.getTimeSummary(7);
                    title = "Weekly Report";
                    break;
                case 'month':
                    summary = dataManager.getTimeSummary(30);
                    title = "Monthly Report";
                    break;
                default:
                    console.error(chalk.red('❌ Invalid period. Use: today, week, or month'));
                    return;
            }

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
                const activitiesReversed = summary.activities.slice(-10).reverse();
                activitiesReversed.forEach((activity, index) => {
                    const timeStr = activity.timestampEnd.toLocaleTimeString('en-US', { 
                        hour: '2-digit', 
                        minute: '2-digit' 
                    });
                    
                    // For reverse display, calculate duration from previous activity
                    let durationStr = '';
                    if (index < activitiesReversed.length - 1) {
                        const nextActivity = activitiesReversed[index + 1];
                        const duration = Math.floor((activity.timestampEnd - nextActivity.timestampEnd) / (1000 * 60));
                        if (duration > 0) {
                            durationStr = chalk.gray(` (${duration}m)`);
                        }
                    } else if (activity.duration > 0) {
                        // For the oldest activity in the display, use its stored duration
                        durationStr = chalk.gray(` (${activity.duration}m)`);
                    }
                    
                    console.log(`  ${chalk.gray(timeStr)} - ${activity.activity}${durationStr}`);
                });
            }

            console.log(chalk.gray('\n💡 Use --export csv, --export json, or --export ical to export data'));
        } catch (error) {
            console.error(chalk.red('❌ Error generating report:'), error.message);
        }
    });

// Config command
program
    .command('config')
    .description('Configure pulse settings')
    .argument('[key]', 'Configuration key (optional - shows all config if omitted)')
    .argument('[value]', 'Configuration value (shows current value if omitted)')
    .action(async (key, value) => {
        try {
            // If no key provided, show all configuration
            if (!key) {
                console.log(chalk.blue('⚙️  Pulse Configuration'));
                console.log('='.repeat(40));
                
                // Get all config values
                const dataConfig = dataManager.config;
                const sessionConfig = sessionManager.getConfig();
                
                // Daemon settings
                console.log(chalk.yellow('\n📡 Daemon Settings:'));
                console.log(`  notificationInterval: ${dataConfig.notificationInterval} minutes`);
                console.log(`  dataRetentionDays: ${dataConfig.dataRetentionDays} days`);
                
                // Session management settings
                console.log(chalk.yellow('\n🔐 Session Management:'));
                console.log(`  autoStartOnLogin: ${sessionConfig.autoStart}`);
                console.log(`  autoStopOnLogout: ${sessionConfig.autoStop}`);
                console.log(`  autoStartOnUnlock: ${sessionConfig.autoStartOnUnlock}`);
                console.log(`  autoStopOnLock: ${sessionConfig.autoStopOnLock}`);
                console.log(`  sessionCheckInterval: ${sessionConfig.checkInterval} seconds`);

                // Logging settings
                const logConfig = logger.getConfig();
                console.log(chalk.yellow('\n📋 Logging:'));
                console.log(`  logLevel: ${logConfig.logLevel}`);
                console.log(`  logToConsole: ${logConfig.logToConsole}`);
                console.log(`  maxLogSizeMB: ${logConfig.maxLogSizeMB} MB`);
                console.log(`  logFile: ${logConfig.logFile}`);
                
                // Data directory
                console.log(chalk.yellow('\n📁 Storage:'));
                console.log(`  dataDir: ${dataManager.dataDir}`);
                
                console.log(chalk.blue('\n💡 Usage:'));
                console.log('  pulse config <key> <value>  Set a configuration value');
                console.log('  pulse config <key>          Show current value for key');
                console.log('  pulse config                Show all configuration');
                
                return;
            }
            
            // If key provided but no value, show current value
            if (!value) {
                let currentValue = null;
                
                // Check session manager config first
                if (['autoStartOnLogin', 'autoStopOnLogout', 'autoStartOnUnlock', 'autoStopOnLock', 'sessionCheckInterval'].includes(key)) {
                    const sessionConfig = sessionManager.getConfig();
                    if (key === 'autoStartOnLogin') currentValue = sessionConfig.autoStart;
                    else if (key === 'autoStopOnLogout') currentValue = sessionConfig.autoStop;
                    else if (key === 'autoStartOnUnlock') currentValue = sessionConfig.autoStartOnUnlock;
                    else if (key === 'autoStopOnLock') currentValue = sessionConfig.autoStopOnLock;
                    else if (key === 'sessionCheckInterval') currentValue = sessionConfig.checkInterval;
                } else if (['logLevel', 'logToConsole', 'maxLogSizeMB'].includes(key)) {
                    // Check logger config
                    const logConfig = logger.getConfig();
                    if (key === 'logLevel') currentValue = logConfig.logLevel;
                    else if (key === 'logToConsole') currentValue = logConfig.logToConsole;
                    else if (key === 'maxLogSizeMB') currentValue = logConfig.maxLogSizeMB;
                } else {
                    // Check data manager config
                    currentValue = dataManager.getConfig(key);
                }
                
                if (currentValue !== null && currentValue !== undefined) {
                    console.log(chalk.blue(`${key}:`), chalk.green(currentValue));
                } else {
                    console.error(chalk.red('❌ Unknown configuration key:'), key);
                    console.log('\nAvailable keys:');
                    console.log('  • notificationInterval - Minutes between notifications');
                    console.log('  • dataRetentionDays - Days to keep activity data');
                    console.log('  • autoStartOnLogin - Auto-start daemon on login (true/false)');
                    console.log('  • autoStopOnLogout - Auto-stop daemon on logout (true/false)');
                    console.log('  • autoStartOnUnlock - Auto-start daemon on screen unlock (true/false)');
                    console.log('  • autoStopOnLock - Auto-stop daemon on screen lock (true/false)');
                    console.log('  • sessionCheckInterval - Seconds between session checks');
                    console.log('  • logLevel - Log level (debug, info, warn, error)');
                    console.log('  • logToConsole - Log to console (true/false)');
                    console.log('  • maxLogSizeMB - Maximum log file size in MB');
                    
                    console.log(chalk.blue('\n💡 Examples:'));
                    console.log('  pulse config autoStartOnUnlock true   # Enable auto-start on screen unlock');
                    console.log('  pulse config autoStopOnLock true      # Enable auto-stop on screen lock');
                    console.log('  pulse config sessionCheckInterval 15  # Check session every 15 seconds');
                }
                return;
            }

            // Setting a new value
            // Convert value to appropriate type
            if (key === 'notificationInterval' || key === 'sessionCheckInterval' || key === 'maxLogSizeMB') {
                const numValue = parseInt(value);
                if (isNaN(numValue) || numValue < 1) {
                    console.error(chalk.red(`❌ ${key} must be a positive number`));
                    return;
                }
                value = numValue;
            } else if (key === 'autoStartOnLogin' || key === 'autoStopOnLogout' || key === 'autoStartOnUnlock' || 
                       key === 'autoStopOnLock' || key === 'logToConsole') {
                // Convert string to boolean
                value = value.toLowerCase() === 'true' || value === '1';
                
                // We only update the config value, not start monitoring
                // The monitoring will be started when the daemon starts
            } else if (key === 'logLevel') {
                if (!['debug', 'info', 'warn', 'error'].includes(value.toLowerCase())) {
                    console.error(chalk.red('❌ logLevel must be one of: debug, info, warn, error'));
                    return;
                }
                value = value.toLowerCase();
            }

            let configSet = false;
            
            // Try session manager config first
            if (['autoStartOnLogin', 'autoStopOnLogout', 'autoStartOnUnlock', 'autoStopOnLock', 'sessionCheckInterval'].includes(key)) {
                configSet = sessionManager.updateConfig(key, value);
            } else if (['logLevel', 'logToConsole', 'maxLogSizeMB'].includes(key)) {
                // Try logger config
                configSet = logger.updateConfig(key, value);
                if (configSet) {
                    await logger.logConfig('updated', key, value);
                }
            } else {
                // Fallback to data manager
                configSet = dataManager.setConfig(key, value);
            }

            if (configSet) {
                console.log(chalk.green('✅ Set'), `${key} = ${value}`);

                // Handle special cases
                if (key === 'notificationInterval' && daemonManager.isAlreadyRunning()) {
                    console.log(chalk.blue('🔄 Restarting daemon with new interval...'));
                    await daemonManager.stop();
                    await daemonManager.start();
                } else if (key === 'autoStartOnLogin' && value === true) {
                    console.log(chalk.blue('💡 Pulse will now auto-start when you log in'));
                } else if (key === 'autoStopOnLogout' && value === true) {
                    console.log(chalk.blue('💡 Pulse will now auto-stop when you log out'));
                } else if (key === 'autoStartOnUnlock' && value === true) {
                    console.log(chalk.blue('💡 Pulse will now auto-start when your screen is unlocked'));
                    console.log(chalk.gray('💡 Note: You need to start the daemon for this to take effect'));
                } else if (key === 'autoStopOnLock' && value === true) {
                    console.log(chalk.blue('💡 Pulse will now auto-stop when your screen is locked'));
                    console.log(chalk.gray('💡 Note: You need to start the daemon for this to take effect'));
                }
            } else {
                console.error(chalk.red('❌ Unknown configuration key:'), key);
                console.log('Available keys:');
                console.log('  • notificationInterval - Minutes between notifications');
                console.log('  • dataRetentionDays - Days to keep activity data');
                console.log('  • autoStartOnLogin - Auto-start daemon on login (true/false)');
                console.log('  • autoStopOnLogout - Auto-stop daemon on logout (true/false)');
                console.log('  • autoStartOnUnlock - Auto-start daemon on screen unlock (true/false)');
                console.log('  • autoStopOnLock - Auto-stop daemon on screen lock (true/false)');
                console.log('  • sessionCheckInterval - Seconds between session checks');
                console.log('  • logLevel - Log level (debug, info, warn, error)');
                console.log('  • logToConsole - Log to console (true/false)');
                console.log('  • maxLogSizeMB - Maximum log file size in MB');
                
                console.log(chalk.blue('\n💡 Examples:'));
                console.log('  pulse config autoStartOnUnlock true   # Enable auto-start on screen unlock');
                console.log('  pulse config autoStopOnLock true      # Enable auto-stop on screen lock');
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

// Test lock detection command
program
    .command('test-lock')
    .description('Test the screen lock/unlock detection')
    .option('--lock', 'Simulate screen lock')
    .option('--unlock', 'Simulate screen unlock')
    .option('--check', 'Check current lock state')
    .action(async (options) => {
        console.log('🧪 Testing screen lock detection...');
        
        try {
            if (!sessionManager.isSessionMonitoringActive()) {
                console.log(chalk.blue('🔄 Starting session monitoring temporarily...'));
                await sessionManager.startSessionMonitoring();
                console.log(chalk.green('✅ Session monitoring started'));
            }
            
            if (options.lock) {
                console.log(chalk.blue('🔒 Simulating screen lock...'));
                // Force the lock state to be unlocked first to ensure the change is detected
                sessionManager.lastLockState = false;
                sessionManager.handleLockStateChange(true);
                console.log(chalk.green('✅ Screen lock simulation complete'));
                console.log(chalk.gray('💡 Check the logs to see if auto-stop was triggered'));
            } else if (options.unlock) {
                console.log(chalk.blue('🔓 Simulating screen unlock...'));
                // Force the lock state to be locked first to ensure the change is detected
                sessionManager.lastLockState = true;
                sessionManager.handleLockStateChange(false);
                console.log(chalk.green('✅ Screen unlock simulation complete'));
                console.log(chalk.gray('💡 Check the logs to see if auto-start was triggered'));
            } else {
                // Default to checking current state
                const currentState = sessionManager.getCurrentLockState();
                console.log(chalk.blue('🔍 Current screen state:'), 
                    currentState === null ? 'Unknown' : 
                    currentState ? 'Locked' : 'Unlocked');
                
                // Also run a fresh check
                console.log(chalk.blue('🔄 Running a fresh lock state check...'));
                if (os.platform() === 'darwin') {
                    await sessionManager.checkMacOSLockState();
                } else if (os.platform() === 'linux') {
                    await sessionManager.checkLinuxLockState();
                } else if (os.platform() === 'win32') {
                    await sessionManager.checkWindowsLockState();
                }
            }
        } catch (error) {
            console.error(chalk.red('❌ Lock detection test error:'), error.message);
        }
    });

// Logs command
program
    .command('logs')
    .description('View and manage application logs')
    .option('-n, --lines <number>', 'Number of lines to show', '50')
    .option('-l, --level <level>', 'Filter by log level (debug, info, warn, error)')
    .option('-c, --category <category>', 'Filter by category (daemon, session, activity, etc)')
    .option('-f, --follow', 'Follow logs in real-time (tail -f style)')
    .option('--since <date>', 'Show logs since date/time (ISO format)')
    .option('--until <date>', 'Show logs until date/time (ISO format)')
    .option('--stats', 'Show log statistics')
    .option('--clear', 'Clear all logs')
    .option('--raw', 'Show raw JSON format')
    .action(async (options) => {
        try {
            if (options.clear) {
                const confirm = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'proceed',
                        message: '⚠️  Are you sure you want to clear all logs?',
                        default: false
                    }
                ]);

                if (confirm.proceed) {
                    await logger.clearLogs();
                    console.log(chalk.green('✅ Logs cleared successfully'));
                } else {
                    console.log(chalk.yellow('Operation cancelled'));
                }
                return;
            }

            if (options.stats) {
                const stats = await logger.getLogStats();
                console.log(chalk.blue('📊 Log Statistics'));
                console.log('='.repeat(40));
                console.log(chalk.gray('File:'), stats.logFile);
                console.log(chalk.gray('Size:'), `${stats.fileSizeMB} MB (${stats.fileSize} bytes)`);
                console.log(chalk.gray('Last modified:'), stats.lastModified.toLocaleString());
                console.log(chalk.gray('Total entries (recent):'), stats.totalEntries);
                
                if (Object.keys(stats.levelCounts).length > 0) {
                    console.log(chalk.yellow('\n📈 Log Levels:'));
                    Object.entries(stats.levelCounts).forEach(([level, count]) => {
                        const color = level === 'ERROR' ? 'red' : level === 'WARN' ? 'yellow' : 'gray';
                        console.log(`  ${chalk[color](level)}: ${count}`);
                    });
                }
                
                if (Object.keys(stats.categoryCounts).length > 0) {
                    console.log(chalk.yellow('\n📂 Categories:'));
                    Object.entries(stats.categoryCounts).forEach(([category, count]) => {
                        console.log(`  ${category}: ${count}`);
                    });
                }
                return;
            }

            if (options.follow) {
                console.log(chalk.blue('📄 Following logs... (Press Ctrl+C to stop)'));
                // Simple implementation - in a real app you'd use a proper tail mechanism
                let lastSize = 0;
                const followInterval = setInterval(async () => {
                    try {
                        const stats = await fs.stat(logger.logFile);
                        if (stats.size > lastSize) {
                            const logs = await logger.readLogs({ lines: 10 });
                            logs.slice(-5).forEach(entry => {
                                displayLogEntry(entry, options.raw);
                            });
                            lastSize = stats.size;
                        }
                    } catch (error) {
                        // Ignore errors in follow mode
                    }
                }, 1000);

                process.on('SIGINT', () => {
                    clearInterval(followInterval);
                    console.log(chalk.gray('\n📄 Stopped following logs'));
                    process.exit(0);
                });
                return;
            }

            // Read logs with filters
            const logOptions = {
                lines: parseInt(options.lines) || 50,
                ...(options.level && { level: options.level }),
                ...(options.category && { category: options.category }),
                ...(options.since && { since: options.since }),
                ...(options.until && { until: options.until })
            };

            const logs = await logger.readLogs(logOptions);
            
            if (logs.length === 0) {
                console.log(chalk.yellow('📄 No logs found matching criteria'));
                return;
            }

            console.log(chalk.blue(`📄 Showing ${logs.length} log entries`));
            console.log('='.repeat(60));

            logs.forEach(entry => displayLogEntry(entry, options.raw));

        } catch (error) {
            console.error(chalk.red('❌ Error reading logs:'), error.message);
        }
    });

function displayLogEntry(entry, raw = false) {
    if (raw) {
        console.log(JSON.stringify(entry, null, 2));
        return;
    }

    const timestamp = new Date(entry.timestampEnd).toLocaleString();
    const levelColor = {
        'DEBUG': 'gray',
        'INFO': 'blue',
        'WARN': 'yellow',
        'ERROR': 'red'
    }[entry.level] || 'white';

    console.log(
        chalk.gray(`[${timestamp}]`),
        chalk[levelColor](`[${entry.level}]`),
        chalk.cyan(`[${entry.category}]`),
        entry.message
    );

    if (entry.data) {
        console.log(chalk.gray('  Data:'), 
            typeof entry.data === 'object' ? 
                JSON.stringify(entry.data, null, 4).split('\n').map(line => '    ' + line).join('\n') :
                entry.data
        );
    }
}

// Session management command
program
    .command('session')
    .description('Manage automatic session start/stop')
    .option('--start', 'Start session monitoring')
    .option('--stop', 'Stop session monitoring')
    .option('--status', 'Show session monitoring status')
    .option('--enable-auto-start', 'Enable auto-start on login')
    .option('--disable-auto-start', 'Disable auto-start on login')
    .option('--enable-auto-stop', 'Enable auto-stop on logout')
    .option('--disable-auto-stop', 'Disable auto-stop on logout')
    .option('--enable-auto-start-unlock', 'Enable auto-start on screen unlock')
    .option('--disable-auto-start-unlock', 'Disable auto-start on screen unlock')
    .option('--enable-auto-stop-lock', 'Enable auto-stop on screen lock')
    .option('--disable-auto-stop-lock', 'Disable auto-stop on screen lock')
    .action(async (options) => {
        try {
            if (options.start) {
                console.log(chalk.blue('🔄 Starting session monitoring...'));
                await logger.info('session', 'Session monitoring start requested via CLI');
                await sessionManager.startSessionMonitoring();
                console.log(chalk.green('✅ Session monitoring started'));
            } else if (options.stop) {
                console.log(chalk.blue('🔄 Stopping session monitoring...'));
                await logger.info('session', 'Session monitoring stop requested via CLI');
                await sessionManager.stopSessionMonitoring();
                console.log(chalk.green('✅ Session monitoring stopped'));
            } else if (options.enableAutoStart) {
                sessionManager.updateConfig('autoStartOnLogin', true);
                console.log(chalk.green('✅ Auto-start on login enabled'));
            } else if (options.disableAutoStart) {
                sessionManager.updateConfig('autoStartOnLogin', false);
                console.log(chalk.green('✅ Auto-start on login disabled'));
            } else if (options.enableAutoStop) {
                sessionManager.updateConfig('autoStopOnLogout', true);
                console.log(chalk.green('✅ Auto-stop on logout enabled'));
            } else if (options.disableAutoStop) {
                sessionManager.updateConfig('autoStopOnLogout', false);
                console.log(chalk.green('✅ Auto-stop on logout disabled'));
            } else if (options.enableAutoStartUnlock) {
                sessionManager.updateConfig('autoStartOnUnlock', true);
                console.log(chalk.green('✅ Auto-start on screen unlock enabled'));
                console.log(chalk.gray('💡 Note: You need to start the daemon for this to take effect'));
                console.log(chalk.gray('💡 Run: pulse start'));
            } else if (options.disableAutoStartUnlock) {
                sessionManager.updateConfig('autoStartOnUnlock', false);
                console.log(chalk.green('✅ Auto-start on screen unlock disabled'));
            } else if (options.enableAutoStopLock) {
                sessionManager.updateConfig('autoStopOnLock', true);
                console.log(chalk.green('✅ Auto-stop on screen lock enabled'));
                console.log(chalk.gray('💡 Note: You need to start the daemon for this to take effect'));
                console.log(chalk.gray('💡 Run: pulse start'));
            } else if (options.disableAutoStopLock) {
                sessionManager.updateConfig('autoStopOnLock', false);
                console.log(chalk.green('✅ Auto-stop on screen lock disabled'));
            } else {
                // Default: show status
                const config = sessionManager.getConfig();
                const sessionState = sessionManager.getCurrentSessionState();
                const lockState = sessionManager.getCurrentLockState();
                
                console.log(chalk.blue('📊 Session Management Status'));
                console.log('='.repeat(40));
                console.log(chalk.gray('Platform:'), os.platform());
                
                const isMonitoring = sessionManager.isSessionMonitoringActive();
                console.log(chalk.gray('Monitoring active:'), isMonitoring ? '✅' : '❌');
                
                if (!isMonitoring && (config.autoStartOnUnlock || config.autoStopOnLock)) {
                    console.log(chalk.yellow('⚠️  Session monitoring is not active. Run "pulse start" to activate it.'));
                }
                
                console.log(chalk.gray('Current session:'), sessionState === null ? 'Unknown' : (sessionState ? 'Active' : 'Inactive'));
                console.log(chalk.gray('Current screen state:'), lockState === null ? 'Unknown' : (lockState ? 'Locked' : 'Unlocked'));
                console.log(chalk.gray('Auto-start on login:'), config.autoStart ? '✅' : '❌');
                console.log(chalk.gray('Auto-stop on logout:'), config.autoStop ? '✅' : '❌');
                console.log(chalk.gray('Auto-start on unlock:'), config.autoStartOnUnlock ? '✅' : '❌');
                console.log(chalk.gray('Auto-stop on lock:'), config.autoStopOnLock ? '✅' : '❌');
                console.log(chalk.gray('Check interval:'), `${config.checkInterval}s`);
                
                console.log(chalk.blue('\n💡 Usage:'));
                console.log('  pulse session --start                     Start session monitoring');
                console.log('  pulse session --stop                      Stop session monitoring');
                console.log('  pulse session --enable-auto-start         Enable auto-start on login');
                console.log('  pulse session --disable-auto-start        Disable auto-start on login');
                console.log('  pulse session --enable-auto-stop          Enable auto-stop on logout');
                console.log('  pulse session --disable-auto-stop         Disable auto-stop on logout');
                console.log('  pulse session --enable-auto-start-unlock  Enable auto-start on screen unlock');
                console.log('  pulse session --disable-auto-start-unlock Disable auto-start on screen unlock');
                console.log('  pulse session --enable-auto-stop-lock     Enable auto-stop on screen lock');
                console.log('  pulse session --disable-auto-stop-lock    Disable auto-stop on screen lock');
                
                console.log(chalk.blue('\n💡 Testing Lock/Unlock:'));
                console.log('  pulse test-lock --check                   Check current lock state');
                console.log('  pulse test-lock --lock                    Simulate screen lock');
                console.log('  pulse test-lock --unlock                  Simulate screen unlock');
            }
        } catch (error) {
            console.error(chalk.red('❌ Session management error:'), error.message);
        }
    });

// Clear data command
program
    .command('clear')
    .description('Clear all activity data')
    .option('-f, --force', 'Skip confirmation prompt')
    .option('--backups', 'Also clear backup files')
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
            
            // Clean up backups if requested
            if (options.backups) {
                const backupCount = await dataManager.cleanupBackups();
                if (backupCount > 0) {
                    console.log(chalk.green(`✅ Also cleaned up ${backupCount} backup files`));
                }
            }
        } catch (error) {
            console.error(chalk.red('❌ Error clearing data:'), error.message);
        }
    });

// Uninstall command
program
    .command('uninstall')
    .description('Completely remove Pulse and all its data')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (options) => {
        try {
            if (!options.force) {
                const confirm = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'proceed',
                        message: '⚠️  Are you sure you want to UNINSTALL Pulse? This will delete ALL data including backups, config, and logs. This cannot be undone.',
                        default: false
                    }
                ]);

                if (!confirm.proceed) {
                    console.log(chalk.yellow('Uninstall cancelled.'));
                    return;
                }
            }

            console.log(chalk.red('🗑️  Uninstalling Pulse...'));
            
            // Perform complete cleanup
            await dataManager.completeCleanup();
            
            console.log(chalk.green('✅ Pulse uninstalled successfully!'));
            console.log(chalk.gray('💡 All data has been removed from your system'));
            console.log(chalk.gray('💡 You can reinstall anytime with: npm install -g pulse-track-cli'));
            
        } catch (error) {
            console.error(chalk.red('❌ Error during uninstall:'), error.message);
        }
    });

// Export function
async function exportReport(summary, period, format) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `pulse_report_${period}_${timestamp}.${format}`;

    try {
        if (format === 'json') {
            await fs.writeJson(filename, summary, { spaces: 2 });
        } else if (format === 'csv') {
            const csvContent = generateCSV(summary);
            await fs.writeFile(filename, csvContent);
        } else if (format === 'ical') {
            const icalContent = generateICAL(summary, period);
            await fs.writeFile(filename, icalContent);
        } else {
            console.error(chalk.red('❌ Invalid export format. Use: csv, json, or ical'));
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
        const timestamp = activity.timestampEnd.toISOString();
        lines.push(`"${activity.activity}",${timeMinutes},${timeHours},${timestamp}`);
    });

    return lines.join('\n');
}

function generateICAL(summary, period) {
    const now = new Date();
    const dtStamp = formatICALDateTime(now);
    const uid = `pulse-report-${period}-${now.getTime()}`;
    
    let icalContent = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Pulse Tracker//Activity Report//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH'
    ];
    
    summary.activities.forEach((activity, index) => {
        if (activity.duration > 0) {
            const endTime = activity.timestampEnd;
            const startTime = new Date(endTime.getTime() - activity.duration * 60 * 1000);
            
            // Clean activity text for iCal format
            const cleanActivity = activity.activity.replace(/[,;\\]/g, '\\$&').replace(/\n/g, '\\n');
            
            icalContent.push(
                'BEGIN:VEVENT',
                `UID:pulse-activity-${activity.timestampEnd.getTime()}-${index}@pulse-tracker`,
                `DTSTART:${formatICALDateTime(startTime)}`,
                `DTEND:${formatICALDateTime(endTime)}`,
                `DTSTAMP:${dtStamp}`,
                `SUMMARY:${cleanActivity}`,
                `DESCRIPTION:Duration: ${activity.duration} minutes`,
                'CATEGORIES:Work,Productivity',
                'END:VEVENT'
            );
        }
    });
    
    icalContent.push('END:VCALENDAR');
    return icalContent.join('\r\n');
}

function formatICALDateTime(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function parseTimestamp(options) {
    const now = new Date();
    
    if (options.ago) {
        // Parse duration ago using ms library (e.g., "30m", "2h", "1h 30m")
        const duration = ms(options.ago);
        if (duration === undefined) {
            throw new Error('Invalid ago format. Use formats like "30m", "2h", "1h 30m"');
        }
        
        return new Date(now.getTime() - duration);
    }
    
    if (options.time) {
        const timeStr = options.time;
        
        // Check if it's full datetime (YYYY-MM-DD HH:MM)
        if (timeStr.includes('-') && timeStr.includes(' ')) {
            const parsed = new Date(timeStr);
            if (isNaN(parsed.getTime())) {
                throw new Error('Invalid datetime format. Use YYYY-MM-DD HH:MM');
            }
            return parsed;
        }
        
        // Just time (HH:MM) - use today's date
        const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
        if (!timeMatch) {
            throw new Error('Invalid time format. Use HH:MM or YYYY-MM-DD HH:MM');
        }
        
        const hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        
        if (hours > 23 || minutes > 59) {
            throw new Error('Invalid time values');
        }
        
        const baseDate = options.date ? new Date(options.date) : new Date();
        baseDate.setHours(hours, minutes, 0, 0);
        return baseDate;
    }
    
    if (options.date) {
        // Just date (YYYY-MM-DD) - use current time
        const parsed = new Date(options.date);
        if (isNaN(parsed.getTime())) {
            throw new Error('Invalid date format. Use YYYY-MM-DD');
        }
        
        // Set to current time on that date
        parsed.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
        return parsed;
    }
    
    return null;
}

function parseDuration(durationStr) {
    // Parse duration using ms library (e.g., "30m", "2h", "1h 30m")
    const durationMs = ms(durationStr);
    if (durationMs === undefined) {
        throw new Error('Invalid duration format. Use formats like "30m", "2h", "1h 30m"');
    }
    
    // Convert to minutes
    return Math.floor(durationMs / (1000 * 60));
}

module.exports = program;

// If this file is run directly, parse command line arguments
if (require.main === module) {
    program.parseAsync();
}

