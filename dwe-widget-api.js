/**
 * DWE Widget API
 * Fetches Notion stats and caches them
 */

const https = require('https');
const fs = require('fs');
const NOTION_API_KEY = (() => {
    try { const k = fs.readFileSync(`${process.env.HOME}/.openclaw/.env`, 'utf8').match(/NOTION_API_KEY="?([^"\n]+)"?/)?.[1]?.trim(); if (k) return k; } catch(e) {}
    return process.env.NOTION_API_KEY || '';
})();
const NOTION_DB_ID = '2f797f89-9129-8068-b8ae-c4321d1c72b7';

// Cache for stats
let cachedStats = null;
let cacheTime = 0;
const CACHE_DURATION = 60 * 1000; // 1 minute

// Cache for all tasks (expensive — 15s to fetch 1200+ tasks)
let cachedTasks = null;
let tasksCacheTime = 0;
const TASKS_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function fetchAllNotionTasks() {
    // Return cached tasks if fresh (avoids 15s Notion API pagination)
    const now = Date.now();
    if (cachedTasks && (now - tasksCacheTime) < TASKS_CACHE_DURATION) {
        return cachedTasks;
    }

    // If cache is stale but exists, return stale cache and refresh in background
    if (cachedTasks) {
        // Trigger background refresh
        _refreshTasksInBackground();
        return cachedTasks;
    }

    // First load — must wait
    return await _fetchTasksFromNotion();
}

let _refreshing = false;
async function _refreshTasksInBackground() {
    if (_refreshing) return;
    _refreshing = true;
    try {
        const tasks = await _fetchTasksFromNotion();
        cachedTasks = tasks;
        tasksCacheTime = Date.now();
    } catch(e) { console.error('[DWE Widget] Background refresh failed:', e.message); }
    _refreshing = false;
}

async function _fetchTasksFromNotion() {
    const allTasks = [];
    let hasMore = true;
    let nextCursor = null;

    while (hasMore && allTasks.length < 3000) {
        const options = {
            hostname: 'api.notion.com',
            path: `/v1/databases/${NOTION_DB_ID}/query`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${NOTION_API_KEY}`,
                'Notion-Version': '2022-06-28',
                'Content-Type': 'application/json'
            }
        };
        
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
                
                return {
                    id: task.id,
                    idNumber: props.ID?.unique_id?.number || 0,
                    name: props['Task name']?.title?.[0]?.plain_text || 'Untitled',
                    status: status,
                    priority: props.Priority?.select?.name || 'Medium',
                    role: props.Role?.select?.name || 'Unassigned',
                    dueDate: props['Due date']?.date?.start || null,
                    pastDue: props['Past due']?.formula?.boolean || false,
                    taskType: props['Task type']?.select?.name || '',
                    summary: props.Summary?.rich_text?.[0]?.plain_text || ''
                };
            });
            allTasks.push(...tasks);
        }
        
        hasMore = response.has_more;
        nextCursor = response.next_cursor;
    }

    // Cache the results
    cachedTasks = allTasks;
    tasksCacheTime = Date.now();
    console.log(`[DWE Widget] Cached ${allTasks.length} tasks (${Date.now() - tasksCacheTime}ms)`);

    return allTasks;
}

async function getDWEStats() {
    const now = Date.now();
    
    // Return cached if fresh
    if (cachedStats && (now - cacheTime) < CACHE_DURATION) {
        return { ...cachedStats, cached: true };
    }
    
    if (!NOTION_API_KEY) {
        return {
            error: 'Notion API key not configured',
            total: 0,
            completed: 0,
            inProgress: 0,
            remaining: 0,
            lastUpdated: new Date().toISOString()
        };
    }
    
    try {
        console.log('[DWE Widget] Fetching fresh stats...');
        const allTasks = await fetchAllNotionTasks();
        
        const total = allTasks.length;
        const completed = allTasks.filter(t =>
            t.status === 'Done' ||
            t.status === 'Completed' ||
            t.status === 'Complete' ||
            t.status === 'Review'
        ).length;
        const inProgress = allTasks.filter(t =>
            t.status === 'In Progress' ||
            t.status === 'In progress'
        ).length;
        const maxId = allTasks.reduce((max, t) => Math.max(max, t.idNumber || 0), 0);

        // Status breakdown
        const statusCounts = {};
        allTasks.forEach(t => { statusCounts[t.status] = (statusCounts[t.status] || 0) + 1; });

        // Priority breakdown
        const priorityCounts = {};
        allTasks.forEach(t => { priorityCounts[t.priority] = (priorityCounts[t.priority] || 0) + 1; });

        // Role/agent breakdown
        const roleCounts = {};
        allTasks.forEach(t => { roleCounts[t.role] = (roleCounts[t.role] || 0) + 1; });

        // Overdue tasks
        const overdue = allTasks.filter(t => t.pastDue && t.status !== 'Done' && t.status !== 'Completed' && t.status !== 'Complete').length;

        // Blocked tasks
        const blocked = allTasks.filter(t => t.status === 'Blocked').length;

        // Not started
        const notStarted = allTasks.filter(t => t.status === 'Not started' || t.status === 'Not Started').length;

        // Tasks created in last 7 days (by due date proximity or ID)
        const recentTasks = allTasks.filter(t => {
            if (!t.dueDate) return false;
            const due = new Date(t.dueDate);
            const now = new Date();
            const diff = (due - now) / (1000 * 60 * 60 * 24);
            return diff >= -7 && diff <= 7;
        }).length;

        cachedStats = {
            total: total,
            completed: completed,
            inProgress: inProgress,
            remaining: total - completed,
            maxId: maxId,
            overdue: overdue,
            blocked: blocked,
            notStarted: notStarted,
            recentTasks: recentTasks,
            statusCounts: statusCounts,
            priorityCounts: priorityCounts,
            roleCounts: roleCounts,
            lastUpdated: new Date().toISOString()
        };
        cacheTime = now;
        
        return cachedStats;
    } catch (e) {
        console.error('[DWE Widget] Error:', e);
        // Return cached or fallback
        return cachedStats || {
            total: 0,
            completed: 0,
            inProgress: 0,
            remaining: 0,
            error: e.message,
            lastUpdated: new Date().toISOString()
        };
    }
}

async function createNotionTask({ name, priority = 'Medium', role = 'CEO', url = '', globalTags = null }) {
    return new Promise((resolve, reject) => {
        const tags = globalTags ? globalTags.map(t => ({ name: t })) : (role === 'CEO' ? [] : [{ name: '12-Agent Task' }]);
        const payload = {
            parent: { database_id: NOTION_DB_ID },
            properties: {
                'Task name': { title: [{ text: { content: name } }] },
                'Priority': { select: { name: priority } },
                'Role': { select: { name: role } },
                'Status': { status: { name: 'Not started' } },
                'Global Tags': { multi_select: tags }
            }
        };
        // Add source URL to URL property, Details field, AND as bookmark block
        if (url) {
            payload.properties['URL'] = { url: url };
            payload.properties['Details'] = { rich_text: [{ text: { content: `Source: ${url}` } }] };
            payload.children = [
                {
                    object: 'block',
                    type: 'bookmark',
                    bookmark: { url: url }
                }
            ];
        }
        const body = JSON.stringify(payload);
        const options = {
            hostname: 'api.notion.com',
            path: '/v1/pages',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${NOTION_API_KEY}`,
                'Notion-Version': '2022-06-28',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({ ok: true, id: json.id });
                } catch(e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

module.exports = { getDWEStats, fetchAllNotionTasks, createNotionTask };