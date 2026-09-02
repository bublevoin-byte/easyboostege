import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const CANONICAL_IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
export const STAGING_COMPOSE_PROTOCOL = 'immutable-archive-v4';
const APP_ENVIRONMENT_NAMES = Object.freeze([
  'ADAPTIVE_LEARNING_ENABLED',
  'ADMIN_TELEGRAM_ID',
  'AI_DAILY_REQUEST_BUDGET',
  'AI_REQUESTS_PER_HOUR',
  'APP_PORT',
  'APP_URL',
  'AZURE_SPEECH_KEY',
  'AZURE_SPEECH_REGION',
  'DATABASE_PROVIDER',
  'DATABASE_URL',
  'GROQ_API_KEY',
  'GROQ_ENABLED',
  'GROQ_MODEL',
  'JWT_SECRET',
  'MONITORING_TOKEN',
  'NODE_ENV',
  'PORT',
  'POSTGRES_PASSWORD',
  'SPEAKING_PRONUNCIATION_ENABLED',
  'SPEAKING_PRONUNCIATION_MAX_AUDIO_BYTES',
  'SPEAKING_PRONUNCIATION_MAX_AUDIO_SECONDS',
  'SPEAKING_PRONUNCIATION_TIMEOUT_MS',
  'STT_REQUESTS_PER_HOUR',
  'TELEGRAM_BOT_TOKEN',
  'TTS_REQUESTS_PER_HOUR',
  'WRITING_REQUESTS_PER_HOUR',
  'XAI_API_KEY',
  'XAI_ENABLED',
  'XAI_MODEL',
]);
const BOOLEAN_ENVIRONMENT_NAMES = Object.freeze([
  'ADAPTIVE_LEARNING_ENABLED', 'GROQ_ENABLED', 'SPEAKING_PRONUNCIATION_ENABLED',
  'XAI_ENABLED',
]);
const INTEGER_ENVIRONMENT_NAMES = Object.freeze([
  'AI_DAILY_REQUEST_BUDGET', 'AI_REQUESTS_PER_HOUR',
  'SPEAKING_PRONUNCIATION_MAX_AUDIO_BYTES',
  'SPEAKING_PRONUNCIATION_MAX_AUDIO_SECONDS',
  'SPEAKING_PRONUNCIATION_TIMEOUT_MS', 'STT_REQUESTS_PER_HOUR',
  'TTS_REQUESTS_PER_HOUR', 'WRITING_REQUESTS_PER_HOUR',
]);
const CREDENTIAL_ENVIRONMENT_NAMES = Object.freeze([
  'JWT_SECRET', 'MONITORING_TOKEN', 'POSTGRES_PASSWORD',
]);
const PUBLIC_CREDENTIAL_PLACEHOLDER =
  /(?:^|[-_])(?:change-me|replace-with)(?:[-_]|$)/iu;
// Exact SHA-256 inventory of every non-empty credential sentinel published by
// .env.staging.example and .env.example. Keep values out of executable source
// and diagnostics; the staging deploy helper must not trust candidate files.
const PUBLIC_CREDENTIAL_SENTINEL_DIGESTS = Object.freeze([
  '01794c255da2fb547b169b613a74354fe69e6251228ed5c3c3ba74beb5b977f7',
  '02828351652acc49175f94ff82d4140fc2614132f53f727ed38f525d98f480f2',
  '3ee7f84812bc39259c100113a24fef25929d87822996f8c87954c85df830e5d0',
  '7527b467fe7b2411be119b909aa4e554f2c488e18a7b05e8a00075572eb6945b',
  '81fbb07aef67e4584b623407531baa235d68e559a6ecd9f573b6227a6a10c8d1',
]);

function isPublishedCredentialSentinel(value) {
  const digest = crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  return PUBLIC_CREDENTIAL_SENTINEL_DIGESTS.includes(digest);
}

function fail(reason) {
  throw new Error(`unsafe staging Compose contract: ${reason}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is missing`);
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    fail(`${label} has an unapproved member`);
  }
}

function allowedKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is invalid`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) fail(`${label} has unapproved runtime authority`);
}

function exactObjectMembers(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is invalid`);
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    fail(`${label} has an unapproved member`);
  }
}

function verifyNetworks(value, label) {
  exactObjectMembers(value, ['backend'], `${label} networks`);
  if (value.backend !== null
      && (!value.backend || typeof value.backend !== 'object'
        || Array.isArray(value.backend) || Object.keys(value.backend).length)) {
    fail(`${label} network attachment is unapproved`);
  }
}

function verifyEnvironment(app, postgres) {
  exactKeys(postgres, ['POSTGRES_DB', 'POSTGRES_PASSWORD', 'POSTGRES_USER'],
    'postgres environment');
  if (postgres.POSTGRES_DB !== 'easyboost_staging'
      || postgres.POSTGRES_USER !== 'easyboost_staging'
      || typeof postgres.POSTGRES_PASSWORD !== 'string'
      || postgres.POSTGRES_PASSWORD.length < 16) {
    fail('postgres environment is not the isolated staging authority');
  }
  exactKeys(app, APP_ENVIRONMENT_NAMES, 'app environment');
  const expectedDatabase = `postgresql://easyboost_staging:${postgres.POSTGRES_PASSWORD}@postgres:5432/easyboost_staging`;
  if (app.APP_URL !== 'https://staging.useboost.ru'
      || app.DATABASE_PROVIDER !== 'postgres' || app.DATABASE_URL !== expectedDatabase
      || typeof app.JWT_SECRET !== 'string' || app.JWT_SECRET.length < 32
      || app.POSTGRES_PASSWORD !== postgres.POSTGRES_PASSWORD
      || app.APP_PORT !== '3001'
      || app.NODE_ENV !== 'production' || String(app.PORT) !== '3000') {
    fail('app environment is not the exact isolated staging authority');
  }
  for (const name of APP_ENVIRONMENT_NAMES) {
    const value = app[name];
    if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/u.test(value)) {
      fail(`app environment ${name} has an unsafe value`);
    }
  }
  for (const name of CREDENTIAL_ENVIRONMENT_NAMES) {
    const value = app[name].trim();
    if (PUBLIC_CREDENTIAL_PLACEHOLDER.test(value) || isPublishedCredentialSentinel(value)) {
      fail(`app environment ${name} uses a public credential placeholder`);
    }
  }
  for (const name of BOOLEAN_ENVIRONMENT_NAMES) {
    if (!['true', 'false'].includes(app[name])) {
      fail(`app environment ${name} is not a boolean switch`);
    }
  }
  for (const name of INTEGER_ENVIRONMENT_NAMES) {
    if (!/^[1-9]\d{0,8}$/u.test(app[name])) {
      fail(`app environment ${name} is not a bounded positive integer`);
    }
  }
}

function portableAbsolute(value, base) {
  if (typeof value !== 'string' || !value) fail('Compose path is missing');
  let normalized = value.replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
  if (!normalized.startsWith('/')) {
    if (!base) fail('Compose path is not absolute');
    normalized = path.posix.join(path.posix.dirname(base), normalized);
  }
  return path.posix.normalize(normalized).replace(/\/$/u, '');
}

export function verifyStagingComposeModel(model, expectedContext, expectedPostgresImageId) {
  if (!CANONICAL_IMAGE_ID.test(expectedPostgresImageId || '')) {
    fail('captured postgres image authority is not canonical');
  }
  if (!model || typeof model !== 'object' || Array.isArray(model)) fail('resolved model is invalid');
  exactKeys(model, ['name', 'networks', 'services', 'volumes'], 'resolved Compose model');
  if (model.name !== 'easyboost-staging') fail('project name is unapproved');
  exactKeys(model.services, ['app', 'postgres'], 'service allowlist');
  const { app, postgres } = model.services;
  exactKeys(app, [
    'build', 'depends_on', 'environment', 'env_file', 'image', 'networks', 'ports',
    'pull_policy', 'restart',
  ], 'app service');
  exactKeys(postgres, [
    'environment', 'healthcheck', 'image', 'networks', 'pull_policy', 'restart', 'volumes',
  ], 'postgres service');
  if (app.image !== 'easyboost-staging-app:local' || app.pull_policy !== 'never') {
    fail('app image/pull policy is not local-only');
  }
  if (!CANONICAL_IMAGE_ID.test(postgres.image || '')
      || postgres.image !== expectedPostgresImageId || postgres.pull_policy !== 'never') {
    fail('postgres image must use canonical immutable local authority and pull-never');
  }
  if (!app.build || typeof app.build !== 'object' || Array.isArray(app.build)) {
    fail('app build sentinel is missing');
  }
  exactKeys(app.build, ['context', 'dockerfile'], 'app build');
  const expected = portableAbsolute(expectedContext);
  if (portableAbsolute(app.build.context ?? '') !== expected) {
    fail('app build context is not the absent sentinel');
  }
  const expectedDockerfile = path.posix.join(path.posix.dirname(expected), 'Dockerfile');
  const dockerfile = portableAbsolute(app.build.dockerfile ?? '', expected);
  if (dockerfile !== expectedDockerfile) fail('app Dockerfile is not release-local');
  if ('build' in postgres || 'additional_contexts' in postgres) {
    fail('postgres may not expose a build context');
  }
  exactKeys(app.depends_on, ['postgres'], 'app dependency closure');
  const dependency = app.depends_on.postgres;
  if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
    fail('app dependency is not a resolved health-gated object');
  }
  exactKeys(dependency, ['condition', 'required', 'restart'], 'app dependency');
  if (dependency.condition !== 'service_healthy' || dependency.required !== true
      || dependency.restart !== false) {
    fail('app dependency condition is not health-gated');
  }
  if (postgres.depends_on && Object.keys(postgres.depends_on).length) {
    fail('postgres has an unapproved dependency');
  }
  if (app.restart !== 'unless-stopped') fail('app restart policy is unapproved');
  if (postgres.restart !== 'unless-stopped') {
    fail('postgres restart policy is unapproved');
  }
  exactKeys(postgres.healthcheck, ['interval', 'retries', 'test', 'timeout'],
    'postgres healthcheck');
  const test = postgres.healthcheck.test;
  if (!Array.isArray(test) || test.length !== 2 || test[0] !== 'CMD-SHELL'
      || test[1] !== 'pg_isready -U easyboost_staging -d easyboost_staging'
      || postgres.healthcheck.retries !== 10
      || !['10s', 10_000_000_000].includes(postgres.healthcheck.interval)
      || !['5s', 5_000_000_000].includes(postgres.healthcheck.timeout)) {
    fail('postgres healthcheck is not the approved readiness command');
  }
  verifyEnvironment(app.environment, postgres.environment);
  verifyNetworks(app.networks, 'app');
  verifyNetworks(postgres.networks, 'postgres');

  if (!Array.isArray(app.ports) || app.ports.length !== 1) fail('app port authority is unapproved');
  const port = app.ports[0];
  exactKeys(port, ['host_ip', 'mode', 'protocol', 'published', 'target'], 'app port');
  if (port.host_ip !== '127.0.0.1' || port.target !== 3000
      || String(port.published) !== '3001'
      || port.protocol !== 'tcp' || port.mode !== 'ingress') {
    fail('app port is not loopback-bound to the approved target');
  }
  if (!Array.isArray(app.env_file) || app.env_file.length !== 1) fail('app env_file is unapproved');
  const entry = app.env_file[0];
  exactKeys(entry, ['path', 'required'], 'app env_file entry');
  if (portableAbsolute(entry.path ?? '', expected) !== path.posix.join(path.posix.dirname(expected), '.env.staging')
      || entry.required !== true) {
    fail('app env_file is not the protected staging environment');
  }

  if (!Array.isArray(postgres.volumes) || postgres.volumes.length !== 1) {
    fail('postgres storage authority is unapproved');
  }
  const volume = postgres.volumes[0];
  exactKeys(volume, ['source', 'target', 'type'], 'postgres volume');
  if (volume.type !== 'volume' || volume.source !== 'postgres-data'
      || volume.target !== '/var/lib/postgresql/data') {
    fail('postgres must use only the approved named volume');
  }

  exactObjectMembers(model.networks, ['backend'], 'top-level networks');
  exactKeys(model.networks.backend, ['name'], 'backend network');
  if (model.networks.backend.name !== 'easyboost-staging_backend') {
    fail('backend network name is not staging-scoped');
  }
  exactObjectMembers(model.volumes, ['postgres-data'], 'top-level volumes');
  exactKeys(model.volumes['postgres-data'], ['name'], 'postgres data volume');
  if (model.volumes['postgres-data'].name !== 'easyboost-staging_postgres-data') {
    fail('postgres volume name is not staging-scoped');
  }
  return { services: 2 };
}

async function run() {
  if (process.argv[2] === '--protocol' && process.argv.length === 3) {
    console.log(STAGING_COMPOSE_PROTOCOL);
    return;
  }
  const expectedContext = process.argv[2];
  if (!expectedContext) fail('expected context is invalid');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_CONFIG_BYTES) fail('resolved model exceeds byte bound');
    chunks.push(Buffer.from(chunk));
  }
  let model;
  try {
    model = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('resolved model is not JSON');
  }
  verifyStagingComposeModel(
    model,
    expectedContext,
    process.env.EASYBOOST_STAGING_POSTGRES_IMAGE_ID,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
