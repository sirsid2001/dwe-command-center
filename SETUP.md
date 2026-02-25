# DWE Mission Control Server - Setup Guide

## Quick Start

### 1. Start the Server

```bash
cd ~/mission-control-server
node server.js
```

### 2. Open Dashboard

```bash
open http://localhost:8899
```

### 3. (Optional) Auto-Start on Login

```bash
# Install LaunchAgent
cp ~/Library/LaunchAgents/com.missioncontrol.server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.missioncontrol.server.plist

# Verify it's running
launchctl list | grep missioncontrol
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /` | - | Serve dashboard HTML |
| `GET /mc/status` | GET | Server uptime, health |
| `GET /mc/data` | GET | Read dashboard data |
| `POST /mc/data` | POST | Save dashboard data |
| `GET /mc/weather?city=NYC` | GET | Weather (mock) |
| `GET /mc/activity` | GET | Read activity log |
| `POST /mc/activity` | POST | Add activity entry |
| `GET /mc/agents` | GET | List AI agents |
| `GET /mc/models` | GET | List available models |
| `POST /mc/upload` | POST | Upload file meta |

## Service Management

```bash
# Start
cd ~/mission-control-server && node server.js

# Stop (auto-start service)
launchctl unload ~/Library/LaunchAgents/com.missioncontrol.server.plist

# Restart
launchctl unload ~/Library/LaunchAgents/com.missioncontrol.server.plist
sleep 2
launchctl load ~/Library/LaunchAgents/com.missioncontrol.server.plist

# View logs
tail -f ~/mission-control-server/logs/server.log
tail -f ~/mission-control-server/logs/server.error.log
```

## Data Files

- `mc-data.json` - Dashboard state
- `mc-activity.json` - Activity log
- `dashboard.html` - Main UI

## Optimizations for Mac mini

- No external framework dependencies
- Built-in Node.js http module
- Minimal memory footprint
- CORS enabled for local dev
- JSON file storage (no DB)
