import { spawn as defaultSpawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReleaseServerEnvironment } from '../e2e/aisy-learner-release-safety.js';
import {
  consumePosixReleaseMaintenanceBinding,
  createPosixReleaseMaintenanceLauncherInvocation,
  createPosixReleaseSessionControl,
  establishPosixReleaseMaintenanceScope,
  launchPosixReleaseMaintenanceBatch,
} from './posix-release-maintenance-scope.js';
import { runBoundedReleaseCommand } from './release-command-supervisor.js';

export const AISY_RELEASE_E2E_CHILD_TIMEOUT_MS = 15 * 60_000;

/* One ordered, built-dist-only inventory. Package gates build once and invoke every expensive
   browser scenario exactly once, while the individual npm scripts remain available for triage. */
export const AISY_RELEASE_E2E_FILES = Object.freeze([
  'e2e/demo.test.js',
  'e2e/aisy-pwa-release.test.js',
  'e2e/aisy-first-launch.test.js',
  'e2e/aisy-shell.test.js',
  'e2e/aisy-today.test.js',
  'e2e/aisy-accessibility.test.js',
  'e2e/aisy-learner-release.test.js',
  'e2e/aisy-practice.test.js',
  'e2e/adaptive-diagnostic.test.js',
  'e2e/grammar-2-release.test.js',
  'e2e/vocabulary-library.test.js',
  'e2e/reading-listening-paper.test.js',
  'e2e/aisy-writing-paper.test.js',
  'e2e/aisy-writing-offline-cache.test.js',
  'e2e/speaking-task4.test.js',
  'e2e/speaking-full.test.js',
  'e2e/speaking-pronunciation-status.test.js',
  'e2e/aisy-speaking-paper.test.js',
  'e2e/asya-assistant.test.js',
  'e2e/aisy-asya-paper.test.js',
  'e2e/aisy-ege-hub.test.js',
  'e2e/ege-mock-written.test.js',
  'e2e/ege-mock-oral.test.js',
  'e2e/ege-mock-result.test.js',
  'e2e/ege-mock-release.test.js',
  'e2e/aisy-progress-profile.test.js',
]);

const scriptPath = fileURLToPath(import.meta.url);
const projectDirectory = path.resolve(path.dirname(scriptPath), '..');

function run(file, {
  spawn = defaultSpawn,
  commandLifecycle = {},
  posixReleaseMaintenanceBinding,
} = {}) {
  let environment = createReleaseServerEnvironment({});
  let command = process.execPath;
  let args = [file];
  const lifecycle = { ...commandLifecycle };
  if (posixReleaseMaintenanceBinding !== undefined) {
    const maintained = createPosixReleaseSessionControl(posixReleaseMaintenanceBinding, {
      controlKey: `aisy-release-e2e:${file}`,
    });
    lifecycle.posixControlRoot = maintained.controlRoot;
    lifecycle.posixRecoveryScope = maintained.recoveryScope;
    lifecycle.posixSessionControl = maintained.control;
  }
  if (process.platform === 'linux' && file === 'e2e/aisy-pwa-release.test.js') {
    const predecessorScope = establishPosixReleaseMaintenanceScope({
      checkoutDirectory: projectDirectory,
      environment,
      lane: 'pwa-predecessor',
    });
    const invocation = createPosixReleaseMaintenanceLauncherInvocation(
      predecessorScope, process.execPath, [path.resolve(file)], {
        cwd: projectDirectory,
        environment,
      },
    );
    command = invocation.command;
    args = invocation.args;
    environment = invocation.environment;
  }
  return runBoundedReleaseCommand(command, args, {
    hardTimeoutMs: AISY_RELEASE_E2E_CHILD_TIMEOUT_MS,
    ...lifecycle,
    commandLabel: `Aisy release E2E ${file}`,
    env: environment,
    spawnProcess: spawn,
    stdio: 'inherit',
  });
}

export async function runAisyReleaseE2e({
  files = AISY_RELEASE_E2E_FILES,
  spawn = defaultSpawn,
  commandLifecycle = {},
  posixReleaseMaintenanceBinding,
  report = (message) => console.log(message),
} = {}) {
  for (const file of files) {
    report(`\n[Aisy release E2E] ${file}`);
    await run(file, { commandLifecycle, posixReleaseMaintenanceBinding, spawn });
  }
  report(`\nAisy release E2E passed: ${files.length} unique Chromium scenarios.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const relaunched = launchPosixReleaseMaintenanceBatch({
    checkoutDirectory: projectDirectory,
    entrypoint: scriptPath,
    lane: 'aisy-release-e2e',
  });
  if (relaunched !== null) {
    if (relaunched.error) console.error(relaunched.error.message);
    process.exitCode = Number.isInteger(relaunched.status) ? relaunched.status : 1;
  } else {
    let binding;
    let bindingFailed = false;
    try {
      binding = consumePosixReleaseMaintenanceBinding({
        checkoutDirectory: projectDirectory,
        lane: 'aisy-release-e2e',
      });
    } catch (error) {
      console.error(error.message);
      bindingFailed = true;
      process.exitCode = 1;
    }
    if (!bindingFailed) {
      runAisyReleaseE2e({ posixReleaseMaintenanceBinding: binding }).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
    }
  }
}
