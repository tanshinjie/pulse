# Pulse

![Pulse Banner](https://raw.githubusercontent.com/tanshinjie/pulse/main/assets/pulse_github_banner.png)

> ⚠️ **Under Active Development**  
> This project is currently under active development and is **not ready for production use**. Features may be incomplete, unstable, or subject to breaking changes. Please do not use this software for important productivity tracking until it reaches a stable release.

A terminal-based productivity tracking application built with Node.js that sends periodic notifications asking what you've been working on. Features clickable notifications that open your terminal with a pre-filled log command, making activity tracking seamless and efficient.

## Features

- 🔔 **Smart Notifications**: Cross-platform notifications with excellent macOS support and clickable actions
- 📝 **Simple Activity Logging**: Intuitive CLI interface for logging activities
- ⏱️ **Automatic Time Tracking**: Calculates time spent between activities
- 📊 **Rich Reports**: Daily, weekly, and monthly productivity summaries
- 💾 **Data Export**: Export to CSV or JSON for external analysis
- 🖥️ **Cross-Platform**: Works seamlessly on macOS, Linux, and Windows
- 🎨 **Beautiful CLI**: Colorful, user-friendly command-line interface
- ⚡ **Fast & Lightweight**: Built with Node.js for optimal performance
- 🖱️ **Click-to-Log**: Click notifications to quickly log activities

## Installation

### Prerequisites

- Node.js 14.0.0 or higher
- npm (comes with Node.js)
- **macOS**: `terminal-notifier` for enhanced notifications with click actions
  ```bash
  brew install terminal-notifier
  ```
  > **Important**: The app is configured to use `terminal-notifier` at `/opt/homebrew/bin/terminal-notifier` for clickable notifications. Without this, notifications will work but won't be clickable.

### Quick Install

1. **Download or clone this repository**
2. **Navigate to the project directory**:
   ```bash
   cd productivity_tracker_nodejs
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Install globally** (recommended):
   ```bash
   npm install -g .
   ```

### Alternative: Local Installation

If you prefer not to install globally:

```bash
# Install dependencies
npm install

# Create a symlink (macOS/Linux)
ln -s $(pwd)/bin/pulse /usr/local/bin/pulse

# Or add to your PATH
export PATH="$PATH:$(pwd)/bin"
```

### macOS Notification Setup

For optimal notification experience on macOS with clickable actions:

1. **Install terminal-notifier** (required for click actions):
   ```bash
   brew install terminal-notifier
   ```

2. **System Preferences** → **Notifications & Focus**
3. Find your terminal app (Warp, Terminal.app, iTerm2, etc.)
4. **Enable notifications** and set alert style to "Alerts" or "Banners"
5. **Test notifications**: `pulse test-notification`

> **Note**: The app uses `node-notifier` with a custom path to `/opt/homebrew/bin/terminal-notifier` for enhanced macOS notifications. This enables the "click-to-log" feature where clicking notifications opens your terminal with the log command ready.

## Quick Start

1. **Test notifications**:
   ```bash
   pulse test-notification
   ```

2. **Start tracking**:
   ```bash
   pulse start
   ```

3. **Log your first activity**:
   ```bash
   pulse log "Setting up pulse"
   ```

4. **Check status and see recent activities**:
   ```bash
   pulse status
   ```

5. **View daily report**:
   ```bash
   pulse report --period today
   ```

6. **Clear all data (if needed)**:
   ```bash
   pulse clear
   ```

7. **Stop tracking**:
   ```bash
   pulse stop
   ```

## Usage Guide

### Core Commands

#### Daemon Management
```bash
# Start background notifications
pulse start

# Start in foreground (for testing)
pulse start --foreground

# Stop background daemon
pulse stop

# Force stop if needed
pulse stop --force

# Check daemon status
pulse status
```

#### Activity Logging
```bash
# Interactive logging (prompts for input)
pulse log

# Quick logging with message
pulse log "Working on feature X"

# Close terminal after logging (useful from notifications)
pulse log --close

# Clear all activity data
pulse clear

# Force clear without confirmation
pulse clear --force
```

#### Reports and Analytics
```bash
# View today's summary
pulse report --period today

# Weekly report
pulse report --period week

# Monthly report
pulse report --period month

# Export to CSV
pulse report --period today --export csv

# Export to JSON
pulse report --period week --export json
```

#### Configuration
```bash
# Set notification interval (minutes)
pulse config notificationInterval 45

# Set data retention period (days)
pulse config dataRetentionDays 180

# View current settings
pulse status
```

### Workflow Examples

#### Daily Workflow
```bash
# Morning
pulse start

# Throughout the day (click notifications or log manually)
pulse log "Email and planning"
pulse log "Feature development"
pulse log "Team meeting"

# End of day
pulse report --period today
pulse stop
```

#### Click-to-Log Workflow
When notifications appear, simply:
1. **Click the notification** → Your terminal app opens and activates
2. **See the command ready** → `pulse log --close` is pre-filled
3. **Type your activity** → Press Enter to log
4. **Terminal closes automatically** → Back to work seamlessly!

No need to switch contexts, remember commands, or manually navigate to terminal.

#### Weekly Review
```bash
# Generate weekly report
pulse report --period week

# Export for external analysis
pulse report --period week --export csv

# View specific day
pulse report --period today
```

## Configuration

The pulse stores configuration in `~/.pulse_track_data/config.json`:

```json
{
  "notificationInterval": 30,
  "dataRetentionDays": 365
}
```

### Available Settings

- `notificationInterval`: Minutes between notifications (default: 30)
- `dataRetentionDays`: How long to keep activity data (default: 365)

## Data Storage

All data is stored locally in `~/.pulse_track_data/`:

- `config.json`: User configuration settings
- `activities.json`: Activity logs and time tracking data
- `pulse.pid`: Process ID file (when daemon is running)

### Data Format

Activities are stored as JSON objects:

```json
{
  "id": "uuid-string",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "activity": "Working on documentation",
  "durationMinutes": 45
}
```

## Advanced Features

### Clickable Notifications

Enhanced macOS notifications with seamless terminal integration:

- **Automatic terminal activation**: Clicking brings your terminal to the foreground
- **Pre-filled command**: `pulse log --close` appears ready to use
- **Smart auto-close**: Terminal closes after successful logging
- **Minimal interruption**: Quick activity logging without losing focus
- **Works with any terminal**: Terminal.app, iTerm2, Warp, etc.

### Automation & Scripting

The pulse can be integrated into scripts:

```bash
#!/bin/bash
# Daily startup routine
pulse start
pulse log "Daily planning"

# Automatic logging with git hooks
git commit -m "Feature complete" && pulse log "Completed feature X"
```

### Data Management

Clear data and export for analysis:

```bash
# Clear all activity data (with confirmation)
pulse clear

# Force clear without confirmation (useful for scripts)
pulse clear --force

# Export data for analysis
pulse report --period month --export json > monthly_data.json

# Use with jq for analysis
pulse report --period week --export json | jq '.activities'

# CSV for spreadsheet analysis
pulse report --period month --export csv
```

## Troubleshooting

### Notifications Not Working

**macOS**:
1. **Install terminal-notifier**: `brew install terminal-notifier`
2. Check **System Preferences** → **Notifications & Focus**
3. Ensure your terminal app has notification permissions
4. Set alert style to "Alerts" for persistent notifications
5. Test with: `pulse test-notification`

> **Important**: Without `terminal-notifier`, notifications will work but won't be clickable. The app specifically looks for it at `/opt/homebrew/bin/terminal-notifier`.

**Linux**:
1. Install notification dependencies:
   ```bash
   # Ubuntu/Debian
   sudo apt install libnotify-bin
   
   # Fedora/RHEL
   sudo dnf install libnotify
   ```
2. Test with: `pulse test-notification`

**Windows**:
1. Notifications should work automatically
2. If issues persist, check Windows notification settings
3. Test with: `pulse test-notification`

### Command Not Found

If `pulse` command is not found after global installation:

```bash
# Check npm global bin directory
npm config get prefix

# Add to PATH (add to ~/.bashrc or ~/.zshrc)
export PATH="$PATH:$(npm config get prefix)/bin"

# Or reinstall globally
npm install -g .
```

### Daemon Issues

```bash
# Check if daemon is running
pulse status

# Force stop stuck daemon
pulse stop --force

# Remove stale PID file
rm ~/.pulse_track_data/tracker.pid

# Restart daemon
pulse start
```

### Data Issues

```bash
# Backup your data before clearing
cp ~/.pulse_track_data/activities.json ~/activities_backup.json

# Clear all data and start fresh
pulse clear --force

# Validate JSON format
node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME + '/.pulse_track_data/activities.json')))"

# Reset configuration (keeps activity data)
rm ~/.pulse_track_data/config.json
```

## Development

### Project Structure

```
productivity_tracker_nodejs/
├── bin/
│   └── pulse              # Main executable
├── src/
│   ├── cli.js              # CLI interface
│   ├── dataManager.js      # Data storage & management
│   ├── notificationManager.js # Cross-platform notifications
│   └── daemonManager.js    # Background scheduling
├── tests/
│   └── test.js            # Test suite
├── docs/                  # Documentation
├── package.json           # Project configuration
└── README.md             # This file
```

### Running Tests

```bash
npm test
```

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Performance

- **Memory Usage**: ~20-30MB when running
- **CPU Usage**: Minimal (only during notifications)
- **Storage**: JSON files, typically <1MB for months of data
- **Startup Time**: <100ms for most commands

## License

MIT License - feel free to modify and distribute.

## Support

For issues or questions:

1. Check this README for troubleshooting
2. Test notifications: `pulse test-notification`
3. Verify Node.js version: `node --version` (requires 14.0.0+)
4. Check system notification settings
5. Create an issue on GitHub

---

**Happy tracking! 📊⏰**

*Built with ❤️ using Node.js*

