// Minimal fake of src/protocol/index.js for UI logic tests. It records calls
// and implements just enough tree semantics to exercise the UI orchestration.
// The real protocol is exercised separately in integration.test.js.

export function createFakeProtocol() {
  const calls = [];
  const conv = (id, extra = {}) => ({ id, title: '', nodes: new Map(), currentNodeId: null, complete: false, ...extra });
  const message = (id, parentId, role = 'assistant', status = 'done') => ({
    id, parentId, role, status, hidden: false, model: null, createdAt: null, source: 'canonical',
    blocks: [{ kind: 'text', markdown: `text ${id}`, citations: [] }],
  });
  const P = {
    calls,
    createConversation: (id) => conv(id),
    // Fake canonical body: {"id","title","current","nodes":[[id,parentId,role], ...]}
    parseConversation(body) {
      calls.push(['parseConversation']);
      let data;
      try { data = typeof body === 'string' ? JSON.parse(body) : body; } catch { return null; }
      if (!data || !Array.isArray(data.nodes)) return null;
      const result = conv(data.id, { title: data.title || '', currentNodeId: data.current || null, complete: true });
      for (const [id, parentId, role] of data.nodes) result.nodes.set(id, { id, parentId, childIds: [], message: message(id, parentId, role) });
      for (const node of result.nodes.values()) result.nodes.get(node.parentId)?.childIds.push(node.id);
      return result;
    },
    mergeConversation(previous, incoming) {
      calls.push(['mergeConversation', previous?.id ?? null, incoming.id]);
      const nodes = new Map(previous?.nodes || []);
      for (const [id, node] of incoming.nodes) nodes.set(id, node);
      return { ...incoming, nodes, title: incoming.title || previous?.title || '' };
    },
    applyLiveMessage(conversation, raw, context = {}) {
      calls.push(['applyLiveMessage', conversation.id, raw.id, context.fallbackParentId ?? null]);
      const nodes = new Map(conversation.nodes);
      const parentId = raw.parent ?? context.fallbackParentId ?? null;
      nodes.set(raw.id, { id: raw.id, parentId, childIds: [], message: message(raw.id, parentId, raw.role || 'assistant', raw.status || 'streaming') });
      return { ...conversation, nodes, currentNodeId: raw.id };
    },
    selectTurns(conversation, leafId = null) {
      calls.push(['selectTurns', conversation.id, leafId]);
      const path = [];
      for (let id = leafId ?? conversation.currentNodeId; id && conversation.nodes.has(id); id = conversation.nodes.get(id).parentId) {
        path.unshift(conversation.nodes.get(id).message);
      }
      const turns = [];
      const branch = { index: 0, count: 1, siblingIds: [] };
      for (const item of path.filter(Boolean)) {
        if (item.role === 'user' || !turns.length) turns.push({ user: item.role === 'user' ? item : null, replies: item.role === 'user' ? [] : [item], userBranch: branch, replyBranch: branch });
        else turns.at(-1).replies.push(item);
      }
      return turns;
    },
    switchBranch(conversation, nodeId, delta) {
      calls.push(['switchBranch', nodeId, delta]);
      const node = conversation.nodes.get(nodeId);
      const siblings = conversation.nodes.get(node?.parentId)?.childIds || [];
      let next = siblings[siblings.indexOf(nodeId) + delta];
      if (!next) return null;
      while (conversation.nodes.get(next).childIds.length) next = conversation.nodes.get(next).childIds.at(-1);
      return next;
    },
    // Fake stream: every chunk is a JSON array of StreamEvents.
    createStreamDecoder() {
      return { push: (chunk) => JSON.parse(chunk), end: () => [{ type: 'done' }] };
    },
    parseConversationList(body) {
      try { const data = JSON.parse(body); return Array.isArray(data.items) ? data.items : null; } catch { return null; }
    },
    messageToPlainText: (m) => m.blocks.map((b) => b.markdown || '').join('\n'),
    conversationToMarkdown: () => '# export',
  };
  return P;
}

export const canonical = (id, nodes, current, title = '') => JSON.stringify({ id, title, current, nodes });
