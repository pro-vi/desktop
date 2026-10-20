import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { waitForDotMessages } from '../dot-message-waiter.mjs';
import { encodeDotCursor } from '../chatgpt-recipient.mjs';
import { binding, createNativeDotPage } from './fixtures/chatgpt-dot/native-page.mjs';
import { createDotServiceFixture, exerciseDotMessaging } from './fixtures/chatgpt-dot/service.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Dot messaging crosses native evaluator, controller, HTTP, durable storage and real MCP stdio', async () => {
  const proof = await exerciseDotMessaging();
  assert.equal(proof.restartCursor, true);
  assert.equal(proof.repeatedInputCount, 1);
});

test('Dot MCP read and wait retain complete text in both result representations', async (t) => {
  const fixture = await createDotServiceFixture(); t.after(() => fixture.close());
  const client = await fixture.connect(); t.after(() => client.close());
  const initial = await client.callTool({ name: 'agentify_dot_read', arguments: {} });
  const text = 'First line\n第二行 with `code`';
  fixture.native.state.messages.push(fixture.native.incoming('text', text), fixture.native.incoming('attachment', undefined, { text: undefined, attachments: [{}] }));
  for (const operation of ['read', 'wait']) {
    const result = await client.callTool({ name: `agentify_dot_${operation}`, arguments: { after: initial.structuredContent.cursor, ...(operation === 'wait' ? { timeoutMs: 1_000 } : {}) } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual(result.structuredContent.messages.map(({ text }) => text), [text, null]);
    assert.equal(result.content[0].text, `messageId=text sender=dot\n${text}`);
    assert.match(result.content[1].text, /\[non-text message\]/);
    assert.equal(result.structuredContent.hasMore, false);
  }
  assert.equal(fixture.native.state.inputCount, 0);
});

test('Dot operation-specific validation prevents effects and preserves ordinary Chat', async (t) => {
  const fixture = await createDotServiceFixture(); t.after(() => fixture.close());
  for (const route of ['/dot/talk', '/dot/read', '/dot/wait']) {
    const valid = route.endsWith('talk') ? { text: 'test' } : route.endsWith('wait') ? { after: encodeDotCursor(binding) } : {};
    for (const field of ['recipient', 'dotBinding', 'dotSubmission', 'sender', 'modeIntent', 'model', 'chatUrl', 'attachments']) {
      assert.equal((await fixture.call(route, { ...valid, [field]: null })).status, 400);
    }
  }
  assert.equal(fixture.native.state.inputCount, 0);
  assert.equal(fixture.tabs.listTabs().length, 1);
  for (const route of ['/query', '/send', '/research']) assert.equal((await fixture.call(route, { recipient: { kind: 'dot' }, prompt: 'test', text: 'test' })).data.error, 'recipient_conflict');
  const ordinary = await fixture.call('/query', { key: 'ordinary', prompt: 'test' });
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.data));
  assert.equal(ordinary.data.result.text, 'ordinary Chat response');
});

test('Dot HTTP wait releases browser ownership so a sender can deliver', async (t) => {
  const fixture = await createDotServiceFixture(); t.after(() => fixture.close());
  const initial = await fixture.call('/dot/read', {});
  const waiting = fixture.call('/dot/wait', { after: initial.data.cursor, timeoutMs: 1_000 });
  await pause(30);
  const talk = await fixture.call('/dot/talk', { text: 'during wait' });
  assert.equal(talk.status, 200, JSON.stringify(talk.data));
  fixture.native.state.messages.push(fixture.native.incoming('update'));
  const batch = await waiting;
  assert.deepEqual(batch.data.messages.map(({ id }) => id), ['update']);
});

test('Dot unknown delivery persists across restart and cannot replay input', async (t) => {
  const native = createNativeDotPage({ settle: false });
  let fixture = await createDotServiceFixture({ native });
  t.after(() => fixture.close({ remove: true }));
  const talk = await fixture.call('/dot/talk', { text: 'unknown', timeoutMs: 10 });
  assert.equal(talk.status, 409);
  const runId = talk.data.data.runId;
  assert.equal(talk.data.data.dotSubmission.state, 'unknown');
  const stateDir = fixture.stateDir;
  await fixture.close({ remove: false });
  fixture = await createDotServiceFixture({ native, stateDir });
  const retry = await fixture.call('/runs/retry', { runId });
  assert.equal(retry.data.error, 'dot_delivery_unconfirmed');
  assert.equal(native.state.inputCount, 1);
  const loaded = await fixture.call('/runs/get', { runId });
  assert.equal(loaded.data.run.dotSubmission.requestId, talk.data.data.dotSubmission.requestId);
});

test('Dot null native submission retains uncertainty and cannot replay', async (t) => {
  const fixture = await createDotServiceFixture(); t.after(() => fixture.close());
  let calls = 0;
  fixture.native.services.composer.sendPrepared = () => { calls++; return null; };
  const talk = await fixture.call('/dot/talk', { text: 'native refusal' });
  assert.equal(talk.status, 409);
  assert.equal(talk.data.error, 'dot_delivery_unconfirmed');
  assert.equal(talk.data.data.dotSubmission.state, 'unknown');
  assert.ok(talk.data.data.dotSubmission.requestId);
  const runId = talk.data.data.runId;
  const loaded = await fixture.call('/runs/get', { runId });
  assert.deepEqual(loaded.data.run.dotSubmission, talk.data.data.dotSubmission);
  assert.equal((await fixture.call('/runs/retry', { runId })).data.error, 'dot_delivery_unconfirmed');
  assert.equal(calls, 1);
  assert.equal(fixture.native.state.inputCount, 0);
});

test('Dot safe pre-input retry revalidates and sends once', async (t) => {
  const fixture = await createDotServiceFixture(); t.after(() => fixture.close());
  fixture.native.state.draft = 'foreign';
  const rejected = await fixture.call('/dot/talk', { text: 'retry' });
  assert.equal(rejected.data.error, 'dot_draft_conflict');
  assert.equal(fixture.native.state.inputCount, 0);
  fixture.native.state.draft = '';
  const retried = await fixture.call('/runs/retry', { runId: rejected.data.data.runId });
  assert.equal(retried.status, 200, JSON.stringify(retried.data));
  assert.equal(fixture.native.state.inputCount, 1);
});

test('Dot persisted cursor rejects account drift without sending or resetting', async (t) => {
  const fixture = await createDotServiceFixture(); t.after(() => fixture.close());
  const initial = await fixture.call('/dot/read', {});
  fixture.native.state.account = 'other-account';
  const drifted = await fixture.call('/dot/read', { after: initial.data.cursor });
  assert.equal(drifted.data.error, 'dot_binding_mismatch');
  assert.deepEqual(drifted.data.data, { mismatchedFields: ['accountKey'] });
  assert.equal(fixture.native.state.inputCount, 0);
});

test('Dot cursors survive active conversation changes across restart and MCP reads', async (t) => {
  const native = createNativeDotPage();
  native.state.messages.push(native.incoming('anchor'));
  let fixture = await createDotServiceFixture({ native }); t.after(() => fixture.close({ remove: true }));
  const initial = await fixture.call('/dot/read', {});
  const stateDir = fixture.stateDir;
  native.state.conversationId = 'current-conversation';
  await fixture.close({ remove: false });
  fixture = await createDotServiceFixture({ native, stateDir });
  const client = await fixture.connect(); t.after(() => client.close());
  const empty = await client.callTool({ name: 'agentify_dot_read', arguments: { after: initial.data.cursor } });
  assert.equal(empty.isError, undefined, JSON.stringify(empty));
  assert.equal(empty.structuredContent.binding.conversationId, native.state.conversationId);
  assert.equal(empty.structuredContent.cursor, initial.data.cursor);
  native.state.messages.push(native.incoming('after-change'));
  for (const operation of ['read', 'wait']) {
    const result = await client.callTool({ name: `agentify_dot_${operation}`, arguments: { after: initial.data.cursor, ...(operation === 'wait' ? { timeoutMs: 1_000 } : {}) } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.binding.conversationId, native.state.conversationId);
    assert.deepEqual(result.structuredContent.messages.map(({ id }) => id), ['after-change']);
  }
  assert.equal(native.state.inputCount, 0);
});

test('Dot cursors cannot establish an unrelated locator', async (t) => {
  const fixture = await createDotServiceFixture(); t.after(() => fixture.close());
  fixture.native.state.navigateRedirect = 'https://chatgpt.com/dots/fixture-route';
  const untrusted = { ...binding, dotUrl: 'https://chatgpt.com/dots/unrelated' };
  for (const after of [undefined, encodeDotCursor(untrusted)]) {
    const refused = await fixture.call('/dot/read', { dotUrl: untrusted.dotUrl, ...(after ? { after } : {}) });
    assert.equal(refused.status, 409);
    assert.equal(refused.data.error, 'dot_binding_mismatch');
    assert.deepEqual(refused.data.data.mismatchedFields, ['dotUrl']);
  }
  assert.equal(fixture.native.state.inputCount, 0);
});

test('Dot MCP binding refusals name changed fields and retain delivery checkpoints', async (t) => {
  const fixture = await createDotServiceFixture(); t.after(() => fixture.close());
  const initial = await fixture.call('/dot/read', {});
  fixture.native.state.account = 'other-account';
  const client = await fixture.connect(); t.after(() => client.close());
  for (const [operation, args] of [['read', {}], ['wait', { after: initial.data.cursor, timeoutMs: 1_000 }], ['talk', { text: 'must not send' }]]) {
    const result = await client.callTool({ name: `agentify_dot_${operation}`, arguments: args });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error, 'dot_binding_mismatch');
    assert.deepEqual(result.structuredContent.mismatchedFields, ['accountKey']);
    assert.match(result.content[0].text, /Binding mismatch: accountKey/);
    if (operation === 'talk') assert.equal(result.structuredContent.dotSubmission.state, 'not-submitted');
  }
  assert.equal(fixture.native.state.inputCount, 0);
});

test('Dot MCP wait preserves binding diagnostics from a foreign successful batch', async (t) => {
  const fixture = await createDotServiceFixture(); t.after(() => fixture.close());
  const initial = await fixture.call('/dot/read', {});
  const foreign = { ...binding, accountKey: 'another-account' };
  const handler = fixture.api.listeners('request')[0];
  fixture.api.removeListener('request', handler);
  fixture.api.on('request', (req, res) => {
    if (req.url !== '/dot/wait') return handler(req, res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ binding: foreign, messages: [], cursor: encodeDotCursor(foreign), hasMore: false }));
  });
  const client = await fixture.connect(); t.after(() => client.close());
  const result = await client.callTool({ name: 'agentify_dot_wait', arguments: { after: initial.data.cursor, timeoutMs: 1_000 } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error, 'dot_binding_mismatch');
  assert.deepEqual(result.structuredContent.mismatchedFields, ['accountKey']);
  assert.match(result.content[0].text, /Binding mismatch: accountKey/);
  assert.equal(fixture.native.state.inputCount, 0);
});

test('Dot checkpoint disk failure prevents the native input through the service', async (t) => {
  const fixture = await createDotServiceFixture(); t.after(() => fixture.close());
  const original = fixture.native.page.evaluate;
  let broken = false;
  fixture.native.page.evaluate = async (script) => {
    const result = await original(script);
    if (!broken && script.includes('runDotPageOperation') && !script.includes('"action"')) {
      broken = true;
      await fs.rename(`${fixture.stateDir}/runs`, `${fixture.stateDir}/saved-runs`);
      await fs.writeFile(`${fixture.stateDir}/runs`, 'prevent run checkpoint');
    }
    return result;
  };
  const failed = await fixture.call('/dot/talk', { text: 'disk failure' });
  assert.equal(failed.status, 503);
  assert.equal(fixture.native.state.inputCount, 0);
});

test('Dot caller deadline wins over late received messages without advancing cursor', async () => {
  const cursor = encodeDotCursor(binding);
  const result = await waitForDotMessages({ conn: {}, body: { after: cursor, timeoutMs: 5 }, request: async () => { await pause(20); return { binding, messages: [{ id: 'late', sender: 'dot', text: 'late', createdAt: '', hasAttachments: false, taskCardOnly: false }], cursor: encodeDotCursor(binding, 'late'), hasMore: false }; } });
  assert.equal(result.timedOut, true);
  assert.equal(result.cursor, cursor);
});

test('Dot canceled HTTP wait leaves send ownership available', async (t) => {
  const fixture = await createDotServiceFixture(); t.after(() => fixture.close());
  const initial = await fixture.call('/dot/read', {});
  const controller = new AbortController();
  const waiting = fixture.call('/dot/wait', { after: initial.data.cursor }, { signal: controller.signal });
  await pause(20); controller.abort();
  await assert.rejects(waiting, /abort/i);
  assert.equal((await fixture.call('/dot/talk', { text: 'after cancellation' })).status, 200);
});

test('Dot MCP oversized-message errors preserve IDs, budgets, and reading positions', async (t) => {
  const fixture = await createDotServiceFixture(); t.after(() => fixture.close());
  const client = await fixture.connect(); t.after(() => client.close());
  const initial = await client.callTool({ name: 'agentify_dot_read', arguments: {} });
  fixture.native.state.messages.push(fixture.native.incoming('oversized', '1234'));
  for (const name of ['agentify_dot_read', 'agentify_dot_wait']) {
    const result = await client.callTool({ name, arguments: { after: initial.structuredContent.cursor, maxChars: 3, ...(name.endsWith('wait') ? { timeoutMs: 1_000 } : {}) } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.messageId, 'oversized');
    assert.equal(result.structuredContent.requiredChars, 4);
    assert.equal(result.structuredContent.cursor, initial.structuredContent.cursor);
  }
});

test('Dot sends through different keys serialize by native room until delivery settles', async (t) => {
  const native = createNativeDotPage({ settle: false });
  const fixture = await createDotServiceFixture({ native }); t.after(() => fixture.close());
  const waitForInputs = async (count) => {
    const deadline = Date.now() + 1_000;
    while (native.state.inputCount < count && Date.now() < deadline) await pause(5);
    assert.equal(native.state.inputCount, count);
  };
  const acceptCurrent = (id) => {
    const message = native.state.messages.at(-1);
    message.id = id;
    message.deliveryState = '';
    native.state.unconfirmed = [];
  };
  const first = fixture.call('/dot/talk', { key: 'first-agent', text: 'first', timeoutMs: 2_000 });
  await waitForInputs(1);
  native.state.conversationId = 'current-conversation';
  const blocked = await fixture.call('/dot/talk', { key: 'second-agent', text: 'must not interleave' });
  assert.equal(blocked.data.error, 'tab_busy');
  assert.equal(native.state.inputCount, 1);
  acceptCurrent('first-canonical');
  assert.equal((await first).status, 200);
  const next = fixture.call('/dot/talk', { key: 'second-agent', text: 'after settlement', timeoutMs: 2_000 });
  await waitForInputs(2);
  acceptCurrent('second-canonical');
  assert.equal((await next).status, 200);
  assert.deepEqual(native.state.texts, ['first', 'after settlement']);
});

test('Dot HTTP wait rejects a capture that completes after its deadline', async (t) => {
  const fixture = await createDotServiceFixture(); t.after(() => fixture.close());
  const initial = await fixture.call('/dot/read', {});
  const evaluate = fixture.native.page.evaluate;
  fixture.native.page.evaluate = async (script) => {
    if (script.includes('"action":"read"')) {
      await pause(50);
      fixture.native.state.messages.push(fixture.native.incoming('after-deadline'));
    }
    return await evaluate(script);
  };
  const waited = await fixture.call('/dot/wait', { after: initial.data.cursor, timeoutMs: 5 });
  assert.equal(waited.data.timedOut, true);
  assert.deepEqual(waited.data.messages, []);
  assert.equal(waited.data.cursor, initial.data.cursor);
});

test('Dot caller deadline survives a response that blocks timer delivery', async () => {
  const cursor = encodeDotCursor(binding);
  const result = await waitForDotMessages({ conn: {}, body: { after: cursor, timeoutMs: 5 }, request: async () => {
    const started = Date.now(); while (Date.now() - started < 15) {}
    return { binding, messages: [{ id: 'late', sender: 'dot', text: 'late', createdAt: '', hasAttachments: false, taskCardOnly: false }], cursor: encodeDotCursor(binding, 'late'), hasMore: false };
  } });
  assert.equal(result.timedOut, true);
  assert.equal(result.cursor, cursor);
});

test('Dot pre-input retry preserves the run binding when key persistence failed', async (t) => {
  const native = createNativeDotPage();
  let fixture = await createDotServiceFixture({ native });
  t.after(() => fixture.close({ remove: true }));
  const keyFile = `${fixture.stateDir}/projects.json`;
  await fs.mkdir(keyFile);
  const rejected = await fixture.call('/dot/talk', { text: 'original target' });
  assert.equal(rejected.status, 500);
  assert.equal(native.state.inputCount, 0);
  const runs = await fixture.call('/runs/list', {});
  const original = runs.data.runs[0];
  assert.equal(original.dotSubmission.state, 'not-submitted');
  assert.equal(original.dotBinding.accountKey, binding.accountKey);
  await fs.rmdir(keyFile);
  const stateDir = fixture.stateDir;
  await fixture.close({ remove: false });
  native.state.account = 'changed-account';
  fixture = await createDotServiceFixture({ native, stateDir });
  for (const route of ['/runs/open', '/runs/retry']) {
    const retried = await fixture.call(route, { runId: original.id });
    assert.equal(retried.data.error, 'dot_binding_mismatch');
  }
  assert.equal(native.state.inputCount, 0);
});

test('Dot after-input storage failure returns its recovery handle and cannot replay', async (t) => {
  const native = createNativeDotPage();
  let fixture = await createDotServiceFixture({ native });
  t.after(() => fixture.close({ remove: true }));
  const evaluate = native.page.evaluate;
  let broken = false;
  native.page.evaluate = async (script) => {
    const result = await evaluate(script);
    if (!broken && script.includes('"action":"submit"')) {
      broken = true;
      await fs.rename(`${fixture.stateDir}/runs`, `${fixture.stateDir}/saved-runs`);
      await fs.writeFile(`${fixture.stateDir}/runs`, 'fail checkpoint after native input');
    }
    return result;
  };
  const talk = await fixture.call('/dot/talk', { text: 'uncertain checkpoint' });
  assert.equal(talk.status, 503);
  assert.equal(native.state.inputCount, 1);
  assert.equal(typeof talk.data.data.runId, 'string');
  assert.equal(talk.data.data.dotSubmission.state, 'unknown');
  assert.equal(typeof talk.data.data.dotCursor, 'string');
  await fs.unlink(`${fixture.stateDir}/runs`);
  await fs.rename(`${fixture.stateDir}/saved-runs`, `${fixture.stateDir}/runs`);
  const stateDir = fixture.stateDir;
  await fixture.close({ remove: false });
  fixture = await createDotServiceFixture({ native, stateDir });
  const retry = await fixture.call('/runs/retry', { runId: talk.data.data.runId });
  assert.equal(retry.data.error, 'dot_delivery_unconfirmed');
  assert.equal(native.state.inputCount, 1);
});

test('Ordinary requests cannot replace an expired saved Dot key with Chat', async (t) => {
  const fixture = await createDotServiceFixture(); t.after(() => fixture.close());
  await fixture.call('/dot/read', {});
  const dot = fixture.tabs.listTabs().find((tab) => tab.key === 'personal-dot');
  await fixture.tabs.closeTab(dot.id);
  const count = fixture.tabs.listTabs().length;
  for (const route of ['/query', '/send', '/research', '/navigate', '/ensure-ready', '/read-page', '/read-conversation', '/tabs/create']) {
    const result = await fixture.call(route, { key: 'personal-dot', text: 'Chat request', prompt: 'Chat request', url: 'https://chatgpt.com/' });
    assert.equal(result.data.error, 'recipient_conflict', route);
    assert.equal(fixture.tabs.listTabs().length, count, route);
  }
  assert.equal(fixture.native.state.chatInputCount, 0);
  assert.equal((await fixture.call('/dot/read', {})).status, 200);
});

for (const checkpoint of ['unknown', 'submitted']) {
  test(`Dot MCP storage failure preserves the ${checkpoint} delivery checkpoint`, async (t) => {
    const fixture = await createDotServiceFixture(); t.after(() => fixture.close());
    const client = await fixture.connect(); t.after(() => client.close());
    await fixture.call('/dot/read', {});
    const tab = fixture.tabs.listTabs().find((row) => row.key === 'personal-dot');
    const controller = fixture.tabs.getControllerById(tab.id);
    const breakStorage = async () => {
      await fs.rename(`${fixture.stateDir}/runs`, `${fixture.stateDir}/saved-runs`);
      await fs.writeFile(`${fixture.stateDir}/runs`, 'fail final persistence');
    };
    if (checkpoint === 'submitted') {
      const inspect = controller.inspectDotBinding.bind(controller);
      controller.inspectDotBinding = async () => { const observed = await inspect(); await breakStorage(); return observed; };
    } else {
      const evaluate = fixture.native.page.evaluate;
      fixture.native.page.evaluate = async (script) => { const result = await evaluate(script); if (script.includes('"action":"submit"')) await breakStorage(); return result; };
    }
    const result = await client.callTool({ name: 'agentify_dot_talk', arguments: { text: 'MCP checkpoint failure' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error, 'run_status_unconfirmed');
    assert.equal(result.structuredContent.dotSubmission.state, checkpoint);
    assert.equal(typeof result.structuredContent.runId, 'string');
    assert.equal(fixture.native.state.inputCount, 1);
    if (checkpoint === 'submitted') assert.match(result.content[0].text, /message delivered; final run status unconfirmed/);
    else assert.match(result.content[0].text, /delivery unconfirmed/);
  });
}

test('Ordinary key-only requests reject a live Dot tab after failed key persistence', async (t) => {
  const fixture = await createDotServiceFixture(); t.after(() => fixture.close());
  const keyFile = `${fixture.stateDir}/projects.json`;
  await fs.mkdir(keyFile);
  assert.equal((await fixture.call('/dot/talk', { text: 'prepare target' })).status, 500);
  await fs.rmdir(keyFile);
  const dot = fixture.tabs.listTabs().find((tab) => tab.key === 'personal-dot');
  assert.equal(dot.recipient.kind, 'dot');
  for (const route of ['/query', '/send', '/research', '/navigate', '/ensure-ready', '/read-page', '/read-conversation', '/tabs/create']) {
    const result = await fixture.call(route, { key: 'personal-dot', text: 'ordinary request', prompt: 'ordinary request', url: 'https://chatgpt.com/c/fixture-chat' });
    assert.equal(result.data.error, 'recipient_conflict', route);
    assert.equal(await fixture.native.page.getUrl(), binding.dotUrl, route);
  }
  assert.equal(fixture.native.state.inputCount, 0);
  assert.equal(fixture.native.state.chatInputCount, 0);
  assert.equal((await fixture.call('/dot/read', {})).status, 200);
});
