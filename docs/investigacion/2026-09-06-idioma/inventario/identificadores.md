# Inventario de idioma — superficie: identificadores y nombres de archivo en `src/`

Repositorio: `/Users/victor/projects/Accounting`, rama `instrumentos-que-mienten-segun-la-maquina`, HEAD `b31e62a993809ece636b6c97baffe0e343c223c1` (`git rev-parse HEAD`). Fecha: 2026-09-06. Ningún archivo del repositorio fue modificado; todos los artefactos viven en `/tmp/investigacion-idioma/`.

Datos de apoyo (TSV y scripts) en `/tmp/investigacion-idioma/inventario/datos/`.

---

## 1. Método

### 1.1 Universo

- `find src -type f -name '*.ts' -not -path '*/node_modules*' | wc -l` → **376** archivos `.ts`.
- `find src -type f -not -name '*.ts' -not -path '*/node_modules*' | sed 's/.*\.//' | sort | uniq -c` → **75 `.sql`, 29 `.md`, 2 `.json`** (482 archivos en total).
- No hay `dist/` ni `.claude/` bajo `src/`; `node_modules` excluido por el `-not -path`.

### 1.2 Extracción de identificadores

Script `datos/extract.pl` (perl, porque el `sed -E` de macOS no entiende `\s`). Recorre línea a línea y captura declaraciones de **nivel superior**:

- **exportadas**: `^\s*export\s+(default\s+)?(async\s+)?(abstract\s+)?(declare\s+)?(function|const|let|var|class|interface|type|enum|namespace)\s+NOMBRE`
- **internas**: la misma forma sin `export`, anclada a columna 0 (`^`), para no recoger variables locales dentro de funciones.

Resultado (`wc -l datos/declaraciones_clasificadas.tsv`): **4 637 declaraciones** → 2 807 exportadas, 1 830 internas. Nombres únicos: 4 288 (`cut -f5 … | sort -u | wc -l`); únicos exportados: 2 762. Los repetidos más frecuentes son plantillas por comando: `CommonOpts` ×29, `EJEMPLOS` ×26, `UUID_RE` ×23, `router` ×16, `FECHA_RE` ×16.

No se cuentan: re-exports (`export { a } from`, `export * from`: 66 líneas, `grep -nE '^\s*export\s+(\{|\*)' -r src --include='*.ts' | wc -l`), `export default` anónimos (16), miembros de clase, variables locales, parámetros. Los re-exports importan para la API pública (§4) y se tratan ahí.

### 1.3 Tokenización y clasificación

Cada nombre se parte en tokens (`camelCase`, `PascalCase`, `snake_case`, `SCREAMING_CASE`, `kebab-case`, dígitos) y se pasa a minúsculas. 2 354 tokens distintos (`datos/tokens_freq.tsv`). Cada token se clasifica con precedencia estricta:

1. **es** — lista curada a mano de 1 128 raíces españolas (`datos/es_sorted.txt`). Se construyó revisando los 1 403 tokens que NO están en el diccionario inglés del sistema (`/usr/share/dict/words`, web2, 235 976 entradas) **más** los tokens españoles que sí están en web2 por ser préstamos o coincidencias (`de`, `la`, `con`, `sin`, `mes`, `estado`, `linea`, `asiento`, `lote`, `clave`, `ruta`, `banco`, `nomina`, `mayor`, `primer`, `cargo`, `cheque`, `folio`, `peso`, `regimen`, `norma`…).
2. **neutro** — 226 tokens (`datos/neutral_sorted.txt`): acrónimos de dominio (`cfdi rfc iva isr imss inpc isn diot sat clabe pue ppd nif fica futa suta macrs ytd ein nacha aba coa gl je`), abreviaturas técnicas (`id uuid xml csv db url ms ns json jwt sql http`), letras sueltas, números, marcas (`redis stripe anthropic sovos finkok…`), palabras idénticas en ambos idiomas (`error base plan fiscal local total general control real legal federal social principal manual final`), y las que coinciden al quitar acentos (`decision version conversion revision precision region union area formula`), más `max`/`min` (prefijos universales) y `resolver` (infinitivo español y sustantivo GraphQL).
3. **en** — está en web2, o su raíz lo está tras quitar `-s/-es/-ies/-ed/-ing`, o está en una lista de 90 abreviaturas técnicas ausentes de web2 (`deps opts config webhook payload ctx cron middleware failover…`, `datos/en_extra.txt` + lista embebida en `clasificar.pl`).
4. Ningún token quedó sin clasificar en la pasada final (`cut -f11 … | grep -v '^$' | wc -l` → 0).

Clase del identificador: ≥1 token es y 0 en → **es**; ≥1 en y 0 es → **en**; ambos → **mixto**; sólo neutros → **neutro**.

### 1.4 Tasa de error de la heurística (revisión manual de 200)

- Muestra 1, semilla 20260906, 100 declaraciones (`datos/muestra100.tsv`): revisadas una a una, **98/100** correctas. Fallos: `MAX_DESCARGAS_MEMORIA_POR_SESION` (heurística: mixto por `MAX`; humano: es) y `CriterioProvision` (heurística: mixto por «provision» en web2; humano: es). Se añadieron `max/min` a neutros y `provision` a españoles.
- Muestra 2, semilla 777, otras 100 (`datos/muestra100b.tsv`), tras esa corrección: **99/100**. Fallo: `MetodoPagoDecision` (mixto por «decision»; humano: es). Se añadieron las coincidencias sin acento (`decision, version…`) a neutros.
- Tasa observada: **3/200 = 1,5 %**, siempre en la misma dirección: la heurística infla «mixto» a costa de «es». Los conteos de «es» de abajo son, si acaso, un piso; los de «mixto», un techo. Ningún error fue es↔en.

---

## 2. Conteos

### 2.1 Identificadores, total y por ámbito

Comando: `cut -f6 datos/declaraciones_clasificadas.tsv | sort | uniq -c` y `awk -F'\t' '{print $3"\t"$6}' … | sort | uniq -c`.

| ámbito | total | es | en | mixto | neutro |
|---|---:|---:|---:|---:|---:|
| exportados | 2 807 | 1 161 (41 %) | 1 497 (53 %) | 141 (5 %) | 8 |
| internos | 1 830 | 905 (49 %) | 785 (43 %) | 77 (4 %) | 63 |
| **todos** | **4 637** | **2 066 (45 %)** | **2 282 (49 %)** | **218 (5 %)** | **71 (2 %)** |

Por tipo de declaración exportada (`awk -F'\t' '$3=="export"{print $4"\t"$6}' … | sort | uniq -c`): function 695 en / 473 es / 68 mixto; interface 446 en / 431 es / 29 mixto; const 176 en / 139 es / 29 mixto; type 87 en / 109 es / 11 mixto; class 69 en / 9 es / 4 mixto; enum 24 en / 0 es. Los `enum` y las `class` son casi todos ingleses (herencia del arranque); las `interface` y los `type` están al 50 %.

### 2.2 Por carpeta (nivel 1, todos los ámbitos)

Comando: `awk` sobre `datos/declaraciones_clasificadas.tsv` agrupando por el segundo segmento de la ruta (ver `carpeta_clase.tsv` en el trabajo).

| carpeta | total | es | en | mixto | neutro | % es |
|---|---:|---:|---:|---:|---:|---:|
| services | 2 503 | 1 485 | 826 | 147 | 45 | 59 % |
| cli | 822 | 271 | 508 | 35 | 8 | 33 % |
| ai | 731 | 99 | 602 | 22 | 8 | 14 % |
| api | 256 | 106 | 136 | 12 | 2 | 41 % |
| database | 85 | 16 | 66 | 1 | 2 | 19 % |
| plan | 79 | 72 | 3 | 1 | 3 | 91 % |
| auth | 64 | 17 | 46 | 0 | 1 | 27 % |
| types | 61 | 0 | 60 | 0 | 1 | 0 % |
| utils | 29 | 0 | 28 | 0 | 1 | 0 % |
| config | 6 | 0 | 6 | 0 | 0 | 0 % |
| index.ts | 1 | 0 | 1 | 0 | 0 | — |

### 2.3 Por subcarpeta (nivel 2, todos los ámbitos; entre paréntesis sólo exportados)

| subcarpeta | total | es | en | mixto | % es | exportados es/en/mixto |
|---|---:|---:|---:|---:|---:|---|
| services/banking | 569 | 502 | 40 | 18 | 88 % | 270 / 14 / 8 |
| services/sat | 346 | 300 | 9 | 26 | 87 % | 198 / 4 / 23 |
| services/accounting | 344 | 125 | 180 | 34 | 36 % | 91 / 136 / 24 |
| services/payroll | 208 | 70 | 121 | 12 | 34 % | 45 / 93 / 10 |
| services/reporting | 150 | 75 | 71 | 4 | 50 % | 47 / 56 / 4 |
| services/xml-ingestion | 121 | 39 | 59 | 22 | 32 % | 20 / 49 / 12 |
| services/ar | 99 | 14 | 81 | 1 | 14 % | 5 / 71 / 1 |
| services/assets | 87 | 71 | 11 | 3 | 82 % | 51 / 10 / 2 |
| services/ap | 82 | 22 | 53 | 3 | 27 % | 5 / 46 / 1 |
| services/integrations | 77 | 13 | 58 | 6 | 17 % | 7 / 42 / 1 |
| services/backup | 64 | 58 | 1 | 4 | 91 % | 27 / 0 / 2 |
| services/fiscal | 59 | 56 | 1 | 1 | 95 % | 40 / 0 / 1 |
| services/accruals | 46 | 42 | 4 | 0 | 91 % | 36 / 4 / 0 |
| services/payments | 42 | 28 | 8 | 5 | 67 % | 12 / 8 / 0 |
| services/webhooks | 36 | 22 | 10 | 4 | 61 % | 13 / 8 / 3 |
| services/blockchain | 31 | 1 | 30 | 0 | 3 % | 0 / 23 / 0 |
| services/fx | 29 | 26 | 0 | 2 | 90 % | 20 / 0 / 2 |
| services/fiscal-credentials | 27 | 1 | 26 | 0 | 4 % | 1 / 20 / 0 |
| services/policy | 22 | 0 | 22 | 0 | 0 % | 0 / 19 / 0 |
| services/vault | 18 | 1 | 17 | 0 | 6 % | 0 / 12 / 0 |
| services/cache | 16 | 2 | 13 | 0 | 12 % | 1 / 12 / 0 |
| services/entity | 11 | 0 | 11 | 0 | 0 % | 0 / 10 / 0 |
| services/jurisdiccion | 11 | 11 | 0 | 0 | 100 % | 7 / 0 / 0 |
| services/audit | 4 | 3 | 0 | 1 | 75 % | 3 / 0 / 1 |
| services/idempotency | 4 | 3 | 0 | 1 | 75 % | 3 / 0 / 1 |
| cli (raíz) | 683 | 254 | 391 | 31 | 37 % | 79 / 181 / 15 |
| cli/kernel | 102 | 17 | 83 | 1 | 17 % | 12 / 61 / 1 |
| cli/init | 37 | 0 | 34 | 3 | 0 % | 0 / 22 / 3 |
| ai (raíz) | 370 | 43 | 306 | 16 | 12 % | 23 / 225 / 13 |
| ai/providers | 108 | 14 | 91 | 1 | 13 % | 14 / 56 / 1 |
| ai/tools | 76 | 25 | 50 | 1 | 33 % | 6 / 29 / 1 |
| ai/skills | 76 | 0 | 75 | 0 | 0 % | 0 / 40 / 0 |
| ai/webhooks | 42 | 0 | 42 | 0 | 0 % | 0 / 31 / 0 |
| ai/jobs | 38 | 0 | 38 | 0 | 0 % | 0 / 26 / 0 |
| ai/eval | 21 | 17 | 0 | 4 | 81 % | 12 / 0 / 4 |
| api/rest | 226 | 82 | 132 | 10 | 36 % | 32 / 27 / 5 |
| api/graphql | 30 | 24 | 4 | 2 | 80 % | 13 / 2 / 1 |

Lectura: la frontera no es por capa sino por **fecha**. Lo que existía en el arranque (types, utils, config, ar/ap, policy, vault, blockchain, ai/skills, ai/jobs, cli/init, esquema GraphQL) está en inglés; lo construido después bajo CONTRIBUTING.md:158 (banking, sat, fiscal, fx, accruals, assets, backup, jurisdiccion, plan, ai/eval, permisos GraphQL) está en español. `services/accounting` y `services/payroll` son la costura: un tercio español dentro de archivos ingleses.

### 2.4 Nombres de archivo

Comando: mismo clasificador sobre el *basename* sin extensión (`datos/archivos_clasificados.tsv`); `awk -F'\t' '{n=split($1,p,"."); print p[n]"\t"$3}' … | sort | uniq -c`.

| extensión | total | es | en | mixto | neutro |
|---|---:|---:|---:|---:|---:|
| .ts | 376 | 41 (11 %) | 298 (79 %) | 10 | 27 (`index.ts`, `csv.ts`, `rfc.ts`, `mt940.ts`…) |
| .sql | 75 | 26 auto + 9 revisados a mano = **35** | 40 | 0 | 0 |
| .md | 29 | 14 | 13 | 0 | 2 |
| .json | 2 | 1 (`manifiesto.json`) | 1 (`ifrs-registry.json`) | 0 | 0 |

Los 9 `.sql` que la heurística marcó «mixto» son títulos en castellano con palabras que coinciden con web2 (`036_pagos_rep`, `041_el_mayor_inviolable`, `042_el_refresco_sale_del_posteo`, `060_la_corrida_que_se_abre_antes`, `061_quien_firma_y_quien_solo_mira`, `063_el_agrupador_con_una_sola_verdad`, `067_lo_que_el_patron_paga_y_nadie_apunta`, `068_el_estado_no_cabe_en_dos_letras`, `069_el_predicado_que_se_paga_por_fila`); revisados uno a uno: todos españoles. Corte temporal nítido: migraciones **001–035 en inglés** (`001_core_schema.sql` … `035_fiscal_credential_log_append_only.sql`, salvo `034_atestaciones_simuladas.sql`), **036–069 en español** (título-frase). Números duplicados: `ls src/database/migrations | sed -E 's/^([0-9]+)_.*/\1/' | sort | uniq -d` → **012, 014, 015, 018**.

Los 41 `.ts` con nombre español (lista completa en `datos/archivos_clasificados.tsv`, `awk '$3=="es"'`):
`src/ai/eval/puntuacion.ts`, `src/ai/tools/superficie.ts`, `src/api/graphql/permisos.ts`, `src/api/rest/middleware/idempotencia.ts`, `src/api/rest/montajes.ts`, `src/auth/sujeto-activo.ts`, `src/cli/kernel/confirmacion.ts`, `src/database/consulta-publica.ts`, `src/plan/conducta.ts`, `src/plan/criterios.ts`, `src/services/accounting/moneda-origen.ts`, `src/services/jurisdiction/jurisdiction.ts`, `src/services/accounting/sat-agrupadores.ts`, `src/services/accounting/sat-agrupadores-catalogo.ts`, `src/services/backup/exportacion-inquilino.ts`, `src/services/banking/parsers/{avisos,fecha,importe,perfiles-csv,texto,tipos}.ts`, `src/services/fiscal/inpc/{parseo,periodo}.ts`, `src/services/integrations/mexico/pac/simulacion.ts`, `src/services/jurisdiction/jurisdiction.ts`, `src/services/payroll/mx/subsidio-entregado.ts`, `src/services/reporting/criterio-cierre.ts`, `src/services/sat/anexo24/{balanza-xml,catalogo-cuentas,polizas-auxiliar-xml,polizas-xml}.ts`, `src/services/sat/diot/{desglose,hallazgos,hechos,serializador,tercero}.ts`, `src/services/webhooks/{barrido-entregas,politica-reintento}.ts`.
Mixtos (10): `cli/kernel/riesgos-retrofit.ts`, `services/backup/ledger-en-base.ts`, `services/payroll/mx/{cfdi-nomina-generator,finiquito-calculator,finiquito-math}.ts`, `services/sat/anexo24/{balanza-invariantes,balanza-service,polizas-invariantes,polizas-service}.ts`, `services/xml-ingestion/rep-pendientes.ts`.

Además hay una **carpeta** con nombre español: `src/services/jurisdiccion/` (y `src/services/sat/anexo24`, `diot`, `inpc` son acrónimos de dominio).

### 2.5 Otros identificadores persistidos o expuestos que rozan esta superficie

- **Tablas** (`grep -rhoiE 'create table (if not exists )?[a-z_]+' src/database/migrations/*.sql | … | sort -u | wc -l`): 112; **107 en inglés, 4 en español** (`inpc_serie`, `sat_anexo`, `sat_bancos`, `sat_codigos_agrupadores`), 1 neutro (`mx_isn_tasas_estatales`). El esquema es inglés aunque las migraciones que lo crean tengan título español.
- **Panel de políticas** (`src/services/policy/pending-catalog.ts`): 53 claves (`grep -cE "^\s+key:\s*'"`), todas en español `snake_case` (`catalogo_entidad_no_mexicana`, `convencion_primer_mes`, `umbral_capitalizacion_mxn`…) y sus valores también (`base_neutro`, `vida_util_nif`, `proporcional_dias`, `avisar`, `bloquear`). Son **valores persistidos** en `policy_decisions` — fuera de esta superficie pero acoplados a ella por nombre.
- **CLI**: 143 nombres de comando (`grep -oE "\.command\('[a-z][a-z-]*'" -r src/cli | sort -u | wc -l`), todos ingleses o acrónimos (`diot`, `sat`, `rep`, `isn`, `cfdi`); el vocabulario cerrado `VERBS` de `src/cli/kernel/vocabulary.ts:22` es inglés (`accrue add allocate answer apply approve … post prepare preview`).
- **REST**: 116 registros `router.<verbo>('…')` en 17 archivos de `src/api/rest/routes/`; los segmentos de ruta son ingleses salvo términos de dominio (`finiquito`, `cfdi-nomina`, `imss-idse`, `sua`, `efw2`, `nacha`).
- **GraphQL**: 36 tipos y 23 campos de `Query`/`Mutation` en `src/api/graphql/schemas/schema.ts`, todos ingleses. Los identificadores españoles de `api/graphql` están en `permisos.ts` (autorización), no en el esquema.

---

## 3. Ejemplos con archivo:línea

| archivo:línea | identificador | ámbito/tipo | clase | idioma |
|---|---|---|---|---|
| `src/services/jurisdiction/jurisdiction.ts:201` | `esContabilidadMexicana` | export function | identificador | es |
| `src/services/accounting/chart-seed.ts:141` | `catalogoBasePara` | export function | identificador | es |
| `src/services/accounting/moneda-origen.ts:237` | `resolverTipoCambio` | export function | identificador | es |
| `src/services/banking/reconciliation-service.ts:2530` | `AsientoDeAjuste` | export interface | identificador | es |
| `src/plan/criterios.ts:604` | `CRITERIOS` | export const | identificador | es |
| `src/services/accounting/posting.ts:187` | `createJournalEntry` | export function | identificador | en |
| `src/services/audit/audit-log.ts:66` | `registrarAuditoria` | export function, **20 archivos consumidores** | identificador (API pública) | es |
| `src/cli/kernel/confirmacion.ts:79` | `confirmarConReintento` | export function, 16 consumidores | identificador (API pública) | es |
| `src/api/rest/risk.ts:108` | `declararRiesgoRuta` | export function, 16 consumidores | identificador (API pública) | es |
| `src/services/idempotency/idempotency-store.ts:63` | `conLlave` | export function, 11 consumidores | identificador (API pública) | es |
| `src/services/reporting/cash-flow-service.ts:370` | `RenglonDeFlujo` | export type | identificador | es |
| `src/database/rls-guard.ts:24` | `RolIgnoraRlsError` | export class | identificador | es |
| `src/ai/agent-events.ts:45` | `registrarEventoEnSegundoPlano` | export function en carpeta inglesa | identificador | es |
| `src/services/banking/bank-account-service.ts:872` | `createBankAccount` | export function en carpeta española | identificador | en |
| `src/cli/mnemosine.ts:3120` | `normalizarToken` | export function | identificador | mixto |
| `src/services/accounting/iva-cash-basis.ts:117` | `MetodoPagoSignals` | export interface | identificador | mixto |
| `src/cli/init/s1-identity.ts:24` | `IdentidadDeps` | export interface | identificador | mixto |
| `src/services/banking/bank-account-service.ts:110` | `routingAbaValido` | export function | identificador | mixto |
| `src/services/banking/bank-statement-service.ts:672` | `esViolacionUnica` | function interna | identificador | es |
| `src/services/payments/payment-service.ts:799` | `monedaDe` | function interna | identificador | es |
| `src/ai/question-service.ts:39` | `createQuestion` | export function | identificador | en |
| `src/services/sat/anexo24/validador.ts:70` | `NS_XSI` | export const | identificador | neutro |
| `src/services/jurisdiction/jurisdiction.ts` | — | archivo | nombre_de_archivo | es |
| `src/services/backup/exportacion-inquilino.ts` | — | archivo | nombre_de_archivo | es |
| `src/services/sat/anexo24/balanza-service.ts` | — | archivo | nombre_de_archivo | mixto |
| `src/database/migrations/051_la_cuenta_y_el_extracto.sql` | — | archivo (citado 7 veces por criterios) | nombre_de_archivo | es |
| `src/database/migrations/033_audit_log_append_only.sql` | — | archivo | nombre_de_archivo | en |
| `src/services/policy/pending-catalog.ts` | `key: 'convencion_primer_mes'`, `value: 'proporcional_dias'` | valor persistido en `policy_decisions` | texto_persistido | es |

---

## 4. Qué es API pública

Definición operativa: símbolo **exportado e importado por nombre desde otra carpeta** (carpeta = `src/<x>` o `src/services/<sub>`). Script `datos/imports.pl` sobre los 376 `.ts`: 3 338 sentencias `import … from './…'` resueltas a archivo (`.js`→`.ts`, `index.ts`); un único origen inexistente (`src/plan/risk.ts`) es un falso positivo: el regex leyó un `import` dentro del literal de un mutante en `criterios.ts:5060`.

- Pares (origen, símbolo) importados desde otra carpeta: **802** (`awk '$4!=$5' … | sort -u | wc -l`). Casan con una declaración del inventario 766; los 36 restantes se importan desde un `index.ts` re-exportador (`services/sat/diot/index.ts` 11, `services/accounting/index.ts` 11, `ai/providers/index.ts` 5, `sat/anexo24/index.ts` 4…).
- De los 766: **538 en (70 %), 200 es (26 %), 28 mixto (4 %)** (`cut -f2 datos/api_publica_clasificada.tsv | sort | uniq -c`).
- Por carpeta de origen (es/mixto que cruzan frontera): banking 77+2, accounting 19+6, assets 15, accruals 14, fx 12+1, reporting 12, ai 8+7, payroll 6+3, backup 6, sat 6+3, payments 4, auth 4, database 3, api 3, webhooks 3, jurisdiccion 2, idempotency 2+1, audit 1+1, xml-ingestion 1+4.
- Radio de impacto dentro de `src/` (`datos/consumo_es.tsv`): **737 sitios de import** (archivo consumidor × símbolo) apuntan a **494** símbolos es/mixto distintos. Los 7 más consumidos: `registrarAuditoria` (audit-log.ts:66, 20 archivos), `noEntendi` (confirmacion.ts:63, 16), `confirmarConReintento` (confirmacion.ts:79, 16), `declararRiesgoRuta` (api/rest/risk.ts:108, 16), `tenantDe` (audit-log.ts:50, 12), `hashDeCarga` (idempotency-store.ts:43, 11), `conLlave` (idempotency-store.ts:63, 11).
- Desde `tests/`: 1 399 símbolos importados desde `src/` (`grep -rhoE "import…from…src/" tests | …`); **189 sitios** importan un símbolo es/mixto exportado, **144 símbolos distintos**. Y `tests/` importa desde **306** módulos de `src/`, de los cuales **35 con nombre español y 8 mixto** (`datos`, comando en `tests_rutas.txt`).
- Exportados es/mixto **sin ningún import nominal** ni en `src/` ni en `tests/`: 720 (cota superior: incluye tipos usados sólo en su archivo y símbolos que viajan por `index.ts`). Son los más baratos de renombrar.
- Expuestos hacia fuera por **REST/GraphQL/CLI por su nombre**: ninguno de los identificadores españoles llega al contrato externo como nombre de ruta, tipo GraphQL o comando (§2.5). Sí llegan como **claves y valores del panel de políticas** (`pending-catalog.ts`) y como **texto de ayuda/salida** del CLI, que son superficie de otro inventario.

---

## 5. Qué se rompe al renombrar o extraer

### 5.1 `src/plan/criterios.ts` (6 648 líneas, 133 criterios)

Conteo de criterios: `perl datos/criterios_bloques.pl` parte el array `CRITERIOS` (`criterios.ts:604`) por cada `paquete:` → **133 bloques**. Por paquete: E1.2 27, E5.1 21, E0.1 16, E0.3 14, E2.1 12, E0.0 11, E1.3 7, E0.2 7, E4.1 5, E3.1 3, E1.1 3, E4.2 2, E2.2 2, E1.4 2, E3.2 1.

Cómo leen: `codigoDe(` 187 llamadas, `crudoDe(` 41, `existe(` 34, `rutaDe(` 20, `dondeAparece(` 14, `consumidoresDe(` 9, `fuentes(` 7, `sinComentarios(` 7, `apariciones(` 1 (`grep -cE "\bNOMBRE\(" src/plan/criterios.ts`). `consumidoresDe` (`criterios.ts:325-328`) hace literalmente `new RegExp('\\b'+simbolo+'\\b')` sobre todo `src/`: es grep de identificador por nombre.

- **117** de 133 criterios leen ≥1 ruta literal (`src/`, `tests/`, `docs/`, `scripts/`, `.github/`); 181 rutas distintas (`datos/criterios_bloques.tsv`, col. 4). Las más citadas: `src/cli/mnemosine.ts` 18, `ar-ap-posting.ts` 12, `payment-service.ts` 10, `period-close.ts` 10, `ingest-service.ts` 9, `posting.ts` 8, `051_la_cuenta_y_el_extracto.sql` 7.
- **56** usan ≥1 regex literal; **75** declaran `mutantes` (120 mutantes con `archivo:`; `grep -cE "^\s+archivo:\s*'"`).
- Criterios que leen una **ruta con nombre español o mixto**: **40** (35 de ellas bajo `src/`; el resto `scripts/provision-roles.sql`, `scripts/corpus-manifiesto.ts`, `scripts/costo-por-fila.ts`, `docs/auditorias/…`). Rutas españolas de `src/` citadas: 18 migraciones (040, 041, 043, 044, 046, 047, 048, 049, 051, 052, 054, 055, 058, 060, 069…), `api/graphql/permisos.ts` ×3, `database/consulta-publica.ts` ×2, `reporting/criterio-cierre.ts` ×2, `webhooks/barrido-entregas.ts` ×2, `sat/anexo24/{polizas,balanza}-service.ts`, `balanza-invariantes.ts`, `payroll/mx/finiquito-math.ts`, `cfdi-nomina-generator.ts`, `xml-ingestion/rep-pendientes.ts`, `ai/tools/superficie.ts`, `ai/eval/puntuacion.ts`, `cli/kernel/riesgos-retrofit.ts`, `sat/anexo24/artefactos.ts`, `ai/docs/manifiesto.json` (`datos/criterios_idioma.tsv`).
- Criterios cuyo regex/literal contiene un **identificador español declarado en el inventario** (cruce exacto, `datos/criterios_cruce.tsv`): **15**. Ejemplos: `criterios.ts:1280` (`bloquearPeriodoParaPostear`), `:1729` y `:1933` (`registrarAuditoria`), `:2691` (`assertPuedeTimbrar`), `:2957` (`conLlave`), `:3057` (`ligarPagoREP`), `:3218` (`registrarEventoEnSegundoPlano`), `:4037` (`fechaDelAsiento`), `:4139` (`cotejarMovimientoConSuLinea`), `:4276` (`asignarPartida`, `reclasificarPartida`), `:4575` (`exigirEstado`), `:6228` (`EJEMPLOS`).
- **Unión: 51 de 133 criterios (38 %) se ponen en rojo con un renombrado masivo** de rutas o identificadores españoles (`cat crit_rutas.txt crit_ids.txt | sort -u | wc -l`). El resto lee rutas inglesas pero **contenido** español (cadenas, comentarios, columnas SQL): un criterio de lectura que busca `politica.value === 'exigir'` (`criterios.ts:1423`) no cae por un identificador, cae por un valor.
- **Mutantes**: de 120, **25 apuntan a un archivo de nombre español/mixto** y **19 literales `de:` contienen un identificador español declarado** (`SUPERFICIE_INGESTA` ×2, `runLedgerChecksEn`, `recalculoDelSat`, `indiceDeCalendario`, `envolverDatosDeTerceros`, `cotejarMovimientoConSuLinea`, `checkSelloDeGarantias`, `censarRutas`, `bloquearPeriodoParaPostear`, `auditarRiesgoDeRutas`…). Un mutante cuyo ancla `de:` deja de existir es «un espejo roto» por definición del propio archivo (`criterios.ts:47`), y `tests/plan/mutacion.spec.ts` lo exige; el trinquete `--piso` (48 criterios, 80 mutantes) no baja, pero cada ancla rota es un rojo.
- Ironía documentada: la cabecera `criterios.ts:17-21` ya prohíbe que un criterio afirme identificadores «porque su autor eligió nombres en español» y aun así 15 los nombran y 51 dependen de nombres.

### 5.2 `vitest.config.ts` y `vitest.integration.config.ts` (umbrales por archivo)

`grep -nE "^\s+'src/[^']+'\s*:\s*\{" vitest*.ts`: **6** umbrales por archivo en unitario (`posting.ts:92`, `validation.ts:95`, `ar-ap-posting.ts:98`, `utils/sequence.ts:101`, `report-service.ts:105`, **`criterio-cierre.ts:112`**) y **9** en integración (`period-close.ts:60`, `ledger-checks.ts:64`, `posting.ts:71`, `ar-ap-posting.ts:75`, `validation.ts:79`, `iva-cash-basis.ts:85`, `report-service.ts:93`, **`criterio-cierre.ts:97`**, `cash-flow-service.ts:101`). Además `include` con `'src/services/jurisdiccion/**'` (`vitest.config.ts:37`). Renombrar `criterio-cierre.ts` o la carpeta `jurisdiccion` **descoloca el umbral en silencio** (la clave deja de casar y el archivo pasa a medirse sólo por el global). Encima, tres mutantes de criterios anclan literales de `vitest.config.ts` (`criterios.ts:1018,1026,1034`: `'src/services/reporting/criterio-cierre.ts': {`).

### 5.3 `src/ai/docs/manifiesto.json`

46 hashes por ruta (`python3 -c "…len(m['hashes'])"`), 13 manuales con listas de rutas fuente, 1 sin revisar. De las 49 rutas distintas, **0 españolas, 1 mixta** (`src/services/payroll/mx/cfdi-nomina-generator.ts`), 2 neutras (`index.ts`). Lo que lee y reescribe: `scripts/corpus-manifiesto.ts:24`; lo vigila `criterios.ts:3718`. Un renombrado masivo lo afecta poco por idioma, pero **cualquier** movimiento de archivo invalida el hash y obliga a `--actualizar`.

### 5.4 `src/cli/kernel/audit.ts` → `LINEA_BASE`

`audit.ts:197-236`: **36 entradas** (`sed -n '197,240p' | grep -cE "^\s+'"`). No son rutas de archivo: son `comando|regla|detalle` (`'sat cred audit|R3 closed verb list|…'`, `'pending define|R6 short flag|…'`). Está acoplada al **nombre de los comandos y verbos del CLI** (ya ingleses) y a los textos de regla; un renombrado de identificadores TypeScript no la toca; un cambio de vocabulario del CLI sí.

### 5.5 Otros acoplamientos por nombre

- `package.json:10-24`: `dev`, `mnemosine`, `build`, `migrate`, `seed`, `plan:status` citan rutas de `src/` (todas inglesas hoy; `src/plan/status.ts`).
- `.github/workflows/ci.yml:410` (`src/cli/kernel/exit.ts`), `witness-triage.yml:111-131` (`src/cli`, `src/ai/docs/`).
- `docs/`, `AGENTS.md`, `CONTRIBUTING.md`, `README.md`: **422** rutas distintas de `src/` citadas (`grep -rhoE 'src/[A-Za-z0-9_./-]+\.(ts|sql)' … | sort -u | wc -l`), **25 españolas + 8 mixtas**. Identificadores españoles exportados nombrados en docs (nº de archivos `.md`): `Veredicto` 39, `Resultado` 33, `Criterio` 33, `Hallazgo` 26, `Vocabulario` 20, `esContabilidadMexicana` 16, `MetodoPago` 16, `apariciones` 15, `Comprobante` 15, `Umbrales` 10.
- `scripts/` (17 archivos): 12 rutas de `src/` citadas; españolas: `src/ai/eval/puntuacion.ts`, `src/database/consulta-publica.ts`, `src/plan/criterios.ts`.
- `tests/`: 189 import-sites de símbolos españoles y 43 módulos con nombre español/mixto importados (§4).
- Migraciones: append-only con duplicados 012/014/015/018; los nombres de archivo españoles 036–069 **no se pueden renombrar** (el migrador cuenta por nombre; `docs/migraciones.md`). 18 de esos nombres están citados por criterios.

---

## 6. Dependencias (quién referencia por nombre o ruta)

1. `src/plan/criterios.ts` — 51/133 criterios por ruta o identificador español; 9 `consumidoresDe` por nombre; 120 mutantes con `archivo:`/`de:`.
2. `tests/plan/mutacion.spec.ts` y `tests/integration/plan-conducta-mutacion.int.spec.ts` — aplican los mutantes; un ancla ausente es fallo.
3. `vitest.config.ts:92-112`, `vitest.integration.config.ts:60-101` — umbrales por ruta; `include` por carpeta (`jurisdiccion/**`).
4. `src/ai/docs/manifiesto.json` + `scripts/corpus-manifiesto.ts:24` — hashes por ruta (46).
5. `src/cli/kernel/audit.ts:197` `LINEA_BASE` — nombres de comando CLI y reglas (no rutas).
6. `src/services/policy/pending-catalog.ts` — 53 claves y sus valores persistidos en `policy_decisions` (español `snake_case`).
7. `package.json` scripts (`plan:status`, `migrate`, `seed`, `mnemosine`, `dev`, `build`), `.github/workflows/{ci,witness-triage}.yml`.
8. `docs/**`, `AGENTS.md`, `CONTRIBUTING.md:158`, `docs/PROCESS.md:58` — 422 rutas y decenas de identificadores por nombre; y la norma vigente que ordena español.
9. `src/database/migrations/036-069_*.sql` — nombres inmutables; 18 citados por criterios.
10. `tests/**` — 189 imports de símbolos españoles; 43 módulos de nombre español.

---

## 7. Resumen

`src/` tiene 4 637 declaraciones de nivel superior en 376 archivos `.ts`: 49 % en inglés, 45 % en español, 5 % mixtas y 2 % neutras, con una tasa de error medida de 1,5 % (3/200) que sólo infla «mixto» a costa de «es». La partición no es por capa sino por fecha: types/utils/config/ar/ap/policy/vault/ai-skills/GraphQL están al 98-100 % en inglés y banking (88 %), sat (87 %), fiscal (95 %), backup (91 %), accruals (91 %), fx (90 %), plan (91 %) y jurisdiccion (100 %) en español, con accounting y payroll como costura al 35 %. Los nombres de archivo van por detrás: 41 `.ts` (11 %) y 35 de 75 migraciones (las 036-069, inmutables) son españoles, y ningún identificador español sale por REST, GraphQL ni como nombre de comando CLI, pero 200 de los 766 símbolos que cruzan carpetas (26 %) son españoles, 494 tienen 737 sitios de import en `src/` y 144 se importan desde `tests/`. Renombrar rompe de forma medible 51 de 133 criterios ejecutables (40 por ruta, 15 por identificador), 19 anclas de mutantes, 2 umbrales de cobertura por archivo (`criterio-cierre.ts`) más el `include` de `jurisdiccion/**`, 33 rutas citadas en docs y las 53 claves del panel de políticas si se tocan sus valores.
