import { EGE_MOCK_ASSETS, egeMockAssetIdsForContentRef } from './assets.js';
import { EGE_MOCK_FORM_CONTENT } from './content.js';
import { deepFreeze } from './immutable.js';

const POSITION_MAX_SCORES = Object.freeze([
  2, 3, 1, 1, 1, 1, 1, 1, 1,
  3, 2, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  6, 14,
  1, 4, 5, 10,
]);

const contentByPosition = new Map(EGE_MOCK_FORM_CONTENT.positions.map((item) => [item.position, item]));

export const EGE_MOCK_RELEASE = deepFreeze({
  assets: EGE_MOCK_ASSETS,
  stimuli: EGE_MOCK_FORM_CONTENT.stimuli,
  positions: POSITION_MAX_SCORES.map((maxScore, index) => {
    const position = index + 1;
    const content = contentByPosition.get(position);
    if (!content?.contentRef || !content.presentation || !content.assessment) {
      throw new Error(`EGE_MOCK_RELEASE_POSITION_MISSING: ${position}`);
    }
    if (content.assessment.maxScore !== maxScore) {
      throw new Error(`EGE_MOCK_RELEASE_SCORE_DRIFT: ${position}`);
    }
    return {
      position,
      maxScore,
      contentRef: content.contentRef,
      presentation: content.presentation,
      assessment: content.assessment,
      assetIds: egeMockAssetIdsForContentRef(content.contentRef),
    };
  }),
});

export function resolveEgeMockContentRef(contentRef) {
  if (!contentRef || typeof contentRef !== 'object') return null;
  return EGE_MOCK_RELEASE.positions.find(({ contentRef: candidate }) => (
    candidate.catalogId === contentRef.catalogId
      && candidate.id === contentRef.id
      && candidate.revision === contentRef.revision
  )) || null;
}
