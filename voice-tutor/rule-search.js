import crypto from 'node:crypto';
import { operationLimits } from '../ai/operations.js';

const OPERATION = 'voice_tutor_rule_search';
const PROMPT_VERSION = 'voice-tutor-rule-search-v1';
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CITATION_URLS = 5;

export function canUseXaiRuleSearch({ enabled, xaiEnabled, apiKey } = {}) {
  return Boolean(enabled && xaiEnabled && String(apiKey || '').trim());
}

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function allowedDomains(allowlist) {
  const domains = [...new Set((Array.isArray(allowlist) ? allowlist : [])
    .map((entry) => String(entry?.domain || '').trim().toLowerCase())
    .filter((domain) => /^[a-z0-9.-]+$/u.test(domain) && !domain.startsWith('.') && !domain.endsWith('.')))];
  if (domains.length < 2 || domains.length > 5) throw new Error('VOICE_TUTOR_RULE_SEARCH_CONFIG_INVALID');
  return domains;
}

function citationPolicies(allowlist, domains) {
  return domains.map((domain) => {
    const configured = allowlist.find((entry) => String(entry?.domain || '').trim().toLowerCase() === domain);
    return { domain, authority: String(configured?.authority || domain).trim().toLowerCase() || domain };
  });
}

function structuredCitationUrls(payload, policies) {
  const urls = [];
  for (const output of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(output?.content) ? output.content : []) {
      for (const annotation of Array.isArray(content?.annotations) ? content.annotations : []) {
        if (annotation?.type === 'url_citation' && typeof annotation.url === 'string') urls.push(annotation.url);
      }
    }
  }
  const candidates = [...new Set(urls)].flatMap((url) => {
    try {
      const parsed = new URL(url);
      const policy = parsed.protocol === 'https:'
        ? policies.find((entry) => parsed.hostname.toLowerCase() === entry.domain)
        : null;
      return policy ? [{ url, authority: policy.authority }] : [];
    } catch { return []; }
  });
  const selected = [];
  const selectedUrls = new Set();
  const selectedAuthorities = new Set();
  for (const candidate of candidates) {
    if (selectedAuthorities.has(candidate.authority)) continue;
    selected.push(candidate.url);
    selectedUrls.add(candidate.url);
    selectedAuthorities.add(candidate.authority);
    if (selected.length === MAX_CITATION_URLS) return selected;
  }
  for (const candidate of candidates) {
    if (selectedUrls.has(candidate.url)) continue;
    selected.push(candidate.url);
    if (selected.length === MAX_CITATION_URLS) break;
  }
  return selected;
}

async function readBoundedResponse(response, controller) {
  const reader = response.body?.getReader?.();
  if (!reader) throw failure('TRUSTED_RULE_RESPONSE_BLOCKED');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw failure('TRUSTED_RULE_RESPONSE_BLOCKED');
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        controller.abort();
        await reader.cancel().catch(() => {});
        throw failure('TRUSTED_RULE_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    reader.releaseLock?.();
  }
}

export function createXaiRuleSearchProvider({
  apiKey,
  endpoint = 'https://api.x.ai/v1/responses',
  model,
  allowlist,
  timeoutMs = 15_000,
  transport = globalThis.fetch,
  claimAiOperation,
  settleAiOperation,
  newId = () => crypto.randomUUID(),
  now = () => new Date(),
} = {}) {
  const domains = allowedDomains(allowlist);
  const policies = citationPolicies(allowlist, domains);
  if (!apiKey || !model || typeof transport !== 'function' || typeof claimAiOperation !== 'function'
    || typeof settleAiOperation !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error('VOICE_TUTOR_RULE_SEARCH_CONFIG_INVALID');
  }
  const limits = operationLimits(OPERATION);
  return Object.freeze({
    async search({ username, skill, examYear }) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let claim = null;
      let settled = false;
      try {
        const skillId = String(skill?.id || '');
        const skillTitle = String(skill?.title || '');
        if (!/^[a-z0-9][a-z0-9._-]{2,119}$/u.test(skillId) || !skillTitle || skillTitle.length > 160
          || !Number.isInteger(examYear) || examYear < 2020 || examYear > 2100) throw failure('TRUSTED_RULE_REQUEST_INVALID');
        claim = await claimAiOperation({
          claimId: newId(), username, operation: OPERATION, promptVersion: PROMPT_VERSION,
          requestsPerHour: limits.requestsPerHour, now: now(),
        });
        const response = await transport(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            store: false,
            input: `Find authoritative English EGE ${examYear} teaching pages for server skill ${skillId} (${skillTitle}). Return citations only.`,
            tools: [{ type: 'web_search', filters: { allowed_domains: domains } }],
          }),
          signal: controller.signal,
        });
        if (!response?.ok) throw failure('TRUSTED_RULE_SEARCH_FAILED');
        const type = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
        const declared = Number(response.headers?.get?.('content-length') || 0);
        if (type !== 'application/json' || (declared && declared > MAX_RESPONSE_BYTES)) throw failure('TRUSTED_RULE_RESPONSE_BLOCKED');
        const raw = await readBoundedResponse(response, controller);
        if (!raw) throw failure('TRUSTED_RULE_RESPONSE_BLOCKED');
        let payload;
        try { payload = JSON.parse(raw); } catch { throw failure('TRUSTED_RULE_RESPONSE_BLOCKED'); }
        const urls = structuredCitationUrls(payload, policies);
        if (urls.length < 2) throw failure('TRUSTED_RULE_INSUFFICIENT_SOURCES');
        await settleAiOperation(username, claim.claim_id, {
          status: 'completed', provider: 'xai', model, durationMs: Date.now() - startedAt,
          promptTokens: payload?.usage?.input_tokens, completionTokens: payload?.usage?.output_tokens,
        });
        settled = true;
        return urls;
      } catch (error) {
        const normalized = error?.name === 'AbortError' ? failure('TRUSTED_RULE_SEARCH_TIMEOUT') : error;
        if (claim && !settled) await settleAiOperation(username, claim.claim_id, {
          status: 'failed', provider: 'xai', model, durationMs: Date.now() - startedAt,
          errorCode: normalized?.code || 'TRUSTED_RULE_SEARCH_FAILED',
        }).catch(() => {});
        throw normalized;
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

export { PROMPT_VERSION as VOICE_TUTOR_RULE_SEARCH_PROMPT_VERSION };
