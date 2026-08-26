import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';

const { Client } = pg;

function importedDate(value, fallback = new Date()) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

export function createJsonImportPlan(parsed, { source = '' } = {}) {
  const users = parsed?.users && typeof parsed.users === 'object' ? parsed.users : {};
  const progress = parsed?.progress && typeof parsed.progress === 'object' ? parsed.progress : {};
  const learnerIdentities = Array.isArray(parsed?.learner_identities) ? parsed.learner_identities : [];
  const identitiesByUsername = new Map();
  for (const identity of learnerIdentities) {
    const username = String(identity?.username || '');
    if (!username) continue;
    const current = identitiesByUsername.get(username) || [];
    current.push(identity);
    identitiesByUsername.set(username, current);
  }

  const report = { source, users: 0, learnerIdentities: 0, progress: 0, skipped: [] };
  const entries = [];
  for (const [username, user] of Object.entries(users)) {
    const providerIdentities = identitiesByUsername.get(username) || [];
    const legacyIdentity = Boolean(user?.hash) || user?.telegram_id != null;
    const providerIdentity = user?.identity_managed === true
      && !user.hash && user.telegram_id == null && providerIdentities.length === 1;
    if (!username || (!legacyIdentity && !providerIdentity)) {
      report.skipped.push({ username, reason: 'missing identity' });
      continue;
    }
    entries.push({
      username,
      user,
      identity: providerIdentity ? providerIdentities[0] : null,
      progress: progress[username] && typeof progress[username] === 'object'
        ? progress[username]
        : null,
    });
    report.users += 1;
    if (providerIdentity) report.learnerIdentities += 1;
    if (progress[username] && typeof progress[username] === 'object') report.progress += 1;
  }
  return { entries, report };
}

async function importUser(client, entry) {
  const { username, user, identity } = entry;
  const result = await client.query(
    `INSERT INTO users (
       username, password_hash, telegram_id, identity_managed, display_name,
       trial_used, subscription_until, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (username) DO UPDATE SET
       password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
       telegram_id = COALESCE(EXCLUDED.telegram_id, users.telegram_id),
       display_name = COALESCE(EXCLUDED.display_name, users.display_name),
       trial_used = users.trial_used OR EXCLUDED.trial_used,
       subscription_until = GREATEST(users.subscription_until, EXCLUDED.subscription_until),
       updated_at = NOW()
     WHERE users.identity_managed = EXCLUDED.identity_managed
     RETURNING username`,
    [
      username,
      user.hash || null,
      user.telegram_id == null ? null : String(user.telegram_id),
      Boolean(identity),
      identity ? String(user.display_name || '') : null,
      Boolean(user.trial_used),
      user.sub_until ? importedDate(Number(user.sub_until), null) : null,
      user.created ? importedDate(Number(user.created)) : new Date(),
    ],
  );
  if (result.rowCount !== 1) throw new Error('IMPORT_USER_IDENTITY_CONFLICT');
}

async function importLearnerIdentity(client, entry) {
  if (!entry.identity) return;
  const { provider, subject, created_at: createdAt, updated_at: updatedAt } = entry.identity;
  const result = await client.query(
    `INSERT INTO learner_identities (provider, subject, username, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, subject) DO UPDATE SET
       updated_at = GREATEST(learner_identities.updated_at, EXCLUDED.updated_at)
     WHERE learner_identities.username = EXCLUDED.username
     RETURNING username`,
    [
      String(provider || ''),
      String(subject || ''),
      entry.username,
      importedDate(createdAt),
      importedDate(updatedAt),
    ],
  );
  if (result.rowCount !== 1) throw new Error('IMPORT_PROVIDER_IDENTITY_CONFLICT');
}

async function importProgress(client, entry) {
  if (!entry.progress) return;
  await client.query(
    `INSERT INTO user_progress (username, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (username) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [entry.username, JSON.stringify(entry.progress)],
  );
}

export async function importJsonData(parsed, { source = '', client } = {}) {
  if (!client || typeof client.query !== 'function') throw new Error('IMPORT_CLIENT_REQUIRED');
  const plan = createJsonImportPlan(parsed, { source });
  await client.query('BEGIN');
  try {
    for (const entry of plan.entries) {
      await importUser(client, entry);
      await importLearnerIdentity(client, entry);
      await importProgress(client, entry);
    }
    await client.query('COMMIT');
    return plan.report;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const fileArgument = process.argv.find((argument) => (
    !argument.startsWith('--') && argument !== process.argv[0] && argument !== process.argv[1]
  ));
  const source = path.resolve(fileArgument || config.database.file);
  const parsed = JSON.parse(await fs.readFile(source, 'utf8'));
  const plan = createJsonImportPlan(parsed, { source });
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, ...plan.report }, null, 2));
    return;
  }
  if (!config.database.url) throw new Error('DATABASE_URL is required to import data');

  const client = new Client({ connectionString: config.database.url });
  await client.connect();
  try {
    const report = await importJsonData(parsed, { source, client });
    console.log(JSON.stringify({ dryRun: false, ...report }, null, 2));
  } finally {
    await client.end();
  }
}

const currentModule = path.resolve(fileURLToPath(import.meta.url));
if (process.argv[1] && currentModule === path.resolve(process.argv[1])) await main();
