import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { classifyLearningAccess, LEARNING_ACCESS_STATES } from '../public/access.js';

test('only a server-authenticated session with active true opens learning', () => {
  assert.deepEqual(classifyLearningAccess({ authenticated: true, username: 'active', active: true }), {
    state: LEARNING_ACCESS_STATES.ACTIVE,
    session: { authenticated: true, username: 'active', active: true },
  });

  for (const session of [
    { authenticated: true, username: 'inactive', active: false },
    { authenticated: true, username: 'missing-subscription' },
  ]) {
    assert.equal(classifyLearningAccess(session).state, LEARNING_ACCESS_STATES.INACTIVE);
  }

  assert.equal(classifyLearningAccess(null).state, LEARNING_ACCESS_STATES.NO_SESSION);
  assert.equal(classifyLearningAccess({ authenticated: false }).state, LEARNING_ACCESS_STATES.NO_SESSION);
});

test('session failures distinguish no session from an unknown network or server result', () => {
  assert.equal(
    classifyLearningAccess(null, { status: 401, code: 'SESSION_REVOKED' }).state,
    LEARNING_ACCESS_STATES.NO_SESSION,
  );
  for (const error of [
    { status: 0, code: 'NETWORK_ERROR' },
    { status: 503, code: 'REQUEST_FAILED' },
    new Error('connection reset'),
  ]) {
    assert.equal(
      classifyLearningAccess(null, error).state,
      LEARNING_ACCESS_STATES.NETWORK_UNKNOWN,
    );
  }
});

test('the private shell remains hidden and inert until active authority commits', async () => {
  const [app, shell, launcher] = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/aisy-shell.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/asya-launcher.js', import.meta.url), 'utf8'),
  ]);

  assert.match(app, /#aisy-shell-nav,#aisy-shell-back,#asya-launcher/u);
  assert.match(app, /element\.hidden=true;element\.inert=true/u);
  assert.match(app, /document\.body\.dataset\.learningAccess='locked'/u);
  assert.match(shell, /dataset\.learningAccess==='active'/u);
  assert.match(launcher, /dataset\.learningAccess==='active'/u);
  assert.doesNotMatch(app, /offlineEgeMock:true/u,
    'an unverified server response cannot revive an owner-bound mock route');
});

test('logout preserves local authority until the server confirms HttpOnly session revocation', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const logout = app.match(/async function logout\(expectedAuthority=null\)\{([\s\S]*?)\n\}/u)?.[1] || '';
  const identityClear = logout.indexOf('currentUser=null;currentDisplayName=null');
  const remoteLogout = logout.indexOf("await auth.logout({'X-EasyBoost-Expected-Owner':logoutOwner})");

  assert.ok(identityClear >= 0, 'logout must clear the internal owner and display identity together');
  assert.ok(remoteLogout >= 0 && remoteLogout < identityClear,
    'a failed server revocation must not erase local authority and silently revive the cookie later');
  assert.match(logout, /hideLearningShell\(\);try\{firstLaunch\.showLogin\(\)\}/u);
  assert.doesNotMatch(logout, /try\{if\(SRV\)await auth\.logout\(\)\}catch\(_\)\{\}/u);
  assert.match(logout, /apiResponseOwner\(result\)!==logoutOwner/u);
});

test('an authoritative no-session result closes private UI before owner cleanup can await', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const clearAuthority = app.match(/async function clearNoSessionAuthority\(authGuard\)\{([\s\S]*?)\n\}/u)?.[1] || '';
  const identityClear = clearAuthority.indexOf('currentUser=null;currentDisplayName=null');
  const shellClose = clearAuthority.indexOf('hideLearningShell()');
  const ownerCleanup = clearAuthority.indexOf('await store.clearCurrentOwner');

  assert.ok(identityClear >= 0, 'no-session must clear both identity fields');
  assert.ok(shellClose > identityClear,
    'private controls must close immediately after authority is revoked');
  assert.ok(ownerCleanup > shellClose,
    'durable cleanup cannot delay the fail-closed presentation');
  assert.match(clearAuthority, /if\(!authGuard\.deferPresentation\)try\{firstLaunch\.showLogin\(\)\}catch\(_\)\{show\('scr5'\)\}/u);
});
