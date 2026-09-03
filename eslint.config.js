import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'backups/**', 'tts-cache/**', 'pwa-compat/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-constant-binary-expression': 'error',
      'no-dupe-keys': 'error',
      'no-undef': 'error',
      'no-unreachable': 'error',
      'valid-typeof': 'error',
    },
  },
  {
    /*
     * Frontend — нативные ES-модули с единой точкой входа public/main.js. Именно поэтому
     * список «общих» глобальных имён здесь почти пуст: всё, что раньше передавалось через
     * глобальную область, теперь передаётся импортом, и no-undef это стережёт.
     */
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.browser,
        EasyBoostApi: 'readonly',
        EasyBoostLearning: 'readonly',
      },
    },
  },
  {
    /* Service worker регистрируется классическим скриптом, а не модулем. */
    files: ['public/service-worker.js'],
    languageOptions: {
      sourceType: 'script',
      globals: globals.serviceworker,
    },
  },
  {
    files: ['e2e/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
];
