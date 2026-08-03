#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceName = '2026-07-30-001-feat-transcript-library-program.md';
const outputName = sourceName.replace(/\.md$/, '.html');
const sourcePath = path.join(repoDir, 'docs', 'plans', sourceName);
const outputPath = path.join(repoDir, 'docs', 'plans', outputName);

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function slug(value) {
  return value.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function renderInline(value) {
  const input = String(value);
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|\b[USO]\d+\b)/g;
  let html = '';
  let offset = 0;
  for (const match of input.matchAll(pattern)) {
    html += escapeHtml(input.slice(offset, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      html += `<code class="inline-code">${escapeHtml(token.slice(1, -1))}</code>`;
    } else if (token.startsWith('**')) {
      html += `<strong>${renderInline(token.slice(2, -2))}</strong>`;
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      html += `<a href="${escapeHtml(link[2])}">${escapeHtml(link[1])}</a>`;
    } else {
      html += `<button class="trace-token" data-token="${token}">${token}</button>`;
    }
    offset = match.index + token.length;
  }
  return html + escapeHtml(input.slice(offset));
}

function renderCodeLine(line, language) {
  const kind = language === 'diff'
    ? line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : line.startsWith('~') ? 'change' : 'context'
    : 'context';
  const escaped = escapeHtml(line || ' ')
    .replace(/\b([USO]\d+)\b/g, '<button class="trace-token" data-token="$1">$1</button>');
  return `<span class="diff-line ${kind}">${line ? escaped : '&nbsp;'}</span>`;
}

function stripFrontmatter(lines) {
  if (lines[0]?.trim() !== '---') return lines;
  const end = lines.slice(1).findIndex((line) => line.trim() === '---');
  return end < 0 ? lines : lines.slice(end + 2);
}

function renderMarkdown(markdown) {
  const lines = stripFrontmatter(markdown.replace(/\r\n?/g, '\n').split('\n'));
  const html = [];
  const sections = [];
  let paragraph = [];
  let list = [];
  let code = null;
  let table = [];
  let sectionOpen = false;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    html.push(`<ul>${list.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
    list = [];
  };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
    const header = rows[0];
    const body = rows.slice(2);
    html.push('<div class="table-wrap"><table><thead><tr>');
    html.push(header.map((cell) => `<th>${renderInline(cell)}</th>`).join(''));
    html.push('</tr></thead><tbody>');
    for (const row of body) html.push(`<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`);
    html.push('</tbody></table></div>');
    table = [];
  };
  const flushBlocks = () => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (const line of lines) {
    if (code) {
      if (line.startsWith('```')) {
        html.push(`<pre class="code-block ${escapeHtml(code.language)}"><code>${code.lines.map((entry) => renderCodeLine(entry, code.language)).join('')}</code></pre>`);
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    const fence = /^```([^\s]*)/.exec(line);
    if (fence) {
      flushBlocks();
      code = { language: fence[1] || 'text', lines: [] };
      continue;
    }
    if (line.trim().startsWith('|')) {
      flushParagraph();
      flushList();
      table.push(line);
      continue;
    }
    if (table.length) flushTable();
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushBlocks();
      const level = heading[1].length;
      const title = heading[2].trim();
      const id = slug(title);
      if (level === 2) {
        if (sectionOpen) html.push('</section>');
        sectionOpen = true;
        sections.push({ id, title });
        html.push(`<section class="program-section" data-section="${id}">`);
      }
      const anchor = level > 1 ? `<a class="anchor" href="#${id}">#</a>` : '';
      html.push(`<h${level} id="${id}">${renderInline(title)}${anchor}</h${level}>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      flushBlocks();
      html.push('<hr>');
      continue;
    }
    const listItem = /^-\s+(.+)$/.exec(line);
    if (listItem) {
      flushParagraph();
      list.push(listItem[1]);
      continue;
    }
    if (!line.trim()) {
      flushBlocks();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushBlocks();
  if (code) throw new Error('program_markdown_unclosed_fence');
  if (sectionOpen) html.push('</section>');
  return { body: html.join('\n'), sections };
}

const css = `
:root{color-scheme:dark;--bg:#090c10;--panel:#11161d;--panel2:#171e27;--ink:#e8edf2;--muted:#8996a6;--line:#273140;--cyan:#65d7df;--green:#70d69a;--red:#ff7d8d;--amber:#f1c875;--violet:#ba9cff;--shadow:0 20px 60px rgba(0,0,0,.32)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 78% 4%,rgba(101,215,223,.09),transparent 26rem),var(--bg);color:var(--ink);font:15px/1.65 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:13px 24px;border-bottom:1px solid var(--line);background:rgba(9,12,16,.88);backdrop-filter:blur(18px)}
.brand{display:flex;align-items:center;gap:12px}.brand-mark{width:30px;height:30px;border:1px solid var(--cyan);border-radius:9px;display:grid;place-items:center;color:var(--cyan);font-weight:800;box-shadow:0 0 24px rgba(101,215,223,.12)}.brand strong{font-size:14px;letter-spacing:.02em}.brand small{display:block;color:var(--muted);font-size:11px}
.actions{display:flex;gap:8px}.actions button,.source-link{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:8px;padding:7px 11px;cursor:pointer;text-decoration:none;font:inherit;font-size:12px}.actions button:hover,.source-link:hover{border-color:var(--cyan)}.actions button.active{color:#061012;background:var(--cyan);border-color:var(--cyan)}button:focus-visible,a:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
.layout{display:grid;grid-template-columns:250px minmax(0,1fr);max-width:1500px;margin:0 auto}.sidebar{position:sticky;top:57px;align-self:start;height:calc(100vh - 57px);padding:32px 20px 40px;border-right:1px solid var(--line);overflow:auto}.eyebrow{color:var(--cyan);font:700 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.15em;text-transform:uppercase}.sidebar h2{font-size:18px;margin:9px 0 5px}.sidebar p{font-size:12px;color:var(--muted);margin:0 0 24px}.sidebar nav{display:grid;gap:4px}.sidebar nav a{display:grid;grid-template-columns:28px 1fr;gap:6px;padding:8px;border-radius:7px;color:var(--muted);text-decoration:none;font-size:12px}.sidebar nav a:hover{background:var(--panel);color:var(--ink)}.sidebar nav span{color:#536174;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
main{min-width:0;padding:48px clamp(26px,5vw,78px) 120px}h1{font-size:clamp(35px,5vw,68px);line-height:1.02;letter-spacing:-.045em;max-width:900px;margin:0 0 28px;background:linear-gradient(120deg,#fff 30%,var(--cyan));-webkit-background-clip:text;color:transparent}h2{margin:66px 0 22px;font-size:25px;letter-spacing:-.02em;display:flex;align-items:center;gap:10px}h3{margin:32px 0 12px;font-size:17px;color:var(--amber)}.anchor{opacity:0;color:var(--muted);text-decoration:none;font-size:14px}.program-section:hover>.anchor,h2:hover .anchor{opacity:1}p{max-width:920px;color:#c6d0da}strong{color:#fff}.inline-code{padding:2px 5px;border:1px solid var(--line);border-radius:5px;background:var(--panel2);color:var(--violet);font:12px ui-monospace,SFMono-Regular,Menlo,monospace}a{color:var(--cyan)}ul{max-width:900px;color:#c6d0da;padding-left:22px}li{margin:5px 0}hr{border:0;border-top:1px solid var(--line);margin:60px 0}
.code-block{position:relative;margin:18px 0 28px;border:1px solid var(--line);border-radius:12px;background:#0c1117;box-shadow:var(--shadow);overflow:auto;padding:12px 0}.diff-line{display:block;min-width:max-content;padding:1px 18px;border-left:3px solid transparent;white-space:pre;font:12px/1.62 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.diff-line.add{color:#b7f3cb;background:rgba(112,214,154,.055);border-color:var(--green)}.diff-line.remove{color:#ffc2ca;background:rgba(255,125,141,.05);border-color:var(--red)}.diff-line.change{color:#ffe2a7;background:rgba(241,200,117,.055);border-color:var(--amber)}.diff-line.context{color:#a8b3c0}
.trace-token{appearance:none;border:0;background:rgba(186,156,255,.12);color:var(--violet);font:inherit;border-radius:4px;padding:0 3px;cursor:pointer}.trace-token:hover,.trace-token.hit{background:var(--violet);color:#120d1c;box-shadow:0 0 0 3px rgba(186,156,255,.13)}
.table-wrap{margin:20px 0 30px;border:1px solid var(--line);border-radius:12px;overflow:auto;box-shadow:var(--shadow)}table{border-collapse:collapse;width:100%;min-width:760px;background:var(--panel)}th,td{padding:11px 13px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line);border-right:1px solid var(--line);font-size:12px}th{position:sticky;top:0;background:var(--panel2);color:var(--cyan);font-size:10px;text-transform:uppercase;letter-spacing:.08em}td{color:#c1ccd7}tr:last-child td{border-bottom:0}th:last-child,td:last-child{border-right:0}
.footer{margin-top:70px;padding-top:22px;border-top:1px solid var(--line);display:flex;justify-content:space-between;color:var(--muted);font:11px ui-monospace,SFMono-Regular,Menlo,monospace}.human-only section{display:none}.human-only section[data-section="0-brief"],.human-only section[data-section="1-types-signatures"],.human-only section[data-section="5-build-order"]{display:block}
@media(max-width:850px){.layout{display:block}.sidebar{display:none}main{padding:34px 18px 90px}.topbar{padding:10px 12px}.brand small{display:none}.source-link{display:none}h2{margin-top:48px}.code-block{border-radius:8px}.actions button{padding:6px 8px}}
@media(max-width:600px){.topbar{gap:8px}.brand strong{display:none}.actions{margin-left:auto}.actions button{font-size:11px;padding:6px 7px}}
`;

const source = await fs.readFile(sourcePath, 'utf8');
const sourceHash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 12);
const rendered = renderMarkdown(source);
const nav = rendered.sections.map(({ id, title }, index) =>
  `<a href="#${id}"><span>${String(index).padStart(2, '0')}</span>${escapeHtml(title.replace(/^\d+\.\s*/, ''))}</a>`).join('');
const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="program-source-sha256" content="${sourceHash}">
<title>Transcript Library · Program Design</title>
<style>${css}</style>
</head>
<body class="human-only">
<header class="topbar"><div class="brand"><div class="brand-mark">TL</div><div><strong>Transcript Library</strong><small>program design · source ${sourceHash}</small></div></div><div class="actions"><button id="human" class="active">Human review</button><button id="full">Full program</button><a class="source-link" href="${sourceName}">Markdown source</a></div></header>
<div class="layout"><aside class="sidebar"><div class="eyebrow">Review surface</div><h2>Shape before code</h2><p>Start with Brief, Signatures, and Build Order. Click any U/S/O token to trace it through the artifact.</p><nav>${nav}</nav></aside><main>${rendered.body}<div class="footer"><span>Generated from ${sourceName}</span><span>sha256:${sourceHash}</span></div></main></div>
<script>
const human=document.querySelector('#human');const full=document.querySelector('#full');
human.onclick=()=>{document.body.classList.add('human-only');human.classList.add('active');full.classList.remove('active')};
full.onclick=()=>{document.body.classList.remove('human-only');full.classList.add('active');human.classList.remove('active')};
document.addEventListener('click',e=>{const token=e.target.closest('.trace-token');if(!token)return;const value=token.dataset.token;document.querySelectorAll('.trace-token').forEach(n=>n.classList.toggle('hit',n.dataset.token===value));const first=[...document.querySelectorAll('.trace-token')].find(n=>n.dataset.token===value&&n!==token);if(first)first.scrollIntoView({behavior:'smooth',block:'center'})});
</script>
</body></html>
`;

await fs.writeFile(outputPath, document, { mode: 0o644 });
process.stdout.write(`${outputPath}\n${sourceHash}\n`);
