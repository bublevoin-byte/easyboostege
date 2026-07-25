import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'backups/**', 'tts-cache/**'],
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
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        DEMO_MODE: 'readonly',
        EasyBoostApi: 'readonly',
        EasyBoostLearning: 'readonly',
        EasyBoostRouter: 'readonly',
        EasyBoostSync: 'readonly',
        HIST: 'readonly',
        LSLOW: 'readonly',
        SRV: 'readonly',
        TOKEN: 'readonly',
        apiGetBlob: 'readonly',
        back: 'readonly',
        bump: 'readonly',
        cur: 'readonly',
        curTask: 'readonly',
        initWords: 'readonly',
        lPlayBtn: 'readonly',
        lPlayRaw: 'writable',
        lPlayRawFallback: 'readonly',
        lStop: 'writable',
        lStopFallback: 'readonly',
        nav: 'readonly',
        registerRouteHook: 'readonly',
        setTask: 'readonly',
        show: 'readonly',
        showScreen: 'readonly',
        tab: 'readonly',
        toast: 'readonly',
        wSpeak: 'writable',
        wSpeakFallback: 'readonly',
      },
    },
  },
  {
    files: ['e2e/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
];
