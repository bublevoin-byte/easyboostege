function catalogIdentity(catalog) {
  return Object.freeze({ version: catalog.version, revision: catalog.revision });
}

function catalogBranchTitle(catalog, suffix) {
  return `${catalog.version} ${suffix}`;
}

export function buildGrammarOpenApiCatalogOwnership({
  runtimes,
  activeTopicIds,
  preActivationTopicIds,
}) {
  const activeCatalogBranches = [];
  const activeCatalogIdentities = [];
  const legacyCatalogIdentities = [];
  const preActivationLegacyBranches = [];

  for (const runtime of runtimes) {
    const { catalog } = runtime;
    const identity = catalogIdentity(catalog);
    const runtimeActiveTopicIds = activeTopicIds.filter((topicId) => runtime.hasActivePractice(topicId));
    legacyCatalogIdentities.push(identity);
    if (runtimeActiveTopicIds.length) {
      activeCatalogBranches.push(Object.freeze({
        title: catalogBranchTitle(catalog, 'active catalog ownership'),
        catalog: identity,
        topicIds: Object.freeze(runtimeActiveTopicIds),
      }));
      activeCatalogIdentities.push(identity);
    }

    for (const topicId of preActivationTopicIds) {
      if (runtime.hasActivePractice(topicId)) continue;
      const levels = catalog.bank[topicId];
      if (!levels) continue;
      const itemIds = ['c', 'c2', 'f'].flatMap((kind) => (
        (levels[kind] || []).map((item) => item.id)
      ));
      if (!itemIds.length) continue;
      preActivationLegacyBranches.push(Object.freeze({
        title: catalogBranchTitle(catalog, `topic ${topicId} pre-activation legacy ownership`),
        catalog: identity,
        topicId,
        itemIds: Object.freeze(itemIds),
      }));
    }
  }

  return Object.freeze({
    activeCatalogBranches: Object.freeze(activeCatalogBranches),
    activeCatalogIdentities: Object.freeze(activeCatalogIdentities),
    legacyCatalogIdentities: Object.freeze(legacyCatalogIdentities),
    preActivationLegacyBranches: Object.freeze(preActivationLegacyBranches),
  });
}
