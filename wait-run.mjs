#!/usr/bin/env node
import { defaultStateDir } from './state.mjs';
import { ensureDesktopRunning } from './mcp-lib.mjs';
import { exitCodeForRunStatus, waitForRun } from './run-waiter.mjs';

function parseArgs(argv) {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const runId = String(args.shift() || '').trim();
  let timeoutMs = 0;
  let includeOutputText = true;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--timeout-ms') timeoutMs = Number(args.shift());
    else if (arg === '--no-output') includeOutputText = false;
    else throw new Error(`unknown_argument:${arg}`);
  }
  if (!runId) throw new Error('missing_run_id');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('invalid_timeout_ms');
  return { runId, timeoutMs, includeOutputText };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\nusage: npm run wait-run -- <runId> [--timeout-ms N] [--no-output]\n`);
    process.exitCode = 64;
    return;
  }
  if (args.help) {
    process.stdout.write('Wait for an Agentify query or research run to reach proven terminal completion.\n\nUsage:\n  npm run wait-run -- <runId> [--timeout-ms N] [--no-output]\n\nExit codes:\n  0 success, 2 error, 3 stopped, 4 interrupted, 64 usage, 75 caller timeout, 130 signal\n');
    return;
  }
  const abortController = new AbortController();
  const onSignal = () => abortController.abort(new Error('wait_aborted'));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const conn = await ensureDesktopRunning({ stateDir: defaultStateDir() });
    const data = await waitForRun({ conn, ...args, signal: abortController.signal });
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    process.exitCode = exitCodeForRunStatus(data.run?.status);
  } catch (error) {
    if (abortController.signal.aborted) process.exitCode = 130;
    else if (error?.message === 'run_wait_timeout') process.exitCode = 75;
    else process.exitCode = error?.data?.status === 409 || /^missing_|^invalid_|^unknown_argument/.test(error?.message || '') ? 64 : 2;
    process.stderr.write(`${error?.message || 'run_wait_failed'}\n`);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

await main();
