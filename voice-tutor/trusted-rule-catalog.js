export function createConfiguredRuleSearchProvider(sourceCatalog = {}) {
  const catalog = structuredClone(sourceCatalog && typeof sourceCatalog === 'object' ? sourceCatalog : {});
  return Object.freeze({
    async search({ skill }) {
      const urls = catalog[skill.id];
      return Array.isArray(urls) ? [...urls] : [];
    },
  });
}
