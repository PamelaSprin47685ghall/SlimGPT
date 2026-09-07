import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesPendingTurn } from '../src/lib/pending-turn.js';

const fresh = () => ({ conversationId: null, text: 'same text', message: { id: 'pending-local', text: 'same text' } });

test('an unrelated broadcast cannot initialize a pending turn identity', () => {
  assert.equal(matchesPendingTurn(fresh(), 'other', { turnId: 'other-turn', turnAliases: ['other-turn'] }), false);
  assert.equal(matchesPendingTurn(fresh(), 'other', { turnUserMessageId: 'other-user' }), false);
  assert.equal(matchesPendingTurn(fresh(), 'new', { conversationRequest: true, transportSessionId: 'submission' }), true);
});

test('once bound to a submission, the generic request flag cannot override conflicting user/session evidence', () => {
  const pending = { ...fresh(), userMessageId: 'u', transportSessionId: 'session', turnAliases: ['turn'] };
  assert.equal(matchesPendingTurn(pending, 'c', { conversationRequest: true, turnUserMessageId: 'old' }), false);
  assert.equal(matchesPendingTurn(pending, 'c', { conversationRequest: true, turnUserMessageId: 'u', transportSessionId: 'other-session' }), false);
  assert.equal(matchesPendingTurn(pending, 'c', { conversationRequest: true }), false);
  assert.equal(matchesPendingTurn(pending, 'c', { transportSessionId: 'session', turnAliases: ['new-server-alias'] }), true);
});

test('semantic identity and local transport identity are independent namespaces', () => {
  const pending = { ...fresh(), transportTurnId: 'transport' };
  assert.equal(matchesPendingTurn(pending, 'c', { turnAliases: ['transport'] }), false);
  assert.equal(matchesPendingTurn(pending, 'c', { transportTurnId: 'transport' }), true);
});

test('matching metadata cannot override a different conversation or explicit exchange', () => {
  const pending = { ...fresh(), conversationId: 'c', userMessageId: 'u', turnExchangeId: 'turn' };
  assert.equal(matchesPendingTurn(pending, 'foreign', { turnUserMessageId: 'u' }), false);
  assert.equal(matchesPendingTurn(pending, 'c', { turnUserMessageId: 'u', turnExchangeId: 'old' }), false);
  assert.equal(matchesPendingTurn(pending, 'c', { turnUserMessageId: 'u', conversationIdConflict: true }), false);
  assert.equal(matchesPendingTurn(pending, 'c', { turnUserMessageId: 'u' }), true);
});
