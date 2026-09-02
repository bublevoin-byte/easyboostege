import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const RELEASE_MARKER_START = '/* build:release-version */';
export const RELEASE_MARKER_END = '/* end build:release-version */';

function releaseNeutralWorker(workerSource) {
  const start = workerSource.indexOf(RELEASE_MARKER_START);
  const end = workerSource.indexOf(RELEASE_MARKER_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('public/service-worker.js потерял markers build:release-version');
  }
  return `${workerSource.slice(0, start)}${RELEASE_MARKER_START}\nconst RELEASE_VERSION='CONTENT_ADDRESS';\n${workerSource.slice(end)}`;
}

function shellFile(directory, shellUrl) {
  const url = new URL(shellUrl, 'https://aisy.invalid');
  if (url.origin !== 'https://aisy.invalid' || !url.pathname.startsWith('/')) {
    throw new Error(`APP_SHELL содержит недопустимый URL: ${shellUrl}`);
  }
  const relative = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  const resolved = path.resolve(directory, relative);
  const outside = path.relative(path.resolve(directory), resolved);
  if (outside.startsWith('..') || path.isAbsolute(outside)) {
    throw new Error(`APP_SHELL выходит за каталог сборки: ${shellUrl}`);
  }
  return resolved;
}

export async function computePwaReleaseVersion({ directory, shell, workerSource }) {
  const digest = crypto.createHash('sha256');
  digest.update('aisy-pwa-release-v1\0');
  digest.update(releaseNeutralWorker(workerSource));
  digest.update('\0');
  for (const shellUrl of [...new Set(shell)].sort()) {
    const content = await fs.readFile(shellFile(directory, shellUrl));
    digest.update(shellUrl);
    digest.update('\0');
    digest.update(String(content.length));
    digest.update('\0');
    digest.update(content);
    digest.update('\0');
  }
  return `sha256-${digest.digest('hex')}`;
}

export function injectPwaReleaseVersion(workerSource, releaseVersion) {
  if (!/^sha256-[a-f0-9]{64}$/u.test(releaseVersion)) {
    throw new Error(`Некорректная content-addressed PWA version: ${releaseVersion}`);
  }
  const start = workerSource.indexOf(RELEASE_MARKER_START);
  const end = workerSource.indexOf(RELEASE_MARKER_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('public/service-worker.js потерял markers build:release-version');
  }
  return `${workerSource.slice(0, start)}${RELEASE_MARKER_START}\nconst RELEASE_VERSION='${releaseVersion}';\n${workerSource.slice(end)}`;
}
