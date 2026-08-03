import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(repoDir, 'scripts', 'visual-proof-transcript-library.mjs');
const evidencePrefix = 'agentify-transcript-library-visual-proof-';
const forbiddenMarkers = [
  'VISUAL_PROOF_PRIVATE_TRANSCRIPT_SENTINEL',
  'VISUAL_PROOF_PRIVATE_ARCHIVE_SENTINEL',
  'PRIVATE-ARCHIVE-PATH.zip'
];
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function runRunner(args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [runner, ...args], {
    cwd: repoDir,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000
  });
  assert.equal(stderr, '');
  return { output: JSON.parse(stdout), raw: stdout };
}

async function assertPrivateFile(filePath) {
  const stat = await fs.lstat(filePath);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o600);
}

async function removeOwnedEvidenceDirectory(evidenceDir) {
  const temporaryRoot = await fs.realpath('/tmp');
  const real = await fs.realpath(evidenceDir).catch(() => null);
  if (
    real &&
    path.dirname(real) === temporaryRoot &&
    path.basename(real).startsWith(evidencePrefix)
  ) {
    await fs.rm(real, { recursive: true, force: false });
  }
}

function assertCleanPrivacyEvidence(privacy) {
  assert.equal(privacy.transcript_bodies_absent, true);
  assert.equal(privacy.raw_archive_paths_absent, true);
  assert.equal(privacy.forbidden_markers_absent, true);
  for (const observation of Object.values(privacy.observations)) {
    assert.deepEqual(observation, {
      fixture_boundary_observed: true,
      rendered_text_absent: true,
      captured_console_error_output_absent: true,
      renderer_console_error_absent: true,
      process_output_absent: true
    });
  }
}

test('visual proof captures the actual Electron renderer states and emits review-gated manifests', { timeout: 90_000 }, async (t) => {
  let evidenceDir = null;
  t.after(async () => {
    if (evidenceDir) await removeOwnedEvidenceDirectory(evidenceDir);
  });

  const captured = await runRunner(['capture']);
  evidenceDir = captured.output.evidenceDir;

  assert.equal(captured.output.status, 'captured-awaiting-pixel-review');
  assert.equal(path.dirname(evidenceDir), await fs.realpath('/tmp'));
  assert.match(path.basename(evidenceDir), /^agentify-transcript-library-visual-proof-/);
  const directoryStat = await fs.lstat(evidenceDir);
  assert.equal(directoryStat.isDirectory(), true);
  assert.equal(directoryStat.isSymbolicLink(), false);
  assert.equal(directoryStat.mode & 0o777, 0o700);
  assert.equal(captured.output.screenshots.length, 2);

  await assertPrivateFile(captured.output.capture);
  const recordText = await fs.readFile(captured.output.capture, 'utf8');
  const record = JSON.parse(recordText);
  assert.equal(record.schema, 'transcript-library-visual-proof-capture/v1');
  assert.equal(record.status, 'captured-awaiting-pixel-review');
  assert.equal(record.evidence_dir, evidenceDir);
  assert.equal(record.privacy.transcript_bodies_absent, true);
  assert.equal(record.privacy.raw_archive_paths_absent, true);
  assert.equal(record.privacy.forbidden_markers_absent, true);
  assert.equal(record.provenance.git.head, (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' })).stdout.trim());
  assert.equal(record.provenance.git.branch, (await execFileAsync('git', ['branch', '--show-current'], { cwd: repoDir, encoding: 'utf8' })).stdout.trim());
  assert.match(record.provenance.worktree_fingerprint, /^[0-9a-f]{64}$/);
  assert.match(record.provenance.package_lock_sha256, /^[0-9a-f]{64}$/);
  assert.match(record.provenance.render_input_sha256, /^[0-9a-f]{64}$/);
  assert.equal(record.captures.length, 2);
  assert.equal(forbiddenMarkers.some((marker) => `${captured.raw}\n${recordText}`.includes(marker)), false);

  const byScenario = new Map(record.captures.map((capture) => [capture.scenario, capture]));
  assert.deepEqual([...byScenario.keys()].sort(), ['forget', 'states']);
  for (const capture of byScenario.values()) {
    assert.equal(capture.inspection.machineVerdict, 'pass');
    assert.equal(capture.inspection.regions.every(({ verdict }) => verdict === 'pass'), true);
    assert.equal(capture.inspection.regions.every(({ observations }) =>
      observations.some(({ kind, fullyWithin }) => kind === 'viewport' && fullyWithin === true)), true);
    assert.equal(capture.inspection.objective.contrastSweep.scoped.length, 0);
    assert.equal(capture.inspection.objective.overflow.htmlOverflowX, false);
    assert.equal(capture.inspection.objective.overflow.bodyOverflowX, false);
    assert.equal(capture.inspection.objective.overflow.cardOverflowX, false);
    assert.equal(capture.inspection.objective.overflow.mainOverflowX, false);
    assert.equal(capture.inspection.objective.overflow.mainOverflowY, true);
    assert.deepEqual(capture.viewport, { width: 720, height: 1800, device: 'desktop' });
    assert.deepEqual(
      [capture.inspection.objective.viewport.width, capture.inspection.objective.viewport.height],
      [capture.viewport.width, capture.viewport.height]
    );
    assert.equal(capture.inspection.objective.privacyMarkersAbsent, true);
    assert.equal(capture.runtime.process_output_private_markers_absent, true);
    assert.equal(capture.runtime.renderer_diagnostics_private_markers_absent, true);
    assertCleanPrivacyEvidence(capture.privacy);
    await assertPrivateFile(capture.screenshot.path);
    const screenshot = await fs.readFile(capture.screenshot.path);
    assert.equal(screenshot.subarray(0, 8).equals(pngSignature), true);
    assert.equal(screenshot.length, capture.screenshot.bytes);
    assert.equal(sha256(screenshot), capture.screenshot.sha256);
  }

  assert.deepEqual(
    byScenario.get('states').inspection.regions.map(({ label }) => label),
    [
      'temporarily unavailable catalog route',
      'disabled source row',
      'syncing source row',
      'partial source row',
      'tracked source row and forget control',
      'private storage location',
      'local-only privacy promise'
    ]
  );
  assert.deepEqual(byScenario.get('forget').confirmation, {
    kind: 'javascript-confirm',
    accepted: true,
    messageMatched: true,
    observableResult: 'success-and-empty-state'
  });
  assert.deepEqual(
    byScenario.get('forget').inspection.regions.map(({ label }) => label),
    ['confirmed local forget success', 'empty tracked-source state', 'provider-preserving privacy promise']
  );

  const finalized = await runRunner([
    'finalize',
    '--evidence-dir', evidenceDir,
    '--pixel-review', 'fail',
    '--reviewer', 'automated-contract-test',
    '--review-note', 'Automated manifest contract exercise only; no human pixel review was performed.'
  ]);
  assert.equal(finalized.output.status, 'rejected-by-pixel-review');
  assert.deepEqual(finalized.output.aggregate, { pass: 0, fail: 2, unknown: 0 });
  assert.equal(finalized.output.manifests.length, 2);

  for (const manifestRecord of finalized.output.manifests) {
    await assertPrivateFile(manifestRecord.path);
    const manifest = JSON.parse(await fs.readFile(manifestRecord.path, 'utf8'));
    assert.equal(manifest.schema, 'visual-proof/v1');
    assert.equal(manifest.capture_mode, 'hybrid-electron-fixture');
    assert.equal(manifest.fixture.mode, 'contract-fixture');
    assert.deepEqual(manifest.fixture.actual_product_surfaces, [
      'ui/control-center.html',
      'ui/control-center.css',
      'ui/control-center.js',
      'ui/preload.cjs'
    ]);
    assert.equal(manifest.fixture.replaced_boundary, 'Electron main-process IPC responses only');
    assert.equal(manifest.inspection.pixel_review.verdict, 'fail');
    assert.equal(manifest.inspection.pixel_review.reviewer, 'automated-contract-test');
    assert.equal(manifest.inspection.summary_verdict, 'fail');
    assert.equal(manifest.ac_mapping.length, 1);
    assert.equal(manifest.ac_mapping[0].verdict, 'fail');
    assertCleanPrivacyEvidence(manifest.privacy);
  }
});

test('visual proof privacy verdicts fail when a boundary sentinel reaches rendered text or captured diagnostics', { timeout: 60_000 }, async () => {
  const renderedLeak = await runRunner(['capture', '--privacy-probe', 'rendered-transcript-body']);
  assert.equal(renderedLeak.output.status, 'privacy-probe-observed');
  assert.equal(renderedLeak.output.verdict, 'fail');
  assert.equal(renderedLeak.output.machine_verdict, 'fail');
  assert.equal(renderedLeak.output.privacy.transcript_bodies_absent, false);
  assert.equal(renderedLeak.output.privacy.raw_archive_paths_absent, true);
  assert.equal(renderedLeak.output.privacy.observations.transcript_body.fixture_boundary_observed, true);
  assert.equal(renderedLeak.output.privacy.observations.transcript_body.rendered_text_absent, false);
  assert.equal(forbiddenMarkers.some((marker) => renderedLeak.raw.includes(marker)), false);

  const diagnosticLeak = await runRunner(['capture', '--privacy-probe', 'diagnostic-archive-path']);
  assert.equal(diagnosticLeak.output.status, 'privacy-probe-observed');
  assert.equal(diagnosticLeak.output.verdict, 'fail');
  assert.equal(diagnosticLeak.output.machine_verdict, 'fail');
  assert.equal(diagnosticLeak.output.privacy.transcript_bodies_absent, true);
  assert.equal(diagnosticLeak.output.privacy.raw_archive_paths_absent, false);
  assert.equal(diagnosticLeak.output.privacy.observations.raw_archive_path.fixture_boundary_observed, true);
  assert.equal(diagnosticLeak.output.privacy.observations.raw_archive_path.captured_console_error_output_absent, false);
  assert.equal(diagnosticLeak.output.privacy.observations.raw_archive_path.renderer_console_error_absent, false);
  assert.equal(forbiddenMarkers.some((marker) => diagnosticLeak.raw.includes(marker)), false);

  const basenameLeak = await runRunner(['capture', '--privacy-probe', 'diagnostic-archive-basename']);
  assert.equal(basenameLeak.output.verdict, 'fail');
  assert.equal(basenameLeak.output.machine_verdict, 'fail');
  assert.equal(basenameLeak.output.privacy.transcript_bodies_absent, true);
  assert.equal(basenameLeak.output.privacy.raw_archive_paths_absent, false);
  assert.equal(basenameLeak.output.privacy.observations.raw_archive_path.renderer_console_error_absent, false);
  assert.equal(forbiddenMarkers.some((marker) => basenameLeak.raw.includes(marker)), false);
});
