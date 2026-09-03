import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GRAMMAR_CATALOG_RUNTIMES,
} from '../public/grammar-catalog.js';
import {
  GRAMMAR_ACTIVE_TOPIC_IDS,
  GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS,
} from '../public/grammar-domain-contract.js';
import {
  buildGrammarOpenApiCatalogOwnership,
} from '../scripts/grammar-openapi-catalog-contract.js';

test('Grammar OpenAPI catalog ownership is derived from every registered runtime', () => {
  const ownership = buildGrammarOpenApiCatalogOwnership({
    runtimes: GRAMMAR_CATALOG_RUNTIMES,
    activeTopicIds: GRAMMAR_ACTIVE_TOPIC_IDS,
    preActivationTopicIds: GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS,
  });

  for (const runtime of GRAMMAR_CATALOG_RUNTIMES) {
    const catalog = runtime.catalog;
    const expectedActiveTopics = GRAMMAR_ACTIVE_TOPIC_IDS.filter((topicId) => (
      runtime.hasActivePractice(topicId)
    ));
    const activeBranch = ownership.activeCatalogBranches.find((branch) => (
      branch.catalog.version === catalog.version && branch.catalog.revision === catalog.revision
    ));
    assert.deepEqual(activeBranch?.topicIds || [], expectedActiveTopics,
      `${catalog.version} active capabilities are registry-derived`);
    assert.equal(ownership.legacyCatalogIdentities.some((identity) => (
      identity.version === catalog.version && identity.revision === catalog.revision
    )), true, `${catalog.version} is accepted by the registry-derived legacy session union`);

    for (const topicId of GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS) {
      const hasBranch = ownership.preActivationLegacyBranches.some((branch) => (
        branch.catalog.version === catalog.version
        && branch.catalog.revision === catalog.revision
        && branch.topicId === topicId
      ));
      assert.equal(hasBranch, !runtime.hasActivePractice(topicId),
        `${catalog.version} topic ${topicId} pre-activation ownership matches runtime capability`);
    }
  }
});

test('Grammar OpenAPI ownership automatically includes a newly registered catalog runtime', () => {
  const nextRuntime = {
    catalog: {
      version: 'grammar-core-v4', revision: 4,
      bank: {
        14: { c: [{ id: 'core.g.14.c.1' }], c2: [], f: [{ id: 'core.g.14.f.1' }] },
        15: { c: [{ id: 'core.g.15.c.1' }], c2: [], f: [{ id: 'core.g.15.f.1' }] },
      },
    },
    hasActivePractice(topicId) { return topicId === 14; },
  };
  const ownership = buildGrammarOpenApiCatalogOwnership({
    runtimes: [...GRAMMAR_CATALOG_RUNTIMES, nextRuntime],
    activeTopicIds: GRAMMAR_ACTIVE_TOPIC_IDS,
    preActivationTopicIds: GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS,
  });

  assert.deepEqual(ownership.activeCatalogBranches.at(-1), {
    title: 'grammar-core-v4 active catalog ownership',
    catalog: { version: 'grammar-core-v4', revision: 4 },
    topicIds: [14],
  });
  assert.deepEqual(ownership.activeCatalogIdentities.at(-1), {
    version: 'grammar-core-v4', revision: 4,
  });
  assert.deepEqual(ownership.legacyCatalogIdentities.at(-1), {
    version: 'grammar-core-v4', revision: 4,
  });
  assert.deepEqual(ownership.preActivationLegacyBranches.filter((branch) => (
    branch.catalog.version === 'grammar-core-v4'
  )).map(({ topicId, itemIds }) => ({ topicId, itemIds })), [{
    topicId: 15,
    itemIds: ['core.g.15.c.1', 'core.g.15.f.1'],
  }]);
});
