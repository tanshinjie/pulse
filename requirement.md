# Product philosophy
I log after I completed a certain task.

# User story
1. User logs after they completed a task.
2. User logs multiple tasks at once that needs to have different start time and end time. 

# Requirements
1. An entry's start time is automatically assumed to be the previous entry's end time.
 - If there's no previous entry, use 00:00 as the start time.

# CLI Commands
## Single Task Logging
- `pulse log <task>` - Log a single completed task with automatic time chaining
- `pulse help` - Show available commands

## Batch Task Logging
- `pulse log-batch` - Interactive mode for logging multiple tasks
- `pulse log-batch "Task 1" "10:00-11:30" "Task 2" "11:30-12:15"` - Command line mode

### Batch Logging UX
**Interactive Mode Flow:**
1. Start prompt: "Enter tasks (press Enter twice when done):"
2. For each task:
   - "Task description: " (user types)
   - "Start time (HH:MM) [auto-suggested]: " (user can accept or override)
   - "End time (HH:MM): " (user enters)
   - "Add another task? (y/n): "
3. Show summary before saving
4. Save all tasks

**Key UX Principles:**
- Smart defaults - Auto-suggest start time based on previous entry's end time
- Flexible input - Accept both "10:00-11:30" format and separate prompts
- Validation - Ensure end time > start time, no overlaps
- Confirmation - Show summary before saving
- Easy exit - Clear way to cancel or finish

# Assumed solved
- Data storage