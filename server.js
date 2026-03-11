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

    // n8n reverse proxy — solves mixed-content (HTTP dashboard → HTTPS n8n)
    if (pathname.startsWith('/n8n/') || pathname === '/n8n') {
        const targetPath = pathname.replace(/^\/n8n/, '') || '/';
        const targetUrl = 'https://n8n.tvcpulse.com' + targetPath + (parsedUrl.search || '');
        const proxyOpts = {
            hostname: 'n8n.tvcpulse.com',
            path: targetPath + (parsedUrl.search || ''),
            method: req.method,
            headers: { ...req.headers, host: 'n8n.tvcpulse.com' }
        };
        delete proxyOpts.headers['host'];
        proxyOpts.headers['host'] = 'n8n.tvcpulse.com';
        const proxyReq = https.request(proxyOpts, (proxyRes) => {
            // Rewrite Location headers for redirects
            const headers = { ...proxyRes.headers };
            if (headers.location && headers.location.includes('n8n.tvcpulse.com')) {
                headers.location = headers.location.replace('https://n8n.tvcpulse.com', '/n8n');
            }
            // Remove frame-blocking headers if any
            delete headers['x-frame-options'];
            delete headers['content-security-policy'];
            res.writeHead(proxyRes.statusCode, headers);
            proxyRes.pipe(res, { end: true });
        });
        proxyReq.on('error', (e) => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'n8n proxy error: ' + e.message }));
        });
        req.pipe(proxyReq, { end: true });
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
        case '/mc/openclaw-backup':
            if (req.method === 'POST') {
                runOpenclawBackup(req, res);
            } else if (req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ lastBackup: getLastOpenclawBackupTime() }));
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
        case '/mc/gateway-restart':
            exec(`launchctl kickstart -k gui/${process.getuid()}/ai.openclaw.gateway`, (err) => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: !err, error: err ? err.message : null }));
            });
            break;
        case '/mc/open-terminal':
            exec('open -a Terminal', (err) => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: !err }));
            });
            break;
        case '/mc/open-settings':
            exec('open "x-apple.systempreferences:"', (err) => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: !err }));
            });
            break;
        case '/mc/openclaw-version':
            getOpenclawVersion(req, res);
            break;
        case '/mc/openclaw-update-check':
            runOpenclawUpdateCheck(req, res);
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
        case '/mc/traffic':
            getTraffic(req, res);
            break;
        case '/mc/openrouter-credits':
            getOpenRouterCredits(req, res);
            break;
        case '/mc/digitalocean-status':
            getDigitalOceanStatus(req, res);
            break;
        case '/mc/sidney-devices':
            getSidneyDevices(req, res);
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
        case '/mc/pipeline':
            getPipeline(req, res);
            break;
        case '/mc/pipeline/move':
            movePipelineFile(req, res);
            break;
        case '/mc/pipeline/read':
            readPipelineFile(req, res);
            break;
        case '/mc/pipeline/open-finder':
            openPipelineInFinder(req, res);
            break;
        case '/dwe/status':
            handleDWEStatus(req, res);
            break;
        case '/dwe':
        case '/dwe/':
        case '/dwe/widget':
            serveFile(res, path.join(__dirname, 'dwe-widget.html'), 'text/html');
            break;
        case '/mc/drive-files':
            getDriveFiles(req, res, parsedUrl.query);
            break;
        case '/mc/drive-open':
            if (req.method === 'POST') {
                const { exec: execDriveOpen } = require('child_process');
                execDriveOpen(`open "${DRIVE_PATH}"`, (err) => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: !err }));
                });
            } else {
                res.writeHead(405); res.end(JSON.stringify({ error: 'POST only' }));
            }
            break;
        case '/mc/drive-copy':
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        const { file } = JSON.parse(body);
                        copyDriveFile(res, file);
                    } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
                });
            } else {
                res.writeHead(405); res.end(JSON.stringify({ error: 'POST only' }));
            }
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
            { id: 'cfo',            name: 'Fran',           role: 'Chief Financial Officer',  telegram: '@DWE_CFO_Bot',    status: gatewayUp ? 'online' : 'offline' },
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
    // Groups (render order): core, heartbeat, followup, anita-pm, brain, monitoring, routine
    const DAEMON_NAMES = {
        // ── Core Infrastructure (always-on services) ──
        'ai.openclaw.gateway':                  { name: 'OpenClaw Gateway',     group: 'core',       scheduled: false },
        'ai.openclaw.relay-daemon':             { name: 'Relay Daemon',         group: 'core',       scheduled: false },
        'com.missioncontrol.server':            { name: 'Mission Control',      group: 'core',       scheduled: false },

        // ── Agent Heartbeats (scheduled check-ins) ──
        'ai.dwe.agent-heartbeat-cto':           { name: 'CTO Heartbeat',        group: 'heartbeat',  scheduled: true  },
        'ai.dwe.agent-heartbeat-anita':         { name: 'COO Heartbeat',        group: 'heartbeat',  scheduled: true  },
        'ai.dwe.agent-heartbeat-ce':            { name: 'CE Heartbeat',         group: 'heartbeat',  scheduled: true  },
        'ai.dwe.agent-heartbeat-nicole':        { name: 'CSO Heartbeat',        group: 'heartbeat',  scheduled: true  },
        'ai.dwe.agent-heartbeat-nicole-weekly': { name: 'CSO Weekly Review',    group: 'heartbeat',  scheduled: true  },
        'ai.dwe.agent-heartbeat-anita-finance': { name: 'COO Finance Review',   group: 'heartbeat',  scheduled: true  },
        'ai.dwe.agent-heartbeat-anita-email-digest': { name: 'COO Email Digest', group: 'heartbeat', scheduled: true },
        'ai.dwe.agent-heartbeat-cfo':          { name: 'CFO Heartbeat',        group: 'heartbeat',  scheduled: true  },

        // ── Task Follow-Up (2h cycles) ──
        'ai.dwe.ce-task-followup':              { name: 'CE Follow-Up',         group: 'followup',   scheduled: true  },
        'ai.dwe.cto-task-followup':             { name: 'CTO Follow-Up',        group: 'followup',   scheduled: true  },
        'ai.dwe.nicole-task-followup':          { name: 'CSO Follow-Up',        group: 'followup',   scheduled: true  },
        'ai.dwe.cfo-task-followup':             { name: 'CFO Follow-Up',        group: 'followup',   scheduled: true  },

        // ── COO PM (operations & triage) ──
        'ai.dwe.anita-email-batch':             { name: 'Email Batch',          group: 'coo-pm',     scheduled: true  },
        'ai.dwe.anita-notion-triage':           { name: 'Notion Triage',        group: 'coo-pm',     scheduled: true  },
        'ai.dwe.morning-digest':                { name: 'Morning Digest',       group: 'coo-pm',     scheduled: true  },

        // ── Brain & Knowledge (Pinecone/RAG pipeline) ──
        'ai.dwe.seed-watcher':                  { name: 'Seed Watcher',         group: 'brain',      scheduled: false },
        'ai.dwe.notion-sync':                   { name: 'Notion Sync',          group: 'brain',      scheduled: false },
        'ai.dwe.brain-trainer':                 { name: 'Brain Trainer',        group: 'brain',      scheduled: true  },
        'ai.dwe.nightly-review':                { name: 'Nightly Review',       group: 'brain',      scheduled: true  },
        'ai.dwe.memory-decay':                  { name: 'Memory Decay',         group: 'brain',      scheduled: true  },

        // ── Monitoring & Health ──
        'ai.dwe.health-monitor':                { name: 'Health Monitor',       group: 'monitoring', scheduled: false },
        'ai.dwe.anomaly-check':                 { name: 'Anomaly Check',        group: 'monitoring', scheduled: true  },
        'ai.dwe.ralphy-monitor':                { name: 'Ralph Monitor',        group: 'monitoring', scheduled: true  },
        'com.dwe.ops-monitor':                  { name: 'Ops Monitor',          group: 'monitoring', scheduled: false },

        // ── Weekly Routines & Maintenance ──
        'ai.dwe.clawhub-check':                 { name: 'ClawHub Check',        group: 'routine',    scheduled: true  },
        'ai.dwe.soul-calibration':              { name: 'Soul Calibration',     group: 'routine',    scheduled: true  },
        'ai.dwe.night-mode-heartbeat':          { name: 'Night Mode',           group: 'routine',    scheduled: true  },
        'ai.dwe.openclaw-backup':               { name: 'OpenClaw Backup',      group: 'routine',    scheduled: true  },
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
                    // Skip OpenClaw app internals (updater, sparkle, app instance)
                    if (label.includes('sparkle') || label.startsWith('application.')) return;
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
        { id: 'cfo',            name: 'Fran',           emoji: '💰', role: 'Finance & budgets',              channel: 'Telegram @DWE_CFO_Bot' },
        { id: 'main',           name: 'Main',           emoji: '🚀', role: 'Primary assistant (web chat)',   channel: 'OpenClaw webchat' }
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents, timestamp: new Date().toISOString() }));
}

// Notion API integration - loaded from environment or config file
const NOTION_API_KEY = (() => {
    try { const k = fs.readFileSync(`${process.env.HOME}/.openclaw/.env`, 'utf8').match(/NOTION_API_KEY="?([^"\n]+)"?/)?.[1]?.trim(); if (k) return k; } catch(e) {}
    return process.env.NOTION_API_KEY || '';
})();
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
            { role: 'CFO',            name: 'Fran',           icon: '💰',  id: 'cfo' },
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
                // git exits 1 when nothing to commit — message appears in stdout
                const combined = (commitStdout || '') + (commitStderr || '') + (commitError.message || '');
                if (combined.includes('nothing to commit') || combined.includes('nothing added')) {
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

// ── OpenClaw Backup ─────────────────────────────────────────────────────────
let lastOpenclawBackupTime = (() => {
    try {
        const { execSync } = require('child_process');
        const newest = execSync('ls -t ~/openclaw/backups/*.tar.gz 2>/dev/null | head -1').toString().trim();
        if (newest) {
            const stats = require('fs').statSync(newest);
            return stats.mtime;
        }
        return new Date(0);
    } catch(e) { return new Date(0); }
})();

function getLastOpenclawBackupTime() {
    return lastOpenclawBackupTime.toISOString();
}

function runOpenclawBackup(req, res) {
    const { exec } = require('child_process');
    const SCRIPT = '/Users/elf-6/openclaw/agents/cto/skills/backup/backup.sh';

    console.log('Starting OpenClaw backup...');

    exec(SCRIPT, {
        timeout: 120000,
        env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/elf-6' }
    }, (error, stdout, stderr) => {
        if (error) {
            console.error('OpenClaw backup error:', error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Backup failed', details: stderr || error.message }));
            return;
        }

        // Parse JSON from last line of stdout (log lines go to tee, JSON is final line)
        try {
            const lines = stdout.trim().split('\n');
            const result = JSON.parse(lines[lines.length - 1]);
            if (result.success) {
                lastOpenclawBackupTime = new Date();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: result.success,
                message: result.success ? 'OpenClaw backup completed' : 'Backup failed',
                lastBackup: lastOpenclawBackupTime.toISOString(),
                archive: result.archive || null,
                totalBackups: result.totalBackups || 0
            }));
        } catch(e) {
            // Fallback: if JSON parsing fails but script exited 0, treat as success
            lastOpenclawBackupTime = new Date();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Backup completed', lastBackup: lastOpenclawBackupTime.toISOString() }));
        }
    });
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
        // Denominator: use real total if known, otherwise round up from explored to nearest 500
        const coverageDenom = totalNotionPages || Math.max(1000, Math.ceil(exploredPages / 500) * 500);
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

// OpenRouter credits — cached, refreshed every 5 minutes
const OPENROUTER_API_KEY = (() => {
    if (process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_API_KEY.startsWith('your_')) return process.env.OPENROUTER_API_KEY;
    try { return fs.readFileSync(`${process.env.HOME}/.openclaw/.env`, 'utf8').match(/OPENROUTER_API_KEY="?([^"\n]+)"?/)?.[1]?.trim() || ''; } catch(e) { return ''; }
})();

let orCreditsCache = null;
const OR_CREDITS_TTL = 5 * 60 * 1000;

function fetchOpenRouterCredits() {
    if (!OPENROUTER_API_KEY) return;
    const opts = {
        hostname: 'openrouter.ai',
        path: '/api/v1/credits',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` }
    };
    const req = https.request(opts, ores => {
        let data = '';
        ores.on('data', c => data += c);
        ores.on('end', () => {
            try {
                const j = JSON.parse(data);
                const d = j.data || j;
                // total_credits and total_usage are in USD cents (credits units)
                const total = typeof d.total_credits === 'number' ? d.total_credits : null;
                const usage = typeof d.total_usage === 'number' ? d.total_usage : 0;
                const remaining = total !== null ? Math.max(0, total - usage) : null;
                orCreditsCache = { remaining, usage, total, fetchedAt: Date.now() };
            } catch(e) {}
        });
    });
    req.on('error', () => {});
    req.end();
}
fetchOpenRouterCredits();
setInterval(fetchOpenRouterCredits, OR_CREDITS_TTL);

function getOpenRouterCredits(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!OPENROUTER_API_KEY) { res.end(JSON.stringify({ error: 'No API key', remaining: null })); return; }
    res.end(JSON.stringify(orCreditsCache || { remaining: null, fetchedAt: null }));
}

// DigitalOcean droplet monitoring — cached, refreshed every 2 minutes
const DO_API_TOKEN = (() => {
    if (process.env.DIGITALOCEAN_TOKEN && !process.env.DIGITALOCEAN_TOKEN.startsWith('your_')) return process.env.DIGITALOCEAN_TOKEN;
    try { return fs.readFileSync(`${process.env.HOME}/.openclaw/.env`, 'utf8').match(/DIGITALOCEAN_TOKEN="?([^"\n]+)"?/)?.[1]?.trim() || ''; } catch(e) { return ''; }
})();

let doMetricsCache = null;
let doDropletId = null;
const DO_METRICS_TTL = 2 * 60 * 1000;

function doApiGet(path) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.digitalocean.com',
            path: path,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${DO_API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch(e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function getLatestValue(metricsResponse) {
    try {
        const results = metricsResponse?.data?.result;
        if (!results || results.length === 0) return null;
        // Get the last value from the first result series
        const values = results[0].values;
        if (!values || values.length === 0) return null;
        return parseFloat(values[values.length - 1][1]);
    } catch(e) { return null; }
}

async function fetchDigitalOceanMetrics() {
    if (!DO_API_TOKEN) return;
    try {
        // Step 1: Get droplet ID if we don't have it
        if (!doDropletId) {
            const droplets = await doApiGet('/v2/droplets?per_page=10');
            if (droplets.droplets && droplets.droplets.length > 0) {
                // Use first droplet (or find n8n one)
                const d = droplets.droplets.find(d => d.name.includes('n8n')) || droplets.droplets[0];
                doDropletId = d.id;
                doMetricsCache = doMetricsCache || {};
                doMetricsCache.dropletName = d.name;
                doMetricsCache.region = d.region?.slug || '';
                doMetricsCache.size = d.size_slug || '';
                doMetricsCache.ip = d.networks?.v4?.find(n => n.type === 'public')?.ip_address || '';
                doMetricsCache.dropletStatus = d.status;
            } else {
                doMetricsCache = { error: 'No droplets found', fetchedAt: Date.now() };
                return;
            }
        }

        // Step 2: Fetch metrics (last 5 minutes)
        const end = Math.floor(Date.now() / 1000);
        const start = end - 300;
        const base = `/v2/monitoring/metrics/droplet`;
        const qs = `host_id=${doDropletId}&start=${start}&end=${end}`;

        const [cpuData, memAvail, memTotal, diskFree, diskSize, load1] = await Promise.all([
            doApiGet(`${base}/cpu?${qs}`),
            doApiGet(`${base}/memory_available?${qs}`),
            doApiGet(`${base}/memory_total?${qs}`),
            doApiGet(`${base}/filesystem_free?${qs}`),
            doApiGet(`${base}/filesystem_size?${qs}`),
            doApiGet(`${base}/load_1?${qs}`)
        ]);

        // CPU: sum non-idle modes or compute from idle
        let cpuPct = null;
        try {
            const cpuResults = cpuData?.data?.result || [];
            const idleSeries = cpuResults.find(r => r.metric?.mode === 'idle');
            if (idleSeries && idleSeries.values && idleSeries.values.length > 0) {
                const idleVal = parseFloat(idleSeries.values[idleSeries.values.length - 1][1]);
                cpuPct = Math.max(0, Math.min(100, 100 - idleVal));
            }
        } catch(e) {}

        const memAvailVal = getLatestValue(memAvail);
        const memTotalVal = getLatestValue(memTotal);
        const diskFreeVal = getLatestValue(diskFree);
        const diskSizeVal = getLatestValue(diskSize);
        const load1Val = getLatestValue(load1);

        const agentInstalled = memTotalVal !== null;

        const cache = {
            dropletName: doMetricsCache?.dropletName || '',
            region: doMetricsCache?.region || '',
            size: doMetricsCache?.size || '',
            ip: doMetricsCache?.ip || '',
            dropletStatus: doMetricsCache?.dropletStatus || '',
            cpu: cpuPct !== null ? Math.round(cpuPct * 10) / 10 : null,
            memFreeMB: memAvailVal !== null ? Math.round(memAvailVal / 1024 / 1024) : null,
            memTotalMB: memTotalVal !== null ? Math.round(memTotalVal / 1024 / 1024) : null,
            memUsedPct: (memAvailVal !== null && memTotalVal !== null && memTotalVal > 0)
                ? Math.round((1 - memAvailVal / memTotalVal) * 1000) / 10 : null,
            diskFreeMB: diskFreeVal !== null ? Math.round(diskFreeVal / 1024 / 1024) : null,
            diskTotalMB: diskSizeVal !== null ? Math.round(diskSizeVal / 1024 / 1024) : null,
            diskUsedPct: (diskFreeVal !== null && diskSizeVal !== null && diskSizeVal > 0)
                ? Math.round((1 - diskFreeVal / diskSizeVal) * 1000) / 10 : null,
            load1: load1Val !== null ? Math.round(load1Val * 100) / 100 : null,
            agentInstalled,
            fetchedAt: Date.now()
        };

        doMetricsCache = cache;
        console.log(`[DO Metrics] CPU: ${cache.cpu}%, MEM: ${cache.memUsedPct}%, DISK: ${cache.diskUsedPct}%, LOAD: ${cache.load1}`);
    } catch(e) {
        console.error('[DO Metrics] Error:', e.message);
        if (!doMetricsCache) doMetricsCache = { error: e.message, fetchedAt: Date.now() };
    }
}

if (DO_API_TOKEN) {
    fetchDigitalOceanMetrics();
    setInterval(fetchDigitalOceanMetrics, DO_METRICS_TTL);
}

async function getDigitalOceanStatus(req, res) {
    if (!DO_API_TOKEN) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No DigitalOcean API token. Add DIGITALOCEAN_TOKEN to ~/.openclaw/.env', configured: false }));
        return;
    }
    // Force refresh if ?refresh=1
    const parsedReq = url.parse(req.url, true);
    if (parsedReq.query.refresh === '1') {
        await fetchDigitalOceanMetrics();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(doMetricsCache || { configured: true, loading: true, fetchedAt: null }));
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

// Network traffic monitor — per-service via nettop + total via netstat, refreshed every 5s
const SERVICE_IP_MAP = {
    // prefix → service name (matched against connection remote IPs)
    '208.103.161': 'notion',
    '64.23.238.56': 'n8n',
    '104.18.2': 'openrouter',
    '104.18.3': 'openrouter',
    '140.82.11': 'github',
    '34.36.155': 'brain',
};
let trafficCache = {
    total: { bytesIn: 0, bytesOut: 0, mbpsIn: 0, mbpsOut: 0 },
    services: { notion: { bytesIn: 0, bytesOut: 0 }, n8n: { bytesIn: 0, bytesOut: 0 }, openrouter: { bytesIn: 0, bytesOut: 0 }, github: { bytesIn: 0, bytesOut: 0 }, brain: { bytesIn: 0, bytesOut: 0 } },
    iface: null, ts: null
};
let prevServiceCounters = null;
let prevServiceTs = null;

function sampleTraffic() {
    // Run both nettop (per-connection) and netstat (total) in parallel
    exec("nettop -L 1 -n -x -J bytes_in,bytes_out 2>/dev/null", { timeout: 8000 }, (err, nettopOut) => {
        exec("netstat -ib | grep -E '^en[01].*<Link'", (err2, netstatOut) => {
            const now = Date.now();

            // Parse total from netstat
            let totalIn = 0, totalOut = 0, iface = null;
            if (netstatOut) {
                for (const line of netstatOut.trim().split('\n')) {
                    const cols = line.trim().split(/\s+/);
                    if (cols.length >= 10 && parseInt(cols[4]) > 0) {
                        iface = cols[0];
                        totalIn = parseInt(cols[6]);
                        totalOut = parseInt(cols[9]);
                        break;
                    }
                }
            }

            // Parse per-connection from nettop, aggregate by service
            const svcBytes = { notion: { bi: 0, bo: 0 }, n8n: { bi: 0, bo: 0 }, openrouter: { bi: 0, bo: 0 }, github: { bi: 0, bo: 0 }, brain: { bi: 0, bo: 0 } };
            if (nettopOut) {
                for (const line of nettopOut.trim().split('\n')) {
                    // Connection lines look like: tcp4 192.168.1.80:61493<->17.57.144.43:5223,4528852,12156547,
                    const m = line.match(/^tcp[46]\s+[\d.:]+<->([\d.]+):\d+,(\d+),(\d+),/);
                    if (!m) continue;
                    const remoteIP = m[1];
                    const bi = parseInt(m[2]) || 0;
                    const bo = parseInt(m[3]) || 0;
                    // Match remote IP to a service
                    for (const [prefix, svc] of Object.entries(SERVICE_IP_MAP)) {
                        if (remoteIP.startsWith(prefix)) {
                            svcBytes[svc].bi += bi;
                            svcBytes[svc].bo += bo;
                            break;
                        }
                    }
                }
            }

            // Total traffic uses netstat deltas (reliable interface counters)
            const services = {};
            for (const svc of Object.keys(svcBytes)) {
                // Use raw cumulative bytes as activity level (nettop counters are per-connection cumulative)
                services[svc] = {
                    bytesIn: svcBytes[svc].bi,
                    bytesOut: svcBytes[svc].bo
                };
            }

            if (prevServiceCounters && prevServiceTs) {
                const elapsed = (now - prevServiceTs) / 1000;
                if (elapsed > 0) {
                    const dTotalIn = totalIn - (prevServiceCounters.totalIn || 0);
                    const dTotalOut = totalOut - (prevServiceCounters.totalOut || 0);
                    if (dTotalIn >= 0 && dTotalOut >= 0) {
                        trafficCache = {
                            total: {
                                bytesIn: Math.round(dTotalIn / elapsed),
                                bytesOut: Math.round(dTotalOut / elapsed),
                                mbpsIn: parseFloat(((dTotalIn / elapsed) * 8 / 1000000).toFixed(2)),
                                mbpsOut: parseFloat(((dTotalOut / elapsed) * 8 / 1000000).toFixed(2))
                            },
                            services,
                            iface,
                            ts: now
                        };
                    }
                }
            }
            prevServiceCounters = { totalIn, totalOut };
            prevServiceTs = now;
        });
    });
}
sampleTraffic();
setInterval(sampleTraffic, 5000);

function getTraffic(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(trafficCache));
}

async function getSystemHealth(req, res) {
    const run = (cmd) => new Promise((resolve) => {
        exec(cmd, (err, stdout) => resolve(stdout ? stdout.trim() : ''));
    });

    try {
        const [cpuOut, vmstatOut, memsizeOut, diskOut, chipOut, bootOut, gatewayPidOut, ipOut, gwOut] = await Promise.all([
            run("ps -A -o %cpu | awk '{s+=$1} END {printf \"%.1f\", s}'"),
            run("vm_stat"),
            run("sysctl -n hw.memsize"),
            run("df -k / | tail -1"),
            run("sysctl -n machdep.cpu.brand_string 2>/dev/null || sysctl -n hw.model"),
            run("sysctl -n kern.boottime | grep -oE 'sec = [0-9]+' | grep -oE '[0-9]+'"),
            run("launchctl list ai.openclaw.gateway 2>/dev/null | grep '\"PID\"' | tr -dc '0-9'"),
            run("ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo ''"),
            run("route -n get default 2>/dev/null | awk '/gateway:/{print $2}'")
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
            localIP: ipOut || null,
            defaultGateway: gwOut || null,
            timestamp: new Date().toISOString()
        }));
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
}

// --- Sidney Device Presence (iPhone + Apple Watch) ---
let sidneyDevicesCache = { iphone: null, watch: null, fetchedAt: null };

// Known device identifiers
const IPHONE_MAC = 'c4:5b:ac:a3:d3:dd';
const WATCH_BONJOUR = 'OverWatch-P';

async function pollSidneyDevices() {
    const run = (cmd, timeoutMs = 5000) => new Promise((resolve) => {
        exec(cmd, { timeout: timeoutMs }, (err, stdout) => resolve(stdout ? stdout.trim() : ''));
    });

    try {
        // Strategy: send a targeted ping to refresh ARP cache, then check ARP table by MAC.
        // Apple devices throttle ICMP but ARP entries persist if device is on WiFi.
        await run('/sbin/ping -c 1 -t 1 192.168.1.114 2>/dev/null', 3000);

        // iPhone: check ARP table for known MAC (-n skips slow DNS lookups)
        const arpTable = await run('/usr/sbin/arp -an');
        let iphoneOnline = false, iphoneIP = null;
        const iphoneLine = arpTable.split('\n').find(l => l.includes(IPHONE_MAC));
        if (iphoneLine && !iphoneLine.includes('(incomplete)')) {
            iphoneOnline = true;
            const m = iphoneLine.match(/\(([0-9.]+)\)/);
            iphoneIP = m ? m[1] : null;
        }

        // Apple Watch: resolve mDNS hostname via ping, then verify in ARP table.
        // Ping may fail (watchOS throttles ICMP) but mDNS resolution populates ARP.
        let watchOnline = false, watchIP = null;
        const watchPingOut = await run(`/sbin/ping -c 1 -t 2 ${WATCH_BONJOUR}.local 2>&1 || true`, 5000);
        const watchIpMatch = watchPingOut.match(/\((\d+\.\d+\.\d+\.\d+)\)/);
        if (watchIpMatch) {
            watchIP = watchIpMatch[1];
            // Re-check ARP (may have been updated by the ping attempt)
            const arpRefresh = await run('/usr/sbin/arp -an');
            const watchArp = arpRefresh.split('\n').find(l => l.includes(watchIP));
            watchOnline = !!(watchArp && !watchArp.includes('(incomplete)'));
        }

        sidneyDevicesCache = {
            iphone: { online: iphoneOnline, ip: iphoneIP, name: 'iPhone' },
            watch:  { online: watchOnline,  ip: watchIP,  name: 'Apple Watch' },
            fetchedAt: Date.now()
        };
    } catch (e) {
        console.error('Sidney device poll error:', e.message);
    }
}

// Poll every 30 seconds
pollSidneyDevices();
setInterval(pollSidneyDevices, 30000);

function getSidneyDevices(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sidneyDevicesCache));
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
        { id: 'nicole-weekly',  name: 'Nicole Weekly',      pattern: /Starting Nicole.*weekly/i,               nextFn: () => { const d = new Date(now); const day = d.getDay(); const daysUntilSun = (0 - day + 7) % 7 || 7; d.setDate(d.getDate() + daysUntilSun); d.setHours(18,0,0,0); return d; } },
        { id: 'cfo',            name: 'Fran (CFO)',         pattern: /Starting CFO health check/,              nextFn: () => { const d = new Date(now); const mins = d.getHours()*60 + d.getMinutes(); const nextSlot = [36, 276, 516, 756, 996, 1236].find(s => s > mins) || 36+1440; d.setHours(Math.floor(nextSlot/60), nextSlot%60, 0, 0); if (nextSlot > 1440) d.setDate(d.getDate()+1); return d; } }
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

    // Read agent models from openclaw.json
    let defaultModel = 'openrouter/auto';
    const agentModels = {};
    try {
        const cfg = JSON.parse(fs.readFileSync(`${process.env.HOME}/.openclaw/openclaw.json`, 'utf8'));
        defaultModel = cfg.agents?.defaults?.model?.primary || 'openrouter/auto';
        (cfg.agents?.list || []).forEach(a => {
            agentModels[a.id] = a.model?.primary || defaultModel;
        });
    } catch(e) {}

    // Return full model string for dashboard color-coding
    function shortModel(m) {
        if (!m) return defaultModel;
        return m; // keep full string so dashboard can detect provider prefix
    }
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
                    model: shortModel(agentModels[agentId] || defaultModel),
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
                model: shortModel(agentModels[agentId] || defaultModel),
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

// ── Document Pipeline ─────────────────────────────────────────────────────────
const PIPELINE_BASE = `${process.env.HOME}/openclaw/shared`;
const PIPELINE_STAGES = ['1_New', '2_CEO_review', '3_Approved', '4_Ready_to_Seed', '5_Failed_Seed'];

function getPipeline(req, res) {
    const result = {};
    PIPELINE_STAGES.forEach(stage => {
        try {
            const files = fs.readdirSync(`${PIPELINE_BASE}/${stage}`)
                .filter(f => !f.startsWith('.') && f !== 'placeholder.txt' && f !== '.gitkeep');
            result[stage] = files.sort();
        } catch(e) { result[stage] = []; }
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stages: result, timestamp: new Date().toISOString() }));
}

function movePipelineFile(req, res) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
        try {
            const { file, from, to } = JSON.parse(body);
            // Validate inputs
            if (!file || !from || !to) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Missing file, from, or to' })); return; }
            if (!PIPELINE_STAGES.includes(from)) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Invalid from stage' })); return; }
            if (!PIPELINE_STAGES.includes(to)) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Invalid to stage' })); return; }
            // Prevent path traversal
            const safeName = path.basename(file);
            const src = path.join(PIPELINE_BASE, from, safeName);
            const dst = path.join(PIPELINE_BASE, to, safeName);
            if (!fs.existsSync(src)) { res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'File not found' })); return; }
            fs.renameSync(src, dst);
            console.log(`[pipeline] Moved ${safeName}: ${from} → ${to}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, file: safeName, from, to }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
    });
}

function openPipelineInFinder(req, res) {
    const u = new url.URL(req.url, `http://localhost`);
    const stage = u.searchParams.get('stage');
    if (!stage || !PIPELINE_STAGES.includes(stage)) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false })); return;
    }
    const folderPath = path.join(PIPELINE_BASE, stage);
    exec(`open "${folderPath}"`, () => {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
}

function readPipelineFile(req, res) {
    const u = new url.URL(req.url, `http://localhost`);
    const stage = u.searchParams.get('stage');
    const file  = u.searchParams.get('file');
    if (!stage || !file || !PIPELINE_STAGES.includes(stage)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid stage or file' }));
        return;
    }
    const safeName = path.basename(file);
    const filePath = path.join(PIPELINE_BASE, stage, safeName);
    if (!filePath.startsWith(PIPELINE_BASE)) {
        res.writeHead(403); res.end(JSON.stringify({ ok: false, error: 'Forbidden' })); return;
    }
    try {
        const stat = fs.statSync(filePath);
        if (stat.size > 500 * 1024) { // 500KB cap for display
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, content: '[File too large to display — ' + Math.round(stat.size/1024) + 'KB]', truncated: true }));
            return;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, content, size: stat.size }));
    } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
    }
}

// ── OpenClaw Version Management ──────────────────────────────────────────
const OC_VERSION_STATE = path.join(__dirname, '.openclaw-version-state.json');

function getOpenclawVersion(req, res) {
    res.setHeader('Content-Type', 'application/json');
    // Read current version from openclaw.json
    try {
        const ocConfig = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.openclaw/openclaw.json'), 'utf8'));
        const currentVersion = ocConfig.meta?.lastTouchedVersion || 'unknown';
        // Read cached update state if it exists
        let updateState = {};
        try {
            updateState = JSON.parse(fs.readFileSync(OC_VERSION_STATE, 'utf8'));
        } catch(e) { /* no cached state yet */ }
        res.end(JSON.stringify({
            ok: true,
            currentVersion,
            latestVersion: updateState.latestVersion || null,
            updateAvailable: updateState.updateAvailable || false,
            lastChecked: updateState.lastChecked || null,
            releaseUrl: updateState.releaseUrl || null,
            releaseNotes: updateState.releaseNotes || null,
            dweImpact: updateState.dweImpact || null
        }));
    } catch(e) {
        res.end(JSON.stringify({ ok: false, error: e.message }));
    }
}

function runOpenclawUpdateCheck(req, res) {
    res.setHeader('Content-Type', 'application/json');
    exec('npx openclaw update --dry-run --json 2>/dev/null', { timeout: 30000 }, (err, stdout) => {
        if (err) {
            res.end(JSON.stringify({ ok: false, error: err.message }));
            return;
        }
        try {
            const data = JSON.parse(stdout.trim());
            const current = data.currentVersion || 'unknown';
            const target = data.targetVersion || current;
            const updateAvailable = current !== target;
            const state = {
                currentVersion: current,
                latestVersion: target,
                updateAvailable,
                lastChecked: new Date().toISOString(),
                releaseUrl: `https://www.npmjs.com/package/openclaw/v/${target}`,
                releaseNotes: null,
                dweImpact: null,
                actions: data.actions || [],
                channel: data.effectiveChannel || 'stable'
            };
            // If update available, fetch npm info for release summary
            if (updateAvailable) {
                exec(`npm view openclaw@${target} description 2>/dev/null`, { timeout: 10000 }, (e2, desc) => {
                    if (!e2 && desc) state.releaseNotes = desc.trim();
                    fs.writeFileSync(OC_VERSION_STATE, JSON.stringify(state, null, 2));
                    res.end(JSON.stringify({ ok: true, ...state }));
                });
            } else {
                fs.writeFileSync(OC_VERSION_STATE, JSON.stringify(state, null, 2));
                res.end(JSON.stringify({ ok: true, ...state }));
            }
        } catch(e) {
            res.end(JSON.stringify({ ok: false, error: 'Failed to parse update check output' }));
        }
    });
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

// ── Google Drive File Browser ────────────────────────────────────────────────
const DRIVE_PATH = '/Users/elf-6/Library/CloudStorage/GoogleDrive-sirsid2001@gmail.com/My Drive/';
const CEO_REVIEW_PATH = '/Users/elf-6/openclaw/shared/2_CEO_review/';
const DOC_EXTENSIONS = new Set(['.gsheet', '.gdoc', '.gslides', '.xlsx', '.pdf', '.csv', '.md', '.docx', '.txt']);

function getDriveFiles(req, res, query) {
    const search = (query.search || '').toLowerCase();
    try {
        const files = fs.readdirSync(DRIVE_PATH)
            .filter(name => {
                const ext = path.extname(name).toLowerCase();
                if (!DOC_EXTENSIONS.has(ext)) return false;
                if (search && !name.toLowerCase().includes(search)) return false;
                return true;
            })
            .map(name => {
                let stat;
                try { stat = fs.statSync(path.join(DRIVE_PATH, name)); } catch(e) { stat = null; }
                return {
                    name,
                    ext: path.extname(name).replace('.', ''),
                    size: stat ? stat.size : 0,
                    modified: stat ? stat.mtime.toISOString() : null
                };
            })
            .sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files, total: files.length }));
    } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, files: [] }));
    }
}

function copyDriveFile(res, filename) {
    if (!filename) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No filename provided' }));
        return;
    }
    // Sanitize: prevent path traversal
    const safe = path.basename(filename);
    const src = path.join(DRIVE_PATH, safe);
    const dest = path.join(CEO_REVIEW_PATH, safe);
    if (!fs.existsSync(src)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found in Drive' }));
        return;
    }
    try {
        fs.copyFileSync(src, dest);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, destination: dest }));
    } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
}

// Handle errors gracefully
process.on('uncaughtException', (err) => {
    console.error('Server error:', err);
});

process.on('SIGTERM', () => {
    console.log('Shutting down...');
    server.close(() => process.exit(0));
});

