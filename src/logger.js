const fs = require('fs-extra');
const path = require('path');
const os = require('os');

class Logger {
    constructor(dataManager) {
        this.dataManager = dataManager;
        this.logFile = path.join(dataManager.dataDir, 'pulse.log');
        this.maxLogSize = dataManager.getConfig('maxLogSizeMB', 10) * 1024 * 1024; // Convert MB to bytes
        this.logLevel = dataManager.getConfig('logLevel', 'info'); // debug, info, warn, error
        this.enableConsole = dataManager.getConfig('logToConsole', false);
        
        // Ensure log file exists
        this.ensureLogFile();
    }

    ensureLogFile() {
        try {
            if (!fs.existsSync(this.logFile)) {
                fs.writeFileSync(this.logFile, '');
            }
        } catch (error) {
            console.warn('Warning: Could not create log file:', error.message);
        }
    }

    formatLogEntry(level, category, message, data = null) {
        const timestamp = new Date().toISOString();
        const pid = process.pid;
        const platform = os.platform();
        
        const entry = {
            timestamp,
            pid,
            platform,
            level: level.toUpperCase(),
            category,
            message,
            ...(data && { data })
        };

        return JSON.stringify(entry);
    }

    shouldLog(level) {
        const levels = { debug: 0, info: 1, warn: 2, error: 3 };
        return levels[level] >= levels[this.logLevel];
    }

    async writeLog(level, category, message, data = null) {
        if (!this.shouldLog(level)) {
            return;
        }

        const logEntry = this.formatLogEntry(level, category, message, data);
        
        try {
            // Check log file size and rotate if necessary
            await this.rotateLogIfNeeded();
            
            // Write to file
            await fs.appendFile(this.logFile, logEntry + '\n');
            
            // Also log to console if enabled
            if (this.enableConsole) {
                const consoleMsg = `[${new Date().toLocaleTimeString()}] [${level.toUpperCase()}] [${category}] ${message}`;
                console.log(consoleMsg);
                if (data) {
                    console.log('  Data:', data);
                }
            }
        } catch (error) {
            // Fallback to console if file writing fails
            console.error('Log write failed:', error.message);
            console.log(`[${level.toUpperCase()}] [${category}] ${message}`);
        }
    }

    async rotateLogIfNeeded() {
        try {
            const stats = await fs.stat(this.logFile);
            if (stats.size > this.maxLogSize) {
                // Create backup
                const backupFile = this.logFile + '.old';
                await fs.move(this.logFile, backupFile, { overwrite: true });
                
                // Create new log file
                await fs.writeFile(this.logFile, '');
                
                await this.info('system', 'Log rotated', { 
                    oldSize: stats.size, 
                    maxSize: this.maxLogSize 
                });
            }
        } catch (error) {
            // Ignore rotation errors
        }
    }

    // Convenience methods for different log levels
    async debug(category, message, data = null) {
        await this.writeLog('debug', category, message, data);
    }

    async info(category, message, data = null) {
        await this.writeLog('info', category, message, data);
    }

    async warn(category, message, data = null) {
        await this.writeLog('warn', category, message, data);
    }

    async error(category, message, data = null) {
        await this.writeLog('error', category, message, data);
    }

    // Specific logging methods for different components
    async logDaemonEvent(event, details = null) {
        await this.info('daemon', `Daemon ${event}`, details);
    }

    async logSessionEvent(event, details = null) {
        await this.info('session', `Session ${event}`, details);
    }

    async logActivity(action, activity, details = null) {
        await this.info('activity', `${action}: ${activity}`, details);
    }

    async logNotification(action, details = null) {
        await this.info('notification', `Notification ${action}`, details);
    }

    async logConfig(action, key, value, oldValue = null) {
        await this.info('config', `Config ${action}: ${key}`, { 
            newValue: value, 
            ...(oldValue !== null && { oldValue }) 
        });
    }

    async logError(category, error, context = null) {
        const errorData = {
            message: error.message,
            stack: error.stack,
            ...(context && { context })
        };
        await this.error(category, `Error: ${error.message}`, errorData);
    }

    // Read logs with filtering
    async readLogs(options = {}) {
        const {
            lines = 100,
            level = null,
            category = null,
            since = null,
            until = null
        } = options;

        try {
            const logContent = await fs.readFile(this.logFile, 'utf8');
            const logLines = logContent.trim().split('\n').filter(line => line.trim());
            
            let filteredLogs = logLines.map(line => {
                try {
                    return JSON.parse(line);
                } catch (e) {
                    return null;
                }
            }).filter(entry => entry !== null);

            // Apply filters
            if (level) {
                const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
                const minLevel = levels[level.toUpperCase()] || 0;
                filteredLogs = filteredLogs.filter(entry => 
                    levels[entry.level] >= minLevel
                );
            }

            if (category) {
                filteredLogs = filteredLogs.filter(entry => 
                    entry.category.toLowerCase().includes(category.toLowerCase())
                );
            }

            if (since) {
                const sinceDate = new Date(since);
                filteredLogs = filteredLogs.filter(entry => 
                    new Date(entry.timestamp) >= sinceDate
                );
            }

            if (until) {
                const untilDate = new Date(until);
                filteredLogs = filteredLogs.filter(entry => 
                    new Date(entry.timestamp) <= untilDate
                );
            }

            // Return most recent entries
            return filteredLogs.slice(-lines);
        } catch (error) {
            throw new Error(`Failed to read logs: ${error.message}`);
        }
    }

    // Get log statistics
    async getLogStats() {
        try {
            const stats = await fs.stat(this.logFile);
            const logs = await this.readLogs({ lines: 1000 }); // Sample recent logs
            
            const levelCounts = logs.reduce((acc, entry) => {
                acc[entry.level] = (acc[entry.level] || 0) + 1;
                return acc;
            }, {});

            const categoryCounts = logs.reduce((acc, entry) => {
                acc[entry.category] = (acc[entry.category] || 0) + 1;
                return acc;
            }, {});

            return {
                fileSize: stats.size,
                fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2),
                lastModified: stats.mtime,
                totalEntries: logs.length,
                levelCounts,
                categoryCounts,
                logFile: this.logFile
            };
        } catch (error) {
            throw new Error(`Failed to get log stats: ${error.message}`);
        }
    }

    // Clear logs
    async clearLogs() {
        try {
            await fs.writeFile(this.logFile, '');
            await this.info('system', 'Logs cleared by user');
        } catch (error) {
            throw new Error(`Failed to clear logs: ${error.message}`);
        }
    }

    // Update logging configuration
    updateConfig(key, value) {
        switch (key) {
            case 'logLevel':
                if (['debug', 'info', 'warn', 'error'].includes(value)) {
                    this.logLevel = value;
                    this.dataManager.setConfig('logLevel', value);
                    return true;
                }
                break;
            case 'logToConsole':
                this.enableConsole = Boolean(value);
                this.dataManager.setConfig('logToConsole', this.enableConsole);
                return true;
            case 'maxLogSizeMB':
                const sizeMB = parseInt(value);
                if (sizeMB > 0) {
                    this.maxLogSize = sizeMB * 1024 * 1024;
                    this.dataManager.setConfig('maxLogSizeMB', sizeMB);
                    return true;
                }
                break;
            default:
                return false;
        }
        return false;
    }

    getConfig() {
        return {
            logLevel: this.logLevel,
            logToConsole: this.enableConsole,
            maxLogSizeMB: Math.floor(this.maxLogSize / (1024 * 1024)),
            logFile: this.logFile
        };
    }
}

module.exports = Logger;