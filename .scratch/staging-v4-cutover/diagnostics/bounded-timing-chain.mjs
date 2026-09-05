// Internal finite fixture worker, never an arbitrary-command entry point.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function completeComponent(status, {
  operation, source, depth, iteration, controlMs, invocationMs, elapsedMs,
}) {
  // Parent identity refusal can return143 before the invocation callback records any timing.
  // Preserve every nonzero supervisor result before touching optional diagnostic measurements.
  if (status !== 0) return status;
  const ms = (value) => Math.min(120_000, Math.max(0, +value.toFixed(2)));
  console.log(JSON.stringify({ event: 'component', operation, source, depth, iteration,
    control_ms: ms(controlMs), invocation_ms: ms(invocationMs), elapsed_ms: ms(elapsedMs), status }));
  return status;
}

async function measure() {
  const [role, operation, countText, depthText] = process.argv.slice(2);
  assert.equal(process.platform, 'linux');
  assert.equal(process.argv.length, 6);
  assert.ok(['owner', 'nested'].includes(role));
  assert.ok(['true', 'bundle', 'compose'].includes(operation));
  assert.ok(['1', '4'].includes(countText));
  assert.ok(['0', '1', '2'].includes(depthText));
  const count = Number(countText);
  const depth = Number(depthText);
  assert.ok(operation === 'true' || (count === 1 && depth === 0));
  assert.ok(count === 1 || depth === 0);
  assert.ok(role === 'owner' || (operation === 'true' && count === 1 && depth < 2));
  const root = process.env.BOUNDED_TIMING_ROOT;
  assert.match(root, /^\/tmp\/easyboost-bounded-timing-[a-zA-Z0-9]+$/);
  const digest = process.env.BOUNDED_TIMING_BUNDLE_DIGEST;
  const nodeDigest = process.env.BOUNDED_TIMING_NODE_DIGEST;
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.match(nodeDigest, /^[a-f0-9]{64}$/);
  const generation = path.join(root, 'helpers', 'generations', digest);
  const { runSupervisedCommand, readLinuxProcessStartTime } = await import(`${generation}/staging-command-supervisor.js`);
  const { createPosixSessionControl, createPosixSessionInvocation } = await import(`${generation}/posix-session-supervisor.js`);
  if (role === 'owner') {
    assert.equal(process.env.EASYBOOST_STAGING_NODE_AUTHORITY,
      `easyboost-staging-node-authority-v1:9:${process.pid}:${nodeDigest}`);
    assert.equal(process.env.EASYBOOST_STAGING_NODE_COMMAND, undefined);
  } else {
    assert.equal(process.env.EASYBOOST_STAGING_NODE_AUTHORITY, undefined);
    assert.match(process.env.EASYBOOST_STAGING_NODE_COMMAND ?? '', /^\/proc\/[1-9][0-9]*\/fd\/9$/);
    assert.match(process.env.EASYBOOST_STAGING_NODE_CHAIN_AUTHORITY ?? '',
      /^easyboost-staging-node-chain-v1:[1-9][0-9]*:[1-9][0-9]*:[a-f0-9]{64}$/);
  }
  const commonScript = `set -Eeuo pipefail\nsource '${generation}/staging-release-common.sh'\n`
    + `app_dir='${root}/app'\nenv_file="$app_dir/.env.staging"\ncompose_file="$app_dir/compose.staging.yml"\n`
    + 'release_store="$app_dir/rollbacks/releases"\nlock_file="$app_dir/.staging-release.lock"\n'
    + 'recovery_marker="$app_dir/.staging-recovery-required"\n';
  for (let iteration = 1; iteration <= count; iteration++) {
    const command = depth > 0
      ? (process.env.EASYBOOST_STAGING_NODE_COMMAND ?? `/proc/${process.pid}/fd/9`)
      : operation === 'true' ? '/usr/bin/true' : '/bin/bash';
    const args = depth > 0 ? [fileURLToPath(import.meta.url), 'nested', operation, '1', String(depth - 1)]
      : operation === 'true' ? [] : ['--noprofile', '--norc', '-c', commonScript
        + (operation === 'bundle' ? `verify_helper_bundle '${digest}'`
          : 'validate_staging_compose_contract "$compose_file"')];
    const beforeControl = performance.now();
    const control = createPosixSessionControl({
      controlKey: `bounded-timing:${process.pid}:${iteration}:${operation}:${depth}`,
      controlRoot: path.join(root, 'chain-controls'),
    });
    const controlMs = performance.now() - beforeControl;
    let invocationMs;
    let source;
    const started = performance.now();
    const status = await runSupervisedCommand({
      command, args, timeoutMs: 60_000, parentPid: process.pid,
      parentStartTime: readLinuxProcessStartTime(process.pid), posixSessionControl: control,
      posixSessionInvocation(...actualArguments) {
        const beforeInvocation = performance.now();
        const invocation = createPosixSessionInvocation(...actualArguments);
        invocationMs = performance.now() - beforeInvocation;
        const authority = JSON.parse(Buffer.from(invocation.args[2], 'base64').toString()).nodeAuthority;
        source = authority.source;
        assert.equal(source, role === 'owner' ? 'descriptor' : 'chain');
        assert.equal(authority.digest, nodeDigest);
        return invocation;
      },
    });
    const completed = completeComponent(status, { operation, source, depth, iteration,
      controlMs, invocationMs, elapsedMs: performance.now() - started });
    if (completed !== 0) return completed;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await measure();
  } catch {
    // The parent captures all child streams and emits only fixed failure categories.
    process.exitCode = 1;
  }
}
