import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const e2eRunner = path.join(repoDir, 'scripts', 'e2e-transcript-library.mjs');
const visualProofRunner = path.join(repoDir, 'scripts', 'visual-proof-transcript-library.mjs');

async function runFailure(script, args) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: repoDir,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return {
    ...result,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8')
  };
}

function parseFailure(result) {
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  return JSON.parse(result.stderr);
}

test('Transcript Library E2E reporter never derives output from a private-looking filesystem error message', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-e2e-reporter-redaction-'));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const marker = 'transcript_private_journal';
  const stateFile = path.join(directory, `${marker}-${crypto.randomUUID()}`);
  await fs.writeFile(stateFile, 'not a state directory', { mode: 0o600, flag: 'wx' });

  const result = await runFailure(e2eRunner, ['--state-dir', stateFile]);
  assert.deepEqual(parseFailure(result), { schemaVersion: 1, status: 'fail', error: 'e2e_failed' });
  assert.equal(result.stderr.includes(marker), false);
  assert.equal(result.stderr.includes(stateFile), false);

  const allowlisted = parseFailure(await runFailure(e2eRunner, ['--not-an-option']));
  assert.equal(allowlisted.error, 'e2e_argument_unknown');
});

test('Transcript Library visual-proof reporter never derives output from a private-looking filesystem error message', async (t) => {
  const temporaryRoot = await fs.realpath('/tmp');
  const marker = 'electron_private_journal';
  const evidenceFile = path.join(
    temporaryRoot,
    `agentify-transcript-library-visual-proof-${marker}-${crypto.randomUUID()}`
  );
  await fs.writeFile(evidenceFile, 'not an evidence directory', { mode: 0o600, flag: 'wx' });
  t.after(async () => await fs.rm(evidenceFile, { force: true }));

  const result = await runFailure(visualProofRunner, ['capture', '--evidence-dir', evidenceFile]);
  assert.deepEqual(parseFailure(result), { schemaVersion: 1, status: 'fail', error: 'visual_proof_failed' });
  assert.equal(result.stderr.includes(marker), false);
  assert.equal(result.stderr.includes(evidenceFile), false);

  const allowlisted = parseFailure(await runFailure(visualProofRunner, ['--not-an-option']));
  assert.equal(allowlisted.error, 'visual_proof_argument_unknown');
});
