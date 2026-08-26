const THEME_STORAGE_KEY = 'aisy.theme.preference.v1';
const THEME_COLORS = Object.freeze({ light: '#fff9f3', dark: '#171219' });
const THEME_PREFERENCES = new Set(['system', 'light', 'dark']);

function normalizeThemePreference(value) {
  return THEME_PREFERENCES.has(value) ? value : 'system';
}

function safeRead(storage) {
  try { return normalizeThemePreference(storage?.getItem(THEME_STORAGE_KEY)); } catch { return 'system'; }
}

function safeWrite(storage, value) {
  try { storage?.setItem(THEME_STORAGE_KEY, value); } catch {}
}

function installTheme({
  document = globalThis.document,
  storage = globalThis.localStorage,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  eventTarget = globalThis,
} = {}) {
  if (!document?.documentElement) throw new Error('Aisy theme requires a document root');
  const root = document.documentElement;
  const themeColor = document.querySelector?.('meta[name="theme-color"]') || null;
  const darkPreference = matchMedia?.('(prefers-color-scheme: dark)') || null;
  let preference = safeRead(storage);

  function effectiveTheme(value = preference) {
    if (value !== 'system') return value;
    return darkPreference?.matches ? 'dark' : 'light';
  }

  function render() {
    root.dataset.themePreference = preference;
    if (preference === 'system') root.removeAttribute('data-theme');
    else root.dataset.theme = preference;
    if (themeColor) themeColor.content = THEME_COLORS[effectiveTheme()];
  }

  function set(value) {
    preference = normalizeThemePreference(value);
    safeWrite(storage, preference);
    render();
    return preference;
  }

  function onSystemChange() {
    if (preference === 'system') render();
  }

  function onStorage(event) {
    if (event?.key !== THEME_STORAGE_KEY) return;
    preference = normalizeThemePreference(event.newValue);
    render();
  }

  darkPreference?.addEventListener?.('change', onSystemChange);
  eventTarget?.addEventListener?.('storage', onStorage);
  render();

  return Object.freeze({
    get preference() { return preference; },
    get effective() { return effectiveTheme(); },
    set,
    destroy() {
      darkPreference?.removeEventListener?.('change', onSystemChange);
      eventTarget?.removeEventListener?.('storage', onStorage);
    },
  });
}

let themeController = null;
if (typeof document !== 'undefined') {
  themeController = installTheme();
  globalThis.AisyTheme = themeController;
}

export {
  THEME_STORAGE_KEY,
  installTheme,
  normalizeThemePreference,
  themeController,
};
