import MarkdownWorker from '../../markdown-worker.js?worker';

const worker = new MarkdownWorker();
const listeners = new Map();
let nextRequestId = 0;

worker.onmessage = (event) => {
  const result = event.data;
  const request = listeners.get(result?.requestId);
  if (!request) return;
  listeners.delete(result.requestId);
  request.listener(result);
};

export function renderMarkdown(id, text, listener) {
  const requestId = ++nextRequestId;
  listeners.set(requestId, { listener });
  worker.postMessage({ requestId, cacheKey: id, text });
  return () => {
    listeners.delete(requestId);
  };
}
