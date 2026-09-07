const strings = (values) => [...new Set((values || []).filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];

/** Pending UI ownership must be established before enriching its identity.
 * A foreign event cannot teach the pending turn its own id and then "match". */
export function matchesPendingTurn(pending, conversationId, evidence = {}) {
  if (!pending) return false;
  if (pending.conversationId && conversationId && pending.conversationId !== conversationId) return false;
  if (evidence.conversationIdConflict) return false;
  const expectedUsers = strings([pending.userMessageId, pending.message?.turnUserMessageId]);
  const observedUser = typeof evidence.turnUserMessageId === 'string' ? evidence.turnUserMessageId.trim() : '';
  if (observedUser && expectedUsers.length && !expectedUsers.includes(observedUser)) return false;
  const expectedSessions = strings([pending.transportSessionId, pending.message?.transportSessionId]);
  const observedSession = evidence.transportSessionId;
  if (observedSession && expectedSessions.length && !expectedSessions.includes(observedSession)) return false;
  const expectedTransport = strings([...expectedSessions, pending.transportTurnId, pending.message?.transportTurnId]);
  const observedTransport = strings([observedSession, evidence.transportTurnId]);
  const expectedAliases = strings([...(pending.turnAliases || []), pending.turnId,
    ...(pending.message?.turnAliases || []), pending.message?.turnId]);
  const aliases = strings([...(evidence.turnAliases || []), evidence.turnId]);
  const expectedExchange = pending.turnExchangeId || pending.message?.turnExchangeId;
  if (evidence.turnExchangeId && expectedExchange && evidence.turnExchangeId !== expectedExchange) return false;
  if (observedUser && expectedUsers.includes(observedUser)) return true;
  if (observedTransport.some((id) => expectedTransport.includes(id))) return true;
  if (aliases.some((id) => expectedAliases.includes(id))) return true;
  // Bootstrap only once from the actual intercepted submission. Generic
  // broadcasts and same-text historical messages never establish ownership.
  return evidence.conversationRequest === true &&
    expectedUsers.length === 0 && expectedTransport.length === 0 && expectedAliases.length === 0;
}
