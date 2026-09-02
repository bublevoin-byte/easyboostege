import { spawnSync } from 'node:child_process';

const requestedConcurrency = process.env.EASYBOOST_TEST_CONCURRENCY;
const arguments_ = ['--test'];

if (requestedConcurrency !== undefined) {
  if (!/^[1-9][0-9]*$/u.test(requestedConcurrency)) {
    throw new Error('EASYBOOST_TEST_CONCURRENCY must be a positive integer');
  }
  arguments_.push(`--test-concurrency=${requestedConcurrency}`);
}

arguments_.push(...process.argv.slice(2), 'test/*.test.js');
const result = spawnSync(process.execPath, arguments_, {
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
