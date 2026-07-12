import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_MCP_TOOL_NAMES,
  MCP_TOOL_PROFILES,
  resolveMcpToolProfile
} from '../mcp-tool-profile.mjs';

test('mcp tool profiles default to the full compatibility surface', () => {
  const resolved = resolveMcpToolProfile({ argv: [], env: {} });
  assert.deepEqual(resolved.profiles, ['full']);
  assert.deepEqual(new Set(resolved.tools), new Set(ALL_MCP_TOOL_NAMES));
  assert.equal(resolved.tools.length, 34);
});

test('mcp tool profiles expose a narrow core workflow', () => {
  const resolved = resolveMcpToolProfile({ argv: ['--tool-profile', 'core'], env: {} });
  assert.deepEqual(resolved.profiles, ['core']);
  assert.deepEqual(resolved.tools, MCP_TOOL_PROFILES.core);
  assert.deepEqual(resolved.tools, [
    'agentify_query',
    'agentify_research',
    'agentify_read_page',
    'agentify_status',
    'agentify_stop_query',
    'agentify_list_runs',
    'agentify_get_run',
    'agentify_wait_run',
    'agentify_image_gen'
  ]);
});

test('mcp tool profiles compose additively from argv or environment', () => {
  const argvResolved = resolveMcpToolProfile({ argv: ['--tool-profile=core,browser'], env: {} });
  assert.deepEqual(argvResolved.profiles, ['core', 'browser']);
  assert.ok(argvResolved.tools.includes('agentify_query'));
  assert.ok(argvResolved.tools.includes('agentify_navigate'));
  assert.equal(argvResolved.tools.filter((name) => name === 'agentify_read_page').length, 1);

  const envResolved = resolveMcpToolProfile({ argv: [], env: { AGENTIFY_MCP_TOOL_PROFILE: 'context,admin' } });
  assert.deepEqual(envResolved.profiles, ['context', 'admin']);
  assert.ok(envResolved.tools.includes('agentify_save_bundle'));
  assert.ok(envResolved.tools.includes('agentify_shutdown'));
  assert.equal(envResolved.tools.includes('agentify_query'), false);
});

test('mcp tool profiles fail fast with valid choices', () => {
  assert.throws(
    () => resolveMcpToolProfile({ argv: ['--tool-profile', 'mystery'], env: {} }),
    /invalid_tool_profile:mystery; valid=full,core,browser,context,operations,media,admin/
  );
});
