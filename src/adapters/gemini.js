/**
 * Google Gemini adapter
 */
import { exceptionEvent, httpErrorEvent, MAX_STREAM_TEXT_CHARS, parseJson, sseData } from './http.js';

export async function* call(slot, systemPrompt, userPrompt, signal) {
  const { baseUrl, apiKey, selectedModel } = slot;
  const startTime = performance.now();

  try {
    // The key goes in a header because URLs end up in logs and error messages.
    // Redirects are rejected so x-goog-api-key is never forwarded cross-origin.
    const model = encodeURIComponent(selectedModel);
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        systemInstruction: { role: 'user', parts: [{ text: systemPrompt }] }
      }),
      redirect: 'error',
      signal
    });

    if (!response.ok) {
      yield await httpErrorEvent(response);
      return;
    }

    let fullText = '';
    let finishReason = null;
    let tokensIn = 0;
    let tokensOut = 0;

    for await (const data of sseData(response.body)) {
      const parsed = parseJson(data);
      if (!parsed) continue;
      if (parsed.promptFeedback?.blockReason) {
        yield { type: 'error', code: 'REFUSAL', message: `the provider blocked this brief (${parsed.promptFeedback.blockReason}).` };
        return;
      }
      const candidate = parsed.candidates?.[0];
      for (const part of candidate?.content?.parts || []) {
        if (typeof part?.text === 'string' && part.text && !part.thought) {
          fullText += part.text;
          if (fullText.length > MAX_STREAM_TEXT_CHARS) {
            yield { type: 'error', code: 'SERVER_ERROR', message: 'response exceeded 2 MB output limit.' };
            return;
          }
          yield { type: 'delta', text: part.text };
        }
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      if (parsed.usageMetadata) {
        tokensIn = parsed.usageMetadata.promptTokenCount || 0;
        tokensOut = parsed.usageMetadata.candidatesTokenCount || 0;
      }
    }

    if (!finishReason) {
      yield { type: 'error', code: 'STREAM_ERROR', message: 'stream ended before the model finished.' };
      return;
    }
    if (finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
      yield { type: 'error', code: 'REFUSAL', message: `the provider stopped the answer (${finishReason}).` };
      return;
    }

    yield {
      type: 'done',
      text: fullText,
      tokensIn,
      tokensOut,
      model: selectedModel,
      truncated: finishReason === 'MAX_TOKENS',
      latencyMs: Math.round(performance.now() - startTime)
    };
  } catch (error) {
    yield exceptionEvent(error);
  }
}
