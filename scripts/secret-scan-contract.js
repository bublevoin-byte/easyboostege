import fs from 'node:fs';
import path from 'node:path';

const START = '(?<![A-Za-z0-9_-])';
const RULES = [
  ['private key', new RegExp('-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', 'u')],
  ['OpenAI-style key', new RegExp(`${START}s${'k-'}[A-Za-z0-9_-]{32,}`, 'u')],
  ['xAI key', new RegExp(`${START}x${'ai-'}[A-Za-z0-9_-]{32,}`, 'u')],
  ['Groq key', new RegExp(`${START}g${'sk_'}[A-Za-z0-9_-]{32,}`, 'u')],
  ['GitHub token', new RegExp(`${START}gh${'[pousr]_'}[A-Za-z0-9]{30,}`, 'u')],
  ['Telegram bot token', new RegExp('\\b\\d{8,12}:[A-Za-z0-9_-]{30,}\\b', 'u')],
];
const BINARY_SUFFIXES = ['.dump', '.gz', '.png'];

function identity(stat) {
  return [
    stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs,
  ].map(String).join(':');
}

function resolveAuditedFile(rootDirectory, file) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file)
      || /[\u0000-\u001f\u007f]/u.test(file)
      || file.split(/[\\/]/u).includes('..')) {
    throw new Error(`${String(file)}: invalid audited file path`);
  }
  const absolute = path.resolve(rootDirectory, file);
  const relative = path.relative(rootDirectory, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${file}: audited file escapes the scan root`);
  }
  return absolute;
}

function readStableAuditedBytes(rootDirectory, file) {
  const absolute = resolveAuditedFile(rootDirectory, file);
  let before;
  try {
    before = fs.lstatSync(absolute, { bigint: true });
  } catch {
    throw new Error(`${file}: audited file is missing or unreadable`);
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${file}: audited path must be a regular file`);
  }

  let descriptor;
  try {
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || identity(opened) !== identity(before)) {
      throw new Error(`${file}: audited file changed before read`);
    }
    const bytes = fs.readFileSync(descriptor);
    const afterRead = fs.fstatSync(descriptor, { bigint: true });
    const afterPath = fs.lstatSync(absolute, { bigint: true });
    if (identity(afterRead) !== identity(opened) || identity(afterPath) !== identity(opened)
        || BigInt(bytes.length) !== opened.size) {
      throw new Error(`${file}: audited file changed during read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${file}:`)) throw error;
    throw new Error(`${file}: audited file could not be read safely`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function findSecretPatternsInBytes({ file, bytes }) {
  const content = Buffer.isBuffer(bytes) ? bytes.toString('latin1') : Buffer.from(bytes).toString('latin1');
  const findings = [];
  for (const [category, pattern] of RULES) {
    if (pattern.test(content)) findings.push({ file, category });
  }
  return findings;
}

export function assertNoSecretBytes(options) {
  const findings = findSecretPatternsInBytes(options);
  if (findings.length) {
    throw new Error(`Secret scan failed:\n${findings
      .map(({ file, category }) => `${file}: ${category}`).join('\n')}`);
  }
  return { files: 1, findings: 0 };
}

export function findSecretPatterns({
  rootDirectory,
  files,
  scanAllBytes = false,
}) {
  const uniqueFiles = [...new Set(files)];
  const findings = [];
  let filesRead = 0;
  for (const file of uniqueFiles) {
    if (!scanAllBytes && BINARY_SUFFIXES.some((suffix) => file.endsWith(suffix))) continue;
    const bytes = readStableAuditedBytes(rootDirectory, file);
    filesRead += 1;
    findings.push(...findSecretPatternsInBytes({ file, bytes }));
  }
  return { filesRead, findings };
}

export function assertNoSecretPatterns(options) {
  const { filesRead, findings } = findSecretPatterns(options);
  if (findings.length) {
    throw new Error(`Secret scan failed:\n${findings
      .map(({ file, category }) => `${file}: ${category}`).join('\n')}`);
  }
  return { files: filesRead, findings: 0 };
}
