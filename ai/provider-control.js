export function estimateCostMicrousd(usage, prices) {
  if (!Number.isInteger(usage?.promptTokens) || !Number.isInteger(usage?.completionTokens)) return null;
  const input = usage.promptTokens * (prices?.inputMicrousdPerMillion || 0);
  const output = usage.completionTokens * (prices?.outputMicrousdPerMillion || 0);
  return Math.ceil((input + output) / 1_000_000);
}

export async function runProviderFallback(providers, invoke) {
  if (!providers.length) throw Object.assign(new Error('AI_NOT_CONFIGURED'), { status: 503 });
  let lastError = null;
  let attempts = 0;
  for (const provider of providers) {
    attempts += 1;
    try { return { ...await invoke(provider), provider: provider.name, model: provider.model, attempts }; }
    catch (error) { lastError = error; lastError.provider = provider.name; lastError.model = provider.model; }
  }
  throw Object.assign(new Error('AI_UNAVAILABLE'), { status: 502, cause: lastError, provider: lastError?.provider, model: lastError?.model });
}

export class TtlCache {
  constructor(ttlMs, maxEntries = 1000) { this.ttlMs = ttlMs; this.maxEntries = maxEntries; this.values = new Map(); }
  get(key, now = Date.now()) {
    const entry = this.values.get(key);
    if (!entry || entry.expiresAt <= now) { if (entry) this.values.delete(key); return null; }
    return structuredClone(entry.value);
  }
  set(key, value, now = Date.now()) {
    if (this.values.size >= this.maxEntries) this.values.delete(this.values.keys().next().value);
    this.values.set(key, { value: structuredClone(value), expiresAt: now + this.ttlMs });
  }
}
