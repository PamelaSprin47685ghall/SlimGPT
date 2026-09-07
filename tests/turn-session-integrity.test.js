import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../main-mitm.js', import.meta.url), 'utf8');
const sessionStart = source.indexOf('  async function snapshotSubmissionTurn(');
const sessionEnd = source.indexOf('  function conversationIdFromRequestBody(', sessionStart);
const notificationStart = source.indexOf('  function conversationNotifications(');
const notificationEnd = source.indexOf('  function scheduleConversationSocketReconnect(', notificationStart);
const xhrStart = source.indexOf('  async function snapshotXhrSubmissionTurn(');
const xhrEnd = source.indexOf('  function observeXhrResponse(', xhrStart);
assert.ok(sessionStart > 0 && sessionEnd > sessionStart && notificationEnd > notificationStart);
const make = new Function(`
  let turnSessionCounter = 0, turnSubmissionOrdinal = 0, pendingNewTurnSession = null;
  const activeTurnSessions = new Map(), turnSessionReservations = new Map(), executionStates = new Map();
  const MAX_EXECUTION_STATES = 256, MAX_IDENTITY_BODY = 1048576, NEW_CHAT_EXECUTION_KEY = 'new';
  const nextTurnSessionId = () => 'session-' + (++turnSessionCounter);
  const requestConversationIndexSync = () => {}, emitExecutionState = () => {};
  const isProvisionalConversationId = (id) => /^WEB:/i.test(id);
  ${source.slice(sessionStart, sessionEnd)}
  ${source.slice(xhrStart, xhrEnd)}
  ${source.slice(notificationStart, notificationEnd)}
  return { snapshotSubmissionTurn, snapshotXhrSubmissionTurn, snapshotActiveTurn, releaseTurnSession, bindPendingTurnSession,
    registerTurnSession, observeCapturedTurn, turnIdentityFromRequestBody, notificationMatchesTurnSession, notificationMatchesPendingNewTurn,
    adoptNotificationTurnIdentity, conversationNotifications, notificationExecutionState, applicableNotificationState,
    active: activeTurnSessions, reservations: turnSessionReservations,
    pending: () => pendingNewTurnSession };
`);
const deferred = () => {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
};
const request = (user, turn = null) => new Request('https://chatgpt.com/backend-api/conversation', {
  method: 'POST', body: JSON.stringify({ messages: [{ id: user, author: { role: 'user' }, content: { parts: ['fixture'] },
    metadata: turn ? { turn_exchange_id: turn } : {} }], parent_message_id: 'parent' }),
});
const scope = (id) => Promise.resolve({ conversationId: id, conflicted: false });
const notification = (id, user = null) => ({ conversationId: 'c', turnId: id, turnExchangeId: id,
  turnAliases: id ? [id] : [], turnUserMessageId: user });

test('late request-body resolution cannot replace a newer active user turn', async () => {
  const h = make(), oldScope = deferred();
  const old = h.snapshotSubmissionTurn(request('u1', 't1'), oldScope.promise);
  const newer = await h.snapshotSubmissionTurn(request('u2', 't2'), scope('c'));
  oldScope.resolve({ conversationId: 'c', conflicted: false });
  const oldSession = await old;
  assert.equal(h.active.get('c').sessionId, newer.sessionId);
  assert.equal(oldSession.userMessageId, 'u1', 'old capture still owns its original identity');
  assert.equal(h.active.get('c').userMessageId, 'u2');
});

test('an unresolved existing-conversation request is not a pending new chat', async () => {
  const h = make(), delayedScope = deferred();
  const pending = h.snapshotSubmissionTurn(request('u'), delayedScope.promise);
  assert.equal(h.bindPendingTurnSession('unrelated'), null);
  delayedScope.resolve({ conversationId: 'c', conflicted: false });
  await pending;
  assert.equal(h.active.has('unrelated'), false);
  assert.equal(h.active.get('c').conversationId, 'c');
});

test('a conflicting request scope does not leave a claimable pending session', async () => {
  const h = make();
  await h.snapshotSubmissionTurn(request('u'), Promise.resolve({ conversationId: null, conflicted: true }));
  assert.equal(h.pending(), null);
  assert.equal(h.bindPendingTurnSession('other'), null);
});

test('new-chat binding never claims an unrelated notification by arrival order or a transport id', async () => {
  const h = make();
  const pending = await h.snapshotSubmissionTurn(request('new-user'), scope(null));
  assert.equal(h.notificationMatchesPendingNewTurn(notification('some-other-turn'), pending), false);
  assert.equal(h.notificationMatchesPendingNewTurn(notification(pending.transportTurnId), pending), false);
  assert.equal(h.notificationMatchesPendingNewTurn(notification('real-turn', 'new-user'), pending), true);
});

test('unknown stop ownership never matches a known active session, while exact user/turn identity does', async () => {
  const h = make();
  const session = await h.snapshotSubmissionTurn(request('u', 'turn'), scope('c'));
  assert.equal(h.notificationMatchesTurnSession(notification(null), session), false);
  assert.equal(h.notificationMatchesTurnSession(notification('old-turn'), session), false);
  assert.equal(h.notificationMatchesTurnSession(notification('turn'), session), true);
  assert.equal(h.notificationMatchesTurnSession(notification(null, 'u'), session), true);
  assert.equal(h.notificationMatchesTurnSession(notification('turn', 'another-user'), session), false);
});

test('alias intersection cannot override an explicitly different exchange id', async () => {
  const h = make();
  const session = await h.snapshotSubmissionTurn(request('u', 't2'), scope('c'));
  session.turnAliases.push('shared-request');
  assert.equal(h.notificationMatchesTurnSession({ ...notification('t1'), turnAliases: ['t1', 'shared-request'] }, session), false);
});

test('an uncorrelated notification cannot inject its aliases into a session without server identity', async () => {
  const h = make();
  await h.snapshotSubmissionTurn(request('u'), scope('c'));
  h.adoptNotificationTurnIdentity('c', notification('unrelated'));
  assert.deepEqual(h.active.get('c').turnAliases, []);
  h.adoptNotificationTurnIdentity('c', notification('correct', 'u'));
  assert.deepEqual(h.active.get('c').turnAliases, ['correct']);
});

test('release of an old capture cannot delete a newly submitted turn', async () => {
  const h = make();
  const old = await h.snapshotSubmissionTurn(request('u1', 't1'), scope('c'));
  const newer = await h.snapshotSubmissionTurn(request('u2', 't2'), scope('c'));
  await h.releaseTurnSession(old);
  assert.equal(h.active.get('c').sessionId, newer.sessionId);
});

test('late resolution of an older new-chat submission cannot steal the newest pending chat', async () => {
  const h = make(), oldScope = deferred();
  const old = h.snapshotSubmissionTurn(request('old'), oldScope.promise);
  const latest = await h.snapshotSubmissionTurn(request('latest'), scope(null));
  oldScope.resolve({ conversationId: null, conflicted: false });
  await old;
  assert.equal(h.pending().sessionId, latest.sessionId);
});

test('a resume with only a conversation id cannot claim an unrelated pending new chat', async () => {
  const h = make();
  await h.snapshotSubmissionTurn(request('u'), scope(null));
  assert.equal(await h.snapshotActiveTurn(scope('unrelated')), null);
  assert.equal(h.pending().userMessageId, 'u');
});

test('notification normalization retains explicit user ownership and rejects conflicting envelope ids', () => {
  const h = make();
  const wire = (payload) => JSON.stringify({ type: 'message', topic_id: 'conversations', payload });
  const [event] = h.conversationNotifications(wire({ type: 'conversation-turn-started', conversation_id: 'c',
    payload: { turn_exchange_id: 't', user_message_id: 'u' } }));
  assert.equal(event.conversationId, 'c');
  assert.equal(event.turnUserMessageId, 'u');
  assert.deepEqual(h.conversationNotifications(wire({ conversation_id: 'a', payload: { conversation_id: 'b' } })), []);
});

test('a delayed stop neither changes the new turn execution state nor authorizes cleanup', async () => {
  const h = make();
  const active = await h.snapshotSubmissionTurn(request('u2', 't2'), scope('c'));
  assert.equal(h.applicableNotificationState({ ...notification('t1'), type: 'conversation-turn-stopped' }, active), null);
  assert.equal(h.applicableNotificationState({ ...notification(null), type: 'conversation-turn-stopped' }, active), null);
  assert.equal(h.applicableNotificationState({ ...notification('t2'), type: 'conversation-turn-stopped' }, active), 'stopped');
  assert.equal(h.applicableNotificationState({ ...notification('t1'), type: 'conversation-turn-stopped' }, null), 'stopped');
});

test('a resume snapshot takes identity at interception entry instead of after its scope resolves', async () => {
  const h = make();
  const old = await h.snapshotSubmissionTurn(request('u1', 't1'), scope('c'));
  const delayed = deferred();
  const resumed = h.snapshotActiveTurn(delayed.promise);
  await h.snapshotSubmissionTurn(request('u2', 't2'), scope('c'));
  delayed.resolve({ conversationId: 'c', conflicted: false });
  const session = await resumed;
  assert.equal(session.sessionId, old.sessionId);
  assert.equal(session.userMessageId, 'u1');
});

test('a slow older submission remains retired even after the newer turn was released', async () => {
  const h = make(), delayed = deferred();
  const old = h.snapshotSubmissionTurn(request('u1', 't1'), delayed.promise);
  const current = await h.snapshotSubmissionTurn(request('u2', 't2'), scope('c'));
  await h.releaseTurnSession(current);
  delayed.resolve({ conversationId: 'c', conflicted: false });
  await old;
  assert.equal(h.active.has('c'), false);
});

test('captured response metadata enriches exactly its originating session for later stop/resume matching', async () => {
  const h = make();
  const session = await h.snapshotSubmissionTurn(request('u'), scope(null));
  h.observeCapturedTurn({ conversation_id: 'c', message: { id: 'a', author: { role: 'assistant' },
    metadata: { turn_exchange_id: 'server-turn' } } }, { transportSessionId: session.sessionId });
  assert.equal(h.pending(), null);
  assert.equal(h.active.get('c').sessionId, session.sessionId);
  assert.deepEqual(h.active.get('c').turnAliases, ['server-turn']);
  assert.equal(h.notificationMatchesTurnSession(notification('server-turn'), h.active.get('c')), true);
  h.observeCapturedTurn({ conversation_id: 'foreign', message: { id: 'a', author: { role: 'assistant' },
    metadata: { turn_exchange_id: 'wrong' } } }, { transportSessionId: session.sessionId });
  assert.deepEqual(h.active.get('c').turnAliases, ['server-turn']);
});

test('stream content and released-session responses cannot invent or revive turn identities', async () => {
  const h = make();
  const session = await h.snapshotSubmissionTurn(request('u'), scope('c'));
  h.observeCapturedTurn({ message: { id: 'tool', author: { role: 'tool' }, content: {
    message: { metadata: { turn_exchange_id: 'quoted-example' } },
  } } }, { transportSessionId: session.sessionId });
  assert.deepEqual(session.turnAliases, []);
  await h.releaseTurnSession(session);
  h.observeCapturedTurn({ message: { id: 'a', author: { role: 'assistant' }, metadata: { turn_exchange_id: 'late' } } }, { transportSessionId: session.sessionId });
  assert.deepEqual(session.turnAliases, []);
  assert.equal(h.active.has('c'), false);
});

test('fetch and XHR submissions share one monotonic registration order', async () => {
  const h = make(), delayed = deferred();
  const old = h.snapshotXhrSubmissionTurn(JSON.stringify({ messages: [{ id: 'xhr-user', author: { role: 'user' } }] }), delayed.promise);
  assert.equal(h.pending(), null);
  const current = await h.snapshotSubmissionTurn(request('fetch-user'), scope('c'));
  delayed.resolve({ conversationId: 'c', conflicted: false });
  await old;
  assert.equal(h.active.get('c').sessionId, current.sessionId);
  const xhr = await h.snapshotXhrSubmissionTurn({ messages: [{ id: 'new-xhr', author: { role: 'user' } }] }, scope('c'));
  assert.equal(h.active.get('c').sessionId, xhr.sessionId);
});

test('failed scope parsing never turns an existing request into a bindable new chat', async () => {
  for (const transport of ['fetch', 'xhr']) {
    const h = make();
    const badScope = Promise.reject(new Error('fixture parse failure'));
    if (transport === 'fetch') await h.snapshotSubmissionTurn(request('u'), badScope);
    else await h.snapshotXhrSubmissionTurn({ messages: [{ id: 'u', author: { role: 'user' } }] }, badScope);
    assert.equal(h.pending(), null);
    assert.equal(h.active.size, 0);
  }
});

test('an explicit old resume identity beats the currently active new submission', async () => {
  const h = make();
  const old = await h.snapshotSubmissionTurn(request('u1', 't1'), scope('c'));
  await h.snapshotSubmissionTurn(request('u2', 't2'), scope('c'));
  const resumed = await h.snapshotActiveTurn(scope('c'), h.turnIdentityFromRequestBody({ user_message_id: 'u1', turn_exchange_id: 't1' }));
  assert.equal(resumed.sessionId, old.sessionId);
  assert.equal(await h.snapshotActiveTurn(scope('c'), { userMessageId: 'not-known' }), null);
});

test('resume cannot guess between multiple regenerated submissions sharing a user id', async () => {
  const h = make();
  await h.snapshotSubmissionTurn(request('same-user', 't1'), scope('c'));
  await h.snapshotSubmissionTurn(request('same-user', 't2'), scope('c'));
  assert.equal(await h.snapshotActiveTurn(scope('c'), { userMessageId: 'same-user' }), null);
  const exact = await h.snapshotActiveTurn(scope('c'), { userMessageId: 'same-user', turnExchangeId: 't1', turnAliases: ['t1'] });
  assert.equal(exact.turnExchangeId, 't1');
});

test('a matching user can associate a newly supplied exchange id with an existing request alias', async () => {
  const h = make();
  const req = new Request('https://chatgpt.com/backend-api/conversation', { method: 'POST', body: JSON.stringify({
    messages: [{ id: 'u', author: { role: 'user' }, metadata: { request_id: 'client-request' } }],
  }) });
  await h.snapshotSubmissionTurn(req, scope('c'));
  h.adoptNotificationTurnIdentity('c', notification('server-exchange', 'u'));
  assert.deepEqual(h.active.get('c').turnAliases, ['client-request', 'server-exchange']);
});
