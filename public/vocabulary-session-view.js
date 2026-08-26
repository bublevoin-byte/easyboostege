function createVocabularySessionView({
  escapeHtml, decoration, badge, speaker, handlerValue, requestFrame, setPrimaryAction,
}) {
  const frame = (item, title, kicker, content) => decoration() + badge(item)
    + `<div class="vocab-task"><p class="vocab-kicker">${kicker}</p>`
    + `<h1 id="w_session_title" tabindex="-1">${title}</h1>${content}</div>`;

  const answerInput = (label, token) => `<label class="vocab-answer-label" for="w_session_input">${label}</label>`
    + `<input id="w_session_input" class="vocab-answer-input" aria-label="${label}" autocapitalize="none" `
    + 'autocomplete="off" spellcheck="false" onkeydown="if(event.key===\'Enter\')wSubmitSession(' + token + ')">';

  const feedbackDetails = (item) => {
    const pronunciation = item.ipa
      ? `<p><strong>Произношение:</strong> ${escapeHtml(item.ipa)}</p>`
      : '';
    const context = item.ex
      ? `<p lang="en">${escapeHtml(item.ex)}</p>`
      : '<p class="is-missing">Контекст пока не добавлен</p>';
    return pronunciation + context;
  };

  const feedbackStatus = (result) => {
    if (result.outcome === 'almost') return 'Почти — небольшая опечатка';
    if (result.outcome === 'not_known') return 'Не знаю — теперь разберём';
    if (result.outcome === 'incorrect') return 'Пока не получилось';
    if (result.outcome === 'knew') return 'Отмечено: знал(а)';
    return result.independentSuccess ? 'Верно — самостоятельно' : 'Верно с опорой на подсказку';
  };

  const focusTask = (preferInput = false) => requestFrame(() => {
    const target = (preferInput && document.getElementById('w_session_input'))
      || document.getElementById('w_session_title');
    if (target) target.focus();
  });

  function trendMarkup(trend7, trend30) {
    const trendDays = new Set(trend30.points.map((point) => point.day)).size;
    const detail = trendDays >= 4
      ? '<div class="vocab-trend-bars" role="img" aria-label="Динамика самостоятельных ответов по дням">'
        + trend30.points.slice(-7).map((point) => `<span style="--vocab-rate:${point.independentRate}%"><i></i>`
          + `<small>${escapeHtml(point.day.slice(5))} · ${point.independentRate}%</small></span>`).join('') + '</div>'
      : `<p class="vocab-trend-empty">Нужно ещё ${Math.max(0, 4 - trendDays)} `
        + `${4 - trendDays === 1 ? 'день' : 'дня'} практики, чтобы показать тренд.</p>`;
    return '<section class="vocab-trend" aria-labelledby="w_trend_title"><h2 id="w_trend_title">Самостоятельное вспоминание</h2>'
      + `<div class="vocab-trend-stats"><article><strong>${trend7.independentRate}%</strong><span>7 дней · ${trend7.attempts} попыток</span></article>`
      + `<article><strong>${trend30.independentRate}%</strong><span>30 дней · ${trend30.attempts} попыток</span></article></div>${detail}</section>`;
  }

  function renderTask(card, options, { task, item, choices = [], contextPrompt = '', token }) {
    if (task.bridge) {
      const content = `<p class="vocab-cue" lang="en">${escapeHtml(item.w)}</p>`
        + `<p class="vocab-task-meaning">${escapeHtml(item.tr || 'Перевод пока не добавлен')}</p>`
        + `<p class="vocab-bridge-note">Без оценки — эта карточка только создаёт интервал перед повтором.</p>`
        + speaker(`Озвучить слово ${item.w}`, item.w);
      card.innerHTML = frame(item, 'Короткая пауза', 'ЗАКРЕПЛЕНИЕ', content);
      options.innerHTML = '';
      setPrimaryAction('Продолжить', `wCompleteBridge(${token})`);
      focusTask();
      return;
    }
    if (task.mode === 'introduction') {
      const content = `<p class="vocab-cue" lang="en">${escapeHtml(item.w)}</p>`
        + `<p class="vocab-task-meaning">${escapeHtml(item.tr || 'Перевод пока не добавлен')}</p>`
        + `<div class="vocab-feedback-context">${feedbackDetails(item)}</div>`
        + speaker(`Озвучить слово ${item.w}`, item.w);
      card.innerHTML = frame(item, 'Познакомься со словом', 'ЗНАКОМСТВО', content);
      options.innerHTML = '';
      setPrimaryAction('Начать вспоминать', `wCompleteIntroduction(${token})`);
      focusTask();
      return;
    }
    if (task.mode === 'receptive_meaning') {
      card.innerHTML = frame(item, 'Выбери значение', 'УЗНАВАНИЕ',
        `<p class="vocab-cue" lang="en">${escapeHtml(item.w)}</p>`);
      options.innerHTML = '<fieldset class="vocab-choice-group"><legend>Варианты значения</legend>'
        + choices.map((choice) => '<label class="vocab-choice aisy-choice"><input type="radio" name="w_recognition_choice" '
        + 'data-vocab-choice="' + handlerValue(choice) + '" value="' + handlerValue(choice) + '" '
        + 'onchange="wChooseRecognition(\'' + handlerValue(choice) + '\',' + token + ')" '
        + 'onkeydown="if(event.key===\'Enter\'){event.preventDefault();this.click()}"><span>' + escapeHtml(choice) + '</span></label>').join('')
        + '</fieldset><p id="w_choice_status" class="vocab-choice-status" role="status" aria-live="polite" aria-atomic="true"></p>'
        + '<button type="button" class="vocab-not-known" onclick="wNotKnown(' + token + ')">Не знаю</button>';
      setPrimaryAction('Проверить ответ', `wSubmitRecognition(${token})`, true);
      focusTask();
      return;
    }
    if (task.mode === 'russian_reveal') {
      card.innerHTML = frame(item, 'Вспомни значение', 'СМЫСЛ',
        `<p class="vocab-cue" lang="en">${escapeHtml(item.w)}</p>${answerInput('Твой вариант значения по-русски', token)}`);
      options.innerHTML = '<button type="button" class="vocab-not-known" onclick="wNotKnown(' + token + ')">Не знаю</button>';
      setPrimaryAction('Показать ответ', `wRevealRussian(${token})`);
    } else if (task.mode === 'english_production') {
      card.innerHTML = frame(item, 'Напиши слово', 'АНГЛИЙСКИЙ',
        `<p class="vocab-task-meaning">${escapeHtml(item.tr || 'Перевод пока не добавлен')}</p>${answerInput('Ответ по-английски', token)}`);
      options.innerHTML = '<button type="button" class="vocab-not-known" onclick="wNotKnown(' + token + ')">Не знаю</button>';
      setPrimaryAction('Проверить', `wSubmitSession(${token})`);
    } else if (task.mode === 'contextual_production') {
      card.innerHTML = frame(item, 'Заполни пропуск', 'КОНТЕКСТ',
        `<p class="vocab-context-prompt" lang="en">${escapeHtml(contextPrompt || 'Контекст пока не добавлен')}</p>${answerInput('Ответ по-английски', token)}`);
      options.innerHTML = '<button type="button" class="vocab-not-known" onclick="wNotKnown(' + token + ')">Не знаю</button>';
      setPrimaryAction('Проверить', `wSubmitSession(${token})`);
    } else {
      card.innerHTML = frame(item, 'Напиши на слух', 'АУДИРОВАНИЕ',
        '<button type="button" class="vocab-listen" onclick="wSpeakLibraryValue(\'' + handlerValue(item.w)
        + '\')">Прослушать ещё раз</button>'
        + answerInput('Ответ по-английски', token));
      options.innerHTML = '<button type="button" class="vocab-not-known" onclick="wNotKnown(' + token + ')">Не знаю</button>';
      setPrimaryAction('Проверить', `wSubmitSession(${token})`);
    }
    focusTask(true);
  }

  function renderRussianReveal(card, options, item, token) {
    card.innerHTML = frame(item, 'Сверь значение', 'ЧЕСТНАЯ САМООЦЕНКА',
      `<p class="vocab-cue" lang="en">${escapeHtml(item.w)}</p>`
      + `<p class="vocab-reveal-answer" role="status" aria-live="polite" aria-atomic="true" `
      + `aria-label="${escapeHtml(item.tr || 'Перевод пока не добавлен')}">${escapeHtml(item.tr || 'Перевод пока не добавлен')}</p>`
      + `<div class="vocab-feedback-context">${feedbackDetails(item)}</div>`);
    options.innerHTML = '<fieldset class="vocab-self-rating"><legend>Насколько близко ты вспомнил(а)?</legend>'
      + '<label class="vocab-choice aisy-choice"><input type="radio" name="w_russian_rating" data-vocab-rating="knew" value="knew" onchange="wChooseRussianRating(\'knew\',' + token + ')" onkeydown="if(event.key===\'Enter\'){event.preventDefault();this.click()}"><span>Знал(а)</span></label>'
      + '<label class="vocab-choice aisy-choice"><input type="radio" name="w_russian_rating" data-vocab-rating="almost" value="almost" onchange="wChooseRussianRating(\'almost\',' + token + ')" onkeydown="if(event.key===\'Enter\'){event.preventDefault();this.click()}"><span>Почти</span></label>'
      + '<label class="vocab-choice aisy-choice"><input type="radio" name="w_russian_rating" data-vocab-rating="not_known" value="not_known" onchange="wChooseRussianRating(\'not_known\',' + token + ')" onkeydown="if(event.key===\'Enter\'){event.preventDefault();this.click()}"><span>Не знал(а)</span></label></fieldset>';
    setPrimaryAction('Сохранить оценку', `wSubmitRussianRating(${token})`, true);
    focusTask();
  }

  function renderFeedback(card, options, task, item, result, token) {
    const status = feedbackStatus(result);
    const full = result.outcome !== 'correct' || task.mode === 'russian_reveal';
    const details = feedbackDetails(item);
    card.innerHTML = decoration() + `<section class="vocab-feedback ${full ? 'is-full' : 'is-compact'}" aria-labelledby="w_feedback_title">`
      + `<p class="vocab-kicker">ОБРАТНАЯ СВЯЗЬ</p><h1 id="w_feedback_title" tabindex="-1">${status}</h1>`
      + `<div class="vocab-feedback-answer"><strong lang="en">${escapeHtml(item.w)}</strong>${speaker(`Озвучить слово ${item.w}`, item.w)}</div>`
      + `<p class="vocab-feedback-meaning">${escapeHtml(item.tr || 'Перевод пока не добавлен')}</p>`
      + (full ? `<div class="vocab-feedback-context">${details}</div>`
        : `<details class="vocab-feedback-more"><summary>Контекст и произношение</summary>${details}</details>`)
      + '</section>';
    options.innerHTML = '';
    setPrimaryAction('Дальше', `wSessionNext(${token})`);
    const heading = document.getElementById('w_feedback_title');
    if (heading) heading.focus();
  }

  const summaryLabel = (value, one, few, many) => {
    const mod100 = value % 100;
    const mod10 = value % 10;
    const word = mod100 >= 11 && mod100 <= 19 ? many : mod10 === 1 ? one : mod10 >= 2 && mod10 <= 4 ? few : many;
    return `${value} ${word}`;
  };

  function renderSummary(card, options, summary, token) {
    const difficult = summary.difficultWords.length
      ? '<section class="vocab-difficult" aria-label="Сложные слова"><h2>Сложные слова</h2><ul>'
        + summary.difficultWords.map((word) => `<li><strong lang="en">${escapeHtml(word.word)}</strong>`
          + `<span>${summaryLabel(word.errors, 'ошибка', 'ошибки', 'ошибок')}</span></li>`).join('') + '</ul></section>'
      : '<p class="vocab-summary-success">Сегодня без сложных слов — отличная самостоятельная работа.</p>';
    const wordLabel = summaryLabel(summary.uniqueWords, 'слово', 'слова', 'слов').replace(/^\d+\s/u, '');
    const attemptLabel = summaryLabel(summary.attempts, 'попытка', 'попытки', 'попыток').replace(/^\d+\s/u, '');
    const errorLabel = summaryLabel(summary.errors, 'ошибка', 'ошибки', 'ошибок').replace(/^\d+\s/u, '');
    card.innerHTML = '<section class="vocab-summary" aria-labelledby="w_summary_title"><p class="vocab-kicker">СЕССИЯ ЗАВЕРШЕНА</p>'
      + '<h1 id="w_summary_title" tabindex="-1">Итоги тренировки</h1><div class="vocab-summary-grid" aria-label="Итоги сессии">'
      + `<article><strong>${summary.uniqueWords}</strong><span>${wordLabel}</span></article>`
      + `<article><strong>${summary.attempts}</strong><span>${attemptLabel}</span></article>`
      + `<article><strong>${summary.introduced}</strong><span>знакомство</span></article>`
      + `<article><strong>${summary.reviewed}</strong><span>повторено</span></article>`
      + `<article><strong>${summary.independent}</strong><span>самостоятельно</span></article>`
      + `<article><strong>${summary.assisted}</strong><span>с подсказкой</span></article>`
      + `<article><strong>${summary.errors}</strong><span>${errorLabel}</span></article></div>${difficult}</section>`;
    options.innerHTML = summary.difficultWords.length
      ? '<button type="button" class="vocab-secondary" onclick="wPracticeDifficult()">Потренировать сложные слова</button>' : '';
    setPrimaryAction('К плану слов', `wShowHome(${token})`);
    const heading = document.getElementById('w_summary_title');
    if (heading) heading.focus();
  }

  return Object.freeze({
    renderFeedback,
    renderRussianReveal,
    renderSummary,
    renderTask,
    trendMarkup,
  });
}

export { createVocabularySessionView };
