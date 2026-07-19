import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';

const composeFile = path.resolve('compose.production.yml');
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const destination = path.resolve(process.argv[2] || path.join('backups', `easyboost-${stamp}.dump`));
const temporary = `${destination}.${process.pid}.tmp`;

async function runBackup() {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fsp.access(destination);
    throw new Error(`Backup already exists: ${destination}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
  const child = spawn('docker', [
    'compose', '-f', composeFile, 'exec', '-T', 'postgres',
    'pg_dump', '-U', 'easyboost', '-d', 'easyboost', '--format=custom', '--no-owner', '--no-privileges',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.pipe(output);

  const exitCodePromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const [exitCode] = await Promise.all([exitCodePromise, finished(output)]);
  if (exitCode !== 0) throw new Error(`pg_dump failed with exit code ${exitCode}`);

  const stat = await fsp.stat(temporary);
  if (!stat.size) throw new Error('pg_dump created an empty backup');
  await fsp.rename(temporary, destination);
  console.log(`Backup created: ${destination} (${stat.size} bytes)`);
}

try {
  await runBackup();
} catch (error) {
  await fsp.rm(temporary, { force: true }).catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
}
