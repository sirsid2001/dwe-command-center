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
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

// ── Performance: gzip helper ────────────────────────────────────────────
const COMPRESSIBLE = new Set(['text/html', 'application/javascript', 'text/css', 'application/json', 'image/svg+xml']);
function sendCompressed(req, res, statusCode, headers, body) {
    const ct = headers['Content-Type'] || '';
    const baseType = ct.split(';')[0].trim();
    const acceptEncoding = (req.headers['accept-encoding'] || '');
    if (COMPRESSIBLE.has(baseType) && acceptEncoding.includes('gzip') && body.length > 1024) {
        zlib.gzip(body, (err, compressed) => {
            if (err) { res.writeHead(statusCode, headers); res.end(body); return; }
            headers['Content-Encoding'] = 'gzip';
            headers['Vary'] = 'Accept-Encoding';
            res.writeHead(statusCode, headers);
            res.end(compressed);
        });
    } else {
        res.writeHead(statusCode, headers);
        res.end(body);
    }
}

// ── Performance: body size limit ────────────────────────────────────────
const MAX_BODY_SIZE = 1024 * 1024; // 1 MB
function collectBody(req, callback) {
    let body = '';
    let exceeded = false;
    req.on('data', chunk => {
        body += chunk;
        if (body.length > MAX_BODY_SIZE) { exceeded = true; req.destroy(); }
    });
    req.on('end', () => { if (!exceeded) callback(body); });
    req.on('error', () => {});
}

// DWE Widget API
const { getDWEStats, fetchAllNotionTasks, createNotionTask } = require('./dwe-widget-api.js');
const nodemailer = require('nodemailer');

// Sprint Orchestrator
const sprint = require('./sprint-orchestrator.js');

// Centralized Operations Log
const opsLog = require('./ops-log.js');

// Sprint Retrospective Engine
const sprintRetro = require('./sprint-retro.js');
const skoolScraper = require('./skool-scraper.js');
const skoolPipeline = require('./skool-pipeline.js');
const ytIntel = require('./yt-intel.js');

// PID file management — prevents zombie processes on restart
const PID_FILE = path.join(__dirname, 'mc-server.pid');
(function managePidFile() {
    // Kill stale process if PID file exists
    if (fs.existsSync(PID_FILE)) {
        const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (oldPid && oldPid !== process.pid) {
            try { process.kill(oldPid, 0); process.kill(oldPid, 'SIGTERM'); console.log(`[PID] Killed stale process ${oldPid}`); } catch(e) { /* already dead */ }
        }
    }
    fs.writeFileSync(PID_FILE, String(process.pid));
    const cleanup = () => { try { fs.unlinkSync(PID_FILE); } catch(e) {} process.exit(); };
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
})();

// Config
const PORT = 8899;
const HOST = '0.0.0.0';  // listen on all interfaces (LAN accessible)
const DATA_FILE = path.join(__dirname, 'mc-data.json');

// ── Server-side response cache ────────────────────────────────────────────
// Caches slow endpoint responses so repeat loads are instant.
// Used by: income-ops, n8n-uptime, services, acp, crons
const _responseCache = new Map(); // key → { data, ts }
function cachedResponse(req, res, ttlMs, fetchFn) {
    const key = req.url || req;
    const now = Date.now();
    const cached = _responseCache.get(key);
    if (cached && (now - cached.ts) < ttlMs) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Cache': 'HIT' });
        res.end(cached.data);
        return;
    }
    // Intercept the real response
    const _origWriteHead = res.writeHead.bind(res);
    const _origEnd = res.end.bind(res);
    let _statusCode = 200;
    res.writeHead = (code, headers) => { _statusCode = code; return _origWriteHead(code, headers); };
    res.end = (body) => {
        if (_statusCode === 200 && typeof body === 'string') {
            _responseCache.set(key, { data: body, ts: now });
        }
        return _origEnd(body);
    };
    fetchFn(req, res);
}
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // ── Performance: reject oversized POST bodies early ─────────────
    if (req.method === 'POST' || req.method === 'PUT') {
        let bodySize = 0;
        req.on('data', (chunk) => {
            bodySize += chunk.length;
            if (bodySize > MAX_BODY_SIZE) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Request body too large (max 1 MB)' }));
                req.destroy();
            }
        });
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    
    // Static file serving
    if (pathname === '/' || pathname === '/index.html') {
        serveFile(res, HTML_FILE, 'text/html', req);
        return;
    }
    
    // Ecosystem Map page
    if (pathname === '/ecosystem' || pathname === '/ecosystem.html') {
        serveFile(res, path.join(__dirname, 'ecosystem.html'), 'text/html', req);
        return;
    }
    
    // AI Team page
    if (pathname === '/ai-team' || pathname === '/ai-team.html') {
        serveFile(res, path.join(__dirname, 'ai-team.html'), 'text/html', req);
        return;
    }

    // Delegations page
    if (pathname === '/delegations' || pathname === '/delegations.html') {
        serveFile(res, path.join(__dirname, 'delegations.html'), 'text/html', req);
        return;
    }

    // Revenue page
    if (pathname === '/revenue' || pathname === '/revenue.html') {
        serveFile(res, path.join(__dirname, 'revenue.html'), 'text/html', req);
        return;
    }
    if (pathname === '/funnel' || pathname === '/funnel.html' || pathname === '/pipelines' || pathname === '/pipelines.html') {
        serveFile(res, path.join(__dirname, 'funnel.html'), 'text/html', req);
        return;
    }

    // CEO's Corner page
    if (pathname === '/ceo-corner' || pathname === '/ceo-corner.html') {
        serveFile(res, path.join(__dirname, 'ceo-corner.html'), 'text/html', req);
        return;
    }

    // n8n Workflows page
    if (pathname === '/n8n-workflows' || pathname === '/n8n-workflows.html') {
        serveFile(res, path.join(__dirname, 'n8n-workflows.html'), 'text/html', req);
        return;
    }

    // Vision Operating System page
    if (pathname === '/vision' || pathname === '/vision.html') {
        serveFile(res, path.join(__dirname, 'vision.html'), 'text/html', req);
        return;
    }
    if (pathname === '/architecture' || pathname === '/architecture.html') {
        serveFile(res, path.join(__dirname, 'architecture.html'), 'text/html', req);
        return;
    }
    if (pathname === '/dataflow' || pathname === '/dataflow.html') {
        serveFile(res, path.join(__dirname, 'dataflow.html'), 'text/html', req);
        return;
    }
    if (pathname === '/n8n-map' || pathname === '/n8n-map.html') {
        serveFile(res, path.join(__dirname, 'n8n-map.html'), 'text/html', req);
        return;
    }

    // Daily Briefing page
    if (pathname === '/daily-briefing' || pathname === '/daily-briefing.html') {
        serveFile(res, path.join(__dirname, 'daily-briefing.html'), 'text/html', req);
        return;
    }

    // Vision Pulse API — serves vision-pulse-data.json
    if (pathname === '/api/vision-pulse') {
        const vpFile = path.join(__dirname, 'vision-pulse-data.json');
        fs.readFile(vpFile, 'utf8', (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to read vision-pulse-data.json' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(content);
        });
        return;
    }

    // Vision Context API — parses VISION_OBJECTIVES.md into structured JSON
    if (pathname === '/api/vision-context') {
        const voFile = path.join(process.env.HOME, 'openclaw/shared/VISION_OBJECTIVES.md');
        fs.readFile(voFile, 'utf8', (err, md) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to read VISION_OBJECTIVES.md' }));
                return;
            }
            try {
                const ctx = {};
                // Extract sections by heading
                const chiefMatch = md.match(/## Chief Aim\n([\s\S]*?)(?=\n## )/);
                ctx.chiefAim = chiefMatch ? chiefMatch[1].trim() : '';
                const visionMatch = md.match(/## 2026 Vision\n([\s\S]*?)(?=\n## )/);
                ctx.vision = visionMatch ? visionMatch[1].trim() : '';
                const missionMatch = md.match(/## Mission\n([\s\S]*?)(?=\n## )/);
                ctx.mission = missionMatch ? missionMatch[1].trim() : '';
                const valuesMatch = md.match(/## Core Values\n([\s\S]*?)(?=\n---)/);
                ctx.values = valuesMatch ? valuesMatch[1].trim().split('\n').filter(l => l.startsWith('- ')).map(l => l.replace(/^- /, '')) : [];
                // Parse objectives
                ctx.objectives = [];
                const soBlocks = md.match(/### SO\d+:[\s\S]*?(?=\n### |\n---)/g) || [];
                for (const block of soBlocks) {
                    const nameMatch = block.match(/### (SO\d+: .+)/);
                    const descMatch = block.match(/\*\*Description\*\*: (.+)/);
                    const kpiMatch = block.match(/\*\*KPI\*\*: (.+)/);
                    const targetMatch = block.match(/\*\*Near-term target\*\*: (.+)/);
                    const ownerMatch = block.match(/\*\*Owner\*\*: (.+)/);
                    const freeMatch = block.match(/\*\*Freedom Bar\*\*: (.+)/);
                    const methodMatch = block.match(/\*\*Method\*\*: (.+)/);
                    ctx.objectives.push({
                        name: nameMatch ? nameMatch[1] : '',
                        description: descMatch ? descMatch[1] : '',
                        kpi: kpiMatch ? kpiMatch[1] : '',
                        target: targetMatch ? targetMatch[1] : '',
                        freedomBar: freeMatch ? freeMatch[1] : '',
                        method: methodMatch ? methodMatch[1] : '',
                        owner: ownerMatch ? ownerMatch[1] : ''
                    });
                }
                // Parse milestones
                ctx.milestones = [];
                const msMatch = md.match(/## Income Milestones[\s\S]*?(?=\n## )/);
                if (msMatch) {
                    const lines = msMatch[0].split('\n');
                    for (const line of lines) {
                        if (line.startsWith('|') && !line.includes('---') && !line.includes('Milestone')) {
                            const cols = line.split('|').map(c => c.trim()).filter(Boolean);
                            if (cols.length >= 3) {
                                ctx.milestones.push({ name: cols[0], income: cols[1], meaning: cols[2] });
                            }
                        }
                    }
                }
                // Parse wealth pyramid
                const pyrMatch = md.match(/## Wealth Pyramid[\s\S]*?(?=\n## )/);
                ctx.wealthPyramid = [];
                if (pyrMatch) {
                    const levels = pyrMatch[0].match(/\d+\. \*\*.+?\*\*.+/g) || [];
                    for (const l of levels) {
                        const m = l.match(/\d+\. \*\*(.+?)\*\*.*?: (.+)/);
                        if (m) ctx.wealthPyramid.push({ level: m[1], description: m[2] });
                    }
                }
                // Five levers
                const levMatch = md.match(/## Five Levers[\s\S]*/);
                ctx.fiveLevers = [];
                if (levMatch) {
                    const items = levMatch[0].match(/\d+\. .+/g) || [];
                    ctx.fiveLevers = items.map(i => i.replace(/^\d+\. /, ''));
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(ctx, null, 2));
            } catch (parseErr) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to parse VISION_OBJECTIVES.md', detail: parseErr.message }));
            }
        });
        return;
    }

    // Serve static assets
    if (pathname.startsWith('/assets/') || pathname.endsWith('.js') || pathname.endsWith('.css')) {
        const filePath = path.join(__dirname, pathname);
        const ext = path.extname(filePath);
        serveFile(res, filePath, mimeTypes[ext] || 'application/octet-stream', req);
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
            cachedResponse(req, res, 30000, getServices);  // 30s cache
            break;
        case '/mc/crons':
            cachedResponse(req, res, 60000, getCrons);     // 60s cache
            break;
        case '/mc/launchd':
            getLaunchd(req, res);
            break;
        case '/mc/tunnel-status':
            getTunnelStatus(req, res);
            break;
        case '/mc/old-vps-status':
            getOldVpsStatus(req, res);
            break;
        case '/mc/site-health':
            getSiteHealth(req, res);
            break;
        case '/mc/contabo-vps-status':
            getContaboVpsStatus(req, res);
            break;
        case '/mc/daemon-health':
            getDaemonHealth(req, res);
            break;
        case '/mc/ops-board':
            getOpsBoard(req, res);
            break;
        case '/mc/night-mode':
            if (req.method === 'POST' || req.method === 'GET') {
                const nmAction = parsedUrl.query.action || 'start';
                const nmScript = nmAction === 'stop'
                    ? path.join(process.env.HOME, 'openclaw/bin/night_mode_stop.sh')
                    : path.join(process.env.HOME, 'openclaw/bin/night_mode_start.sh');
                const { execFile } = require('child_process');
                execFile('bash', [nmScript], { timeout: 30000 }, (err, stdout, stderr) => {
                    const nmState = JSON.parse(fs.readFileSync(path.join(process.env.HOME, 'openclaw/shared/night_mode.json'), 'utf8') || '{}');
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ ok: true, action: nmAction, nightMode: nmState }));
                });
            } else {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Method not allowed' }));
            }
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
        case '/mc/migration':
            getMigrationStatus(req, res);
            break;
        case '/mc/brain-run':
            exec('launchctl start ai.dwe.brain-trainer', { timeout: 10000 }, (err) => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: !err, error: err ? err.message : null }));
            });
            break;
        case '/mc/brain-restart':
            exec(`launchctl kickstart -k gui/${process.getuid()}/ai.dwe.brain-trainer`, { timeout: 10000 }, (err) => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: !err, error: err ? err.message : null }));
            });
            break;
        case '/mc/gateway-restart':
            exec(`launchctl kickstart -k gui/${process.getuid()}/ai.openclaw.gateway`, { timeout: 10000 }, (err) => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: !err, error: err ? err.message : null }));
            });
            break;
        case '/mc/open-terminal':
            exec('open -a Terminal', { timeout: 5000 }, (err) => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: !err }));
            });
            break;
        case '/mc/open-settings':
            exec('open "x-apple.systempreferences:"', { timeout: 5000 }, (err) => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: !err }));
            });
            break;
        case '/mc/newsletters':
            runNewsletterDigest(req, res, parsedUrl.query);
            break;
        case '/mc/newsletters/refresh':
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            refreshNewsletterCache();
            res.end(JSON.stringify({ ok: true, message: 'Newsletter refresh started' }));
            break;
        case '/mc/messages':
            getScreenedMessages(req, res);
            break;
        case '/mc/messages/refresh':
            messagesCache.timestamp = 0;
            getScreenedMessages(req, res);
            break;
        case '/mc/messages/archive':
            archiveGmailMessage(req, res, parsedUrl.query);
            break;
        case '/mc/messages/invalidate':
            messagesCache.timestamp = 0;
            res.end('{"ok":true}');
            break;
        case '/mc/gmail-interest':
            getGmailInterest(req, res);
            break;
        case '/mc/messages/label':
            labelGmailMessage(req, res, parsedUrl.query);
            break;
        case '/mc/skool-digest':
            runSkoolDigest(req, res, parsedUrl.query);
            break;
        case '/mc/skool-scrape':
            handleSkoolScrape(req, res);
            break;
        case '/mc/skool-config':
            handleSkoolConfig(req, res);
            break;
        case '/mc/skool-auth':
            handleSkoolAuth(req, res);
            break;
        case '/mc/gmail-archive':
            archiveGmailMessage(req, res, parsedUrl.query);
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
        case '/mc/local-traffic':
            getLocalTraffic(req, res);
            break;
        case '/mc/openrouter-credits':
            getOpenRouterCredits(req, res);
            break;
        case '/mc/teamorouter-credits':
            getTeamoRouterCredits(req, res);
            break;
        case '/mc/digitalocean-status':
            getDigitalOceanStatus(req, res);
            break;
        case '/mc/tailscale':
            getTailscaleStatus(req, res);
            break;
        case '/mc/n8n-uptime':
            cachedResponse(req, res, 60000, getN8nUptime);  // 60s cache (VPS ping is slow)
            break;
        case '/mc/ssh-tunnels':
            getSshTunnels(req, res);
            break;
        case '/mc/mesh-status':
            cachedResponse(req, res, 30000, getMeshStatus);  // 30s cache
            break;
        case '/mc/system-optimize':
            if (req.method === 'POST') {
                const { exec: execOpt } = require('child_process');
                execOpt('/Users/elf-6/openclaw/bin/system_optimize.sh', { timeout: 60000 }, (err, stdout, stderr) => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    try {
                        const lines = stdout.split('\n');
                        const marker = lines.findIndex(l => l.includes('###OPTIMIZE_RESULT###'));
                        const jsonLine = marker >= 0 ? lines[marker + 1] : lines[lines.length - 1];
                        const result = JSON.parse(jsonLine.trim());
                        res.end(JSON.stringify(result));
                    } catch(e) {
                        res.end(JSON.stringify({ ok: false, error: err ? err.message : 'parse error', raw: stdout }));
                    }
                });
            } else {
                res.writeHead(405); res.end(JSON.stringify({ error: 'POST only' }));
            }
            break;
        case '/mc/vps-optimize':
            if (req.method === 'POST') {
                const { exec: execVps } = require('child_process');
                const vpsScript = path.join(__dirname, 'vps_optimize.sh');
                execVps(`bash "${vpsScript}"`, { timeout: 30000, env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin' } }, (err, stdout, stderr) => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    try {
                        const lines = stdout.trim().split('\n');
                        const jsonLine = lines[lines.length - 1];
                        const result = JSON.parse(jsonLine);
                        res.end(JSON.stringify(result));
                    } catch(e) {
                        res.end(JSON.stringify({ ok: false, error: err ? err.message : 'parse error', raw: stdout.slice(0, 300) }));
                    }
                });
            } else {
                res.writeHead(405); res.end(JSON.stringify({ error: 'POST only' }));
            }
            break;
        case '/mc/n8n-workflows':
            getN8nWorkflows(req, res);
            break;
        case '/mc/sidney-devices':
            getSidneyDevices(req, res);
            break;
        case '/mc/notion-tasks':
            getNotionTasks(req, res);
            break;
        case '/mc/notion-tasks/create':
            handleCreateTask(req, res);
            break;
        case '/mc/briefing-tasks':
            handleBriefingTasks(req, res);
            break;
        case '/mc/briefing-tasks/run':
            handleBriefingTasksRun(req, res, parsedUrl.query);
            break;
        case '/mc/command-briefing':
            getCommandBriefing(req, res);
            break;
        case '/mc/heartbeat':
            getHeartbeats(req, res);
            break;
        case '/mc/delegation-stats':
            getDelegationStats(req, res);
            break;
        case '/mc/recurring-tasks':
            getRecurringTaskStats(req, res);
            break;
        case '/mc/sprint':
            handleSprint(req, res);
            break;
        case '/mc/sprint-history':
            handleSprintHistory(req, res);
            break;
        case '/mc/sprint-retro':
            handleSprintRetro(req, res);
            break;
        case '/mc/ops-log':
            handleOpsLog(req, res);
            break;
        case '/mc/cso':
            getCSoPipeline(req, res);
            break;
        case '/mc/opp33-funnel':
            getOpp33Funnel(req, res);
            break;
        case '/mc/opp-pipeline':
            getOppPipeline(req, res);
            break;
        case '/mc/n8n-wf-status':
            getN8nWfStatus(req, res);
            break;
        case '/mc/financial':
            getFinancialPulse(req, res);
            break;
        case '/mc/agent-tasks':
            cachedResponse(req, res, 120000, getAgentTasks);  // 2min cache (Notion API is slow ~19s)
            break;
        case '/mc/acp':
            cachedResponse(req, res, 30000, getAgentSessions);  // 30s cache (OpenClaw session read is slow)
            break;
        case '/mc/agent-model':
            if (req.method === 'POST') {
                setAgentModel(req, res);
            } else if (req.method === 'GET') {
                getAgentModels(req, res);
            } else {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Method not allowed' }));
            }
            break;
        case '/mc/income-ops':
            cachedResponse(req, res, 60000, getIncomeOps);  // 60s cache (Google Sheets fetch)
            break;
        case '/mc/change-log':
            getChangeLog(req, res);
            break;
        case '/mc/ceo-corner/drills':
            getCeoCornerDrills(req, res);
            break;
        case '/mc/ceo-corner/review':
            getCeoCornerReview(req, res);
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
        case '/mc/swarm-review':
            runSwarmReview(req, res);
            break;
        case '/mc/swarm-status':
            getSwarmStatus(req, res);
            break;
        case '/dwe/status':
            cachedResponse(req, res, 120000, handleDWEStatus);  // 2min cache (Notion API ~3.6s)
            break;
        case '/dwe':
        case '/dwe/':
        case '/dwe/widget':
            serveFile(res, path.join(__dirname, 'dwe-widget.html'), 'text/html', req);
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
        case '/mc/wf2-config':
            handleWF2Config(req, res);
            break;
        case '/mc/pipeline-products':
            getPipelineProducts(req, res);
            break;
        case '/mc/graduate-product':
            handleGraduateProduct(req, res);
            break;
        case '/mc/mqt-price':
            getMqtPrice(req, res);
            break;
        case '/mc/mqt-paper':
            getMqtPaperTrading(req, res);
            break;
        case '/mc/smi-paper':
            getSmiPaperTrading(req, res);
            break;
        case '/mc/trading-comparison':
            getTradingComparison(req, res);
            break;
        case '/mc/prospects':
            getProspects(req, res, parsedUrl.query);
            break;
        case '/mc/prospects/add':
            addProspect(req, res, parsedUrl.query);
            break;
        case '/mc/prospects/update':
            updateProspect(req, res, parsedUrl.query);
            break;
        case '/mc/prospects/stats':
            getProspectStats(req, res, parsedUrl.query);
            break;
        case '/mc/pipelines':
            listPipelines(req, res);
            break;
        case '/mc/logs/audit':
            servePipelineLog(res, 'audit_runner.log');
            break;
        case '/mc/logs/outreach':
            servePipelineLog(res, 'outreach_sender.log');
            break;
        case '/mc/config':
            servePipelineConfig(res, parsedUrl.query);
            break;
        case '/mc/audit-reports':
            serveAuditReportsList(res, parsedUrl.query);
            break;
        case '/mc/outreach-drafts':
            serveOutreachDrafts(res, parsedUrl.query);
            break;
        case '/mc/outreach-queue':
            getOutreachQueue(req, res, parsedUrl.query);
            break;
        case '/mc/jarvis-stats':
            getJarvisStats(req, res);
            break;
        case '/mc/jarvis-log':
            logJarvisDelegation(req, res);
            break;
        case '/mc/pipeline-stage-run':
            runPipelineStage(req, res, parsedUrl.query);
            break;
        case '/mc/pipeline-stage-log':
            servePipelineStageLog(req, res, parsedUrl.query);
            break;
        case '/mc/outreach-approve':
            approveOutreachEmail(req, res);
            break;
        case '/mc/outreach-skip':
            skipOutreachEmail(req, res);
            break;
        case '/mc/prompt/audit':
            servePipelinePrompt(res, parsedUrl.query, 'audit_prompt.md', 'Audit Prompt');
            break;
        case '/mc/prompt/outreach':
            servePipelinePrompt(res, parsedUrl.query, 'outreach_prompt.md', 'Outreach Prompt');
            break;
        case '/mc/content-intel':
            handleContentIntel(req, res);
            break;
        case '/mc/smart-money-intel':
            try {
                const intelPath = path.join(require('os').homedir(), 'openclaw/shared/intel/latest_signals.json');
                const data = fs.readFileSync(intelPath, 'utf8');
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(data);
            } catch(e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No intel data available', top_signals: [] }));
            }
            break;
        case '/mc/content-intel/ceo-brief':
            handleCeoIntelBrief(req, res);
            break;
        case '/mc/yt-intel/ingest':
            ytIntel.handleYtIntelIngest(req, res);
            break;
        case '/mc/ga4':
            try {
                const ga4Data = JSON.parse(fs.readFileSync(path.join(__dirname, 'ga4_cache.json'), 'utf8'));
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(ga4Data));
            } catch(e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No GA4 data cached yet', thisWeek: {}, lastWeek: {}, deltas: {} }));
            }
            break;
        case '/mc/gbp':
            try {
                const gbpData = JSON.parse(fs.readFileSync(path.join(__dirname, 'gbp_cache.json'), 'utf8'));
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(gbpData));
            } catch(e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No GBP data cached yet', status: 'unknown' }));
            }
            break;
        case '/mc/sheets-writeback':
            (async () => {
                try {
                    let body = '';
                    req.on('data', d => body += d);
                    req.on('end', async () => {
                        try {
                            const { website, espocrm_id, espocrm_status } = JSON.parse(body);
                            if (!website || !espocrm_id) {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Missing website or espocrm_id' }));
                                return;
                            }

                            const crypto = require('crypto');
                            const https = require('https');

                            // Load SA key
                            const saPath = '/Users/elf-6/.openclaw/credentials/ga4-service-account.json';
                            const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));

                            // Generate JWT for Sheets scope
                            const now = Math.floor(Date.now() / 1000);
                            const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
                            const payload = Buffer.from(JSON.stringify({
                                iss: sa.client_email,
                                scope: 'https://www.googleapis.com/auth/spreadsheets',
                                aud: 'https://oauth2.googleapis.com/token',
                                exp: now + 3600,
                                iat: now
                            })).toString('base64url');
                            const sigInput = `${header}.${payload}`;
                            const sign = crypto.createSign('RSA-SHA256');
                            sign.update(sigInput);
                            const sig = sign.sign(sa.private_key, 'base64url');
                            const jwt = `${sigInput}.${sig}`;

                            // Exchange for access token
                            const tokenBody = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
                            const tokenData = await new Promise((resolve, reject) => {
                                const tr = https.request({
                                    hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
                                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                                }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve(JSON.parse(b))); });
                                tr.on('error', reject);
                                tr.write(tokenBody);
                                tr.end();
                            });

                            if (!tokenData.access_token) {
                                res.writeHead(500, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Token exchange failed', detail: tokenData.error_description || tokenData.error }));
                                return;
                            }

                            const token = tokenData.access_token;
                            const SHEET_ID = '1nkhSpjxS11rWC2MPP40GLYvA7LYsaFba91hC5mWpi80';

                            // Find the row with matching website
                            const sheetData = await new Promise((resolve, reject) => {
                                const r = https.request({
                                    hostname: 'sheets.googleapis.com',
                                    path: `/v4/spreadsheets/${SHEET_ID}/values/Prospect_DWE_Marketing!A:Z`,
                                    headers: { Authorization: `Bearer ${token}` }
                                }, resp => { let b = ''; resp.on('data', d => b += d); resp.on('end', () => resolve(JSON.parse(b))); });
                                r.on('error', reject);
                                r.end();
                            });

                            if (sheetData.error) {
                                res.writeHead(403, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Sheet access denied — share sheet with ' + sa.client_email, detail: sheetData.error.message }));
                                return;
                            }

                            const rows = sheetData.values || [];
                            const headers = rows[0] || [];
                            const websiteCol = headers.findIndex(h => h.toLowerCase().includes('website'));
                            const espoCrmIdCol = headers.findIndex(h => h.toLowerCase().includes('espocrm_id') || h.toLowerCase().includes('crm_id'));
                            const statusCol = headers.findIndex(h => h.toLowerCase().includes('crm_status') || h.toLowerCase() === 'status');

                            if (websiteCol === -1) {
                                res.writeHead(500, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Website column not found', headers }));
                                return;
                            }

                            // Find matching row
                            let rowIdx = -1;
                            for (let i = 1; i < rows.length; i++) {
                                if ((rows[i][websiteCol] || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '') ===
                                    website.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')) {
                                    rowIdx = i + 1; // 1-indexed
                                    break;
                                }
                            }

                            if (rowIdx === -1) {
                                res.writeHead(404, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Row not found for website: ' + website }));
                                return;
                            }

                            // Determine the espocrm_id column — use col T (index 19) if not found
                            const writeCol = espoCrmIdCol !== -1 ? espoCrmIdCol : 19; // Column T
                            const colLetter = String.fromCharCode(65 + writeCol);
                            const range = `Prospect_DWE_Marketing!${colLetter}${rowIdx}`;

                            const updateBody = JSON.stringify({ values: [[espocrm_id]] });
                            await new Promise((resolve, reject) => {
                                const r = https.request({
                                    hostname: 'sheets.googleapis.com',
                                    path: `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
                                    method: 'PUT',
                                    headers: {
                                        Authorization: `Bearer ${token}`,
                                        'Content-Type': 'application/json',
                                        'Content-Length': Buffer.byteLength(updateBody)
                                    }
                                }, resp => { let b = ''; resp.on('data', d => b += d); resp.on('end', () => resolve(JSON.parse(b))); });
                                r.on('error', reject);
                                r.write(updateBody);
                                r.end();
                            });

                            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                            res.end(JSON.stringify({ ok: true, row: rowIdx, col: colLetter, espocrm_id }));
                        } catch(e) {
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: e.message }));
                        }
                    });
                } catch(e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Write-back failed' }));
                }
            })();
            return;

        case '/mc/sheets-read-prospects':
            (async () => {
                try {
                    const https = require('https');
                    const envFile = fs.readFileSync(`${process.env.HOME}/.openclaw/.env`, 'utf8');
                    const matonKey = envFile.match(/MATON_API_KEY=["']?([^"'\n]+)/)?.[1]?.trim();
                    if (!matonKey) throw new Error('MATON_API_KEY not found in .env');
                    const SHEET_ID = '1nkhSpjxS11rWC2MPP40GLYvA7LYsaFba91hC5mWpi80';
                    const range = encodeURIComponent('Prospect_DWE_Marketing!A:Z');
                    const sheetData = await new Promise((resolve, reject) => {
                        const r = https.request({
                            hostname: 'gateway.maton.ai',
                            path: `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/${range}`,
                            headers: { Authorization: `Bearer ${matonKey}` }
                        }, resp => { let b = ''; resp.on('data', d => b += d); resp.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { reject(e); } }); });
                        r.on('error', reject); r.end();
                    });
                    if (sheetData.error) {
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Sheet access denied', detail: sheetData.error.message }));
                        return;
                    }
                    const rows = sheetData.values || [];
                    const headers = rows[0] || [];
                    const records = rows.slice(1).map(row => {
                        const obj = {};
                        headers.forEach((h, i) => { obj[h] = row[i] || ''; });
                        return obj;
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify(records));
                } catch(e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            })();
            return;

        case '/mc/seed-crm-lead':
            (async () => {
                try {
                    let body = '';
                    req.on('data', d => body += d);
                    req.on('end', () => {
                        try {
                            const lead = JSON.parse(body);
                            const id = (lead.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
                            if (!id) {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Missing lead id' }));
                                return;
                            }
                            const seedDir = '/Users/elf-6/openclaw/shared/4_Ready_to_Seed';
                            const seedFile = path.join(seedDir, `crm_lead_${id}.md`);
                            const content = [
                                `# CRM Lead: ${lead.accountName || lead.name || 'Unknown'}`,
                                ``,
                                `**ID:** ${id}`,
                                `**Status:** ${lead.status || 'New'}`,
                                `**Website:** ${lead.website || 'N/A'}`,
                                `**Score:** ${lead.cScore || 0}`,
                                `**Email Sent:** ${lead.cEmailSent ? 'Yes' : 'No'}`,
                                `**Email Replied:** ${lead.cEmailReplied ? 'Yes' : 'No'}`,
                                ``,
                                `## SEO Audit`,
                                lead.cSeoAudit || 'No audit data yet.',
                                ``,
                                `## AISO Audit`,
                                lead.cAisoAudit || 'No AISO data yet.',
                                ``,
                                `**CRM URL:** https://crm.tvcpulse.com/#Lead/view/${id}`,
                                `**Seeded:** ${new Date().toISOString()}`
                            ].join('\n');
                            fs.writeFileSync(seedFile, content, 'utf8');
                            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                            res.end(JSON.stringify({ ok: true, file: seedFile }));
                        } catch(e) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: e.message }));
                        }
                    });
                } catch(e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Seed failed' }));
                }
            })();
            return;

        case '/mc/crm':
            (async () => {
                try {
                    const crmCacheFile = path.join(__dirname, 'crm_cache.json');
                    const crmCacheMaxAge = 5 * 60 * 1000; // 5 minutes
                    let crmData = null;
                    try {
                        const stat = fs.statSync(crmCacheFile);
                        if (Date.now() - stat.mtimeMs < crmCacheMaxAge) {
                            crmData = JSON.parse(fs.readFileSync(crmCacheFile, 'utf8'));
                        }
                    } catch(e) {}

                    if (!crmData) {
                        const https = require('https');
                        const fetchEspo = (ePath) => new Promise((resolve, reject) => {
                            const opts = {
                                hostname: 'crm.tvcpulse.com',
                                path: ePath,
                                method: 'GET',
                                headers: { 'X-Api-Key': '25ddaa8471b6b4497a559dea4d2f664b' }
                            };
                            const req2 = https.request(opts, (r) => {
                                let body = '';
                                r.on('data', d => body += d);
                                r.on('end', () => {
                                    try { resolve(JSON.parse(body)); }
                                    catch(e) { resolve({}); }
                                });
                            });
                            req2.on('error', () => resolve({}));
                            req2.end();
                        });

                        const today = new Date().toISOString().slice(0, 10);
                        const allLeads = await fetchEspo('/api/v1/Lead?select=status,cScore,cEmailSent,cEmailReplied,createdAt&maxSize=1000');

                        const leads = allLeads.list || [];
                        const counts = { New: 0, 'In Process': 0, Converted: 0, Dead: 0, Recycled: 0 };
                        let convertedScore = 0, deadScore = 0, convertedCount = 0, deadCount = 0, repliedCount = 0, sentCount = 0, todayNew = 0;

                        for (const l of leads) {
                            const s = l.status || 'New';
                            if (counts[s] !== undefined) counts[s]++;
                            if (l.createdAt && l.createdAt.startsWith(today)) todayNew++;
                            if (s === 'Converted') { convertedScore += (l.cScore || 0); convertedCount++; }
                            if (s === 'Dead') { deadScore += (l.cScore || 0); deadCount++; }
                            if (l.cEmailReplied) repliedCount++;
                            if (l.cEmailSent) sentCount++;
                        }

                        const replyRate = sentCount > 0 ? Math.round((repliedCount / sentCount) * 100) : 0;
                        const avgConverted = convertedCount > 0 ? Math.round(convertedScore / convertedCount) : 0;
                        const avgDead = deadCount > 0 ? Math.round(deadScore / deadCount) : 0;
                        const pipelineValue = counts['In Process'] * 149 + counts.Converted * 449;

                        crmData = {
                            total: allLeads.total || leads.length,
                            todayNew,
                            counts,
                            replyRate,
                            avgScoreConverted: avgConverted,
                            avgScoreDead: avgDead,
                            pipelineValue,
                            updatedAt: new Date().toISOString()
                        };
                        fs.writeFileSync(crmCacheFile, JSON.stringify(crmData));
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify(crmData));
                } catch(e) {
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'CRM data unavailable', total: 0, counts: {}, replyRate: 0 }));
                }
            })();
            return;
        case '/mc/night-mode':
            handleNightMode(req, res);
            break;
        case '/mc/drill/inject':
            handleDrillInject(req, res);
            break;
        case '/mc/drill/status':
            handleDrillStatus(req, res);
            break;
        case '/mc/ceo-corner/drills-real':
            getCeoCornerDrillsReal(req, res);
            break;
        case '/mc/cashflow':
            handleCashflow(req, res);
            break;
        case '/mc/meeting-status': {
            // GET: return current meeting mute state
            const msStatePath = path.join(process.env.HOME, 'openclaw/shared/meeting_mute_state.json');
            try {
                const msData = JSON.parse(fs.readFileSync(msStatePath, 'utf8'));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(msData));
            } catch(e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ muted: false, error: 'no state file' }));
            }
            break;
        }
        case '/mc/meeting-unmute': {
            // POST: manually unmute system audio
            const { execSync: msUnmute } = require('child_process');
            const msUStatePath = path.join(process.env.HOME, 'openclaw/shared/meeting_mute_state.json');
            try {
                msUnmute('osascript -e "set volume without output muted"');
                const msState = JSON.parse(fs.readFileSync(msUStatePath, 'utf8'));
                msState.muted = false;
                msState.unmuted_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
                msState.unmute_reason = 'manual';
                fs.writeFileSync(msUStatePath, JSON.stringify(msState, null, 2));
                console.log('[Meeting] MANUAL UNMUTE');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, action: 'unmuted', reason: 'manual' }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
            break;
        }
        // ── Jake Email Dashboard ──────────────────────────────────────────
        case '/mc/jake-inbox':
            getJakeInbox(req, res);
            break;
        // ── Proposal & Deal Management endpoints ────────────────────────
        case '/mc/proposal-queue':
            getProposalQueue(req, res);
            break;
        case '/mc/proposal-approve':
            approveProposal(req, res);
            break;
        case '/mc/proposal-reject':
            rejectProposal(req, res);
            break;
        case '/mc/deals':
            getDeals(req, res);
            break;
        case '/mc/deals/update':
            updateDeal(req, res);
            break;
        case '/mc/crm-stats':
            getCrmStats(req, res);
            break;
        case '/mc/crm':
            getCrmRecord(req, res, parsedUrl.query);
            break;
        case '/mc/pipeline-summary':
            getPipelineSummary(req, res);
            break;
        case '/mc/autoresearch':
            getAutoresearchStatus(req, res);
            break;
        case '/mc/audit-clicks':
            getAuditClicks(req, res);
            break;
        case '/mc/track-click':
            trackButtonClick(req, res);
            break;
        case '/mc/click-stats':
            getClickStats(req, res);
            break;
        case '/mc/intel-signals':
            getIntelSignals(req, res);
            break;
        case '/mc/batch': {
            // Batch endpoint: runs multiple mc/* calls in parallel, returns one JSON blob.
            // Cuts initial dashboard load from ~84 HTTP round-trips to 1.
            const batchFetch = (endpoint) => new Promise((resolve) => {
                const bReq = http.get(`http://127.0.0.1:${PORT}${endpoint}`, (bRes) => {
                    let raw = '';
                    bRes.on('data', c => raw += c);
                    bRes.on('end', () => {
                        try { resolve({ k: endpoint, v: JSON.parse(raw) }); }
                        catch(e) { resolve({ k: endpoint, v: null }); }
                    });
                });
                bReq.on('error', () => resolve({ k: endpoint, v: null }));
                bReq.setTimeout(8000, () => { bReq.destroy(); resolve({ k: endpoint, v: null }); });
            });
            // Excluded (too slow for batch — load lazily after paint):
            //   /mc/agent-tasks ~19s (Notion API)
            //   /mc/acp          ~9s (OpenClaw session files)
            //   /mc/crons        ~5s (launchctl list)
            //   /mc/n8n-uptime   ~5s (VPS ping)
            //   /mc/services     ~3s (external checks)
            //   /mc/income-ops   ~1s (Google Sheets)
            // All fast endpoints (<500ms) are batched here:
            const BATCH_ENDPOINTS = [
                '/mc/status', '/mc/agents', '/mc/heartbeat',
                '/mc/launchd', '/mc/delegation-stats', '/mc/brain',
                '/mc/system', '/mc/internet', '/mc/sprint', '/mc/cso',
                '/mc/financial', '/mc/n8n-workflows',
                '/mc/jarvis-stats', '/mc/ga4', '/mc/tailscale', '/mc/pipeline',
                '/mc/daemon-health', '/mc/migration',
                '/mc/recurring-tasks', '/mc/openrouter-credits', '/mc/autoresearch',
                '/mc/content-intel', '/mc/openclaw-version', '/mc/sidney-devices',
            ];
            Promise.all(BATCH_ENDPOINTS.map(batchFetch)).then((results) => {
                const out = {};
                results.forEach(r => { out[r.k] = r.v; });
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(out));
            });
            break;
        }
        default:
            // Check for /mc/audit-report/PP-XXXX pattern
            if (pathname.startsWith('/mc/audit-report/')) {
                const leadId = pathname.split('/mc/audit-report/')[1];
                serveAuditReport(res, leadId, parsedUrl.query);
                break;
            }
            // Serve PDF: /mc/audit-pdf/PP-XXXX?pipeline=xxx
            if (pathname.startsWith('/mc/audit-pdf/')) {
                const leadId = pathname.split('/mc/audit-pdf/')[1];
                const pipelineId = (parsedUrl.query && parsedUrl.query.pipeline) || 'dwe-marketing';
                const pdfPath = path.join(AUDITS_DIR, pipelineId, leadId, 'AUDIT-REPORT.pdf');
                if (fs.existsSync(pdfPath)) {
                    const pdfData = fs.readFileSync(pdfPath);
                    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Audit-${leadId}.pdf"` });
                    res.end(pdfData);
                } else {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('PDF not generated yet. Run: node generate-audit-pdf.js ' + pipelineId + ' ' + leadId);
                }
                break;
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
    }
});

// ── Night Mode — start/stop via Alexa → HA → MC ─────────────────────
// ── Jarvis Delegation Stats ──────────────────────────────────────────
const JARVIS_LOG_FILE = path.join(process.env.HOME, 'openclaw/logs/jarvis-delegations.jsonl');
function logJarvisDelegation(req, res) {
    if (req.method !== 'POST') { res.writeHead(405); res.end('POST only'); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
        try {
            const entry = JSON.parse(body);
            entry.logged_at = new Date().toISOString();
            fs.appendFileSync(JARVIS_LOG_FILE, JSON.stringify(entry) + '\n');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    });
}
function getJarvisStats(req, res) {
    try {
        const lines = fs.existsSync(JARVIS_LOG_FILE) ? fs.readFileSync(JARVIS_LOG_FILE, 'utf8').trim().split('\n').filter(Boolean) : [];
        const entries = lines.map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);
        const today = new Date().toISOString().slice(0, 10);
        const thisWeek = entries.filter(e => e.logged_at && e.logged_at >= today.slice(0,8) + '01');
        const todayEntries = entries.filter(e => e.logged_at && e.logged_at.startsWith(today));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            total: entries.length,
            today: todayEntries.length,
            thisMonth: thisWeek.length,
            recent: entries.slice(-5).reverse(),
            byAgent: entries.reduce((acc, e) => { const a = e.source || e.agent || '?'; acc[a] = (acc[a]||0)+1; return acc; }, {})
        }));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
}

function handleNightMode(req, res) {
    const STATE_FILE = path.join(process.env.HOME, 'openclaw/shared/night_mode.json');
    if (req.method === 'GET') {
        try {
            const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(state));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ active: false, error: 'no state file' }));
        }
        return;
    }
    if (req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            let action = 'start';
            try { action = JSON.parse(body).action || 'start'; } catch(e) {}
            const script = action === 'stop'
                ? path.join(process.env.HOME, 'openclaw/bin/night_mode_stop.sh')
                : path.join(process.env.HOME, 'openclaw/bin/night_mode_start.sh');
            const { exec } = require('child_process');
            exec(`bash "${script}"`, { timeout: 30000 }, (err, stdout, stderr) => {
                // Lock screen when starting night mode
                if (action === 'start') {
                    exec('pmset displaysleepnow', () => {});
                }
                const state = fs.existsSync(STATE_FILE)
                    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
                    : { active: action === 'start' };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, action, state, output: stdout.slice(0, 200) }));
            });
        });
        return;
    }
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GET or POST only' }));
}

// ── Drill Inject — POST scenario to inbox, spawn realtime drill ──────
function handleDrillInject(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'POST required' }));
        return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            const scenarioText = data.scenario_text || '';
            const source = data.source || 'dashboard';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
            const inboxDir = path.join(process.env.HOME, 'openclaw/shared/drill_inbox');
            const inboxFile = path.join(inboxDir, `drill_${timestamp}.json`);

            fs.writeFileSync(inboxFile, JSON.stringify({
                source,
                scenario_text: scenarioText,
                submitted_by: 'Sidney',
                submitted_at: new Date().toISOString(),
                type: scenarioText ? 'adhoc' : 'real'
            }, null, 2));

            const { exec } = require('child_process');
            const script = path.join(process.env.HOME, 'openclaw/bin/command_drill_realtime.sh');
            const flag = scenarioText ? '--inbox' : '--auto';
            exec(`bash "${script}" ${flag}`, { timeout: 600000 }, () => {});

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, message: 'Drill queued', type: scenarioText ? 'adhoc' : 'auto-detect' }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
    });
}

// ── Drill Status — check if drill is running ────────────────────────
function handleDrillStatus(req, res) {
    const pidFile = path.join(process.env.HOME, 'openclaw/logs/drill_realtime.pid');
    let running = false;
    if (fs.existsSync(pidFile)) {
        try {
            const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
            process.kill(pid, 0); // Check if process exists
            running = true;
        } catch (e) {
            running = false;
        }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ running }));
}

// ── CEO Corner Drills (Real + Ad-hoc) ───────────────────────────────
function getCeoCornerDrillsReal(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
        let state = {};
        if (fs.existsSync(DRILL_STATE_PATH)) {
            state = JSON.parse(fs.readFileSync(DRILL_STATE_PATH, 'utf8'));
        }

        const mapScores = (arr) => (arr || []).map(s => ({
            date: s.date,
            total: s.score || s.total || 0,
            s1: s.s1 || 0, s2: s.s2 || 0, s3: s.s3 || 0,
            s4: s.s4 || 0, s5: s.s5 || 0, s6: s.s6 || 0,
            type: s.type || 'unknown',
            source: s.source || 'unknown',
            summary: s.scenario_summary || ''
        }));

        const realScores = mapScores(state.real_scores);
        const adhocScores = mapScores(state.adhoc_scores);
        const allScores = [...realScores, ...adhocScores].sort((a, b) => a.date.localeCompare(b.date));

        const latest = allScores.length > 0 ? allScores[allScores.length - 1] : null;
        const avgScore = allScores.length > 0
            ? (allScores.reduce((sum, h) => sum + h.total, 0) / allScores.length).toFixed(1)
            : null;

        res.end(JSON.stringify({
            latest,
            real: realScores,
            adhoc: adhocScores,
            all: allScores,
            totalReal: state.total_real_drills || realScores.length,
            totalAdhoc: state.total_adhoc_drills || adhocScores.length,
            avgScore
        }));
    } catch (e) {
        res.end(JSON.stringify({ latest: null, real: [], adhoc: [], all: [], error: e.message }));
    }
}

// ── WF2 Config — dynamic keywords & subreddits via Google Sheets ─────
function handleWF2Config(req, res) {
    const MATON_KEY = 'vqV4andwInf-ObTAMv_-QZdq9DUBAhMnU2Gw8g5cP2_I5rAoBM4gwvCl1VHWrKUhzN39AW6nRHBtG8eP7dsVBEbIfBwNWcNAa7E';
    const SHEET_ID = '1nkhSpjxS11rWC2MPP40GLYvA7LYsaFba91hC5mWpi80';
    const RANGE = 'WF2_Config!A1:B10';

    if (req.method === 'GET') {
        const opts = {
            hostname: 'gateway.maton.ai',
            path: `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/${RANGE}`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${MATON_KEY}` }
        };
        const apiReq = https.request(opts, (apiRes) => {
            let body = '';
            apiRes.on('data', chunk => body += chunk);
            apiRes.on('end', () => {
                try {
                    const raw = JSON.parse(body);
                    const rows = raw.values || [];
                    const config = {};
                    for (let i = 1; i < rows.length; i++) {
                        if (rows[i][0]) config[rows[i][0]] = rows[i][1] || '';
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
                    res.end(JSON.stringify({
                        ok: true,
                        subreddits: (config.subreddits || '').split(',').map(s => s.trim()).filter(Boolean),
                        keywords: (config.keywords || '').split(',').map(s => s.trim()).filter(Boolean),
                        last_updated: config.last_updated || ''
                    }));
                } catch(e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Parse error: ' + e.message }));
                }
            });
        });
        apiReq.on('error', (e) => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Maton API error: ' + e.message }));
        });
        apiReq.end();

    } else if (req.method === 'POST') {
        let reqBody = '';
        req.on('data', chunk => reqBody += chunk);
        req.on('end', () => {
            try {
                const { subreddits, keywords } = JSON.parse(reqBody);
                const now = new Date().toISOString();
                const payload = JSON.stringify({
                    values: [
                        [subreddits || ''],
                        [keywords || ''],
                        [now]
                    ]
                });
                const opts = {
                    hostname: 'gateway.maton.ai',
                    path: `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/WF2_Config!B2:B4?valueInputOption=RAW`,
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${MATON_KEY}`,
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload)
                    }
                };
                const apiReq = https.request(opts, (apiRes) => {
                    let body = '';
                    apiRes.on('data', chunk => body += chunk);
                    apiRes.on('end', () => {
                        try {
                            const result = JSON.parse(body);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: true, updated: now, cells: result.updatedCells || 0 }));
                        } catch(e) {
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: 'Parse error: ' + e.message }));
                        }
                    });
                });
                apiReq.on('error', (e) => {
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Maton API error: ' + e.message }));
                });
                apiReq.write(payload);
                apiReq.end();
            } catch(e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
    } else {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'GET or POST only' }));
    }
}

// DWE Widget Status Handler
async function handleDWEStatus(req, res) {
    const timeoutMs = 8000;
    const fallback = {
        total: 1214, completed: 973, inProgress: 7, remaining: 234,
        maxIdNumber: 1743, lastUpdated: new Date().toISOString(),
        source: 'cache-fallback'
    };
    try {
        const statsPromise = getDWEStats();
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), timeoutMs));
        const stats = await Promise.race([statsPromise, timeoutPromise]);
        // Cache last good result
        handleDWEStatus._cache = stats;
        handleDWEStatus._cacheTime = Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify(stats));
    } catch (e) {
        // Return cached result if available, otherwise fallback
        const cached = handleDWEStatus._cache || fallback;
        cached.stale = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cached));
    }
}

function serveFile(res, filePath, contentType, req) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        // Static assets: short cache (5s) — browser can revalidate cheaply
        const headers = {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=5'
        };
        if (req) {
            sendCompressed(req, res, 200, headers, data);
        } else {
            res.writeHead(200, headers);
            res.end(data);
        }
    });
}

// ── IncomeOps_Monitor — proxies Google Sheets via Maton ─────────────────
function getIncomeOps(req, res) {
    const MATON_KEY = 'vqV4andwInf-ObTAMv_-QZdq9DUBAhMnU2Gw8g5cP2_I5rAoBM4gwvCl1VHWrKUhzN39AW6nRHBtG8eP7dsVBEbIfBwNWcNAa7E';
    const SHEET_ID = '1nkhSpjxS11rWC2MPP40GLYvA7LYsaFba91hC5mWpi80';
    const apiPath = `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/IncomeOps_Monitor!A1:W50`;

    const opts = {
        hostname: 'gateway.maton.ai',
        path: apiPath,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${MATON_KEY}` }
    };

    const apiReq = https.request(opts, (apiRes) => {
        let body = '';
        apiRes.on('data', chunk => body += chunk);
        apiRes.on('end', () => {
            try {
                const raw = JSON.parse(body);
                const rows = raw.values || [];
                // Row 4 (index 3) is the header row
                const header = rows[3] || [];
                const dataRows = rows.slice(4); // data starts at row 5

                const streams = dataRows.filter(r => r[0] && r[0].trim()).map(r => {
                    const obj = {};
                    header.forEach((col, i) => {
                        const key = col.trim().replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
                        obj[key] = (r[i] || '').trim();
                    });
                    return obj;
                });

                // Fetch hyperlinks from Source Platform column (C5:C50)
                const hlPath = `/google-sheets/v4/spreadsheets/${SHEET_ID}?ranges=IncomeOps_Monitor!C5:C50&fields=sheets.data.rowData.values.hyperlink,sheets.data.rowData.values.formattedValue`;
                const hlOpts = { hostname: 'gateway.maton.ai', path: hlPath, method: 'GET', headers: { 'Authorization': `Bearer ${MATON_KEY}` } };
                const hlReq = https.request(hlOpts, (hlRes) => {
                    let hlBody = '';
                    hlRes.on('data', c => hlBody += c);
                    hlRes.on('end', () => {
                        try {
                            const hlData = JSON.parse(hlBody);
                            const rowData = (hlData.sheets && hlData.sheets[0] && hlData.sheets[0].data && hlData.sheets[0].data[0] && hlData.sheets[0].data[0].rowData) || [];
                            rowData.forEach((rd, i) => {
                                if (i < streams.length && rd.values && rd.values[0] && rd.values[0].hyperlink) {
                                    streams[i].Source_URL = rd.values[0].hyperlink;
                                }
                            });
                        } catch(e) { /* hyperlink fetch failed, continue without */ }

                        finishIncomeOps();
                    });
                });
                hlReq.on('error', () => finishIncomeOps());
                hlReq.end();

                function finishIncomeOps() {
                // Split streams by Income Type
                const cashflowStreams = streams.filter(s => s.Income_Type === 'Cash Flow');
                const longtermStreams = streams.filter(s => s.Income_Type !== 'Cash Flow');

                // Parse dollar values for summing
                const parseDollar = (v) => parseFloat((v || '$0').replace(/[$,]/g, '')) || 0;
                const cashflowMonthly = cashflowStreams.reduce((sum, s) => sum + parseDollar(s['30_Days']), 0);
                const longtermMonthly = longtermStreams.reduce((sum, s) => sum + parseDollar(s['30_Days']), 0);

                // Sort: Cash Flow first, then by 30-day desc
                streams.sort((a, b) => {
                    if (a.Income_Type === 'Cash Flow' && b.Income_Type !== 'Cash Flow') return -1;
                    if (a.Income_Type !== 'Cash Flow' && b.Income_Type === 'Cash Flow') return 1;
                    return parseDollar(b['30_Days']) - parseDollar(a['30_Days']);
                });

                // Summary row (row 1, index 0) has totals in specific columns
                const summaryRow = rows[0] || [];
                const cashflowRow = rows[1] || [];
                const summary = {
                    daily_total: summaryRow[12] || '$0',
                    weekly_total: summaryRow[13] || '$0',
                    monthly_total: summaryRow[14] || '$0',
                    yearly_total: summaryRow[15] || '$0',
                    projected_profit: summaryRow[17] || '$0',
                    staked_total: cashflowRow[7] || '$0'
                };

                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
                res.end(JSON.stringify({
                    ok: true,
                    streams,
                    cashflow_streams: cashflowStreams,
                    longterm_streams: longtermStreams,
                    cashflow_monthly: '$' + cashflowMonthly.toFixed(2),
                    longterm_monthly: '$' + longtermMonthly.toFixed(2),
                    summary,
                    updated: new Date().toISOString()
                }));
                } // end finishIncomeOps
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Parse error: ' + e.message }));
            }
        });
    });

    apiReq.on('error', (e) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Maton API error: ' + e.message }));
    });

    apiReq.end();
}

// ── MQT Price — fetches live MQT price from DexScreener ───────────────
// MQT constants for sheet sync
const MQT_HOLDINGS = 1300;       // total MQT in Golden Hatchery
const MQT_COMPOUND_RATE = 0.0022; // 0.22% daily compound rate
const MQT_CYCLE_DAYS = 210;       // cycle length
const MQT_ORIGINAL_COST = 7850;   // original USD investment

function syncMqtPriceToSheet(price) {
    const MATON_KEY = 'vqV4andwInf-ObTAMv_-QZdq9DUBAhMnU2Gw8g5cP2_I5rAoBM4gwvCl1VHWrKUhzN39AW6nRHBtG8eP7dsVBEbIfBwNWcNAa7E';
    const SHEET_ID = '1nkhSpjxS11rWC2MPP40GLYvA7LYsaFba91hC5mWpi80';

    // Compound interest: MQT earned = holdings * ((1+rate)^days - 1)
    const r = 1 + MQT_COMPOUND_RATE;
    const day1Mqt = MQT_HOLDINGS * MQT_COMPOUND_RATE;
    const day7Mqt = MQT_HOLDINGS * (Math.pow(r, 7) - 1);
    const day30Mqt = MQT_HOLDINGS * (Math.pow(r, 30) - 1);
    const cycleMqt = MQT_HOLDINGS * (Math.pow(r, MQT_CYCLE_DAYS) - 1);
    // 365d = 1 full cycle + 155 days of next cycle (principal resets)
    const day155Mqt = MQT_HOLDINGS * (Math.pow(r, 155) - 1);
    const day365Mqt = cycleMqt + day155Mqt;
    const endBalance = Math.round(MQT_HOLDINGS * Math.pow(r, MQT_CYCLE_DAYS));

    const staked = Math.round(MQT_HOLDINGS * price);
    const daily = '$' + (day1Mqt * price).toFixed(2);
    const weekly = '$' + Math.round(day7Mqt * price);
    const monthly = '$' + Math.round(day30Mqt * price);
    const yearly = '$' + Math.round(day365Mqt * price).toLocaleString();
    const projUnits = endBalance.toLocaleString() + ' MQT';
    const profit = Math.round(staked - MQT_ORIGINAL_COST);
    const cyclEarn = Math.round(cycleMqt * price);
    const priceStr = price.toFixed(2);

    // Batch update: J11 (unit price), H12:R12 (hatchery values), B18:B20 (scenarios)
    const batchBody = JSON.stringify({
        valueInputOption: 'RAW',
        data: [
            { range: 'IncomeOps_Monitor!J11', values: [['$' + priceStr]] },
            { range: 'IncomeOps_Monitor!H12:Q12', values: [[
                '$' + staked.toLocaleString(), '$0', MQT_HOLDINGS + ' MQT', day1Mqt.toFixed(4) + ' MQT', 'Y',
                daily, weekly, monthly, yearly, projUnits
            ]] },
            { range: 'IncomeOps_Monitor!R12', values: [[
                (profit >= 0 ? '$' : '-$') + Math.abs(profit).toLocaleString()
            ]] },
            { range: 'IncomeOps_Monitor!B18:B20', values: [
                ['MQT @ Current ($' + priceStr + ')'],
                ['$' + staked.toLocaleString()],
                ['$' + cyclEarn.toLocaleString()]
            ] }
        ]
    });

    const batchPath = `/google-sheets/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`;
    const opts = {
        hostname: 'gateway.maton.ai', path: batchPath, method: 'POST',
        headers: { 'Authorization': `Bearer ${MATON_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(batchBody) }
    };
    const req = https.request(opts, (apiRes) => {
        let b = ''; apiRes.on('data', c => b += c);
        apiRes.on('end', () => { try { console.log('[MQT] Sheet synced @ $' + priceStr); } catch(e) {} });
    });
    req.on('error', (e) => console.error('[MQT] Sheet sync error:', e.message));
    req.write(batchBody);
    req.end();
}

function getMqtPrice(req, res) {
    const MQT_CONTRACT = '0xef0cdae2FfEEeFA539a244a16b3f46ba75b8c810';
    const apiUrl = `https://api.dexscreener.com/latest/dex/tokens/${MQT_CONTRACT}`;

    https.get(apiUrl, (apiRes) => {
        let body = '';
        apiRes.on('data', chunk => body += chunk);
        apiRes.on('end', () => {
            try {
                const data = JSON.parse(body);
                const pairs = data.pairs || [];
                if (pairs.length === 0) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'No pairs found for MQT' }));
                    return;
                }
                const price = parseFloat(pairs[0].priceUsd) || 0;

                // Auto-sync MQT price to IncomeOps_Monitor sheet
                syncMqtPriceToSheet(price);

                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
                res.end(JSON.stringify({
                    ok: true,
                    price,
                    symbol: 'MQT',
                    source: 'DexScreener',
                    pair: pairs[0].pairAddress,
                    updated: new Date().toISOString()
                }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Parse error: ' + e.message }));
            }
        });
    }).on('error', (e) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'DexScreener API error: ' + e.message }));
    });
}

function getMqtPaperTrading(req, res) {
    const homeDir = require('os').homedir();
    const signalPath = path.join(homeDir, 'openclaw/shared/mqt_latest_signal.json');
    const portfolioPath = path.join(homeDir, 'openclaw/shared/mqt_paper_trading_state.json');
    const tradeLogPath = path.join(homeDir, 'openclaw/shared/mqt_trade_log.json');

    let signal = {}, portfolio = {}, trades = [];
    try { signal = JSON.parse(fs.readFileSync(signalPath, 'utf8')); } catch(e) {}
    try { portfolio = JSON.parse(fs.readFileSync(portfolioPath, 'utf8')); } catch(e) { portfolio = { usdt_balance: 1000, mqt_balance: 0, position: null, total_trades: 0, total_pnl: 0 }; }
    try { trades = JSON.parse(fs.readFileSync(tradeLogPath, 'utf8')); } catch(e) {}

    const price = signal.price || 0;
    const totalQty = portfolio.total_qty || 0;
    const posValue = totalQty * price;
    const totalValue = (portfolio.usdt_balance || 0) + posValue;
    const avgEntry = portfolio.avg_entry_price || 0;
    const gainPct = avgEntry > 0 ? ((price - avgEntry) / avgEntry * 100) : 0;

    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
        ok: true,
        price: price,
        change24h: signal.price_change_24h || 0,
        ma: signal.ma,
        signal: signal.signal || 'HOLD',
        reason: signal.reason || '',
        timestamp: signal.timestamp || '',
        portfolio: {
            usdt: portfolio.usdt_balance || 1000,
            mqt: totalQty,
            totalValue: totalValue,
            pnl: portfolio.total_pnl || 0,
            trades: portfolio.total_trades || 0,
            buys: portfolio.trade_count_buys || 0,
            sells: portfolio.trade_count_sells || 0,
            avgEntry: avgEntry,
            gainPct: gainPct,
            floor: portfolio.floor_price || null,
            trailingActive: portfolio.trailing_active || false,
            ladderTiers: (portfolio.ladder_tiers || []).map(t => ({drop: t.drop_pct, buy: t.buy_pct, triggered: t.triggered})),
            hasPosition: totalQty > 0,
            daysHeld: 0
        },
        recentTrades: (trades || []).slice(-5)
    }));
}

// ── Trading Comparison ────────────────────────────────────────────────
function getTradingComparison(req, res) {
    const snapPath = require('path').join(require('os').homedir(), 'openclaw/shared/trading_comparison_snapshots.json');
    let snapshots = [];
    try { snapshots = JSON.parse(require('fs').readFileSync(snapPath, 'utf8')); } catch(e) {}
    // Current live values from both traders
    const mqtStatePath = require('path').join(require('os').homedir(), 'openclaw/shared/mqt_paper_trading_state.json');
    const mqtSigPath   = require('path').join(require('os').homedir(), 'openclaw/shared/mqt_latest_signal.json');
    const smiStatePath = require('path').join(require('os').homedir(), 'openclaw/shared/smi_paper_trading_state.json');
    let mqtState = {}, mqtSig = {}, smiState = {};
    try { mqtState = JSON.parse(require('fs').readFileSync(mqtStatePath, 'utf8')); } catch(e) {}
    try { mqtSig   = JSON.parse(require('fs').readFileSync(mqtSigPath,   'utf8')); } catch(e) {}
    try { smiState = JSON.parse(require('fs').readFileSync(smiStatePath, 'utf8')); } catch(e) {}
    const mqtPrice    = mqtSig.price || 0;
    const mqtRaw      = (mqtState.usdt_balance || 0) + (mqtState.total_qty || 0) * mqtPrice;
    const mqtOriginal = (mqtState.total_cost || 500) + 500;
    const mqtNorm     = mqtOriginal > 0 ? (mqtRaw / mqtOriginal) * 1000 : mqtRaw;
    const smiTotal    = smiState.portfolio_value || smiState.balance || 1000;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
        ok: true,
        snapshots: snapshots.slice(-30),
        current: {
            mqt: { value: Math.round(mqtNorm * 100) / 100, pnlPct: Math.round(((mqtNorm - 1000) / 1000) * 10000) / 100 },
            smi: { value: Math.round(smiTotal * 100) / 100, pnlPct: Math.round(((smiTotal - 1000) / 1000) * 10000) / 100 },
        },
    }));
}

// ── SMI Paper Trading ─────────────────────────────────────────────────
function getSmiPaperTrading(req, res) {
    const homeDir = require('os').homedir();
    const statePath = path.join(homeDir, 'openclaw/shared/smi_paper_trading_state.json');
    const logPath   = path.join(homeDir, 'openclaw/shared/smi_trade_log.json');
    let state = {}, trades = [];
    try { state  = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch(e) {
        state = { balance: 1000, positions: {}, total_trades: 0, total_pnl: 0, portfolio_value: 1000, start_date: null, end_date: null };
    }
    try { trades = JSON.parse(fs.readFileSync(logPath,   'utf8')); } catch(e) {}
    const startVal   = 1000;
    const totalVal   = state.portfolio_value || state.balance || startVal;
    const pnlPct     = ((totalVal - startVal) / startVal) * 100;
    const startDate  = state.start_date ? new Date(state.start_date) : null;
    const endDate    = state.end_date   ? new Date(state.end_date)   : null;
    const now        = new Date();
    const daysIn     = startDate ? Math.floor((now - startDate) / 86400000) : 0;
    const daysLeft   = endDate   ? Math.max(0, Math.ceil((endDate - now) / 86400000)) : 30;
    const positions  = Object.entries(state.positions || {}).map(([ticker, p]) => ({
        ticker, shares: p.shares, entryPrice: p.entry_price, costBasis: p.cost_basis,
        entryDate: p.entry_date, signalScore: p.signal_score, signalSource: p.signal_source,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
        ok: true,
        balance: state.balance || 0,
        totalValue: totalVal,
        totalPnl: state.total_pnl || 0,
        pnlPct: Math.round(pnlPct * 100) / 100,
        peakValue: state.peak_value || totalVal,
        totalTrades: state.total_trades || 0,
        buys:  state.trade_count_buys  || 0,
        sells: state.trade_count_sells || 0,
        positions,
        daysIn, daysLeft,
        startDate: state.start_date,
        endDate:   state.end_date,
        lastRun:   state.last_run,
        recentTrades: (trades || []).slice(-10).reverse(),
    }));
}

// ── Prospect Pipeline — replicable funnel system ──────────────────────

const PIPELINES_DIR = path.join(require('os').homedir(), 'openclaw/shared/config/pipelines');

function loadPipelineConfig(pipelineId) {
    const configPath = path.join(PIPELINES_DIR, pipelineId || 'dwe-marketing', 'pipeline.json');
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch(e) { return null; }
}

// ── Pipeline Operations Endpoints ────────────────────────────────────

const LOGS_DIR = path.join(require('os').homedir(), 'openclaw/logs');
const AUDITS_DIR = path.join(require('os').homedir(), 'openclaw/shared/audits');

function darkPageWrapper(title, bodyHtml) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | DWE</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',sans-serif;background:#0a0e27;color:#fff;min-height:100vh;padding:1.5rem}
.top-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem}
.top-bar h1{font-size:1.1rem;font-weight:700;background:linear-gradient(135deg,#ff6600,#ffaa00);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.back-link{color:#ffaa00;text-decoration:none;font-size:0.8rem;padding:0.3rem 0.75rem;border:1px solid rgba(255,170,0,0.3);border-radius:8px}
.back-link:hover{background:rgba(255,170,0,0.1)}
.card{background:rgba(20,20,40,0.6);border:1px solid rgba(255,255,255,0.08);border-radius:1rem;padding:1.25rem;backdrop-filter:blur(12px);margin-bottom:1rem}
pre{font-family:'JetBrains Mono',monospace;font-size:0.75rem;line-height:1.6;color:rgba(255,255,255,0.85);white-space:pre-wrap;word-wrap:break-word;overflow-x:auto}
.log-line{padding:0.1rem 0;border-bottom:1px solid rgba(255,255,255,0.03)}
.log-ts{color:#ffaa00}
.log-err{color:#ff4444}
.log-ok{color:#00ff88}
.json-key{color:#00c8ff}
.json-str{color:#00ff88}
.json-num{color:#ffaa00}
.json-bool{color:#b829dd}
h2{font-size:0.85rem;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:1rem}
a.report-link{color:#00c8ff;text-decoration:none;font-size:0.85rem}
a.report-link:hover{text-decoration:underline}
.score-badge{display:inline-block;padding:0.15rem 0.5rem;border-radius:1rem;font-size:0.7rem;font-weight:600;margin-left:0.5rem}
.md-content h1{font-size:1.1rem;color:#ffaa00;margin:1rem 0 0.5rem}
.md-content h2{font-size:0.95rem;color:#00c8ff;margin:1rem 0 0.5rem;text-transform:none;letter-spacing:normal}
.md-content h3{font-size:0.85rem;color:#fff;margin:0.75rem 0 0.4rem}
.md-content p{color:rgba(255,255,255,0.8);font-size:0.8rem;line-height:1.6;margin:0.3rem 0}
.md-content strong{color:#ffaa00}
.md-content li{font-size:0.8rem;color:rgba(255,255,255,0.75);margin:0.2rem 0 0.2rem 1.5rem}
.md-content table{border-collapse:collapse;margin:0.5rem 0}
.md-content th,.md-content td{padding:0.3rem 0.75rem;border:1px solid rgba(255,255,255,0.1);font-size:0.75rem}
.md-content th{color:rgba(255,255,255,0.5);font-weight:500}
.md-content code{font-family:'JetBrains Mono',monospace;background:rgba(255,255,255,0.06);padding:0.1rem 0.3rem;border-radius:4px;font-size:0.75rem}
.draft-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:0.75rem;padding:1rem;margin-bottom:0.75rem}
.draft-to{color:#00c8ff;font-size:0.8rem}
.draft-subject{color:#ffaa00;font-weight:600;font-size:0.85rem;margin:0.25rem 0}
.draft-body{color:rgba(255,255,255,0.7);font-size:0.78rem;line-height:1.5;white-space:pre-wrap;margin-top:0.5rem}
</style></head><body>
<div class="top-bar"><h1>${title}</h1><a href="/funnel" class="back-link">← Funnel</a></div>
${bodyHtml}
</body></html>`;
}

function servePipelineLog(res, logFilename) {
    try {
        const logPath = path.join(LOGS_DIR, logFilename);
        const content = fs.readFileSync(logPath, 'utf8');
        const lines = content.trim().split('\n').slice(-50);
        const formatted = lines.map(line => {
            let cls = 'log-line';
            let html = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            html = html.replace(/\[([\d-]+\s[\d:]+)\]/g, '<span class="log-ts">[$1]</span>');
            if (/ERROR|FAIL/i.test(line)) html = `<span class="log-err">${html}</span>`;
            else if (/complete|Updated|success/i.test(line)) html = `<span class="log-ok">${html}</span>`;
            return `<div class="${cls}">${html}</div>`;
        }).join('');
        const title = logFilename.includes('audit') ? 'Audit Runner Log' : 'Outreach Sender Log';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(darkPageWrapper(title, `<div class="card"><pre>${formatted}</pre></div>`));
    } catch(e) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(darkPageWrapper('Log', '<div class="card"><p style="color:rgba(255,255,255,0.4)">Log file not found or empty.</p></div>'));
    }
}

function servePipelineConfig(res, query) {
    const pipelineId = query.pipeline || 'dwe-marketing';
    const cfg = loadPipelineConfig(pipelineId);
    if (!cfg) { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end(darkPageWrapper('Config', '<div class="card"><p>Pipeline not found.</p></div>')); return; }
    let json = JSON.stringify(cfg, null, 2);
    json = json.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    json = json.replace(/"([^"]+)":/g, '<span class="json-key">"$1"</span>:');
    json = json.replace(/: "([^"]*)"/g, ': <span class="json-str">"$1"</span>');
    json = json.replace(/: (\d+)/g, ': <span class="json-num">$1</span>');
    json = json.replace(/: (true|false)/g, ': <span class="json-bool">$1</span>');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(darkPageWrapper(`Config: ${pipelineId}`, `<div class="card"><pre>${json}</pre></div>`));
}

function simpleMarkdownToHtml(md) {
    let html = md.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^\| (.+) \|$/gm, (match, inner) => {
        const cells = inner.split(' | ').map(c => `<td>${c.trim()}</td>`).join('');
        return `<tr>${cells}</tr>`;
    });
    html = html.replace(/(<tr>.*<\/tr>\n?)+/g, (m) => `<table>${m}</table>`);
    html = html.replace(/^(?!<[hltup])(.*\S.*)$/gm, '<p>$1</p>');
    return html;
}

function serveAuditReport(res, leadId, query) {
    const pipelineId = query.pipeline || 'dwe-marketing';
    const reportPath = path.join(AUDITS_DIR, pipelineId, leadId, 'AUDIT-SUMMARY.md');
    try {
        const md = fs.readFileSync(reportPath, 'utf8');
        const html = simpleMarkdownToHtml(md);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(darkPageWrapper(`Audit: ${leadId}`, `<div class="card md-content">${html}</div>`));
    } catch(e) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end(darkPageWrapper('Audit Report', `<div class="card"><p style="color:rgba(255,255,255,0.4)">No audit report found for ${leadId}.</p></div>`));
    }
}

function serveAuditReportsList(res, query) {
    const pipelineId = query.pipeline || 'dwe-marketing';
    const auditsPath = path.join(AUDITS_DIR, pipelineId);
    try {
        const dirs = fs.readdirSync(auditsPath).filter(d => fs.existsSync(path.join(auditsPath, d, 'AUDIT-SUMMARY.md')));
        if (dirs.length === 0) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(darkPageWrapper('Audit Reports', '<div class="card"><p style="color:rgba(255,255,255,0.4)">No audit reports yet.</p></div>'));
            return;
        }
        let html = '<div class="card"><h2>Audit Reports</h2>';
        html += `<div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;padding:0.5rem 0 0.3rem;border-bottom:1px solid rgba(255,255,255,0.1);">
            <span style="font-size:0.65rem;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.05em;">Business</span>
            <span style="font-size:0.65rem;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.05em;text-align:center;">Score</span>
            <span style="font-size:0.65rem;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.05em;text-align:center;">Markdown</span>
            <span style="font-size:0.65rem;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.05em;text-align:center;">PDF</span>
        </div>`;
        dirs.forEach(d => {
            try {
                const md = fs.readFileSync(path.join(auditsPath, d, 'AUDIT-SUMMARY.md'), 'utf8');
                const titleMatch = md.match(/^# (.+)$/m);
                const scoreMatch = md.match(/\*\*Score:\*\* (\d+)\/100/);
                const gradeMatch = md.match(/Grade: ([A-F][+-]?)\)/);
                const title = titleMatch ? titleMatch[1] : d;
                const score = scoreMatch ? scoreMatch[1] : '?';
                const grade = gradeMatch ? gradeMatch[1] : '?';
                const scoreColor = parseInt(score) >= 70 ? '#00ff88' : parseInt(score) >= 50 ? '#ffaa00' : '#ff4444';
                const hasPdf = fs.existsSync(path.join(auditsPath, d, 'AUDIT-REPORT.pdf'));
                const pdfLink = hasPdf
                    ? `<a href="/mc/audit-pdf/${d}?pipeline=${pipelineId}" target="_blank" style="color:#ffaa00;text-decoration:none;font-size:0.8rem;font-weight:600;">View PDF</a>`
                    : `<span style="color:rgba(255,255,255,0.2);font-size:0.7rem;">Not generated</span>`;
                html += `<div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;padding:0.6rem 0;border-bottom:1px solid rgba(255,255,255,0.06);align-items:center;">
                    <span style="font-size:0.85rem;color:#fff;">${title.replace(/&/g,'&amp;').replace(/</g,'&lt;')} <span style="color:rgba(255,255,255,0.3);font-size:0.7rem;">${d}</span></span>
                    <span style="text-align:center;"><span class="score-badge" style="background:${scoreColor}22;color:${scoreColor}">${score}/100 (${grade})</span></span>
                    <span style="text-align:center;"><a href="/mc/audit-report/${d}?pipeline=${pipelineId}" target="_blank" style="color:#00c8ff;text-decoration:none;font-size:0.8rem;">View MD</a></span>
                    <span style="text-align:center;">${pdfLink}</span>
                </div>`;
            } catch(e) {
                html += `<div style="padding:0.5rem 0;"><a class="report-link" href="/mc/audit-report/${d}?pipeline=${pipelineId}">${d}</a></div>`;
            }
        });
        html += '</div>';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(darkPageWrapper(`Audit Reports: ${pipelineId}`, html));
    } catch(e) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(darkPageWrapper('Audit Reports', '<div class="card"><p style="color:rgba(255,255,255,0.4)">No audits directory found.</p></div>'));
    }
}

function serveOutreachDrafts(res, query) {
    const pipelineId = query.pipeline || 'dwe-marketing';
    const auditsPath = path.join(AUDITS_DIR, pipelineId);
    try {
        const dirs = fs.readdirSync(auditsPath).filter(d => fs.existsSync(path.join(auditsPath, d, 'outreach_draft.txt')));
        if (dirs.length === 0) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(darkPageWrapper('Outreach Drafts', '<div class="card"><p style="color:rgba(255,255,255,0.4)">No outreach drafts yet.</p></div>'));
            return;
        }
        let html = '<div class="card"><h2>Outreach Drafts</h2>';
        dirs.forEach(d => {
            try {
                const draft = fs.readFileSync(path.join(auditsPath, d, 'outreach_draft.txt'), 'utf8');
                const lines = draft.split('\n');
                const to = (lines.find(l => l.startsWith('To:')) || '').replace('To: ', '');
                const subject = (lines.find(l => l.startsWith('Subject:')) || '').replace('Subject: ', '');
                const body = lines.slice(lines.indexOf('') + 1).join('\n').trim();
                html += `<div class="draft-card">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <span style="color:rgba(255,255,255,0.4);font-size:0.7rem;">${d}</span>
                        <span class="draft-to">${to.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</span>
                    </div>
                    <div class="draft-subject">${subject.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>
                    <div class="draft-body">${body.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>
                </div>`;
            } catch(e) {}
        });
        html += '</div>';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(darkPageWrapper(`Outreach Drafts: ${pipelineId}`, html));
    } catch(e) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(darkPageWrapper('Outreach Drafts', '<div class="card"><p style="color:rgba(255,255,255,0.4)">No audits directory found.</p></div>'));
    }
}

// === Outreach Queue (JSON-based, CEO approval before SES send) ===

const OUTREACH_QUEUE_DIR = path.join(process.env.HOME || '/Users/elf-6', 'openclaw/shared/outreach_queue');
const SES_CONFIG_FILE = path.join(process.env.HOME || '/Users/elf-6', 'openclaw/shared/config/ses_config.json');

function getOutreachQueue(req, res, query) {
    try {
        const pipeline = query.pipeline || '';
        if (!fs.existsSync(OUTREACH_QUEUE_DIR)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, queue: [], total: 0 }));
            return;
        }
        const files = fs.readdirSync(OUTREACH_QUEUE_DIR).filter(f => f.endsWith('.json'));
        const queue = [];
        files.forEach(f => {
            try {
                const item = JSON.parse(fs.readFileSync(path.join(OUTREACH_QUEUE_DIR, f), 'utf8'));
                if (pipeline && item.pipeline !== pipeline) return;
                item._file = f;
                queue.push(item);
            } catch(e) {}
        });
        // Sort by queued_at descending (newest first)
        queue.sort((a, b) => (b.queued_at || '').localeCompare(a.queued_at || ''));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, queue, total: queue.length }));
    } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
    }
}

// ── Pipeline Stage Run / Log ──────────────────────────────────────────────────
const PIPELINE_STAGE_MAP = {
    'lead-gen':   { service: 'ai.dwe.hvac-lead-scraper',       log: 'hvac_lead_scraper.log',    label: 'Lead Scraper' },
    'audit':      { service: 'ai.dwe.audit-runner',            log: 'audit_runner.log',          label: 'Audit Runner' },
    'outreach':   { service: 'ai.dwe.outreach-sender',         log: 'outreach_sender.log',       label: 'Outreach Sender' },
    'queue':      { service: 'ai.dwe.populate-outreach-queue', log: 'populate_outreach_queue.log', label: 'Outreach Queue' },
    'reply':      { service: 'ai.dwe.reply-tracker',           log: 'reply_tracker.log',         label: 'Reply Tracker' },
};

function runPipelineStage(req, res, query) {
    if (req.method !== 'POST') { res.writeHead(405); res.end('POST only'); return; }
    const stage = (query && query.stage) || '';
    const meta = PIPELINE_STAGE_MAP[stage];
    if (!meta) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unknown stage: ' + stage }));
        return;
    }
    exec(`launchctl kickstart -k gui/${process.getuid()}/${meta.service}`, { timeout: 10000 }, (err, stdout, stderr) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: !err, service: meta.service, label: meta.label, err: err ? err.message : null }));
    });
}

function servePipelineStageLog(req, res, query) {
    const stage = (query && query.stage) || '';
    const meta = PIPELINE_STAGE_MAP[stage];
    if (!meta) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unknown stage' }));
        return;
    }
    const logPath = path.join(process.env.HOME, 'openclaw/logs', meta.log);
    if (!fs.existsSync(logPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, lines: [], label: meta.label, missing: true }));
        return;
    }
    try {
        // Return last 50 lines
        const content = fs.readFileSync(logPath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim()).slice(-50);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, lines, label: meta.label }));
    } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
    }
}

function approveOutreachEmail(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        try {
            const data = JSON.parse(body);
            const leadId = data.lead_id;
            if (!leadId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'lead_id required' }));
                return;
            }
            const filePath = path.join(OUTREACH_QUEUE_DIR, leadId + '.json');
            if (!fs.existsSync(filePath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Queue item not found' }));
                return;
            }
            const item = JSON.parse(fs.readFileSync(filePath, 'utf8'));

            // Allow editing subject/body before approval
            if (data.subject) item.subject = data.subject;
            if (data.body_text) item.body_text = data.body_text;

            // Read SES config
            let sesConfig = { mode: 'draft', sender: '', region: 'us-east-1', reply_to: '' };
            try { sesConfig = JSON.parse(fs.readFileSync(SES_CONFIG_FILE, 'utf8')); } catch(e) {}

            if (sesConfig.mode === 'draft') {
                // Draft mode — mark approved but don't send
                item.status = 'approved';
                item.approved_at = new Date().toISOString();
                fs.writeFileSync(filePath, JSON.stringify(item, null, 2));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, message: 'Approved (draft mode — SES not configured yet)', status: 'approved' }));
                return;
            }

            if (sesConfig.mode === 'gmail') {
                // Gmail SMTP mode — send via nodemailer
                try {
                    const transporter = nodemailer.createTransport({
                        service: 'gmail',
                        auth: {
                            user: sesConfig.gmail_user,
                            pass: sesConfig.gmail_app_password
                        }
                    });
                    const mailOptions = {
                        from: sesConfig.sender || `DWE Marketing <${sesConfig.gmail_user}>`,
                        to: item.to,
                        replyTo: sesConfig.reply_to || sesConfig.gmail_user,
                        subject: item.subject,
                        text: item.body_text
                    };
                    const info = await transporter.sendMail(mailOptions);
                    const messageId = info.messageId || 'unknown';

                    item.status = 'sent';
                    item.sent_at = new Date().toISOString();
                    item.gmail_message_id = messageId;
                    fs.writeFileSync(filePath, JSON.stringify(item, null, 2));

                    // Update prospect stage
                    try {
                        const updateUrl = `http://localhost:${PORT}/mc/prospects/update?pipeline=${item.pipeline}`;
                        const updateData = JSON.stringify({
                            lead_id: leadId,
                            Funnel_Stage: 'Outreach Sent',
                            Outreach_Status: 'Sent',
                            Last_Activity: new Date().toISOString().split('T')[0]
                        });
                        const updateReq = http.request(updateUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' } });
                        updateReq.write(updateData);
                        updateReq.end();
                    } catch(e) {}

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, message: `Sent via Gmail SMTP (ID: ${messageId})`, status: 'sent' }));
                } catch(e) {
                    item.status = 'send_failed';
                    item.error = e.message;
                    fs.writeFileSync(filePath, JSON.stringify(item, null, 2));
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Gmail send failed: ' + e.message }));
                }
                return;
            }

            // Send mode — use AWS SES
            const { execSync } = require('child_process');
            try {
                const sender = sesConfig.sender || 'DWE Marketing <outreach@tvcpulse.com>';
                const region = sesConfig.region || 'us-east-1';
                const replyTo = sesConfig.reply_to || '';

                // Build SES send-email command
                const sesPayload = {
                    Source: sender,
                    Destination: { ToAddresses: [item.to] },
                    Message: {
                        Subject: { Data: item.subject, Charset: 'UTF-8' },
                        Body: { Text: { Data: item.body_text, Charset: 'UTF-8' } }
                    }
                };
                if (replyTo) sesPayload.ReplyToAddresses = [replyTo];

                const tmpFile = `/tmp/ses_email_${leadId}.json`;
                fs.writeFileSync(tmpFile, JSON.stringify(sesPayload));

                const result = execSync(
                    `aws ses send-email --cli-input-json file://${tmpFile} --region ${region}`,
                    { timeout: 30000, encoding: 'utf8' }
                );
                const messageId = JSON.parse(result).MessageId || 'unknown';

                // Clean up temp file
                try { fs.unlinkSync(tmpFile); } catch(e) {}

                // Update queue item
                item.status = 'sent';
                item.sent_at = new Date().toISOString();
                item.ses_message_id = messageId;
                fs.writeFileSync(filePath, JSON.stringify(item, null, 2));

                // Update prospect stage via internal API
                try {
                    const updateUrl = `http://localhost:${PORT}/mc/prospects/update?pipeline=${item.pipeline}`;
                    const updateData = JSON.stringify({
                        lead_id: leadId,
                        Funnel_Stage: 'Outreach Sent',
                        Outreach_Status: 'Sent',
                        Last_Activity: new Date().toISOString().split('T')[0]
                    });
                    const updateReq = http.request(updateUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' } });
                    updateReq.write(updateData);
                    updateReq.end();
                } catch(e) {}

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, message: `Sent via SES (MessageId: ${messageId})`, status: 'sent' }));
            } catch(e) {
                item.status = 'send_failed';
                item.error = e.message;
                fs.writeFileSync(filePath, JSON.stringify(item, null, 2));
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'SES send failed: ' + e.message }));
            }
        } catch(e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid JSON: ' + e.message }));
        }
    });
}

function skipOutreachEmail(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            const leadId = data.lead_id;
            if (!leadId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'lead_id required' }));
                return;
            }
            const filePath = path.join(OUTREACH_QUEUE_DIR, leadId + '.json');
            if (!fs.existsSync(filePath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Queue item not found' }));
                return;
            }
            const item = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            item.status = 'skipped';
            item.skipped_at = new Date().toISOString();
            if (data.reason) item.skip_reason = data.reason;
            fs.writeFileSync(filePath, JSON.stringify(item, null, 2));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, message: 'Email skipped', status: 'skipped' }));
        } catch(e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid JSON: ' + e.message }));
        }
    });
}

function servePipelinePrompt(res, query, filename, title) {
    const pipelineId = query.pipeline || 'dwe-marketing';
    const promptPath = path.join(PIPELINES_DIR, pipelineId, filename);
    try {
        const md = fs.readFileSync(promptPath, 'utf8');
        const html = simpleMarkdownToHtml(md);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(darkPageWrapper(`${title}: ${pipelineId}`, `<div class="card md-content">${html}</div>`));
    } catch(e) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end(darkPageWrapper(title, `<div class="card"><p style="color:rgba(255,255,255,0.4)">Prompt file not found: ${filename}</p></div>`));
    }
}

function listPipelines(req, res) {
    try {
        const dirs = fs.readdirSync(PIPELINES_DIR).filter(d =>
            d !== '_template' && fs.existsSync(path.join(PIPELINES_DIR, d, 'pipeline.json'))
        );
        const pipelines = dirs.map(d => {
            const cfg = loadPipelineConfig(d);
            return cfg ? { id: cfg.pipeline_id, name: cfg.name, active: cfg.active, industry: cfg.industry_focus } : null;
        }).filter(Boolean);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, pipelines }));
    } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
    }
}

function getProspects(req, res, query) {
    const cfg = loadPipelineConfig(query.pipeline);
    if (!cfg) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Pipeline not found' })); return; }

    const MATON_KEY = 'vqV4andwInf-ObTAMv_-QZdq9DUBAhMnU2Gw8g5cP2_I5rAoBM4gwvCl1VHWrKUhzN39AW6nRHBtG8eP7dsVBEbIfBwNWcNAa7E';
    const SHEET_ID = '1nkhSpjxS11rWC2MPP40GLYvA7LYsaFba91hC5mWpi80';
    const range = encodeURIComponent(cfg.sheet_tab + '!A1:T500');

    const opts = { hostname: 'gateway.maton.ai', path: `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/${range}`, method: 'GET', headers: { 'Authorization': `Bearer ${MATON_KEY}` } };

    const apiReq = https.request(opts, (apiRes) => {
        let body = '';
        apiRes.on('data', chunk => body += chunk);
        apiRes.on('end', () => {
            try {
                const raw = JSON.parse(body);
                const rows = raw.values || [];
                const header = rows[0] || [];
                const allProspects = rows.slice(1).filter(r => r[0] && r[0].trim()).map(r => {
                    const obj = {};
                    header.forEach((col, i) => { obj[col] = (r[i] || '').trim(); });
                    return obj;
                });
                // Include all prospects in response but flag test rows
                const prospects = allProspects;
                // Stage counts exclude QA_Flag=T rows
                const prodProspects = allProspects.filter(p => (p.QA_Flag || '').toUpperCase() !== 'T');
                const stages = {};
                prodProspects.forEach(p => { const s = p.Funnel_Stage || 'New'; stages[s] = (stages[s] || 0) + 1; });
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
                res.end(JSON.stringify({ ok: true, pipeline: cfg.pipeline_id, prospects, stage_counts: stages, total: prodProspects.length, total_with_qa: allProspects.length }));
            } catch(e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Parse error: ' + e.message })); }
        });
    });
    apiReq.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    apiReq.end();
}

function addProspect(req, res, query) {
    if (req.method !== 'POST') { res.writeHead(405, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'POST required' })); return; }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            const cfg = loadPipelineConfig(query.pipeline);
            if (!cfg) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Pipeline not found' })); return; }

            const MATON_KEY = 'vqV4andwInf-ObTAMv_-QZdq9DUBAhMnU2Gw8g5cP2_I5rAoBM4gwvCl1VHWrKUhzN39AW6nRHBtG8eP7dsVBEbIfBwNWcNAa7E';
            const SHEET_ID = '1nkhSpjxS11rWC2MPP40GLYvA7LYsaFba91hC5mWpi80';
            const now = new Date().toISOString().split('T')[0];

            // First, read to get next ID
            const range = encodeURIComponent(cfg.sheet_tab + '!A:A');
            const readOpts = { hostname: 'gateway.maton.ai', path: `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/${range}`, method: 'GET', headers: { 'Authorization': `Bearer ${MATON_KEY}` } };

            const readReq = https.request(readOpts, (readRes) => {
                let readBody = '';
                readRes.on('data', chunk => readBody += chunk);
                readRes.on('end', () => {
                    let nextId = 1;
                    try {
                        const ids = JSON.parse(readBody).values || [];
                        ids.forEach(r => { const m = (r[0] || '').match(/PP-(\d+)/); if (m) nextId = Math.max(nextId, parseInt(m[1]) + 1); });
                    } catch(e) {}
                    const leadId = 'PP-' + String(nextId).padStart(4, '0');

                    const row = [
                        leadId,
                        data.business_name || '',
                        data.url || '',
                        data.industry || '',
                        data.location || '',
                        data.lead_score || '',
                        '', // Audit_Score (empty until audited)
                        'New',
                        data.funding_signal || 'No',
                        data.contact_email || '',
                        data.contact_name || '',
                        data.source || '',
                        now,
                        now,
                        '', '', '', '',
                        data.notes || '',
                        data.qa_flag || '' // Column T: QA_Flag — "T" = test lead, excluded from stats
                    ];

                    const appendRange = encodeURIComponent(cfg.sheet_tab + '!A:T');
                    const appendPath = `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/${appendRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
                    const writeOpts = { hostname: 'gateway.maton.ai', path: appendPath, method: 'POST', headers: { 'Authorization': `Bearer ${MATON_KEY}`, 'Content-Type': 'application/json' } };

                    const writeReq = https.request(writeOpts, (writeRes) => {
                        let writeBody = '';
                        writeRes.on('data', chunk => writeBody += chunk);
                        writeRes.on('end', () => {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: true, lead_id: leadId, pipeline: cfg.pipeline_id }));
                        });
                    });
                    writeReq.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
                    writeReq.end(JSON.stringify({ values: [row] }));
                });
            });
            readReq.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
            readReq.end();
        } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON: ' + e.message })); }
    });
}

function updateProspect(req, res, query) {
    if (req.method !== 'PUT') { res.writeHead(405, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'PUT required' })); return; }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            const cfg = loadPipelineConfig(query.pipeline);
            if (!cfg) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Pipeline not found' })); return; }
            if (!data.lead_id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'lead_id required' })); return; }

            const MATON_KEY = 'vqV4andwInf-ObTAMv_-QZdq9DUBAhMnU2Gw8g5cP2_I5rAoBM4gwvCl1VHWrKUhzN39AW6nRHBtG8eP7dsVBEbIfBwNWcNAa7E';
            const SHEET_ID = '1nkhSpjxS11rWC2MPP40GLYvA7LYsaFba91hC5mWpi80';

            // Read all data to find the row
            const range = encodeURIComponent(cfg.sheet_tab + '!A1:T500');
            const readOpts = { hostname: 'gateway.maton.ai', path: `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/${range}`, method: 'GET', headers: { 'Authorization': `Bearer ${MATON_KEY}` } };

            const readReq = https.request(readOpts, (readRes) => {
                let readBody = '';
                readRes.on('data', chunk => readBody += chunk);
                readRes.on('end', () => {
                    try {
                        const raw = JSON.parse(readBody);
                        const rows = raw.values || [];
                        const header = rows[0] || [];
                        let rowIdx = -1;
                        for (let i = 1; i < rows.length; i++) {
                            if ((rows[i][0] || '').trim() === data.lead_id) { rowIdx = i; break; }
                        }
                        if (rowIdx === -1) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Lead not found' })); return; }

                        // Merge updates into existing row
                        const existing = rows[rowIdx];
                        const fieldMap = {};
                        header.forEach((h, i) => { fieldMap[h] = i; });

                        // Apply updates
                        const updatable = ['Business_Name', 'URL', 'Industry', 'Location', 'Lead_Score', 'Audit_Score', 'Funnel_Stage', 'Funding_Signal', 'Source', 'Last_Activity', 'Audit_Report_Path', 'Outreach_Status', 'Product_Offered', 'Monthly_Value', 'Notes', 'Contact_Email', 'Contact_Name', 'QA_Flag'];
                        updatable.forEach(f => {
                            if (data[f] !== undefined && fieldMap[f] !== undefined) {
                                while (existing.length <= fieldMap[f]) existing.push('');
                                existing[fieldMap[f]] = data[f];
                            }
                        });
                        // Always update Last_Activity
                        if (fieldMap['Last_Activity'] !== undefined) {
                            while (existing.length <= fieldMap['Last_Activity']) existing.push('');
                            existing[fieldMap['Last_Activity']] = new Date().toISOString().split('T')[0];
                        }

                        const sheetRow = rowIdx + 1; // 1-indexed
                        const writeRange = encodeURIComponent(cfg.sheet_tab + `!A${sheetRow}:T${sheetRow}`);
                        const writePath = `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/${writeRange}?valueInputOption=USER_ENTERED`;
                        const writeOpts = { hostname: 'gateway.maton.ai', path: writePath, method: 'PUT', headers: { 'Authorization': `Bearer ${MATON_KEY}`, 'Content-Type': 'application/json' } };

                        const writeReq = https.request(writeOpts, (writeRes) => {
                            let writeBody = '';
                            writeRes.on('data', chunk => writeBody += chunk);
                            writeRes.on('end', () => {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ ok: true, lead_id: data.lead_id, updated_row: sheetRow }));
                            });
                        });
                        writeReq.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
                        writeReq.end(JSON.stringify({ values: [existing] }));
                    } catch(e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Parse error: ' + e.message })); }
                });
            });
            readReq.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
            readReq.end();
        } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON: ' + e.message })); }
    });
}

function getProspectStats(req, res, query) {
    const cfg = loadPipelineConfig(query.pipeline);
    if (!cfg) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Pipeline not found' })); return; }

    const MATON_KEY = 'vqV4andwInf-ObTAMv_-QZdq9DUBAhMnU2Gw8g5cP2_I5rAoBM4gwvCl1VHWrKUhzN39AW6nRHBtG8eP7dsVBEbIfBwNWcNAa7E';
    const SHEET_ID = '1nkhSpjxS11rWC2MPP40GLYvA7LYsaFba91hC5mWpi80';
    const range = encodeURIComponent(cfg.sheet_tab + '!A1:T500');

    const opts = { hostname: 'gateway.maton.ai', path: `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/${range}`, method: 'GET', headers: { 'Authorization': `Bearer ${MATON_KEY}` } };

    const apiReq = https.request(opts, (apiRes) => {
        let body = '';
        apiRes.on('data', chunk => body += chunk);
        apiRes.on('end', () => {
            try {
                const raw = JSON.parse(body);
                const rows = raw.values || [];
                const header = rows[0] || [];
                const qaIdx = header.indexOf('QA_Flag');
                // Exclude QA_Flag=T rows from all stats
                const data = rows.slice(1).filter(r => r[0] && r[0].trim() && (qaIdx === -1 || (r[qaIdx] || '').toUpperCase() !== 'T'));

                const stageIdx = header.indexOf('Funnel_Stage');
                const scoreIdx = header.indexOf('Audit_Score');
                const valueIdx = header.indexOf('Monthly_Value');
                const fundingIdx = header.indexOf('Funding_Signal');

                const stages = {};
                const stageOrder = ['Lead Generation', 'New', 'Audited', 'Outreach Sent', 'Responded', 'Proposal', 'Client', 'Upsell', 'Disqualified'];
                stageOrder.forEach(s => stages[s] = 0);

                let totalValue = 0;
                let totalScore = 0;
                let scoredCount = 0;
                let fundingLeads = 0;

                data.forEach(r => {
                    const stage = (r[stageIdx] || 'New').trim();
                    stages[stage] = (stages[stage] || 0) + 1;
                    const val = parseFloat((r[valueIdx] || '0').replace(/[$,]/g, '')) || 0;
                    totalValue += val;
                    const score = parseFloat(r[scoreIdx] || '0') || 0;
                    if (score > 0) { totalScore += score; scoredCount++; }
                    if ((r[fundingIdx] || '').trim().toLowerCase() !== 'no' && (r[fundingIdx] || '').trim() !== '') fundingLeads++;
                });

                // Lead Generation = total prospects sourced (everyone who entered the pipeline)
                stages['Lead Generation'] = data.length;

                // Conversion rates (skip Lead Generation → New since LG is cumulative)
                const conversions = {};
                const convStages = stageOrder.slice(1); // Start from New for conversion math
                conversions['Lead Generation → New'] = data.length > 0 ? '100%' : '0%';
                for (let i = 0; i < convStages.length - 1; i++) {
                    const from = convStages[i];
                    const laterSum = convStages.slice(i + 1).reduce((s, st) => s + (stages[st] || 0), 0);
                    const fromTotal = (stages[from] || 0) + laterSum;
                    conversions[from + ' → ' + convStages[i + 1]] = fromTotal > 0 ? Math.round((laterSum / fromTotal) * 100) + '%' : '0%';
                }

                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
                res.end(JSON.stringify({
                    ok: true,
                    pipeline: cfg.pipeline_id,
                    total: data.length,
                    stages,
                    conversions,
                    pipeline_value: '$' + totalValue.toFixed(0),
                    avg_audit_score: scoredCount > 0 ? Math.round(totalScore / scoredCount) : 0,
                    funding_leads: fundingLeads,
                    products: cfg.products
                }));
            } catch(e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Parse error: ' + e.message })); }
        });
    });
    apiReq.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    apiReq.end();
}

// ── Pipeline Products — reads GO products from Product_Pipeline sheet ──
function getPipelineProducts(req, res) {
    const MATON_KEY = 'vqV4andwInf-ObTAMv_-QZdq9DUBAhMnU2Gw8g5cP2_I5rAoBM4gwvCl1VHWrKUhzN39AW6nRHBtG8eP7dsVBEbIfBwNWcNAa7E';
    const SHEET_ID = '1nkhSpjxS11rWC2MPP40GLYvA7LYsaFba91hC5mWpi80';
    const apiPath = `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/Product_Pipeline!A1:K50`;

    const opts = {
        hostname: 'gateway.maton.ai',
        path: apiPath,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${MATON_KEY}` }
    };

    const apiReq = https.request(opts, (apiRes) => {
        let body = '';
        apiRes.on('data', chunk => body += chunk);
        apiRes.on('end', () => {
            try {
                const raw = JSON.parse(body);
                const rows = raw.values || [];
                const header = rows[0] || [];
                const dataRows = rows.slice(1);

                const products = dataRows.filter(r => r[0] && r[0].trim()).map((r, idx) => {
                    const obj = { _row: idx + 2 }; // 1-indexed, header is row 1
                    header.forEach((col, i) => {
                        const key = col.trim().replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
                        obj[key] = (r[i] || '').trim();
                    });
                    return obj;
                });

                // Filter to GO products that are Ready to Launch (not yet graduated)
                const goProducts = products.filter(p =>
                    p.VERDICT === 'GO' &&
                    p.Status === 'Ready to Launch'
                );

                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
                res.end(JSON.stringify({ ok: true, products: goProducts, total: products.length, updated: new Date().toISOString() }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Parse error: ' + e.message }));
            }
        });
    });

    apiReq.on('error', (e) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Maton API error: ' + e.message }));
    });

    apiReq.end();
}

// ── Graduate Product — moves product from Pipeline → IncomeOps ─────────
function handleGraduateProduct(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'POST only' }));
        return;
    }

    let reqBody = '';
    req.on('data', chunk => reqBody += chunk);
    req.on('end', () => {
        try {
            const { source_id, product_name, price, row_number } = JSON.parse(reqBody);
            if (!source_id || !product_name) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'source_id and product_name required' }));
                return;
            }

            const MATON_KEY = 'vqV4andwInf-ObTAMv_-QZdq9DUBAhMnU2Gw8g5cP2_I5rAoBM4gwvCl1VHWrKUhzN39AW6nRHBtG8eP7dsVBEbIfBwNWcNAa7E';
            const SHEET_ID = '1nkhSpjxS11rWC2MPP40GLYvA7LYsaFba91hC5mWpi80';
            const now = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

            // Step 1: Append new row to IncomeOps_Monitor
            const newRow = [
                product_name,           // A: Stream Name
                source_id,              // B: Contract ID
                'DWE Product Pipeline', // C: Source Platform
                now,                    // D: Start Date
                '',                     // E: End Date
                '✅ Active',            // F: Status
                '30',                   // G: Cycle Days
                '$0',                   // H: Staked Balance
                '',                     // I: Loan Balance
                price || '',            // J: Unit Value
                '',                     // K: Daily Rewards
                'Y',                    // L: Cashflow
                '',                     // M: 1 Day ($)
                '',                     // N: 7 Days ($)
                '$0',                   // O: 30 Days ($) — updated when revenue starts
                '$0',                   // P: 365 Days ($)
                '',                     // Q: Projected Units
                '',                     // R: Projected Profit
                '',                     // S: Daily Growth %
                '',                     // T: Cumulative ROI %
                '🟢 High',             // U: Monitoring Tier
                '',                     // V: Notes / Escalation
                'Cash Flow'             // W: Income Type
            ];

            const appendPayload = JSON.stringify({ values: [newRow] });
            const appendOpts = {
                hostname: 'gateway.maton.ai',
                path: `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/IncomeOps_Monitor!A:W:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${MATON_KEY}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(appendPayload)
                }
            };

            const appendReq = https.request(appendOpts, (appendRes) => {
                let appendBody = '';
                appendRes.on('data', chunk => appendBody += chunk);
                appendRes.on('end', () => {
                    // Step 2: Update Pipeline Status to "Graduated → IncomeOps"
                    if (row_number) {
                        const statusPayload = JSON.stringify({ values: [['Graduated → IncomeOps']] });
                        const statusOpts = {
                            hostname: 'gateway.maton.ai',
                            path: `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/Product_Pipeline!I${row_number}?valueInputOption=RAW`,
                            method: 'PUT',
                            headers: {
                                'Authorization': `Bearer ${MATON_KEY}`,
                                'Content-Type': 'application/json',
                                'Content-Length': Buffer.byteLength(statusPayload)
                            }
                        };
                        const statusReq = https.request(statusOpts, (statusRes) => {
                            let statusBody = '';
                            statusRes.on('data', chunk => statusBody += chunk);
                            statusRes.on('end', () => {
                                console.log(`[graduate] ${product_name} (${source_id}) → IncomeOps as Cash Flow`);
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ ok: true, product: product_name, source_id, graduated: now }));
                            });
                        });
                        statusReq.on('error', (e) => {
                            // Append succeeded but status update failed — still report success with warning
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: true, product: product_name, warning: 'Added to IncomeOps but Pipeline status update failed: ' + e.message }));
                        });
                        statusReq.write(statusPayload);
                        statusReq.end();
                    } else {
                        console.log(`[graduate] ${product_name} (${source_id}) → IncomeOps as Cash Flow (no row_number, status not updated)`);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true, product: product_name, source_id, graduated: now }));
                    }
                });
            });

            appendReq.on('error', (e) => {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Failed to append to IncomeOps: ' + e.message }));
            });

            appendReq.write(appendPayload);
            appendReq.end();
        } catch(e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
    });
}

// ── Change_Log — proxies Google Sheets via Maton ────────────────────────
function getChangeLog(req, res) {
    const MATON_KEY = 'vqV4andwInf-ObTAMv_-QZdq9DUBAhMnU2Gw8g5cP2_I5rAoBM4gwvCl1VHWrKUhzN39AW6nRHBtG8eP7dsVBEbIfBwNWcNAa7E';
    const SHEET_ID = '1nkhSpjxS11rWC2MPP40GLYvA7LYsaFba91hC5mWpi80';
    const apiPath = `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/Change_Log!A1:X500`;

    const opts = {
        hostname: 'gateway.maton.ai',
        path: apiPath,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${MATON_KEY}` }
    };

    const apiReq = https.request(opts, (apiRes) => {
        let body = '';
        apiRes.on('data', chunk => body += chunk);
        apiRes.on('end', () => {
            try {
                const raw = JSON.parse(body);
                const rows = raw.values || [];
                const header = rows[0] || [];
                const dataRows = rows.slice(1);

                const entries = dataRows.filter(r => r[0] && r[0].trim()).map(r => {
                    const obj = {};
                    header.forEach((col, i) => {
                        const key = col.trim().replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
                        obj[key] = (r[i] || '').trim();
                    });
                    return obj;
                });

                // Return newest first
                entries.reverse();

                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
                res.end(JSON.stringify({ ok: true, entries, total: entries.length, updated: new Date().toISOString() }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Parse error: ' + e.message }));
            }
        });
    });

    apiReq.on('error', (e) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Maton API error: ' + e.message }));
    });

    apiReq.end();
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

// Activity blip log — for server-side services (brain, openrouter) not visible in local nettop
const activityLog = {}; // { brain: lastMs, openrouter: lastMs, ... }

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
                // Update in-memory traffic blip log immediately
                if (entry.service) activityLog[entry.service] = Date.now();

                // Respond immediately — HUD reads from memory, not disk
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));

                // Persist to disk in background (non-blocking)
                fs.readFile(ACTIVITY_FILE, 'utf8', (err, data) => {
                    try {
                        const activity = JSON.parse(data || '{"entries":[]}');
                        activity.entries.push(entry);
                        fs.writeFile(ACTIVITY_FILE, JSON.stringify(activity, null, 2), () => {});
                    } catch (_) {}
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
    exec('nc -z 127.0.0.1 3000 && echo "open" || echo "closed"', { timeout: 5000 }, (err, out) => {
        const gatewayUp = (out || '').trim() === 'open';
        const agents = [
            { id: 'cto',            name: 'Steve',          role: 'Chief Technology Officer',  telegram: '@DWE_CTO_Bot',    status: gatewayUp ? 'online' : 'offline' },
            { id: 'anita',          name: 'Anita',          role: 'Chief Operating Officer',   telegram: 'anita-coo',       status: gatewayUp ? 'online' : 'offline' },
            { id: 'nicole',         name: 'Nicole',         role: 'Chief Information Officer', telegram: 'nicole-cos',      status: gatewayUp ? 'online' : 'offline' },
            { id: 'chief-engineer', name: 'Chief Engineer', role: 'Engineering Lead',          telegram: null,              status: gatewayUp ? 'online' : 'offline' },
            { id: 'cfo',            name: 'Fran',           role: 'Chief Financial Officer',   telegram: '@DWE_CFO_Bot',    status: gatewayUp ? 'online' : 'offline' },
            { id: 'main',           name: 'Main',           role: 'Primary Assistant',         telegram: null,              status: gatewayUp ? 'online' : 'offline' },
            { id: 'jarvis',         name: 'Jarvis',         role: 'Execution Layer',           telegram: null,              status: gatewayUp ? 'online' : 'offline' },
            { id: 'herald',         name: 'Herald',         role: 'SEO & AISO Specialist',     telegram: null,              status: gatewayUp ? 'online' : 'offline' },
            { id: 'validator',      name: 'Victor',         role: 'QA & Validation',           telegram: null,              status: gatewayUp ? 'online' : 'offline' }
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

// ── Daemon Taxonomy ─────────────────────────────────────────────────────────
// tier 1 = critical (kickstart -k immediately, escalate after 2 attempts)
// tier 2 = operational (graceful stop+start, escalate after 2 attempts)
// tier 0 / alwaysOn: false = scheduled, NEVER auto-restart
const KEY_DAEMONS = [
    { label: 'ai.dwe.audit-runner',          id: 'PL-01', name: 'Audit Runner',       tier: 2, alwaysOn: true  },
    { label: 'ai.dwe.outreach-sender',        id: 'PL-02', name: 'Outreach Sender',    tier: 2, alwaysOn: true  },
    { label: 'ai.dwe.daily-ops-log',          id: 'PL-03', name: 'Daily Ops Log',      tier: 0, alwaysOn: false },
    { label: 'ai.dwe.ops-log-task-creator',   id: 'PL-04', name: 'Ops Task Creator',   tier: 0, alwaysOn: false },
    { label: 'ai.openclaw.gateway',            id: 'OC-01', name: 'OpenClaw Gateway',   tier: 1, alwaysOn: true  },
    { label: 'ai.dwe.notion-sync',             id: 'BR-01', name: 'Notion Sync',        tier: 2, alwaysOn: true  },
    { label: 'ai.dwe.seed-watcher',            id: 'BR-02', name: 'Brain Seed Watcher', tier: 1, alwaysOn: true  },
    { label: 'ai.dwe.anomaly-check',           id: 'MN-01', name: 'Anomaly Check',      tier: 0, alwaysOn: false },
    { label: 'ai.dwe.ralphy-monitor',          id: 'MN-02', name: 'Ralphy Monitor',     tier: 2, alwaysOn: true  },
    { label: 'ai.dwe.anita-notion-triage',     id: 'PM-01', name: 'Anita PM Triage',   tier: 0, alwaysOn: false },
];

// ── Self-Healer State (in-memory, resets on server restart) ────────────────
const healingState = {};
KEY_DAEMONS.forEach(d => {
    healingState[d.label] = { status: 'ok', restartCount: 0, firstRestartAt: null };
});

const CRASH_WINDOW_MS   = 5 * 60 * 1000;  // 5 minutes
const MAX_RESTARTS      = 2;               // >= MAX in window = crash loop
const TIER2_GRACE_MS    = 30 * 1000;      // 30s grace before start for Tier 2
const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours — auto-trigger backup if overdue
let   backupInProgress  = false;           // guard: prevent stacked backup runs

// ── RAM Self-Healer State ───────────────────────────────────────────────────
const RAM_OPTIMIZE_COOLDOWN_MS = 10 * 60 * 1000; // 10 min between optimize runs
let   ramOptimizeInProgress    = false;
let   ramOptimizeAttempts      = 0;       // resets when pressure returns to normal
let   ramLastOptimizeAt        = 0;
let   ramState                 = 'ok';    // 'ok' | 'warn' | 'critical' | 'escalated'
let   ramLastPageouts          = null;    // baseline for Pageouts delta detection

// Read memory_pressure level + Pageouts from vm_stat in one exec
function getRamPressure(cb) {
    exec(
        'memory_pressure 2>/dev/null | head -1 ; ' +
        'vm_stat 2>/dev/null | awk \'/Pageouts/ {gsub(/\\./,""); print $2}\'',
        { timeout: 5000 },
        (err, stdout) => {
            if (err) return cb(null);
            const lines = stdout.trim().split('\n');
            // memory_pressure output: "System-wide memory free percentage: 14%  System Memory Pressure: WARN"
            const pressureLine = lines.find(l => /pressure/i.test(l)) || '';
            let level = 'normal';
            if (/CRITICAL/i.test(pressureLine))    level = 'critical';
            else if (/WARN/i.test(pressureLine))   level = 'warn';
            const pageouts = parseInt(lines.find(l => /^\d+$/.test(l.trim())) || '0', 10) || 0;
            cb({ level, pageouts });
        }
    );
}

// Get top 5 memory hogs for Alert Hub payload
function getTopMemHogs(cb) {
    exec(
        "ps aux | sort -k4 -rn | awk 'NR>1 && NR<=6 {printf \"%s %.1f%% %s\\n\", $1, $4, $11}'",
        { timeout: 5000 },
        (err, stdout) => cb(err ? 'unavailable' : stdout.trim())
    );
}

// Check if Ollama is actively running inference (has established connections)
function isOllamaBusy(cb) {
    exec("lsof -i :11434 -n -P 2>/dev/null | grep -c ESTABLISHED", { timeout: 4000 }, (err, stdout) => {
        cb(!err && parseInt(stdout.trim(), 10) > 0);
    });
}

// ── Alert Hub Escalation ────────────────────────────────────────────────────
function postAlertHub(daemon, action, attempts) {
    const body = JSON.stringify({
        service:   daemon.label,
        name:      daemon.name,
        id:        daemon.id,
        tier:      daemon.tier,
        attempts,
        action,
        timestamp: new Date().toISOString(),
        source:    'mc-server-self-healer'
    });
    const opts = {
        hostname: 'n8n.tvcpulse.com',
        path:     '/webhook/dwe-agent-alert',
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => { res.resume(); }); // fire-and-forget
    req.on('error', e => console.error('[Healer] Alert Hub POST failed:', e.message));
    req.write(body);
    req.end();
}

// ── Self-Healer Loop ────────────────────────────────────────────────────────
// Polls launchctl every 20s. Restarts always-on daemons on error.
// Crash-loop guard: 2 restarts within 5 min → escalate, stop retrying.
function runHealerTick() {
    const uid = process.getuid();
    exec('launchctl list 2>/dev/null | grep "ai\\."', { timeout: 5000 }, (error, stdout) => {
        if (error) return;

        const liveMap = {};
        if (stdout) {
            stdout.trim().split('\n').forEach(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 3) {
                    const pid      = parts[0] !== '-' ? parts[0] : null;
                    const exitCode = parts[1] !== '-' ? parseInt(parts[1], 10) : null;
                    liveMap[parts[2]] = { pid, exitCode };
                }
            });
        }

        const now = Date.now();

        KEY_DAEMONS.forEach(daemon => {
            if (!daemon.alwaysOn) return;

            const info  = liveMap[daemon.label];
            const state = healingState[daemon.label];

            // Running normally
            if (info && info.pid) {
                if (state.status === 'recovering') {
                    console.log(`[Healer] ${daemon.label} recovered (PID ${info.pid})`);
                    state.status = 'ok';
                    state.restartCount = 0;
                    state.firstRestartAt = null;
                    wsPushOpsBoard();
                }
                return;
            }

            // Not loaded = plist unloaded, not our concern
            if (!info) return;
            // Clean exit — skip
            if (info.exitCode === 0 || info.exitCode === null) return;

            // Daemon is DOWN with nonzero exit
            if (state.status === 'escalated') return;

            // Reset window if outside 5-min crash window
            if (state.firstRestartAt && (now - state.firstRestartAt) > CRASH_WINDOW_MS) {
                state.restartCount = 0;
                state.firstRestartAt = null;
            }

            // Crash-loop check
            if (state.restartCount >= MAX_RESTARTS) {
                if (state.status !== 'escalated') {
                    state.status = 'escalated';
                    console.error(`[Healer] CRASH LOOP: ${daemon.label} — escalating`);
                    postAlertHub(daemon, 'crash-loop-detected', state.restartCount);
                    wsPushOpsBoard();
                }
                return;
            }

            // Attempt restart
            state.status = 'recovering';
            state.restartCount += 1;
            if (!state.firstRestartAt) state.firstRestartAt = now;

            console.log(`[Healer] Restart #${state.restartCount} for ${daemon.label} (tier ${daemon.tier}, exit ${info.exitCode})`);
            wsPushOpsBoard();

            if (daemon.tier === 1) {
                exec(`launchctl kickstart -k gui/${uid}/${daemon.label}`, { timeout: 15000 }, (err) => {
                    if (err) console.error(`[Healer] kickstart failed for ${daemon.label}: ${err.message}`);
                    else console.log(`[Healer] kickstart issued for ${daemon.label}`);
                    if (state.restartCount >= MAX_RESTARTS) {
                        postAlertHub(daemon, 'restarted-kickstart-attempt-' + state.restartCount, state.restartCount);
                    }
                });
            } else {
                exec(`launchctl stop gui/${uid}/${daemon.label}`, { timeout: 10000 }, (stopErr) => {
                    if (stopErr) console.warn(`[Healer] stop warning for ${daemon.label}: ${stopErr.message}`);
                    setTimeout(() => {
                        exec(`launchctl start gui/${uid}/${daemon.label}`, { timeout: 10000 }, (startErr) => {
                            if (startErr) {
                                console.error(`[Healer] start failed for ${daemon.label}: ${startErr.message}`);
                                exec(`launchctl kickstart -k gui/${uid}/${daemon.label}`, { timeout: 15000 }, () => {});
                            } else {
                                console.log(`[Healer] graceful restart issued for ${daemon.label}`);
                            }
                            if (state.restartCount >= MAX_RESTARTS) {
                                postAlertHub(daemon, 'restarted-graceful-attempt-' + state.restartCount, state.restartCount);
                            }
                        });
                    }, TIER2_GRACE_MS);
                });
            }
        });

        // ── Auto-backup check ──────────────────────────────────────────────
        // If no backup in 24h and none in progress, fire one silently
        if (!backupInProgress) {
            const ocBackupMs = lastOpenclawBackupTime ? lastOpenclawBackupTime.getTime() : 0;
            if ((now - ocBackupMs) > BACKUP_MAX_AGE_MS) {
                backupInProgress = true;
                console.log('[Healer] Backup overdue — auto-triggering OpenClaw backup');
                wsPushOpsBoard(); // board will show 'recovering' for BK-01 (set below)
                const SCRIPT = '/Users/elf-6/openclaw/agents/cto/skills/backup/backup.sh';
                exec(SCRIPT, {
                    timeout: 180000,
                    env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/elf-6' }
                }, (err, stdout) => {
                    backupInProgress = false;
                    if (err) {
                        console.error('[Healer] Auto-backup failed:', err.message);
                        postAlertHub({ label: 'openclaw-backup', name: 'OpenClaw Backup', id: 'BK-01', tier: 1 }, 'auto-backup-failed', 1);
                    } else {
                        try {
                            const lines = stdout.trim().split('\n');
                            const result = JSON.parse(lines[lines.length - 1]);
                            if (result.success) lastOpenclawBackupTime = new Date();
                        } catch(e) {
                            lastOpenclawBackupTime = new Date(); // fallback: assume success if exit 0
                        }
                        console.log('[Healer] Auto-backup completed — last backup:', lastOpenclawBackupTime.toISOString());
                    }
                    wsPushOpsBoard();
                });
            }
        }

        // ── RAM pressure check ────────────────────────────────────────────
        if (!ramOptimizeInProgress) {
            getRamPressure(pressure => {
                if (!pressure) return;

                const { level, pageouts } = pressure;
                const pageoutsDelta = ramLastPageouts !== null ? pageouts - ramLastPageouts : 0;
                ramLastPageouts = pageouts;
                const swapGrowing = pageoutsDelta > 50; // >50 new pageouts since last tick = real pressure

                if (level === 'normal' && !swapGrowing) {
                    // Pressure cleared — reset state
                    if (ramState !== 'ok') {
                        console.log('[Healer] RAM pressure cleared');
                        ramState = 'ok';
                        ramOptimizeAttempts = 0;
                    }
                    return;
                }

                if (level === 'warn' && !swapGrowing) {
                    // Warn only — log hogs, no action
                    if (ramState === 'ok') {
                        ramState = 'warn';
                        getTopMemHogs(hogs => {
                            console.warn(`[Healer] RAM pressure WARN — top hogs:\n${hogs}`);
                        });
                    }
                    return;
                }

                // Critical or swap growing — attempt optimize
                if (ramState === 'escalated') return;

                const cooldownOk = (Date.now() - ramLastOptimizeAt) > RAM_OPTIMIZE_COOLDOWN_MS;
                if (!cooldownOk) return;

                if (ramOptimizeAttempts >= 2) {
                    // Two attempts, still critical — escalate
                    if (ramState !== 'escalated') {
                        ramState = 'escalated';
                        getTopMemHogs(hogs => {
                            console.error(`[Healer] RAM still critical after ${ramOptimizeAttempts} attempts — escalating`);
                            postAlertHub(
                                { label: 'mac-mini-ram', name: 'Mac Mini RAM', id: 'SY-RAM', tier: 1 },
                                `ram-critical-after-${ramOptimizeAttempts}-attempts`,
                                ramOptimizeAttempts
                            );
                        });
                    }
                    return;
                }

                // Fire optimize — but check Ollama first
                ramOptimizeInProgress = true;
                ramOptimizeAttempts += 1;
                ramLastOptimizeAt = Date.now();
                ramState = 'critical';

                isOllamaBusy(busy => {
                    const SCRIPT = '/Users/elf-6/openclaw/bin/system_optimize.sh';
                    // If Ollama is mid-inference, pass flag to skip the purge step
                    const env = {
                        ...process.env,
                        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
                        HOME: '/Users/elf-6',
                        SKIP_PURGE: busy ? '1' : '0'
                    };
                    if (busy) console.log(`[Healer] RAM optimize attempt #${ramOptimizeAttempts} — Ollama busy, skipping purge`);
                    else      console.log(`[Healer] RAM optimize attempt #${ramOptimizeAttempts} — running full optimize`);

                    exec(SCRIPT, { timeout: 120000, env }, (err, stdout) => {
                        ramOptimizeInProgress = false;
                        if (err) {
                            console.error('[Healer] RAM optimize failed:', err.message);
                        } else {
                            console.log('[Healer] RAM optimize completed');
                        }
                        // Re-check pressure after 15s to see if it helped
                        setTimeout(() => {
                            getRamPressure(after => {
                                if (!after) return;
                                if (after.level === 'normal') {
                                    console.log('[Healer] RAM pressure resolved after optimize');
                                    ramState = 'ok';
                                    ramOptimizeAttempts = 0;
                                } else {
                                    console.warn(`[Healer] RAM still at ${after.level} after optimize attempt #${ramOptimizeAttempts}`);
                                }
                            });
                        }, 15000);
                    });
                });
            });
        }
    });
}

function getServices(req, res) {
    const services = [
        { name: 'OpenClaw Gateway', port: 3000, check: 'http://127.0.0.1:3000/status' },
        { name: 'n8n Contabo', url: 'https://n8n.tvcpulse.com', type: 'external' },
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
            exec(`curl -s -o /dev/null -w "%{http_code}" "${service.url}" --max-time 3`, { timeout: 5000 }, (error, stdout) => {
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
            exec(`nc -z 127.0.0.1 ${service.port} && echo "open" || echo "closed"`, { timeout: 5000 }, (error, stdout) => {
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

function parseCronLines(stdout, prefix, hostLabel) {
    const crons = [];
    if (!stdout) return crons;
    const lines = stdout.trim().split('\n');
    lines.forEach((line, idx) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 6) {
            const schedule = parts.slice(0, 5).join(' ');
            const commandParts = parts.slice(5);
            let scriptName = 'System';
            for (const part of commandParts) {
                if (part.includes('.sh') || part.includes('/')) {
                    scriptName = part.split('/').pop().replace('.sh', '');
                    break;
                }
            }
            if (scriptName === 'System' && commandParts.length > 0) {
                const meaningful = commandParts.find(p => !p.startsWith('>') && !p.startsWith('-') && p.length > 2);
                if (meaningful) {
                    scriptName = meaningful.split('/').pop();
                }
            }
            crons.push({
                id: `${prefix}-${String(idx + 1).padStart(3, '0')}`,
                schedule: schedule,
                command: scriptName,
                host: hostLabel,
                status: 'active',
                nextRun: calculateNextRun(schedule)
            });
        }
    });
    return crons;
}

function getCrons(req, res) {
    let allCrons = [];
    let pending = 2;

    function done() {
        if (--pending > 0) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ crons: allCrons, count: allCrons.length, timestamp: new Date().toISOString() }));
    }

    // Local Mac crons
    exec('crontab -l 2>/dev/null | grep -v "^#" | grep -v "^$" | head -20', { timeout: 5000 }, (error, stdout) => {
        if (!error && stdout) {
            allCrons.push(...parseCronLines(stdout, 'MAC', 'Mac Mini'));
        }
        done();
    });

    // VPS crons (ssh with 5s timeout)
    exec('ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -i /Users/elf-6/.ssh/remote_access_key root@86.48.27.45 "crontab -l 2>/dev/null | grep -v \'^#\' | grep -v \'^$\' | head -20"', { timeout: 10000 }, (error, stdout) => {
        if (!error && stdout) {
            allCrons.push(...parseCronLines(stdout, 'VPS', 'VPS'));
        }
        done();
    });
}

function getOldVpsStatus(req, res) {
    const cmd = '/Users/elf-6/mission-control-server/check_old_vps.sh';
    exec(cmd, { timeout: 15000 }, (err, stdout) => {
        const result = { online: false, cpu: '—', ram: '—', disk: '—', uptime: '—', n8n: '—', load: '—' };
        if (!err && stdout) {
            result.online = true;
            stdout.split('\n').forEach(line => {
                if (line.startsWith('CPU:')) result.cpu = line.slice(4);
                if (line.startsWith('RAM:')) result.ram = line.slice(4);
                if (line.startsWith('DISK:')) result.disk = line.slice(5);
                if (line.startsWith('UPTIME:')) result.uptime = line.slice(7);
                if (line.startsWith('N8N:')) result.n8n = line.slice(4);
                if (line.startsWith('LOAD:')) result.load = line.slice(5);
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    });
}

function getSiteHealth(req, res) {
    const https = require('https');
    const sites = [
        { name: 'theveteransconsultant.com', url: 'https://theveteransconsultant.com/', label: 'TVC Home' },
        { name: 'theveteransconsultant.com/services', url: 'https://theveteransconsultant.com/services/', label: 'TVC Services' },
        { name: 'theveteransconsultant.com/health-report', url: 'https://theveteransconsultant.com/health-report/', label: 'Health Report' },
        { name: 'tvcpulse.com', url: 'https://tvcpulse.com/', label: 'TVC Pulse' },
    ];
    const results = [];
    let pending = sites.length;
    sites.forEach(site => {
        const start = Date.now();
        const hostname = new URL(site.url).hostname;
        // Get SSL expiry via openssl (works through Cloudflare)
        exec(`echo | openssl s_client -servername ${hostname} -connect ${hostname}:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//'`, { timeout: 8000 }, (sslErr, sslOut) => {
            let sslDays = null;
            if (!sslErr && sslOut && sslOut.trim()) {
                const expiry = new Date(sslOut.trim());
                if (!isNaN(expiry)) sslDays = Math.round((expiry - Date.now()) / (1000 * 60 * 60 * 24));
            }
            // HTTP check
            const req2 = https.get(site.url, { timeout: 10000 }, (resp) => {
                const elapsed = ((Date.now() - start) / 1000).toFixed(2);
                results.push({ label: site.label, url: site.url, status: resp.statusCode, time: elapsed + 's', ssl: sslDays, ok: resp.statusCode >= 200 && resp.statusCode < 400 });
                resp.resume();
                pending--;
                if (pending === 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(results)); }
            });
            req2.on('error', (e) => {
                results.push({ label: site.label, url: site.url, status: 'DOWN', time: '—', ssl: sslDays, ok: false });
                pending--;
                if (pending === 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(results)); }
            });
            req2.on('timeout', () => { req2.destroy(); });
        });
    });
}

function getContaboVpsStatus(req, res) {
    const cmd = '/Users/elf-6/mission-control-server/check_contabo_vps.sh';
    exec(cmd, { timeout: 15000 }, (err, stdout) => {
        const result = { online: false, cpu: '—', ram: '—', disk: '—', uptime: '—', n8n: '—', load: '—' };
        if (!err && stdout) {
            result.online = true;
            stdout.split('\n').forEach(line => {
                if (line.startsWith('CPU:')) result.cpu = line.slice(4);
                if (line.startsWith('RAM:')) result.ram = line.slice(4);
                if (line.startsWith('DISK:')) result.disk = line.slice(5);
                if (line.startsWith('UPTIME:')) result.uptime = line.slice(7);
                if (line.startsWith('N8N:')) result.n8n = line.slice(4);
                if (line.startsWith('LOAD:')) result.load = line.slice(5);
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    });
}

function getTunnelStatus(req, res) {
    const ports = [
        { name: 'ollama', port: 11434 },
        { name: 'ssh', port: 2222 },
        { name: 'mc', port: 8899 },
        { name: 'openclaw', port: 3100 },
        { name: 'litellm', port: 4000 },
    ];
    const vpsIP = '86.48.27.45';
    const results = [];
    let pending = ports.length;

    ports.forEach(p => {
        const cmd = `ssh -o ConnectTimeout=3 -o BatchMode=yes contabo-vps "nc -z -w2 localhost ${p.port} 2>/dev/null && echo UP || echo DOWN" 2>/dev/null || echo UNREACHABLE`;
        exec(cmd, { timeout: 8000 }, (err, stdout) => {
            const status = (stdout || '').trim();
            results.push({ name: p.name, port: p.port, status: status === 'UP' ? 'up' : 'down' });
            pending--;
            if (pending === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(results));
            }
        });
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
        'ai.dwe.agent-heartbeat-nicole':        { name: 'CIO Heartbeat',        group: 'heartbeat',  scheduled: true  },
        'ai.dwe.agent-heartbeat-nicole-weekly': { name: 'CIO Weekly Review',    group: 'heartbeat',  scheduled: true  },
        'ai.dwe.agent-heartbeat-anita-finance': { name: 'COO Finance Review',   group: 'heartbeat',  scheduled: true  },
        'ai.dwe.agent-heartbeat-anita-email-digest': { name: 'COO Email Digest', group: 'heartbeat', scheduled: true },
        'ai.dwe.agent-heartbeat-cfo':          { name: 'CFO Heartbeat',        group: 'heartbeat',  scheduled: true  },

        // ── Task Follow-Up (2h cycles) ──
        'ai.dwe.ce-task-followup':              { name: 'CE Follow-Up',         group: 'followup',   scheduled: true  },
        'ai.dwe.cto-task-followup':             { name: 'CTO Follow-Up',        group: 'followup',   scheduled: true  },
        'ai.dwe.nicole-task-followup':          { name: 'CIO Follow-Up',        group: 'followup',   scheduled: true  },
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

    exec('launchctl list | grep -E "ai\\.openclaw|ai\\.dwe|com\\.dwe|com\\.missioncontrol"', { timeout: 5000 }, (error, stdout) => {
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

function getDaemonHealth(req, res) {
    exec('launchctl list 2>/dev/null | grep "ai\\."', { timeout: 5000 }, (error, stdout) => {
        const daemons = [];
        if (!error && stdout) {
            stdout.trim().split('\n').forEach(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 3) {
                    const pidRaw = parts[0];
                    const exitCodeRaw = parts[1];
                    const label = parts[2];
                    // Skip OpenClaw app internals
                    if (label.includes('sparkle') || label.startsWith('application.')) return;
                    const pid = pidRaw !== '-' ? pidRaw : null;
                    const exitCode = exitCodeRaw !== '-' ? parseInt(exitCodeRaw, 10) : null;
                    let status;
                    if (pid) {
                        status = 'running';
                    } else if (exitCode === 0 || exitCode === null) {
                        status = 'ok';
                    } else {
                        status = 'error';
                    }
                    daemons.push({ label, pid, exitCode, status });
                }
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(daemons));
    });
}

// ── Live Ops Board ─────────────────────────────────────────────────────────────
// Assembles a flat list of status rows from multiple sources.
// Each row: { id, label, detail, status }   status: 'ok' | 'warn' | 'error' | 'idle'
async function getOpsBoardData() {
    const rows = [];
    const now = Date.now();

    // Helper: ms → "Xm ago" / "Xh ago"
    function ago(ms) {
        if (!ms || ms <= 0) return 'never';
        const diff = now - ms;
        if (diff < 0) return 'just now';
        if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
        if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
        return `${Math.round(diff / 86400000)}d ago`;
    }

    // 1. Mission Control Server (self-check)
    rows.push({ id: 'MC-01', label: 'Mission Control', detail: `Port ${PORT} · online`, status: 'ok' });

    // 2. Ollama
    try {
        const ollamaRes = await new Promise(resolve => {
            const r = http.get('http://127.0.0.1:11434/api/tags', res => {
                let d = ''; res.on('data', c => d += c);
                res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
            });
            r.on('error', () => resolve(null));
            r.setTimeout(4000, () => { r.destroy(); resolve(null); });
        });
        const modelCount = ollamaRes && ollamaRes.models ? ollamaRes.models.length : 0;
        rows.push({ id: 'ML-01', label: 'Ollama (Local LLM)', detail: ollamaRes ? `${modelCount} model${modelCount !== 1 ? 's' : ''} loaded` : 'Not responding', status: ollamaRes ? 'ok' : 'error' });
    } catch(e) {
        rows.push({ id: 'ML-01', label: 'Ollama (Local LLM)', detail: 'Not responding', status: 'error' });
    }

    // 3. Key daemons (taxonomy defined at module level as KEY_DAEMONS)
    const keyDaemons = KEY_DAEMONS;

    await new Promise(resolve => {
        exec('launchctl list 2>/dev/null | grep "ai\\."', { timeout: 5000 }, (error, stdout) => {
            const daemonMap = {};
            if (!error && stdout) {
                stdout.trim().split('\n').forEach(line => {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 3) {
                        const pid = parts[0] !== '-' ? parts[0] : null;
                        const exitCode = parts[1] !== '-' ? parseInt(parts[1], 10) : null;
                        daemonMap[parts[2]] = { pid, exitCode };
                    }
                });
            }
            keyDaemons.forEach(d => {
                const info = daemonMap[d.label];
                const hs   = healingState[d.label];
                if (!info) {
                    rows.push({ id: d.id, label: d.name, detail: 'Not loaded', status: 'idle' });
                } else if (info.pid) {
                    rows.push({ id: d.id, label: d.name, detail: `PID ${info.pid} · running`, status: 'ok' });
                } else if (info.exitCode === 0 || info.exitCode === null) {
                    rows.push({ id: d.id, label: d.name, detail: 'Scheduled · last exit 0', status: 'ok' });
                } else if (hs && hs.status === 'recovering') {
                    rows.push({ id: d.id, label: d.name, detail: `Auto-recovering… (attempt ${hs.restartCount})`, status: 'recovering' });
                } else if (hs && hs.status === 'escalated') {
                    rows.push({ id: d.id, label: d.name, detail: `Escalated · ${hs.restartCount} attempts failed`, status: 'escalated' });
                } else {
                    rows.push({ id: d.id, label: d.name, detail: `Exit ${info.exitCode} · check logs`, status: 'error' });
                }
            });
            resolve();
        });
    });

    // 4. Last backup time
    const ocBackupMs = lastOpenclawBackupTime ? lastOpenclawBackupTime.getTime() : 0;
    const backupAge = now - ocBackupMs;
    rows.push({
        id: 'BK-01',
        label: 'OpenClaw Backup',
        detail: backupInProgress
            ? 'Auto-backup running…'
            : ocBackupMs ? `Last: ${ago(ocBackupMs)}` : 'No backup found',
        status: backupInProgress
            ? 'recovering'
            : backupAge < 86400000 ? 'ok' : backupAge < 172800000 ? 'warn' : 'error'
    });

    // 5. Pipeline leads count (from pipeline endpoint cache if available)
    try {
        const pipeline = await localFetch('/mc/pipeline');
        if (pipeline) {
            const total = pipeline.totalLeads || pipeline.total || 0;
            const responded = pipeline.responded || pipeline.responded_count || 0;
            rows.push({ id: 'PL-05', label: 'Pipeline Leads', detail: `${total} total · ${responded} responded`, status: total > 0 ? 'ok' : 'idle' });
        }
    } catch(e) {}

    // 6. n8n (check if webhook host reachable — we just check the mc/n8n-workflows cache)
    try {
        const n8n = await localFetch('/mc/n8n-workflows');
        if (n8n && Array.isArray(n8n.workflows)) {
            const active = n8n.workflows.filter(w => w.active).length;
            const total = n8n.workflows.length;
            rows.push({ id: 'N8-01', label: 'n8n Workflows', detail: `${active} active / ${total} total`, status: active > 0 ? 'ok' : 'warn' });
        } else {
            rows.push({ id: 'N8-01', label: 'n8n Workflows', detail: n8n ? 'Data unavailable' : 'Not reachable', status: 'warn' });
        }
    } catch(e) {
        rows.push({ id: 'N8-01', label: 'n8n Workflows', detail: 'Not reachable', status: 'error' });
    }

    return { rows, ts: new Date().toISOString() };
}

function getOpsBoard(req, res) {
    getOpsBoardData().then(data => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(data));
    }).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rows: [], ts: new Date().toISOString(), error: e.message }));
    });
}

function getAgentRouting(req, res) {
    const agents = [
        { id: 'cto',            name: 'Steve',          emoji: '💻', role: 'Technical & infrastructure',     channel: 'Telegram @DWE_CTO_Bot' },
        { id: 'anita',          name: 'Anita',          emoji: '⚙️', role: 'Operations & task coordination', channel: 'Telegram anita-coo' },
        { id: 'nicole',         name: 'Nicole',         emoji: '📋', role: 'Revenue & intelligence (CIO)',   channel: 'Telegram nicole-cos' },
        { id: 'chief-engineer', name: 'Chief Engineer', emoji: '🔧', role: 'Infrastructure & daemons',       channel: 'OpenClaw session' },
        { id: 'cfo',            name: 'Fran',           emoji: '💰', role: 'Finance & budgets',              channel: 'Telegram @DWE_CFO_Bot' },
        { id: 'main',           name: 'Main',           emoji: '🚀', role: 'Primary assistant (web chat)',   channel: 'OpenClaw webchat' },
        { id: 'jarvis',         name: 'Jarvis',         emoji: '⚡', role: 'Execution layer (headless)',     channel: 'Delegation webhook' },
        { id: 'herald',         name: 'Herald',         emoji: '🔍', role: 'SEO & AISO specialist',          channel: 'OpenClaw session' },
        { id: 'validator',      name: 'Victor',         emoji: '✅', role: 'QA & validation',               channel: 'OpenClaw session' }
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents, timestamp: new Date().toISOString() }));
}

// Notion API — fetchAllNotionTasks imported from dwe-widget-api.js

async function getNotionTasks(req, res) {
    try {
        console.log('Fetching all Notion tasks...');
        const allTasks = await fetchAllNotionTasks();
        console.log(`Fetched ${allTasks.length} total tasks`);

        const stats = {
            total: allTasks.length,
            inProgress: allTasks.filter(t => t.status === 'In Progress' || t.status === 'In progress').length,
            completed: allTasks.filter(t => t.status === 'Done' || t.status === 'Completed' || t.status === 'Complete' || t.status === 'Review').length,
            todo: allTasks.filter(t => t.status === 'To Do' || t.status === 'To do' || t.status === 'No Status' || t.status === 'Not started').length,
            maxIdNumber: allTasks.reduce((max, t) => Math.max(max, t.idNumber || 0), 0)
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            tasks: allTasks.slice(0, 100),
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

async function getAgentTasks(req, res) {
    try {
        const allTasks = await fetchAllNotionTasks();

        // Role → agent display config
        const AGENTS = [
            { role: 'CEO',            name: 'Sidney',         icon: '👑',  id: 'ceo' },
            { role: 'CTO',            name: 'Steve',          icon: '⚙️',  id: 'cto' },
            { role: 'COO',            name: 'Anita',          icon: '📋',  id: 'anita' },
            { role: 'CIO',            name: 'Nicole',         icon: '📈',  id: 'nicole' },
            { role: 'CE',             name: 'Chief Engineer', icon: '🔧',  id: 'ce' },
            { role: 'CFO',            name: 'Fran',           icon: '💰',  id: 'cfo' },
            { role: 'Jarvis',         name: 'Jarvis',         icon: '⚡',  id: 'jarvis' },
            { role: 'QA',             name: 'Victor',         icon: '✅',  id: 'validator' },
            { role: 'Unassigned',     name: 'Unassigned',     icon: '📥',  id: 'main' },
        ];
        const DONE_STATUSES = new Set(['Done', 'Completed', 'Complete', 'Review', 'Archived']);
        const PRIORITY_ORDER = ['Critical', 'High', 'Medium', 'Low', 'No Priority'];

        // Normalize role aliases so tasks don't fall into Unassigned
        const ROLE_ALIASES = { 'Chief Engineer': 'CE', 'Chief': 'CTO', 'CSO': 'CIO' };
        for (const t of allTasks) {
            if (ROLE_ALIASES[t.role]) t.role = ROLE_ALIASES[t.role];
        }

        const KNOWN_ROLES = new Set(AGENTS.map(a => a.role));
        const ACTIONABLE_STATUSES = new Set(['Not started', 'Not Started', 'In Progress', 'In progress']);
        const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

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

            // Actionable tasks: Status ∈ {Not Started, In Progress} AND (dueDate ≤ today OR no dueDate)
            // QA role: show ALL open tasks regardless of due date (QA tasks depend on other agents finishing first)
            const actionable = role === 'QA'
                ? open.filter(t => !DONE_STATUSES.has(t.status))
                : tasks.filter(t =>
                    ACTIONABLE_STATUSES.has(t.status) &&
                    (!t.dueDate || t.dueDate <= todayStr)
                );
            const actionableByPriority = {};
            for (const p of PRIORITY_ORDER) actionableByPriority[p] = 0;
            for (const t of actionable) {
                const p = t.priority || 'No Priority';
                actionableByPriority[p] = (actionableByPriority[p] || 0) + 1;
            }
            const actionableOverdue = actionable.filter(t => t.dueDate && t.dueDate < todayStr).length;
            const actionableNoDue = actionable.filter(t => !t.dueDate).length;
            // Include task list for dashboard display (sorted: overdue first, then by priority)
            const PRIO_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };
            const actionableList = actionable
                .map(t => ({
                    id: t.idNumber,
                    pageId: t.id,
                    name: t.name,
                    status: t.status,
                    priority: t.priority,
                    dueDate: t.dueDate || null,
                    isOverdue: !!(t.dueDate && t.dueDate < todayStr),
                }))
                .sort((a, b) => {
                    // Overdue first
                    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
                    // Then by priority
                    return (PRIO_RANK[a.priority] ?? 4) - (PRIO_RANK[b.priority] ?? 4);
                });

            return {
                id, role, name, icon,
                total: tasks.length, open: open.length, done: done.length, overdue, byPriority,
                actionable: actionableList.length,
                actionableOverdue,
                actionableNoDue,
                actionableByPriority,
                actionableList,
            };
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
    exec('cd ~/mission-control-server && git add -A', { timeout: 15000 }, (addError, addStdout, addStderr) => {
        if (addError) {
            console.error('Git add error:', addError);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Git add failed', details: addError.message }));
            return;
        }
        console.log('Git add completed');
        
        // Step 2: git commit
        exec('cd ~/mission-control-server && git commit -m "Backup: ' + new Date().toISOString() + '"', { timeout: 15000 }, (commitError, commitStdout, commitStderr) => {
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
            exec('cd ~/mission-control-server && git push', { timeout: 30000 }, (pushError, pushStdout, pushStderr) => {
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

// Pinecone dwe-v2 → dwe-v3 Migration Status
function getMigrationStatus(req, res) {
    const RESEED_LOG = '/Users/elf-6/openclaw/logs/reseed-v3.log';
    const PINECONE_KEY = process.env.PINECONE_API_KEY || '';
    const result = { v3Vectors: null, reseedTotal: 1516, reseedProcessed: 0, reseedFailed: 0, isRunning: false, complete: false, lastLine: '' };

    // Parse reseed log for progress
    try {
        if (fs.existsSync(RESEED_LOG)) {
            const lines = fs.readFileSync(RESEED_LOG, 'utf8').split('\n').filter(l => l.trim());
            result.lastLine = lines[lines.length - 1] || '';
            // Count queued files
            result.reseedProcessed = lines.filter(l => l.includes('Queued:')).length;
            // Count failures
            result.reseedFailed = lines.filter(l => l.includes('FAILED to copy')).length;
            // Check if reseed script said complete
            const scriptDone = lines.some(l => l.includes('RE-SEED COMPLETE'));
            // Check if running
            const { execSync } = require('child_process');
            try { result.isRunning = execSync('pgrep -f reseed_v3.py 2>/dev/null', { stdio: 'pipe' }).toString().trim().length > 0; } catch(e) {}
            // Check if seed watcher still has files to process
            const SEED_DIR = '/Users/elf-6/openclaw/shared/4_Ready_to_Seed';
            let queueCount = 0;
            try {
                queueCount = fs.readdirSync(SEED_DIR).filter(f => !f.startsWith('.') && f !== 'placeholder.txt' && f !== '.gitkeep').length;
            } catch(e) {}
            result.queueRemaining = queueCount;
            // Only truly complete when script is done AND queue is drained
            result.complete = scriptDone && queueCount === 0 && !result.isRunning;
        }
    } catch(e) {}

    // Query Pinecone dwe-v3 stats
    if (PINECONE_KEY) {
        const postData = '{}';
        const opts = {
            hostname: 'dwe-v3-lm4owoj.svc.aped-4627-b74a.pinecone.io',
            path: '/describe_index_stats',
            method: 'POST',
            headers: { 'Api-Key': PINECONE_KEY, 'Content-Type': 'application/json', 'Content-Length': postData.length }
        };
        const preq = https.request(opts, pres => {
            let data = '';
            pres.on('data', c => data += c);
            pres.on('end', () => {
                try { result.v3Vectors = JSON.parse(data).totalVectorCount || 0; } catch(e) {}
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            });
        });
        preq.on('error', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        });
        preq.write(postData);
        preq.end();
    } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
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

// TeamoRouter credits — cached, refreshed every 5 minutes
const TEAMOROUTER_API_KEY = (() => {
    if (process.env.TEAMOROUTER_API_KEY && !process.env.TEAMOROUTER_API_KEY.startsWith('your_')) return process.env.TEAMOROUTER_API_KEY;
    try { return fs.readFileSync(`${process.env.HOME}/.openclaw/.env`, 'utf8').match(/TEAMOROUTER_API_KEY="?([^"\n]+)"?/)?.[1]?.trim() || ''; } catch(e) { return ''; }
})();

let teamoCreditsCache = null;
const TEAMO_CREDITS_TTL = 5 * 60 * 1000;

function fetchTeamoRouterCredits() {
    if (!TEAMOROUTER_API_KEY) return;
    const opts = {
        hostname: 'router.teamolab.com',
        path: '/v1/billing/me/balance',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${TEAMOROUTER_API_KEY}` }
    };
    const req = https.request(opts, ores => {
        let data = '';
        ores.on('data', c => data += c);
        ores.on('end', () => {
            try {
                const j = JSON.parse(data);
                const d = j.data || j;
                const available = parseFloat(d.available_balance) || 0;
                const spent = parseFloat(d.lifetime_spent) || 0;
                const total = available + spent;
                teamoCreditsCache = { remaining: available, usage: spent, total, status: d.status || 'unknown', fetchedAt: Date.now() };
            } catch(e) {}
        });
    });
    req.on('error', () => {});
    req.end();
}
fetchTeamoRouterCredits();
setInterval(fetchTeamoRouterCredits, TEAMO_CREDITS_TTL);

function getTeamoRouterCredits(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!TEAMOROUTER_API_KEY) { res.end(JSON.stringify({ error: 'No API key', remaining: null })); return; }
    res.end(JSON.stringify(teamoCreditsCache || { remaining: null, fetchedAt: null }));
}

// ══════════════════════════════════════════════════════════════════════
// n8n Workflow Inventory — cached, refreshed every 3 minutes
// ══════════════════════════════════════════════════════════════════════
const N8N_API_KEY = (() => {
    if (process.env.N8N_API_KEY && !process.env.N8N_API_KEY.startsWith('your_')) return process.env.N8N_API_KEY;
    try { return fs.readFileSync(`${process.env.HOME}/.openclaw/.env`, 'utf8').match(/N8N_API_KEY="?([^"\n]+)"?/)?.[1]?.trim() || ''; } catch(e) { return ''; }
})();

let n8nWorkflowsCache = null;
let n8nWorkflowsCacheTime = 0;
const N8N_WF_TTL = 3 * 60 * 1000;

const N8N_WORKFLOW_GROUPS = [
    { id: 'strategic', label: 'Strategic Pipeline', icon: '🎯', patterns: [
        'RSS', 'Reddit', 'Email Monitor', 'Email Newsletter', 'Google Search', 'Twitter', 'Telegram Channel',
        'ProductHunt', 'Product Hunt', 'Anita Morning', 'Tri-Factor', 'Substack', 'Manual.*Intake',
        'Daily Top', 'Setup.*Sheet', 'Opportunity'
    ]},
    { id: 'gmail', label: 'Gmail & Email', icon: '📧', patterns: ['Gmail'] },
    { id: 'brain', label: 'Brain & Knowledge', icon: '🧠', patterns: ['Brain', 'Pinecone', 'openclaw', 'Seed', 'RAG', 'Ingest'] },
    { id: 'ops', label: 'Operations & Monitoring', icon: '📊', patterns: ['COO', 'Monitor', 'Alert', 'Heartbeat', 'Health', 'Notion', 'Agent'] },
    { id: 'utility', label: 'Utility & Integration', icon: '🔧', patterns: ['Webhook', 'BTCC', 'Price', 'Calendar', 'Backup'] },
];

function deriveTriggerType(workflow) {
    const nodes = workflow.nodes || [];
    for (const n of nodes) {
        const t = (n.type || '').toLowerCase();
        if (t.includes('scheduletrigger') || t.includes('cron')) return 'schedule';
        if (t.includes('webhook')) return 'webhook';
        if (t.includes('executeworkflowtrigger')) return 'sub-workflow';
        if (t.includes('telegramtrigger')) return 'trigger';
        if (t.includes('imapEmail') || t.includes('imap')) return 'schedule';
        if (t.includes('trigger')) return 'trigger';
    }
    return 'manual';
}

function categorizeWorkflow(name) {
    for (const group of N8N_WORKFLOW_GROUPS) {
        for (const pat of group.patterns) {
            if (new RegExp(pat, 'i').test(name)) return group.id;
        }
    }
    return 'other';
}

function fetchN8nWorkflows() {
    return new Promise((resolve, reject) => {
        if (!N8N_API_KEY) { reject(new Error('No N8N_API_KEY')); return; }
        const opts = {
            hostname: 'n8n.tvcpulse.com',
            path: '/api/v1/workflows?limit=250',
            method: 'GET',
            headers: { 'X-N8N-API-KEY': N8N_API_KEY }
        };
        const req = https.request(opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const workflows = (parsed.data || []).filter(w => !w.isArchived);
                    // Build groups
                    const groupMap = {};
                    for (const g of N8N_WORKFLOW_GROUPS) {
                        groupMap[g.id] = { id: g.id, label: g.label, icon: g.icon, workflows: [], activeCount: 0, totalCount: 0 };
                    }
                    groupMap['other'] = { id: 'other', label: 'Other / Legacy', icon: '📦', workflows: [], activeCount: 0, totalCount: 0 };

                    let totalActive = 0, totalInactive = 0;
                    for (const wf of workflows) {
                        const groupId = categorizeWorkflow(wf.name);
                        const triggerType = deriveTriggerType(wf);
                        const item = {
                            id: wf.id,
                            name: wf.name,
                            active: wf.active,
                            triggerType,
                            updatedAt: wf.updatedAt,
                            tags: (wf.tags || []).map(t => t.name || t)
                        };
                        groupMap[groupId].workflows.push(item);
                        groupMap[groupId].totalCount++;
                        if (wf.active) { groupMap[groupId].activeCount++; totalActive++; }
                        else { totalInactive++; }
                    }
                    // Sort workflows: active first, then alphabetical
                    for (const g of Object.values(groupMap)) {
                        g.workflows.sort((a, b) => {
                            if (a.active !== b.active) return a.active ? -1 : 1;
                            return a.name.localeCompare(b.name);
                        });
                    }
                    // Build ordered groups array (skip empty)
                    const groupOrder = ['strategic', 'gmail', 'brain', 'ops', 'utility', 'other'];
                    const groups = groupOrder.map(id => groupMap[id]).filter(g => g.totalCount > 0);

                    const result = {
                        groups,
                        summary: { total: workflows.length, active: totalActive, inactive: totalInactive },
                        timestamp: new Date().toISOString()
                    };
                    n8nWorkflowsCache = result;
                    n8nWorkflowsCacheTime = Date.now();
                    resolve(result);
                } catch(e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

function getN8nWorkflows(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!N8N_API_KEY) {
        res.end(JSON.stringify({ error: 'No N8N_API_KEY configured', groups: [], summary: { total: 0, active: 0, inactive: 0 } }));
        return;
    }
    if (n8nWorkflowsCache && (Date.now() - n8nWorkflowsCacheTime) < N8N_WF_TTL) {
        res.end(JSON.stringify(n8nWorkflowsCache));
        return;
    }
    fetchN8nWorkflows().then(data => {
        res.end(JSON.stringify(data));
    }).catch(e => {
        // Return stale cache if available
        if (n8nWorkflowsCache) { res.end(JSON.stringify(n8nWorkflowsCache)); return; }
        res.end(JSON.stringify({ error: e.message, groups: [], summary: { total: 0, active: 0, inactive: 0 } }));
    });
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

// Tailscale mesh status — poll every 60s
let tailscaleCache = { devices: [], allOnline: false, ts: null };
function pollTailscale() {
    exec('/usr/local/bin/tailscale status --json 2>/dev/null', { timeout: 10000 }, (err, stdout) => {
        if (err || !stdout) {
            tailscaleCache = { devices: [], allOnline: false, running: false, ts: Date.now() };
            return;
        }
        try {
            const data = JSON.parse(stdout);
            // Friendly name overrides for Tailscale hostnames
            const tsNameMap = { 'vmi3199495': 'dwe-ops', 'n8n-tvc': 'dwe-ops', 'localhost': 'iPhone' };
            function tsDisplayName(raw) { return tsNameMap[raw] || raw; }
            const devices = [];
            // Self
            if (data.Self) {
                const rawName = data.Self.HostName || 'self';
                devices.push({
                    name: tsDisplayName(rawName),
                    ip: data.Self.TailscaleIPs ? data.Self.TailscaleIPs[0] : '',
                    os: data.Self.OS || '',
                    online: true
                });
            }
            // Peers
            for (const [key, peer] of Object.entries(data.Peer || {})) {
                const rawName = peer.HostName || key;
                devices.push({
                    name: tsDisplayName(rawName),
                    ip: peer.TailscaleIPs ? peer.TailscaleIPs[0] : '',
                    os: peer.OS || '',
                    online: peer.Online || false,
                    lastSeen: peer.LastSeen || null
                });
            }
            const allOnline = devices.every(d => d.online);
            tailscaleCache = { devices, allOnline, running: true, ts: Date.now() };
        } catch (e) {
            tailscaleCache = { devices: [], allOnline: false, running: false, error: e.message, ts: Date.now() };
        }
    });
}
pollTailscale();
setInterval(pollTailscale, 60000);

function getTailscaleStatus(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tailscaleCache));
}

function getN8nUptime(req, res) {
    const { exec: execSsh } = require('child_process');
    const cmd = 'ssh -o ConnectTimeout=5 -i /Users/elf-6/.ssh/remote_access_key root@86.48.27.45 "uptime -s && docker inspect -f \'{{.State.Running}}\' n8n-docker-caddy-n8n-1 2>/dev/null || echo false"';
    execSsh(cmd, { timeout: 10000 }, (err, stdout) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (err || !stdout.trim()) {
            res.end(JSON.stringify({ ok: false, bootTime: null, dockerRunning: null }));
            return;
        }
        const lines = stdout.trim().split('\n');
        const bootISO = new Date(lines[0].trim().replace(' ', 'T')).toISOString();
        const dockerRunning = lines[1] ? lines[1].trim() === 'true' : null;
        res.end(JSON.stringify({ ok: true, bootTime: bootISO, dockerRunning }));
    });
}

// ── Mesh & Access Status ──────────────────────────────────────────────────
// Checks SSH reachability, Tailscale ping, and Cloudflare proxy for each host.
function getMeshStatus(req, res) {
    const { exec: execMesh } = require('child_process');
    const https = require('https');

    // Helper: run a shell command, resolve true/false
    function shellCheck(cmd, timeoutMs) {
        return new Promise(resolve => {
            execMesh(cmd, { timeout: timeoutMs || 6000 }, (err) => resolve(!err));
        });
    }

    // Helper: HTTP GET check (resolve true if response received regardless of status)
    function httpCheck(url, timeoutMs) {
        return new Promise(resolve => {
            try {
                const req2 = https.get(url, { timeout: timeoutMs || 3000 }, (r) => {
                    r.resume(); // drain
                    resolve(true);
                });
                req2.on('error', () => resolve(false));
                req2.on('timeout', () => { req2.destroy(); resolve(false); });
                req2.setTimeout(timeoutMs || 3000);
            } catch(e) { resolve(false); }
        });
    }

    // Run all checks in parallel
    Promise.all([
        // elf-6 (Mac Mini)
        shellCheck('ssh -o ConnectTimeout=3 -o BatchMode=yes -o StrictHostKeyChecking=no -i /Users/elf-6/.ssh/id_ed25519 macmini exit 0 2>/dev/null', 6000),
        shellCheck('ssh -o ConnectTimeout=3 -o BatchMode=yes -o StrictHostKeyChecking=no -i /Users/elf-6/.ssh/id_ed25519 elf-6@100.78.240.29 exit 2>/dev/null', 6000),
        httpCheck('https://brain.tvcpulse.com', 3000),
        // dwe-ops (Contabo VPS)
        shellCheck('ssh -o ConnectTimeout=3 -o BatchMode=yes -o StrictHostKeyChecking=no -i /Users/elf-6/.ssh/remote_access_key root@86.48.27.45 exit 0 2>/dev/null', 7000),
        shellCheck('ssh -o ConnectTimeout=3 -o BatchMode=yes -o StrictHostKeyChecking=no -i /Users/elf-6/.ssh/remote_access_key root@100.99.34.109 exit 2>/dev/null', 6000),
        // overlord (iPhone) — no SSH, use ping
        shellCheck('ping -c 1 -t 2 100.88.99.61 > /dev/null 2>&1', 5000),
    ]).then(([elfSshDirect, elfTailscalePing, elfCloudflare, opsSshDirect, opsTailscalePing, overlordPing]) => {
        const hosts = [
            {
                name: 'elf-6',
                role: 'Mac Mini · AI Hub',
                access: [
                    { method: 'SSH Direct',   address: 'ssh macmini',              ok: elfSshDirect      },
                    { method: 'SSH Tailscale', address: 'ssh elf-6@100.78.240.29',  ok: elfTailscalePing  },
                    { method: 'Cloudflare',    address: 'brain.tvcpulse.com',       ok: elfCloudflare     },
                ]
            },
            {
                name: 'dwe-ops',
                role: 'Contabo VPS · n8n + Mailcow + EspoCRM',
                access: [
                    { method: 'SSH Direct',    address: 'ssh dwe-ops (86.48.27.45)',      ok: opsSshDirect    },
                    { method: 'SSH Tailscale', address: 'ssh dwe-ops-ts (100.99.34.109)', ok: opsTailscalePing },
                ]
            },
            {
                name: 'overlord',
                role: 'iPhone · Mobile',
                access: [
                    { method: 'Tailscale', address: '100.88.99.61', ok: overlordPing },
                ]
            }
        ];
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ hosts, timestamp: new Date().toISOString() }));
    }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    });
}

function getSshTunnels(req, res) {
    const { exec: execLocal } = require('child_process');
    // Check actual port reachability on dwe-ops via SSH
    // This is reliable — launchctl PID check was unreliable (shows DOWN even when ports are UP)
    const cmd = 'ssh -o ConnectTimeout=5 -o BatchMode=yes -i /Users/elf-6/.ssh/remote_access_key root@86.48.27.45 "ss -tlnp | grep -E \':11434|:2222|:8899|:3100|:4000\'" 2>/dev/null';
    execLocal(cmd, { timeout: 12000 }, (err, stdout) => {
        const sshOk = !err;
        const output = stdout || '';
        // Parse which ports are bound
        const ports = {
            '11434': /[:\s]11434[\s\b]/.test(output) || output.includes(':11434'),
            '2222':  /[:\s]2222[\s\b]/.test(output)  || output.includes(':2222'),
            '8899':  /[:\s]8899[\s\b]/.test(output)  || output.includes(':8899'),
            '3100':  /[:\s]3100[\s\b]/.test(output)  || output.includes(':3100'),
            '4000':  /[:\s]4000[\s\b]/.test(output)  || output.includes(':4000'),
        };
        const tunnelUp = sshOk && Object.values(ports).some(Boolean);
        // Legacy fields for backward compat with old fetchTunnels() caller path
        const reverseUp = sshOk && ports['11434'];
        const forwardUp = sshOk;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            tunnelUp,
            ports,
            sshOk,
            // legacy fields
            reverse: { up: reverseUp, note: 'Ollama · SSH · Dashboard → VPS' },
            forward: { up: forwardUp, note: '86.48.27.45' }
        }));
    });
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
    exec('/sbin/ping -c 1 -W 2000 1.1.1.1 > /dev/null 2>&1 && echo ok || echo fail', { timeout: 5000 }, (err, stdout) => {
        if ((stdout || '').trim() === 'ok') lastPingSuccess = Date.now();
    });
}
runInternetPing(); // immediate on boot
setTimeout(runInternetPing, 3000); // second check 3s later in case first races with startup
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

// Activity blip log — for services whose traffic is server-side (brain, openrouter)
// Scripts POST to /mc/activity?service=brain to register activity
// activityLog declared near top of file — see handleActivity

// Network traffic monitor — per-service via nettop + total via netstat, refreshed every 5s
const SERVICE_IP_MAP = {
    // prefix → service name (matched against connection remote IPs)
    '208.103.161': 'notion',
    '86.48.27.45': 'n8n',
    '104.18.2': 'openrouter',
    '104.18.3': 'openrouter',
    '140.82.11': 'github',
    '34.36.155': 'brain',
    '3.220.89': 'brain',
    '3.233.180': 'brain',
    '3.210.104': 'brain',
    '149.154': 'telegram',
    '91.108': 'telegram',
    '160.79.104': 'openrouter',  // Anthropic/Claude API (openclaw gateway calls)
};
let trafficCache = {
    total: { bytesIn: 0, bytesOut: 0, mbpsIn: 0, mbpsOut: 0 },
    services: { notion: { bytesIn: 0, bytesOut: 0 }, n8n: { bytesIn: 0, bytesOut: 0 }, openrouter: { bytesIn: 0, bytesOut: 0 }, github: { bytesIn: 0, bytesOut: 0 }, brain: { bytesIn: 0, bytesOut: 0 }, telegram: { bytesIn: 0, bytesOut: 0 } },
    iface: null, ts: null
};
let prevServiceCounters = null;
let prevServiceTs = null;

function sampleTraffic() {
    // Run both nettop (per-connection) and netstat (total) in parallel
    exec("nettop -L 1 -n -x -J bytes_in,bytes_out 2>/dev/null", { timeout: 8000 }, (err, nettopOut) => {
        exec("netstat -ib | grep -E '^en[01].*<Link'", { timeout: 5000 }, (err2, netstatOut) => {
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
            const svcBytes = { notion: { bi: 0, bo: 0 }, n8n: { bi: 0, bo: 0 }, openrouter: { bi: 0, bo: 0 }, github: { bi: 0, bo: 0 }, brain: { bi: 0, bo: 0 }, telegram: { bi: 0, bo: 0 } };
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
                        const mbpsIn  = parseFloat(((dTotalIn  / elapsed) * 8 / 1000000).toFixed(2));
                        const mbpsOut = parseFloat(((dTotalOut / elapsed) * 8 / 1000000).toFixed(2));
                        trafficCache = {
                            total: {
                                bytesIn:  Math.round(dTotalIn  / elapsed),
                                bytesOut: Math.round(dTotalOut / elapsed),
                                mbpsIn,
                                mbpsOut
                            },
                            services,
                            iface,
                            ts: now
                        };
                        // Mirror Mac Mini bandwidth into localTrafficCache for orange ring
                        localTrafficCache.macMbpsIn  = mbpsIn;
                        localTrafficCache.macMbpsOut = mbpsOut;
                    }
                }
            }
            prevServiceCounters = { totalIn, totalOut };
            prevServiceTs = now;
        });
    });
}
sampleTraffic();
setInterval(sampleTraffic, 15000);  // was 5s — 15s is plenty for traffic counters

function getTraffic(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...trafficCache, activity: activityLog }));
}

// Local process traffic — monitors inter-process connections within Mac Mini
let localTrafficCache = { ollama: 0, mcp: 0, gateway: 0, memPct: 0, cpuPct: 0, macMbpsIn: 0, macMbpsOut: 0, routerDrops: 0, routerErrors: 0, routerAlert: false, routerMbps: 0, routerExtIp: '', ts: null };
let lastSystemHealth = null; // populated by getSystemHealth, read by sampleLocalTraffic

function sampleLocalTraffic() {
    // Ollama: connections + CPU — high CPU = actively generating tokens
    // n8n connects to Ollama via reverse SSH tunnel (ai.dwe.ollama-tunnel)
    // which shows as ssh process on 127.0.0.1:11434 — detect by ssh PID in lsof
    // Run all 6 checks in parallel with Promise.all (was 5-deep nested callbacks)
    const run = (cmd) => new Promise(resolve => {
        exec(cmd, { timeout: 5000 }, (err, stdout) => resolve((stdout || '').trim()));
    });
    Promise.all([
        run("lsof -i :11434 -n -P 2>/dev/null | grep ESTABLISHED"),
        run("ps -p 924 -o %cpu= 2>/dev/null"),
        run("ps -p 896 -o %cpu= 2>/dev/null"),
        run("lsof -p 856 -n -P 2>/dev/null | grep -c ESTABLISHED"),
        run("top -l 1 -n 0 2>/dev/null | awk '/CPU usage/ {gsub(/%/,\"\"); for(i=1;i<=NF;i++) if($i==\"idle\") idle=$(i-1); printf \"%.1f\", 100-idle}'"),
        run("vm_stat | awk '/Pages (free|active|inactive|wired down|purgeable|occupied by compressor)/ {gsub(/\\./,\"\"); v[NR]=$NF} END {tot=0; avail=0; for(i in v) tot+=v[i]; avail=v[1]+v[3]+v[5]; printf \"%.1f\", (1-avail/tot)*100}'")
    ]).then(([ollamaRaw, cpuOut, gwCpu, rdOut, cpuRaw, memRaw]) => {
        const ollamaLines = ollamaRaw.split('\n').filter(l => l.length > 0);
        const ollamaConns = ollamaLines.length;
        const n8nToOllama = ollamaLines.some(l => /^ssh\s/.test(l)) ? 1 : 0;
        const ollamaCpu = parseFloat(cpuOut || '0') || 0;
        const ollamaActivity = ollamaConns > 0
            ? Math.min(6, Math.max(1, ollamaConns + Math.round(ollamaCpu / 20)))
            : 0;
        const gwCpuVal = parseFloat(gwCpu || '0') || 0;
        const gatewayConns = gwCpuVal > 1 ? Math.min(5, 1 + Math.round(gwCpuVal / 5)) : 1;
        const mcpConns = parseInt(rdOut || '0') || 0;
        const cpuPct = parseFloat(cpuRaw || '0') || 0;
        const memPct = parseFloat(memRaw || '0') || 0;
        localTrafficCache = {
            ...localTrafficCache,
            ollama: ollamaActivity,
            n8nOllama: n8nToOllama ? Math.max(2, ollamaActivity) : 0,
            mcp: mcpConns,
            gateway: gatewayConns,
            memPct,
            cpuPct,
            ts: Date.now()
        };
    }).catch(() => {});
}
sampleLocalTraffic();
setInterval(sampleLocalTraffic, 15000);  // was 5s — 15s reduces exec() churn

// Router health — poll Nokia BGW320-505 AT&T gateway (no auth required from LAN)
let lastRouterCounters = null;
let lastRouterBytes = null;
let lastRouterPollTs = null;
function sampleRouterHealth() {
    const http = require('http');
    http.get('http://192.168.1.254/cgi-bin/broadbandstatistics.ha', res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
            const extract = (label) => {
                const m = body.match(new RegExp(label + '[\\s\\S]{0,300}?<td[^>]*>\\s*(\\d+)'));
                return m ? parseInt(m[1]) : 0;
            };
            const extractStr = (label) => {
                const m = body.match(new RegExp(label + '[\\s\\S]{0,300}?<td[^>]*>\\s*([\\d.]+)'));
                return m ? m[1].trim() : '';
            };
            const extIp = extractStr('Broadband IPv4 Address');
            if (extIp) localTrafficCache.routerExtIp = extIp;
            const txDrops = extract('Transmit Drops');
            const rxDrops = extract('Receive Drops');
            const txErr   = extract('Transmit Errors');
            const rxErr   = extract('Receive Errors');
            const total = txDrops + rxDrops + txErr + rxErr;
            const alert = lastRouterCounters !== null && total > lastRouterCounters;
            lastRouterCounters = total;

            // Compute WAN throughput Mbps from actual byte counter deltas
            const txBytes  = extract('Transmit Bytes');
            const rxBytes  = extract('Receive Bytes');
            const now = Date.now();
            let routerMbps = 0;
            if (lastRouterBytes !== null && lastRouterPollTs !== null) {
                const elapsed = (now - lastRouterPollTs) / 1000; // seconds
                if (elapsed > 0) {
                    const txDelta  = Math.max(0, txBytes - lastRouterBytes.tx);
                    const rxDelta  = Math.max(0, rxBytes - lastRouterBytes.rx);
                    routerMbps = ((txDelta + rxDelta) * 8) / (elapsed * 1e6);
                }
            }
            lastRouterBytes = { tx: txBytes, rx: rxBytes };
            lastRouterPollTs = now;

            localTrafficCache.routerDrops  = txDrops + rxDrops;
            localTrafficCache.routerErrors = txErr + rxErr;
            localTrafficCache.routerAlert  = alert;
            localTrafficCache.routerMbps   = routerMbps;
        });
    }).on('error', () => {}); // silent if router unreachable
}
sampleRouterHealth();
setInterval(sampleRouterHealth, 30000);  // was 5s — router stats don't change that fast

function getLocalTraffic(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(localTrafficCache));
}

async function getSystemHealth(req, res) {
    const run = (cmd) => new Promise((resolve) => {
        exec(cmd, { timeout: 5000 }, (err, stdout) => resolve(stdout ? stdout.trim() : ''));
    });

    try {
        const [cpuOut, vmstatOut, memsizeOut, diskOut, chipOut, bootOut, gatewayPidOut, ipOut, gwOut, loadOut] = await Promise.all([
            run("/bin/ps -A -o %cpu | /usr/bin/awk '{s+=$1} END {printf \"%.1f\", s}'"),
            run("/usr/bin/vm_stat"),
            run("/usr/sbin/sysctl -n hw.memsize"),
            run("/bin/df -k / | /usr/bin/tail -1"),
            run("/usr/sbin/sysctl -n machdep.cpu.brand_string 2>/dev/null || /usr/sbin/sysctl -n hw.model"),
            run("/usr/sbin/sysctl -n kern.boottime | /usr/bin/grep -oE 'sec = [0-9]+' | /usr/bin/grep -oE '[0-9]+'"),
            run("launchctl list ai.openclaw.gateway 2>/dev/null | /usr/bin/grep '\"PID\"' | /usr/bin/tr -dc '0-9'"),
            run("IP=$(/usr/sbin/ipconfig getifaddr en0 2>/dev/null); [ -z \"$IP\" ] && IP=$(/usr/sbin/ipconfig getifaddr en1 2>/dev/null); [ -z \"$IP\" ] && IP=$(/usr/sbin/ipconfig getifaddr en2 2>/dev/null); [ -z \"$IP\" ] && IP=$(/usr/sbin/ipconfig getifaddr en8 2>/dev/null); echo \"$IP\""),
            run("/sbin/route -n get default 2>/dev/null | /usr/bin/awk '/gateway:/{print $2}'"),
            run("/usr/sbin/sysctl -n vm.loadavg | /usr/bin/awk '{print $2}'")
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

        // Load average (1-min)
        const load1Val = parseFloat(loadOut) || null;

        const sysPayload = {
            chip: chipOut || 'Apple M4',
            cores: logicalCPU,
            cpu:    { percent: cpuPct, raw: cpuRaw },
            memory: { totalGB: parseFloat(totalGB.toFixed(1)), usedGB: parseFloat(usedGB.toFixed(1)), percent: memPct },
            disk:   { totalGB: diskTotalGB, usedGB: diskUsedGB, freeGB: diskFreeGB, percent: diskPct },
            load1: load1Val !== null ? Math.round(load1Val * 100) / 100 : null,
            bootTime: bootISO,
            gatewayStartTime: gatewayStartISO,
            localIP: ipOut || null,
            defaultGateway: gwOut || null,
            timestamp: new Date().toISOString()
        };
        lastSystemHealth = sysPayload; // cache for sampleLocalTraffic
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sysPayload));
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
}

// --- Sidney Device Presence (iPhone → implies Watch on wrist) ---
let sidneyDevicesCache = { iphone: null, watch: null, fetchedAt: null };

// Known device identifiers
const IPHONE_MAC = 'c4:5b:ac:a3:d3:dd';

async function pollSidneyDevices() {
    const run = (cmd, timeoutMs = 5000) => new Promise((resolve) => {
        exec(cmd, { timeout: timeoutMs }, (err, stdout) => resolve(stdout ? stdout.trim() : ''));
    });

    try {
        // Ping to refresh ARP cache, then check ARP table by MAC
        await run('/sbin/ping -c 1 -t 1 192.168.1.114 2>/dev/null', 3000);

        const arpTable = await run('/usr/sbin/arp -an');
        let iphoneOnline = false, iphoneIP = null;
        const iphoneLine = arpTable.split('\n').find(l => l.includes(IPHONE_MAC));
        if (iphoneLine && !iphoneLine.includes('(incomplete)')) {
            iphoneOnline = true;
            const m = iphoneLine.match(/\(([0-9.]+)\)/);
            iphoneIP = m ? m[1] : null;
        }

        // Apple Watch connects via Bluetooth to iPhone — not directly on WiFi.
        // If iPhone is on the network, Sidney has his watch on (always wears it).
        sidneyDevicesCache = {
            iphone: { online: iphoneOnline, ip: iphoneIP, name: 'iPhone' },
            watch:  { online: iphoneOnline, ip: null, name: 'Apple Watch', viaIphone: true },
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

function getRecurringTaskStats(req, res) {
    const LOG_FILE = `${process.env.HOME}/openclaw/logs/recurring_task_handler.log`;
    try {
        const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
        const lines = content.split('\n');

        let lastRun = null;
        let lastFound = 0;
        let totalCreated = 0;
        let totalFailed = 0;
        let lastStatus = 'unknown';
        const taskNames = [];

        for (const line of lines) {
            // Last run start
            const startMatch = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] Starting recurring task handler/);
            if (startMatch) { lastRun = startMatch[1]; lastFound = 0; }

            // Found count
            const foundMatch = line.match(/Found (\d+) recurring tasks/);
            if (foundMatch) lastFound = parseInt(foundMatch[1]);

            // Success
            const successMatch = line.match(/SUCCESS: Created new instance of recurring task '([^']+)'/);
            if (successMatch) { totalCreated++; if (!taskNames.includes(successMatch[1])) taskNames.push(successMatch[1]); }

            // Failure
            if (line.includes('ERROR: Failed to create')) totalFailed++;

            // Completed
            if (line.includes('Recurring task handler completed')) lastStatus = 'completed';
        }

        // Check daemon status via launchctl
        let daemonLoaded = false;
        try {
            const { execSync } = require('child_process');
            const out = execSync('launchctl list ai.dwe.recurring-tasks 2>&1', { encoding: 'utf8', timeout: 3000 });
            daemonLoaded = !out.includes('Could not find');
        } catch(e) { daemonLoaded = false; }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            daemonActive: daemonLoaded,
            lastRun,
            lastFound,
            totalCreated,
            totalFailed,
            lastStatus,
            taskNames: taskNames.slice(-10),
            timestamp: new Date().toISOString()
        }));
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, daemonActive: false }));
    }
}

function getDelegationStats(req, res) {
    const LOG_FILE = `${process.env.HOME}/openclaw/logs/agent-heartbeat.log`;
    try {
        const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
        const lines = content.split('\n');

        // Parse delegation lines: [timestamp] [<Agent>-delegate] Delegating to <target>: <title>
        const delegations = [];
        const delegateRegex = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[(\w+)-delegate\] Delegating to (\w[\w-]*):\s*(.+)/;

        for (const line of lines) {
            const m = line.match(delegateRegex);
            if (m) {
                delegations.push({ timestamp: m[1], source: m[2], target: m[3], task: m[4].trim() });
            }
        }

        // Count by source (who delegates)
        const bySource = {};
        delegations.forEach(d => { bySource[d.source] = (bySource[d.source] || 0) + 1; });

        // Count by target (who gets delegated to)
        const byTarget = {};
        delegations.forEach(d => { byTarget[d.target] = (byTarget[d.target] || 0) + 1; });

        // Count pairs (source → target)
        const pairs = {};
        delegations.forEach(d => {
            const key = `${d.source} → ${d.target}`;
            pairs[key] = (pairs[key] || 0) + 1;
        });

        // Last 10 delegations (most recent first)
        const recent = delegations.slice(-10).reverse();

        // Gamification — titles and badges based on delegation count
        const getTitleAndBadge = (count) => {
            if (count >= 100) return { title: 'Delegation Machine', badge: '★★★★★' };
            if (count >= 50)  return { title: 'Master Delegator',   badge: '★★★★' };
            if (count >= 25)  return { title: 'Senior Delegator',   badge: '★★★' };
            if (count >= 10)  return { title: 'Active Delegator',   badge: '★★' };
            if (count >= 5)   return { title: 'Rising Delegator',   badge: '★' };
            if (count >= 1)   return { title: 'First Delegation',   badge: '◆' };
            return { title: '', badge: '' };
        };

        const gamification = {};
        for (const [agent, count] of Object.entries(bySource)) {
            gamification[agent] = { sent: count, ...getTitleAndBadge(count) };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            total: delegations.length,
            bySource,
            byTarget,
            pairs,
            recent,
            gamification,
            timestamp: new Date().toISOString()
        }));
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, total: 0, bySource: {}, byTarget: {} }));
    }
}

function handleSprint(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') {
        // Return current sprint state + presence info
        const state = sprint.getState();
        const presence = sprint.getPresenceStatus();
        res.writeHead(200);
        res.end(JSON.stringify({ ...state, presence }));
    } else if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { action, trigger } = JSON.parse(body);
                let result;
                if (action === 'activate') {
                    result = sprint.activate(trigger || 'manual');
                } else if (action === 'deactivate') {
                    result = sprint.deactivate(trigger || 'manual');
                } else if (action === 'cycle') {
                    sprint.runSprintCycle();
                    result = { ok: true, message: 'Manual cycle triggered' };
                } else {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid action. Use: activate, deactivate, cycle' }));
                    return;
                }
                res.writeHead(200);
                res.end(JSON.stringify(result));
            } catch(e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    } else {
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'GET or POST only' }));
    }
}

function handleOpsLog(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') {
        const url = new URL(req.url, 'http://localhost');
        const type = url.searchParams.get('type') || 'all';
        const limit = parseInt(url.searchParams.get('limit') || '200');
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const data = opsLog.getEvents(type, limit, offset);
        res.writeHead(200);
        res.end(JSON.stringify(data));
    } else if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { type, icon, detail, meta } = JSON.parse(body);
                if (!type || !detail) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'type and detail required' }));
                    return;
                }
                const event = opsLog.logEvent(type, icon || '📝', detail, meta || {});
                res.writeHead(200);
                res.end(JSON.stringify(event));
            } catch(e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    } else {
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'GET or POST only' }));
    }
}

function handleSprintHistory(req, res) {
    res.setHeader('Content-Type', 'application/json');
    try {
        const historyFile = require('path').join(process.env.HOME || '/Users/elf-6', 'openclaw/logs/sprint_history.json');
        const fs2 = require('fs');
        if (fs2.existsSync(historyFile)) {
            const data = fs2.readFileSync(historyFile, 'utf8');
            res.writeHead(200);
            res.end(data);
        } else {
            res.writeHead(200);
            res.end(JSON.stringify({ sessions: [], totals: { tasksCompleted: 0, tasksKickedBack: 0, sprintCycles: 0, totalSessions: 0 } }));
        }
    } catch(e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
    }
}

function handleSprintRetro(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') {
        // Return latest retro report
        const report = sprintRetro.getLatestReport();
        if (report) {
            res.writeHead(200);
            res.end(JSON.stringify(report));
        } else {
            res.writeHead(200);
            res.end(JSON.stringify({ message: 'No retro reports yet. POST to trigger one.' }));
        }
    } else if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { sprintNumber, ceoFeedback } = body ? JSON.parse(body) : {};
                const report = await sprintRetro.runRetro(sprintNumber || null, ceoFeedback || null);
                res.writeHead(200);
                res.end(JSON.stringify(report));
            } catch(e) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    } else {
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'GET or POST only' }));
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
        { id: 'nicole',         name: 'Nicole (CIO)',       pattern: /Starting Nicole CSO daily/,              nextFn: () => { const d = new Date(now); d.setHours(17,0,0,0); if (d <= now) d.setDate(d.getDate()+1); return d; } },
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
    const INTAKE_JSONL = `${process.env.HOME}/openclaw/logs/opportunity_intake.jsonl`;
    const LEGACY_FILE  = `${process.env.HOME}/openclaw/logs/cso_pipeline.json`;

    try {
        let opportunities = [];

        // Read from opportunity_intake.jsonl (primary source)
        if (fs.existsSync(INTAKE_JSONL)) {
            const lines = fs.readFileSync(INTAKE_JSONL, 'utf8').split('\n').filter(l => l.trim());
            for (const line of lines) {
                try {
                    const rec = JSON.parse(line);
                    // Determine stage — score/filter always override watcher-set stage
                    const score = parseInt(rec.fit_score) || 0;
                    const filter = (rec.hard_filter || '').toUpperCase();
                    let stage;
                    if (filter === 'FAIL' || score < 4) stage = 'Rejected';
                    else if (score >= 7 && filter === 'PASS') stage = 'Qualified';
                    else if (rec.notified_nicole) stage = 'Under Review';
                    else stage = rec.stage || 'Intake';
                    opportunities.push({
                        id: rec.filename + '_' + (rec.dropped_at || ''),
                        name: rec.opportunity_name || rec.filename,
                        fit_score: rec.fit_score || 0,
                        hard_filter: rec.hard_filter || 'UNKNOWN',
                        source: rec.source || 'CEO drop',
                        estimated_effort: rec.estimated_effort || 'Unknown',
                        estimated_roi_tier: rec.estimated_roi_tier || 'Unknown',
                        recommended_action: rec.recommended_action || '',
                        stage: stage,
                        dropped_at: rec.dropped_at || rec.processed_at,
                        filename: rec.filename
                    });
                } catch (_) {}
            }
        }

        // Fall back to legacy file if no intake data yet
        if (opportunities.length === 0 && fs.existsSync(LEGACY_FILE)) {
            const legacyData = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
            if (legacyData.opportunities) {
                opportunities = legacyData.opportunities;
            }
        }

        // Build stage counts
        const stages = ['Intake', 'Under Review', 'Qualified', 'In Development', 'Rejected'];
        const stage_counts = {};
        for (const s of stages) stage_counts[s] = 0;
        for (const opp of opportunities) {
            const s = opp.stage || 'Intake';
            if (stage_counts[s] !== undefined) stage_counts[s]++;
            else stage_counts[s] = 1;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            opportunities,
            stage_counts,
            total: opportunities.length,
            lastUpdated: new Date().toISOString()
        }));
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
}

function getOpp33Funnel(req, res) {
    // OPP-33 Revenue Funnel: 5-stage pipeline for health-report landing page
    // Sources: GA4 (visitors), EspoCRM (leads/qualified), Stripe (proposals/closed)
    const https = require('https');

    const now = new Date().toISOString();
    const result = {
        stages: [
            { stage: 'Visitors',   count: 0, source: 'GA4',           drilldown: '', note: 'GA4 service account auth broken — fix pending' },
            { stage: 'Leads',      count: 0, source: 'EspoCRM',        drilldown: '?filter=website_populated', note: '' },
            { stage: 'Qualified',  count: 0, source: 'EspoCRM',        drilldown: '?filter=email_ready',       note: '' },
            { stage: 'Proposals',  count: 0, source: 'Stripe',         drilldown: '', note: 'Webhook not wired — pending' },
            { stage: 'Closed',     count: 0, source: 'Stripe $15',     drilldown: '', note: 'Webhook not wired — pending' }
        ],
        lastUpdated: now
    };

    // Helper: fetch EspoCRM with API key header
    function fetchEspoCRM(path) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'crm.tvcpulse.com',
                path: path,
                method: 'GET',
                headers: { 'X-Api-Key': '6add7bd35487e5d0e1b6b1fc54644863' }
            };
            const req2 = https.request(options, (r) => {
                let data = '';
                r.on('data', chunk => data += chunk);
                r.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch(e) { reject(new Error('EspoCRM parse error: ' + data.slice(0,100))); }
                });
            });
            req2.on('error', reject);
            req2.setTimeout(10000, () => { req2.destroy(); reject(new Error('EspoCRM timeout')); });
            req2.end();
        });
    }

    // Helper: fetch GA4 Data API with service account
    function fetchGA4(report) {
        return new Promise((resolve, reject) => {
            const { oauth2client } = require('./oauth2-google');
            oauth2client.fetchAccessTokenForClient('<not-needed>', (err, token) => {
                if (err || !token) { resolve({ visitors: 0, note: 'GA4 auth failed' }); return; }
                const postData = JSON.stringify(report);
                const options = {
                    hostname: 'analyticsdata.googleapis.com',
                    path: '/v1beta/properties/349790229:runReport',
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token.access_token, 'Content-Type': 'application/json' }
                };
                const req2 = https.request(options, (r) => {
                    let data = '';
                    r.on('data', chunk => data += chunk);
                    r.on('end', () => {
                        try {
                            const parsed = JSON.parse(data);
                            const rows = parsed.rows || [];
                            let visitors = 0;
                            rows.forEach(r => { visitors += parseInt(r.metricValues[0].value, 10); });
                            resolve({ visitors });
                        } catch(e) { resolve({ visitors: 0, note: 'GA4 parse error' }); }
                    });
                });
                req2.on('error', reject);
                req2.write(postData);
                req2.end();
            });
        });
    }

    // Step 1: GA4 visitors for /health-report page (30-day)
    fetchGA4({
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'sessions' }],
        dimensionFilter: { filter: { fieldName: 'pagePath', stringFilter: { value: '/health-report', filterType: 'CONTAINS' } } }
    }).then(ga4 => {
        if (ga4.visitors > 0) result.stages[0].count = ga4.visitors;
        delete result.stages[0].note;
    }).catch(() => {}).then(() => {
        // Step 2: EspoCRM leads with website (filter: has website, not deleted)
        return fetchEspoCRM('/api/v1/Lead?maxResults=200&offset=0&deleted=false');
    }).then(data => {
        const leads = data.list || [];
        const total = data.total || leads.length;
        const withWebsite = leads.filter(l => l.website && l.website !== 'null' && l.website !== '');
        result.stages[1].count = withWebsite.length;
        result.stages[2].count = withWebsite.filter(l => l.emailAddress).length;
    }).catch(e => {
        result.stages[1].note = 'EspoCRM error: ' + e.message;
        result.stages[2].note = 'EspoCRM error: ' + e.message;
    }).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result, null, 2));
    });
}

function getOppPipeline(req, res) {
    // Reads Product_Pipeline tab from DW Control Sheet
    // Returns stage counts for the full TAS-1025 opportunity pipeline
    const MATON_KEY = 'vqV4andwInf-ObTAMv_-QZdq9DUBAhMnU2Gw8g5cP2_I5rAoBM4gwvCl1VHWrKUhzN39AW6nRHBtG8eP7dsVBEbIfBwNWcNAa7E';
    const SHEET_ID = '1nkhSpjxS11rWC2MPP40GLYvA7LYsaFba91hC5mWpi80';
    const range = encodeURIComponent('Product_Pipeline!A1:K200');
    const opts = {
        hostname: 'gateway.maton.ai',
        path: `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/${range}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${MATON_KEY}` }
    };
    const apiReq = https.request(opts, (apiRes) => {
        let body = '';
        apiRes.on('data', chunk => body += chunk);
        apiRes.on('end', () => {
            try {
                const raw = JSON.parse(body);
                const rows = raw.values || [];
                const header = rows[0] || [];
                const statusIdx = header.indexOf('Status');
                const nameIdx = header.indexOf('Product / Service');
                const verdictIdx = header.indexOf('VERDICT');
                const sourceIdx = header.indexOf('Source ID');

                // Funnel stages — map raw Status values to display stages
                const stageMap = {
                    'Needs Gate 1': 'Gate 1',
                    'Needs Gate 2': 'Gate 2',
                    'Needs Gate 3': 'Gate 3',
                    'Needs POC': 'POC',
                    'Needs POC + Research': 'POC',
                    'Needs POC+Research': 'POC',
                    'Needs POC (sign up 3 lender partners)': 'POC',
                    'Needs licensing + POC': 'POC',
                    'Needs curriculum + POC': 'POC',
                    'Pilot — Build First': 'Pilot',
                    'Ready to Launch': 'Ready to Launch'
                };
                const stageOrder = ['Gate 1', 'Gate 2', 'Gate 3', 'POC', 'Pilot', 'Ready to Launch'];
                const stage_counts = {};
                stageOrder.forEach(s => stage_counts[s] = 0);

                const opportunities = rows.slice(1).filter(r => r[0]).map(r => {
                    const rawStatus = statusIdx >= 0 ? (r[statusIdx] || '') : '';
                    const stage = stageMap[rawStatus] || rawStatus || 'POC';
                    if (stage_counts[stage] !== undefined) stage_counts[stage]++;
                    return {
                        id: sourceIdx >= 0 ? (r[sourceIdx] || '') : '',
                        name: nameIdx >= 0 ? (r[nameIdx] || '') : '',
                        verdict: verdictIdx >= 0 ? (r[verdictIdx] || '') : '',
                        status: rawStatus,
                        stage
                    };
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, opportunities, stage_counts, total: opportunities.length, lastUpdated: new Date().toISOString() }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Parse error: ' + e.message }));
            }
        });
    });
    apiReq.on('error', (e) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
    });
    apiReq.end();
}

function getN8nWfStatus(req, res) {
    // Returns last execution status for TAS-1025 n8n workflows
    const N8N_API_KEY = process.env.N8N_API_KEY || require('fs').readFileSync(`${process.env.HOME}/.openclaw/.env`, 'utf8').match(/N8N_API_KEY=([^\n]+)/)?.[1]?.trim() || '';
    const workflows = [
        { id: 'CNkbCCRhRNrlbIHv', name: 'WF2: Reddit Scraper', stage: 'Gate 1' },
        { id: 'Em0T5U5VdzrE615T', name: 'WF12: Daily Top 3',   stage: 'Gate 3' },
        { id: '3b4NTJeI3E8rEwZq', name: 'WF8: Tri-Factor',     stage: 'Gate 2' }
    ];

    let pending = workflows.length;
    const results = [];

    workflows.forEach(wf => {
        const opts = {
            hostname: 'n8n.tvcpulse.com',
            path: `/api/v1/executions?workflowId=${wf.id}&limit=1`,
            method: 'GET',
            headers: { 'X-N8N-API-KEY': N8N_API_KEY }
        };
        const req2 = https.request(opts, (res2) => {
            let body = '';
            res2.on('data', c => body += c);
            res2.on('end', () => {
                try {
                    const d = JSON.parse(body);
                    const exec = (d.data || [])[0];
                    results.push({
                        id: wf.id,
                        name: wf.name,
                        stage: wf.stage,
                        status: exec ? exec.status : 'unknown',
                        lastRun: exec ? (exec.stoppedAt || exec.finishedAt || exec.startedAt || '').slice(0, 19) : null
                    });
                } catch(e) {
                    results.push({ id: wf.id, name: wf.name, stage: wf.stage, status: 'unknown', lastRun: null });
                }
                if (--pending === 0) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, workflows: results }));
                }
            });
        });
        req2.on('error', () => {
            results.push({ id: wf.id, name: wf.name, stage: wf.stage, status: 'unreachable', lastRun: null });
            if (--pending === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, workflows: results }));
            }
        });
        req2.end();
    });
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

// ── Cashflow Overview — reads SGG-Cashflow + L2 Liabilities from Google Sheets ──
function handleCashflow(req, res) {
    const MATON_KEY = 'vqV4andwInf-ObTAMv_-QZdq9DUBAhMnU2Gw8g5cP2_I5rAoBM4gwvCl1VHWrKUhzN39AW6nRHBtG8eP7dsVBEbIfBwNWcNAa7E';
    const SHEET_ID = '1vTShVS1jhDi_laZYc6tZFLP9tLH1s0FFNcqEtG4WtxU';

    function fetchRange(range) {
        return new Promise((resolve, reject) => {
            const opts = {
                hostname: 'gateway.maton.ai',
                path: `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`,
                method: 'GET',
                headers: { 'Authorization': `Bearer ${MATON_KEY}` }
            };
            const apiReq = https.request(opts, (apiRes) => {
                let body = '';
                apiRes.on('data', chunk => body += chunk);
                apiRes.on('end', () => {
                    try { resolve(JSON.parse(body)); }
                    catch(e) { reject(new Error('Parse error: ' + e.message)); }
                });
            });
            apiReq.on('error', reject);
            apiReq.end();
        });
    }

    function parseDollar(v) {
        if (!v || v === '#N/A' || v === '#VALUE!' || v === '#REF!') return null;
        return parseFloat(String(v).replace(/[$,\s]/g, '')) || 0;
    }

    function findRow(rows, label) {
        return rows.find(r => r[0] && r[0].trim().startsWith(label));
    }

    Promise.all([
        fetchRange('SGG-Cashflow!A1:H100'),
        fetchRange('L2 Liabilities!A1:J30')
    ]).then(([sggData, l2Data]) => {
        const sgg = sggData.values || [];
        const l2 = l2Data.values || [];

        // Income
        const earnedRow = findRow(sgg, 'Earned Total');
        const passiveRow = findRow(sgg, 'Passive Total');
        const portfolioRow = findRow(sgg, 'Portfolio Total');
        const totalIncomeRow = findRow(sgg, 'D. TOTAL INCOME');

        // Expenses & Cash Flow
        const totalExpenseRow = findRow(sgg, 'E. TOTAL EXPENSES');
        const netCashFlowRow = findRow(sgg, 'NET MONTHLY CASH FLOW');
        const paydayRow = sgg.find(r => r[6] && String(r[6]).trim() === 'PAYDAY');

        // Assets
        const assetsSubRow = findRow(sgg, 'F. ASSETS SUBTOTAL');
        const doodadsRow = findRow(sgg, 'G. DOODADS TOTAL');
        const bankerAssetsRow = findRow(sgg, 'H. TOTAL ASSETS per Banker');
        const richDadAssetsRow = findRow(sgg, 'I. TOTAL ASSETS per Rich Dad');

        // Net Worth
        const bankerNWRow = sgg.find(r => r[5] && String(r[5]).trim().startsWith('K. NET WORTH'));
        const richDadNWRow = sgg.find(r => r[5] && String(r[5]).trim().startsWith('I. NET WORTH'));

        // Analysis ratios (column G/H in early rows)
        const cfRatioRow = sgg.find(r => r[6] && String(r[6]).includes('Cash Flow/Total Income'));
        const passiveRatioRow = sgg.find(r => r[6] && String(r[6]).includes('Passive+Portfolio/Total Inc'));
        const taxRatioRow = sgg.find(r => r[6] && String(r[6]).includes('Taxes/Total Income'));
        const housingRatioRow = sgg.find(r => r[6] && String(r[6]).includes('Housing Expenses/Income'));
        const roaRow = sgg.find(r => r[6] && String(r[6]).includes('Pass+Port/Rich Dad Assets'));

        // L2 Liabilities summary
        const ccRow = l2.find(r => r[4] && String(r[4]).trim() === 'CC:');
        const loansRow = l2.find(r => r[4] && String(r[4]).trim() === 'Loans:');
        const totalDebtRow = l2.find(r => r[4] && String(r[4]).trim() === 'Total:');

        // Individual liabilities for top-debt list
        const liabilities = [];
        for (const r of l2) {
            if (r[1] && String(r[1]).startsWith('LID') && r[2] && r[6]) {
                const owed = parseDollar(r[6]);
                if (owed !== null && owed > 0) {
                    liabilities.push({ id: r[1], name: r[2], owed, minPayment: parseDollar(r[8]), utilization: r[9] || '' });
                }
            }
        }
        liabilities.sort((a, b) => b.owed - a.owed);

        // Individual income items (Earned #1, #2, Real Estate, Passive Portfolio, VA Benefits, etc.)
        const incomeItems = [];
        const expenseItems = [];
        const assetItems = [];
        let section = null;
        for (const r of sgg) {
            const a = (r[0] || '').trim();
            const b = (r[1] || '').trim();
            const c = parseDollar(r[2]);
            // Track sections
            if (a === 'A. Earned Income' || a === 'B. Passive Income' || a === 'C. Portfolio Income') { section = 'income'; continue; }
            if (a === 'E. Expenses') { section = 'expenses'; continue; }
            if (a.startsWith('F. ASSETS') || a === 'F.' || (a === 'F. ' || (b === 'ASSETS' && a.startsWith('F')))) { section = 'assets'; continue; }
            if (a.startsWith('Asset ID')) { section = 'assets'; continue; }
            if (a.startsWith('G. DOODADS') || a.startsWith('E. TOTAL') || a.startsWith('NET MONTHLY') || a.startsWith('D. TOTAL') || a.startsWith('F. ASSETS SUBTOTAL')) { section = null; continue; }
            // Collect items
            if (section === 'income' && b && c !== null && !a.startsWith('Earned Total') && !a.startsWith('Passive Total') && !a.startsWith('Portfolio Total')) {
                incomeItems.push({ name: b, amount: c });
            }
            if (section === 'expenses' && b && c !== null && a !== 'ExID') {
                expenseItems.push({ id: a, name: b, amount: c });
            }
            if (section === 'assets' && b && c !== null && (a.startsWith('Asset') || a.startsWith('asset'))) {
                assetItems.push({ id: a, name: b, amount: c });
            }
        }

        // Liability items with balances (from L2)
        const liabilityItems = [];
        for (const r of l2) {
            if (r[1] && String(r[1]).startsWith('LID') && r[2]) {
                const owed = parseDollar(r[6]);
                liabilityItems.push({ id: r[1].trim(), name: r[2], balance: owed !== null ? owed : 0 });
            }
        }

        // Cash value from sheet
        const cashRow = sgg.find(r => r[6] && String(r[6]).trim() === 'CASH:');
        const cashValue = cashRow ? parseDollar(cashRow[7]) : null;

        const result = {
            ok: true,
            timestamp: new Date().toISOString(),
            income: {
                earned: parseDollar(earnedRow && earnedRow[2]),
                passive: parseDollar(passiveRow && passiveRow[2]),
                portfolio: parseDollar(portfolioRow && portfolioRow[2]),
                total: parseDollar(totalIncomeRow && totalIncomeRow[2]),
                items: incomeItems
            },
            expenses: {
                total: parseDollar(totalExpenseRow && totalExpenseRow[2]),
                items: expenseItems
            },
            netCashFlow: parseDollar(netCashFlowRow && netCashFlowRow[2]),
            payday: parseDollar(paydayRow && paydayRow[7]),
            cash: cashValue,
            assets: {
                subtotal: parseDollar(assetsSubRow && assetsSubRow[2]),
                doodads: parseDollar(doodadsRow && doodadsRow[2]),
                bankerTotal: parseDollar(bankerAssetsRow && bankerAssetsRow[2]),
                richDadTotal: parseDollar(richDadAssetsRow && richDadAssetsRow[2]),
                items: assetItems
            },
            netWorth: {
                banker: parseDollar(bankerNWRow && bankerNWRow[7]),
                richDad: parseDollar(richDadNWRow && richDadNWRow[7])
            },
            debt: {
                ccTotal: parseDollar(ccRow && ccRow[6]),
                ccCredit: parseDollar(ccRow && ccRow[5]),
                ccUtilization: ccRow && ccRow[9] ? ccRow[9] : null,
                loansTotal: parseDollar(loansRow && loansRow[6]),
                grandTotal: parseDollar(totalDebtRow && totalDebtRow[6]),
                minPayments: parseDollar(totalDebtRow && totalDebtRow[8]),
                topDebts: liabilities.slice(0, 5),
                items: liabilityItems
            },
            analysis: {
                cashFlowRatio: cfRatioRow && cfRatioRow[7] && !String(cfRatioRow[7]).startsWith('#') ? cfRatioRow[7] : null,
                passivePortfolioRatio: passiveRatioRow && passiveRatioRow[7] && !String(passiveRatioRow[7]).startsWith('#') ? passiveRatioRow[7] : null,
                taxRatio: taxRatioRow && taxRatioRow[7] && !String(taxRatioRow[7]).startsWith('#') ? taxRatioRow[7] : null,
                housingRatio: housingRatioRow && housingRatioRow[7] && !String(housingRatioRow[7]).startsWith('#') ? housingRatioRow[7] : null,
                returnOnAssets: roaRow && roaRow[7] && !String(roaRow[7]).startsWith('#') ? roaRow[7] : null
            },
            freedomProgress: null // passive+portfolio vs expenses
        };

        // Calculate freedom progress (passive+portfolio income / total expenses)
        if (result.income.passive !== null && result.income.portfolio !== null && result.expenses.total !== null && result.expenses.total > 0) {
            result.freedomProgress = ((result.income.passive + result.income.portfolio) / result.expenses.total * 100).toFixed(1) + '%';
        }

        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify(result));

    }).catch(err => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Maton API error: ' + err.message }));
    });
}

function getAgentSessions(req, res) {
    const { execSync } = require('child_process');
    const AGENT_NAMES = {
        'cto':            'Steve (CTO)',
        'anita':          'Anita (COO)',
        'nicole':         'Nicole (CIO)',
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

// ── Agent Model Selector ──────────────────────────────────────────────────────
const OPENCLAW_CONFIG = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
const MODEL_OPTIONS = [
    { value: 'smart-routing', label: 'Smart Routing', desc: 'Kimi → MiniMax → GLM → OpenRouter' },
    { value: 'ollama/kimi-k2.5:cloud', label: 'Kimi K2.5', desc: 'Ollama Cloud (free)' },
    { value: 'ollama/minimax-m2.7:cloud', label: 'MiniMax M2.7', desc: 'Ollama Cloud (free)' },
    { value: 'ollama/glm-5:cloud', label: 'GLM-5', desc: 'Ollama Cloud (free)' },
    { value: 'openrouter/auto', label: 'OpenRouter Auto', desc: 'Paid — last resort' },
];
const SMART_ROUTING_PRIMARY = 'ollama/kimi-k2.5:cloud';
const SMART_ROUTING_FALLBACKS = ['ollama/minimax-m2.7:cloud', 'ollama/glm-5:cloud', 'openrouter/auto'];

function getAgentModels(req, res) {
    try {
        const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
        const defaultPrimary = cfg.agents?.defaults?.model?.primary || 'openrouter/auto';
        const defaultFallbacks = cfg.agents?.defaults?.model?.fallbacks || [];
        const agents = {};
        (cfg.agents?.list || []).forEach(a => {
            if (a.id === 'herald') return; // skip non-team agents
            const primary = a.model?.primary;
            const fallbacks = a.model?.fallbacks;
            // If agent has no override, or matches smart routing defaults, it's "smart-routing"
            if (!primary || (primary === defaultPrimary && !fallbacks)) {
                agents[a.id] = 'smart-routing';
            } else {
                agents[a.id] = primary;
            }
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, agents, options: MODEL_OPTIONS }));
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
    }
}

function setAgentModel(req, res) {
    collectBody(req, (body) => {
        try {
            const { agent, model } = JSON.parse(body);
            if (!agent || !model) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Missing agent or model' }));
                return;
            }
            const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
            const agentEntry = (cfg.agents?.list || []).find(a => a.id === agent);
            if (!agentEntry) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: `Agent "${agent}" not found` }));
                return;
            }
            if (model === 'smart-routing') {
                // Remove per-agent override → falls back to defaults
                delete agentEntry.model;
            } else {
                // Set specific model, no fallbacks (force this model)
                agentEntry.model = { primary: model };
            }
            fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(cfg, null, 2), 'utf8');
            // Restart gateway to apply
            exec(`launchctl kickstart -k gui/${process.getuid()}/ai.openclaw.gateway`, { timeout: 15000 }, (err) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ok: true,
                    agent,
                    model,
                    gatewayRestarted: !err,
                    gatewayError: err ? err.message : null
                }));
            });
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
    });
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

// ── Telegram notification helper ──────────────────────────────────────
function sendTelegramNotification(botToken, chatId, threadId, message) {
    const postData = JSON.stringify({
        chat_id: chatId,
        message_thread_id: threadId,
        text: message,
        parse_mode: 'HTML'
    });
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${botToken}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
            if (res.statusCode !== 200) console.log(`[telegram] Send failed (${res.statusCode}): ${d.slice(0, 200)}`);
            else console.log('[telegram] Notification sent');
        });
    });
    req.on('error', e => console.log(`[telegram] Error: ${e.message}`));
    req.write(postData);
    req.end();
}

// Notify Anita (PM topic) when a file is approved
function notifyPMOnApproval(fileName, filePath) {
    let botToken = process.env.OPENCLAW_TELEGRAM_BOT_TOKEN;
    if (!botToken) {
        // Fallback: read from env file
        try {
            const envFile = fs.readFileSync(`${process.env.HOME}/.openclaw/.env`, 'utf8');
            botToken = (envFile.match(/OPENCLAW_TELEGRAM_BOT_TOKEN="?([^"\n]+)"?/)?.[1] || '').trim();
        } catch(e) {}
    }
    if (!botToken) { console.log('[pipeline] No Telegram token for PM notification'); return; }

    const TELEGRAM_GROUP = '-1003704478785';
    const PM_THREAD = '83';  // Anita's PM topic

    // Read first 500 chars of the file for context
    let preview = '';
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        preview = content.slice(0, 500).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        if (content.length > 500) preview += '…';
    } catch(e) { preview = '(could not read file)'; }

    const msg = `📋 <b>New Approved Document</b>\n\n`
        + `Sidney approved: <b>${fileName.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</b>\n\n`
        + `<b>Preview:</b>\n<pre>${preview}</pre>\n\n`
        + `Please review and create a project plan if this requires execution.`;

    sendTelegramNotification(botToken, TELEGRAM_GROUP, PM_THREAD, msg);
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

            // Notify Anita when a file is approved
            if (to === '3_Approved') {
                notifyPMOnApproval(safeName, dst);
            }

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

// ── Swarm Review (on-demand trigger) ─────────────────────────────────────

function runSwarmReview(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        try {
            const { pipelines = [], concern = '', steps = [] } = JSON.parse(body || '{}');
            const timestamp = new Date().toISOString();
            const logFile = path.join(process.env.HOME, 'openclaw/logs/swarm-diagnosis.log');
            const script = path.join(process.env.HOME, 'openclaw/agents/anita/skills/swarm-diagnosis/swarm_diagnosis.sh');
            const out = fs.openSync(logFile, 'a');
            const child = require('child_process').spawn('bash', [script], {
                detached: true,
                stdio: ['ignore', out, out],
                env: { ...process.env, SWARM_ON_DEMAND: '1', SWARM_CONCERN: concern, SWARM_PIPELINES: pipelines.join(','), SWARM_STEPS: JSON.stringify(steps) }
            });
            child.unref();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, message: 'Swarm dispatched', timestamp }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
    });
}

function getSwarmStatus(req, res) {
    try {
        const logFile = path.join(process.env.HOME, 'openclaw/logs/swarm-diagnosis.log');
        const content = fs.readFileSync(logFile, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        const last200 = lines.slice(-200).join('\n');
        // Check for outcome markers written by the swarm script
        const fixed = last200.includes('SWARM_RESULT: FIXED');
        const escalatedMatch = last200.match(/SWARM_RESULT: ESCALATED (TAS-[A-Z0-9]+)/);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            log: last200,
            fixed: fixed || false,
            escalated: escalatedMatch ? escalatedMatch[1] : null
        }));
    } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, log: 'No swarm log found.' }));
    }
}

// ── OpenClaw Version Management ──────────────────────────────────────────
const OC_VERSION_STATE = path.join(__dirname, '.openclaw-version-state.json');

function versionNewer(current, latest) {
    if (!latest || !current || current === latest) return false;
    const c = current.split('.').map(Number);
    const l = latest.split('.').map(Number);
    for (let i = 0; i < Math.max(c.length, l.length); i++) {
        if ((l[i] || 0) > (c[i] || 0)) return true;
        if ((l[i] || 0) < (c[i] || 0)) return false;
    }
    return false;
}

function getOpenclawVersion(req, res) {
    res.setHeader('Content-Type', 'application/json');
    // Get actual installed version from package.json
    let currentVersion = 'unknown';
    try {
        const pkg = JSON.parse(fs.readFileSync('/opt/homebrew/lib/node_modules/openclaw/package.json', 'utf8'));
        currentVersion = pkg.version || 'unknown';
    } catch(e) { /* fallback stays unknown */ }
    {
        // Read cached update state if it exists
        let updateState = {};
        try {
            updateState = JSON.parse(fs.readFileSync(OC_VERSION_STATE, 'utf8'));
        } catch(e) { /* no cached state yet */ }
        const latestVersion = updateState.latestVersion || null;
        const updateAvailable = versionNewer(currentVersion, latestVersion);
        res.end(JSON.stringify({
            ok: true,
            currentVersion,
            latestVersion,
            updateAvailable,
            lastChecked: updateState.lastChecked || null,
            releaseUrl: updateState.releaseUrl || null,
            releaseNotes: updateState.releaseNotes || null,
            dweImpact: updateState.dweImpact || null
        }));
    }
}

function runOpenclawUpdateCheck(req, res) {
    res.setHeader('Content-Type', 'application/json');
    exec('/opt/homebrew/bin/npx openclaw update --dry-run --json 2>/dev/null', { timeout: 30000, env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' } }, (err, stdout) => {
        if (err) {
            res.end(JSON.stringify({ ok: false, error: err.message }));
            return;
        }
        try {
            // Strip plugin registration lines that leak to stdout before JSON
            const jsonStart = stdout.indexOf('{');
            const cleanOutput = jsonStart >= 0 ? stdout.substring(jsonStart) : stdout;
            const data = JSON.parse(cleanOutput.trim());
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

// ── Proposal & Deal Management Handlers ─────────────────────────────────

const PROPOSAL_QUEUE_DIR = path.join(require('os').homedir(), 'openclaw/shared/proposal_queue');
const DEALS_DIR_PATH = path.join(require('os').homedir(), 'openclaw/shared/deals');
const CRM_DIR_PATH = path.join(require('os').homedir(), 'openclaw/shared/crm');

function getProposalQueue(req, res) {
    try {
        if (!fs.existsSync(PROPOSAL_QUEUE_DIR)) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({proposals:[]})); return; }
        const files = fs.readdirSync(PROPOSAL_QUEUE_DIR).filter(f => f.endsWith('.json'));
        const proposals = files.map(f => {
            try { return JSON.parse(fs.readFileSync(path.join(PROPOSAL_QUEUE_DIR, f), 'utf8')); } catch(e) { return null; }
        }).filter(Boolean);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({proposals, count: proposals.length}));
    } catch(e) {
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error: e.message}));
    }
}

function approveProposal(req, res) {
    collectBody(req, (body) => {
        try {
            const data = JSON.parse(body);
            const leadId = data.lead_id;
            if (!leadId) throw new Error('lead_id required');
            const qf = path.join(PROPOSAL_QUEUE_DIR, leadId + '.json');
            if (!fs.existsSync(qf)) throw new Error('Proposal not found in queue');
            const item = JSON.parse(fs.readFileSync(qf, 'utf8'));
            item.status = 'approved';
            item.approved_at = new Date().toISOString();
            item.approved_by = data.approved_by || 'CEO';
            // Allow editing tier/notes before approval
            if (data.tier) item.tier = data.tier;
            if (data.notes) item.notes = data.notes;
            fs.writeFileSync(qf, JSON.stringify(item, null, 2));
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ok: true, lead_id: leadId, status: 'approved'}));
        } catch(e) {
            res.writeHead(400, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ok: false, error: e.message}));
        }
    });
}

function rejectProposal(req, res) {
    collectBody(req, (body) => {
        try {
            const data = JSON.parse(body);
            const leadId = data.lead_id;
            if (!leadId) throw new Error('lead_id required');
            const qf = path.join(PROPOSAL_QUEUE_DIR, leadId + '.json');
            if (!fs.existsSync(qf)) throw new Error('Proposal not found');
            const item = JSON.parse(fs.readFileSync(qf, 'utf8'));
            item.status = 'rejected';
            item.rejected_at = new Date().toISOString();
            item.reject_reason = data.reason || '';
            fs.writeFileSync(qf, JSON.stringify(item, null, 2));
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ok: true, lead_id: leadId, status: 'rejected'}));
        } catch(e) {
            res.writeHead(400, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ok: false, error: e.message}));
        }
    });
}

function getDeals(req, res) {
    try {
        if (!fs.existsSync(DEALS_DIR_PATH)) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({deals:[]})); return; }
        const files = fs.readdirSync(DEALS_DIR_PATH).filter(f => f.endsWith('.json') && !f.startsWith('_'));
        const deals = files.map(f => {
            try { return JSON.parse(fs.readFileSync(path.join(DEALS_DIR_PATH, f), 'utf8')); } catch(e) { return null; }
        }).filter(Boolean);

        // Pipeline snapshot
        let snapshot = {};
        const snapFile = path.join(DEALS_DIR_PATH, '_pipeline_snapshot.json');
        if (fs.existsSync(snapFile)) { try { snapshot = JSON.parse(fs.readFileSync(snapFile, 'utf8')); } catch(e) {} }

        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({deals, count: deals.length, snapshot}));
    } catch(e) {
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error: e.message}));
    }
}

function updateDeal(req, res) {
    collectBody(req, (body) => {
        try {
            const data = JSON.parse(body);
            const leadId = data.lead_id;
            if (!leadId) throw new Error('lead_id required');
            const df = path.join(DEALS_DIR_PATH, leadId + '.json');
            if (!fs.existsSync(df)) throw new Error('Deal not found');
            const deal = JSON.parse(fs.readFileSync(df, 'utf8'));
            // Updatable fields
            const updatable = ['stage', 'tier', 'notes', 'monthly_value', 'close_date', 'loss_reason'];
            for (const key of updatable) {
                if (data[key] !== undefined) deal[key] = data[key];
            }
            deal.updated_at = new Date().toISOString();

            // If closing, update prospect stage
            if (data.stage === 'Closed Won') {
                deal.closed_at = new Date().toISOString();
            }

            fs.writeFileSync(df, JSON.stringify(deal, null, 2));
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ok: true, deal}));
        } catch(e) {
            res.writeHead(400, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ok: false, error: e.message}));
        }
    });
}

function getCrmRecord(req, res, query) {
    try {
        const leadId = query && query.lead_id;
        if (leadId) {
            const cf = path.join(CRM_DIR_PATH, leadId + '.json');
            if (!fs.existsSync(cf)) throw new Error('CRM record not found');
            const crm = JSON.parse(fs.readFileSync(cf, 'utf8'));
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify(crm));
        } else {
            // List all CRM records
            if (!fs.existsSync(CRM_DIR_PATH)) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({records:[]})); return; }
            const files = fs.readdirSync(CRM_DIR_PATH).filter(f => f.endsWith('.json'));
            const records = files.map(f => {
                try {
                    const r = JSON.parse(fs.readFileSync(path.join(CRM_DIR_PATH, f), 'utf8'));
                    return { lead_id: r.lead_id, lead_name: r.lead_name, pipeline: r.pipeline, last_activity: r.last_activity, interaction_count: (r.interactions||[]).length, deal_stage: r.deal_stage };
                } catch(e) { return null; }
            }).filter(Boolean);
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify({records, count: records.length}));
        }
    } catch(e) {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error: e.message}));
    }
}

// ── EspoCRM Stats (Phase 6: CRM Pipeline widget) ─────────────────────
function getCrmStats(req, res) {
    // Cache key so EspoCRM API isn't hit on every page load
    const CACHE_KEY = '/mc/crm-stats';
    const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
    const cached = _responseCache.get(CACHE_KEY);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
        res.end(cached.data);
        return;
    }

    const envFile = (() => {
        try { return fs.readFileSync(`${process.env.HOME}/.openclaw/.env`, 'utf8'); } catch(e) { return ''; }
    })();
    const ESPOCRM_HOST = envFile.match(/ESPOCRM_HOST=([^\n]+)/)?.[1]?.trim() || 'https://crm.tvcpulse.com';
    const ESPOCRM_API_KEY = envFile.match(/ESPOCRM_API_KEY=([^\n]+)/)?.[1]?.trim() || '';

    if (!ESPOCRM_API_KEY) {
        const out = JSON.stringify({ error: 'ESPOCRM_API_KEY not configured', configured: false });
        _responseCache.set(CACHE_KEY, { data: out, ts: Date.now() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(out);
        return;
    }

    // Fetch all leads (status + stage + createdAt) in parallel — max 500
    const fetchJson = (endpoint) => new Promise((resolve) => {
        const url = `${ESPOCRM_HOST}/api/v1/${endpoint}`;
        const reqObj = https.get(url, {
            headers: { 'X-Api-Key': ESPOCRM_API_KEY, 'Content-Type': 'application/json' },
            timeout: 10000
        }, (response) => {
            let data = '';
            response.on('data', c => data += c);
            response.on('end', () => {
                try { resolve({ status: response.statusCode, body: JSON.parse(data) }); }
                catch(e) { resolve({ status: 0, body: null }); }
            });
        });
        reqObj.on('error', () => resolve({ status: 0, body: null }));
        reqObj.setTimeout(10000, () => { reqObj.destroy(); resolve({ status: 0, body: null }); });
    });

    (async () => {
        try {
            // Fetch leads + today's new count in parallel
            const [leadResult, todayResult] = await Promise.all([
                fetchJson('Lead?select=status,stage,dateEntered&maxSize=500'),
                fetchJson('Lead?select=status,stage,dateEntered&maxSize=1&sort=dateEntered&order=desc'),
            ]);

            const leads = (leadResult.status === 200 && Array.isArray(leadResult.body?.list)) ? leadResult.body.list : [];
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            // Counts by status
            const byStatus = {};
            let newToday = 0;
            let replied = 0;
            let totalScore = 0;
            let scoredLeads = 0;

            leads.forEach(l => {
                const s = l.status || 'Unknown';
                byStatus[s] = (byStatus[s] || 0) + 1;
                const entered = l.dateEntered ? new Date(l.dateEntered) : null;
                if (entered && entered >= today) newToday++;
                // Track replied via a 'Converted' or 'Dead' proxy — real implementation needs cEmailReplied field
                if (l.stage === 'Closed - Won') replied++;
            });

            const totalLeads = leads.length;
            const replyRate = totalLeads > 0 ? Math.round((replied / totalLeads) * 100) : 0;

            const out = JSON.stringify({
                configured: true,
                total_leads: totalLeads,
                new_leads_today: newToday,
                leads_by_status: byStatus,
                reply_rate_pct: replyRate,
                converted_count: byStatus['Closed - Won'] || 0,
                in_process_count: (byStatus['In Process'] || 0) + (byStatus['New'] || 0),
                avg_score: scoredLeads > 0 ? Math.round(totalScore / scoredLeads) : 0,
                crm_url: ESPOCRM_HOST,
                timestamp: new Date().toISOString(),
            });

            _responseCache.set(CACHE_KEY, { data: out, ts: Date.now() });
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
            res.end(out);
        } catch(e) {
            const out = JSON.stringify({ error: e.message, configured: true });
            _responseCache.set(CACHE_KEY, { data: out, ts: Date.now() });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(out);
        }
    })();
}

function getPipelineSummary(req, res) {
    try {
        // Aggregate across all pipeline stages
        const summary = { stages: {}, total_prospects: 0, pipeline_mrr: 0, closed_mrr: 0, deals: 0, crm_records: 0 };

        // Count deals
        if (fs.existsSync(DEALS_DIR_PATH)) {
            const snapFile = path.join(DEALS_DIR_PATH, '_pipeline_snapshot.json');
            if (fs.existsSync(snapFile)) {
                try {
                    const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
                    summary.pipeline_mrr = snap.pipeline_mrr || 0;
                    summary.closed_mrr = snap.closed_mrr || 0;
                    summary.deals = snap.total_deals || 0;
                    summary.deal_stages = snap.stages || {};
                } catch(e) {}
            }
        }

        // Count CRM records
        if (fs.existsSync(CRM_DIR_PATH)) {
            summary.crm_records = fs.readdirSync(CRM_DIR_PATH).filter(f => f.endsWith('.json')).length;
        }

        // Count proposals
        if (fs.existsSync(PROPOSAL_QUEUE_DIR)) {
            const pFiles = fs.readdirSync(PROPOSAL_QUEUE_DIR).filter(f => f.endsWith('.json'));
            summary.proposals_pending = pFiles.filter(f => {
                try { return JSON.parse(fs.readFileSync(path.join(PROPOSAL_QUEUE_DIR, f), 'utf8')).status === 'pending_review'; } catch(e) { return false; }
            }).length;
            summary.proposals_total = pFiles.length;
        }

        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(summary));
    } catch(e) {
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error: e.message}));
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

    // Resume Sprint Mode if it was active before restart
    sprint.resumeIfActive();

    // Start Apple Watch presence detector (auto-triggers Sprint Mode)
    sprint.startPresenceDetector();

    // Pre-warm newsletter cache on boot so results are instant at 7 AM
    console.log('[Newsletter Cache] Pre-warming on boot...');
    refreshNewsletterCache();

    // Self-healing daemon watchdog — detects errors, auto-restarts, escalates on crash loops
    console.log('[Healer] Self-healing loop started (20s interval)');
    setInterval(runHealerTick, 20000);
    setTimeout(runHealerTick, 2000); // first check after WS server initializes
});

// ── WebSocket Server ──────────────────────────────────────────────────────────
// Attached to the same HTTP server — no extra port needed.
// Pushes live data to all connected dashboard clients instead of polling.
const wss = new WebSocketServer({ server, path: '/ws' });

// Broadcast a typed message to all open clients
function wsBroadcast(type, data) {
    const msg = JSON.stringify({ type, data, ts: Date.now() });
    wss.clients.forEach(client => {
        if (client.readyState === 1 /* OPEN */) {
            client.send(msg, err => { if (err) { /* client gone */ } });
        }
    });
}

// Helper: fetch an mc/* endpoint from the local server and return parsed JSON
function localFetch(endpoint) {
    return new Promise(resolve => {
        const req = http.get(`http://127.0.0.1:${PORT}${endpoint}`, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    });
}

const WS_BATCH_ENDPOINTS = [
    '/mc/status', '/mc/agents', '/mc/heartbeat',
    '/mc/launchd', '/mc/delegation-stats', '/mc/brain',
    '/mc/system', '/mc/internet', '/mc/sprint', '/mc/cso',
    '/mc/financial', '/mc/n8n-workflows',
    '/mc/jarvis-stats', '/mc/ga4', '/mc/tailscale', '/mc/pipeline',
    '/mc/daemon-health', '/mc/migration',
    '/mc/recurring-tasks', '/mc/openrouter-credits', '/mc/autoresearch',
    '/mc/content-intel', '/mc/openclaw-version', '/mc/sidney-devices',
];

async function wsPushBatch() {
    if (wss.clients.size === 0) return; // no one listening
    const results = await Promise.all(WS_BATCH_ENDPOINTS.map(ep =>
        localFetch(ep).then(v => ({ k: ep, v }))
    ));
    const batch = {};
    results.forEach(r => { batch[r.k] = r.v; });
    wsBroadcast('batch', batch);
}

function wsPushTraffic() {
    if (wss.clients.size === 0) return;
    wsBroadcast('traffic', { ...trafficCache, activity: activityLog });
    wsBroadcast('local-traffic', { ...localTrafficCache });
}

// ── Additional push helpers for endpoints previously client-polled ────────────

async function wsPushSingle(type, endpoint, timeout = 8000) {
    if (wss.clients.size === 0) return;
    const data = await localFetch(endpoint);
    if (data !== null) wsBroadcast(type, data);
}

function wsPushMQT()        { return wsPushSingle('mqt',              '/mc/mqt-paper'); }
function wsPushSMI()        { return wsPushSingle('smi',              '/mc/smi-paper'); }
function wsPushComparison() { return wsPushSingle('trading-comparison','/mc/trading-comparison'); }
function wsPushTunnels()    { return wsPushSingle('tunnels',           '/mc/tunnel-status'); }
function wsPushOldVps()     { return wsPushSingle('old-vps',          '/mc/contabo-vps-status'); }
function wsPushSiteHealth() { return wsPushSingle('site-health',      '/mc/site-health'); }
function wsPushJakeInbox()  { return wsPushSingle('jake-inbox',       '/mc/jake-inbox'); }
function wsPushPipeline()   { return wsPushSingle('pipeline-push',    '/mc/pipeline'); }
function wsPushYtIntel()    { return wsPushSingle('yt-intel',         '/mc/content-intel'); }
function wsPushMeeting()    { return wsPushSingle('meeting-status',   '/mc/meeting-status'); }
function wsPushOpsBoard()   { return wsPushSingle('ops-board',         '/mc/ops-board'); }

async function wsPushVisionScore() {
    if (wss.clients.size === 0) return;
    // vision-pulse reads a local JSON file — use localFetch against the api route
    const data = await new Promise(resolve => {
        const req = http.get(`http://127.0.0.1:${PORT}/api/vision-pulse`, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    });
    if (data !== null) wsBroadcast('vision-score', data);
}

wss.on('connection', (ws, req) => {
    console.log(`[WS] Client connected from ${req.socket.remoteAddress}`);
    // Send initial data immediately so client paints on connect
    wsPushBatch();
    wsPushTraffic();
    wsPushMQT();
    wsPushSMI();
    wsPushComparison();
    wsPushTunnels();
    wsPushOldVps();
    wsPushSiteHealth();
    wsPushJakeInbox();
    wsPushPipeline();
    wsPushYtIntel();
    wsPushMeeting();
    wsPushVisionScore();
    wsPushOpsBoard();
    ws.on('error', () => {});
    ws.on('close', () => console.log('[WS] Client disconnected'));
});

// Push batch every 90s
setInterval(wsPushBatch, 90000);
// Push traffic every 15s
setInterval(wsPushTraffic, 15000);
// Push pipeline every 30s (high-value, fast)
setInterval(wsPushPipeline, 30000);
// Push meeting status every 30s
setInterval(wsPushMeeting, 30000);
// Push MQT every 60s
setInterval(wsPushMQT, 60000);
// Push tunnels every 120s
setInterval(wsPushTunnels, 120000);
// Push YT intel every 120s
setInterval(wsPushYtIntel, 120000);
// Push old VPS every 180s
setInterval(wsPushOldVps, 180000);
// Push SMI every 240s
setInterval(wsPushSMI, 240000);
// Push site health every 300s
setInterval(wsPushSiteHealth, 300000);
// Push trading comparison every 300s
setInterval(wsPushComparison, 300000);
// Push Jake inbox every 300s
setInterval(wsPushJakeInbox, 300000);
// Push vision score every 300s
setInterval(wsPushVisionScore, 300000);
// Push ops board every 30s (real-time status board)
setInterval(wsPushOpsBoard, 30000);

console.log('[WS] WebSocket server ready at ws://localhost:' + PORT + '/ws');

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

// ═══ Newsletter Digest ═══
// ── Newsletter Cache ──
const NEWSLETTER_CACHE_MAX_AGE = 4 * 60 * 60 * 1000; // 4 hours
let newsletterCache = { data: null, timestamp: 0, refreshing: false };

function runNewsletterScan(callback) {
    const digestCmd = `SKILL_DIR=/Users/elf-6/.openclaw/skills/gmail-api /bin/bash /Users/elf-6/.openclaw/skills/gmail-api/newsletter_digest.sh all --json`;
    exec(digestCmd, { timeout: 300000, maxBuffer: 1024 * 1024 * 5, env: { ...process.env, SKILL_DIR: '/Users/elf-6/.openclaw/skills/gmail-api', PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' } }, (err, stdout, stderr) => {
        if (err) { callback(err, null); return; }
        try {
            const jsonStart = stdout.indexOf('{"');
            if (jsonStart >= 0) {
                const data = JSON.parse(stdout.substring(jsonStart));
                callback(null, data);
            } else {
                callback(new Error('No JSON output found'), null);
            }
        } catch (e) {
            callback(new Error('JSON parse error: ' + e.message), null);
        }
    });
}

function refreshNewsletterCache() {
    if (newsletterCache.refreshing) return;
    newsletterCache.refreshing = true;
    console.log('[Newsletter Cache] Refreshing...');
    runNewsletterScan((err, data) => {
        newsletterCache.refreshing = false;
        if (!err && data) {
            newsletterCache.data = data;
            newsletterCache.timestamp = Date.now();
            console.log('[Newsletter Cache] Updated at', new Date().toLocaleTimeString());
        } else {
            console.log('[Newsletter Cache] Refresh failed:', err?.message);
        }
    });
}

function runNewsletterDigest(req, res, query) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const telegram = query && query.telegram === '1';

    // Telegram requests always run live (they send a message, not just read)
    if (telegram) {
        const digestCmd = `SKILL_DIR=/Users/elf-6/.openclaw/skills/gmail-api /bin/bash /Users/elf-6/.openclaw/skills/gmail-api/newsletter_digest.sh all --json --telegram`;
        exec(digestCmd, { timeout: 300000, maxBuffer: 1024 * 1024 * 5, env: { ...process.env, SKILL_DIR: '/Users/elf-6/.openclaw/skills/gmail-api', PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' } }, (err, stdout, stderr) => {
            if (err) { res.end(JSON.stringify({ error: err.message, stderr })); return; }
            try {
                const jsonStart = stdout.indexOf('{"');
                if (jsonStart >= 0) {
                    const data = JSON.parse(stdout.substring(jsonStart));
                    // Also update cache with these results
                    newsletterCache.data = data;
                    newsletterCache.timestamp = Date.now();
                    res.end(JSON.stringify(data));
                } else {
                    res.end(JSON.stringify({ error: 'No JSON output found', raw: stdout.substring(0, 500) }));
                }
            } catch (e) {
                res.end(JSON.stringify({ error: 'JSON parse error: ' + e.message, raw: stdout.substring(0, 500) }));
            }
        });
        return;
    }

    // Non-telegram: serve from cache if fresh
    const cacheAge = Date.now() - newsletterCache.timestamp;
    if (newsletterCache.data && cacheAge < NEWSLETTER_CACHE_MAX_AGE) {
        const cacheAgeMin = Math.round(cacheAge / 60000);
        res.end(JSON.stringify({ ...newsletterCache.data, cached: true, cache_age_min: cacheAgeMin }));
        return;
    }

    // Cache stale or empty
    if (newsletterCache.data) {
        // Return stale cache immediately, refresh in background
        const cacheAgeMin = Math.round(cacheAge / 60000);
        res.end(JSON.stringify({ ...newsletterCache.data, cached: true, cache_age_min: cacheAgeMin, stale: true }));
        refreshNewsletterCache();
        return;
    }

    // No cache at all — must run live (first-ever load)
    runNewsletterScan((err, data) => {
        if (err) {
            res.end(JSON.stringify({ error: err.message }));
        } else {
            newsletterCache.data = data;
            newsletterCache.timestamp = Date.now();
            res.end(JSON.stringify(data));
        }
    });
}

// ── Communications Center: Unified Inbox with AI Screening ──
const MESSAGES_CACHE_TTL = 30 * 60 * 1000; // 30 min
let messagesCache = { data: null, timestamp: 0, refreshing: false };

function getScreenedMessages(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const cacheAge = Date.now() - messagesCache.timestamp;
    if (messagesCache.data && cacheAge < MESSAGES_CACHE_TTL) {
        res.end(JSON.stringify({ ...messagesCache.data, cached: true, cache_age_min: Math.round(cacheAge / 60000) }));
        return;
    }

    if (messagesCache.refreshing && messagesCache.data) {
        res.end(JSON.stringify({ ...messagesCache.data, cached: true, cache_age_min: Math.round(cacheAge / 60000), stale: true }));
        return;
    }

    messagesCache.refreshing = true;
    const collectScript = path.join(__dirname, 'collect_messages.py');
    exec(`/opt/homebrew/bin/python3 ${collectScript}`, { timeout: 120000, maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
        if (err) {
            messagesCache.refreshing = false;
            res.end(JSON.stringify({ ok: false, error: 'Collection failed: ' + err.message, messages: [] }));
            return;
        }

        let rawMessages;
        try {
            rawMessages = JSON.parse(stdout);
        } catch (e) {
            messagesCache.refreshing = false;
            res.end(JSON.stringify({ ok: false, error: 'Parse error', messages: [] }));
            return;
        }

        // No filtering — show ALL messages, just tag importance
        const allMessages = rawMessages.messages;
        // Opportunity keywords — things that signal a potential deal/lead
        const oppKeywords = ['looking for', 'need help', 'anyone know', 'recommend', 'who does',
            'partnership', 'collab', 'project', 'contract', 'client', 'deal', 'revenue',
            'opportunity', 'budget', 'proposal', 'quote', 'pitch', 'gig', 'freelance',
            'hire', 'hiring', 'agency', 'service', 'outsource', 'marketing', 'website',
            'lead gen', 'ads', 'seo', 'funnel', 'saas', 'startup', 'invest', 'funding'];

        const kept = allMessages.map(m => {
            let importance = 'medium';
            let ai_reason = '';
            let is_opportunity = false;
            const preview = (m.preview || '').toLowerCase();
            const from = (m.from || '').toLowerCase();
            const subject = (m.subject || '').toLowerCase();

            // Gmail importance classification
            if (m.channel === 'gmail') {
                if (m.starred) {
                    importance = 'high'; ai_reason = 'Starred';
                } else if (subject.includes('invitation') || subject.includes('meeting') || subject.includes('calendar') || subject.includes('rsvp') || subject.includes('invite')) {
                    importance = 'high'; ai_reason = 'Meeting/Calendar invite';
                } else if (subject.includes('payment') || subject.includes('invoice') || subject.includes('bill') || subject.includes('past due') || subject.includes('overdue')) {
                    importance = 'high'; ai_reason = 'Payment/Billing';
                } else if (subject.includes('action required') || subject.includes('urgent') || subject.includes('important') || subject.includes('confirm') || subject.includes('verify') || subject.includes('approve')) {
                    importance = 'high'; ai_reason = 'Action required';
                }
            }
            // iMessage — personal messages, default high
            if (m.channel === 'imessage') {
                importance = 'high'; ai_reason = 'Personal message';
            }
            // Google Voice — personal messages, default high
            if (m.channel === 'gvoice') {
                importance = 'high'; ai_reason = 'Voice/Text message';
            }

            // Rocket Community = lawsuit-related, always high priority
            if (from.includes('rocket') && m.channel === 'telegram') {
                importance = 'high';
                ai_reason = 'Rocket Community — lawsuit action item';
            // TLV.zone = important group, auto-task + high priority
            } else if (from.includes('tlv') && m.channel === 'telegram') {
                importance = 'high';
                ai_reason = 'TLV.zone — important group';
                m._auto_task = true;
            // Liquid Pay / Bank / Bitcoin Code — flag announcements & US-related news
            } else if (m.channel === 'telegram' && (from.includes('liquid') || from.includes('bank') || from.includes('bitcoin code'))) {
                const flagWords = ['announcement', 'major', 'united states', 'usa', 'u.s.', 'america', 'us market', 'us launch', 'regulation', 'sec', 'federal', 'congress'];
                const matched = flagWords.find(kw => preview.includes(kw));
                if (matched) {
                    importance = 'high';
                    ai_reason = `${from.split('›')[0].trim()} — "${matched}"`;
                }
            } else if (preview.includes('blocked') || preview.includes('urgent') || preview.includes('asap') || preview.includes('waiting on you')) {
                importance = 'high';
            }
            // Opportunity detection for Telegram messages
            if (m.channel === 'telegram' && !from.startsWith('→')) {
                const matchedKw = oppKeywords.find(kw => preview.includes(kw));
                if (matchedKw) {
                    is_opportunity = true;
                    ai_reason = ai_reason || `Potential opportunity — "${matchedKw}"`;
                }
            }
            return { ...m, importance, ai_reason, is_opportunity };
        });
        const screenedOut = 0;

        // Auto-create tasks for TLV.zone messages (fire-and-forget, don't block response)
        const autoTaskFile = path.join(__dirname, '.auto_tasks_created.json');
        let createdIds = {};
        try { createdIds = JSON.parse(fs.readFileSync(autoTaskFile, 'utf8')); } catch(e) {}
        for (const m of kept) {
            if (m._auto_task && !createdIds[m.id]) {
                createdIds[m.id] = Date.now();
                const taskName = `[TLV.zone] ${(m.preview || '').substring(0, 80)}`;
                createNotionTask({ name: taskName, priority: 'High', role: 'CEO', url: m.url || '' }).catch(() => {});
            }
            delete m._auto_task;
        }
        try { fs.writeFileSync(autoTaskFile, JSON.stringify(createdIds)); } catch(e) {}

        messagesCache.data = {
            ok: true,
            messages: kept,
            screened_out: screenedOut,
            total_raw: allMessages.length,
            generated: new Date().toISOString(),
            channels: rawMessages.channels
        };
        messagesCache.timestamp = Date.now();
        messagesCache.refreshing = false;
        res.end(JSON.stringify(messagesCache.data));
    });
}


function runSkoolDigest(req, res, query) {
    const telegram = query && query.telegram === '1' ? '--telegram' : '';
    const digestCmd = `SKILL_DIR=/Users/elf-6/.openclaw/skills/gmail-api /bin/bash /Users/elf-6/.openclaw/skills/gmail-api/skool_digest.sh --json ${telegram}`;

    exec(digestCmd, { timeout: 600000, maxBuffer: 1024 * 1024 * 10, env: { ...process.env, SKILL_DIR: '/Users/elf-6/.openclaw/skills/gmail-api', PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' } }, (err, stdout, stderr) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (err) {
            res.end(JSON.stringify({ error: err.message, stderr: stderr }));
            return;
        }
        try {
            const jsonStart = stdout.indexOf('{"');
            if (jsonStart >= 0) {
                const data = JSON.parse(stdout.substring(jsonStart));
                res.end(JSON.stringify(data));
            } else {
                res.end(JSON.stringify({ error: 'No JSON output found', raw: stdout.substring(0, 500) }));
            }
        } catch (e) {
            res.end(JSON.stringify({ error: 'JSON parse error: ' + e.message, raw: stdout.substring(0, 500) }));
        }
    });
}

// ═══ Skool Direct Scraper Endpoints ═══

async function handleSkoolScrape(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const parsedUrl = require('url').parse(req.url, true);
    const method = parsedUrl.query.method || 'api'; // 'api' (default, fast) or 'browser' (Puppeteer fallback)

    try {
        let scraperResult;

        if (method === 'api') {
            // API approach — lightweight HTTP requests, no browser needed
            console.log('[Skool Scrape] Starting API scrape...');
            const configPath = skoolScraper.CONFIG_PATH;
            const unreads = parsedUrl.query.unreads === '1';
            scraperResult = await new Promise((resolve, reject) => {
                const args = [
                    path.join(__dirname, 'skool-api', 'skool_api_scrape.py'),
                    '--config', configPath
                ];
                if (unreads) args.push('--unreads');

                const { execFile } = require('child_process');
                execFile('python3', args, { timeout: 120000 }, (err, stdout, stderr) => {
                    if (stderr) console.log('[Skool API]', stderr.trim());
                    if (err) {
                        console.error('[Skool API] Error:', err.message);
                        reject(err);
                        return;
                    }
                    try {
                        resolve(JSON.parse(stdout));
                    } catch (e) {
                        reject(new Error('Failed to parse API scraper output'));
                    }
                });
            });
        } else {
            // Puppeteer approach — full browser, slower but handles JS-heavy pages
            console.log('[Skool Scrape] Starting browser scrape...');
            scraperResult = await skoolScraper.scrapeAllCommunities();
        }

        if (!scraperResult.meta.session_ok) {
            res.end(JSON.stringify({ error: scraperResult.meta.error || 'Session expired', session_ok: false }));
            return;
        }

        if (scraperResult.meta.total_posts === 0) {
            const cached = skoolPipeline.getCachedResults();
            if (cached) {
                cached.from_cache = true;
                res.end(JSON.stringify(cached));
            } else {
                res.end(JSON.stringify({ total: 0, classrooms: [], videos: [], themes: null, theme_count: 0, video_count: 0 }));
            }
            return;
        }

        const config = skoolScraper.loadConfig();
        const enriched = await skoolPipeline.enrichScrapeResults(scraperResult, config);
        console.log(`[Skool Scrape] Done (${method}): ${enriched.total} posts, ${enriched.video_count} videos`);
        res.end(JSON.stringify(enriched));
    } catch (e) {
        console.error('[Skool Scrape] Error:', e);
        res.end(JSON.stringify({ error: e.message }));
    }
}

function getCommandBriefing(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const briefPath = '/Users/elf-6/openclaw/shared/COMMAND_BRIEFING.md';
    try {
        const content = fs.readFileSync(briefPath, 'utf8');
        const genMatch = content.match(/\*\*Generated:\*\*\s*(.+)/);
        const generated = genMatch ? genMatch[1].trim() : '';
        res.end(JSON.stringify({ ok: true, content, generated }));
    } catch (e) {
        res.end(JSON.stringify({ ok: false, error: 'Briefing not available: ' + e.message }));
    }
}

function handleSkoolConfig(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const updates = JSON.parse(body);
                const config = skoolScraper.loadConfig();
                if (updates.communities) config.communities = updates.communities;
                if (updates.scrollDepth) config.scrollDepth = updates.scrollDepth;
                if (updates.maxVideosPerRun) config.maxVideosPerRun = updates.maxVideosPerRun;
                skoolScraper.saveConfig(config);
                res.end(JSON.stringify({ ok: true, config }));
            } catch (e) {
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
    } else {
        const config = skoolScraper.loadConfig();
        res.end(JSON.stringify(config));
    }
}

async function handleSkoolAuth(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'POST') {
        // Launch visible browser for auth — non-blocking, just starts it
        skoolScraper.launchAuth().catch(() => {});
        res.end(JSON.stringify({ ok: true, message: 'Browser launched for Skool login. Close the browser when done.' }));
    } else {
        // Check session status
        const ok = await skoolScraper.checkSession();
        res.end(JSON.stringify({ session_ok: ok }));
    }
}

function handleCreateTask(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        try {
            const data = JSON.parse(body);
            const result = await createNotionTask({ name: data.name, priority: data.priority, role: data.role, url: data.url || '' });
            res.end(JSON.stringify(result));
        } catch(e) {
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
    });
}

function handleBriefingTasksRun(req, res, query) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    (async () => {
        try {
            const raw = query && query.data ? Buffer.from(query.data, 'base64').toString('utf8') : null;
            if (!raw) { res.writeHead(400, {'Content-Type': 'text/plain'}); res.end('Missing data param'); return; }
            const { tasks } = JSON.parse(raw);
            const results = await Promise.all(tasks.map(t =>
                createNotionTask({
                    name: t.name,
                    priority: t.priority || 'Medium',
                    role: 'CEO',
                    url: t.url || '',
                    globalTags: ['02 – Priority'],
                }).then(r => ({ ok: true, name: t.name, id: r.id }))
                  .catch(e => ({ ok: false, name: t.name, error: e.message }))
            ));
            const ok = results.filter(r => r.ok);
            const fail = results.filter(r => !r.ok);
            const html = `<!DOCTYPE html><html><head><meta charset=utf-8><title>CEO Tasks</title>
<style>body{font-family:system-ui;background:#111;color:#eee;max-width:520px;margin:60px auto;padding:20px}
h2{color:${fail.length===0?'#4ade80':'#facc15'}}.ok{color:#4ade80}.fail{color:#f87171}li{margin:6px 0}
.done{margin-top:24px;color:#888;font-size:14px}</style></head><body>
<h2>${fail.length===0?'✅':'⚠️'} ${ok.length} task${ok.length!==1?'s':''} created in Notion${fail.length>0?' ('+fail.length+' failed)':''}</h2>
<ul>${ok.map(r=>'<li class=ok>✓ '+r.name+'</li>').join('')}${fail.map(r=>'<li class=fail>✗ '+r.name+': '+r.error+'</li>').join('')}</ul>
<p class=done>You can close this tab.</p></body></html>`;
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(html);
        } catch(e) {
            res.writeHead(500, {'Content-Type': 'text/plain'});
            res.end('Error: ' + e.message);
        }
    })();
}
function handleBriefingTasks(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        try {
            const data = JSON.parse(body);
            const tasks = Array.isArray(data.tasks) ? data.tasks : [data];
            const results = await Promise.all(tasks.map(t =>
                createNotionTask({
                    name: t.name,
                    priority: t.priority || 'Medium',
                    role: 'CEO',
                    url: t.url || '',
                    globalTags: ['02 – Priority'],
                }).then(r => ({ ok: true, name: t.name, id: r.id }))
                  .catch(e => ({ ok: false, name: t.name, error: e.message }))
            ));
            const failed = results.filter(r => !r.ok);
            res.end(JSON.stringify({ ok: failed.length === 0, results }));
        } catch(e) {
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
    });
}
function archiveGmailMessage(req, res, query) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const msgId = query && query.id;
    if (!msgId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing ?id= parameter' }));
        return;
    }
    // Sanitize — Gmail API IDs are alphanumeric
    const cleanId = String(msgId).replace(/[^a-zA-Z0-9]/g, '');
    if (!cleanId) {
        res.end(JSON.stringify({ ok: false, error: 'Invalid id' }));
        return;
    }
    // Use Gmail API skill to archive (removes INBOX label)
    const cmd = `SKILL_DIR=/Users/elf-6/.openclaw/skills/gmail-api /bin/bash /Users/elf-6/.openclaw/skills/gmail-api/gmail_skill.sh archive ${cleanId}`;
    exec(cmd, { timeout: 15000, env: { ...process.env, SKILL_DIR: '/Users/elf-6/.openclaw/skills/gmail-api', PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' } }, (err, stdout) => {
        if (err) {
            res.end(JSON.stringify({ ok: false, error: err.message }));
        } else {
            res.end(JSON.stringify({ ok: true, archived: cleanId }));
        }
    });
}

function labelGmailMessage(req, res, query) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const msgId = query && query.id;
    const label = query && query.label;
    if (!msgId || !label) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing ?id= or ?label= parameter' }));
        return;
    }
    const cleanId = String(msgId).replace(/[^a-zA-Z0-9]/g, '');
    const cleanLabel = String(label).replace(/[^a-zA-Z0-9_ -]/g, '');
    if (!cleanId || !cleanLabel) {
        res.end(JSON.stringify({ ok: false, error: 'Invalid id or label' }));
        return;
    }
    const cmd = `SKILL_DIR=/Users/elf-6/.openclaw/skills/gmail-api /bin/bash /Users/elf-6/.openclaw/skills/gmail-api/gmail_skill.sh label ${cleanId} ${cleanLabel}`;
    exec(cmd, { timeout: 15000, env: { ...process.env, SKILL_DIR: '/Users/elf-6/.openclaw/skills/gmail-api', PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' } }, (err, stdout) => {
        if (err) {
            res.end(JSON.stringify({ ok: false, error: err.message }));
        } else {
            res.end(JSON.stringify({ ok: true, labeled: cleanId, label: cleanLabel }));
        }
    });
}

// ═══ Gmail Interest Feed ═══
let interestCache = { data: null, timestamp: 0 };
const INTEREST_CACHE_TTL = 15 * 60 * 1000; // 15 min (Ollama summaries are expensive)

function getGmailInterest(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const bust = url.parse(req.url, true).query.bust;
    const cacheAge = Date.now() - interestCache.timestamp;
    if (!bust && interestCache.data && cacheAge < INTEREST_CACHE_TTL) {
        res.end(JSON.stringify({ ...interestCache.data, cached: true, cache_age_min: Math.round(cacheAge / 60000) }));
        return;
    }

    const scriptPath = path.join(__dirname, 'gmail_interest.py');
    exec(`/opt/homebrew/bin/python3 ${scriptPath}`, { timeout: 300000, maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
        if (err) {
            res.end(JSON.stringify({ error: err.message, messages: [], total: 0, senders: [] }));
            return;
        }
        try {
            const data = JSON.parse(stdout);
            interestCache.data = data;
            interestCache.timestamp = Date.now();
            res.end(JSON.stringify(data));
        } catch(e) {
            res.end(JSON.stringify({ error: 'Parse error: ' + e.message, messages: [], total: 0 }));
        }
    });
}

// ═══ CEO's Corner API Handlers ═══

const DRILL_STATE_PATH = '/Users/elf-6/openclaw/logs/drill_state.json';
const DRILL_RESULTS_DIR = '/Users/elf-6/openclaw/shared/drill_results';
const CEO_REVIEW_DIR = '/Users/elf-6/openclaw/shared/2_CEO_review';

function getCeoCornerDrills(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
        let state = { day: 0, last_run: '', scores: [], total_drills: 0 };
        if (fs.existsSync(DRILL_STATE_PATH)) {
            state = JSON.parse(fs.readFileSync(DRILL_STATE_PATH, 'utf8'));
        }

        const history = (state.scores || []).map(s => ({
            day: s.day,
            date: s.date,
            total: s.score || s.total || 0,
            s1: s.s1 || 0,
            s2: s.s2 || 0,
            s3: s.s3 || 0,
            s4: s.s4 || 0,
            s5: s.s5 || 0,
            s6: s.s6 || 0
        }));

        const latest = history.length > 0 ? history[history.length - 1] : null;
        const avgScore = history.length > 0
            ? (history.reduce((sum, h) => sum + h.total, 0) / history.length).toFixed(1)
            : null;

        res.end(JSON.stringify({
            latest,
            history,
            totalDrills: state.total_drills || history.length,
            avgScore,
            currentDay: state.day,
            lastRun: state.last_run
        }));
    } catch (e) {
        res.end(JSON.stringify({ latest: null, history: [], totalDrills: 0, avgScore: null, error: e.message }));
    }
}

function getCeoCornerReview(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
        const items = [];
        if (fs.existsSync(CEO_REVIEW_DIR)) {
            const files = fs.readdirSync(CEO_REVIEW_DIR)
                .filter(f => !f.startsWith('.') && f !== 'Strategy')
                .map(f => {
                    const stat = fs.statSync(path.join(CEO_REVIEW_DIR, f));
                    return { name: f, date: stat.mtime.toISOString().split('T')[0], size: formatSize(stat.size), mtime: stat.mtimeMs };
                })
                .sort((a, b) => b.mtime - a.mtime);
            items.push(...files.map(f => {
                let badge = '';
                if (f.name.startsWith('TAS-')) badge = 'Task';
                else if (f.name.includes('POC')) badge = 'POC';
                else if (f.name.includes('Audit') || f.name.includes('audit')) badge = 'Audit';
                else if (f.name.includes('Strategy') || f.name.includes('Doctrine')) badge = 'Strategy';
                return { name: f.name.replace(/\.md$/, '').replace(/_/g, ' '), date: f.date, size: f.size, badge };
            }));
        }
        res.end(JSON.stringify({ items }));
    } catch (e) {
        res.end(JSON.stringify({ items: [], error: e.message }));
    }
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Content Intelligence Pipeline ──────────────────────────────────
const CONTENT_INTEL_FILE = path.join(__dirname, 'content-intel-data.json');

function loadContentIntel() {
    try {
        return JSON.parse(fs.readFileSync(CONTENT_INTEL_FILE, 'utf8'));
    } catch(e) {
        return { lastScan: null, weeklyStats: { nuggets: 0, videos: 0, avgScore: 0 }, recentNuggets: [], channelStats: {} };
    }
}

function saveContentIntel(data) {
    fs.writeFileSync(CONTENT_INTEL_FILE, JSON.stringify(data, null, 2));
}

function handleContentIntel(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });

    if (req.method === 'GET') {
        res.end(JSON.stringify(loadContentIntel()));
        return;
    }

    if (req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const nugget = JSON.parse(body);
                const data = loadContentIntel();
                data.lastScan = new Date().toISOString();

                // Add nugget to recent list (keep last 50)
                data.recentNuggets.unshift({
                    videoId: nugget.videoId || '',
                    title: nugget.title || '',
                    channel: nugget.channelName || nugget.channel || '',
                    score: nugget.relevance_score || nugget.score || 0,
                    verdict: nugget.verdict || '',
                    verdict_reason: nugget.verdict_reason || '',
                    video_summary: nugget.video_summary || [],
                    key_highlights: (nugget.key_highlights || []).slice(0, 5),
                    agent_assignments: nugget.agent_assignments || [],
                    tools_mentioned: nugget.tools_mentioned || [],
                    revenue_potential: nugget.revenue_potential || null,
                    nuggets: (nugget.nuggets || []).slice(0, 5),
                    summary: nugget.summary || '',
                    tags: nugget.tags || [],
                    actionItems: nugget.action_items || nugget.actionItems || [],
                    url: nugget.url || '',
                    timestamp: new Date().toISOString()
                });
                if (data.recentNuggets.length > 50) data.recentNuggets = data.recentNuggets.slice(0, 50);

                // Update channel stats
                const ch = nugget.channelName || nugget.channel || 'Unknown';
                if (!data.channelStats[ch]) data.channelStats[ch] = { videos: 0, totalScore: 0, avgScore: 0 };
                data.channelStats[ch].videos++;
                data.channelStats[ch].totalScore += (nugget.relevance_score || nugget.score || 0);
                data.channelStats[ch].avgScore = Math.round((data.channelStats[ch].totalScore / data.channelStats[ch].videos) * 10) / 10;

                // Recalculate weekly stats (last 7 days)
                const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
                const weekNuggets = data.recentNuggets.filter(n => new Date(n.timestamp).getTime() > weekAgo);
                data.weeklyStats = {
                    nuggets: weekNuggets.reduce((sum, n) => sum + (n.nuggets?.length || 1), 0),
                    videos: weekNuggets.length,
                    avgScore: weekNuggets.length ? Math.round(weekNuggets.reduce((s, n) => s + n.score, 0) / weekNuggets.length * 10) / 10 : 0
                };

                saveContentIntel(data);
                res.end(JSON.stringify({ ok: true, totalNuggets: data.recentNuggets.length }));
            } catch(e) {
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    res.end(JSON.stringify({ error: 'GET or POST only' }));
}

function handleCeoIntelBrief(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    if (req.method !== 'POST') { res.end(JSON.stringify({ error: 'POST only' })); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
        try {
            const { filename, content } = JSON.parse(body);
            if (!filename || !content) { res.end(JSON.stringify({ error: 'filename and content required' })); return; }
            const safeName = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
            const filePath = path.join(CEO_REVIEW_DIR, safeName);
            fs.writeFileSync(filePath, content, 'utf8');
            res.end(JSON.stringify({ ok: true, path: filePath }));
        } catch(e) {
            res.end(JSON.stringify({ error: e.message }));
        }
    });
}

// ── Audit Click Tracking ────────────────────────────────────────────────
function getAuditClicks(req, res) {
    // Read prospect data and find those with "Interested" stage (set by n8n webhook on click)
    const MC_URL = 'http://localhost:' + (server.address()?.port || 8899);
    // Query prospects directly from the pipeline
    try {
        const prospectsFile = path.join(process.env.HOME, 'openclaw/shared/outreach_queue');
        const pipelineDir = path.join(process.env.HOME, 'openclaw/shared/config/pipelines');

        // Scan audit dirs for aiso.json (has click data via prospect updates)
        const auditsDir = path.join(process.env.HOME, 'openclaw/shared/audits/dwe-marketing');
        const clicks = [];
        if (fs.existsSync(auditsDir)) {
            for (const leadDir of fs.readdirSync(auditsDir)) {
                const auditPath = path.join(auditsDir, leadDir, 'audit.json');
                const summaryPath = path.join(auditsDir, leadDir, 'AUDIT-SUMMARY.md');
                if (fs.existsSync(summaryPath)) {
                    const md = fs.readFileSync(summaryPath, 'utf8');
                    const nameMatch = md.match(/^# .*?— (.+)$/m);
                    const scoreMatch = md.match(/Score:\s*([\d.]+)\/100/);
                    clicks.push({
                        lead_id: leadDir,
                        business_name: nameMatch ? nameMatch[1].trim() : leadDir,
                        audit_score: scoreMatch ? parseFloat(scoreMatch[1]) : 0,
                        has_report: fs.existsSync(path.join(auditsDir, leadDir, 'AUDIT-REPORT.pdf')),
                        has_aiso: fs.existsSync(path.join(auditsDir, leadDir, 'aiso.json')),
                    });
                }
            }
        }

        const json = JSON.stringify({
            total_audits: clicks.length,
            with_reports: clicks.filter(c => c.has_report).length,
            with_aiso: clicks.filter(c => c.has_aiso).length,
            audits: clicks.slice(-20).reverse(),
        });
        sendCompressed(req, res, 200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, Buffer.from(json));
    } catch (e) {
        sendCompressed(req, res, 200, { 'Content-Type': 'application/json' }, Buffer.from(JSON.stringify({ error: e.message })));
    }
}

// ── Jake Email Dashboard — real-time inbox status via Gmail API ─────────
function getJakeInbox(req, res) {
    const { execSync } = require('child_process');
    try {
        const result = execSync('python3 /Users/elf-6/openclaw/bin/jake_inbox_status.py', {
            timeout: 30000,
            env: { ...process.env, HOME: process.env.HOME }
        }).toString();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
        res.end(result);
    } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message?.substring(0, 300) || 'Unknown error' }));
    }
}

// ── Autoresearch Status ─────────────────────────────────────────────────
function getAutoresearchStatus(req, res) {
    const baseDir = path.join(process.env.HOME, 'openclaw/shared/config/pipelines/dwe-marketing/autoresearch');
    const resultsPath = path.join(baseDir, 'results.tsv');
    const promptLabPath = path.join(baseDir, 'prompt_lab.md');
    const baselinePath = path.join(baseDir, 'prompt_lab_baseline.md');

    const result = {
        total_experiments: 0,
        improvements: 0,
        best_score: 0,
        last_experiment: null,
        recent: [],
        prompt_changed: false,
        daemon_loaded: false,
    };

    // Check if daemon is loaded
    try {
        const launchctlOut = require('child_process').execSync('launchctl list 2>/dev/null | grep autoresearch || true', { encoding: 'utf8' });
        result.daemon_loaded = launchctlOut.includes('ai.dwe.autoresearch');
    } catch (e) { /* ignore */ }

    // Check if prompt has been modified from baseline
    try {
        const lab = fs.readFileSync(promptLabPath, 'utf8');
        const baseline = fs.readFileSync(baselinePath, 'utf8');
        result.prompt_changed = lab !== baseline;
    } catch (e) { /* ignore */ }

    // Parse results.tsv
    try {
        const tsv = fs.readFileSync(resultsPath, 'utf8').trim().split('\n');
        if (tsv.length > 1) {
            const rows = tsv.slice(1).map(line => {
                const [exp_id, timestamp, mode, score, baseline, strategy, status, model] = line.split('\t');
                return { exp_id, timestamp, mode, score: parseFloat(score) || 0, baseline: parseFloat(baseline) || 0, strategy, status, model };
            });
            result.total_experiments = rows.length;
            result.improvements = rows.filter(r => r.status === 'kept').length;
            const kept = rows.filter(r => r.status === 'kept');
            result.best_score = kept.length > 0 ? Math.max(...kept.map(r => r.score)) : 0;
            result.last_experiment = rows[rows.length - 1] || null;
            result.recent = rows.slice(-10).reverse();
        }
    } catch (e) { /* no results yet */ }

    const json = JSON.stringify(result);
    sendCompressed(req, res, 200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, Buffer.from(json));
}

// ── TVC Website Button Click Tracking ──────────────────────────────────
const CLICK_LOG = path.join(__dirname, 'tvc_click_log.json');

function trackButtonClick(req, res) {
    // Accept GET (from pixel/beacon) or POST
    const query = url.parse(req.url, true).query || {};
    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                logClick(data);
            } catch(e) {
                logClick(query);
            }
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end('{"ok":true}');
        });
    } else {
        logClick(query);
        // Return 1x1 transparent GIF for beacon/img tracking
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
        res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    }
}

function logClick(data) {
    const entry = {
        ts: new Date().toISOString(),
        page: data.page || 'unknown',
        button: data.button || 'unknown',
        href: data.href || '',
        ua: data.ua || '',
        ref: data.ref || ''
    };
    let log = [];
    try { log = JSON.parse(fs.readFileSync(CLICK_LOG, 'utf8')); } catch(e) {}
    log.push(entry);
    // Keep last 10,000 clicks
    if (log.length > 10000) log = log.slice(-10000);
    fs.writeFileSync(CLICK_LOG, JSON.stringify(log, null, 2));
}

function getClickStats(req, res) {
    let log = [];
    try { log = JSON.parse(fs.readFileSync(CLICK_LOG, 'utf8')); } catch(e) {}
    const today = new Date().toISOString().split('T')[0];
    const todayClicks = log.filter(e => e.ts.startsWith(today));
    // Group by button
    const byButton = {};
    const byPage = {};
    log.forEach(e => {
        byButton[e.button] = (byButton[e.button] || 0) + 1;
        byPage[e.page] = (byPage[e.page] || 0) + 1;
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
        ok: true,
        total_clicks: log.length,
        today_clicks: todayClicks.length,
        by_button: byButton,
        by_page: byPage,
        recent: log.slice(-20).reverse()
    }));
}

// Handle errors gracefully
process.on('uncaughtException', (err) => {
    console.error('Server error:', err);
});

process.on('SIGTERM', () => {
    console.log('Shutting down...');
    server.close(() => process.exit(0));
});

// ── Intel Signals Dashboard Widget ──────────────────────────────────────────
function getIntelSignals(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const INTEL_FILE = path.join(process.env.HOME, 'openclaw/shared/intel/latest_signals.json');
    try {
        const raw = fs.readFileSync(INTEL_FILE, 'utf8');
        const data = JSON.parse(raw);
        const allSignals = data.all_signals || [];
        const topSignals = data.top_signals || [];
        // Return top 20 by score, with filter params from query
        const feed = parsedUrl.query.feed || '';
        const limit = Math.min(parseInt(parsedUrl.query.limit) || 20, 100);
        let filtered = feed
            ? allSignals.filter(s => s.source === feed)
            : allSignals;
        filtered = filtered
            .sort((a, b) => (b.score || 0) - (a.score || 0))
            .slice(0, limit)
            .map(s => ({
                ticker:    s.ticker    || '',
                action:    s.action    || '',
                amount_usd: s.amount_usd || 0,
                score:     s.score     || 0,
                date:      s.date      || '',
                sector:    s.sector    || '',
                source:    s.source    || ''
            }));
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache'
        });
        res.end(JSON.stringify({
            ok: true,
            count: filtered.length,
            total: allSignals.length,
            generated: data.generated_at,
            feeds: Object.keys(data.by_source || {}),
            signals: filtered
        }));
    } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
    }
}

