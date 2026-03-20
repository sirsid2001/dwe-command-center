/**
 * DWE Skool Pipeline — Enrichment layer for scraped Skool posts
 * Deduplicates, extracts YouTube transcripts, summarizes with Ollama, detects themes.
 *
 * Returns JSON matching the skoolRender() frontend contract:
 *   { total, classrooms, videos, themes, theme_count, video_count }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const http = require('http');

const CONFIG_DIR = path.join(process.env.HOME, 'openclaw/shared/config/skool-scraper');
const SEEN_POSTS_PATH = path.join(CONFIG_DIR, 'seen_posts.json');
const CACHE_DIR = path.join(CONFIG_DIR, 'cache');
const YT_DLP = '/opt/homebrew/bin/yt-dlp';
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const OLLAMA_MODEL = 'qwen2.5:7b';

// ── Dedup ──

function loadSeenPosts() {
    try {
        return JSON.parse(fs.readFileSync(SEEN_POSTS_PATH, 'utf8'));
    } catch (e) {
        return { seen: {}, lastPruned: null };
    }
}

function saveSeenPosts(data) {
    fs.writeFileSync(SEEN_POSTS_PATH, JSON.stringify(data, null, 2));
}

function postHash(post) {
    const key = (post.postUrl || post.title || '') + (post.text || '').substring(0, 200);
    return crypto.createHash('md5').update(key).digest('hex');
}

function pruneSeenPosts(data) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
    const pruned = {};
    for (const [hash, entry] of Object.entries(data.seen)) {
        if (new Date(entry.firstSeen).getTime() > cutoff) {
            pruned[hash] = entry;
        }
    }
    data.seen = pruned;
    data.lastPruned = new Date().toISOString();
    return data;
}

function deduplicatePosts(communities) {
    let seenData = loadSeenPosts();
    // Prune weekly
    if (!seenData.lastPruned || Date.now() - new Date(seenData.lastPruned).getTime() > 7 * 24 * 60 * 60 * 1000) {
        seenData = pruneSeenPosts(seenData);
    }

    const newCommunities = [];
    for (const community of communities) {
        const newPosts = [];
        for (const post of (community.posts || [])) {
            const hash = postHash(post);
            if (!seenData.seen[hash]) {
                seenData.seen[hash] = { firstSeen: new Date().toISOString(), community: community.name };
                newPosts.push(post);
            }
        }
        newCommunities.push({ ...community, posts: newPosts });
    }
    saveSeenPosts(seenData);
    return newCommunities;
}

// ── YouTube Transcript via yt-dlp ──

function getYouTubeTranscript(url, timeout = 45000) {
    return new Promise((resolve) => {
        const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'skool-yt-'));
        const subFile = path.join(tmpDir, 'subs');

        const args = [
            '--skip-download',
            '--write-auto-sub',
            '--sub-lang', 'en',
            '--sub-format', 'vtt',
            '--output', subFile,
            '--no-warnings',
            '--quiet',
            url
        ];

        execFile(YT_DLP, args, { timeout }, (err) => {
            try {
                const files = fs.readdirSync(tmpDir);
                const vttFile = files.find(f => f.endsWith('.vtt'));
                if (vttFile) {
                    const vtt = fs.readFileSync(path.join(tmpDir, vttFile), 'utf8');
                    const transcript = parseVTT(vtt);
                    cleanup(tmpDir);
                    resolve(transcript.substring(0, 8000));
                    return;
                }

                // Try manual subs
                const args2 = [...args];
                args2[2] = '--write-sub'; // replace --write-auto-sub
                execFile(YT_DLP, args2, { timeout }, (err2) => {
                    try {
                        const files2 = fs.readdirSync(tmpDir);
                        const vttFile2 = files2.find(f => f.endsWith('.vtt'));
                        if (vttFile2) {
                            const vtt2 = fs.readFileSync(path.join(tmpDir, vttFile2), 'utf8');
                            const transcript = parseVTT(vtt2);
                            cleanup(tmpDir);
                            resolve(transcript.substring(0, 8000));
                        } else {
                            cleanup(tmpDir);
                            resolve(null);
                        }
                    } catch (e) {
                        cleanup(tmpDir);
                        resolve(null);
                    }
                });
            } catch (e) {
                cleanup(tmpDir);
                resolve(null);
            }
        });
    });
}

function parseVTT(vtt) {
    const lines = [];
    let prevLine = '';
    for (const line of vtt.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('WEBVTT') || trimmed.startsWith('Kind:') || trimmed.startsWith('Language:')) continue;
        if (/^\d{2}:\d{2}/.test(trimmed) || trimmed.startsWith('NOTE')) continue;
        const clean = trimmed.replace(/<[^>]+>/g, '').trim();
        if (clean && clean !== prevLine) {
            lines.push(clean);
            prevLine = clean;
        }
    }
    return lines.join(' ');
}

function cleanup(dir) {
    try {
        const files = fs.readdirSync(dir);
        for (const f of files) fs.unlinkSync(path.join(dir, f));
        fs.rmdirSync(dir);
    } catch (e) {}
}

function getYouTubeTitle(url, timeout = 15000) {
    return new Promise((resolve) => {
        execFile(YT_DLP, ['--get-title', '--no-warnings', '--quiet', url], { timeout }, (err, stdout) => {
            resolve(err ? null : stdout.trim());
        });
    });
}

// ── Ollama LLM ──

function ollamaChat(prompt, maxTokens = 1500, timeout = 120000) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            model: OLLAMA_MODEL,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            options: { num_predict: maxTokens }
        });

        const req = http.request(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(body);
                    resolve(result.message?.content || '');
                } catch (e) {
                    reject(new Error('Ollama parse error'));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
        req.write(data);
        req.end();
    });
}

async function summarizePost(post) {
    const text = (post.text || '').substring(0, 3000);
    const linksText = (post.links || []).map(l => `- [${l.text}](${l.url})`).join('\n') || 'No links';

    const prompt = `You are summarizing a Skool community post for a CEO who runs a digital wealth ecosystem with AI agents.
This is from the "${post.community}" community and likely covers AI, automation, Claude, SEO, or business tools.

Post by: ${post.author || 'Unknown'}
Title: ${post.title || 'Untitled'}

Content:
${text}

Links found:
${linksText}

Respond in EXACTLY this format (no extra text):

HYPE CHECK: [🟢 Solid | 🟡 Mixed | 🔴 Hype]
• (1 sentence explaining WHY — does it have specifics, proof, data, real examples? Or is it vague motivation, income claims, engagement bait, upsell pressure?)

KEY POINTS:
• (2-4 bullet points, ultra concise, action-oriented)

LINKS:
• [link text](url) — one line description
(only include genuinely useful links)

RELEVANCE:
• (1-2 bullets on how this is relevant to DWE — AI automation, agent workflows, revenue, Claude/OpenClaw usage)

HYPE CHECK rules:
🟢 Solid = specific techniques, real code/tools, data-backed claims, step-by-step how-to, verifiable results
🟡 Mixed = some real info buried under salesmanship, useful if you filter the noise
🔴 Hype = vague promises, income screenshots, "secret method" language, pure upsell, no actionable substance

Keep the entire response under 180 words.`;

    try {
        return await ollamaChat(prompt);
    } catch (e) {
        return `KEY POINTS:\n• (Ollama error: ${e.message})\n• ${text.substring(0, 200)}...`;
    }
}

async function summarizeVideo(title, transcript, url) {
    const prompt = `You are extracting golden nuggets from a video transcript for a CEO building a digital wealth ecosystem with AI agents (OpenClaw, Claude, automation).

Video: ${title}
URL: ${url}

Transcript excerpt:
${transcript.substring(0, 5000)}

Extract the MOST ACTIONABLE insights. Respond in EXACTLY this format:

HYPE CHECK: [🟢 Solid | 🟡 Mixed | 🔴 Hype]
• (1 sentence: does this video teach real techniques with specifics, or is it motivation/upsell/vague promises?)

GOLDEN NUGGETS:
• (3-5 key takeaways that are immediately actionable)

TOOLS/TECH MENTIONED:
• (any tools, APIs, frameworks, or techniques mentioned)

DWE ACTION ITEMS:
• (specific things the CEO or his AI team should do based on this video)

HYPE CHECK rules:
🟢 Solid = specific techniques, real demos, code walkthroughs, verifiable methods, step-by-step tutorials
🟡 Mixed = some real content mixed with salesmanship, useful if filtered
🔴 Hype = income claims without proof, "secret method", guru posturing, pure pitch, no real how-to

Keep the entire response under 220 words. Focus on what's NEW and ACTIONABLE, not obvious advice.`;

    try {
        return await ollamaChat(prompt, 1500, 120000);
    } catch (e) {
        return `GOLDEN NUGGETS:\n• (Ollama error: ${e.message})`;
    }
}

async function detectThemes(allPosts) {
    if (allPosts.length < 2) return null;

    const digestLines = allPosts.map(p =>
        `[${p.community}] "${p.title}": ${(p.summary || p.text || '').substring(0, 300)}`
    );

    const prompt = `You are a strategic intelligence analyst for a CEO building a digital wealth ecosystem with AI.

Below are summaries from ${allPosts.length} Skool community posts across different classrooms. Identify convergent themes — when multiple communities talk about the same trends, tools, or strategies, that's a HIGH-CONFIDENCE signal.

POSTS:
${digestLines.join('\n\n').substring(0, 6000)}

Respond in EXACTLY this format:

🎓 THEME DETECTED: [topic]
Classrooms: [Community A] + [Community B]
Signal: [1-2 sentences on why this matters and what action to take]

Repeat for each theme. If no themes exist, write:
✅ No cross-classroom convergence detected.

Then add:

📈 LEARNING PULSE:
• [1-2 sentences: what's the overall educational focus right now across these communities?]

Keep response under 250 words.`;

    try {
        return await ollamaChat(prompt, 1500, 90000);
    } catch (e) {
        return `(Theme analysis error: ${e.message})`;
    }
}

// ── Main Pipeline ──

/**
 * Run the full enrichment pipeline on scraper output.
 * Returns JSON matching the skoolRender() frontend contract.
 */
async function enrichScrapeResults(scraperOutput, config) {
    const maxVideos = (config && config.maxVideosPerRun) || 5;

    // Step 1: Deduplicate
    const communities = deduplicatePosts(scraperOutput.communities || []);

    // Step 2: Process each community
    const classrooms = [];
    const allVideos = [];
    const allPostsFlat = [];
    let total = 0;
    let videoCount = 0;

    for (const community of communities) {
        const emails = []; // Named "emails" to match frontend contract

        for (const post of (community.posts || [])) {
            console.log(`  📝 Summarizing: ${(post.title || 'untitled').substring(0, 50)}...`);
            const summary = await summarizePost(post);

            const item = {
                subject: post.title || post.text?.substring(0, 80) || 'Untitled',
                date: post.timestamp || '',
                summary: summary,
                msg_id: post.postUrl || postHash(post), // Used for archive/dedup on frontend
                youtube_urls: post.youtubeUrls || [],
                author: post.author || '',
                likes: post.likes || 0,
                comments: post.comments || 0,
            };

            emails.push(item);
            allPostsFlat.push({ ...item, community: community.name });
            total++;

            // Process YouTube videos (cap at maxVideos total)
            for (const ytUrl of (post.youtubeUrls || [])) {
                if (videoCount >= maxVideos) break;
                console.log(`    🎬 Pulling transcript: ${ytUrl}`);
                const title = await getYouTubeTitle(ytUrl) || post.title || 'Untitled Video';
                const transcript = await getYouTubeTranscript(ytUrl);
                const video = {
                    url: ytUrl,
                    title: title,
                    classroom: community.name,
                    from_subject: post.title || '',
                    has_transcript: transcript !== null,
                    summary: null
                };
                if (transcript) {
                    console.log(`    📝 Summarizing video: ${title.substring(0, 40)}...`);
                    video.summary = await summarizeVideo(title, transcript, ytUrl);
                } else {
                    video.summary = '⚠️ No transcript available for this video.';
                    console.log(`    ⚠️ No transcript available`);
                }
                allVideos.push(video);
                videoCount++;
            }
        }

        if (emails.length > 0) {
            classrooms.push({
                name: community.name,
                emails: emails
            });
        }
    }

    // Step 3: Cross-community theme detection
    let themes = null;
    if (allPostsFlat.length >= 2) {
        console.log(`  🔗 Analyzing cross-classroom themes...`);
        themes = await detectThemes(allPostsFlat);
    }

    const themeCount = themes ? (themes.match(/THEME DETECTED/g) || []).length : 0;

    // Cache results
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(
            path.join(CACHE_DIR, 'last_scrape.json'),
            JSON.stringify({ total, classrooms, videos: allVideos, themes, theme_count: themeCount, video_count: videoCount, scraped_at: new Date().toISOString() }, null, 2)
        );
    } catch (e) {}

    return {
        total,
        classrooms,
        videos: allVideos,
        themes,
        theme_count: themeCount,
        video_count: videoCount
    };
}

/**
 * Get cached results (for instant display without waiting for scrape).
 */
function getCachedResults() {
    try {
        const cachePath = path.join(CACHE_DIR, 'last_scrape.json');
        if (fs.existsSync(cachePath)) {
            return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        }
    } catch (e) {}
    return null;
}

module.exports = { enrichScrapeResults, getCachedResults };
