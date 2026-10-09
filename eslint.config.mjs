// ESLint for JusttPrint's JavaScript: the server (src/server, src/core), scripts, tests, the helper
// and the plain browser scripts at the top of the project.
//
// The web UI (src/web, TypeScript) is checked by `tsc` in strict mode instead: typescript-eslint
// does not support TypeScript 7 yet (it needs < 6.1). Add it here once it does.
//
//   npm run lint
import js from '@eslint/js';
import globals from 'globals';

/** Rules on top of the recommended ones: real mistakes are errors, leftovers are warnings. */
const rules = {
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-control-regex': 'off',
  'no-useless-escape': 'warn',
  'no-prototype-builtins': 'off',
  'prefer-const': ['warn', { destructuring: 'all' }],
  eqeqeq: ['warn', 'smart'],
  // New in ESLint 10's recommended set; worth fixing over time, not errors for code written before.
  'preserve-caught-error': 'warn',
  'no-useless-assignment': 'warn'
};

/** Files that also run in the browser (they check `typeof window` / `typeof fflate` first). */
const SHARED = ['slicer-protocol.js', 'step-assembly.js', 'stl-sanity.js', 'parse-lys-geometry.js', 'threemf-svg-extrude.js', 'threemf-mesh-extract.js'];

export default [
  {
    ignores: [
      'node_modules/**', 'web-build/**', 'dist/**', 'vendor/**', 'docs/**', 'guide/**', 'assets/**',
      'tests/e2e/.work/**', 'tests/fixtures/**', 'test-results/**', 'playwright-report/**',
      // TypeScript: checked by tsc (see above).
      'src/web/**'
    ]
  },
  js.configs.recommended,
  {
    // Node, CommonJS: the server, shared core code, scripts, tests and the helper.
    files: ['src/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', 'helper/**/*.js', ...SHARED],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      // Some of these files also run in the browser's parse worker (self.*).
      globals: { ...globals.node, ...globals.worker }
    },
    rules
  },
  {
    // Browser code in Node files: shared files, and functions run in a page (Playwright's and
    // Puppeteer's page.evaluate in the end-to-end tests, the thumbnail worker, the icon builder).
    files: [...SHARED, 'tests/e2e/**/*.js', 'src/server/thumbnail-worker.js', 'scripts/build-icons.js'],
    languageOptions: { globals: { ...globals.browser, fflate: 'readonly' } }
  },
  {
    // Plain scripts the page loads (no bundler): page wiring, the server bridge, the guide, the service worker.
    files: ['page-init.js', 'server-bridge.js', 'guide.js', 'pwa.js', 'puter-signin.js', 'sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.serviceworker }
    },
    rules
  },
  {
    files: ['*.mjs', 'scripts/**/*.mjs', 'src/**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules
  }
];
