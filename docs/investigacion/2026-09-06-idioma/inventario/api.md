# Inventario de idioma — superficie API (REST + GraphQL)

Raíz: `/Users/victor/projects/Accounting` · rama `instrumentos-que-mienten-segun-la-maquina` · fecha 2026-09-06.
Todas las rutas son relativas a la raíz. Ningún archivo del repositorio fue editado. Los artefactos de trabajo viven en `/tmp/investigacion-idioma/inventario/`:

- `api.md` — este informe.
- `api-extraer-cadenas.mjs` — extractor de cadenas de usuario con clasificación de idioma (reproducible).
- `api-cadenas.tsv` — su salida (890 filas: `archivo:línea · clase · idioma · constructor[código] · texto`).
- `api-codigos-distintos.txt` — los 59 códigos distintos de `AccountingError`.

Nota de seguridad: ningún archivo leído contenía instrucciones dirigidas al agente; nada que anotar.

---

## 1. Qué es la superficie y cómo viaja un error

**Contrato de error (una sola clase para las dos puertas).** `src/utils/errors.ts:1-12` define `AppError { statusCode, code, message, field?, details? }`. De ella cuelgan `ValidationError` (422, `VALIDATION_ERROR`, :14-19), `NotFoundError` (404, `RESOURCE_NOT_FOUND`, :21-26; el mensaje se arma como `` `${resource} with id ${id} not found` ``), `ConflictError` (409, `RESOURCE_ALREADY_EXISTS`, :28-33), `UnauthorizedError` (401, :35-40), `ForbiddenError` (403, :42-47), `NotImplementedError` (501, `NOT_IMPLEMENTED`, :62-67) y `AccountingError(code, message, details)` (422 con código libre, :69-74). Hay además un objeto `ErrorCodes` con 10 nombres (:77-88) del que sólo `PERIOD_CLOSED` se usa (ver §3).

**REST.** `src/api/rest/middleware/error-handler.ts:12-27` serializa cualquier `AppError` como
`{ errors: [{ code, message, field, details }], meta: { request_id, timestamp, version: 'v1' } }`; lo que no es `AppError` sale como 500 con `code: 'INTERNAL_SERVER_ERROR'`, `message: 'An unexpected error occurred'` (:31-44). Es el único punto de salida para los errores lanzados; el `code` es el discriminador estable y `message` es prosa libre.

**GraphQL.** `src/api/graphql/errores.ts:23-43` (`formatearError`) traduce el MISMO `AppError` a `extensions: { code, status, field, details }` con `message` arriba, y deja pasar sin reinterpretar lo que no es `AppError` (sólo le quita `stacktrace`, :41-42). Consecuencia: los errores nativos de Apollo/graphql-js (validación de consulta, `BAD_USER_INPUT`, etc.) salen con el texto en inglés de la librería y no pasan por ningún catálogo. Se cablea en `src/index.ts:262-268` (`formatError: formatearError`).

**Zod.** `src/api/rest/middleware/async-handler.ts:64-70` (`validateBody`) y `:84-90` (`validateQuery`) convierten un `ZodError` en un `ValidationError` cuyo mensaje concatena `` `${path}: ${e.message}` `` bajo el prefijo `Invalid request body:` / `Invalid query params:`. No hay `z.setErrorMap` ni `errorMap` en `src/` (grep = 0), así que los mensajes por omisión de Zod (`Required`, `Expected string, received number`…) salen en el inglés de la librería. 46 esquemas de cuerpo pasan por aquí.

**Tres salidas que esquivan `AppError`.** `src/api/rest/routes/public-verification.ts:48-56` responde 501 a mano con `code: 'ATTESTATION_SIMULATED'` y mensaje en castellano; `:96-99` responde 404 a mano con `code: 'NOT_FOUND'` (no `RESOURCE_NOT_FOUND`) y mensaje en inglés; `src/api/rest/middleware/rate-limiter.ts:46-47` responde 429 con `RATE_LIMIT_EXCEEDED` / `Too many requests. Please try again later.`. Mismo sobre, sin pasar por `errorHandler`.

**Quién más consume el mismo mensaje.** El CLI llama a los servicios directamente y **imprime el `message` del `AccountingError` tal cual** (`src/cli/entry-command.ts:143-149`, `translateDomainError` conserva `message` y mapea `code` a código de salida). Es decir: el texto que hoy escribe un servicio es a la vez la prosa del JSON de la API y la del terminal del CLI. Un catálogo de mensajes a nivel de servicio (clave + parámetros) sirve a las dos superficies a la vez; uno sólo en la API no.

**Negociación de idioma hoy: ninguna.** No hay `Accept-Language`, ni cabecera propia, ni preferencia de usuario o inquilino:
```
grep -rniE "accept-language|acceptslanguages|acceptlanguage|x-idioma|x-locale|x-language|\bidioma\b|\blocale\b|\bi18n\b|\bintl\b" src tests --include='*.ts' -l
```
devuelve 41 archivos, y en `src/api` los únicos son `reports.ts:249` (un comentario: «`?method=` en el idioma de la API (inglés) y en el del panel (español)») y `openapi.ts:83` (`localeCompare`). Las cabeceras que la API ya lee son `x-request-id` (82 lecturas), `x-entity-id` (2) y `user-agent` (1):
```
grep -rhoE "headers\[['\"]x-[a-z-]+['\"]\]|req\.get\(['\"][A-Za-z-]+['\"]\)" src/api | sort | uniq -c | sort -rn
```

---

## 2. Método y comandos

Todo lo contado abajo se contó con estos comandos (cwd = raíz del repo).

| # | Qué | Comando |
|---|-----|---------|
| C1 | Archivos y líneas de `src/api` | `find src/api -type f \| sort` · `find src/api -type f -name '*.ts' \| xargs wc -l \| tail -1` |
| C2 | Llamadas a `AccountingError` y sus códigos (multilínea, con archivo:línea) | `for f in $(grep -rlE "new AccountingError\(" src); do perl -0ne 'my $f=$ARGV; while(/new AccountingError\(\s*(?:ErrorCodes\.([A-Z_]+)\|[\x27"]([A-Z0-9_]+)[\x27"])/g){ my $c=$1\|\|$2; my $pre=substr($_,0,pos($_)); my $l=($pre=~tr/\n//)+1; print "$f:$l:$c\n"; }' "$f"; done \| sort > …/codigos-accounting.txt; cut -d: -f3 … \| sort -u` |
| C3 | Códigos distintos con vocablo castellano | `grep -E "$ES_TOK" api-codigos-distintos.txt \| wc -l` con `ES_TOK='(^\|_)(QUIEN\|CREA\|POSTEA\|RESUELTO\|SIN\|ORIGEN\|INCOMPLETO\|REQUIERE\|DECISION\|CIERRE\|YA\|EMITIDO\|CONVERSION\|CASA\|POLITICA\|DESCONOCIDA\|DESCONOCIDO\|TIPO\|DE\|LA\|FUENTE\|BASES\|DISTINTAS\|AMBIGUA\|MEDIO\|PERIODO\|UN\|MES\|INVERTIDO\|INDICE\|PETICION\|GRANDE\|RESPUESTA\|ILEGIBLE\|SIMULADO\|TIMBRADO\|PAGOS\|RESULTADO\|BARRER\|SUBSIDIO\|REGISTRO\|PROVEEDOR\|NUEVO\|AUTORIZAR\|ENTREGABLE\|FORMATO\|FUNDAMENTADO)(_\|$)'` |
| C4 | Uso de cada nombre de `ErrorCodes` | `for c in DEBITS_CREDITS_MISMATCH PERIOD_CLOSED …; do grep -rn "'$c'\|ErrorCodes\.$c" src --include='*.ts' \| grep -v src/utils/errors.ts \| wc -l; done` |
| C5 | Códigos literales fuera de `AppError` en `src/api` | `grep -rnoE "code:\s*'[A-Z_]{3,}'" src/api` |
| C6 | Subclases de error en `src/` | `grep -rnE "class \w+ extends (AppError\|Error\|AccountingError\|ValidationError)" src \| grep -v src/utils/errors.ts` |
| C7 | Cadenas de usuario por idioma (constructores de error + claves `message/aviso/nota/note/hint/warning`) | `node /tmp/investigacion-idioma/inventario/api-extraer-cadenas.mjs > api-cadenas.tsv` y los `awk` de agregación que se listan en §3 |
| C8 | Mensajes Zod explícitos en `src/api` | `grep -rnoE "\{\s*message:\s*['\"][^'\"]+['\"]" src/api` (8) · `grep -rnoE "\.(min\|max\|regex\|refine\|int\|positive)\([^)]*,\s*'[^']+'\)" src/api` (4) · `grep -rn "setErrorMap\|errorMap:" src` (0) |
| C9 | Esquemas de cuerpo validados | `grep -rhoE "validate(Body\|Query)\(" src/api/rest/routes \| sort \| uniq -c` |
| C10 | Esquema GraphQL: descripciones y comentarios | `grep -cE '^\s*"""' src/api/graphql/schemas/schema.ts` · `grep -cE '^\s*#' …` · `grep -nE '^\s*#' … \| awk -F: '$1>=322 && $1<=340' \| wc -l` |
| C11 | Declaraciones `escribe:` y valores `riesgo:` | `grep -rhoE "escribe:\s*['\"\`]" src/api \| wc -l` · `grep -rhoE "riesgo:\s*'[a-z]+'" src/api \| sort \| uniq -c` · `grep -rhoE "escribe:\s*'[^']+'" src/api \| grep -c "[áéíóúñ]"` |
| C12 | Contrato publicado `docs/openapi.json` | `grep -oE '"(description\|summary)":\s*"[^"]+"' docs/openapi.json \| wc -l`; ídem con `grep -cE "[áéíóúñ«»¿¡]"`; `grep -c '"x-escribe"' docs/openapi.json`; `grep -oE '"x-escribe":\s*"[^"]+"' docs/openapi.json \| grep -cE "\b(del\|la\|el\|los\|las\|de\|en\|que\|sin\|con\|por\|una\|un)\b"` |
| C13 | Claves JSON en castellano en respuestas REST | `grep -rnoE "\b(simulado\|simulada\|aviso\|nota\|fecha_timbrado\|no_certificado_sat\|resumen\|detalle\|advertencias\|motivo\|razon\|folio\|mensaje\|siguiente_paso\|criterio\|metodo)\s*:" src/api/rest/routes` |
| C14 | Pruebas acopladas a texto literal de mensajes | `grep -rnE "toThrow\((['\"\`]\|/)\|\.message\)\.(toMatch\|toContain\|toBe)\(\|expect\([a-zA-Z_.]*message[a-zA-Z_.]*\)\.(toMatch\|toContain\|toBe)" tests \| wc -l` (y lo mismo sobre `tests/api`) |
| C15 | Pruebas que citan códigos de error | `grep -rhoE "code:\s*'[A-Z][A-Z0-9_]{4,}'\|'[A-Z][A-Z0-9_]{4,}'\)" tests \| grep -oE "[A-Z][A-Z0-9_]{4,}" \| sort \| uniq -c \| sort -rn` |
| C16 | Consumidores de códigos fuera de la API | `grep -rnE "\.code\s*===?\s*['\"][A-Z_]+['\"]\|code\s*===?\s*['\"][A-Z_]+['\"]" src/cli src/ai src/services \| grep -vE "ECONN\|ENOENT\|EACCES\|ETIMEDOUT\|ENOTFOUND"` |
| C17 | Acoplamientos de vigilantes | `grep -n "src/api" src/plan/criterios.ts` (24) · `grep -n "src/api" src/cli/kernel/audit.ts` (0) · `grep -o '"src/api[^"]*"' src/ai/docs/manifiesto.json` (4) · `grep -nE "^\s*'src/[^']+':" vitest.config.ts` |
| C18 | Infraestructura para negociar idioma | `grep -n "acceptsLanguages" node_modules/express/lib/request.js` · `sed -n '15,60p' src/database/migrations/001_core_schema.sql` · `grep -nE "app\.use\(\|ApolloServer\|formatError\|context:" src/index.ts` |

Heurística de idioma del extractor (C7): `es` si hay acento/ñ/«»/¿¡ o una palabra funcional castellana (`el, la, los, las, un, una, del, sin, ya, por, para, con, se, es, hay, este, esta, pero, porque, aquí, cuando, todavía, nada, ninguna, tu, qué, existe, viene, llegaron, caben, debe, puede`…); `en` si hay `the, is, are, must, not, for, with, of, and, required, cannot, does, has, have, be, to, this, that, from, found, invalid, missing, only, at, least, already, yourself, your, either, both, please, too, many, again, later, unexpected, occurred, denied, expired, token, header, per, between, expected`; `mixto` si ambas; `neutro` si ninguna (p. ej. `'YYYY-MM-DD'`, o los nombres de recurso de `NotFoundError` como `'Invoice'`, que son inglés pero de una sola palabra). Las cadenas de `NotFoundError` cuentan sólo el recurso, no el id.

---

## 3. Conteos

### 3.1 Tamaño de la superficie
- `src/api`: **37 archivos**, **9 929 líneas** (C1). REST: 13 routers en `src/api/rest/routes/`, 9 middleware, `openapi.ts` (414), `risk.ts` (434), `zod-a-json-schema.ts` (404), `topes.ts`, `montajes.ts`, `trust-proxy.ts`. GraphQL: `schemas/schema.ts` (493), `resolvers/index.ts`, `permisos.ts`, `errores.ts`.
- Módulos de error de servicios: **no existe `src/services/**/errors`**. Los errores se lanzan en línea desde 30 archivos de `src/services` (C2 sobre `src/services`) y el único módulo de tipos es `src/utils/errors.ts`.

### 3.2 Códigos de error (el discriminador estable)
| Origen | Distintos | Con vocablo castellano | Dónde |
|---|---|---|---|
| Fijos en subclases de `AppError` | 6 | 0 | `src/utils/errors.ts:16,23,30,37,44,64` (`VALIDATION_ERROR`, `RESOURCE_NOT_FOUND`, `RESOURCE_ALREADY_EXISTS`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_IMPLEMENTED`) |
| `AccountingError` (113 llamadas, C2) | **59** | **21** (C3) | 30 archivos de `src/services` |
| Subclases con código propio | 3 | 3 | `DIOT_NO_ENTREGABLE` `src/services/sat/diot/serializador.ts:45-50`; `DIOT_FORMATO_NO_FUNDAMENTADO` `:52-57`; `PROVEEDOR_NUEVO_SIN_AUTORIZAR` `src/services/xml-ingestion/pre-registration-service.ts:62-78` (`this.code = …` en :76) |
| Respuestas a mano (C5) | 4 | 0 | `INTERNAL_SERVER_ERROR` `error-handler.ts:35`; `RATE_LIMIT_EXCEEDED` `rate-limiter.ts:46`; `NOT_FOUND` `public-verification.ts:98`; `ATTESTATION_SIMULATED` `public-verification.ts:50` |
| **Total en circulación** | **72** | **24 (33 %)** | |
| `ErrorCodes` declarados sin uso (C4) | 9 | 1 (`PAC_TIMBRADO_ERROR`, mixto) | `src/utils/errors.ts:78-87`; sólo `PERIOD_CLOSED` se usa (4 sitios) |

Los 21 códigos castellanos de `AccountingError` (C3): `CFDI_REQUIERE_DECISION CIERRE_YA_EMITIDO FX_CONVERSION_NO_CASA FX_ORIGEN_INCOMPLETO FX_POLITICA_DESCONOCIDA FX_SIN_TIPO_DE_LA_FUENTE INPC_BASES_DISTINTAS INPC_BASE_AMBIGUA INPC_MEDIO_PERIODO_DE_UN_MES INPC_PERIODO_INVERTIDO INPC_SIN_INDICE PAC_PETICION_GRANDE PAC_RESPUESTA_ILEGIBLE PAC_SIMULADO PAC_YA_TIMBRADO REP_SIN_PAGOS REP_SIN_XML RESULTADO_SIN_BARRER SOD_QUIEN_CREA_NO_POSTEA SUBSIDIO_REGISTRO_DESCONOCIDO TENANT_NO_RESUELTO`.

Los 38 en inglés/neutro: `ALL_PACS_FAILED ALREADY_POSTED ALREADY_REVERSED ALREADY_VOID AP_ACCOUNT_MISSING CANNOT_CLOSE_PERIOD ENTITY_NOT_FOUND ENTRY_NOT_EDITABLE ENTRY_NOT_FOUND ENTRY_NOT_POSTED ENTRY_VOID FX_AR_NOT_WIRED FX_RATE_MISSING INVALID_CONFIG INVALID_STATUS IVA_ROLE_UNRESOLVED MISSING_ROLE_ACCOUNT NOT_CONFIGURED NO_PAC_AVAILABLE PAC_AUTH PAC_ERROR PAC_NOT_CONFIGURED PAC_NOT_FOUND PAYMENT_STATE_UNSUPPORTED PERIOD_ALREADY_OPEN PERIOD_CLOSED PERIOD_LOCKED PERIOD_NOT_CLOSED PERIOD_NOT_FOUND PERIOD_NOT_FUTURE PERIOD_NOT_OPEN PERIOD_NOT_SOFT_CLOSED PROVIDER_NOT_FOUND REASON_REQUIRED UNKNOWN_CHECK UNSUPPORTED_TYPE VALIDATION_FAILED WRITE_OFF_ACCOUNT_UNRESOLVED`.

Observación: la convención de forma (MAYÚSCULAS_CON_GUION) es única y estable; lo que no es estable es el idioma. Y hay solapes semánticos por idioma: `PAC_NOT_CONFIGURED` vs `NOT_CONFIGURED`, `NOT_FOUND` vs `RESOURCE_NOT_FOUND` vs `ENTITY_NOT_FOUND`, `VALIDATION_ERROR` vs `VALIDATION_FAILED`.

### 3.3 Cadenas de usuario por idioma (C7, `api-cadenas.tsv`, 890 filas)

```
awk -F'\t' '{split($1,a,":"); amb=(a[1] ~ /^src\/api\/graphql/)?"src/api/graphql":(a[1] ~ /^src\/api/)?"src/api/rest":(a[1] ~ /^src\/services/)?"src/services":"src/utils"; c[amb"\t"$3]++} END{for(k in c) print c[k]"\t"k}' api-cadenas.tsv | sort -k2,3
```

| Ámbito | en | es | mixto | neutro | total |
|---|---|---|---|---|---|
| `src/api/rest` | 62 | 12 | 2 | 38 | 114 |
| `src/api/graphql` | 0 | 3 | 0 | 0 | 3 |
| **`src/api` (la puerta)** | **62** | **15** | **2** | **38** | **117** |
| `src/services` (todo constructor de error) | 117 | **501** | 6 | 149 | 773 |
| `src/services`, sólo `AccountingError` | 37 | **61** | 1 | 9 | 108 |

De los 38 «neutro» de `src/api`, 33 son nombres de recurso de `NotFoundError` en inglés (`Invoice`, `Vendor`, `Pre-Registration`, `Processing Rule`, `Bitcoin anchor`, `W-2`…; lista completa con `grep -rhoE "new NotFoundError\('[^']+'" src/api | sort | uniq -c`). Contándolos como inglés: **la capa `src/api` está en inglés al 81 % (95 de 117) y la capa de servicios en castellano al 81 % (501 de 618 clasificables)**, y las dos llegan al cliente por el mismo sobre.

Por constructor en `src/api` (`awk -F'\t' '$1 ~ /^src\/api/ {sub(/\[.*/,"",$4); c[$4"\t"$3]++} END{for(k in c) print c[k]"\t"k}' api-cadenas.tsv | sort -k2,3`): `ValidationError` 37 en / 8 es / 2 neutro; `NotFoundError` 1 en / 33 neutro; `NotImplementedError` 6 en / 1 es; `ForbiddenError` 2 en / 3 es / 2 neutro; `UnauthorizedError` 4 en / 1 mixto; `ConflictError` 1 en; clave `message:` 11 en / 2 es / 1 neutro; `aviso:` 1 mixto; `note:` 1 es.

### 3.4 Zod (C8, C9)
- 46 `validateBody(` en `src/api/rest/routes`; 0 `validateQuery(` en rutas (las query se validan a mano, p. ej. `reports.ts:102-106`).
- 8 mensajes de `refine` explícitos, todos en inglés (`customers.ts:51,64`, `accounts.ts:56`, `xml-ingestion.ts:58,68,112`, `journal-entries.ts:51`, `vendors.ts:58`); 4 mensajes por argumento, inglés/neutro (`invoices.ts:97`, `journal-entries.ts:56,78`, `payroll.ts:58`).
- 1 mensaje de `superRefine` en castellano que reemplaza al de Zod para los cuatro topes de lote: `src/api/rest/topes.ts:155` (`llegaron N movimientos y caben M por petición. …`).
- El resto (los cientos de `Required`, `Invalid uuid`, `Expected …`) son texto de la librería, en inglés, sin mapa de errores.

### 3.5 GraphQL (C10)
- `schema.ts`: 40 declaraciones `type/input/enum`, **0 descripciones** (`"""`), 43 líneas de comentario `#`: 14 separadores, 8 rótulos en inglés (`ENUMS`, `TYPES`, `REPORTS`, `CONNECTION TYPES (Pagination)`, …), **19 líneas de un bloque explicativo en castellano** (`:322-340`). Los identificadores (tipos, campos, enums) están todos en inglés y camelCase.
- `resolvers/index.ts`: 3 `throw new` con prosa, las 3 en castellano (`:93`, `:155`, `:175`).
- `permisos.ts`: las claves `motivo:`/`razón:` (10 sitios) son diagnósticos de arranque (`CompuertaAbiertaError`, `:357`), no respuestas HTTP.

### 3.6 OpenAPI (C11, C12)
- `src/api/rest/openapi.ts`: plantillas de `summary`/`description` en inglés (`:275`, `:316-352`, `:375`; `Read route (no declared risk class…)`, `Mutating route declared …`, `The envelope every error goes out in (src/api/rest/middleware/error-handler.ts)`).
- `docs/openapi.json` (311 797 bytes, generado por `npm run openapi`): 195 `description`/`summary`, **0 con marca castellana**; **101 `x-escribe`**, de los que 62 llevan palabra funcional castellana y **0 acentos** — porque las 83 declaraciones `escribe:` de `src/api` están escritas en castellano sin acentos (`catalogo`, `logica`, `configuracion`; `grep … | grep -c "[áéíóúñ]"` = 0; ninguna prueba ni criterio lo exige — es convención tácita).
- Los valores de `riesgo:` que se publican como `x-riesgo` son un enum castellano: `escritura` 46, `irreversible` 23, `externo` 14, `lectura` 4 (87 declaraciones).
- Los mensajes de Zod NO entran en OpenAPI: `grep -n "message" src/api/rest/zod-a-json-schema.ts` = 0. Cambiarlos no desfasa `docs/openapi.json`; cambiar un `escribe:` o un `summary` sí.

### 3.7 Claves y valores en castellano dentro de respuestas (C13)
11 claves en cuerpos de respuesta REST: `simulado` (`integrations.ts:25,55,93`, `invoices.ts:291`, `public-verification.ts:137`), `aviso` (`invoices.ts:292`, `blockchain.ts:404,490`), `fecha_timbrado` (`invoices.ts:294`), `no_certificado_sat` (`:295`), `metodo` (`reports.ts:292`). Y un vocabulario de entrada bilingüe: `?method=direct|directo|indirect|indirecto` (`reports.ts:256-259`) sobre un tipo interno castellano `MetodoDeFlujo = 'indirecto' | 'directo'` (`src/services/reporting/cash-flow-service.ts:75`).

### 3.8 Pruebas acopladas (C14, C15)
- **772** aserciones sobre texto literal de mensajes en `tests/` (14 en `tests/api`).
- En `tests/api` + `tests/integration`, las que fijan castellano de la API: `tests/api/routes/topes-de-lote.spec.ts:184` (`llegaron ${n}`), `tests/api/middleware/tenant-context.spec.ts:58` (`/no identifica un inquilino/`), `tests/integration/anclaje-simulado-superficies.int.spec.ts:134,151` (`/SIMULADAS/`), `:164` (`/compromiso de ese periodo/i`). Inglés: `tests/api/graphql/permisos.spec.ts:425` (`'Insufficient permissions'`).
- Códigos citados por pruebas (top): `FX_ORIGEN_INCOMPLETO` 12, `SOD_QUIEN_CREA_NO_POSTEA` 10, `INPC_BASES_DISTINTAS` 5, `MISSING_ROLE_ACCOUNT` 4, `INPC_SIN_INDICE` 4, `ATTESTATION_SIMULATED` 4, `INTERNAL_SERVER_ERROR` 3, `INPC_PERIODO_INVERTIDO` 2, `INPC_BASE_AMBIGUA` 2, `FX_CONVERSION_NO_CASA` 2, y con 1: `WRITE_OFF_ACCOUNT_UNRESOLVED VALIDATION_ERROR PROVEEDOR_NUEVO_SIN_AUTORIZAR PERIOD_NOT_FUTURE PERIOD_ALREADY_OPEN PAC_YA_TIMBRADO NOT_IMPLEMENTED INPC_MEDIO_PERIODO_DE_UN_MES CFDI_REQUIERE_DECISION`.

---

## 4. Ejemplos con archivo:línea y clase

| archivo:línea | clase | idioma | texto / hecho |
|---|---|---|---|
| `src/utils/errors.ts:23` | texto_de_usuario_renderizado | en | `` `${resource}${id ? ` with id ${id}` : ''} not found` `` — plantilla inglesa de todos los 404 |
| `src/utils/errors.ts:86` | identificador | mixto | `PAC_TIMBRADO_ERROR` en `ErrorCodes`, sin uso |
| `src/api/rest/middleware/error-handler.ts:35-36` | texto_de_usuario_renderizado | en | `INTERNAL_SERVER_ERROR` / `An unexpected error occurred` |
| `src/api/rest/middleware/auth.ts:92` | texto_de_usuario_renderizado | es | `x-entity-id viene repetida: la petición actúa sobre una sola entidad` (a 9 líneas de `:101` `Access denied to this entity`, en inglés, en la misma función) |
| `src/api/rest/middleware/auth.ts:175-179` | texto_de_usuario_renderizado | en | `Insufficient permissions` con `details: { required, missing, current }` — claves de contrato |
| `src/api/rest/middleware/tenant-context.ts:40` | texto_de_usuario_renderizado | es | `El token no identifica un inquilino: la petición no puede acotarse y se rechaza.` (401) |
| `src/api/rest/middleware/idempotencia.ts:188-210,256` | texto_de_usuario_renderizado | es | 5 `ValidationError` sobre `Idempotency-Key`, todos en castellano |
| `src/api/rest/middleware/async-handler.ts:70,90` | texto_de_usuario_renderizado | en | `Invalid request body: ${details}` — prefijo inglés + mensajes Zod ingleses |
| `src/api/rest/topes.ts:155` | texto_de_usuario_renderizado | es | `llegaron ${n} ${plural} y caben ${tope} por petición. ${salida}` (reemplaza el `at most N element(s)` de Zod) |
| `src/api/rest/routes/public-verification.ts:50-54` | texto_de_usuario_renderizado | es | `ATTESTATION_SIMULATED` con prosa castellana, escrito a mano sin `AppError` |
| `src/api/rest/routes/public-verification.ts:98` | texto_de_usuario_renderizado | en | `NOT_FOUND` / `No attestation found for entry hash` — código distinto del `RESOURCE_NOT_FOUND` canónico |
| `src/api/rest/routes/invoices.ts:342-344` | texto_de_usuario_renderizado | es | `NotImplementedError('mnemosine todavía no cancela CFDI ante el SAT…')`; los otros 6 `NotImplementedError` de la API (`bills.ts:171`, `payroll.ts:419,428,436,444`, `bank-reconciliation.ts:376`) están en inglés |
| `src/api/rest/routes/invoices.ts:291-295` | dato_vocabulario | es | claves JSON `simulado`, `aviso`, `fecha_timbrado`, `no_certificado_sat` junto a `cfdi_uuid`, `provider_used` |
| `src/api/rest/routes/reports.ts:256-259` | dato_vocabulario | mixto | `?method=` acepta `direct/directo/indirect/indirecto`; rechazo en inglés `method must be 'indirect' or 'direct'` |
| `src/api/rest/routes/blockchain.ts:404` | texto_de_usuario_renderizado | es | `aviso: '${n} de ${m} atestaciones de esta página son SIMULADAS…'` (respuesta 200 con prosa) |
| `src/api/rest/routes/webhooks.ts:70` | texto_emitido_a_tercero | en | `dispatchEvent(…, 'test.ping', { message: 'Test webhook delivery' })` — sale a la URL del suscriptor |
| `src/api/rest/routes/accounts.ts:115` | texto_emitido_a_tercero | es | `escribe: 'accounts (alta del catalogo)'` → `x-escribe` en `docs/openapi.json` (sin acento) |
| `src/api/rest/openapi.ts:275` | texto_emitido_a_tercero | en | descripción del sobre de error que además cita una RUTA de archivo (`src/api/rest/middleware/error-handler.ts`) dentro del contrato publicado |
| `src/api/graphql/schemas/schema.ts:322-340` | comentario | es | 19 líneas explicando por qué `balanceSheet`/`incomeStatement` no se declaran |
| `src/api/graphql/schemas/schema.ts:12-88` | identificador | en | enums `AccountType`, `JournalEntryStatus`, `CfdiStatus`… |
| `src/api/graphql/resolvers/index.ts:175-179` | texto_de_usuario_renderizado | es | `La petición nombra 2 entidades distintas (la cabecera x-entity-id: …)` con `field: 'entityId'` |
| `src/api/graphql/errores.ts:5-22` | comentario | es | cabecera del formateador de errores |
| `src/services/accounting/posting.ts:136-140` | identificador + texto | es | `AccountingError('SOD_QUIEN_CREA_NO_POSTEA', '…la política de segregación de funciones exige…')` |
| `src/services/accounting/fiscal-calendar-service.ts:246` vs `:376` | texto_de_usuario_renderizado | es / en | **el mismo código `PERIOD_ALREADY_OPEN` con `${period.period_name} ya está abierto.` en una función y `${period.period_name} is already open.` en otra** — la deriva bilingüe dentro de un solo archivo |
| `src/services/accounting/ar-ap-posting.ts:87` | texto_de_usuario_renderizado | es | `MISSING_ROLE_ACCOUNT`: `No hay cuenta mapeada al rol "${role}" en esta entidad. Siembra…` |
| `src/services/accounting/period-close.ts:747-755` | texto_de_usuario_renderizado | en | `PERIOD_NOT_FOUND` `Fiscal period not found`, `PERIOD_NOT_OPEN` `Period is not in open status` |
| `src/services/xml-ingestion/pre-registration-service.ts:62-78` | texto_de_usuario_renderizado | es | `ProveedorNuevoSinAutorizar` — 7 líneas de prosa castellana con instrucción de CLI embebida, `field: 'vendor_id'`, `details.suggested_vendor` |
| `src/services/sat/diot/serializador.ts:45-57` | identificador | es | `DIOT_NO_ENTREGABLE` (422), `DIOT_FORMATO_NO_FUNDAMENTADO` (501) |
| `src/api/rest/trust-proxy.ts:65-70,81-85` | texto_de_usuario_renderizado | es | `aviso:` sobre `TRUST_PROXY` — va al log de arranque, no al cliente HTTP |
| `src/api/rest/routes/*.ts` (nombres) | nombre_de_archivo | en | 13 routers en inglés (`journal-entries.ts`, `fiscal-periods.ts`…) frente a `montajes.ts`, `topes.ts`, `errores.ts`, `permisos.ts`, `idempotencia.ts` en castellano |

---

## 5. Qué se rompe al cambiar

### 5.1 Renombrar un código (p. ej. `SOD_QUIEN_CREA_NO_POSTEA` → `SOD_CREATOR_CANNOT_POST`)
- **Criterios ejecutables**: `src/plan/criterios.ts:1470` (`/SOD_QUIEN_CREA_NO_POSTEA/.test(p)` sobre `posting.ts`) y `:1476` (`/'SOD_QUIEN_CREA_NO_POSTEA'/.test(codigoDe('src/cli/entry-command.ts'))`) → `npm run plan:status` cae. También `:3312` (`NO_MATCHING_APPROVAL_POLICY`) y `:3339` (`AI_BUDGET_EXCEEDED`) anclan códigos por literal.
- **CLI**: `src/cli/entry-command.ts:131-139` (`BLOCKED_CODES` con 10 literales, entre ellos `SOD_QUIEN_CREA_NO_POSTEA`, `ENTRY_NOT_FOUND` en `:146`), `src/cli/bill-command.ts:1215` (`ErrorCodes.PERIOD_CLOSED`), `:1222` (`MISSING_ROLE_ACCOUNT`), `:1500` (`PROVEEDOR_NUEVO_SIN_AUTORIZAR`, `CFDI_REQUIERE_DECISION`).
- **Agente e ingesta**: `src/ai/ingest-service.ts:206` y `src/services/xml-ingestion/rep-pendientes.ts:150` (`CFDI_REQUIERE_DECISION` decide `blocked` vs `error`); `src/services/integrations/mexico/pac/pac-router.ts:194` (`PAC_YA_TIMBRADO` gobierna el failover).
- **Pruebas**: 4 archivos para SOD (`tests/accounting/posting-sod.spec.ts`, `tests/accounting/exigir-segregacion.spec.ts`, `tests/integration/g3-ataque.int.spec.ts`, `tests/integration/g3-candado-de-una-sola-puerta.int.spec.ts`); 12 referencias a `FX_ORIGEN_INCOMPLETO`, etc. (§3.8).
- **Clientes de la API**: el `code` es el contrato público; un cliente que hace `switch (code)` se rompe sin aviso. Los códigos no se renombran: se congelan, y en todo caso se publica una tabla de alias con ventana de retiro.
- **Docs**: `docs/auditorias/2026-09-01-integral-iii/superficies-no-cli.md:45`, `docs/plan-cierre-brechas.md:407,418,441,786,805,5427-5444` citan códigos por nombre (documentos históricos; no se corrigen, se contextualizan).

### 5.2 Cambiar el texto de un mensaje (sin tocar el código)
- Pruebas con texto literal: 772 en `tests/` (C14), de las que en la puerta HTTP son pocas y localizables (§3.8: `topes-de-lote.spec.ts:184`, `tenant-context.spec.ts:58`, `anclaje-simulado-superficies.int.spec.ts:134,151,164`, `permisos.spec.ts:425`). Las 758 restantes viven en pruebas de servicios y CLI: cualquier catálogo que reescriba los mensajes de `src/services` tiene que ir prueba por prueba o cambiar las aserciones a `code`.
- `docs/openapi.json` NO cambia por mensajes de error ni de Zod (§3.6). SÍ cambia por `escribe:`, `summary`/`description` y `x-riesgo`: `tests/integration/g4b-ataque.int.spec.ts:86-96` exige igualdad byte a byte con lo generado y `.github/workflows/ci.yml:166` corre `npx tsx scripts/openapi.ts --check`. Regenerar con `npm run openapi`.

### 5.3 Editar dos rutas concretas
- `src/api/rest/routes/invoices.ts` y `src/api/rest/routes/bank-reconciliation.ts` son fuentes hasheadas de manuales del agente (`src/ai/docs/manifiesto.json`: `manuales/mexico-cfdi.md[3]`, `manuales/banking.md[1]`). Cualquier edición (incluido cambiar un mensaje) marca el manual como caducado: `ci.yml:158` (`corpus-manifiesto.ts --check`) falla hasta correr `npm run corpus:estado` y revisar el manual según `_como_actualizar`.

### 5.4 Renombrar o mover archivos de `src/api`
- `src/plan/criterios.ts` referencia 14 rutas de `src/api` en 24 sitios (`:1918, 2305, 2331, 2415, 2423-2424, 2502-2520, 2630, 2709, 2756, 3621, 3642, 4893, 4901, 5059, 5072, 5119, 5132, 5178, 5186`); `:2331` recorre el directorio `src/api/rest/routes` entero.
- `src/api/rest/openapi.ts:275` publica la ruta `src/api/rest/middleware/error-handler.ts` dentro del texto del contrato → renombrar el manejador desfasa `docs/openapi.json`.
- `src/cli/kernel/audit.ts` `LINEA_BASE`: 0 rutas de `src/api` (no acopla).
- `vitest.config.ts:82-112`: sin umbral por archivo para `src/api`; pero los archivos de servicio que más mensajes lanzan sí lo tienen (`posting.ts:82`, `validation.ts:85`, `ar-ap-posting.ts:88`, `report-service.ts:95`, `criterio-cierre.ts:112`). Extraer sus mensajes a un módulo de catálogo baja el número de líneas cubiertas y puede mover el porcentaje; el módulo nuevo necesita spec propio porque los llamadores mockean `posting` entero (memoria «Trinquete de cobertura en posting.ts»).

### 5.5 Cambiar el sobre `{ errors: [{ code, message, field, details }], meta }`
- `error-handler.ts:12-27` y `errores.ts:28-40` son los dos únicos serializadores, más las 3 salidas a mano (§1). Añadir claves a `meta` (p. ej. `language`) es aditivo y no rompe a nadie; cambiar `field`/`details` o quitar `message` sí. Las claves de `details` son contrato: `required/missing/current` (`auth.ts:175-179`, afirmadas en `tests/api/graphql/puerta-de-campos.spec.ts:118`), `suggested_vendor` (`pre-registration-service.ts:74`), `errors` (`ai.ts:97`).

---

## 6. Dependencias (quién referencia esta superficie por nombre o ruta)

- `src/plan/criterios.ts` — 24 referencias a rutas de `src/api` (C17) y códigos por literal en `:1470`, `:1476`, `:3312`, `:3339`.
- `src/cli/entry-command.ts:131-149`, `src/cli/bill-command.ts:1215,1222,1500` — mapa de códigos → código de salida del CLI.
- `src/ai/ingest-service.ts:206`, `src/services/xml-ingestion/rep-pendientes.ts:150`, `src/services/integrations/mexico/pac/pac-router.ts:194` — lógica de control sobre códigos.
- `src/ai/docs/manifiesto.json` — hashes de `invoices.ts` y `bank-reconciliation.ts`; `scripts/corpus-manifiesto.ts --check` en CI (`ci.yml:158`).
- `docs/openapi.json` + `scripts/openapi.ts` + `tests/integration/g4b-ataque.int.spec.ts:86-96` + `tests/api/routes/openapi-contrato.spec.ts` + `ci.yml:166`.
- `tests/api/**` (16 specs), `tests/integration/anclaje-simulado-superficies.int.spec.ts`, `tests/integration/g3-*.int.spec.ts`, `tests/accounting/posting-sod.spec.ts`, `tests/accounting/exigir-segregacion.spec.ts` — códigos y texto.
- `vitest.config.ts:82-112` — umbrales por archivo de los servicios emisores.
- `docs/plan-cierre-brechas.md`, `docs/auditorias/2026-09-01-integral-iii/*.md`, `docs/completion-plan.md:158` — citan códigos.
- `CONTRIBUTING.md:158` y `docs/PROCESS.md:58` — hoy ordenan comentarios, documentación y commits en castellano (dato; no objeción).

---

## 7. Cómo negociar idioma en HTTP sin romper clientes

Lo que hay a favor:
1. **Express 4 ya trae `req.acceptsLanguages()`** (`node_modules/express/lib/request.js:179`), que implementa la negociación RFC 9110 sobre `Accept-Language`. Es el mecanismo estándar y el que un cliente HTTP genérico ya sabe mandar.
2. **La casa ya usa AsyncLocalStorage para el contexto de petición** (`tenant-context.ts:48-52`, `withTenant`). El idioma cabe en el mismo contexto ambiente y así lo ve cualquier servicio sin cambiar firmas — importante porque los mensajes nacen en `src/services`, no en la API.
3. **`tenants.settings JSONB DEFAULT '{}'`** existe desde `001_core_schema.sql:23`: un idioma por omisión del inquilino no necesita migración. **`users` no tiene columna de preferencia** (`001:28-45`): una preferencia por persona requiere migración nueva, append-only, con el siguiente número libre (respetando los cuatro duplicados de `docs/migraciones.md`). `legal_entities.incorporation_country CHAR(2)` (`001:85`) permite un fallback por país (MX→es, US→en) si el dueño lo quiere, aunque su regla es «español primero y por omisión».
4. **El sobre ya tiene `meta`** (`error-handler.ts:22-26`; respuestas de datos con `meta: { request_id, timestamp, version }` en cada router): añadir `meta.language` es aditivo.

Diseño compatible (propuesta, no implementación):
- Precedencia: cabecera explícita (`Accept-Language`, y opcionalmente una cabecera propia `X-Language` para forzar, en la tradición de `x-entity-id`/`Idempotency-Key`) > preferencia de usuario (cuando exista) > `tenants.settings.language` > **`es`** por omisión. Sin cabecera, hoy y mañana, la respuesta sale en castellano: ningún cliente actual cambia de comportamiento por la sola introducción del mecanismo.
- Un middleware `negociarIdioma` justo después de `correlationIdMiddleware` (`src/index.ts:129`) y ANTES de `authenticate` (`:201`), para que también el 401/403/429 salgan localizados; guarda `req.idioma` y lo propaga por ALS. Para GraphQL, el mismo middleware va en la cadena de `/graphql` (`index.ts:273-309`) y el idioma se pasa por contexto (`:295-305`), igual que `entidadDeCabecera`.
- Respuesta: `Content-Language: es|en` y `Vary: Accept-Language` en cabeceras; `meta.language` en el cuerpo.
- **El `code` no se traduce ni se renombra**; `message` pasa a renderizarse desde el catálogo con `clave + params` (que `AppError` puede llevar como campos nuevos `clave`/`params` sin quitar `message`, para que los 758 tests de servicios sigan viendo prosa). `field` y `details` no cambian. Lo que no está en catálogo (errores nativos de Apollo, mensajes de Zod sin mapa) queda en inglés hasta que se les ponga `errorMap`/`formatError` de segunda capa — y se dice en el contrato.
- Los 24 códigos castellanos se congelan como están: son contrato. Los nuevos se acuñan en inglés. Si algún día se quiere un solo idioma en códigos, se publica alias (`SOD_CREATOR_CANNOT_POST` → mismo error, `details.legacy_code`) y una ventana de retiro; nunca un renombre seco.
- Lo publicado en `docs/openapi.json` (`x-escribe`, `x-riesgo`) es texto y vocabulario castellano hoy: `x-riesgo` es enum y se puede mantener (documentado) o duplicar como `x-risk` con valores ingleses; `x-escribe` es prosa y entraría al catálogo como cualquier otra cadena, regenerando el contrato.

---

## 8. Resumen

La superficie API son 37 archivos y 9 929 líneas en `src/api`, más los mensajes de 113 `AccountingError` en 30 archivos de `src/services` que viajan tal cual al cliente; el sobre es único (`{errors:[{code,message,field,details}],meta}` en REST, `extensions.{code,status,field,details}` en GraphQL) y el `code` es el discriminador estable. Hay 72 códigos en circulación y 24 (33 %) llevan vocablo castellano (`SOD_QUIEN_CREA_NO_POSTEA`, `CFDI_REQUIERE_DECISION`, 5 `INPC_*`, 3 `FX_*`, 4 `PAC_*`…), sin que ninguna convención lo decida: el mismo `PERIOD_ALREADY_OPEN` sale en castellano en `fiscal-calendar-service.ts:246` y en inglés en `:376`. Las dos capas están en idiomas opuestos: `src/api` emite 95 de 117 cadenas en inglés (81 %) y `src/services` 501 de 618 en castellano (81 %); Zod y Apollo añaden inglés de librería sin mapa, y el contrato publicado (`docs/openapi.json`) lleva 195 descripciones inglesas junto a 101 `x-escribe` en castellano sin acentos y un enum `x-riesgo` castellano. No existe negociación de idioma; se puede introducir sin romper a nadie con `Accept-Language` (Express ya trae `acceptsLanguages`), propagación por el AsyncLocalStorage que la casa ya usa para el inquilino, `tenants.settings` como preferencia sin migración, `meta.language` aditivo y **códigos congelados**: lo que rompe un renombre está localizado en `criterios.ts:1470,1476,3312,3339`, `entry-command.ts:131-149`, `bill-command.ts:1215-1500`, `ingest-service.ts:206`, `rep-pendientes.ts:150`, `pac-router.ts:194`, 772 aserciones de texto literal en `tests/` y las guardas de CI sobre `docs/openapi.json` (`ci.yml:166`) y `manifiesto.json` (`ci.yml:158`).
