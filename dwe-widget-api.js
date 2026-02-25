/**
 * DWE Widget API
 * Fetches Notion stats and caches them
 */

const https = require('https');
const NOTION_API_KEY = process.env.NOTION_API_KEY || '';
const NOTION_DB_ID = '2f797f89-9129-80f7-99d0-000b3bf2f347';

// Cache for 5 minutes
let cachedStats = null;
let cacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

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

async function getDWEStats() {
    const now = Date.now();
    
    // Return cached if fresh
    if (cachedStats && (now - cacheTime) < CACHE_DURATION) {
        return { ...cachedStats, cached: true };
    }
    
    if (!NOTION_API_KEY) {
        return {
            error: 'Notion API key not configured',
            total: 1020,
            completed: 562,
            inProgress: 4,
            remaining: 458,
            maxId: 1020,
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
        
        cachedStats = {
            total: maxId, // Use max ID as total
            completed: completed,
            inProgress: inProgress,
            remaining: maxId - completed,
            maxId: maxId,
            activeTasks: total,
            lastUpdated: new Date().toISOString()
        };
        cacheTime = now;
        
        return cachedStats;
    } catch (e) {
        console.error('[DWE Widget] Error:', e);
        // Return cached or fallback
        return cachedStats || {
            total: 1020,
            completed: 562,
            inProgress: 4,
            remaining: 458,
            maxId: 1020,
            error: e.message,
            lastUpdated: new Date().toISOString()
        };
    }
}

module.exports = { getDWEStats, fetchAllNotionTasks };