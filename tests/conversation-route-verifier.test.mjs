import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatGptRouteVerifier } from '../conversation-catalog-sync.mjs';

const OBSERVED_AT = '2026-07-31T13:00:00.000Z';
const NAVIGATION_TIMEOUT_MS = 12_345;

function identity(providerConversationId = 'route-verifier-thread') {
  return {
    provider: 'chatgpt',
    profileScopeId: 'profile-main',
    providerConversationId
  };
}

function verifierFixture({
  servedUrl = 'https://chatgpt.com/c/route-verifier-thread',
  servedUrls = null,
  prepareError = null,
  inspectResult = { status: 'served', visibleTurnCount: 2 },
  inspectError = null,
  ensureError = null,
  challenge = { kind: null, blocked: false },
  challengeResults = null,
  challengeError = null,
  navigationTimeoutMs = NAVIGATION_TIMEOUT_MS,
  controllerPatch = {}
} = {}) {
  const events = [];
  let inExclusive = false;
  let exclusiveQuarantine = null;
  let urlRead = 0;
  let challengeRead = 0;
  const controller = {
    async runExclusive(operation) {
      assert.equal(inExclusive, false);
      events.push(['exclusive:start']);
      inExclusive = true;
      try {
        if (exclusiveQuarantine !== null) {
          const error = new Error('tab_busy');
          error.code = 'tab_busy';
          throw error;
        }
        return await operation();
      } finally {
        inExclusive = false;
        events.push(['exclusive:end']);
      }
    },
    quarantineExclusiveUntil(operation) {
      events.push(['exclusive:quarantine']);
      const quarantine = Promise.resolve(operation).then(() => undefined, () => undefined);
      exclusiveQuarantine = quarantine;
      void quarantine.finally(() => {
        if (exclusiveQuarantine === quarantine) exclusiveQuarantine = null;
      });
    },
    async prepareChatEntry(input) {
      assert.equal(inExclusive, true);
      events.push(['prepare', input]);
      if (prepareError) throw prepareError;
    },
    async detectChallenge() {
      assert.equal(inExclusive, true);
      events.push(['challenge']);
      if (challengeError) throw challengeError;
      if (!Array.isArray(challengeResults)) return challenge;
      const value = challengeResults[Math.min(challengeRead, challengeResults.length - 1)];
      challengeRead += 1;
      return value;
    },
    async inspectConversationRoute() {
      assert.equal(inExclusive, true);
      events.push(['inspect']);
      if (inspectError) throw inspectError;
      return inspectResult;
    },
    async getUrl() {
      assert.equal(inExclusive, true);
      events.push(['url']);
      if (!Array.isArray(servedUrls)) return servedUrl;
      const value = servedUrls[Math.min(urlRead, servedUrls.length - 1)];
      urlRead += 1;
      return value;
    },
    ...controllerPatch
  };
  const tabs = {
    async ensureTab(input) {
      events.push(['ensure', input]);
      if (ensureError) throw ensureError;
      return 'verification-tab';
    },
    getControllerById(tabId) {
      events.push(['controller', tabId]);
      return controller;
    }
  };
  return {
    events,
    verifier: createChatGptRouteVerifier({
      tabs,
      navigationTimeoutMs,
      clock: () => OBSERVED_AT
    }),
    controller
  };
}

function unavailable(expectedIdentity, reason, retryable) {
  return {
    status: 'unavailable',
    identity: expectedIdentity,
    observation: { observedAt: OBSERVED_AT, reason, retryable }
  };
}

test('route verifier: exact served identity is verified through one exclusive canonical navigation', async () => {
  const expectedIdentity = identity();
  const fixture = verifierFixture({
    servedUrl: 'https://chatgpt.com/c/route-verifier-thread?temporary=ignored#fragment'
  });

  const outcome = await fixture.verifier.verify(expectedIdentity, 'owned-catalog-key');
  assert.deepEqual(outcome, {
    status: 'verified',
    identity: expectedIdentity,
    canonicalUrl: 'https://chatgpt.com/c/route-verifier-thread',
    evidence: 'direct-navigation'
  });
  assert.deepEqual(fixture.events, [
    ['ensure', {
      key: 'owned-catalog-key',
      name: 'Catalog verification',
      url: 'https://chatgpt.com/c/route-verifier-thread',
      vendorId: 'chatgpt',
      vendorName: 'ChatGPT',
      show: false,
      projectUrl: null
    }],
    ['controller', 'verification-tab'],
    ['exclusive:start'],
    ['prepare', {
      chatUrl: 'https://chatgpt.com/c/route-verifier-thread',
      timeoutMs: NAVIGATION_TIMEOUT_MS,
      forceNavigation: true
    }],
    ['challenge'],
    ['url'],
    ['inspect'],
    ['challenge'],
    ['url'],
    ['exclusive:end']
  ]);
});

test('route verifier: an exact provider id remains verifiable after a project-route redirect', async () => {
  const expectedIdentity = identity();
  const fixture = verifierFixture({
    servedUrl: 'https://chatgpt.com/g/g-p-project/c/route-verifier-thread?temporary=true'
  });

  assert.deepEqual(await fixture.verifier.verify(expectedIdentity, 'project-route-key'), {
    status: 'verified',
    identity: expectedIdentity,
    canonicalUrl: 'https://chatgpt.com/g/g-p-project/c/route-verifier-thread',
    evidence: 'direct-navigation'
  });
});

test('route verifier: redirected non-conversations and mismatched provider ids are availability observations', async () => {
  const expectedIdentity = identity();
  const redirected = verifierFixture({ servedUrl: 'https://chatgpt.com/' });
  assert.deepEqual(
    await redirected.verifier.verify(expectedIdentity, 'redirected-key'),
    unavailable(expectedIdentity, 'not-found', true)
  );

  const publicShare = verifierFixture({ servedUrl: 'https://chatgpt.com/share/public-snapshot' });
  assert.deepEqual(
    await publicShare.verifier.verify(expectedIdentity, 'shared-key'),
    unavailable(expectedIdentity, 'not-found', true)
  );

  const mismatched = verifierFixture({ servedUrl: 'https://chatgpt.com/c/a-different-thread' });
  assert.deepEqual(
    await mismatched.verifier.verify(expectedIdentity, 'mismatched-key'),
    unavailable(expectedIdentity, 'foreign-profile', false)
  );
});

test('route verifier: a retained exact URL and generic-ready shell without a served turn stays unavailable', async () => {
  const expectedIdentity = identity();
  const fixture = verifierFixture({
    servedUrl: 'https://chatgpt.com/c/route-verifier-thread',
    inspectResult: { status: 'unavailable', reason: 'not-found' }
  });

  assert.deepEqual(
    await fixture.verifier.verify(expectedIdentity, 'retained-error-shell-key'),
    unavailable(expectedIdentity, 'not-found', true)
  );
  assert.deepEqual(fixture.events.map(([event]) => event), [
    'ensure', 'controller', 'exclusive:start', 'prepare', 'challenge', 'url', 'inspect',
    'challenge', 'url', 'exclusive:end'
  ]);
});

test('route verifier: route identity must remain exact while served evidence is inspected', async () => {
  const expectedIdentity = identity();
  const fixture = verifierFixture({
    servedUrls: [
      'https://chatgpt.com/c/route-verifier-thread',
      'https://chatgpt.com/c/a-different-thread'
    ]
  });

  assert.deepEqual(
    await fixture.verifier.verify(expectedIdentity, 'route-race-key'),
    unavailable(expectedIdentity, 'foreign-profile', false)
  );
});

test('route verifier: explicit not-found and forbidden navigation failures stay retryable availability observations', async (t) => {
  const expectedIdentity = identity();
  const cases = [
    ['not-found', Object.assign(new Error('private route body'), { code: 'route_not_found' })],
    ['forbidden', Object.assign(new Error('private provider response'), { code: 'HTTP_403_FORBIDDEN' })]
  ];
  for (const [reason, prepareError] of cases) {
    await t.test(reason, async () => {
      const fixture = verifierFixture({ prepareError });
      assert.deepEqual(
        await fixture.verifier.verify(expectedIdentity, `${reason}-key`),
        unavailable(expectedIdentity, reason, true)
      );
      assert.equal(fixture.events.filter(([event]) => event === 'exclusive:start').length, 1);
      assert.equal(fixture.events.filter(([event]) => event === 'url').length, 0);
    });
  }
});

test('route verifier: login and challenge detection override a generic navigation error', async (t) => {
  const expectedIdentity = identity();
  const cases = [
    ['login', { kind: 'login', blocked: true }],
    ['challenge', { kind: 'captcha', blocked: true }]
  ];
  for (const [reason, challenge] of cases) {
    await t.test(reason, async () => {
      const fixture = verifierFixture({
        prepareError: Object.assign(new Error('private navigation failure'), { code: 'EIO' }),
        challenge
      });
      assert.deepEqual(
        await fixture.verifier.verify(expectedIdentity, `${reason}-key`),
        { status: 'failed', reason }
      );
      assert.equal(fixture.events.filter(([event]) => event === 'challenge').length, 1);
      assert.equal(fixture.events.filter(([event]) => event === 'exclusive:start').length, 1);
    });
  }
});

test('route verifier: protective challenges fail closed after successful readiness and during inspection', async (t) => {
  const expectedIdentity = identity();
  await t.test('blocked immediately after readiness', async () => {
    const fixture = verifierFixture({ challenge: { kind: 'captcha', blocked: true } });
    assert.deepEqual(
      await fixture.verifier.verify(expectedIdentity, 'ready-but-blocked-key'),
      { status: 'failed', reason: 'challenge' }
    );
    assert.deepEqual(fixture.events.map(([event]) => event), [
      'ensure', 'controller', 'exclusive:start', 'prepare', 'challenge', 'exclusive:end'
    ]);
  });

  await t.test('challenge appears during served-turn inspection', async () => {
    const fixture = verifierFixture({
      challengeResults: [
        { kind: null, blocked: false },
        { kind: 'captcha', blocked: true }
      ]
    });
    assert.deepEqual(
      await fixture.verifier.verify(expectedIdentity, 'inspection-challenge-key'),
      { status: 'failed', reason: 'challenge' }
    );
    assert.deepEqual(fixture.events.map(([event]) => event), [
      'ensure', 'controller', 'exclusive:start', 'prepare', 'challenge', 'url', 'inspect',
      'challenge', 'exclusive:end'
    ]);
  });
});

test('route verifier: transport and compatibility failures never become availability claims', async (t) => {
  const expectedIdentity = identity();
  await t.test('transport', async () => {
    const fixture = verifierFixture({
      prepareError: Object.assign(new Error('private network failure'), { code: 'ECONNRESET' }),
      challenge: null
    });
    assert.deepEqual(
      await fixture.verifier.verify(expectedIdentity, 'transport-key'),
      { status: 'failed', reason: 'transport' }
    );
  });

  await t.test('compatibility error', async () => {
    const fixture = verifierFixture({
      prepareError: Object.assign(new Error('private selector drift'), { code: 'compatibility_drift' }),
      challenge: null
    });
    assert.deepEqual(
      await fixture.verifier.verify(expectedIdentity, 'compatibility-key'),
      { status: 'failed', reason: 'compatibility-drift' }
    );
  });

  await t.test('free-form exception text is never classified or exposed', async () => {
    const fixture = verifierFixture({
      inspectError: new Error('private data-message-author-role selector excerpt')
    });
    assert.deepEqual(
      await fixture.verifier.verify(expectedIdentity, 'free-form-error-key'),
      { status: 'failed', reason: 'transport' }
    );
  });

  await t.test('malformed served-conversation observation', async () => {
    const fixture = verifierFixture({ inspectResult: { status: 'served', visibleTurnCount: 0 } });
    assert.deepEqual(
      await fixture.verifier.verify(expectedIdentity, 'malformed-observation-key'),
      { status: 'failed', reason: 'compatibility-drift' }
    );
  });

  await t.test('explicit served-conversation compatibility failure', async () => {
    const fixture = verifierFixture({ inspectResult: { status: 'failed', reason: 'compatibility-drift' } });
    assert.deepEqual(
      await fixture.verifier.verify(expectedIdentity, 'observation-compatibility-key'),
      { status: 'failed', reason: 'compatibility-drift' }
    );
  });

  await t.test('malformed protective-state observation', async () => {
    const fixture = verifierFixture({ challenge: null });
    assert.deepEqual(
      await fixture.verifier.verify(expectedIdentity, 'malformed-challenge-key'),
      { status: 'failed', reason: 'compatibility-drift' }
    );
  });

  await t.test('missing controller contract', async () => {
    const events = [];
    const verifier = createChatGptRouteVerifier({
      tabs: {
        async ensureTab(input) {
          events.push(['ensure', input]);
          return 'incompatible-tab';
        },
        getControllerById(tabId) {
          events.push(['controller', tabId]);
          return {
            runExclusive: async (operation) => await operation(),
            prepareChatEntry: async () => {},
            getUrl: async () => 'https://chatgpt.com/'
          };
        }
      },
      clock: () => OBSERVED_AT
    });
    assert.deepEqual(
      await verifier.verify(expectedIdentity, 'missing-contract-key'),
      { status: 'failed', reason: 'compatibility-drift' }
    );
    assert.deepEqual(events.map(([event]) => event), ['ensure', 'controller']);
  });
});

test('route verifier: failures before a provider document is observed remain transport failures', async (t) => {
  const expectedIdentity = identity();
  for (const [reason, code] of [['not-found', 'tab_not_found'], ['forbidden', 'HTTP_403']]) {
    await t.test(reason, async () => {
      const fixture = verifierFixture({
        ensureError: Object.assign(new Error('private tab acquisition failure'), { code })
      });
      assert.deepEqual(
        await fixture.verifier.verify(expectedIdentity, `ensure-${reason}`),
        { status: 'failed', reason: 'transport' }
      );
      assert.deepEqual(fixture.events.map(([event]) => event), ['ensure']);
    });
  }

  await t.test('controller disappears after tab acquisition', async () => {
    const events = [];
    const verifier = createChatGptRouteVerifier({
      tabs: {
        async ensureTab() {
          events.push(['ensure']);
          return 'closed-tab';
        },
        getControllerById() {
          events.push(['controller']);
          return null;
        }
      },
      clock: () => OBSERVED_AT
    });
    assert.deepEqual(
      await verifier.verify(expectedIdentity, 'closed-tab-key'),
      { status: 'failed', reason: 'transport' }
    );
    assert.deepEqual(events.map(([event]) => event), ['ensure', 'controller']);
  });
});

test('route verifier: a hung provider inspection times out and quarantines later controller work', async () => {
  const fixture = verifierFixture({
    navigationTimeoutMs: 25,
    controllerPatch: {
      async inspectConversationRoute() {
        fixture.events.push(['inspect:hung']);
        return await new Promise(() => {});
      }
    }
  });

  const startedAt = Date.now();
  const outcome = await fixture.verifier.verify(identity(), 'bounded-verification-key');

  assert.deepEqual(outcome, { status: 'failed', reason: 'transport' });
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(fixture.events.at(-1)[0], 'exclusive:end');
  assert.deepEqual(
    await fixture.verifier.verify(identity(), 'still-quarantined-key'),
    { status: 'failed', reason: 'transport' }
  );
  await assert.rejects(
    fixture.controller.runExclusive(async () => 'unsafe-overlap'),
    (error) => error?.code === 'tab_busy'
  );
});

test('route verifier: late provider completion clears quarantine before the next exclusive operation', async () => {
  let releasePreparation;
  const preparation = new Promise((resolve) => {
    releasePreparation = resolve;
  });
  const fixture = verifierFixture({
    navigationTimeoutMs: 25,
    controllerPatch: {
      async prepareChatEntry() {
        fixture.events.push(['prepare:pending']);
        await preparation;
        fixture.events.push(['prepare:settled']);
      }
    }
  });

  assert.deepEqual(
    await fixture.verifier.verify(identity(), 'late-completion-key'),
    { status: 'failed', reason: 'transport' }
  );
  await assert.rejects(
    fixture.controller.runExclusive(async () => 'unsafe-overlap'),
    (error) => error?.code === 'tab_busy'
  );

  releasePreparation();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    try {
      assert.equal(await fixture.controller.runExclusive(async () => 'released'), 'released');
      return;
    } catch (error) {
      if (error?.code !== 'tab_busy') throw error;
    }
  }
  assert.fail('controller quarantine did not clear after provider operation settled');
});
