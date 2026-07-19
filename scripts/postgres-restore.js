import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [backupArgument, confirmation] = process.argv.slice(2);
if (!backupArgument || confirmation !== '--confirm-restore') {
  console.error('Usage: npm run db:restore -- <backup.dump> --confirm-restore');
  process.exit(2);
}

const backup = path.resolve(backupArgument);
const composeFile = path.resolve('compose.production.yml');

async function docker(args, inputFile) {
  const input = inputFile ? fs.createReadStream(inputFile) : 'ignore';
  const child = spawn('docker', ['compose', '-f', composeFile, ...args], {
    stdio: [input, 'inherit', 'inherit'],
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
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
