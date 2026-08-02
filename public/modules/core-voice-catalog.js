function pointer(id) {
  return Object.freeze({ id, revision: 1 });
}

export function decorateCoreVocabulary(words) {
  words.forEach((word, index) => {
    const prefix = `core.v.${index + 1}`;
    word.voice_tutor = Object.freeze({
      c1: pointer(`${prefix}.c1`),
      c2: pointer(`${prefix}.c2`),
      type: pointer(`${prefix}.type`),
    });
  });
  return words;
}

export function coreVocabularyVoice(word, mode) {
  return word?.voice_tutor?.[mode] || word?.voice || null;
}

export function decorateCoreGrammar(bank, exams) {
  Object.entries(bank).forEach(([topicId, levels]) => {
    for (const kind of ['c', 'c2', 'f']) {
      (levels?.[kind] || []).forEach((item, index) => {
        item.voice = pointer(`core.g.${topicId}.${kind}.${index + 1}`);
      });
    }
  });
  exams.forEach((exam, examIndex) => {
    (exam.gaps || []).forEach((gap, gapIndex) => {
      gap.voice = pointer(`core.g.exam.${examIndex + 1}.${gapIndex + 1}`);
    });
  });
  return { bank, exams };
}

export function coreGrammarVoice(item) {
  return item?.voice || null;
}
