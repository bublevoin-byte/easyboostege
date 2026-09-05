// Finite standalone observation test: never invokes staging scripts or flock.
import { spawn } from 'node:child_process';
import { profileOwnedChild } from './native-lock-profile.mjs';

const timerCase = process.argv[2] === 'timer';
const child = spawn(process.execPath, ['-e', timerCase
  ? 'setTimeout(() => process.exit(23), 100)'
  : `require('node:child_process').spawn('/bin/sleep', ['0.2'], { stdio: 'ignore' });
     setTimeout(() => process.exit(23), 350);`], { stdio: 'ignore' });
const result = await profileOwnedChild(child, {
  sampleIntervalMs: timerCase ? 1000 : 10,
  // Windows can prove timer completion through the filesystem seam. Linux uses real /proc.
  ...(timerCase && process.platform !== 'linux' ? {
    readProc: async (_pid, file) => file === 'stat'
      ? `${child.pid} (node) S ${process.pid} ${'0 '.repeat(17)}1000 0`
      : file === 'children' ? '' : 'node\0',
  } : {}),
});
process.exitCode = result.code;
