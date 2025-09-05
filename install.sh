#!/bin/bash

# Pulse Installation Script
# This script installs Pulse and sets up the environment

set -e  # Exit on any error

echo "🚀 Installing Pulse..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required but not installed."
    echo "   Please install Node.js 14.0.0 or higher from https://nodejs.org"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2)
REQUIRED_VERSION="14.0.0"

if ! node -e "process.exit(process.version.slice(1).split('.').map(Number).reduce((a,b,i)=>(a||0)*1000+b,0) >= '$REQUIRED_VERSION'.split('.').map(Number).reduce((a,b,i)=>(a||0)*1000+b,0) ? 0 : 1)"; then
    echo "❌ Node.js version $NODE_VERSION is too old. Please upgrade to $REQUIRED_VERSION or higher."
    exit 1
fi

echo "✅ Node.js version $NODE_VERSION detected"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is required but not installed. Please install npm."
    exit 1
fi

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

echo "📦 Installing dependencies..."
cd "$SCRIPT_DIR"
npm install

echo "🔧 Installing globally..."
npm install -g .

# Test installation
echo "🧪 Testing installation..."
if pulse test-notification; then
    echo ""
    echo "✅ Installation completed successfully!"
    echo ""
    echo "🎉 Pulse is now installed!"
    echo ""
    echo "📚 Quick start:"
    echo "   pulse start              # Start the background daemon"
    echo "   pulse log \"message\"       # Log an activity"
    echo "   pulse status             # Check status"
    echo "   pulse report             # View time report"
    echo "   pulse stop               # Stop the daemon"
    echo ""
    echo "📖 For more help, run: pulse --help"
    echo ""
    
    # Platform-specific tips
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "🍎 macOS Tips:"
        echo "   • Enable notifications: System Preferences → Notifications & Focus"
        echo "   • Find your terminal app (Warp, Terminal, etc.) and enable notifications"
        echo "   • Test with: pulse test-notification"
        echo ""
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        echo "🐧 Linux Tips:"
        echo "   • If notifications don't work, install: sudo apt install libnotify-bin"
        echo "   • Test with: pulse test-notification"
        echo ""
    fi
    
    echo "🚀 Ready to track your productivity!"
else
    echo "❌ Installation test failed. Please check the error messages above."
    echo ""
    echo "💡 Common solutions:"
    echo "   • Make sure Node.js and npm are properly installed"
    echo "   • Try running: npm install -g ."
    echo "   • Check if global npm bin is in your PATH"
    exit 1
fi

