#!/usr/bin/env node
// Downloads the official FIPI assessment manuals used to build the release quality set.
// The PDFs are not committed: they belong to Rosobrnadzor/FIPI and are fetched on demand.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetDirectory = path.join(__dirname, '..', 'quality', 'sources');

const YEARS = [2023, 2024, 2025, 2026];
const PARTS = [
  { code: 'pch', label: 'письменная часть (задания 37 и 38)' },
  { code: 'uch', label: 'устная часть (задания 1–4)' },
];

function documentUrl(year, code) {
  return `https://doc.fipi.ru/ege/dlya-predmetnyh-komissiy-subektov-rf/${year}/angl_yaz_${code}_mr_ege_${year}.pdf`;
}

async function download(url, file) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.subarray(0, 4).toString('latin1') !== '%PDF') throw new Error(`${url} → not a PDF`);
  await fs.writeFile(file, buffer);
  return buffer.length;
}

async function main() {
  await fs.mkdir(targetDirectory, { recursive: true });
  let failed = 0;
  for (const year of YEARS) {
    for (const part of PARTS) {
      const file = path.join(targetDirectory, `fipi-${part.code}-${year}.pdf`);
      try {
        const bytes = await download(documentUrl(year, part.code), file);
        console.log(`ok    ${path.basename(file)}  ${(bytes / 1048576).toFixed(1)} MB  ${part.label}`);
      } catch (error) {
        failed += 1;
        console.log(`fail  ${path.basename(file)}  ${error.message}`);
      }
    }
  }
  console.log(`\nСохранено в ${targetDirectory}`);
  console.log('Текст извлекается командой: pdftotext -enc UTF-8 -layout <файл>.pdf <файл>.txt');
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
