import crypto from 'crypto';
import jwt from 'jsonwebtoken';

// Session handling lives here so routes never touch the JWT or the cookie directly.
export function createAuthentication({
  secret, sessionDays, monitoringToken, createSession, getUser, isSessionActive, secureCookies = false,
}) {
  async function issueToken(username) {
    const sid = crypto.randomUUID();
    const expiresAt = Date.now() + sessionDays * 86_400_000;
    await createSession(sid, username, expiresAt);
    return jwt.sign({ u: username, sid }, secret, { expiresIn: sessionDays + 'd' });
  }

  function readCookie(req, name) {
    const header = req.headers.cookie || '';
    const match = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[1]) : '';
  }

  function cookieSuffix(req) {
    return secureCookies || req.secure === true || req.protocol === 'https' ? '; Secure' : '';
  }

  function appendCookie(res, cookie) {
    const existing = res.getHeader('Set-Cookie');
    if (!existing) res.setHeader('Set-Cookie', cookie);
    else if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing, cookie]);
    else res.setHeader('Set-Cookie', [String(existing), cookie]);
  }

  function setAuthCookie(req, res, token) {
    appendCookie(res, 'eb_token=' + encodeURIComponent(token)
      + '; Path=/; Max-Age=' + (sessionDays * 86400) + '; HttpOnly; SameSite=Lax' + cookieSuffix(req));
  }

  function clearAuthCookie(req, res) {
    appendCookie(res, 'eb_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' + cookieSuffix(req));
  }

  async function authenticateRequest(req) {
    const header = req.headers.authorization || '';
    const token = (header.startsWith('Bearer ') ? header.slice(7) : '') || readCookie(req, 'eb_token');
    const claims = jwt.verify(token, secret);
    const username = claims.u;
    const user = await getUser(username);
    if (!user) return null;
    if (claims.sid && !await isSessionActive(claims.sid, username)) return null;
    return {
      username,
      role: user.role || 'student',
      sessionId: claims.sid || null,
      token,
    };
  }

  async function auth(req, res, next) {
    try {
      const authenticated = await authenticateRequest(req);
      if (!authenticated) {
        return res.status(401).json({ error: { code: 'SESSION_REVOKED', message: 'Сессия завершена. Войдите снова.' } });
      }
      req.user = authenticated.username;
      req.role = authenticated.role;
      req.sessionId = authenticated.sessionId;
      req.authToken = authenticated.token;
      next();
    } catch (error) {
      res.status(401).json({ error: 'Требуется вход' });
    }
  }

  function requireRole(...roles) {
    return (req, res, next) => (roles.includes(req.role)
      ? next()
      : res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Недостаточно прав.' } }));
  }

  // Compared in constant time: the monitoring token is a shared secret, not a session.
  function monitoringAuth(req, res, next) {
    const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/u, '');
    if (!monitoringToken) return res.status(404).end();
    const expectedBuffer = Buffer.from(monitoringToken);
    const providedBuffer = Buffer.from(provided);
    if (expectedBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Monitoring token required.' } });
    }
    next();
  }

  return { issueToken, readCookie, appendCookie, setAuthCookie, clearAuthCookie, authenticateRequest, auth, requireRole, monitoringAuth };
}
