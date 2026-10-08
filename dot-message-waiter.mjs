import { requestJson } from './mcp-lib.mjs';
import { parseDotCursor, parseDotMessageBatch, sameDotBinding } from './chatgpt-recipient.mjs';

export async function waitForDotMessages({ conn, body, signal, request = requestJson } = {}) {
  const input = parseDotCursor(body.after);
  const deadline = body.timeoutMs > 0 ? Date.now() + body.timeoutMs : Infinity;
  while (true) {
    if (signal?.aborted) throw signal.reason || new Error('wait_aborted');
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { binding: input.binding, messages: [], cursor: body.after, hasMore: false, timedOut: true };
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    let timer;
    let expired = false;
    try {
      const running = request({ ...conn, method: 'POST', path: '/dot/wait', signal: controller.signal, body: { ...body, timeoutMs: Math.min(25_000, remaining) } });
      const response = Number.isFinite(remaining) ? await Promise.race([running, new Promise((resolve) => {
        timer = setTimeout(() => { expired = true; controller.abort(); resolve(null); }, remaining);
      })]) : await running;
      if (expired) return { binding: input.binding, messages: [], cursor: body.after, hasMore: false, timedOut: true };
      const batch = parseDotMessageBatch(response);
      if (!sameDotBinding(input.binding, batch.binding)) throw new Error('dot_binding_mismatch');
      if (batch.messages.length || batch.hasMore) return batch;
      if (batch.cursor !== body.after) throw new Error('invalid_dot_batch');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}
