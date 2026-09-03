#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import { buildSpeakingCalibrationReport } from '../speaking/calibration.js';

function option(args, name) {
  const prefix = `--${name}=`;
  const matches = args.filter((argument) => argument === `--${name}` || argument.startsWith(prefix));
  if (matches.length > 1) throw new Error(`${name}: option must be provided at most once`);
  if (!matches.length) return null;
  if (!matches[0].startsWith(prefix) || !matches[0].slice(prefix.length).trim()) {
    throw new Error(`${name}: use --${name}=<value>`);
  }
  return matches[0].slice(prefix.length).trim();
}

async function readJson(file, label) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} could not be read as JSON: ${error.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((argument) => !argument.startsWith('--'));
  if (positional.length > 1) throw new Error('provide at most one dataset path');
  const datasetFile = path.resolve(positional[0] || 'quality/speaking-calibration-template.json');
  const outputOption = option(args, 'output');
  const approvalOption = option(args, 'approval');
  const reportVersion = option(args, 'report-version') || 'speaking-calibration-draft-v1';
  const dataset = await readJson(datasetFile, 'dataset');
  const approval = approvalOption ? await readJson(path.resolve(approvalOption), 'approval') : null;
  const report = buildSpeakingCalibrationReport(dataset, { reportVersion, approval });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputOption) {
    const outputFile = path.resolve(outputOption);
    await fs.mkdir(path.dirname(outputFile), { recursive: true });
    await fs.writeFile(outputFile, serialized, { encoding: 'utf8', flag: 'wx' });
    process.stderr.write(`speaking_calibration_report=${outputFile}\n`);
  } else {
    process.stdout.write(serialized);
  }
  process.stderr.write(`release_status=${report.releaseStatus}\nreport_digest=${report.reportDigest}\n`);
  if (report.releaseStatus !== 'validated') process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`speaking_calibration_error=${error.message}\n`);
  process.exitCode = 1;
});
