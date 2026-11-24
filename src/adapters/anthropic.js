import Anthropic from '@anthropic-ai/sdk';
import { exceptionEvent } from './http.js';

// These models accept output_config.effort and the server-side refusal fallback.
// Older Claude models can reject either, so they get a plain request.
const CURRENT_MODEL = /^claude-(?:(?:fable|mythos)-5-[12]|opus-5(?:-5)?|sonnet-5-5)$/;

function errorEvent(error) {
  if (error instanceof Anthropic.APIUserAbortError) {
    return { type: 'error', code: 'ABORTED', message: 'request aborted.' };
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return { type: 'error', code: 'AUTH_ERROR', message: `authentication error (${error.status}): ${error.message}` };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { type: 'error', code: 'RATE_LIMIT', message: `rate limit (429): ${error.message}` };
  }
  if (error instanceof Anthropic.APIError && error.status) {
    return { type: 'error', code: 'SERVER_ERROR', message: `HTTP ${error.status}: ${error.message}` };
  }
  return exceptionEvent(error);
}

export async function* call(slot, systemPrompt, userPrompt, signal) {
  const { apiKey, baseUrl, selectedModel, maxTokens } = slot;
  const startTime = performance.now();

  try {
    // With no explicit key the SDK resolves ANTHROPIC_AUTH_TOKEN or ambient
    // SDK credentials by itself.
    const client = new Anthropic({
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseURL: baseUrl } : {})
    });
    const params = {
      model: selectedModel,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    };
    const stream = CURRENT_MODEL.test(selectedModel)
      ? client.beta.messages.stream({
          ...params,
          output_config: { effort: 'high' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default'
        }, { signal })
      : client.messages.stream(params, { signal });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'delta', text: event.delta.text };
      }
    }

    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category;
      yield { type: 'error', code: 'REFUSAL', message: `the model declined this brief${category ? ` (${category})` : ''}.` };
      return;
    }

    yield {
      type: 'done',
      text: message.content.filter(b => b.type === 'text').map(b => b.text).join(''),
      tokensIn: message.usage.input_tokens,
      tokensOut: message.usage.output_tokens,
      model: message.model,
      truncated: message.stop_reason === 'max_tokens',
      latencyMs: Math.round(performance.now() - startTime)
    };
  } catch (error) {
    yield errorEvent(error);
  }
}
