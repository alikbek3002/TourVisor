import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Flat ESLint config (ESLint 9). Lints the TypeScript sources with the
// typescript-eslint recommended ruleset. Kept intentionally lean.
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'eslint.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Allow intentionally-unused args/vars when prefixed with underscore.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // The Tourvisor/WAHA payloads are loosely typed; `any` casts are pragmatic.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
