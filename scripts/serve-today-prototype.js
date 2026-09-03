import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const prototypeDirectory = path.join(projectDirectory, 'public', 'prototypes', 'today-v1');
const routePrefix = '/prototypes/today-v1/';
const port = Number.parseInt(process.env.AISY_TODAY_PROTOTYPE_PORT || '4173', 10);
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
]);

function resolvePrototypeRequest(pathname) {
  if (pathname === '/') return { kind: 'redirect' };
  if (!pathname.startsWith(routePrefix)) return { kind: 'not-found' };
  let relative;
  try {
    relative = decodeURIComponent(pathname.slice(routePrefix.length)) || 'index.html';
  } catch {
    return { kind: 'bad-request' };
  }
  const candidate = path.resolve(prototypeDirectory, relative);
  if (candidate !== prototypeDirectory && !candidate.startsWith(`${prototypeDirectory}${path.sep}`)) {
    return { kind: 'not-found' };
  }
  return { kind: 'file', path: candidate };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const target = resolvePrototypeRequest(url.pathname);
  if (target.kind === 'redirect') {
    response.writeHead(302, { Location: `${routePrefix}${url.search}` });
    response.end();
    return;
  }
  if (target.kind === 'not-found') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Prototype route only');
    return;
  }
  if (target.kind === 'bad-request') {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Malformed prototype path');
    return;
  }
  try {
    const content = await fs.readFile(target.path);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Content-Type': contentTypes.get(path.extname(target.path)) || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(content);
  } catch (error) {
    response.writeHead(error?.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(error?.code === 'ENOENT' ? 'Not found' : 'Prototype server error');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Aisy Today PROTOTYPE: http://127.0.0.1:${port}${routePrefix}?variant=A`);
});
