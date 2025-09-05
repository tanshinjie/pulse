# Quick Start Guide - Pulse

## Installation (macOS/Warp Terminal)

1. **Ensure Node.js is installed**:
   ```bash
   node --version  # Should be 14.0.0 or higher
   ```
   If not installed, get it from [nodejs.org](https://nodejs.org/)

2. **Navigate to the app folder**:
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

## First Use

1. **Test notifications** (important for macOS):
   ```bash
   pulse test-notification
   ```
   
   ✅ **If you see a notification**: You're all set!
   
   ❌ **If no notification appears**:
   - Go to **System Preferences** → **Notifications & Focus**
   - Find **Warp** (or your terminal app)
   - Enable **Allow Notifications**
   - Set alert style to **Alerts** or **Banners**
   - Test again: `pulse test-notification`

2. **Start tracking**:
   ```bash
   pulse start
   ```

3. **Log your first activity**:
   ```bash
   pulse log "Setting up pulse" --category "Setup"
   ```

4. **Check status**:
   ```bash
   pulse status
   ```

## Daily Workflow

1. **Morning**: `pulse start`
2. **Throughout day**: 
   - Respond to notifications, or
   - Manually log: `pulse log "what you're working on"`
3. **Evening**: 
   - `pulse report --period today`
   - `pulse stop`

## Essential Commands

```bash
# Core commands
pulse start                    # Start notifications
pulse log "message"            # Log activity
pulse status                   # Check recent activities
pulse report                   # View time summary
pulse stop                     # Stop notifications

# With options
pulse log "coding" --category "Development"
pulse report --period week
pulse config notificationInterval 45
```

## Troubleshooting

**"Command not found"?**
```bash
# If global install didn't work, try:
export PATH="$PATH:$(npm config get prefix)/bin"

# Or use directly:
./bin/pulse --help
```

**Notifications not working on macOS?**
1. System Preferences → Notifications & Focus
2. Find your terminal app (Warp, Terminal, etc.)
3. Enable notifications
4. Test: `pulse test-notification`

**Need help?**
```bash
pulse --help
pulse [command] --help
```

That's it! You're ready to track your productivity! 🚀

## Why Node.js Version?

- ⚡ **Faster**: Quicker startup and better performance
- 🔔 **Better notifications**: Superior cross-platform notification support
- 📦 **Easier install**: Single `npm install` command
- 🎨 **Modern CLI**: Beautiful, colorful interface
- 🔧 **Fewer dependencies**: Less likely to have conflicts

