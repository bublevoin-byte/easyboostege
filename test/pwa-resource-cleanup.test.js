import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as predecessorTools from '../scripts/pwa-predecessor-compat.js';

test('predecessor fixture owns and removes its root when git archive fails after allocation', async () => {
  const source = await fs.readFile(new URL('../scripts/pwa-predecessor-compat.js', import.meta.url), 'utf8');
  assert.match(source, /temporaryDirectory = os\.tmpdir\(\)/u,
    'the fixture must expose a bounded parent so allocation cleanup is observable');
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-predecessor-failure-parent-'));
  let archiveAttempts = 0;
  try {
    await assert.rejects(predecessorTools.buildExactPredecessorFixture({
      projectDirectory: path.resolve('.'),
      commit: '0'.repeat(40),
      temporaryDirectory: parent,
      async runCommand(command, args, options) {
        archiveAttempts += 1;
        assert.equal(command, 'git');
        assert.match(args.join(' '), /archive/u);
        assert.equal(options.commandLabel, 'PWA predecessor git archive');
        throw new Error('synthetic predecessor git archive failure');
      },
    }), /git archive|failed|predecessor/iu);
    assert.equal(archiveAttempts, 1);
    assert.deepEqual(await fs.readdir(parent), [],
      'the fixture must remove the partial root before propagating the primary failure');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('cleanup settlement runs every independent operation and returns labelled failures', async () => {
  assert.equal(typeof predecessorTools.settleCleanupOperations, 'function');
  const calls = [];
  const primaryCleanupFailure = new Error('context close failed');
  const errors = await predecessorTools.settleCleanupOperations([
    ['context', async () => { calls.push('context'); throw primaryCleanupFailure; }],
    ['browser', async () => { calls.push('browser'); }],
    ['fixture', async () => { calls.push('fixture'); }],
  ]);
  assert.deepEqual(calls.sort(), ['browser', 'context', 'fixture']);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /context.*cleanup/iu);
  assert.equal(errors[0].cause, primaryCleanupFailure);
});

test('predecessor artifact generation reports success only after cleanup and preserves dual failures',
  async () => {
    assert.equal(typeof predecessorTools.generatePredecessorCompatibility, 'function');
    const primary = new Error('artifact generation failed');
    const cleanup = new Error('fixture cleanup failed');
    const output = [];
    await assert.rejects(predecessorTools.generatePredecessorCompatibility({
      buildFixture: async () => ({ rootDirectory: '/owned-fixture', distDirectory: '/dist' }),
      generateArtifact: async () => { throw primary; },
      cleanupFixture: async () => { throw cleanup; },
      reportSuccess: (message) => output.push(message),
    }), (error) => {
      assert.ok(error instanceof AggregateError, error?.stack);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[0], primary);
      assert.equal(error.errors[1].cause, cleanup);
      return true;
    });
    assert.deepEqual(output, [], 'neither primary nor cleanup failure may leave success output');

    await assert.rejects(predecessorTools.generatePredecessorCompatibility({
      buildFixture: async () => ({ rootDirectory: '/owned-fixture', distDirectory: '/dist' }),
      generateArtifact: async () => ({ files: [{}], contentSha256: 'c'.repeat(64) }),
      cleanupFixture: async () => { throw cleanup; },
      reportSuccess: (message) => output.push(message),
    }), /cleanup/iu);
    assert.deepEqual(output, [], 'cleanup failure after generation must still suppress success output');

    await predecessorTools.generatePredecessorCompatibility({
      buildFixture: async () => ({ rootDirectory: '/owned-fixture', distDirectory: '/dist' }),
      generateArtifact: async () => ({ files: [{}], contentSha256: 'd'.repeat(64) }),
      cleanupFixture: async () => {},
      reportSuccess: (message) => output.push(message),
    });
    assert.deepEqual(output, [
      `PWA predecessor compatibility: 1 files, ${'d'.repeat(64)}`,
    ]);
  });

test('PWA E2E owns fixture and server before work and settles cleanup in two failure-safe phases', async () => {
  const source = await fs.readFile(new URL('../e2e/aisy-pwa-release.test.js', import.meta.url), 'utf8');
  const declarations = source.indexOf('let predecessorFixture = null;');
  const protectedScope = source.indexOf('try {', declarations);
  const fixtureAllocation = source.indexOf('predecessorFixture = await buildExactPredecessorFixture', protectedScope);
  const serverListen = source.indexOf("server.listen(port, '127.0.0.1'", fixtureAllocation);
  assert.ok(declarations >= 0 && declarations < protectedScope);
  assert.ok(protectedScope < fixtureAllocation && fixtureAllocation < serverListen,
    'the protected scope must begin before the earliest repo-local resource allocation');
  assert.match(source,
    /phaseOneCleanupErrors = await settleCleanupOperations[\s\S]*phaseTwoCleanupErrors = await settleCleanupOperations/u);
  assert.match(source, /new AggregateError\(\[primaryFailure, \.\.\.cleanupErrors\]/u,
    'cleanup failures must not mask the primary scenario failure');
  assert.match(source, /server\?\.listening/u,
    'an unstarted server must not be closed as if it were listening');
});
