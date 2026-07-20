import fs from 'node:fs/promises';
import { calculateQualityMetrics, evaluateQualityGate, validateQualityDataset } from '../ai/quality.js';

const args = process.argv.slice(2);
const release = args.includes('--release');
const file = args.find((arg) => !arg.startsWith('--')) || 'quality/engineering-smoke.json';
const cases = JSON.parse(await fs.readFile(file, 'utf8'));
const validation = validateQualityDataset(cases, { release });
if (!validation.ok) {
  console.error(JSON.stringify({ validation }, null, 2));
  process.exitCode = 1;
} else {
  const metrics = calculateQualityMetrics(cases);
  const gate = evaluateQualityGate(metrics);
  console.log(JSON.stringify({ dataset: file, release, counts: validation.counts, metrics, gate }, null, 2));
  if (release && !gate.pass) process.exitCode = 1;
}
