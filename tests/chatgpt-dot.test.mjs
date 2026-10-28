import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTController } from '../chatgpt-controller.mjs';
import { encodeDotCursor, parseDotCursor, parseDotSubmission, initialDotSubmission } from '../chatgpt-recipient.mjs';
import { binding, createNativeDotPage } from './fixtures/chatgpt-dot/native-page.mjs';
import { DOT_PAGE_FAILURE_REASONS, dotPageScript, parseDotPageObservation } from '../chatgpt-dot-ui.mjs';

const failureCases = [
  ['origin-unexpected', "location.origin = 'https://example.test'"],
  ['sidebar-ambiguous', "document.querySelectorAll = () => []"],
  ['route-not-dot', "location.pathname = '/'"],
  ['account-ambiguous', "sidebar.__reactFiber$fixture.memoizedProps.accountKey = null"],
  ['conversation-ambiguous', "props.conversationId = null"],
  ['context-ambiguous', "props.services = null"],
  ['room-invalid', "props.room.members = null"],
  ['peer-ambiguous', "props.room.members[0].aeon_id = null"],
  ['owner-ambiguous', "props.room.members.pop()"],
  ['profile-context-mismatch', "sidebar.__reactFiber$fixture.memoizedProps.profile.messaging_room_id = 'unrelated-room'"],
  ['timeline-unavailable', "props.services.conversations.timeline = null"],
  ['timeline-not-loaded', "props.services.conversations.timeline = () => ({ getSnapshot: () => ({ loaded: false }) })"],
  ['messages-invalid', "props.services.conversations.timeline = () => ({ getSnapshot: () => ({ loaded: true }) })"],
  ['cursors-invalid', "props.services.conversations.timeline = () => ({ getSnapshot: () => ({ loaded: true, messages: [], cursors: {} }) })"],
  ['composer-invalid', "props.services.composer.state.getSnapshot = () => ({})"],
  ['message-invalid', "props.services.conversations.timeline = () => ({ getSnapshot: () => ({ loaded: true, messages: [{}], cursors: { after: null } }) })"],
  ['message-sender-unknown', "props.services.conversations.timeline = () => ({ getSnapshot: () => ({ loaded: true, messages: [{ id: 'bad', roomId: props.roomId, deliveryState: '' }], cursors: { after: null } }) })"],
  ['submission-unavailable', "props.services.composer.sendPrepared = null", { action: 'submit', binding, text: 'fixture', requestId: 'fixture-request' }],
  ['message-delivery-pending', null, { action: 'read', limit: 32, maxChars: 20000 }, { deliveryState: 'pending' }],
  ['message-content-unavailable', null, { action: 'read', limit: 32, maxChars: 20000 }, { text: null }]
];

test('Dot rejection fixtures cover every public reason', () => {
  assert.deepEqual(failureCases.map(([reason]) => reason), [...DOT_PAGE_FAILURE_REASONS]);
});

for (const [reason, mutation, options = {}, message] of failureCases) {
  test(`Dot reports ${reason} without private native values`, async () => {
    const fixture = createNativeDotPage();
    if (message) fixture.state.messages.push(fixture.incoming('fixture-message', 'private fixture body', message));
    const script = `(() => { const sidebar = document.querySelectorAll('button')[0]; const props = document.querySelectorAll('main')[0].__reactProps$fixture; ${mutation || ''}; return ${dotPageScript(options)}; })()`;
    const observed = await fixture.page.evaluate(script);
    assert.deepEqual(observed, { state: 'unconfirmed', reason });
    assert.throws(() => parseDotPageObservation(observed), (error) => {
      assert.equal(error.message, 'dot_binding_unconfirmed');
      assert.deepEqual(error.data, { reason });
      return true;
    });
    assert.equal(fixture.state.inputCount, 0);
  });
}

test('Dot ignores unrecognized diagnostic content', () => {
  assert.throws(() => parseDotPageObservation({ state: 'unconfirmed', reason: 'private fixture body', text: 'private fixture body' }), (error) => {
    assert.equal(error.data, undefined);
    return true;
  });
});

test('Dot confirms the primary profile on the home alias without a selected sidebar item', async () => {
  const fixture = createNativeDotPage();
  fixture.location.href = 'https://chatgpt.com/dots/home';
  fixture.location.pathname = '/dots/home';
  const evaluate = fixture.page.evaluate;
  fixture.page.evaluate = (script) => evaluate(`(() => { const sidebar = document.querySelectorAll('button')[0]; const get = sidebar.getAttribute; sidebar.getAttribute = name => name === 'aria-current' ? null : get(name); return ${script}; })()`);
  assert.deepEqual(await controllerFor(fixture).inspectDotBinding(), { ...binding, dotUrl: fixture.location.href });
  assert.equal(fixture.state.inputCount, 0);
});

for (const [field, value, reason] of [
  ['is_primary', false, 'sidebar-ambiguous'],
  ['id', 'another-profile', 'sidebar-ambiguous'],
  ['messaging_room_id', 'another-room', 'profile-context-mismatch'],
  ['active_root_thread_id', 'another-conversation', 'profile-context-mismatch']
]) {
  test(`Dot refuses a native primary profile with changed ${field}`, async () => {
    const fixture = createNativeDotPage();
    const evaluate = fixture.page.evaluate;
    fixture.page.evaluate = (script) => evaluate(`(() => { document.querySelectorAll('button')[0].__reactProps$fixture.profile[${JSON.stringify(field)}] = ${JSON.stringify(value)}; return ${script}; })()`);
    await assert.rejects(controllerFor(fixture).inspectDotBinding(), (error) => {
      assert.deepEqual(error.data, { reason });
      return true;
    });
    assert.equal(fixture.state.inputCount, 0);
  });
}

test('Dot rejects duplicate visible primary profile controls', async () => {
  const fixture = createNativeDotPage();
  const evaluate = fixture.page.evaluate;
  fixture.page.evaluate = (script) => evaluate(`(() => { const query = document.querySelectorAll; document.querySelectorAll = selector => selector.startsWith('button[data-sidebar-destination') ? [...query(selector), ...query(selector)] : query(selector); return ${script}; })()`);
  await assert.rejects(controllerFor(fixture).inspectDotBinding(), (error) => {
    assert.deepEqual(error.data, { reason: 'sidebar-ambiguous' });
    return true;
  });
  assert.equal(fixture.state.inputCount, 0);
});

for (const opened of [true, false]) {
  test(`Dot preparation retains the last ${opened ? 'timeline' : 'opening'} reason`, async () => {
    const fixture = createNativeDotPage();
    fixture.state.loaded = false;
    if (!opened) fixture.location.origin = 'https://example.test';
    await assert.rejects(controllerFor(fixture).prepareDotEntry({ timeoutMs: 1 }), (error) => {
      assert.deepEqual(error.data, { reason: opened ? 'timeline-not-loaded' : 'origin-unexpected' });
      return true;
    });
  });
}

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

test('Dot identifies the native conversation when its URL uses another route ID', async () => {
  const fixture = createNativeDotPage();
  fixture.location.pathname = '/dots/fixture-peer';
  fixture.location.href = 'https://chatgpt.com/dots/fixture-peer';
  const controller = new ChatGPTController({ vendorId: 'chatgpt', recipient: { kind: 'dot', dotUrl: fixture.location.href }, page: fixture.page, selectors: {} });
  assert.deepEqual(await controller.prepareDotEntry(), { ...binding, dotUrl: fixture.location.href });
  const delivered = await talk(controller, { binding: { ...binding, dotUrl: fixture.location.href } });
  assert.equal(delivered.result.userMessageId, 'accepted-1');
});

test('Dot accepts a conversation locator redirected to its canonical personal route', async () => {
  const fixture = createNativeDotPage();
  fixture.location.href = 'https://chatgpt.com/';
  fixture.location.pathname = '/';
  fixture.state.navigateRedirect = 'https://chatgpt.com/dots/fixture-peer';
  const controller = new ChatGPTController({ vendorId: 'chatgpt', recipient: { kind: 'dot', dotUrl: binding.dotUrl }, page: fixture.page, selectors: {} });
  assert.deepEqual(await controller.prepareDotEntry(), { ...binding, dotUrl: fixture.state.navigateRedirect });
  assert.equal(fixture.state.inputCount, 0);
});

test('Dot rejects an unrelated locator redirected to the personal route', async () => {
  const fixture = createNativeDotPage();
  fixture.state.navigateRedirect = 'https://chatgpt.com/dots/fixture-peer';
  const controller = new ChatGPTController({ vendorId: 'chatgpt', recipient: { kind: 'dot', dotUrl: 'https://chatgpt.com/dots/unrelated' }, page: fixture.page, selectors: {} });
  await assert.rejects(controller.prepareDotEntry(), /dot_binding_mismatch/);
  assert.equal(fixture.state.inputCount, 0);
});

for (const reversed of [false, true]) {
  test(`Dot rejects conflicting visible native conversations in ${reversed ? 'reversed' : 'original'} order`, async () => {
    const fixture = createNativeDotPage();
    const controller = controllerFor(fixture);
    await controller.prepareDotEntry();
    const props = { ...fixture.main.__reactProps$fixture, conversationId: 'conflicting-conversation' };
    const other = { ...fixture.main, __reactProps$fixture: props, __reactFiber$fixture: { memoizedProps: props, return: null } };
    fixture.state.mainNodes = reversed ? [other, fixture.main] : [fixture.main, other];
    await assert.rejects(controller.inspectDotBinding(), /dot_binding_unconfirmed/);
    assert.equal(fixture.state.inputCount, 0);
  });
}

test('Dot accepts duplicated identical native contexts', async () => {
  const fixture = createNativeDotPage();
  const controller = controllerFor(fixture);
  await controller.prepareDotEntry();
  fixture.state.mainNodes = [fixture.main, { ...fixture.main }];
  assert.deepEqual(await controller.inspectDotBinding(), binding);
});

for (const [field, stateKey] of [['roomId', 'roomId'], ['peerAeonId', 'peer'], ['accountKey', 'account']]) {
  test(`Dot binding refusal identifies ${field} without returning identity values`, async () => {
    const fixture = createNativeDotPage();
    const controller = controllerFor(fixture);
    await controller.prepareDotEntry();
    fixture.state[stateKey] = 'changed-identity';
    await assert.rejects(controller.inspectDotBinding(), (error) => {
      assert.equal(error.message, 'dot_binding_mismatch');
      assert.deepEqual(error.data, { mismatchedFields: [field] });
      return true;
    });
    assert.equal(fixture.state.inputCount, 0);
  });
}

test('Dot native binding follows the active conversation within the same room', async () => {
  const fixture = createNativeDotPage();
  const controller = controllerFor(fixture);
  await controller.prepareDotEntry();
  const cursor = (await controller.readDotMessages()).cursor;
  fixture.state.conversationId = 'current-conversation';
  const current = { ...binding, conversationId: fixture.state.conversationId };
  assert.deepEqual(await controller.prepareDotEntry({ dotBinding: binding }), current);
  assert.equal((await controller.readDotMessages({ after: cursor })).cursor, cursor);
  fixture.state.messages.push(fixture.incoming('new-message'));
  assert.deepEqual((await controller.readDotMessages({ after: cursor })).messages.map(({ id }) => id), ['new-message']);
  await talk(controller, { binding: current });
  assert.equal(fixture.state.inputCount, 1);
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

test('Dot native delivery handle waits for canonical request acceptance', async () => {
  const fixture = createNativeDotPage({ settle: false });
  const send = fixture.services.composer.sendPrepared;
  fixture.services.composer.sendPrepared = (...args) => {
    send(...args);
    return { delivery: Promise.resolve(true) };
  };
  let observePending;
  const pending = new Promise((resolve) => { observePending = resolve; });
  const evaluate = fixture.page.evaluate;
  fixture.page.evaluate = async (script) => {
    const observation = await evaluate(script);
    if (fixture.state.inputCount && !script.includes('"action":"submit"')) observePending();
    return observation;
  };
  const checkpoints = [];
  const sending = talk(controllerFor(fixture), { timeoutMs: 2_000, recordDotSubmission: async (value) => checkpoints.push(value) });
  const first = await Promise.race([pending.then(() => 'pending'), sending.then(() => 'early-success', () => 'early-error')]);
  assert.equal(first, 'pending');
  assert.deepEqual(checkpoints.map(({ state }) => state), ['unknown']);
  const message = fixture.state.messages.at(-1);
  message.id = 'canonical-outgoing';
  message.deliveryState = '';
  fixture.state.unconfirmed = [];
  assert.equal((await sending).result.userMessageId, message.id);
  assert.deepEqual(checkpoints.map(({ state }) => state), ['unknown', 'submitted']);
  assert.equal(fixture.state.inputCount, 1);
});

test('Dot canonical acceptance does not wait on the native delivery promise', async () => {
  const fixture = createNativeDotPage();
  const send = fixture.services.composer.sendPrepared;
  fixture.services.composer.sendPrepared = (...args) => {
    send(...args);
    return { delivery: new Promise(() => {}) };
  };
  const delivered = await talk(controllerFor(fixture));
  assert.equal(delivered.result.userMessageId, 'accepted-1');
  assert.equal(fixture.state.inputCount, 1);
});

test('Dot checkpoint failure prevents the native send', async () => {
  const fixture = createNativeDotPage();
  await assert.rejects(talk(controllerFor(fixture), { recordDotSubmission: async () => { throw new Error('disk_failed'); } }), /disk_failed/);
  assert.equal(fixture.state.inputCount, 0);
});

test('Dot accepts an absent room draft in a confirmed native map', async () => {
  const fixture = createNativeDotPage();
  const snapshot = fixture.services.composer.state.getSnapshot;
  fixture.services.composer.state.getSnapshot = () => ({ ...snapshot(), drafts: new Map() });
  await talk(controllerFor(fixture));
  assert.equal(fixture.state.inputCount, 1);
});

for (const [name, drafts] of [
  ['missing draft map', undefined],
  ['malformed room draft', new Map([[binding.roomId, {}]])],
  ['undefined room draft', new Map([[binding.roomId, undefined]])],
  ['different native draft', new Map([[binding.roomId, { text: 'foreign' }]])]
]) {
  test(`Dot rejects ${name} without input`, async () => {
    const fixture = createNativeDotPage();
    const snapshot = fixture.services.composer.state.getSnapshot;
    fixture.services.composer.state.getSnapshot = () => ({ ...snapshot(), drafts });
    await assert.rejects(talk(controllerFor(fixture)), /dot_draft_conflict/);
    assert.equal(fixture.state.inputCount, 0);
  });
}

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

test('Dot empty reads retain the exact valid opaque cursor representation', async () => {
  const fixture = createNativeDotPage();
  const controller = controllerFor(fixture);
  await controller.prepareDotEntry();
  const cursor = Buffer.from(JSON.stringify({ messageId: null, binding })).toString('base64url');
  assert.equal((await controller.readDotMessages({ after: cursor })).cursor, cursor);
});

test('Dot empty-position cursor refuses missing older-history metadata', async () => {
  const fixture = createNativeDotPage();
  const controller = controllerFor(fixture);
  await controller.prepareDotEntry();
  fixture.state.before = undefined;
  fixture.state.messages.push(fixture.incoming('visible'));
  fixture.state.history = () => {};
  await assert.rejects(controller.readDotMessages({ after: encodeDotCursor(binding) }), /dot_cursor_unavailable/);
});
