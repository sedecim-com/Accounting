# ADR-0005 · TypeScript 6, and 7 once typescript-eslint supports it

- **Date:** 2026-09-26
- **Status:** proposed.
- **Comes from:** #351, Dependabot's proposal to go from 5.9 to 7.0, closed without merging.

## Context

In #351, `npm ci` fails with ERESOLVE before anything compiles: typescript-eslint does not support 7. Staying on 5.9.3 is no answer either. It is the last 5.x ever published, so staying there freezes the compiler.

**6.0.3 installs, and asks for a single change.** TS 6 deprecates the `baseUrl` option (error TS5101), and in this repo it did nothing: no import uses `@/…` or a bare `src/…` specifier. It is removed, and `paths` becomes `./src/*`. Measured on 2026-09-26:

- `tsc` compiles both projects with no errors;
- `dist/` comes out byte for byte identical to 5.9.3's;
- lint reports the same warnings, with the same text;
- `scripts/verify.sh`, `plan:status --piso` and `npm run mutantes` stay green.

**What blocks 7** (typescript 7.0.2 and typescript-eslint 8.70.1, on 2026-09-26):

1. **typescript-eslint.** Its stable and canary releases both declare `typescript >=4.8.4 <6.1.0`, and there is no 9.x. Type-aware lint (`parserOptions.project` in `eslint.config.mjs`) needs the `Program` and the `TypeChecker` in process, and 7 does not provide them. That is why `npm ci` fails; with `--legacy-peer-deps` lint would fail at run time instead. Tracked upstream in typescript-eslint#10940.
2. **7 ships without the classic API.** `require('typescript')` only returns the version. Everything else lives under `typescript/unstable/*`, with no semver, and parsing text means launching the `tsgo` binary and talking to it over IPC. Also:
   - `ts.forEachChild` is gone (the `node.forEachChild` method remains), and so is `node.getChildren()`;
   - `isFunctionLike`, `isGetAccessor`, `isSetAccessor`, `isParameter`, `isMethodSignature`, `isPropertySignature` and `isStringLiteralLike` are renamed.
3. **Ten files read code through that API**, and half of them are measuring instruments:
   - the plan board, which is verified by mutation: the helpers in `src/plan/criteria/shared.ts` and the criteria in `src/plan/criteria/e0-0.ts`. Their walks use `getChildren()`, which also returns tokens;
   - the language meter: `scripts/language/extract.ts`, `scripts/language/lanes/code.ts` and `scripts/language/lanes/plan.ts`. The last one publishes a `npx tsx -e '…require("typescript")…'` recipe to reproduce its figure, and under 7 that recipe would stop working;
   - five tests: `tests/ai/eval/arnes-cableado.spec.ts`, `tests/cli/codigos-de-salida-hojas.spec.ts`, `tests/i18n/sync.spec.ts`, `tests/language/extract.spec.ts` and `tests/language/lexicon-conformance.spec.ts`.

**What does not block:** `tsx`, vitest and compilation itself. 7's `tsc` checks both projects with no errors, in about 5 s against about 24 s for 6 on `tsconfig.test.json`. Its output only changes in form: the order of unions and the quotes in `.d.ts` files, and one line break in a `.js` file.

## Decision

1. **TypeScript moves to `^6.0.3` and `baseUrl` leaves `tsconfig.json`.** `ignoreDeprecations` is not used: it would only postpone the same error until 7, where `baseUrl` no longer exists.
2. **7 waits until typescript-eslint supports it.** When it does, the lowest-risk path is:
   - 7 becomes the root `typescript`, for `tsc`;
   - the ten files, and the recipe in `plan.ts`, import the classic API from `@typescript/typescript6`, the official package that keeps it alongside 7.

   That is a mechanical change of imports. But it touches the plan board and the meter, so it is re-verified with `npm run mutantes` and `npm run language:status`.
3. **Porting those files to `typescript/unstable/*` is a separate migration, with its own issue.** The API is unstable, parsing spawns a process, and the walks over `getChildren()` have to be proven again by mutation.

**Rejected:**

- **Staying on 5.9.3.** It freezes the compiler: there will be no more 5.x.
- **Two compilers right away:** 7 as an `npm:typescript@7` alias only for `tsc`, and 6 for lint and for reading code. It installs and compiles, but the same gate would have two compilers behind it, and the speed does not justify that yet.
- **`--legacy-peer-deps`.** It installs 7 and breaks lint at run time.

## Consequences

- `.github/dependabot.yml` ignores major updates of `typescript` (#368). Once this lands on 6, that keeps 7 out; 6.x minors and patches keep arriving in the usual group.
- A proposal for 7 that arrives some other way will fail `npm ci` while typescript-eslint says `<6.1.0`. It is closed citing this ADR.
- This ADR is revisited when typescript-eslint publishes a version that supports 7, and the dependabot ignore is lifted in the same change.
