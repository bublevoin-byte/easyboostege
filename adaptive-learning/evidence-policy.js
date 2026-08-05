export const SERVER_ASSESSED_MODULES = Object.freeze(['writing', 'speaking']);

const SERVER_ASSESSED_MODULE_SET = new Set(SERVER_ASSESSED_MODULES);

export function requiresServerAssessment(module) {
  return SERVER_ASSESSED_MODULE_SET.has(module);
}
