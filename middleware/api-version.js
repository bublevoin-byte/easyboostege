/*
 * Section 13.1: the API is versioned, and /api/v1 is the only supported contract.
 *
 * Versioning after the fact breaks every client that is already deployed. The one
 * client that matters here is the PWA itself: a device can hold a cached service
 * worker shell with the previous app.js and keep calling the unversioned paths
 * until it manages to fetch a new build. This middleware rewrites those calls to
 * the versioned route and records that it had to, so the legacy surface can be
 * switched off deliberately rather than hopefully.
 */

export const API_PREFIX = '/api';
export const API_VERSION = 'v1';
export const VERSIONED_API_PREFIX = `${API_PREFIX}/${API_VERSION}`;

function splitUrl(url) {
  const queryStart = url.indexOf('?');
  return queryStart === -1
    ? { pathname: url, search: '' }
    : { pathname: url.slice(0, queryStart), search: url.slice(queryStart) };
}

export function isVersionedApiPath(pathname) {
  return pathname === VERSIONED_API_PREFIX || pathname.startsWith(`${VERSIONED_API_PREFIX}/`);
}

export function isApiPath(pathname) {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

export function createApiVersionRewrite({ enabled = true, log = console.log } = {}) {
  /* One report per method and path keeps a stuck client from flooding the log;
     the http_request records carry the volume. */
  const reported = new Set();

  return function rewriteLegacyApiPath(req, res, next) {
    const { pathname, search } = splitUrl(req.url || '');
    if (!isApiPath(pathname) || isVersionedApiPath(pathname)) return next();

    /* With the legacy surface disabled the request falls through to the 404
       handler, which is the honest answer for a path that no longer exists. */
    if (!enabled) return next();

    const rewritten = `${VERSIONED_API_PREFIX}${pathname.slice(API_PREFIX.length)}`;
    const marker = `${req.method} ${pathname}`;
    if (!reported.has(marker)) {
      reported.add(marker);
      log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        type: 'api_legacy_path',
        requestId: req.requestId || '',
        method: req.method,
        from: pathname,
        to: rewritten,
        note: 'Unversioned API path served through the compatibility rewrite (section 13.1).',
      }));
    }

    req.url = rewritten + search;
    next();
  };
}
