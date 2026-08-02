import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

const MAX_URL_LENGTH = 2_048;
const ALLOWED_CONTENT_TYPES = new Set(['text/html', 'text/plain']);

function blocked() {
  return Object.assign(new Error('TRUSTED_RULE_SOURCE_BLOCKED'), { code: 'TRUSTED_RULE_SOURCE_BLOCKED' });
}

function normalizedAllowlist(allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length < 2 || allowlist.length > 30) throw blocked();
  const normalized = allowlist.map((entry) => {
    const authority = String(entry?.authority || '').trim();
    const domain = String(entry?.domain || '').trim().toLowerCase().replace(/\.$/u, '');
    const prefixes = Array.isArray(entry?.pathPrefixes) ? entry.pathPrefixes : [];
    if (!/^[a-z0-9][a-z0-9.-]{2,252}$/u.test(domain) || net.isIP(domain)
      || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(authority)
      || prefixes.length < 1 || prefixes.length > 20
      || prefixes.some((prefix) => typeof prefix !== 'string' || !prefix.startsWith('/') || prefix.length > 300)) throw blocked();
    return { authority, domain, pathPrefixes: prefixes };
  });
  if (new Set(normalized.map((entry) => entry.authority)).size !== normalized.length
    || new Set(normalized.map((entry) => entry.domain)).size !== normalized.length) throw blocked();
  return normalized;
}

export function validateTrustedRuleUrl(value, allowlist) {
  const raw = String(value || '');
  if (!raw || raw.length > MAX_URL_LENGTH) throw blocked();
  let url;
  try { url = new URL(raw); } catch { throw blocked(); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || url.hash || net.isIP(hostname) || url.search.length > 512) throw blocked();
  const source = normalizedAllowlist(allowlist).find((entry) => entry.domain === hostname
    && entry.pathPrefixes.some((prefix) => prefix.endsWith('/')
      ? url.pathname.startsWith(prefix)
      : url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)));
  if (!source) throw blocked();
  url.hostname = hostname;
  url.port = '';
  return { url: url.toString(), authority: source.authority, domain: source.domain };
}

function privateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

export function isPublicAddress(address) {
  const value = String(address || '').toLowerCase().split('%')[0];
  const family = net.isIP(value);
  if (family === 4) return !privateIpv4(value);
  if (family !== 6) return false;
  if (value.startsWith('::ffff:')) return isPublicAddress(value.slice(7));
  return value !== '::' && value !== '::1' && !value.startsWith('fc') && !value.startsWith('fd')
    && !/^fe[89ab]/u.test(value) && !value.startsWith('ff') && !value.startsWith('2001:db8');
}

function timeoutError() {
  return Object.assign(new Error('TRUSTED_RULE_FETCH_TIMEOUT'), { code: 'TRUSTED_RULE_FETCH_TIMEOUT' });
}

function withinDeadline(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(timeoutError());
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(timeoutError()), remaining); }),
  ]).finally(() => clearTimeout(timer));
}

function requestOnce(request, url, address, family, { deadline, maxBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let hardTimer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      callback(value);
    };
    const succeed = (value) => finish(resolve, value);
    const fail = (error) => finish(reject, error);
    const request_ = request({
      protocol: 'https:', hostname: url.hostname, port: 443, path: `${url.pathname}${url.search}`,
      method: 'GET', servername: url.hostname,
      headers: { Accept: 'text/html, text/plain;q=0.9', 'Accept-Encoding': 'identity', 'User-Agent': 'EasyBoost-TrustedRule/1.0' },
      lookup(hostname, options, callback) { callback(null, address, family); },
    }, (response) => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400) {
        response.resume();
        return succeed({ redirect: response.headers.location || '' });
      }
      if (status < 200 || status >= 300) {
        response.resume();
        return fail(Object.assign(new Error('TRUSTED_RULE_FETCH_FAILED'), { code: 'TRUSTED_RULE_FETCH_FAILED' }));
      }
      const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const contentLength = Number(response.headers['content-length'] || 0);
      const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.has(contentType) || (contentLength && contentLength > maxBytes) || encoding !== 'identity') {
        response.destroy();
        return fail(Object.assign(new Error('TRUSTED_RULE_RESPONSE_BLOCKED'), { code: 'TRUSTED_RULE_RESPONSE_BLOCKED' }));
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          response.destroy(Object.assign(new Error('TRUSTED_RULE_RESPONSE_TOO_LARGE'), { code: 'TRUSTED_RULE_RESPONSE_TOO_LARGE' }));
        } else chunks.push(chunk);
      });
      response.on('end', () => succeed({ contentType, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', fail);
    });
    request_.on('error', fail);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return request_.destroy(timeoutError());
    hardTimer = setTimeout(() => request_.destroy(timeoutError()), remaining);
    request_.setTimeout(remaining, () => request_.destroy(timeoutError()));
    request_.end();
  });
}

export function createTrustedRuleFetcher({
  allowlist,
  lookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
  request = https.request,
  timeoutMs = 5_000,
  maxBytes = 256 * 1_024,
  maxRedirects = 1,
  now = () => new Date(),
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 15_000
    || !Number.isInteger(maxBytes) || maxBytes < 1_024 || maxBytes > 1_048_576
    || !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 2) throw new Error('TRUSTED_RULE_FETCH_CONFIG_INVALID');
  return async function fetchDocument({ url: input }) {
    const deadline = Date.now() + timeoutMs;
    let trusted = validateTrustedRuleUrl(input, allowlist);
    const visited = new Set();
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      if (visited.has(trusted.url)) throw blocked();
      visited.add(trusted.url);
      const url = new URL(trusted.url);
      const addresses = await withinDeadline(Promise.resolve().then(() => lookup(url.hostname)), deadline);
      if (!Array.isArray(addresses) || !addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) throw blocked();
      const pinned = addresses[0];
      const response = await requestOnce(request, url, pinned.address, pinned.family, { deadline, maxBytes });
      if (!response.redirect) return {
        ...response,
        finalUrl: trusted.url,
        authority: trusted.authority,
        domain: trusted.domain,
        retrievedAt: now(),
      };
      if (redirectCount === maxRedirects) throw blocked();
      trusted = validateTrustedRuleUrl(new URL(response.redirect, url).toString(), allowlist);
    }
    throw blocked();
  };
}
