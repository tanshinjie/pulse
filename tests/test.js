#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const chalk = require('chalk');

// Import modules for direct testing
const { DataManager, Activity } = require('../src/dataManager');
const NotificationManager = require('../src/notificationManager');

class TestSuite {
    constructor() {
        this.passed = 0;
        this.failed = 0;
        this.testDataDir = '/tmp/productivity_tracker_test';
    }

    async runAllTests() {
        console.log(chalk.blue('🚀 Running Pulse Tests (Node.js)'));
        console.log('='.repeat(50));

        const tests = [
            { name: 'Data Manager', fn: () => this.testDataManager() },
            { name: 'Notification System', fn: () => this.testNotificationManager() },
            { name: 'CLI Commands', fn: () => this.testCLICommands() },
            { name: 'Activity Logging', fn: () => this.testActivityLogging() },
            { name: 'Clear Command', fn: () => this.testClearCommand() },
            { name: 'Report Generation', fn: () => this.testReportGeneration() },
            { name: 'Configuration', fn: () => this.testConfiguration() }
        ];

        for (const test of tests) {
            console.log(`\n📋 ${test.name}`);
            console.log('-'.repeat(30));
            
            try {
                await test.fn();
                this.passed++;
                console.log(chalk.green(`✅ ${test.name} PASSED`));
            } catch (error) {
                this.failed++;
                console.log(chalk.red(`❌ ${test.name} FAILED: ${error.message}`));
            }
        }

        this.printSummary();
        return this.failed === 0;
    }

    async testDataManager() {
        console.log('🧪 Testing data manager...');
        
        // Create test data manager
        const dm = new DataManager(this.testDataDir);
        
        // Test activity creation
        const activity1 = dm.addActivity('Test activity 1');
        if (!activity1 || activity1.activity !== 'Test activity 1') {
            throw new Error('Activity creation failed');
        }
        console.log('✅ Activity creation working');

        // Test data persistence
        await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
        const activity2 = dm.addActivity('Test activity 2');
        
        if (dm.activities.length !== 2) {
            throw new Error('Activity persistence failed');
        }
        console.log('✅ Activity persistence working');

        // Test configuration
        dm.setConfig('notificationInterval', 45);
        if (dm.getConfig('notificationInterval') !== 45) {
            throw new Error('Configuration management failed');
        }
        console.log('✅ Configuration management working');

        // Test time summary
        const summary = dm.getTimeSummary(1);
        if (summary.activityCount !== 2 || !Array.isArray(summary.activities)) {
            throw new Error('Time summary failed');
        }
        console.log('✅ Time summary working');

        // Cleanup
        await fs.remove(this.testDataDir);
    }

    async testNotificationManager() {
        console.log('🧪 Testing notification manager...');
        
        const nm = new NotificationManager();
        
        // Test notification sending (will use fallback)
        const success = await nm.testNotification();
        if (!success) {
            throw new Error('Notification test failed');
        }
        console.log('✅ Notification system working');
    }

    async testCLICommands() {
        console.log('🧪 Testing CLI commands...');
        
        // Test help command
        try {
            const output = execSync('node src/cli.js --help', { 
                encoding: 'utf8',
                cwd: path.join(__dirname, '..')
            });
            if (!output.includes('Pulse')) {
                throw new Error('Help command failed');
            }
            console.log('✅ Help command working');
        } catch (error) {
            throw new Error(`CLI help failed: ${error.message}`);
        }

        // Test status command
        try {
            const output = execSync('node src/cli.js status', { 
                encoding: 'utf8',
                cwd: path.join(__dirname, '..')
            });
            if (!output.includes('daemon')) {
                throw new Error('Status command failed');
            }
            console.log('✅ Status command working');
        } catch (error) {
            throw new Error(`Status command failed: ${error.message}`);
        }
    }

    async testActivityLogging() {
        console.log('🧪 Testing activity logging...');
        
        try {
            const output = execSync('node src/cli.js log "Test CLI activity"', { 
                encoding: 'utf8',
                cwd: path.join(__dirname, '..')
            });
            if (!output.includes('Logged: Test CLI activity')) {
                throw new Error('Activity logging failed');
            }
            console.log('✅ Activity logging working');
        } catch (error) {
            throw new Error(`Activity logging failed: ${error.message}`);
        }

        // Test --close flag (basic test - can't test actual terminal closing)
        try {
            const output = execSync('node src/cli.js log "Test close flag activity" --close', { 
                encoding: 'utf8',
                cwd: path.join(__dirname, '..'),
                timeout: 5000 // Prevent hanging
            });
            if (!output.includes('Logged: Test close flag activity') || !output.includes('Closing terminal...')) {
                throw new Error('--close flag test failed');
            }
            console.log('✅ --close flag working');
        } catch (error) {
            throw new Error(`--close flag test failed: ${error.message}`);
        }
    }

    async testClearCommand() {
        console.log('🧪 Testing clear command...');
        
        // First log some activities
        try {
            execSync('node src/cli.js log "Activity to clear 1"', { 
                encoding: 'utf8',
                cwd: path.join(__dirname, '..')
            });
            execSync('node src/cli.js log "Activity to clear 2"', { 
                encoding: 'utf8',
                cwd: path.join(__dirname, '..')
            });
            console.log('✅ Test activities created');
        } catch (error) {
            throw new Error(`Failed to create test activities: ${error.message}`);
        }

        // Test clear with force flag
        try {
            const output = execSync('node src/cli.js clear --force', { 
                encoding: 'utf8',
                cwd: path.join(__dirname, '..')
            });
            if (!output.includes('All activity data cleared successfully!')) {
                throw new Error('Clear command failed');
            }
            console.log('✅ Clear command working');
        } catch (error) {
            throw new Error(`Clear command failed: ${error.message}`);
        }

        // Verify data is cleared
        try {
            const output = execSync('node src/cli.js report --period today', { 
                encoding: 'utf8',
                cwd: path.join(__dirname, '..')
            });
            if (!output.includes('Total activities: 0')) {
                throw new Error('Data not properly cleared');
            }
            console.log('✅ Data clearing verified');
        } catch (error) {
            throw new Error(`Clear verification failed: ${error.message}`);
        }
    }

    async testReportGeneration() {
        console.log('🧪 Testing report generation...');
        
        try {
            const output = execSync('node src/cli.js report --period today', { 
                encoding: 'utf8',
                cwd: path.join(__dirname, '..')
            });
            if (!output.includes("Today's Report")) {
                throw new Error('Report generation failed');
            }
            console.log('✅ Report generation working');
        } catch (error) {
            throw new Error(`Report generation failed: ${error.message}`);
        }

        // Test export functionality
        try {
            const output = execSync('node src/cli.js report --period today --export json', { 
                encoding: 'utf8',
                cwd: path.join(__dirname, '..')
            });
            if (!output.includes('Report exported to:')) {
                throw new Error('Export functionality failed');
            }
            console.log('✅ Export functionality working');

            // Cleanup exported files
            const files = await fs.readdir(path.join(__dirname, '..'));
            for (const file of files) {
                if (file.startsWith('productivity_report_') && file.endsWith('.json')) {
                    await fs.remove(path.join(__dirname, '..', file));
                }
            }
        } catch (error) {
            throw new Error(`Export functionality failed: ${error.message}`);
        }
    }

    async testConfiguration() {
        console.log('🧪 Testing configuration...');
        
        try {
            const output = execSync('node src/cli.js config notificationInterval 20', { 
                encoding: 'utf8',
                cwd: path.join(__dirname, '..')
            });
            if (!output.includes('Set notificationInterval = 20')) {
                throw new Error('Configuration setting failed');
            }
            console.log('✅ Configuration setting working');

            // Reset to default
            execSync('node src/cli.js config notificationInterval 30', { 
                encoding: 'utf8',
                cwd: path.join(__dirname, '..')
            });
        } catch (error) {
            throw new Error(`Configuration failed: ${error.message}`);
        }
    }

    printSummary() {
        const total = this.passed + this.failed;
        console.log('\n' + '='.repeat(50));
        console.log(chalk.blue('📊 Test Results:'), `${this.passed}/${total} tests passed`);
        
        if (this.failed === 0) {
            console.log(chalk.green('🎉 All tests passed! The Node.js application is working correctly.'));
        } else {
            console.log(chalk.red('⚠️  Some tests failed. Please check the output above.'));
        }
    }
}

// Run tests if this file is executed directly
if (require.main === module) {
    const testSuite = new TestSuite();
    testSuite.runAllTests().then(success => {
        process.exit(success ? 0 : 1);
    }).catch(error => {
        console.error(chalk.red('Test suite error:'), error.message);
        process.exit(1);
    });
}

module.exports = TestSuite;

