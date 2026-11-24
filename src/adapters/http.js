const MAX_SSE_EVENT_CHARS = 1_048_576;
const MAX_ERROR_BODY_BYTES = 65_536;
export const MAX_STREAM_TEXT_CHARS = 2_000_000;

// Yields the data payload of each server-sent event. Handles LF and CRLF line
// endings and an unterminated final event, while capping event size so a
// non-SSE or runaway response cannot exhaust memory.
export async function* sseData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const payload = block => block.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''))
    .join('\n');

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        const data = payload(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (data) yield data;
      }
      if (buffer.length > MAX_SSE_EVENT_CHARS) {
        throw new Error('SSE event exceeded 1 MiB limit.');
      }
    }
    const data = payload(buffer + decoder.decode());
    if (data) yield data;
  } finally {
    // Stops a server that holds the connection open after its final event.
    reader.cancel().catch(() => {});
  }
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readBoundedText(body, maxBytes) {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let out = '';
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const slice = value.byteLength > maxBytes - total ? value.subarray(0, maxBytes - total) : value;
      total += slice.byteLength;
      out += decoder.decode(slice, { stream: true });
    }
    return out + decoder.decode();
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function httpErrorEvent(response) {
  let detail = response.statusText || 'request failed';
  try {
    const json = parseJson(await readBoundedText(response.body, MAX_ERROR_BODY_BYTES));
    if (typeof json?.error?.message === 'string' && json.error.message.trim()) {
      detail = json.error.message;
    }
  } catch {
    // Not every error body is readable JSON.
  }
  if (response.status === 401 || response.status === 403 || /api key not valid/i.test(detail)) {
    return { type: 'error', code: 'AUTH_ERROR', message: `authentication error (${response.status}): ${detail}` };
  }
  if (response.status === 429) {
    return { type: 'error', code: 'RATE_LIMIT', message: `rate limit (429): ${detail}` };
  }
  return { type: 'error', code: 'SERVER_ERROR', message: `HTTP ${response.status}: ${detail}` };
}

export function exceptionEvent(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return { type: 'error', code: 'ABORTED', message: 'request aborted.' };
  }
  return { type: 'error', code: 'NETWORK', message: `network or stream error: ${error?.message || String(error)}` };
}
