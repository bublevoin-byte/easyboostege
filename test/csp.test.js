import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { contentSecurityPolicy, inlineScriptHashes } from '../security/csp.js';

const frontendPath = new URL('../public/index.html', import.meta.url);

test('CSP allows self-hosted scripts and blocks arbitrary inline script elements', async () => {
  const frontend = await fs.readFile(frontendPath, 'utf8');
  const scripts = [...frontend.matchAll(/<script(?![^>]*\bsrc\s*=)(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)];
  const hashes = inlineScriptHashes(frontend);
  assert.equal(scripts.length, 0);
  assert.equal(hashes.length, scripts.length);
  const policy = contentSecurityPolicy(frontend, true);
  assert.deepEqual(policy.directives.scriptSrc, ["'self'"]);
  assert.equal(policy.directives.scriptSrc.includes("'unsafe-inline'"), false);
  assert.deepEqual(policy.directives.connectSrc, ["'self'"]);
  assert.deepEqual(policy.directives.frameAncestors, ["'none'"]);
});

test('development CSP does not force HTTP requests to HTTPS', () => {
  const policy = contentSecurityPolicy('<script src="/app.js" defer></script>', false);
  assert.equal(policy.directives.upgradeInsecureRequests, null);
});
