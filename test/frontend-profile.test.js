import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/modules/profile.js', import.meta.url), 'utf8');

function createProfileModule() {
  const window = {};
  vm.runInNewContext(source, { window, Object, Number, Math, Array, String, Boolean, Date });
  return window.EasyBoostProfile;
}

test('profile module falls back to a guest name and initial', () => {
  const profile = createProfileModule();

  assert.equal(profile.displayName('Аня'), 'Аня');
  assert.equal(profile.displayName('   '), 'Гость');
  assert.equal(profile.displayName(null), 'Гость');
  assert.equal(profile.initial('аня'), 'А');
  assert.equal(profile.initial(''), 'Г');
  assert.equal(profile.greeting('Аня'), 'Привет, Аня 👋');
  assert.equal(profile.greeting(null), 'Привет, друг 👋');
});

test('profile module formats subscription dates as dd.mm.yyyy', () => {
  const profile = createProfileModule();

  assert.equal(profile.formatDate(new Date(2027, 0, 5).getTime()), '05.01.2027');
  assert.equal(profile.formatDate(new Date(2026, 11, 31).getTime()), '31.12.2026');
});

test('profile module reports an unactivated subscription', () => {
  const profile = createProfileModule();
  const status = profile.subscriptionStatus(null, Date.now());

  assert.equal(status.state, 'none');
  assert.equal(status.text, 'Доступ не активирован — открой бота');
  assert.equal(status.color, '#A56000');
  assert.equal(status.background, '#FFF4DE');
  assert.equal(profile.subscriptionStatus({ active: true }, Date.now()).state, 'none');
});

test('profile module counts the days left on an active subscription', () => {
  const profile = createProfileModule();
  const now = new Date(2026, 6, 25).getTime();
  const until = new Date(2026, 7, 1).getTime();
  const status = profile.subscriptionStatus({ active: true, sub_until: until }, now);

  assert.equal(status.state, 'active');
  assert.equal(status.daysLeft, 7);
  assert.equal(status.text, 'Подписка до 01.08.2026 · осталось 7 дн.');
  assert.equal(status.color, '#1D7F4A');
});

test('profile module reports an expired subscription without a countdown', () => {
  const profile = createProfileModule();
  const until = new Date(2026, 5, 30).getTime();
  const status = profile.subscriptionStatus({ active: false, sub_until: until }, new Date(2026, 6, 25).getTime());

  assert.equal(status.state, 'expired');
  assert.equal(status.daysLeft, 0);
  assert.equal(status.text, 'Подписка закончилась 30.06.2026');
  assert.equal(status.color, '#A83226');
  assert.equal(status.background, '#FDEDEA');
});

test('profile module shows a Premium paywall or the remaining voice minutes', () => {
  const profile = createProfileModule();
  const base = profile.voiceTutorStatus({
    entitlements: { voice_tutor: false },
    voice_tutor: { daily_remaining_seconds: 0, monthly_remaining_seconds: 0, active_session: false },
  });
  assert.equal(base.state, 'paywall');
  assert.equal(base.title, 'Voice Tutor · Premium');
  assert.match(base.text, /доступен в Premium/u);

  const premium = profile.voiceTutorStatus({
    entitlements: { voice_tutor: true },
    voice_tutor: { daily_remaining_seconds: 600, monthly_remaining_seconds: 7_200, active_session: false },
  });
  assert.equal(premium.state, 'premium');
  assert.equal(premium.title, 'Voice Tutor · Premium');
  assert.equal(premium.text, 'Осталось 10 мин сегодня · 120 мин в этом месяце');
  assert.equal('daily_limit_seconds' in premium, false);
});
