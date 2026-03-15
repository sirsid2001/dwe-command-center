/**
 * Sprint Retrospective Engine
 *
 * Analyzes sprint history, computes metrics, runs LLM analysis via OpenRouter/auto,
 * generates full CEO retro report, creates Critical Notion task, and tracks
 * sprint-over-sprint improvement.
 *
 * Usage:
 *   const retro = require('./sprint-retro');
 *   const report = await retro.runRetro();           // latest sprint
 *   const report = await retro.runRetro(3);          // sprint #3
 *   const latest = retro.getLatestReport();          // read cached report
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const opsLog = require('./ops-log.js');

const HISTORY_FILE = path.join(process.env.HOME || '/Users/elf-6', 'openclaw/logs/sprint_history.json');
const RETRO_DIR = path.join(process.env.HOME || '/Users/elf-6', 'openclaw/logs/sprint_retros');
const SEED_DIR = path.join(process.env.HOME || '/Users/elf-6', 'openclaw/shared/4_Ready_to_Seed');
const CEO_REVIEW_DIR = path.join(process.env.HOME || '/Users/elf-6', 'openclaw/shared/2_CEO_review');
const PATTERNS_FILE = path.join(RETRO_DIR, 'patterns.json');

// Notion config
const NOTION_DB_ID = '2f797f89-9129-8068-b8ae-c4321d1c72b7';

function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch(e) {}
    return { sessions: [], totals: {} };
}

function readApiKey(name) {
    try {
        const envContent = fs.readFileSync(`${process.env.HOME}/.openclaw/.env`, 'utf8');
        const match = envContent.match(new RegExp(`${name}="?([^"\\n]+)"?`));
        return match?.[1]?.trim() || '';
    } catch(e) { return ''; }
}

function notionRequest(method, apiPath, body = null) {
    const notionKey = readApiKey('NOTION_API_KEY');
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.notion.com',
            path: apiPath,
            method,
            headers: {
                'Authorization': `Bearer ${notionKey}`,
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
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Notion timeout')); });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function callOpenRouter(prompt) {
    const apiKey = readApiKey('OPENROUTER_API_KEY');
    if (!apiKey) return Promise.resolve('(OpenRouter unavailable — no API key)');

    return new Promise((resolve) => {
        const payload = JSON.stringify({
            model: 'openrouter/auto',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: 2000
        });

        const req = https.request({
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://dwe.openclaw.ai',
                'X-Title': 'DWE Sprint Retro'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed.choices?.[0]?.message?.content || '(empty LLM response)');
                } catch(e) {
                    resolve(`(LLM parse error: ${e.message})`);
                }
            });
        });

        req.on('error', (e) => resolve(`(LLM error: ${e.message})`));
        req.setTimeout(60000, () => { req.destroy(); resolve('(LLM timeout)'); });
        req.write(payload);
        req.end();
    });
}

// ─── Core Retro Logic ──────────────────────────────────────

async function runRetro(sprintNumber = null, ceoFeedback = null) {
    const history = loadHistory();

    // Find target session
    let session;
    if (sprintNumber) {
        session = history.sessions.find(s => s.number === sprintNumber || s.id === `sprint-${sprintNumber}`);
    } else {
        // Most recent completed session
        session = [...history.sessions].reverse().find(s => s.ended);
    }

    if (!session) {
        return { error: 'No completed sprint session found', sprintNumber };
    }

    const sprintNum = session.number || session.id;
    const sprintDate = session.started.split('T')[0];
    console.log(`[Retro] Analyzing Sprint #${sprintNum} (${sprintDate})`);

    // ── Step 1: Compute Metrics ──
    const metrics = computeMetrics(session);

    // ── Step 2: Query Notion for tasks touched during sprint ──
    let notionTasks = [];
    try {
        notionTasks = await querySprintTasks(session.started, session.ended);
    } catch(e) {
        console.error(`[Retro] Notion query error: ${e.message}`);
    }

    // ── Step 3: Build retro prompt for LLM (includes CEO perspective if provided) ──
    const llmAnalysis = await runLLMAnalysis(session, metrics, notionTasks, ceoFeedback);

    // ── Step 4: Get sprint-over-sprint trend ──
    const trend = computeTrend(history, session);

    // ── Step 5: Build full report ──
    const report = buildReport(session, metrics, llmAnalysis, trend, notionTasks, ceoFeedback);

    // ── Step 6: Save report ──
    if (!fs.existsSync(RETRO_DIR)) fs.mkdirSync(RETRO_DIR, { recursive: true });

    const jsonPath = path.join(RETRO_DIR, `sprint-${sprintNum}.json`);
    const mdPath = path.join(RETRO_DIR, `sprint-${sprintNum}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(mdPath, report.markdown);

    // ── Step 7: Seed to Brain ──
    const seedPath = path.join(SEED_DIR, `memory_sprint_retro_${sprintNum}_${sprintDate.replace(/-/g, '')}.md`);
    try {
        fs.writeFileSync(seedPath, report.markdown);
        console.log(`[Retro] Seeded to Brain: ${seedPath}`);
    } catch(e) {
        console.error(`[Retro] Seed error: ${e.message}`);
    }

    // ── Step 8: Create Critical Notion task for CEO ──
    try {
        await createCEORetroTask(sprintNum, sprintDate, report);
    } catch(e) {
        console.error(`[Retro] Notion task creation error: ${e.message}`);
    }

    // ── Step 9: Mark retro complete in history ──
    session.retroCompleted = true;
    session.retroId = `retro-${sprintNum}`;
    try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)); } catch(e) {}

    // ── Step 10: Update patterns.json (Stage 3 prep) ──
    updatePatterns(report);

    // ── Step 11: Log to ops ──
    opsLog.logEvent('retro', '📊', `Sprint #${sprintNum} retro complete — ${metrics.tasksCompleted} completed, ${metrics.idlePct}% idle`, {
        tab: 'Sprint Log',
        sprintNumber: sprintNum,
        retroStatus: 'Complete',
        keyLesson: report.keyLesson || ''
    });

    console.log(`[Retro] Sprint #${sprintNum} retro complete. Report at ${mdPath}`);
    return report;
}

function computeMetrics(session) {
    const cycles = session.cycles || [];
    const stats = session.stats || {};
    const summary = session.summary || {};

    const totalCycles = cycles.length;
    const activeCycles = cycles.filter(c => c.totalActions > 0).length;
    const idlePct = totalCycles > 0 ? Math.round(((totalCycles - activeCycles) / totalCycles) * 100) : 0;
    const throughput = totalCycles > 0 ? (stats.tasksCompleted / totalCycles).toFixed(3) : '0.000';

    // PM gate breakdown
    const pmResults = {
        closed: stats.tasksCompleted || 0,
        kickedBack: stats.tasksKickedBack || 0,
        escalated: stats.tasksEscalated || 0,
        enhanced: stats.tasksEnhanced || 0
    };

    // Agent utilization from enriched logs
    const agentActions = {};
    for (const cycle of cycles) {
        for (const key of ['completed', 'kickedBack', 'escalated', 'enhanced', 'assigned', 'unblocked']) {
            const items = cycle[key] || [];
            for (const item of items) {
                const detail = typeof item === 'object' ? item.detail : item;
                if (!detail) continue;
                // Try to extract role
                const roleMatch = detail.match(/\((\w[\w\s]*?)\)/) || detail.match(/^▶️\s*(\w[\w\s]*?):/);
                const role = roleMatch ? roleMatch[1].trim() : 'Unknown';
                if (!agentActions[role]) agentActions[role] = { assigned: 0, completed: 0, kickedBack: 0, escalated: 0, enhanced: 0, unblocked: 0 };
                if (key === 'assigned') agentActions[role].assigned++;
                else if (key === 'completed') agentActions[role].completed++;
                else if (key === 'kickedBack') agentActions[role].kickedBack++;
                else if (key === 'escalated') agentActions[role].escalated++;
                else if (key === 'enhanced') agentActions[role].enhanced++;
                else if (key === 'unblocked') agentActions[role].unblocked++;
            }
        }
    }

    // Blocking analysis
    const blockingEvents = [];
    for (const cycle of cycles) {
        const allActions = cycle.allActions || [];
        for (const a of allActions) {
            if (a.includes('Blocked') || a.includes('blocked')) {
                blockingEvents.push({ cycle: cycle.cycle, detail: a });
            }
        }
    }

    return {
        totalCycles,
        activeCycles,
        idlePct,
        throughput,
        tasksAssigned: stats.tasksAssigned || 0,
        tasksCompleted: stats.tasksCompleted || 0,
        tasksKickedBack: stats.tasksKickedBack || 0,
        tasksEscalated: stats.tasksEscalated || 0,
        tasksEnhanced: stats.tasksEnhanced || 0,
        tasksUnblocked: stats.tasksUnblocked || 0,
        pmResults,
        agentActions,
        blockingEvents,
        duration: session.summary?.duration || 'unknown',
        activeAgents: session.summary?.activeAgents || [],
        taskNames: session.summary?.taskNames || {}
    };
}

async function querySprintTasks(startTime, endTime) {
    try {
        const result = await notionRequest('POST', `/v1/databases/${NOTION_DB_ID}/query`, {
            filter: {
                and: [
                    { property: 'Last edited time', last_edited_time: { on_or_after: startTime } },
                    { property: 'Last edited time', last_edited_time: { on_or_before: endTime } }
                ]
            },
            page_size: 100
        });
        if (result.status === 200 && result.data.results) {
            return result.data.results.map(r => {
                const props = r.properties || {};
                return {
                    id: r.id,
                    name: (props['Task name']?.title || []).map(t => t.plain_text).join(''),
                    status: props.Status?.status?.name || '',
                    role: props.Role?.select?.name || '',
                    priority: props.Priority?.select?.name || '',
                    summary: (props.Summary?.rich_text || []).map(t => t.plain_text).join(''),
                    idNumber: props['ID']?.unique_id?.number || null
                };
            });
        }
    } catch(e) {
        console.error(`[Retro] Notion query error: ${e.message}`);
    }
    return [];
}

async function runLLMAnalysis(session, metrics, notionTasks, ceoFeedback = null) {
    const sprintNum = session.number || session.id;

    // Collect all action details for context
    const allDetailActions = [];
    for (const cycle of (session.cycles || [])) {
        const actions = cycle.allActions || [];
        for (const a of actions) {
            if (!allDetailActions.includes(a)) allDetailActions.push(a);
        }
    }

    // Task summary for Notion tasks touched during sprint
    const taskSummaries = notionTasks.slice(0, 20).map(t =>
        `- TAS-${t.idNumber} "${t.name}" (${t.role}, ${t.status}, ${t.priority}): ${(t.summary || 'no summary').slice(0, 100)}`
    ).join('\n');

    // CEO perspective section — most important input for the retro
    let ceoSection = '';
    if (ceoFeedback) {
        ceoSection = `
## CEO Perspective (Sidney's Direct Input — HIGHEST PRIORITY)
**What worked from CEO's view**: ${ceoFeedback.wentWell || '(not provided)'}
**What didn't work from CEO's view**: ${ceoFeedback.wentPoorly || '(not provided)'}
${ceoFeedback.additionalNotes ? `**Additional notes**: ${ceoFeedback.additionalNotes}` : ''}

IMPORTANT: The CEO's perspective must be the PRIMARY driver of your analysis.
Your recommendations should directly address the CEO's concerns. If the CEO
says something didn't work, that is the #1 problem to solve — even if the
metrics look fine.
`;
    } else {
        ceoSection = `
## CEO Perspective
(CEO feedback not yet collected — analysis based on metrics only.
For a complete retro, re-run with CEO input via /sprint-retro in Jarvis.)
`;
    }

    const prompt = `You are analyzing Sprint #${sprintNum} for the DWE (Digital Wealth Ecosystem) AI agent team.
${ceoSection}
## Sprint Metrics
- Duration: ${metrics.duration}
- Total cycles: ${metrics.totalCycles} (5-min intervals)
- Active cycles (at least 1 action): ${metrics.activeCycles} (${100 - metrics.idlePct}% active, ${metrics.idlePct}% idle)
- Throughput: ${metrics.throughput} tasks/cycle
- Tasks assigned: ${metrics.tasksAssigned}
- Tasks completed: ${metrics.tasksCompleted}
- Tasks kicked back: ${metrics.tasksKickedBack}
- Tasks escalated to CEO: ${metrics.tasksEscalated}
- Tasks with enhancements: ${metrics.tasksEnhanced}
- Tasks unblocked by Jarvis: ${metrics.tasksUnblocked}
- Active agents: ${metrics.activeAgents.join(', ') || 'none detected'}

## Agent Performance
${Object.entries(metrics.agentActions).map(([role, a]) =>
    `- ${role}: assigned=${a.assigned}, completed=${a.completed}, kickedBack=${a.kickedBack}, escalated=${a.escalated}`
).join('\n') || '(no per-agent data)'}

## All Sprint Actions
${allDetailActions.slice(0, 50).join('\n') || '(no detailed actions recorded — legacy sprint format)'}

## Notion Tasks Touched During Sprint
${taskSummaries || '(none found)'}

## Blocking Events
${metrics.blockingEvents.map(b => `Cycle ${b.cycle}: ${b.detail}`).join('\n') || '(none)'}

---

Analyze this sprint and provide:

1. **Top 3 Things That Went Well** (be specific, reference TAS numbers)${ceoFeedback ? ' — incorporate CEO perspective' : ''}
2. **Top 3 Things That Went Poorly** (be specific)${ceoFeedback ? ' — CEO concerns are #1 priority' : ''}
3. **Root Cause Analysis** for the #1 problem (2-3 sentences)
4. **3 Actionable Recommendations** — each must include:
   - What to change
   - Target: one of [triage rules, SLA, SOUL.md, orchestrator, human decision]
   - Expected impact
5. **Sprint Goals for Next Sprint** (2-3 specific, measurable goals)
6. **One-Line Key Lesson** (the single most important takeaway)

Format your response as structured sections with headers. Be direct and specific — no fluff.`;

    return await callOpenRouter(prompt);
}

function computeTrend(history, currentSession) {
    const completedSessions = history.sessions.filter(s => s.ended).sort((a, b) =>
        new Date(a.started) - new Date(b.started)
    );

    const trend = completedSessions.map(s => {
        const totalCycles = (s.cycles || []).length;
        const activeCycles = (s.cycles || []).filter(c => c.totalActions > 0).length;
        const idlePct = totalCycles > 0 ? Math.round(((totalCycles - activeCycles) / totalCycles) * 100) : 0;
        return {
            sprint: s.number || s.id,
            date: (s.started || '').split('T')[0],
            completed: s.stats?.tasksCompleted || 0,
            assigned: s.stats?.tasksAssigned || 0,
            kickedBack: s.stats?.tasksKickedBack || 0,
            totalCycles,
            activeCycles,
            idlePct,
            throughput: totalCycles > 0 ? (s.stats?.tasksCompleted / totalCycles).toFixed(3) : '0.000'
        };
    });

    // After 5+ sprints, assess improvement
    let assessment = '';
    if (trend.length >= 5) {
        const recent3 = trend.slice(-3);
        const earlier3 = trend.slice(-6, -3);
        const recentAvg = recent3.reduce((sum, t) => sum + t.completed, 0) / recent3.length;
        const earlierAvg = earlier3.length > 0 ? earlier3.reduce((sum, t) => sum + t.completed, 0) / earlier3.length : 0;
        if (recentAvg > earlierAvg * 1.2) assessment = 'IMPROVING — task completion trending upward';
        else if (recentAvg < earlierAvg * 0.8) assessment = 'DEGRADING — task completion trending downward';
        else assessment = 'STAGNANT — no significant improvement in task completion';
    }

    return { trend, assessment };
}

function buildReport(session, metrics, llmAnalysis, trend, notionTasks, ceoFeedback = null) {
    const sprintNum = session.number || session.id;
    const sprintDate = (session.started || '').split('T')[0];

    // Extract key lesson from LLM analysis
    const keyLessonMatch = llmAnalysis.match(/Key Lesson[:\s]*(.+)/i) ||
                           llmAnalysis.match(/One-Line[:\s]*(.+)/i);
    const keyLesson = keyLessonMatch ? keyLessonMatch[1].trim().replace(/^\*+|\*+$/g, '') : 'See full analysis';

    // Build markdown report
    let md = `# Sprint Retro Report — Sprint #${sprintNum} (${sprintDate})\n\n`;
    md += `## Executive Summary\n`;
    md += `- **Duration**: ${metrics.duration} | **Cycles**: ${metrics.totalCycles} total, ${metrics.activeCycles} active (${metrics.idlePct}% idle)\n`;
    md += `- **Tasks**: ${metrics.tasksAssigned} assigned, ${metrics.tasksCompleted} completed, ${metrics.tasksKickedBack} kicked back, ${metrics.tasksEscalated} escalated to CEO\n`;
    md += `- **Enhancements applied**: ${metrics.tasksEnhanced}\n`;
    md += `- **Agents active**: ${metrics.activeAgents.join(', ') || 'none detected'}\n`;
    md += `- **Throughput**: ${metrics.throughput} tasks/cycle\n\n`;

    // CEO Perspective (most important section)
    if (ceoFeedback) {
        md += `## CEO Perspective (Sidney's Input)\n`;
        md += `**What worked**: ${ceoFeedback.wentWell || '(not provided)'}\n\n`;
        md += `**What didn't work**: ${ceoFeedback.wentPoorly || '(not provided)'}\n\n`;
        if (ceoFeedback.additionalNotes) {
            md += `**Additional notes**: ${ceoFeedback.additionalNotes}\n\n`;
        }
    } else {
        md += `## CEO Perspective\n`;
        md += `*Not collected for this retro. For complete analysis, re-run with CEO input via /sprint-retro.*\n\n`;
    }

    // Agent Performance table
    md += `## Agent Performance\n`;
    md += `| Agent | Assigned | Completed | Kicked Back | Escalated | Enhanced |\n`;
    md += `|-------|----------|-----------|-------------|-----------|----------|\n`;
    for (const [role, a] of Object.entries(metrics.agentActions)) {
        md += `| ${role} | ${a.assigned} | ${a.completed} | ${a.kickedBack} | ${a.escalated} | ${a.enhanced} |\n`;
    }
    md += '\n';

    // Task details
    if (Object.keys(metrics.taskNames).length > 0) {
        md += `## Tasks Worked\n`;
        for (const [tas, name] of Object.entries(metrics.taskNames)) {
            md += `- ${tas}: "${name}"\n`;
        }
        md += '\n';
    }

    // Blocking events
    if (metrics.blockingEvents.length > 0) {
        md += `## Blocking Events\n`;
        for (const b of metrics.blockingEvents) {
            md += `- Cycle ${b.cycle}: ${b.detail}\n`;
        }
        md += '\n';
    }

    // LLM Analysis
    md += `## AI Analysis\n\n${llmAnalysis}\n\n`;

    // Sprint-over-Sprint Trend
    md += `## Sprint-over-Sprint Trend\n`;
    md += `| Sprint | Date | Completed | Assigned | Idle% | Throughput |\n`;
    md += `|--------|------|-----------|----------|-------|------------|\n`;
    for (const t of trend.trend) {
        md += `| ${t.sprint} | ${t.date} | ${t.completed} | ${t.assigned} | ${t.idlePct}% | ${t.throughput} |\n`;
    }
    if (trend.assessment) {
        md += `\n**Assessment**: ${trend.assessment}\n`;
    }
    md += '\n';

    return {
        sprintNumber: sprintNum,
        sprintDate,
        metrics,
        llmAnalysis,
        trend,
        keyLesson,
        markdown: md,
        generatedAt: new Date().toISOString()
    };
}

async function createCEORetroTask(sprintNum, sprintDate, report) {
    const title = `Sprint #${sprintNum} Retro — ${report.keyLesson.slice(0, 60)}`;
    const summaryText = [
        `Sprint #${sprintNum} (${sprintDate}) Retrospective Report`,
        '',
        `Duration: ${report.metrics.duration}`,
        `Tasks: ${report.metrics.tasksCompleted} completed, ${report.metrics.tasksKickedBack} kicked back, ${report.metrics.tasksEscalated} escalated`,
        `Idle: ${report.metrics.idlePct}%`,
        `Throughput: ${report.metrics.throughput} tasks/cycle`,
        '',
        `Key Lesson: ${report.keyLesson}`,
        '',
        'Full report saved to sprint_retros/ and seeded to DWE Brain.',
        'Run /sprint-retro in Jarvis for interactive review.'
    ].join('\n');

    const result = await notionRequest('POST', '/v1/pages', {
        parent: { database_id: NOTION_DB_ID },
        properties: {
            'Task name': { title: [{ text: { content: title.slice(0, 100) } }] },
            'Status': { status: { name: 'Not started' } },
            'Priority': { select: { name: 'Critical' } },
            'Role': { select: { name: 'CEO' } },
            'Global Tags': { multi_select: [] },
            'Summary': { rich_text: [{ text: { content: summaryText.slice(0, 2000) } }] }
        }
    });

    if (result.status === 200 || result.status === 201) {
        console.log(`[Retro] Created CEO retro task: ${title}`);
    } else {
        console.error(`[Retro] Failed to create CEO task: ${JSON.stringify(result.data).slice(0, 300)}`);
    }
}

function updatePatterns(report) {
    let patterns;
    try {
        if (fs.existsSync(PATTERNS_FILE)) {
            patterns = JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf8'));
        } else {
            patterns = { issues: [], improvements: [], sprintCount: 0 };
        }
    } catch(e) {
        patterns = { issues: [], improvements: [], sprintCount: 0 };
    }

    patterns.sprintCount++;
    patterns.issues.push({
        sprint: report.sprintNumber,
        date: report.sprintDate,
        idlePct: report.metrics.idlePct,
        completed: report.metrics.tasksCompleted,
        keyLesson: report.keyLesson,
        timestamp: new Date().toISOString()
    });

    // Keep last 20 entries
    if (patterns.issues.length > 20) patterns.issues = patterns.issues.slice(-20);

    // Check for recurring issues (3+ occurrences)
    if (patterns.sprintCount >= 3) {
        const recentIssues = patterns.issues.slice(-3);
        const allHighIdle = recentIssues.every(i => i.idlePct > 80);
        const allLowCompletion = recentIssues.every(i => i.completed < 3);

        if (allHighIdle || allLowCompletion) {
            const proposal = {
                type: allHighIdle ? 'orchestrator' : 'triage_rules',
                issue: allHighIdle ? 'Consistently >80% idle cycles across 3 sprints' : 'Consistently <3 tasks completed across 3 sprints',
                proposal: allHighIdle
                    ? 'Reduce sprint cycle interval from 5min to 3min, or add more aggressive task assignment'
                    : 'Review task assignment logic — agents may not be picking up work',
                proposedAt: new Date().toISOString(),
                status: 'pending_ceo_review'
            };
            patterns.improvements.push(proposal);

            // Write proposal to CEO review folder
            const proposalPath = path.join(CEO_REVIEW_DIR, `retro_proposal_sprint_${report.sprintNumber}.md`);
            const proposalMd = `# Retro Auto-Proposal — Sprint #${report.sprintNumber}\n\n` +
                `**Issue**: ${proposal.issue}\n` +
                `**Target**: ${proposal.type}\n` +
                `**Proposal**: ${proposal.proposal}\n\n` +
                `This pattern has repeated across 3+ sprints. Auto-applied in 48h if not rejected.\n`;
            try { fs.writeFileSync(proposalPath, proposalMd); } catch(e) {}
        }
    }

    try { fs.writeFileSync(PATTERNS_FILE, JSON.stringify(patterns, null, 2)); } catch(e) {}
}

function getLatestReport() {
    try {
        const files = fs.readdirSync(RETRO_DIR).filter(f => f.endsWith('.json') && f.startsWith('sprint-'));
        if (files.length === 0) return null;
        files.sort();
        const latest = files[files.length - 1];
        return JSON.parse(fs.readFileSync(path.join(RETRO_DIR, latest), 'utf8'));
    } catch(e) {
        return null;
    }
}

module.exports = { runRetro, getLatestReport };
