import fs from 'node:fs/promises';

import { syncEgeWritingOpenApiContract } from './ege-writing-openapi-contract.js';
import { syncGrammarOpenApiContract } from './grammar-openapi-contract.js';

const openApiUrl = new URL('../docs/openapi.yaml', import.meta.url);
const original = (await fs.readFile(openApiUrl, 'utf8')).replace(/\r\n/gu, '\n');
const generated = syncGrammarOpenApiContract(syncEgeWritingOpenApiContract(original));

if (process.argv.includes('--check')) {
  if (generated !== original) {
    throw new Error('OpenAPI generated contracts are stale; run npm run openapi:grammar:sync');
  }
} else {
  await fs.writeFile(openApiUrl, generated, 'utf8');
}
