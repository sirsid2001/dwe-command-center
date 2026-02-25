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
        case '/mc/agent-routing':
            getAgentRouting(req, res);
            break;
        case '/mc/notion-tasks':
            getNotionTasks(req, res);
            break;
        default:
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
    }
});

function serveFile(res, filePath, contentType) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        agents: [
            { id: 'steve', name: 'Steve', role: 'Chief Technology Officer', status: 'online', model: 'claude-3-5-sonnet' },
            { id: 'maxx', name: 'Maxx', role: 'Chief Operating Officer', status: 'busy', model: 'gpt-4o' },
            { id: 'anita', name: 'Anita', role: 'Project Manager', status: 'online', model: 'claude-3.5-haiku' },
            { id: 'lucy', name: 'Lucy', role: 'Executive Assistant', status: 'online', model: 'gpt-4o-mini' }
        ],
        count: 4
    }));
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
                const online = statusCode === '200' || statusCode === '401' || statusCode === '403';
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
    exec('launchctl list | grep com.dwe', (error, stdout) => {
        const services = [
            { id: 'DWE-001', name: 'Ops Report', status: 'waiting', nextRun: '10:00a' },
            { id: 'DWE-002', name: 'Ops Monitor', status: 'waiting', nextRun: '10:05a' },
            { id: 'DWE-003', name: 'Project Monitor', status: 'waiting', nextRun: '10:00a' },
            { id: 'DWE-007', name: 'COO Task Mgr', status: 'running', nextRun: 'Active' },
            { id: 'DWE-008', name: 'Lucy Email', status: 'waiting', nextRun: '7:00a' }
        ];

        if (!error && stdout) {
            stdout.split('\n').forEach(line => {
                if (line.includes('com.dwe')) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 3) {
                        const pid = parts[0];
                        const name = parts[2];
                        const service = services.find(s => name.toLowerCase().includes(s.name.toLowerCase().replace(/\s/g, '')));
                        if (service && pid !== '-') {
                            service.status = 'running';
                            service.pid = pid;
                        }
                    }
                }
            });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ services: services, timestamp: new Date().toISOString() }));
    });
}

function getAgentRouting(req, res) {
    const agents = [
        { id: 'coo', name: 'COO', emoji: '👨‍💼', role: 'Task routing & coordination', status: 'online', tasks: 12 },
        { id: 'cto', name: 'CTO', emoji: '💻', role: 'Technical & infrastructure', status: 'online', tasks: 8 },
        { id: 'chief', name: 'Chief', emoji: '🔧', role: 'Systems & architecture', status: 'idle', tasks: 3 },
        { id: 'security', name: 'Security', emoji: '🛡️', role: 'Protection & compliance', status: 'online', tasks: 5 }
    ];

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents: agents, timestamp: new Date().toISOString() }));
}

// Notion API integration - loaded from environment or config file
const NOTION_API_KEY = process.env.NOTION_API_KEY || '';
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

