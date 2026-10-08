import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTController } from '../chatgpt-controller.mjs';
import { encodeDotCursor, parseDotCursor, parseDotSubmission, initialDotSubmission } from '../chatgpt-recipient.mjs';
import { binding, createNativeDotPage } from './fixtures/chatgpt-dot/native-page.mjs';

function controllerFor(fixture) {
  return new ChatGPTController({ vendorId: 'chatgpt', recipient: { kind: 'dot' }, page: fixture.page, selectors: {} });
}

async function talk(controller, options = {}) {
  const checkpoints = [];
  let cursor;
  const result = await controller.talkDot({ text: ' exact\ntext ', binding, timeoutMs: 20, recordDotSubmission: async (value) => checkpoints.push(parseDotSubmission(value)), recordDotCursor: async (value) => { cursor = value; }, ...options });
  return { result, checkpoints, cursor };
}

test('Dot native adapter discovers personal context without display names', async () => {
  const fixture = createNativeDotPage();
  const controller = controllerFor(fixture);
  assert.deepEqual(await controller.prepareDotEntry(), binding);
  assert.equal(fixture.state.inputCount, 0);
});

test('Dot native prepared send persists request identity before input and returns delivery only', async () => {
  const fixture = createNativeDotPage();
  const controller = controllerFor(fixture);
  const checkpoints = [];
  let cursor;
  const result = await talk(controller, { recordDotSubmission: async (value) => { checkpoints.push(parseDotSubmission(value)); if (value.state === 'unknown') assert.equal(fixture.state.inputCount, 0); }, recordDotCursor: async (value) => { cursor = value; } });
  assert.deepEqual(fixture.state.texts, [' exact\ntext ']);
  assert.deepEqual(checkpoints.map(({ state }) => state), ['unknown', 'submitted']);
  assert.equal(checkpoints[0].requestId, checkpoints[1].requestId);
  assert.equal(parseDotCursor(cursor).messageId, null);
  assert.equal(result.result.userMessageId, 'accepted-1');
  assert.equal(Object.hasOwn(result.result, 'completionEvidence'), false);
});

test('Dot checkpoint failure prevents the native send', async () => {
  const fixture = createNativeDotPage();
  await assert.rejects(talk(controllerFor(fixture), { recordDotSubmission: async () => { throw new Error('disk_failed'); } }), /disk_failed/);
  assert.equal(fixture.state.inputCount, 0);
});

for (const change of ['draft', 'uploads', 'room', 'account']) {
  test(`Dot final native guard rejects changed ${change} before submission`, async () => {
    const fixture = createNativeDotPage();
    fixture.state.beforeSubmit = () => { if (change === 'draft') fixture.state.draft = 'foreign'; if (change === 'uploads') fixture.state.attachments = [{}]; if (change === 'room') fixture.state.roomId = 'changed-room'; if (change === 'account') fixture.state.account = 'changed-account'; };
    await assert.rejects(talk(controllerFor(fixture)), /dot_draft_conflict|dot_binding_mismatch/);
    assert.equal(fixture.state.inputCount, 0);
    if (change === 'draft') assert.equal(fixture.state.draft, 'foreign');
  });
}

test('Dot optimistic outgoing ID and incoming messages never prove delivery', async () => {
  const fixture = createNativeDotPage({ settle: false });
  fixture.state.messages.push(fixture.incoming('proactive', 'same text'));
  await assert.rejects(talk(controllerFor(fixture)), /dot_delivery_unconfirmed/);
  assert.equal(fixture.state.inputCount, 1);
});

test('Dot local stop after checkpoint performs no native input or task stop', async () => {
  const fixture = createNativeDotPage();
  const controller = controllerFor(fixture);
  await assert.rejects(talk(controller, { recordDotSubmission: async () => { await controller.requestStop(); } }), /query_aborted/);
  assert.equal(fixture.state.inputCount, 0);
});

test('Dot ordered batches preserve budgets, independent readers, and tail positions', async () => {
  const fixture = createNativeDotPage();
  const controller = controllerFor(fixture);
  await controller.prepareDotEntry();
  const start = (await controller.readDotMessages()).cursor;
  fixture.state.messages.push(fixture.incoming('first', '123'), fixture.incoming('second', '456'));
  const first = await controller.readDotMessages({ after: start, maxChars: 3 });
  assert.deepEqual(first.messages.map(({ id }) => id), ['first']);
  assert.equal(first.hasMore, true);
  assert.equal(parseDotCursor(first.cursor).messageId, 'first');
  assert.deepEqual((await controller.readDotMessages({ after: start })).messages.map(({ id }) => id), ['first', 'second']);
  const second = await controller.readDotMessages({ after: first.cursor });
  assert.deepEqual(second.messages.map(({ id }) => id), ['second']);
  assert.equal((await controller.readDotMessages({ after: second.cursor })).cursor, second.cursor);
  fixture.state.messages.push(fixture.incoming('later'));
  assert.deepEqual((await controller.readDotMessages({ after: second.cursor })).messages.map(({ id }) => id), ['later']);
});

test('Dot oversized and missing content retain the caller position', async () => {
  const fixture = createNativeDotPage();
  const controller = controllerFor(fixture);
  await controller.prepareDotEntry();
  const cursor = encodeDotCursor(binding);
  fixture.state.messages.push(fixture.incoming('large', '1234'));
  await assert.rejects(controller.readDotMessages({ after: cursor, maxChars: 3 }), (error) => error.message === 'dot_message_too_large' && error.data.messageId === 'large' && error.data.requiredChars === 4);
  fixture.state.messages[0].text = undefined;
  await assert.rejects(controller.readDotMessages({ after: cursor }), /dot_binding_unconfirmed/);
  fixture.state.messages[0].attachments = [{}];
  assert.equal((await controller.readDotMessages({ after: cursor })).messages[0].text, null);
});

test('Dot missing anchor seeks native history and rejects uncovered ranges', async () => {
  const fixture = createNativeDotPage();
  const controller = controllerFor(fixture);
  await controller.prepareDotEntry();
  fixture.state.messages.push(fixture.incoming('later'));
  fixture.state.history = () => fixture.state.messages.unshift(fixture.incoming('anchor'));
  assert.deepEqual((await controller.readDotMessages({ after: encodeDotCursor(binding, 'anchor') })).messages.map(({ id }) => id), ['later']);
  fixture.state.after = 'missing-tail';
  await assert.rejects(controller.readDotMessages(), /dot_cursor_unavailable/);
});

test('Dot native sender identity and loading state fail closed', async () => {
  const fixture = createNativeDotPage();
  const controller = controllerFor(fixture);
  fixture.state.messages.push(fixture.incoming('foreign', 'text', { senderAeonId: 'foreign' }));
  await assert.rejects(controller.inspectDotBinding(), /dot_binding_unconfirmed/);
  fixture.state.messages = [];
  fixture.state.loaded = false;
  await assert.rejects(controller.inspectDotBinding(), /dot_binding_unconfirmed/);
});

test('Dot empty recent read never anchors an unconfirmed outgoing message', async () => {
  const fixture = createNativeDotPage();
  const controller = controllerFor(fixture);
  await controller.prepareDotEntry();
  fixture.state.messages.push({ id: 'uncertain', roomId: binding.roomId, self: true, senderId: 'fixture-owner', requestId: 'uncertain-request', deliveryState: '', text: 'outgoing', createdAt: '', attachments: [] });
  fixture.state.unconfirmed = ['uncertain-request'];
  const empty = await controller.readDotMessages();
  assert.equal(parseDotCursor(empty.cursor).messageId, null);
  fixture.state.messages.push(fixture.incoming('later'));
  assert.deepEqual((await controller.readDotMessages({ after: empty.cursor })).messages.map(({ id }) => id), ['later']);
});
