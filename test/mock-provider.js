import http from 'node:http';

const sse = (res, events, { end = true } = {}) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
  if (end) res.end();
};

function openai(model, req, res, body) {
  const label = body.messages[0].content.split('.')[0];
  if (model === 'unauthorized') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'bad key sk-openai-secret' } }));
  }
  const delta = (content, extra = {}) => ({ choices: [{ delta: { content }, ...extra }] });
  if (model === 'cut') return sse(res, [delta('partial')]);
  if (model === 'empty') return sse(res, [{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']);
  if (model === 'bad-error') return sse(res, [{ error: { message: [{ msg: 'not a string' }] } }]);
  const finish_reason = model === 'long' ? 'length' : 'stop';
  // Holding the connection open after [DONE] proves the lane does not hang.
  sse(res, [
    delta('openai '), delta(`says: ${label}`),
    { choices: [{ delta: {}, finish_reason }], usage: { prompt_tokens: 11, completion_tokens: 7 } },
    '[DONE]'
  ], { end: false });
}

function gemini(model, res, body) {
  if (model === 'redirect') {
    res.writeHead(307, { Location: `http://127.0.0.1:${res.socket.localPort}/collector` });
    return res.end();
  }
  if (model === 'blocked') return sse(res, [{ promptFeedback: { blockReason: 'SAFETY' } }]);
  const label = body.systemInstruction.parts[0].text.split('.')[0];
  sse(res, [
    { candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: 'gemini ' }] } }] },
    { candidates: [{ content: { parts: [{ text: `says: ${label}` }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } }
  ]);
}

function anthropic(res, body) {
  const label = body.system.split('.')[0];
  const refused = body.model === 'claude-refuses';
  const events = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, output_tokens: 1 } } },
    ...(refused ? [] : [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `anthropic says: ${label}` } },
      { type: 'content_block_stop', index: 0 }
    ]),
    { type: 'message_delta', delta: { stop_reason: refused ? 'refusal' : 'end_turn', stop_sequence: null, ...(refused ? { stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' } } : {}) }, usage: { output_tokens: 4 } },
    { type: 'message_stop' }
  ];
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

export async function startMock() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      if (req.url === '/collector') {
        res.writeHead(200).end('collected');
        return;
      }
      const body = JSON.parse(raw);
      requests.push({ url: req.url, headers: req.headers, body });
      if (req.url === '/openai/chat/completions') return openai(body.model, req, res, body);
      const g = req.url.match(/^\/gemini\/models\/([^:]+):streamGenerateContent\?alt=sse$/);
      if (g) return gemini(g[1], res, body);
      if (req.url.startsWith('/anthropic/v1/messages')) return anthropic(res, body);
      res.writeHead(404).end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    requests,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.closeAllConnections(); server.close(); }
  };
}
