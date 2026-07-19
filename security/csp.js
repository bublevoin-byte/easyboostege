import crypto from 'node:crypto';

export function inlineScriptHashes(html) {
  const scripts = [...String(html).matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)];
  return scripts.map((match) => {
    const normalized = match[1].replace(/\r\n?/gu, '\n');
    const digest = crypto.createHash('sha256').update(normalized, 'utf8').digest('base64');
    return `'sha256-${digest}'`;
  });
}

export function contentSecurityPolicy(html, isProduction) {
  const scriptHashes = inlineScriptHashes(html);
  if (!scriptHashes.length) throw new Error('Frontend must contain at least one script for CSP hashing');
  return {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
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
