import crypto from 'node:crypto';

export function inlineScriptHashes(html) {
  const scripts = [...String(html).matchAll(/<script(?![^>]*\bsrc\s*=)(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)];
  return scripts.map((match) => {
    const normalized = match[1].replace(/\r\n?/gu, '\n');
    const digest = crypto.createHash('sha256').update(normalized, 'utf8').digest('base64');
    return `'sha256-${digest}'`;
  });
}

function realtimeWebSocketOrigin(realtimeUrl) {
  if (!realtimeUrl) return null;
  let url;
  try {
    url = new URL(realtimeUrl);
  } catch {
    throw new Error('realtime WebSocket URL must use WSS');
  }
  if (url.protocol !== 'wss:' || url.username || url.password) {
    throw new Error('realtime WebSocket URL must use WSS');
  }
  return url.origin;
}

export function contentSecurityPolicy(html, isProduction, realtimeUrl = '') {
  const scriptHashes = inlineScriptHashes(html);
  const realtimeOrigin = realtimeWebSocketOrigin(realtimeUrl);
  return {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'", ...(realtimeOrigin ? [realtimeOrigin] : [])],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", ...scriptHashes],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      upgradeInsecureRequests: isProduction ? [] : null,
    },
  };
}
