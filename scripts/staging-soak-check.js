import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const baseUrl = new URL(process.env.STAGING_SOAK_URL || 'https://staging.useboost.ru');
const outputDirectory = path.resolve(process.env.STAGING_SOAK_DIR || 'soak-results');
const historyFile = path.join(outputDirectory, 'staging-soak.ndjson');
const statusFile = path.join(outputDirectory, 'staging-soak-status.json');
const requiredDays = 7;

async function probe(url) {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'EasyBoost-Staging-Soak/1.0' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      bodyValid: url.pathname === '/health/ready' ? body.includes('ready') : body.length > 0,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      bodyValid: false,
      error: error.name,
    };
  }
}

await fs.mkdir(outputDirectory, { recursive: true });
const checkedAt = new Date();
const ready = await probe(new URL('/health/ready', baseUrl));
const homepage = await probe(new URL('/', baseUrl));
const success = ready.ok && ready.bodyValid && homepage.ok && homepage.bodyValid;
const sample = { checkedAt: checkedAt.toISOString(), success, ready, homepage };
await fs.appendFile(historyFile, `${JSON.stringify(sample)}\n`, { encoding: 'utf8', mode: 0o600 });

const lines = (await fs.readFile(historyFile, 'utf8')).trim().split('\n').filter(Boolean);
const samples = lines.map((line) => JSON.parse(line));
const firstAt = new Date(samples[0].checkedAt);
const elapsedDays = (checkedAt - firstAt) / 86_400_000;
const successfulSamples = samples.filter((entry) => entry.success).length;
const status = {
  startedAt: firstAt.toISOString(),
  checkedAt: checkedAt.toISOString(),
  requiredDays,
  elapsedDays: Math.round(elapsedDays * 1000) / 1000,
  samples: samples.length,
  successfulSamples,
  failedSamples: samples.length - successfulSamples,
  currentSuccess: success,
  complete: elapsedDays >= requiredDays && successfulSamples === samples.length,
};
const temporary = `${statusFile}.${process.pid}.tmp`;
await fs.writeFile(temporary, JSON.stringify(status, null, 2), { mode: 0o600 });
await fs.rename(temporary, statusFile);
console.log(JSON.stringify(status));
if (!success) process.exitCode = 1;
