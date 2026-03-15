/**
 * DWE Operations Log — Centralized event log for all systems
 *
 * Any system can POST events. Each event has a type (delegation, sprint, jarvis, workflow, etc.)
 * The UI filters by type into tabs. Master tab shows everything.
 *
 * Event format:
 * {
 *   type: 'delegation' | 'sprint' | 'jarvis' | 'workflow' | string,
 *   icon: '🔗',
 *   detail: 'Steve → CE: Fix API endpoint',
 *   meta: { ... }   // optional extra data per event type
 * }
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const LOG_FILE = path.join(process.env.HOME || '/Users/elf-6', 'openclaw/logs/ops_events.json');
const MAX_EVENTS = 5000; // keep last 5000 events
const CHANGELOG_WEBHOOK = 'https://n8n.tvcpulse.com/webhook/dwe-ops-changelog';

function loadEvents() {
    try {
        if (fs.existsSync(LOG_FILE)) return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    } catch(e) {}
    return { events: [], types: {} };
}

function saveEvents(data) {
    try {
        const dir = path.dirname(LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(LOG_FILE, JSON.stringify(data));
    } catch(e) { console.error('[ops-log] Save error:', e.message); }
}

function pushToChangelog(event) {
    try {
        const payload = JSON.stringify({
            timestamp: event.timestamp,
            user: event.type,
            tab: event.meta.tab || '',
            changeType: event.type,
            recordId: event.meta.taskId || event.meta.recordId || '',
            field: event.meta.field || '',
            oldValue: event.meta.oldValue || '',
            newValue: event.detail,
            notes: event.icon + ' ' + (event.meta.notes || ''),
            id: event.id
        });
        const url = new URL(CHANGELOG_WEBHOOK);
        const req = https.request({
            hostname: url.hostname, path: url.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        });
        req.on('error', () => {}); // fire-and-forget
        req.write(payload);
        req.end();
    } catch(e) { /* non-blocking */ }
}

function logEvent(type, icon, detail, meta = {}) {
    const data = loadEvents();
    const event = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        type: type,
        icon: icon,
        detail: detail,
        meta: meta,
        timestamp: new Date().toISOString()
    };
    data.events.push(event);

    // Track known types
    if (!data.types[type]) data.types[type] = { count: 0, label: type.charAt(0).toUpperCase() + type.slice(1) };
    data.types[type].count++;

    // Trim to max
    if (data.events.length > MAX_EVENTS) {
        data.events = data.events.slice(-MAX_EVENTS);
    }

    saveEvents(data);

    // Push to Google Sheet ChangeLog via n8n (fire-and-forget)
    pushToChangelog(event);

    return event;
}

function getEvents(type = null, limit = 200, offset = 0) {
    const data = loadEvents();
    let events = data.events;
    if (type && type !== 'all') {
        events = events.filter(e => e.type === type);
    }
    // Newest first
    events = events.slice().reverse().slice(offset, offset + limit);
    return {
        events: events,
        types: data.types,
        total: data.events.length
    };
}

module.exports = { logEvent, getEvents };
