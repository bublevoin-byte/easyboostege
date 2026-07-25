import crypto from 'crypto';
import jwt from 'jsonwebtoken';

// Session handling lives here so routes never touch the JWT or the cookie directly.
export function createAuthentication({ secret, sessionDays, monitoringToken, createSession, getUser, isSessionActive }) {
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
    return (req.headers['x-forwarded-proto'] || req.protocol) === 'https' ? '; Secure' : '';
  }

  function setAuthCookie(req, res, token) {
    res.setHeader('Set-Cookie', 'eb_token=' + encodeURIComponent(token)
      + '; Path=/; Max-Age=' + (sessionDays * 86400) + '; HttpOnly; SameSite=Lax' + cookieSuffix(req));
  }

  function clearAuthCookie(req, res) {
    res.setHeader('Set-Cookie', 'eb_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' + cookieSuffix(req));
  }

  async function auth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = (header.startsWith('Bearer ') ? header.slice(7) : '') || readCookie(req, 'eb_token');
    try {
      const claims = jwt.verify(token, secret);
      const username = claims.u;
      const user = await getUser(username);
      if (!user) return res.status(401).json({ error: 'Требуется вход' });
      if (claims.sid && !await isSessionActive(claims.sid, username)) {
        return res.status(401).json({ error: { code: 'SESSION_REVOKED', message: 'Сессия завершена. Войдите снова.' } });
      }
      req.user = username;
      req.role = user.role || 'student';
      req.sessionId = claims.sid || null;
      req.authToken = token;
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

  return { issueToken, readCookie, setAuthCookie, clearAuthCookie, auth, requireRole, monitoringAuth };
}
