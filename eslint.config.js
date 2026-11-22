const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/',
      'dist/',
      'out/',
      'release/',
      'data/',
      'versions/',
      'desktop/node_modules/',
      'desktop/.staging/',
      'desktop/src-tauri/',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // `catch (e) {}` is the house idiom for "a failure here changes
      // nothing": the binding and the empty block are both deliberate.
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['src/web/public/**/*.js', 'desktop/ui/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },
  {
    files: ['tools/oauth-relay/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.serviceworker },
    },
  },
];
