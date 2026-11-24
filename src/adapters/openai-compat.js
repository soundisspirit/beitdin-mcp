/**
 * OpenAI-compatible adapter
 * Covers: OpenAI, Mistral, Groq, Together, OpenRouter, and local servers (Ollama, LM Studio)
 */
import { exceptionEvent, httpErrorEvent, MAX_STREAM_TEXT_CHARS, parseJson, sseData } from './http.js';

export async function* call(slot, systemPrompt, userPrompt, signal) {
  const { baseUrl, apiKey, selectedModel, provider } = slot;
  const startTime = performance.now();

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        stream: true,
        // Some compatible servers reject this option, and they tend to send
        // usage in the last chunk anyway.
        ...(provider === 'openai' ? { stream_options: { include_usage: true } } : {})
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
    let finished = false;
    let tokensIn = 0;
    let tokensOut = 0;

    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') {
        finished = true;
        break;
      }
      const parsed = parseJson(data);
      if (!parsed) continue;
      if (parsed.error) {
        const message = typeof parsed.error?.message === 'string' && parsed.error.message.trim()
          ? parsed.error.message
          : 'the provider reported an error mid-stream.';
        yield { type: 'error', code: 'SERVER_ERROR', message };
        return;
      }
      const choice = parsed.choices?.[0];
      if (typeof choice?.delta?.content === 'string' && choice.delta.content) {
        fullText += choice.delta.content;
        if (fullText.length > MAX_STREAM_TEXT_CHARS) {
          yield { type: 'error', code: 'SERVER_ERROR', message: 'response exceeded 2 MB output limit.' };
          return;
        }
        yield { type: 'delta', text: choice.delta.content };
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (parsed.usage) {
        tokensIn = parsed.usage.prompt_tokens || 0;
        tokensOut = parsed.usage.completion_tokens || 0;
      }
    }

    // A dropped connection must not pass off a partial answer as a whole one.
    if (!finished && !finishReason) {
      yield { type: 'error', code: 'STREAM_ERROR', message: 'stream ended before the model finished.' };
      return;
    }

    yield {
      type: 'done',
      text: fullText,
      tokensIn,
      tokensOut,
      model: selectedModel,
      truncated: finishReason === 'length',
      latencyMs: Math.round(performance.now() - startTime)
    };
  } catch (error) {
    yield exceptionEvent(error);
  }
}
