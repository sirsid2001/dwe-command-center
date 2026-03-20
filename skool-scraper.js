/**
 * DWE Skool Community Scraper — Direct page scraping via Puppeteer
 * Uses persistent Chrome profile for authentication.
 *
 * Usage:
 *   const { scrapeAllCommunities, checkSession } = require('./skool-scraper');
 *   const result = await scrapeAllCommunities();
 *
 * CLI:
 *   node skool-scraper.js --auth    # Opens visible browser for manual login
 *   node skool-scraper.js --test    # Headless test scrape
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const CONFIG_DIR = path.join(process.env.HOME, 'openclaw/shared/config/skool-scraper');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const CHROME_PROFILE = path.join(CONFIG_DIR, 'chrome-profile');

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        return { communities: [], scrollDepth: 3, maxVideosPerRun: 5, ollamaModel: 'qwen2.5:7b', lastRun: null };
    }
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function launchBrowser(headless = true) {
    return puppeteer.launch({
        headless: headless ? 'new' : false,
        userDataDir: CHROME_PROFILE,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1280,900'
        ],
        defaultViewport: { width: 1280, height: 900 }
    });
}

/**
 * Check if the Skool session is still valid (user is logged in).
 */
async function checkSession() {
    let browser;
    try {
        browser = await launchBrowser(true);
        const page = await browser.newPage();
        await page.goto('https://www.skool.com', { waitUntil: 'networkidle2', timeout: 30000 });

        // If logged in, Skool shows the user's avatar or a feed page.
        // If not logged in, it shows the login/signup page.
        const loggedIn = await page.evaluate(() => {
            // Check for common logged-in indicators
            const hasAvatar = !!document.querySelector('[data-testid="user-avatar"], img[alt*="avatar"], .styled-avatar');
            const hasNav = !!document.querySelector('nav a[href*="/community"], a[href*="/classroom"]');
            const onLoginPage = window.location.pathname.includes('/login') || window.location.pathname.includes('/signup');
            const hasUserMenu = !!document.querySelector('[aria-label*="profile"], [aria-label*="menu"], button[data-testid*="user"]');
            return (hasAvatar || hasNav || hasUserMenu) && !onLoginPage;
        });

        await browser.close();
        return loggedIn;
    } catch (e) {
        if (browser) await browser.close().catch(() => {});
        return false;
    }
}

/**
 * Open a visible browser for manual Skool login.
 * Returns a promise that resolves when the browser is closed.
 */
async function launchAuth() {
    const browser = await launchBrowser(false);
    const page = await browser.newPage();
    await page.goto('https://www.skool.com/login', { waitUntil: 'networkidle2', timeout: 30000 });

    console.log('\n🔐 Skool Login — Please log in manually in the browser window.');
    console.log('   Close the browser when done. Your session will be saved.\n');

    return new Promise((resolve) => {
        browser.on('disconnected', () => {
            console.log('✅ Browser closed. Session saved to chrome profile.');
            resolve({ ok: true, message: 'Session saved. You can now run headless scrapes.' });
        });
    });
}

/**
 * Extract community slug from URL.
 * e.g., "https://www.skool.com/ai-seo-with-julian-goldie-1553" → "ai-seo-with-julian-goldie-1553"
 */
function getCommunitySlug(url) {
    const match = url.match(/skool\.com\/([^?#/]+)/);
    return match ? match[1] : url;
}

/**
 * Scrape a single Skool community page.
 */
async function scrapeCommunity(page, communityUrl, scrollDepth = 3) {
    const slug = getCommunitySlug(communityUrl);
    const feedUrl = `https://www.skool.com/${slug}`;

    await page.goto(feedUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    // Wait for the feed to load
    await page.waitForSelector('article, [data-testid="post"], div[class*="post"], div[class*="feed-item"]', { timeout: 15000 }).catch(() => {});

    // Scroll to load more posts
    for (let i = 0; i < scrollDepth; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000)); // Random delay 1.5-2.5s
    }

    // Scroll back to top for consistent extraction
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(r => setTimeout(r, 500));

    // Extract posts from the DOM
    const posts = await page.evaluate((communityName) => {
        const results = [];

        // Skool uses various post container patterns — try multiple selectors
        const postContainers = document.querySelectorAll(
            'article, [data-testid="post"], [class*="PostCard"], [class*="post-card"], [class*="FeedItem"], [class*="feed-item"]'
        );

        // If no specific containers found, try a broader approach
        let containers = postContainers.length > 0 ? postContainers : document.querySelectorAll('div[class*="styled__"] > div');

        containers.forEach((post, idx) => {
            if (idx > 50) return; // Safety cap

            const item = {
                title: '',
                text: '',
                author: '',
                timestamp: '',
                postUrl: '',
                youtubeUrls: [],
                links: [],
                likes: 0,
                comments: 0,
                community: communityName
            };

            // Title — often in h2, h3, or a prominent link
            const titleEl = post.querySelector('h2, h3, [class*="Title"], [class*="title"]');
            if (titleEl) item.title = titleEl.innerText.trim();

            // Text content — the post body
            const bodyEl = post.querySelector('[class*="Body"], [class*="body"], [class*="Content"], [class*="content"], p');
            if (bodyEl) item.text = bodyEl.innerText.trim().substring(0, 2000);

            // If no title, use first line of text
            if (!item.title && item.text) {
                item.title = item.text.split('\n')[0].substring(0, 100);
            }

            // Author
            const authorEl = post.querySelector('[class*="Author"], [class*="author"], [class*="UserName"], [class*="user-name"], a[href*="/@"]');
            if (authorEl) item.author = authorEl.innerText.trim();

            // Timestamp
            const timeEl = post.querySelector('time, [class*="time"], [class*="date"], [class*="Time"], [class*="Date"]');
            if (timeEl) item.timestamp = timeEl.getAttribute('datetime') || timeEl.innerText.trim();

            // Post URL
            const linkEl = post.querySelector('a[href*="/post/"], a[href*="skool.com"]');
            if (linkEl) item.postUrl = linkEl.href;

            // YouTube embeds
            const iframes = post.querySelectorAll('iframe[src*="youtube"], iframe[src*="youtu.be"]');
            iframes.forEach(iframe => {
                const src = iframe.src || '';
                const vidMatch = src.match(/(?:youtube\.com\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
                if (vidMatch) {
                    item.youtubeUrls.push(`https://www.youtube.com/watch?v=${vidMatch[1]}`);
                }
            });

            // YouTube links in text
            const allLinks = post.querySelectorAll('a[href]');
            allLinks.forEach(a => {
                const href = a.href || '';
                const vidMatch = href.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/);
                if (vidMatch) {
                    const ytUrl = `https://www.youtube.com/watch?v=${vidMatch[1]}`;
                    if (!item.youtubeUrls.includes(ytUrl)) {
                        item.youtubeUrls.push(ytUrl);
                    }
                } else if (href && !href.includes('skool.com') && !href.includes('javascript:') && !href.startsWith('#')) {
                    const text = a.innerText.trim().substring(0, 80);
                    if (text) {
                        item.links.push({ text, url: href });
                    }
                }
            });

            // Like/comment counts
            const engagementEls = post.querySelectorAll('[class*="like"], [class*="Like"], [class*="comment"], [class*="Comment"], [class*="reaction"]');
            engagementEls.forEach(el => {
                const num = parseInt(el.innerText.replace(/\D/g, ''));
                if (!isNaN(num)) {
                    if (el.className.toLowerCase().includes('like') || el.className.toLowerCase().includes('reaction')) {
                        item.likes = Math.max(item.likes, num);
                    } else if (el.className.toLowerCase().includes('comment')) {
                        item.comments = Math.max(item.comments, num);
                    }
                }
            });

            // Only include posts with some content
            if (item.title || item.text) {
                results.push(item);
            }
        });

        return results;
    }, slug);

    return posts;
}

/**
 * Scrape all enabled communities from config.
 */
async function scrapeAllCommunities() {
    const config = loadConfig();
    const enabledCommunities = config.communities.filter(c => c.enabled !== false);

    if (enabledCommunities.length === 0) {
        return { communities: [], meta: { scraped_at: new Date().toISOString(), session_ok: true, total_posts: 0 } };
    }

    let browser;
    try {
        browser = await launchBrowser(true);
        const page = await browser.newPage();

        // Set a reasonable user agent
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Check session first
        await page.goto('https://www.skool.com', { waitUntil: 'networkidle2', timeout: 30000 });
        const loggedIn = await page.evaluate(() => {
            const onLoginPage = window.location.pathname.includes('/login') || window.location.pathname.includes('/signup');
            return !onLoginPage;
        });

        if (!loggedIn) {
            await browser.close();
            return {
                communities: [],
                meta: { scraped_at: new Date().toISOString(), session_ok: false, total_posts: 0, error: 'Session expired — re-authenticate required' }
            };
        }

        const communities = [];
        let totalPosts = 0;

        for (const community of enabledCommunities) {
            try {
                console.log(`  Scraping: ${community.name}...`);
                const posts = await scrapeCommunity(page, community.url, config.scrollDepth || 3);
                communities.push({
                    name: community.name,
                    url: community.url,
                    posts: posts
                });
                totalPosts += posts.length;
                console.log(`  ✅ ${community.name}: ${posts.length} posts`);

                // Brief delay between communities
                if (enabledCommunities.indexOf(community) < enabledCommunities.length - 1) {
                    await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
                }
            } catch (e) {
                console.error(`  ❌ ${community.name}: ${e.message}`);
                communities.push({
                    name: community.name,
                    url: community.url,
                    posts: [],
                    error: e.message
                });
            }
        }

        await browser.close();

        // Update lastRun in config
        config.lastRun = new Date().toISOString();
        saveConfig(config);

        return {
            communities,
            meta: {
                scraped_at: new Date().toISOString(),
                session_ok: true,
                total_posts: totalPosts
            }
        };

    } catch (e) {
        if (browser) await browser.close().catch(() => {});
        return {
            communities: [],
            meta: { scraped_at: new Date().toISOString(), session_ok: false, total_posts: 0, error: e.message }
        };
    }
}

// CLI interface
if (require.main === module) {
    const args = process.argv.slice(2);

    if (args.includes('--auth')) {
        launchAuth().then(result => {
            console.log(JSON.stringify(result));
            process.exit(0);
        });
    } else if (args.includes('--check')) {
        checkSession().then(ok => {
            console.log(ok ? '✅ Session is valid' : '❌ Session expired — run --auth');
            process.exit(ok ? 0 : 1);
        });
    } else {
        // Default: scrape all
        scrapeAllCommunities().then(result => {
            console.log(JSON.stringify(result, null, 2));
            process.exit(0);
        });
    }
}

module.exports = { scrapeAllCommunities, checkSession, launchAuth, loadConfig, saveConfig, CONFIG_PATH };
