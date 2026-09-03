export function transitionRuleCardReview(card, { decision, reviewer, reviewedAt }) {
  if (!card) throw Object.assign(new Error('RULE_CARD_NOT_FOUND'), { code: 'RULE_CARD_NOT_FOUND' });
  if (!['approved', 'rejected'].includes(decision)) {
    throw Object.assign(new Error('RULE_CARD_REVIEW_INVALID'), { code: 'RULE_CARD_REVIEW_INVALID' });
  }
  if (card.status === decision) return { applied: false, card };
  if (card.status !== 'pending_review') {
    throw Object.assign(new Error('RULE_CARD_REVIEW_CONFLICT'), { code: 'RULE_CARD_REVIEW_CONFLICT' });
  }
  const reviewed_at = new Date(reviewedAt).toISOString();
  return {
    applied: true,
    card: {
      ...card,
      status: decision,
      reviewed_at,
      review_audit: [...(card.review_audit || []), { reviewer, decision, reviewed_at }],
    },
  };
}
