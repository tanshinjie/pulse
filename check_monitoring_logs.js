#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// Get the data directory (same logic as in the main app)
const dataDir = path.join(os.homedir(), '.pulse_track_data');
const logFile = path.join(dataDir, 'pulse.log');

async function checkMonitoringLogs() {
    console.log('🔍 Checking Pulse monitoring logs...\n');
    
    if (!await fs.pathExists(logFile)) {
        console.log('❌ Log file not found:', logFile);
        console.log('   Make sure Pulse has been started at least once.');
        return;
    }
    
    try {
        const logContent = await fs.readFile(logFile, 'utf8');
        const logLines = logContent.trim().split('\n').filter(line => line.trim());
        
        if (logLines.length === 0) {
            console.log('📝 Log file is empty');
            return;
        }
        
        // Parse and filter for session-related logs
        const sessionLogs = logLines.map(line => {
            try {
                return JSON.parse(line);
            } catch (e) {
                return null;
            }
        }).filter(entry => 
            entry && 
            entry.category === 'session' && 
            (entry.message.includes('macos_lock') || 
             entry.message.includes('lock_monitoring') ||
             entry.message.includes('polling cycle'))
        );
        
        console.log(`📊 Found ${sessionLogs.length} session monitoring log entries\n`);
        
        if (sessionLogs.length === 0) {
            console.log('⚠️  No session monitoring logs found.');
            console.log('   This might mean:');
            console.log('   - Session monitoring is not enabled');
            console.log('   - Logging level is too high (try setting logLevel to "debug")');
            console.log('   - The daemon is not running');
            return;
        }
        
        // Group by event type
        const eventGroups = {};
        sessionLogs.forEach(log => {
            const eventType = log.message.split(' ')[0];
            if (!eventGroups[eventType]) {
                eventGroups[eventType] = [];
            }
            eventGroups[eventType].push(log);
        });
        
        // Display summary
        console.log('📈 Monitoring Activity Summary:');
        Object.keys(eventGroups).forEach(eventType => {
            const count = eventGroups[eventType].length;
            const latest = eventGroups[eventType][eventGroups[eventType].length - 1];
            console.log(`   ${eventType}: ${count} entries (latest: ${new Date(latest.timestamp).toLocaleString()})`);
        });
        
        console.log('\n🔍 Recent Monitoring Activity:');
        const recentLogs = sessionLogs.slice(-10); // Last 10 entries
        recentLogs.forEach(log => {
            const time = new Date(log.timestamp).toLocaleTimeString();
            const level = log.level.padEnd(5);
            console.log(`   [${time}] [${level}] ${log.message}`);
            if (log.data) {
                console.log(`      Data: ${JSON.stringify(log.data, null, 2).split('\n').join('\n      ')}`);
            }
        });
        
        // Check if monitoring is currently active
        const activeLogs = sessionLogs.filter(log => 
            log.message.includes('macos_lock_monitoring_active') ||
            log.message.includes('polling cycle started')
        );
        
        if (activeLogs.length > 0) {
            const lastActive = activeLogs[activeLogs.length - 1];
            const timeSinceLastActive = Date.now() - new Date(lastActive.timestamp).getTime();
            const minutesSince = Math.floor(timeSinceLastActive / (1000 * 60));
            
            console.log(`\n✅ Monitoring appears to be active`);
            console.log(`   Last activity: ${minutesSince} minutes ago`);
            
            if (minutesSince > 5) {
                console.log(`   ⚠️  No recent activity - monitoring might have stopped`);
            }
        } else {
            console.log(`\n❌ No active monitoring detected in logs`);
        }
        
    } catch (error) {
        console.error('❌ Error reading logs:', error.message);
    }
}

// Run the check
checkMonitoringLogs().catch(console.error);
