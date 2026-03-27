#!/usr/bin/env node
/**
 * DWE Audit Report — PDF Generator (v6 — D8 Light Body)
 * Dark header with purple plasma waves, cream/light body
 * Usage: node generate-audit-pdf.js <pipeline> <lead-id>
 *   or:  node generate-audit-pdf.js --all <pipeline>
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const AUDITS_DIR = path.join(process.env.HOME, 'openclaw/shared/audits');

const SECTION_MAP = [
    { name: 'Content & Messaging', icon: '&#9998;', color: '#E8734A',
      factors: ['Headline Clarity', 'Value Proposition', 'Content Depth'] },
    { name: 'Search Visibility', icon: '&#128269;', color: '#7c3aed',
      factors: ['Title Tag', 'Meta Description', 'Header Structure', 'Image Alt Text', 'NAP (Name/Address/Phone)', 'Service Area Targeting', 'Local Trust Signals'] },
    { name: 'Technical Performance', icon: '&#9881;', color: '#0891b2',
      factors: ['Mobile Ready', 'SSL/HTTPS', 'Schema Markup'] },
    { name: 'Conversion Power', icon: '&#9889;', color: '#F5A623',
      factors: ['CTA Quality', 'Contact Methods', 'Trust Near Conversion'] },
    { name: 'Brand & Growth', icon: '&#9650;', color: '#16a34a',
      factors: ['Social Proof', 'Credibility Signals', 'Content Strategy', 'Competitive Differentiation'] }
];

function parseAuditMarkdown(md) {
    const data = {};
    const t = md.match(/^# Marketing Audit — (.+)$/m);
    data.businessName = t ? t[1].trim() : 'Unknown Business';
    const u = md.match(/\*\*URL:\*\*\s*(.+)$/m);
    data.url = u ? u[1].trim() : '';
    const s = md.match(/\*\*Score:\*\*\s*([\d.]+)\/100\s*\(Grade:\s*([A-F][+-]?)\)/);
    data.score = s ? Math.round(parseFloat(s[1])) : 0;
    data.grade = s ? s[2] : 'N/A';
    const d = md.match(/\*\*Date:\*\*\s*(.+)$/m);
    data.date = d ? d[1].trim() : new Date().toISOString().split('T')[0];
    data.factors = [];
    const fs = md.match(/## All 20 Factors[\s\S]*?\n\n/);
    if (fs) { const r = /\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([\d.]+)\/100\s*\|\s*(\d+)%\s*\|/g; let m;
        while ((m = r.exec(fs[0])) !== null) data.factors.push({ name: m[1].trim(), score: Math.round(parseFloat(m[2])), weight: parseInt(m[3]) });
    }
    const iss = md.match(/## Top (?:\d+ )?Issues\n([\s\S]*?)(?=\n## )/);
    data.issues = iss ? iss[1].trim().split('\n').filter(l => l.startsWith('-')).map(l => l.replace(/^-\s*/, '')).slice(0,5) : [];
    const wins = md.match(/## Top (?:\d+ )?Quick Wins\n([\s\S]*?)(?=\n## )/);
    data.quickWins = wins ? wins[1].trim().split('\n').filter(l => l.startsWith('-')).map(l => l.replace(/^-\s*/, '')).slice(0,5) : [];
    const sum = md.match(/## Summary\n([\s\S]*?)(?=\n## |$)/);
    data.summary = sum ? sum[1].trim() : '';
    data.sections = SECTION_MAP.map(sec => {
        const mf = sec.factors.map(fn => data.factors.find(f => f.name === fn) || { name: fn, score: 0, weight: 5 });
        return { name: sec.name, icon: sec.icon, color: sec.color, score: Math.round(mf.reduce((a,f) => a+f.score, 0)/mf.length), factors: mf };
    });
    return data;
}

function sc(score) { return score >= 80 ? '#16a34a' : score >= 60 ? '#ca8a04' : score >= 40 ? '#ea580c' : '#dc2626'; }

const WAVES = `<svg class="hw" viewBox="0 0 794 180" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
<defs><filter id="g"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
<path d="M-30,130 C80,50 200,145 350,65 C500,-5 620,110 794,40" fill="none" stroke="#bb66ff" stroke-width="1.8" filter="url(#g)"/>
<path d="M-20,90 C100,150 240,30 390,110 C540,180 670,50 824,120" fill="none" stroke="#aa55ff" stroke-width="1.5" filter="url(#g)"/>
<path d="M-30,55 C110,120 250,15 400,85 C550,150 680,30 824,95" fill="none" stroke="#cc77ff" stroke-width="2" filter="url(#g)"/>
<path d="M-20,150 C70,75 190,155 340,80 C490,10 610,115 794,50" fill="none" stroke="#9944ee" stroke-width="1.5" filter="url(#g)"/>
<path d="M-30,35 C120,100 260,5 410,80 C560,150 690,25 824,90" fill="none" stroke="#bb55ff" stroke-width="1.8" filter="url(#g)"/>
<path d="M-20,110 C90,40 220,125 370,50 C520,-15 650,90 794,25" fill="none" stroke="#dd88ff" stroke-width="1.3" filter="url(#g)"/>
<circle cx="85" cy="115" r="2.5" fill="#edf" fill-opacity="0.7"/><circle cx="350" cy="70" r="2.5" fill="#fff" fill-opacity="0.6"/>
<circle cx="510" cy="120" r="2" fill="#dbf" fill-opacity="0.6"/><circle cx="640" cy="45" r="3" fill="#edf" fill-opacity="0.55"/>
<circle cx="200" cy="140" r="2" fill="#fff" fill-opacity="0.5"/><circle cx="720" cy="95" r="2" fill="#edf" fill-opacity="0.5"/>
</svg>`;

const WAVES_SM = `<svg class="hw" viewBox="0 0 794 110" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
<defs><filter id="g2"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
<path d="M-20,80 C75,22 185,90 330,38 C475,-8 580,65 794,18" fill="none" stroke="#bb66ff" stroke-width="1.6" filter="url(#g2)"/>
<path d="M-30,50 C95,100 225,18 375,70 C525,118 665,28 824,75" fill="none" stroke="#aa55ff" stroke-width="1.4" filter="url(#g2)"/>
<path d="M-20,25 C100,75 230,2 380,55 C530,105 670,15 824,60" fill="none" stroke="#cc77ff" stroke-width="1.8" filter="url(#g2)"/>
<path d="M-30,95 C65,38 190,98 340,48 C490,-2 610,75 794,28" fill="none" stroke="#9944ee" stroke-width="1.4" filter="url(#g2)"/>
<path d="M-20,12 C115,65 245,-5 395,48 C545,95 678,10 824,55" fill="none" stroke="#bb55ff" stroke-width="1.6" filter="url(#g2)"/>
<circle cx="160" cy="50" r="2" fill="#edf" fill-opacity="0.6"/><circle cx="350" cy="35" r="2.5" fill="#fff" fill-opacity="0.5"/>
<circle cx="520" cy="65" r="2" fill="#dbf" fill-opacity="0.55"/><circle cx="680" cy="22" r="2.5" fill="#edf" fill-opacity="0.5"/>
</svg>`;

function buildPage1(data) {
    const c = sc(data.score), R = 42, CI = 2*Math.PI*R, DO = CI-(data.score/100)*CI;
    const bars = data.sections.map(s => `<div class="cr"><span class="ci" style="color:${s.color}">${s.icon}</span><span class="cn">${s.name}</span><div class="cb"><div class="cf" style="width:${s.score}%;background:${sc(s.score)}"></div></div><span class="cs" style="color:${sc(s.score)}">${s.score}</span></div>`).join('');
    const iss = data.issues.slice(0,3).map((t,i) => `<div class="ic ir"><div class="in">${i+1}</div><div class="it">${t}</div></div>`).join('');
    const win = data.quickWins.slice(0,3).map((t,i) => `<div class="ic iw"><div class="in">${i+1}</div><div class="it">${t}</div></div>`).join('');
    return `<div class="pg">
<div class="hdr">${WAVES}
<div class="ht"><div><div class="logo">The Veterans Consultant<span class="llc">, LLC</span></div><div class="sub">Powered by DWE Intelligence</div></div></div>
<div class="bn">${data.businessName}</div><div class="bu">${data.url}</div>
<div class="meta"><span class="mt">Marketing Audit Report</span><span class="md"> &bull; ${data.date}</span></div><div class="ha"></div></div>
<div class="body">
<div class="score-row">
<div class="ring"><svg width="100" height="100" viewBox="0 0 100 100"><circle cx="50" cy="50" r="${R}" fill="none" stroke="#e5e7eb" stroke-width="6"/><circle cx="50" cy="50" r="${R}" fill="none" stroke="${c}" stroke-width="6" stroke-dasharray="${CI}" stroke-dashoffset="${DO}" stroke-linecap="round" style="transform:rotate(-90deg);transform-origin:center"/></svg><div class="rt"><span class="rn" style="color:${c}">${data.score}</span><span class="rl">of 100</span></div></div>
<div class="grade" style="border-color:${c}"><div class="gl">Grade</div><div class="gv" style="color:${c}">${data.grade}</div></div>
<div class="sum">${data.summary}</div></div>
<div class="sec"><div class="sh">Performance Overview</div>${bars}</div>
<div class="cols"><div class="sec"><div class="sh" style="color:#dc2626">Critical Issues</div>${iss}</div><div class="sec"><div class="sh" style="color:#16a34a">Quick Wins</div>${win}</div></div>
<div class="cta"><div><div class="ct">Ready to improve your digital presence?</div><div class="cst">Click below to see our services and connect with our team — no obligation.</div></div><a href="https://theveteransconsultant.com/services/?utm_source=audit_report&utm_medium=pdf&utm_campaign=${data.pipeline || 'dwe-marketing'}&utm_content=${data.leadId || ''}&utm_term=get_started" class="cb-btn" style="text-decoration:none;color:#111;display:inline-block;">See Our Services &rarr;</a></div>
<div class="trust-row"><span class="trust-badge">theveteransconsultant.com</span><span class="trust-badge">Veteran-Owned</span><span class="trust-badge">No Contracts</span><span class="trust-badge">30-Day Guarantee</span></div>
</div>
<div class="ft"><span>Confidential — Prepared for ${data.businessName} | The Veterans Consultant by DWE</span><span>Page 1 of 2</span></div>
</div>`;
}

function buildPage2(data) {
    const blocks = data.sections.map(s => {
        const rows = s.factors.map(f => `<div class="fr"><span class="fn">${f.name}</span><div class="fb"><div class="ff" style="width:${f.score}%;background:${sc(f.score)}"></div></div><span class="fs" style="color:${sc(f.score)}">${f.score}</span><span class="fw">${f.weight}%</span></div>`).join('');
        return `<div class="ds"><div class="dh"><span class="di" style="color:${s.color}">${s.icon}</span><span class="dt">${s.name}</span><span class="dsc" style="color:${sc(s.score)}">${s.score}<small>/100</small></span></div>${rows}</div>`;
    }).join('');
    return `<div class="pg p2">
<div class="hdr hdr2">${WAVES_SM}
<div class="logo" style="position:relative;z-index:1">The Veterans Consultant<span class="llc">, LLC</span></div>
<div class="p2t">Detailed Factor Analysis</div><div class="p2b">${data.businessName} — ${data.url}</div><div class="ha"></div></div>
<div class="body">${blocks}
<div class="cta" style="margin-top:16px"><div><div class="ct">Let's fix these together.</div><div class="cst">Visit theveteransconsultant.com to learn more — or reply to Jake's email.</div></div><a href="https://theveteransconsultant.com/services/?utm_source=audit_report&utm_medium=pdf&utm_campaign=${data.pipeline || 'dwe-marketing'}&utm_content=${data.leadId || ''}&utm_term=get_started" class="cb-btn" style="text-decoration:none;color:#111;display:inline-block;">See Our Services &rarr;</a></div>
</div>
<div class="ft"><span>Confidential — Prepared for ${data.businessName} | The Veterans Consultant by DWE</span><span>Page 2 of 2</span></div>
</div>`;
}

function buildHTML(data) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Inter:wght@300;400;500;600;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',sans-serif;background:#050814;color:#1B1624;-webkit-font-smoothing:antialiased}
.pg{width:794px;height:1123px;position:relative;display:flex;flex-direction:column;overflow:hidden;page-break-after:always;background:#050814}

/* ═══ HEADER (dark + waves) ═══ */
.hdr{background:linear-gradient(160deg,#08051a,#0c0828 30%,#150a30 60%,#1a0835 80%,#120625);padding:36px 48px 28px;color:#fff;position:relative;overflow:hidden}
.hdr2{padding:22px 48px 18px}
.hw{position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none}
.ht{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;position:relative;z-index:1}
.logo{font-family:'DM Serif Display',serif;font-size:15px;color:#fff;position:relative;z-index:1}
.acc{color:#F5A623}.llc{font-size:0.4em;opacity:0.7;letter-spacing:0.08em}
.sub{font-size:9px;color:#8B90A8;margin-top:3px;letter-spacing:0.08em;position:relative;z-index:1}
.meta{position:relative;z-index:1;margin-top:10px}
.mt{font-size:9px;color:#8B90A8;text-transform:uppercase;letter-spacing:0.14em;font-weight:600}
.md{font-size:9px;color:#8B90A8;letter-spacing:0.05em}
.bn{font-family:'DM Serif Display',serif;font-size:28px;line-height:1.15;position:relative;z-index:1}
.bu{font-size:11px;color:#8B90A8;margin-top:5px;position:relative;z-index:1}
.ha{position:absolute;bottom:0;left:0;right:0;height:4px;background:linear-gradient(90deg,#E8734A,#F5A623,#F5D623,#4AE88A,#00dcff,#7B61FF,#cc00ff);box-shadow:0 0 12px rgba(0,220,255,0.3),0 0 24px rgba(204,0,255,0.15)}
.p2t{font-family:'DM Serif Display',serif;font-size:19px;margin-top:10px;position:relative;z-index:1}
.p2b{font-size:10px;color:#8B90A8;margin-top:3px;position:relative;z-index:1}

/* ═══ BODY (cream/light) ═══ */
.body{padding:24px 48px;flex:1;background:#FAF7F2}
.p2 .body{background:linear-gradient(180deg,#050814 0%,#0d0a1f 30%,#1a0e2e 50%,#0d0a1f 70%,#050814 100%)}

/* Score row */
.score-row{display:flex;align-items:center;gap:22px;margin-bottom:0;padding:20px 24px;background:#0a0e1a;border-bottom:1px solid #1a1f35;border-radius:0;margin:-24px -48px 24px;padding:24px 48px}
.ring{flex-shrink:0;position:relative;width:100px;height:100px}
.ring svg circle:first-child{stroke:#1a1f35}
.rt{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center}
.rn{font-family:'DM Serif Display',serif;font-size:30px;line-height:1;display:block}
.rl{font-size:9px;color:#8B90A8;display:block;margin-top:1px}
.grade{padding:8px 18px;border-radius:12px;border:2px solid;text-align:center;flex-shrink:0;background:transparent}
.gl{font-size:8px;color:#8B90A8;text-transform:uppercase;letter-spacing:0.12em;font-weight:700}
.gv{font-family:'DM Serif Display',serif;font-size:32px;line-height:1.1;margin-top:2px}
.sum{flex:1;font-size:12px;color:#8B90A8;line-height:1.75}

/* Section bars */
.sec{margin-bottom:18px}
.sh{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.13em;color:#1B1624;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #E8E3DC}
.cr{display:flex;align-items:center;gap:10px;margin-bottom:9px}
.ci{font-size:13px;width:18px;text-align:center;flex-shrink:0}
.cn{font-size:11px;font-weight:500;color:#5A5A6E;width:140px;flex-shrink:0}
.cb{flex:1;height:7px;background:#E8E3DC;border-radius:4px;overflow:hidden}
.cf{height:100%;border-radius:4px}
.cs{font-size:12px;font-weight:700;width:30px;text-align:right;flex-shrink:0}

/* Issues / Wins */
.cols{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.ic{display:flex;gap:10px;padding:10px 12px;border-radius:10px;margin-bottom:6px;align-items:flex-start}
.ir{background:#fef2f2;border:1px solid #fecaca}
.iw{background:#f0fdf4;border:1px solid #bbf7d0}
.in{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0}
.ir .in{background:#fca5a5;color:#7f1d1d}
.iw .in{background:#86efac;color:#14532d}
.it{font-size:10.5px;line-height:1.5;color:#5A5A6E}

/* CTA */
.cta{background:linear-gradient(135deg,#0f172a,#1e293b);color:#fff;padding:18px 24px;border-radius:14px;margin-top:10px;display:flex;justify-content:space-between;align-items:center}
.ct{font-family:'DM Serif Display',serif;font-size:15px}
.cst{font-size:10.5px;color:#94a3b8;margin-top:3px}
.cb-btn{background:#F5A623;color:#111;padding:10px 24px;border-radius:9999px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;flex-shrink:0;box-shadow:0 4px 15px rgba(245,166,35,0.25);cursor:pointer;transition:all 0.2s}
.cb-btn:hover{background:#FFB83D;box-shadow:0 6px 20px rgba(245,166,35,0.4);transform:translateY(-1px)}
.trust-row{display:flex;gap:8px;margin-top:10px;justify-content:center;flex-wrap:wrap}
.trust-badge{font-size:8.5px;color:#94a3b8;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:4px;padding:3px 8px;letter-spacing:0.02em}

/* Footer */
.ft{padding:12px 48px;background:#050814;border-top:1px solid #1a1f35;display:flex;justify-content:space-between;font-size:8px;color:#5a6080;margin-top:auto}

/* ═══ PAGE 2 — Factor Detail ═══ */
.ds{background:rgba(5,8,25,0.75);border:1px solid rgba(200,200,200,0.18);border-radius:12px;padding:14px 18px;margin-bottom:12px;box-shadow:0 0 0 1px rgba(200,200,200,0.08),0 4px 24px rgba(0,0,0,0.4)}
.dh{display:flex;align-items:center;gap:10px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.1)}
.di{font-size:15px;flex-shrink:0}
.dt{font-family:'DM Serif Display',serif;font-size:13px;color:#fff;flex:1}
.dsc{font-family:'DM Serif Display',serif;font-size:20px}
.dsc small{font-size:10px;color:#8B90A8}
.fr{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.fn{font-size:10.5px;font-weight:500;color:rgba(255,255,255,0.65);width:165px;flex-shrink:0}
.fb{flex:1;height:5px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden}
.ff{height:100%;border-radius:3px}
.fs{font-size:11px;font-weight:700;width:28px;text-align:right;flex-shrink:0}
.fw{font-size:9px;color:#8B90A8;width:24px;text-align:right;flex-shrink:0}
</style></head><body>
${buildPage1(data)}
${buildPage2(data)}
</body></html>`;
}

async function generatePDF(pipeline, leadId) {
    const auditPath = path.join(AUDITS_DIR, pipeline, leadId, 'AUDIT-SUMMARY.md');
    if (!fs.existsSync(auditPath)) { console.error('No audit found: ' + auditPath); return null; }
    const md = require('fs').readFileSync(auditPath, 'utf8');
    const data = parseAuditMarkdown(md);
    data.leadId = leadId;
    data.pipeline = pipeline;
    const html = buildHTML(data);
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfPath = path.join(AUDITS_DIR, pipeline, leadId, 'AUDIT-REPORT.pdf');
    await page.pdf({ path: pdfPath, width: '794px', height: '1123px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    await browser.close();
    console.log('PDF generated: ' + pdfPath);
    return pdfPath;
}

async function main() {
    const args = process.argv.slice(2);
    if (args[0] === '--all' && args[1]) {
        const pipeline = args[1];
        const dir = path.join(AUDITS_DIR, pipeline);
        if (!fs.existsSync(dir)) { console.error('Pipeline not found'); process.exit(1); }
        for (const lead of fs.readdirSync(dir).filter(d => d.startsWith('PP-'))) {
            if (fs.existsSync(path.join(dir, lead, 'AUDIT-SUMMARY.md'))) await generatePDF(pipeline, lead);
        }
    } else if (args.length === 2) { await generatePDF(args[0], args[1]); }
    else { console.log('Usage: node generate-audit-pdf.js <pipeline> <lead-id>\n       node generate-audit-pdf.js --all <pipeline>'); }
}
main().catch(e => { console.error(e); process.exit(1); });
