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
      // nothing": the binding and the empty block are both deliberate. So are
      // `[_, value]` and `{ dropped, ...rest }`, which name what they skip.
      'no-unused-vars': [
        'error',
        { caughtErrors: 'none', ignoreRestSiblings: true, destructuredArrayIgnorePattern: '^_' },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['src/web/public/**/*.js', 'desktop/ui/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Classic scripts share one global scope: these are declared at the
        // top level of one file of the dashboard and used by the others (see
        // the <script> order in index.html).
        CustomSelect: 'readonly',
        TooltipSystem: 'readonly',
        loadLocale: 'readonly',
      },
    },
    rules: {
      // A top-level declaration in a classic script is a global that another
      // script or the page may use: only locals are checked.
      'no-unused-vars': [
        'error',
        { vars: 'local', caughtErrors: 'none', ignoreRestSiblings: true, destructuredArrayIgnorePattern: '^_' },
      ],
      // The shared globals above are declared by the very files that define
      // them: that declaration is not a redeclaration.
      'no-redeclare': ['error', { builtinGlobals: false }],
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
