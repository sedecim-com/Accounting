# ADR-0005 · TypeScript 6, y el 7 cuando typescript-eslint lo admita

- **Fecha:** 2026-09-26
- **Estado:** propuesta.
- **Viene de:** #351, la propuesta de Dependabot de pasar de 5.9 a 7.0, que se cerró sin fusionar.

## Contexto

En #351, `npm ci` falla con ERESOLVE antes de compilar: typescript-eslint no admite el 7. Pero quedarse en 5.9.3 tampoco sirve: es la última 5.x publicada, así que quedarse ahí es congelar el compilador.

**El 6.0.3 sí se instala, y pide un solo cambio.** TS 6 declara obsoleta la opción `baseUrl` (error TS5101), y en este repo no hacía nada: ningún import usa `@/…` ni un especificador desnudo como `src/…`. Se quita, y `paths` pasa a `./src/*`. Medido el 2026-09-26:

- `tsc` compila los dos proyectos sin errores;
- `dist/` sale idéntico, byte a byte, al del 5.9.3;
- lint da las mismas advertencias, con el mismo texto;
- `scripts/verify.sh`, `plan:status --piso` y `npm run mutantes` quedan en verde.

**Qué bloquea el 7** (typescript 7.0.2 y typescript-eslint 8.70.1, el 2026-09-26):

1. **typescript-eslint.** Su versión estable y la canary declaran `typescript >=4.8.4 <6.1.0`, y no existe una 9.x. El lint con información de tipos (`parserOptions.project` en `eslint.config.mjs`) necesita el `Program` y el `TypeChecker` en proceso, y el 7 no los ofrece. Por eso falla `npm ci`, y con `--legacy-peer-deps` fallaría el lint al correr. El seguimiento está en typescript-eslint#10940.
2. **El 7 no trae la API clásica.** `require('typescript')` sólo devuelve la versión. El resto vive en `typescript/unstable/*`, sin semver, y para parsear texto hay que lanzar el binario `tsgo` y hablarle por IPC. Además:
   - no existen `ts.forEachChild` (queda el método `node.forEachChild`) ni `node.getChildren()`;
   - cambian de nombre `isFunctionLike`, `isGetAccessor`, `isSetAccessor`, `isParameter`, `isMethodSignature`, `isPropertySignature` e `isStringLiteralLike`.
3. **Diez archivos leen código con esa API**, y la mitad son instrumentos de medida:
   - el tablero del plan, que se verifica por mutación: los ayudantes de `src/plan/criteria/shared.ts` y los criterios de `src/plan/criteria/e0-0.ts`. Sus recorridos usan `getChildren()`, que también devuelve los tokens;
   - el metro del idioma: `scripts/language/extract.ts`, `scripts/language/lanes/code.ts` y `scripts/language/lanes/plan.ts`. Este último publica en `scripts/language/lanes/plan.ts:615` una receta `npx tsx -e '…require("typescript")…'` para reproducir su cifra, y con el 7 dejaría de funcionar;
   - cinco pruebas: `tests/ai/eval/arnes-cableado.spec.ts`, `tests/cli/codigos-de-salida-hojas.spec.ts`, `tests/i18n/sync.spec.ts`, `tests/language/extract.spec.ts` y `tests/language/lexicon-conformance.spec.ts`.

**Lo que no bloquea:** `tsx`, vitest y la compilación misma. El `tsc` del 7 revisa los dos proyectos sin errores, en unos 5 s frente a unos 24 s del 6 para `tsconfig.test.json`. Su salida sólo cambia en la forma: el orden de las uniones y las comillas de los `.d.ts`, y un salto de línea en un `.js`.

## Decisión

1. **TypeScript sube a `^6.0.3` y `baseUrl` sale de `tsconfig.json`.** No se usa `ignoreDeprecations`, porque sólo aplazaría el mismo error hasta el 7, donde `baseUrl` ya no existe.
2. **El 7 espera a que typescript-eslint lo admita.** Cuando lo haga, el camino con menos riesgo es:
   - el 7 queda como `typescript` raíz, para `tsc`;
   - los diez archivos, y la receta de `plan.ts`, importan la API clásica de `@typescript/typescript6`, el paquete oficial que la conserva junto al 7.

   Es un cambio mecánico de imports. Pero toca el tablero del plan y el metro, así que se re-verifica con `npm run mutantes` y `npm run language:status`.
3. **Portar esos archivos a `typescript/unstable/*` es otra migración, con su propia issue.** La API es inestable, parsear lanza un proceso, y los recorridos por `getChildren()` tienen que volver a probarse por mutación.

**Descartado:**

- **Quedarse en 5.9.3.** Congela el compilador: no hay más 5.x.
- **Dos compiladores desde ya:** el 7 como alias `npm:typescript@7` sólo para `tsc`, y el 6 para lint y para leer código. Se instala y compila, pero la misma puerta tendría dos compiladores detrás, y la velocidad no lo justifica todavía.
- **`--legacy-peer-deps`.** Instala el 7 y rompe el lint al correr.

## Consecuencias

- Mientras typescript-eslint diga `<6.1.0`, una propuesta del 7 va a fallar en `npm ci`. Se cierra citando este ADR. Cómo la filtra Dependabot se decide en otro PR, y el filtro tiene que dejar pasar el 6.
- Un parche de 6.0 entra como cualquier otra dependencia.
- Este ADR se revisa cuando typescript-eslint publique una versión que admita el 7.
