import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CANDIDATE_MANIFEST = 'scripts/aisy-release-candidate-files.json';

function repositoryPath(value) {
  return value.split(path.sep).join('/').replace(/^\.\//u, '').replace(/\/$/u, '');
}

function resolveInside(projectDirectory, name, label) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name)
      || name.split(/[\\/]/u).includes('..')) {
    throw new Error(`${label} must stay inside the repository: ${name}`);
  }
  const resolved = path.resolve(projectDirectory, name);
  const relative = path.relative(projectDirectory, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the repository: ${name}`);
  }
  return { resolved, relative: repositoryPath(relative) };
}

export function parseCandidateFileManifest({
  projectDirectory,
  manifestName = DEFAULT_CANDIDATE_MANIFEST,
  source,
} = {}) {
  const { relative: relativeManifest } = resolveInside(
    projectDirectory, manifestName, 'Candidate manifest',
  );
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('Invalid release candidate file manifest');
  }
  if (parsed.schemaVersion !== 'aisy-release-candidate-files-v1'
      || !Array.isArray(parsed.files) || !parsed.files.length) {
    throw new Error('Invalid release candidate file manifest');
  }
  const normalized = parsed.files.map((file) => {
    const { resolved, relative } = resolveInside(projectDirectory, file, 'Candidate path');
    if (!fs.lstatSync(resolved).isFile()) throw new Error(`Missing candidate file: ${file}`);
    return relative;
  });
  if (!normalized.includes(relativeManifest)) throw new Error('Candidate manifest must include itself');
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Candidate manifest contains duplicate paths');
  }
  if (JSON.stringify([...normalized].sort()) !== JSON.stringify(normalized)) {
    throw new Error('Candidate manifest paths must be sorted');
  }
  return normalized;
}

export function readCandidateFileManifest({
  projectDirectory,
  manifestName = DEFAULT_CANDIDATE_MANIFEST,
} = {}) {
  const { resolved: manifestPath } = resolveInside(
    projectDirectory, manifestName, 'Candidate manifest',
  );
  return parseCandidateFileManifest({
    projectDirectory,
    manifestName,
    source: fs.readFileSync(manifestPath, 'utf8'),
  });
}

export function gitTrackedFiles(projectDirectory) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: projectDirectory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\0').filter(Boolean).map(repositoryPath);
}

export function validateAuditedPathSet(files) {
  const canonicalPaths = new Map();
  const normalizedFiles = [];
  for (const file of files) {
    if (typeof file !== 'string' || /[\u0000-\u001f\u007f]/u.test(file)) {
      throw new Error(`Audited path contains a control character: ${JSON.stringify(file)}`);
    }
    const normalized = repositoryPath(file);
    const canonical = normalized.normalize('NFC').toLocaleLowerCase('en-US');
    const previous = canonicalPaths.get(canonical);
    if (previous && previous !== normalized) {
      throw new Error(`Audited path collision: ${previous} <> ${normalized}`);
    }
    canonicalPaths.set(canonical, normalized);
    normalizedFiles.push(normalized);
  }
  return normalizedFiles;
}

function dockerGlobExpression(pattern) {
  if (/[\[\]{}\\]/u.test(pattern) || pattern.includes('**')) {
    throw new Error(`Unsupported .dockerignore pattern: ${pattern}`);
  }
  let expression = '';
  for (const character of pattern) {
    if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[.+^$()|]/u, '\\$&');
  }
  return expression;
}

export function parseDockerignore(source) {
  const rules = [];
  for (const rawLine of source.split(/\r?\n/u)) {
    if (!rawLine) continue;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    let pattern = negated ? line.slice(1) : line;
    if (!pattern || pattern === '.' || pattern.includes('\0')) {
      throw new Error(`Unsupported .dockerignore pattern: ${rawLine}`);
    }
    pattern = pattern.replace(/^\//u, '').replace(/\/$/u, '');
    const expression = dockerGlobExpression(pattern);
    const hasDirectory = pattern.includes('/');
    rules.push({
      negated,
      pattern,
      expression: new RegExp(
        hasDirectory ? `^${expression}(?:/.*)?$` : `(?:^|/)${expression}(?:/.*)?$`, 'u',
      ),
    });
  }
  return rules;
}

export function dockerContextIgnores(rules, candidate) {
  const normalized = repositoryPath(candidate);
  let ignored = false;
  for (const rule of rules) {
    if (rule.expression.test(normalized)) ignored = !rule.negated;
  }
  return ignored;
}

function normalizeCopySource(source) {
  if (!source || path.isAbsolute(source) || source.startsWith('/') || source.startsWith('~')
      || source.includes('$') || /[*?\[\]]/u.test(source)
      || source.split(/[\\/]/u).includes('..')) {
    throw new Error(`Unsupported Docker COPY source: ${source}`);
  }
  const normalized = repositoryPath(source);
  if (!normalized || normalized === '.') throw new Error('Docker COPY of the whole workspace is forbidden');
  return normalized;
}

export function parseDockerCopySources(dockerfile) {
  const sources = [];
  for (const rawLine of dockerfile.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (/^ADD\b/iu.test(line)) throw new Error(`Unsupported Docker ADD instruction: ${line}`);
    if (/^RUN\b.*--mount=[^\s]*\btype=bind\b/iu.test(line)) {
      throw new Error(`Unsupported Docker build-context bind mount: ${line}`);
    }
    if (!/^COPY\b/iu.test(line)) continue;
    if (line.endsWith('\\')) throw new Error(`Unsupported continued Docker COPY: ${line}`);
    const instruction = line.slice(4).trim();
    if (instruction.startsWith('[') || instruction.includes('"') || instruction.includes("'")) {
      throw new Error(`Unsupported JSON/quoted Docker COPY: ${line}`);
    }
    const tokens = instruction.split(/\s+/u);
    let fromAnotherStage = false;
    while (tokens[0]?.startsWith('--')) {
      const flag = tokens.shift();
      if (flag === '--from') {
        if (!tokens.shift()) throw new Error(`Invalid Docker COPY --from: ${line}`);
        fromAnotherStage = true;
      } else if (flag.startsWith('--from=')) fromAnotherStage = true;
      else if (!flag.startsWith('--chown=')) throw new Error(`Unsupported Docker COPY flag: ${flag}`);
    }
    if (fromAnotherStage) continue;
    if (tokens.length < 2) throw new Error(`Docker COPY must have source and destination: ${line}`);
    sources.push(...tokens.slice(0, -1).map(normalizeCopySource));
  }
  if (!sources.length) throw new Error('Dockerfile has no build-context COPY sources');
  return [...new Set(sources)].sort();
}

function assertSymlinkContained(projectDirectory, absolute, relative) {
  const target = fs.realpathSync(absolute);
  const targetRelative = path.relative(projectDirectory, target);
  if (targetRelative.startsWith('..') || path.isAbsolute(targetRelative)) {
    throw new Error(`Docker context symlink escapes the repository: ${relative}`);
  }
}

export function verifyDockerBuildContext({
  projectDirectory = fileURLToPath(new URL('..', import.meta.url)),
  dockerfileName = 'Dockerfile',
  dockerignoreName = '.dockerignore',
  candidateManifestName = DEFAULT_CANDIDATE_MANIFEST,
  trackedFiles,
  candidateFiles,
  dockerfileSource,
  dockerignoreSource,
} = {}) {
  const dockerfileOverride = path.join(projectDirectory, `${dockerfileName}.dockerignore`);
  if (fs.existsSync(dockerfileOverride)) {
    throw new Error(`Unsupported Dockerfile-specific ignore file: ${repositoryPath(
      path.relative(projectDirectory, dockerfileOverride),
    )}`);
  }
  const dockerfile = dockerfileSource
    ?? fs.readFileSync(path.join(projectDirectory, dockerfileName), 'utf8');
  const dockerignore = dockerignoreSource
    ?? fs.readFileSync(path.join(projectDirectory, dockerignoreName), 'utf8');
  if (typeof dockerfile !== 'string' || typeof dockerignore !== 'string') {
    throw new Error('Frozen Docker control sources must be UTF-8 text');
  }
  const ignoreRules = parseDockerignore(dockerignore);
  const copySources = parseDockerCopySources(dockerfile);
  const tracked = (trackedFiles ?? gitTrackedFiles(projectDirectory)).map(repositoryPath);
  const explicit = candidateFiles ?? readCandidateFileManifest({
    projectDirectory, manifestName: candidateManifestName,
  });
  const expected = new Set(validateAuditedPathSet([...tracked, ...explicit]));
  const reachable = new Set();

  const visit = (absolute, relative) => {
    const normalized = repositoryPath(relative);
    if (dockerContextIgnores(ignoreRules, normalized)) return;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      assertSymlinkContained(projectDirectory, absolute, normalized);
      reachable.add(normalized);
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
        visit(path.join(absolute, entry.name), `${normalized}/${entry.name}`);
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsupported Docker context filesystem entry: ${normalized}`);
    reachable.add(normalized);
  };

  for (const source of copySources) {
    const { resolved, relative } = resolveInside(projectDirectory, source, 'Docker COPY source');
    if (!fs.existsSync(resolved)) throw new Error(`Missing Docker COPY source: ${source}`);
    if (dockerContextIgnores(ignoreRules, relative)) {
      throw new Error(`Docker COPY source is excluded by .dockerignore: ${source}`);
    }
    visit(resolved, relative);
  }

  const listed = [...reachable].sort();
  const unexpected = listed.filter((file) => !expected.has(file));
  if (unexpected.length) {
    throw new Error(`Docker context contains untracked reachable paths:\n${unexpected.join('\n')}`);
  }
  return {
    copySources,
    reachable: listed,
    unexpected,
    tracked: tracked.length,
    explicit: explicit.length,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const verified = verifyDockerBuildContext();
    console.log(`Docker context guard passed (${verified.reachable.length} reachable COPY files).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
