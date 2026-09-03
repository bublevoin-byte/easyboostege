(function applyAisyThemeBeforePaint() {
  'use strict';
  var key = 'aisy.theme.preference.v1';
  var preference = 'system';
  try {
    var stored = window.localStorage.getItem(key);
    if (stored === 'light' || stored === 'dark') preference = stored;
  } catch (_) {}
  var root = document.documentElement;
  root.dataset.themePreference = preference;
  if (preference === 'light' || preference === 'dark') root.dataset.theme = preference;
  else root.removeAttribute('data-theme');
  var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var effective = preference === 'system' ? (dark ? 'dark' : 'light') : preference;
  var themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = effective === 'dark' ? '#171219' : '#fff9f3';
})();
