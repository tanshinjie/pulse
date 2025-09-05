const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

class Activity {
    constructor(activity, timestamp = null, id = null) {
        this.id = id || uuidv4();
        this.timestamp = timestamp || new Date();
        this.activity = activity;
        this.durationMinutes = 0; // Will be calculated when next activity is logged
    }

    toJSON() {
        return {
            id: this.id,
            timestamp: this.timestamp.toISOString(),
            activity: this.activity,
            durationMinutes: this.durationMinutes
        };
    }

    static fromJSON(data) {
        const activity = new Activity(
            data.activity,
            new Date(data.timestamp),
            data.id
        );
        activity.durationMinutes = data.durationMinutes || 0;
        return activity;
    }
}

class DataManager {
    constructor(dataDir = null) {
        this.dataDir = dataDir || path.join(os.homedir(), '.pulse_track_data');
        this.configFile = path.join(this.dataDir, 'config.json');
        this.activitiesFile = path.join(this.dataDir, 'activities.json');
        
        // Ensure data directory exists
        fs.ensureDirSync(this.dataDir);
        
        this.config = this.loadConfig();
        this.activities = this.loadActivities();
    }

    loadConfig() {
        const defaultConfig = {
            notificationInterval: 30,
            dataRetentionDays: 365
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
            fs.writeJsonSync(this.configFile, this.config, { spaces: 2 });
        } catch (error) {
            console.error('Error saving config:', error.message);
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
            const data = this.activities.map(activity => activity.toJSON());
            fs.writeJsonSync(this.activitiesFile, data, { spaces: 2 });
        } catch (error) {
            console.error('Error saving activities:', error.message);
        }
    }

    addActivity(activity) {
        const newActivity = new Activity(activity);

        // Calculate duration for the previous activity
        if (this.activities.length > 0) {
            const lastActivity = this.activities[this.activities.length - 1];
            const duration = (newActivity.timestamp - lastActivity.timestamp) / (1000 * 60); // minutes
            lastActivity.durationMinutes = Math.max(0, Math.floor(duration));
        }

        this.activities.push(newActivity);
        this.saveActivities();
        return newActivity;
    }

    getRecentActivities(hours = 24) {
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
        return this.activities.filter(a => a.timestamp >= cutoff);
    }

    getActivitiesByDate(date) {
        const start = new Date(date);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        
        return this.activities.filter(a => a.timestamp >= start && a.timestamp < end);
    }

    getTimeSummary(days = 1) {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const recentActivities = this.activities.filter(a => a.timestamp >= cutoff);

        let totalTime = 0;
        const activities = [];

        for (const activity of recentActivities) {
            const duration = activity.durationMinutes;
            totalTime += duration;
            activities.push({
                activity: activity.activity,
                duration: duration,
                timestamp: activity.timestamp
            });
        }

        return {
            totalTimeMinutes: totalTime,
            activities: activities,
            activityCount: recentActivities.length,
            periodDays: days
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
        this.activities = this.activities.filter(a => a.timestamp >= cutoff);
        
        if (this.activities.length < originalCount) {
            this.saveActivities();
            console.log(`Cleaned up ${originalCount - this.activities.length} old activities`);
        }
    }
}

module.exports = { DataManager, Activity };

