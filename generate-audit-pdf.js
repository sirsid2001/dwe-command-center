#!/usr/bin/env node
/**
 * DWE Audit Report — PDF Generator (D6 Design)
 * Converts markdown audit reports into branded 2-page PDFs
 * Style: D6 glassmorphism (dark theme, DM Serif Display + Inter, gold/cyan accents)
 * Usage: node generate-audit-pdf.js <pipeline> <lead-id>
 *   or:  node generate-audit-pdf.js --all <pipeline>
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const AUDITS_DIR = path.join(process.env.HOME, 'openclaw/shared/audits');

// 5-section mapping: consolidate 7 audit categories → 5 presentation sections
const SECTION_MAP = [
    {
        name: 'Content & Messaging',
        icon: '&#9998;',  // pencil
        color: '#E8734A', // coral
        factors: ['Headline Clarity', 'Value Proposition', 'Content Depth'],
        sourceCategories: ['Content & Messaging']
    },
    {
        name: 'Search Visibility',
        icon: '&#128269;', // magnifying glass
        color: '#00dcff',  // cyan
        factors: ['Title Tag', 'Meta Description', 'Header Structure', 'Image Alt Text', 'NAP (Name/Address/Phone)', 'Service Area Targeting', 'Local Trust Signals'],
        sourceCategories: ['SEO Foundations', 'Local SEO']
    },
    {
        name: 'Technical Performance',
        icon: '&#9881;',  // gear
        color: '#cc00ff',  // purple
        factors: ['Mobile Ready', 'SSL/HTTPS', 'Schema Markup'],
        sourceCategories: ['Technical Health']
    },
    {
        name: 'Conversion Power',
        icon: '&#9889;',  // lightning
        color: '#D4A853',  // gold
        factors: ['CTA Quality', 'Contact Methods', 'Trust Near Conversion'],
        sourceCategories: ['Conversion Optimization']
    },
    {
        name: 'Brand & Growth',
        icon: '&#9650;',  // triangle up
        color: '#22c55e',  // green
        factors: ['Social Proof', 'Credibility Signals', 'Content Strategy', 'Competitive Differentiation'],
        sourceCategories: ['Brand & Authority', 'Growth Readiness']
    }
];

function parseAuditMarkdown(md) {
    const data = {};

    // Title
    const titleMatch = md.match(/^# Marketing Audit — (.+)$/m);
    data.businessName = titleMatch ? titleMatch[1].trim() : 'Unknown Business';

    // URL
    const urlMatch = md.match(/\*\*URL:\*\*\s*(.+)$/m);
    data.url = urlMatch ? urlMatch[1].trim() : '';

    // Score & Grade (supports decimals like 41.3/100)
    const scoreMatch = md.match(/\*\*Score:\*\*\s*([\d.]+)\/100\s*\(Grade:\s*([A-F][+-]?)\)/);
    data.score = scoreMatch ? Math.round(parseFloat(scoreMatch[1])) : 0;
    data.grade = scoreMatch ? scoreMatch[2] : 'N/A';

    // Date
    const dateMatch = md.match(/\*\*Date:\*\*\s*(.+)$/m);
    data.date = dateMatch ? dateMatch[1].trim() : new Date().toISOString().split('T')[0];

    // Category scores (handles "30.0/100" format)
    data.categories = [];
    const catSection = md.match(/## Category Summary[\s\S]*?\|[\s\S]*?\n\n/);
    if (catSection) {
        const catRegex = /\|\s*([^|]+?)\s*\|\s*([\d.]+)\/100\s*\|/g;
        let m;
        while ((m = catRegex.exec(catSection[0])) !== null) {
            const name = m[1].trim();
            if (name.includes('Category') || name.includes('---')) continue;
            data.categories.push({ name, score: Math.round(parseFloat(m[2])) });
        }
    }

    // Individual factor scores from "All 20 Factors" table
    data.factors = [];
    const factorSection = md.match(/## All 20 Factors[\s\S]*?\n\n/);
    if (factorSection) {
        const factorRegex = /\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([\d.]+)\/100\s*\|\s*(\d+)%\s*\|/g;
        let m;
        while ((m = factorRegex.exec(factorSection[0])) !== null) {
            data.factors.push({
                name: m[1].trim(),
                score: Math.round(parseFloat(m[2])),
                weight: parseInt(m[3])
            });
        }
    }

    // Top Issues
    const issuesSection = md.match(/## Top (?:\d+ )?Issues\n([\s\S]*?)(?=\n## )/);
    data.issues = issuesSection ? issuesSection[1].trim().split('\n').filter(l => l.startsWith('-')).map(l => l.replace(/^-\s*/, '')).slice(0, 5) : [];

    // Top Quick Wins
    const winsSection = md.match(/## Top (?:\d+ )?Quick Wins\n([\s\S]*?)(?=\n## )/);
    data.quickWins = winsSection ? winsSection[1].trim().split('\n').filter(l => l.startsWith('-')).map(l => l.replace(/^-\s*/, '')).slice(0, 5) : [];

    // Summary
    const summarySection = md.match(/## Summary\n([\s\S]*?)(?=\n## |$)/);
    data.summary = summarySection ? summarySection[1].trim() : '';

    // Build 5-section structure with factors
    data.sections = SECTION_MAP.map(sec => {
        const matchedFactors = sec.factors.map(fname => {
            const found = data.factors.find(f => f.name === fname);
            return found || { name: fname, score: 0, weight: 5 };
        });
        const avgScore = matchedFactors.length > 0
            ? Math.round(matchedFactors.reduce((sum, f) => sum + f.score, 0) / matchedFactors.length)
            : 0;
        return {
            name: sec.name,
            icon: sec.icon,
            color: sec.color,
            score: avgScore,
            factors: matchedFactors
        };
    });

    return data;
}

function getScoreColor(score) {
    if (score >= 80) return '#22c55e';
    if (score >= 60) return '#D4A853';
    if (score >= 40) return '#E8734A';
    return '#ef4444';
}

function buildPage1(data) {
    const scoreColor = getScoreColor(data.score);

    // SVG donut ring
    const radius = 42;
    const circumference = 2 * Math.PI * radius;
    const dashOffset = circumference - (data.score / 100) * circumference;

    // Section bars for page 1
    const sectionBars = data.sections.map(s => {
        const barColor = getScoreColor(s.score);
        return `
            <div class="cat-row">
                <span class="cat-icon" style="color:${s.color};">${s.icon}</span>
                <span class="cat-name">${s.name}</span>
                <div class="cat-bar-bg">
                    <div class="cat-bar-fill" style="width:${s.score}%; background: linear-gradient(90deg, ${barColor}99, ${barColor});"></div>
                </div>
                <span class="cat-score" style="color:${barColor};">${s.score}</span>
            </div>`;
    }).join('');

    // Issues (max 3 on page 1)
    const issuesList = data.issues.slice(0, 3).map((issue, i) => `
        <div class="item-card issue">
            <div class="item-num">${i + 1}</div>
            <div class="item-text">${issue}</div>
        </div>`).join('');

    // Quick wins (max 3 on page 1)
    const winsList = data.quickWins.slice(0, 3).map((win, i) => `
        <div class="item-card win">
            <div class="item-num">${i + 1}</div>
            <div class="item-text">${win}</div>
        </div>`).join('');

    return `
    <div class="page">
        <!-- Simulated shader background -->
        <div class="shader-bg"></div>

        <!-- Header -->
        <div class="header">
            <div class="header-glow glow-gold"></div>
            <div class="header-glow glow-cyan"></div>
            <div class="header-top">
                <div class="brand-block">
                    <div class="brand">The Veterans<span class="accent">.</span> Consultant<span class="llc">, LLC</span></div>
                    <div class="brand-sub">Powered by DWE Intelligence</div>
                </div>
                <div class="report-meta">
                    <div class="report-type">Marketing Audit Report</div>
                    <div class="report-date">${data.date}</div>
                </div>
            </div>
            <div class="biz-name">${data.businessName}</div>
            <div class="biz-url">${data.url}</div>
            <div class="header-accent"></div>
        </div>

        <!-- Score Section -->
        <div class="score-section">
            <div class="score-ring">
                <svg width="110" height="110" viewBox="0 0 110 110">
                    <circle cx="55" cy="55" r="${radius}" fill="none" stroke="#1a1f35" stroke-width="7"/>
                    <circle cx="55" cy="55" r="${radius}" fill="none" stroke="${scoreColor}" stroke-width="7"
                        stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"
                        stroke-linecap="round" filter="url(#glow)"/>
                    <defs>
                        <filter id="glow"><feGaussianBlur stdDeviation="3" result="blur"/>
                            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
                        </filter>
                    </defs>
                </svg>
                <div class="score-ring-text">
                    <span class="score-ring-num" style="color:${scoreColor};">${data.score}</span>
                    <span class="score-ring-label">of 100</span>
                </div>
            </div>
            <div class="grade-badge" style="border-color:${scoreColor}40; background:${scoreColor}12;">
                <div class="grade-label">Grade</div>
                <div class="grade-val" style="color:${scoreColor};">${data.grade}</div>
            </div>
            <div class="score-summary">${data.summary}</div>
        </div>

        <!-- Content area -->
        <div class="content">
            <!-- Section Performance -->
            <div class="section">
                <div class="section-header">
                    <div class="section-icon-wrap" style="background:#081822; border:1px solid #0f2838; color:#00dcff;">&#9776;</div>
                    <div class="section-title">Performance Overview</div>
                </div>
                ${sectionBars}
            </div>

            <!-- Issues & Quick Wins -->
            <div class="two-col">
                <div class="section">
                    <div class="section-header">
                        <div class="section-icon-wrap" style="background:#220e0e; border:1px solid #3d1515; color:#ef4444;">&#9888;</div>
                        <div class="section-title">Critical Issues</div>
                    </div>
                    ${issuesList}
                </div>
                <div class="section">
                    <div class="section-header">
                        <div class="section-icon-wrap" style="background:#0c1a10; border:1px solid #153d1e; color:#22c55e;">&#10003;</div>
                        <div class="section-title">Quick Wins</div>
                    </div>
                    ${winsList}
                </div>
            </div>

            <!-- CTA -->
            <div class="cta-box">
                <div>
                    <div class="cta-text">Ready to improve your digital presence?</div>
                    <div class="cta-sub-text">Our team can implement these fixes and more — starting this week.</div>
                </div>
                <div class="cta-btn">Get Started</div>
            </div>
        </div>

        <!-- Footer -->
        <div class="footer">
            <div class="footer-left">Confidential — Prepared for ${data.businessName} | The Veterans Consultant by DWE</div>
            <div class="footer-right">Page 1 of 2</div>
        </div>
    </div>`;
}

function buildPage2(data) {
    // Build factor detail sections
    const sectionBlocks = data.sections.map(sec => {
        const factorRows = sec.factors.map(f => {
            const color = getScoreColor(f.score);
            return `
                <div class="factor-row">
                    <span class="factor-name">${f.name}</span>
                    <div class="factor-bar-bg">
                        <div class="factor-bar-fill" style="width:${f.score}%; background: linear-gradient(90deg, ${color}88, ${color});"></div>
                    </div>
                    <span class="factor-score" style="color:${color};">${f.score}</span>
                    <span class="factor-weight">${f.weight}%</span>
                </div>`;
        }).join('');

        const secColor = getScoreColor(sec.score);
        return `
            <div class="detail-section">
                <div class="detail-header">
                    <div class="detail-icon" style="color:${sec.color};">${sec.icon}</div>
                    <div class="detail-title">${sec.name}</div>
                    <div class="detail-score" style="color:${secColor};">${sec.score}<span class="detail-max">/100</span></div>
                </div>
                <div class="factor-list">
                    ${factorRows}
                </div>
            </div>`;
    }).join('');

    return `
    <div class="page page2">
        <div class="shader-bg"></div>

        <!-- Page 2 Header (compact) -->
        <div class="p2-header">
            <div class="header-glow glow-gold"></div>
            <div class="brand-block">
                <div class="brand">The Veterans<span class="accent">.</span> Consultant<span class="llc">, LLC</span></div>
            </div>
            <div class="p2-title">Detailed Factor Analysis</div>
            <div class="p2-biz">${data.businessName} — ${data.url}</div>
            <div class="header-accent"></div>
        </div>

        <!-- Factor Sections -->
        <div class="p2-content">
            ${sectionBlocks}
        </div>

        <!-- Footer -->
        <div class="footer">
            <div class="footer-left">Confidential — Prepared for ${data.businessName} | The Veterans Consultant by DWE</div>
            <div class="footer-right">Page 2 of 2</div>
        </div>
    </div>`;
}

function buildHTML(data) {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Inter:wght@300;400;500;600;700;800&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: 'Inter', -apple-system, sans-serif;
        background: #050814;
        color: #e2e8f0;
        -webkit-font-smoothing: antialiased;
    }

    .page {
        width: 794px;
        height: 1123px;
        position: relative;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        page-break-after: always;
    }

    /* ── Simulated shader background ── */
    .shader-bg {
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        background:
            radial-gradient(ellipse at 20% 50%, rgba(204,0,255,0.06) 0%, transparent 50%),
            radial-gradient(ellipse at 80% 30%, rgba(0,220,255,0.05) 0%, transparent 50%),
            radial-gradient(ellipse at 50% 80%, rgba(212,168,83,0.04) 0%, transparent 50%),
            linear-gradient(180deg, #050814 0%, #0a0e1a 50%, #050814 100%);
        z-index: 0;
    }

    /* ── Header (D6 style) ── */
    .header {
        background: linear-gradient(145deg, #050814 0%, #0c1024 100%);
        padding: 38px 48px 30px;
        color: #fff;
        position: relative;
        z-index: 1;
        border-bottom: 1px solid #1a1f35;
    }
    .header-glow {
        position: absolute;
        border-radius: 50%;
        pointer-events: none;
    }
    .glow-gold {
        top: -60px; right: -20px;
        width: 220px; height: 220px;
        background: radial-gradient(circle, #1f1a0e 0%, transparent 65%);
    }
    .glow-cyan {
        bottom: -40px; left: 30%;
        width: 180px; height: 180px;
        background: radial-gradient(circle, #081218 0%, transparent 65%);
    }
    .header-top {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 22px;
        position: relative;
        z-index: 1;
    }
    .brand {
        font-family: 'DM Serif Display', serif;
        font-size: 15px;
        color: #fff;
        letter-spacing: 0.02em;
    }
    .brand .accent { color: #D4A853; }
    .brand .llc { font-size: 0.4em; opacity: 0.7; letter-spacing: 0.08em; }
    .brand-sub {
        font-size: 9px;
        color: #5a6080;
        margin-top: 3px;
        letter-spacing: 0.08em;
        font-weight: 400;
    }
    .report-meta { text-align: right; }
    .report-type {
        font-size: 9px;
        color: #4a5070;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        font-weight: 600;
    }
    .report-date {
        font-size: 11px;
        color: #7a80a0;
        margin-top: 3px;
        font-weight: 500;
    }
    .biz-name {
        font-family: 'DM Serif Display', serif;
        font-size: 28px;
        letter-spacing: -0.01em;
        line-height: 1.15;
        position: relative;
        z-index: 1;
        color: #fff;
    }
    .biz-url {
        font-size: 11px;
        color: #5a6080;
        margin-top: 6px;
        font-weight: 400;
        position: relative;
        z-index: 1;
    }
    .header-accent {
        position: absolute;
        bottom: 0; left: 0; right: 0;
        height: 3px;
        background: linear-gradient(90deg, #D4A853 0%, #00dcff 50%, transparent 100%);
    }

    /* ── Score Section ── */
    .score-section {
        display: flex;
        align-items: center;
        gap: 24px;
        padding: 28px 48px;
        background: #0c1024;
        border-bottom: 1px solid #1a1f35;
        position: relative;
        z-index: 1;
    }
    .score-ring { flex-shrink: 0; position: relative; width: 110px; height: 110px; }
    .score-ring svg { transform: rotate(-90deg); }
    .score-ring-text {
        position: absolute;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        text-align: center;
    }
    .score-ring-num {
        font-family: 'DM Serif Display', serif;
        font-size: 32px;
        line-height: 1;
        display: block;
    }
    .score-ring-label { font-size: 9px; color: #8B90A8; font-weight: 500; display: block; margin-top: 2px; }
    .grade-badge {
        padding: 10px 20px;
        border-radius: 14px;
        border: 2px solid;
        text-align: center;
        flex-shrink: 0;
    }
    .grade-label { font-size: 8px; color: #8B90A8; text-transform: uppercase; letter-spacing: 0.14em; font-weight: 700; }
    .grade-val {
        font-family: 'DM Serif Display', serif;
        font-size: 34px;
        line-height: 1.1;
        margin-top: 2px;
    }
    .score-summary {
        flex: 1;
        font-size: 12px;
        color: #8B90A8;
        line-height: 1.75;
        font-weight: 400;
    }

    /* ── Content ── */
    .content { padding: 24px 48px 0; flex: 1; position: relative; z-index: 1; background: #080c18; }

    .section { margin-bottom: 22px; }
    .section-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 14px;
        padding-bottom: 8px;
        border-bottom: 1px solid #1a1f35;
    }
    .section-icon-wrap {
        width: 24px; height: 24px;
        border-radius: 7px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        flex-shrink: 0;
    }
    .section-title {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        color: #e2e8f0;
    }

    /* ── Category bars (page 1 — 5 sections) ── */
    .cat-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .cat-icon { font-size: 13px; width: 18px; text-align: center; flex-shrink: 0; }
    .cat-name { font-size: 11px; font-weight: 500; color: #8B90A8; width: 140px; flex-shrink: 0; }
    .cat-bar-bg { flex: 1; height: 7px; background: #141830; border-radius: 4px; overflow: hidden; }
    .cat-bar-fill { height: 100%; border-radius: 4px; }
    .cat-score { font-size: 12px; font-weight: 700; width: 30px; text-align: right; flex-shrink: 0; }

    /* ── Two Column ── */
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }

    /* ── Issue/Win Cards (glass) ── */
    .item-card {
        display: flex;
        gap: 10px;
        padding: 10px 12px;
        border-radius: 10px;
        margin-bottom: 7px;
        align-items: flex-start;
    }
    .item-card.issue {
        background: #1a0f0f;
        border: 1px solid #3d1515;
    }
    .item-card.win {
        background: #0c1a10;
        border: 1px solid #153d1e;
    }
    .item-num {
        width: 20px; height: 20px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        font-weight: 700;
        flex-shrink: 0;
    }
    .item-card.issue .item-num { background: #4a1c1c; color: #fca5a5; }
    .item-card.win .item-num { background: #14462a; color: #86efac; }
    .item-text { font-size: 10.5px; line-height: 1.5; color: #a0a8c0; font-weight: 400; }

    /* ── CTA Box (D6 style) ── */
    .cta-box {
        background: linear-gradient(135deg, #0e1328 0%, #151c38 100%);
        border: 1px solid #3a2e15;
        color: #fff;
        padding: 20px 24px;
        border-radius: 16px;
        margin-top: 10px;
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .cta-text {
        font-family: 'DM Serif Display', serif;
        font-size: 15px;
        letter-spacing: -0.01em;
    }
    .cta-sub-text { font-size: 10.5px; color: #6b7394; margin-top: 4px; font-weight: 400; }
    .cta-btn {
        background: linear-gradient(135deg, #D4A853, #E0B65E);
        color: #050814;
        padding: 10px 26px;
        border-radius: 9999px;
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        flex-shrink: 0;
        box-shadow: 0 4px 20px rgba(212,168,83,0.25);
    }

    /* ── Footer ── */
    .footer {
        padding: 14px 48px;
        background: #050814;
        border-top: 1px solid #1a1f35;
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: auto;
        position: relative;
        z-index: 1;
    }
    .footer-left { font-size: 8px; color: #8B90A8; font-weight: 500; }
    .footer-right { font-size: 8px; color: #3a4060; font-weight: 500; }

    /* ════════════════════════════════════════════════
       PAGE 2 — Detailed Factor Breakdown
       ════════════════════════════════════════════════ */
    .page2 { }

    .p2-header {
        background: linear-gradient(145deg, #050814 0%, #0c1024 100%);
        padding: 24px 48px 20px;
        position: relative;
        z-index: 1;
        border-bottom: 1px solid #1a1f35;
    }
    .p2-title {
        font-family: 'DM Serif Display', serif;
        font-size: 20px;
        color: #fff;
        margin-top: 12px;
        letter-spacing: -0.01em;
    }
    .p2-biz {
        font-size: 10.5px;
        color: #5a6080;
        margin-top: 4px;
        font-weight: 400;
    }

    .p2-content {
        padding: 20px 48px;
        flex: 1;
        position: relative;
        z-index: 1;
        background: #080c18;
    }

    /* ── Detail sections (dark cards) ── */
    .detail-section {
        background: #0c1024;
        border: 1px solid #1a1f35;
        border-radius: 14px;
        padding: 16px 20px;
        margin-bottom: 14px;
    }
    .detail-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 12px;
        padding-bottom: 10px;
        border-bottom: 1px solid #141830;
    }
    .detail-icon { font-size: 16px; flex-shrink: 0; }
    .detail-title {
        font-family: 'DM Serif Display', serif;
        font-size: 14px;
        color: #fff;
        flex: 1;
    }
    .detail-score {
        font-family: 'DM Serif Display', serif;
        font-size: 22px;
        font-weight: 400;
    }
    .detail-max { font-size: 11px; color: #8B90A8; }

    .factor-list { }
    .factor-row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 7px;
    }
    .factor-name { font-size: 10.5px; font-weight: 500; color: #8B90A8; width: 165px; flex-shrink: 0; }
    .factor-bar-bg { flex: 1; height: 5px; background: #141830; border-radius: 3px; overflow: hidden; }
    .factor-bar-fill { height: 100%; border-radius: 3px; }
    .factor-score { font-size: 11px; font-weight: 700; width: 28px; text-align: right; flex-shrink: 0; }
    .factor-weight { font-size: 9px; color: #8B90A8; width: 24px; text-align: right; flex-shrink: 0; }

</style>
</head>
<body>
${buildPage1(data)}
${buildPage2(data)}
</body>
</html>`;
}

async function generatePDF(pipeline, leadId) {
    const auditPath = path.join(AUDITS_DIR, pipeline, leadId, 'AUDIT-SUMMARY.md');
    if (!fs.existsSync(auditPath)) {
        console.error(`No audit found: ${auditPath}`);
        return null;
    }

    const md = fs.readFileSync(auditPath, 'utf8');
    const data = parseAuditMarkdown(md);
    const html = buildHTML(data);

    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdfPath = path.join(AUDITS_DIR, pipeline, leadId, 'AUDIT-REPORT.pdf');
    await page.pdf({
        path: pdfPath,
        width: '794px',
        height: '1123px',
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });

    await browser.close();
    console.log(`PDF generated: ${pdfPath}`);
    return pdfPath;
}

async function main() {
    const args = process.argv.slice(2);
    if (args[0] === '--all' && args[1]) {
        const pipeline = args[1];
        const pipelineDir = path.join(AUDITS_DIR, pipeline);
        if (!fs.existsSync(pipelineDir)) { console.error('Pipeline not found'); process.exit(1); }
        const leads = fs.readdirSync(pipelineDir).filter(d => d.startsWith('PP-'));
        for (const lead of leads) {
            const auditFile = path.join(pipelineDir, lead, 'AUDIT-SUMMARY.md');
            if (fs.existsSync(auditFile)) await generatePDF(pipeline, lead);
        }
    } else if (args.length === 2) {
        await generatePDF(args[0], args[1]);
    } else {
        console.log('Usage: node generate-audit-pdf.js <pipeline> <lead-id>');
        console.log('       node generate-audit-pdf.js --all <pipeline>');
    }
}

main().catch(e => { console.error(e); process.exit(1);  });
