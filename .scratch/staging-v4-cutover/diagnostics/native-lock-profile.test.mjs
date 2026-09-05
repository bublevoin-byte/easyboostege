import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { profileOwnedChild, sampleOwnedProcesses } from './native-lock-profile.mjs';

function stat(pid, parent, start) {
  // Linux stat fields 3..22; starttime is field 22, after 18 intervening fields.
  return `${pid} (test ) process) S ${parent} ${'0 '.repeat(17)}${start} 0`;
}

function procFixture(entries) {
  return async (pid, file) => {
    const entry = entries[pid];
    if (!entry) throw Object.assign(new Error('private fixture path'), { code: 'ENOENT' });
    if (file === 'stat') return stat(pid, entry.parent, entry.start);
    if (file === 'children') return (entry.children ?? []).join(' ');
    if (file === 'cmdline') return entry.argv.join('\0') + '\0';
    throw new Error('unexpected metadata read');
  };
}

const anchor = { pid: 100, parent: 50, start: '1000' };

test('owned nested processes report only fixed stage categories, never arguments or identities', async () => {
  const snapshot = await sampleOwnedProcesses(anchor, procFixture({
    100: { parent: 50, start: '1000', children: [101, 102], argv: ['/private/node'] },
    101: { parent: 100, start: '1001', children: [103], argv: [
      '/private/node', '/private/staging-runtime-authority.js', 'secret-recovery-authority',
    ] },
    102: { parent: 100, start: '1002', argv: ['/private/unrecognised-secret-program'] },
    103: { parent: 101, start: '1003', argv: ['/bin/sleep', 'private-duration'] },
  }));
  assert.deepEqual(snapshot.categories, { node: 1, 'runtime-authority': 1, sleep: 1, unknown: 1 });
  assert.equal(snapshot.omitted, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|secret|1000|argv|pid|parent/);
});

test('helper-looking data arguments do not impersonate the executed stage', async () => {
  const snapshot = await sampleOwnedProcesses(anchor, procFixture({
    100: { parent: 50, start: '1000', argv: ['/bin/sleep', '/private/staging-runtime-authority.js'] },
  }));
  assert.deepEqual(snapshot.categories, { sleep: 1 });
});

test('the actual inherited descriptor executable retains its helper stage category', async () => {
  const snapshot = await sampleOwnedProcesses(anchor, procFixture({
    100: { parent: 50, start: '1000', argv: ['/proc/12345/fd/9', '/private/staging-helper-bundle.js'] },
  }));
  assert.deepEqual(snapshot.categories, { 'helper-bundle': 1 });
  assert.doesNotMatch(JSON.stringify(snapshot), /12345|private|proc/);
});

test('observation preserves a finite child failure and emits a bounded final category report', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(23), 100)'], {
    stdio: 'ignore',
  });
  const reports = [];
  const result = await profileOwnedChild(child, {
    readProc: procFixture({
      [child.pid]: { parent: process.pid, start: '1000', argv: ['/private/node', 'secret-argument'] },
    }),
    writeLine: (line) => reports.push(line),
    sampleIntervalMs: 10,
  });
  assert.deepEqual(result, { code: 23, signal: null });
  const final = JSON.parse(reports.at(-1));
  assert.equal(final.event, 'child-exit');
  assert.equal(final.exit_code, 23);
  assert.ok(final.samples >= 1);
  assert.ok(final.categories.some((entry) => entry.category === 'node' && entry.observations >= 1));
  assert.ok(reports.every((line) => Buffer.byteLength(line) <= 8192));
  assert.doesNotMatch(reports.join(''), /private|secret|argv|pid|parent/);
});

test('missing, reparented, older and PID-zero entries cannot become owned descendants', async () => {
  const snapshot = await sampleOwnedProcesses(anchor, procFixture({
    100: { parent: 50, start: '1000', children: [101, 102, 103, 0], argv: ['/bin/bash'] },
    102: { parent: 999, start: '1002', argv: ['/bin/sleep'] },
    103: { parent: 100, start: '999', argv: ['/bin/sleep'] },
  }));
  assert.deepEqual(snapshot.categories, { bash: 1 });
  assert.equal(snapshot.omitted, 4);
  assert.deepEqual((await sampleOwnedProcesses({ ...anchor, pid: 0 }, procFixture({}))).categories, {});
});

test('PID reuse during discovery or after command inspection discards the unstable child', async () => {
  for (const changesOnRead of [2, 3]) {
    let statReads = 0;
    const read = procFixture({
      100: { parent: 50, start: '1000', children: [101], argv: ['/bin/bash'] },
      101: { parent: 100, start: '1001', argv: ['/bin/sleep'] },
    });
    const snapshot = await sampleOwnedProcesses(anchor, (pid, file) => {
      if (pid === 101 && file === 'stat' && ++statReads >= changesOnRead) {
        return stat(101, 100, '2000');
      }
      return read(pid, file);
    });
    assert.deepEqual(snapshot.categories, { bash: 1 });
    assert.equal(snapshot.omitted, 1);
  }
});

test('a changed or missing anchor discards its whole sampled subtree', async () => {
  let anchorReads = 0;
  const read = procFixture({
    100: { parent: 50, start: '1000', children: [101], argv: ['/bin/bash'] },
    101: { parent: 100, start: '1001', argv: ['/bin/sleep'] },
  });
  const changed = await sampleOwnedProcesses(anchor, (pid, file) => (
    pid === 100 && file === 'stat' && ++anchorReads === 2 ? stat(100, 50, '2000') : read(pid, file)
  ));
  assert.deepEqual(changed.categories, {});
  assert.equal(changed.omitted, 1);
  assert.deepEqual((await sampleOwnedProcesses(anchor, procFixture({}))).categories, {});
});

test('wide trees, missing entries and oversized metadata have fixed observation bounds', async () => {
  const entries = {
    100: { parent: 50, start: '1000', children: [], argv: ['/bin/bash'] },
  };
  for (let pid = 101; pid <= 300; pid++) {
    entries[100].children.push(pid);
    entries[pid] = { parent: 100, start: '1001', argv: ['/bin/sleep', 'private-argument'] };
  }
  const wide = await sampleOwnedProcesses(anchor, procFixture(entries));
  assert.deepEqual(wide.categories, { bash: 1, sleep: 63 });
  assert.equal(wide.truncated, true);
  assert.ok(wide.reads <= 512);
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) < 256);

  let calls = 0;
  entries[100].children = Array.from({ length: 900 }, (_, index) => index + 1000);
  const missing = procFixture(entries);
  const exhausted = await sampleOwnedProcesses(anchor, (pid, file) => { calls++; return missing(pid, file); });
  assert.ok(calls <= 512);
  assert.equal(exhausted.truncated, true);

  entries[100].argv = ['x'.repeat(4097)];
  const oversized = await sampleOwnedProcesses(anchor, procFixture(entries));
  assert.deepEqual(oversized.categories, {});
  assert.equal(oversized.truncated, true);
});

test('a finite child outlives the sample cap without being signalled or changing its result', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(17), 180)'], { stdio: 'ignore' });
  const reports = [];
  const result = await profileOwnedChild(child, {
    readProc: procFixture({
      [child.pid]: { parent: process.pid, start: '1000', argv: ['/bin/bash'] },
    }),
    sampleIntervalMs: 10, maxSamples: 3,
    writeLine: (line) => reports.push(JSON.parse(line)),
  });
  assert.deepEqual(result, { code: 17, signal: null });
  assert.deepEqual(reports.map((report) => report.event), ['sample-limit', 'child-exit']);
  assert.equal(reports.at(-1).samples, 3);
  assert.equal(reports.at(-1).categories[0].sampled_residency_ms, 30);
});

test('metadata and report-write failures cannot mask the original finite child failure', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(19), 50)'], { stdio: 'ignore' });
  const result = await profileOwnedChild(child, {
    readProc: async () => { throw new Error('private unavailable metadata'); },
    writeLine: () => { throw new Error('private closed output'); },
  });
  assert.deepEqual(result, { code: 19, signal: null });
});

test('native /proc observes a real finite grandchild and the harness exits with the child status', {
  skip: process.platform !== 'linux' && 'requires Linux /proc',
}, () => {
  const harness = fileURLToPath(new URL('./finite-child-harness.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [harness], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 8192,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 23, result.stderr);
  const final = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(final.event, 'child-exit');
  assert.ok(final.categories.some((entry) => entry.category === 'sleep' && entry.observations > 0));
  assert.doesNotMatch(result.stdout, /private|secret|argv|pid|parent/);
});

test('observer completion clears its pending sampling timer', () => {
  const harness = fileURLToPath(new URL('./finite-child-harness.mjs', import.meta.url));
  const started = performance.now();
  const result = spawnSync(process.execPath, [harness, 'timer'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 8192,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 23, result.stderr);
  assert.ok(performance.now() - started < 900, 'a pending 1000ms observer timer must not delay exit');
});
