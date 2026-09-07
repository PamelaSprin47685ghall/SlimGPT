const strings = (values) => [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
const subjectIds = (row) => strings([row?.id, row?.nodeId, row?.itemId]);
const callIds = (row) => strings([row?.callId, row?.toolCallId, ...(row?.callIds || []), row?.tool?.callId, row?.tool?.toolCallId, ...(row?.tool?.callIds || [])]);

// Preserve namespaces: a worker request id is not an exchange id just because
// their strings happen to match. Listed numbers are evidence classes, never
// time, position in an array, or distance to a nearby user message.
export function semanticOwnershipKeys(row) {
  const keys = [
    ['exchange', row?.turnExchangeId, 1], ['working', row?.workingTurnId, 4],
    ['request', row?.turnRequestId, 5], ['trace', row?.turnTraceId, 6],
  ].filter(([, value]) => typeof value === 'string' && value);
  if (!keys.length) for (const value of strings([row?.turnId, ...(row?.turnAliases || [])])) keys.push(['legacy', value, 7]);
  return keys;
}

/** Solve ownership from the entire selected history + live item graph.
 * A final item's anchor can identify preceding output ancestors and tool
 * components. Canonical/live is provenance, not a one-way resolution barrier.
 * Explicit owner/exchange evidence overrides a misleading parent; user nodes
 * are boundaries, so back-propagation can never cross into the previous turn.
 */
export function resolveOwnershipGraph(rows, users) {
  const allRows = [...new Set([...rows, ...users].filter(Boolean))];
  const userSet = new Set(users);
  const usersById = new Map();
  const subjects = new Map();
  const legacyOwners = new Map();
  const userAliases = new Map();
  const nodes = new Map();
  const hubs = new Map();
  const queues = Array.from({ length: 9 }, () => []);
  const addIndex = (index, id, value) => {
    const values = index.get(id) || new Set();
    values.add(value);
    index.set(id, values);
  };
  for (const user of users) for (const id of strings([...subjectIds(user), user.turnUserMessageId])) addIndex(usersById, id, user);
  for (const user of users) for (const [, id] of semanticOwnershipKeys(user)) addIndex(userAliases, id, user);
  const nodeFor = (row) => {
    if (!nodes.has(row)) nodes.set(row, { row, edges: [], strength: Infinity, owners: new Map(), queued: null });
    return nodes.get(row);
  };
  const edge = (from, to, strength, kind, reference) => from.edges.push({ to, strength, kind, reference });
  const hub = (kind, id) => {
    const key = `${kind}\0${id}`;
    if (!hubs.has(key)) hubs.set(key, { row: null, edges: [], strength: Infinity, owners: new Map(), queued: null });
    return hubs.get(key);
  };
  const link = (row, kind, id, strength) => {
    if (!id) return;
    const node = nodeFor(row), shared = hub(kind, id);
    edge(node, shared, strength, kind, id);
    if (!userSet.has(row)) edge(shared, node, strength, kind, id);
  };
  for (const row of allRows) {
    nodeFor(row);
    for (const id of subjectIds(row)) addIndex(subjects, id, row);
    for (const [kind, id, strength] of semanticOwnershipKeys(row)) link(row, kind, id, strength);
    // A call/result and a response component already have protocol identities.
    link(row, 'response', row.responseId, 2);
    link(row, 'item', row.itemId, 2);
    for (const id of callIds(row)) link(row, 'call', id, 2);
  }

  // Legacy local ledgers retained only the untyped alias list. Connect those
  // records to matching typed evidence in one direction, so they cannot join
  // two otherwise independent protocol namespaces.
  const typedByValue = new Map();
  for (const row of allRows) for (const [kind, id, strength] of semanticOwnershipKeys(row)) {
    if (kind !== 'legacy') addIndex(typedByValue, id, hub(kind, id));
  }
  for (const row of allRows) for (const [kind, id] of semanticOwnershipKeys(row)) {
    if (kind !== 'legacy') continue;
    for (const typed of typedByValue.get(id) || []) {
      if (userSet.has(row)) edge(nodeFor(row), typed, 7, 'legacy-alias', id);
      else edge(typed, nodeFor(row), 7, 'legacy-alias', id);
    }
  }

  for (const row of allRows) {
    if (userSet.has(row)) continue;
    const node = nodeFor(row);
    if (semanticOwnershipKeys(row).every(([kind]) => kind === 'legacy')) {
      const candidates = new Set(semanticOwnershipKeys(row).flatMap(([, id]) => [...(userAliases.get(id) || [])]));
      if (candidates.size) legacyOwners.set(row, candidates);
      if (candidates.size === 1) edge(nodeFor([...candidates][0]), node, 1, 'legacy-alias', row.turnId);
    }
    const owners = usersById.get(row.turnUserMessageId);
    if (owners?.size === 1) edge(nodeFor([...owners][0]), node, 0, 'user-message', row.turnUserMessageId);
    // turnParentMessageId is the prior context in the submit request, not a
    // parent of this response item. Only the actual item parent participates.
    const parents = subjects.get(row.parentId);
    for (const parent of parents || []) {
      if (parent === row) continue;
      edge(nodeFor(parent), node, 3, 'parent', row.parentId);
      if (parents.size === 1 && !userSet.has(parent)) edge(node, nodeFor(parent), 8, 'child', row.id || row.nodeId);
    }
  }

  const permitted = (node, owner) => {
    const row = node.row;
    if (!row) return true;
    if (userSet.has(row)) return row === owner;
    const legacy = legacyOwners.get(row);
    if (legacy && (legacy.size > 1 || !legacy.has(owner))) return false;
    if (row.turnUserMessageId && !usersById.get(row.turnUserMessageId)?.has(owner)) return false;
    if (row.turnExchangeId && owner.turnExchangeId && row.turnExchangeId !== owner.turnExchangeId) return false;
    return true;
  };
  const offer = (node, owner, strength, proof) => {
    if (!permitted(node, owner) || strength > node.strength) return;
    if (strength < node.strength) { node.strength = strength; node.owners.clear(); }
    if (node.owners.has(owner)) return;
    node.owners.set(owner, proof);
    if (node.queued !== strength) { queues[strength].push(node); node.queued = strength; }
  };
  for (const user of users) offer(nodeFor(user), user, 0, null);
  // Settle stronger evidence before letting weaker links propagate. Otherwise
  // a late stronger proof could leave a stale candidate downstream of a
  // weaker bottleneck, making the result depend on iteration order.
  for (let strength = 0; strength < queues.length; strength++) {
    const queue = queues[strength];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const node = queue[cursor];
      if (node.strength !== strength) continue;
      node.queued = null;
      for (const relation of node.edges) {
        for (const [owner, previous] of node.owners) offer(relation.to, owner,
          Math.max(node.strength, relation.strength), { kind: relation.kind, reference: relation.reference, previous });
      }
    }
  }

  const resolved = new Map();
  const failures = new Map();
  for (const row of allRows) {
    if (userSet.has(row)) continue;
    const state = nodeFor(row);
    if (state.owners.size === 1) {
      const [user, proof] = [...state.owners][0];
      const evidence = [];
      const seen = new Set();
      for (let cursor = proof; cursor && evidence.length < 64; cursor = cursor.previous) {
        const key = `${cursor.kind}\0${cursor.reference}`;
        if (!seen.has(key)) { seen.add(key); evidence.push({ kind: cursor.kind, reference: cursor.reference }); }
      }
      resolved.set(row, { user, userMessageId: user.id || user.nodeId, evidence });
    } else {
      const reason = state.owners.size > 1 || legacyOwners.get(row)?.size > 1 ? 'conflicting-evidence'
        : row.turnUserMessageId && !usersById.has(row.turnUserMessageId) ? 'missing-user-message'
        : row.parentId && !subjects.has(row.parentId) ? 'missing-parent-message'
        : 'missing-owner-anchor';
      failures.set(row, { reason, messageId: row.id || row.nodeId || null,
        parentId: row.parentId || null, userMessageId: row.turnUserMessageId || null,
        identities: semanticOwnershipKeys(row).map(([kind, id]) => ({ kind, id })),
        responseId: row.responseId || null, callIds: callIds(row),
      });
    }
  }
  return { resolved, failures };
}
