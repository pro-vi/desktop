const SUPPORTED_BROWSER_BACKENDS = ['electron', 'chrome-cdp'];

export function rendererEvaluationError(details) {
  const description = details?.exception?.description || details?.text || 'renderer_evaluation_failed';
  const message = String(description).split('\n')[0];
  const frames = details?.stackTrace?.callFrames || [];
  let stackFrames = frames.map(frame =>
    `    at ${frame.functionName || '<anonymous>'} (script ${frame.scriptId}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`
  );
  if (!stackFrames.length) {
    stackFrames = String(description).split('\n').slice(1).flatMap(line => {
      const frame = line.trim();
      if (!frame.startsWith('at ')) return [];
      const position = /:(\d+):(\d+)\)?$/.exec(frame);
      if (!position) return [];
      const call = frame.slice(3);
      const nameEnd = call.indexOf(' (');
      const name = nameEnd >= 0 ? call.slice(0, nameEnd) : '<anonymous>';
      return [`    at ${name} (line ${position[1]}:${position[2]})`];
    });
  }
  const stack = [message, ...stackFrames].join('\n');
  const error = new Error(message);
  error.data = { rendererError: {
    source: 'renderer',
    name: details?.exception?.className || 'Error',
    message,
    stack,
    lineNumber: details?.lineNumber ?? null,
    columnNumber: details?.columnNumber ?? null
  } };
  return error;
}

export function normalizeBrowserBackend(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'electron';
  if (raw === 'chrome' || raw === 'chrome_cdp' || raw === 'cdp') return 'chrome-cdp';
  if (SUPPORTED_BROWSER_BACKENDS.includes(raw)) return raw;
  return 'electron';
}

export function resolveBrowserBackend({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--browser-backend') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  return normalizeBrowserBackend(argValue || env.AGENTIFY_DESKTOP_BROWSER_BACKEND || settings.browserBackend);
}

export function resolveChromeExecutablePath({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-binary') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  const raw = argValue || env.AGENTIFY_DESKTOP_CHROME_BIN || settings.chromeExecutablePath || '';
  const trimmed = String(raw || '').trim();
  return trimmed || null;
}

export function resolveChromeDebugPort({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-debug-port') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  const raw = argValue || env.AGENTIFY_DESKTOP_CHROME_DEBUG_PORT || settings.chromeDebugPort;
  const port = Math.floor(Number(raw));
  if (!Number.isFinite(port) || port < 1024 || port > 65535) return 9222;
  return port;
}

export function resolveChromeProfileMode({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-profile-mode') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  const raw = String(argValue || env.AGENTIFY_DESKTOP_CHROME_PROFILE_MODE || settings.chromeProfileMode || '').trim().toLowerCase();
  return raw === 'existing' ? 'existing' : 'isolated';
}

export function resolveChromeProfileName({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-profile-name') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  const raw = String(argValue || env.AGENTIFY_DESKTOP_CHROME_PROFILE_NAME || settings.chromeProfileName || '').trim();
  return raw || 'Default';
}

export async function createBrowserBackend({
  kind,
  stateDir,
  windowDefaults,
  userAgent,
  popupPolicy,
  onChanged,
  chromeExecutablePath,
  chromeDebugPort,
  chromeProfileMode,
  chromeProfileName
} = {}) {
  const normalized = normalizeBrowserBackend(kind);
  if (normalized === 'chrome-cdp') {
    const { ChromeCdpBrowserBackend } = await import('./chrome-cdp-backend.mjs');
    return new ChromeCdpBrowserBackend({
      stateDir,
      userAgent,
      onChanged,
      executablePath: chromeExecutablePath,
      debugPort: chromeDebugPort,
      profileMode: chromeProfileMode,
      profileName: chromeProfileName
    });
  }
  const { ElectronBrowserBackend } = await import('./electron-browser-backend.mjs');
  return new ElectronBrowserBackend({
    windowDefaults,
    userAgent,
    popupPolicy,
    onChanged
  });
}
