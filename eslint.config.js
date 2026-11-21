// Minimal, bug-oriented ruleset. Formatting is Prettier's job (see .prettierrc.json),
// so stylistic rules stay off; TypeScript already checks undefined names in .ts files.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', '**/node_modules/**', 'apps/web/dist/**', '**/*.svelte'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      // Style only: dense declarations mix reassigned and constant names.
      'prefer-const': 'off',
    },
  },
  { files: ['**/*.ts'], rules: { 'no-undef': 'off' } },
  // UI code and browser-side callbacks of e2e tests (page.evaluate) run in the browser.
  { files: ['apps/web/**', 'tests/e2e/**', 'tests/helpers/**'], languageOptions: { globals: { ...globals.browser } } },
  prettier,
);
