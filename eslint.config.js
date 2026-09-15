// ESLint flat config.
//
// Scope: the Node.js ESM entry points in the repo root, src/** and test/**.
// Formatting is deliberately NOT enforced here — `npm run format:check`
// (Prettier) owns that, so no eslint-config-prettier / prettier plugin is
// installed.
//
// Uses the official rule sets rather than an inlined copy, so a rule update
// arrives with a dependency bump instead of silently drifting.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'docs/**', 'dist/**'],
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
    },
  },
];
