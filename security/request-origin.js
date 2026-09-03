const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : '';
  } catch {
    return '';
  }
}

export function hasCookie(request, name) {
  const cookie = String(request.headers.cookie || '');
  return cookie.split(';').some((part) => part.trim().startsWith(`${name}=`));
}

export function isTrustedCookieRequest(request, allowedOrigin) {
  if (!UNSAFE_METHODS.has(request.method)) return true;
  if (!hasCookie(request, 'eb_token')) return true;
  const fetchSite = String(request.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') return false;
  return normalizeOrigin(request.headers.origin) === allowedOrigin;
}

export function protectCookieRequests(allowedAppUrl) {
  const allowedOrigin = normalizeOrigin(allowedAppUrl);
  if (!allowedOrigin) throw new Error('APP_URL must be an absolute HTTP(S) URL');
  return (request, response, next) => {
    if (isTrustedCookieRequest(request, allowedOrigin)) return next();
    return response.status(403).json({
      error: { code: 'CROSS_SITE_REQUEST_REJECTED', message: 'Межсайтовый запрос отклонён.' },
    });
  };
}
