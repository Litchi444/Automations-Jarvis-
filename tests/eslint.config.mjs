// Run from the repo root (npm run lint does `cd ..`): globs are relative to it.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['tests/node_modules/**', 'workflows/**'] },
  js.configs.recommended,
  {
    // n8n Code nodes: a function body with n8n globals and a top-level return.
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      parserOptions: { ecmaFeatures: { globalReturn: true } },
      globals: { $: 'readonly', $input: 'readonly', $env: 'readonly', Buffer: 'readonly' },
    },
    rules: {
      // Stripping control characters from untrusted text is intentional here.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['tests/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    files: ['tests/*.mjs'],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },
];
