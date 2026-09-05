import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const bashExecutable = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';

const postgresContainerId = '2'.repeat(64);
const operationToken = '12345678-1234-4abc-8def-1234567890ab';
const archiveSha256 = 'a'.repeat(64);
const windowsGitBashSegfaultExitCode = 2816;
const windowsGitBashReadRetryDelaysMs = [100, 300, 900];
const supervisorInput = {
  archiveBytes: 23,
  archiveSha256,
  capacityHeadroomBytes: 1_048_576,
};

function commandKind(arguments_) {
  if (arguments_[0] === 'stop') return 'stop';
  if (arguments_[0] === 'inspect') return 'inspect';
  if (arguments_[0] === 'exec' && arguments_.includes('--detach')) return 'launch';
  if (arguments_.includes('psql')) return 'activity';
  const script = arguments_.find((argument) => typeof argument === 'string'
    && argument.includes('# EASYBOOST_RESTORE_')) || '';
  if (script.includes('EASYBOOST_RESTORE_STAGE')) return 'stage';
  if (script.includes('EASYBOOST_RESTORE_CANCEL')) return 'cancel';
  if (script.includes('EASYBOOST_RESTORE_PROBE')) return 'probe';
  if (script.includes('EASYBOOST_RESTORE_CLEANUP')) return 'cleanup';
  return 'unknown';
}

async function captureRemoteRestoreScripts(token) {
  const { runSupervisedPostgresRestore } = await import(
    '../scripts/postgres-restore-supervisor.js'
  );
  const launchError = new Error('capture remote restore scripts');
  const scripts = {};
  await assert.rejects(runSupervisedPostgresRestore({
    ...supervisorInput,
    createOperationToken: () => token,
    inputHandle: {},
    postgresContainerId,
    restoreDeadlineMs: 60_000,
    runDocker: async (arguments_) => {
      const kind = commandKind(arguments_);
      const script = arguments_.find((argument) => typeof argument === 'string'
        && argument.includes('# EASYBOOST_RESTORE_')) || '';
      if (script) scripts[kind] = script;
      if (kind === 'stage') return '';
      if (kind === 'launch') throw launchError;
      if (kind === 'cancel' || kind === 'cleanup') return '';
      if (kind === 'probe') return 'STATUS=EXIT:74\nPROCESS=NONE';
      if (kind === 'activity') return '0';
      throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
    },
    wait: async () => {},
  }), (error) => error === launchError);
  return scripts;
}

async function runBashFixture({ environment, fixtureLabel, input, spawnArguments, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bashExecutable, spawnArguments, {
      env: { ...process.env, ...environment },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let closeFixture;
    const fixtureClosed = new Promise((closed) => { closeFixture = closed; });
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      const error = new Error(
        `Bash behavioral fixture ${fixtureLabel} exceeded ${timeoutMs}ms`,
      );
      error.code = null;
      error.killed = true;
      if (process.platform === 'win32') {
        // Keep the owned launcher alive until taskkill has captured its tree.
        // Killing only Git Bash's launcher first loses its descendants and pipes.
        let cleanupError;
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
          cleanupError = new Error('Timed-out Bash launcher already exited; tree settlement is unproven');
        } else {
          const cleanup = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            encoding: 'utf8',
            killSignal: 'SIGKILL',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 1000,
            windowsHide: true,
          });
          if (cleanup.error || cleanup.status !== 0) {
            cleanupError = new Error('Timed-out Bash process tree termination failed', {
              cause: cleanup.error || new Error(`taskkill exited ${cleanup.status}: ${cleanup.stderr}`),
            });
          }
        }
        // Exact tree termination is attempted before closing inherited pipe ends.
        // Failure remains explicit even when the launcher can be stopped locally.
        if (cleanupError) {
          try { child.kill('SIGKILL'); } catch (cause) {
            cleanupError = new AggregateError([cleanupError, cause],
              'Timed-out Bash tree and launcher termination failed');
          }
        }
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        let closeTimer;
        const closed = await Promise.race([
          fixtureClosed.then(() => true),
          new Promise((resolveClose) => {
            closeTimer = setTimeout(() => resolveClose(false), 1000);
          }),
        ]);
        clearTimeout(closeTimer);
        if (!closed) {
          cleanupError = new Error('Timed-out Bash launcher did not close within 1000ms', {
            cause: cleanupError,
          });
          // Match the existing bounded-child uncertainty contract: report failure
          // after attempted termination instead of retaining a hung worker handle.
          child.unref();
        }
        if (cleanupError) {
          error.childSettlementUnproven = true;
          error.cause = cleanupError;
        }
      } else {
        child.kill();
      }
      error.stderr = Buffer.concat(stderr).toString('utf8');
      error.stdout = Buffer.concat(stdout).toString('utf8');
      reject(error);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout.push(chunk); });
    child.stderr.on('data', (chunk) => { stderr.push(chunk); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      closeFixture();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      const failureDetail = result.stderr.trim() || `exited ${code}`;
      const error = new Error(`Bash behavioral fixture ${fixtureLabel}: ${failureDetail}`);
      error.code = code;
      error.signal = signal;
      error.stderr = result.stderr;
      error.stdout = result.stdout;
      reject(error);
    });
    child.stdin.end(input);
  });
}

async function runBashScript(script, arguments_ = [], environment = {}, timeoutMs = 15_000) {
  const fixtureLabel = script.match(/# EASYBOOST_RESTORE_([A-Z]+)/u)?.[1]?.toLowerCase()
    || 'support';
  return runBashFixture({
    environment,
    fixtureLabel,
    input: script,
    spawnArguments: ['-seu', '--', ...arguments_],
    timeoutMs,
  });
}

function runBashTimeoutWorker(input) {
  const workerSource = `
    import { spawn, spawnSync } from 'node:child_process';
    const bashExecutable = ${JSON.stringify(bashExecutable)};
    const runBashFixture = ${runBashFixture.toString()};
    try {
      await runBashFixture({
        environment: { FIXTURE_NODE: ${JSON.stringify(toBashPath(process.execPath))} },
        fixtureLabel: 'owned-descendant-timeout',
        input: ${JSON.stringify(input)},
        spawnArguments: ['-seu', '--'],
        timeoutMs: 1000,
      });
      throw new Error('fixture unexpectedly succeeded');
    } catch (error) {
      console.log(JSON.stringify({
        code: error.code, killed: error.killed, message: error.message,
        stdout: error.stdout, stderr: error.stderr,
        childSettlementUnproven: error.childSettlementUnproven,
        cause: error.cause?.message, cleanupCause: error.cause?.cause?.message,
      }));
    }
  `;
  const startedAt = performance.now();
  const worker = spawnSync(process.execPath, ['--input-type=module', '--eval', workerSource], {
    encoding: 'utf8',
    timeout: 12_000,
    windowsHide: true,
  });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(worker.status, 0, `${worker.error || ''}\n${worker.stderr}`);
  assert.ok(elapsedMs < 3000,
    `timed-out fixture worker must exit before its finite child: ${Math.round(elapsedMs)}ms`);
  return JSON.parse(worker.stdout.trim());
}

test('Windows Bash fixture timeout settles its owned descendant and releases the worker', {
  skip: process.platform !== 'win32',
}, () => {
  // A finite child keeps this regression bounded even against the broken harness.
  const failure = runBashTimeoutWorker([
    "printf 'fixture diagnostic\\n' >&2",
    `"$FIXTURE_NODE" -e 'console.log("OWNED_CHILD=" + process.pid); setTimeout(() => {}, 8000)' &`,
    'wait',
    '',
  ].join('\n'));
  assert.equal(failure.killed, true, 'bounded cleanup must not turn timeout into success');
  assert.equal(failure.code, null);
  assert.match(failure.message, /owned-descendant-timeout exceeded 1000ms/u);
  assert.match(failure.stderr, /fixture diagnostic/u);
  assert.notEqual(failure.childSettlementUnproven, true, JSON.stringify(failure));
  const childPid = Number(failure.stdout?.match(/OWNED_CHILD=(\d+)/u)?.[1]);
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0,
    'the real descendant must start before the fixture deadline');
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' },
    'prompt worker exit must also settle the exact owned descendant');
});

test('Windows Bash fixture reports an exited launcher with inherited pipes as unproven', {
  skip: process.platform !== 'win32',
}, async () => {
  const failure = runBashTimeoutWorker([
    `"$FIXTURE_NODE" -e 'console.log("OWNED_CHILD=" + process.pid); setTimeout(() => {}, 3000)' &`,
    'exit 0',
    '',
  ].join('\n'));
  assert.equal(failure.killed, true);
  assert.equal(failure.code, null);
  assert.match(failure.message, /owned-descendant-timeout exceeded 1000ms/u);
  assert.equal(failure.childSettlementUnproven, true,
    'closing inherited pipes cannot prove that an exited launcher has no descendants');
  assert.match(failure.cause, /launcher already exited/u);
  const childPid = Number(failure.stdout?.match(/OWNED_CHILD=(\d+)/u)?.[1]);
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
  // This deliberately orphaned descendant is finite; retain responsibility for
  // observing its natural exit without using its exited parent as kill authority.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(childPid, 0); } catch (error) {
      assert.equal(error.code, 'ESRCH');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('the finite uncertainty fixture descendant did not settle');
});

async function retryReadOnlyWindowsGitBash(operation, {
  deadlineMs,
  delays = windowsGitBashReadRetryDelaysMs,
  now = Date.now,
  platform = process.platform,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}) {
  const deadlineAt = now() + deadlineMs;
  let lastError;
  for (let attempt = 0; ; attempt += 1) {
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) {
      throw lastError || new Error(`Read-only Bash behavioral fixture exceeded ${deadlineMs}ms`);
    }
    try {
      return await operation(remainingMs);
    } catch (error) {
      lastError = error;
      const retryDelayMs = delays[attempt];
      if (platform !== 'win32'
        || error?.code !== windowsGitBashSegfaultExitCode
        || error?.signal !== null
        || retryDelayMs === undefined
        || retryDelayMs >= deadlineAt - now()) {
        throw error;
      }
      await sleep(retryDelayMs);
    }
  }
}

async function runReadOnlyBashScript(script, arguments_ = [], environment = {}, timeoutMs = 15_000) {
  return retryReadOnlyWindowsGitBash(
    (remainingMs) => runBashScript(script, arguments_, environment, remainingMs),
    { deadlineMs: timeoutMs },
  );
}

function createWindowsGitBashSegfaultError(label) {
  const error = new Error(label);
  error.code = windowsGitBashSegfaultExitCode;
  error.signal = null;
  return error;
}

test('read-only Windows Git Bash retries three segfaults within one bounded deadline', async () => {
  const errors = [0, 1, 2].map((index) => createWindowsGitBashSegfaultError(`crash-${index}`));
  const waits = [];
  let calls = 0;
  const result = await retryReadOnlyWindowsGitBash(async () => {
    const error = errors[calls];
    calls += 1;
    if (error) throw error;
    return 'observed';
  }, {
    deadlineMs: 15_000,
    now: () => 0,
    platform: 'win32',
    sleep: async (delayMs) => { waits.push(delayMs); },
  });
  assert.equal(result, 'observed');
  assert.equal(calls, 4);
  assert.deepEqual(waits, windowsGitBashReadRetryDelaysMs);
});

test('read-only Windows Git Bash rethrows the exact fourth segfault without a fifth attempt',
  async () => {
    const errors = [0, 1, 2, 3]
      .map((index) => createWindowsGitBashSegfaultError(`crash-${index}`));
    let calls = 0;
    await assert.rejects(retryReadOnlyWindowsGitBash(async () => {
      const error = errors[calls];
      calls += 1;
      throw error;
    }, {
      deadlineMs: 15_000,
      now: () => 0,
      platform: 'win32',
      sleep: async () => {},
    }), (error) => error === errors[3]);
    assert.equal(calls, 4);
  });

test('read-only Windows Git Bash shares one shrinking deadline across every attempt',
  async () => {
    const errors = [
      createWindowsGitBashSegfaultError('first-crash'),
      createWindowsGitBashSegfaultError('second-crash'),
    ];
    const remainingBudgets = [];
    const waits = [];
    let clock = 0;
    let calls = 0;
    await assert.rejects(retryReadOnlyWindowsGitBash(async (remainingMs) => {
      remainingBudgets.push(remainingMs);
      if (calls === 0) clock = 600;
      else clock = 950;
      const error = errors[calls];
      calls += 1;
      throw error;
    }, {
      deadlineMs: 1_000,
      delays: [100, 300],
      now: () => clock,
      platform: 'win32',
      sleep: async (delayMs) => { waits.push(delayMs); clock += delayMs; },
    }), (error) => error === errors[1]);
    assert.equal(calls, 2,
      'the next backoff must not start when it cannot fit inside the shared deadline');
    assert.deepEqual(remainingBudgets, [1_000, 300]);
    assert.deepEqual(waits, [100]);
  });

test('read-only Bash never retries a different failure or a non-Windows segfault', async () => {
  const fixtures = [
    { error: Object.assign(new Error('other'), { code: 74, signal: null }), platform: 'win32' },
    { error: createWindowsGitBashSegfaultError('linux-segfault'), platform: 'linux' },
  ];
  for (const fixture of fixtures) {
    let calls = 0;
    await assert.rejects(retryReadOnlyWindowsGitBash(async () => {
      calls += 1;
      throw fixture.error;
    }, {
      deadlineMs: 15_000,
      now: () => 0,
      platform: fixture.platform,
      sleep: async () => {},
    }), (error) => error === fixture.error);
    assert.equal(calls, 1);
  }
});

test('read-only Bash returns immediate success without sleeping', async () => {
  let slept = false;
  const result = await retryReadOnlyWindowsGitBash(async () => 'observed', {
    deadlineMs: 15_000,
    now: () => 0,
    platform: 'win32',
    sleep: async () => { slept = true; },
  });
  assert.equal(result, 'observed');
  assert.equal(slept, false);
});

async function runBashCommandWithInput(
  script,
  input,
  arguments_ = [],
  environment = {},
  timeoutMs = 15_000,
) {
  return runBashFixture({
    environment,
    fixtureLabel: 'stdin-command',
    input,
    spawnArguments: ['-ceu', script, 'easyboost-shell-fixture', ...arguments_],
    timeoutMs,
  });
}

function toBashPath(filePath) {
  if (process.platform !== 'win32') return filePath;
  return filePath.replace(/^([A-Za-z]):\\/u, (_, drive) => `/${drive.toLowerCase()}/`)
    .replaceAll('\\', '/');
}

async function createFakePgRestore(body) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-fake-pg-restore-'));
  const executable = path.join(root, 'pg_restore');
  await fs.writeFile(executable, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o700 });
  await fs.chmod(executable, 0o700);
  return {
    async cleanup() { await fs.rm(root, { force: true, recursive: true }); },
    path: `${toBashPath(root)}:/usr/bin:/bin`,
  };
}

async function prepareRemoteRestoreFixture(token) {
  await runBashScript(String.raw`
token="$1"
base="/tmp/easyboost-restore-$token"
printf 'fixture\n' > "$base.dump"
printf 'fixture\n' > "$base.reserve"
`, [token]);
}

async function findTokenProcesses(token) {
  const { stdout } = await runReadOnlyBashScript(String.raw`
token="$1"
for environment_file in /proc/[0-9]*/environ; do
  [ -r "$environment_file" ] || continue
  if tr '\000' '\n' < "$environment_file" 2>/dev/null \
    | grep -Fqx "EASYBOOST_RESTORE_OPERATION_TOKEN=$token"; then
    pid="${'$'}{environment_file#/proc/}"
    printf '%s\n' "${'$'}{pid%/environ}"
  fi
done
`, [token]);
  return stdout.trim() ? stdout.trim().split(/\r?\n/u) : [];
}

async function cleanupRemoteRestoreFixture(token, scripts) {
  const tokenProcesses = await findTokenProcesses(token).catch(() => ['unproven']);
  if (tokenProcesses.length && scripts.cancel) {
    await runBashScript(scripts.cancel, [token]).catch(() => {});
  }
  if (scripts.cleanup) await runBashScript(scripts.cleanup, [token]);
}

function injectIdentityCaptureFailure(script, identityName) {
  const target = `${identityName}_start_time="$(read_process_start_time "$${identityName}_pid")"`;
  assert.equal(script.includes(target), true,
    `the real remote script must expose the ${identityName} identity capture seam`);
  return script.replace(target, `${identityName}_start_time="$(false)"`);
}

function injectReplacedChildObservation(script) {
  const start = script.indexOf('observe_restore_identity() (');
  const end = script.indexOf('\n)\n', start);
  assert.ok(start >= 0 && end > start,
    'the behavioral harness must replace the exact post-handshake observation helper');
  return `${script.slice(0, start)}observe_restore_identity() (
  printf 'REPLACED\\n'
)${script.slice(end + 2)}`;
}

function replacePgRestoreCommand(script, command) {
  const start = script.indexOf('  exec pg_restore -U easyboost');
  const end = script.indexOf('\n) &', start);
  assert.ok(start >= 0 && end > start,
    'the behavioral harness must replace the real gated pg_restore command exactly once');
  return `${script.slice(0, start)}  ${command}${script.slice(end)}`;
}

async function readRemoteRestoreOutcome(token) {
  const { stdout } = await runReadOnlyBashScript(String.raw`
token="$1"
base="/tmp/easyboost-restore-$token"
status='MISSING'
[ ! -r "$base.status" ] || status="$(head -n 1 "$base.status")"
marker='ABSENT'
[ ! -e "$base.fake-pg-restore-invoked" ] || marker='PRESENT'
printf '%s|%s\n' "$status" "$marker"
`, [token]);
  return stdout.trim();
}

async function runRemoteProbe(probeScript, token) {
  const { stdout } = await runReadOnlyBashScript(probeScript, [token]);
  return stdout.replaceAll('\r\n', '\n').trim();
}

async function runTerminalFixtureProbe(probeScript, token) {
  const promoteAmbientUncertainty = String.raw`  if [ "$process" = 'NONE' ] && [ "$process_unknown" = 'true' ]; then
    process='UNKNOWN'
  fi`;
  assert.equal(probeScript.includes(promoteAmbientUncertainty), true,
    'the production probe must retain its fail-closed ambient-process uncertainty');
  const fixtureProbe = probeScript.replace(
    promoteAmbientUncertainty,
    "  : # fixture separately proves absence of every readable token-bearing process",
  );
  return runRemoteProbe(fixtureProbe, token);
}

test('remote staging reserves exact archive bytes for partial and whole MiB inputs', async () => {
  const scripts = await captureRemoteRestoreScripts(randomUUID());
  const fixtures = [
    Buffer.alloc(23, 0x61),
    Buffer.alloc(1024 * 1024, 0x62),
  ];

  for (const payload of fixtures) {
    const token = randomUUID();
    const fixtureBase = path.join(os.tmpdir(), `easyboost-restore-${token}`);
    try {
      await runBashCommandWithInput(scripts.stage, payload, [], {
        EASYBOOST_RESTORE_ARCHIVE_BYTES: String(payload.length),
        EASYBOOST_RESTORE_ARCHIVE_SHA256: createHash('sha256').update(payload).digest('hex'),
        EASYBOOST_RESTORE_CAPACITY_HEADROOM_BYTES: String(1024 * 1024),
        EASYBOOST_RESTORE_OPERATION_TOKEN: token,
      });
      assert.equal((await fs.stat(`${fixtureBase}.dump`)).size, payload.length,
        'the staged archive must retain its exact non-rounded byte length');
      assert.equal((await fs.stat(`${fixtureBase}.reserve`)).size, 1024 * 1024,
        'the reserved headroom must retain its exact policy byte length');
      assert.equal((await fs.readFile(`${fixtureBase}.status`, 'utf8')).trim(), 'STAGED');
    } finally {
      await runBashScript(scripts.cleanup, [token]).catch(() => {});
    }
  }

  const failedToken = randomUUID();
  const failedBase = path.join(os.tmpdir(), `easyboost-restore-${failedToken}`);
  await assert.rejects(runBashCommandWithInput(scripts.stage, Buffer.alloc(23, 0x63), [], {
    EASYBOOST_RESTORE_ARCHIVE_BYTES: '23',
    EASYBOOST_RESTORE_ARCHIVE_SHA256: '0'.repeat(64),
    EASYBOOST_RESTORE_CAPACITY_HEADROOM_BYTES: String(1024 * 1024),
    EASYBOOST_RESTORE_OPERATION_TOKEN: failedToken,
  }));
  await runBashScript(scripts.cancel, [failedToken]);
  await runBashScript(scripts.cleanup, [failedToken]);
  for (const suffix of ['dump', 'reserve', 'status', 'status.tmp', 'cancel', 'cancel.external.tmp']) {
    await assert.rejects(fs.access(`${failedBase}.${suffix}`),
      `failure cancellation and cleanup must remove ${suffix}`);
  }
});

test('an unreadable live process makes remote token-process evidence UNKNOWN', async () => {
  const token = randomUUID();
  const scripts = await captureRemoteRestoreScripts(token);
  const environmentRead = String.raw`tr '\000' '\n' < "$environment_file" 2>/dev/null`;
  assert.equal(scripts.probe.includes(environmentRead), true,
    'the production probe must expose its real process-environment read');
  const unreadableProbe = scripts.probe.replace(environmentRead, 'false');

  assert.equal(await runRemoteProbe(unreadableProbe, token),
    'STATUS=PENDING\nPROCESS=UNKNOWN',
    'an extant process whose environment cannot be read is not absence proof');
});

test('remote restore success reaps every token-bearing watchdog descendant', async () => {
  const token = randomUUID();
  const scripts = await captureRemoteRestoreScripts(token);
  const fakePgRestore = await createFakePgRestore('sleep 1');
  await prepareRemoteRestoreFixture(token);
  try {
    await runBashScript(scripts.launch, [], {
      EASYBOOST_RESTORE_DEADLINE_SECONDS: '30',
      EASYBOOST_RESTORE_OPERATION_TOKEN: token,
      PATH: fakePgRestore.path,
    });
    assert.deepEqual(await findTokenProcesses(token), [],
      'normal completion must not leave the watchdog sleep active until its deadline');
    assert.equal(await runTerminalFixtureProbe(scripts.probe, token),
      'STATUS=EXIT:0\nPROCESS=NONE',
      'the production probe must observe terminal settlement immediately after success');
  } finally {
    await cleanupRemoteRestoreFixture(token, scripts);
    await fakePgRestore.cleanup();
  }
});

test('an already-exited exact watchdog is reaped as a same-birth zombie', async () => {
  const token = randomUUID();
  const scripts = await captureRemoteRestoreScripts(token);
  const fakePgRestore = await createFakePgRestore('sleep 1');
  const watchdogStart = '  watchdog_attempt=0';
  assert.equal(scripts.launch.includes(watchdogStart), true);
  const zombieScript = scripts.launch.replace(watchdogStart, '  exit 0');
  await prepareRemoteRestoreFixture(token);
  try {
    await runBashScript(zombieScript, [], {
      EASYBOOST_RESTORE_DEADLINE_SECONDS: '30',
      EASYBOOST_RESTORE_OPERATION_TOKEN: token,
      PATH: fakePgRestore.path,
    });
    assert.equal(await runTerminalFixtureProbe(scripts.probe, token),
      'STATUS=EXIT:0\nPROCESS=NONE');
    assert.deepEqual(await findTokenProcesses(token), [],
      'a same-birth zombie is exact reap authority, never a reason to leave the lock active');
  } finally {
    await cleanupRemoteRestoreFixture(token, scripts);
    await fakePgRestore.cleanup();
  }
});

test('restore identity capture failure closes the startup gate before pg_restore can run', async () => {
  const token = randomUUID();
  const scripts = await captureRemoteRestoreScripts(token);
  const fakePgRestore = await createFakePgRestore(String.raw`
printf 'invoked\n' > "/tmp/easyboost-restore-$EASYBOOST_RESTORE_OPERATION_TOKEN.fake-pg-restore-invoked"
while :; do :; done
`);
  await prepareRemoteRestoreFixture(token);
  try {
    await assert.rejects(runBashScript(
      injectIdentityCaptureFailure(scripts.launch, 'restore'),
      [],
      {
        EASYBOOST_RESTORE_DEADLINE_SECONDS: '30',
        EASYBOOST_RESTORE_OPERATION_TOKEN: token,
        PATH: fakePgRestore.path,
      },
    ), (error) => {
      assert.equal(error.code, 74);
      return true;
    });
    assert.equal(await readRemoteRestoreOutcome(token), 'EXIT:74|ABSENT',
      'the gated child must exit and publish failure without entering pg_restore');
    assert.deepEqual(await findTokenProcesses(token), [],
      'a failed restore identity capture must reap the gated child');
    assert.equal(await runTerminalFixtureProbe(scripts.probe, token),
      'STATUS=EXIT:74\nPROCESS=NONE');
  } finally {
    await cleanupRemoteRestoreFixture(token, scripts);
    await runBashScript('rm -f "/tmp/easyboost-restore-$1.fake-pg-restore-invoked"', [token]);
    await fakePgRestore.cleanup();
  }
});

test('a direct restore child that exits before READY is reaped as an exact zombie', async () => {
  const token = randomUUID();
  const scripts = await captureRemoteRestoreScripts(token);
  const readyPublish = '  printf \'READY:%s\\n\' "$own_start_time" > "${restore_ready}.tmp"';
  assert.equal(scripts.launch.includes(readyPublish), true,
    'the real restore child must expose its pre-READY publication boundary');
  const processReaderStart = 'read_process_record() (\n  identity_pid="$1"\n';
  assert.equal(scripts.launch.includes(processReaderStart), true,
    'the real remote script must expose the process-state observer');
  const zombieObserver = [
    'read_process_record() (',
    '  identity_pid="$1"',
    '  if [ -n "${restore_pid:-}" ] && [ "$identity_pid" = "$restore_pid" ] \\',
    '    && [ -r "$base.pre-ready-start" ]; then',
    '    IFS= read -r pre_ready_start < "$base.pre-ready-start" || exit 1',
    '    printf \'Z:%s\\n\' "$pre_ready_start"',
    '    exit 0',
    '  fi',
  ].join('\n');
  const earlyExitScript = scripts.launch
    .replace(processReaderStart, `${zombieObserver}\n`)
    .replace(readyPublish, [
      '  printf \'%s\\n\' "$own_start_time" > "$base.pre-ready-start"',
      '  exit 74',
    ].join('\n'));
  const fixtureBase = path.join(os.tmpdir(), `easyboost-restore-${token}`);
  await prepareRemoteRestoreFixture(token);
  try {
    await assert.rejects(runBashScript(earlyExitScript, [], {
      EASYBOOST_RESTORE_DEADLINE_SECONDS: '30',
      EASYBOOST_RESTORE_OPERATION_TOKEN: token,
    }), (error) => {
      assert.equal(error.code, 74);
      return true;
    });
    assert.equal(await readRemoteRestoreOutcome(token), 'EXIT:74|ABSENT',
      'an exact direct-child zombie is bounded wait authority, not retained outer authority');
    await assert.rejects(fs.access(`${fixtureBase}.outer-authority`),
      'pre-READY zombie settlement must not publish unproven outer authority');
    assert.deepEqual(await findTokenProcesses(token), []);
    assert.equal(await runTerminalFixtureProbe(scripts.probe, token),
      'STATUS=EXIT:74\nPROCESS=NONE');
  } finally {
    await cleanupRemoteRestoreFixture(token, scripts);
    await fs.rm(`${fixtureBase}.pre-ready-start`, { force: true });
  }
});

test('a delayed launch after cooperative cancellation never starts pg_restore', async () => {
  const token = randomUUID();
  const scripts = await captureRemoteRestoreScripts(token);
  const fakePgRestore = await createFakePgRestore(String.raw`
printf 'invoked\n' > "/tmp/easyboost-restore-$EASYBOOST_RESTORE_OPERATION_TOKEN.fake-pg-restore-invoked"
exit 0
`);
  await prepareRemoteRestoreFixture(token);
  try {
    await runBashScript(scripts.cancel, [token], { PATH: fakePgRestore.path });
    await assert.rejects(runBashScript(scripts.launch, [], {
      EASYBOOST_RESTORE_DEADLINE_SECONDS: '30',
      EASYBOOST_RESTORE_OPERATION_TOKEN: token,
      PATH: fakePgRestore.path,
    }), (error) => {
      assert.equal(error.code, 74);
      return true;
    });
    assert.equal(await readRemoteRestoreOutcome(token), 'EXIT:74|ABSENT',
      'a cancel marker published before detached launch must close the launch window');
    assert.deepEqual(await findTokenProcesses(token), []);
    assert.equal(await runTerminalFixtureProbe(scripts.probe, token),
      'STATUS=EXIT:74\nPROCESS=NONE');
  } finally {
    await cleanupRemoteRestoreFixture(token, scripts);
    await runBashScript('rm -f "/tmp/easyboost-restore-$1.fake-pg-restore-invoked"', [token]);
    await fakePgRestore.cleanup();
  }
});

test('watchdog identity capture failure reaps the gate and the exact running pg_restore', async () => {
  const token = randomUUID();
  const scripts = await captureRemoteRestoreScripts(token);
  await prepareRemoteRestoreFixture(token);
  try {
    await assert.rejects(runBashScript(
      replacePgRestoreCommand(
        injectIdentityCaptureFailure(scripts.launch, 'watchdog'),
        'printf \'invoked\\n\' > "$base.fake-pg-restore-invoked"; while ! control_marker_matches "$cancel_marker" CANCEL; do wait_without_descendant 0.1 fake-restore; done',
      ),
      [],
      {
        EASYBOOST_RESTORE_DEADLINE_SECONDS: '30',
        EASYBOOST_RESTORE_OPERATION_TOKEN: token,
      },
    ), (error) => {
      assert.equal(error.code, 74);
      return true;
    });
    assert.equal(await readRemoteRestoreOutcome(token), 'EXIT:74|PRESENT',
      'the restore child must have crossed its gate before watchdog startup fails');
    assert.deepEqual(await findTokenProcesses(token), [],
      'watchdog startup failure must settle both exact children before returning');
    assert.equal(await runTerminalFixtureProbe(scripts.probe, token),
      'STATUS=EXIT:74\nPROCESS=NONE');
  } finally {
    await cleanupRemoteRestoreFixture(token, scripts);
    await runBashScript('rm -f "/tmp/easyboost-restore-$1.fake-pg-restore-invoked"', [token]);
  }
});

test('unexpected post-handshake shell failure settles both exact children through EXIT cleanup',
  async () => {
    const token = randomUUID();
    const scripts = await captureRemoteRestoreScripts(token);
    const goCommand = "printf 'GO\\n' >&5";
    let faultScript = replacePgRestoreCommand(
      scripts.launch,
      'printf \'invoked\\n\' > "$base.fake-pg-restore-invoked"; while ! control_marker_matches "$cancel_marker" CANCEL; do wait_without_descendant 0.1 fake-restore; done',
    );
    assert.equal(faultScript.includes(goCommand), true,
      'the test fault must occur only after both exact startup handshakes');
    faultScript = faultScript.replace(goCommand, `${goCommand}\nfalse`);
    await prepareRemoteRestoreFixture(token);
    try {
      await assert.rejects(runBashScript(faultScript, [], {
        EASYBOOST_RESTORE_DEADLINE_SECONDS: '30',
        EASYBOOST_RESTORE_OPERATION_TOKEN: token,
      }), (error) => {
        assert.equal(error.code, 74);
        return true;
      });
      assert.equal(await readRemoteRestoreOutcome(token), 'EXIT:74|PRESENT');
      assert.deepEqual(await findTokenProcesses(token), [],
        'set -e must never bypass exact TERM-to-KILL settlement and reap');
      assert.equal(await runTerminalFixtureProbe(scripts.probe, token),
        'STATUS=EXIT:74\nPROCESS=NONE');
    } finally {
      await cleanupRemoteRestoreFixture(token, scripts);
      await runBashScript('rm -f "/tmp/easyboost-restore-$1.fake-pg-restore-invoked"', [token]);
    }
  });

test('a stopped restore child returns bounded unproven evidence without numeric signalling',
  async () => {
    const token = randomUUID();
    const scripts = await captureRemoteRestoreScripts(token);
    const fakePgRestore = await createFakePgRestore(String.raw`
IFS= read -r identity_stat < "/proc/$$/stat"
identity_fields="${'$'}{identity_stat##*) }"
set -- $identity_fields
printf '%s:%s\n' "$$" "${'$'}{20}" \
  > "/tmp/easyboost-restore-$EASYBOOST_RESTORE_OPERATION_TOKEN.stopped-child"
exec >/dev/null 2>&1
kill -STOP "$$"
    `);
    await prepareRemoteRestoreFixture(token);
    const startedAt = Date.now();
    const launched = spawn(bashExecutable, ['-seu', '--'], {
      env: {
        ...process.env,
        EASYBOOST_RESTORE_DEADLINE_SECONDS: '1',
        EASYBOOST_RESTORE_OPERATION_TOKEN: token,
        PATH: fakePgRestore.path,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const launchedStderr = [];
    launched.stderr.on('data', (chunk) => { launchedStderr.push(chunk); });
    launched.stdin.end(scripts.launch);
    let launchOutcome;
    const launchClosed = new Promise((resolve, reject) => {
      launched.once('error', reject);
      launched.once('close', (code, signal) => {
        launchOutcome = { code, signal };
        resolve(launchOutcome);
      });
    });
    try {
      let unprovenPublished = false;
      const fixtureBase = path.join(os.tmpdir(), `easyboost-restore-${token}`);
      let lastControlEvidence = 'unread';
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const status = await fs.readFile(`${fixtureBase}.status`, 'utf8')
          .then((value) => value.trim()).catch(() => 'MISSING');
        const outer = await fs.readFile(`${fixtureBase}.outer-authority`, 'utf8')
          .then((value) => value.trim()).catch(() => 'ABSENT');
        const gates = await Promise.all([
          fs.access(`${fixtureBase}.restore-gate`).then(() => true).catch(() => false),
          fs.access(`${fixtureBase}.watchdog-gate`).then(() => true).catch(() => false),
        ]);
        lastControlEvidence = `${status}|${outer}|${gates.join(',')}`;
        if (status === 'RUNNING' && outer === `OUTER:${token}` && !gates.some(Boolean)) {
          unprovenPublished = true;
          break;
        }
        await new Promise((resolve) => { setTimeout(resolve, 100); });
      }
      assert.equal(unprovenPublished, true,
        `a non-progressing live child must reach bounded outer-authority handoff; evidence=${lastControlEvidence} launch=${JSON.stringify(launchOutcome)} stderr=${Buffer.concat(launchedStderr).toString('utf8')}`);
      assert.ok(Date.now() - startedAt < 20_000,
        'a non-progressing live child must not reach an unbounded wait');
      assert.equal((await readRemoteRestoreOutcome(token)).startsWith('RUNNING|'), true,
        'unproved child settlement must remain nonterminal for outer container authority');
    } finally {
      await runBashScript(String.raw`
token="$1"
for environment_file in /proc/[0-9]*/environ; do
  [ -r "$environment_file" ] || continue
  tr '\000' '\n' < "$environment_file" 2>/dev/null \
    | grep -Fqx "EASYBOOST_RESTORE_OPERATION_TOKEN=$token" || continue
  child_pid="${'$'}{environment_file#/proc/}"
  child_pid="${'$'}{child_pid%/environ}"
  IFS= read -r child_stat < "/proc/$child_pid/stat" || continue
  child_fields="${'$'}{child_stat##*) }"
  set -- $child_fields
  child_start="${'$'}{20:-}"
  IFS= read -r child_stat_after < "/proc/$child_pid/stat" || continue
  child_fields_after="${'$'}{child_stat_after##*) }"
  set -- $child_fields_after
  [ "${'$'}{20:-}" = "$child_start" ] || continue
  tr '\000' '\n' < "/proc/$child_pid/environ" 2>/dev/null \
    | grep -Fqx "EASYBOOST_RESTORE_OPERATION_TOKEN=$token" || continue
  kill -CONT "$child_pid" 2>/dev/null || true
done
rm -f "/tmp/easyboost-restore-$token.stopped-child"
`, [token]).catch(() => {});
      const closeOutcome = await Promise.race([
        launchClosed,
        new Promise((resolve) => {
          setTimeout(() => resolve({ code: null, signal: 'TIMEOUT' }), 5_000);
        }),
      ]);
      if (closeOutcome.signal === 'TIMEOUT') launched.kill();
      await cleanupRemoteRestoreFixture(token, scripts);
      await fakePgRestore.cleanup();
    }
  });

test('a reused child PID is never signalled or waited while the replacement is live',
  async () => {
    const token = randomUUID();
    const scripts = await captureRemoteRestoreScripts(token);
    const fakePgRestore = await createFakePgRestore(String.raw`
IFS= read -r identity_stat < "/proc/$$/stat"
identity_fields="${'$'}{identity_stat##*) }"
set -- $identity_fields
printf '%s:%s\n' "$$" "${'$'}{20}" \
  > "/tmp/easyboost-restore-$EASYBOOST_RESTORE_OPERATION_TOKEN.reuse-child"
exec >/dev/null 2>&1
release_marker="/tmp/easyboost-restore-$EASYBOOST_RESTORE_OPERATION_TOKEN.release-child"
while [ ! -e "$release_marker" ]; do
  wait_fifo="/tmp/easyboost-restore-$EASYBOOST_RESTORE_OPERATION_TOKEN.reuse-wait"
  rm -f "$wait_fifo"
  mkfifo "$wait_fifo"
  exec 8<> "$wait_fifo"
  rm -f "$wait_fifo"
  read -r -t 0.1 ignored <&8 || true
  exec 8>&-
done
`);
    await prepareRemoteRestoreFixture(token);
    try {
      await assert.rejects(runBashScript(
        injectReplacedChildObservation(scripts.launch),
        [],
        {
          EASYBOOST_RESTORE_DEADLINE_SECONDS: '1',
          EASYBOOST_RESTORE_OPERATION_TOKEN: token,
          PATH: fakePgRestore.path,
        },
      ), (error) => {
        assert.equal(error.code, 74);
        return true;
      });
      const { stdout: replacementEvidence } = await runBashScript(String.raw`
token="$1"
IFS=: read -r child_pid child_start < "/tmp/easyboost-restore-$token.reuse-child"
IFS= read -r child_stat < "/proc/$child_pid/stat"
child_fields="${'$'}{child_stat##*) }"
set -- $child_fields
[ "${'$'}{20}" = "$child_start" ]
[ "$1" != 'Z' ]
printf 'LIVE:%s\n' "$child_start"
`, [token]);
      assert.match(replacementEvidence, /^LIVE:\d+\r?\n$/u,
        'the replacement remains alive for outer exact-container authority');
      assert.equal(await runRemoteProbe(scripts.probe, token),
        'STATUS=RUNNING\nPROCESS=ACTIVE');
    } finally {
      await runBashScript(String.raw`
token="$1"
base="/tmp/easyboost-restore-$token"
: > "$base.release-child"
attempt=0
while [ "$attempt" -lt 50 ] && [ -e "$base.reuse-child" ]; do
  IFS=: read -r child_pid ignored < "$base.reuse-child" || break
  [ -e "/proc/$child_pid/stat" ] || break
  attempt=$((attempt + 1))
  wait_fifo="$base.release-wait"
  rm -f "$wait_fifo"
  mkfifo "$wait_fifo"
  exec 8<> "$wait_fifo"
  rm -f "$wait_fifo"
  read -r -t 0.1 ignored <&8 || true
  exec 8>&-
done
rm -f "$base.reuse-child" "$base.release-child" "$base.reuse-wait" "$base.release-wait"
`, [token]).catch(() => {});
      await cleanupRemoteRestoreFixture(token, scripts);
      await fakePgRestore.cleanup();
    }
  });

test('supervised restore settles a remote mutation after its local Docker CLI times out',
  async () => {
    const { runSupervisedPostgresRestore } = await import(
      '../scripts/postgres-restore-supervisor.js'
    );
    const launchTimeout = new Error('local docker exec timed out while remote restore remained alive');
    const calls = [];
    let remoteProcessActive = false;
    let databaseActivity = false;
    let remoteStatus = 'PENDING';
    const runDocker = async (arguments_, options = {}) => {
      const kind = commandKind(arguments_);
      calls.push({ arguments_, kind, options });
      if (kind === 'stage') return '';
      if (kind === 'launch') {
        remoteProcessActive = true;
        databaseActivity = true;
        remoteStatus = 'RUNNING';
        throw launchTimeout;
      }
      if (kind === 'cancel') {
        remoteProcessActive = false;
        databaseActivity = false;
        remoteStatus = 'EXIT:74';
        return '';
      }
      if (kind === 'probe') {
        return `STATUS=${remoteStatus}\nPROCESS=${remoteProcessActive ? 'ACTIVE' : 'NONE'}`;
      }
      if (kind === 'activity') return databaseActivity ? '1' : '0';
      if (kind === 'cleanup') return '';
      throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
    };

    await assert.rejects(runSupervisedPostgresRestore({
      ...supervisorInput,
      createOperationToken: () => operationToken,
      inputHandle: {},
      postgresContainerId,
      restoreDeadlineMs: 60_000,
      runDocker,
      wait: async () => {},
    }), (error) => error === launchTimeout);
    assert.equal(calls.some(({ kind }) => kind === 'cancel'), true,
      'an uncertain local launch outcome must cancel the remote token authority');
    assert.equal(calls.some(({ kind }) => kind === 'stop'), false,
      'proved remote settlement must not stop PostgreSQL');
    assert.equal(remoteProcessActive, false);
    assert.equal(databaseActivity, false);
    for (const { arguments_, kind, options } of calls) {
      assert.equal(arguments_.includes(postgresContainerId), true,
        'every remote command must stay bound to the immutable PostgreSQL container ID');
      if (kind === 'cancel') {
        assert.equal(options.capture, true,
          'remote cancellation output must be captured under a hard byte cap');
        assert.ok(options.maxCaptureBytes > 0 && options.maxCaptureBytes <= 4096);
      }
    }
  });

test('an uncertain detached launch cannot settle before its delayed child publishes terminal status',
  async () => {
    const { runSupervisedPostgresRestore } = await import(
      '../scripts/postgres-restore-supervisor.js'
    );
    const launchFailure = new Error('detached launch response was lost');
    const brackets = [
      ['STATUS=PENDING\nPROCESS=NONE', 'STATUS=PENDING\nPROCESS=NONE', '0'],
      ['STATUS=RUNNING\nPROCESS=ACTIVE', 'STATUS=RUNNING\nPROCESS=ACTIVE', '1'],
      ['STATUS=EXIT:74\nPROCESS=NONE', 'STATUS=EXIT:74\nPROCESS=NONE', '0'],
    ];
    let probeCalls = 0;
    let activityCalls = 0;
    let stopped = false;

    await assert.rejects(runSupervisedPostgresRestore({
      ...supervisorInput,
      createOperationToken: () => operationToken,
      inputHandle: {},
      postgresContainerId,
      runDocker: async (arguments_) => {
        const kind = commandKind(arguments_);
        if (kind === 'stage') return '';
        if (kind === 'launch') throw launchFailure;
        if (kind === 'cancel' || kind === 'cleanup') return '';
        if (kind === 'probe') {
          const bracket = brackets[Math.min(Math.floor(probeCalls / 2), brackets.length - 1)];
          const evidence = bracket[probeCalls % 2];
          probeCalls += 1;
          return evidence;
        }
        if (kind === 'activity') {
          const activity = brackets[Math.min(activityCalls, brackets.length - 1)][2];
          activityCalls += 1;
          return activity;
        }
        if (kind === 'stop') {
          stopped = true;
          return '';
        }
        throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
      },
      settlementProbeAttempts: 3,
      wait: async () => {},
    }), (error) => {
      assert.equal(error, launchFailure);
      assert.equal(error.settlementProven, true);
      assert.equal(error.recoveryEvidence.lastProbe.status, 'EXIT:74');
      return true;
    });
    assert.equal(probeCalls, 6,
      'PENDING/NONE and a later RUNNING child are not terminal detached-launch proof');
    assert.equal(stopped, false);
  });

test('remote restore cancellation is cooperative and PID reuse never reaches a signal primitive',
  async () => {
    const { runSupervisedPostgresRestore } = await import(
      '../scripts/postgres-restore-supervisor.js'
    );
    const launchError = new Error('uncertain detached restore launch');
    let watchdogScript = '';
    let cancelScript = '';
    await assert.rejects(runSupervisedPostgresRestore({
      ...supervisorInput,
      createOperationToken: () => operationToken,
      inputHandle: {},
      postgresContainerId,
      restoreDeadlineMs: 60_000,
      runDocker: async (arguments_) => {
        const kind = commandKind(arguments_);
        const script = arguments_.find((argument) => typeof argument === 'string'
          && argument.includes('# EASYBOOST_RESTORE_')) || '';
        if (kind === 'stage') return '';
        if (kind === 'launch') {
          watchdogScript = script;
          throw launchError;
        }
        if (kind === 'cancel') {
          cancelScript = script;
          return '';
        }
        if (kind === 'probe') return 'STATUS=EXIT:74\nPROCESS=NONE';
        if (kind === 'activity') return '0';
        if (kind === 'cleanup') return '';
        throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
      },
      wait: async () => {},
    }), (error) => error === launchError);

    assert.doesNotMatch(watchdogScript, /\bkill\b/u,
      'the remote supervisor must never signal a numeric PID');
    assert.doesNotMatch(cancelScript, /\bkill\b/u,
      'external cancellation must never signal a numeric PID');
    assert.match(watchdogScript,
      /restore_start_time="\$\(read_process_start_time "\$restore_pid"\)"/u);
    assert.match(watchdogScript,
      /watchdog_start_time="\$\(read_process_start_time "\$watchdog_pid"\)"/u);
    assert.match(watchdogScript,
      /request_restore_cancel\(\)[\s\S]*publish_control_marker "\$cancel_marker" CANCEL[\s\S]*terminate_restore_backends\(\)[\s\S]*PGAPPNAME="\$control_application_name" psql[\s\S]*pg_terminate_backend\(pid\)[\s\S]*application_name = :'appname'/u,
      'cancellation must use a tokenized marker and the unique restore application name');
    assert.match(watchdogScript,
      /trap settle_after_unexpected_exit EXIT[\s\S]*mkfifo "\$restore_gate"[\s\S]*printf 'GO\\n' >&4[\s\S]*mkfifo "\$watchdog_gate"[\s\S]*printf 'GO\\n' >&5/u,
      'neither child may cross its startup gate before token-and-birth capture');
    assert.match(watchdogScript,
      /case "\$child_observation" in[\s\S]*ZOMBIE\|GONE\) ;;[\s\S]*REPLACED\) return 2;;[\s\S]*wait "\$child_pid"/u,
      'a replaced or potentially-live child must fail closed before the wait-only reap');
    assert.match(watchdogScript,
      /elif \[ ! -e "\/proc\/\$\{child_pid\}\/stat" \]; then[\s\S]*wait "\$child_pid"/u,
      'an identity-less gated child may only be waited after proc proves absence');
    assert.match(cancelScript,
      /printf 'CANCEL:%s\\n' "\$token" > "\$cancel_tmp"[\s\S]*mv "\$cancel_tmp" "\$cancel_marker"[\s\S]*PGAPPNAME="\$control_application_name" psql[\s\S]*pg_terminate_backend\(pid\)/u,
      'external cancellation must atomically publish authority before backend termination');
    for (const cooperativeScript of [watchdogScript, cancelScript]) {
      assert.match(cooperativeScript,
        /PGCONNECT_TIMEOUT=2 PGOPTIONS='-c statement_timeout=2000 -c lock_timeout=2000' PGAPPNAME="\$control_application_name" psql/u,
        'cooperative backend termination must itself be bounded');
    }
    assert.doesNotMatch(watchdogScript, /\bsleep\b/u,
      'remote settlement polls must remain bounded without raw sleep descendants');
  });

test('supervised restore requires both process and pg_stat_activity settlement before success',
  async () => {
    const { runSupervisedPostgresRestore } = await import(
      '../scripts/postgres-restore-supervisor.js'
    );
    let clock = 0;
    let probeCount = 0;
    const calls = [];
    const runDocker = async (arguments_, options = {}) => {
      const kind = commandKind(arguments_);
      calls.push({ arguments_, kind, options });
      if (kind === 'stage' || kind === 'launch' || kind === 'cleanup') return '';
      if (kind === 'probe') {
        probeCount += 1;
        if (probeCount === 1) return 'STATUS=RUNNING\nPROCESS=ACTIVE';
        if (probeCount === 2) return 'STATUS=EXIT:0\nPROCESS=NONE';
        if (probeCount === 3) return 'STATUS=EXIT:0\nPROCESS=ACTIVE';
        return 'STATUS=EXIT:0\nPROCESS=NONE';
      }
      if (kind === 'activity') return probeCount === 2 ? '1' : '0';
      throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
    };
    const result = await runSupervisedPostgresRestore({
      ...supervisorInput,
      createOperationToken: () => operationToken,
      inputHandle: {},
      now: () => clock,
      postgresContainerId,
      runDocker,
      wait: async (milliseconds) => { clock += milliseconds; },
    });
    assert.deepEqual(result, {
      applicationName: `easyboost_restore_${operationToken}`,
      kind: 'restore',
      lastProbe: { activityCount: 0, process: 'NONE', settled: true, status: 'EXIT:0' },
      operationToken,
      postgresContainerId,
      settlement: 'remote-proof',
    });
    assert.ok(probeCount >= 4,
      'neither process absence nor pg_stat_activity absence alone may authorize success');
    const launch = calls.find(({ kind }) => kind === 'launch');
    assert.ok(launch.arguments_.includes('--detach'));
    assert.ok(launch.arguments_.includes(`EASYBOOST_RESTORE_OPERATION_TOKEN=${operationToken}`));
    assert.ok(launch.arguments_.includes(`PGAPPNAME=easyboost_restore_${operationToken}`));
    assert.ok(launch.arguments_.includes('EASYBOOST_RESTORE_DEADLINE_SECONDS=1800'));
    const firstBracket = calls.filter(({ kind }) => ['probe', 'activity'].includes(kind)).slice(0, 3);
    assert.deepEqual(firstBracket.map(({ kind }) => kind), ['probe', 'activity', 'probe']);
    assert.ok(firstBracket[0].arguments_.includes('easyboost-restore-probe-before'));
    assert.ok(firstBracket[0].arguments_.includes('before'));
    assert.ok(firstBracket[2].arguments_.includes('easyboost-restore-probe-after'));
    assert.ok(firstBracket[2].arguments_.includes('after'));
    for (const { options } of calls) {
      assert.ok(Number.isSafeInteger(options.commandTimeoutMs) && options.commandTimeoutMs > 0,
        'every remote control/probe must have a finite host deadline');
      if (options.capture) {
        assert.ok(Number.isSafeInteger(options.maxCaptureBytes)
          && options.maxCaptureBytes > 0 && options.maxCaptureBytes <= 4096,
        'every remote capture must have a hard byte cap');
      }
    }
    for (const { kind, options } of calls.filter(({ kind }) => (
      ['launch', 'probe', 'activity', 'cleanup'].includes(kind)
    ))) {
      assert.equal(options.capture, true,
        `${kind} remote control output must be captured rather than inherited`);
      assert.ok(options.maxCaptureBytes > 0 && options.maxCaptureBytes <= 4096,
        `${kind} remote control capture must have a hard byte cap`);
    }
  });

test('a token process appearing between bracket scans prevents torn settlement proof', async () => {
  const { runSupervisedPostgresRestore } = await import(
    '../scripts/postgres-restore-supervisor.js'
  );
  const probeEvidence = [
    'STATUS=EXIT:0\nPROCESS=NONE',
    'STATUS=EXIT:0\nPROCESS=ACTIVE',
    'STATUS=EXIT:0\nPROCESS=NONE',
    'STATUS=EXIT:0\nPROCESS=NONE',
  ];
  let probeCalls = 0;
  const result = await runSupervisedPostgresRestore({
    ...supervisorInput,
    createOperationToken: () => operationToken,
    inputHandle: {},
    postgresContainerId,
    runDocker: async (arguments_) => {
      const kind = commandKind(arguments_);
      if (kind === 'stage' || kind === 'launch' || kind === 'cleanup') return '';
      if (kind === 'probe') {
        const evidence = probeEvidence[Math.min(probeCalls, probeEvidence.length - 1)];
        probeCalls += 1;
        return evidence;
      }
      if (kind === 'activity') return '0';
      throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
    },
    wait: async () => {},
  });

  assert.equal(result.settlement, 'remote-proof');
  assert.equal(probeCalls, 4,
    'a process-free sample may settle only when it brackets the activity proof');
});

test('a status transition across bracket scans is retried before terminal settlement', async () => {
  const { runSupervisedPostgresRestore } = await import(
    '../scripts/postgres-restore-supervisor.js'
  );
  const probeEvidence = [
    'STATUS=RUNNING\nPROCESS=NONE',
    'STATUS=EXIT:0\nPROCESS=NONE',
    'STATUS=EXIT:0\nPROCESS=NONE',
    'STATUS=EXIT:0\nPROCESS=NONE',
  ];
  let probeCalls = 0;
  const result = await runSupervisedPostgresRestore({
    ...supervisorInput,
    createOperationToken: () => operationToken,
    inputHandle: {},
    postgresContainerId,
    runDocker: async (arguments_) => {
      const kind = commandKind(arguments_);
      if (kind === 'stage' || kind === 'launch' || kind === 'cleanup') return '';
      if (kind === 'probe') {
        const evidence = probeEvidence[Math.min(probeCalls, probeEvidence.length - 1)];
        probeCalls += 1;
        return evidence;
      }
      if (kind === 'activity') return '0';
      throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
    },
    wait: async () => {},
  });

  assert.equal(result.lastProbe.status, 'EXIT:0');
  assert.equal(probeCalls, 4,
    'different status samples may not be composed into one terminal proof');
});

test('supervised restore keeps a cleanup-only failure as the exact primary error', async () => {
  const { runSupervisedPostgresRestore } = await import(
    '../scripts/postgres-restore-supervisor.js'
  );
  const cleanupError = new Error('remote status cleanup failed');
  await assert.rejects(runSupervisedPostgresRestore({
    ...supervisorInput,
    createOperationToken: () => operationToken,
    inputHandle: {},
    postgresContainerId,
    runDocker: async (arguments_) => {
      const kind = commandKind(arguments_);
      if (kind === 'stage' || kind === 'launch') return '';
      if (kind === 'probe') return 'STATUS=EXIT:0\nPROCESS=NONE';
      if (kind === 'activity') return '0';
      if (kind === 'cleanup') throw cleanupError;
      throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
    },
  }), (error) => {
    assert.equal(error, cleanupError,
      'successful terminal status must not be replaced by a fabricated primary');
    assert.equal(error.settlementProven, true);
    assert.equal(error.retainOperationLock, false);
    return true;
  });
});

test('supervised restore starts the host deadline after immutable archive staging', async () => {
  const { runSupervisedPostgresRestore } = await import(
    '../scripts/postgres-restore-supervisor.js'
  );
  let clock = 0;
  let probeCount = 0;
  const result = await runSupervisedPostgresRestore({
    ...supervisorInput,
    createOperationToken: () => operationToken,
    inputHandle: {},
    now: () => clock,
    postgresContainerId,
    restoreDeadlineMs: 60_000,
    runDocker: async (arguments_) => {
      const kind = commandKind(arguments_);
      if (kind === 'stage') {
        clock += 59_000;
        return '';
      }
      if (kind === 'launch' || kind === 'cleanup') return '';
      if (kind === 'probe') {
        probeCount += 1;
        return probeCount < 3
          ? 'STATUS=RUNNING\nPROCESS=ACTIVE'
          : 'STATUS=EXIT:0\nPROCESS=NONE';
      }
      if (kind === 'activity') return probeCount < 3 ? '1' : '0';
      if (kind === 'cancel') return '';
      throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
    },
    wait: async (milliseconds) => { clock += milliseconds; },
  });
  assert.equal(result.settlement, 'remote-proof');
  assert.equal(probeCount, 4,
    'staging time must not consume the configured destructive restore deadline');
});

test('supervised restore uses an exact stopped-container proof when remote settlement fails',
  async () => {
    const { runSupervisedPostgresRestore } = await import(
      '../scripts/postgres-restore-supervisor.js'
    );
    const launchError = new Error('uncertain launch');
    const cancelError = new Error('remote cancellation failed');
    const calls = [];
    const runDocker = async (arguments_, options = {}) => {
      const kind = commandKind(arguments_);
      calls.push({ arguments_, kind, options });
      if (kind === 'stage') return '';
      if (kind === 'launch') throw launchError;
      if (kind === 'cancel') throw cancelError;
      if (kind === 'probe') return 'STATUS=RUNNING\nPROCESS=ACTIVE';
      if (kind === 'activity') return '1';
      if (kind === 'stop') return '';
      if (kind === 'inspect') return `${postgresContainerId}|false`;
      throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
    };
    await assert.rejects(runSupervisedPostgresRestore({
      ...supervisorInput,
      createOperationToken: () => operationToken,
      inputHandle: {},
      postgresContainerId,
      restoreDeadlineMs: 60_000,
      runDocker,
      settlementProbeAttempts: 2,
      wait: async () => {},
    }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], launchError);
      assert.ok(error.errors.includes(cancelError));
      assert.equal(error.cause, launchError);
      assert.equal(error.settlementProven, true);
      assert.equal(error.retainOperationLock, false);
      return true;
    });
    assert.deepEqual(calls.filter(({ kind }) => kind === 'stop')
      .map(({ arguments_ }) => arguments_), [
      ['stop', '--time', '10', postgresContainerId],
    ]);
    assert.equal(calls.some(({ kind, arguments_ }) => kind === 'inspect'
      && arguments_.at(-1) === postgresContainerId), true);
    for (const { kind, options } of calls.filter(({ kind }) => (
      ['cancel', 'stop', 'inspect'].includes(kind)
    ))) {
      assert.equal(options.capture, true,
        `${kind} recovery control output must be captured under a hard byte cap`);
      assert.ok(options.maxCaptureBytes > 0 && options.maxCaptureBytes <= 4096);
    }
  });

test('supervised restore marks unproven settlement for retained-lock recovery', async () => {
  const { runSupervisedPostgresRestore } = await import(
    '../scripts/postgres-restore-supervisor.js'
  );
  const launchError = new Error('uncertain launch');
  const cancelError = new Error('remote cancellation failed');
  const stopError = new Error('exact PostgreSQL stop failed');
  const calls = [];
  const runDocker = async (arguments_) => {
    const kind = commandKind(arguments_);
    calls.push({ arguments_, kind });
    if (kind === 'stage') return '';
    if (kind === 'launch') throw launchError;
    if (kind === 'cancel') throw cancelError;
    if (kind === 'probe') return 'STATUS=RUNNING\nPROCESS=ACTIVE';
    if (kind === 'activity') return '1';
    if (kind === 'stop') throw stopError;
    if (kind === 'inspect') return `${postgresContainerId}|true`;
    throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
  };
  await assert.rejects(runSupervisedPostgresRestore({
    ...supervisorInput,
    createOperationToken: () => operationToken,
    inputHandle: {},
    postgresContainerId,
    restoreDeadlineMs: 60_000,
    runDocker,
    settlementProbeAttempts: 1,
    wait: async () => {},
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], launchError);
    assert.ok(error.errors.includes(cancelError));
    assert.ok(error.errors.includes(stopError));
    assert.equal(error.cause, launchError);
    assert.equal(error.settlementProven, false);
    assert.equal(error.retainOperationLock, true);
    assert.deepEqual(error.recoveryEvidence, {
      applicationName: `easyboost_restore_${operationToken}`,
      kind: 'restore',
      lastProbe: { activityCount: 1, process: 'ACTIVE', settled: false, status: 'RUNNING' },
      operationToken,
      postgresContainerId,
    });
    return true;
  });
  assert.equal(calls.some(({ kind }) => kind === 'stop'), true);
  assert.equal(calls.some(({ kind }) => kind === 'inspect'), true,
    'stop failure must still be followed by exact stopped-state inspection');
});

test('supervised restore validates its bounded deadline before remote work', async () => {
  const { runSupervisedPostgresRestore } = await import(
    '../scripts/postgres-restore-supervisor.js'
  );
  for (const restoreDeadlineMs of [0, 59_999, 3_600_001, Number.MAX_SAFE_INTEGER]) {
    let dockerCalls = 0;
    await assert.rejects(runSupervisedPostgresRestore({
      ...supervisorInput,
      inputHandle: {},
      postgresContainerId,
      restoreDeadlineMs,
      runDocker: async () => { dockerCalls += 1; },
    }), /Restore deadline must be an integer between 60000 and 3600000ms/u);
    assert.equal(dockerCalls, 0);
  }
});

test('supervised restore reserves exact staged bytes plus bounded headroom before launch', async () => {
  const { runSupervisedPostgresRestore } = await import(
    '../scripts/postgres-restore-supervisor.js'
  );
  const calls = [];
  await runSupervisedPostgresRestore({
    ...supervisorInput,
    createOperationToken: () => operationToken,
    inputHandle: {},
    postgresContainerId,
    runDocker: async (arguments_, options = {}) => {
      const kind = commandKind(arguments_);
      calls.push({ arguments_, kind, options });
      if (kind === 'stage' || kind === 'launch' || kind === 'cleanup') return '';
      if (kind === 'probe') return 'STATUS=EXIT:0\nPROCESS=NONE';
      if (kind === 'activity') return '0';
      throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
    },
  });
  const stage = calls.find(({ kind }) => kind === 'stage');
  assert.ok(stage.arguments_.includes(`EASYBOOST_RESTORE_ARCHIVE_BYTES=${supervisorInput.archiveBytes}`));
  assert.ok(stage.arguments_.includes(`EASYBOOST_RESTORE_ARCHIVE_SHA256=${archiveSha256}`));
  assert.ok(stage.arguments_.includes(
    `EASYBOOST_RESTORE_CAPACITY_HEADROOM_BYTES=${supervisorInput.capacityHeadroomBytes}`,
  ));
  assert.match(stage.arguments_.join('\n'), /EASYBOOST_RESTORE_CAPACITY_RESERVATION/u);
  assert.ok(calls.findIndex(({ kind }) => kind === 'stage')
    < calls.findIndex(({ kind }) => kind === 'launch'));
});

test('supervised restore cancels and settles when app isolation changes during launch', async () => {
  const { runSupervisedPostgresRestore } = await import(
    '../scripts/postgres-restore-supervisor.js'
  );
  const raceError = new Error('application started while restore was launching');
  const phases = [];
  const calls = [];
  let cancelled = false;
  await assert.rejects(runSupervisedPostgresRestore({
    ...supervisorInput,
    assertMutationIsolation: async ({ phase }) => {
      phases.push(phase);
      if (phase === 'after-launch') throw raceError;
    },
    createOperationToken: () => operationToken,
    inputHandle: {},
    postgresContainerId,
    runDocker: async (arguments_) => {
      const kind = commandKind(arguments_);
      calls.push(kind);
      if (kind === 'stage' || kind === 'launch' || kind === 'cleanup') return '';
      if (kind === 'cancel') { cancelled = true; return ''; }
      if (kind === 'probe') {
        return cancelled ? 'STATUS=EXIT:74\nPROCESS=NONE' : 'STATUS=RUNNING\nPROCESS=ACTIVE';
      }
      if (kind === 'activity') return cancelled ? '0' : '1';
      throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
    },
    wait: async () => {},
  }), (error) => error === raceError);
  assert.deepEqual(phases, ['before-stage', 'before-launch', 'after-launch']);
  assert.ok(calls.includes('cancel'), 'the tokenized remote mutation must be cancelled');
  assert.ok(calls.indexOf('cancel') < calls.lastIndexOf('probe'),
    'settlement must be reproved after cancellation');
});

test('container capacity failure stays pre-mutation and never launches pg_restore', async () => {
  const { runSupervisedPostgresRestore } = await import(
    '../scripts/postgres-restore-supervisor.js'
  );
  const capacityError = new Error('EASYBOOST_RESTORE_CONTAINER_CAPACITY_UNAVAILABLE');
  const calls = [];
  await assert.rejects(runSupervisedPostgresRestore({
    ...supervisorInput,
    createOperationToken: () => operationToken,
    inputHandle: {},
    postgresContainerId,
    runDocker: async (arguments_) => {
      const kind = commandKind(arguments_);
      calls.push(kind);
      if (kind === 'stage') throw capacityError;
      if (kind === 'cancel' || kind === 'cleanup') return '';
      if (kind === 'probe') return 'STATUS=STAGING\nPROCESS=NONE';
      if (kind === 'activity') return '0';
      throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
    },
  }), (error) => error === capacityError);
  assert.equal(calls.includes('launch'), false);
});

test('recursive child settlement uncertainty survives supervisor error aggregation', async () => {
  const { runSupervisedPostgresRestore } = await import(
    '../scripts/postgres-restore-supervisor.js'
  );
  const childFailure = new Error('local Docker child settlement is unproven');
  childFailure.childSettlementUnproven = true;
  const launchFailure = new AggregateError([
    new Error('detached launch transport failed'),
  ], 'detached launch failed', {
    cause: new AggregateError([], 'nested child lifecycle', { cause: childFailure }),
  });

  await assert.rejects(runSupervisedPostgresRestore({
    ...supervisorInput,
    createOperationToken: () => operationToken,
    inputHandle: {},
    postgresContainerId,
    runDocker: async (arguments_) => {
      const kind = commandKind(arguments_);
      if (kind === 'stage') return '';
      if (kind === 'launch') throw launchFailure;
      if (kind === 'cancel') return '';
      if (kind === 'probe') return 'STATUS=RUNNING\nPROCESS=ACTIVE';
      if (kind === 'activity') return '1';
      if (kind === 'stop') throw new Error('container stop failed');
      if (kind === 'inspect') throw new Error('container state is unreadable');
      throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
    },
    settlementProbeAttempts: 1,
    wait: async () => {},
  }), (error) => {
    assert.equal(error.childSettlementUnproven, true,
      'a nested child-lifecycle marker must survive flattening and lifecycle aggregation');
    return true;
  });
});
