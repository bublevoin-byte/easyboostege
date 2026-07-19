import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { config } from '../config.js';

const { Client } = pg;
const dryRun = process.argv.includes('--dry-run');
const fileArgument = process.argv.find((argument) => !argument.startsWith('--') && argument !== process.argv[0] && argument !== process.argv[1]);
const source = path.resolve(fileArgument || config.database.file);

const parsed = JSON.parse(await fs.readFile(source, 'utf8'));
const users = parsed.users && typeof parsed.users === 'object' ? parsed.users : {};
const progress = parsed.progress && typeof parsed.progress === 'object' ? parsed.progress : {};
const report = { source, users: 0, progress: 0, skipped: [] };

for (const [username, user] of Object.entries(users)) {
  if (!username || (!user.hash && user.telegram_id == null)) {
    report.skipped.push({ username, reason: 'missing identity' });
    continue;
  }
  report.users++;
  if (progress[username] && typeof progress[username] === 'object') report.progress++;
}

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, ...report }, null, 2));
  process.exit(0);
}

if (!config.database.url) throw new Error('DATABASE_URL is required to import data');

const client = new Client({ connectionString: config.database.url });
await client.connect();
try {
  await client.query('BEGIN');
  for (const [username, user] of Object.entries(users)) {
    if (!username || (!user.hash && user.telegram_id == null)) continue;
    await client.query(
      `INSERT INTO users (
         username, password_hash, telegram_id, trial_used, subscription_until, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (username) DO UPDATE SET
         password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
         telegram_id = COALESCE(EXCLUDED.telegram_id, users.telegram_id),
         trial_used = users.trial_used OR EXCLUDED.trial_used,
         subscription_until = GREATEST(users.subscription_until, EXCLUDED.subscription_until),
         updated_at = NOW()`,
      [
        username,
        user.hash || null,
        user.telegram_id == null ? null : String(user.telegram_id),
        Boolean(user.trial_used),
        user.sub_until ? new Date(Number(user.sub_until)) : null,
        user.created ? new Date(Number(user.created)) : new Date(),
      ],
    );
    if (progress[username] && typeof progress[username] === 'object') {
      await client.query(
        `INSERT INTO user_progress (username, data, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (username) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [username, JSON.stringify(progress[username])],
      );
    }
  }
  await client.query('COMMIT');
  console.log(JSON.stringify({ dryRun: false, ...report }, null, 2));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
