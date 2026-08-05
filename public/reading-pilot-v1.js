import {
  READING_CATALOG_ID,
  READING_CONTRACT_VERSION,
  assertReadingCatalog,
  deepFreezeReadingCatalog,
} from './reading-catalog-contract.js';

const SHARD_KINDS = ['task10', 'task11', 'task12_18'];

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
