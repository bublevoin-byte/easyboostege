import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectName = `easyboost-postgres-integration-${process.pid}`;
const composeArguments = ['compose', '-p', projectName, '-f', 'compose.test.yml'];

function run(command, arguments_, { captureOutput = false, env = process.env } = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: projectDirectory,
    encoding: 'utf8',
    env,
    stdio: captureOutput ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(' ')} exited with status ${result.status}`);
  }
  return result.stdout?.trim() || '';
}

function compose(arguments_, options) {
  return run('docker', [...composeArguments, ...arguments_], options);
}

let failure;

try {
  compose(['up', '--detach', '--wait', '--wait-timeout', '60', '--pull', 'missing', 'postgres']);
  const publishedPort = compose(['port', 'postgres', '5432'], { captureOutput: true });
  const match = publishedPort.match(/127\.0\.0\.1:(\d+)$/u);
  if (!match) throw new Error(`Could not determine the disposable PostgreSQL port from: ${publishedPort}`);

  const connectionString = `postgresql://easyboost_repository_test@127.0.0.1:${match[1]}/easyboost_repository_test`;
  const testEnvironment = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: connectionString,
    TEST_DATABASE_URL: connectionString,
  };

  run(process.execPath, ['scripts/migrate.js'], { env: testEnvironment });
  run(process.execPath, ['--test', 'test/postgres-repository.test.js'], { env: testEnvironment });
} catch (error) {
  failure = error;
  console.error(error instanceof Error ? error.message : error);
} finally {
  try {
    compose(['down', '--volumes', '--remove-orphans']);
  } catch (cleanupError) {
    console.error('Failed to clean up the disposable PostgreSQL Compose project.');
    console.error(cleanupError instanceof Error ? cleanupError.message : cleanupError);
    failure ||= cleanupError;
  }
}

if (failure) process.exitCode = 1;
