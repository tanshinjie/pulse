const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

class Activity {
    constructor(activity, timestampEnd = null, durationMinutes = null, id = null) {
        this.id = id || uuidv4();
        this.timestampEnd = timestampEnd || new Date();
        this.activity = activity;
        
        // Calculate timestampStart based on duration
        if (durationMinutes !== null && durationMinutes > 0) {
            this.timestampStart = new Date(this.timestampEnd.getTime() - (durationMinutes * 60 * 1000));
        } else {
            // Default to 0 duration (current moment)
            this.timestampStart = this.timestampEnd;
        }
    }

    // Get duration in minutes
    get durationMinutes() {
        return Math.floor((this.timestampEnd - this.timestampStart) / (1000 * 60));
    }

    // Set duration by adjusting timestampStart
    set durationMinutes(minutes) {
        this.timestampStart = new Date(this.timestampEnd.getTime() - (minutes * 60 * 1000));
    }

    toJSON() {
        return {
            id: this.id,
            timestampStart: this.timestampStart.toISOString(),
            timestampEnd: this.timestampEnd.toISOString(),
            activity: this.activity
        };
    }

    static fromJSON(data) {
        const activity = new Activity(
            data.activity,
            new Date(data.timestampEnd),
            null, // duration will be calculated
            data.id
        );
        activity.timestampStart = new Date(data.timestampStart);
        return activity;
    }
}

class DataManager {
    constructor(dataDir = null) {
        this.dataDir = dataDir || path.join(os.homedir(), '.pulse_track_data');
        this.configFile = path.join(this.dataDir, 'config.json');
        this.activitiesFile = path.join(this.dataDir, 'activities.json');
        this.backupDir = path.join(this.dataDir, 'backups');
        
        // Ensure data directory exists
        fs.ensureDirSync(this.dataDir);
        fs.ensureDirSync(this.backupDir);
        
        // Initialize data directory
        
        // Load data with integrity checks
        this.config = this.loadConfigWithIntegrityCheck();
        this.activities = this.loadActivitiesWithIntegrityCheck();
        
        // Check for emergency pre-shutdown backup and recover if needed
        this.checkEmergencyRecovery();
        
        // Data loaded successfully
    }

    loadConfig() {
        const defaultConfig = {
            notificationInterval: 30,
            dataRetentionDays: 365,
            autoStartOnLogin: true,
            autoStopOnLogout: true,
            autoStartOnUnlock: true,
            autoStopOnLock: true,
            sessionCheckInterval: 30,
            logLevel: 'info',
            logToConsole: false,
            maxLogSizeMB: 10
        };

        try {
            if (fs.existsSync(this.configFile)) {
                const config = fs.readJsonSync(this.configFile);
                return { ...defaultConfig, ...config };
            }
        } catch (error) {
            console.warn('Error loading config, using defaults:', error.message);
        }

        return defaultConfig;
    }

    saveConfig() {
        try {
            // Create backup before saving
            this.createBackup(this.configFile, 'config');
            
            fs.writeJsonSync(this.configFile, this.config, { spaces: 2 });
            
            // Verify the write was successful
            this.verifyFileWrite(this.configFile, this.config);
        } catch (error) {
            console.error('Error saving config:', error.message);
            // Attempt to restore from backup
            this.restoreFromBackup('config');
        }
    }

    loadActivities() {
        try {
            if (fs.existsSync(this.activitiesFile)) {
                const data = fs.readJsonSync(this.activitiesFile);
                return data.map(item => Activity.fromJSON(item));
            }
        } catch (error) {
            console.warn('Error loading activities, starting fresh:', error.message);
        }

        return [];
    }

    saveActivities() {
        try {
            // Create backup before saving
            this.createBackup(this.activitiesFile, 'activities');
            
            const data = this.activities.map(activity => activity.toJSON());
            fs.writeJsonSync(this.activitiesFile, data, { spaces: 2 });
            
            // Verify the write was successful
            this.verifyFileWrite(this.activitiesFile, data);
        } catch (error) {
            console.error('❌ Error saving activities:', error.message);
            // Attempt to restore from backup
            this.restoreFromBackup('activities');
        }
    }

    addActivity(activity, timestampEnd = null, durationMinutes = null) {
        const newActivity = new Activity(activity, timestampEnd, durationMinutes);

        // If no duration specified, calculate it based on previous activity
        if (durationMinutes === null) {
            let previousEndTime = null;
            
            if (this.activities.length > 0) {
                // Find the most recent activity before this timestamp
                const previousActivity = this.activities
                    .filter(a => a.timestampEnd < newActivity.timestampEnd)
                    .sort((a, b) => b.timestampEnd - a.timestampEnd)[0];
                
                if (previousActivity) {
                    previousEndTime = previousActivity.timestampEnd;
                }
            }
            
            // If no previous record, use the start of the same day as the new activity
            if (!previousEndTime) {
                const dayStart = new Date(newActivity.timestampEnd);
                dayStart.setHours(0, 0, 0, 0);
                previousEndTime = dayStart;
            }
            
            // Calculate duration from previous activity end to current activity end
            const duration = (newActivity.timestampEnd - previousEndTime) / (1000 * 60); // minutes
            newActivity.durationMinutes = Math.max(0, Math.floor(duration));
        }

        // Insert activity in chronological order
        const insertIndex = this.findInsertIndex(newActivity.timestampEnd);
        this.activities.splice(insertIndex, 0, newActivity);

        this.saveActivities();
        return newActivity;
    }

    findInsertIndex(timestampEnd) {
        // Find the correct position to insert the new activity chronologically
        let left = 0;
        let right = this.activities.length;
        
        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (this.activities[mid].timestampEnd <= timestampEnd) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }
        
        return left;
    }

    recalculateDurations(fromIndex = 0) {
        // Recalculate durations from the affected index backwards to avoid missing any
        const startIndex = Math.max(0, fromIndex - 1);
        
        for (let i = startIndex; i < this.activities.length; i++) {
            const current = this.activities[i];
            const previous = this.activities[i - 1];
            
            if (previous) {
                // Calculate duration from previous activity end to current activity end
                // This represents how long was spent on the previous task
                const duration = (current.timestampEnd - previous.timestampEnd) / (1000 * 60); // minutes
                previous.durationMinutes = Math.max(0, Math.floor(duration));
            }
            
            // The current (most recent) activity always has 0 duration until next activity is logged
            if (i === this.activities.length - 1) {
                current.durationMinutes = 0;
            }
        }
    }

    updateActivity(id, updates) {
        const activityIndex = this.activities.findIndex(a => a.id === id);
        if (activityIndex === -1) {
            throw new Error('Activity not found');
        }

        const activity = this.activities[activityIndex];
        let needsRecalculation = false;

        // Update description if provided
        if (updates.activity !== undefined) {
            activity.activity = updates.activity;
        }

        // Update timestampEnd if provided
        if (updates.timestampEnd !== undefined) {
            const newTimestampEnd = new Date(updates.timestampEnd);
            
            // Remove activity from current position
            this.activities.splice(activityIndex, 1);
            
            // Update timestampEnd
            activity.timestampEnd = newTimestampEnd;
            
            // Find new position and insert
            const newIndex = this.findInsertIndex(newTimestampEnd);
            this.activities.splice(newIndex, 0, activity);
            
            needsRecalculation = true;
        }

        // Update duration if provided (this will override calculated duration)
        if (updates.durationMinutes !== undefined) {
            activity.durationMinutes = Math.max(0, parseInt(updates.durationMinutes));
        }

        // Recalculate all durations if timestamp was changed
        if (needsRecalculation) {
            this.recalculateDurations();
        }

        this.saveActivities();
        return activity;
    }

    deleteActivity(id) {
        const activityIndex = this.activities.findIndex(a => a.id === id);
        if (activityIndex === -1) {
            throw new Error('Activity not found');
        }

        // Remove the activity
        this.activities.splice(activityIndex, 1);
        
        // Recalculate durations since we removed an activity
        this.recalculateDurations();
        
        this.saveActivities();
        return true;
    }

    getRecentActivities(hours = 24) {
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
        return this.activities.filter(a => a.timestampEnd >= cutoff);
    }

    getActivitiesByDate(date) {
        const start = new Date(date);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        
        return this.activities.filter(a => a.timestampEnd >= start && a.timestampEnd < end);
    }

    getTimeSummary(days = 1) {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const recentActivities = this.activities.filter(a => a.timestampEnd >= cutoff);

        let totalTime = 0;
        const activities = [];

        for (const activity of recentActivities) {
            const duration = activity.durationMinutes;
            totalTime += duration;
            activities.push({
                activity: activity.activity,
                duration: duration,
                timestampStart: activity.timestampStart,
                timestampEnd: activity.timestampEnd
            });
        }

        return {
            totalTimeMinutes: totalTime,
            activities: activities,
            activityCount: recentActivities.length,
            periodDays: days
        };
    }

    getTodaysSummary() {
        // Get activities from 00:00 today onwards
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todaysActivities = this.activities.filter(a => a.timestampEnd >= today);

        let totalTime = 0;
        const activities = [];

        for (const activity of todaysActivities) {
            const duration = activity.durationMinutes;
            totalTime += duration;
            activities.push({
                activity: activity.activity,
                duration: duration,
                timestampStart: activity.timestampStart,
                timestampEnd: activity.timestampEnd
            });
        }

        return {
            totalTimeMinutes: totalTime,
            activities: activities,
            activityCount: todaysActivities.length,
            periodDays: 'today'
        };
    }

    getDateSummary(date) {
        // Get activities for a specific date
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);
        
        const dateActivities = this.activities.filter(a => 
            a.timestampEnd >= startOfDay && a.timestampEnd <= endOfDay
        );

        let totalTime = 0;
        const activities = [];

        for (const activity of dateActivities) {
            const duration = activity.durationMinutes;
            totalTime += duration;
            activities.push({
                activity: activity.activity,
                duration: duration,
                timestampStart: activity.timestampStart,
                timestampEnd: activity.timestampEnd
            });
        }

        const dateString = date.toISOString().split('T')[0]; // YYYY-MM-DD format

        return {
            totalTimeMinutes: totalTime,
            activities: activities,
            activityCount: dateActivities.length,
            periodDays: dateString,
            reportDate: dateString
        };
    }

    setConfig(key, value) {
        if (key in this.config) {
            this.config[key] = value;
            this.saveConfig();
            return true;
        }
        return false;
    }

    getConfig(key, defaultValue = null) {
        return this.config[key] !== undefined ? this.config[key] : defaultValue;
    }

    // Cleanup old activities based on retention policy
    cleanupOldActivities() {
        const retentionDays = this.config.dataRetentionDays;
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
        
        const originalCount = this.activities.length;
        this.activities = this.activities.filter(a => a.timestampEnd >= cutoff);
        
        if (this.activities.length < originalCount) {
            this.saveActivities();
            console.log(`Cleaned up ${originalCount - this.activities.length} old activities`);
        }
    }
    
    // Enhanced data integrity methods
    loadConfigWithIntegrityCheck() {
        try {
            const config = this.loadConfig();
            
            // Additional integrity check for config
            if (!config || typeof config !== 'object') {
                console.warn('Config data appears corrupted, attempting recovery...');
                return this.recoverConfig();
            }
            
            return config;
        } catch (error) {
            console.error('Config integrity check failed:', error.message);
            return this.recoverConfig();
        }
    }
    
    loadActivitiesWithIntegrityCheck() {
        try {
            const activities = this.loadActivities();
            
            // Validate activities structure
            if (!Array.isArray(activities)) {
                console.warn('Activities data appears corrupted, attempting recovery...');
                return this.recoverActivities();
            }
            
            // Check for corrupted activity entries
            const validActivities = activities.filter(activity => {
                return activity && 
                       activity.id && 
                       activity.timestampStart && 
                       activity.timestampEnd && 
                       activity.activity;
            });
            
            if (validActivities.length !== activities.length) {
                console.warn(`Found ${activities.length - validActivities.length} corrupted activity entries, filtering them out`);
                // Save the cleaned activities
                setTimeout(() => {
                    this.activities = validActivities;
                    this.saveActivities();
                }, 100);
            }
            
            return validActivities;
        } catch (error) {
            console.error('Activities integrity check failed:', error.message);
            return this.recoverActivities();
        }
    }
    
    createBackup(filePath, type) {
        try {
            if (fs.existsSync(filePath)) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const backupPath = path.join(this.backupDir, `${type}_${timestamp}.json`);
                fs.copySync(filePath, backupPath);
            }
        } catch (error) {
            console.warn(`Failed to create backup for ${type}:`, error.message);
        }
    }
    
    verifyFileWrite(filePath, expectedData) {
        try {
            if (fs.existsSync(filePath)) {
                const writtenData = fs.readJsonSync(filePath);
                const expectedString = JSON.stringify(expectedData);
                const writtenString = JSON.stringify(writtenData);
                
                if (expectedString !== writtenString) {
                    throw new Error('File verification failed - written data does not match expected data');
                }
            } else {
                throw new Error('File verification failed - file does not exist after write');
            }
        } catch (error) {
            console.error(`File verification failed for ${filePath}:`, error.message);
            throw error;
        }
    }
    
    restoreFromBackup(type) {
        try {
            const backupFiles = fs.readdirSync(this.backupDir)
                .filter(file => file.startsWith(`${type}_`) && file.endsWith('.json'))
                .sort()
                .reverse();
                
            if (backupFiles.length > 0) {
                const latestBackup = path.join(this.backupDir, backupFiles[0]);
                const targetFile = type === 'config' ? this.configFile : this.activitiesFile;
                
                console.log(`Restoring ${type} from backup: ${backupFiles[0]}`);
                fs.copySync(latestBackup, targetFile);
                
                // Reload the data
                if (type === 'config') {
                    this.config = this.loadConfig();
                } else {
                    this.activities = this.loadActivities();
                }
                
                return true;
            }
        } catch (error) {
            console.error(`Failed to restore ${type} from backup:`, error.message);
        }
        return false;
    }
    
    recoverConfig() {
        console.warn('Attempting to recover config from backup...');
        
        if (this.restoreFromBackup('config')) {
            return this.config;
        }
        
        // Fall back to default config
        console.warn('No backup found, using default config');
        const defaultConfig = {
            notificationInterval: 30,
            dataRetentionDays: 365,
            autoStartOnLogin: true,
            autoStopOnLogout: true,
            autoStartOnUnlock: true,
            autoStopOnLock: true,
            sessionCheckInterval: 30,
            logLevel: 'info',
            logToConsole: false,
            maxLogSizeMB: 10
        };
        
        this.config = defaultConfig;
        this.saveConfig();
        return defaultConfig;
    }
    
    recoverActivities() {
        console.warn('Attempting to recover activities from backup...');
        
        if (this.restoreFromBackup('activities')) {
            return this.activities;
        }
        
        // Fall back to empty activities list
        console.warn('No backup found, starting with empty activities list');
        return [];
    }
    
    // Emergency recovery method to check for pre-shutdown backup
    checkEmergencyRecovery() {
        const emergencyFile = path.join(this.dataDir, 'emergency_pre_shutdown.json');
        
        try {
            if (fs.existsSync(emergencyFile)) {
                console.log('🚨 Emergency pre-shutdown backup found, checking if recovery needed...');
                
                const emergencyBackup = fs.readJsonSync(emergencyFile);
                console.log(`📊 Emergency backup: ${emergencyBackup.activitiesCount} activities from process ${emergencyBackup.processId}`);
                console.log(`🕒 Emergency backup created: ${emergencyBackup.timestamp}`);
                
                // More intelligent recovery check:
                // 1. Check if a daemon is currently running
                // 2. Check if activities file is more recent than emergency backup
                // 3. Only recover if there's actual data loss
                
                const daemonRunning = this.isDaemonRunning();
                const activitiesFileStats = fs.existsSync(this.activitiesFile) ? fs.statSync(this.activitiesFile) : null;
                const emergencyTime = new Date(emergencyBackup.timestamp);
                const activitiesFileTime = activitiesFileStats ? activitiesFileStats.mtime : new Date(0);
                
                console.log(`🔍 Recovery analysis:`);
                console.log(`   - Daemon running: ${daemonRunning}`);
                console.log(`   - Emergency backup time: ${emergencyTime.toISOString()}`);
                console.log(`   - Activities file modified: ${activitiesFileTime.toISOString()}`);
                console.log(`   - Current activities: ${this.activities.length}, Backup: ${emergencyBackup.activitiesCount}`);
                
                // Only recover if:
                // 1. No daemon is running AND
                // 2. Activities file is older than emergency backup OR
                // 3. Current activities count is significantly less than backup
                const shouldRecover = !daemonRunning && 
                                    (activitiesFileTime < emergencyTime || 
                                     this.activities.length < (emergencyBackup.activitiesCount - 1));
                
                if (shouldRecover) {
                    console.warn(`⚠️ Data loss detected! Recovering from emergency backup...`);
                    
                    // Recover activities from emergency backup
                    this.activities = emergencyBackup.activities.map(data => Activity.fromJSON(data));
                    
                    // Also recover config if it exists in backup
                    if (emergencyBackup.config) {
                        this.config = { ...this.config, ...emergencyBackup.config };
                    }
                    
                    // Save the recovered data
                    this.saveActivities();
                    this.saveConfig();
                    
                    console.log(`✅ Recovery successful! Restored ${this.activities.length} activities`);
                } else {
                    console.log('✅ No recovery needed - data appears to be current');
                }
                
                // Only clean up emergency backup if daemon is not running or recovery was performed
                if (!daemonRunning || shouldRecover) {
                    fs.removeSync(emergencyFile);
                    console.log('🧹 Emergency backup file cleaned up');
                } else {
                    console.log('⏳ Keeping emergency backup - daemon may still be using it');
                }
                
            } else {
                console.log('ℹ️ No emergency backup found (normal startup)');
            }
        } catch (error) {
            console.error('❌ Error during emergency recovery check:', error.message);
            // Don't fail startup if emergency recovery fails
        }
    }
    
    // Check if daemon is currently running
    isDaemonRunning() {
        try {
            const pidFile = path.join(this.dataDir, 'tracker.pid');
            if (fs.existsSync(pidFile)) {
                const pid = parseInt(fs.readFileSync(pidFile, 'utf8'));
                // Check if process is actually running
                process.kill(pid, 0); // Doesn't actually kill, just checks if process exists
                return true;
            }
            return false;
        } catch (error) {
            // Process doesn't exist or we can't check it
            return false;
        }
    }
    
    // Complete cleanup method for uninstall
    async completeCleanup() {
        try {
            console.log('🧹 Starting complete data cleanup...');
            
            // Stop any running daemon first
            if (this.isDaemonRunning()) {
                console.log('🛑 Stopping daemon before cleanup...');
                try {
                    const pidFile = path.join(this.dataDir, 'tracker.pid');
                    const pid = parseInt(fs.readFileSync(pidFile, 'utf8'));
                    process.kill(pid, 'SIGTERM');
                    
                    // Wait a bit for graceful shutdown
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    // Force kill if still running
                    try {
                        process.kill(pid, 0);
                        process.kill(pid, 'SIGKILL');
                    } catch (error) {
                        // Process already stopped
                    }
                } catch (error) {
                    console.warn('Could not stop daemon:', error.message);
                }
            }
            
            // Remove entire data directory
            if (fs.existsSync(this.dataDir)) {
                console.log(`🗑️ Removing data directory: ${this.dataDir}`);
                await fs.remove(this.dataDir);
                console.log('✅ Data directory removed successfully');
            } else {
                console.log('ℹ️ No data directory found to clean up');
            }
            
            return true;
        } catch (error) {
            console.error('❌ Error during complete cleanup:', error.message);
            throw error;
        }
    }
    
    // Clean up backup files only
    async cleanupBackups() {
        try {
            if (fs.existsSync(this.backupDir)) {
                const backupFiles = fs.readdirSync(this.backupDir);
                console.log(`🧹 Found ${backupFiles.length} backup files to clean up`);
                
                for (const file of backupFiles) {
                    const filePath = path.join(this.backupDir, file);
                    await fs.remove(filePath);
                }
                
                // Remove backup directory if empty
                await fs.remove(this.backupDir);
                console.log('✅ Backup files cleaned up successfully');
                return backupFiles.length;
            } else {
                console.log('ℹ️ No backup directory found');
                return 0;
            }
        } catch (error) {
            console.error('❌ Error cleaning up backups:', error.message);
            throw error;
        }
    }
}

module.exports = { DataManager, Activity };

