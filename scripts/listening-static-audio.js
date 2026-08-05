import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LISTENING_AUDIO_DEFAULT_PRICE_USD_PER_MILLION,
  LISTENING_AUDIO_PAID_CONFIRMATION,
  createXaiTtsProvider,
  runListeningAudioPipeline,
} from '../audio/listening-static-audio.js';
import { LISTENING_PILOT_CATALOG } from '../public/listening-pilot-v1.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const publicDirectory = path.join(projectDirectory, 'public');
const manifestPath = path.join(
  publicDirectory, 'audio', 'listening', 'listening-pilot-v1', 'manifest.json',
);

function parseArguments(argv) {
  const parsed = {
    paid: false,
    confirmation: '',
    priceUsdPerMillion: LISTENING_AUDIO_DEFAULT_PRICE_USD_PER_MILLION,
    summaryOnly: false,
  };
  argv.forEach((argument) => {
    if (argument === '--paid') parsed.paid = true;
    else if (argument === '--summary') parsed.summaryOnly = true;
    else if (argument.startsWith('--confirm-paid=')) parsed.confirmation = argument.slice('--confirm-paid='.length);
    else if (argument.startsWith('--usd-per-million=')) parsed.priceUsdPerMillion = Number(argument.slice('--usd-per-million='.length));
    else throw new Error(`Unknown argument: ${argument}`);
  });
  if (!parsed.paid && parsed.confirmation) throw new Error('--confirm-paid requires --paid');
  return parsed;
}

function printSummary(result, { summaryOnly }) {
  if (!summaryOnly) result.missing.forEach((assetPath) => process.stdout.write(`missing=${assetPath}\n`));
  process.stdout.write(`mode=${result.mode}\n`);
  process.stdout.write(`catalog=${result.catalogId}@r${result.catalogRevision}\n`);
  process.stdout.write(`sets=${result.setCount}\n`);
  process.stdout.write(`requests=${result.requestCount}\n`);
  process.stdout.write(`assets=${result.assetCount}\n`);
  process.stdout.write(`missing_assets=${result.missingCount}\n`);
  process.stdout.write(`characters=${result.characterCount}\n`);
  process.stdout.write(`usd_per_million=${result.priceUsdPerMillion}\n`);
  process.stdout.write(`estimated_usd=${result.estimatedUsd.toFixed(6)}\n`);
  if (result.mode === 'generate') {
    process.stdout.write(`generated_assets=${result.generatedCount}\n`);
    process.stdout.write(`skipped_assets=${result.skippedCount}\n`);
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const paidConfirmed = args.confirmation === LISTENING_AUDIO_PAID_CONFIRMATION;
  const apiKey = process.env.XAI_API_KEY || '';
  const provider = args.paid && paidConfirmed && apiKey
    ? createXaiTtsProvider({ apiKey })
    : undefined;
  const result = await runListeningAudioPipeline({
    catalog: LISTENING_PILOT_CATALOG,
    publicDirectory,
    manifestPath,
    mode: args.paid ? 'generate' : 'dry-run',
    priceUsdPerMillion: args.priceUsdPerMillion,
    paidConfirmed,
    apiKey,
    provider,
  });
  printSummary(result, args);
}

main().catch((error) => {
  process.stderr.write(`Listening audio pipeline failed: ${error.message}\n`);
  process.exitCode = 1;
});
