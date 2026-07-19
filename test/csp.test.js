import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { contentSecurityPolicy, inlineScriptHashes } from '../security/csp.js';

const frontendPath = new URL('../public/index.html', import.meta.url);

test('CSP hashes every inline script and blocks arbitrary script elements', async () => {
  const frontend = await fs.readFile(frontendPath, 'utf8');
  const scripts = [...frontend.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)];
  const hashes = inlineScriptHashes(frontend);
  assert.equal(hashes.length, scripts.length);
  assert.ok(hashes.every((hash) => /^'sha256-[A-Za-z0-9+/]+={0,2}'$/u.test(hash)));
  const policy = contentSecurityPolicy(frontend, true);
  assert.deepEqual(policy.directives.scriptSrc, ["'self'", ...hashes]);
  assert.equal(policy.directives.scriptSrc.includes("'unsafe-inline'"), false);
  assert.deepEqual(policy.directives.connectSrc, ["'self'"]);
  assert.deepEqual(policy.directives.frameAncestors, ["'none'"]);
});

test('development CSP does not force HTTP requests to HTTPS', () => {
  const policy = contentSecurityPolicy('<script>console.log("ok")</script>', false);
  assert.equal(policy.directives.upgradeInsecureRequests, null);
});
