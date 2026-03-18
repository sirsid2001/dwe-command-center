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
    const catBars = data.categories.map(c => {
        const color = getScoreColor(c.score);
        return `
            <div class="cat-row">
                <span class="cat-name">${c.name}</span>
                <div class="cat-bar-bg">
                    <div class="cat-bar-fill" style="width:${c.score}%; background:${color};"></div>
                </div>
                <span class="cat-score" style="color:${color};">${c.score}</span>
            </div>`;
    }).join('');

    const issuesList = data.issues.map((issue, i) => `
        <div class="item-row issue">
            <div class="item-num">${i + 1}</div>
            <div class="item-text">${issue}</div>
        </div>`).join('');

    const winsList = data.quickWins.map((win, i) => `
        <div class="item-row win">
            <div class="item-num">${i + 1}</div>
            <div class="item-text">${win}</div>
        </div>`).join('');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', -apple-system, sans-serif; color: #1a1a2e; background: #fff; }

    .page { width: 794px; min-height: 1123px; padding: 0; }

    /* Header band */
    .header { background: linear-gradient(135deg, #0a0e27 0%, #1a1e3c 60%, #2d1b69 100%); padding: 48px 56px 40px; color: #fff; position: relative; overflow: hidden; }
    .header::after { content: ''; position: absolute; top: -50%; right: -10%; width: 300px; height: 300px; background: radial-gradient(circle, rgba(255,170,0,0.15) 0%, transparent 70%); border-radius: 50%; }
    .header-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
    .brand { font-size: 13px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #ffaa00; }
    .brand-sub { font-size: 10px; color: rgba(255,255,255,0.5); margin-top: 2px; letter-spacing: 0.08em; }
    .report-type { font-size: 10px; color: rgba(255,255,255,0.4); text-transform: uppercase; letter-spacing: 0.1em; text-align: right; }
    .report-date { font-size: 11px; color: rgba(255,255,255,0.5); text-align: right; margin-top: 4px; }
    .biz-name { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.15; }
    .biz-url { font-size: 12px; color: rgba(255,255,255,0.4); margin-top: 6px; }

    /* Score banner */
    .score-banner { display: flex; align-items: center; gap: 32px; background: #f8f9fc; padding: 28px 56px; border-bottom: 1px solid #e8eaf0; }
    .score-circle { width: 88px; height: 88px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-direction: column; border: 4px solid ${scoreColor}; flex-shrink: 0; }
    .score-num { font-size: 32px; font-weight: 900; color: ${scoreColor}; line-height: 1; }
    .score-max { font-size: 10px; color: #999; margin-top: 2px; }
    .grade-box { padding: 8px 20px; border-radius: 8px; background: ${gradeColor}18; border: 1px solid ${gradeColor}40; }
    .grade-label { font-size: 9px; color: #888; text-transform: uppercase; letter-spacing: 0.1em; }
    .grade-val { font-size: 28px; font-weight: 800; color: ${gradeColor}; line-height: 1.1; }
    .score-summary { flex: 1; font-size: 13px; color: #555; line-height: 1.6; }

    /* Content */
    .content { padding: 36px 56px 48px; }

    .section { margin-bottom: 32px; }
    .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; color: #0a0e27; padding-bottom: 10px; border-bottom: 2px solid #0a0e27; margin-bottom: 18px; display: flex; align-items: center; gap: 8px; }
    .section-icon { font-size: 14px; }

    /* Category bars */
    .cat-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .cat-name { font-size: 12px; font-weight: 500; color: #444; width: 160px; flex-shrink: 0; }
    .cat-bar-bg { flex: 1; height: 10px; background: #f0f1f5; border-radius: 5px; overflow: hidden; }
    .cat-bar-fill { height: 100%; border-radius: 5px; transition: width 0.4s; }
    .cat-score { font-size: 13px; font-weight: 700; width: 30px; text-align: right; flex-shrink: 0; }

    /* Items (issues & wins) */
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
    .item-row { display: flex; gap: 12px; margin-bottom: 14px; align-items: flex-start; }
    .item-num { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; }
    .item-row.issue .item-num { background: #fce4ec; color: #c62828; }
    .item-row.win .item-num { background: #e8f5e9; color: #2e7d32; }
    .item-text { font-size: 12px; line-height: 1.55; color: #444; }

    /* Footer */
    .footer { padding: 24px 56px; background: #f8f9fc; border-top: 1px solid #e8eaf0; display: flex; justify-content: space-between; align-items: center; }
    .footer-left { font-size: 9px; color: #999; }
    .footer-right { font-size: 9px; color: #bbb; }
    .cta-box { background: linear-gradient(135deg, #0a0e27, #1a1e3c); color: #fff; padding: 20px 28px; border-radius: 10px; margin-top: 8px; display: flex; justify-content: space-between; align-items: center; }
    .cta-text { font-size: 14px; font-weight: 600; }
    .cta-sub { font-size: 11px; color: rgba(255,255,255,0.6); margin-top: 4px; }
    .cta-btn { background: #ffaa00; color: #0a0e27; padding: 10px 24px; border-radius: 6px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
</style>
</head>
<body>
<div class="page">
    <!-- Header -->
    <div class="header">
        <div class="header-top">
            <div>
                <div class="brand">The Veterans Consultant</div>
                <div class="brand-sub">Powered by DWE Intelligence</div>
            </div>
            <div>
                <div class="report-type">Marketing Audit Report</div>
                <div class="report-date">${data.date}</div>
            </div>
        </div>
        <div class="biz-name">${data.businessName}</div>
        <div class="biz-url">${data.url}</div>
    </div>

    <!-- Score Banner -->
    <div class="score-banner">
        <div class="score-circle">
            <div class="score-num">${data.score}</div>
            <div class="score-max">/100</div>
        </div>
        <div class="grade-box">
            <div class="grade-label">Grade</div>
            <div class="grade-val">${data.grade}</div>
        </div>
        <div class="score-summary">${data.summary}</div>
    </div>

    <!-- Content -->
    <div class="content">
        <!-- Category Breakdown -->
        <div class="section">
            <div class="section-title">Performance Breakdown</div>
            ${catBars}
        </div>

        <!-- Issues & Quick Wins side by side -->
        <div class="two-col">
            <div class="section">
                <div class="section-title"><span class="section-icon" style="color:#c62828;">&#9888;</span> Critical Issues</div>
                ${issuesList}
            </div>
            <div class="section">
                <div class="section-title"><span class="section-icon" style="color:#2e7d32;">&#10003;</span> Quick Wins</div>
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
