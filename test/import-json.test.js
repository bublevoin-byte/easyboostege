import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const importerPath = fileURLToPath(new URL('../scripts/import-json.js', import.meta.url));

function importerEnvironment(overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    APP_URL: 'http://127.0.0.1:3000',
    VK_ID_MODE: 'disabled',
    DATABASE_PROVIDER: 'file',
    DATABASE_URL: '',
    ...overrides,
  };
}

function runImporterArguments(
  arguments_,
  env = importerEnvironment(),
  workingDirectory = projectDirectory,
) {
  return spawnSync(process.execPath, [importerPath, ...arguments_], {
    cwd: workingDirectory,
    encoding: 'utf8',
    env,
  });
}

function runImporter(
  source,
  arguments_ = [],
  env = importerEnvironment(),
  workingDirectory = projectDirectory,
) {
  return runImporterArguments([source, ...arguments_], env, workingDirectory);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fakeOwnedPosixSession(child, requests, {
  onRequest = () => {},
  targetStatus = () => ({
    errorCode: null,
    exitCode: 0,
    signal: null,
    state: 'present',
  }),
} = {}) {
  let wrapperClosed = false;
  const controlKey = `database:${projectDirectory}:docker`;
  const control = {
    dispose() {
      if (!wrapperClosed) throw new Error('fake owned-session disposal before exact settlement');
    },
    markWrapperSpawned() {},
    observeWrapperClose() { wrapperClosed = true; },
    proofState() { return { state: wrapperClosed ? 'absent' : 'alive' }; },
    request(signal) {
      requests.push(signal);
      onRequest(signal);
    },
    specification: {
      controlDirectory: path.join(
        os.tmpdir(),
        'easyboost-posix-session-controls',
        sha256(controlKey),
      ),
    },
    targetStatus,
  };
  return {
    forcePosixSession: true,
    platform: 'linux',
    posixSessionControl: control,
    posixSessionInvocation(command, args, cwd, settlementMilliseconds, environment, authority) {
      return {
        args,
        command,
        cwd,
        environment,
        posixSessionControl: authority,
      };
    },
  };
}

const DEFAULT_POSTGRES_IMAGE_ID = `sha256:${'9'.repeat(64)}`;
const DEFAULT_POSTGRES_CONTAINER_ID = '0'.repeat(64);
const DEFAULT_POSTGRES_NETWORK_NAME = 'easyboost_backend';
const DEFAULT_POSTGRES_ENDPOINT = '172.30.0.2';
const DEFAULT_IMPORT_OPERATION_TOKEN = '12345678-1234-4abc-8def-1234567890ab';
const REQUIRED_IMPORT_PROTOCOL =
  'easyboost-production-json-import-v1;write=append-only;owner=exact;digest=sha256';
let productionAuthorityLockSequence = 0;
const productionAuthorityArtifacts = new Set();
const productionAuthorityRoot = fsSync.mkdtempSync(path.join(
  os.tmpdir(),
  `easyboost-import-json-authority-test-${process.pid}-`,
));

after(async () => {
  for (const artifact of productionAuthorityArtifacts) {
    await fs.rm(artifact, { recursive: true, force: true });
  }
  await fs.rm(productionAuthorityRoot, { recursive: true, force: true });
});

function temporaryOperationLock(directory) {
  return path.join(directory, '.easyboost-database-operation.lock');
}

function temporaryHostOperationLock(directory) {
  return path.join(directory, '.easyboost-host-operation.lock');
}

function withCanonicalPostgres(runDocker, {
  postgresImageId = DEFAULT_POSTGRES_IMAGE_ID,
  postgresContainerId = DEFAULT_POSTGRES_CONTAINER_ID,
  postgresEndpoint = DEFAULT_POSTGRES_ENDPOINT,
  appContainerInventory = '',
  importActivityCount = '0',
  importProtocol = REQUIRED_IMPORT_PROTOCOL,
  oneOffProject = 'easyboost-production',
  oneOffService = 'app',
  oneOff = 'True',
  calls = null,
} = {}) {
  let networkInspectionCalls = 0;
  let appInventoryCalls = 0;
  return async (arguments_, options = {}) => {
    if (arguments_[0] === 'exec'
        && arguments_.includes('--print-production-import-protocol')) {
      calls?.push({ arguments_, options });
      return typeof importProtocol === 'function'
        ? importProtocol(arguments_, options)
        : importProtocol;
    }
    if (arguments_[0] === 'compose' && arguments_.includes('ps')) {
      calls?.push({ arguments_, options });
      if (arguments_.at(-1) === 'app') {
        appInventoryCalls += 1;
        return typeof appContainerInventory === 'function'
          ? appContainerInventory(appInventoryCalls)
          : appContainerInventory;
      }
      return postgresContainerId;
    }
    if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
      calls?.push({ arguments_, options });
      if (arguments_[2].includes('NetworkSettings.Networks')) {
        networkInspectionCalls += 1;
        const endpoint = typeof postgresEndpoint === 'function'
          ? postgresEndpoint(networkInspectionCalls)
          : postgresEndpoint;
        return JSON.stringify({
          [DEFAULT_POSTGRES_NETWORK_NAME]: { IPAddress: endpoint },
        });
      }
      return [
        postgresContainerId,
        postgresImageId,
        'easyboost-production',
        'postgres',
        'False',
        'true',
      ].join('|');
    }
    if (arguments_[0] === 'inspect'
        && arguments_[2] === '{{ index .Config.Labels "com.docker.compose.project" }}') {
      calls?.push({ arguments_, options });
      return typeof oneOffProject === 'function'
        ? oneOffProject(arguments_, options)
        : oneOffProject;
    }
    if (arguments_[0] === 'inspect'
        && arguments_[2] === '{{ index .Config.Labels "com.docker.compose.service" }}') {
      calls?.push({ arguments_, options });
      return typeof oneOffService === 'function'
        ? oneOffService(arguments_, options)
        : oneOffService;
    }
    if (arguments_[0] === 'inspect'
        && arguments_[2] === '{{ index .Config.Labels "com.docker.compose.oneoff" }}') {
      calls?.push({ arguments_, options });
      return typeof oneOff === 'function' ? oneOff(arguments_, options) : oneOff;
    }
    if (arguments_[0] === 'exec' && arguments_[1] === postgresContainerId
      && arguments_[2] === 'pg_isready') {
      calls?.push({ arguments_, options });
      return '';
    }
    if (arguments_[0] === 'exec' && arguments_.includes(postgresContainerId)
        && arguments_.includes('psql')
        && arguments_.some((argument) => String(argument).includes('pg_stat_activity'))) {
      calls?.push({ arguments_, options });
      return typeof importActivityCount === 'function'
        ? importActivityCount(arguments_, options)
        : importActivityCount;
    }
    return runDocker(arguments_, options);
  };
}

function productionAuthority(appImageId, runDocker, overrides = {}, postgresOptions = {}) {
  productionAuthorityLockSequence += 1;
  const authorityId = `${process.pid}-${productionAuthorityLockSequence}`;
  const lockFile = path.join(
    productionAuthorityRoot,
    `${authorityId}.lock`,
  );
  const hostLockDirectory = path.join(
    productionAuthorityRoot,
    `${authorityId}.host.lock`,
  );
  productionAuthorityArtifacts.add(lockFile);
  productionAuthorityArtifacts.add(hostLockDirectory);
  return {
    lockFile,
    environment: {
      EASYBOOST_PRODUCTION_APP_IMAGE_ID: appImageId,
      EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: DEFAULT_POSTGRES_IMAGE_ID,
      EASYBOOST_HOST_OPERATION_LOCK_DIR: hostLockDirectory,
      ...overrides,
    },
    runDocker: withCanonicalPostgres(runDocker, postgresOptions),
  };
}

function productionImportReport(arguments_, overrides = {}) {
  return JSON.stringify({
    dryRun: arguments_.includes('--dry-run'),
    source: '/tmp/easyboost-legacy-data.json',
    users: 0,
    learnerIdentities: 0,
    progress: 0,
    skipped: [],
    ...overrides,
  });
}

function isProductionImportCommand(arguments_) {
  return arguments_[0] === 'exec' && arguments_.includes('--expected-source-sha256');
}

function productionOneOffAuthorityLabel(arguments_, ownershipToken) {
  const template = arguments_[2];
  if (template.includes('com.docker.compose.project')) return 'easyboost-production';
  if (template.includes('com.docker.compose.service')) return 'app';
  if (template.includes('com.docker.compose.oneoff')) return 'True';
  return ownershipToken;
}

function createFailingRemoteImportDocker({
  appImageId,
  calls,
  createdContainerId,
  importError,
  ownershipToken,
}) {
  let ownershipInventoryCalls = 0;
  return async (arguments_, options = {}) => {
    calls.push({ arguments_, options });
    if (arguments_[0] === 'image') return appImageId;
    if (arguments_[0] === 'ps') {
      ownershipInventoryCalls += 1;
      return ownershipInventoryCalls === 1 ? '' : createdContainerId;
    }
    if (arguments_[0] === 'compose') return createdContainerId;
    if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
      return productionOneOffAuthorityLabel(arguments_, ownershipToken);
    }
    if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
      return createdContainerId;
    }
    if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') return appImageId;
    if (arguments_[0] === 'inspect' && arguments_[2] === '{{.State.Running}}') return 'true';
    if (arguments_[0] === 'cp'
        || (arguments_[0] === 'exec' && arguments_.includes('chown'))) return '';
    if (isProductionImportCommand(arguments_)) throw importError;
    if (arguments_[0] === 'rm') return createdContainerId;
    throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
  };
}

async function createDockerSentinel(directory) {
  const marker = path.join(directory, 'docker-invoked');
  const preload = path.join(directory, 'docker-sentinel.cjs');
  await fs.writeFile(preload, [
    "const childProcess = require('node:child_process');",
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const { EventEmitter } = require('node:events');",
    "const { PassThrough } = require('node:stream');",
    'const originalSpawn = childProcess.spawn;',
    'function dockerInvocation(command, arguments_, options) {',
    "  if (command === 'docker') return { arguments_, proof: null };",
    "  const runIndex = arguments_.indexOf('--run');",
    '  if (runIndex >= 0) {',
    "    const payload = JSON.parse(Buffer.from(arguments_[runIndex + 1], 'base64').toString('utf8'));",
    "    if (payload.command !== 'docker') return null;",
    "    const proof = JSON.parse(Buffer.from(options.env.EASYBOOST_POSIX_SESSION_CONTROL, 'base64').toString('utf8'));",
    '    return { arguments: payload.arguments, proof };',
    '  }',
    "  if (!String(command).toLowerCase().endsWith('powershell.exe')) return null;",
    "  const payloadIndex = arguments_.indexOf('-Payload');",
    '  if (payloadIndex < 0) return null;',
    "  const payload = JSON.parse(Buffer.from(arguments_[payloadIndex + 1], 'base64').toString('utf8'));",
    "  if (payload.command !== 'docker') return null;",
    "  const proof = JSON.parse(Buffer.from(options.env.EASYBOOST_WINDOWS_JOB_CONTROL, 'base64').toString('utf8'));",
    '  return { arguments: payload.arguments, proof };',
    '}',
    'function publishSettlement(proof, exitCode) {',
    '  if (!proof) return;',
    '  if (proof.readyPath) {',
    '    const processGroupId = 2147483647;',
    '    fs.writeFileSync(proof.readyPath, `${JSON.stringify({',
    "      event: 'READY', processGroupId, protocol: proof.proofProtocol, sessionId: processGroupId,",
    "      startTime: '1', targetPid: null, token: proof.proofToken, wrapperPid: processGroupId,",
    "    })}\\n`);",
    '    fs.writeFileSync(proof.statusPath, `${JSON.stringify({',
    "      errorCode: null, event: 'TARGET_STATUS', exitCode, protocol: proof.proofProtocol,",
    '      signal: null, token: proof.proofToken,',
    "    })}\\n`);",
    '    fs.writeFileSync(proof.proofPath, `${JSON.stringify({',
    "      activeProcesses: 0, event: 'SESSION_DRAINED', protocol: proof.proofProtocol, token: proof.proofToken,",
    "    })}\\n`);",
    '    return;',
    '  }',
    '  fs.writeFileSync(proof.proofPath, `${JSON.stringify({',
    "    activeProcesses: 0, protocol: proof.proofProtocol, token: proof.proofToken,",
    "  })}\\n`);",
    '}',
    'childProcess.spawn = function spawn(command, arguments_, options) {',
    '  const invocation = dockerInvocation(command, arguments_, options);',
    '  if (!invocation) return originalSpawn.call(this, command, arguments_, options);',
    "  fs.writeFileSync(process.env.IMPORT_DOCKER_SENTINEL, 'invoked');",
    '  const child = new EventEmitter();',
    '  child.stdout = new PassThrough();',
    '  child.stderr = new PassThrough();',
    '  child.stdio = [null, child.stdout, child.stderr, new PassThrough()];',
    '  process.nextTick(() => {',
    '    publishSettlement(invocation.proof, 99);',
    "    child.stdio[3].emit('end');",
    "    child.emit('close', invocation.proof?.readyPath ? null : 99,",
    "      invocation.proof?.readyPath ? 'SIGKILL' : null);",
    '  });',
    '  return child;',
    '};',
    'syncBuiltinESMExports();',
    '',
  ].join('\n'), 'utf8');
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${preload}`]
    .filter(Boolean).join(' ');
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR;
  const supervisorPath = process.platform === 'win32' && windowsRoot
    ? path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0')
    : '';
  return {
    marker,
    environment: {
      IMPORT_DOCKER_SENTINEL: marker,
      NODE_OPTIONS: nodeOptions,
      PATH: supervisorPath,
      Path: supervisorPath,
    },
  };
}

async function createSuccessfulDockerStub(directory) {
  const preload = path.join(directory, 'docker-success.cjs');
  await fs.writeFile(preload, [
    "const childProcess = require('node:child_process');",
    "const fs = require('node:fs');",
    "const { EventEmitter } = require('node:events');",
    "const { PassThrough } = require('node:stream');",
    "const { syncBuiltinESMExports } = require('node:module');",
    'const originalSpawn = childProcess.spawn;',
    'let ownershipInventoryCalls = 0;',
    "let ownershipToken = '';",
    'function dockerInvocation(command, arguments_, options) {',
    "  if (command === 'docker') return { arguments_, proof: null };",
    "  const runIndex = arguments_.indexOf('--run');",
    '  if (runIndex >= 0) {',
    "    const payload = JSON.parse(Buffer.from(arguments_[runIndex + 1], 'base64').toString('utf8'));",
    "    if (payload.command !== 'docker') return null;",
    "    const proof = JSON.parse(Buffer.from(options.env.EASYBOOST_POSIX_SESSION_CONTROL, 'base64').toString('utf8'));",
    '    return { arguments: payload.arguments, proof };',
    '  }',
    "  if (!String(command).toLowerCase().endsWith('powershell.exe')) return null;",
    "  const payloadIndex = arguments_.indexOf('-Payload');",
    '  if (payloadIndex < 0) return null;',
    "  const payload = JSON.parse(Buffer.from(arguments_[payloadIndex + 1], 'base64').toString('utf8'));",
    "  if (payload.command !== 'docker') return null;",
    "  const proof = JSON.parse(Buffer.from(options.env.EASYBOOST_WINDOWS_JOB_CONTROL, 'base64').toString('utf8'));",
    '  return { arguments: payload.arguments, proof };',
    '}',
    'function publishSettlement(proof, exitCode) {',
    '  if (!proof) return;',
    '  if (proof.readyPath) {',
    '    const processGroupId = 2147483647;',
    '    fs.writeFileSync(proof.readyPath, `${JSON.stringify({',
    "      event: 'READY', processGroupId, protocol: proof.proofProtocol, sessionId: processGroupId,",
    "      startTime: '1', targetPid: null, token: proof.proofToken, wrapperPid: processGroupId,",
    "    })}\\n`);",
    '    fs.writeFileSync(proof.statusPath, `${JSON.stringify({',
    "      errorCode: null, event: 'TARGET_STATUS', exitCode, protocol: proof.proofProtocol,",
    '      signal: null, token: proof.proofToken,',
    "    })}\\n`);",
    '    fs.writeFileSync(proof.proofPath, `${JSON.stringify({',
    "      activeProcesses: 0, event: 'SESSION_DRAINED', protocol: proof.proofProtocol, token: proof.proofToken,",
    "    })}\\n`);",
    '    return;',
    '  }',
    '  fs.writeFileSync(proof.proofPath, `${JSON.stringify({',
    "    activeProcesses: 0, protocol: proof.proofProtocol, token: proof.proofToken,",
    "  })}\\n`);",
    '}',
    'childProcess.spawn = function spawn(command, arguments_, options) {',
    '  const invocation = dockerInvocation(command, arguments_, options);',
    '  if (!invocation) return originalSpawn.call(this, command, arguments_, options);',
    '  arguments_ = invocation.arguments;',
    '  const child = new EventEmitter();',
    '  child.stdout = new PassThrough();',
    '  child.stderr = new PassThrough();',
    '  child.stdio = [null, child.stdout, child.stderr, new PassThrough()];',
    '  child.kill = () => true;',
    "  let output = '';",
    "  if (arguments_[0] === 'image') output = process.env.EASYBOOST_PRODUCTION_APP_IMAGE_ID;",
    "  else if (arguments_[0] === 'compose' && arguments_.includes('ps')) {",
    "    output = arguments_.at(-1) === 'app'",
    "      ? '' : process.env.IMPORT_POSTGRES_CONTAINER_ID;",
    "  } else if (arguments_[0] === 'inspect'",
    '      && arguments_.at(-1) === process.env.IMPORT_POSTGRES_CONTAINER_ID) {',
    "    if (arguments_[2].includes('NetworkSettings.Networks')) {",
    "      output = JSON.stringify({ easyboost_backend: { IPAddress: '172.30.0.2' } });",
    '    } else {',
    '      output = `${process.env.IMPORT_POSTGRES_CONTAINER_ID}`',
    '        + `|${process.env.EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID}`',
    "        + '|easyboost-production|postgres|False|true';",
    '    }',
    "  } else if (arguments_[0] === 'exec' && arguments_[2] === 'pg_isready') {",
    "    output = '/var/run/postgresql:5432 - accepting connections';",
    "  } else if (arguments_[0] === 'ps') {",
    '    ownershipInventoryCalls += 1;',
    "    output = ownershipInventoryCalls === 1 ? '' : process.env.IMPORT_APP_CONTAINER_ID;",
    "  } else if (arguments_[0] === 'compose' && arguments_.includes('run')) {",
    "    const label = arguments_[arguments_.indexOf('--label') + 1];",
    "    ownershipToken = label.slice(label.indexOf('=') + 1);",
    '    output = process.env.IMPORT_APP_CONTAINER_ID;',
    "  } else if (arguments_[0] === 'inspect' && arguments_[2].startsWith('{{ index')) {",
    '    if (arguments_[2].includes("com.docker.compose.project")) output = "easyboost-production";',
    '    else if (arguments_[2].includes("com.docker.compose.service")) output = "app";',
    '    else if (arguments_[2].includes("com.docker.compose.oneoff")) output = "True";',
    '    else output = ownershipToken;',
    "  } else if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {",
    '    output = process.env.IMPORT_APP_CONTAINER_ID;',
    "  } else if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') {",
    '    output = process.env.EASYBOOST_PRODUCTION_APP_IMAGE_ID;',
    "  } else if (arguments_[0] === 'inspect' && arguments_[2] === '{{.State.Running}}') {",
    "    output = 'true';",
    "  } else if (arguments_[0] === 'exec'",
    "      && arguments_.includes('--print-production-import-protocol')) {",
    `    output = ${JSON.stringify(REQUIRED_IMPORT_PROTOCOL)};`,
    "  } else if (arguments_[0] === 'exec'",
    "      && arguments_.includes('--expected-source-sha256')) {",
    "    const report = JSON.stringify({",
    "      dryRun: arguments_.includes('--dry-run'),",
    "      source: '/tmp/easyboost-legacy-data.json',",
    '      users: 0, learnerIdentities: 0, progress: 0, skipped: [],',
    '    });',
    "    output = arguments_.includes('npm') && !arguments_.includes('--silent')",
    "      ? `> npm lifecycle banner\\n${report}` : report;",
    '  }',
    '  process.nextTick(() => {',
    '    publishSettlement(invocation.proof, 0);',
    '    if (output && options.stdio[1] === \'inherit\') process.stdout.write(`${output}\\n`);',
    '    else if (output) child.stdout.write(output);',
    '    child.stdout.end();',
    '    child.stderr.end();',
    "    child.stdio[3].emit('end');",
    "    child.emit('close', invocation.proof?.readyPath ? null : 0,",
    "      invocation.proof?.readyPath ? 'SIGKILL' : null);",
    '  });',
    '  return child;',
    '};',
    'syncBuiltinESMExports();',
    '',
  ].join('\n'), 'utf8');
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${preload}`]
    .filter(Boolean).join(' ');
  return {
    NODE_OPTIONS: nodeOptions,
    IMPORT_POSTGRES_CONTAINER_ID: '1'.repeat(64),
    IMPORT_APP_CONTAINER_ID: '2'.repeat(64),
    EASYBOOST_HOST_OPERATION_LOCK_DIR: temporaryHostOperationLock(directory),
  };
}

async function createDatabaseSentinel(directory) {
  const marker = path.join(directory, 'database-connect-invoked');
  const preload = path.join(directory, 'database-sentinel.cjs');
  await fs.writeFile(preload, [
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    'net.Socket.prototype.connect = function connect() {',
    "  fs.writeFileSync(process.env.IMPORT_DATABASE_SENTINEL, 'invoked');",
    "  throw new Error('Database connection sentinel reached');",
    '};',
    '',
  ].join('\n'), 'utf8');
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${preload}`]
    .filter(Boolean).join(' ');
  return {
    marker,
    environment: {
      DATABASE_URL: 'postgresql://sentinel:sentinel@127.0.0.1:1/sentinel',
      IMPORT_DATABASE_SENTINEL: marker,
      NODE_OPTIONS: nodeOptions,
    },
  };
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function importFixture(suffix = 'dry') {
  const legacyUsername = `legacy_import_${suffix}`;
  const providerUsername = `learner_import_${suffix}`;
  const forbiddenSecret = `must-never-be-imported-${suffix}`;
  return {
    forbiddenSecret,
    legacyUsername,
    providerUsername,
    snapshot: {
      users: {
        [legacyUsername]: {
          hash: 'legacy-password-hash', role: 'student', trial_used: true,
          created: Date.parse('2026-08-20T08:00:00.000Z'),
        },
        [providerUsername]: {
          identity_managed: true, display_name: 'Мария Импорт', role: 'student',
          created: Date.parse('2026-08-21T08:00:00.000Z'),
        },
      },
      learner_identities: [{
        provider: 'vk', subject: `vk-${suffix}`, username: providerUsername,
        created_at: '2026-08-21T08:00:00.000Z', updated_at: '2026-08-22T08:00:00.000Z',
        access_token: forbiddenSecret,
      }],
      progress: {
        [legacyUsername]: { learned: 3 },
        [providerUsername]: { learned: 7 },
      },
      oauth_auth_transactions: {
        ['a'.repeat(64)]: { verifier_sealed: forbiddenSecret },
      },
    },
  };
}

class RecordingImportClient {
  constructor() {
    this.queries = [];
  }

  async query(text, parameters = []) {
    this.queries.push({ text: String(text), parameters });
    return { rowCount: 1, rows: [] };
  }
}

class FailingIdentityClient extends RecordingImportClient {
  async query(text, parameters = []) {
    const result = await super.query(text, parameters);
    if (/INSERT INTO learner_identities/u.test(String(text))) {
      throw new Error('simulated identity insert failure');
    }
    return result;
  }
}

test('JSON import dry-run preserves legacy and provider-managed account coverage', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-json-dry-'));
  try {
    const source = path.join(directory, 'data.json');
    const { snapshot } = importFixture();
    await fs.writeFile(source, JSON.stringify(snapshot), 'utf8');

    const result = runImporter(source, ['--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      dryRun: true,
      source,
      users: 2,
      learnerIdentities: 1,
      progress: 2,
      skipped: [],
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('local JSON import binds parsed bytes to an expected digest before database access',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-local-digest-'));
    try {
      const source = path.join(directory, 'data.json');
      const sourceBytes = '{}';
      await fs.writeFile(source, sourceBytes, 'utf8');
      const exactDigest = sha256(sourceBytes);

      const dryRun = runImporter(
        source,
        ['--dry-run', '--expected-source-sha256', exactDigest],
      );
      assert.equal(dryRun.status, 0, dryRun.stderr);
      assert.equal(JSON.parse(dryRun.stdout).dryRun, true);

      const { environment: databaseEnvironment, marker } = await createDatabaseSentinel(directory);
      const mismatch = runImporter(
        source,
        ['--expected-source-sha256', 'f'.repeat(64)],
        importerEnvironment(databaseEnvironment),
      );
      assert.equal(mismatch.status, 1, mismatch.stderr);
      assert.match(mismatch.stderr, new RegExp(
        `source digest mismatch: expected ${'f'.repeat(64)}, received ${exactDigest}`,
        'u',
      ));
      assert.equal(await exists(marker), false, 'digest mismatch must fail before database access');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('JSON import CLI rejects an unknown option before Docker or data access', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-cli-option-'));
  try {
    const source = path.join(directory, 'must-not-be-read.json');
    const { environment: dockerEnvironment, marker } = await createDockerSentinel(directory);
    const result = runImporter(
      source,
      ['--production-compose', '--dry-rnu'],
      importerEnvironment({
        EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'a'.repeat(64)}`,
        ...dockerEnvironment,
      }),
    );

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Unknown JSON import option: --dry-rnu/u);
    assert.equal(await exists(marker), false, 'invalid CLI input must not start Docker');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('JSON import CLI rejects a duplicate option before Docker or data access', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-cli-duplicate-'));
  try {
    const source = path.join(directory, 'data.json');
    await fs.writeFile(source, '{}', 'utf8');
    const { environment: dockerEnvironment, marker } = await createDockerSentinel(directory);
    const result = runImporter(
      source,
      ['--production-compose', '--dry-run', '--dry-run'],
      importerEnvironment({
        EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'b'.repeat(64)}`,
        ...dockerEnvironment,
      }),
    );

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Duplicate JSON import option: --dry-run/u);
    assert.equal(await exists(marker), false, 'invalid CLI input must not start Docker');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('JSON import CLI rejects an extra positional source before Docker or data access', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-cli-extra-'));
  try {
    const source = path.join(directory, 'data.json');
    const extraSource = path.join(directory, 'other.json');
    await fs.writeFile(source, '{}', 'utf8');
    await fs.writeFile(extraSource, '{}', 'utf8');
    const { environment: dockerEnvironment, marker } = await createDockerSentinel(directory);
    const result = runImporter(
      source,
      [extraSource, '--production-compose', '--dry-run'],
      importerEnvironment({
        EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'c'.repeat(64)}`,
        ...dockerEnvironment,
      }),
    );

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /JSON import requires exactly one source path/u);
    assert.equal(await exists(marker), false, 'invalid CLI input must not start Docker');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('JSON import CLI rejects a missing source before Docker or data access', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-cli-missing-'));
  try {
    const { environment: dockerEnvironment, marker } = await createDockerSentinel(directory);
    const result = runImporterArguments(
      ['--production-compose', '--dry-run'],
      importerEnvironment({
        EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'d'.repeat(64)}`,
        ...dockerEnvironment,
      }),
    );

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /JSON import requires exactly one source path/u);
    assert.equal(await exists(marker), false, 'invalid CLI input must not start Docker');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('JSON import CLI rejects a blank positional source', () => {
  const result = runImporterArguments(['', '--dry-run']);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /JSON import requires exactly one source path/u);
});

test('JSON import CLI accepts the exact production dry-run and live grammars', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-cli-valid-'));
  try {
    const source = path.join(directory, 'data.json');
    await fs.writeFile(source, '{}', 'utf8');
    const { environment: dockerEnvironment, marker } = await createDockerSentinel(directory);
    const environment = importerEnvironment({
      EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'e'.repeat(64)}`,
      EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: DEFAULT_POSTGRES_IMAGE_ID,
      EASYBOOST_HOST_OPERATION_LOCK_DIR: temporaryHostOperationLock(directory),
      ...dockerEnvironment,
    });

    for (const arguments_ of [
      ['--production-compose', '--expected-source-sha256', sha256('{}')],
      ['--production-compose', '--dry-run'],
    ]) {
      await fs.rm(marker, { force: true });
      const result = runImporter(source, arguments_, environment, directory);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Docker command failed with exit code 99/u);
      assert.equal(await exists(marker), true,
        `${arguments_.join(' ')} must pass grammar validation and start Docker`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('production JSON dry-run CLI emits the exact frozen source SHA-256', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-cli-sha-'));
  try {
    const source = path.join(directory, 'data.json');
    const sourceBytes = '{"dryRun":"authority"}';
    await fs.writeFile(source, sourceBytes, 'utf8');
    const dockerEnvironment = await createSuccessfulDockerStub(directory);
    const result = runImporter(
      source,
      ['--production-compose', '--dry-run'],
      importerEnvironment({
        EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'a'.repeat(64)}`,
        EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: `sha256:${'b'.repeat(64)}`,
        ...dockerEnvironment,
      }),
      directory,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      dryRun: true,
      source,
      sourceSha256: sha256(sourceBytes),
      report: {
        dryRun: true,
        source: '/tmp/easyboost-legacy-data.json',
        users: 0,
        learnerIdentities: 0,
        progress: 0,
        skipped: [],
      },
    });
    assert.equal(result.stdout.trim().split(/\r?\n/u).filter((line) => line === '{').length, 1,
      'production dry-run must emit exactly one JSON document');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('production JSON live import requires the exact dry-run source digest before filesystem or Docker access', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-cli-digest-'));
  try {
    const source = path.join(directory, 'must-not-be-read.json');
    const { environment: dockerEnvironment, marker } = await createDockerSentinel(directory);
    const result = runImporter(
      source,
      ['--production-compose'],
      importerEnvironment({
        EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'a'.repeat(64)}`,
        EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: `sha256:${'b'.repeat(64)}`,
        ...dockerEnvironment,
      }),
    );

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /live production JSON import requires --expected-source-sha256/u);
    assert.equal(await exists(marker), false, 'missing digest authority must not start Docker');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('production digest CLI grammar rejects typo, duplicate, invalid, and extra forms before Docker',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-cli-digest-grammar-'));
    try {
      const source = path.join(directory, 'data.json');
      const extraSource = path.join(directory, 'extra.json');
      await fs.writeFile(source, '{}', 'utf8');
      const { environment: dockerEnvironment, marker } = await createDockerSentinel(directory);
      const digest = sha256('{}');
      const environment = importerEnvironment({
        EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'a'.repeat(64)}`,
        EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: `sha256:${'b'.repeat(64)}`,
        ...dockerEnvironment,
      });
      const scenarios = [
        {
          arguments_: [source, '--production-compose', '--expected-source-sha265', digest],
          message: /Unknown JSON import option: --expected-source-sha265/u,
        },
        {
          arguments_: [source, '--production-compose', '--expected-source-sha256'],
          message: /requires exactly 64 lowercase hexadecimal characters/u,
        },
        {
          arguments_: [
            source, '--production-compose', '--expected-source-sha256', digest,
            '--expected-source-sha256', digest,
          ],
          message: /Duplicate JSON import option: --expected-source-sha256/u,
        },
        {
          arguments_: [source, '--production-compose', '--expected-source-sha256', digest.toUpperCase()],
          message: /requires exactly 64 lowercase hexadecimal characters/u,
        },
        {
          arguments_: [
            source, extraSource, '--production-compose', '--expected-source-sha256', digest,
          ],
          message: /JSON import requires exactly one source path/u,
        },
        {
          arguments_: [
            source, '--production-compose', '--dry-run', '--expected-source-sha256', digest,
          ],
          message: /cannot be supplied to a production-compose dry run/u,
        },
      ];

      for (const scenario of scenarios) {
        await fs.rm(marker, { force: true });
        const result = runImporterArguments(scenario.arguments_, environment);
        assert.equal(result.status, 2, result.stderr);
        assert.match(result.stderr, scenario.message);
        assert.equal(await exists(marker), false,
          `${scenario.arguments_.join(' ')} must fail before Docker`);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('JSON import CLI validates local live arguments before database connection', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-cli-database-'));
  try {
    const source = path.join(directory, 'data.json');
    await fs.writeFile(source, '{}', 'utf8');
    const { environment: databaseEnvironment, marker } = await createDatabaseSentinel(directory);
    const environment = importerEnvironment(databaseEnvironment);

    const invalid = runImporter(source, ['--dry-rnu'], environment);
    assert.equal(invalid.status, 2, invalid.stderr);
    assert.match(invalid.stderr, /Unknown JSON import option: --dry-rnu/u);
    assert.equal(await exists(marker), false, 'invalid CLI input must not connect to PostgreSQL');

    const valid = runImporter(source, [], environment);
    assert.equal(valid.status, 1, valid.stderr);
    assert.match(valid.stderr, /Database connection sentinel reached/u);
    assert.equal(await exists(marker), true,
      'valid local live grammar must continue to the database boundary');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('production JSON import refuses any existing Compose app allocation before one-off work',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-app-present-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const appImageId = `sha256:${'a'.repeat(64)}`;
      const existingAppContainerId = 'b'.repeat(64);
      let allocationAttempted = false;
      const calls = [];
      const runDocker = withCanonicalPostgres(async (arguments_, options = {}) => {
        calls.push({ arguments_, options });
        if (arguments_[0] === 'image') return appImageId;
        if (arguments_[0] === 'ps') return '';
        if (arguments_[0] === 'compose' && arguments_.includes('run')) {
          allocationAttempted = true;
          throw new Error('one-off allocation must not be reached while app is present');
        }
        throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
      }, {
        appContainerInventory: existingAppContainerId,
        calls,
      });
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: true,
        composeFile: 'compose.production.yml',
        hostLockDirectory: temporaryHostOperationLock(directory),
        lockFile: temporaryOperationLock(directory),
        environment: {
          EASYBOOST_PRODUCTION_APP_IMAGE_ID: appImageId,
          EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: DEFAULT_POSTGRES_IMAGE_ID,
        },
        runDocker,
      }), /production application allocation must be absent before JSON import/iu);

      assert.equal(allocationAttempted, false);
      assert.equal(calls.some(({ arguments_ }) => (
        arguments_[0] === 'compose' && arguments_.at(-1) === 'app'
      )), true, 'the exact Compose app service must be inventoried under the operation guard');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import rechecks app absence at the final database boundary', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-app-race-'));
  try {
    const source = path.join(directory, 'data.json');
    await fs.writeFile(source, '{}', 'utf8');
    const appImageId = `sha256:${'c'.repeat(64)}`;
    const createdContainerId = 'd'.repeat(64);
    const lateAppContainerId = 'e'.repeat(64);
    const ownershipToken = 'f'.repeat(64);
    let ownershipInventoryCalls = 0;
    let importAttempted = false;
    let cleanupAttempted = false;
    const runDocker = withCanonicalPostgres(async (arguments_) => {
      if (arguments_[0] === 'image') return appImageId;
      if (arguments_[0] === 'ps') {
        ownershipInventoryCalls += 1;
        return ownershipInventoryCalls === 1 ? '' : createdContainerId;
      }
      if (arguments_[0] === 'compose' && arguments_.includes('run')) return createdContainerId;
      if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
      return productionOneOffAuthorityLabel(arguments_, ownershipToken);
      }
      if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
        return createdContainerId;
      }
      if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') return appImageId;
      if (arguments_[0] === 'inspect' && arguments_[2] === '{{.State.Running}}') return 'true';
      if (isProductionImportCommand(arguments_)) {
        importAttempted = true;
        return productionImportReport(arguments_);
      }
      if (arguments_[0] === 'rm') {
        cleanupAttempted = true;
        return createdContainerId;
      }
      return '';
    }, {
      appContainerInventory: (call) => (call === 1 ? '' : lateAppContainerId),
    });
    const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

    await assert.rejects(runProductionComposeJsonImport({
      source,
      dryRun: true,
      composeFile: 'compose.production.yml',
      ownershipToken,
      hostLockDirectory: temporaryHostOperationLock(directory),
      lockFile: temporaryOperationLock(directory),
      environment: {
        EASYBOOST_PRODUCTION_APP_IMAGE_ID: appImageId,
        EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: DEFAULT_POSTGRES_IMAGE_ID,
      },
      runDocker,
    }), /production application allocation appeared before JSON import/iu);

    assert.equal(importAttempted, false);
    assert.equal(cleanupAttempted, true,
      'the owned one-off container must still be removed after a late app-allocation race');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('production JSON import never deletes an unapproved one-off container',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-authority-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const approvedImageId = `sha256:${'a'.repeat(64)}`;
      const differentImageId = `sha256:${'b'.repeat(64)}`;
      const createdContainerId = 'd'.repeat(64);
      const ownershipToken = '0'.repeat(64);
      const containerName = 'easyboost-json-import-authority-test';
      const calls = [];
      let inventoryCalls = 0;
      const runDocker = async (arguments_, options = {}) => {
        calls.push({ arguments_, options });
        if (arguments_[0] === 'image') return approvedImageId;
        if (arguments_[0] === 'ps') {
          inventoryCalls += 1;
          return inventoryCalls === 1 ? '' : createdContainerId;
        }
        if (arguments_[0] === 'compose') return createdContainerId;
        if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
      return productionOneOffAuthorityLabel(arguments_, ownershipToken);
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
          return createdContainerId;
        }
        if (arguments_[0] === 'inspect') return differentImageId;
        if (arguments_[0] === 'rm') return createdContainerId;
        throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
      };
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: true,
        composeFile: 'compose.production.yml',
        containerName,
        ownershipToken,
        ...productionAuthority(approvedImageId, runDocker),
      }), /one-off import container does not use the owner-approved image/u);

      assert.deepEqual(calls.map(({ arguments_ }) => arguments_), [
        ['image', 'inspect', '--format', '{{.Id}}', approvedImageId],
        [
          'ps', '--all', '--quiet', '--no-trunc', '--filter',
          `label=easyboost.production-import-owner=${ownershipToken}`,
        ],
        [
          'compose', '--project-name', 'easyboost-production',
          '-f', 'compose.production.yml', 'run', '--rm', '--detach', '--no-deps',
          '--label', `easyboost.production-import-owner=${ownershipToken}`,
          '--name', containerName, '--entrypoint', 'sleep', 'app', '3600',
        ],
        [
          'ps', '--all', '--quiet', '--no-trunc', '--filter',
          `label=easyboost.production-import-owner=${ownershipToken}`,
        ],
        [
          'inspect', '--format',
          '{{ index .Config.Labels "easyboost.production-import-owner" }}',
          createdContainerId,
        ],
        ['inspect', '--format', '{{.Id}}', createdContainerId],
        ['inspect', '--format', '{{.Image}}', createdContainerId],
      ]);
      const composeIndex = calls.findIndex(({ arguments_ }) => arguments_[0] === 'compose');
      assert.ok(calls.slice(composeIndex + 1).every(({ arguments_ }) => (
        !arguments_.includes(containerName)
      )),
        'a foreign replacement reusing the requested name must never be inspected or deleted');
      assert.ok(calls.every(({ options }) => (
        options.environment.EASYBOOST_PRODUCTION_APP_IMAGE_ID === approvedImageId
      )), 'every Docker call must receive the exact immutable Compose binding');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import rejects a foreign one-off Compose project before deletion or copy',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-project-proof-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const appImageId = `sha256:${'a'.repeat(64)}`;
      const createdContainerId = 'b'.repeat(64);
      const ownershipToken = 'c'.repeat(64);
      const calls = [];
      let ownershipInventoryCalls = 0;
      const runDocker = async (arguments_, options = {}) => {
        calls.push({ arguments_, options });
        if (arguments_[0] === 'image') return appImageId;
        if (arguments_[0] === 'ps') {
          ownershipInventoryCalls += 1;
          return ownershipInventoryCalls === 1 ? '' : createdContainerId;
        }
        if (arguments_[0] === 'compose') return createdContainerId;
        if (arguments_[0] === 'inspect'
            && arguments_[2]?.includes('easyboost.production-import-owner')) {
          return ownershipToken;
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
          return createdContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') return appImageId;
        throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
      };
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: true,
        composeFile: 'compose.production.yml',
        ownershipToken,
        ...productionAuthority(appImageId, runDocker, {}, {
          oneOffProject: 'foreign-project',
        }),
      }), /foreign Compose project/u);

      assert.equal(calls.some(({ arguments_ }) => arguments_[0] === 'rm'), false);
      assert.equal(calls.some(({ arguments_ }) => arguments_[0] === 'cp'), false);
      assert.equal(calls.some(({ arguments_ }) => isProductionImportCommand(arguments_)), false);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import proves the approved one-off image before dry-run and live import',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-approved-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const approvedImageId = `sha256:${'c'.repeat(64)}`;
      const containerSource = '/tmp/easyboost-legacy-data.json';
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');
      let approvedDryRunDigest = null;

      for (const dryRun of [true, false]) {
        const containerName = `easyboost-json-import-${dryRun ? 'dry' : 'live'}-test`;
        const createdContainerId = (dryRun ? 'e' : 'f').repeat(64);
        const ownershipToken = (dryRun ? '1' : '2').repeat(64);
        const calls = [];
        let inventoryCalls = 0;
        const runDocker = async (arguments_, options = {}) => {
          calls.push({ arguments_, options });
          if (arguments_[0] === 'image') return approvedImageId;
          if (arguments_[0] === 'ps') {
            inventoryCalls += 1;
            return inventoryCalls === 1 ? '' : createdContainerId;
          }
          if (arguments_[0] === 'compose') return createdContainerId;
          if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
      return productionOneOffAuthorityLabel(arguments_, ownershipToken);
          }
          if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
            return createdContainerId;
          }
          if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') {
            return approvedImageId;
          }
          if (arguments_[0] === 'inspect' && arguments_[2] === '{{.State.Running}}') return 'true';
          if (isProductionImportCommand(arguments_)) {
            return productionImportReport(arguments_);
          }
          return '';
        };

        const importResult = await runProductionComposeJsonImport({
          source,
          dryRun,
          composeFile: 'compose.production.yml',
          containerName,
          ownershipToken,
          ...(dryRun ? {} : { expectedSourceSha256: approvedDryRunDigest }),
          ...productionAuthority(approvedImageId, runDocker, {
            DATABASE_URL: 'postgresql://easyboost:must-not-render@postgres:5432/easyboost',
          }),
        });
        if (dryRun) {
          approvedDryRunDigest = importResult.sourceSha256;
          assert.equal(approvedDryRunDigest, sha256('{}'));
        } else {
          assert.equal(importResult.sourceSha256, approvedDryRunDigest,
            'live import must bind to the exact digest emitted by the preceding dry run');
        }

        const expectedImport = calls.find(({ arguments_ }) => (
          isProductionImportCommand(arguments_)
        )).arguments_;
        assert.deepEqual(expectedImport.slice(0, 5), [
          'exec', '-i', createdContainerId, 'node', '-e',
        ]);
        assert.equal(expectedImport[6], DEFAULT_POSTGRES_ENDPOINT);
        assert.match(expectedImport[7], /^easyboost_import_[0-9a-f-]{36}$/u);
        assert.deepEqual(expectedImport.slice(8), [
          containerSource, '--expected-source-sha256', sha256('{}'),
          ...(dryRun ? ['--dry-run'] : []),
        ]);
        assert.match(expectedImport[5], /process\.env\.DATABASE_URL/u);
        assert.match(expectedImport[5],
          /searchParams\.set\('application_name', applicationName\)/u,
          'the inner database connection must carry the exact per-import PG activity tag');
        assert.doesNotMatch(expectedImport.join(' '), /must-not-render|postgresql:\/\//u,
          'database credentials must be rewritten only inside the app container');
        assert.equal(expectedImport.includes('--env'), false);
        if (dryRun) {
          const wrapperResult = spawnSync(process.execPath, [
            '-e', expectedImport[5], DEFAULT_POSTGRES_ENDPOINT,
            `easyboost_import_${DEFAULT_IMPORT_OPERATION_TOKEN}`,
            source, '--expected-source-sha256', sha256('{}'), '--dry-run',
          ], {
            cwd: projectDirectory,
            encoding: 'utf8',
            env: importerEnvironment({
              DATABASE_PROVIDER: 'postgres',
              DATABASE_URL: 'postgresql://easyboost:must-not-render@postgres:5432/easyboost',
            }),
          });
          assert.equal(wrapperResult.status, 0, wrapperResult.stderr);
          assert.equal(JSON.parse(wrapperResult.stdout).dryRun, true);
          assert.doesNotMatch(`${wrapperResult.stdout}\n${wrapperResult.stderr}`, /must-not-render/u);
        }
        const copiedSnapshotPath = calls.find(({ arguments_ }) => arguments_[0] === 'cp')
          .arguments_[1];
        assert.notEqual(copiedSnapshotPath, source);
        assert.deepEqual(calls.map(({ arguments_ }) => arguments_), [
          ['image', 'inspect', '--format', '{{.Id}}', approvedImageId],
          [
            'ps', '--all', '--quiet', '--no-trunc', '--filter',
            `label=easyboost.production-import-owner=${ownershipToken}`,
          ],
          [
            'compose', '--project-name', 'easyboost-production',
            '-f', 'compose.production.yml', 'run', '--rm', '--detach', '--no-deps',
            '--label', `easyboost.production-import-owner=${ownershipToken}`,
            '--name', containerName, '--entrypoint', 'sleep', 'app', '3600',
          ],
          [
            'ps', '--all', '--quiet', '--no-trunc', '--filter',
            `label=easyboost.production-import-owner=${ownershipToken}`,
          ],
          [
            'inspect', '--format',
            '{{ index .Config.Labels "easyboost.production-import-owner" }}',
            createdContainerId,
          ],
          ['inspect', '--format', '{{.Id}}', createdContainerId],
          ['inspect', '--format', '{{.Image}}', createdContainerId],
          ['inspect', '--format', '{{.State.Running}}', createdContainerId],
          ['cp', copiedSnapshotPath, `${createdContainerId}:${containerSource}`],
          ['exec', '--user', 'root', createdContainerId, 'chown', 'node:node', containerSource],
          expectedImport,
          ['rm', '--force', createdContainerId],
        ]);
        const imageProofIndex = calls.findIndex(({ arguments_ }) => (
          arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}'
        ));
        const importIndex = calls.findIndex(({ arguments_ }) => (
          arguments_.join(' ') === expectedImport.join(' ')
        ));
        assert.ok(imageProofIndex >= 0 && imageProofIndex < importIndex,
          'the exact one-off image must be proved before either import mode executes');
        const composeIndex = calls.findIndex(({ arguments_ }) => arguments_[0] === 'compose');
        const allocationArguments = calls[composeIndex].arguments_;
        const removeOnExitIndex = allocationArguments.indexOf('--rm');
        const detachIndex = allocationArguments.indexOf('--detach');
        const serviceIndex = allocationArguments.indexOf('app');
        const sleepSeconds = Number(allocationArguments[serviceIndex + 1]);
        assert.ok(removeOnExitIndex >= 0 && removeOnExitIndex < detachIndex,
          'one-off auto-removal must be enabled before detached allocation');
        assert.ok(detachIndex < serviceIndex,
          'Compose run options must precede the app service command');
        assert.equal(allocationArguments[serviceIndex - 1], 'sleep');
        assert.ok(Number.isSafeInteger(sleepSeconds) && sleepSeconds > 0,
          'the detached one-off command must have a finite positive lifetime');
        assert.ok(calls.slice(composeIndex + 1).every(({ arguments_ }) => (
          !arguments_.includes(containerName)
        )),
          'the mutable requested name must never be used after Docker returns the created ID');
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import pins every Compose call to the canonical production project',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-project-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const appImageId = `sha256:${'a'.repeat(64)}`;
      const ownershipToken = 'b'.repeat(64);
      const calls = [];
      const allocationError = new Error('stop after observing Compose authority');
      const runDocker = async (arguments_, options = {}) => {
        calls.push({ arguments_, options });
        if (arguments_[0] === 'image') return appImageId;
        if (arguments_[0] === 'ps') return '';
        if (arguments_[0] === 'compose' && arguments_.includes('run')) throw allocationError;
        throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
      };
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: true,
        composeFile: 'compose.production.yml',
        ownershipToken,
        allocationSettlementProbeAttempts: 2,
        allocationSettlementProbeIntervalMs: 1,
        wait: async () => {},
        ...productionAuthority(appImageId, runDocker, {}, { calls }),
      }), (error) => error === allocationError);

      const composeCalls = calls.filter(({ arguments_ }) => arguments_[0] === 'compose');
      assert.ok(composeCalls.length >= 3);
      for (const { arguments_ } of composeCalls) {
        assert.deepEqual(arguments_.slice(0, 5), [
          'compose', '--project-name', 'easyboost-production',
          '-f', 'compose.production.yml',
        ]);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import rejects a stale app-image importer before copying owner data',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-protocol-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const appImageId = `sha256:${'7'.repeat(64)}`;
      const createdContainerId = '8'.repeat(64);
      const ownershipToken = '9'.repeat(64);
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      for (const importProtocol of ['', 'easyboost-production-json-import-v0', 'malformed']) {
        const calls = [];
        let ownershipInventoryCalls = 0;
        const runDocker = async (arguments_, options = {}) => {
          calls.push({ arguments_, options });
          if (arguments_[0] === 'image') return appImageId;
          if (arguments_[0] === 'ps') {
            ownershipInventoryCalls += 1;
            return ownershipInventoryCalls === 1 ? '' : createdContainerId;
          }
          if (arguments_[0] === 'compose') return createdContainerId;
          if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
      return productionOneOffAuthorityLabel(arguments_, ownershipToken);
          }
          if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
            return createdContainerId;
          }
          if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') return appImageId;
          if (arguments_[0] === 'inspect' && arguments_[2] === '{{.State.Running}}') return 'true';
          if (arguments_[0] === 'rm') return createdContainerId;
          throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
        };

        await assert.rejects(runProductionComposeJsonImport({
          source,
          dryRun: true,
          ownershipToken,
          ...productionAuthority(appImageId, runDocker, {}, {
            calls,
            importProtocol,
          }),
        }), /does not attest the required append-only import protocol/u);

        const protocolCall = calls.findIndex(({ arguments_ }) => (
          arguments_.includes('--print-production-import-protocol')
        ));
        const removalCall = calls.findIndex(({ arguments_ }) => (
          arguments_[0] === 'rm' && arguments_.at(-1) === createdContainerId
        ));
        assert.ok(protocolCall >= 0 && removalCall > protocolCall,
          'stale importer rejection must clean up only the exact one-off container');
        assert.equal(calls.some(({ arguments_ }) => arguments_[0] === 'cp'), false,
          'owner source bytes must never enter an unattested app image');
        assert.equal(calls.some(({ arguments_ }) => isProductionImportCommand(arguments_)), false,
          'an unattested app image must never reach either dry-run or live database code');
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('importer exposes one exact append-only production protocol attestation', () => {
  const result = runImporterArguments(
    ['--print-production-import-protocol'],
    importerEnvironment(),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim(), REQUIRED_IMPORT_PROTOCOL);
});

test('production-compose JSON import CLI rejects invalid image authority before Docker', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-cli-authority-'));
  try {
    const source = path.join(directory, 'data.json');
    await fs.writeFile(source, '{}', 'utf8');
    const environment = importerEnvironment({ PATH: '', Path: '' });
    delete environment.EASYBOOST_PRODUCTION_APP_IMAGE_ID;
    const result = runImporter(
      source,
      ['--production-compose', '--dry-run'],
      environment,
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr,
      /EASYBOOST_PRODUCTION_APP_IMAGE_ID must be an owner-approved canonical sha256 image ID/u);
    assert.doesNotMatch(result.stderr, /ENOENT|spawn docker/u,
      'production import must reject invalid authority before it tries Docker');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('production JSON import requires canonical PostgreSQL image authority before source access',
  async () => {
    const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');
    let dockerCalled = false;

    await assert.rejects(runProductionComposeJsonImport({
      source: path.resolve('missing-production-import-source.json'),
      dryRun: true,
      environment: {
        EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'a'.repeat(64)}`,
      },
      runDocker: async () => {
        dockerCalled = true;
        throw new Error('Docker must not run without PostgreSQL authority');
      },
    }), {
      message: 'EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID must be an owner-approved canonical sha256 image ID',
      exitCode: 2,
    });
    assert.equal(dockerCalled, false);
  });

test('production JSON import validates bounded allocation observation before acquiring guards',
  async () => {
    const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');
    let hostAcquireCalls = 0;
    let dockerCalls = 0;
    const base = {
      source: path.join(os.tmpdir(), 'easyboost-import-not-read.json'),
      dryRun: true,
      operationToken: DEFAULT_IMPORT_OPERATION_TOKEN,
      ownershipToken: 'a'.repeat(64),
      environment: {
        EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'b'.repeat(64)}`,
        EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: DEFAULT_POSTGRES_IMAGE_ID,
      },
      acquireHostOperation: async () => {
        hostAcquireCalls += 1;
      },
      runDocker: async () => {
        dockerCalls += 1;
      },
    };

    for (const allocationSettlementProbeAttempts of [1, 61, 2.5]) {
      await assert.rejects(runProductionComposeJsonImport({
        ...base,
        allocationSettlementProbeAttempts,
      }), /Allocation settlement probe attempts must be between 2 and 60/u);
    }
    for (const allocationSettlementProbeIntervalMs of [0, 60_001, 1.5]) {
      await assert.rejects(runProductionComposeJsonImport({
        ...base,
        allocationSettlementProbeIntervalMs,
      }), /Allocation settlement probe interval must be between 1 and 60000ms/u);
    }
    assert.equal(hostAcquireCalls, 0);
    assert.equal(dockerCalls, 0);
  });

test('production JSON import proves the canonical PostgreSQL container before app allocation',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-pg-proof-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const appImageId = `sha256:${'a'.repeat(64)}`;
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const foreignImageId = `sha256:${'c'.repeat(64)}`;
      const postgresContainerId = 'd'.repeat(64);
      const calls = [];
      const runDocker = async (arguments_) => {
        calls.push(arguments_);
        if (arguments_[0] === 'image') return appImageId;
        if (arguments_[0] === 'compose' && arguments_.includes('ps')) {
          if (arguments_.at(-1) === 'app') return '';
          return postgresContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
          return `${postgresContainerId}|${foreignImageId}|easyboost-production|postgres|False|true`;
        }
        throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
      };
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: true,
        composeFile: 'compose.production.yml',
        hostLockDirectory: temporaryHostOperationLock(directory),
        lockFile: temporaryOperationLock(directory),
        environment: {
          EASYBOOST_PRODUCTION_APP_IMAGE_ID: appImageId,
          EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: postgresImageId,
        },
        runDocker,
      }), /canonical PostgreSQL container identity does not match owner authority/u);

      assert.equal(calls.some((arguments_) => (
        arguments_[0] === 'compose' && arguments_.includes('run')
      )), false, 'PostgreSQL proof must finish before app one-off allocation');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import rejects non-unique or unsafe PostgreSQL endpoints before allocation',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-pg-endpoint-proof-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const appImageId = `sha256:${'a'.repeat(64)}`;
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const postgresContainerId = 'c'.repeat(64);
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');
      for (const [networks, expectedError] of [
        [
          {
            easyboost_backend: { IPAddress: '172.30.0.2' },
            foreign_network: { IPAddress: '172.31.0.2' },
          },
          /exactly one inspected network endpoint/u,
        ],
        [
          { easyboost_backend: { IPAddress: '127.0.0.1' } },
          /not a usable unicast address/u,
        ],
      ]) {
        let appAllocated = false;
        const runDocker = async (arguments_) => {
          if (arguments_[0] === 'image') return appImageId;
          if (arguments_[0] === 'compose' && arguments_.includes('ps')) {
            if (arguments_.at(-1) === 'app') return '';
            return postgresContainerId;
          }
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
            if (arguments_[2].includes('NetworkSettings.Networks')) {
              return JSON.stringify(networks);
            }
            return `${postgresContainerId}|${postgresImageId}|easyboost-production|postgres|False|true`;
          }
          if (arguments_[0] === 'compose' && arguments_.includes('run')) appAllocated = true;
          throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
        };

        await assert.rejects(runProductionComposeJsonImport({
          source,
          dryRun: true,
          hostLockDirectory: temporaryHostOperationLock(directory),
          lockFile: temporaryOperationLock(directory),
          environment: {
            EASYBOOST_PRODUCTION_APP_IMAGE_ID: appImageId,
            EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: postgresImageId,
          },
          runDocker,
        }), expectedError);
        assert.equal(appAllocated, false);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import bounds PostgreSQL readiness before app allocation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-pg-ready-'));
  try {
    const source = path.join(directory, 'data.json');
    await fs.writeFile(source, '{}', 'utf8');
    const appImageId = `sha256:${'a'.repeat(64)}`;
    const postgresImageId = `sha256:${'b'.repeat(64)}`;
    const postgresContainerId = 'c'.repeat(64);
    const readinessError = new Error('postgres is starting');
    const calls = [];
    const waits = [];
    const readinessOptions = [];
    const runDocker = async (arguments_, options = {}) => {
      calls.push(arguments_);
      if (arguments_[0] === 'image') return appImageId;
      if (arguments_[0] === 'compose' && arguments_.includes('ps')) {
        if (arguments_.at(-1) === 'app') return '';
        return postgresContainerId;
      }
      if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
        if (arguments_[2].includes('NetworkSettings.Networks')) {
          return JSON.stringify({ easyboost_backend: { IPAddress: '172.30.0.2' } });
        }
        return `${postgresContainerId}|${postgresImageId}|easyboost-production|postgres|False|true`;
      }
      if (arguments_[0] === 'exec' && arguments_[1] === postgresContainerId) {
        readinessOptions.push(options);
        throw readinessError;
      }
      throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
    };
    const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

    await assert.rejects(runProductionComposeJsonImport({
      source,
      dryRun: true,
      composeFile: 'compose.production.yml',
      hostLockDirectory: temporaryHostOperationLock(directory),
      lockFile: temporaryOperationLock(directory),
      postgresReadinessAttempts: 3,
      postgresReadinessIntervalMs: 7,
      wait: async (milliseconds) => { waits.push(milliseconds); },
      environment: {
        EASYBOOST_PRODUCTION_APP_IMAGE_ID: appImageId,
        EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: postgresImageId,
      },
      runDocker,
    }), (error) => {
      assert.match(error.message, /PostgreSQL readiness check failed after 3 attempts/u);
      assert.equal(error.cause, readinessError);
      return true;
    });

    const readinessCalls = calls.filter((arguments_) => (
      arguments_[0] === 'exec' && arguments_[1] === postgresContainerId
    ));
    assert.equal(readinessCalls.length, 3);
    assert.ok(readinessCalls.every((arguments_) => (
      arguments_.join(' ') === `exec ${postgresContainerId} pg_isready -t 2 -U easyboost -d easyboost`
    )));
    assert.deepEqual(waits, [7, 7]);
    assert.ok(readinessOptions.every(({ capture }) => capture === true),
      'pg_isready stdout must be bounded and must never inherit the outer CLI stdout');
    assert.equal(calls.some((arguments_) => (
      arguments_[0] === 'compose' && arguments_.includes('run')
    )), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('production JSON import fails closed when the Compose PostgreSQL allocation swaps before import',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-pg-swap-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const appImageId = `sha256:${'a'.repeat(64)}`;
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const postgresContainerId = 'c'.repeat(64);
      const swappedPostgresContainerId = 'd'.repeat(64);
      const createdContainerId = 'e'.repeat(64);
      const ownershipToken = 'f'.repeat(64);
      let postgresAllocationCalls = 0;
      let ownershipInventoryCalls = 0;
      let importBegan = false;
      const runDocker = async (arguments_) => {
        if (arguments_[0] === 'image') return appImageId;
        if (arguments_[0] === 'compose' && arguments_.includes('ps')) {
          if (arguments_.at(-1) === 'app') return '';
          postgresAllocationCalls += 1;
          return postgresAllocationCalls === 1
            ? postgresContainerId
            : swappedPostgresContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
          if (arguments_[2].includes('NetworkSettings.Networks')) {
            return JSON.stringify({
              easyboost_backend: { IPAddress: '172.30.0.2' },
            });
          }
          return arguments_[2].includes('.State.Running')
            ? `${postgresContainerId}|${postgresImageId}|easyboost-production|postgres|False|true`
            : `${postgresContainerId}|${postgresImageId}|easyboost-production|postgres|False`;
        }
        if (arguments_[0] === 'exec' && arguments_[1] === postgresContainerId) return '';
        if (arguments_[0] === 'ps') {
          ownershipInventoryCalls += 1;
          return ownershipInventoryCalls === 1 ? '' : createdContainerId;
        }
        if (arguments_[0] === 'compose') return createdContainerId;
        if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
      return productionOneOffAuthorityLabel(arguments_, ownershipToken);
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
          return createdContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') return appImageId;
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.State.Running}}') return 'true';
        if (arguments_[0] === 'exec'
            && arguments_.includes('--print-production-import-protocol')) {
          return REQUIRED_IMPORT_PROTOCOL;
        }
        if (isProductionImportCommand(arguments_)) {
          importBegan = true;
          return productionImportReport(arguments_);
        }
        return '';
      };
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: true,
        hostLockDirectory: temporaryHostOperationLock(directory),
        lockFile: temporaryOperationLock(directory),
        ownershipToken,
        environment: {
          EASYBOOST_PRODUCTION_APP_IMAGE_ID: appImageId,
          EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: postgresImageId,
        },
        runDocker,
      }), /PostgreSQL allocation changed before import/u);
      assert.equal(importBegan, false);
      assert.equal(postgresAllocationCalls, 2,
        'immutable PostgreSQL allocation must be re-proved at the final import boundary');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import fails closed when the proven PostgreSQL endpoint changes before import',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-pg-endpoint-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const appImageId = `sha256:${'a'.repeat(64)}`;
      const createdContainerId = '7'.repeat(64);
      const ownershipToken = '8'.repeat(64);
      let inventoryCalls = 0;
      let importBegan = false;
      const runDocker = async (arguments_) => {
        if (arguments_[0] === 'image') return appImageId;
        if (arguments_[0] === 'ps') {
          inventoryCalls += 1;
          return inventoryCalls === 1 ? '' : createdContainerId;
        }
        if (arguments_[0] === 'compose') return createdContainerId;
        if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
      return productionOneOffAuthorityLabel(arguments_, ownershipToken);
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
          return createdContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') return appImageId;
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.State.Running}}') return 'true';
        if (isProductionImportCommand(arguments_)) {
          importBegan = true;
          return productionImportReport(arguments_);
        }
        return '';
      };
      const postgresCalls = [];
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: true,
        hostLockDirectory: temporaryHostOperationLock(directory),
        lockFile: temporaryOperationLock(directory),
        ownershipToken,
        environment: {
          EASYBOOST_PRODUCTION_APP_IMAGE_ID: appImageId,
          EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: DEFAULT_POSTGRES_IMAGE_ID,
        },
        runDocker: withCanonicalPostgres(runDocker, {
          calls: postgresCalls,
          postgresEndpoint: (inspection) => (
            inspection === 1 ? '172.30.0.2' : '172.30.0.3'
          ),
        }),
      }), /PostgreSQL network endpoint changed before import/u);
      assert.equal(importBegan, false);
      assert.equal(postgresCalls.filter(({ arguments_ }) => (
        arguments_[0] === 'inspect' && arguments_[2].includes('NetworkSettings.Networks')
      )).length, 2);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import holds the host guard outside the database-operation lock', async () => {
  const events = [];
  const hostRelease = async () => { events.push('host-release'); };
  const databaseRelease = async () => { events.push('database-release'); };
  const source = path.resolve('missing-host-guard-order-import.json');
  const appImageId = `sha256:${'1'.repeat(64)}`;
  let dockerCalls = 0;
  const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

  await assert.rejects(runProductionComposeJsonImport({
    source,
    dryRun: true,
    environment: {
      EASYBOOST_PRODUCTION_APP_IMAGE_ID: appImageId,
      EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: DEFAULT_POSTGRES_IMAGE_ID,
    },
    acquireHostOperation: async ({ operation }) => {
      events.push(`host-acquire:${operation}`);
      return hostRelease;
    },
    releaseHostOperation: async (release, timeoutMs) => {
      assert.equal(timeoutMs, 2_000);
      await release();
    },
    acquireOperationLock: async () => {
      events.push('database-acquire');
      return databaseRelease;
    },
    runDocker: async () => {
      dockerCalls += 1;
      throw new Error('missing source must fail before Docker');
    },
  }), { code: 'ENOENT' });

  assert.deepEqual(events, [
    'host-acquire:database-import',
    'database-acquire',
    'database-release',
    'host-release',
  ]);
  assert.equal(dockerCalls, 0);
});

test('production JSON import retains host evidence when database guard finalization is unproven',
  async () => {
    const sourceFailure = { code: 'ENOENT' };
    const databaseFinalizationFailure = new Error('synthetic database finalization failure');
    const events = [];
    const hostRelease = async () => { events.push('host-release-handle'); };
    hostRelease.retain = async () => {};
    const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

    await assert.rejects(runProductionComposeJsonImport({
      source: path.resolve('missing-db-finalization-import.json'),
      dryRun: true,
      operationToken: DEFAULT_IMPORT_OPERATION_TOKEN,
      ownershipToken: '8'.repeat(64),
      environment: {
        EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'1'.repeat(64)}`,
        EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: DEFAULT_POSTGRES_IMAGE_ID,
      },
      acquireHostOperation: async () => hostRelease,
      releaseHostOperation: async () => { events.push('host-release'); },
      acquireOperationLock: async () => async () => {
        events.push('database-finalize');
        throw databaseFinalizationFailure;
      },
      retainOperationLock: async (_release, timeoutMs, reason, evidence) => {
        events.push('database-retain');
        assert.equal(timeoutMs, 2_000);
        assert.equal(reason, 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN');
        assert.equal(evidence.operationToken, DEFAULT_IMPORT_OPERATION_TOKEN);
      },
      retainHostOperation: async (_release, timeoutMs, evidence) => {
        events.push('host-retain');
        assert.equal(timeoutMs, 2_000);
        assert.equal(evidence.kind, 'import');
        assert.equal(evidence.operationToken, DEFAULT_IMPORT_OPERATION_TOKEN);
        assert.equal(evidence.retentionReason, 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN');
        return async () => { events.push('host-complete'); };
      },
    }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0]?.code, sourceFailure.code);
      assert.equal(error.errors[1], databaseFinalizationFailure);
      assert.equal(error.errors.length, 2);
      return true;
    });

    assert.deepEqual(events, ['host-retain', 'database-finalize', 'database-retain']);
  });

test('production JSON import fails at host-guard contention before source, DB lock, or Docker',
  async () => {
    const hostError = new Error('HOST_OPERATION_LOCKED: /tmp/easyboost-host.lock');
    let databaseLockCalls = 0;
    let dockerCalls = 0;
    const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

    await assert.rejects(runProductionComposeJsonImport({
      source: path.resolve('missing-host-contended-import.json'),
      dryRun: true,
      environment: {
        EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'2'.repeat(64)}`,
        EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: DEFAULT_POSTGRES_IMAGE_ID,
      },
      acquireHostOperation: async () => { throw hostError; },
      acquireOperationLock: async () => {
        databaseLockCalls += 1;
        throw new Error('database lock must not be reached');
      },
      runDocker: async () => {
        dockerCalls += 1;
        throw new Error('Docker must not be reached');
      },
    }), (error) => error === hostError);

    assert.equal(databaseLockCalls, 0);
    assert.equal(dockerCalls, 0);
  });

test('production import lock excludes restore, verification, and a second import before Docker',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-shared-lock-'));
    let releaseImport;
    let ownerImport;
    try {
      const source = path.join(directory, 'data.json');
      const backup = path.join(directory, 'source.dump');
      const lockFile = path.join(directory, '.easyboost-database-operation.lock');
      await fs.writeFile(source, '{}', 'utf8');
      await fs.writeFile(backup, 'test backup bytes', 'utf8');
      const appImageId = `sha256:${'a'.repeat(64)}`;
      const createdContainerId = 'b'.repeat(64);
      const ownershipToken = 'c'.repeat(64);
      let inventoryCalls = 0;
      let ownerEnteredResolve;
      const ownerEntered = new Promise((resolve) => { ownerEnteredResolve = resolve; });
      const ownerGate = new Promise((resolve) => { releaseImport = resolve; });
      let ownerReachedDocker = false;
      const ownerDocker = async (arguments_) => {
        if (arguments_[0] === 'image') {
          if (!ownerReachedDocker) {
            ownerReachedDocker = true;
            ownerEnteredResolve();
            await ownerGate;
          }
          return appImageId;
        }
        if (arguments_[0] === 'ps') {
          inventoryCalls += 1;
          return inventoryCalls === 1 ? '' : createdContainerId;
        }
        if (arguments_[0] === 'compose') return createdContainerId;
        if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
      return productionOneOffAuthorityLabel(arguments_, ownershipToken);
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
          return createdContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') return appImageId;
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.State.Running}}') return 'true';
        if (isProductionImportCommand(arguments_)) return productionImportReport(arguments_);
        return '';
      };
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');
      ownerImport = runProductionComposeJsonImport({
        source,
        dryRun: true,
        ownershipToken,
        ...productionAuthority(appImageId, ownerDocker),
        lockFile,
      });
      await ownerEntered;

      let contenderDockerCalls = 0;
      const contenderDocker = async () => {
        contenderDockerCalls += 1;
        throw new Error('contending database operation reached Docker');
      };
      const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
      await assert.rejects(restorePostgresBackup({
        backup,
        lockFile,
        postgresExpectedImageId: DEFAULT_POSTGRES_IMAGE_ID,
        productionAppImageId: appImageId,
        runDocker: contenderDocker,
        log() {},
      }), /DATABASE_OPERATION_LOCKED/u);
      const { verifyPostgresBackup } = await import('../scripts/postgres-verify-backup.js');
      await assert.rejects(verifyPostgresBackup({
        backup,
        backupDirectory: directory,
        lockFile,
        postgresExpectedImageId: DEFAULT_POSTGRES_IMAGE_ID,
        productionAppImageId: appImageId,
        publishStatus: async () => {},
        runDocker: contenderDocker,
      }), /DATABASE_OPERATION_LOCKED/u);
      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: true,
        ...productionAuthority(appImageId, contenderDocker),
        lockFile,
      }), /DATABASE_OPERATION_LOCKED/u);
      assert.equal(contenderDockerCalls, 0,
        'every contender must fail at the shared lock before Docker or PostgreSQL work');

      releaseImport();
      await ownerImport;
      await assert.rejects(fs.access(lockFile), { code: 'ENOENT' },
        'successful import must release the shared database-operation lock');
    } finally {
      releaseImport?.();
      await ownerImport?.catch(() => {});
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('restore-held shared lock excludes dry-run and live imports before source or Docker access',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-restore-import-lock-'));
    let releaseRestore;
    let restoreOwner;
    try {
      const backup = path.join(directory, 'source.dump');
      const lockFile = path.join(directory, '.easyboost-database-operation.lock');
      const hostLockDirectory = temporaryHostOperationLock(directory);
      await fs.writeFile(backup, 'test backup bytes', 'utf8');
      const appImageId = `sha256:${'d'.repeat(64)}`;
      const postgresImageId = `sha256:${'e'.repeat(64)}`;
      const postgresContainerId = 'f'.repeat(64);
      const appContainerId = '1'.repeat(64);
      let appRunning = true;
      let restoreEnteredResolve;
      const restoreEntered = new Promise((resolve) => { restoreEnteredResolve = resolve; });
      const restoreGate = new Promise((resolve) => { releaseRestore = resolve; });
      let supervisedRestoreCalls = 0;
      const restoreDocker = async (arguments_) => {
        if (arguments_[0] === 'image') return appImageId;
        if (arguments_[0] === 'compose' && arguments_.at(-1) === 'postgres') {
          return postgresContainerId;
        }
        if (arguments_[0] === 'compose' && arguments_.at(-1) === 'app') {
          return appContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
          return [
            postgresContainerId, 'easyboost-production',
            'postgres', 'False', postgresImageId, 'true',
          ].join('|');
        }
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
          return [
            appContainerId, 'easyboost-production',
            'app', 'False', appImageId, String(appRunning),
          ].join('|');
        }
        if (arguments_[0] === 'stop') appRunning = false;
        if (arguments_[0] === 'start') appRunning = true;
        return '';
      };
      const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
      restoreOwner = restorePostgresBackup({
        backup,
        checkReadiness: async () => ({ ok: true }),
        hostLockDirectory,
        lockFile,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: appImageId,
        runDocker: restoreDocker,
        runSupervisedRestore: async ({
          postgresContainerId: supervisedPostgresContainerId,
          restoreDeadlineMs,
          runDocker,
        }) => {
          supervisedRestoreCalls += 1;
          assert.equal(supervisedPostgresContainerId, postgresContainerId);
          assert.equal(restoreDeadlineMs, 1_800_000);
          assert.equal(typeof runDocker, 'function');
          restoreEnteredResolve();
          await restoreGate;
        },
        log() {},
      });
      await restoreEntered;

      let importDockerCalls = 0;
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');
      for (const dryRun of [true, false]) {
        const missingSource = path.join(directory, `missing-${dryRun ? 'dry' : 'live'}.json`);
        await assert.rejects(runProductionComposeJsonImport({
          source: missingSource,
          dryRun,
          expectedSourceSha256: dryRun ? null : '2'.repeat(64),
          hostLockDirectory,
          lockFile,
          environment: {
            EASYBOOST_PRODUCTION_APP_IMAGE_ID: appImageId,
            EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: postgresImageId,
          },
          runDocker: async () => {
            importDockerCalls += 1;
            throw new Error('contending import reached Docker');
          },
        }), /HOST_OPERATION_LOCKED/u);
      }
      assert.equal(importDockerCalls, 0,
        'both import modes must reject before source access, Docker, or database work');

      releaseRestore();
      await restoreOwner;
      assert.equal(supervisedRestoreCalls, 1,
        'the lock owner must pass through the supervised restore boundary exactly once');
      await assert.rejects(fs.access(lockFile), { code: 'ENOENT' });
    } finally {
      releaseRestore?.();
      await restoreOwner?.catch(() => {});
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import freezes one exact source digest before Docker and copies only snapshot',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-snapshot-'));
    try {
      const source = path.join(directory, 'data.json');
      const editedSource = path.join(directory, 'edited-original.json');
      const approvedSource = '{"version":"approved"}';
      const editedSourceBytes = '{"version":"edited-after-freeze"}';
      const replacedSource = '{"version":"replaced-after-freeze"}';
      await fs.writeFile(source, approvedSource, 'utf8');
      const appImageId = `sha256:${'a'.repeat(64)}`;
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const postgresContainerId = 'c'.repeat(64);
      const createdContainerId = 'd'.repeat(64);
      const ownershipToken = 'e'.repeat(64);
      let ownershipInventoryCalls = 0;
      let sourceReplaced = false;
      let copiedSourcePath = null;
      let copiedSourceBytes = null;
      const runDocker = async (arguments_) => {
        if (!sourceReplaced) {
          sourceReplaced = true;
          await fs.writeFile(source, editedSourceBytes, 'utf8');
          await fs.rename(source, editedSource);
          await fs.writeFile(source, replacedSource, 'utf8');
        }
        if (arguments_[0] === 'image') return appImageId;
        if (arguments_[0] === 'compose' && arguments_.includes('ps')) {
          if (arguments_.at(-1) === 'app') return '';
          return postgresContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
          if (arguments_[2].includes('NetworkSettings.Networks')) {
            return JSON.stringify({ easyboost_backend: { IPAddress: '172.30.0.2' } });
          }
          return `${postgresContainerId}|${postgresImageId}|easyboost-production|postgres|False|true`;
        }
        if (arguments_[0] === 'exec' && arguments_[1] === postgresContainerId) return '';
        if (arguments_[0] === 'ps') {
          ownershipInventoryCalls += 1;
          return ownershipInventoryCalls === 1 ? '' : createdContainerId;
        }
        if (arguments_[0] === 'compose' && arguments_.includes('run')) return createdContainerId;
        if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
      return productionOneOffAuthorityLabel(arguments_, ownershipToken);
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
          return createdContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') return appImageId;
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.State.Running}}') return 'true';
        if (arguments_[0] === 'exec'
            && arguments_.includes('--print-production-import-protocol')) {
          return REQUIRED_IMPORT_PROTOCOL;
        }
        if (arguments_[0] === 'cp') {
          copiedSourcePath = arguments_[1];
          copiedSourceBytes = await fs.readFile(copiedSourcePath, 'utf8');
          return '';
        }
        if (isProductionImportCommand(arguments_)) {
          return productionImportReport(arguments_);
        }
        if (arguments_[0] === 'exec' || arguments_[0] === 'rm') return '';
        throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
      };
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      const result = await runProductionComposeJsonImport({
        source,
        dryRun: true,
        composeFile: 'compose.production.yml',
        hostLockDirectory: temporaryHostOperationLock(directory),
        lockFile: temporaryOperationLock(directory),
        ownershipToken,
        environment: {
          EASYBOOST_PRODUCTION_APP_IMAGE_ID: appImageId,
          EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: postgresImageId,
        },
        runDocker,
      });

      assert.equal(result.sourceSha256, sha256(approvedSource));
      assert.equal(copiedSourceBytes, approvedSource);
      assert.notEqual(copiedSourcePath, source, 'Docker must never copy the mutable original path');
      assert.equal(await fs.readFile(source, 'utf8'), replacedSource);
      assert.equal(await fs.readFile(editedSource, 'utf8'), editedSourceBytes);
      assert.equal(await exists(copiedSourcePath), false, 'private snapshot must be cleaned after import');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import rejects linked or oversized sources before Docker', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-source-bounds-'));
  try {
    const source = path.join(directory, 'data.json');
    const sourceLink = path.join(directory, 'data-hardlink.json');
    await fs.writeFile(source, '{}', 'utf8');
    await fs.link(source, sourceLink);
    let dockerCalled = false;
    const authority = {
      hostLockDirectory: temporaryHostOperationLock(directory),
      lockFile: temporaryOperationLock(directory),
      environment: {
        EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'a'.repeat(64)}`,
        EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: `sha256:${'b'.repeat(64)}`,
      },
      runDocker: async () => {
        dockerCalled = true;
        throw new Error('Docker must not run for an unsafe source');
      },
    };
    const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

    await assert.rejects(runProductionComposeJsonImport({
      source,
      dryRun: true,
      ...authority,
    }), /source must have exactly one filesystem link/u);
    assert.equal(dockerCalled, false);

    await fs.unlink(sourceLink);
    await assert.rejects(runProductionComposeJsonImport({
      source,
      dryRun: true,
      maximumSourceBytes: 1,
      ...authority,
    }), /source exceeds 1 bytes/u);
    assert.equal(dockerCalled, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('production JSON import rejects container bytes that differ from the frozen host digest',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-container-digest-'));
    try {
      const source = path.join(directory, 'approved.json');
      const containerCopy = path.join(directory, 'container-copy.json');
      await fs.writeFile(source, '{"approved":true}', 'utf8');
      const appImageId = `sha256:${'a'.repeat(64)}`;
      const createdContainerId = '5'.repeat(64);
      const ownershipToken = '6'.repeat(64);
      let inventoryCalls = 0;
      let unverifiedInnerImportSucceeded = false;
      const runDocker = async (arguments_) => {
        if (arguments_[0] === 'image') return appImageId;
        if (arguments_[0] === 'ps') {
          inventoryCalls += 1;
          return inventoryCalls === 1 ? '' : createdContainerId;
        }
        if (arguments_[0] === 'compose') return createdContainerId;
        if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
      return productionOneOffAuthorityLabel(arguments_, ownershipToken);
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
          return createdContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') return appImageId;
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.State.Running}}') return 'true';
        if (arguments_[0] === 'cp') {
          await fs.writeFile(containerCopy, '{"approved":false}', 'utf8');
          return '';
        }
        if (isProductionImportCommand(arguments_)) {
          const digestOptionIndex = arguments_.indexOf('--expected-source-sha256');
          const innerArguments = [containerCopy, '--dry-run'];
          if (digestOptionIndex >= 0) {
            innerArguments.push(
              '--expected-source-sha256',
              arguments_[digestOptionIndex + 1],
            );
          }
          const inner = runImporterArguments(innerArguments, importerEnvironment());
          if (inner.status !== 0) throw new Error(inner.stderr.trim());
          unverifiedInnerImportSucceeded = true;
          const report = JSON.parse(inner.stdout);
          report.source = '/tmp/easyboost-legacy-data.json';
          return JSON.stringify(report);
        }
        return '';
      };
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: true,
        ownershipToken,
        ...productionAuthority(appImageId, runDocker),
      }), /source digest mismatch/u);
      assert.equal(unverifiedInnerImportSucceeded, false,
        'one-off must reject copied bytes before parsing/importing them');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON live import rejects a different dry-run digest before Docker allocation',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-digest-bind-'));
    try {
      const source = path.join(directory, 'data.json');
      const sourceBytes = '{"approved":true}';
      await fs.writeFile(source, sourceBytes, 'utf8');
      let dockerCalled = false;
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: false,
        expectedSourceSha256: 'f'.repeat(64),
        hostLockDirectory: temporaryHostOperationLock(directory),
        lockFile: temporaryOperationLock(directory),
        environment: {
          EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'a'.repeat(64)}`,
          EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: `sha256:${'b'.repeat(64)}`,
        },
        runDocker: async () => {
          dockerCalled = true;
          throw new Error('Docker must not run when the source digest differs');
        },
      }), new RegExp(
        `source digest mismatch: expected ${'f'.repeat(64)}, received ${sha256(sourceBytes)}`,
        'u',
      ));
      assert.equal(dockerCalled, false);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import keeps the primary failure before private snapshot cleanup failure',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-snapshot-errors-'));
    let snapshotDirectory = null;
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const appImageId = `sha256:${'a'.repeat(64)}`;
      const createdContainerId = '3'.repeat(64);
      const ownershipToken = '4'.repeat(64);
      const importError = new Error('simulated import failure before snapshot cleanup');
      let inventoryCalls = 0;
      let snapshotPath = null;
      const runDocker = async (arguments_) => {
        if (arguments_[0] === 'image') return appImageId;
        if (arguments_[0] === 'ps') {
          inventoryCalls += 1;
          return inventoryCalls === 1 ? '' : createdContainerId;
        }
        if (arguments_[0] === 'compose') return createdContainerId;
        if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
      return productionOneOffAuthorityLabel(arguments_, ownershipToken);
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
          return createdContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') return appImageId;
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.State.Running}}') return 'true';
        if (arguments_[0] === 'cp') {
          snapshotPath = arguments_[1];
          snapshotDirectory = path.dirname(snapshotPath);
          return '';
        }
        if (isProductionImportCommand(arguments_)) {
          await fs.link(snapshotPath, `${snapshotPath}.unexpected-link`);
          throw importError;
        }
        return '';
      };
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: false,
        expectedSourceSha256: sha256('{}'),
        ownershipToken,
        ...productionAuthority(appImageId, runDocker),
      }), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], importError);
        assert.match(error.errors[1].message, /private snapshot identity changed/u);
        assert.equal(error.cause, importError);
        return true;
      });
    } finally {
      if (snapshotDirectory) await fs.rm(snapshotDirectory, { recursive: true, force: true });
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('remote settlement evidence survives private snapshot cleanup failure and retains both guards',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-evidence-chain-'));
    let snapshotDirectory = null;
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const appImageId = `sha256:${'b'.repeat(64)}`;
      const createdContainerId = '5'.repeat(64);
      const ownershipToken = '6'.repeat(64);
      const importError = new Error('simulated remote import failure with tagged activity');
      const events = [];
      let ownershipInventoryCalls = 0;
      let snapshotPath = null;
      const runDocker = async (arguments_) => {
        if (arguments_[0] === 'image') return appImageId;
        if (arguments_[0] === 'ps') {
          ownershipInventoryCalls += 1;
          return ownershipInventoryCalls === 1 ? '' : createdContainerId;
        }
        if (arguments_[0] === 'compose') return createdContainerId;
        if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
          return productionOneOffAuthorityLabel(arguments_, ownershipToken);
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
          return createdContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') return appImageId;
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.State.Running}}') return 'true';
        if (arguments_[0] === 'cp') {
          snapshotPath = arguments_[1];
          snapshotDirectory = path.dirname(snapshotPath);
          return '';
        }
        if (arguments_[0] === 'exec' && arguments_.includes('chown')) return '';
        if (isProductionImportCommand(arguments_)) {
          await fs.link(snapshotPath, `${snapshotPath}.unexpected-link`);
          throw importError;
        }
        if (arguments_[0] === 'rm') return createdContainerId;
        throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
      };
      const databaseRelease = async () => { events.push('database-release'); };
      const hostRelease = async () => { events.push('host-release'); };
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: true,
        operationToken: DEFAULT_IMPORT_OPERATION_TOKEN,
        ownershipToken,
        importSettlementProbeAttempts: 1,
        importSettlementProbeIntervalMs: 1,
        wait: async () => {},
        ...productionAuthority(appImageId, runDocker, {}, {
          importActivityCount: '1',
        }),
        acquireHostOperation: async () => {
          events.push('host-acquire');
          return hostRelease;
        },
        acquireOperationLock: async () => {
          events.push('database-acquire');
          return databaseRelease;
        },
        retainOperationLock: async (release, _timeout, reason, evidence) => {
          assert.equal(release, databaseRelease);
          assert.equal(reason, 'IMPORT_REMOTE_SETTLEMENT_UNPROVEN');
          assert.deepEqual(evidence.lastProbe,
            { activityCount: 1, process: 'ACTIVE', status: 'ACTIVE' });
          events.push('database-retain');
        },
        retainHostOperation: async (release, _timeout, evidence) => {
          assert.equal(release, hostRelease);
          assert.equal(evidence.retentionReason, 'IMPORT_REMOTE_SETTLEMENT_UNPROVEN');
          assert.deepEqual(evidence.lastProbe,
            { activityCount: 1, process: 'ACTIVE', status: 'ACTIVE' });
          events.push('host-retain');
        },
        releaseHostOperation: async (release) => { await release(); },
      }), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], importError);
        assert.match(error.errors[1].message, /did not settle within the bounded probe window/u);
        assert.match(error.errors[2].message, /private snapshot identity changed/u);
        assert.equal(error.cause, importError);
        return true;
      });

      assert.deepEqual(events, [
        'host-acquire',
        'database-acquire',
        'database-retain',
        'host-retain',
      ]);
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.deepEqual(events, [
        'host-acquire',
        'database-acquire',
        'database-retain',
        'host-retain',
      ], 'retained guards must have no late release effect');
    } finally {
      if (snapshotDirectory) await fs.rm(snapshotDirectory, { recursive: true, force: true });
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production import waits for delayed shared-lock settlement before releasing the host guard',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-lock-release-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const appImageId = `sha256:${'5'.repeat(64)}`;
      const importError = new Error('simulated import failure while shared lock is held');
      const events = [];
      let releaseCalls = 0;
      let dockerCalls = 0;
      let releaseEnteredResolve;
      let releaseSettledResolve;
      let allowReleaseResolve;
      let operationSettled = false;
      const releaseEntered = new Promise((resolve) => { releaseEnteredResolve = resolve; });
      const releaseSettled = new Promise((resolve) => { releaseSettledResolve = resolve; });
      const allowRelease = new Promise((resolve) => { allowReleaseResolve = resolve; });
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      const operation = runProductionComposeJsonImport({
        acquireHostOperation: async () => {
          events.push('host-acquire');
          return async () => { events.push('host-release'); };
        },
        acquireOperationLock: async () => async () => {
          releaseCalls += 1;
          events.push('database-release-entered');
          releaseEnteredResolve();
          await allowRelease;
          events.push('database-release-settled');
          releaseSettledResolve();
        },
        releaseHostOperation: async (release) => { await release(); },
        source,
        dryRun: true,
        lockReleaseTimeoutMs: 10,
        ...productionAuthority(appImageId, async () => {
          dockerCalls += 1;
          throw importError;
        }),
      });
      operation.finally(() => { operationSettled = true; }).catch(() => {});

      await releaseEntered;
      assert.equal(operationSettled, false,
        'the import must not settle while its database lock release is still pending');
      assert.deepEqual(events, ['host-acquire', 'database-release-entered']);
      allowReleaseResolve();
      await releaseSettled;
      await assert.rejects(operation, (error) => error === importError);
      assert.equal(dockerCalls, 1);
      assert.equal(releaseCalls, 1);
      assert.deepEqual(events, [
        'host-acquire',
        'database-release-entered',
        'database-release-settled',
        'host-release',
      ]);
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.equal(releaseCalls, 1, 'settled release must have no late side effect');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('Docker subprocess rejects an unretainable POSIX controller before spawn', async () => {
  const { runDockerCommand } = await import('../scripts/import-json.js');
  const controlRoot = path.join(
    path.parse(projectDirectory).root,
    ...Array.from({ length: 15 }, () => 'y'.repeat(100)),
  );
  let spawnCalls = 0;

  await assert.rejects(runDockerCommand(['ps'], {
    childLifecycle: {
      forcePosixSession: true,
      platform: 'linux',
      posixControlRoot: controlRoot,
    },
    spawnProcess() {
      spawnCalls += 1;
      throw new Error('spawn must remain unreachable');
    },
  }), (error) => {
    assert.match(error.cause?.message ?? '', /exceeds its durable retention bound/u);
    return true;
  });
  assert.equal(spawnCalls, 0);
});

test('Docker subprocess binds the native POSIX control key before its hold', {
  skip: process.platform === 'win32',
}, async () => {
  const { runDockerCommand } = await import('../scripts/import-json.js');
  const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-root-'));
  const firstCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-cwd-first-'));
  const secondCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-cwd-second-'));
  const previousCwd = process.cwd();
  const spawnError = new Error('stop after observing fixed POSIX control key');
  let observedControlNames = [];
  try {
    process.chdir(firstCwd);
    const expectedControlName = sha256(`database:${firstCwd}:docker`);
    const redirectedControlName = sha256(`database:${secondCwd}:docker`);
    const operationLock = {
      async beginLocalChildHold() {
        process.chdir(secondCwd);
        return { async release() {} };
      },
    };

    await assert.rejects(runDockerCommand(['ps'], {
      childLifecycle: {
        forcePosixSession: true,
        platform: 'linux',
        posixControlRoot: controlRoot,
      },
      operationLock,
      spawnProcess() {
        observedControlNames = fsSync.readdirSync(controlRoot);
        throw spawnError;
      },
    }), (error) => error.cause === spawnError);

    assert.deepEqual(observedControlNames, [expectedControlName]);
    assert.equal(observedControlNames.includes(redirectedControlName), false,
      'an ambient cwd change must not redirect the preflighted POSIX authority');
  } finally {
    process.chdir(previousCwd);
    await fs.rm(controlRoot, { recursive: true, force: true });
    await fs.rm(firstCwd, { recursive: true, force: true });
    await fs.rm(secondCwd, { recursive: true, force: true });
  }
});

test('Docker subprocess rejects a POSIX invocation that swaps its preflighted controller',
  async () => {
    const { runDockerCommand } = await import('../scripts/import-json.js');
    const controlDirectory = path.join(
      path.parse(projectDirectory).root,
      'bounded-posix-controller',
      'a'.repeat(64),
    );
    const replacementDirectory = path.join(
      path.parse(projectDirectory).root,
      ...Array.from({ length: 15 }, () => 'z'.repeat(100)),
      'b'.repeat(64),
    );
    const control = { dispose() {}, specification: { controlDirectory } };
    const replacement = {
      dispose() {},
      specification: { controlDirectory: replacementDirectory },
    };
    let holdCalls = 0;
    let holdReleaseCalls = 0;
    let invocationCalls = 0;
    let spawnCalls = 0;

    await assert.rejects(runDockerCommand(['ps'], {
      childLifecycle: {
        forcePosixSession: true,
        platform: 'linux',
        posixSessionControl: control,
        posixSessionInvocation(command, args, cwd, settlement, environment) {
          invocationCalls += 1;
          return {
            args,
            command,
            cwd,
            environment,
            posixSessionControl: replacement,
            settlement,
          };
        },
      },
      operationLock: {
        async beginLocalChildHold() {
          holdCalls += 1;
          return {
            async release() { holdReleaseCalls += 1; },
          };
        },
      },
      spawnProcess() {
        spawnCalls += 1;
        throw new Error('spawn must remain unreachable');
      },
    }), (error) => {
      assert.match(error.cause?.message ?? '', /replaced its preflighted controller authority/u);
      return true;
    });

    assert.equal(holdCalls, 1);
    assert.equal(holdReleaseCalls, 1);
    assert.equal(invocationCalls, 1);
    assert.equal(spawnCalls, 0,
      'a substituted controller must be rejected before child creation');
  });

test('Docker subprocess rejects unretainable Windows controller roots before hold and spawn',
  async (t) => {
    const { runDockerCommand } = await import('../scripts/import-json.js');
    const fixtures = [
      {
        label: 'ASCII path with Windows separator escaping',
        root: path.join(
          path.parse(projectDirectory).root,
          ...Array.from({ length: 30 }, () => 'w'.repeat(100)),
        ),
      },
      {
        label: 'multi-byte Unicode path',
        root: path.join(
          path.parse(projectDirectory).root,
          ...Array.from({ length: 16 }, () => 'я'.repeat(100)),
        ),
      },
    ];

    for (const fixture of fixtures) {
      await t.test(fixture.label, async () => {
        let holdCalls = 0;
        let spawnCalls = 0;
        const operationLock = {
          async beginLocalChildHold() {
            holdCalls += 1;
            return { async release() {} };
          },
        };

        await assert.rejects(runDockerCommand(['ps'], {
          childLifecycle: {
            forceWindowsJob: true,
            platform: 'win32',
            windowsControlRoot: fixture.root,
          },
          operationLock,
          spawnProcess() {
            spawnCalls += 1;
            throw new Error('spawn must remain unreachable');
          },
        }), (error) => {
          assert.match(error.cause?.message ?? '', /Windows controller exceeds its durable retention bound/u);
          return true;
        });
        assert.equal(holdCalls, 0, 'codec capacity must be proven before the local-child hold');
        assert.equal(spawnCalls, 0, 'codec capacity must be proven before child creation');
      });
    }
  });

test('Docker subprocess binds the native Windows temporary control root before its hold', {
  skip: process.platform !== 'win32',
}, async () => {
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-windows-root-first-'));
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-windows-root-second-'));
  const previousTemp = process.env.TEMP;
  const previousTmp = process.env.TMP;
  const spawnError = new Error('stop after observing fixed Windows control root');
  const controlKey = `database:${process.cwd()}:docker`;
  const controlName = `easyboost-windows-job-${sha256(controlKey)}`;
  let spawnCalls = 0;
  let firstRootObserved = false;
  let secondRootObserved = false;
  try {
    process.env.TEMP = firstRoot;
    process.env.TMP = firstRoot;
    const { runDockerCommand } = await import('../scripts/import-json.js');
    const operationLock = {
      async beginLocalChildHold() {
        process.env.TEMP = secondRoot;
        process.env.TMP = secondRoot;
        assert.equal(os.tmpdir(), secondRoot,
          'the fixture must change the ambient temporary root during the hold');
        return { async release() {} };
      },
    };

    await assert.rejects(runDockerCommand(['ps'], {
      childLifecycle: { forceWindowsJob: true, platform: 'win32' },
      operationLock,
      spawnProcess() {
        spawnCalls += 1;
        firstRootObserved = fsSync.existsSync(path.join(firstRoot, controlName));
        secondRootObserved = fsSync.existsSync(path.join(secondRoot, controlName));
        throw spawnError;
      },
    }), (error) => error.cause === spawnError);

    assert.equal(spawnCalls, 1);
    assert.equal(firstRootObserved, true,
      'child creation must use the control root fixed before the hold');
    assert.equal(secondRootObserved, false,
      'an ambient temporary-root change must not redirect child authority');
  } finally {
    if (previousTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP;
    else process.env.TMP = previousTmp;
    await fs.rm(firstRoot, { recursive: true, force: true });
    await fs.rm(secondRoot, { recursive: true, force: true });
  }
});

test('Docker subprocess rejects an injected Windows controller before hold and spawn', async () => {
  const { runDockerCommand } = await import('../scripts/import-json.js');
  let holdCalls = 0;
  let spawnCalls = 0;
  const operationLock = {
    async beginLocalChildHold() {
      holdCalls += 1;
      return { async release() {} };
    },
  };

  await assert.rejects(runDockerCommand(['ps'], {
    childLifecycle: {
      forceWindowsJob: true,
      platform: 'win32',
      windowsJobInvocation() {
        throw new Error('injected invocation must remain unreachable');
      },
    },
    operationLock,
    spawnProcess() {
      spawnCalls += 1;
      throw new Error('spawn must remain unreachable');
    },
  }), (error) => {
    assert.match(error.cause?.message ?? '', /cannot be proven before spawn/u);
    return true;
  });
  assert.equal(holdCalls, 0);
  assert.equal(spawnCalls, 0);
});

test('Docker subprocess accepts POSIX wrapper self-termination only from authenticated target status',
  async () => {
    const { runDockerCommand } = await import('../scripts/import-json.js');
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const signals = [];
    child.kill = (signal) => {
      throw new Error(`direct child signal escaped owned session: ${signal}`);
    };

    const command = runDockerCommand(['ps'], {
      capture: true,
      childLifecycle: fakeOwnedPosixSession(child, signals),
      spawnProcess: () => {
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
        return child;
      },
      hardTimeoutMs: 100,
      terminateGraceMs: 20,
      killGraceMs: 20,
    });

    assert.equal(await command, '');
    assert.deepEqual(signals, []);
  });

test('Docker subprocess preserves authenticated POSIX target and wrapper failures', async (t) => {
  const { runDockerCommand } = await import('../scripts/import-json.js');
  const fixtures = [
    {
      close: { exitCode: null, signal: 'SIGKILL' },
      expected: /exit code 23/u,
      label: 'nonzero target',
      status: { errorCode: null, exitCode: 23, signal: null, state: 'present' },
    },
    {
      close: { exitCode: null, signal: 'SIGKILL' },
      expected: /target failed with signal SIGTERM/u,
      label: 'signalled target',
      status: { errorCode: null, exitCode: null, signal: 'SIGTERM', state: 'present' },
    },
    {
      close: { exitCode: null, signal: 'SIGKILL' },
      expected: /target status could not be authenticated/u,
      label: 'controller status failure',
      status: { error: new Error('corrupt target status proof'), state: 'unknown' },
    },
    {
      close: { exitCode: 125, signal: null },
      expected: /POSIX wrapper failed with exit code 125 and signal none/u,
      label: 'wrapper failure',
      status: { errorCode: null, exitCode: 0, signal: null, state: 'present' },
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.label, async () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const signals = [];
      child.kill = (signal) => {
        throw new Error(`direct child signal escaped owned session: ${signal}`);
      };
      await assert.rejects(runDockerCommand(['ps'], {
        capture: true,
        childLifecycle: fakeOwnedPosixSession(child, signals, {
          targetStatus: () => fixture.status,
        }),
        spawnProcess: () => {
          queueMicrotask(() => child.emit(
            'close', fixture.close.exitCode, fixture.close.signal,
          ));
          return child;
        },
        hardTimeoutMs: 100,
        terminateGraceMs: 20,
        killGraceMs: 20,
      }), fixture.expected);
      assert.deepEqual(signals, []);
    });
  }
});

test('real POSIX wrapper reports generic Docker target success, exit, signal and control failure', {
  skip: process.platform !== 'linux',
  timeout: 20_000,
}, async (t) => {
  const { runDockerCommand } = await import('../scripts/import-json.js');
  const { createPosixSessionControl } = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-real-docker-wrapper-'));
  const executable = path.join(root, 'docker');
  const executableSource = `#!/usr/bin/env node
const fs = require('node:fs');
const [mode, marker] = process.argv.slice(2);
if (mode === 'success') {
  process.stdout.write('fixture-output\\n');
  process.exit(0);
}
if (mode === 'nonzero') process.exit(23);
if (mode === 'signal') {
  process.kill(process.pid, 'SIGTERM');
  setInterval(() => {}, 1_000);
}
if (mode === 'control-failure') {
  fs.writeFileSync(marker, 'ready', { flag: 'wx', mode: 0o600 });
  setTimeout(() => process.exit(0), 250);
}
`;
  const environment = {
    ...process.env,
    PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  const options = (label, childLifecycle = {}) => ({
    capture: true,
    childLifecycle: {
      platform: 'linux',
      posixControlKey: `real-docker-wrapper:${label}`,
      posixControlRoot: path.join(root, `controls-${label}`),
      ...childLifecycle,
    },
    environment,
    hardTimeoutMs: 5_000,
    terminateGraceMs: 200,
    killGraceMs: 200,
  });
  try {
    await fs.writeFile(executable, executableSource, { mode: 0o700 });
    await fs.chmod(executable, 0o700);

    await t.test('success', async () => {
      assert.equal(await runDockerCommand(['success'], options('success')), 'fixture-output');
    });
    await t.test('nonzero exit', async () => {
      await assert.rejects(runDockerCommand(['nonzero'], options('nonzero')), /exit code 23/u);
    });
    await t.test('target signal', async () => {
      await assert.rejects(runDockerCommand(['signal'], options('signal')),
        /target failed with signal SIGTERM/u);
    });
    await t.test('controller status publication failure', async () => {
      const controlRoot = path.join(root, 'controls-failure');
      const control = createPosixSessionControl({
        controlKey: 'real-docker-wrapper:control-failure',
        controlRoot,
      });
      const marker = path.join(root, 'control-failure.ready');
      const operation = runDockerCommand(
        ['control-failure', marker],
        options('control-failure', {
          posixControlKey: undefined,
          posixControlRoot: undefined,
          posixSessionControl: control,
        }),
      );
      const deadline = Date.now() + 2_000;
      while (!fsSync.existsSync(marker) && Date.now() < deadline) {
        await new Promise((resolve) => { setTimeout(resolve, 10); });
      }
      assert.equal(fsSync.existsSync(marker), true, 'fixture target did not start');
      await fs.writeFile(control.specification.statusPath, 'foreign-status-record\n', {
        flag: 'wx',
        mode: 0o600,
      });
      await assert.rejects(operation, (error) => {
        const pending = [error];
        const seen = new Set();
        const messages = [];
        while (pending.length > 0) {
          const current = pending.shift();
          if (!current || typeof current !== 'object' || seen.has(current)) continue;
          seen.add(current);
          if (typeof current.message === 'string') messages.push(current.message);
          if (current instanceof AggregateError) pending.push(...current.errors);
          pending.push(current.cause);
        }
        assert.equal(messages.some((message) =>
          /target status could not be authenticated|writer publication residue|settlement/iu
            .test(message)), true);
        return true;
      });
      assert.equal(await fs.readFile(control.specification.statusPath, 'utf8'),
        'foreign-status-record\n');
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Docker subprocess deadline escalates TERM to KILL and rejects only after close', async () => {
  const { runDockerCommand } = await import('../scripts/import-json.js');
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const signals = [];
  let closed = false;
  child.kill = (signal) => {
    throw new Error(`direct child signal escaped owned session: ${signal}`);
  };

  await assert.rejects(runDockerCommand(['ps'], {
    capture: true,
    childLifecycle: fakeOwnedPosixSession(child, signals, {
      onRequest(signal) {
        if (signal === 'SIGKILL') {
          queueMicrotask(() => {
            closed = true;
            child.emit('close', null, 'SIGKILL');
          });
        }
      },
    }),
    spawnProcess: () => child,
    hardTimeoutMs: 10,
    terminateGraceMs: 10,
    killGraceMs: 100,
  }), (error) => {
    assert.match(error.message, /Docker command exceeded hard deadline of 10ms/u);
    assert.equal(closed, true, 'deadline rejection must wait for child close/reap');
    return true;
  });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('Docker subprocess preserves a stream failure as primary and aborts the child', async () => {
  const { runDockerCommand } = await import('../scripts/import-json.js');
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const streamError = new Error('simulated stdout stream failure');
  const signals = [];
  child.kill = (signal) => {
    throw new Error(`direct child signal escaped owned session: ${signal}`);
  };

  const command = runDockerCommand(['inspect', 'anything'], {
    capture: true,
    childLifecycle: fakeOwnedPosixSession(child, signals, {
      onRequest(signal) { queueMicrotask(() => child.emit('close', null, signal)); },
    }),
    spawnProcess: () => {
      queueMicrotask(() => child.stdout.emit('error', streamError));
      return child;
    },
    hardTimeoutMs: 100,
    terminateGraceMs: 20,
    killGraceMs: 20,
  });
  await assert.rejects(command, (error) => error === streamError);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test('production import keeps both guards owned when its allocation child never closes',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-child-held-'));
    try {
      const source = path.join(directory, 'data.json');
      const lockFile = path.join(directory, '.easyboost-database-operation.lock');
      await fs.writeFile(source, '{}', 'utf8');
      const appImageId = `sha256:${'a'.repeat(64)}`;
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const postgresContainerId = 'c'.repeat(64);
      const ownershipToken = 'd'.repeat(64);
      const finalizations = [];
      const signals = [];
      let ownershipInventoryCalls = 0;
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      const childLifecycle = fakeOwnedPosixSession(child, signals);
      const { runDockerCommand, runProductionComposeJsonImport } =
        await import('../scripts/import-json.js');
      const runDocker = async (arguments_, options = {}) => {
        if (arguments_[0] === 'image') return appImageId;
        if (arguments_[0] === 'compose' && arguments_.includes('ps')) {
          return arguments_.at(-1) === 'app' ? '' : postgresContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
          if (arguments_[2].includes('NetworkSettings.Networks')) {
            return JSON.stringify({ easyboost_backend: { IPAddress: '172.30.0.2' } });
          }
          return `${postgresContainerId}|${postgresImageId}`
            + '|easyboost-production|postgres|False|true';
        }
        if (arguments_[0] === 'exec' && arguments_[1] === postgresContainerId) return '';
        if (arguments_[0] === 'ps') {
          ownershipInventoryCalls += 1;
          return '';
        }
        if (arguments_[0] === 'compose' && arguments_.includes('run')) {
          return runDockerCommand(arguments_, {
            ...options,
            childLifecycle,
            hardTimeoutMs: 5,
            terminateGraceMs: 5,
            killGraceMs: 10,
            spawnProcess: () => child,
          });
        }
        throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
      };

      await assert.rejects(runProductionComposeJsonImport({
        acquireHostOperation: async () => async () => {
          finalizations.push('host-release');
        },
        allocationSettlementProbeAttempts: 2,
        allocationSettlementProbeIntervalMs: 1,
        dryRun: true,
        environment: {
          EASYBOOST_PRODUCTION_APP_IMAGE_ID: appImageId,
          EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: postgresImageId,
        },
        lockFile,
        operationToken: DEFAULT_IMPORT_OPERATION_TOKEN,
        ownershipToken,
        releaseHostOperation: async (release) => { await release(); },
        retainHostOperation: async () => { finalizations.push('host-retain'); },
        retainOperationLock: async () => { finalizations.push('database-retain'); },
        runDocker,
        source,
        wait: async () => {},
      }), (error) => {
        assert.equal(error.childSettlementUnproven, true);
        assert.equal(error.code, 'PRODUCTION_IMPORT_LOCAL_CHILD_RECOVERY_REQUIRED');
        assert.ok(error.recoveryAuthority?.controlDirectory);
        return true;
      });

      assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
      assert.equal(ownershipInventoryCalls, 1,
        'an unclosed allocation child cannot be replaced by a quiet ownership observation');
      assert.deepEqual(finalizations, ['host-retain'],
        'the host guard must retain exact recovery evidence while the DB hold stays owned');
      const artifacts = await fs.readdir(directory);
      assert.equal(artifacts.filter((entry) => (
        entry.startsWith('.easyboost-database-operation.lock.local-child-')
      )).length, 1, 'the exact unclosed child must retain one durable recovery hold');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('failed remote import releases guards only after tagged PostgreSQL activity reaches zero',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-pg-settle-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const appImageId = `sha256:${'1'.repeat(64)}`;
      const createdContainerId = '2'.repeat(64);
      const ownershipToken = '3'.repeat(64);
      const importError = new Error('simulated remote import transport failure');
      const calls = [];
      const waits = [];
      const activityCounts = ['1', '0'];
      const runDocker = createFailingRemoteImportDocker({
        appImageId,
        calls,
        createdContainerId,
        importError,
        ownershipToken,
      });
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: true,
        operationToken: DEFAULT_IMPORT_OPERATION_TOKEN,
        ownershipToken,
        importSettlementProbeAttempts: 2,
        importSettlementProbeIntervalMs: 7,
        wait: async (milliseconds) => { waits.push(milliseconds); },
        ...productionAuthority(appImageId, runDocker, {}, {
          calls,
          importActivityCount: () => activityCounts.shift(),
        }),
      }), (error) => error === importError);

      const removeIndex = calls.findIndex(({ arguments_ }) => arguments_[0] === 'rm');
      const activityProbes = calls
        .map(({ arguments_ }, index) => ({ arguments_, index }))
        .filter(({ arguments_ }) => arguments_.includes('psql'));
      assert.equal(activityProbes.length, 2);
      assert.ok(activityProbes.every(({ index }) => index > removeIndex),
        'the one-off must be removed before PostgreSQL settlement can be authorized');
      assert.ok(activityProbes.every(({ arguments_ }) => (
        arguments_.includes(`appname=easyboost_import_${DEFAULT_IMPORT_OPERATION_TOKEN}`)
      )), 'every recovery probe must target the exact tagged import session');
      assert.deepEqual(waits, [7]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('active PostgreSQL import after the bounded probe budget retains database and host guards',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-pg-active-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const appImageId = `sha256:${'4'.repeat(64)}`;
      const createdContainerId = '5'.repeat(64);
      const ownershipToken = '6'.repeat(64);
      const importError = new Error('simulated remote import timeout');
      const calls = [];
      const lockEvents = [];
      const databaseRelease = async () => { lockEvents.push('database-release'); };
      databaseRelease.retain = async (reason, evidence) => {
        lockEvents.push('database-retain');
        assert.equal(reason, 'IMPORT_REMOTE_SETTLEMENT_UNPROVEN');
        assert.deepEqual(evidence, {
          applicationName: `easyboost_import_${DEFAULT_IMPORT_OPERATION_TOKEN}`,
          kind: 'import',
          operationToken: DEFAULT_IMPORT_OPERATION_TOKEN,
          ownershipToken,
          importContainerId: createdContainerId,
          postgresContainerId: DEFAULT_POSTGRES_CONTAINER_ID,
          lastProbe: { activityCount: 1, process: 'ACTIVE', status: 'ACTIVE' },
        });
      };
      const hostRelease = async () => { lockEvents.push('host-release'); };
      hostRelease.retain = async (evidence) => {
        lockEvents.push('host-retain');
        assert.deepEqual(evidence, {
          applicationName: `easyboost_import_${DEFAULT_IMPORT_OPERATION_TOKEN}`,
          kind: 'import',
          operationToken: DEFAULT_IMPORT_OPERATION_TOKEN,
          ownershipToken,
          importContainerId: createdContainerId,
          postgresContainerId: DEFAULT_POSTGRES_CONTAINER_ID,
          lastProbe: { activityCount: 1, process: 'ACTIVE', status: 'ACTIVE' },
          retentionReason: 'IMPORT_REMOTE_SETTLEMENT_UNPROVEN',
        });
      };
      const runDocker = createFailingRemoteImportDocker({
        appImageId,
        calls,
        createdContainerId,
        importError,
        ownershipToken,
      });
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: true,
        operationToken: DEFAULT_IMPORT_OPERATION_TOKEN,
        ownershipToken,
        importSettlementProbeAttempts: 2,
        importSettlementProbeIntervalMs: 1,
        wait: async () => {},
        ...productionAuthority(appImageId, runDocker, {}, {
          calls,
          importActivityCount: '1',
        }),
        acquireHostOperation: async () => {
          lockEvents.push('host-acquire');
          return hostRelease;
        },
        acquireOperationLock: async () => {
          lockEvents.push('database-acquire');
          return databaseRelease;
        },
        retainHostOperation: async (release, _timeout, evidence) => {
          await release.retain(evidence);
        },
        retainOperationLock: async (release, _timeout, reason, evidence) => {
          await release.retain(reason, evidence);
        },
      }), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, importError);
        assert.equal(error.errors[0], importError);
        assert.match(error.errors[1].message, /did not settle within the bounded probe window/u);
        return true;
      });
      assert.deepEqual(lockEvents, [
        'host-acquire',
        'database-acquire',
        'database-retain',
        'host-retain',
      ]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('PostgreSQL settlement probe failure retains the last known activity and both guards',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-pg-probe-error-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const appImageId = `sha256:${'7'.repeat(64)}`;
      const createdContainerId = '8'.repeat(64);
      const ownershipToken = '9'.repeat(64);
      const importError = new Error('simulated remote import stream failure');
      const probeError = new Error('simulated pg_stat_activity probe failure');
      const calls = [];
      const lockEvents = [];
      const databaseRelease = async () => { lockEvents.push('database-release'); };
      databaseRelease.retain = async (reason, evidence) => {
        lockEvents.push('database-retain');
        assert.equal(reason, 'IMPORT_REMOTE_SETTLEMENT_UNPROVEN');
        assert.deepEqual(evidence.lastProbe, {
          activityCount: 1, process: 'ACTIVE', status: 'ACTIVE',
        });
        assert.equal(evidence.applicationName,
          `easyboost_import_${DEFAULT_IMPORT_OPERATION_TOKEN}`);
      };
      const hostRelease = async () => { lockEvents.push('host-release'); };
      hostRelease.retain = async () => {
        lockEvents.push('host-retain');
        return async () => { lockEvents.push('host-release'); };
      };
      const runDocker = createFailingRemoteImportDocker({
        appImageId,
        calls,
        createdContainerId,
        importError,
        ownershipToken,
      });
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: true,
        operationToken: DEFAULT_IMPORT_OPERATION_TOKEN,
        ownershipToken,
        importSettlementProbeAttempts: 2,
        importSettlementProbeIntervalMs: 1,
        wait: async () => {},
        ...productionAuthority(appImageId, runDocker, {}, {
          calls,
          importActivityCount: (() => {
            let probe = 0;
            return () => {
              probe += 1;
              if (probe === 1) return '1';
              throw probeError;
            };
          })(),
        }),
        acquireHostOperation: async () => {
          lockEvents.push('host-acquire');
          return hostRelease;
        },
        acquireOperationLock: async () => {
          lockEvents.push('database-acquire');
          return databaseRelease;
        },
        retainHostOperation: async (release) => release.retain(),
        retainOperationLock: async (release, _timeout, reason, evidence) => {
          await release.retain(reason, evidence);
        },
      }), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [importError, probeError]);
        return true;
      });
      assert.deepEqual(lockEvents, [
        'host-acquire',
        'database-acquire',
        'database-retain',
        'host-retain',
      ]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import recovers an owned container when Compose errors after allocation',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-create-error-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const approvedImageId = `sha256:${'1'.repeat(64)}`;
      const createdContainerId = '2'.repeat(64);
      const ownershipToken = '3'.repeat(64);
      const containerName = 'easyboost-json-import-create-error-test';
      const createError = new Error('simulated Compose failure after allocation');
      const calls = [];
      let inventoryCalls = 0;
      let removed = false;
      const runDocker = async (arguments_, options = {}) => {
        calls.push({ arguments_, options });
        if (arguments_[0] === 'image') return approvedImageId;
        if (arguments_[0] === 'ps') {
          inventoryCalls += 1;
          return inventoryCalls === 1 || removed ? '' : createdContainerId;
        }
        if (arguments_[0] === 'compose') throw createError;
        if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
      return productionOneOffAuthorityLabel(arguments_, ownershipToken);
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
          return createdContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') {
          return approvedImageId;
        }
        if (arguments_[0] === 'rm') {
          removed = true;
          return createdContainerId;
        }
        throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
      };
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: false,
        expectedSourceSha256: sha256('{}'),
        composeFile: 'compose.production.yml',
        containerName,
        ownershipToken,
        allocationSettlementProbeAttempts: 2,
        allocationSettlementProbeIntervalMs: 1,
        wait: async () => {},
        ...productionAuthority(approvedImageId, runDocker),
      }), (error) => error === createError);

      assert.equal(inventoryCalls, 4,
        'ownership inventory must include a separated quiet proof after exact removal');
      assert.deepEqual(calls.find(({ arguments_ }) => arguments_[0] === 'rm').arguments_,
        ['rm', '--force', createdContainerId]);
      const composeIndex = calls.findIndex(({ arguments_ }) => arguments_[0] === 'compose');
      assert.ok(calls.slice(composeIndex + 1).every(({ arguments_ }) => (
        !arguments_.includes(containerName)
      )), 'post-error recovery must never touch a foreign replacement by mutable name');
      assert.equal(calls.some(({ arguments_ }) => arguments_[0] === 'cp'), false);
      assert.equal(calls.some(({ arguments_ }) => isProductionImportCommand(arguments_)), false);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import observes and settles a delayed owned Compose allocation',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-delayed-create-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const approvedImageId = `sha256:${'c'.repeat(64)}`;
      const createdContainerId = 'd'.repeat(64);
      const ownershipToken = 'e'.repeat(64);
      const createError = new Error('simulated Compose failure before delayed allocation appears');
      const calls = [];
      const events = [];
      const waits = [];
      let ownershipInventoryCalls = 0;
      let removed = false;
      const runDocker = async (arguments_, options = {}) => {
        calls.push({ arguments_, options });
        if (arguments_[0] === 'image') return approvedImageId;
        if (arguments_[0] === 'ps') {
          ownershipInventoryCalls += 1;
          if (ownershipInventoryCalls === 1 || ownershipInventoryCalls === 2) return '';
          if (!removed && ownershipInventoryCalls === 3) return createdContainerId;
          return '';
        }
        if (arguments_[0] === 'compose') throw createError;
        if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
          return productionOneOffAuthorityLabel(arguments_, ownershipToken);
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
          return createdContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') {
          return approvedImageId;
        }
        if (arguments_[0] === 'rm') {
          removed = true;
          return createdContainerId;
        }
        throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
      };
      const databaseRelease = async () => { events.push('database-release'); };
      const hostRelease = async () => { events.push('host-release'); };
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: true,
        operationToken: DEFAULT_IMPORT_OPERATION_TOKEN,
        ownershipToken,
        allocationSettlementProbeAttempts: 2,
        allocationSettlementProbeIntervalMs: 7,
        wait: async (milliseconds) => { waits.push(milliseconds); },
        ...productionAuthority(approvedImageId, runDocker, {}, { calls }),
        acquireHostOperation: async () => {
          events.push('host-acquire');
          return hostRelease;
        },
        acquireOperationLock: async () => {
          events.push('database-acquire');
          return databaseRelease;
        },
        retainOperationLock: async () => { events.push('database-retain'); },
        retainHostOperation: async () => { events.push('host-retain'); },
        releaseHostOperation: async (release) => { await release(); },
      }), (error) => error === createError);

      assert.deepEqual(waits, [7, 7],
        'both delayed discovery and final quiet proof must use separated observations');
      assert.equal(ownershipInventoryCalls, 5);
      assert.deepEqual(events, [
        'host-acquire',
        'database-acquire',
        'database-release',
        'host-release',
      ]);
      const removalIndex = calls.findIndex(({ arguments_ }) => arguments_[0] === 'rm');
      assert.ok(removalIndex > 0);
      for (const template of [
        'com.docker.compose.project',
        'com.docker.compose.service',
        'com.docker.compose.oneoff',
        '{{.Image}}',
      ]) {
        assert.ok(calls.slice(0, removalIndex).some(({ arguments_ }) => (
          arguments_[0] === 'inspect' && arguments_[2].includes(template)
        )), `${template} authority must be exact before removal`);
      }
      const postgresProofs = calls
        .map(({ arguments_ }, index) => ({ arguments_, index }))
        .filter(({ arguments_ }) => (
          arguments_[0] === 'inspect' && arguments_.at(-1) === DEFAULT_POSTGRES_CONTAINER_ID
          && !arguments_[2].includes('NetworkSettings.Networks')
        ));
      assert.ok(postgresProofs.some(({ index }) => index < removalIndex));
      assert.ok(postgresProofs.some(({ index }) => index > removalIndex));
      const appProofs = calls
        .map(({ arguments_ }, index) => ({ arguments_, index }))
        .filter(({ arguments_ }) => (
          arguments_[0] === 'compose' && arguments_.at(-1) === 'app'
        ));
      assert.ok(appProofs.some(({ index }) => index < removalIndex));
      assert.ok(appProofs.some(({ index }) => index > removalIndex));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import recovers owned allocation from malformed successful Compose output',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-malformed-create-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const approvedImageId = `sha256:${'4'.repeat(64)}`;
      const createdContainerId = '5'.repeat(64);
      const ownershipToken = '6'.repeat(64);
      const containerName = 'easyboost-json-import-malformed-create-test';
      const calls = [];
      let inventoryCalls = 0;
      const runDocker = async (arguments_, options = {}) => {
        calls.push({ arguments_, options });
        if (arguments_[0] === 'image') return approvedImageId;
        if (arguments_[0] === 'ps') {
          inventoryCalls += 1;
          return inventoryCalls === 1 ? '' : createdContainerId;
        }
        if (arguments_[0] === 'compose') return 'created-container-with-malformed-stdout';
        if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
      return productionOneOffAuthorityLabel(arguments_, ownershipToken);
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
          return createdContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') {
          return approvedImageId;
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.State.Running}}') return 'true';
        if (isProductionImportCommand(arguments_)) {
          return productionImportReport(arguments_);
        }
        return '';
      };
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await runProductionComposeJsonImport({
        source,
        dryRun: true,
        composeFile: 'compose.production.yml',
        containerName,
        ownershipToken,
        ...productionAuthority(approvedImageId, runDocker),
      });

      assert.equal(inventoryCalls, 2);
      const importCall = calls.find(({ arguments_ }) => isProductionImportCommand(arguments_));
      assert.equal(importCall.arguments_[2], createdContainerId);
      assert.deepEqual(calls.at(-1).arguments_, ['rm', '--force', createdContainerId]);
      const composeIndex = calls.findIndex(({ arguments_ }) => arguments_[0] === 'compose');
      assert.ok(calls.slice(composeIndex + 1).every(({ arguments_ }) => (
        !arguments_.includes(containerName)
      )), 'malformed stdout recovery must retain only the label-resolved immutable ID');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import releases guards after bounded separated quiet allocation observation',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-no-allocation-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const approvedImageId = `sha256:${'9'.repeat(64)}`;
      const ownershipToken = 'a'.repeat(64);
      const createError = new Error('simulated Compose failure without allocation');
      const calls = [];
      const waits = [];
      const lockEvents = [];
      const databaseRelease = async () => { lockEvents.push('database-release'); };
      databaseRelease.retain = async (reason, evidence) => {
        lockEvents.push('database-retain');
        assert.equal(reason, 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN');
        assert.deepEqual(evidence, {
          applicationName: `easyboost_import_${DEFAULT_IMPORT_OPERATION_TOKEN}`,
          kind: 'import',
          operationToken: DEFAULT_IMPORT_OPERATION_TOKEN,
          ownershipToken,
          importContainerId: 'unknown',
          postgresContainerId: DEFAULT_POSTGRES_CONTAINER_ID,
          lastProbe: { activityCount: 'unknown', process: 'UNKNOWN', status: 'UNKNOWN' },
        });
      };
      const hostRelease = async () => { lockEvents.push('host-release'); };
      hostRelease.retain = async () => {
        lockEvents.push('host-retain');
        return async () => { lockEvents.push('host-release'); };
      };
      const runDocker = async (arguments_, options = {}) => {
        calls.push({ arguments_, options });
        if (arguments_[0] === 'image') return approvedImageId;
        if (arguments_[0] === 'ps') return '';
        if (arguments_[0] === 'compose') throw createError;
        throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
      };
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: true,
        operationToken: DEFAULT_IMPORT_OPERATION_TOKEN,
        ownershipToken,
        allocationSettlementProbeAttempts: 3,
        allocationSettlementProbeIntervalMs: 7,
        wait: async (milliseconds) => { waits.push(milliseconds); },
        ...productionAuthority(approvedImageId, runDocker),
        acquireHostOperation: async () => {
          lockEvents.push('host-acquire');
          return hostRelease;
        },
        acquireOperationLock: async () => {
          lockEvents.push('database-acquire');
          return databaseRelease;
        },
        retainHostOperation: async (release) => release.retain(),
        retainOperationLock: async (release, _timeout, reason, evidence) => {
          await release.retain(reason, evidence);
        },
      }), (error) => error === createError);

      assert.equal(calls.filter(({ arguments_ }) => arguments_[0] === 'ps').length, 4);
      assert.deepEqual(waits, [7, 7]);
      assert.equal(calls.some(({ arguments_ }) => (
        arguments_[0] === 'inspect' && arguments_.at(-1) !== DEFAULT_POSTGRES_CONTAINER_ID
      )), false);
      assert.equal(calls.some(({ arguments_ }) => arguments_[0] === 'rm'), false,
        'stable empty observation has no container safe to delete');
      assert.deepEqual(lockEvents, [
        'host-acquire',
        'database-acquire',
        'host-retain',
        'database-release',
        'host-release',
      ], 'guards release only after the bounded stable-quiet and final authority proofs');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import refuses ambiguous or foreign ownership inventory without deletion',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-foreign-inventory-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const approvedImageId = `sha256:${'b'.repeat(64)}`;
      const ownershipToken = 'c'.repeat(64);
      const firstContainerId = 'd'.repeat(64);
      const secondContainerId = 'e'.repeat(64);
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      for (const scenario of ['ambiguous', 'foreign-label']) {
        const calls = [];
        let inventoryCalls = 0;
        const runDocker = async (arguments_, options = {}) => {
          calls.push({ arguments_, options });
          if (arguments_[0] === 'image') return approvedImageId;
          if (arguments_[0] === 'ps') {
            inventoryCalls += 1;
            if (inventoryCalls === 1) return '';
            return scenario === 'ambiguous'
              ? `${firstContainerId}\n${secondContainerId}`
              : firstContainerId;
          }
          if (arguments_[0] === 'compose') return 'malformed-success-output';
          if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
            return 'foreign-ownership-token';
          }
          throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
        };

        await assert.rejects(runProductionComposeJsonImport({
          source,
          dryRun: true,
          ownershipToken,
          ...productionAuthority(approvedImageId, runDocker),
        }), scenario === 'ambiguous' ? /ownership inventory is ambiguous/iu : /ownership label mismatch/iu);
        assert.equal(calls.some(({ arguments_ }) => arguments_[0] === 'rm'), false,
          `${scenario} inventory must not authorize deletion of any unknown container`);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import keeps allocation failure first when ownership recovery also fails',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-recovery-errors-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const approvedImageId = `sha256:${'f'.repeat(64)}`;
      const ownershipToken = '0'.repeat(64);
      const allocationError = new Error('simulated allocation failure after unknown side effect');
      const recoveryError = new Error('simulated ownership inventory failure');
      const calls = [];
      let inventoryCalls = 0;
      const runDocker = async (arguments_, options = {}) => {
        calls.push({ arguments_, options });
        if (arguments_[0] === 'image') return approvedImageId;
        if (arguments_[0] === 'ps') {
          inventoryCalls += 1;
          if (inventoryCalls === 1) return '';
          throw recoveryError;
        }
        if (arguments_[0] === 'compose') throw allocationError;
        throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
      };
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: true,
        ownershipToken,
        ...productionAuthority(approvedImageId, runDocker),
      }), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [allocationError, recoveryError]);
        assert.equal(error.cause, allocationError);
        return true;
      });
      assert.equal(calls.some(({ arguments_ }) => arguments_[0] === 'rm'), false,
        'failed recovery must never authorize deletion of an unknown container');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production JSON import preserves both the primary failure and immutable-ID cleanup failure',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-cleanup-errors-'));
    try {
      const source = path.join(directory, 'data.json');
      await fs.writeFile(source, '{}', 'utf8');
      const approvedImageId = `sha256:${'7'.repeat(64)}`;
      const createdContainerId = '8'.repeat(64);
      const ownershipToken = '3'.repeat(64);
      const containerName = 'easyboost-json-import-cleanup-errors-test';
      const primaryError = new Error('simulated legacy import failure');
      const cleanupError = new Error('simulated immutable container cleanup failure');
      const calls = [];
      const lockEvents = [];
      const databaseRelease = async () => { lockEvents.push('database-release'); };
      databaseRelease.retain = async (reason, evidence) => {
        lockEvents.push('database-retain');
        assert.equal(reason, 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN');
        assert.deepEqual(evidence, {
          applicationName: `easyboost_import_${DEFAULT_IMPORT_OPERATION_TOKEN}`,
          kind: 'import',
          operationToken: DEFAULT_IMPORT_OPERATION_TOKEN,
          ownershipToken,
          importContainerId: createdContainerId,
          postgresContainerId: DEFAULT_POSTGRES_CONTAINER_ID,
          lastProbe: { activityCount: 'unknown', process: 'UNKNOWN', status: 'UNKNOWN' },
        });
      };
      const hostRelease = async () => { lockEvents.push('host-release'); };
      hostRelease.retain = async () => { lockEvents.push('host-retain'); };
      let inventoryCalls = 0;
      const runDocker = async (arguments_, options = {}) => {
        calls.push({ arguments_, options });
        if (arguments_[0] === 'image') return approvedImageId;
        if (arguments_[0] === 'ps') {
          inventoryCalls += 1;
          return inventoryCalls === 1 ? '' : createdContainerId;
        }
        if (arguments_[0] === 'compose') return createdContainerId;
        if (arguments_[0] === 'inspect' && arguments_[2]?.startsWith('{{ index')) {
          return productionOneOffAuthorityLabel(arguments_, ownershipToken);
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Id}}') {
          return createdContainerId;
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.Image}}') {
          return approvedImageId;
        }
        if (arguments_[0] === 'inspect' && arguments_[2] === '{{.State.Running}}') return 'true';
        if (isProductionImportCommand(arguments_)) throw primaryError;
        if (arguments_[0] === 'rm') throw cleanupError;
        return '';
      };
      const { runProductionComposeJsonImport } = await import('../scripts/import-json.js');

      await assert.rejects(runProductionComposeJsonImport({
        source,
        dryRun: false,
        expectedSourceSha256: sha256('{}'),
        composeFile: 'compose.production.yml',
        containerName,
        operationToken: DEFAULT_IMPORT_OPERATION_TOKEN,
        ownershipToken,
        ...productionAuthority(approvedImageId, runDocker),
        acquireHostOperation: async () => {
          lockEvents.push('host-acquire');
          return hostRelease;
        },
        acquireOperationLock: async () => {
          lockEvents.push('database-acquire');
          return databaseRelease;
        },
        retainHostOperation: async (release) => { await release.retain(); },
        retainOperationLock: async (release, _timeout, reason, evidence) => {
          await release.retain(reason, evidence);
        },
      }), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [primaryError, cleanupError]);
        assert.equal(error.cause, primaryError);
        assert.match(error.message, /legacy import failed and immutable container cleanup also failed/iu);
        return true;
      });
      assert.deepEqual(calls.at(-1).arguments_, ['rm', '--force', createdContainerId]);
      const composeIndex = calls.findIndex(({ arguments_ }) => arguments_[0] === 'compose');
      assert.ok(calls.slice(composeIndex + 1).every(({ arguments_ }) => (
        !arguments_.includes(containerName)
      )),
        'failure cleanup must never target a mutable or replaced container name');
      assert.deepEqual(lockEvents, [
        'host-acquire',
        'database-acquire',
        'database-retain',
        'host-retain',
      ], 'unknown remote settlement must retain both guards without calling either release path');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('JSON import writes provider identity and progress in the same transaction without OAuth payloads', async () => {
  const { importJsonData } = await import('../scripts/import-json.js');
  const { snapshot, legacyUsername, providerUsername } = importFixture('real');
  const client = new RecordingImportClient();

  const report = await importJsonData(snapshot, { source: 'fixture.json', client });

  assert.deepEqual(report, {
    source: 'fixture.json', users: 2, learnerIdentities: 1, progress: 2, skipped: [],
  });
  assert.equal(client.queries[0].text, 'BEGIN');
  assert.equal(client.queries.at(-1).text, 'COMMIT');
  const providerUser = client.queries.find(({ text, parameters }) => (
    /INSERT INTO users/u.test(text) && parameters[0] === providerUsername
  ));
  assert.deepEqual(providerUser.parameters.slice(0, 5), [
    providerUsername, null, null, true, 'Мария Импорт',
  ]);
  const legacyUser = client.queries.find(({ text, parameters }) => (
    /INSERT INTO users/u.test(text) && parameters[0] === legacyUsername
  ));
  assert.deepEqual(legacyUser.parameters.slice(0, 5), [
    legacyUsername, 'legacy-password-hash', null, false, null,
  ]);
  const identity = client.queries.find(({ text }) => /INSERT INTO learner_identities/u.test(text));
  assert.deepEqual(identity.parameters.slice(0, 3), ['vk', 'vk-real', providerUsername]);
  assert.equal(client.queries.filter(({ text }) => /INSERT INTO user_progress/u.test(text)).length, 2);
  assert.doesNotMatch(JSON.stringify(client.queries), /must-never-be-imported|oauth_auth_transactions/u);
});

test('JSON import is append-only and rolls back before touching an existing username', async () => {
  const { importJsonData } = await import('../scripts/import-json.js');
  const { snapshot } = importFixture('existing-user');
  const client = new RecordingImportClient();
  client.query = async (text, parameters = []) => {
    const normalizedText = String(text);
    client.queries.push({ text: normalizedText, parameters });
    if (/INSERT INTO users/u.test(normalizedText)) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [] };
  };

  await assert.rejects(
    importJsonData(snapshot, { source: 'existing-user.json', client }),
    /IMPORT_EXISTING_USER_CONFLICT/u,
  );

  const userInsert = client.queries.find(({ text }) => /INSERT INTO users/u.test(text));
  assert.match(userInsert.text, /ON CONFLICT \(username\) DO NOTHING/u);
  assert.doesNotMatch(userInsert.text, /DO UPDATE/u);
  assert.equal(client.queries.some(({ text }) => /learner_identities|user_progress/u.test(text)), false,
    'an existing username must abort before any dependent learner state is touched');
  assert.equal(client.queries.at(-1).text, 'ROLLBACK');
  assert.equal(client.queries.some(({ text }) => text === 'COMMIT'), false);
});

test('JSON import never overwrites existing learner progress and rolls back the snapshot', async () => {
  const { importJsonData } = await import('../scripts/import-json.js');
  const { snapshot } = importFixture('existing-progress');
  const client = new RecordingImportClient();
  client.query = async (text, parameters = []) => {
    const normalizedText = String(text);
    client.queries.push({ text: normalizedText, parameters });
    if (/INSERT INTO user_progress/u.test(normalizedText)) {
      return { rowCount: 0, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  };

  await assert.rejects(
    importJsonData(snapshot, { source: 'existing-progress.json', client }),
    /IMPORT_EXISTING_PROGRESS_CONFLICT/u,
  );

  const progressInsert = client.queries.find(({ text }) => /INSERT INTO user_progress/u.test(text));
  assert.match(progressInsert.text, /ON CONFLICT \(username\) DO NOTHING/u);
  assert.doesNotMatch(progressInsert.text, /DO UPDATE/u);
  assert.equal(client.queries.at(-1).text, 'ROLLBACK');
  assert.equal(client.queries.some(({ text }) => text === 'COMMIT'), false);
});

test('JSON import never reassigns an existing provider identity', async () => {
  const { importJsonData } = await import('../scripts/import-json.js');
  const { snapshot } = importFixture('existing-provider');
  const client = new RecordingImportClient();
  client.query = async (text, parameters = []) => {
    const normalizedText = String(text);
    client.queries.push({ text: normalizedText, parameters });
    if (/INSERT INTO learner_identities/u.test(normalizedText)) {
      return { rowCount: 0, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  };

  await assert.rejects(
    importJsonData(snapshot, { source: 'existing-provider.json', client }),
    /IMPORT_PROVIDER_IDENTITY_CONFLICT/u,
  );

  const identityInsert = client.queries.find(({ text }) => (
    /INSERT INTO learner_identities/u.test(text)
  ));
  assert.match(identityInsert.text, /ON CONFLICT \(provider, subject\) DO NOTHING/u);
  assert.doesNotMatch(identityInsert.text, /DO UPDATE/u);
  assert.equal(client.queries.at(-1).text, 'ROLLBACK');
});

test('JSON import rolls back the complete snapshot when provider identity persistence fails', async () => {
  const { importJsonData } = await import('../scripts/import-json.js');
  const { snapshot } = importFixture('rollback');
  const client = new FailingIdentityClient();

  await assert.rejects(
    importJsonData(snapshot, { source: 'rollback.json', client }),
    /simulated identity insert failure/u,
  );
  assert.equal(client.queries[0].text, 'BEGIN');
  assert.equal(client.queries.at(-1).text, 'ROLLBACK');
  assert.equal(client.queries.some(({ text }) => text === 'COMMIT'), false);
});

test('JSON import preserves the query failure before a rollback failure', async () => {
  const { importJsonData } = await import('../scripts/import-json.js');
  const { snapshot } = importFixture('query-rollback-errors');
  const queryError = new Error('simulated import query failure');
  const rollbackError = new Error('simulated rollback failure');
  const client = new RecordingImportClient();
  client.query = async (text, parameters = []) => {
    const normalizedText = String(text);
    client.queries.push({ text: normalizedText, parameters });
    if (/INSERT INTO learner_identities/u.test(normalizedText)) throw queryError;
    if (normalizedText === 'ROLLBACK') throw rollbackError;
    return { rowCount: 1, rows: [] };
  };

  await assert.rejects(
    importJsonData(snapshot, { source: 'query-rollback-errors.json', client }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[0], queryError);
      assert.equal(error.errors[1], rollbackError);
      assert.equal(error.cause, queryError);
      return true;
    },
  );
  assert.equal(client.queries.at(-1).text, 'ROLLBACK');
  assert.equal(client.queries.some(({ text }) => text === 'COMMIT'), false);
});

test('connected JSON import preserves the import failure before disconnect failure', async () => {
  const { runConnectedJsonImport } = await import('../scripts/import-json.js');
  const { snapshot } = importFixture('import-disconnect-errors');
  const importError = new Error('simulated connected import failure');
  const disconnectError = new Error('simulated disconnect failure');
  const client = new RecordingImportClient();
  let disconnectCalls = 0;
  client.query = async (text, parameters = []) => {
    const normalizedText = String(text);
    client.queries.push({ text: normalizedText, parameters });
    if (/INSERT INTO learner_identities/u.test(normalizedText)) throw importError;
    return { rowCount: 1, rows: [] };
  };
  client.end = async () => {
    disconnectCalls += 1;
    throw disconnectError;
  };

  await assert.rejects(
    runConnectedJsonImport(snapshot, { source: 'import-disconnect-errors.json', client }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[0], importError);
      assert.equal(error.errors[1], disconnectError);
      assert.equal(error.cause, importError);
      return true;
    },
  );
  assert.equal(client.queries.at(-1).text, 'ROLLBACK');
  assert.equal(disconnectCalls, 1);
});

test('connected JSON import preserves query, rollback, and disconnect failures in lifecycle order',
  async () => {
    const { runConnectedJsonImport } = await import('../scripts/import-json.js');
    const { snapshot } = importFixture('query-rollback-disconnect-errors');
    const queryError = new Error('simulated lifecycle query failure');
    const rollbackError = new Error('simulated lifecycle rollback failure');
    const disconnectError = new Error('simulated lifecycle disconnect failure');
    const client = new RecordingImportClient();
    let disconnectCalls = 0;
    client.query = async (text, parameters = []) => {
      const normalizedText = String(text);
      client.queries.push({ text: normalizedText, parameters });
      if (/INSERT INTO learner_identities/u.test(normalizedText)) throw queryError;
      if (normalizedText === 'ROLLBACK') throw rollbackError;
      return { rowCount: 1, rows: [] };
    };
    client.end = async () => {
      disconnectCalls += 1;
      throw disconnectError;
    };

    await assert.rejects(
      runConnectedJsonImport(snapshot, {
        source: 'query-rollback-disconnect-errors.json', client,
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 3);
        assert.equal(error.errors[0], queryError);
        assert.equal(error.errors[1], rollbackError);
        assert.equal(error.errors[2], disconnectError);
        assert.equal(error.cause, queryError);
        return true;
      },
    );
    assert.equal(client.queries.at(-1).text, 'ROLLBACK');
    assert.equal(disconnectCalls, 1);
  });

test('connected JSON import reports success before surfacing a disconnect failure', async () => {
  const { runConnectedJsonImport } = await import('../scripts/import-json.js');
  const { snapshot } = importFixture('success-disconnect-error');
  const disconnectError = new Error('simulated disconnect-only failure');
  const client = new RecordingImportClient();
  let reported = null;
  let disconnectCalls = 0;
  client.end = async () => {
    disconnectCalls += 1;
    throw disconnectError;
  };

  await assert.rejects(
    runConnectedJsonImport(snapshot, {
      source: 'success-disconnect-error.json',
      client,
      onReport(report) {
        reported = report;
        assert.equal(client.queries.at(-1).text, 'COMMIT');
      },
    }),
    (error) => error === disconnectError,
  );
  assert.deepEqual(reported, {
    source: 'success-disconnect-error.json',
    users: 2,
    learnerIdentities: 1,
    progress: 2,
    skipped: [],
  });
  assert.equal(disconnectCalls, 1);
});

test('JSON import CLI restores legacy and provider accounts in PostgreSQL without OAuth secrets', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const suffix = `pg_${process.pid}_${Date.now()}`;
  const fixture = importFixture(suffix);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-json-pg-'));
  const source = path.join(directory, 'data.json');
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await fs.writeFile(source, JSON.stringify(fixture.snapshot), 'utf8');
    const result = runImporter(source, [], importerEnvironment({
      DATABASE_PROVIDER: 'postgres',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
    }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      dryRun: false,
      source,
      users: 2,
      learnerIdentities: 1,
      progress: 2,
      skipped: [],
    });

    const accounts = await client.query(
      `SELECT username, password_hash, identity_managed, display_name
       FROM users WHERE username = ANY($1::text[]) ORDER BY username`,
      [[fixture.legacyUsername, fixture.providerUsername]],
    );
    assert.equal(accounts.rowCount, 2);
    const legacy = accounts.rows.find(({ username }) => username === fixture.legacyUsername);
    assert.equal(legacy.password_hash, 'legacy-password-hash');
    assert.equal(legacy.identity_managed, false);
    const provider = accounts.rows.find(({ username }) => username === fixture.providerUsername);
    assert.equal(provider.password_hash, null);
    assert.equal(provider.identity_managed, true);
    assert.equal(provider.display_name, 'Мария Импорт');

    const identity = await client.query(
      `SELECT provider, subject, username FROM learner_identities
       WHERE provider = $1 AND subject = $2`,
      ['vk', `vk-${suffix}`],
    );
    assert.deepEqual(identity.rows, [{
      provider: 'vk', subject: `vk-${suffix}`, username: fixture.providerUsername,
    }]);
    const progress = await client.query(
      'SELECT username, data FROM user_progress WHERE username = ANY($1::text[])',
      [[fixture.legacyUsername, fixture.providerUsername]],
    );
    assert.equal(progress.rowCount, 2);
    assert.deepEqual(progress.rows.find(({ username }) => (
      username === fixture.providerUsername
    )).data, { learned: 7 });
    const oauth = await client.query(
      'SELECT 1 FROM oauth_auth_transactions WHERE verifier_sealed = $1',
      [fixture.forbiddenSecret],
    );
    assert.equal(oauth.rowCount, 0);
  } finally {
    if (connected) {
      try {
        await client.query('DELETE FROM users WHERE username = ANY($1::text[])', [
          [fixture.legacyUsername, fixture.providerUsername],
        ]);
      } finally {
        await client.end();
      }
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
