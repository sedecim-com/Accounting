// @ts-check
//
// ESLint flat config (ESLint 9 + typescript-eslint 8).
//
// This codebase ran without any lint layer until its first pass, so the
// severities below are a deliberate triage rather than a default preset:
//
//   error  -> defect classes that were found and fixed; they now gate CI.
//   warn   -> unsoundness that enters through THIRD-PARTY types (Express's
//             `req.body: any`, fast-xml-parser's `parse(): any`, and rows
//             typed `Record<string, unknown>`). Fixing these means typing the
//             boundaries, not editing the call sites, so they are tracked as
//             visible debt instead of being silenced.
//   off    -> rules that fight a deliberate design decision here. Each one
//             carries the reason; none is disabled just to get to zero.
//
// The warnings are ratcheted, not ignored: package.json runs eslint with
// `--max-warnings 1067` (436 in src, 631 in tests). CI fails if that number
// goes up, and the cap should be lowered as boundaries get typed. Do not
// raise it to make a build pass.
//
// Scope is `src/`, `tests/` and `scripts/`, all with type information. src and
// tests get different rule sets because they run under different constraints;
// scripts follows src.

import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    name: 'accounting-core/ignores',
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },

  // Type-aware recommended set: the rules that need the type checker
  // (no-floating-promises, no-misused-promises) are the ones that found the
  // real bugs here, so the cheaper untyped preset would not have been enough.
  ...tseslint.configs.recommendedTypeChecked,

  {
    name: 'accounting-core/typed',
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        // tsconfig.test.json rather than tsconfig.json: it extends the latter
        // and adds tests/ and scripts/, so it is the one project covering
        // everything the type-aware rules are pointed at. tsconfig.json stays
        // src-only because it is the build, and scripts must not reach dist/.
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // The four pre-existing `eslint-disable-next-line no-explicit-any`
      // comments in src/ai are real and load-bearing. This makes sure a
      // disable comment that stops being needed is reported instead of rotting.
      reportUnusedDisableDirectives: 'error',
    },
  },

  {
    name: 'accounting-core/src',
    files: ['src/**/*.ts'],
    rules: {
      // ── error: fixed, and kept fixed ───────────────────────────────────

      // Underscore prefix is this codebase's existing convention for a
      // parameter that exists only to satisfy a signature (errorHandler's
      // `_next`, ledger-tools' `_id`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // `declare global { namespace Express { ... } }` in the auth middleware
      // is the only supported way to augment Express's Request type. The rule
      // is about authoring new namespaces, not about module augmentation.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],

      // ── warn: unsoundness owned by third-party types ───────────────────
      //
      // Express 4 types `Request.body` as `any` and fast-xml-parser returns
      // `any`, so every route body read and every parsed CFDI node is unsafe
      // by construction. The fix is to parse at the boundary (the repo's own
      // `validateBody` zod helper already does this on some routes) and to
      // give xml-ingestion real result types. Until then these stay visible.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',

      // Same root cause seen from the string side: `Record<string, unknown>`
      // row fields become `{}` under `??`, which is not provably stringable.
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',

      // ── off: rules that contradict a deliberate design here ────────────

      // The system is built on Promise-returning interfaces whose
      // implementations are sometimes synchronous on purpose: the local-dev
      // vault, the PAC adapters' unsupported `getRemainingStamps`, and the
      // Validator hierarchy in services/accounting/validation.ts. Dropping
      // `async` there would break the interface; `Promise.resolve()` wrappers
      // would only obscure it.
      '@typescript-eslint/require-await': 'off',
    },
  },

  {
    // Tests get the same type-aware analysis as src, minus the rules that
    // fight what a test is allowed to do. Note that no-floating-promises and
    // no-misused-promises stay ON here: a test that forgets to await is a test
    // that passes for the wrong reason.
    name: 'accounting-core/tests',
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // La aserción "innecesaria" que sí hace falta.
      //
      // Con el arnés de dobles, `vi.hoisted(() => ({ arnes: { actual: null } }))`
      // infiere `{ actual: null }`, y sin el `as { actual: ClienteFalso | null }`
      // ninguna asignación posterior compila. ESLint, con su propia vista de
      // tipos, cree que la aserción sobra; `tsc -p tsconfig.test.json` dice lo
      // contrario, y es la autoridad: aplicar el --fix de esta regla rompió
      // literalmente el typecheck de tests/accounting/posting-sod.spec.ts.
      // Se apaga en tests, no en src, porque es el arnés lo que la provoca.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',

      // Same third-party/`any` boundary as src, plus the fake pg client in
      // tests/helpers/fake-pg.ts, which is deliberately loosely typed so one
      // helper can stand in for every query shape.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',

      // `expect(obj.method).toHaveBeenCalled()` is the normal vitest assertion
      // form and is exactly what this rule flags. There is no vitest plugin
      // installed to supply the assertion-aware version, so it is off here and
      // stays on in src.
      '@typescript-eslint/unbound-method': 'off',

      // Tests must be able to simulate what a real SDK throws. failover.spec.ts
      // throws bare objects like `{ status: 429 }` on purpose, because the
      // failover code under test has to survive non-Error rejections.
      '@typescript-eslint/only-throw-error': 'off',

      // Test doubles are the one place `any` earns its keep: a stub only needs
      // to satisfy the call site, not the whole interface.
      '@typescript-eslint/no-explicit-any': 'off',

      // Off for a different reason than in src: spec files declare `async` on
      // every `it(...)` for consistency within a file, whether or not that
      // particular case awaits anything. An async test with no await is not a
      // defect, and no-floating-promises still catches a forgotten await.
      '@typescript-eslint/require-await': 'off',
    },
  },

  {
    // scripts/ runs under the same compiler settings as src (CommonJS, NodeNext)
    // and is covered by tsconfig.test.json, so it gets the same type-aware
    // treatment. This matters most for reclasificar-iva-ppd.ts, which rewrites
    // already-posted IVA: no-floating-promises is exactly the rule you want
    // pointed at a script that mutates the ledger.
    name: 'accounting-core/scripts',
    files: ['scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
