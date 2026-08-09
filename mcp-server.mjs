#!/usr/bin/env node
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { locationFromConversationUrl } from './chatgpt-location.mjs';
import {
  CATALOG_LIST_CURSOR_PATTERN,
  parseCatalogPage,
  parseExportImportOutcome,
  parseImportCounts,
  parseImportCursor,
  parseIsoDateTime,
  parseRouteVerificationOutcome
} from './conversation-catalog-contract.mjs';
import {
  CHATGPT_CONVERSATION_ID_PATTERN,
  LIBRARY_LOCAL_ID_PATTERN,
  PROFILE_SCOPE_ID_PATTERN,
  formatConversationIdentity,
  parseConversationIdentity,
  parseProfileScopeId,
  providerConversationIdFromOwnedLocation,
  sameConversationIdentity
} from './conversation-identity.mjs';
import {
  TRANSCRIPT_CAPTURE_REASONS,
  TRANSCRIPT_PROVIDER_MESSAGE_ID_PATTERN,
  parseTranscriptTurn
} from './transcript-contract.mjs';
import {
  TRANSCRIPT_SOURCE_KEY_MAX_LENGTH,
  TRANSCRIPT_SOURCE_LABEL_MAX_LENGTH,
  TRANSCRIPT_SOURCE_TAG_MAX_LENGTH,
  TRANSCRIPT_SOURCE_TAGS_MAX_COUNT,
  parseTranscriptSourceKey,
  parseTranscriptSourceLabel,
  parseTranscriptSourceTags
} from './transcript-source-contract.mjs';
import { EXPORT_GRANT_ID_PATTERN, parseExportGrantId } from './export-import-grants.mjs';
import { defaultStateDir } from './state.mjs';
import { ensureDesktopRunning, normalizeDesktopStatus, requestJson } from './mcp-lib.mjs';
import { waitForRun } from './run-waiter.mjs';
import { resolveMcpToolProfile } from './mcp-tool-profile.mjs';
import { isSafeLibraryHttpErrorCode } from './library-http-errors.mjs';

const server = new McpServer({ name: 'agentify-desktop', version: '0.1.0' });
const stateDir = defaultStateDir();
const showTabs = process.argv.includes('--show-tabs');
const toolProfile = resolveMcpToolProfile({ argv: process.argv.slice(2) });
const enabledTools = new Set(toolProfile.tools);

function acceptedBy(parser, value) {
  try {
    parser(value);
    return true;
  } catch {
    return false;
  }
}

const transcriptSourceLabelSchema = z.string()
  .min(1).max(TRANSCRIPT_SOURCE_LABEL_MAX_LENGTH)
  .refine((value) => acceptedBy(parseTranscriptSourceLabel, value));
const transcriptSourceKeySchema = z.string()
  .min(1).max(TRANSCRIPT_SOURCE_KEY_MAX_LENGTH)
  .refine((value) => acceptedBy(parseTranscriptSourceKey, value));
const transcriptSourceTagSchema = z.string()
  .min(1).max(TRANSCRIPT_SOURCE_TAG_MAX_LENGTH);
const transcriptSourceTagsSchema = z.array(transcriptSourceTagSchema)
  .max(TRANSCRIPT_SOURCE_TAGS_MAX_COUNT)
  .refine((value) => acceptedBy(parseTranscriptSourceTags, value));

function resolveLocalPaths(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((item) => (path.isAbsolute(item) ? item : path.resolve(process.cwd(), item)));
}

function asyncQueryStructuredContent(data = {}) {
  return {
    ok: data.ok !== false,
    async: true,
    tabId: data.tabId || null,
    key: data.key || null,
    queryId: data.queryId || null,
    runId: data.runId || null,
    packedContextSummary: data.packedContextSummary || null
  };
}

function runOutputPath(run = {}, data = {}) {
  return (
    data.outputPath ||
    run?.outputManifest?.responsePath ||
    run?.researchMeta?.outputManifest?.responsePath ||
    run?.researchMeta?.outputManifest?.exportedMarkdownPath ||
    null
  );
}

function runStatusText(run = {}, data = {}) {
  if (!run) return 'Run not found.';
  const bits = [
    `runId=${run.id || ''}`,
    `status=${run.status || ''}`,
    run.phase ? `phase=${run.phase}` : null,
    run.kind ? `kind=${run.kind}` : null
  ].filter(Boolean);
  const lines = [bits.join(' ')];
  if (run.label) lines.push(`label=${run.label}`);
  if (run.detail) lines.push(`detail=${run.detail}`);
  const outputPath = runOutputPath(run, data);
  if (outputPath) lines.push(`outputPath=${outputPath}`);
  if (data.outputError) lines.push(`outputError=${data.outputError}`);
  if (typeof data.outputText === 'string') {
    const truncation = data.outputTruncated ? `\n\n[output truncated at ${data.maxOutputChars} chars]\n` : '\n';
    lines.push(`${truncation}${data.outputText}`);
  }
  return lines.join('\n');
}

function registerTool(name, def, handler) {
  if (!enabledTools.has(name)) return;
  server.registerTool(name, def, handler);
}

async function getConn() {
  return await ensureDesktopRunning({ stateDir, showTabs });
}

const TRANSCRIPT_SHA256 = /^[a-f0-9]{64}$/;
const TRANSCRIPT_ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const transcriptIdentitySchema = z.object({
  provider: z.literal('chatgpt'),
  profileScopeId: z.string().regex(PROFILE_SCOPE_ID_PATTERN),
  providerConversationId: z.string().regex(CHATGPT_CONVERSATION_ID_PATTERN)
}).strict();

const transcriptSnapshotRefSchema = z.object({
  kind: z.literal('snapshot'),
  algorithm: z.literal('sha256'),
  hash: z.string().regex(TRANSCRIPT_SHA256),
  contentHash: z.string().regex(TRANSCRIPT_SHA256),
  byteLength: z.number().int().positive().safe()
}).strict();

const transcriptOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('complete'),
    snapshot: transcriptSnapshotRefSchema,
    changed: z.boolean()
  }).strict(),
  z.object({
    kind: z.literal('partial'),
    reason: z.enum(TRANSCRIPT_CAPTURE_REASONS)
  }).strict(),
  z.object({
    kind: z.literal('failed'),
    reason: z.enum([
      'login',
      'challenge',
      'tab_closed',
      'navigation_failed',
      'provider_transport',
      'compatibility_drift',
      'capture_failed',
      'snapshot_write_failed'
    ])
  }).strict(),
  z.object({ kind: z.literal('interrupted') }).strict()
]);

const transcriptAttemptSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(LIBRARY_LOCAL_ID_PATTERN),
  sourceId: z.string().regex(LIBRARY_LOCAL_ID_PATTERN),
  trigger: z.enum(['manual', 'post-query']),
  startedAt: z.string().regex(TRANSCRIPT_ISO_DATE_TIME),
  finishedAt: z.string().regex(TRANSCRIPT_ISO_DATE_TIME).nullable(),
  outcome: transcriptOutcomeSchema.nullable()
}).strict();

const transcriptLocationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('standalone-conversation'),
    conversationUrl: z.string().url(),
    sourceUrl: z.string().url().optional()
  }).strict(),
  z.object({
    kind: z.literal('project-conversation'),
    projectUrl: z.string().url(),
    conversationUrl: z.string().url(),
    sourceUrl: z.string().url().optional()
  }).strict()
]);

const transcriptSourceSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(LIBRARY_LOCAL_ID_PATTERN),
  identity: transcriptIdentitySchema,
  label: transcriptSourceLabelSchema,
  tags: transcriptSourceTagsSchema,
  key: transcriptSourceKeySchema,
  target: z.object({
    kind: z.literal('owned-conversation'),
    location: transcriptLocationSchema
  }).strict(),
  enabled: z.boolean(),
  state: z.enum(['disabled', 'syncing', 'tracked', 'complete', 'partial', 'failed', 'interrupted']),
  latestLiveSnapshot: transcriptSnapshotRefSchema.nullable(),
  lastAttempt: transcriptAttemptSchema.nullable(),
  createdAt: z.string().regex(TRANSCRIPT_ISO_DATE_TIME),
  updatedAt: z.string().regex(TRANSCRIPT_ISO_DATE_TIME)
}).strict();

const transcriptSyncResultSchema = z.object({
  source: transcriptSourceSchema,
  attempt: transcriptAttemptSchema,
  status: z.enum(['complete', 'partial', 'failed', 'interrupted']),
  outcome: transcriptOutcomeSchema
}).strict();

const transcriptDeletionSchema = z.object({
  sourceId: z.string().regex(LIBRARY_LOCAL_ID_PATTERN),
  recoverable: z.literal(true),
  recoveryLocation: z.string().refine((value) =>
    value.startsWith('local-trash/') && LIBRARY_LOCAL_ID_PATTERN.test(value.slice('local-trash/'.length))),
  forgottenAt: z.string().regex(TRANSCRIPT_ISO_DATE_TIME)
}).strict();

const transcriptCursorSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotHash: z.string().regex(TRANSCRIPT_SHA256),
  afterTurnId: z.string().min(1).max(600).refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
}).strict();

const transcriptTurnIdentitySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('provider'),
    providerMessageId: z.string().regex(TRANSCRIPT_PROVIDER_MESSAGE_ID_PATTERN)
  }).strict(),
  z.object({
    kind: z.literal('snapshot-local'),
    ordinal: z.number().int().nonnegative().safe(),
    turnContentHash: z.string().regex(TRANSCRIPT_SHA256)
  }).strict()
]);

const transcriptTurnSchema = z.object({
  turnId: z.string().min(1).max(600).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  ordinal: z.number().int().nonnegative().safe(),
  identity: transcriptTurnIdentitySchema,
  role: z.enum(['user', 'assistant', 'system', 'tool', 'unknown']),
  rawRole: z.string().min(1).max(64).nullable(),
  text: z.string().min(1).max(1_000_000)
}).strict();

const transcriptCitationSchema = z.object({
  identity: z.string().min(1).max(700),
  snapshotHash: z.string().regex(TRANSCRIPT_SHA256),
  turnId: z.string().min(1).max(600)
}).strict();

const transcriptPageSchema = z.object({
  schemaVersion: z.literal(1),
  identity: transcriptIdentitySchema,
  snapshot: transcriptSnapshotRefSchema,
  normalizationVersion: z.literal(1),
  capturedAt: z.string().regex(TRANSCRIPT_ISO_DATE_TIME),
  startOrdinal: z.number().int().nonnegative().safe(),
  endOrdinal: z.number().int().positive().safe(),
  totalTurns: z.number().int().positive().safe(),
  text: z.string().min(1).max(1_000_000),
  structuredTurns: z.array(transcriptTurnSchema).min(1).max(100),
  citations: z.array(transcriptCitationSchema).min(1).max(100),
  nextCursor: transcriptCursorSchema.nullable(),
  liveSourceId: z.string().regex(LIBRARY_LOCAL_ID_PATTERN).nullable(),
  sourceKey: transcriptSourceKeySchema.nullable(),
  conversationUrl: z.string().url().nullable(),
  paths: z.object({
    snapshot: z.string().min(1).max(4096).refine((value) => path.isAbsolute(value))
  }).strict().optional()
}).strict();

const catalogRawRecordRefSchema = z.object({
  kind: z.literal('raw'),
  algorithm: z.literal('sha256'),
  hash: z.string().regex(TRANSCRIPT_SHA256),
  byteLength: z.number().int().positive().safe()
}).strict();

const catalogImportCursorSchema = z.object({
  schemaVersion: z.literal(1),
  recordIndex: z.number().int().nonnegative().safe()
}).strict();

const catalogCountsSchema = z.object({
  recordsSeen: z.number().int().nonnegative().safe(),
  cataloged: z.number().int().nonnegative().safe(),
  snapshots: z.number().int().nonnegative().safe(),
  problems: z.number().int().nonnegative().safe()
}).strict();

const catalogProblemSchema = z.object({
  recordIndex: z.number().int().nonnegative().safe(),
  reason: z.enum([
    'provider-id-missing',
    'active-branch-ambiguous',
    'message-graph-invalid',
    'unsupported-content'
  ]),
  identity: transcriptIdentitySchema.nullable()
}).strict();

const catalogImportOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('complete'),
    importId: z.string().regex(LIBRARY_LOCAL_ID_PATTERN),
    counts: catalogCountsSchema
  }).strict(),
  z.object({
    status: z.literal('partial'),
    importId: z.string().regex(LIBRARY_LOCAL_ID_PATTERN),
    counts: catalogCountsSchema,
    problems: z.array(catalogProblemSchema).min(1).max(10_000),
    resume: catalogImportCursorSchema
  }).strict(),
  z.object({
    status: z.literal('rejected'),
    reason: z.enum([
      'not-a-zip',
      'unsupported-export',
      'unsafe-archive',
      'scope-confirmation-required',
      'account-hint-conflict'
    ])
  }).strict()
]);

const exportGrantOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('cancelled') }).strict(),
  z.object({
    status: z.literal('granted'),
    grant: z.object({
      grantId: z.string().regex(EXPORT_GRANT_ID_PATTERN),
      profileScopeId: z.string().regex(PROFILE_SCOPE_ID_PATTERN),
      expiresAt: z.string().regex(TRANSCRIPT_ISO_DATE_TIME)
    }).strict()
  }).strict()
]);

const catalogImportSummarySchema = z.object({
  schemaVersion: z.literal(1),
  importId: z.string().regex(LIBRARY_LOCAL_ID_PATTERN),
  profileScopeId: z.string().regex(PROFILE_SCOPE_ID_PATTERN),
  status: z.enum(['open', 'complete', 'partial']),
  readOnlyReason: z.literal('legacy-record-limit').nullable(),
  cursor: catalogImportCursorSchema,
  counts: catalogCountsSchema,
  suspension: z.object({
    reason: z.enum(['interrupted', 'scope-reassigned']),
    observedAt: z.string().regex(TRANSCRIPT_ISO_DATE_TIME)
  }).strict().nullable(),
  createdAt: z.string().regex(TRANSCRIPT_ISO_DATE_TIME),
  updatedAt: z.string().regex(TRANSCRIPT_ISO_DATE_TIME)
}).strict();

const catalogImportSummaryPageSchema = z.object({
  items: z.array(catalogImportSummarySchema).max(100),
  truncated: z.boolean()
}).strict();

const catalogReassignmentSchema = z.object({
  importId: z.string().regex(LIBRARY_LOCAL_ID_PATTERN),
  changed: z.boolean(),
  previousProfileScopeId: z.string().regex(PROFILE_SCOPE_ID_PATTERN),
  profileScopeId: z.string().regex(PROFILE_SCOPE_ID_PATTERN),
  cursor: catalogImportCursorSchema
}).strict();

const catalogRouteSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('unverified'),
    claimedConversationId: z.string().regex(CHATGPT_CONVERSATION_ID_PATTERN)
  }).strict(),
  z.object({
    kind: z.literal('verified'),
    canonicalUrl: z.string().url(),
    verifiedAt: z.string().regex(TRANSCRIPT_ISO_DATE_TIME),
    evidence: z.enum(['tracked-tab', 'direct-navigation'])
  }).strict(),
  z.object({
    kind: z.literal('temporarily-unavailable'),
    previousUrl: z.string().url().nullable(),
    observedAt: z.string().regex(TRANSCRIPT_ISO_DATE_TIME),
    reason: z.enum(['not-found', 'forbidden', 'foreign-profile', 'challenge']),
    retryable: z.boolean()
  }).strict()
]);

const catalogConversationSchema = z.object({
  schemaVersion: z.literal(1),
  identity: transcriptIdentitySchema,
  title: z.string().min(1).max(512).nullable(),
  route: catalogRouteSchema,
  firstObservedAt: z.string().regex(TRANSCRIPT_ISO_DATE_TIME),
  lastObservedAt: z.string().regex(TRANSCRIPT_ISO_DATE_TIME),
  latestArchiveRecord: catalogRawRecordRefSchema,
  latestImportedSnapshot: transcriptSnapshotRefSchema.nullable()
}).strict();

const catalogPageSchema = z.object({
  items: z.array(catalogConversationSchema).max(100),
  nextCursor: z.string().regex(CATALOG_LIST_CURSOR_PATTERN).nullable()
}).strict();

const catalogVerificationSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('verified'),
    identity: transcriptIdentitySchema,
    canonicalUrl: z.string().url(),
    evidence: z.literal('direct-navigation')
  }).strict(),
  z.object({
    status: z.literal('unavailable'),
    identity: transcriptIdentitySchema,
    observation: z.object({
      observedAt: z.string().regex(TRANSCRIPT_ISO_DATE_TIME),
      reason: z.enum(['not-found', 'forbidden', 'foreign-profile', 'challenge']),
      retryable: z.boolean()
    }).strict()
  }).strict(),
  z.object({
    status: z.literal('failed'),
    reason: z.enum(['login', 'challenge', 'transport', 'compatibility-drift'])
  }).strict()
]);

function transcriptMcpError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeTranscriptHttpError(error) {
  const body = error?.data?.body;
  if (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    isSafeLibraryHttpErrorCode(body.error)
  ) {
    return body.error;
  }
  return 'transcript_mcp_request_failed';
}

async function requestTranscriptJson({ method, path, body }) {
  try {
    const conn = await getConn();
    return await requestJson({ ...conn, method, path, body });
  } catch (error) {
    throw transcriptMcpError(safeTranscriptHttpError(error));
  }
}

function parseTranscriptResponse(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw transcriptMcpError('transcript_mcp_response_invalid');
  return parsed.data;
}

function isCanonicalTranscriptDateTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validateTranscriptAttempt(attempt) {
  if (attempt === null) return;
  if (
    !isCanonicalTranscriptDateTime(attempt.startedAt) ||
    (attempt.finishedAt === null) !== (attempt.outcome === null) ||
    (attempt.finishedAt !== null && !isCanonicalTranscriptDateTime(attempt.finishedAt))
  ) {
    throw transcriptMcpError('transcript_mcp_response_invalid');
  }
}

function validateTranscriptSource(source) {
  try {
    const identity = parseConversationIdentity(source.identity);
    const observed = locationFromConversationUrl(source.target.location.conversationUrl, {
      sourceUrl: source.target.location.sourceUrl || null
    });
    const expected = source.target.location;
    if (
      observed.kind !== expected.kind ||
      observed.conversationUrl !== expected.conversationUrl ||
      (observed.projectUrl || null) !== (expected.projectUrl || null) ||
      (observed.sourceUrl || null) !== (expected.sourceUrl || null) ||
      providerConversationIdFromOwnedLocation(observed) !== identity.providerConversationId
    ) {
      throw transcriptMcpError('transcript_mcp_response_invalid');
    }
  } catch {
    throw transcriptMcpError('transcript_mcp_response_invalid');
  }
  validateTranscriptAttempt(source.lastAttempt);
  const expectedState = !source.enabled
    ? 'disabled'
    : source.lastAttempt?.outcome === null
      ? 'syncing'
      : source.lastAttempt?.outcome?.kind || 'tracked';
  if (
    source.state !== expectedState ||
    (source.lastAttempt !== null && source.lastAttempt.sourceId !== source.id) ||
    !isCanonicalTranscriptDateTime(source.createdAt) ||
    !isCanonicalTranscriptDateTime(source.updatedAt) ||
    (source.lastAttempt === null && source.latestLiveSnapshot !== null) ||
    (
      source.lastAttempt?.outcome?.kind === 'complete' &&
      JSON.stringify(source.lastAttempt.outcome.snapshot) !== JSON.stringify(source.latestLiveSnapshot)
    )
  ) {
    throw transcriptMcpError('transcript_mcp_response_invalid');
  }
  return source;
}

function parseTranscriptSourceResponse(value) {
  return validateTranscriptSource(parseTranscriptResponse(transcriptSourceSchema, value));
}

function safeTranscriptAttempt(attempt) {
  if (attempt === null) return null;
  return {
    schemaVersion: attempt.schemaVersion,
    id: attempt.id,
    sourceId: attempt.sourceId,
    trigger: attempt.trigger,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    outcome: attempt.outcome
  };
}

function safeTranscriptSource(source) {
  return {
    schemaVersion: source.schemaVersion,
    id: source.id,
    identity: source.identity,
    enabled: source.enabled,
    state: source.state,
    latestLiveSnapshot: source.latestLiveSnapshot,
    lastAttempt: safeTranscriptAttempt(source.lastAttempt),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt
  };
}

function parseTranscriptSyncResponse(value) {
  const result = parseTranscriptResponse(transcriptSyncResultSchema, value);
  validateTranscriptSource(result.source);
  validateTranscriptAttempt(result.attempt);
  if (
    result.status !== result.outcome.kind ||
    result.attempt.outcome === null ||
    result.attempt.outcome.kind !== result.status ||
    JSON.stringify(result.attempt.outcome) !== JSON.stringify(result.outcome) ||
    result.attempt.sourceId !== result.source.id ||
    result.source.lastAttempt?.id !== result.attempt.id ||
    JSON.stringify(result.source.lastAttempt) !== JSON.stringify(result.attempt)
  ) {
    throw transcriptMcpError('transcript_mcp_response_invalid');
  }
  return result;
}

function sameTranscriptSnapshotRef(left, right) {
  return !!left && !!right &&
    left.kind === right.kind &&
    left.algorithm === right.algorithm &&
    left.hash === right.hash &&
    left.contentHash === right.contentHash &&
    left.byteLength === right.byteLength;
}

function expectedTranscriptTurnId(turn) {
  return turn.identity.kind === 'provider'
    ? `provider:${turn.identity.providerMessageId}`
    : `snapshot-local:${turn.ordinal}:${turn.identity.turnContentHash}`;
}

function renderTranscriptPageTurns(turns) {
  const labels = { user: 'User', assistant: 'Assistant', system: 'System', tool: 'Tool', unknown: 'Unknown' };
  return turns.map((turn) => `${labels[turn.role]}\n${turn.text}`).join('\n\n');
}

function validateTranscriptPageTurns(turns, startOrdinal) {
  const providerMessageIds = new Set();
  for (let index = 0; index < turns.length; index += 1) {
    let turn;
    try {
      turn = parseTranscriptTurn(turns[index], startOrdinal + index);
    } catch {
      throw transcriptMcpError('transcript_mcp_response_invalid');
    }
    if (turn.identity.kind === 'provider') {
      if (providerMessageIds.has(turn.identity.providerMessageId)) {
        throw transcriptMcpError('transcript_mcp_response_invalid');
      }
      providerMessageIds.add(turn.identity.providerMessageId);
    }
  }
}

function parseTranscriptPageResponse(value, request) {
  const page = parseTranscriptResponse(transcriptPageSchema, value);
  validateTranscriptPageTurns(page.structuredTurns, page.startOrdinal);
  const identity = parseConversationIdentity(request.identity);
  const identityKey = formatConversationIdentity(identity);
  const hasLiveSource = page.liveSourceId !== null || page.sourceKey !== null || page.conversationUrl !== null;
  if (
    !sameConversationIdentity(page.identity, identity) ||
    !isCanonicalTranscriptDateTime(page.capturedAt) ||
    page.endOrdinal !== page.startOrdinal + page.structuredTurns.length ||
    page.endOrdinal > page.totalTurns ||
    page.structuredTurns.length > (request.limit ?? 20) ||
    page.citations.length !== page.structuredTurns.length ||
    page.text !== renderTranscriptPageTurns(page.structuredTurns) ||
    (request.snapshot !== undefined && !sameTranscriptSnapshotRef(page.snapshot, request.snapshot)) ||
    (request.cursor !== undefined && request.cursor.snapshotHash !== page.snapshot.hash) ||
    (request.cursor === undefined && page.startOrdinal !== 0) ||
    (request.cursor !== undefined && page.startOrdinal === 0) ||
    (request.includePaths === true) !== (page.paths !== undefined) ||
    (hasLiveSource && (page.liveSourceId === null || page.sourceKey === null || page.conversationUrl === null)) ||
    (!hasLiveSource && (page.liveSourceId !== null || page.sourceKey !== null || page.conversationUrl !== null))
  ) {
    throw transcriptMcpError('transcript_mcp_response_invalid');
  }
  for (let index = 0; index < page.structuredTurns.length; index += 1) {
    const turn = page.structuredTurns[index];
    const citation = page.citations[index];
    if (
      turn.ordinal !== page.startOrdinal + index ||
      (turn.identity.kind === 'snapshot-local' && turn.identity.ordinal !== turn.ordinal) ||
      turn.turnId !== expectedTranscriptTurnId(turn) ||
      citation.identity !== identityKey ||
      citation.snapshotHash !== page.snapshot.hash ||
      citation.turnId !== turn.turnId
    ) {
      throw transcriptMcpError('transcript_mcp_response_invalid');
    }
  }
  if (
    page.endOrdinal < page.totalTurns
      ? !page.nextCursor ||
        page.nextCursor.snapshotHash !== page.snapshot.hash ||
        page.nextCursor.afterTurnId !== page.structuredTurns.at(-1).turnId
      : page.nextCursor !== null
  ) {
    throw transcriptMcpError('transcript_mcp_response_invalid');
  }
  if (hasLiveSource) {
    try {
      const observed = locationFromConversationUrl(page.conversationUrl);
      if (providerConversationIdFromOwnedLocation(observed) !== identity.providerConversationId) {
        throw transcriptMcpError('transcript_mcp_response_invalid');
      }
    } catch {
      throw transcriptMcpError('transcript_mcp_response_invalid');
    }
  }
  return page;
}

function parseCatalogImportResponse(value) {
  const shaped = parseTranscriptResponse(catalogImportOutcomeSchema, value);
  try {
    return parseExportImportOutcome(shaped);
  } catch {
    throw transcriptMcpError('transcript_mcp_response_invalid');
  }
}

function parseExportGrantResponse(value, expectedProfileScopeId) {
  const shaped = parseTranscriptResponse(exportGrantOutcomeSchema, value);
  if (shaped.status === 'cancelled') return shaped;
  try {
    parseExportGrantId(shaped.grant.grantId);
    const profileScopeId = parseProfileScopeId(shaped.grant.profileScopeId);
    parseIsoDateTime(shaped.grant.expiresAt, 'grant.expiresAt');
    if (profileScopeId !== expectedProfileScopeId) throw new Error('grant_scope_mismatch');
  } catch {
    throw transcriptMcpError('transcript_mcp_response_invalid');
  }
  return shaped;
}

function parseCatalogImportSummaryPageResponse(value) {
  const shaped = parseTranscriptResponse(catalogImportSummaryPageSchema, value);
  try {
    for (const catalogImport of shaped.items) {
      parseProfileScopeId(catalogImport.profileScopeId);
      parseImportCursor(catalogImport.cursor);
      parseImportCounts(catalogImport.counts);
      parseIsoDateTime(catalogImport.createdAt, 'createdAt');
      parseIsoDateTime(catalogImport.updatedAt, 'updatedAt');
      if (catalogImport.suspension) {
        parseIsoDateTime(catalogImport.suspension.observedAt, 'suspension.observedAt');
        if (catalogImport.status !== 'partial') throw new Error('invalid_suspension_status');
      }
      if (catalogImport.readOnlyReason !== null && catalogImport.status === 'open') {
        throw new Error('invalid_read_only_status');
      }
    }
  } catch {
    throw transcriptMcpError('transcript_mcp_response_invalid');
  }
  return shaped;
}

function parseCatalogReassignmentResponse(value, { importId, newProfileScopeId }) {
  const shaped = parseTranscriptResponse(catalogReassignmentSchema, value);
  try {
    parseImportCursor(shaped.cursor);
    if (shaped.importId !== importId || shaped.profileScopeId !== newProfileScopeId) {
      throw new Error('reassignment_mismatch');
    }
    if (
      (shaped.changed && shaped.previousProfileScopeId === shaped.profileScopeId) ||
      (!shaped.changed && shaped.previousProfileScopeId !== shaped.profileScopeId)
    ) {
      throw new Error('reassignment_state_mismatch');
    }
  } catch {
    throw transcriptMcpError('transcript_mcp_response_invalid');
  }
  return shaped;
}

function catalogImportToolResult(outcome) {
  const counts = outcome.status === 'rejected'
    ? ''
    : ` records=${outcome.counts.recordsSeen} snapshots=${outcome.counts.snapshots} problems=${outcome.counts.problems}`;
  const detail = outcome.status === 'rejected' ? ` reason=${outcome.reason}` : ` importId=${outcome.importId}${counts}`;
  return {
    content: [{ type: 'text', text: `status=${outcome.status}${detail}` }],
    structuredContent: outcome,
    isError: outcome.status === 'rejected'
  };
}

function parseCatalogPageResponse(value) {
  const shaped = parseTranscriptResponse(catalogPageSchema, value);
  try {
    return parseCatalogPage(shaped);
  } catch {
    throw transcriptMcpError('transcript_mcp_response_invalid');
  }
}

function parseCatalogVerificationResponse(value, expectedIdentity) {
  const shaped = parseTranscriptResponse(catalogVerificationSchema, value);
  let outcome;
  try {
    outcome = parseRouteVerificationOutcome(shaped);
  } catch {
    throw transcriptMcpError('transcript_mcp_response_invalid');
  }
  if (outcome.status !== 'failed' && !sameConversationIdentity(outcome.identity, expectedIdentity)) {
    throw transcriptMcpError('transcript_mcp_response_invalid');
  }
  return outcome;
}

registerTool(
  'agentify_query',
  {
    description:
      'Send a prompt to the local Agentify Desktop session and return the assistant response. To continue a Transcript Library source, pass its returned liveSourceId, sourceKey as key, and conversationUrl as chatUrl. For long work, set fireAndForget=true, then pass the returned runId to agentify_wait_run; use agentify_get_run only for a non-blocking status snapshot.',
    inputSchema: {
      model: z.string().optional().describe('Target vendor hint for tab selection (e.g., "chatgpt" or "claude"); does not switch the provider UI model picker.'),
      tabId: z.string().optional().describe('Tab/session id to use (for parallel jobs).'),
      key: z.string().optional().describe('Stable tab key (e.g., project name); creates a tab if missing.'),
      chatUrl: z.string().optional().describe('ChatGPT conversation or shared-chat URL to continue. Mutually exclusive with projectUrl; suppresses saved/default project routing.'),
      liveSourceId: z.string().regex(LIBRARY_LOCAL_ID_PATTERN).optional()
        .describe('Tracked Transcript Library source id returned with sourceKey and conversationUrl; enables fail-closed live continuation validation.'),
      projectUrl: z.string().optional().describe('ChatGPT Project URL (e.g., https://chatgpt.com/g/g-p-{id}/project). Routes conversations into the project.'),
      modeIntent: z.string().optional().describe('ChatGPT mode intent for this tab/query. Supported intents: extended-pro (Pro Extended), thinking (Medium), instant. This is separate from the vendor `model` hint.'),
      modelIntent: z.string().optional().describe('Optional explicit ChatGPT generation intent for this query only. Supported intents: gpt-5.5-pro, gpt-5.4-pro. Any other value is rejected before sending rather than ignored, so a successful run always means the requested generation was applied. Omit to leave the picker as-is. The controller also fails closed when the UI cannot confirm the requested generation.'),
      bundleName: z.string().optional().describe('Named context bundle to merge into this query before sending.'),
      prompt: z.string().describe('Prompt to send to ChatGPT.'),
      promptPrefix: z.string().optional().describe('Optional reusable instruction block prepended before packed context and prompt.'),
      attachments: z.array(z.string()).optional().describe('Local file paths to upload before sending the prompt.'),
      contextPaths: z.array(z.string()).optional().describe('Local files/folders to pack into the prompt and/or attach automatically.'),
      maxContextChars: z.number().optional().describe('Maximum packed inline context characters to add before the prompt.'),
      maxContextFiles: z.number().optional().describe('Maximum number of files to scan from contextPaths.'),
      maxContextFileChars: z.number().optional().describe('Maximum sampled characters per text file before chunking.'),
      maxContextChunkChars: z.number().optional().describe('Maximum characters per inline chunk when a text file is split.'),
      maxContextChunksPerFile: z.number().optional().describe('Maximum number of chunks to inline for any single file.'),
      maxContextInlineFiles: z.number().optional().describe('Maximum number of text files to inline into the prompt.'),
      maxContextAttachments: z.number().optional().describe('Maximum binary/image files auto-attached from contextPaths.'),
      timeoutMs: z.number().optional().describe('Soft response-observation deadline. Agentify continues listening after this deadline; it does not prove provider failure.'),
      fireAndForget: z.boolean().optional().describe('Return a runId immediately. Next call agentify_wait_run to await proven completion, or agentify_get_run for a non-blocking snapshot.')
    }
  },
  async ({
    model,
    tabId,
    key,
    chatUrl,
    liveSourceId,
    projectUrl,
    modeIntent,
    modelIntent,
    bundleName,
    prompt,
    promptPrefix,
    attachments,
    contextPaths,
    maxContextChars,
    maxContextFiles,
    maxContextFileChars,
    maxContextChunkChars,
    maxContextChunksPerFile,
    maxContextInlineFiles,
    maxContextAttachments,
    timeoutMs,
    fireAndForget
  }) => {
    const resolvedAttachments = resolveLocalPaths(attachments || []);
    const resolvedContextPaths = resolveLocalPaths(contextPaths || []);
    let effectiveKey = key || (fireAndForget && !chatUrl ? `async-${Date.now().toString(36)}` : undefined);
    if (liveSourceId !== undefined) {
      try {
        effectiveKey = parseTranscriptSourceKey(key);
      } catch {
        throw transcriptMcpError('conversation-not-live-bound');
      }
    }
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/query',
      body: {
        source: 'mcp',
        model,
        tabId,
        key: effectiveKey,
        chatUrl,
        liveSourceId,
        projectUrl,
        modeIntent,
        modelIntent,
        bundleName,
        prompt,
        promptPrefix,
        attachments: resolvedAttachments,
        contextPaths: resolvedContextPaths,
        maxContextChars: maxContextChars || undefined,
        maxContextFiles: maxContextFiles || undefined,
        maxContextFileChars: maxContextFileChars || undefined,
        maxContextChunkChars: maxContextChunkChars || undefined,
        maxContextChunksPerFile: maxContextChunksPerFile || undefined,
        maxContextInlineFiles: maxContextInlineFiles || undefined,
        maxContextAttachments: maxContextAttachments || undefined,
        timeoutMs: timeoutMs || 10 * 60_000,
        fireAndForget: fireAndForget || undefined
      }
    });
    if (data.async) {
      const structuredContent = asyncQueryStructuredContent(data);
      return {
        content: [{ type: 'text', text: `Query submitted. runId=${structuredContent.runId || ''}. Next: call agentify_wait_run with this runId for proven completion. Use agentify_get_run only for a non-blocking snapshot.` }],
        structuredContent
      };
    }
    const structuredContent = {
      runId: data.runId || null,
      text: data.result?.text || '',
      codeBlocks: data.result?.codeBlocks || [],
      meta: data.result?.meta || null,
      packedContext: data.packedContext || null,
      packedContextSummary: data.packedContextSummary || data.packedContext?.summary || null,
      bundle: data.bundle || null
    };
    return {
      content: [{ type: 'text', text: structuredContent.text }],
      structuredContent: { tabId: data.tabId || tabId || null, ...structuredContent }
    };
  }
);

registerTool(
  'agentify_research',
  {
    description:
      'Start ChatGPT Deep Research asynchronously and return a durable runId. Next call agentify_wait_run with that runId for receipt-backed completion; agentify_get_run is snapshot-only.',
    inputSchema: {
      tabId: z.string().optional().describe('Tab/session id to use. Must point to a ChatGPT tab if provided.'),
      key: z.string().optional().describe('Stable tab key (e.g., project name); creates a ChatGPT tab if missing.'),
      projectUrl: z.string().optional().describe('ChatGPT Project URL (e.g., https://chatgpt.com/g/g-p-{id}/project). Routes conversations into the project.'),
      bundleName: z.string().optional().describe('Named context bundle to merge into this research request before sending.'),
      prompt: z.string().describe('Full prompt to send to ChatGPT Deep Research.'),
      attachments: z.array(z.string()).optional().describe('Local file paths to upload before sending the prompt.'),
      contextPaths: z.array(z.string()).optional().describe('Local files/folders to pack into the prompt and/or attach automatically.'),
      timeoutMs: z.number().optional().describe('Soft observation deadline; research continues under service supervision after it elapses.')
    }
  },
  async ({ tabId, key, projectUrl, bundleName, prompt, attachments, contextPaths, timeoutMs }) => {
    const resolvedAttachments = resolveLocalPaths(attachments || []);
    const resolvedContextPaths = resolveLocalPaths(contextPaths || []);
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/research',
      body: {
        source: 'mcp',
        tabId,
        key,
        projectUrl,
        bundleName,
        prompt,
        attachments: resolvedAttachments,
        contextPaths: resolvedContextPaths,
        timeoutMs: timeoutMs || undefined
      }
    });
    return {
      content: [{ type: 'text', text: `Research submitted. runId=${data.runId || ''}. Next: call agentify_wait_run with this runId for receipt-backed completion.` }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_read_page',
  {
    description: 'Read text content from the active tab in the local Agentify Desktop window.',
    inputSchema: {
      model: z.string().optional().describe('Target vendor hint for tab selection (e.g., "chatgpt" or "claude"); does not switch the provider UI model picker.'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      maxChars: z.number().optional().describe('Maximum characters to return.')
    }
  },
  async ({ model, tabId, key, maxChars }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/read-page',
      body: { model, tabId, key, maxChars: maxChars || 200_000 }
    });
    return { content: [{ type: 'text', text: data.text || '' }] };
  }
);

registerTool(
  'agentify_read_conversation',
  {
    description:
      'Read a complete ChatGPT conversation and inventory attached file cards. Pass chatUrl to read a specific conversation; Agentify navigates there read-only and never sends a prompt, so reading cannot add a turn. Without chatUrl the active tab is read. Agentify scrolls through virtualized turns and reports complete=false with a reason when it cannot return the full transcript. artifactInventory has its own complete/partial status because file-card coverage is independent from transcript text coverage. reason=leading_turn_missing means the scroll reached the top and the provider never served the opening turn, so retrying returns the same capture -- recover that conversation with agentify_import_selected_chatgpt_export instead.',
    inputSchema: {
      model: z.string().optional().describe('Target vendor hint for tab selection. Use ChatGPT for complete conversation capture.'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      chatUrl: z.string().optional().describe('ChatGPT conversation or shared-chat URL to read. Navigates the tab before capturing, without sending anything to the conversation.'),
      maxChars: z.number().optional().describe('Maximum transcript characters to return.')
    }
  },
  async ({ model, tabId, key, chatUrl, maxChars }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/read-conversation',
      body: { model, tabId, key, chatUrl, maxChars: maxChars || 200_000 }
    });
    return {
      content: [{ type: 'text', text: data.text || '' }],
      structuredContent: data,
      isError: data.complete === false && data.reason !== 'max_chars'
    };
  }
);

registerTool(
  'agentify_download_conversation_artifacts',
  {
    description:
      'Download selected file artifacts from anywhere in a ChatGPT conversation. First call agentify_read_conversation and pass artifactKey values from artifactInventory. Agentify uses the authenticated browser session, saves files to its local artifact store without opening a native Save dialog, and returns one outcome per requested key.',
    inputSchema: {
      model: z.string().optional().describe('Target vendor hint for tab selection. Use ChatGPT.'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      chatUrl: z.string().optional().describe('Canonical ChatGPT conversation URL containing the inventoried artifacts.'),
      artifactKeys: z.array(z.string()).describe('Stable artifactKey values returned by agentify_read_conversation.'),
      maxFiles: z.number().optional().describe('Maximum selected files to process. Default 6, maximum 50.'),
      maxBytesPerFile: z.number().optional().describe('Maximum bytes allowed for each file. Default 100 MiB, maximum 1 GiB.'),
      timeoutMs: z.number().optional().describe('Per-file download timeout in milliseconds. Default 20000, maximum 120000.')
    }
  },
  async ({ model, tabId, key, chatUrl, artifactKeys, maxFiles, maxBytesPerFile, timeoutMs }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/conversation-artifacts/download',
      body: {
        model,
        tabId,
        key,
        chatUrl,
        artifactKeys,
        maxFiles: maxFiles || 6,
        maxBytesPerFile: maxBytesPerFile || 100 * 1024 * 1024,
        timeoutMs: timeoutMs || 20_000
      }
    });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          requestedCount: data.requestedCount || 0,
          savedCount: data.savedCount || 0,
          outcomes: data.outcomes || []
        }, null, 2)
      }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_import_selected_chatgpt_export',
  {
    description: 'Open Agentify Desktop\'s native ZIP picker for human selection, then import the selected ChatGPT export without returning its path or one-use grant to the agent.',
    inputSchema: z.object({
      profileScopeId: z.string().regex(PROFILE_SCOPE_ID_PATTERN)
        .describe('Stable local ChatGPT profile scope confirmed for this import.')
    }).strict()
  },
  async ({ profileScopeId }) => {
    const grantOutcome = parseExportGrantResponse(await requestTranscriptJson({
      method: 'POST',
      path: '/catalog/export-grant',
      body: { profileScopeId }
    }), profileScopeId);
    if (grantOutcome.status === 'cancelled') {
      return {
        content: [{ type: 'text', text: 'status=cancelled' }],
        structuredContent: grantOutcome
      };
    }
    const outcome = parseCatalogImportResponse(await requestTranscriptJson({
      method: 'POST',
      path: '/catalog/import',
      body: { grantId: grantOutcome.grant.grantId, profileScopeId }
    }));
    return catalogImportToolResult(outcome);
  }
);

registerTool(
  'agentify_import_chatgpt_export',
  {
    description: 'Consume an existing one-use ChatGPT export grant. For the normal agent workflow, use agentify_import_selected_chatgpt_export so the human can choose the ZIP in the native picker.',
    inputSchema: z.object({
      grantId: z.string().regex(EXPORT_GRANT_ID_PATTERN)
        .describe('One-use grant id returned by the Agentify Desktop file picker.'),
      profileScopeId: z.string().regex(PROFILE_SCOPE_ID_PATTERN)
        .describe('The same local ChatGPT profile scope confirmed in the picker.')
    }).strict()
  },
  async ({ grantId, profileScopeId }) => {
    const outcome = parseCatalogImportResponse(await requestTranscriptJson({
      method: 'POST',
      path: '/catalog/import',
      body: { grantId, profileScopeId }
    }));
    return catalogImportToolResult(outcome);
  }
);

registerTool(
  'agentify_list_chatgpt_imports',
  {
    description: 'List the latest bounded ChatGPT import and recovery summaries without archive paths, raw records, transcript text, or account hints.',
    inputSchema: z.object({}).strict()
  },
  async () => {
    const page = parseCatalogImportSummaryPageResponse(await requestTranscriptJson({
      method: 'GET',
      path: '/catalog/imports'
    }));
    const partial = page.items.filter(({ status }) => status === 'partial').length;
    const suspended = page.items.filter(({ suspension }) => suspension !== null).length;
    return {
      content: [{ type: 'text', text: `count=${page.items.length} partial=${partial} suspended=${suspended}${page.truncated ? ' truncated=true' : ''}` }],
      structuredContent: page
    };
  }
);

registerTool(
  'agentify_reassign_chatgpt_import',
  {
    description: 'Reassign one ChatGPT import to a different local profile scope. Confirmation clears imported snapshots and requires selecting the same ZIP again.',
    inputSchema: z.object({
      importId: z.string().regex(LIBRARY_LOCAL_ID_PATTERN).describe('Catalog import id.'),
      newProfileScopeId: z.string().regex(PROFILE_SCOPE_ID_PATTERN).describe('Confirmed replacement local profile scope.'),
      confirm: z.literal(true).describe('Must be true to confirm scope reassignment and snapshot clearing.')
    }).strict()
  },
  async ({ importId, newProfileScopeId, confirm }) => {
    const outcome = parseCatalogReassignmentResponse(await requestTranscriptJson({
      method: 'POST',
      path: '/catalog/reassign',
      body: { importId, newProfileScopeId, confirm }
    }), { importId, newProfileScopeId });
    return {
      content: [{ type: 'text', text: `importId=${outcome.importId} status=${outcome.changed ? 'reassigned' : 'unchanged'}` }],
      structuredContent: outcome
    };
  }
);

registerTool(
  'agentify_verify_catalog_conversation',
  {
    description: 'Verify one imported ChatGPT conversation by direct exact navigation. A failed observation never means deletion.',
    inputSchema: z.object({
      identity: transcriptIdentitySchema,
      key: transcriptSourceKeySchema.describe('Agentify tab key used for the direct verification navigation.')
    }).strict()
  },
  async ({ identity, key }) => {
    const expectedIdentity = parseConversationIdentity(identity);
    const outcome = parseCatalogVerificationResponse(await requestTranscriptJson({
      method: 'POST',
      path: '/catalog/verify',
      body: { identity: expectedIdentity, key }
    }), expectedIdentity);
    const detail = outcome.status === 'unavailable'
      ? ` reason=${outcome.observation.reason}`
      : outcome.status === 'failed' ? ` reason=${outcome.reason}` : '';
    return {
      content: [{ type: 'text', text: `status=${outcome.status}${detail}` }],
      structuredContent: outcome,
      isError: outcome.status === 'failed'
    };
  }
);

registerTool(
  'agentify_list_chatgpt_catalog',
  {
    description: 'List bounded ChatGPT catalog metadata. Imported routes remain non-navigable until exact verification.',
    inputSchema: z.object({
      profileScopeId: z.string().regex(PROFILE_SCOPE_ID_PATTERN).optional(),
      cursor: z.string().regex(CATALOG_LIST_CURSOR_PATTERN).optional(),
      limit: z.number().int().min(1).max(100).optional()
    }).strict()
  },
  async ({ profileScopeId, cursor, limit }) => {
    const query = new URLSearchParams();
    if (profileScopeId !== undefined) query.set('profileScopeId', profileScopeId);
    if (cursor !== undefined) query.set('cursor', cursor);
    if (limit !== undefined) query.set('limit', String(limit));
    const page = parseCatalogPageResponse(await requestTranscriptJson({
      method: 'GET',
      path: `/catalog/list${query.size ? `?${query}` : ''}`
    }));
    return {
      content: [{ type: 'text', text: `count=${page.items.length}${page.nextCursor ? ' nextCursor=available' : ''}` }],
      structuredContent: page
    };
  }
);

registerTool(
  'agentify_track_transcript',
  {
    description: 'Track the exact owned ChatGPT conversation already open on an existing keyed tab.',
    inputSchema: z.object({
      label: transcriptSourceLabelSchema.describe('Local display label. It is never returned through MCP.'),
      tags: transcriptSourceTagsSchema.describe('Local tags. They are never returned through MCP.'),
      key: transcriptSourceKeySchema.describe('Existing Agentify tab key for the open owned conversation.'),
      profileScopeId: z.string().regex(PROFILE_SCOPE_ID_PATTERN).describe('Stable local ChatGPT profile scope id.')
    }).strict()
  },
  async ({ label, tags, key, profileScopeId }) => {
    const source = parseTranscriptSourceResponse(
      await requestTranscriptJson({
        method: 'POST',
        path: '/transcripts/track',
        body: { label, tags, key, profileScopeId }
      })
    );
    if (source.state !== 'tracked') throw transcriptMcpError('transcript_mcp_response_invalid');
    const structuredContent = safeTranscriptSource(source);
    return {
      content: [{ type: 'text', text: `sourceId=${source.id} status=${source.state}` }],
      structuredContent
    };
  }
);

registerTool(
  'agentify_sync_transcript',
  {
    description: 'Manually capture and publish the newest complete snapshot for a tracked source.',
    inputSchema: z.object({
      sourceId: z.string().regex(LIBRARY_LOCAL_ID_PATTERN).describe('Tracked transcript source id.')
    }).strict()
  },
  async ({ sourceId }) => {
    const result = parseTranscriptSyncResponse(await requestTranscriptJson({
      method: 'POST',
      path: '/transcripts/sync',
      body: { sourceId }
    }));
    if (result.source.id !== sourceId) throw transcriptMcpError('transcript_mcp_response_invalid');
    const structuredContent = {
      source: safeTranscriptSource(result.source),
      attempt: safeTranscriptAttempt(result.attempt),
      status: result.status,
      outcome: result.outcome
    };
    const changed = result.status === 'complete' ? ` changed=${result.outcome.changed}` : '';
    return {
      content: [{ type: 'text', text: `sourceId=${result.source.id} status=${result.status}${changed}` }],
      structuredContent
    };
  }
);

registerTool(
  'agentify_list_transcripts',
  {
    description: 'List tracked transcript source metadata without transcript text, labels, or routes.',
    inputSchema: z.object({}).strict()
  },
  async () => {
    const sources = parseTranscriptResponse(
      z.array(transcriptSourceSchema),
      await requestTranscriptJson({ method: 'GET', path: '/transcripts/list' })
    );
    for (const source of sources) validateTranscriptSource(source);
    if (new Set(sources.map(({ id }) => id)).size !== sources.length) {
      throw transcriptMcpError('transcript_mcp_response_invalid');
    }
    const structuredContent = {
      count: sources.length,
      sources: sources.map(safeTranscriptSource)
    };
    return {
      content: [{ type: 'text', text: `count=${sources.length}` }],
      structuredContent
    };
  }
);

registerTool(
  'agentify_get_transcript',
  {
    description: 'Retrieve one bounded page of immutable structured transcript turns with exact citations.',
    inputSchema: z.object({
      identity: transcriptIdentitySchema,
      snapshot: transcriptSnapshotRefSchema.optional().describe('Explicit immutable snapshot returned by an earlier page.'),
      cursor: transcriptCursorSchema.optional().describe('Cursor returned by the same immutable snapshot.'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum whole turns to return. Defaults to 20.'),
      includePaths: z.boolean().optional().describe('Include the private local snapshot path. Defaults to false.')
    }).strict()
  },
  async (request) => {
    const page = parseTranscriptPageResponse(
      await requestTranscriptJson({ method: 'POST', path: '/transcripts/get', body: request }),
      request
    );
    return {
      content: [{ type: 'text', text: page.text }],
      structuredContent: page
    };
  }
);

registerTool(
  'agentify_forget_transcript',
  {
    description: 'Forget one local transcript source. This does not delete the provider conversation.',
    inputSchema: z.object({
      sourceId: z.string().regex(LIBRARY_LOCAL_ID_PATTERN).describe('Tracked transcript source id.'),
      confirm: z.literal(true).describe('Must be true to confirm local forgetting.')
    }).strict()
  },
  async ({ sourceId, confirm }) => {
    const deletion = parseTranscriptResponse(
      transcriptDeletionSchema,
      await requestTranscriptJson({
        method: 'POST',
        path: '/transcripts/forget',
        body: { sourceId, confirm }
      })
    );
    if (deletion.sourceId !== sourceId) throw transcriptMcpError('transcript_mcp_response_invalid');
    return {
      content: [{ type: 'text', text: `sourceId=${deletion.sourceId} status=forgotten` }],
      structuredContent: deletion
    };
  }
);

registerTool(
  'agentify_navigate',
  {
    description: 'Navigate the Agentify Desktop browser window to a URL (local UI automation).',
    inputSchema: {
      model: z.string().optional().describe('Target vendor hint for tab selection (e.g., "chatgpt" or "claude"); does not switch the provider UI model picker.'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      url: z.string().describe('URL to navigate to.')
    }
  },
  async ({ model, tabId, key, url }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/navigate', body: { model, tabId, key, url } });
    return { content: [{ type: 'text', text: data.url || 'ok' }], structuredContent: data };
  }
);

registerTool(
  'agentify_ensure_ready',
  {
    description:
      'Wait until ChatGPT is ready for input (e.g., after login/CAPTCHA). Triggers local user handoff if needed and resumes when the prompt textarea is visible.',
    inputSchema: {
      model: z.string().optional().describe('Target vendor hint for tab selection (e.g., "chatgpt" or "claude"); does not switch the provider UI model picker.'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait for readiness.')
    }
  },
  async ({ model, tabId, key, timeoutMs }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/ensure-ready',
      body: { model, tabId, key, timeoutMs: timeoutMs || 10 * 60_000 }
    });
    return { content: [{ type: 'text', text: JSON.stringify(data.state || {}, null, 2) }], structuredContent: data };
  }
);

registerTool(
  'agentify_show',
  { description: 'Bring the Agentify Desktop window to the front.', inputSchema: { model: z.string().optional(), tabId: z.string().optional(), key: z.string().optional() } },
  async ({ model, tabId, key }) => {
    const conn = await getConn();
    await requestJson({ ...conn, method: 'POST', path: '/show', body: { model, tabId, key } });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

registerTool(
  'agentify_hide',
  { description: 'Minimize the Agentify Desktop window.', inputSchema: { model: z.string().optional(), tabId: z.string().optional(), key: z.string().optional() } },
  async ({ model, tabId, key }) => {
    const conn = await getConn();
    await requestJson({ ...conn, method: 'POST', path: '/hide', body: { model, tabId, key } });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

registerTool(
  'agentify_status',
  {
    description: 'Get current URL and blocked/ready status for the Agentify Desktop window.',
    inputSchema: {
      model: z.string().optional().describe('Target vendor hint for tab selection (e.g., "chatgpt" or "claude"); does not switch the provider UI model picker.'),
      tabId: z.string().optional().describe('Tab/session id to inspect.'),
      key: z.string().optional().describe('Stable tab key to inspect.'),
      vendorId: z.string().optional().describe('Target vendor id to inspect.')
    }
  },
  async ({ model, tabId, key, vendorId }) => {
    const conn = await getConn();
    const qs = new URLSearchParams();
    if (tabId) qs.set('tabId', tabId);
    if (key) qs.set('key', key);
    if (vendorId) qs.set('vendorId', vendorId);
    if (model) qs.set('model', model);
    const path = qs.size ? `/status?${qs.toString()}` : '/status';
    const data = await requestJson({ ...conn, method: 'GET', path });
    const status = normalizeDesktopStatus(data);
    return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }], structuredContent: status };
  }
);

registerTool(
  'agentify_stop_query',
  {
    description: 'Break-glass stop for a running query/send on a tab. Best-effort: requests cancellation and clicks the provider stop button if visible.',
    inputSchema: {
      model: z.string().optional().describe('Target vendor hint for tab selection (e.g., "chatgpt" or "claude"); does not switch the provider UI model picker.'),
      tabId: z.string().optional().describe('Tab/session id to stop.'),
      runId: z.string().optional().describe('Durable run id to stop, including queued runs waiting for provider capacity.'),
      key: z.string().optional().describe('Stable tab key to stop.'),
      vendorId: z.string().optional().describe('Target vendor id to stop.')
    }
  },
  async ({ model, tabId, runId, key, vendorId }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/query/stop',
      body: { model, tabId, runId, key, vendorId }
    });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
);

registerTool(
  'agentify_list_runs',
  {
    description: 'List durable provider runs captured by Agentify Desktop.',
    inputSchema: {
      includeArchived: z.boolean().optional().describe('Include archived runs in the response.'),
      limit: z.number().optional().describe('Maximum number of runs to return.')
    }
  },
  async ({ includeArchived, limit }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/runs/list',
      body: { includeArchived: !!includeArchived, limit: limit || 100 }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.runs || [], null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_get_run',
  {
    description: 'Fetch one non-blocking durable-run snapshot. Do not poll this to await completion; call agentify_wait_run instead. Set full=true only for replay/debug.',
    inputSchema: {
      runId: z.string().describe('Durable run id.'),
      full: z.boolean().optional().describe('Return the full durable replay/debug record. Defaults to false for low-token polling.'),
      includeOutputText: z.boolean().optional().describe('Include saved response markdown from outputManifest.responsePath, capped by maxOutputChars.'),
      maxOutputChars: z.number().optional().describe('Maximum output markdown characters to return when includeOutputText is true. Defaults to 200000.')
    }
  },
  async ({ runId, full, includeOutputText, maxOutputChars }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/runs/get',
      body: {
        runId,
        view: full ? 'full' : 'summary',
        includeOutputText: !!includeOutputText,
        maxOutputChars: maxOutputChars || undefined
      }
    });
    if (full && !includeOutputText) {
      return {
        content: [{ type: 'text', text: JSON.stringify(data.run || null, null, 2) }],
        structuredContent: data
      };
    }
    return {
      content: [{ type: 'text', text: runStatusText(data.run || null, data) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_wait_run',
  {
    description: 'Wait for a durable output-bearing run to truly finish. Success is returned only after Agentify validates and registers the saved response artifacts. Waiting does not cancel or mutate the run.',
    inputSchema: {
      runId: z.string().describe('Durable query or research run id. Dispatch-only send runs are unsupported.'),
      timeoutMs: z.number().optional().describe('Caller-only wait deadline. Omit or use 0 to wait indefinitely; this never changes run state.'),
      includeOutputText: z.boolean().optional().describe('Include saved response markdown. Defaults to true.'),
      maxOutputChars: z.number().optional().describe('Maximum response characters to include.')
    }
  },
  async ({ runId, timeoutMs, includeOutputText, maxOutputChars }) => {
    const conn = await getConn();
    const data = await waitForRun({
      conn,
      runId,
      timeoutMs: timeoutMs || 0,
      includeOutputText: includeOutputText !== false,
      maxOutputChars
    });
    return {
      content: [{ type: 'text', text: runStatusText(data.run || null, data) }],
      structuredContent: data,
      isError: data.run?.status !== 'success'
    };
  }
);

registerTool(
  'agentify_open_run',
  {
    description: 'Open a durable run in the desktop UI, preferring its saved conversation URL and project context.',
    inputSchema: {
      runId: z.string().describe('Durable run id.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait while reopening the run context.'),
      show: z.boolean().optional().describe('Show the tab window after reopening the run context.')
    }
  },
  async ({ runId, timeoutMs, show }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/runs/open',
      body: {
        runId,
        timeoutMs: timeoutMs || 30_000,
        show: typeof show === 'boolean' ? show : undefined
      }
    });
    return {
      content: [{ type: 'text', text: data.tabId || 'ok' }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_retry_run',
  {
    description: 'Retry a durable run by replaying its stored packed prompt and resolved attachments.',
    inputSchema: {
      runId: z.string().describe('Durable run id.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait for the retried run.'),
      fireAndForget: z.boolean().optional().describe('Queue the retry and return immediately.'),
      show: z.boolean().optional().describe('Show the tab window before retrying.')
    }
  },
  async ({ runId, timeoutMs, fireAndForget, show }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/runs/retry',
      body: {
        runId,
        timeoutMs: timeoutMs || undefined,
        fireAndForget: !!fireAndForget,
        show: !!show,
        source: 'mcp'
      }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_archive_run',
  {
    description: 'Archive a durable run so it disappears from the default inbox view.',
    inputSchema: {
      runId: z.string().describe('Durable run id.')
    }
  },
  async ({ runId }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/runs/archive',
      body: { runId }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ runId: data.runId || runId, archivedAt: data.archivedAt || null }, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_image_gen',
  {
    description:
      'Generate images via ChatGPT web UI (best-effort): sends the prompt, then downloads any images from the latest assistant message to a local folder and returns file paths. Use a dedicated key/projectUrl if your normal ChatGPT project is pinned to a Pro model that cannot create images.',
    inputSchema: {
      model: z.string().optional().describe('Target vendor hint for tab selection (e.g., "chatgpt" or "claude"); does not switch the provider UI model picker.'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      projectUrl: z.string().optional().describe('ChatGPT Project URL (e.g., https://chatgpt.com/g/g-p-{id}/project). Useful for routing image requests to a separate Instant/Thinking project.'),
      modeIntent: z.string().optional().describe('ChatGPT mode intent for image creation. Defaults to the configured image intent when omitted.'),
      prompt: z.string().describe('Prompt to send to ChatGPT for image generation.'),
      attachments: z.array(z.string()).optional().describe('Local file paths to upload before sending the prompt.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait for completion.'),
      maxImages: z.number().optional().describe('Maximum images to download.')
    }
  },
  async ({ model, tabId, key, projectUrl, modeIntent, prompt, attachments, timeoutMs, maxImages }) => {
    const resolvedAttachments = resolveLocalPaths(attachments || []);
    const conn = await getConn();
    const q = await requestJson({
      ...conn,
      method: 'POST',
      path: '/query',
      body: {
        source: 'mcp',
        model,
        tabId,
        key,
        projectUrl,
        modeIntent,
        imageGeneration: true,
        prompt,
        attachments: resolvedAttachments,
        timeoutMs: timeoutMs || 10 * 60_000
      }
    });
    const d = await requestJson({
      ...conn,
      method: 'POST',
      path: '/artifacts/save',
      body: { model, tabId: q.tabId || tabId, key, mode: 'images', maxImages: maxImages || 6 }
    });
    const structuredContent = { text: q.result?.text || '', files: d.artifacts || [], dir: d.dir || null };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent: { tabId: q.tabId || tabId || null, ...structuredContent }
    };
  }
);

registerTool(
  'agentify_download_images',
  {
    description:
      'Download images from the latest assistant message (best-effort). Useful if you generated images manually in the UI or via agentify_query.',
    inputSchema: {
      model: z.string().optional().describe('Target vendor hint for tab selection (e.g., "chatgpt" or "claude"); does not switch the provider UI model picker.'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      maxImages: z.number().optional().describe('Maximum images to download.')
    }
  },
  async ({ model, tabId, key, maxImages }) => {
    const conn = await getConn();
    const d = await requestJson({
      ...conn,
      method: 'POST',
      path: '/artifacts/save',
      body: { model, tabId, key, mode: 'images', maxImages: maxImages || 6 }
    });
    const structuredContent = { files: d.artifacts || [], dir: d.dir || null };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent: { tabId: d.tabId || tabId || null, ...structuredContent }
    };
  }
);

registerTool(
  'agentify_list_watch_folders',
  {
    description: 'List local watch/ingest folders that Agentify indexes into artifacts automatically.',
    inputSchema: {}
  },
  async () => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'GET', path: '/watch-folders/list' });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.folders || [], null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_add_watch_folder',
  {
    description: 'Add a local folder to Agentify watch/ingest folders.',
    inputSchema: {
      name: z.string().optional().describe('Friendly folder name. If omitted, Agentify derives one from the path.'),
      folderPath: z.string().describe('Local folder path to watch. Relative paths resolve from the MCP client working directory.')
    }
  },
  async ({ name, folderPath }) => {
    const rawPath = String(folderPath || '').trim();
    if (!rawPath) throw new Error('missing_watch_folder_path');
    const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/watch-folders/add',
      body: { name: name || '', path: resolvedPath }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.folder || null, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_remove_watch_folder',
  {
    description: 'Remove a configured watch/ingest folder by name.',
    inputSchema: {
      name: z.string().describe('Configured watch folder name.')
    }
  },
  async ({ name }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/watch-folders/delete',
      body: { name }
    });
    return {
      content: [{ type: 'text', text: data.deleted ? 'deleted' : 'not_found' }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_open_watch_folder',
  {
    description: 'Open the local watch/ingest folder in Finder/Explorer so you can drop files there for automatic indexing.',
    inputSchema: {
      name: z.string().optional().describe('Watch folder name. Defaults to inbox.')
    }
  },
  async ({ name }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/watch-folders/open',
      body: { name: name || 'inbox' }
    });
    return {
      content: [{ type: 'text', text: data.folder?.path || 'ok' }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_scan_watch_folder',
  {
    description: 'Force an immediate scan of the watch/ingest folder and index any newly dropped files as artifacts.',
    inputSchema: {}
  },
  async () => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/watch-folders/scan', body: {} });
    return {
      content: [{ type: 'text', text: JSON.stringify({ folders: data.folders || [], ingested: data.ingested || [] }, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_save_bundle',
  {
    description:
      'Save a named reusable bundle of prompt prefix, attachments, and context paths. Useful for recurring project workflows.',
    inputSchema: {
      name: z.string().describe('Stable bundle name, e.g. repo-review.'),
      promptPrefix: z.string().optional().describe('Reusable instruction prefix.'),
      attachments: z.array(z.string()).optional().describe('Local files to always attach with this bundle.'),
      contextPaths: z.array(z.string()).optional().describe('Local files/folders to pack when this bundle is used.')
    }
  },
  async ({ name, promptPrefix, attachments, contextPaths }) => {
    const resolvedAttachments = resolveLocalPaths(attachments || []);
    const resolvedContextPaths = resolveLocalPaths(contextPaths || []);
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/bundles/save',
      body: { name, promptPrefix, attachments: resolvedAttachments, contextPaths: resolvedContextPaths }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.bundle || {}, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_list_bundles',
  {
    description: 'List saved context bundles.',
    inputSchema: {}
  },
  async () => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'GET', path: '/bundles/list' });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.bundles || [], null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_get_bundle',
  {
    description: 'Fetch a saved context bundle by name.',
    inputSchema: {
      name: z.string().describe('Bundle name.')
    }
  },
  async ({ name }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/bundles/get', body: { name } });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.bundle || null, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_delete_bundle',
  {
    description: 'Delete a saved context bundle by name.',
    inputSchema: {
      name: z.string().describe('Bundle name.')
    }
  },
  async ({ name }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/bundles/delete', body: { name } });
    return {
      content: [{ type: 'text', text: data.deleted ? 'deleted' : 'not_found' }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_save_artifacts',
  {
    description:
      'Save the latest assistant-generated images/files from a tab to the local artifacts folder. Returns local paths you can reuse as attachments in the next prompt.',
    inputSchema: {
      model: z.string().optional().describe('Target vendor hint for tab selection (e.g., "chatgpt" or "claude"); does not switch the provider UI model picker.'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; uses the existing tab.'),
      mode: z.enum(['images', 'files', 'all']).optional().describe('What to save from the latest assistant response.'),
      maxImages: z.number().optional().describe('Maximum images to save when mode includes images.'),
      maxFiles: z.number().optional().describe('Maximum files/links to save when mode includes files.')
    }
  },
  async ({ model, tabId, key, mode, maxImages, maxFiles }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/artifacts/save',
      body: { model, tabId, key, mode: mode || 'all', maxImages: maxImages || 6, maxFiles: maxFiles || 6 }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ dir: data.dir || null, artifacts: data.artifacts || [] }, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_list_artifacts',
  {
    description: 'List locally saved artifacts for a tab/session so you can reuse their paths in later prompts.',
    inputSchema: {
      model: z.string().optional().describe('Target vendor hint for tab selection (e.g., "chatgpt" or "claude"); does not switch the provider UI model picker.'),
      tabId: z.string().optional().describe('Tab/session id to inspect.'),
      key: z.string().optional().describe('Stable tab key to inspect.'),
      limit: z.number().optional().describe('Maximum number of artifacts to return.')
    }
  },
  async ({ model, tabId, key, limit }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/artifacts/list',
      body: { model, tabId, key, limit: limit || 50 }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.artifacts || [], null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_open_artifacts_folder',
  {
    description: 'Open the local artifacts folder in Finder/Explorer for the whole app or for a specific tab/session.',
    inputSchema: {
      model: z.string().optional().describe('Target vendor hint for tab selection (e.g., "chatgpt" or "claude"); does not switch the provider UI model picker.'),
      tabId: z.string().optional().describe('Tab/session id whose artifacts folder should open.'),
      key: z.string().optional().describe('Stable tab key whose artifacts folder should open.')
    }
  },
  async ({ model, tabId, key }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/artifacts/open-folder',
      body: { model, tabId, key }
    });
    return {
      content: [{ type: 'text', text: data.folderPath || 'ok' }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_tabs',
  { description: 'List current tabs/sessions (for parallel jobs).', inputSchema: {} },
  async () => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'GET', path: '/tabs' });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
);

registerTool(
  'agentify_tab_create',
  {
    description: 'Create (or ensure) a tab/session for a given key.',
    inputSchema: {
      model: z.string().optional().describe('Target vendor hint for tab selection (e.g., "chatgpt" or "claude"); does not switch the provider UI model picker.'),
      key: z.string().optional(),
      name: z.string().optional(),
      projectUrl: z.string().optional().describe('ChatGPT Project URL. Routes conversations on this tab into the project.'),
      modeIntent: z.string().optional().describe('ChatGPT mode intent to associate with this tab. Supported intents: extended-pro (Pro Extended), thinking (Medium), instant.'),
      show: z.boolean().optional().describe('Show the tab window immediately.')
    }
  },
  async ({ model, key, name, projectUrl, modeIntent, show }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/tabs/create',
      body: { model, key, name, projectUrl, modeIntent, show: typeof show === 'boolean' ? show : undefined }
    });
    return { content: [{ type: 'text', text: data.tabId || '' }], structuredContent: data };
  }
);

registerTool(
  'agentify_tab_close',
  { description: 'Close a tab/session by tabId.', inputSchema: { tabId: z.string().describe('Tab id to close.') } },
  async ({ tabId }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/tabs/close', body: { tabId } });
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: data };
  }
);

registerTool('agentify_shutdown', { description: 'Gracefully shut down the Agentify Desktop app.', inputSchema: {} }, async () => {
  const conn = await getConn();
  await requestJson({ ...conn, method: 'POST', path: '/shutdown', body: { scope: 'app' } });
  return { content: [{ type: 'text', text: 'ok' }] };
});

registerTool(
  'agentify_rotate_token',
  { description: 'Rotate the local HTTP API bearer token (requires reconnect on subsequent calls).', inputSchema: {} },
  async () => {
    const conn = await getConn();
    await requestJson({ ...conn, method: 'POST', path: '/rotate-token' });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`agentify-desktop MCP server running on stdio (profiles=${toolProfile.profiles.join(',')}; tools=${enabledTools.size})`);
}

main().catch((e) => {
  console.error('agentify-desktop MCP fatal:', e);
  process.exit(1);
});
