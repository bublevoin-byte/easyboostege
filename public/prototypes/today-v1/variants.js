const STUDY_OBJECT = './assets/aisy-soft-study-cards.png';

function durationChoices(fixture) {
  return fixture.duration.choices.map((minutes) => `
    <button class="duration-choice aisy-v2-duration-choice" type="button"
      aria-pressed="${minutes === fixture.duration.selected}" data-minutes="${minutes}">
      <strong>${minutes}</strong><span>мин</span>
    </button>
  `).join('');
}

function rhythmDays(fixture, className = '') {
  return fixture.rhythm.days.map((day) => {
    const state = day.status === 'today' ? `${day.minutes} мин` : day.status === 'complete' ? 'в ритме' : 'далее';
    return `<li class="rhythm-day ${className}" data-status="${day.status}"><span>${day.label}</span><i aria-hidden="true"></i><strong>${state}</strong></li>`;
  }).join('');
}

function todayRhythm(fixture) {
  return fixture.rhythm.days.find((day) => day.status === 'today');
}

function studyObject(className) {
  return `<img class="aisy-v2-study-object ${className}" src="${STUDY_OBJECT}" width="1312" height="1199" alt="" aria-hidden="true">`;
}

function verified(fixture, { withDetail = false } = {}) {
  return `<div class="verified-block"><p class="verified-label"><span aria-hidden="true"></span>${fixture.evidence.label}</p>${withDetail
    ? `<p class="evidence-detail">${fixture.evidence.detail}</p>`
    : ''}</div>`;
}

function asyaCue(fixture, className = '') {
  return `
    <aside class="asya-cue aisy-v2-asya-moment ${className}" aria-labelledby="asya-cue-title">
      <span class="asya-cue__orb" aria-hidden="true"></span>
      <div>
        <p>${fixture.studyContext.label}</p>
        <h2 id="asya-cue-title">${fixture.studyContext.title}</h2>
        <span>${fixture.studyContext.copy}</span>
      </div>
    </aside>
  `;
}

function primaryAction(fixture) {
  return `<button class="primary-cta aisy-v2-button" type="button" data-prototype-action>${fixture.recommendation.ctaLabel}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"></path></svg></button>`;
}

export function renderCoralRoute(fixture) {
  return `
    <article class="concept concept-a aisy-v2-composition" aria-labelledby="concept-title">
      <header class="concept-a__hero">
        <div class="concept-a__copy aisy-v2-motion-reveal">
          <p class="concept-kicker">Сегодня · ${fixture.context}</p>
          <p class="concept-a__greeting">${fixture.greeting}</p>
          <h1 id="concept-title">Ваш маршрут —<br><em>${fixture.recommendation.title.toLowerCase()}</em></h1>
          <p class="concept-lead">${fixture.recommendation.reason} ${fixture.recommendation.outcome}</p>
          ${verified(fixture, { withDetail: true })}
          <div class="duration-block" aria-labelledby="duration-a-label">
            <div class="duration-block__heading"><h2 id="duration-a-label">Сколько времени есть?</h2><span>${fixture.duration.help}</span></div>
            <div class="duration-choices">${durationChoices(fixture)}</div>
          </div>
          ${primaryAction(fixture)}
        </div>
        <div class="concept-a__stage" aria-hidden="true">
          <span class="concept-a__number">${fixture.recommendation.estimatedMinutes}</span>
          <span class="concept-a__unit">минут<br>на маршрут</span>
          <svg class="route-line route-line--hero" viewBox="0 0 360 420" fill="none">
            <path d="M50 35C315 60 58 180 290 245S214 382 326 398"></path>
            <circle cx="50" cy="35" r="8"></circle><circle cx="290" cy="245" r="8"></circle><circle cx="326" cy="398" r="8"></circle>
          </svg>
          ${studyObject('concept-a__object')}
        </div>
      </header>

      <section class="route-story" aria-labelledby="route-story-title">
        <div class="section-heading">
          <p>Маршрут занятия</p>
          <h2 id="route-story-title">От решения к результату</h2>
        </div>
        <ol>
          <li><span>01</span><div><strong>Войти в контекст</strong><p>Короткий разогрев помогает услышать тему до основного задания.</p></div></li>
          <li><span>02</span><div><strong>${fixture.recommendation.title}</strong><p>${fixture.recommendation.reason}</p></div></li>
          <li><span>03</span><div><strong>Обновить следующий шаг</strong><p>${fixture.recommendation.outcome}</p></div></li>
        </ol>
      </section>

      <div class="concept-a__lower">
        <section class="rhythm-card aisy-v2-surface" aria-labelledby="rhythm-a-title">
          <div class="rhythm-card__heading"><div><p>Ритм недели</p><h2 id="rhythm-a-title">${fixture.rhythm.streakDays} дней подряд</h2></div><strong>${fixture.rhythm.weeklyTargetMinutes}<small>мин / нед.</small></strong></div>
          <ol class="rhythm-days">${rhythmDays(fixture)}</ol>
        </section>
        ${asyaCue(fixture)}
        <section class="exam-card aisy-v2-ege-surface" aria-label="Контекст экзамена"><p>Цель</p><strong>${fixture.countdown.days}</strong><span>день до ЕГЭ</span></section>
      </div>
    </article>
  `;
}

export function renderLivingCanvas(fixture) {
  return `
    <article class="concept concept-b aisy-v2-composition" aria-labelledby="concept-title">
      <header class="concept-b__heading aisy-v2-motion-reveal">
        <p class="concept-kicker">${fixture.greeting}<br>${fixture.context}</p>
        <h1 id="concept-title">Сегодня —<br><em>слышать</em> больше.</h1>
        <p class="concept-b__intro">${fixture.recommendation.reason}</p>
      </header>

      <div class="living-canvas">
        <section class="living-decision" aria-labelledby="living-decision-title">
          <span class="living-decision__index">01 / выбор дня</span>
          <h2 id="living-decision-title">${fixture.recommendation.title}</h2>
          <p>${fixture.recommendation.outcome}</p>
          ${verified(fixture, { withDetail: true })}
          <div class="duration-block" aria-labelledby="duration-b-label">
            <div class="duration-block__heading"><h3 id="duration-b-label">Ваше время</h3><span>${fixture.duration.help}</span></div>
            <div class="duration-choices">${durationChoices(fixture)}</div>
          </div>
          ${primaryAction(fixture)}
        </section>

        <figure class="living-object">
          <span class="living-object__shape" aria-hidden="true"></span>
          ${studyObject('living-object__image')}
          <figcaption><strong>${fixture.recommendation.estimatedMinutes}</strong><span>минут<br>в фокусе</span></figcaption>
        </figure>

        <section class="living-rhythm" aria-labelledby="rhythm-b-title">
          <div><p>02 / ваш ритм</p><h2 id="rhythm-b-title">${fixture.rhythm.streakDays} дней<br>без разрыва</h2></div>
          <ol class="rhythm-days rhythm-days--editorial">${rhythmDays(fixture, 'rhythm-day--editorial')}</ol>
          <p class="living-rhythm__target">Цель недели <strong>${fixture.rhythm.weeklyTargetMinutes} минут</strong></p>
        </section>

        ${asyaCue(fixture, 'living-asya')}

        <section class="living-exam aisy-v2-ege-surface" aria-label="Контекст экзамена">
          <p>03 / горизонт</p><strong>${fixture.countdown.days}</strong><span>день до цели ЕГЭ</span>
        </section>
      </div>
    </article>
  `;
}

export function renderProgressPulse(fixture) {
  return `
    <article class="concept concept-c aisy-v2-composition" aria-labelledby="concept-title">
      <header class="concept-c__heading aisy-v2-motion-reveal">
        <div><p class="concept-kicker">Сегодня · решение по данным</p><h1 id="concept-title">Продолжить ритм.<br><em>Укрепить аудирование.</em></h1></div>
        <p>${fixture.greeting}<br><span>${fixture.context}</span></p>
      </header>

      <div class="pulse-dashboard">
        <section class="pulse-decision" aria-labelledby="pulse-decision-title">
          <p>Главный шаг</p>
          <div class="pulse-decision__title"><h2 id="pulse-decision-title">${fixture.recommendation.title}</h2><strong>${fixture.recommendation.estimatedMinutes}<small>мин</small></strong></div>
          <p class="pulse-decision__why">${fixture.recommendation.reason}</p>
          <p class="pulse-decision__outcome">${fixture.recommendation.outcome}</p>
          ${verified(fixture)}
          <div class="duration-block" aria-labelledby="duration-c-label">
            <div class="duration-block__heading"><h3 id="duration-c-label">Длительность</h3><span>${fixture.duration.help}</span></div>
            <div class="duration-choices">${durationChoices(fixture)}</div>
          </div>
          ${primaryAction(fixture)}
        </section>

        <section class="pulse-rhythm aisy-v2-surface" aria-labelledby="rhythm-c-title">
          <div class="pulse-rhythm__headline"><div><p>Ритм недели</p><h2 id="rhythm-c-title">${fixture.rhythm.streakDays}<span>дней подряд</span></h2></div><div><strong>${todayRhythm(fixture).minutes}</strong><span>мин сегодня</span></div><div><strong>${fixture.rhythm.weeklyTargetMinutes}</strong><span>мин / нед.</span></div></div>
          <ol class="pulse-chart">${rhythmDays(fixture, 'pulse-chart__day')}</ol>
          <p class="aisy-v2-chart-summary">Учебных дней подряд: ${fixture.rhythm.streakDays}; сегодня уже отмечено ${todayRhythm(fixture).minutes} минут. Цель недели — ${fixture.rhythm.weeklyTargetMinutes} минут.</p>
        </section>

        <section class="pulse-evidence" aria-labelledby="pulse-evidence-title">
          <div><p>Почему этот шаг</p><h2 id="pulse-evidence-title">Решение можно проверить</h2><span>${fixture.evidence.detail}</span></div>
          <svg class="pulse-evidence__line" viewBox="0 0 280 100" fill="none" aria-hidden="true"><path d="M8 78C60 82 62 30 116 48s58-36 104-12 34 8 52-20"></path><circle cx="8" cy="78" r="6"></circle><circle cx="116" cy="48" r="6"></circle><circle cx="272" cy="16" r="6"></circle></svg>
        </section>

        <section class="pulse-horizon aisy-v2-ege-surface" aria-label="Контекст экзамена"><p>До цели</p><strong>${fixture.countdown.days}</strong><span>день · ЕГЭ английский</span></section>
        ${asyaCue(fixture, 'pulse-asya')}
        <div class="pulse-object">${studyObject('pulse-object__image')}</div>
      </div>
    </article>
  `;
}
