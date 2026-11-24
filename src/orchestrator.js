import { call as callOpenAI } from './adapters/openai-compat.js';
import { call as callGemini } from './adapters/gemini.js';
import { call as callAnthropic } from './adapters/anthropic.js';

const ADAPTERS = {
  'openai-compat': callOpenAI,
  gemini: callGemini,
  anthropic: callAnthropic
};

const MAX_ERROR_CHARS = 500;
const singleLine = s => String(s).replace(/[\r\n]+/g, ' ').trim();

function systemPromptFor(role) {
  return `You are the ${role.title}. ${role.focus}\nAnswer clearly and structure your output in Markdown. Do not write a preamble, just the output.`;
}

function sanitizeError(raw, secrets) {
  let msg = typeof raw === 'string' && raw.trim() ? singleLine(raw) : 'the model API returned an error.';
  for (const secret of secrets || []) msg = msg.replaceAll(secret, '***');
  return msg.length > MAX_ERROR_CHARS ? `${msg.slice(0, MAX_ERROR_CHARS)}...` : msg;
}

async function runLane(slot, role, brief, { signal, timeoutMs }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const laneSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const base = { role: singleLine(role.title), model: singleLine(slot.selectedModel) };
  let error = 'the model API returned no result.';

  try {
    for await (const event of ADAPTERS[slot.adapter](slot, systemPromptFor(role), brief, laneSignal)) {
      if (event.type === 'error') {
        error = event.message;
      } else if (event.type === 'done') {
        if (event.text.trim()) {
          return { ...base, ...event, model: singleLine(event.model || slot.selectedModel) };
        }
        error = 'the model API returned no text.';
      }
    }
  } catch (e) {
    error = e?.message;
  }

  if (timeout.aborted) error = `timed out after ${Math.round(timeoutMs / 1000)} seconds.`;
  // Some providers echo part of the key back in their error text.
  return { ...base, error: sanitizeError(error, slot.secrets) };
}

function laneFooter(lane) {
  const notes = [];
  if (lane.truncated) notes.push('WARNING: answer cut off at the output limit');
  if (lane.tokensIn || lane.tokensOut) notes.push(`tokens: ${lane.tokensIn} in, ${lane.tokensOut} out`);
  notes.push(`${(lane.latencyMs / 1000).toFixed(1)}s`);
  return `*${notes.join(' | ')}*`;
}

// Folds the lane results into one Markdown document, as the web app does.
function compose(board, lanes) {
  const sections = lanes.map((lane, i) => {
    const heading = `## Lane ${i + 1}: ${lane.role} (Model: ${lane.model})`;
    const body = lane.error ? `*[FAILED: ${lane.error}]*` : `${lane.text}\n\n${laneFooter(lane)}`;
    return `${heading}\n\n${body}\n\n---\n`;
  });
  return `# beitdin result\n\n**Board:** ${singleLine(board.name)}\n\n---\n\n${sections.join('\n')}`;
}

// Runs the three roles at once and waits for all of them, so one failing lane
// never costs the answers from the other two.
export async function runBoard(board, brief, slots, { signal, timeoutMs, onLaneDone }) {
  let done = 0;
  const lanes = await Promise.all(board.roles.map(async (role, i) => {
    const lane = await runLane(slots[i], role, brief, { signal, timeoutMs });
    onLaneDone?.(++done, role.title);
    return lane;
  }));
  return { markdown: compose(board, lanes), allFailed: lanes.every(l => l.error) };
}
