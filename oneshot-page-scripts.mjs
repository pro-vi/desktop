// Functions the one-shot engine runs inside the provider page. Each one is
// serialized with Function#toString, so it may use only its arguments, the
// helpers object and page globals; it must not close over module scope.
// Selector arguments are arrays of profile branches, canonical first.

export function pageHelpers() {
  const visible = (node) => {
    if (!node || typeof node.getBoundingClientRect !== 'function') return false;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  // The first branch that matches anything decides the node set, so a
  // canonical branch is never mixed with a legacy one.
  const all = (selectors, root = document) => {
    for (const selector of selectors || []) {
      let nodes = [];
      try {
        nodes = Array.from(root.querySelectorAll(selector));
      } catch {
        nodes = [];
      }
      if (nodes.length) return nodes;
    }
    return [];
  };
  const matchesAny = (node, selectors) => (selectors || []).some((selector) => {
    try {
      return !!node?.matches?.(selector);
    } catch {
      return false;
    }
  });
  const insideAny = (node, selectors, stop = null) => {
    for (let current = node; current && current !== stop; current = current.parentElement) {
      if (matchesAny(current, selectors)) return true;
    }
    return false;
  };
  const rectOf = (node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  };
  const textOf = (node) => String(node?.innerText ?? node?.textContent ?? '');
  // The first visible node, checking each branch in order: a branch that
  // matches only hidden nodes falls through to the next branch.
  const first = (selectors, root = document) => {
    for (const selector of selectors || []) {
      let nodes = [];
      try {
        nodes = Array.from(root.querySelectorAll(selector));
      } catch {
        nodes = [];
      }
      const shown = nodes.find(visible);
      if (shown) return shown;
    }
    return null;
  };
  return { visible, all, first, matchesAny, insideAny, rectOf, textOf };
}

export function pageScript(fn, args = {}) {
  return `(() => { const h = (${pageHelpers.toString()})(); return (${fn.toString()})(${JSON.stringify(args)}, h); })()`;
}

export function readPageState(a, h) {
  const captcha = Array.from(document.querySelectorAll('iframe'))
    .filter(h.visible)
    .some((frame) => /turnstile|challenges\.cloudflare|recaptcha|hcaptcha|arkoselabs|captcha/i.test(String(frame.getAttribute('src') || '')));
  const composer = h.first(a.composer);
  return {
    url: String(location.href || ''),
    readyState: String(document.readyState || ''),
    composerVisible: !!composer,
    signedOut: h.all(a.signedOut).some(h.visible),
    termsGate: h.all(a.termsGate).some(h.visible),
    authInput: !!document.querySelector('input[type="password"]'),
    captcha,
    // Page text is a weak signal; it is read only where no composer shows.
    verifyText: !composer && /verify you are human|human verification|unusual traffic|are you a robot/i
      .test(String(document.body?.innerText || '').slice(0, 5000)),
    userTurns: h.all(a.userTurn).length,
    assistantTurns: h.all(a.assistantTurn).length
  };
}

export function readComposer(a, h) {
  const el = h.first(a.composer);
  if (!el) return { found: false };
  const usesValue = el.matches('textarea, input');
  return {
    found: true,
    usesValue,
    text: usesValue ? String(el.value || '') : String(el.innerText || el.textContent || ''),
    rect: h.rectOf(el)
  };
}

export function focusComposer(a, h) {
  const el = h.first(a.composer);
  if (!el) return { found: false };
  el.focus();
  return { found: true };
}

export function readSendButton(a, h) {
  const el = h.first(a.send);
  if (!el) return { found: false };
  const enabled = !el.disabled &&
    el.getAttribute('aria-disabled') !== 'true' &&
    !h.matchesAny(el, a.sendDisabled);
  return { found: true, enabled, rect: h.rectOf(el) };
}

// Read on every poll while an answer streams, so it returns counts and the
// answer text only; the user turn's text is read once, by readLastUserText.
export function readTurns(a, h) {
  const assistants = h.all(a.assistantTurn);
  const last = assistants[assistants.length - 1] || null;
  let lastAssistant = null;
  if (last) {
    const bodies = h.all(a.answerBody, last).filter((node) => !h.insideAny(node, a.answerExclude, last));
    lastAssistant = {
      answerText: bodies.map(h.textOf).join('\n').trim(),
      error: !!h.first(a.answerError, last),
      // A control the page shows only on a finished answer, such as its action bar.
      idle: !!h.first(a.idle, last)
    };
  }
  const composer = h.first(a.composer);
  const notice = h.first(a.notice);
  return {
    userTurns: h.all(a.userTurn).length,
    assistantTurns: assistants.length,
    lastAssistant,
    stopVisible: !!h.first(a.stop),
    composerEmpty: composer ? !String(composer.matches('textarea, input') ? composer.value : h.textOf(composer)).trim() : null,
    notice: notice ? h.textOf(notice).replace(/\s+/g, ' ').trim().slice(0, 300) : null
  };
}

export function readLastUserText(a, h) {
  const users = h.all(a.userTurn);
  return users.length ? h.textOf(users[users.length - 1]) : null;
}

export function readAttachments(a, h) {
  const nodes = h.all(a.attachmentItem).filter(h.visible);
  // A chip's own child nodes can match the same selector; keep only chips.
  const outermost = nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
  const items = outermost.map((node) => ({
    text: h.textOf(node).replace(/\s+/g, ' ').trim().slice(0, 200),
    pending: h.matchesAny(node, a.attachmentPending) || h.all(a.attachmentPending, node).some(h.visible),
    error: h.matchesAny(node, a.attachmentError) || h.all(a.attachmentError, node).some(h.visible)
  }));
  const errorTexts = h.all(a.attachmentError)
    .filter(h.visible)
    .map((node) => h.textOf(node).replace(/\s+/g, ' ').trim().slice(0, 200))
    .filter(Boolean);
  return { items, errorTexts };
}

// Files arrive as base64 and become page-side File objects, which framework
// change handlers accept; a CDP-set file list is rejected by some of them.
export function injectFiles(a, h) {
  const inputs = h.all(a.fileInput).filter((node) => String(node.getAttribute('type') || '').toLowerCase() === 'file');
  if (!inputs.length) return { ok: false, reason: 'file_input_not_found' };
  const input = inputs[inputs.length - 1];
  if (a.files.length > 1 && !input.multiple) return { ok: false, reason: 'file_input_single' };
  const transfer = new DataTransfer();
  for (const file of a.files) {
    const bytes = Uint8Array.from(atob(file.data), (ch) => ch.charCodeAt(0));
    transfer.items.add(new File([bytes], file.name, { type: file.mime, lastModified: Date.now() }));
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}

export function readPageText(a) {
  const clean = (value) => String(value || '').replace(/\u0000/g, '').replace(/\s+\n/g, '\n').trim();
  const text = clean(document.querySelector('main')?.innerText) || clean(document.body?.innerText);
  return { text: text.slice(0, a.maxChars), totalChars: text.length };
}

// Converts the last assistant answer to Markdown. Links stay inline; citation
// markers become numbered links; every distinct http(s) URL is also returned
// as a structured source, in first-seen order.
export function captureAnswer(a, h) {
  const assistants = h.all(a.assistantTurn);
  const turn = assistants[assistants.length - 1];
  if (!turn) return { found: false, reason: 'assistant_turn_missing' };
  const bodies = h.all(a.answerBody, turn).filter((node) => !h.insideAny(node, a.answerExclude, turn));
  if (!bodies.length) return { found: false, reason: 'answer_body_missing' };

  const sources = [];
  const byUrl = new Map();
  const httpUrl = (value) => {
    if (!value) return null;
    try {
      const url = new URL(String(value), location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      // A text fragment (#:~:text=) points into the page; the page is the source.
      if (url.hash.startsWith('#:~:')) url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  };
  const addSource = (url, title, kind) => {
    if (!url) return null;
    let source = byUrl.get(url);
    if (!source) {
      source = { index: sources.length + 1, url, title: '', kinds: [] };
      sources.push(source);
      byUrl.set(url, source);
    }
    const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    // A citation marker's own text is usually just its number, which names nothing.
    const namesSomething = cleanTitle && cleanTitle !== url && !/^[\[(]?\d+[\])]?$/.test(cleanTitle);
    if (!source.title && namesSomething) source.title = cleanTitle;
    if (!source.kinds.includes(kind)) source.kinds.push(kind);
    return source.index;
  };
  // A citation names its sources by href, by data-url, by a nested link, or by
  // data-oneshot-sources: a JSON list an adapter wrote after opening the
  // citation's card, for sites whose markers hold no URL themselves.
  const citedSources = (node) => {
    const stamped = node.getAttribute?.('data-oneshot-sources');
    if (stamped) {
      try {
        return JSON.parse(stamped).map((item) => ({ url: httpUrl(item?.url), title: item?.title || '' })).filter((item) => item.url);
      } catch {}
    }
    const url = httpUrl(node.getAttribute?.('href') || node.getAttribute?.('data-url')) ||
      httpUrl(node.querySelector?.('a[href]')?.getAttribute('href'));
    return url ? [{ url, title: node.getAttribute?.('title') || h.textOf(node) }] : [];
  };
  const SKIP_TAGS = new Set(['script', 'style', 'svg', 'button', 'noscript', 'template', 'canvas']);
  const BLOCK_TAGS = new Set(['p', 'section', 'article', 'figure', 'header', 'footer']);
  const codeLanguage = (pre) => {
    const code = pre.querySelector?.('code');
    const match = /language-([\w+#.-]+)/.exec(String(code?.getAttribute?.('class') || ''));
    if (match) return match[1];
    let ancestor = pre.parentElement;
    for (let depth = 0; ancestor && depth < 3; depth += 1, ancestor = ancestor.parentElement) {
      const label = h.all(a.codeLanguage, ancestor)[0];
      if (label) return h.textOf(label).trim().split(/\s+/)[0] || '';
    }
    return '';
  };
  const indent = (text, prefix) => text.split('\n').map((line, i) => (i === 0 ? line : prefix + line)).join('\n');

  const MARKS = { strong: '**', b: '**', em: '*', i: '*', del: '~~', s: '~~' };
  const renderChildren = (node) => Array.from(node.childNodes || []).map(render).join('');
  // Text inside <pre> is taken verbatim from textContent, so render never
  // needs to keep whitespace itself.
  function render(node) {
    if (node.nodeType === 3) return String(node.textContent || '').replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const tag = String(node.tagName || '').toLowerCase();
    if (SKIP_TAGS.has(tag) || h.matchesAny(node, a.answerSkip) || h.matchesAny(node, a.answerExclude)) return '';
    if (h.matchesAny(node, a.citation)) {
      return citedSources(node)
        .map((item) => ` [${addSource(item.url, item.title, 'citation')}](${item.url})`)
        .join('');
    }
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) return `\n\n${'#'.repeat(Number(heading[1]))} ${renderChildren(node).trim()}\n\n`;
    if (BLOCK_TAGS.has(tag)) return `\n\n${renderChildren(node)}\n\n`;
    if (tag === 'div') return `\n${renderChildren(node)}\n`;
    if (tag === 'br') return '\n';
    if (tag === 'hr') return '\n\n---\n\n';
    if (MARKS[tag]) {
      const inner = renderChildren(node);
      return inner.trim() ? `${MARKS[tag]}${inner.trim()}${MARKS[tag]}` : inner;
    }
    if (tag === 'code') return `\`${String(node.textContent || '')}\``;
    if (tag === 'pre') {
      const code = node.querySelector?.('code') || node;
      const body = String(code.textContent || '').replace(/\n$/, '');
      return `\n\n\`\`\`${codeLanguage(node)}\n${body}\n\`\`\`\n\n`;
    }
    if (tag === 'a') {
      const url = httpUrl(node.getAttribute('href'));
      const text = renderChildren(node).replace(/\s+/g, ' ').trim();
      if (!url) return text;
      addSource(url, text, 'inline');
      return `[${text || url}](${url})`;
    }
    if (tag === 'img') {
      const src = httpUrl(node.getAttribute('src'));
      return src ? `![${String(node.getAttribute('alt') || '').trim()}](${src})` : '';
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(node.children || []).filter((child) => String(child.tagName || '').toLowerCase() === 'li');
      const lines = items.map((item, i) => {
        const marker = tag === 'ol' ? `${i + 1}.` : '-';
        const content = renderChildren(item).replace(/\n{3,}/g, '\n\n').trim();
        return `${marker} ${indent(content, ' '.repeat(marker.length + 1))}`;
      });
      return `\n\n${lines.join('\n')}\n\n`;
    }
    if (tag === 'blockquote') {
      const content = renderChildren(node).replace(/\n{3,}/g, '\n\n').trim();
      return `\n\n${content.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n')}\n\n`;
    }
    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr')).map((row) => Array.from(row.children || [])
        .map((cell) => renderChildren(cell).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')));
      if (!rows.length) return '';
      const width = Math.max(...rows.map((row) => row.length));
      const line = (row) => `| ${Array.from({ length: width }, (_, i) => row[i] || '').join(' | ')} |`;
      return `\n\n${[line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n')}\n\n`;
    }
    return renderChildren(node);
  }

  const tidy = (text) => text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const markdown = tidy(bodies.map(render).join('\n\n'));
  // Panel sources come from this answer's turn or the panel the site opens
  // for it, never from the rest of the page.
  const panel = h.first(a.sourcePanel);
  for (const root of [turn, panel].filter(Boolean)) {
    for (const item of h.all(a.sourceItem, root)) {
      for (const cited of citedSources(item)) addSource(cited.url, cited.title, 'panel');
    }
  }
  return {
    found: true,
    markdown,
    text: bodies.map(h.textOf).join('\n\n').trim(),
    sources
  };
}
