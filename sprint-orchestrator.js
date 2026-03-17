/**
 * Sprint Orchestrator
 *
 * When Sprint Mode is active (triggered by phone leaving house or sleep mode):
 * - Each agent works on ONE task at a time
 * - When a task is Done → assign next highest-priority task
 * - If Blocked → spawn Jarvis subtask to try to unblock
 * - If Jarvis can't help → Hold or reassign to proper role
 * - Fully automated, runs on interval while active
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { fetchAllNotionTasks } = require('./dwe-widget-api.js');
const opsLog = require('./ops-log.js');

// Notion config (shared with dwe-widget-api)
const NOTION_API_KEY = (() => {
    try { const k = fs.readFileSync(`${process.env.HOME}/.openclaw/.env`, 'utf8').match(/NOTION_API_KEY="?([^"\n]+)"?/)?.[1]?.trim(); if (k) return k; } catch(e) {}
    return process.env.NOTION_API_KEY || '';
})();
const NOTION_DB_ID = '2f797f89-9129-8068-b8ae-c4321d1c72b7';

// State
const STATE_FILE = path.join(process.env.HOME, 'openclaw/shared/sprint_mode.json');
const LOG_FILE = path.join(process.env.HOME, 'openclaw/logs/sprint_orchestrator.log');
let sprintInterval = null;
const CYCLE_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Agent roles the orchestrator manages
// Goal: drive ALL open tasks to zero. Agents mark tasks as "Review" (not "Done").
// PM (Anita) reviews each "Review" task, verifies completion & dyslexia-friendly docs,
// then marks Done or kicks back to In Progress.
const AGENT_ROLES = ['CTO', 'COO', 'CSO', 'Chief Engineer', 'CFO'];
const DONE_STATUSES = new Set(['Done', 'Completed', 'Complete', 'Archived']);
const REVIEW_STATUS = 'Review';
const BLOCKED_STATUSES = new Set(['Blocked']);
const ACTIVE_STATUSES = new Set(['In Progress', 'In progress']);
const PRIORITY_ORDER = ['Critical', 'High', 'Medium', 'Low'];

// Track Jarvis unblock attempts: taskId → { attempts, createdAt, jarvisTaskId }
let jarvisAttempts = {};

// Role → openclaw account mapping for Telegram check-ins
const ROLE_ACCOUNT_MAP = {
    'CTO': 'cto', 'COO': 'anita', 'CSO': 'nicole',
    'Chief Engineer': 'chief-engineer', 'CFO': 'cfo'
};

// ─── Logging ───────────────────────────────────────────────

function log(msg) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const line = `[${ts}] ${msg}`;
    console.log(`[Sprint] ${msg}`);
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch(e) {}
}

// ─── Sprint History Log ─────────────────────────────────────
// Persistent record of every sprint session + completed tasks
const HISTORY_FILE = path.join(process.env.HOME || '/Users/elf-6', 'openclaw/logs/sprint_history.json');

function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch(e) {}
    return { sessions: [], totals: { tasksCompleted: 0, tasksKickedBack: 0, sprintCycles: 0, totalSessions: 0 } };
}

function saveHistory(history) {
    try {
        const dir = path.dirname(HISTORY_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    } catch(e) { log(`History save error: ${e.message}`); }
}

function logCycleToHistory(cycleNum, actions) {
    const history = loadHistory();
    const sessionId = history.sessions.length > 0 ? history.sessions[history.sessions.length - 1].id : null;
    const currentSession = history.sessions.find(s => s.id === sessionId && !s.ended);

    if (!currentSession) return; // no active session

    const completed = actions.filter(a => a.includes('PM approved → Done') || a.includes('PM closed → Done'));
    const kickedBack = actions.filter(a => a.includes('PM kicked back'));
    const escalated = actions.filter(a => a.includes('PM escalated → CEO'));
    const enhanced = actions.filter(a => a.includes('PM enhanced'));
    const assigned = actions.filter(a => a.startsWith('▶️'));
    const unblocked = actions.filter(a => a.includes('Jarvis unblocked'));

    // Enriched: store both TAS number AND full detail string for retro analysis
    const enrichAction = a => { const m = a.match(/TAS-(\d+)/); return { tas: m ? `TAS-${m[1]}` : null, detail: a }; };

    const cycleRecord = {
        cycle: cycleNum,
        timestamp: new Date().toISOString(),
        completed: completed.map(enrichAction),
        kickedBack: kickedBack.map(enrichAction),
        escalated: escalated.map(enrichAction),
        enhanced: enhanced.map(enrichAction),
        assigned: assigned.map(enrichAction),
        unblocked: unblocked.map(enrichAction),
        allActions: actions,  // preserve ALL raw action strings for retro analysis
        totalActions: actions.length
    };

    currentSession.cycles.push(cycleRecord);
    currentSession.stats.tasksCompleted += completed.length;
    currentSession.stats.tasksKickedBack += kickedBack.length;
    currentSession.stats.tasksEscalated = (currentSession.stats.tasksEscalated || 0) + escalated.length;
    currentSession.stats.tasksEnhanced = (currentSession.stats.tasksEnhanced || 0) + enhanced.length;
    currentSession.stats.tasksAssigned += assigned.length;
    currentSession.stats.tasksUnblocked += unblocked.length;
    currentSession.stats.totalCycles = cycleNum;

    history.totals.tasksCompleted += completed.length;
    history.totals.tasksKickedBack += kickedBack.length;
    history.totals.sprintCycles++;

    saveHistory(history);
}

function startHistorySession(trigger) {
    const history = loadHistory();
    // Sequential sprint numbering (backward-compatible with old timestamp-based IDs)
    const existingNumbers = history.sessions.map(s => s.number || 0);
    const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
    const session = {
        id: `sprint-${nextNumber}`,
        number: nextNumber,
        started: new Date().toISOString(),
        ended: null,
        trigger: trigger,
        stats: { tasksCompleted: 0, tasksKickedBack: 0, tasksEscalated: 0, tasksEnhanced: 0, tasksAssigned: 0, tasksUnblocked: 0, totalCycles: 0 },
        cycles: [],
        retroCompleted: false,
        retroId: null
    };
    history.sessions.push(session);
    history.totals.totalSessions++;
    saveHistory(history);
    return session.id;
}

function endHistorySession() {
    const history = loadHistory();
    const current = history.sessions.find(s => !s.ended);
    if (current) {
        current.ended = new Date().toISOString();

        // Compute session summary for retro analysis + Google Sheets
        const startMs = new Date(current.started).getTime();
        const endMs = new Date(current.ended).getTime();
        const durationMs = endMs - startMs;
        const hours = Math.floor(durationMs / 3600000);
        const minutes = Math.floor((durationMs % 3600000) / 60000);

        // Extract unique agent roles from assigned actions
        const activeAgents = new Set();
        const taskNames = {};
        for (const cycle of current.cycles) {
            for (const a of (cycle.assigned || [])) {
                const detail = typeof a === 'object' ? a.detail : a;
                if (!detail) continue;
                const roleMatch = detail.match(/^▶️\s*(\w[\w\s]*?):/);
                if (roleMatch) activeAgents.add(roleMatch[1].trim());
                const taskMatch = detail.match(/TAS-(\d+)\s+"([^"]+)"/);
                if (taskMatch) taskNames[`TAS-${taskMatch[1]}`] = taskMatch[2];
            }
        }

        const totalCycles = current.cycles.length;
        const activeCycles = current.cycles.filter(c => c.totalActions > 0).length;
        const idlePct = totalCycles > 0 ? Math.round(((totalCycles - activeCycles) / totalCycles) * 100) : 0;

        current.summary = {
            duration: hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`,
            durationMs,
            activeAgents: Array.from(activeAgents),
            taskNames,
            totalCycles,
            activeCycles,
            idlePct
        };

        saveHistory(history);

        // Push sprint-end event to Google Sheets ChangeLog via opsLog
        const sprintNum = current.number || current.id;
        const taskList = Object.entries(taskNames).map(([tas, name]) => `${tas} ${name}`).join(' | ');
        opsLog.logEvent('sprint-end', '🏁', `Sprint #${sprintNum} ended — ${current.summary.duration}, ${current.stats.tasksCompleted} completed, ${idlePct}% idle`, {
            tab: 'Sprint Log',
            sprintNumber: sprintNum,
            duration: current.summary.duration,
            totalCycles,
            activeCycles,
            idlePct,
            tasksAssigned: current.stats.tasksAssigned,
            tasksCompleted: current.stats.tasksCompleted,
            tasksKickedBack: current.stats.tasksKickedBack,
            tasksEscalated: current.stats.tasksEscalated || 0,
            tasksEnhanced: current.stats.tasksEnhanced || 0,
            tasksUnblocked: current.stats.tasksUnblocked,
            agentsActive: current.summary.activeAgents.join(', '),
            taskDetails: taskList,
            retroStatus: 'Pending',
            notes: `Trigger: ${current.trigger}`
        });
    }
}

// ─── State Management ──────────────────────────────────────

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        }
    } catch(e) {}
    return { active: false, trigger: null, started: null, stopped: null, cycleCount: 0, assignments: {} };
}

function saveState(state) {
    try {
        const dir = path.dirname(STATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch(e) { log(`State save error: ${e.message}`); }
}

function getState() {
    return loadState();
}

// ─── Notion API Helpers ────────────────────────────────────

function notionRequest(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.notion.com',
            path: apiPath,
            method: method,
            headers: {
                'Authorization': `Bearer ${NOTION_API_KEY}`,
                'Notion-Version': '2022-06-28',
                'Content-Type': 'application/json'
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
                catch(e) { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function updateTaskStatus(taskId, newStatus) {
    log(`Updating task ${taskId} → ${newStatus}`);
    const result = await notionRequest('PATCH', `/v1/pages/${taskId}`, {
        properties: {
            Status: { status: { name: newStatus } }
        }
    });
    if (result.status !== 200) {
        log(`Failed to update task ${taskId}: ${JSON.stringify(result.data).slice(0, 200)}`);
        return false;
    }
    return true;
}

async function createJarvisSubtask(blockedTask) {
    const title = `[Jarvis Unblock] ${blockedTask.name} (TAS-${blockedTask.idNumber})`;
    const summary = `Sprint Orchestrator: Task TAS-${blockedTask.idNumber} "${blockedTask.name}" is blocked. ` +
        `Role: ${blockedTask.role}. Investigate and attempt to resolve the blocker. ` +
        `When finished, mark this subtask as "Review" (NOT Done) so Sidney can verify. ` +
        `If this cannot be resolved, mark as Review with a note explaining why.`;

    log(`Creating Jarvis subtask for TAS-${blockedTask.idNumber}`);
    const result = await notionRequest('POST', '/v1/pages', {
        parent: { database_id: NOTION_DB_ID },
        properties: {
            'Task name': { title: [{ text: { content: title } }] },
            'Status': { status: { name: 'In Progress' } },
            'Priority': { select: { name: 'High' } },
            'Role': { select: { name: 'Chief Engineer' } },
            'Task type': { select: { name: 'Bug' } },
            'Summary': { rich_text: [{ text: { content: summary } }] }
        }
    });

    if (result.status === 200 || result.status === 201) {
        const newId = result.data.id;
        log(`Created Jarvis subtask ${newId} for TAS-${blockedTask.idNumber}`);
        return newId;
    } else {
        log(`Failed to create Jarvis subtask: ${JSON.stringify(result.data).slice(0, 300)}`);
        return null;
    }
}

// ─── Telegram Notification ─────────────────────────────────

function sendTelegramNotification(message) {
    // Read bot token from openclaw env
    let botToken, chatId;
    try {
        const envContent = fs.readFileSync(`${process.env.HOME}/.openclaw/.env`, 'utf8');
        botToken = envContent.match(/TELEGRAM_BOT_TOKEN="?([^"\n]+)"?/)?.[1]?.trim();
        chatId = envContent.match(/TELEGRAM_CHAT_ID="?([^"\n]+)"?/)?.[1]?.trim();
    } catch(e) {}

    if (!botToken || !chatId) {
        log('Telegram credentials not found, skipping notification');
        return;
    }

    const body = JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
    });

    const options = {
        hostname: 'api.telegram.org',
        path: `/bot${botToken}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    };

    const req = https.request(options, () => {});
    req.on('error', (e) => log(`Telegram error: ${e.message}`));
    req.write(body);
    req.end();
}

// ─── Agent Dispatch (TAS-1097 fix) ────────────────────────

function notifyAgentAssignment(role, taskNumber, taskName, priority) {
    const account = ROLE_ACCOUNT_MAP[role];
    if (!account) {
        log(`No account mapping for role ${role} — skipping agent notification`);
        return;
    }

    const msg = `🎯 Sprint Task Assigned: TAS-${taskNumber} — "${taskName}" (${priority})\n\nThis task is now In Progress and assigned to you. Begin work immediately. Update Notion when done and set status to Review.`;

    const { exec } = require('child_process');
    exec(
        `openclaw agent --agent ${account} --channel telegram --message ${JSON.stringify(msg)} --deliver`,
        { timeout: 60000 },
        (err, stdout, stderr) => {
            if (err) {
                log(`Agent dispatch failed for ${role}: ${err.message}`);
                sendTelegramNotification(`⚠️ Could not dispatch TAS-${taskNumber} to ${role} agent. Task is In Progress but agent may not be aware.`);
            } else {
                log(`Agent dispatch OK for ${role}: TAS-${taskNumber}`);
            }
        }
    );
}

// ─── iMessage Notification ─────────────────────────────────

const IMESSAGE_TO = 'sirsid2001@icloud.com';

function sendIMessage(message) {
    try {
        // Escape for AppleScript
        const escaped = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const script = `tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetBuddy to participant "${IMESSAGE_TO}" of targetService
    send "${escaped}" to targetBuddy
end tell`;
        execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000 });
        log(`iMessage sent to ${IMESSAGE_TO}`);
    } catch(e) {
        log(`iMessage error: ${e.message}`);
    }
}

// ─── Core Sprint Logic ─────────────────────────────────────

async function runSprintCycle() {
    const state = loadState();
    if (!state.active) return;

    state.cycleCount = (state.cycleCount || 0) + 1;
    state.lastCycle = new Date().toISOString();
    log(`── Sprint Cycle #${state.cycleCount} ──`);

    try {
        const allTasks = await fetchAllNotionTasks();
        const actionsTaken = [];

        for (const role of AGENT_ROLES) {
            const roleTasks = allTasks.filter(t => t.role === role);
            const activeTasks = roleTasks.filter(t => ACTIVE_STATUSES.has(t.status));
            const blockedTasks = roleTasks.filter(t => BLOCKED_STATUSES.has(t.status));
            const queuedTasks = roleTasks
                .filter(t => t.status === 'Not started' || t.status === 'Not Started' || t.status === 'To Do' || t.status === 'To do')
                .sort((a, b) => {
                    const pa = PRIORITY_ORDER.indexOf(a.priority);
                    const pb = PRIORITY_ORDER.indexOf(b.priority);
                    const priDiff = (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
                    if (priDiff !== 0) return priDiff;
                    // FIFO tiebreaker: lower TAS number = created earlier = first
                    return (a.idNumber || 0) - (b.idNumber || 0);
                });

            // ── Handle blocked tasks: Jarvis unblock flow ──
            for (const task of blockedTasks) {
                const attempt = jarvisAttempts[task.id];
                if (!attempt) {
                    // First time seeing this blocked — send Jarvis
                    const jarvisId = await createJarvisSubtask(task);
                    if (jarvisId) {
                        jarvisAttempts[task.id] = {
                            attempts: 1,
                            createdAt: Date.now(),
                            jarvisTaskId: jarvisId
                        };
                        actionsTaken.push(`🔧 TAS-${task.idNumber} (${role}): Blocked → Jarvis investigating`);
                    }
                } else {
                    // Check if Jarvis subtask is done
                    const jarvisTask = allTasks.find(t => t.id === attempt.jarvisTaskId);
                    const jarvisDone = jarvisTask && DONE_STATUSES.has(jarvisTask.status);
                    const elapsed = Date.now() - attempt.createdAt;
                    const maxWait = 30 * 60 * 1000; // 30 minutes

                    if (jarvisDone) {
                        // Jarvis finished — try to unblock the original
                        log(`Jarvis resolved subtask for TAS-${task.idNumber}, setting back to In Progress`);
                        await updateTaskStatus(task.id, 'In Progress');
                        delete jarvisAttempts[task.id];
                        actionsTaken.push(`✅ TAS-${task.idNumber} (${role}): Jarvis unblocked → In Progress`);
                        notifyAgentAssignment(role, task.idNumber, task.name, task.priority);
                    } else if (elapsed > maxWait) {
                        // Jarvis couldn't help in time — hold or reassign
                        log(`Jarvis timed out on TAS-${task.idNumber} after ${Math.round(elapsed/60000)}min`);

                        // Try to find a different role that could handle it
                        const reassignRole = findReassignRole(task, role);
                        if (reassignRole) {
                            await reassignTask(task, reassignRole);
                            actionsTaken.push(`🔄 TAS-${task.idNumber} (${role}): Reassigned → ${reassignRole}`);
                        } else {
                            await updateTaskStatus(task.id, 'On Hold');
                            actionsTaken.push(`⏸️ TAS-${task.idNumber} (${role}): → On Hold (Jarvis couldn't unblock)`);
                            sendTelegramNotification(`⏸️ <b>Task On Hold</b>\nTAS-${task.idNumber} — "${task.title}"\nAssigned: ${role}\nReason: Jarvis couldn't unblock after ${ja.attempts} attempt(s). Needs CEO decision.`);
                        }
                        delete jarvisAttempts[task.id];
                    }
                    // else: still waiting for Jarvis, do nothing
                }
            }

            // ── Enforce ONE active task per agent ──
            if (activeTasks.length === 0 && queuedTasks.length > 0) {
                // No active task — assign the next one
                const next = queuedTasks[0];
                await updateTaskStatus(next.id, 'In Progress');
                state.assignments[role] = {
                    taskId: next.id,
                    taskNumber: next.idNumber,
                    taskName: next.name,
                    assignedAt: new Date().toISOString()
                };
                actionsTaken.push(`▶️ ${role}: Assigned TAS-${next.idNumber} "${next.name}" (${next.priority})`);
                notifyAgentAssignment(role, next.idNumber, next.name, next.priority);
            } else if (activeTasks.length > 1) {
                // Multiple active — keep highest priority (FIFO tiebreak), pause the rest
                const sorted = activeTasks.sort((a, b) => {
                    const pa = PRIORITY_ORDER.indexOf(a.priority);
                    const pb = PRIORITY_ORDER.indexOf(b.priority);
                    const priDiff = (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
                    if (priDiff !== 0) return priDiff;
                    return (a.idNumber || 0) - (b.idNumber || 0);
                });
                for (let i = 1; i < sorted.length; i++) {
                    await updateTaskStatus(sorted[i].id, 'Not started');
                    actionsTaken.push(`⏸️ ${role}: Paused TAS-${sorted[i].idNumber} (enforcing 1-at-a-time)`);
                }
                state.assignments[role] = {
                    taskId: sorted[0].id,
                    taskNumber: sorted[0].idNumber,
                    taskName: sorted[0].name,
                    assignedAt: new Date().toISOString()
                };
            } else if (activeTasks.length === 1) {
                state.assignments[role] = {
                    taskId: activeTasks[0].id,
                    taskNumber: activeTasks[0].idNumber,
                    taskName: activeTasks[0].name,
                    assignedAt: state.assignments[role]?.assignedAt || new Date().toISOString()
                };
            }
        }

        // ── PM Review: Anita 4-question review gate for "Review" status tasks ──
        const reviewTasks = allTasks.filter(t => t.status === REVIEW_STATUS);
        for (const task of reviewTasks) {
            try {
                const reviewed = await pmReviewTask(task);
                if (reviewed === 'approved') {
                    actionsTaken.push(`✅ TAS-${task.idNumber} "${task.name}": PM closed → Done`);
                } else if (reviewed === 'kicked_back') {
                    actionsTaken.push(`🔙 TAS-${task.idNumber} "${task.name}": PM kicked back → In Progress (${task.role})`);
                } else if (reviewed === 'escalated') {
                    actionsTaken.push(`📋 TAS-${task.idNumber} "${task.name}": PM escalated → CEO review`);
                } else if (reviewed === 'enhanced') {
                    actionsTaken.push(`🔧 TAS-${task.idNumber} "${task.name}": PM enhanced + closed → Done`);
                }
                // else: error, skip
            } catch (e) {
                log(`PM review error for TAS-${task.idNumber}: ${e.message}`);
            }
        }

        // ── Summary ──
        // Re-fetch counts after reviews may have changed statuses
        const totalOpen = allTasks.filter(t => !DONE_STATUSES.has(t.status) && t.status !== REVIEW_STATUS).length
            + reviewTasks.length - reviewTasks.filter(t => actionsTaken.some(a => a.includes(`TAS-${t.idNumber}: PM approved`))).length;
        const totalReview = reviewTasks.length - reviewTasks.filter(t =>
            actionsTaken.some(a => a.includes(`TAS-${t.idNumber}: PM approved`) || a.includes(`TAS-${t.idNumber}: PM kicked back`))
        ).length;
        state.openTasks = totalOpen;
        state.reviewTasks = totalReview;

        // Log cycle to history + ops log
        logCycleToHistory(state.cycleCount, actionsTaken);
        actionsTaken.forEach(a => {
            const tasMatch = a.match(/TAS-\d+/);
            const tas = tasMatch ? tasMatch[0] : '';
            if (a.includes('PM closed → Done')) opsLog.logEvent('sprint', '✅', `${tas} closed → Done`, { cycle: state.cycleCount });
            else if (a.includes('PM kicked back')) opsLog.logEvent('sprint', '🔙', `${tas} kicked back → In Progress`, { cycle: state.cycleCount });
            else if (a.includes('PM escalated')) opsLog.logEvent('sprint', '📋', `${tas} escalated → CEO review`, { cycle: state.cycleCount });
            else if (a.includes('PM enhanced')) opsLog.logEvent('sprint', '🔧', `${tas} enhanced + closed`, { cycle: state.cycleCount });
            else if (a.startsWith('▶️')) opsLog.logEvent('sprint', '▶️', a.replace('▶️ ', ''), { cycle: state.cycleCount });
            else if (a.includes('Jarvis unblocked')) opsLog.logEvent('sprint', '🔧', a, { cycle: state.cycleCount });
            else if (a.includes('Reassigned')) opsLog.logEvent('sprint', '🔄', a, { cycle: state.cycleCount });
        });

        if (actionsTaken.length > 0) {
            const summary = `🏃 <b>Sprint Cycle #${state.cycleCount}</b>\n` +
                `📊 Open: ${totalOpen} | In Review: ${totalReview}\n\n` + actionsTaken.join('\n');
            log(`Actions taken:\n  ${actionsTaken.join('\n  ')}`);
            log(`Open tasks remaining: ${totalOpen}, In Review: ${totalReview}`);
            sendTelegramNotification(summary);
        } else {
            log(`No actions needed. Open: ${totalOpen}, Review: ${totalReview}`);
        }

        // Zero task celebration
        if (totalOpen === 0) {
            sendTelegramNotification('🎉 <b>SPRINT COMPLETE!</b>\nAll tasks are at zero open. Every task is Done or in Review.');
            log('SPRINT COMPLETE — zero open tasks!');
        }

        saveState(state);
    } catch (e) {
        log(`Cycle error: ${e.message}`);
    }
}

async function pmReviewTask(task) {
    // PM (Anita) 4-question review gate for tasks in "Review" status
    // Decision tree: Q1 Complete? → Q2 CEO needed? → Q3 Close? → Q4 Enhance?
    // Returns: 'approved' | 'kicked_back' | 'escalated' | 'enhanced' | 'error'
    log(`PM reviewing TAS-${task.idNumber} "${task.name}" (${task.role})`);

    try {
        const prompt = `PM REVIEW — TAS-${task.idNumber}: "${task.name}"
Summary: ${task.summary || 'No summary provided'}
Role: ${task.role}
Priority: ${task.priority}

You are Anita (COO/PM). Review this completed task using these 4 questions IN ORDER.
Stop at the first YES/NO that triggers an action.

Q1 — COMPLETE? Is the Summary filled out in detail? Could someone revisit this task
later and understand exactly what was done? Look for specific deliverables, not vague
promises or status updates. Short sentences, bullet points, plain language.
→ If NO: respond "KICK_BACK: [what's missing]"

Q2 — CEO NEEDED? Does this require CEO review — strategic decisions, policy changes,
budget items, revenue decisions, or anything requiring human judgment beyond routine ops?
→ If YES: respond "ESCALATE: [reason CEO needs to see this]"

Q3 — DONE? Is the work fully complete with no loose ends?
→ If YES: respond "CLOSE"

Q4 — ENHANCE? Does this reveal an opportunity to improve DWE system efficiency —
triage rules, agent workflows, SLA thresholds, SOUL.md guidance, operational processes?
→ If YES: respond "ENHANCE: [specific improvement to make]"
→ If NO: respond "CLOSE"

Reply with EXACTLY one line starting with KICK_BACK, ESCALATE, CLOSE, or ENHANCE.`;

        let verdict = await callOpenRouterForReview(prompt, task);

        // Parse verdict
        verdict = verdict.trim();
        // Extract first line that starts with a known keyword
        const lines = verdict.split('\n');
        const verdictLine = lines.find(l => /^(KICK_BACK|ESCALATE|CLOSE|ENHANCE)/i.test(l.trim())) || lines[0] || '';
        const normalizedVerdict = verdictLine.trim().toUpperCase();

        if (normalizedVerdict.startsWith('KICK_BACK')) {
            const reason = verdictLine.replace(/^KICK_BACK:\s*/i, '').trim() || 'Incomplete or unclear documentation';
            await updateTaskStatus(task.id, 'In Progress');
            const kickMsg = `🔙 TAS-${task.idNumber} kicked back by PM.\nReason: ${reason}\nPlease complete the work and update documentation in dyslexia-friendly format (short sentences, bullet points, plain language). Then set status back to Review.`;
            sendTelegramNotification(kickMsg);
            log(`TAS-${task.idNumber}: PM kicked back → In Progress. Reason: ${reason}`);
            return 'kicked_back';

        } else if (normalizedVerdict.startsWith('ESCALATE')) {
            const reason = verdictLine.replace(/^ESCALATE:\s*/i, '').trim() || 'Requires CEO review';
            // Route to CEO: leave Status as Review, set Role=CEO, clear Global Tags
            await notionRequest('PATCH', `/v1/pages/${task.id}`, {
                properties: {
                    Role: { select: { name: 'CEO' } },
                    'Global Tags': { multi_select: [] }
                }
            });
            sendTelegramNotification(`📋 TAS-${task.idNumber} escalated to CEO review.\nReason: ${reason}`);
            log(`TAS-${task.idNumber}: PM escalated → CEO review. Reason: ${reason}`);
            return 'escalated';

        } else if (normalizedVerdict.startsWith('ENHANCE')) {
            const enhancement = verdictLine.replace(/^ENHANCE:\s*/i, '').trim() || 'System improvement identified';
            // Close as Done + log the enhancement
            await updateTaskStatus(task.id, 'Done');
            // Log enhancement to ops-log so it's visible in Google Sheets
            opsLog.logEvent('pm-enhance', '🔧', `TAS-${task.idNumber}: ${enhancement}`, {
                tab: 'PM Reviews',
                taskId: `TAS-${task.idNumber}`,
                taskName: task.name,
                enhancement: enhancement
            });
            sendTelegramNotification(`🔧 TAS-${task.idNumber} closed + enhancement applied.\nEnhancement: ${enhancement}`);
            log(`TAS-${task.idNumber}: PM enhanced + closed → Done. Enhancement: ${enhancement}`);
            return 'enhanced';

        } else {
            // CLOSE or any other response → mark Done
            await updateTaskStatus(task.id, 'Done');
            log(`TAS-${task.idNumber}: PM closed → Done`);
            return 'approved';
        }
    } catch (e) {
        log(`PM review failed for TAS-${task.idNumber}: ${e.message}`);
        return 'error';
    }
}

// OpenRouter/auto LLM call for PM review — falls back to ESCALATE if unavailable
async function callOpenRouterForReview(prompt, task) {
    // Read OpenRouter key
    let apiKey;
    try {
        const envContent = fs.readFileSync(`${process.env.HOME}/.openclaw/.env`, 'utf8');
        apiKey = envContent.match(/OPENROUTER_API_KEY="?([^"\n]+)"?/)?.[1]?.trim();
    } catch(e) {}

    if (!apiKey) {
        log(`OpenRouter API key not found, escalating TAS-${task.idNumber} to CEO`);
        return 'ESCALATE: LLM unavailable — CEO must review manually';
    }

    return new Promise((resolve) => {
        const payload = JSON.stringify({
            model: 'openrouter/auto',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            max_tokens: 200
        });

        const req = https.request({
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://dwe.openclaw.ai',
                'X-Title': 'DWE Sprint PM Review'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const content = parsed.choices?.[0]?.message?.content || '';
                    if (content) {
                        resolve(content);
                    } else {
                        log(`OpenRouter empty response for TAS-${task.idNumber}: ${data.slice(0, 200)}`);
                        resolve('ESCALATE: LLM returned empty response — CEO must review');
                    }
                } catch(e) {
                    log(`OpenRouter parse error for TAS-${task.idNumber}: ${e.message}`);
                    resolve('ESCALATE: LLM error — CEO must review');
                }
            });
        });

        req.on('error', (e) => {
            log(`OpenRouter request error for TAS-${task.idNumber}: ${e.message}`);
            resolve('ESCALATE: LLM unavailable — CEO must review');
        });

        // 45-second timeout
        req.setTimeout(45000, () => {
            log(`OpenRouter timeout for TAS-${task.idNumber}`);
            req.destroy();
            resolve('ESCALATE: LLM timeout — CEO must review');
        });

        req.write(payload);
        req.end();
    });
}

function findReassignRole(task, currentRole) {
    // Simple reassignment logic based on task type
    const reassignMap = {
        'CTO': 'Chief Engineer',
        'Chief Engineer': 'CTO',
        'COO': 'CSO',
        'CSO': 'COO',
        'CFO': null  // CFO tasks are specialized, go to hold
    };
    return reassignMap[currentRole] || null;
}

async function reassignTask(task, newRole) {
    log(`Reassigning TAS-${task.idNumber} from ${task.role} → ${newRole}`);
    const result = await notionRequest('PATCH', `/v1/pages/${task.id}`, {
        properties: {
            Status: { status: { name: 'Not started' } },
            Role: { select: { name: newRole } }
        }
    });
    return result.status === 200;
}

// ─── Agent Sprint Check-Ins ───────────────────────────────

/**
 * On sprint activation, each agent queries their actionable tasks and
 * Telegrams their status: "I have X tasks: [list]" or "0 tasks, standing by."
 * Uses the local /mc/agent-tasks endpoint to avoid duplicate Notion queries.
 */
async function sendAgentCheckIns() {
    const http = require('http');
    try {
        const data = await new Promise((resolve, reject) => {
            http.get('http://localhost:8899/mc/agent-tasks', (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
                });
            }).on('error', reject);
        });

        if (!data.agents) return;

        for (const [role, info] of Object.entries(data.agents)) {
            const account = ROLE_ACCOUNT_MAP[role];
            if (!account) continue;

            const actionable = info.actionableList || [];
            const count = actionable.length;
            let msg;

            if (count === 0) {
                msg = `🏃 Sprint activated — ${role}: 0 actionable tasks. Standing by for assignments.`;
            } else {
                const taskLines = actionable.slice(0, 5).map(t => {
                    const due = t.dueDate ? ` (due: ${t.dueDate})` : ' (no due)';
                    return `• TAS-${t.idNumber} — ${t.title}${due}`;
                }).join('\n');
                const extra = count > 5 ? `\n...and ${count - 5} more` : '';
                msg = `🏃 Sprint activated — ${role}: ${count} actionable task${count > 1 ? 's' : ''}:\n${taskLines}${extra}`;
            }

            // Send via openclaw CLI (non-blocking)
            const { exec } = require('child_process');
            exec(`openclaw message send --channel telegram --account ${account} --target 5205160024 --message ${JSON.stringify(msg)}`,
                { timeout: 30000 },
                (err) => { if (err) log(`Check-in send failed for ${role}: ${err.message}`); }
            );
            log(`Sprint check-in sent for ${role}: ${count} actionable tasks`);
        }
    } catch(e) {
        log(`Agent check-ins failed: ${e.message}`);
    }
}

// ─── Activate / Deactivate ─────────────────────────────────

function activate(trigger = 'manual') {
    const state = loadState();
    if (state.active) {
        log(`Already active (trigger: ${state.trigger})`);
        return { already: true, ...state };
    }

    state.active = true;
    state.trigger = trigger;
    state.started = new Date().toISOString();
    state.stopped = null;
    state.cycleCount = 0;
    state.assignments = {};
    saveState(state);

    // Run first cycle immediately, then on interval
    jarvisAttempts = {};
    runSprintCycle();
    sprintInterval = setInterval(runSprintCycle, CYCLE_INTERVAL);

    const triggerLabel = {
        'geofence_leave': '📍 Phone left home',
        'sleep_mode': '😴 Sleep mode activated',
        'manual': '🖐️ Manual activation'
    }[trigger] || trigger;

    log(`Sprint Mode ACTIVATED (${triggerLabel})`);
    startHistorySession(trigger);
    opsLog.logEvent('sprint', '🏃', `Sprint ACTIVATED (${triggerLabel})`, { trigger });
    sendTelegramNotification(`🏃 <b>Sprint Mode ACTIVATED</b>\n${triggerLabel}\n\nGoal: ZERO open tasks.\nRules: 1 task at a time per agent. Mark completed as "Review" (not Done). Blocked → Jarvis unblock → Hold/Reassign.`);

    // Agent check-ins: each agent Telegrams their actionable task count
    sendAgentCheckIns().catch(e => log(`Agent check-ins error: ${e.message}`));

    // Cool iMessage to Sidney
    const openCount = state.openTasks || '?';
    sendIMessage(`🤖 AI Agents entering SUPER AGENT MODE.\n\n5 agents locked in. ${openCount} tasks in the queue. One mission: zero open tasks.\n\nBlocked? Jarvis handles it. Still stuck? Reassigned.\n\nWe don't sleep until the board is clear. 🏁`);

    return state;
}

function deactivate(trigger = 'manual') {
    const state = loadState();
    if (!state.active) {
        return { already: true, ...state };
    }

    state.active = false;
    state.stopped = new Date().toISOString();
    state.trigger = null;
    saveState(state);

    if (sprintInterval) {
        clearInterval(sprintInterval);
        sprintInterval = null;
    }
    jarvisAttempts = {};

    const triggerLabel = {
        'geofence_arrive': '📍 Phone returned home',
        'wake_mode': '☀️ Wake mode',
        'manual': '🖐️ Manual deactivation'
    }[trigger] || trigger;

    endHistorySession();
    opsLog.logEvent('sprint', '⏹️', `Sprint DEACTIVATED (${triggerLabel}) — ${state.cycleCount} cycles`, { trigger, cycles: state.cycleCount });
    log(`Sprint Mode DEACTIVATED (${triggerLabel}) after ${state.cycleCount} cycles`);
    sendTelegramNotification(`⏹️ <b>Sprint Mode DEACTIVATED</b>\n${triggerLabel}\nRan ${state.cycleCount} cycles since ${state.started}\n\n📊 Sprint retro available — run <code>/sprint-retro</code> in Jarvis or wait for Anita's auto-retro.`);

    // iMessage summary
    sendIMessage(`⏹️ Super Agent Mode complete.\n\n${state.cycleCount} sprint cycles ran. Your team is standing by for review.\n\n📊 Sprint retro ready — run /sprint-retro in Jarvis for lessons learned.`);

    return state;
}

// ─── Resume on server restart ──────────────────────────────

function resumeIfActive() {
    const state = loadState();
    if (state.active) {
        log('Resuming Sprint Mode after server restart');
        jarvisAttempts = {};
        runSprintCycle();
        sprintInterval = setInterval(runSprintCycle, CYCLE_INTERVAL);
    }
}

// ─── Apple Watch Presence Detector ─────────────────────────
// Checks Bluetooth RSSI for "Sidney's Apple Watch"
// Present (RSSI exists) = Sidney is awake & nearby → no sprint
// Absent (no RSSI) = sleeping or away → activate sprint

const { execSync } = require('child_process');
// Note: BT name uses Unicode curly quote + non-breaking space: Sidney\u2019s Apple\u00a0Watch
const WATCH_PATTERN = /Sidney.s\s*Apple\s*Watch/;
const PRESENCE_CHECK_INTERVAL = 3 * 60 * 1000; // check every 3 minutes
const ABSENCE_THRESHOLD = 2; // must be absent for 2 consecutive checks before triggering
let presenceInterval = null;
let consecutiveAbsent = 0;
let lastPresenceState = null; // true = present, false = absent

function checkWatchPresence() {
    try {
        const btData = execSync('system_profiler SPBluetoothDataType 2>/dev/null', {
            timeout: 15000,
            encoding: 'utf8'
        });

        // Look for the watch entry and check if it has RSSI (connected)
        const watchMatch = btData.match(WATCH_PATTERN);
        if (!watchMatch) {
            return false; // watch not even listed
        }

        // Check for RSSI within the next few lines after the watch name
        const afterWatch = btData.slice(watchMatch.index, watchMatch.index + 200);
        const hasRSSI = /RSSI:\s*-?\d+/.test(afterWatch);
        return hasRSSI;
    } catch(e) {
        log(`Watch presence check error: ${e.message}`);
        return null; // unknown, don't act
    }
}

function runPresenceCheck() {
    const present = checkWatchPresence();
    if (present === null) return; // error, skip this cycle

    const state = loadState();

    if (present) {
        consecutiveAbsent = 0;
        if (lastPresenceState === false && state.active && (state.trigger === 'watch_absent' || state.trigger === 'sleep_mode')) {
            // Watch came back — Sidney is awake/returned
            log('Apple Watch detected — Sidney is back');
            deactivate('watch_present');
        }
        lastPresenceState = true;
    } else {
        consecutiveAbsent++;
        if (consecutiveAbsent >= ABSENCE_THRESHOLD && !state.active) {
            // Watch gone for 2+ checks — Sidney is asleep or away
            log(`Apple Watch absent for ${consecutiveAbsent} checks — activating Sprint`);
            activate('watch_absent');
        }
        lastPresenceState = false;
    }
}

function startPresenceDetector() {
    // Initial check
    const present = checkWatchPresence();
    lastPresenceState = present;
    log(`Presence detector started. Watch ${present ? 'DETECTED' : 'NOT DETECTED'}`);

    presenceInterval = setInterval(runPresenceCheck, PRESENCE_CHECK_INTERVAL);
}

function stopPresenceDetector() {
    if (presenceInterval) {
        clearInterval(presenceInterval);
        presenceInterval = null;
    }
    log('Presence detector stopped');
}

function getPresenceStatus() {
    return {
        watchDetected: lastPresenceState,
        consecutiveAbsent,
        detectorRunning: presenceInterval !== null
    };
}

// ─── Exports ───────────────────────────────────────────────

module.exports = {
    activate,
    deactivate,
    getState,
    runSprintCycle,
    resumeIfActive,
    startPresenceDetector,
    stopPresenceDetector,
    getPresenceStatus
};
