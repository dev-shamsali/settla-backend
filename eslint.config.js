import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules', 'coverage'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', { selector: "CallExpression[callee.name='require']", message: 'ESM only: use import' }],
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
];
