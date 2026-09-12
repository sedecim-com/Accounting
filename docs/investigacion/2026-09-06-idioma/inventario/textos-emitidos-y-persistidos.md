# Inventario · Textos que el sistema escribe en la base o emite a terceros

Superficie: **textos generados por el sistema que quedan persistidos en PostgreSQL o salen en un archivo/protocolo hacia un tercero**, y que por tanto NO se pueden re-traducir después con un catálogo de mensajes en la capa de presentación.

- Árbol: `/Users/victor/projects/Accounting`, commit `b31e62a` (rama `instrumentos-que-mienten-segun-la-maquina`).
- **Aviso de árbol compartido**: durante la investigación otra sesión modificó `src/ai/doctor-service.ts` (+23 líneas), `src/services/accounting/iva-ppd-reclass.ts` (+11), `iva-cash-basis.ts`, `pais-contable.ts` y `vitest.config.ts` (`git diff --stat`). Para esos dos archivos las líneas se citan **de HEAD** (`git show HEAD:<ruta> | grep -n`), no del árbol de trabajo. El resto de citas coincide en ambos.
- No se editó ningún archivo del repositorio. Ningún archivo leído contenía instrucciones dirigidas al investigador.

---

## 1. Método y comandos

Todos los conteos son reproducibles desde la raíz del repo. Se cuentan **líneas de código fuente** con un literal, no filas de base de datos (no se consultó ninguna base).

| # | Qué cuenta | Comando |
|---|-----------|---------|
| C1 | Literales `description:` en los 11 escritores de asientos | `for f in src/services/accounting/posting.ts src/services/accounting/period-close.ts src/services/accounting/ar-ap-posting.ts src/services/accounting/iva-ppd-reclass.ts src/services/banking/treasury-posting.ts src/services/accruals/amortization-run.ts src/services/assets/depreciation.ts src/services/payroll/common/gl-posting-service.ts src/services/xml-ingestion/pre-registration-service.ts src/services/xml-ingestion/cfdi-posting-plan.ts src/services/xml-ingestion/cfdi-taxonomy.ts; do grep -c -E "description: (\`\|'\|\")" $f; done` → **106** |
| C2 | Llamadores de `createJournalEntry(` (quién escribe pólizas) | `grep -rn "createJournalEntry(" src --include='*.ts' \| grep -v "export async function" \| awk -F: '{print $1}' \| sort \| uniq -c` → 18 archivos (9 en ar-ap-posting, 3 treasury, 2 period-close, …) |
| C3 | Cabeceras de póliza (4.º argumento literal) | `grep -rn -A5 "createJournalEntry(" src/services src/ai --include='*.ts' \| grep -E "^\S+-[0-9]+-\s+(\`\|')"` + lectura manual de los 5 ternarios de ar-ap-posting (572, 684, 905, 1099, 1185) → **22 plantillas** |
| C4 | Descripciones de línea pasadas por parámetro en nómina | `grep -c "creditIfPresent('" src/services/payroll/common/gl-posting-service.ts` → **10** (+3 `description:` +2 ternario subsidio = 15) |
| C5 | Cuentas sembradas por estrato | `awk 'NR>=44&&NR<=82&&/code: /{a++} NR>=92&&NR<=99&&/code: /{b++} NR>=123&&NR<=127&&/code: /{c++} END{print a,b,c}' src/services/accounting/chart-seed.ts` → **32 / 6 / 3 = 41** |
| C6 | Cuentas de nómina MX/US | `awk 'NR>=85&&NR<=131&&/code: /{m++} NR>=171&&NR<=218&&/code: /{u++} END{print m,u}' src/services/payroll/common/payroll-account-mapping-seed.ts` → **6 MX / 9 US** |
| C7 | Cuentas por rol CFDI | `grep -c -E "^\s*code: '" src/services/xml-ingestion/account-roles-seed.ts` → **24** |
| C8 | Panel de políticas, por campo | `for k in question impact whyAsking whatIDo ifSkipped defaultRationale; do grep -c -E "^\s*$k:" src/services/policy/pending-catalog.ts; done` → 54/54/53/53/53/54; `grep -o "label:" … \| wc -l` → **134 opciones** |
| C9 | Panel en castellano | `grep -E "^\s*question:" pending-catalog.ts \| grep -c "¿"` → **0**; `grep -E "^\s*(label\|impact\|whyAsking\|whatIDo\|ifSkipped\|defaultRationale):" … \| grep -c -E "[áéíóúñ¿¡]"` → **0** |
| C10 | `reason:` con literal (audit_log) | `grep -rn -E "reason: (\`\|'\|\")" src --include='*.ts' \| grep -v -E "/plan/\|\.spec\."` → 16 líneas, de las que 6 son prosa (resto: tipos `'01'\|'02'…` del PAC y `''`) |
| C11 | Escritores de `audit_log` | `grep -rn "registrarAuditoria(" src \| grep -v "export async function" \| grep -v /plan/ \| wc -l` → **50**; `grep -rn "INSERT INTO audit_log" src \| grep -v /plan/` → 5 directos |
| C12 | Doctor: nombres y detalles | `git show HEAD:src/ai/doctor-service.ts \| grep -c "name: '"` → 53 líneas, **19 nombres únicos**; `… \| grep -c -E "detail:\s*(\`\|')"` → **43**; con acentos/ñ o léxico castellano → **5** |
| C13 | Formatos de locale | `grep -rn -E "toLocaleString\|toLocaleDateString\|Intl\.(NumberFormat\|DateTimeFormat)" src --include='*.ts' \| grep -v /plan/ \| grep -v spec` → **8** (7 `en-US`, 1 `es-MX`) |
| C14 | Textos fijados por pruebas | `grep -rl --include='*.ts' -F "<texto>" tests` por cada literal (tabla en §4) |
| C15 | Correo/notificación real | `grep -rn -i -E "nodemailer\|sendgrid\|smtp\|sendMail\|sendEmail" src --include='*.ts' \| grep -v /plan/` → **0** implementaciones; `grep -rn "IEmailAdapter" src \| grep -v adapter.interface` → **0** |

Heurística de idioma (C9, C12, §3): presencia de `[áéíóúñ¿¡]` o de palabras castellanas inequívocas; contada línea a línea y verificada a ojo en cada archivo. Donde digo «en inglés» es porque leí la cadena, no por ausencia de acentos.

---

## 2. Dónde aterriza cada texto (columna, idioma, cantidad)

### 2.1 Pólizas: `journal_entries.description`, `journal_entries.notes`, `journal_entry_lines.description`

Esquema: `src/database/migrations/001_core_schema.sql:242-243` (`description TEXT, notes TEXT`) y `:281` (`journal_entry_lines.description TEXT`).
Inmutabilidad: `041_el_mayor_inviolable.sql:42-70` — en un asiento **posteado** sólo admiten UPDATE `reversed_by_entry_id, notes, entry_hash, blockchain_attestation_id, commitment`; **`description` queda congelada** para siempre. La descripción **no** entra en el hash de atestación (`src/services/blockchain/crypto-service.ts:36-58`: id, fecha, totales, líneas cuenta/debe/haber), así que leerla de otra forma no rompe la cadena.

Escritores y plantillas (todas persistidas; la clase es `texto_persistido`):

| Archivo:línea | Plantilla | Idioma |
|---|---|---|
| `src/services/accounting/posting.ts:676` | `Reversal: ${line.description}` (cada línea del espejo) | en |
| `posting.ts:752-753` | `Reversal of ${entry_number}[: ${reason}]` (cabecera) | en |
| `posting.ts:812` | `Reversal of ${entry_number}: ${reason}` (void de posteado) | en |
| `posting.ts:817,822` | `notes = notes \|\| '\nVoided: ${reason}'` | en |
| `src/services/accounting/period-close.ts:1388` | `'Year-end closing entries'` | en |
| `period-close.ts:1418` | `Close Income Summary to ${nombreDestino}` | en (+nombre de cuenta es) |
| `period-close.ts:1369,1370,1374,1375,1410,1411` | `Close revenue to Income Summary`, `Revenue closed to…`, `Close expense to…`, `Expenses closed to…`, `Close Income Summary`, `Net income\|loss to ${nombreDestino}` | en |
| `period-close.ts:1320-1328` | `Reversal of ${n}: Recierre de periodo reabierto: se reversa el cierre anterior…` | **mixto** en+es en una sola cadena |
| `src/services/banking/treasury-posting.ts:900,911,918,930` | `Bank fee ${fecha} - ${etiqueta}`, `VAT on bank fee parked in 1135 - no CFDI from the bank yet - …`, `Bank fee charged …`, cabecera `Bank fee ${fecha} - ${account_name} - ${etiqueta}` | en |
| `treasury-posting.ts:1179,1188,1195,1202` | `Interest credited … (net)`, `ISR withheld by the bank - prepayment in our favour, NOT an expense`, `Interest earned … (gross)`, cabecera | en |
| `treasury-posting.ts:1496,1502,1512` | `IVA now creditable - cheque … cleared …`, `IVA released from 1135 on cheque clearing (LIVA: …)`, cabecera `Cheque … cleared … - IVA reclassified 1135 to 1130` | en |
| `treasury-posting.ts:893,1173` | respaldo de `etiqueta`: `'Bank fee'`, `'Interest earned'` cuando el banco no trae descripción | en |
| `src/services/accruals/amortization-run.ts:326,332,338` | `Prepaid amortization ${period_name} - ${desc}`, `Accrued expense - …`, `Prepaid expenses - …` | en (+`period_name` en) |
| `src/services/assets/depreciation.ts:367,373,379` | `Monthly depreciation ${period_name} - ${asset_name}`, `Depreciation - …`, `Accumulated Depreciation - …` | en |
| `src/services/payroll/common/gl-posting-service.ts:120,129,138,226` | `Gross wages for pay run …`, `'Employer payroll taxes'`, `'Net pay disbursement'`, `Payroll run …` | en |
| `gl-posting-service.ts:149-193` (10 × `creditIfPresent`) | `'FIT withheld'`, `'FICA EE+ER'`, `'FUTA'`, `'SUTA'`, `'State tax + SDI'`, `'ISR withheld (net of subsidio)'`, `'IMSS EE+ER'`, `'INFONAVIT'`, `'Pre-tax benefit withholding'`, `'Post-tax deductions/garnishments'` | en (mezcla siglas MX) |
| `gl-posting-service.ts:187-188` | `'Subsidio al empleo entregado en efectivo (acreditable contra ISR retenido)'` / `(absorbido por el patrón)` | **es** |
| `src/services/accounting/ar-ap-posting.ts` (31 `description:` + 9 cabeceras) | `Invoice ${n}`, `Bill ${n} - line ${k}`, `Credit note ${n}`, `Payment received ${n}`, `AR settlement ${n}`, `On-account (unapplied) ${n}`, `IVA released from ${role} on collection - Invoice …`, `IVA now in ${to} (PPD payment) - Bill …`, `Early-payment discount taken …`, `Short-pay write-off …`, `Realized FX loss/gain … (${moneda} @ ${tasa})`, `AR reopened … (unapply …)`, `Back on account …`, `Unapplication of … from …` (:968), `Customer payment … · IVA caused on collection: …` (:572-574), `Application of …` (:684-686, :905-907), `Vendor payment … · IVA creditable on payment: … · early-payment discount …` (:1099-1103, :1185-1188) | en |
| `ar-ap-posting.ts:101-102,165-167,255-257,375-377` | sufijos `· MetodoPago missing: ${m} assumed`, `IVA ${describeMetodo} - Invoice … · ${ivaTreatmentNote}`, `Tax - Invoice …`, `Creditable IVA - Bill …`, `IVA reversed … · no linked invoice: PUE assumed` | en |
| `src/services/accounting/iva-ppd-reclass.ts` HEAD:232,238,244 | `Reclasificación IVA PPD — ${n}`, `IVA pendiente de acreditar — CFDI ${uuid}`, `Sale de IVA acreditable — …` | **es** |
| `src/services/xml-ingestion/cfdi-taxonomy.ts` (54 × `description:`, p. ej. :129-131,146-147,212) | `'Advance to vendor'`, `'Creditable VAT on the advance'`, `'Vendor payable for advance'`, `'Expense/purchase'`, `'IEPS'`, `'Sale'` … | en |
| `src/services/xml-ingestion/cfdi-posting-plan.ts:210` | `${propuesta.description} — ${referencia}` (la taxonomía llega a la línea con el folio) | en |
| `src/services/xml-ingestion/pre-registration-service.ts:863,894,1162` | `Bill ${n}`, `${ivaTreatmentNote('received', d)} — Bill ${n}`, cabecera `Bill ${n} - ${external_reference}` | en |

Flujo de la taxonomía: `cfdi-taxonomy.ts` → `planearAsiento` (`cfdi-posting-plan.ts:199-212`) → `pre-registration-service.ts:784` (`lineasDelAsiento`) → `:1150-1162` `createJournalEntry` directo. **No pasa por `ai_drafts`**: las 54 descripciones inglesas de la matriz quedan escritas en `journal_entry_lines.description` de cada CFDI contabilizado por reglas.

Descripciones que NO son del sistema (dato del usuario o del agente, se persisten tal cual y no son traducibles por diseño): `journal-entry-service.ts:363` (`input.description`), `batch-service.ts:745` (lote importado), `reconciliation-service.ts:2841-2851` (`payload.description` del ajuste), `draft-service.ts:670` (`approvedPayload.description`, que es lo que redactó el LLM en `draft-tools.ts:28,41`), REST `journal-entries.ts:213`, GraphQL `resolvers/index.ts:444-453`, `ar-ap-posting.ts:155,245` (`line.description ||` plantilla).

**Balance**: de las ~120 plantillas del sistema (C1 106 + C3 22 − solapes), **5 están en castellano** (iva-ppd-reclass ×3, gl-posting ×2) y **1 es mixta** (period-close:1320-1328); el resto en inglés. El mayor de una entidad mexicana hoy nace con «Reversal of JE-…», «Year-end closing entries», «Bank fee 2026-03-01 - …».

### 2.2 Salida a terceros de esas mismas cadenas: Anexo 24 (SAT)

`src/services/sat/anexo24/polizas-service.ts:949-951` (`desCta ← a.name`, `concepto ← jel.description ?? je.description ?? entry_number`), `:980` (`concepto` de la póliza), `:1199,1216` (auxiliar de folios/cuentas); `catalogo-cuentas.ts:290,381,418` (`Desc ← accounts.name`). Es decir: el XML que se entrega al SAT lleva como `Concepto` las plantillas inglesas de §2.1 y como `Desc` los nombres de cuenta de §2.3. Clase: `texto_emitido_a_tercero`. Los tags del esquema (`Concepto`, `NumCta`, `DesCta`) son vocabulario del SAT, no se traducen.

### 2.3 Nombres y descripciones de cuentas sembradas: `accounts.name VARCHAR(255)`, `accounts.description`

Esquema `001_core_schema.sql:105`. Escritores con literal (`grep -rn "INSERT INTO accounts" src`):

| Semilla | Filas | Idioma | Ejemplos |
|---|---|---|---|
| `src/services/accounting/chart-seed.ts:44-82` (universal) | 32 | es | `'Caja y Bancos'`, `'Resultado del Ejercicio'` (:64), `'Resumen de Ingresos y Gastos'` (:65) |
| `chart-seed.ts:92-99` (fiscal MX) | 6 | es | `'Banco Nacional - MXN'`, `'IVA Acreditable'` |
| `chart-seed.ts:123-127` (fiscal neutro, entidades **no mexicanas**) | 3 | **es** | `'Cuenta Bancaria Operativa'`, `'Impuesto sobre Ventas por Pagar'` — una sociedad de Delaware nace con catálogo en castellano; el propio comentario :32-35 dice «con los nombres en español porque el producto se usa en español» |
| `src/services/xml-ingestion/account-roles-seed.ts:38-224` | 24 (+`description`) | es | `'IVA Pendiente de Acreditar'`, descripción `'Anticipos pagados: es un derecho a recibir el bien o servicio, no un gasto.'` (:69) |
| `src/services/payroll/common/payroll-account-mapping-seed.ts:87-124` | 6 | es | `'INFONAVIT por Pagar'` |
| `payroll-account-mapping-seed.ts:173-215` | 9 | **en** | `'FICA Payable'`, `'Salaries and Wages'`, descripción `'Employer FICA, FUTA and SUTA — the employer cost, not the employee withholding.'` (:215) |
| `src/ai/onboarding-service.ts:204` | 1 | en | `'Opening balancing (onboarding)'` |
| `src/database/migrations/053_la_nomina_deja_de_cargarse_a_devoluciones.sql:118-135` | 4 | es+en | `'Salaries and Wages'`, `'Employer Payroll Taxes'` sembradas **por migración** (append-only: ese texto ya no se toca) |

Los roles se resuelven por `code`/`account_roles`, nunca por nombre (`chart-seed.ts:9-12`), así que el nombre es presentación… salvo en los mensajes que lo citan: `period-close.ts:1252,1270` («3900 «Resumen de Ingresos y Gastos»», «3300 «Resultado del Ejercicio»»).

### 2.4 Nombres de periodo: `fiscal_periods.period_name VARCHAR(50)`

Esquema `001_core_schema.sql:198`. Escritor: `src/services/accounting/fiscal-calendar-service.ts:534` → `start.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }) + ' 2026'` = **`January 2026`** (clase `formato_locale` + `texto_persistido`, en). Semilla de desarrollo `src/database/seed.ts:54,68` con los 12 meses en inglés.
Lectores que dependen del texto: resolución por nombre tecleado `fiscal-calendar-service.ts:141-151` (`period_name ILIKE $2`, y el error lista los nombres), mensajes `:246-258,378-384`; se **copia dentro de otras cadenas persistidas** (`amortization-run.ts:115,326`; `depreciation.ts:367`); informes `report-service.ts:208,232` (`"January 2026..March 2026"`).

### 2.5 Rótulos de informes (renderizados, no persistidos)

`src/services/reporting/report-service.ts:964-966` (`'Assets'`, `'Liabilities'`, `'Equity'`), `:975` (`'Result Of The Period'`), `:1085` (`'Revenue'`/`'Expenses'`) — **6 literales**, en, clase `texto_de_usuario_renderizado`. No hay `createHash` en `src/services/reporting` (los informes no se firman por rótulo). Los consume la CLI (`src/cli/report-command.ts:519` «Revenue … Expenses … Net income»), GraphQL/REST y las pruebas los usan **como clave de búsqueda** (§4). `docs/jurisdicciones.md:135` ya prevé `informes: { idioma: 'es' | 'en' }` por paquete de jurisdicción.

### 2.6 Panel de políticas: `pending-catalog.ts` → `policy_decisions`

Catálogo `src/services/policy/pending-catalog.ts`: 54 claves; por clave `question`, `impact`, `defaultRationale` (54), `whyAsking`, `whatIDo`, `ifSkipped` (53), y 134 opciones `{value,label}`. **Todo en inglés** (C9: 0 cadenas con `¿` o acentos). Ejemplo `:52-91` (`catalogo_entidad_no_mexicana`).
Persistencia: `src/services/policy/policy-service.ts:51-58` inserta `question, impact, options (JSONB con labels), default_value, default_rationale` **por inquilino, una sola vez** (`ON CONFLICT DO NOTHING`); esquema `016_policy_decisions.sql:18-24`. Es decir, la prosa inglesa queda **congelada por tenant** en el momento de sembrar; `criterios.ts:6312-6326` ya lo sabe («el texto congelado al sembrar caduca») y obliga a `pending-command.ts` a leer del catálogo, no de la fila.
Los `value` (`'base_neutro'`, `'vida_util_nif'`, `'tasa_lisr'`, `'mes_completo'`, `'directo_a_acumulados'`, `'cuenta_por_cobrar_fisco'`…) son **valores persistidos en `resolved_value` y comparados por el código** (`period-close.ts:1300-1312`, `gl-posting-service.ts:180-188`): clase `dato_vocabulario`, en castellano, **no se traducen** (regla de la casa). `resolution_notes` es texto del usuario.

### 2.7 `audit_log.reason TEXT` (append-only, `033_audit_log_append_only.sql`)

Esquema `001_core_schema.sql:468`. 50 llamadas a `registrarAuditoria` + 5 INSERT directos. La mayoría pasa `opts.reason`/`--reason` del usuario. Motivos **generados por el sistema**:

| Archivo:línea | Texto | Idioma |
|---|---|---|
| `src/services/accounting/posting.ts:323` | `Reversión de ${reference}` | es |
| `posting.ts:722` | `reason: description` = `Reversal of …` | en |
| `posting.ts:182` (`autorizarPosteo`, vía :368/:506) | `'SoD: quien postea es quien creó el borrador (política en alertar)'` | es |
| `src/services/banking/treasury-posting.ts:1568` | `Cobro del cheque ${n}` | es |
| `src/services/assets/asset-service.ts:740` | `Alta de activo fijo (${categoria.name})` | es |
| `src/services/banking/reconciliation-service.ts:1413` | `'clasificación de partidas conciliatorias'` | es |
| `reconciliation-service.ts:2349-2351,2496` | `'SoD: quien aprueba la conciliación es quien la cerró…'` | es |
| `src/services/accounting/period-close.ts:1320-1322` | `Recierre de periodo reabierto: …` (dentro de `Reversal of …`) | mixto |
| `src/services/banking/match-service.ts:72-79,1740,1778` | `MOTIVOS_DESAPLICACION` (`'cotejo-erroneo'`, `'duplicado'`…) → `reconciliation_matches.unapply_reason` y `audit_log.reason` | es, **códigos** (`:1673-1676`: «el motivo es un código y no prosa libre porque las causas tienen que poder contarse») |
| `fiscal-calendar-service.ts:397-410` | `reason ?? null` (usuario) | — |

Aquí el reparto es el inverso al de las pólizas: el rastro se escribe mayormente en castellano y el mayor en inglés.

### 2.8 Doctor (`src/ai/doctor-service.ts`, HEAD)

19 nombres de verificación: 18 en inglés (`'Migrations'`, `'Ledger integrity'`, `'Tenant isolation'`…) y 1 en castellano (`'Segregación de funciones (permisos)'`, HEAD:905,911). 43 `detail`: 38 en, 5 es (HEAD:826 `'account_balances = Σ líneas posteadas, y todo posteado tiene su rastro'`, :907, :977, :1144 …). **No persiste** (`grep -n "INSERT INTO\|UPDATE " doctor-service.ts` → 0): clase `texto_de_usuario_renderizado`. Pero el nombre es contrato: `tests/ai/doctor-service.spec.ts:86-136` busca `find(r, 'Migrations')`, `'Tenant isolation'`.

### 2.9 Textos que escribe el agente (`ai_*`)

- **Idioma del agente**: `src/ai/providers/config.ts:1119-1131` (`MNEMOSINE_LANG` o `config.language`, **por omisión `'es'`**); `src/ai/system-prompt.ts:171-174` `'Always respond in Spanish'|'…English'`; `mnemosine.config.json` trae `"language": "es"`. Todo lo que redacta el LLM se persiste en ese idioma **sin marca de idioma en la fila**.
- `ai_drafts.payload.description` / `payload.lines[].description` / `ai_reasoning` (`011_ai_drafts.sql:20-27`; `draft-service.ts:346-356`; esquema de la herramienta `src/ai/tools/draft-tools.ts:28,41`) — prosa del LLM. Al aprobarse pasa a `journal_entries.description` (`draft-service.ts:670`).
- `ai_drafts.review_notes` ← `src/ai/ingest-service.ts:362` `auto-post by threshold (confidence 0.97, amount 1234…)` (en). **Se usa como discriminador**: `src/ai/stats-service.ts:97-102` y `src/ai/shadow-verdicts.ts:57,61` filtran `LIKE 'auto-post by threshold%'`; `src/plan/criterios.ts:3198,3416` exigen ≥3 apariciones del literal en stats-service. Prefijo `reviewed_by 'policy:'` ídem (criterios:3199).
- `ai_shadow_verdicts.motivo` ← `ingest-service.ts:410-461`: 6 en inglés (`'suspicious third-party content: a flagged CFDI never auto-posts'`, `confidence … < …`) y **1 en castellano en la misma función** (`:461` `'todas las compuertas pasaron'`).
- `ai_questions.question/context/answer` (`013_ai_questions.sql:17-24`) ← LLM (`question-tools.ts:124`) o humano; literal del sistema `src/ai/memory-service.ts:163-164` `context = 'Criterion taught directly by the firm (did not arise from a question).'`, `ai_model = 'human-taught'` (en).
- `ai_messages.content`, `ai_sessions.title` (`session-store.ts:157-168`, primer mensaje del usuario), `skill_drafts.content` (`skill-drafts.ts:143-149`), `ai_webhook_deliveries.suspicion` (JSON de banderas), `ai_ingest_runs` (`ingest-runs.ts:281` guarda `err.message` de Node/pg, en inglés).

### 2.10 Cotejo bancario

`reconciliation_sessions.notas TEXT` (`054_la_sesion_que_cuadra.sql:99`) ← `opts.notas` del usuario. `reconciliation_matches.unapply_reason` ← códigos (§2.7). Asientos de ajuste ← `payload.description` del usuario/agente (`reconciliation-service.ts:2841-2851`). Asientos automáticos de tesorería ← plantillas inglesas de §2.1 + `etiqueta` del banco. Rastro ← castellano (§2.7).

### 2.11 Archivos generados

| Generador | Texto libre emitido | Idioma / clase |
|---|---|---|
| `src/services/payroll/mx/cfdi-nomina-generator.ts:108,120-121,134,154` | `Concepto="Subsidio para el empleo (efectivamente entregado al trabajador)"`, `Descripcion="Pago de nómina"`, `Concepto="ISR"`, `Concepto ← paycheck_earnings/deductions.description` (dato: `paycheck-service.ts:591-610`) | es, **vocabulario SAT** |
| `src/services/payroll/mx/sua-generator.ts` | ninguno (ancho fijo numérico; nombre de archivo `SUA_…` :114) | — |
| `src/services/payroll/usa/nacha-generator.ts:90,102` | `pad('BANK', 23)`, `pad('PAYROLL', 10)` (Company Entry Description) | en, **constante de protocolo** |
| `src/services/payroll/usa/forms/w2-generator.ts:114` | `label: 'SDI'` | código |
| `src/services/sat/diot/serializador.ts:179-201` | «papel de trabajo»: `'# PAPEL DE TRABAJO DE LA DIOT — ESTO NO ES EL ARCHIVO DE LA DECLARACIÓN.'`, `# Contribuyente: …`, `# Base: operaciones PAGADAS (LIVA art. 5 frac. III)…` (≈12 líneas) y `:213-227` explicación del lote no fundamentado | **es**, `texto_emitido_a_tercero` (lo lee el contador, no el SAT) |
| `src/services/sat/anexo24/*.ts` | tags SAT + `Concepto`/`Desc` de §2.2 | es (esquema) + **en (contenido copiado del mayor)** |
| `src/services/backup/exportacion-inquilino.ts` | JSON de filas, sin prosa | — |

### 2.12 Correos y notificaciones

`src/services/integrations/base/adapter.interface.ts:155-175` declara `IEmailAdapter` (`subject`, `messageId`) y **nadie lo implementa** (C15 → 0). Sin nodemailer/sendgrid/smtp. Webhooks salientes (`src/services/webhooks/webhook-service.ts`) envían JSON sin literales de prosa. PAC: motivo de cancelación `'01'|'02'|'03'|'04'` = códigos SAT. `docs/cli-command-catalog.md:749` prevé `dunning preview … --lang` (no construido). **Superficie vacía hoy**: es el sitio donde diseñar bien desde el primer día.

### 2.13 Formatos de locale (C13)

`fiscal-calendar-service.ts:534` (`en-US`, **persistido**, §2.4); `policy-preview.ts:27` (`en-US` importes, render); `cfdi-decisions.ts:47` (`es-MX` importes, render); `compact-command.ts:83`, `usage-command.ts:71`, `prompt-size-command.ts:103`, `approvals-command.ts:158-159` (`en-US`, render CLI — superficie de otro inventario).

---

## 3. Ejemplos con clase (resumen de los 20 más representativos)

Ver §2; clasificación usada en el JSON de salida: `texto_persistido` (§2.1, 2.3, 2.4, 2.6, 2.7, 2.9), `texto_emitido_a_tercero` (§2.2, 2.11), `texto_de_usuario_renderizado` (§2.5, 2.8), `dato_vocabulario` (valores del panel, códigos de desaplicación, tags SAT, NACHA), `formato_locale` (§2.13).

---

## 4. Qué se rompe al cambiar (acoplamientos con archivo:línea)

**Pólizas (§2.1)**
- Pruebas que fijan la prosa: `tests/services/accounting/batch-service.spec.ts` (`Reversal of`), `tests/accounting/posting-create.spec.ts` y `posting-auditoria.spec.ts` (`Reversal:`, `Reversión de`), `tests/integration/g1a-informes-y-saldos.int.spec.ts` (`Year-end closing entries`), `tests/services/accounting/cierre-barrido.spec.ts` (`Close Income Summary`), `tests/integration/iva-ppd-reclass.int.spec.ts` (`Bill ${`).
- El mayor posteado es inmutable (`041:42-70`): **ninguna fila histórica se corrige**; una migración que quisiera rellenar columnas nuevas en asientos posteados tendría que `CREATE OR REPLACE` la función `ledger_posteado_inmutable` añadiendo esas columnas a `permitidas` (migración nueva ≥070; nunca renumerar; los cuatro duplicados 012/014/015/018 de `docs/migraciones.md:17-20` no se tocan).
- Anexo 24 (§2.2): cambiar la prosa cambia los bytes del XML entregado; `balanza-xml.ts:73` avisa que «el orden de las filas es parte de los bytes» — hay pruebas de bytes en `tests/` para anexo24 que habrá que revisar al tocar `Concepto`.
- Umbrales por archivo: `vitest.config.ts:82` (`posting.ts`), `:88` (`ar-ap-posting.ts`), `:95` (`report-service.ts`) — mover o renombrar estos archivos descoloca el umbral (`period-close.ts` no lleva umbral, `:41`).
- `src/plan/criterios.ts` no fija ninguna de estas plantillas (grep de `Reversal|Voided|Year-end|Close Income` → 0), sólo `conducta.ts:236-237` pasa `descripcion` como parámetro.

**Cuentas (§2.3)**
- Pruebas: `tests/integration/catalogo-por-pais.int.spec.ts` (`Banco Nacional - MXN`), `tests/integration/period-close.int.spec.ts`, `tests/integration/cierre-que-barre.int.spec.ts` (`Resultado del Ejercicio`), `tests/accounting/period-close-accounts.spec.ts` (`Resumen de Ingresos y Gastos`); 6 pruebas nombran `IVA Acreditable`.
- Criterio E1.1 (citado en `chart-seed.ts:119-121`): dos semillas no pueden declarar el mismo código con nombres distintos — una semilla bilingüe por clave lo respeta si el nombre se resuelve **antes** de insertar.
- `053:118-135` ya sembró nombres por migración: esas filas quedan como dato.
- Mensajes que citan el nombre: `period-close.ts:1252,1270`.

**Periodos (§2.4)**
- `fiscal-calendar-service.ts:141-151` resuelve por `ILIKE` el nombre que teclea el usuario; con nombres en castellano cambia lo que hay que teclear y las filas viejas siguen en inglés (entidades con 2026 en «January» y 2027 en «Enero»).
- Pruebas: `tests/services/accounting/fiscal-calendar-service.spec.ts:100-115`, `tests/services/reporting/report-service.spec.ts:921-922`, `tests/services/accounting/journal-entry-service.spec.ts` (`January 2026`); `src/cli/period-command.ts` y `src/ai/docs/cli-reference.md` lo muestran (este último está hasheado en `src/ai/docs/manifiesto.json`).
- El nombre se copia dentro de descripciones de pólizas (`amortization-run.ts:326`, `depreciation.ts:367`): doble persistencia.

**Informes (§2.5)**
- `tests/integration/g1a-cifras-que-se-firman.int.spec.ts:198,278` y `tests/services/reporting/report-service.spec.ts` buscan `s.name === 'Result Of The Period'`; `tests/…report-service.spec.ts` también `'Assets'`/`'Liabilities'`.

**Panel (§2.6)**
- `criterios.ts:1436, 2162, 2723-2738, 3438, 6001, 6312-6326` leen `pending-catalog.ts` con grep; el de :2723-2738 vigila **prosa concreta** («direct SAT download …») y el de :3438 `value: 'shadow'`.
- Filas ya sembradas por tenant conservan la prosa vieja (`policy-service.ts:51-58`); `pending-command.ts` lee del catálogo (`criterios:6312`), así que la fila sólo importa para quien lea `policy_decisions` directo (GraphQL/REST).
- Los `value` **no se tocan**: `resolved_value` persistido y comparado literalmente (`period-close.ts:1300-1312`, `gl-posting-service.ts:180-188`, `posting.ts:171-182`).

**Rastro y agente (§2.7, 2.9)**
- `audit_log` append-only (`033`): lo escrito, escrito está.
- `review_notes LIKE 'auto-post by threshold%'`: `stats-service.ts:97-102`, `shadow-verdicts.ts:57,61`, `criterios.ts:3198,3416`, `tests/integration/agente-medible-a12.int.spec.ts`, `tests/ai/ingest-service.spec.ts`. Cambiar la cadena parte la estadística histórica en dos.
- `tests/ai/external/onboarding-service.spec.ts` fija `Opening balancing`.

**Doctor (§2.8)**: `tests/ai/doctor-service.spec.ts:86-136` por nombre.

**Ninguna ruta de esta superficie aparece en `LINEA_BASE` de `src/cli/kernel/audit.ts:197`** (grep de `services/(accounting|banking|policy|reporting|payroll|sat|assets|accruals)` → 0).

---

## 5. Dependencias (criterios, pruebas, umbrales, manifiestos, docs)

- `src/plan/criterios.ts:1436,2162,2723-2738,3198,3416,3438,6001,6312-6326`
- `vitest.config.ts:82,88,95` (umbrales por archivo de posting.ts, ar-ap-posting.ts, report-service.ts)
- `src/database/migrations/041_el_mayor_inviolable.sql:42-70` (columnas editables de un posteado), `033_audit_log_append_only.sql`, `016_policy_decisions.sql:18-24`, `013_ai_questions.sql:17-24`, `011_ai_drafts.sql:20-31`, `053:118-135`
- `docs/migraciones.md:17-20` (duplicados 012/014/015/018)
- Pruebas listadas en §4 (C14)
- `src/ai/docs/cli-reference.md:37,285-302` (idioma del agente; hasheado en `src/ai/docs/manifiesto.json`)
- `docs/jurisdicciones.md:135,257` (`informes.idioma` por paquete), `docs/cli-command-catalog.md:749,2800` (`--lang`, `lang`/`config set language`)
- `mnemosine.config.json` (`language`), `src/ai/providers/config.ts:1119-1131`, `src/ai/system-prompt.ts:171-185`
- `CONTRIBUTING.md:158` y `docs/PROCESS.md:58` (comentarios/docs/commits en castellano — norma vigente, contraria al pedido)

---

## 6. Qué habría que hacer (clave + parámetros persistidos, render al leer)

Principio: **lo que el sistema redacta se guarda como `(clave, parámetros)` y se renderiza en el idioma del lector o del destinatario; lo que redacta una persona o el LLM se guarda como está, con su idioma anotado.** Lo histórico no se reescribe.

1. **Pólizas.** Migración nueva (≥070): `journal_entries.description_key VARCHAR(80)`, `description_params JSONB`, y lo mismo en `journal_entry_lines`; añadir ambas a `permitidas` de `ledger_posteado_inmutable` sólo si se decide rellenar históricos (no recomendado: NIF B-1 y rastro). Las 22 cabeceras y ~100 líneas de §2.1 se convierten en claves (`entry.reversal_of {entry_number, reason}`, `closing.year_end`, `treasury.bank_fee {date, label}`…). `description` sigue escribiéndose (render en el idioma de la entidad al escribir) para lectores viejos y para el Anexo 24, que necesita una cadena fija. Filas con `description_key IS NULL` se muestran tal cual: dato histórico. Los textos que hoy son mixtos (`period-close.ts:1320-1328`) desaparecen al separarse la clave del motivo humano.
2. **Anexo 24.** Al emitir, `Concepto` se renderiza **siempre en es-MX** desde `(clave, params)` cuando exista, y desde `description` cuando no. Eso corta el paso de plantillas inglesas al SAT sin tocar el mayor.
3. **Cuentas.** Las tres semillas (`chart-seed`, `account-roles-seed`, `payroll-account-mapping-seed`) pasan a `{code, nameKey}` y se renderizan en el idioma del paquete de jurisdicción de la entidad (`docs/jurisdicciones.md:135`) **en el momento de sembrar**; el catálogo es dato del cliente y no se re-renderiza. Para entidades existentes, un comando opcional que traduzca sólo los nombres que coinciden byte a byte con la semilla original (= no personalizados). Los mensajes que citan nombres (`period-close.ts:1252,1270`) los leen de la fila, no del literal.
4. **Periodos.** Derivar el nombre de `(period_number, year_number, idioma)` al leer; conservar `period_name` sólo para la resolución `ILIKE`, aceptando ambos idiomas (o resolver por `YYYY-MM`, que ya existe en `:125-134`).
5. **Informes.** Los 6 rótulos salen de un catálogo por idioma de informe (`report.section.assets`…); las pruebas buscan por `id` de sección, no por `name`.
6. **Panel.** `pending-catalog.ts` conserva las **claves** (`key`, `value`) y mueve la prosa (6 campos × 54 + 134 labels) a un catálogo `es`/`en`; `policy-service.ts:51-58` deja de copiar `question/impact/options/default_rationale` a la fila (o la sigue copiando como instantánea auditable, pero nadie la lee: `criterios:6312`). Los `value` no cambian jamás. Los criterios que grepan prosa (`:2723-2738`) se reescriben contra la clave.
7. **`audit_log.reason`.** Los 8 motivos del sistema (§2.7) → `reason_key` + `reason_params` (migración ≥070; la tabla es append-only, los viejos se quedan). Los del usuario siguen libres.
8. **`ai_drafts.review_notes`.** Sustituir el discriminador por una columna (`review_kind = 'auto_post_threshold'`) y dejar el `LIKE` como compatibilidad para filas viejas; actualizar `criterios.ts:3198,3416` en el mismo PR. `ai_shadow_verdicts.motivo` → clave + params (`:461` deja de ser la única en castellano).
9. **Texto del LLM y del usuario** (`ai_drafts.payload`, `ai_questions`, `ai_messages`, `notas`, `resolution_notes`): añadir columna `lang CHAR(2)` con el `resolveLanguage()` vigente al escribir. No se traduce; se sabe qué es.
10. **Doctor.** `name` → `id` estable kebab-case + rótulo por catálogo; las pruebas buscan por `id`.
11. **Archivos a terceros.** CFDI/SUA/DIOT/Anexo 24: vocabulario SAT, en castellano por ley → **no se traduce**; NACHA `'PAYROLL'` → constante de protocolo. El «papel de trabajo» de la DIOT (`serializador.ts:179-227`) sí es prosa del sistema: catálogo, con `es` por omisión.
12. **Correo/notificaciones.** No existe nada: cuando se implemente `IEmailAdapter`, plantillas por clave + `lang` del destinatario desde el día uno.

Orden sugerido por riesgo: 6 (panel, sin datos que rehacer) → 5 y 10 (render puro) → 4 → 3 (semillas, sólo entidades nuevas) → 1+2 (mayor y SAT, con migración) → 7, 8 → 9, 11, 12.

---

## 7. Resumen

En esta superficie el sistema escribe hoy **en dos idiomas cruzados**: el mayor (`journal_entries`/`journal_entry_lines.description`) recibe ~120 plantillas del sistema de las que 5 están en castellano y 1 es mixta, y esas cadenas inglesas viajan al SAT como `Concepto` del Anexo 24; el rastro (`audit_log.reason`) recibe sus 8 motivos de sistema casi todos en castellano; el catálogo sembrado (41+24+15 cuentas) es castellano incluso para entidades estadounidenses salvo 9 cuentas de nómina US en inglés; los 12 nombres de periodo se persisten en `en-US` y se recopian dentro de pólizas; el panel de políticas (54 preguntas, 134 opciones, 6 campos de prosa) es 100 % inglés y se congela por inquilino en `policy_decisions`. Nada de eso se puede re-traducir después: el mayor posteado es inmutable por trigger (`041`), `audit_log` es append-only (`033`) y la prosa del LLM/usuario no lleva marca de idioma. El camino es persistir `(clave, parámetros)` y renderizar al leer o al emitir —con `es` por omisión y el SAT siempre en castellano—, dejando lo histórico como dato; el orden de menor riesgo empieza por el panel y los rótulos, que no tienen datos que rehacer, y termina por el mayor, que exige migración nueva y no renumerar nada.
