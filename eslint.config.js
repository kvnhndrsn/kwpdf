import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// Globals the build injects with esbuild `define` (see build.js). Declaring them
// keeps `no-undef` useful instead of forced off for the files that use them.
const BUILD_DEFINES = {
    WORKER_BASE: 'readonly',
    __BUNDLE_HASH__: 'readonly',
    __COMMIT_DATE__: 'readonly',
    KEYWORDS: 'readonly',
};

export default [
    { ignores: ['dist/**', 'dist-types/**', 'node_modules/**', 'coverage/**'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            // `any` is still load-bearing across the loaders. Types are being
            // tightened file-by-file through tsconfig.strict.json, so this rule
            // becomes worth enabling as each batch migrates.
            '@typescript-eslint/no-explicit-any': 'off',
            // Most hits are `catch (e) {}` where the binding is genuinely unused;
            // a named-but-unused import or variable is still an error.
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' },
            ],
            // `try { x() } catch (e) {}` is a deliberate best-effort pattern.
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.worker,
                // build.js and the fixture generator run in Node; the OCR worker
                // loads Tesseract through importScripts.
                ...globals.node,
                Tesseract: 'readonly',
                ...BUILD_DEFINES,
            },
        },
    },
    {
        files: ['**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node },
        },
    },
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            globals: { ...globals.browser, ...BUILD_DEFINES },
        },
    },
    {
        files: ['src/__tests__/**/*.js', '**/*.bench.js'],
        languageOptions: { globals: { ...globals.node } },
    },
];
