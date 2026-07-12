const CORE_TOOLS = [
  'agentify_query',
  'agentify_research',
  'agentify_read_page',
  'agentify_status',
  'agentify_stop_query',
  'agentify_list_runs',
  'agentify_get_run',
  'agentify_wait_run',
  'agentify_image_gen'
];

export const MCP_TOOL_PROFILES = Object.freeze({
  core: Object.freeze(CORE_TOOLS),
  browser: Object.freeze([
    'agentify_read_page',
    'agentify_navigate',
    'agentify_ensure_ready',
    'agentify_show',
    'agentify_hide',
    'agentify_tabs',
    'agentify_tab_create',
    'agentify_tab_close'
  ]),
  context: Object.freeze([
    'agentify_list_watch_folders',
    'agentify_add_watch_folder',
    'agentify_remove_watch_folder',
    'agentify_open_watch_folder',
    'agentify_scan_watch_folder',
    'agentify_save_bundle',
    'agentify_list_bundles',
    'agentify_get_bundle',
    'agentify_delete_bundle',
    'agentify_save_artifacts',
    'agentify_list_artifacts',
    'agentify_open_artifacts_folder'
  ]),
  operations: Object.freeze([
    'agentify_list_runs',
    'agentify_open_run',
    'agentify_retry_run',
    'agentify_archive_run'
  ]),
  media: Object.freeze([
    'agentify_image_gen',
    'agentify_download_images',
    'agentify_save_artifacts',
    'agentify_list_artifacts',
    'agentify_open_artifacts_folder'
  ]),
  admin: Object.freeze([
    'agentify_shutdown',
    'agentify_rotate_token'
  ])
});

export const ALL_MCP_TOOL_NAMES = Object.freeze(Array.from(new Set(
  Object.values(MCP_TOOL_PROFILES).flat()
)));

export const MCP_TOOL_PROFILE_NAMES = Object.freeze(['full', ...Object.keys(MCP_TOOL_PROFILES)]);

function profileValueFromArgv(argv = []) {
  const args = Array.from(argv, String);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('--tool-profile=')) return arg.slice('--tool-profile='.length);
    if (arg === '--tool-profile') return args[index + 1] || '';
  }
  return null;
}

export function resolveMcpToolProfile({ argv = [], env = process.env } = {}) {
  const raw = profileValueFromArgv(argv) ?? env.AGENTIFY_MCP_TOOL_PROFILE ?? 'full';
  const requested = String(raw || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!requested.length) throw new Error(`missing_tool_profile: valid=${MCP_TOOL_PROFILE_NAMES.join(',')}`);
  const invalid = requested.filter((name) => !MCP_TOOL_PROFILE_NAMES.includes(name));
  if (invalid.length) throw new Error(`invalid_tool_profile:${invalid.join(',')}; valid=${MCP_TOOL_PROFILE_NAMES.join(',')}`);
  const profiles = Array.from(new Set(requested));
  const tools = profiles.includes('full')
    ? [...ALL_MCP_TOOL_NAMES]
    : Array.from(new Set(profiles.flatMap((name) => MCP_TOOL_PROFILES[name])));
  return { profiles, tools };
}
