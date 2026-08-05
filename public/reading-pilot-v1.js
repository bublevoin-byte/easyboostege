import {
  READING_CATALOG_ID,
  READING_CONTRACT_VERSION,
  assertReadingCatalog,
  deepFreezeReadingCatalog,
} from './reading-catalog-contract.js';

const SHARD_KINDS = ['task10', 'task11', 'task12_18'];
let catalogPromise;

function completeShard(shards, kind) {
  const shard = shards?.[kind];
  if (!Array.isArray(shard)) throw new TypeError(`${kind} shard must be an array`);
  if (shard.length !== 20) throw new TypeError(`${kind} shard must contain exactly 20 sets`);
  return shard;
}

export function assembleReadingPilotCatalog(shards) {
  const catalog = {
    id: READING_CATALOG_ID,
    revision: 1,
    validation: { contract: READING_CONTRACT_VERSION },
    sets: SHARD_KINDS.flatMap((kind) => completeShard(shards, kind)),
  };
  assertReadingCatalog(catalog);
  return deepFreezeReadingCatalog(catalog);
}

export async function loadReadingTask10Shard() {
  const { READING_TASK10_SETS } = await import('./content/reading/task10-v1.js');
  return READING_TASK10_SETS;
}

export async function loadReadingTask11Shard() {
  const { READING_TASK11_SETS } = await import('./content/reading/task11-v1.js');
  return READING_TASK11_SETS;
}

export async function loadReadingTask12Shard() {
  const { READING_TASK12_18_SETS } = await import('./content/reading/task12-18-v1.js');
  return READING_TASK12_18_SETS;
}

export function loadReadingPilotCatalog() {
  if (!catalogPromise) {
    catalogPromise = Promise.all([
      loadReadingTask10Shard(),
      loadReadingTask11Shard(),
      loadReadingTask12Shard(),
    ]).then(([task10, task11, task12_18]) => assembleReadingPilotCatalog({ task10, task11, task12_18 }))
      .catch((error) => {
        catalogPromise = undefined;
        throw error;
      });
  }
  return catalogPromise;
}
