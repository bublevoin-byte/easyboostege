import crypto from 'node:crypto';
import { validateTrustedRuleUrl } from './trusted-rule-fetch.js';

const CONTENT_TYPES = new Set(['text/html', 'text/plain']);

export class TrustedRuleDiscoveryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TrustedRuleDiscoveryError';
    this.code = code;
  }
}

function fail(code) { throw new TrustedRuleDiscoveryError(code); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function boundedText(value, maximum, code = 'TRUSTED_RULE_EVIDENCE_INVALID') {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (!text || text.length > maximum) fail(code);
  return text;
}

function normalizedSkill(value) {
  const id = boundedText(value?.id, 120, 'TRUSTED_RULE_REQUEST_INVALID').toLowerCase();
  const title = boundedText(value?.title, 160, 'TRUSTED_RULE_REQUEST_INVALID');
  if (!/^[a-z0-9][a-z0-9._-]{2,119}$/u.test(id) || /[<>]/u.test(title)) fail('TRUSTED_RULE_REQUEST_INVALID');
  return { id, title };
}

function normalizedEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('TRUSTED_RULE_EVIDENCE_INVALID');
  const keys = Object.keys(value);
  if (keys.some((key) => !['title', 'explanation', 'examples', 'claims'].includes(key))) fail('TRUSTED_RULE_EVIDENCE_INVALID');
  const title = boundedText(value.title, 160);
  const explanation = boundedText(value.explanation, 1_500);
  if (!Array.isArray(value.examples) || value.examples.length < 1 || value.examples.length > 4
    || !Array.isArray(value.claims) || value.claims.length < 1 || value.claims.length > 20) fail('TRUSTED_RULE_EVIDENCE_INVALID');
  const examples = value.examples.map((item) => boundedText(item, 300));
  const claims = [...new Set(value.claims.map((item) => boundedText(item, 200).toLowerCase()))].sort();
  if (claims.length !== value.claims.length) fail('TRUSTED_RULE_EVIDENCE_INVALID');
  return { rule: { title, explanation, examples }, claims };
}

function normalizedBody(document) {
  const type = String(document?.contentType || '').split(';')[0].trim().toLowerCase();
  const body = String(document?.body ?? '');
  if (!CONTENT_TYPES.has(type)) fail('TRUSTED_RULE_RESPONSE_BLOCKED');
  if (!body || Buffer.byteLength(body, 'utf8') > 256 * 1_024) fail('TRUSTED_RULE_RESPONSE_TOO_LARGE');
  const text = type === 'text/html'
    ? body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
      .replace(/<[^>]+>/gu, ' ')
    : body;
  const untrustedText = text.replace(/\s+/gu, ' ').trim().slice(0, 20_000);
  if (!untrustedText) fail('TRUSTED_RULE_EVIDENCE_INVALID');
  return { type, body, untrustedText };
}

function evidenceDiscrepancies(evidence) {
  const discrepancies = [];
  for (const field of ['title', 'explanation', 'examples']) {
    const values = evidence.map((item) => ({ url: item.source.url, value: item.rule[field] }));
    const distinct = new Set(values.map((item) => JSON.stringify(item.value)));
    if (distinct.size > 1) discrepancies.push({ field, values });
  }
  return discrepancies;
}

export function createTrustedRuleDiscovery({
  allowlist,
  searchProvider,
  fetchDocument,
  evidenceExtractor,
  createRuleCard,
  now = () => new Date(),
  newId = () => crypto.randomUUID(),
} = {}) {
  if (!searchProvider?.search || typeof fetchDocument !== 'function' || !evidenceExtractor?.extract || typeof createRuleCard !== 'function') {
    throw new Error('TRUSTED_RULE_DISCOVERY_CONFIG_INVALID');
  }
  return Object.freeze({
    async discover({ username, skill: inputSkill, examYear }) {
      const skill = normalizedSkill(inputSkill);
      if (!Number.isInteger(examYear) || examYear < 2020 || examYear > 2100) fail('TRUSTED_RULE_REQUEST_INVALID');
      const rawResults = await searchProvider.search({ skill: structuredClone(skill), examYear, allowlist: structuredClone(allowlist) });
      if (!Array.isArray(rawResults) || rawResults.length < 1 || rawResults.length > 12) fail('TRUSTED_RULE_INSUFFICIENT_SOURCES');
      let trusted;
      try {
        trusted = rawResults.map((result) => validateTrustedRuleUrl(typeof result === 'string' ? result : result?.url, allowlist));
      } catch {
        fail('TRUSTED_RULE_SOURCE_BLOCKED');
      }
      const deduplicated = [...new Map(trusted.map((source) => [source.url, source])).values()];
      if (deduplicated.length < 2 || new Set(deduplicated.map((source) => source.authority)).size < 2
        || new Set(deduplicated.map((source) => source.domain)).size < 2) {
        fail('TRUSTED_RULE_INSUFFICIENT_SOURCES');
      }
      const evidence = [];
      for (const source of deduplicated) {
        let document;
        try { document = await fetchDocument({ url: source.url }); } catch (error) {
          if (error?.code === 'TRUSTED_RULE_SOURCE_BLOCKED') fail(error.code);
          fail('TRUSTED_RULE_FETCH_FAILED');
        }
        let actualSource = source;
        if (document.finalUrl) {
          try { actualSource = validateTrustedRuleUrl(document.finalUrl, allowlist); } catch { fail('TRUSTED_RULE_SOURCE_BLOCKED'); }
        }
        const { type, body, untrustedText } = normalizedBody(document);
        const contentHash = hash(body);
        const extracted = normalizedEvidence(await evidenceExtractor.extract({
          username,
          skill: structuredClone(skill),
          examYear,
          source: { url: actualSource.url, authority: actualSource.authority, contentHash },
          document: { contentType: type, untrustedText, dataOnly: true },
        }));
        evidence.push({
          source: actualSource, contentHash,
          retrievedAt: new Date(document.retrievedAt || now()).toISOString(),
          rule: extracted.rule,
          claims: extracted.claims,
          agreementHash: hash(JSON.stringify(extracted.claims)),
        });
      }
      const agreementHashes = new Set(evidence.map((item) => item.agreementHash));
      if (agreementHashes.size !== 1) fail('TRUSTED_RULE_SOURCE_CONFLICT');
      if (new Set(evidence.map((item) => item.source.authority)).size < 2
        || new Set(evidence.map((item) => item.source.domain)).size < 2
        || new Set(evidence.map((item) => item.source.url)).size < 2) fail('TRUSTED_RULE_INSUFFICIENT_SOURCES');
      const first = evidence[0];
      const discrepancies = evidenceDiscrepancies(evidence);
      const card = await createRuleCard({
        id: newId(),
        createdForUsername: username || null,
        status: 'pending_review',
        skill,
        examYear,
        rule: first.rule,
        agreementHash: first.agreementHash,
        sources: evidence.map((item) => ({
          authority: item.source.authority,
          domain: item.source.domain,
          url: item.source.url,
          retrieved_at: item.retrievedAt,
          content_hash: item.contentHash,
        })),
        discrepancies,
        createdAt: now(),
      });
      return {
        card_id: card.id,
        status: card.status,
        provisional: true,
        notice: 'Предварительное объяснение из согласующихся доверенных источников; карточка ожидает проверки преподавателем.',
        rule: structuredClone(first.rule),
        sources: evidence.map((item) => item.source.url),
      };
    },
  });
}
