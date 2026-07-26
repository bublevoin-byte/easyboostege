export function estimateCostMicrousd(usage, prices) {
  if (!Number.isInteger(usage?.promptTokens) || !Number.isInteger(usage?.completionTokens)) return null;
  const input = usage.promptTokens * (prices?.inputMicrousdPerMillion || 0);
  const output = usage.completionTokens * (prices?.outputMicrousdPerMillion || 0);
  return Math.ceil((input + output) / 1_000_000);
}

// Section 10.7: when a provider is abandoned the log has to say which one and why, otherwise an
// operator sees only that a call eventually succeeded and never learns the primary is broken.
function describeSkipped(skipped) {
  return skipped.length ? skipped.map(({ name, reason }) => `${name}: ${reason}`).join('; ') : null;
}

export async function runProviderFallback(providers, invoke) {
  if (!providers.length) throw Object.assign(new Error('AI_NOT_CONFIGURED'), { status: 503 });
  let lastError = null;
  let attempts = 0;
  const skipped = [];
  for (const provider of providers) {
    attempts += 1;
    try {
      return {
        ...await invoke(provider),
        provider: provider.name,
        model: provider.model,
        attempts,
        fallbackReason: describeSkipped(skipped),
      };
    } catch (error) {
      lastError = error;
      lastError.provider = provider.name;
      lastError.model = provider.model;
      skipped.push({ name: provider.name, reason: String(error?.message || 'unknown').slice(0, 120) });
    }
  }
  throw Object.assign(new Error('AI_UNAVAILABLE'), {
    status: 502,
    cause: lastError,
    provider: lastError?.provider,
    model: lastError?.model,
    fallbackReason: describeSkipped(skipped),
  });
}

// Section 10.8: a burst of students must not open a burst of provider connections. Calls above the
// limit wait in order instead of being rejected, and a caller that waits too long gives up so the
// HTTP request cannot hang forever.
export function createConcurrencyGate(limit, maxWaitMs = 20_000) {
  const waiting = [];
  let active = 0;

  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  async function acquire() {
    if (active < limit) { active += 1; return; }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiting.indexOf(admit);
        if (index !== -1) waiting.splice(index, 1);
        reject(Object.assign(new Error('AI_QUEUE_TIMEOUT'), { code: 'AI_QUEUE_TIMEOUT', status: 503 }));
      }, maxWaitMs);
      function admit() { clearTimeout(timer); active += 1; resolve(); }
      waiting.push(admit);
    });
  }

  return {
    async run(task) {
      await acquire();
      try { return await task(); }
      finally { release(); }
    },
    stats() { return { active, waiting: waiting.length, limit }; },
  };
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
