// A minimal DOM for running the one-shot engine's page scripts under node:vm.
// An element matches a selector only when it lists that exact selector string
// (or, for a bare tag list such as "textarea, input", by its tag), so a test
// states which profile branches each element answers to.
import vm from 'node:vm';

const BARE_TAGS = /^[a-z][a-z0-9]*$/;

function textNode(value) {
  return { nodeType: 3, textContent: String(value), parentElement: null };
}

// Engine timings scaled down for stub pages.
export const FAST_TIMINGS = Object.freeze({ pollMs: 1, stableMs: 15, sendAckMs: 200, sendEnableMs: 20, uploadMs: 200, uiCheckMs: 50, promptDeliveryMs: 200, menuMs: 50, controlMs: 100, hardResponseMs: 600 });

export function el(tag, {
  attrs = {},
  text = null,
  children = [],
  rect = { x: 0, y: 0, w: 100, h: 20 },
  matches = [],
  hidden = false,
  props = {},
  onClick = null
} = {}) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    attrs: { ...attrs },
    selectorList: [...matches],
    hidden,
    rectBox: rect,
    onClick,
    events: [],
    parentElement: null,
    childNodes: []
  };
  // Descriptors, not a spread, so a test's setter (input.files) stays a setter.
  Object.defineProperties(node, Object.getOwnPropertyDescriptors(props));
  const kids = [...(text === null ? [] : [text]), ...children];
  node.childNodes = kids.map((child) => (typeof child === 'string' ? textNode(child) : child));
  for (const child of node.childNodes) child.parentElement = node;
  Object.defineProperty(node, 'children', { get: () => node.childNodes.filter((child) => child.nodeType === 1) });
  Object.defineProperty(node, 'className', { get: () => node.attrs.class || '' });
  Object.defineProperty(node, 'textContent', {
    get: () => node.childNodes.map((child) => child.textContent).join(''),
    configurable: true
  });
  if (!Object.prototype.hasOwnProperty.call(props, 'innerText')) {
    Object.defineProperty(node, 'innerText', { get: () => (node.hidden ? '' : node.textContent), configurable: true });
  }
  node.getAttribute = (name) => (Object.prototype.hasOwnProperty.call(node.attrs, name) ? String(node.attrs[name]) : null);
  node.setAttribute = (name, value) => { node.attrs[name] = String(value); };
  node.hasAttribute = (name) => Object.prototype.hasOwnProperty.call(node.attrs, name);
  node.matches = (selector) => {
    if (node.selectorList.includes(selector)) return true;
    const parts = String(selector).split(',').map((part) => part.trim());
    return parts.every((part) => BARE_TAGS.test(part)) && parts.includes(node.tagName.toLowerCase());
  };
  node.querySelectorAll = (selector) => descendants(node).filter((child) => child.matches(selector));
  node.querySelector = (selector) => node.querySelectorAll(selector)[0] || null;
  node.getBoundingClientRect = () => (node.hidden
    ? { x: 0, y: 0, width: 0, height: 0 }
    : { x: node.rectBox.x, y: node.rectBox.y, width: node.rectBox.w, height: node.rectBox.h });
  node.contains = (other) => {
    for (let current = other; current; current = current.parentElement) if (current === node) return true;
    return false;
  };
  node.focus = () => { node.focused = true; };
  node.click = () => { node.onClick?.(); };
  node.dispatchEvent = (event) => { node.events.push(event.type); return true; };
  return node;
}

function descendants(root) {
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes || []) {
      if (child.nodeType !== 1) continue;
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

export function createDocument({ url = 'https://site.example/', readyState = 'complete', body = [] } = {}) {
  const bodyNode = el('body', { children: body, rect: { x: 0, y: 0, w: 1200, h: 800 } });
  const focused = () => descendants(bodyNode).find((node) => node.focused) || bodyNode;
  return {
    url,
    readyState,
    body: bodyNode,
    get activeElement() { return focused(); },
    querySelectorAll: (selector) => bodyNode.querySelectorAll(selector),
    querySelector: (selector) => bodyNode.querySelector(selector),
    getElementById: (id) => descendants(bodyNode).find((node) => node.attrs.id === id) || null,
    allNodes: () => descendants(bodyNode)
  };
}

class FakeEvent {
  constructor(type) {
    this.type = type;
  }
}

class FakeFile {
  constructor(parts, name, { type = '' } = {}) {
    this.name = name;
    this.type = type;
    this.size = parts.reduce((sum, part) => sum + (part?.length || 0), 0);
  }
}

class FakeDataTransfer {
  constructor() {
    const files = [];
    this.files = files;
    this.items = { add: (file) => files.push(file) };
  }
}

export async function runInDocument(js, document) {
  const context = {
    document,
    location: new URL(document.url),
    window: {
      getComputedStyle: (node) => ({ visibility: node.hidden ? 'hidden' : 'visible', display: 'block' })
    },
    URL,
    atob,
    Event: FakeEvent,
    MouseEvent: FakeEvent,
    File: FakeFile,
    DataTransfer: FakeDataTransfer
  };
  const value = await vm.runInNewContext(js, context);
  // CDP returns values by JSON-like serialization; doing the same here keeps
  // test assertions free of cross-realm prototypes.
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// A provider tab: render(state) builds the DOM for the current state, and
// pointer clicks land on the topmost element whose rect holds the point.
export function createFakePage({ state, render, url = 'https://site.example/', onNavigate = null, onEvaluate = null }) {
  const page = {
    state,
    url,
    evaluations: [],
    keys: [],
    clicks: [],
    moves: [],
    navigations: [],
    lastDocument: null,
    async evaluate(js) {
      page.evaluations.push(js);
      onEvaluate?.(js, page);
      const document = createDocument({ url: page.url, body: render(page.state, page) });
      page.lastDocument = document;
      return await runInDocument(js, document);
    },
    async navigate(next) {
      page.navigations.push(next);
      page.url = next;
      onNavigate?.(next, page);
    },
    async getUrl() {
      return page.url;
    },
    async sendKey(key, { modifiers = [] } = {}) {
      page.keys.push(modifiers.length ? `${modifiers.join('+')}+${key}` : key);
      if (key === 'Backspace' && page.state.selectAll) {
        page.state.composerText = '';
        page.state.selectAll = false;
      } else if (key === 'Backspace') {
        page.state.composerText = page.state.composerText.slice(0, -1);
      } else if (key === 'A' && modifiers.length) {
        page.state.selectAll = true;
      } else if (key === 'Return' && modifiers.includes('shift')) {
        page.state.composerText += '\n';
      } else if (key === 'Escape') {
        page.state.menu = null;
      }
    },
    async insertText(text) {
      page.state.composerText += page.state.dropText ? page.state.dropText(text) : text;
    },
    async moveMouse(x, y) {
      page.moves.push([x, y]);
    },
    async mouseDown() {},
    async mouseUp(x, y) {
      page.clicks.push([x, y]);
      const document = createDocument({ url: page.url, body: render(page.state, page) });
      const hit = document.allNodes()
        .filter((node) => node.onClick && !node.hidden)
        .filter((node) => x >= node.rectBox.x && x <= node.rectBox.x + node.rectBox.w && y >= node.rectBox.y && y <= node.rectBox.y + node.rectBox.h)
        .pop();
      hit?.onClick();
    }
  };
  return page;
}
