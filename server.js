#!/usr/bin/env node
/**
 * DWE Mission Control Server
 * Lightweight local server for Mission Control dashboard
 * Optimized for Mac mini - minimal resource usage
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// DWE Widget API
const { getDWEStats } = require('./dwe-widget-api.js');

// Config
const PORT = 8899;
const HOST = '127.0.0.1';
const DATA_FILE = path.join(__dirname, 'mc-data.json');
const ACTIVITY_FILE = path.join(__dirname, 'mc-activity.json');
const HTML_FILE = path.join(__dirname, 'dashboard.html');

// Ensure data files exist
function ensureFile(filePath, defaultContent = '{}') {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, defaultContent, 'utf8');
    }
}
ensureFile(DATA_FILE);
ensureFile(ACTIVITY_FILE, JSON.stringify({ entries: [] }));

// MIME types
const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// Start time for uptime
const startTime = Date.now();

const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    
    // Static file serving
    if (pathname === '/' || pathname === '/index.html') {
        serveFile(res, HTML_FILE, 'text/html');
        return;
    }
    
    // Ecosystem Map page
    if (pathname === '/ecosystem' || pathname === '/ecosystem.html') {
        serveFile(res, path.join(__dirname, 'ecosystem.html'), 'text/html');
        return;
    }
    
    // AI Team page
    if (pathname === '/ai-team' || pathname === '/ai-team.html') {
        serveFile(res, path.join(__dirname, 'ai-team.html'), 'text/html');
        return;
    }
    
    // Serve static assets
    if (pathname.startsWith('/assets/') || pathname.endsWith('.js') || pathname.endsWith('.css')) {
        const filePath = path.join(__dirname, pathname);
        const ext = path.extname(filePath);
        serveFile(res, filePath, mimeTypes[ext] || 'application/octet-stream');
        return;
    }
    
    // API Routes
    switch (pathname) {
        case '/mc/status':
            getStatus(req, res);
            break;
        case '/mc/data':
            handleData(req, res);
            break;
        case '/mc/weather':
            getWeather(req, res, parsedUrl.query.city);
            break;
        case '/mc/activity':
            handleActivity(req, res);
            break;
        case '/mc/agents':
            getAgents(req, res);
            break;
        case '/mc/models':
            getModels(req, res);
            break;
        case '/mc/upload':
            handleUpload(req, res);
            break;
        case '/mc/services':
            getServices(req, res);
            break;
        case '/mc/crons':
            getCrons(req, res);
            break;
        case '/mc/launchd':
            getLaunchd(req, res);
            break;
        case '/mc/backup':
            if (req.method === 'POST') {
                runBackup(req, res);
            } else if (req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ lastBackup: getLastBackupTime() }));
            } else {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Method not allowed' }));
            }
            break;
        case '/mc/agent-routing':
            getAgentRouting(req, res);
            break;
        case '/mc/brain':
            getBrainStatus(req, res);
            break;
        case '/mc/brain-run':
            exec('launchctl start ai.dwe.brain-trainer', (err) => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: !err, error: err ? err.message : null }));
            });
            break;
        case '/mc/brain-restart':
            exec(`launchctl kickstart -k gui/${process.getuid()}/ai.dwe.brain-trainer`, (err) => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: !err, error: err ? err.message : null }));
            });
            break;
        case '/mc/brain-query':
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        const { question } = JSON.parse(body);
                        if (!question) { res.writeHead(400); res.end(JSON.stringify({ error: 'No question' })); return; }
                        // Apply same DWE expansion as brain_query.sh
                        const expanded = question
                            .replace(/\bDWE\b/g, 'DWE (Digital Wealth Ecosystem)')
                            .replace(/currently working on/gi, 'currently working on Phase 4 agent autonomy active projects')
                            .replace(/4_Ready_to_Seed/g, 'Ready to Seed folder seed-watcher auto-ingest DWE Brain Pinecone');
                        const https = require('https');
                        const payload = JSON.stringify({ question: expanded, botId: 'main' });
                        const opts = {
                            hostname: 'n8n.tvcpulse.com',
                            path: '/webhook/openclaw-query',
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                        };
                        const preq = https.request(opts, pres => {
                            let data = '';
                            pres.on('data', c => data += c);
                            pres.on('end', () => {
                                res.setHeader('Content-Type', 'application/json');
                                try { res.end(data); } catch(e) { res.end(JSON.stringify({ error: 'Parse error' })); }
                            });
                        });
                        preq.on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
                        preq.write(payload);
                        preq.end();
                    } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
                });
            } else {
                res.writeHead(405); res.end(JSON.stringify({ error: 'POST only' }));
            }
            break;
        case '/mc/system':
            getSystemHealth(req, res);
            break;
        case '/mc/internet':
            getInternetStatus(req, res);
            break;
        case '/mc/notion-tasks':
            getNotionTasks(req, res);
            break;
        case '/mc/heartbeat':
            getHeartbeats(req, res);
            break;
        case '/mc/cso':
            getCSoPipeline(req, res);
            break;
        case '/mc/financial':
            getFinancialPulse(req, res);
            break;
        case '/mc/agent-tasks':
            getAgentTasks(req, res);
            break;
        case '/mc/acp':
            getAgentSessions(req, res);
            break;
        case '/dwe/status':
            handleDWEStatus(req, res);
            break;
        case '/dwe':
        case '/dwe/':
        case '/dwe/widget':
            serveFile(res, path.join(__dirname, 'dwe-widget.html'), 'text/html');
            break;
        default:
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
    }
});

// DWE Widget Status Handler
async function handleDWEStatus(req, res) {
    try {
        const stats = await getDWEStats();
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache'
        });
        res.end(JSON.stringify(stats));
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            error: 'Failed to fetch stats',
            total: 1020,
            completed: 562,
            inProgress: 4,
            remaining: 458,
            lastUpdated: new Date().toISOString()
        }));
    }
}

function serveFile(res, filePath, contentType) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end(data);
    });
}

function getStatus(req, res) {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const stats = fs.statSync(DATA_FILE);
    const memUsage = process.memoryUsage().heapUsed / 1024 / 1024;
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        online: true,
        uptime: uptime,
        memory: parseFloat(memUsage.toFixed(1)),
        lastRefresh: stats.mtime.toISOString(),
        serverTime: new Date().toISOString(),
        version: '1.0.0'
    }));
}

function handleData(req, res) {
    if (req.method === 'GET') {
        fs.readFile(DATA_FILE, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to read data' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data || '{}');
        });
    } else if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), err => {
                    if (err) {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: 'Failed to save' }));
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                });
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    }
}

function getWeather(req, res, city) {
    if (!city) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'City required' }));
        return;
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        city: city,
        temperature: 72,
        condition: 'Sunny',
        feels_like: 75,
        humidity: 45,
        source: 'wttr.in (mock)'
    }));
}

function handleActivity(req, res) {
    if (req.method === 'GET') {
        fs.readFile(ACTIVITY_FILE, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to read' }));
                return;
            }
            const activity = JSON.parse(data || '{"entries":[]}');
            const last50 = activity.entries.slice(-50);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ entries: last50 }));
        });
    } else if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const entry = JSON.parse(body);
                entry.timestamp = new Date().toISOString();
                
                fs.readFile(ACTIVITY_FILE, 'utf8', (err, data) => {
                    const activity = JSON.parse(data || '{"entries":[]}');
                    activity.entries.push(entry);
                    
                    fs.writeFile(ACTIVITY_FILE, JSON.stringify(activity, null, 2), err => {
                        if (err) {
                            res.writeHead(500);
                            res.end(JSON.stringify({ error: 'Failed to save' }));
                            return;
                        }
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true }));
                    });
                });
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    }
}

function handleUpload(req, res) {
    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    filename: data.name,
                    size: Math.floor(Math.random() * 50 + 1),
                    url: `https://1drv.ms/u/s!${Math.random().toString(36).slice(2, 10)}`
                }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid data' }));
            }
        });
    }
}

function getAgents(req, res) {
    // Check if gateway is up — determines if agents can receive messages
    exec('nc -z 127.0.0.1 3000 && echo "open" || echo "closed"', (err, out) => {
        const gatewayUp = (out || '').trim() === 'open';
        const agents = [
            { id: 'cto',            name: 'Steve',          role: 'Chief Technology Officer', telegram: '@DWE_CTO_Bot',    status: gatewayUp ? 'online' : 'offline' },
            { id: 'anita',          name: 'Anita',          role: 'Chief Operating Officer',  telegram: 'anita-coo',       status: gatewayUp ? 'online' : 'offline' },
            { id: 'nicole',         name: 'Nicole',         role: 'Chief Strategic Officer',  telegram: 'nicole-cos',      status: gatewayUp ? 'online' : 'offline' },
            { id: 'chief-engineer', name: 'Chief Engineer', role: 'Engineering Lead',         telegram: null,              status: gatewayUp ? 'online' : 'offline' },
            { id: 'main',           name: 'Main',           role: 'Primary Assistant',        telegram: null,              status: gatewayUp ? 'online' : 'offline' }
        ];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents, count: agents.length, gatewayUp }));
    });
}

function getModels(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        models: [
            { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'anthropic' },
            { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
            { id: 'kimi-k2-5', name: 'Kimi K2.5', provider: 'moonshot' }
        ],
        active: 'claude-3-5-sonnet'
    }));
}

const { exec } = require('child_process');

function getServices(req, res) {
    const services = [
        { name: 'OpenClaw Gateway', port: 3000, check: 'http://127.0.0.1:3000/status' },
        { name: 'n8n Digital Ocean', url: 'https://n8n.tvcpulse.com', type: 'external' },
        { name: 'MCporter Client', port: 8080 },
        { name: 'Notion API', url: 'https://api.notion.com/v1', type: 'external' },
        { name: 'Pinecone', url: 'https://api.pinecone.io', type: 'external' },
        { name: 'Ollama M4 GPU', port: 11434 },
        { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', type: 'external' }
    ];

    const results = [];
    let pending = services.length;

    services.forEach(service => {
        if (service.type === 'external') {
            // For external services, check if we can resolve them
            exec(`curl -s -o /dev/null -w "%{http_code}" "${service.url}" --max-time 3`, (error, stdout) => {
                const statusCode = stdout.trim();
                const online = ['200','400','401','403','404'].includes(statusCode);
                results.push({
                    name: service.name,
                    status: online ? 'online' : 'offline',
                    info: online ? 'OK' : 'Unreachable'
                });
                pending--;
                if (pending === 0) sendResponse();
            });
        } else if (service.port) {
            // Check local port
            exec(`nc -z 127.0.0.1 ${service.port} && echo "open" || echo "closed"`, (error, stdout) => {
                const isOpen = stdout.trim() === 'open';
                results.push({
                    name: service.name,
                    port: service.port,
                    status: isOpen ? 'online' : 'offline',
                    info: isOpen ? `Port ${service.port} open` : 'Not responding'
                });
                pending--;
                if (pending === 0) sendResponse();
            });
        }
    });

    function sendResponse() {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ services: results, timestamp: new Date().toISOString() }));
    }
}

// Calculate next run time from cron schedule
function calculateNextRun(schedule) {
    const parts = schedule.split(/\s+/);
    if (parts.length < 5) return 'Unknown';
    
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const now = new Date();
    const next = new Date(now);
    let hourModified = false;
    
    // Handle minute-based intervals first (most frequent)
    if (minute.startsWith('*/')) {
        const interval = parseInt(minute.replace('*/', ''));
        const currentMin = now.getMinutes();
        const nextMin = Math.floor(currentMin / interval) * interval + interval;
        if (nextMin >= 60) {
            next.setHours(next.getHours() + 1);
            hourModified = true;
            next.setMinutes(nextMin - 60);
        } else {
            next.setMinutes(nextMin);
        }
    } else if (minute === '*') {
        next.setMinutes(now.getMinutes() + 1);
    } else {
        next.setMinutes(parseInt(minute));
    }
    
    // Handle hour intervals (*/N)
    if (hour.startsWith('*/')) {
        if (!minute.startsWith('*/')) {  // Only if we didn't already modify hour above
            const interval = parseInt(hour.replace('*/', ''));
            const currentHour = now.getHours();
            next.setHours(currentHour + interval);
            next.setMinutes(0);
        }
    } else if (hour !== '*') {
        // Specific hour - only set if we haven't modified hour via minute rollover
        if (!hourModified) {
            next.setHours(parseInt(hour));
            if (next <= now) {
                next.setDate(next.getDate() + 1);
            }
        }
    }
    
    // Handle day of week (0-6, where 0 is Sunday)
    if (dayOfWeek !== '*' && !dayOfWeek.includes('/')) {
        const targetDay = parseInt(dayOfWeek);
        const currentDay = now.getDay();
        const daysUntil = (targetDay - currentDay + 7) % 7;
        if (daysUntil === 0 && next <= now) {
            next.setDate(next.getDate() + 7);
        } else {
            next.setDate(next.getDate() + daysUntil);
        }
    }
    
    // Format time
    const hours = next.getHours();
    const mins = next.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    const displayMins = mins.toString().padStart(2, '0');
    
    // Check if it's today or tomorrow
    const isToday = next.getDate() === now.getDate() && next.getMonth() === now.getMonth();
    const isTomorrow = next.getDate() === now.getDate() + 1;
    const dayLabel = isToday ? '' : isTomorrow ? 'Tomorrow ' : `${next.toLocaleDateString('en-US', {weekday: 'short'})} `;
    
    return `${dayLabel}${displayHours}:${displayMins}${ampm.toLowerCase()}`;
}

function getCrons(req, res) {
    exec('crontab -l 2>/dev/null | grep -v "^#" | grep -v "^$" | head -20', (error, stdout) => {
        const crons = [];
        if (!error && stdout) {
            const lines = stdout.trim().split('\n');
            lines.forEach((line, idx) => {
                // Parse cron line: schedule + command
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 6) {
                    // First 5 parts are the schedule
                    const schedule = parts.slice(0, 5).join(' ');
                    // Rest is the command - find the actual script name
                    const commandParts = parts.slice(5);
                    let scriptName = 'System';
                    
                    // Look for actual script file in the command
                    for (const part of commandParts) {
                        if (part.includes('.sh') || part.includes('/')) {
                            scriptName = part.split('/').pop().replace('.sh', '');
                            break;
                        }
                    }
                    
                    // If no script found, use first meaningful part
                    if (scriptName === 'System' && commandParts.length > 0) {
                        const meaningful = commandParts.find(p => !p.startsWith('>') && !p.startsWith('-') && p.length > 2);
                        if (meaningful) {
                            scriptName = meaningful.split('/').pop();
                        }
                    }
                    
                    crons.push({
                        id: `CRON-${String(idx + 1).padStart(3, '0')}`,
                        schedule: schedule,
                        command: scriptName,
                        status: 'active',
                        nextRun: calculateNextRun(schedule)
                    });
                }
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ crons: crons, count: crons.length, timestamp: new Date().toISOString() }));
    });
}

function getLaunchd(req, res) {
    // scheduled:true = runs and exits on a timer; not running is normal (green if exit 0, yellow if exit non-zero)
    // scheduled:false = should always be running; not running = error
    const DAEMON_NAMES = {
        'ai.openclaw.gateway':                  { name: 'OpenClaw Gateway',    group: 'core',      scheduled: false },
        'ai.openclaw.relay-daemon':             { name: 'Relay Daemon',        group: 'core',      scheduled: false },
        'ai.dwe.seed-watcher':                  { name: 'Seed Watcher',        group: 'brain',     scheduled: false },
        'ai.dwe.notion-sync':                   { name: 'Notion Sync',         group: 'brain',     scheduled: false },
        'ai.dwe.brain-trainer':                 { name: 'Brain Trainer',       group: 'brain',     scheduled: true  },
        'ai.dwe.health-monitor':                { name: 'Health Monitor',      group: 'autonomy',  scheduled: false },
        'ai.dwe.agent-heartbeat-cto':           { name: 'CTO Heartbeat',       group: 'autonomy',  scheduled: true  },
        'ai.dwe.agent-heartbeat-anita':         { name: 'Anita Heartbeat',     group: 'autonomy',  scheduled: true  },
        'ai.dwe.agent-heartbeat-anita-finance': { name: 'Anita Finance Pulse', group: 'autonomy',  scheduled: true  },
        'ai.dwe.agent-heartbeat-ce':            { name: 'CE Heartbeat',        group: 'autonomy',  scheduled: true  },
        'ai.dwe.agent-heartbeat-nicole':        { name: 'Nicole CSO Heartbeat',group: 'autonomy',  scheduled: true  },
        'ai.dwe.agent-heartbeat-nicole-weekly': { name: 'Nicole Weekly',       group: 'autonomy',  scheduled: true  },
        'ai.dwe.nightly-review':                { name: 'Nightly Review',      group: 'brain',     scheduled: true  },
        'com.dwe.ops-monitor':                  { name: 'Ops Monitor',         group: 'ops',       scheduled: false },
        'com.dwe.ops-report':                   { name: 'Ops Report',          group: 'ops',       scheduled: true  },
        'com.dwe.command-center':               { name: 'Mission Control (old plist — retire)', group: 'ops', scheduled: false, retired: true },
        'com.missioncontrol.server':            { name: 'Mission Control',     group: 'core',      scheduled: false }
    };

    exec('launchctl list | grep -E "ai\\.openclaw|ai\\.dwe|com\\.dwe|com\\.missioncontrol"', (error, stdout) => {
        const services = [];
        if (!error && stdout) {
            stdout.trim().split('\n').forEach(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 3) {
                    const pid = parts[0];
                    const exitCode = parts[1];
                    const label = parts[2];
                    const running = pid !== '-';
                    const hasError = exitCode !== '0' && exitCode !== '-';
                    const meta = DAEMON_NAMES[label] || { name: label.split('.').pop(), group: 'other', scheduled: false };

                    let status;
                    if (running) {
                        status = 'running';
                    } else if (meta.scheduled) {
                        // Scheduled daemons: not running is normal. Status = last exit code
                        status = hasError ? 'warning' : 'waiting';
                    } else {
                        // Continuous daemons: must always run
                        status = hasError ? 'error' : 'waiting';
                    }

                    services.push({
                        id: label,
                        name: meta.name,
                        group: meta.group,
                        scheduled: meta.scheduled || false,
                        retired: meta.retired || false,
                        status,
                        pid: running ? pid : null,
                        exitCode
                    });
                }
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ services, count: services.length, timestamp: new Date().toISOString() }));
    });
}

function getAgentRouting(req, res) {
    const agents = [
        { id: 'cto',            name: 'Steve',          emoji: '💻', role: 'Technical & infrastructure',     channel: 'Telegram @DWE_CTO_Bot' },
        { id: 'anita',          name: 'Anita',          emoji: '⚙️', role: 'Operations & task coordination', channel: 'Telegram anita-coo' },
        { id: 'nicole',         name: 'Nicole',         emoji: '📋', role: 'Strategy & revenue discovery',   channel: 'Telegram nicole-cos' },
        { id: 'chief-engineer', name: 'Chief Engineer', emoji: '🔧', role: 'Infrastructure & daemons',       channel: 'OpenClaw session' },
        { id: 'main',           name: 'Main',           emoji: '🚀', role: 'Primary assistant (web chat)',   channel: 'OpenClaw webchat' }
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents, timestamp: new Date().toISOString() }));
}

// Notion API integration - loaded from environment or config file
const NOTION_API_KEY = process.env.NOTION_API_KEY ||
    (() => { try { return require('fs').readFileSync(`${process.env.HOME}/.config/notion/api_key`, 'utf8').trim(); } catch(e) { return ''; } })();
const NOTION_DB_ID = '2f797f89-9129-80f7-99d0-000b3bf2f347';

async function getNotionTasks(req, res) {
    if (!NOTION_API_KEY) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            error: 'Notion API key not configured. Set NOTION_API_KEY environment variable.',
            tasks: [],
            stats: { total: 0, inProgress: 0, completed: 0, todo: 0 }
        }));
        return;
    }
    
    try {
        console.log('Fetching all Notion tasks...');
        const allTasks = await fetchAllNotionTasks();
        console.log(`Fetched ${allTasks.length} total tasks`);

        // Calculate stats
        const stats = {
            total: allTasks.length,
            inProgress: allTasks.filter(t => t.status === 'In Progress' || t.status === 'In progress').length,
            completed: allTasks.filter(t => t.status === 'Done' || t.status === 'Completed' || t.status === 'Complete' || t.status === 'Review').length,
            todo: allTasks.filter(t => t.status === 'To Do' || t.status === 'To do' || t.status === 'No Status' || t.status === 'Not started').length,
            maxIdNumber: allTasks.reduce((max, t) => Math.max(max, t.idNumber || 0), 0)
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            tasks: allTasks.slice(0, 100), // Limit displayed tasks to 100 for UI performance
            stats: stats,
            source: 'Notion',
            timestamp: new Date().toISOString()
        }));
    } catch (e) {
        console.error('Notion API error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to fetch from Notion', tasks: [], stats: { total: 0, inProgress: 0, completed: 0, todo: 0 } }));
    }
}

// Fetch all tasks with pagination
async function fetchAllNotionTasks() {
    const allTasks = [];
    let hasMore = true;
    let nextCursor = null;
    
    while (hasMore && allTasks.length < 3000) {
        const options = {
            hostname: 'api.notion.com',
            path: `/v1/data_sources/${NOTION_DB_ID}/query`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${NOTION_API_KEY}`,
                'Notion-Version': '2025-09-03',
                'Content-Type': 'application/json'
            }
        };
        
        // Query ALL records - no filters
        const body = nextCursor 
            ? JSON.stringify({ page_size: 100, start_cursor: nextCursor })
            : JSON.stringify({ page_size: 100 });
        
        const response = await new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
        
        if (response.results) {
            const tasks = response.results.map(task => {
                const props = task.properties;
                let status = 'No Status';
                if (props.Status?.status?.name) status = props.Status.status.name;
                else if (props.Status?.select?.name) status = props.Status.select.name;
                
                // Get ID number from Notion's unique_id field
                const idNumber = props.ID?.unique_id?.number || 0;
                
                return {
                    id: task.id,
                    idNumber: idNumber,
                    name: props['Task name']?.title?.[0]?.plain_text || 'Untitled',
                    status: status,
                    priority: props.Priority?.select?.name || 'Medium',
                    role: props.Role?.select?.name || 'Unassigned',
                    dueDate: props['Due date']?.date?.start || null,
                    pastDue: props['Past due']?.formula?.boolean || false,
                    taskType: props['Task type']?.select?.name || 'Task',
                    summary: props.Summary?.rich_text?.[0]?.plain_text || ''
                };
            });
            allTasks.push(...tasks);
        }
        
        hasMore = response.has_more;
        nextCursor = response.next_cursor;
    }
    
    return allTasks;
}

async function getAgentTasks(req, res) {
    if (!NOTION_API_KEY) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Notion API key not configured', agents: [] }));
        return;
    }
    try {
        const allTasks = await fetchAllNotionTasks();

        // Role → agent display config
        const AGENTS = [
            { role: 'CEO',            name: 'Sidney',         icon: '👑',  id: 'ceo' },
            { role: 'CTO',            name: 'Steve',          icon: '⚙️',  id: 'cto' },
            { role: 'COO',            name: 'Anita',          icon: '📋',  id: 'anita' },
            { role: 'CSO',            name: 'Nicole',         icon: '📈',  id: 'nicole' },
            { role: 'Chief Engineer', name: 'Chief Engineer', icon: '🔧',  id: 'ce' },
            { role: 'Unassigned',     name: 'Unassigned',     icon: '📥',  id: 'main' },
        ];
        const DONE_STATUSES = new Set(['Done', 'Completed', 'Complete', 'Review', 'Archived']);
        const PRIORITY_ORDER = ['Critical', 'High', 'Medium', 'Low', 'No Priority'];

        const KNOWN_ROLES = new Set(AGENTS.map(a => a.role));
        const agentStats = AGENTS.map(({ role, name, icon, id }) => {
            // For 'Unassigned': tasks with role not in any known agent role
            const tasks = role === 'Unassigned'
                ? allTasks.filter(t => !KNOWN_ROLES.has(t.role))
                : allTasks.filter(t => t.role === role);
            const open  = tasks.filter(t => !DONE_STATUSES.has(t.status));
            const done  = tasks.filter(t => DONE_STATUSES.has(t.status));
            const byPriority = {};
            for (const p of PRIORITY_ORDER) byPriority[p] = 0;
            for (const t of open) {
                const p = t.priority || 'No Priority';
                byPriority[p] = (byPriority[p] || 0) + 1;
            }
            const overdue = open.filter(t => t.pastDue || (t.dueDate && new Date(t.dueDate) < new Date())).length;
            return { id, role, name, icon, total: tasks.length, open: open.length, done: done.length, overdue, byPriority };
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents: agentStats, fetchedAt: new Date().toISOString() }));
    } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, agents: [] }));
    }
}

// Track last backup time — read actual last git commit on startup
let lastBackupTime = (() => {
    try {
        const { execSync } = require('child_process');
        const iso = execSync('git -C ' + __dirname + ' log -1 --format=%cI 2>/dev/null').toString().trim();
        return iso ? new Date(iso) : new Date(0);
    } catch(e) { return new Date(0); }
})();

// Run GitHub backup
function runBackup(req, res) {
    const { exec } = require('child_process');
    
    console.log('Starting backup...');
    
    // Step 1: git add
    exec('cd ~/mission-control-server && git add -A', (addError, addStdout, addStderr) => {
        if (addError) {
            console.error('Git add error:', addError);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Git add failed', details: addError.message }));
            return;
        }
        console.log('Git add completed');
        
        // Step 2: git commit
        exec('cd ~/mission-control-server && git commit -m "Backup: ' + new Date().toISOString() + '"', (commitError, commitStdout, commitStderr) => {
            if (commitError) {
                // Check if it's just "nothing to commit"
                if (commitStderr && commitStderr.includes('nothing to commit')) {
                    console.log('Nothing to commit, proceeding to push...');
                } else {
                    console.error('Git commit error:', commitError, commitStderr);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Git commit failed', details: commitStderr || commitError.message }));
                    return;
                }
            } else {
                console.log('Git commit completed:', commitStdout);
            }
            
            // Step 3: git push
            exec('cd ~/mission-control-server && git push', (pushError, pushStdout, pushStderr) => {
                if (pushError) {
                    console.error('Git push error:', pushError, pushStderr);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Git push failed', details: pushStderr || pushError.message }));
                    return;
                }
                console.log('Git push completed:', pushStdout);
                lastBackupTime = new Date();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    message: 'Backup completed',
                    lastBackup: lastBackupTime.toISOString()
                }));
            });
        });
    });
}

function getLastBackupTime() {
    return lastBackupTime.toISOString();
}

function getBrainStatus(req, res) {
    const PASSED_FILE = '/Users/elf-6/openclaw/logs/brain_trainer_passed.json';
    const STATE_FILE  = '/Users/elf-6/openclaw/logs/brain_trainer_state.json';
    const LOG_FILE    = '/Users/elf-6/openclaw/logs/brain-trainer.log';
    const TOTAL = 90;
    try {
        const passed = fs.existsSync(PASSED_FILE) ? JSON.parse(fs.readFileSync(PASSED_FILE, 'utf8')) : [];
        const state  = fs.existsSync(STATE_FILE)  ? JSON.parse(fs.readFileSync(STATE_FILE,  'utf8')) : {};
        const passedCount = Array.isArray(passed) ? passed.length : 0;
        const score = Math.round((passedCount / TOTAL) * 100);

        // Get failures from the most recent run only
        let recentFailures = [];
        if (fs.existsSync(LOG_FILE)) {
            const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
            // Find start of last run
            let lastRunStart = 0;
            lines.forEach((l, i) => { if (l.includes('=== Brain Trainer run')) lastRunStart = i; });
            recentFailures = lines
                .slice(lastRunStart)
                .filter(l => l.includes('FAIL:'))
                .map(l => { const m = l.match(/FAIL: '(.+?)'/); return m ? m[1] : null; })
                .filter(Boolean);
        }

        let lastLines = [];
        if (fs.existsSync(LOG_FILE)) {
            const allLines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(l => l.trim());
            lastLines = allLines.slice(-8);
        }

        // Check if trainer process is actively running right now
        const { execSync } = require('child_process');
        let isRunning = false;
        try { isRunning = execSync('pgrep -f brain_trainer.py 2>/dev/null', { stdio: 'pipe' }).toString().trim().length > 0; } catch(e) {}

        const exploredPages = (state.explored_pages || []).length;
        const pagesValidated = state.pages_validated || 0;
        const totalNotionPages = state.total_notion_pages || 0;
        // Coverage = validated / total if known, else explored / 600 estimate
        const coverageDenom = totalNotionPages || 600;
        const coveragePct = Math.round((pagesValidated / coverageDenom) * 100);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            // Fixed Q&A score (secondary — sanity check)
            passed: passedCount,
            total: TOTAL,
            score,
            failed: TOTAL - passedCount,
            // Page coverage (primary metric)
            pagesValidated,
            exploredPages,
            totalNotionPages,
            coveragePct,
            pendingValidation: (state.pending_validation || []).length,
            runs: state.runs || 0,
            expansionSeeds: state.expansion_seeds || 0,
            sweepNum: state.sweep_num || 1,
            hasSweepCursor: !!state.sweep_cursor,
            mode: score >= 90 ? 'expansion' : 'remediation',
            recentFailures,
            lastLines,
            isRunning,
            timestamp: new Date().toISOString()
        }));
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
}

// Internet connectivity — ping 1.1.1.1 every 60s, track last success
let lastPingSuccess = null;
function runInternetPing() {
    exec('ping -c 1 -W 3 1.1.1.1 > /dev/null 2>&1 && echo ok || echo fail', (err, stdout) => {
        if ((stdout || '').trim() === 'ok') lastPingSuccess = Date.now();
    });
}
runInternetPing();
setInterval(runInternetPing, 60000);

function getInternetStatus(req, res) {
    const now = Date.now();
    const secsSince = lastPingSuccess ? Math.round((now - lastPingSuccess) / 1000) : null;
    let status, label;
    if (secsSince === null) {
        status = 'unknown'; label = 'No ping yet';
    } else if (secsSince <= 90) {
        status = 'ok';      label = `${secsSince}s ago`;
    } else if (secsSince <= 300) {
        status = 'warn';    label = `${Math.round(secsSince/60)}m ago`;
    } else if (secsSince <= 600) {
        status = 'warn';    label = `${Math.round(secsSince/60)}m ago`;
    } else {
        status = 'error';   label = `${Math.round(secsSince/60)}m ago`;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status, label, lastPingSuccess, secsSince }));
}

async function getSystemHealth(req, res) {
    const run = (cmd) => new Promise((resolve) => {
        exec(cmd, (err, stdout) => resolve(stdout ? stdout.trim() : ''));
    });

    try {
        const [cpuOut, vmstatOut, memsizeOut, diskOut, chipOut, bootOut, gatewayPidOut] = await Promise.all([
            run("ps -A -o %cpu | awk '{s+=$1} END {printf \"%.1f\", s}'"),
            run("vm_stat"),
            run("sysctl -n hw.memsize"),
            run("df -k / | tail -1"),
            run("sysctl -n machdep.cpu.brand_string 2>/dev/null || sysctl -n hw.model"),
            run("sysctl -n kern.boottime | grep -oE 'sec = [0-9]+' | grep -oE '[0-9]+'"),
            run("lsof -ti :3000 2>/dev/null | head -1")
        ]);

        // CPU — sum of all process %cpu (can exceed 100% on multi-core; normalize to logical CPUs)
        const logicalCPU = 10; // M4 Mac mini: 10 cores
        const cpuRaw = parseFloat(cpuOut) || 0;
        const cpuPct = Math.min(Math.round(cpuRaw / logicalCPU), 100);

        // Memory — parse vm_stat page size + page counts
        const pageSizeMatch = vmstatOut.match(/page size of (\d+) bytes/);
        const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1]) : 16384;
        const getPages = (key) => {
            const m = vmstatOut.match(new RegExp(key + ':\\s+(\\d+)'));
            return m ? parseInt(m[1]) : 0;
        };
        const active  = getPages('Pages active');
        const wired   = getPages('Pages wired down');
        const inactive = getPages('Pages inactive');
        const totalBytes = parseInt(memsizeOut) || 0;
        const totalGB = totalBytes / (1024 ** 3);
        const usedGB  = ((active + wired) * pageSize) / (1024 ** 3);
        const memPct  = Math.round((usedGB / totalGB) * 100);

        // Disk — df output: filesystem totalK usedK availK pct mount
        const dp = diskOut.split(/\s+/);
        const diskTotalKB = parseInt(dp[1]) || 0;
        const diskUsedKB  = parseInt(dp[2]) || 0;
        const diskFreeKB  = parseInt(dp[3]) || 0;
        const diskTotalGB = Math.round(diskTotalKB / (1024 ** 2));
        const diskUsedGB  = Math.round(diskUsedKB  / (1024 ** 2));
        const diskFreeGB  = Math.round(diskFreeKB  / (1024 ** 2));
        const diskPct     = Math.round((diskUsedKB / diskTotalKB) * 100);

        // Mac mini boot time
        const bootSec = parseInt(bootOut) || 0;
        const bootISO = bootSec ? new Date(bootSec * 1000).toISOString() : null;

        // Gateway start time from PID
        let gatewayStartISO = null;
        const gatewayPid = (gatewayPidOut || '').trim();
        if (gatewayPid) {
            const lstart = await run(`ps -o lstart= -p ${gatewayPid} 2>/dev/null`);
            if (lstart) gatewayStartISO = new Date(lstart).toISOString();
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            chip: chipOut || 'Apple M4',
            cores: logicalCPU,
            cpu:    { percent: cpuPct, raw: cpuRaw },
            memory: { totalGB: parseFloat(totalGB.toFixed(1)), usedGB: parseFloat(usedGB.toFixed(1)), percent: memPct },
            disk:   { totalGB: diskTotalGB, usedGB: diskUsedGB, freeGB: diskFreeGB, percent: diskPct },
            bootTime: bootISO,
            gatewayStartTime: gatewayStartISO,
            timestamp: new Date().toISOString()
        }));
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
}

function getHeartbeats(req, res) {
    const LOG_FILE = `${process.env.HOME}/openclaw/logs/agent-heartbeat.log`;
    const now = new Date();

    // Known schedule definitions (launchd plist schedules)
    const AGENTS = [
        { id: 'cto',            name: 'Steve (CTO)',        pattern: /Starting CTO morning briefing/,          nextFn: () => { const d = new Date(now); d.setHours(7,5,0,0); if (d <= now) d.setDate(d.getDate()+1); return d; } },
        { id: 'anita',          name: 'Anita (COO)',         pattern: /Starting Anita overdue task check/,      nextFn: () => { const d = new Date(now); d.setHours(8,5,0,0); if (d <= now) d.setDate(d.getDate()+1); return d; } },
        { id: 'anita-finance',  name: 'Anita Finance',      pattern: /Starting Anita.*finance/i,               nextFn: () => { const d = new Date(now); const day = d.getDay(); const daysUntilMon = (1 - day + 7) % 7 || 7; d.setDate(d.getDate() + daysUntilMon); d.setHours(7,30,0,0); return d; } },
        { id: 'ce',             name: 'Chief Engineer',     pattern: /Starting CE health check/,               nextFn: () => { const d = new Date(now); const mins = d.getHours()*60 + d.getMinutes(); const nextSlot = [36, 276, 516, 756, 996, 1236].find(s => s > mins) || 36+1440; d.setHours(Math.floor(nextSlot/60), nextSlot%60, 0, 0); if (nextSlot > 1440) d.setDate(d.getDate()+1); return d; } },
        { id: 'nicole',         name: 'Nicole (CSO)',       pattern: /Starting Nicole CSO daily/,              nextFn: () => { const d = new Date(now); d.setHours(17,0,0,0); if (d <= now) d.setDate(d.getDate()+1); return d; } },
        { id: 'nicole-weekly',  name: 'Nicole Weekly',      pattern: /Starting Nicole.*weekly/i,               nextFn: () => { const d = new Date(now); const day = d.getDay(); const daysUntilSun = (0 - day + 7) % 7 || 7; d.setDate(d.getDate() + daysUntilSun); d.setHours(18,0,0,0); return d; } }
    ];

    let logLines = [];
    try {
        const content = fs.readFileSync(LOG_FILE, 'utf8');
        logLines = content.split('\n').filter(l => l.match(/^\[2\d{3}-\d{2}-\d{2}/));
    } catch (e) {}

    const agents = AGENTS.map(agent => {
        // Find last line matching this agent's pattern
        let lastRun = null;
        for (let i = logLines.length - 1; i >= 0; i--) {
            if (agent.pattern.test(logLines[i])) {
                const m = logLines[i].match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
                if (m) { lastRun = new Date(m[1].replace(' ', 'T')); break; }
            }
        }
        const nextRun = agent.nextFn();
        const minutesSince = lastRun ? Math.floor((now - lastRun) / 60000) : null;
        return {
            id: agent.id,
            name: agent.name,
            lastRun: lastRun ? lastRun.toISOString() : null,
            lastRunDisplay: lastRun ? `${lastRun.getHours() % 12 || 12}:${String(lastRun.getMinutes()).padStart(2,'0')}${lastRun.getHours() >= 12 ? 'pm':'am'}` : 'Never',
            minutesSince,
            nextRun: nextRun.toISOString(),
            nextRunDisplay: (() => {
                const h = nextRun.getHours(); const m = nextRun.getMinutes();
                const isToday = nextRun.toDateString() === now.toDateString();
                const label = isToday ? '' : (nextRun.getDate() === now.getDate()+1 ? 'Tomorrow ' : nextRun.toLocaleDateString('en-US',{weekday:'short'})+' ');
                return `${label}${h%12||12}:${String(m).padStart(2,'0')}${h>=12?'pm':'am'}`;
            })(),
            status: lastRun ? (minutesSince < 1440 ? 'ok' : 'stale') : 'never'
        };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents, timestamp: now.toISOString() }));
}

function getCSoPipeline(req, res) {
    const PIPELINE_FILE = `${process.env.HOME}/openclaw/logs/cso_pipeline.json`;
    try {
        if (fs.existsSync(PIPELINE_FILE)) {
            const data = JSON.parse(fs.readFileSync(PIPELINE_FILE, 'utf8'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ opportunities: [], count: 0, lastReport: null, note: 'No pipeline data yet — Nicole CSO will populate this file during sessions.' }));
        }
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
}

function getFinancialPulse(req, res) {
    const PULSE_FILE = `${process.env.HOME}/openclaw/logs/financial_pulse.json`;
    try {
        if (fs.existsSync(PULSE_FILE)) {
            const data = JSON.parse(fs.readFileSync(PULSE_FILE, 'utf8'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ incomeStreams: [], count: 0, lastPulse: null, note: 'No financial data yet — Anita Monday finance heartbeat will populate this file.' }));
        }
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
}

function getAgentSessions(req, res) {
    const { execSync } = require('child_process');
    const AGENT_NAMES = {
        'cto':            'Steve (CTO)',
        'anita':          'Anita (COO)',
        'nicole':         'Nicole (CSO)',
        'chief-engineer': 'Chief Engineer',
        'main':           'Main',
    };
    try {
        const raw = execSync('/opt/homebrew/bin/node /opt/homebrew/bin/openclaw sessions --all-agents --json', {
            timeout: 10000,
            env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' }
        }).toString();
        const data = JSON.parse(raw);
        const sessions = data.sessions || [];
        const now = Date.now();

        // For each agent, find most recent main/direct session
        const agentStatus = Object.keys(AGENT_NAMES).map(agentId => {
            const agentSessions = sessions.filter(s =>
                s.agentId === agentId && s.kind === 'direct'
            );
            if (!agentSessions.length) {
                return {
                    agentId,
                    name: AGENT_NAMES[agentId],
                    status: 'offline',
                    lastActiveMs: null,
                    minutesSince: null,
                    totalTokens: 0,
                    contextTokens: 0,
                    contextPct: 0,
                    sessionKey: null,
                };
            }
            // Sort by updatedAt descending, take most recent
            agentSessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            const s = agentSessions[0];
            const minutesSince = s.updatedAt ? Math.round((now - s.updatedAt) / 60000) : null;
            const status = minutesSince === null ? 'offline'
                         : minutesSince < 60    ? 'online'
                         : minutesSince < 1440  ? 'idle'
                         : 'offline';
            const contextPct = s.contextTokens && s.totalTokens
                ? Math.round((s.totalTokens / s.contextTokens) * 100)
                : 0;
            return {
                agentId,
                name: AGENT_NAMES[agentId],
                status,
                lastActiveMs: s.updatedAt || null,
                minutesSince,
                totalTokens: s.totalTokens || 0,
                contextTokens: s.contextTokens || 0,
                contextPct,
                sessionKey: s.key || null,
            };
        });

        // User presence — Mac idle time as Sidney's "session" signal
        let userPresence = { status: 'unknown', idleSec: null };
        try {
            const { execSync: es2 } = require('child_process');
            const idleRaw = es2("ioreg -n IOHIDSystem | awk '/HIDIdleTime/{print $NF/1000000000; exit}'",
                { timeout: 3000, env: { ...process.env, PATH: '/usr/bin:/bin' } }).toString().trim();
            const idleSec = parseFloat(idleRaw) || 0;
            userPresence = {
                status: idleSec < 300 ? 'active' : idleSec < 1800 ? 'idle' : 'away',
                idleSec: Math.round(idleSec),
                idleMin: Math.round(idleSec / 60),
            };
        } catch(e) {}

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents: agentStatus, userPresence, fetchedAt: new Date().toISOString() }));
    } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents: [], error: err.message }));
    }
}

server.listen(PORT, HOST, () => {
    console.log(`🚀 DWE Mission Control Server`);
    console.log(`   Running on http://${HOST}:${PORT}`);
    console.log(`   Dashboard: http://${HOST}:${PORT}/`);
    console.log(`   Status: http://${HOST}:${PORT}/mc/status`);
    console.log(`   Data: http://${HOST}:${PORT}/mc/data`);
    console.log('');
    console.log('Press Ctrl+C to stop');
});

// Handle errors gracefully
process.on('uncaughtException', (err) => {
    console.error('Server error:', err);
});

process.on('SIGTERM', () => {
    console.log('Shutting down...');
    server.close(() => process.exit(0));
});

