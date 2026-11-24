// Providers the server can call. Base URLs and keys come only from this table
// and the server's environment. A caller picks a provider by name and can never
// supply a URL, so an MCP client cannot redirect an API key somewhere else.
const PROVIDERS = {
  anthropic: { adapter: 'anthropic', keyEnv: ['ANTHROPIC_API_KEY'], keyOptional: true },
  openai: { adapter: 'openai-compat', baseUrl: 'https://api.openai.com/v1', keyEnv: ['OPENAI_API_KEY'] },
  gemini: { adapter: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  mistral: { adapter: 'openai-compat', baseUrl: 'https://api.mistral.ai/v1', keyEnv: ['MISTRAL_API_KEY'] },
  groq: { adapter: 'openai-compat', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: ['GROQ_API_KEY'] },
  together: { adapter: 'openai-compat', baseUrl: 'https://api.together.xyz/v1', keyEnv: ['TOGETHER_API_KEY'] },
  openrouter: { adapter: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: ['OPENROUTER_API_KEY'] },
  local: { adapter: 'openai-compat', baseUrl: 'http://localhost:11434/v1', keyEnv: ['LOCAL_API_KEY'], keyOptional: true }
};

const MODEL_ID = /^[a-zA-Z0-9._:/@-]{1,200}$/;

const positiveInt = (raw, fallback) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const splitList = raw => (raw || '').split(',').map(s => s.trim()).filter(Boolean);

function collectSecrets(providers, env) {
  const candidates = [
    ...Object.values(providers).map(p => p.apiKey),
    env.ANTHROPIC_AUTH_TOKEN || ''
  ];
  for (const p of Object.values(providers)) {
    if (!p.baseUrl) continue;
    try {
      const u = new URL(p.baseUrl);
      if (u.password) candidates.push(decodeURIComponent(u.password));
    } catch {
      // Malformed base URLs fail cleanly at request time.
    }
  }
  return [...new Set(candidates.filter(s => s.length >= 4))];
}

export function loadConfig(env = process.env) {
  const providers = {};
  for (const [name, def] of Object.entries(PROVIDERS)) {
    const keyVar = def.keyEnv.find(v => env[v]);
    providers[name] = {
      name,
      adapter: def.adapter,
      baseUrl: env[`BEITDIN_${name.toUpperCase()}_BASE_URL`] || def.baseUrl,
      apiKey: keyVar ? env[keyVar] : '',
      keyEnv: def.keyEnv,
      keyOptional: !!def.keyOptional
    };
  }
  return {
    providers,
    secrets: collectSecrets(providers, env),
    defaultModels: splitList(env.BEITDIN_MODELS),
    maxTokens: positiveInt(env.BEITDIN_MAX_TOKENS, 64000),
    timeoutMs: positiveInt(env.BEITDIN_TIMEOUT_MS, 600000),
    maxConcurrentRuns: positiveInt(env.BEITDIN_MAX_CONCURRENT_RUNS, 4),
    boardsDir: env.BEITDIN_BOARDS_DIR || '',
    runsDir: env.BEITDIN_RUNS_DIR || ''
  };
}

// Model ids can contain colons (llama3:8b), so only the first colon separates
// the provider from the model.
function resolveSpec(spec, config) {
  const colon = spec.indexOf(':');
  const providerName = colon === -1 ? '' : spec.slice(0, colon);
  const selectedModel = colon === -1 ? '' : spec.slice(colon + 1);
  if (
    !selectedModel
    || !MODEL_ID.test(selectedModel)
    || selectedModel.includes('..')
    || !Object.hasOwn(config.providers, providerName)
  ) {
    throw new Error(`invalid model "${spec}". Use provider:model, where provider is one of: ${Object.keys(config.providers).join(', ')}.`);
  }
  const provider = config.providers[providerName];
  if (!provider.apiKey && !provider.keyOptional) {
    throw new Error(`provider "${providerName}" has no API key. Set ${provider.keyEnv.join(' or ')} in the server environment.`);
  }
  return {
    provider: provider.name,
    adapter: provider.adapter,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    secrets: config.secrets,
    selectedModel,
    maxTokens: config.maxTokens
  };
}

// Turns one or three provider:model specs into the three lanes of a run. One
// spec means all three roles use that model.
export function resolveLanes(requested, config) {
  const specs = requested?.length ? requested : config.defaultModels;
  if (specs.length === 0) {
    throw new Error('no model selected. Pass models, or set BEITDIN_MODELS in the server environment.');
  }
  if (specs.length !== 1 && specs.length !== 3) {
    throw new Error(`expected 1 or 3 models, got ${specs.length}.`);
  }
  const slots = specs.map(spec => resolveSpec(spec, config));
  return slots.length === 1 ? [slots[0], slots[0], slots[0]] : slots;
}
