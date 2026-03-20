#!/usr/bin/env node
/**
 * DWE Audit Report — PDF Generator
 * Converts markdown audit reports into professional branded PDFs
 * Usage: node generate-audit-pdf.js <pipeline> <lead-id>
 *   or:  node generate-audit-pdf.js --all <pipeline>
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const AUDITS_DIR = path.join(process.env.HOME, 'openclaw/shared/audits');

function parseAuditMarkdown(md) {
    const data = {};
    // Title
    const titleMatch = md.match(/^# Marketing Audit — (.+)$/m);
    data.businessName = titleMatch ? titleMatch[1].trim() : 'Unknown Business';
    // URL
    const urlMatch = md.match(/\*\*URL:\*\*\s*(.+)$/m);
    data.url = urlMatch ? urlMatch[1].trim() : '';
    // Score & Grade
    const scoreMatch = md.match(/\*\*Score:\*\*\s*(\d+)\/100\s*\(Grade:\s*([A-F][+-]?)\)/);
    data.score = scoreMatch ? parseInt(scoreMatch[1]) : 0;
    data.grade = scoreMatch ? scoreMatch[2] : 'N/A';
    // Date
    const dateMatch = md.match(/\*\*Date:\*\*\s*(.+)$/m);
    data.date = dateMatch ? dateMatch[1].trim() : new Date().toISOString().split('T')[0];
    // Category scores
    data.categories = [];
    const catRegex = /\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|/g;
    let m;
    while ((m = catRegex.exec(md)) !== null) {
        if (m[1].includes('Category') || m[1].includes('---')) continue;
        data.categories.push({ name: m[1].trim(), score: parseInt(m[2]) });
    }
    // Top 3 Issues
    const issuesSection = md.match(/## Top 3 Issues\n([\s\S]*?)(?=\n## )/);
    data.issues = issuesSection ? issuesSection[1].trim().split('\n').filter(l => l.startsWith('-')).map(l => l.replace(/^-\s*/, '')) : [];
    // Top 3 Quick Wins
    const winsSection = md.match(/## Top 3 Quick Wins\n([\s\S]*?)(?=\n## )/);
    data.quickWins = winsSection ? winsSection[1].trim().split('\n').filter(l => l.startsWith('-')).map(l => l.replace(/^-\s*/, '')) : [];
    // Summary
    const summarySection = md.match(/## Summary\n([\s\S]*?)(?=\n## |$)/);
    data.summary = summarySection ? summarySection[1].trim() : '';

    return data;
}

function getScoreColor(score) {
    if (score >= 80) return '#00c853';
    if (score >= 60) return '#ffab00';
    if (score >= 40) return '#ff6d00';
    return '#d50000';
}

function getGradeColor(grade) {
    if (grade.startsWith('A')) return '#00c853';
    if (grade.startsWith('B')) return '#64dd17';
    if (grade.startsWith('C')) return '#ffab00';
    if (grade.startsWith('D')) return '#ff6d00';
    return '#d50000';
}

function buildHTML(data) {
    const scoreColor = getScoreColor(data.score);
    const gradeColor = getGradeColor(data.grade);

    // SVG donut ring parameters
    const radius = 42;
    const circumference = 2 * Math.PI * radius;
    const dashOffset = circumference - (data.score / 100) * circumference;

    const catBars = data.categories.map(c => {
        const color = getScoreColor(c.score);
        return `
            <div class="cat-row">
                <span class="cat-name">${c.name}</span>
                <div class="cat-bar-bg">
                    <div class="cat-bar-fill" style="width:${c.score}%; background: linear-gradient(90deg, ${color}cc, ${color});"></div>
                </div>
                <span class="cat-score" style="color:${color};">${c.score}</span>
            </div>`;
    }).join('');

    const issuesList = data.issues.map((issue, i) => `
        <div class="item-card issue">
            <div class="item-num">${i + 1}</div>
            <div class="item-text">${issue}</div>
        </div>`).join('');

    const winsList = data.quickWins.map((win, i) => `
        <div class="item-card win">
            <div class="item-num">${i + 1}</div>
            <div class="item-text">${win}</div>
        </div>`).join('');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Plus Jakarta Sans', 'Inter', -apple-system, sans-serif; color: #1e293b; background: #fff; -webkit-font-smoothing: antialiased; }

    .page { width: 794px; min-height: 1123px; padding: 0; position: relative; display: flex; flex-direction: column; }

    /* ── Header ── */
    .header {
        background: linear-gradient(145deg, #0f172a 0%, #1e293b 50%, #334155 100%);
        padding: 44px 52px 36px;
        color: #fff;
        position: relative;
        overflow: hidden;
    }
    .header::before {
        content: '';
        position: absolute;
        top: -80px;
        right: -40px;
        width: 280px;
        height: 280px;
        background: radial-gradient(circle, rgba(234,179,8,0.12) 0%, transparent 65%);
        border-radius: 50%;
    }
    .header::after {
        content: '';
        position: absolute;
        bottom: -60px;
        left: 30%;
        width: 200px;
        height: 200px;
        background: radial-gradient(circle, rgba(59,130,246,0.08) 0%, transparent 65%);
        border-radius: 50%;
    }
    .header-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; position: relative; z-index: 1; }
    .brand-block {}
    .brand { font-size: 14px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: #eab308; }
    .brand-sub { font-size: 9.5px; color: rgba(255,255,255,0.4); margin-top: 3px; letter-spacing: 0.06em; font-weight: 400; }
    .report-meta { text-align: right; }
    .report-type { font-size: 9px; color: rgba(255,255,255,0.35); text-transform: uppercase; letter-spacing: 0.12em; font-weight: 600; }
    .report-date { font-size: 11px; color: rgba(255,255,255,0.55); margin-top: 3px; font-weight: 500; }
    .biz-name { font-size: 30px; font-weight: 800; letter-spacing: -0.025em; line-height: 1.15; position: relative; z-index: 1; }
    .biz-url { font-size: 11.5px; color: rgba(255,255,255,0.35); margin-top: 8px; font-weight: 400; position: relative; z-index: 1; }
    .header-accent { position: absolute; bottom: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, #eab308 0%, #f59e0b 40%, transparent 100%); }

    /* ── Score Section ── */
    .score-section {
        display: flex;
        align-items: center;
        gap: 28px;
        padding: 32px 52px;
        background: #fafbfc;
        border-bottom: 1px solid #e2e8f0;
    }
    .score-ring { flex-shrink: 0; position: relative; width: 100px; height: 100px; }
    .score-ring svg { transform: rotate(-90deg); }
    .score-ring-text {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        text-align: center;
    }
    .score-ring-num { font-size: 30px; font-weight: 800; color: ${scoreColor}; line-height: 1; display: block; }
    .score-ring-label { font-size: 9px; color: #94a3b8; font-weight: 500; display: block; margin-top: 1px; }
    .grade-badge {
        padding: 10px 22px;
        border-radius: 12px;
        background: ${gradeColor}0d;
        border: 2px solid ${gradeColor}30;
        text-align: center;
        flex-shrink: 0;
    }
    .grade-label { font-size: 8px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700; }
    .grade-val { font-size: 32px; font-weight: 800; color: ${gradeColor}; line-height: 1.1; margin-top: 2px; }
    .score-summary { flex: 1; font-size: 12.5px; color: #64748b; line-height: 1.7; font-weight: 400; }

    /* ── Content ── */
    .content { padding: 32px 52px 0; flex: 1; }

    .section { margin-bottom: 28px; }
    .section-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 16px;
        padding-bottom: 10px;
        border-bottom: 1.5px solid #e2e8f0;
    }
    .section-icon-wrap {
        width: 26px;
        height: 26px;
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        flex-shrink: 0;
    }
    .section-title {
        font-size: 10.5px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.13em;
        color: #1e293b;
    }

    /* ── Category Bars ── */
    .cat-row { display: flex; align-items: center; gap: 14px; margin-bottom: 11px; }
    .cat-name { font-size: 11.5px; font-weight: 500; color: #475569; width: 150px; flex-shrink: 0; }
    .cat-bar-bg { flex: 1; height: 8px; background: #f1f5f9; border-radius: 4px; overflow: hidden; }
    .cat-bar-fill { height: 100%; border-radius: 4px; }
    .cat-score { font-size: 12.5px; font-weight: 700; width: 32px; text-align: right; flex-shrink: 0; }

    /* ── Two Column Layout ── */
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }

    /* ── Issue/Win Cards ── */
    .item-card {
        display: flex;
        gap: 12px;
        padding: 12px 14px;
        border-radius: 8px;
        margin-bottom: 8px;
        align-items: flex-start;
    }
    .item-card.issue { background: #fef2f2; border: 1px solid #fecaca; }
    .item-card.win { background: #f0fdf4; border: 1px solid #bbf7d0; }
    .item-num {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10.5px;
        font-weight: 700;
        flex-shrink: 0;
    }
    .item-card.issue .item-num { background: #fca5a5; color: #7f1d1d; }
    .item-card.win .item-num { background: #86efac; color: #14532d; }
    .item-text { font-size: 11.5px; line-height: 1.55; color: #475569; font-weight: 400; }

    /* ── CTA ── */
    .cta-box {
        background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
        color: #fff;
        padding: 22px 28px;
        border-radius: 12px;
        margin-top: 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .cta-text { font-size: 15px; font-weight: 700; letter-spacing: -0.01em; }
    .cta-sub { font-size: 11px; color: rgba(255,255,255,0.5); margin-top: 4px; font-weight: 400; }
    .cta-btn {
        background: linear-gradient(135deg, #eab308, #f59e0b);
        color: #0f172a;
        padding: 11px 28px;
        border-radius: 8px;
        font-size: 11.5px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        flex-shrink: 0;
        box-shadow: 0 2px 8px rgba(234,179,8,0.3);
    }

    /* ── Footer ── */
    .footer {
        padding: 18px 52px;
        background: #f8fafc;
        border-top: 1px solid #e2e8f0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: auto;
    }
    .footer-left { font-size: 8.5px; color: #94a3b8; font-weight: 500; }
    .footer-right { font-size: 8.5px; color: #cbd5e1; font-weight: 500; }
</style>
</head>
<body>
<div class="page">
    <!-- Header -->
    <div class="header">
        <div class="header-top">
            <div class="brand-block">
                <div class="brand">The Veterans Consultant</div>
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
            <svg width="100" height="100" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="${radius}" fill="none" stroke="#e2e8f0" stroke-width="6"/>
                <circle cx="50" cy="50" r="${radius}" fill="none" stroke="${scoreColor}" stroke-width="6"
                    stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"
                    stroke-linecap="round"/>
            </svg>
            <div class="score-ring-text">
                <span class="score-ring-num">${data.score}</span>
                <span class="score-ring-label">of 100</span>
            </div>
        </div>
        <div class="grade-badge">
            <div class="grade-label">Grade</div>
            <div class="grade-val">${data.grade}</div>
        </div>
        <div class="score-summary">${data.summary}</div>
    </div>

    <!-- Content -->
    <div class="content">
        <!-- Category Breakdown -->
        <div class="section">
            <div class="section-header">
                <div class="section-icon-wrap" style="background: #eff6ff; color: #3b82f6;">&#9776;</div>
                <div class="section-title">Performance Breakdown</div>
            </div>
            ${catBars}
        </div>

        <!-- Issues & Quick Wins -->
        <div class="two-col">
            <div class="section">
                <div class="section-header">
                    <div class="section-icon-wrap" style="background: #fef2f2; color: #ef4444;">&#9888;</div>
                    <div class="section-title">Critical Issues</div>
                </div>
                ${issuesList}
            </div>
            <div class="section">
                <div class="section-header">
                    <div class="section-icon-wrap" style="background: #f0fdf4; color: #22c55e;">&#10003;</div>
                    <div class="section-title">Quick Wins</div>
                </div>
                ${winsList}
            </div>
        </div>

        <!-- CTA -->
        <div class="cta-box">
            <div>
                <div class="cta-text">Ready to improve your digital presence?</div>
                <div class="cta-sub">Our team can implement these fixes and more — starting this week.</div>
            </div>
            <div class="cta-btn">Get Started</div>
        </div>
    </div>

    <!-- Footer -->
    <div class="footer">
        <div class="footer-left">Confidential — Prepared for ${data.businessName} | The Veterans Consultant by DWE</div>
        <div class="footer-right">Page 1 of 1</div>
    </div>
</div>
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

main().catch(e => { console.error(e); process.exit(1); });
