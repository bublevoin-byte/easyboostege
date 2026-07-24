import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const composeFile = path.resolve('compose.production.yml');
const backupDirectory = path.resolve('backups');
const statusFile = path.join(backupDirectory, 'restore-check-status.json');
const startedAt = Date.now();
const databaseName = `easyboost_restore_check_${Date.now()}_${process.pid}`;

async function latestBackup() {
  const entries = await fsp.readdir(backupDirectory, { withFileTypes: true });
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isFile() && /^easyboost-.*\.dump$/u.test(entry.name))
    .map(async (entry) => ({ path: path.join(backupDirectory, entry.name), stat: await fsp.stat(path.join(backupDirectory, entry.name)) })));
  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  if (!candidates[0]) throw new Error('BACKUP_NOT_FOUND');
  return candidates[0].path;
}

async function docker(args, { inputFile = null, capture = false } = {}) {
  const child = spawn('docker', ['compose', '-f', composeFile, ...args], {
    stdio: [inputFile ? 'pipe' : 'ignore', capture ? 'pipe' : 'inherit', 'inherit'],
  });
  let output = '';
  if (capture) child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  const exitCodePromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const tasks = [exitCodePromise];
  if (inputFile) tasks.push(pipeline(fs.createReadStream(inputFile), child.stdin));
  const [exitCode] = await Promise.all(tasks);
  if (exitCode !== 0) throw new Error(`docker compose ${args.join(' ')} failed with exit code ${exitCode}`);
  return output.trim();
}

async function writeStatus(status) {
  await fsp.mkdir(backupDirectory, { recursive: true });
  const temporary = `${statusFile}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(status, null, 2), { mode: 0o600 });
  await fsp.rename(temporary, statusFile);
}

let backup;
let databaseCreated = false;
try {
  backup = path.resolve(process.argv[2] || await latestBackup());
  await fsp.access(backup);
  await docker(['exec', '-T', 'postgres', 'pg_restore', '--list'], { inputFile: backup });
  await docker(['exec', '-T', 'postgres', 'createdb', '-U', 'easyboost', databaseName]);
  databaseCreated = true;
  await docker([
    'exec', '-T', 'postgres', 'pg_restore', '-U', 'easyboost', '-d', databaseName,
    '--no-owner', '--no-privileges', '--exit-on-error',
  ], { inputFile: backup });
  const verification = await docker([
    'exec', '-T', 'postgres', 'psql', '-U', 'easyboost', '-d', databaseName, '-Atc',
    `SELECT (to_regclass('public.users') IS NOT NULL)::int || ':' ||
            (to_regclass('public.schema_migrations') IS NOT NULL)::int || ':' ||
            (SELECT COUNT(*) FROM users) || ':' ||
            (SELECT COUNT(*) FROM schema_migrations);`,
  ], { capture: true });
  const [usersTable, migrationsTable, users, migrations] = verification.split(':').map(Number);
  if (usersTable !== 1 || migrationsTable !== 1 || migrations < 1) throw new Error('RESTORE_VERIFICATION_FAILED');
  const status = {
    status: 'success',
    checkedAt: new Date().toISOString(),
    backup: path.basename(backup),
    users,
    migrations,
    durationMs: Date.now() - startedAt,
  };
  await writeStatus(status);
  console.log(JSON.stringify(status));
} catch (error) {
  await writeStatus({
    status: 'failed',
    checkedAt: new Date().toISOString(),
    backup: backup ? path.basename(backup) : null,
    errorCode: String(error.message).slice(0, 200),
    durationMs: Date.now() - startedAt,
  }).catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (databaseCreated) {
    await docker(['exec', '-T', 'postgres', 'dropdb', '-U', 'easyboost', '--force', databaseName])
      .catch((error) => { console.error(`Temporary database cleanup failed: ${error.message}`); process.exitCode = 1; });
  }
}
