function entry(adaptiveSkillId, modules) {
  return Object.freeze({ adaptiveSkillId, modules: Object.freeze([...modules]) });
}

export const VOICE_TUTOR_SKILL_COMPATIBILITY = Object.freeze({
  version: 'voice-tutor-skill-compat-v2',
  exact: Object.freeze({
    'ege.grammar.past_simple': entry('ege.grammar.forms', ['grammar']),
    'ege.grammar.future_passive': entry('ege.grammar.forms', ['grammar']),
    'ege.vocabulary.meaning_in_context': entry('ege.vocabulary.lexical_choice', ['vocabulary']),
    'ege.reading.evidence': entry('ege.reading.detail', ['reading']),
    'ege.listening.evidence': entry('ege.listening.detail', ['listening']),
    'ege.speaking.interaction': entry('ege.speaking.direct_questions', ['speaking']),
    'ege.speaking.monologue': entry('ege.speaking.monologue_content', ['speaking']),
    'ege.speaking.4.criterion.1': entry('ege.speaking.monologue_content', ['speaking']),
    'ege.speaking.4.criterion.2': entry('ege.speaking.monologue_organization', ['speaking']),
    'ege.speaking.4.criterion.3': entry(null, ['speaking']),
  }),
  families: Object.freeze([
    Object.freeze({ prefix: 'ege.word_formation.', ...entry('ege.vocabulary.word_formation', ['grammar', 'vocabulary']) }),
    Object.freeze({ prefix: 'ege.collocation.', ...entry('ege.vocabulary.lexical_choice', ['grammar', 'vocabulary']) }),
    Object.freeze({ prefix: 'ege.grammar.topic_', ...entry('ege.grammar.forms', ['grammar']) }),
    Object.freeze({ prefix: 'ege.grammar.generated_', ...entry('ege.grammar.forms', ['grammar']) }),
    Object.freeze({ prefix: 'ege.vocabulary.lexeme_', ...entry('ege.vocabulary.lexical_choice', ['vocabulary']) }),
    Object.freeze({ prefix: 'ege.vocabulary.generated_', ...entry('ege.vocabulary.lexical_choice', ['vocabulary']) }),
    Object.freeze({ prefix: 'ege.writing.writing_37.criterion.', ...entry('ege.writing.email', ['writing']) }),
    Object.freeze({ prefix: 'ege.writing.email.criterion.', ...entry('ege.writing.email', ['writing']) }),
    Object.freeze({ prefix: 'ege.writing.writing_38.criterion.', ...entry('ege.writing.essay', ['writing']) }),
    Object.freeze({ prefix: 'ege.writing.essay.criterion.', ...entry('ege.writing.essay', ['writing']) }),
    Object.freeze({ prefix: 'ege.speaking.1.criterion.', ...entry('ege.speaking.reading_aloud', ['speaking']) }),
    Object.freeze({ prefix: 'ege.speaking.2.criterion.', ...entry('ege.speaking.direct_questions', ['speaking']) }),
    Object.freeze({ prefix: 'ege.speaking.3.criterion.', ...entry('ege.speaking.interview_completeness', ['speaking']) }),
  ]),
});

export function resolveVoiceTutorAdaptiveSkill(skillId, module) {
  const normalized = String(skillId || '').trim().toLocaleLowerCase('en');
  if (!normalized) return Object.freeze({ recognized: false, adaptiveSkillId: null });
  const exact = VOICE_TUTOR_SKILL_COMPATIBILITY.exact[normalized];
  const familyMatches = exact ? [] : VOICE_TUTOR_SKILL_COMPATIBILITY.families
    .filter((family) => normalized.startsWith(family.prefix))
    .sort((left, right) => right.prefix.length - left.prefix.length);
  const descriptor = exact || familyMatches[0] || null;
  if (!descriptor) return Object.freeze({ recognized: false, adaptiveSkillId: null });
  return Object.freeze({
    recognized: true,
    adaptiveSkillId: descriptor.modules.includes(module) ? descriptor.adaptiveSkillId : null,
  });
}
