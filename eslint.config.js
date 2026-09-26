// @ts-check
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'web/.e2e-data/**', 'web/test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // An async click handler is the React idiom; the handler owns its errors.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    // Test doubles stand in for async APIs without having anything to await.
    files: ['**/*.test.{ts,tsx}', '**/*.bench.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  { files: ['eslint.config.js'], extends: [tseslint.configs.disableTypeChecked] },
  { files: ['server/**/*.ts', 'mcp/**/*.ts'], languageOptions: { globals: globals.node } },
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    extends: [reactHooks.configs.flat['recommended-latest']],
  },
)
