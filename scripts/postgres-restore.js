import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const [backupArgument, confirmation] = process.argv.slice(2);
if (!backupArgument || confirmation !== '--confirm-restore') {
  console.error('Usage: npm run db:restore -- <backup.dump> --confirm-restore');
  process.exit(2);
}

const backup = path.resolve(backupArgument);
const composeFile = path.resolve('compose.production.yml');

async function docker(args, inputFile) {
  const child = spawn('docker', ['compose', '-f', composeFile, ...args], {
    stdio: [inputFile ? 'pipe' : 'ignore', 'inherit', 'inherit'],
  });
  const exitCodePromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const tasks = [exitCodePromise];
  if (inputFile) tasks.push(pipeline(fs.createReadStream(inputFile), child.stdin));
  const [exitCode] = await Promise.all(tasks);
  if (exitCode !== 0) throw new Error(`docker compose ${args.join(' ')} failed with exit code ${exitCode}`);
}

await fsp.access(backup);
console.log(`Validating backup: ${backup}`);
await docker(['exec', '-T', 'postgres', 'pg_restore', '--list'], backup);

console.log('Stopping application for restore...');
await docker(['stop', 'app']);
try {
  await docker([
    'exec', '-T', 'postgres', 'pg_restore', '-U', 'easyboost', '-d', 'easyboost',
    '--clean', '--if-exists', '--no-owner', '--no-privileges', '--exit-on-error',
  ], backup);
  console.log('Restore completed successfully.');
} finally {
  console.log('Starting application...');
  await docker(['up', '-d', 'app']);
}
