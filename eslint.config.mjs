import js from '@eslint/js';
import globals from 'globals';
import importPlugin from 'eslint-plugin-import';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const tsFiles = ['backend/**/*.ts', 'shared/**/*.ts', 'frontend/src/**/*.{ts,tsx}'];

const typedConfigs = [
  ...tseslint.configs.recommended,
].map((config) => ({
  ...config,
  files: tsFiles,
}));

const typeAwareSourceFiles = [
  'backend/src/**/*.ts',
  'frontend/src/**/*.{ts,tsx}',
  'shared/src/index.ts',
  'shared/src/snapshot/**/*.ts',
  'shared/src/workflow-detail.ts',
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-test/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.claude/**',
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  ...typedConfigs,
  {
    files: tsFiles,
    plugins: {
      import: importPlugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'import/first': 'error',
    },
  },
  {
    files: typeAwareSourceFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        project: [
          './backend/tsconfig.test.json',
          './frontend/tsconfig.test.json',
          './shared/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', {
        fixStyle: 'inline-type-imports',
      }],
      '@typescript-eslint/no-floating-promises': ['error', {
        ignoreVoid: true,
      }],
      '@typescript-eslint/no-misused-promises': ['error', {
        checksVoidReturn: {
          attributes: false,
        },
      }],
      '@typescript-eslint/restrict-template-expressions': ['error', {
        allowBoolean: true,
        allowNumber: true,
        allowNullish: true,
      }],
    },
  },
  {
    files: ['frontend/src/**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      'react/no-danger': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
);
