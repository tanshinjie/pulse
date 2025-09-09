# Functional Specifications Summary

Pulse is a personal productivity tracker with these core specs:

Primary Functions:

1. Rhythmic Check-ins - Periodic notifications (configurable intervals) asking "what are you working on?"
2. Activity Logging - Track work activities with automatic duration calculation
3. Time Reports - Generate daily/weekly/monthly productivity summaries
4. Session Awareness - Auto-start/stop based on login/logout and screen lock/unlock
5. Data Export - CSV/JSON export for external analysis

Key Features:

- CLI-based with rich command interface (start, stop, log, report, config)
- Cross-platform (macOS, Linux, Windows) with platform-specific optimizations
- Smart Notifications - Clickable on macOS, context-aware messages
- Automatic Session Management - Pause on lock, resume on unlock
- Data Persistence - JSON files with backup/recovery mechanisms
- Configurable - 15+ config options for intervals, retention, logging
