/**
 * DWE YouTube Intel — CEO-curated video analysis pipeline
 * Single endpoint: POST /mc/yt-intel/ingest
 *
 * Flow: CEO shares YouTube URL from RSS reader → fetch transcript via yt-dlp →
 * analyze with Ollama → route brief to selected agents → store in dashboard + Brain
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { getYouTubeTranscript, getYouTubeTitle, ollamaChat } = require('./skool-pipeline.js');

const CONTENT_INTEL_FILE = path.join(__dirname, 'content-intel-data.json');
const CONFIG_DIR = path.join(process.env.HOME, 'openclaw/shared/config/content-intel');
const SEEN_FILE = path.join(CONFIG_DIR, 'seen_videos.json');
const OPENCLAW = '/opt/homebrew/bin/openclaw';
const OLLAMA_EMBED_URL = 'http://localhost:11434/api/embeddings';

// ── Tag → Agent routing map ──
const TAG_TO_AGENTS = {
    'finance':    ['cfo'],
    'revenue':    ['cfo'],
    'investing':  ['cfo'],
    'engineering':['chief-engineer'],
    'automation': ['chief-engineer'],
    'coding':     ['chief-engineer'],
    'architecture':['cto'],
    'ai-agents':  ['cto', 'chief-engineer'],
    'infrastructure': ['cto'],
    'marketing':  ['nicole'],
    'seo':        ['nicole'],
    'growth':     ['nicole'],
    'outreach':   ['jake'],
    'email':      ['jake'],
    'cold-email': ['jake'],
    'project-management': ['anita'],
};

// ── Helpers ──

function loadSeen() {
    try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); }
    catch(e) { return {}; }
}

function saveSeen(data) {
    fs.writeFileSync(SEEN_FILE, JSON.stringify(data, null, 2));
}

function extractVideoId(url) {
    // watch?v=, youtu.be/, shorts/, live/, embed/
    let m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];
    m = url.match(/(?:youtu\.be|shorts|live|embed)\/([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}

function resolveAgents(requested, tags, suggested) {
    if (!requested || !requested.length || (requested.length === 1 && requested[0] === 'auto')) {
        // Auto-route from tags + LLM suggestions
        const agentSet = new Set();
        for (const tag of (tags || [])) {
            const mapped = TAG_TO_AGENTS[tag.toLowerCase()];
            if (mapped) mapped.forEach(a => agentSet.add(a));
        }
        for (const a of (suggested || [])) {
            agentSet.add(a);
        }
        // Default to CTO if nothing matched
        if (agentSet.size === 0) agentSet.add('cto');
        return [...agentSet];
    }
    if (requested.includes('all')) {
        return ['cto', 'chief-engineer', 'cfo', 'nicole', 'jake', 'anita'];
    }
    return requested;
}

function buildBrief(title, channel, url, score, verdict, analysis, agentId) {
    const summaryBullets = (analysis.summary || []).map(b => `• ${b}`).join('\n');
    const agentTask = (analysis.agent_tasks || []).find(t => t.agent === agentId);
    const taskLine = agentTask ? `\nYOUR TASK:\n${agentTask.task}` : '';
    const highlights = (analysis.key_highlights || []).slice(0, 3)
        .map(h => `• ${h.highlight} → ${h.dwe_application || ''}`).join('\n');
    const tools = (analysis.tools_mentioned || []).join(', ') || 'None';

    return `YOUTUBE INTEL BRIEF\n` +
        `====================\n` +
        `Video: ${title}\n` +
        `Channel: ${channel}\n` +
        `Score: ${score}/10 | Verdict: ${verdict}\n` +
        `URL: ${url}\n\n` +
        `SUMMARY:\n${summaryBullets}\n` +
        `${taskLine}\n\n` +
        `KEY HIGHLIGHTS:\n${highlights}\n\n` +
        `Tools mentioned: ${tools}`;
}

function notifyAgent(agentId, brief) {
    return new Promise((resolve) => {
        execFile(OPENCLAW, [
            'agent', '--agent', agentId,
            '--message', brief
        ], { timeout: 30000 }, (err) => {
            if (err) console.log(`[yt-intel] Agent ${agentId} notify failed: ${err.message}`);
            resolve(!err);
        });
    });
}

function storeNugget(nugget) {
    try {
        const data = JSON.parse(fs.readFileSync(CONTENT_INTEL_FILE, 'utf8'));
        data.lastScan = new Date().toISOString();
        data.recentNuggets.unshift(nugget);
        if (data.recentNuggets.length > 50) data.recentNuggets = data.recentNuggets.slice(0, 50);

        const ch = nugget.channel || 'Unknown';
        if (!data.channelStats[ch]) data.channelStats[ch] = { videos: 0, totalScore: 0, avgScore: 0 };
        data.channelStats[ch].videos++;
        data.channelStats[ch].totalScore += nugget.score;
        data.channelStats[ch].avgScore = Math.round((data.channelStats[ch].totalScore / data.channelStats[ch].videos) * 10) / 10;

        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const weekNuggets = data.recentNuggets.filter(n => new Date(n.timestamp).getTime() > weekAgo);
        data.weeklyStats = {
            nuggets: weekNuggets.reduce((sum, n) => sum + (n.nuggets?.length || 1), 0),
            videos: weekNuggets.length,
            avgScore: weekNuggets.length ? Math.round(weekNuggets.reduce((s, n) => s + n.score, 0) / weekNuggets.length * 10) / 10 : 0
        };

        fs.writeFileSync(CONTENT_INTEL_FILE, JSON.stringify(data, null, 2));
    } catch(e) {
        console.log(`[yt-intel] Store nugget error: ${e.message}`);
    }
}

async function upsertToPinecone(videoId, title, channel, summary, tags, score) {
    try {
        // Get embedding from Ollama
        const embedReq = JSON.stringify({ model: 'nomic-embed-text', prompt: `${title} ${summary}` });
        const embedding = await new Promise((resolve, reject) => {
            const req = http.request(OLLAMA_EMBED_URL, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 30000
            }, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(body).embedding); }
                    catch(e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.write(embedReq);
            req.end();
        });

        if (!embedding || !embedding.length) return;

        // Upsert via n8n ingest webhook
        const payload = JSON.stringify({
            filename: `yt-intel-${videoId}`,
            namespace: 'dwe-docs',
            content: `---\ntitle: "${title}"\nchannel: "${channel}"\ntags: ${JSON.stringify(tags)}\nscore: ${score}\ntype: youtube-intel\n---\n\n${summary}`
        });
        const ingestReq = http.request('https://n8n.tvcpulse.com/webhook/openclaw-ingest', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 15000
        });
        ingestReq.on('error', () => {});
        ingestReq.write(payload);
        ingestReq.end();
    } catch(e) {
        console.log(`[yt-intel] Pinecone upsert skipped: ${e.message}`);
    }
}

// ── Analysis prompt ──

function buildAnalysisPrompt(title, channel, transcript) {
    return `You are an intelligence analyst for a CEO building a digital workforce ecosystem (DWE) with AI agents.

Analyze this YouTube video transcript and respond with ONLY valid JSON (no markdown, no backticks):

{
  "score": <1-10 relevance to DWE>,
  "verdict": "<WATCH|SKIM|SKIP>",
  "verdict_reason": "<1 sentence why>",
  "summary": ["<bullet 1>", "<bullet 2>", "<bullet 3>"],
  "key_highlights": [{"highlight": "...", "dwe_application": "...", "urgency": "this_week|this_month|backlog"}],
  "tools_mentioned": ["tool1", "tool2"],
  "tags": ["finance", "engineering", "marketing", "ai-agents", "seo", "automation", "growth", "outreach", "cold-email", "investing", "infrastructure", "coding", "project-management"],
  "suggested_agents": ["<cfo|cto|chief-engineer|nicole|jake|anita>"],
  "agent_tasks": [{"agent": "<id>", "task": "<specific actionable task for this agent>"}],
  "revenue_potential": "<null or 1-sentence revenue angle>"
}

Video: ${title}
Channel: ${channel}

Transcript:
${(transcript || '').substring(0, 6000)}

DWE context: We run AI agents (CTO=architecture/tech, Chief Engineer=implementation, CFO/Fran=finance/revenue, Nicole=marketing/growth, Jake=outreach/email, Anita=project management) on OpenClaw. We use Pinecone, n8n, Ollama local LLM, Claude Code. Target: $10K/month revenue.
Score 8+ = directly actionable. Score 5-7 = useful reference. Below 5 = skip.
Only include tags that genuinely apply. Only suggest agents who would actually benefit.`;
}

// ── Main handler ──

async function handleYtIntelIngest(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method !== 'POST') {
        res.writeHead(405);
        res.end(JSON.stringify({ ok: false, error: 'POST only' }));
        return;
    }

    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
        try {
            const { url: videoUrl, agents: requestedAgents } = JSON.parse(body);
            if (!videoUrl) {
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: 'Missing url' }));
                return;
            }

            const videoId = extractVideoId(videoUrl);
            if (!videoId) {
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: 'Could not parse YouTube video ID from URL' }));
                return;
            }

            // Dedup check
            const seen = loadSeen();
            if (seen[videoId]) {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, duplicate: true, existing: seen[videoId] }));
                return;
            }

            console.log(`[yt-intel] Ingesting ${videoId} from ${videoUrl}`);

            // Fetch title + transcript in parallel
            const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
            const [title, transcript] = await Promise.all([
                getYouTubeTitle(canonicalUrl),
                getYouTubeTranscript(canonicalUrl)
            ]);

            const videoTitle = title || `Video ${videoId}`;
            const channel = ''; // RSS reader doesn't pass channel; Ollama will infer from content

            if (!transcript) {
                // Still useful — analyze from title alone
                console.log(`[yt-intel] No transcript for ${videoId}, analyzing title only`);
            }

            // Ollama analysis
            const prompt = buildAnalysisPrompt(videoTitle, channel, transcript || '(No transcript available — analyze based on title only)');
            let analysis;
            try {
                const raw = await ollamaChat(prompt, 2000, 120000);
                // Extract JSON from response (handle markdown wrapping)
                const jsonMatch = raw.match(/\{[\s\S]*\}/);
                analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
            } catch(e) {
                console.log(`[yt-intel] Ollama analysis failed: ${e.message}`);
                analysis = null;
            }

            if (!analysis) {
                analysis = {
                    score: 5, verdict: 'SKIM', verdict_reason: 'Analysis failed — review manually',
                    summary: [videoTitle], key_highlights: [], tools_mentioned: [],
                    tags: [], suggested_agents: ['cto'], agent_tasks: [], revenue_potential: null
                };
            }

            const score = analysis.score || 5;
            const verdict = analysis.verdict || 'SKIM';

            // Resolve which agents get the brief
            const agents = resolveAgents(requestedAgents, analysis.tags, analysis.suggested_agents);

            // Store nugget in content-intel-data.json
            const nugget = {
                videoId,
                title: videoTitle,
                channel: channel || analysis.channel || '',
                score,
                verdict,
                verdict_reason: analysis.verdict_reason || '',
                video_summary: analysis.summary || [],
                key_highlights: (analysis.key_highlights || []).slice(0, 5),
                agent_assignments: agents.map(a => ({ agent: a })),
                tools_mentioned: analysis.tools_mentioned || [],
                revenue_potential: analysis.revenue_potential || null,
                tags: analysis.tags || [],
                url: canonicalUrl,
                timestamp: new Date().toISOString()
            };
            storeNugget(nugget);

            // Pinecone upsert (non-blocking)
            const summaryText = (analysis.summary || []).join(' ');
            upsertToPinecone(videoId, videoTitle, channel, summaryText, analysis.tags || [], score);

            // Notify agents (non-blocking, fire in parallel)
            const notifyPromises = agents.map(agentId => {
                const brief = buildBrief(videoTitle, channel, canonicalUrl, score, verdict, analysis, agentId);
                return notifyAgent(agentId, brief);
            });
            Promise.all(notifyPromises).then(results => {
                const notified = agents.filter((_, i) => results[i]);
                console.log(`[yt-intel] Notified: ${notified.join(', ')} for ${videoId}`);
            });

            // Mark as seen
            seen[videoId] = {
                title: videoTitle,
                score,
                verdict,
                agents_notified: agents,
                analyzedAt: new Date().toISOString()
            };
            saveSeen(seen);

            // Respond immediately (agent notifications continue in background)
            res.writeHead(200);
            res.end(JSON.stringify({
                ok: true,
                videoId,
                title: videoTitle,
                score,
                verdict,
                verdict_reason: analysis.verdict_reason || '',
                summary: analysis.summary || [],
                agents_notified: agents,
                has_transcript: !!transcript
            }));

            console.log(`[yt-intel] Done: ${videoTitle} — ${verdict} (${score}/10) → ${agents.join(', ')}`);

        } catch(e) {
            console.log(`[yt-intel] Error: ${e.message}`);
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
    });
}

module.exports = { handleYtIntelIngest };
