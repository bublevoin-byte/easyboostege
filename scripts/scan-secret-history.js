import { execFileSync } from 'node:child_process';

const self = 'scripts/scan-secret-history.js';
/*
 * Префикс ключа обязан начинать слово — то же условие, что в scripts/scan-secrets.js и по той же
 * причине: без него `sk-` находилось в середине любого слова, кончающегося на «sk», и тестовый
 * JWT-секрет `task-bank-test-secret-with-32-characters` читался как ключ OpenAI.
 *
 * Здесь это записано группой, а не ретроспективной проверкой: `git grep -E` разбирает POSIX ERE,
 * а lookbehind в нём нет.
 */
const START = '(^|[^A-Za-z0-9_-])';
const patterns = [
  '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----',
  START + 's' + 'k-[A-Za-z0-9_-]{32,}',
  START + 'x' + 'ai-[A-Za-z0-9_-]{32,}',
  START + 'g' + 'sk_[A-Za-z0-9_-]{32,}',
  START + 'gh' + '[pousr]_[A-Za-z0-9]{30,}',
  '[0-9]{8,12}:[A-Za-z0-9_-]{30,}',
];
const commits = execFileSync('git', ['rev-list', '--all'], { encoding: 'utf8' })
  .trim().split(/\s+/u).filter(Boolean);
const findings = new Set();

for (const commit of commits) {
  let matches = '';
  try {
    matches = execFileSync(
      'git',
      ['grep', '-I', '-l', '-E', '-e', patterns.join('|'), commit, '--', '.'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  for (const line of matches.trim().split(/\r?\n/u).filter(Boolean)) {
    const separator = line.indexOf(':');
    const path = separator >= 0 ? line.slice(separator + 1) : line;
    if (path !== self) findings.add(`${commit.slice(0, 12)}:${path}`);
  }
}

if (findings.size) {
  console.error(`Secret history scan failed (values suppressed):\n${[...findings].join('\n')}`);
  process.exit(1);
}
console.log(`Secret history scan passed (${commits.length} commits checked).`);
