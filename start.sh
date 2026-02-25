#!/bin/bash
# Start DWE Command Center
# Make sure to set NOTION_API_KEY environment variable first

if [ -z "$NOTION_API_KEY" ]; then
    echo "⚠️  NOTION_API_KEY not set!"
    echo "   Run: export NOTION_API_KEY=your_key_here"
    echo "   Or create a .env file from .env.example"
    exit 1
fi

echo "🚀 Starting DWE Command Center..."
echo "   Dashboard: http://127.0.0.1:8899/"
echo ""

node server.js
