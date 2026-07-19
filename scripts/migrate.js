import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';

const { Client } = pg;
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

if (!config.database.url) throw new Error('DATABASE_URL is required to run migrations');

const client = new Client({ connectionString: config.database.url });
await client.connect();

try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const files = (await fs.readdir(directory)).filter((name) => /^\d+.*\.sql$/u.test(name)).sort();
  for (const file of files) {
    const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
    if (applied.rowCount) continue;
    const sql = await fs.readFile(path.join(directory, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.end();
}

