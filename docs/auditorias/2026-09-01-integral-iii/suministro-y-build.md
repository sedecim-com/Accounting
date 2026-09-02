# Lente 10 — Cadena de suministro y puertas de calidad

**Árbol auditado:** `61379d0` (origin/main `cfe40c6` + los dos commits de documentación del PR 19).
Todos los comandos se corrieron con `cwd` en ese árbol. Números de `npm audit` y de cobertura
medidos hoy, 2026-09-01, no heredados de la auditoría II.

**Nota de método:** el aviso del encargo decía que las ramas dependabot «llevan ahí» tiempo.
**Es falso y lo digo antes que nada:** las seis se abrieron hoy entre las 05:09 y las 07:27 UTC
(`git log -1 --format=%ci` sobre cada `origin/dependabot/*`). No hay abandono que reportar en ese
frente. Lo que sí hay es lo que esos PR contienen, y eso es el hallazgo 5.

---

## LO QUE RESISTE

Audito también a favor, porque varias cosas de esta lente están mejor de lo que el resto del
informe podría sugerir.

- **No hay un solo secreto real en el árbol.** Barrido con
  `grep -rnE "(password|secret|api_?key|token|passwd)\s*[:=]\s*['\"][^'\"]{8,}['\"]"` sobre `src/`
  y `scripts/`, descontando `process.env`: **cero aciertos**. El único literal parecido es
  `DEV_JWT_SECRET = 'dev-secret-change-me'` (`src/config/index.ts:14`), y el propio archivo lo
  documenta como publicado a propósito (`:166`) con negativa a arrancar en producción.
- **Los certificados versionados son sintéticos y verificablemente sintéticos.** Los tres
  `tests/fixtures/certs/*.cer` son DER autofirmados —`subject` idéntico a `issuer`— con los RFC
  genéricos del SAT: `AAA010101AAA` (csd, fiel) y `XAXX010101000` (seed). Las tres `.key` son
  PKCS#8 **cifradas** (OID `2a864886f70d010c`). La excepción `!tests/fixtures/certs/*.key` de
  `.gitignore:27` está justificada y el comentario de `.gitignore:20-22` la explica bien.
- **El lockfile está limpio.** `lockfileVersion: 3`, 587 paquetes con `resolved`, y **cero**
  resoluciones fuera de `registry.npmjs.org` (ni git, ni tarball http, ni `file:`). No hay
  dependencia inyectada por ruta.
- **`tsc` corre en estricto de verdad y sobre dos programas.** `tsconfig.json:9` pone
  `strict: true` sin desactivar nada por debajo, y la CI corre `typecheck` **y**
  `typecheck:tests` (`ci.yml:43-44`), es decir el árbol de pruebas también se tipa. Eso es más
  de lo que hace la mayoría.
- **La CI corre la suite de integración contra Postgres de verdad**, y además un job aparte
  (`aislamiento`, `ci.yml:135-184`) que conecta como `mnemosine_app` para que la RLS filtre. El
  comentario `ci.yml:152-155` explica por qué, y tiene razón. La regla de la casa (g) se cumple:
  los roles salen de `scripts/provision-roles.sql` (`ci.yml:171-176`), no de una migración.
- **La supresión de CodeQL que el autor NO puso.** `scripts/eval-clasificador.ts:111-115` documenta
  que se abstuvo de escribir `// codeql[js/insufficient-password-hash]` porque el escaneo por
  omisión de GitHub no honra esos comentarios, y **«creerse protegido por un no-op es peor que no
  tener nada»**. Es exactamente la regla (d) de la casa aplicada a una herramienta ajena. Resiste.
- **Sólo 4 `eslint-disable`, 0 `@ts-ignore`, 1 `@ts-expect-error` y 0 `as any` en `src/`.** La
  deuda de supresiones no existe.

---

## HALLAZGOS

### 1 · [NUEVA] · ALTA · El trinquete de cobertura vigila 3 de 16 archivos y es ciego por diseño a lo que prueba la integración

`vitest.config.ts:16` mide `src/services/accounting/**` — son **16 archivos**. `vitest.config.ts:36-49`
declara umbrales para **tres** de ellos (`posting.ts`, `validation.ts`, `ar-ap-posting.ts`) más
`src/utils/sequence.ts`. Los otros **trece no tienen umbral**.

Corrida real de hoy (`npx vitest run --coverage`, 142 archivos / 2185 pruebas en verde):

| archivo | % stmts | umbral |
|---|---|---|
| `iva-ppd-reclass.ts` | **0** | ninguno |
| `account-roles-backfill.ts` | **0** | ninguno |
| `period-close.ts` | 6,77 | ninguno (declarado) |
| `ledger-checks.ts` | 33,17 | ninguno |
| `entity-accounting.ts` | 41,02 | ninguno |
| `account-roles-service.ts` | 44,44 | ninguno |

**Me corrijo a mí mismo antes de que alguien lo haga:** esos 0 % **no** significan «sin pruebas».
`iva-ppd-reclass.ts`, `account-roles-backfill.ts` y `ledger-checks.ts` sí tienen prueba —
`tests/integration/iva-ppd-reclass.int.spec.ts`, `tests/integration/account-roles-backfill.int.spec.ts`,
`tests/integration/f01-catalogo-asiento-mayor.int.spec.ts`— y `vitest.config.ts:8` excluye
`tests/integration/**`. El 0 % es artefacto del corte.

**Y ahí está el hallazgo, que es peor que «sin pruebas».** `vitest.integration.config.ts` son quince
líneas (`:5-15`) y **no declara ni un bloque `coverage`**; el único `--coverage` de toda la CI está
en `ci.yml:59`, dentro del job `unit`, que es justo el que excluye la integración. Resultado: el
código que sólo prueba la integración **no tiene trinquete en ninguna de las dos suites**. Se puede
vaciar `iva-ppd-reclass.ts` y la puerta de cobertura no se entera, porque su porcentaje ya es 0 y
no hay umbral que violar.

Agravante de honestidad: `vitest.config.ts:25` dice **«Dos ausencias deliberadas»** y nombra
`period-close.ts` y `sequence.ts`. Las ausencias son **trece**. Once archivos del motor contable
—entre ellos los dos que mutan el mayor— quedan fuera sin que el archivo lo diga.

*Escenario de fallo:* alguien refactoriza `iva-ppd-reclass.ts` y rompe una rama que la prueba de
integración no cubre. `unit` verde (cobertura no lo mira), `integration` verde (no mide cobertura,
sólo pasa/falla), `plan` verde (E4.2 no habla de esto). El PR entra. La reclasificación de IVA PPD
—que según `scripts/reclasificar-iva-ppd.ts:132` toca «posteados sin hash, y con ellos, periodos que
ya no se pueden sellar»— sale a producción con la rama muerta.

### 2 · [NUEVA] · MEDIA · El trinquete de `sequence.ts` se quedó 10 puntos por debajo de lo medido

`vitest.config.ts:46-48` fija `statements: 69, lines: 69` para `src/utils/sequence.ts`, y el
comentario `:31-34` justifica el número diciendo **«Se deja el trinquete en lo medido en vez de
fingir que el objetivo se cumple»**. La medición de hoy da **79,12 %**.

El trinquete tiene 10,12 puntos de holgura: `sequence.ts` puede perder una décima parte de su
cobertura y la CI sigue verde. Los otros tres umbrales están apretados de verdad (posting 99 vs
100; validation 90 vs 94,28; ar-ap 96 vs 96,48), lo que confirma que 69 vs 79 es un trinquete que
resbaló, no una política.

*Escenario de fallo:* se borra el manejo de errores de `sequence.ts:63-81` (las líneas hoy
descubiertas son justo ésas más lo que subió después); la cobertura cae de 79 a ~70 y el umbral de
69 no se toca. El generador de folios pierde pruebas sin que nada lo diga — y el folio es lo que
la 043 ya rompió una vez.

### 3 · [NUEVA / II-EXAGERADA] · ALTA · `soap` no lo importa nadie, y es la única puerta de entrada de las dos vulnerabilidades ALTAS que la auditoría II señaló

La auditoría II (`seguridad-multitenant.md:85-90`, `:146`) nombró `axios` y `@xmldom/xmldom` como
«las dos que importan por dónde viven» y recomendó **«subir `soap` (o fijar overrides)»**. Reconstruí
el grafo desde `package-lock.json` (no desde `npm ls`, que aquí miente porque `node_modules` es un
enlace simbólico al proyecto principal):

- `axios@1.15.0` (ALTA, hasta CVSS 8,7 — MitM completo vía prototype pollution en `config.proxy`,
  GHSA-35jp-ww65-95wh) — padres: **`soap`** y `axios-ntlm`; y `axios-ntlm` también cuelga de `soap`.
- `@xmldom/xmldom@0.8.12` (ALTA, inyección de nodos XML) — padre: `xml-crypto`; padre de
  `xml-crypto`: **`soap`**.
- `form-data@4.0.5` (ALTA, inyección CRLF) — padre: `axios`.

Y `soap` (`package.json:53`) tiene **cero importaciones** en todo el árbol:
`grep -rnE "['\"]soap(/|['\"])" src/ tests/ scripts/` devuelve nada.

**La recomendación de la II es la cara: la barata es `npm uninstall soap`**, que se lleva las dos
ALTAS que ella llamó las que importan, más `form-data`, sin tocar una línea de código. Que la II
propusiera «subir soap» en vez de «borrar soap» es la exageración: trató como riesgo asumido lo
que es peso muerto.

*Escenario de fallo:* un despliegue instala 323 paquetes de producción, tres de ellos con ALTA
conocida, para servir una biblioteca SOAP que ningún módulo llama. La superficie es gratuita y no
compra nada.

### 4 · [NUEVA] · MEDIA · `kysely` es dependencia directa de producción, con ALTA de inyección SQL, y tampoco lo importa nadie

`package.json:46` declara `kysely: ^0.27.0`; instalado `0.27.6`; padre en el lockfile: **ROOT**.
Tres advisories vivas, la peor **CVSS 8,2 — SQL Injection vía claves de ruta JSON sin sanear**
(GHSA-wmrf-hv6w-mr66), más GHSA-pv5w-4p9q-p3v2 (7,5, `JSONPathBuilder.key()/.at()`) y
GHSA-8cpq-38p9-67gx (8,1). Importaciones en `src/`, `tests/`, `scripts/`: **cero**.

La auditoría II midió los mismos 14 hallazgos de producción que yo mido hoy (9 moderadas + 5 altas
— coinciden exactamente) pero enumeró sólo axios y xmldom. **`kysely` se le escapó**, y es la más
llamativa de la lista: un constructor de SQL con inyección SQL declarada, en un sistema contable
multi-inquilino con RLS. Que no se use es lo que salva el caso — pero eso hay que decirlo, no
suponerlo, y nadie lo había dicho.

*Escenario de fallo:* el hallazgo real no es explotación (no hay ruta), es gobierno: el día que
alguien decida «ya tenemos kysely, úsalo para la consulta nueva», hereda 0.27.6 con tres inyecciones
sin que ninguna puerta chiste. Y `npm audit` no está en la CI (hallazgo 9), así que no chistaría.

### 5 · [NUEVA] · MEDIA · El grupo «menores-y-parches» de dependabot está embarcando saltos ROMPEDORES de dependencias 0.x

`.github/dependabot.yml:10-12` agrupa por `update-types: [minor, patch]`. Para paquetes **0.x** el
segundo dígito es la versión mayor de facto, y dependabot lo clasifica como *minor*. El diff de
`origin/dependabot/npm_and_yarn/menores-y-parches-8408abafd4` sobre `package.json` lo confirma:

- `kysely: ^0.27.0 → ^0.29.5` — dos mayores 0.x.
- `@anthropic-ai/sdk: ^0.120.0 → ^0.122.0` — y **este sí se usa: 15 archivos de `src/`**.

Van dentro de un PR único con **556 líneas de diff de lockfile** y el rótulo «menores y parches»,
que es precisamente la caja que el comentario de `dependabot.yml:1-2` creó para que se pudiera
revisar de un vistazo. El caret (`^0.120.0`) sí protege el lockfile por sí solo —no deriva—; la
única puerta es la lectura del PR, y el agrupamiento es lo que la anula.

*Escenario de fallo:* se fusiona el PR agrupado mirando el rótulo. `@anthropic-ai/sdk` 0.122 cambia
la forma de un `tool_use` o de un `stop_reason`; `typecheck` puede pasarlo si el tipo es compatible
y el cambio es de conducta. El agente contable degrada en silencio, y el commit que lo hizo dice
«Bump the menores-y-parches group with 11 updates».

### 6 · [NUEVA] · MEDIA · Las acciones que ejecutan la única puerta automática van en etiqueta móvil, y dependabot ya propone saltarles dos mayores

`ci.yml:37-38` (y en los cinco jobs) usan `actions/checkout@v4` y `actions/setup-node@v4`:
**etiquetas, no SHA**. En un repositorio público, `@v4` es un puntero que el proveedor de la acción
puede reapuntar. `CODEOWNERS:23` dice **«La CI es la única puerta automática: quien la edita, edita
la puerta»** — y protege el *archivo*, no el *contenido* de lo que el archivo invoca.

Peor: el grupo `acciones` de `dependabot.yml:16-19` usa `patterns: ['*']` **sin `update-types`**, así
que propone mayores. La rama abierta hoy
(`origin/dependabot/github_actions/acciones-9b61906d8b`) lleva `checkout@v4 → @v7` y
`setup-node@v4 → @v7` en los cinco jobs, de una sentada.

*Escenario de fallo:* se fusiona el bump por ser «de dependabot». `setup-node@v7` cambia el
comportamiento de `cache: npm` o el resolutor de `node-version`; los cinco jobs empiezan a correr
sobre un Node distinto del declarado, o el `npm ci` deja de restaurar caché y los tiempos se
disparan. El diff que lo causó son diez líneas idénticas y nadie las mira dos veces.

### 7 · [NUEVA] · MEDIA · `scripts/` está fuera de los dos `tsconfig`: seis archivos no los tipa nadie, y uno ya no compila

`tsconfig.json:22` incluye `src/**/*` y `:23` excluye `tests`. `tsconfig.test.json:3-6` incluye
`src` y `tests`. **`scripts/` no está en ninguno.** Verificado con `tsc --listFilesOnly`: sólo dos
scripts entran al programa, y por arrastre (algún test los importa) —`catalogo-estado.ts` y
`build-niif-indice.ts`—. Los otros seis no entran a ningún programa de `tsc`:

`artefacto-catalogo.ts`, `costo-por-fila.ts`, `eval-clasificador.ts`, `generate-cli-reference.ts`,
`reclasificar-iva-ppd.ts`, `rellenar-roles-de-cuenta.ts`.

Compilándolos a mano con los flags del propio proyecto sale un error real:

```
scripts/generate-cli-reference.ts(55,41): error TS1470:
  The 'import.meta' meta-property is not allowed in files which will build into CommonJS output.
```

Dos matices honestos, para no inflar esto: (a) los dos scripts de respaldo (`reclasificar-iva-ppd.ts`,
`rellenar-roles-de-cuenta.ts`) son envoltorios delgados —censan por omisión, escriben sólo con
`--aplicar` (`rellenar-roles-de-cuenta.ts:14`, `reclasificar-iva-ppd.ts:16`)— y su lógica vive en
`src/services/accounting/`, que sí se tipa; (b) `generate-cli-reference.ts` no está en `npm run build`,
así que el TS1470 hoy no rompe nada. Pero `eval-clasificador.ts` es el arnés de evaluación del
clasificador y lleva la lógica de redacción de credenciales (`:83-134`) — es el peor archivo del
repositorio para dejar sin tipar, y está sin tipar.

*Escenario de fallo:* alguien cambia la firma de `sinSecretos` o el tipo de `HUELLAS` en
`eval-clasificador.ts`; `npm run typecheck` y `typecheck:tests` pasan los dos porque el archivo no
está en sus programas; el redactor deja de tachar y el mensaje de error del proveedor —con la
credencial— acaba en la bitácora pública de Actions, que es exactamente lo que `:63-69` dice temer.

### 8 · [NUEVA] · MEDIA · `.gitignore` cubre `.key`, `.pem`, `.p12` y `.pfx` — pero no `.cer`, que es la otra mitad del par que entrega el SAT

`.gitignore:23-26` lista cuatro extensiones bajo el rótulo «Material criptográfico real»
(`:20-22`). Comprobado con `git check-ignore -v`:

```
prueba.cer                  → (sin regla)
FIEL_AAA010101AAA.cer       → (sin regla)
x.key / x.pem / x.p12 / x.pfx → .gitignore:23/24/25/26
```

El SAT entrega la e.firma y el CSD como **par `.cer` + `.key`**. La mitad `.key` la ataja el glob
—y el desarrollador ve el bloqueo—; la mitad `.cer` pasa callada. Es una protección parcial que se
lee como total, en un repositorio **público**.

No exagero el contenido: un `.cer` es la parte pública. Pero lleva el RFC del contribuyente, la
razón social, el número de serie del certificado y su vigencia — identidad fiscal completa de un
cliente real. La regla (e) de la casa dice que la e.firma jamás se pide por chat ni se guarda en
Postgres; el árbol de trabajo es la tercera puerta y está entornada.

*Escenario de fallo:* un operador descomprime el zip del SAT en la raíz para probar la bóveda y hace
`git add -A`. El `.key` se bloquea, él ve el bloqueo y confía. El `.cer` entra, se empuja, y el RFC
y la razón social de un contribuyente real quedan en el historial público de git — donde borrarlos
exige reescribir la historia.

### 9 · [NUEVA] · MEDIA · CodeQL no existe en el árbol: ni flujo, ni configuración, ni registro de descartes

`find . -iname "*codeql*"` sobre todo el repositorio (menos `node_modules`): **cero archivos**.
`.github/workflows/` contiene **un solo archivo**, `ci.yml`, y no menciona CodeQL. Sin embargo hay
cuatro commits de CodeQL en el historial (la propia auditoría II los cita,
`maestro-vs-codigo.md:160`) y tres archivos del fuente comentan hallazgos suyos
(`src/api/rest/middleware/rate-limiter.ts:21`, `src/api/rest/routes/xml-ingestion.ts:50`,
`scripts/eval-clasificador.ts:73`).

O sea: CodeQL corre por el **«escaneo por omisión» de GitHub**, y el propio autor lo dice con esas
palabras en `scripts/eval-clasificador.ts:113`. Consecuencias, todas verificables desde el árbol:

- **No se sabe qué reglas corren.** El default setup elige el conjunto de consultas por su cuenta y
  puede cambiarlo sin un commit. No hay `queries:` que revisar.
- **Los descartes viven fuera del repositorio.** `eval-clasificador.ts:111-112` remite a «el panel de
  seguridad (alerta #22)». Esa justificación —que es buena, la leí y es correcta— no viaja en el
  diff, no la ve un revisor, y no la protege `CODEOWNERS`.
- **`CODEOWNERS:24` protege `/.github/workflows/` — donde CodeQL no está.** Quien pueda tocar los
  ajustes del repositorio apaga el análisis estático sin generar un diff que alguien tenga que
  aprobar.
- **No es reproducible en local.** Nadie puede correr el mismo análisis antes de abrir el PR.

*Escenario de fallo:* se desactiva el escaneo por omisión, o GitHub cambia el conjunto de consultas
por omisión. No hay commit, no hay revisión, no hay rojo. El repositorio sigue diciendo lo mismo que
decía ayer, y `CODEOWNERS` sigue prometiendo custodia sobre un directorio que no contiene la puerta.

### 10 · [NUEVA] · BAJA · `npm run graphql:codegen` invoca un binario que no existe en el lockfile

`package.json:17` declara `"graphql:codegen": "graphql-codegen"`. `grep "graphql-codegen"
package-lock.json` → **cero aciertos**. El comando falla con «command not found» en cualquier
árbol limpio. Es un script de mantenimiento muerto que aparenta capacidad.

### 11 · [NUEVA] · BAJA · Cinco dependencias directas de producción sin un solo consumidor, y un paquete de tipos embarcado a producción

Contadas: **29 directas de producción + 13 de desarrollo**; 323 paquetes de producción y 264 de
desarrollo en el lockfile. Sin importación alguna en `src/`, `tests/` ni `scripts/`:

| paquete | línea | por qué duele |
|---|---|---|
| `soap` | `package.json:53` | trae axios + xml-crypto/xmldom (hallazgo 3) |
| `kysely` | `package.json:46` | ALTA de inyección SQL (hallazgo 4) |
| `bullmq` | `package.json:34` | arrastra `uuid` con su moderada |
| `@graphql-tools/schema` | `package.json:31` | — |
| `graphql` | `package.json:41` | sólo lo necesita `@apollo/server` como par |

Además `@types/node-forge` (`package.json:32`) está en **`dependencies`**, no en `devDependencies`:
un paquete de sólo-tipos que se instala en producción. `node-forge` sí se usa
(`src/services/fiscal-credentials/certificate.ts:1`); sus tipos no hacen falta en tiempo de ejecución.

Esto es la versión-dependencias de la «capacidad huérfana» que `doctor` ya persigue en tablas y
exports. El instrumento la mira dentro del código y no la mira en el `package.json`.

### 12 · [NUEVA] · BAJA · El job `unit` corre la suite entera dos veces, y `npm ci` ejecuta scripts de instalación

Dos cosas menores del mismo job:

- `ci.yml:56` corre `npm test` y `ci.yml:59` corre `npx vitest run --coverage`. Vitest resuelve
  `vitest.config.ts` por omisión, así que es **la misma suite completa dos veces**: 2185 pruebas en
  ~26 s cada pasada. La segunda basta para las dos cosas.
- No hay `.npmrc` ni `--ignore-scripts` en ningún `npm ci` (los cinco jobs). El lockfile declara
  cinco paquetes con script de instalación, **dos de ellos de producción**: `@apollo/protobufjs` y
  `msgpackr-extract` (este último por `bullmq`, que nadie importa — hallazgo 11). El radio de daño
  está acotado: `permissions: contents: read` (`ci.yml:26-27`) y el job no tiene secretos. Pero el
  árbol de dependencias corre código arbitrario en el ejecutor en cada PR, incluidos los de fork.

---

## VERIFICACIÓN DE LA AUDITORÍA II

Cuatro afirmaciones suyas caen en mi lente. **Ninguna cerró.** Ninguna estaba mal medida salvo el
matiz del hallazgo 3.

| # | Afirmación de la II | Estado hoy en `61379d0` |
|---|---|---|
| a | «`ci.yml` no tiene ningún paso de `npm audit`» (`seguridad-multitenant.md:90`) | **[II-SIGUE-VIVA]** `grep "npm audit" .github/workflows/ci.yml` → cero. Y la puerta que propone su R9 daría rojo hoy: `npm audit --omit=dev --audit-level=high` → **exit=1**. |
| b | «14 vulnerabilidades de producción (9 moderadas, 5 altas)» (`:85`) | **[II-SIGUE-VIVA, y su número era exacto]** medido hoy: `{"moderate":9,"high":5,"critical":0,"total":14}`. Idéntico. Contando desarrollo: 23 (11 moderadas, 10 altas, **2 críticas** — `vitest` y `@vitest/coverage-v8`, GHSA de lectura/ejecución arbitraria con el servidor de UI escuchando). |
| c | «`npm run lint` no es un no-op, es un script **roto**» (`maestro-vs-codigo.md:196`) | **[II-SIGUE-VIVA, y su corrección era la correcta]** reproducido: `ESLint: 8.57.1 / No files matching the pattern "src/"`, **exit=2**. No existe `.eslintrc*` ni `eslint.config.*` ni clave `eslintConfig` en ninguna parte del árbol. Añado lo que ella no dijo: `lint` **tampoco está en la CI**, así que su rotura no tiene consecuencia — y las dos ramas dependabot de `js-yaml` y `postcss` son transitivas de `eslint` y `vite`, es decir, parches para una herramienta que no corre. |
| d | «CI no corre `npm run build`; ningún criterio mira la deuda de dependencias» (`instrumento-ii.md:63`, `:114`) | **[II-SIGUE-VIVA]** `grep "npm run build" .github/workflows/ci.yml` → cero. `grep -in "npm audit\|vulnerab\|dependab\|eslint\|dependenc" src/plan/criterios.ts` → **cero aciertos**. Ninguno de los 70 criterios declarados mira la cadena de suministro. |

**Exagerada:** la de `seguridad-multitenant.md:146` — «subir `soap` (o fijar overrides de `axios` y
`@xmldom/xmldom`)». Trató una dependencia muerta como un coste a pagar. Ver hallazgo 3.

**Cerradas: ninguna.** Lo digo sin adornos: en esta lente, entre la auditoría II de ayer y hoy, no
se cerró nada. Lo único que se movió fueron seis ramas de dependabot abiertas hoy, ninguna fusionada.

---

## RECOMENDACIONES

Ordenadas por relación consecuencia/coste. El tramo destino sale del vocabulario de
`docs/plan-catalogo.md` y de la lista `--exigir` de `ci.yml:94`.

| # | Qué | Tamaño | Tramo destino |
|---|---|---|---|
| R1 | **`npm uninstall soap kysely bullmq @graphql-tools/schema` y mover `@types/node-forge` a `devDependencies`.** Cierra de un golpe las dos ALTAS que la II llamó las que importan, más la ALTA de inyección SQL de kysely y la moderada de form-data. Cero líneas de código tocadas. Vuelve a añadirse el día que se use, con la versión de ese día. | **S** | inmediata (gobernanza) |
| R2 | **Poner umbral por archivo a los trece huérfanos de `vitest.config.ts`**, fijado en lo medido hoy, y **subir el de `sequence.ts` de 69 a 79**. Si un archivo mide 0 porque su prueba es de integración, que el comentario lo diga por su nombre, como ya hace con `period-close.ts`. Un trinquete que documenta 2 de 13 huecos no es un trinquete. | **S** | inmediata (E4.2 / instrumento) |
| R3 | **Declarar cobertura en `vitest.integration.config.ts`** con umbrales sobre los cuatro módulos que sólo ella prueba (`iva-ppd-reclass`, `account-roles-backfill`, `ledger-checks`, `period-close`) y correrla con `--coverage` en el job `integration`. Sin esto, R2 sólo documenta el agujero; esto lo tapa. Es la mitad cara del hallazgo 1 y la que de verdad importa. | **M** | fase 1 (E4.2) |
| R4 | **Meter `scripts/` en `tsconfig.test.json`** (`include: ["src/**/*", "tests/**/*", "scripts/**/*"]`) y arreglar el TS1470 de `generate-cli-reference.ts:55`. Seis archivos entran a la puerta que ya existe; no hay job nuevo que pagar. | **S** | inmediata |
| R5 | **Job `npm audit --omit=dev --audit-level=high`** (la R9 de la II, que sigue sin hacerse). Hoy daría rojo; tras R1 debería dar verde, y ése es justamente el orden correcto: primero se limpia, luego se pone la puerta que impide volver a ensuciar. | **S** | inmediata (gobernanza) |
| R6 | **Fijar las acciones a SHA** (`actions/checkout@<sha> # v4`) y acotar el grupo `acciones` de `dependabot.yml` a `update-types: [minor, patch]`, para que un salto mayor de la puerta llegue en su propio PR y no de a diez líneas. Coherente con lo que `CODEOWNERS:23` ya afirma querer. | **S** | inmediata (gobernanza) |
| R7 | **Sacar las dependencias `0.x` del grupo «menores-y-parches»** con un `ignore`/grupo propio para `@anthropic-ai/sdk` y cualquier otra 0.x. Bajo semver 0.x el segundo dígito rompe, y el rótulo del grupo dice lo contrario. | **S** | inmediata (gobernanza) |
| R8 | **Añadir `.cer`, `.crt`, `.der` y `.jks` a `.gitignore:23-26`**, con su excepción para `tests/fixtures/certs/`, y una prueba que afirme la invariante — `git check-ignore` sobre las seis extensiones — para que el glob no se erosione. Cuatro líneas y un spec. | **S** | inmediata (F08 / credenciales fiscales) |
| R9 | **Bajar CodeQL al árbol**: un `.github/workflows/codeql.yml` con su `queries:` explícito, y trasladar el descarte de la alerta #22 a un `.github/codeql/config.yml` versionado. Así el análisis estático queda bajo `CODEOWNERS:24` como el resto de la puerta, es reproducible en local, y apagarlo cuesta un diff que alguien tiene que aprobar. | **M** | fase 1 (gobernanza) |
| R10 | **Un criterio de plan que mire la cadena de suministro** — altas de producción en cero y `lint` con exit 0 —, porque hoy los 70 criterios de `src/plan/criterios.ts` no tienen ni uno. Con la advertencia que la propia II levantó: que juzgue **conducta** (correr `npm audit` y leer el código de salida), no una regex sobre `ci.yml`, o nace con el vicio que persigue. | **M** | fase 1 (instrumento) |
| R11 | **Decidir sobre `lint`**: o se le pone `eslint.config.js` con `@typescript-eslint` y entra a la CI como sexto job, o se borra del `package.json:15` y de `CONTRIBUTING.md:35`. Lo que no puede seguir es anunciado y roto — es un verde falso en la documentación, que es la regla (d) al revés. | **S** (borrar) / **L** (configurar) | inmediata / fase 1 |
| R12 | **Quitar `npm test` de `ci.yml:56`**, que `npx vitest run --coverage` ya lo cubre, y añadir `--ignore-scripts` a los `npm ci` que no lo necesiten. Ahorra la mitad del job `unit` y cierra la ejecución de código de instalación en el ejecutor. | **S** | inmediata |
