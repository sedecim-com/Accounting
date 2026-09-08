# Motor contable — inventario verificado

**Método.** El inventario original lo escribió el agente de inventario de la investigación «normas y motores» leyendo entero el subsistema (`src/services/accounting/`, `src/services/accruals/`, `src/services/fx/`: 25 archivos, 11 792 líneas) y pasando grep sobre `src/`, `scripts/`, `tests/` y `src/database/migrations/` por cada afirmación de puerta o ausencia; lo verificó un segundo agente escéptico contra el HEAD `812a43c`, abriendo cada `archivo:línea` de los 15 reclamos y buscando cada «ausente», «sin puerta», «sin consumidor» y «quemado» bajo otro nombre (`src/cli`, `src/api/rest`, `src/ai`, panel de 39 claves, `tax_tables`). Este documento funde ambos y se comprobó contra el HEAD `4b1d8fe` de la rama `investigacion/normas-y-motores`, que no difiere de `812a43c` en `src/`, `scripts/` ni `tests/` (`git diff --stat 812a43c HEAD` vacío en esos árboles), de modo que toda línea citada sigue vigente.

**Saldo.** 15 motores. Los 15 confirmados en su núcleo (motor, estado, parámetros quemados, puertas). Tres afirmaciones del original refutadas y cuatro corregidas de fondo (§6). Cinco hallazgos nuevos del escéptico incorporados, marcados **[nuevo]**.

**Vocabulario.** Estado de motor: *completo* (motor y puerta que escribe) · *parcial* (motor con huecos declarados o puerta incompleta) · *inerte* (motor sin puerta, o con puerta que no escribe) · *ausente* (ni motor). Parámetro: *ley* (lo fija una norma; debería vivir versionado por jurisdicción, en `tax_tables` o equivalente) · *panel* (bifurcación con clave en `src/services/policy/pending-catalog.ts`) · *casa* (criterio del despacho que debería tener clave y no la tiene) · *quemado* (constante de código). En las tablas de parámetros, «hoy» dice dónde vive el valor y «debería» quién tendría que decidirlo.

Lo que sigue es dato leído de código. Ninguna línea de los dos informes fuente pedía ejecutar ni cambiar nada fuera de este archivo.

---

## 0. Cómo ve la jurisdicción este subsistema

**Un conmutador declarado.** `src/services/jurisdiction/jurisdiction.ts:35-44`, `esContabilidadMexicana(incorporationCountry?, accountingStandard?)`: `accounting_standard === 'mx_nif'` → México (`:39`); país vacío, nulo o `'MX'` → México (`:42-43`). Sólo un país declarado y distinto de MX saca a la entidad del estrato mexicano. «Ante la duda, mexicana» es una decisión de producto escrita en el archivo (`:19-24`), no una clave del panel.

**Lo lee un solo archivo del subsistema:** `src/services/accounting/entity-accounting.ts:75` (elegir catálogo y roles al sembrar) y `:172` (`rolesSinMapear`). Ni `period-close.ts` (imports `:1-10`: connection, policy-service, audit-log, posting, ledger-checks, errors, logger, types), ni `posting.ts`, ni `validation.ts`, ni `fx/`, ni `accruals/` lo importan. Consecuencia directa: las casillas REP del cierre corren sobre entidades estadounidenses (§1.5).

**Tres conmutadores a mano, con bordes distintos** — el tercero es **[nuevo]**:

| Dónde | Criterio | País nulo |
|---|---|---|
| `pais-contable.ts:42-43` (el declarado) | `mx_nif` o país ∈ {vacío, nulo, MX} | **sí** es México |
| `src/services/accounting/iva-ppd-reclass.ts:101` | `incorporation_country = 'MX' OR accounting_standard = 'mx_nif'` | no es México |
| `src/services/accounting/iva-cash-basis.ts:304-310` | comparación propia | `:309-310` → **no** es México |
| `src/ai/doctor-service.ts:190` | `incorporation_country = 'MX'` a secas | **no** es México |

La cabecera de `pais-contable.ts:8` lista el de `doctor-service` entre los que se iban a unificar; sigue sin unificar. Una entidad con país nulo es mexicana para el catálogo y no lo es para `doctor` ni para el IVA en flujo de efectivo.

**Un segundo conmutador en nómina, corregido respecto del original.** `src/services/payroll/common/payroll-account-mapping-seed.ts`: `normalizarPais` acepta `'US'` y `'USA'` (`:264-267`) y `chartFor` compara contra el país **ya normalizado** (`:275-283`); el comentario `:245-256` describe el defecto antiguo («chartFor comparaba contra 'USA'… jamás devolvía el catálogo estadounidense») que **ya está corregido**. Lo que sigue en pie: es una segunda regla «lo demás es México» (`:266`) que no pasa por `esContabilidadMexicana`; `entity-accounting.ts:130-136` le entrega `pais` crudo (`incorporation_country ?? 'MX'`, `:74`), no el booleano.

**Columnas de la entidad** (`src/database/migrations/001_core_schema.sql`): `incorporation_country CHAR(2) NOT NULL` (`:85`), `functional_currency CHAR(3) DEFAULT 'USD'` (`:86`), `accounting_standard DEFAULT 'us_gaap' CHECK IN ('us_gaap','mx_nif','ifrs')` (`:87-88`), `fiscal_year_start_month INTEGER DEFAULT 1` (`:89`). `fiscal_year_start_month` **no tiene lector**: fuera del tipo (`src/types/index.ts:904`) sólo aparece en INSERTs de fixtures (`tests/integration/helpers/tenant-fixture.ts:70,155` y tres specs); ningún `SELECT` la lee. `functional_currency` tiene lectores (`posting.ts:133-140`, `moneda-origen.ts:193-203`, `treasury-posting.ts:498`, `bank-account-service.ts:283,540`, `pre-registration-service.ts:944-951`) pero ninguno la determina ni la usa para remedir (§1.14).

**El panel no tiene dimensión de jurisdicción, pero sí de entidad.** Las 39 claves de `pending-catalog.ts` (`grep -c "^    key: '"`) carecen de dimensión de país (grep `jurisdic|country|país`: sólo prosa en `:43,77`). Sí pueden acotarse **por entidad**: `src/services/policy/policy-service.ts:137-138` resuelve `entity_id = $3` por encima de `entity_id IS NULL`, y `src/cli/pending-command.ts:293,335` acepta `-e, --entity`. Lo que falta es que la jurisdicción dispare un valor, no la capacidad de acotarlo. Ningún archivo de `src/services/accounting`, `src/services/fx` ni `src/services/accruals` lee `tax_tables` ni `tax_parameters`.

Claves del panel que este subsistema lee:

| Clave (`pending-catalog.ts`) | Default | Lector | Dimensión de jurisdicción |
|---|---|---|---|
| `catalogo_entidad_no_mexicana` (`:50`) | `base_neutro` | `entity-accounting.ts:84` | define «no MX» por negación; no hay «US» |
| `segregacion_de_funciones` (`:913`) | `off` | `posting.ts:355-358` | ninguna; acotable por entidad |
| `linea_banco_sin_partida_al_cierre` (`:969`) | `partida_conciliatoria` | `period-close.ts:375` | ninguna |
| `rep_faltante_recibido` (`:861`) | `avisar` | `period-close.ts:559` | **MX sin compuerta** (§1.5) |
| `rep_faltante_emitido` (`:885`) | `avisar` | `period-close.ts:560` | **MX sin compuerta** (§1.5) |
| `destino_del_resultado_del_ejercicio` (`:625`; default `:639`) | `dos_pasos_hasta_asamblea` | `period-close.ts:1105,1138` | default de práctica MX (LGSM art. 19 como razón, `:642`) aplicado a **toda** entidad (§1.6) |
| `cierre_recierre_de_periodo_reabierto` (`:652`) | `reversar_y_reemitir` | `period-close.ts:1106,1177` | ninguna |
| `severidad_resultado_sin_barrer` (`:680`) | `bloquear_cierre` | `period-close.ts:1107,1131,1306` | ninguna |
| `fuente_tipo_cambio` (`:708`) | `dof` | `rate-service.ts:288`, `moneda-origen.ts:242` | **sólo fuentes MX + manual** (§1.12) |
| `amortizacion_anticipados_convencion` (`:403`) | `proporcional_dias` | `prepaid-service.ts:249`, `amortization-run.ts:167` | ninguna |
| `amortizacion_faltante_al_cierre` (`:428`) | `avisar` | `prepaid-service.ts:657` | ninguna; **fuera del checklist** (§1.5) |
| `umbral_anticipado_mxn` (`:451`) | `5000` | `prepaid-service.ts:250` | **moneda MXN en la clave** (§1.10) |
| `informes_asientos_de_cierre` (`:595`) | `estado_sin_cierre_balanza_con_cierre` | `criterio-cierre.ts:76` (informes, no este subsistema) | ninguna |

Clave que existe y **debería** leerse aquí: `depreciacion_faltante_al_cierre` (`:160`) — el propio panel afirma que gobierna la casilla `depreciation-posted` del cierre (`:163-166`) y no la gobierna (§1.5). Bifurcaciones que el código declara y no tienen clave: orden de cierre (`period-close.ts:145-150`); fecha por omisión de la reversa cuando el original cae en periodo cerrado (§1.3); redondeo y decimales por moneda (§1.11).

---

## 1. Motores

Estados: **7 completos** (1.1, 1.2, 1.3, 1.6, 1.7, 1.8, 1.11) · **6 parciales** (1.4, 1.5, 1.9, 1.10, 1.12, 1.13) · **2 ausentes** (1.14, 1.15) · **0 motores enteros inertes**, pero cinco funciones inertes dentro de motores vivos, listadas al final de la sección.

### 1.1 Partida doble y posteo al mayor — `posting.ts`

**Estado:** completo · ambas jurisdicciones.
**Archivo:** `src/services/accounting/posting.ts:72` (`createJournalEntry`), `:285` (`postJournalEntry`).

**Reglas implementadas**
- Todo movimiento físico a `journal_entries` / `journal_entry_lines` / `account_balances` pasa por este módulo (`posting.ts:18-24`); los productores de documentos (AR/AP, nómina, depreciación, tesorería, conciliación, devengo) llaman a `createJournalEntry` (§5).
- Periodo fiscal deducido de la fecha del asiento, excluyendo `hard_close`/`locked`; sin periodo → `PERIOD_CLOSED` (`:102-116`).
- Verificación del origen en moneda extranjera **antes** del INSERT, leyendo la moneda funcional de la entidad una sola vez (`:132-142`; motor §1.11). NIF B-15.
- Folio atómico por entidad y año (`:147`, `nextEntityNumber`, prefijo `'JE'`). El año del folio es el **año calendario del documento** (`src/utils/sequence.ts:47`, `añoDeDocumento`), no el ejercicio fiscal.
- Nace siempre `draft` (`:152-163`); con `autoPost` valida las siete reglas (`:214`), toma candado `FOR SHARE` sobre el periodo (`:223`; `bloquearPeriodoParaPostear` `:454-472`), marca `posted` (`:226-229`) y mueve `account_balances` con `INSERT … ON CONFLICT DO UPDATE` (`:243-255`).
- `postJournalEntry`: `FOR UPDATE` del asiento (`:306-308`), rechaza `posted` y `void` (`:317-323`), valida (`:331`), lee `segregacion_de_funciones` **sólo para pólizas manuales** (`source_type` nulo; `:354-370`): `'exigir'` bloquea si creador = posteador, `'alertar'` anota en auditoría, otro valor no hace nada.
- Rastro de auditoría en la misma transacción para `create`, `post`, `update`, `void` (`:200-209`, `:233-241`, `:388-397`, `:604-613`, `:721-734`); sin inquilino resuelto no se escribe (`:474-483`, `TENANT_NO_RESUELTO`).
- Atestación en cadena de bloques disparada **después** del commit (`:53-59`, `:279-281`, `:428-430`).
- Inmutabilidad del asiento posteado: la garantiza el esquema (`041_el_mayor_inviolable.sql:42-112`, disparadores `journal_entries_posteado_inmutable` y `journal_entry_lines_posteada_inmutable`), no este módulo.

**Reglas por definir**
- *Ambas:* ninguna regla de partida doble falta; el motor es universal (NIF A-2 «dualidad económica» / marco conceptual FASB CON 8). Lo que falta está en los motores que lo usan (§1.5, §1.6).
- *US:* la segregación de funciones es un control SOX §404 para emisoras. La política existe (`pending-catalog.ts:913`, default `off`) y **sí puede acotarse por entidad** (`policy-service.ts:137-138`; `pending-command.ts:293,335`): una emisora US puede quedar en `exigir` con el resto del inquilino en `off`. Lo que no existe es que la jurisdicción o el tipo de emisora lo dispare. (Corrección al original, que decía que no podía exigirse ni por jurisdicción ni por entidad.)
- *US:* la serie `JE-AAAA-N` se corta por año calendario (`sequence.ts:47`); en un ejercicio no calendario (§1.4) la serie se partiría a mitad de ejercicio.

**Parámetros**

| Parámetro | archivo:línea | Hoy | Debería |
|---|---|---|---|
| Prefijo de folio `'JE'` y formato `JE-AAAA-N` | `posting.ts:147`; asumido en `ledger-checks.ts:287,292` y en las migraciones `043:51`, `048:85` | quemado (cuatro sitios) | casa (serie por ejercicio, que en US puede no ser el año) |
| Año del folio = año calendario del documento | `src/utils/sequence.ts:47` | quemado | casa / ley (ejercicio fiscal de la entidad) |
| Exención de SoD por `source_type` nulo | `posting.ts:354` | quemado (el panel sólo lo cuenta en prosa, `pending-catalog.ts:909-911`) | panel |
| `segregacion_de_funciones` | `pending-catalog.ts:913` → `posting.ts:355-358` | panel | panel con disparador por jurisdicción/tipo de emisora |
| Resumen de auditoría a 2 decimales (el mayor lleva 4) | `posting.ts:491-492` (`toFixed(2)`) | quemado | quemado (es sólo el extracto del rastro) |

**Puerta:** completa — CLI, REST, GraphQL, agente y ocho productores internos (§5).

---

### 1.2 Las siete reglas de validación NIF — `validation.ts`

**Estado:** completo · ambas jurisdicciones (citas y mensajes MX).
**Archivo:** `src/services/accounting/validation.ts:347-355` (`ALL_RULES`), `:357-386` (`validateJournalEntry`).

**Reglas implementadas** (con la norma que el código cita)

| # | Regla | Líneas | Severidad | Norma citada en el código |
|---|---|---|---|---|
| 0 | Mínimo dos líneas | 361-367 | error | — (NIF A-2 en `journal-entry-service.ts:33-35`) |
| 1 | Débitos = créditos, **exacto** (sin tolerancia) | 58-90 | error | NIF A-2 dualidad económica (`:59`, `:82`) |
| 2 | Cada línea exactamente un lado, importe positivo | 92-119 | error | — (CHECK de la 001) |
| 3 | Cargo contra-natural | 121-157 | advertencia | NIF A-5, NIF B-1 (`:149-150`) |
| 4 | Estado del periodo: `hard_close`/`locked` rechaza; `soft_close` y `future` avisan | 159-191 | error/adv. | NIF A-2 devengación (`:184-185`) |
| 5 | Permisos de cuenta: existe en la entidad, activa, no agrupadora, `allow_manual_entries` salvo tipos automatizados | 202-250 | error | — |
| 6 | Moneda extranjera: exige `exchange_rate` y `foreign_*`; conversión con tolerancia 0.01 | 252-294 | error | NIF B-15 (`:263-264`) |
| 7 | Sustancia: `anticipo` acreditado a ingreso; línea manual a capital | 296-345 | advertencia | NIF D-1 (`:316-327`), NIF C-11 (`:331-339`) |

- Frontera de entidad dentro del SQL en las tres reglas que leen cuentas (`:45-56`, `cuentasDeLaEntidad`); una cuenta ajena cae en «not found» (`:221-231`).
- Tipos automatizados exentos de `allow_manual_entries`: `AUTOMATED_ENTRY_TYPES` (`:197-200`).
- La regla 6 tolera 0.01 (`:282`) mientras `verificarOrigenFx` exige igualdad exacta (`conversion.ts:222-226`, cuyo comentario reconoce la doble vara). Matiz del escéptico: `verificarOrigenFx` corre **antes** del INSERT en `posting.ts:132-142` para toda línea con campos FX, así que para una línea nueva manda el criterio exacto; el 0.01 sólo alcanza líneas que no pasan por ahí (borradores viejos releídos).
- Pruebas: `tests/accounting/validation.spec.ts` (26 casos; `describe` en `:54, :79, :135, :183, :224, :264, :305`).

**Reglas por definir**
- *MX (documental):* las citas usan la serie A antigua. Desde el 1 de enero de 2023 el CINIF sustituyó las NIF A-1 a A-8 por una sola **NIF A-1 «Marco Conceptual»**. Sitios: `validation.ts:59,82` (A-2), `:149-150` (A-5, B-1), `:184-185` (A-2); `src/services/accruals/amortization-math.ts:83` (A-2); `src/services/accruals/prepaid-service.ts:323` (A-4); `journal-entry-service.ts:35` (A-2). Agravante: la documentación del agente ya cita bien — `src/ai/docs/nif-marco.md:1,8-13` («desde el 1-ene-2023 toda la Serie A se consolidó en una sola NIF A-1… La cita correcta hoy es "NIF A-1, cap. 20"»). Código y docs se contradicen dentro del mismo repo.
- *MX:* la regla 7 detecta anticipos por la palabra `anticipo` en la descripción (`:322`). **El original decía que no había motor de pasivo por anticipo de cliente; es falso** (§6). El rol `anticipo_clientes` → cuenta `2150 Anticipos de Clientes` se siembra en toda entidad (`src/services/xml-ingestion/account-roles-seed.ts:100,242`; no está en `CODIGOS_FISCALES_MX` `:300-311` ni en `ROLES_FISCALES_MX` `:318-331`). Escritores: cobro con remanente → **CR anticipo_clientes** (`src/services/accounting/ar-ap-posting.ts:544,558-565`); aplicación posterior a factura → **DR anticipo_clientes · CR cxc** (`postReceiptApplicationEntry`, `:619-622,679-690`); desaplicación → **DR cxc · CR anticipo_clientes** (`postReceiptUnapplicationEntry`, `:916-937`). En la taxonomía CFDI: anticipo emitido → CR anticipo_clientes (`src/services/xml-ingestion/cfdi-taxonomy.ts:196`, nota `:199` «A customer advance is a LIABILITY until the revenue is earned»); aplicación TipoRelacion 07 → DR anticipo_clientes (`:288-299`). La regla 7 es una red para pólizas **manuales**; el camino automatizado ya reconoce el pasivo y lo libera. Lo que sigue faltando es el devengo por calendario (§1.10).
- *US:* la regla 7 no tiene contraparte US GAAP nombrada (ASC 606-10-45 «contract liability»; ASC 505 para capital); las advertencias hablan sólo en NIF y en español (`:326-327,336-338`).
- *Ambas:* la tolerancia 0.01 de la regla 6 frente al criterio exacto de `verificarOrigenFx` debería ser un parámetro o desaparecer, no dos criterios en dos archivos.

**Parámetros**

| Parámetro | archivo:línea | Hoy | Debería |
|---|---|---|---|
| `BALANCE_TOLERANCE = 0.01` (sólo regla 6) | `validation.ts:13`; único uso `:282` | quemado | casa (o eliminarse: la puerta viva es exacta) |
| `AUTOMATED_ENTRY_TYPES` | `validation.ts:197-200` | quemado | quemado |
| Expresión `/\banticipo\b/` (español) | `validation.ts:322` | quemado | casa (idioma del despacho) |
| Citas NIF serie A antigua; mensajes en inglés con citas en español | `validation.ts:59,82,149-150,184-185,326-327,336-338` | quemado | ley (cita vigente: NIF A-1 2023) |

**Puerta:** CLI `entry check`, dentro de `entry post`, `batch check`; internas (§5).

---

### 1.3 Reversión y anulación (NIF B-1) — `posting.ts`

**Estado:** completo · ambas jurisdicciones.
**Archivo:** `src/services/accounting/posting.ts:537` (`reverseWithinTransaction`), `:622` (`reverseJournalEntry`), `:674` (`voidJournalEntryInTx`), `:739` (`voidJournalEntry`).

**Reglas implementadas**
- Sólo se reversa un asiento `posted` (`:544-549`, `ENTRY_NOT_POSTED`); una sola reversa por asiento (`:550-555`, `ALREADY_REVERSED`).
- El espejo cruza los lados funcionales **y** los de moneda extranjera, conservando `currency_code` y `exchange_rate` (`:562-578`); nace `reversing` con `autoPost` en la misma transacción (`:580-594`); enlaza en ambas direcciones (`:596-599`).
- El original **no se anula**: sigue `posted` y «anulado» se expresa por `reversed_by_entry_id` (`:601-603`, `:667-672`); un borrador se marca `void` sin tocar el mayor (`:709-713`).
- Fecha de la reversa: la que pida el llamador o `new Date()` (`:649`); `voidJournalEntry` siempre fecha hoy (`:703`). La fecha **es elegible** en las dos puertas de la reversa — `src/cli/entry-command.ts:962` (`--date`) y `src/api/rest/routes/journal-entries.ts:72,254,260` (`reversal_date` en `POST /:id/reverse`) — pero no en `void`.

**Reglas por definir**
- *MX:* NIF B-1 distingue corrección de error del periodo (reversa en periodo abierto) de **error de ejercicios anteriores** (reexpresión retrospectiva). El sistema sólo ofrece reversa o reapertura del periodo (`fiscal-calendar-service.ts:223-281`); no hay motor de reexpresión ni marca de «ajuste a resultados acumulados» (grep `restatement|retrospectiv|reexpres|ASC 250` en `src/services`, `src/cli`: cero; los únicos hits son docs del agente y un comentario de migración sin relación).
- *US:* ASC 250-10-45-23 exige *restatement* (ajuste a saldos iniciales de utilidades retenidas). Mismo hueco.
- *Ambas:* si el original está en periodo cerrado, la reversa aterriza por omisión en el periodo abierto (`:649`); ninguna de las 39 claves decide si eso es correcto o si debe reabrirse el periodo de origen.

**Parámetros**

| Parámetro | archivo:línea | Hoy | Debería |
|---|---|---|---|
| Prefijo `Reversal:` (inglés) | `posting.ts:566` | quemado | quemado (idioma) |
| Tipo `'reversing'` | `posting.ts:583` | quemado | quemado |
| Nota `Voided:` | `posting.ts:707,712` | quemado | quemado |
| Fecha por omisión «hoy» | `posting.ts:649`, `:703` | quemado | casa (periodo abierto vs. reabrir origen) |

**Puerta:** CLI, REST, GraphQL y cuatro consumidores de documentos (§5).

---

### 1.4 Calendario fiscal: ejercicio, periodos, apertura, reapertura — `fiscal-calendar-service.ts`

**Estado:** parcial · ambas jurisdicciones (sólo año calendario).
**Archivo:** `src/services/accounting/fiscal-calendar-service.ts:489` (`ensureFiscalYear`), `:361` (`openPeriod`), `:223` (`reopenClosedPeriod`), `:302` (`restorePeriodStatus`).

**Reglas implementadas**
- Ejercicio = **año calendario** (`start_date = AAAA-01-01`, `end_date = AAAA-12-31`, `is_calendar_year = true`; `:513-515`), **doce periodos mensuales regulares** (`:518-538`; el único INSERT de periodos escribe el literal `'regular'`, `:528-530`); los meses vencidos y el corriente nacen `open`, el resto `future` (`:521-524`). El propio código declara fuera de alcance los calendarios 52-53 semanas, 4-4-5 y el periodo 13 (`:485-487`).
- `future → open` es una compuerta de política, no una barrera (`:194-200`; `createJournalEntry` sólo rechaza `hard_close`/`locked`), auditada (`:396-410`).
- Reapertura: exige motivo (`:229-234`), `locked` no se reabre (`:248-254`), sólo `soft_close`/`hard_close` (`:255-260`), audita el estado previo (`:268-277`).
- Restauración tras reabrir: vuelve a `soft_close`/`hard_close` y **rehace el arrastre** si es `hard_close` (`:330-331`; §1.7), en la misma transacción.
- Resolución de periodo por uuid, `AAAA-MM` o nombre inequívoco; el ambiguo se rechaza (`:111-155`).
- Nombres de periodo acuñados en inglés (`:532-534`, `toLocaleString('en-US')`).

**Reglas por definir**
- *US:* IRC §441 permite ejercicio fiscal distinto del calendario y §441(f) el de 52-53 semanas; `legal_entities.fiscal_year_start_month` existe (`001:89`) y nadie la lee (§0). Un contribuyente US con ejercicio julio-junio no puede llevarse aquí.
- *US:* periodo 13 de ajuste (práctica US GAAP para asientos de auditoría): el esquema lo admite (`fiscal_periods.period_number BETWEEN 1 AND 13`, `period_type IN ('regular','adjustment','closing')`, `001:197-202`) y ningún código lo crea (grep `'adjustment'` en `src/services/accounting`: cero).
- *MX:* CFF art. 11 fija el ejercicio al año calendario (coincide con lo quemado), pero su segundo párrafo permite **ejercicio irregular** para sociedades constituidas a mitad de año y para liquidación; `ensureFiscalYear` siempre crea doce meses enteros.
- *Ambas:* `fiscal_years.status IN ('open','closed')` (`001:187`): ningún código escribe `'closed'` (grep `UPDATE fiscal_years|fiscal_years SET` en `src/`, `scripts/`: cero; únicos escritores los INSERT con `'open'`, `:513-515` y `src/database/seed.ts:48`). El cierre del último periodo no cierra el ejercicio como objeto. **[nuevo]** `year list --status closed` acepta el filtro (`src/cli/period-command.ts:572-577`) y nunca puede casar.

**Parámetros**

| Parámetro | archivo:línea | Hoy | Debería |
|---|---|---|---|
| Ejercicio = año calendario | `fiscal-calendar-service.ts:513-515` | quemado | ley (CFF art. 11 en MX; IRC §441 en US admite otro) — `fiscal_year_start_month` ya existe |
| 12 periodos mensuales | `:518` | quemado | ley / casa (52-53 semanas, 4-4-5, periodo 13) |
| Regla open/future por fecha | `:521-524` | quemado | casa |
| Idioma de los nombres de periodo | `:532-534` | quemado | casa |
| Rango de años 1900-2999 | `:551` | quemado | quemado |

**Puerta:** CLI `period`/`year`, asistente `init`, REST sólo lectura; sin REST/GraphQL de apertura o reapertura; `restorePeriodStatus` sin puerta CLI (§5).

---

### 1.5 Checklist y cierre mensual (soft/hard) — `period-close.ts`, `close-explain.ts`

**Estado:** parcial · MX (casillas REP sin compuerta; resto universal).
**Archivo:** `src/services/accounting/period-close.ts:96` (`getPeriodCloseStatus`), `:599` (`softClosePeriod`), `:677` (`hardClosePeriod`); `close-explain.ts:336` (`explainCloseCheck`).

**Reglas implementadas** — doce casillas con código estable (`CLOSE_CHECK_CODES`, `period-close.ts:24-37`):

| Casilla | Líneas | Severidad | Gobierno |
|---|---|---|---|
| `previous-period-closed` | 151-175 | advertencia **fija** (`:165`) | el comentario `:145-150` declara la bifurcación (cerrar en orden vs. adelantar) **sin política** (grep `orden_de_cierre|periodo_anterior` en `src/services/policy`: cero) |
| `entries-posted` | 178-191 | bloqueante | — |
| `bank-reconciled` (sesión que **cubra** el periodo; cero bancos = «no se pudo comprobar») | 211-241 | advertencia (`:233`) | — |
| `bank-variance-frozen` (sin aritmética bloquea; residual ≠ 0 avisa) | 263-309 | mixta | — |
| `bank-items-overdue` | 323-348 | advertencia (`:337`) | — |
| `bank-lines-unexplained` | 359-392 | por panel | `linea_banco_sin_partida_al_cierre` (`:375`; sólo `'bloquear_cierre'` bloquea, `:70-72`) |
| `invoices-reviewed` | 395-411 | advertencia (`:409`) | — |
| `depreciation-posted` (cero activos = «no se pudo comprobar») | 419-446 | advertencia **fija** (`:438`) | **no lee** `depreciacion_faltante_al_cierre`; esa política sólo la leen `src/services/assets/depreciation-plan.ts:224` y `src/cli/depreciation-command.ts` |
| `trial-balance` (Σ débitos − Σ créditos ≤ 0.01) | 449-463 | bloqueante | — |
| `ledger-integrity` (`runLedgerChecks` bloqueantes) | 482-502 | bloqueante | — |
| `rep-parked` (REP en `needs_review` fechados en el periodo) | 522-539 | advertencia (`:536`) | — |
| `rep-missing` (pagos/cobros del periodo con `cfdi_uuid IS NULL`) | 541-589 | por panel | `rep_faltante_recibido`, `rep_faltante_emitido` (`:558-561`; `'bloquear'` en `:568-576`) |

- Pertenencia periodo↔entidad comprobada antes de contar (`:117-126`; 404 por serie TEN).
- Cierre suave: `FOR UPDATE` del periodo, checklist **dentro** de la transacción, `close_checklist` guardado en la fila, auditoría (`:612-656`).
- Cierre duro: exige `soft_close` (`:702-707`); si el periodo es el último del ejercicio (`period_number = MAX`, `:710-716`) emite asientos de cierre (§1.6); arrastra saldos (`:740`, §1.7); sella `hard_close` (`:743-748`); audita con conteo de asientos de cierre, reversas y avisos (`:754-769`); candado `FOR UPDATE` sobre los asientos del periodo (`:792-797`).
- `closing explain <codigo>` lista los renglones ofensores de cada casilla con el comando que los remedia (`close-explain.ts:45-58`, `:85-322`).
- La casilla de amortización de anticipados (`revisionDeAmortizacionAlCierre`, `prepaid-service.ts:652`) **no está en `CLOSE_CHECK_CODES`**; sólo la invoca `prepaid-command.ts`.

**Reglas por definir**
- *US (defecto observable):* `period-close.ts` no importa `pais-contable` (`:1-10`). La consulta de `rep-missing` (`:541-550`) cuenta `vp.cfdi_uuid IS NULL AND vp.status <> 'void'` y `cp.cfdi_uuid IS NULL AND cp.status <> 'void'` sin filtro de país. En una entidad estadounidense ningún pago tiene `cfdi_uuid`, así que **todos** sus pagos y cobros cuentan como «sin REP». Con el default `'avisar'` (`pending-catalog.ts:871,895`) es ruido; con `'bloquear'` (`:558-561, 568-576`) el cierre de una entidad US no completa nunca.
- *US:* no hay casillas de cierre US GAAP: provisión de impuesto sobre la renta (ASC 740), devengo de nómina/vacaciones (ASC 710), inventario (ASC 330). La lista `:24-37` es cerrada; grep `ASC 740|income tax payable|isr anual` en `src/services`, `src/cli`: cero; grep `accru|devengo|provisi` en `src/services/payroll`: sólo finiquito y mapeo de cuentas.
- *MX:* `previous-period-closed` es «criterio del despacho» sin política (`:145-150`): debe declararse en el panel con su lector.
- *MX:* `depreciation-posted` debería leer `depreciacion_faltante_al_cierre` como `bank-lines-unexplained` lee la suya. **Agravante [nuevo]:** el propio panel promete lo contrario — `pending-catalog.ts:163-166` («Governs the "Depreciation calculated and posted" item on the close checklist») y `src/cli/depreciation-command.ts:83` («gobierna la casilla del cierre»). El panel promete una compuerta que el checklist no tiene.
- *MX:* `amortizacion_faltante_al_cierre` (`pending-catalog.ts:428`) debería tener casilla en el checklist, no sólo en `prepaid`.
- *MX (pregunta abierta) [nuevo]:* `rep-missing` tampoco distingue PUE de PPD dentro de México: `:541-550` no filtra por `metodo_pago`. No se verificó si los pagos PUE reciben `cfdi_uuid` por otro camino; se anota como pregunta, no como defecto.
- *Ambas:* la tolerancia 0.01 de la balanza no es configurable ni por moneda ni por jurisdicción.

**Parámetros**

| Parámetro | archivo:línea | Hoy | Debería |
|---|---|---|---|
| Tolerancia 0.01 de la balanza | `period-close.ts:459,461,463`; `close-explain.ts:252` (`> 0.01`) | quemado | casa (moneda y escala) |
| Severidades fijas de seis casillas | `period-close.ts:165,233,337,409,438,536` | quemado | casa; la de `:438` ya tiene clave (`depreciacion_faltante_al_cierre`, `pending-catalog.ts:160`) sin leer |
| Orden de cierre (`previous-period-closed`) | `period-close.ts:145-150` | quemado | casa (sin clave) |
| Fin de ejercicio = `MAX(period_number)` | `period-close.ts:710-716` | quemado | quemado (correcto mientras no exista periodo 13) |
| `LIMITE_POR_OMISION = 20` renglones en `explain` | `close-explain.ts:65` | quemado | casa |
| Casillas REP sin compuerta de jurisdicción | `period-close.ts:522-589` | quemado (corren siempre) | ley (sólo MX: CFF art. 29-A fr. VII, REP) tras `esContabilidadMexicana` |
| `linea_banco_sin_partida_al_cierre`, `rep_faltante_recibido`, `rep_faltante_emitido` | `pending-catalog.ts:969,861,885` → `period-close.ts:375,559,560` | panel | panel |

**Puerta:** CLI `close`, `closing`; REST; GraphQL; agente sólo lectura (§5).

---

### 1.6 Asientos de cierre anual — `period-close.ts`

**Estado:** completo · ambas jurisdicciones (default MX aplicado a todas).
**Archivo:** `src/services/accounting/period-close.ts:1062` (`generateClosingEntries`), `:956` (`barrerCuentasDeResultados`), `:1318` (`verificarQueElEjercicioBarrio`).

**Reglas implementadas**
- Cuentas puente resueltas **por código**, no por rol: `3900` Resumen de Ingresos y Gastos y `3200` Resultado de Ejercicios Anteriores (ambas `is_system_account`), `3300` Resultado del Ejercicio (`:1086-1092`); el comentario `:1081-1083` explica que la taxonomía de roles no tiene roles de capital.
- Barrido **por signo**, no por `abs()` (`:873-897`, `:926-940`, `:956-975`): corrige la duplicación de cuentas contra-naturales (devoluciones).
- Saldos agregados sobre **todo el ejercicio** (`:1213-1236`), no sólo el último periodo.
- Tres políticas leídas dentro de la transacción (`:1104-1107`):
  - `destino_del_resultado_del_ejercicio` → `codigoDestinoDelResultado` (`:1006-1012`): `directo_a_acumulados` → `3200`; cualquier otro valor (incluido el default `dos_pasos_hasta_asamblea`, `pending-catalog.ts:639`) → `3300`; si pide `3300` y no existe, cae a `3200` avisando (`:1138-1148`). **Con el default, el cierre anual barre a 3300 en toda entidad, la neutra incluida** (`:1145-1146`).
  - `cierre_recierre_de_periodo_reabierto` → `reversar` (espejos NIF B-1, `:1188-1204`), `incremental`, `prohibir` (`:1025-1032`, `:1176-1207`).
  - `severidad_resultado_sin_barrer` → `bloquear` (revierte el cierre entero, `:1344-1352`) o `avisar`; `'tolerancia'` bloquea porque no existe tolerancia de cierre (`:1037-1040`).
- Asientos fechados al **fin del periodo** (`:1256-1257`, `:1286-1287`), tipo `closing`, `autoPost`, mismo cliente que el cierre duro.
- Valor de política desconocido: cae al conservador **y avisa** (`:999-1004`).
- Sin cuentas puente: no emite barrido y deja que el residuo decida (`:1121-1135`).
- Pruebas: `tests/accounting/period-close-accounts.spec.ts`, `tests/integration/period-close.int.spec.ts`.

**Reglas por definir**
- *MX:* el segundo paso (`3300 → 3200` «a separate, audited act» tras la asamblea, `pending-catalog.ts:635,647`) **no tiene motor ni puerta** (grep `asamblea|aplicaci[oó]n del resultado|utilidades acumuladas` en `src/cli`, `src/services` excluidos panel y `period-close.ts`: sólo el aviso de la R7, `validation.ts:332,338`; grep `3300` en `src/services`: `chart-seed.ts:64` y `period-close.ts`). Se haría con `entry create` a mano.
- *MX:* **reserva legal** (LGSM art. 20: al menos 5 % de la utilidad neta anual hasta la quinta parte del capital social): ni cálculo ni cuenta sembrada (grep `reserva legal|reserva_legal|LGSM` en `src/services`, `src/cli`: sólo `pending-catalog.ts:642`). El agente **sabe la regla** (`src/ai/docs/nif-registro.md:90-91`) y no hay motor.
- *MX:* LGSM art. 19 (no repartir utilidades hasta absorber pérdidas) se cita como razón del default (`:642`) y no hay verificación.
- *US:* la práctica US GAAP cierra directamente a *Retained Earnings*; la opción existe (`directo_a_acumulados`) pero el **default es la práctica mexicana** y no hay default por jurisdicción. **Corrección al original**, que decía que `3300` era un renglón que la entidad neutra recibía «sin usarlo» (`chart-seed.ts:64`): con el default se usa en toda entidad; el defecto real es un default mexicano aplicado a una entidad US, y sólo queda inútil si el despacho elige `directo_a_acumulados`.
- *US:* provisión de impuesto sobre la renta al cierre (ASC 740-10) y su cuenta por pagar: ni motor ni cuenta en el estrato neutro (`chart-seed.ts:123-127`; grep `ASC 740|isr_por_pagar|income_tax_payable`: cero). La `2130 ISR por Pagar` del estrato MX (`chart-seed.ts:97`) sólo la escribe la **nómina** (`payroll-account-mapping-seed.ts:123`, `isr_payable: '2130'`), ningún cierre.
- *Ambas:* `fiscal_years.status` no pasa a `closed` (§1.4, §1.15).

**Parámetros**

| Parámetro | archivo:línea | Hoy | Debería |
|---|---|---|---|
| Códigos `3900/3200/3300` y mapa política→código | `period-close.ts:1086-1092`, `:1006-1012` | quemado | casa (por rol, no por código; US sin cuenta intermedia) |
| Nombres y descripciones en inglés | `period-close.ts:1148, 1240-1246, 1259, 1282-1290` | quemado | casa (idioma) |
| `destino_del_resultado_del_ejercicio` (default `dos_pasos_hasta_asamblea`) | `pending-catalog.ts:625,639` → `:1105,1138` | panel | panel con default por jurisdicción (US: `directo_a_acumulados`) |
| `cierre_recierre_de_periodo_reabierto` | `pending-catalog.ts:652` → `:1106,1177` | panel | panel |
| `severidad_resultado_sin_barrer` | `pending-catalog.ts:680` → `:1107,1131,1306` | panel | panel |
| Reserva legal 5 % / tope 20 % | — (no existe) | ausente | ley (LGSM art. 20) con panel para «cuándo se contabiliza» |

**Puerta:** sólo desde `hardClosePeriod` sobre el último periodo (`:720-735`). **No hay comando ni ruta que emita el cierre anual por separado ni que lo previsualice** (§5).

---

### 1.7 Arrastre de saldos entre periodos — `period-close.ts`

**Estado:** completo como aritmética · ambas jurisdicciones. El reintento que falta es defecto de calendario con consecuencia bloqueante (hallazgo **[nuevo]** B, abajo).
**Archivo:** `src/services/accounting/period-close.ts:826` (`carryForwardBalances`).

**Reglas implementadas**
- Siembra `beginning_balance` del periodo siguiente con `ending_balance` del cerrado, **sólo cuentas de balance** (`asset`, `liability`, `equity` y sus contra; `:849-851`); las de resultados guardan actividad y se barren (§1.6).
- Invariante `ending = beginning + debit_total − credit_total` en signo deudor-positivo (`:820-822`, `:862-867`).
- Un final en cero no estrena renglón pero sí corrige el que exista (`:851-861`), para que una reapertura que cancela un saldo llegue al mes siguiente.
- Idempotente; devuelve 0 si el periodo siguiente no existe (`:837`, «next year not created yet — nothing to seed»).
- Llamadores: `period-close.ts:740` (tras los asientos de cierre) y `fiscal-calendar-service.ts:331` (`restorePeriodStatus`). `ensureFiscalYear`/`createFiscalYear` **no lo llaman** (`fiscal-calendar-service.ts:489-570`).
- Verificado por `balanceEncadenamiento` (§1.8) y consumido por el auxiliar (`report-service.ts:1045-1050`: «el inicial lo jura el periodo anterior»).

**Reglas por definir**
- *Ambas:* ninguna regla contable falta. Lo abierto es de calendario, y el escéptico lo agudizó:

**[nuevo] B. Enero no cierra si el año siguiente se creó después de cerrar diciembre.** El eslabón roto no queda mudo. `balanceEncadenamiento` (`ledger-checks.ts:205-260`) usa `JOIN LATERAL … ON true` (`:234-240`): mientras el año siguiente no existe no hay hallazgo; en cuanto `year create` lo crea, `sab.beginning_balance` es NULL → `COALESCE(…, 0)` (`:230`) → **hallazgo bloqueante** por cada cuenta de balance con final distinto de cero en diciembre (`fp.status IN ('hard_close','locked')`, `:244`). La casilla `ledger-integrity` del cierre de **enero** corre `runLedgerChecks(entityId, undefined, { period })` (`period-close.ts:482`), cuyo filtro incluye «el eslabón que debía llegar» (`ledger-checks.ts:218-223`, `fp.id = $i OR sig.id = $i`) → **enero no cierra**. Los únicos caminos que rehacen el arrastre son volver a cerrar duro diciembre tras `period reopen` (`period-close.ts:740`) o `restorePeriodStatus` (`fiscal-calendar-service.ts:331`), que **no tiene puerta CLI** (único llamador: `iva-ppd-reclass.ts:275`).

**Parámetros**

| Parámetro | archivo:línea | Hoy | Debería |
|---|---|---|---|
| Lista de tipos de cuenta de balance | `period-close.ts:849-851` | quemado | quemado (universal y correcta) |

**Puerta:** sin puerta propia; corre dentro de `close --hard` y de la restauración tras `period reopen` (§5).

---

### 1.8 Integridad del mayor — `ledger-checks.ts`

**Estado:** completo · ambas jurisdicciones.
**Archivo:** `src/services/accounting/ledger-checks.ts:315` (`runLedgerChecks`), `:352` (`listStaleDrafts`).

**Reglas implementadas** (registro `LEDGER_CHECK_NAMES`, `:35-37`; sin nombres corren las bloqueantes)
- `balance` (bloqueante), tres contrastes: `account_balances.debit/credit` vs. Σ líneas posteadas (`:78-126`); invariante `ending = beginning + d − c` (`:143-185`); encadenamiento `ending(N) = beginning(N+1)` sólo desde periodos `hard_close`/`locked` y sólo cuentas de balance (`:205-260`).
- `audit-trail` (bloqueante): posteados sin fila `'post'` en `audit_log` (`:262-281`).
- `continuity` (advertencia): huecos en la serie anual de folio `JE-AAAA-N` (`:283-306`; `substring(entry_number from '^JE-\d{4}')` `:287`, `~ '^JE-\d{4}-\d+$'` `:292`).
- Filtros `--account`/`--period` **resueltos por id**, no interpolados (`:46-68`): un filtro que no casa lanza `NotFoundError` en vez de un «limpio» fabricado.
- Borradores viejos: `listStaleDrafts` (default 30 días, `:356` `opts.days ?? 30`).

**Reglas por definir**
- *MX:* CFF art. 28 fr. IV y RCFF art. 33-34 exigen pólizas con folio, fecha y vínculo al CFDI (UUID); `continuity` vigila el folio pero ninguna verificación comprueba póliza ↔ UUID: `journal_entries` sólo tiene `source_type`/`source_id` (`001:232-233,260`), sin `cfdi_uuid`; grep `cfdi_uuid|uuid` en `ledger-checks.ts`: sólo el comentario del resolvedor de periodo (`:58`). Eso vive, si acaso, en la ingesta.
- *US:* Treas. Reg. §1.6001-1 exige libros «suficientes para determinar el impuesto»; sin regla adicional aquí. La retención de registros (7 años en la práctica US; 5 años CFF art. 30 en MX) no la modela ningún motor (grep `CFF art. 30|retenci[oó]n de registros|record retention|cinco años|siete años` en `src/services`, `src/cli`: sólo el quinquenio de vacaciones de `finiquito-math.ts:71`).

**Parámetros**

| Parámetro | archivo:línea | Hoy | Debería |
|---|---|---|---|
| Expresión del folio `^JE-\d{4}-\d+$` | `ledger-checks.ts:287,292` | quemado | casa (junto con §1.1) |
| 30 días de borrador viejo | `ledger-checks.ts:356` | quemado | casa |
| `LIMIT 100` en los cuatro listados | `ledger-checks.ts:117,174,249,272` | quemado | quemado |

**Puerta:** CLI `ledger check`, `ledger stale-draft list`; casilla `ledger-integrity`; verificador de respaldo (§5).

---

### 1.9 Catálogo por país y capa semántica de roles — `chart-seed.ts`, `entity-accounting.ts`, `account-roles-*.ts`, `account-service.ts`

**Estado:** parcial · MX (US sólo mínimo neutro).
**Archivo:** `src/services/accounting/chart-seed.ts:141` (`catalogoBasePara`), `:161` (`ensureBaseChart`); `entity-accounting.ts:45` (`ensureEntityAccounting`); `account-roles-service.ts:83` (`setAccountRole`); `account-service.ts:452` (`MAPPING_SCHEMES`).

**Reglas implementadas**
- Tres estratos: `CATALOGO_UNIVERSAL` (32 cuentas de partida doble en español, `chart-seed.ts:44-82`), `ESTRATO_FISCAL_MX` (6: bancos MXN/USD, IVA acreditable/trasladado, ISR por pagar, retenciones; `:92-99`), `ESTRATO_FISCAL_NEUTRO` (3: banco operativo, impuesto acreditable sobre compras, impuesto sobre ventas por pagar; `:123-127`). **No existe catálogo US**: el comentario `:101-107` lo declara «deliberadamente somero»; grep `BASE_CHART_US|CATALOGO_US`: cero. Matiz: la entidad US **sí** recibe nueve cuentas más de nómina estadounidense (`payroll-account-mapping-seed.ts:159-199`: FICA/FUTA/SUTA/FIT withheld/garnishments/benefits payable, salaries, employer taxes), sembradas desde `entity-accounting.ts:130-136`. Ninguna es impuesto sobre la renta **corporativo**.
- `catalogoBasePara(esMexicana)` (`:141-145`); `ensureBaseChart` idempotente, padre antes que hijo, `esMexicana = true` por omisión (`:161-199`); inserta trece columnas y **ninguna es `mx_nif_code`** (`:179-186`).
- `ensureEntityAccounting`: lee país y norma **antes** de sembrar (`entity-accounting.ts:60-75`); política `catalogo_entidad_no_mexicana` (`:82-84`: `base_neutro` | `ninguno`); siembra siempre roles (`:124`, `seedAccountRoles` con `esMexicana`) y mapeo de nómina (`:130-136`, con `pais`).
- Ramificación de roles (`src/services/xml-ingestion/account-roles-seed.ts`): 10 códigos fiscales MX excluidos (`:300-311`), 12 roles fiscales MX excluidos (`:318-331`), y los dos roles genéricos de impuesto reapuntados al estrato neutro (`:334-337`; `rolesPara` `:355-363`). El rol `anticipo_clientes` → `2150` es universal (`:100,242`; §1.2).
- `account role set`: reapunta un rol o crea variante calificada; exige rol conocido y cuenta activa **de la entidad** (`account-roles-service.ts:83-126`).
- Relleno masivo de entidades sin roles (`account-roles-backfill.ts:39-124`).
- Mapeos estatutarios por cuenta: `sat-agrupador → mx_nif_code`, `us-tax-line → us_gaap_code`, `ifrs → ifrs_code` (`account-service.ts:452-457`); esquemas sin columna se rechazan (`:459-471`); importación masiva **sin validar contra `c_CodAgrup`** (`:513-516`, «no existe en el repo todavía»; `src/cli/account-command.ts:632,640` lo repite); compuerta de cobertura por nivel (`:559-577`).
- Diagnóstico `rolesSinMapear` pregunta por los roles **que a esa entidad le tocan** (`entity-accounting.ts:155-185`).

**Reglas por definir**
- *MX (Anexo 24, CFF art. 28 fr. III, RMF 2.8.1.6):* el catálogo sembrado **nace sin código agrupador**: `ChartAccountSpec` no tiene campo para él (`chart-seed.ts:16-27`) y ninguna semilla escribe `mx_nif_code`. Una entidad mexicana recibe 38 cuentas y cero agrupadores; la tarea «más pesada de un despacho mexicano» (`account-service.ts:445-449`) se deja a `account map import`. Debería venir como parámetro de jurisdicción (tabla `c_CodAgrup` versionada + agrupador por defecto de cada cuenta sembrada).
- *MX:* `c_CodAgrup` no existe en el repositorio (`account-service.ts:515`); `map import` acepta cualquier cadena.
- *MX* **[nuevo] A. Dos columnas para el agrupador SAT.** `accounts.mx_nif_code` (`001:130`), que es la que `account map set/import/check` escribe y lee (`account-service.ts:455`), y `accounts.codigo_agrupador_sat` (`src/database/migrations/037_etiquetado_que_encarece.sql:28-31`, «el checklist de F07 exigirá que ninguna cuenta con movimientos lo tenga vacío»), que **no tiene ni un lector ni un escritor** en `src/`, `scripts/` ni `tests/` (grep: sólo la migración). El «checklist de F07» que la migración promete tampoco existe (grep `F07` en `src/services`, `src/cli`: cero).
- *US:* no hay catálogo US GAAP ni semilla de `us_gaap_code` (líneas de Form 1120/1065, Schedule L). El estrato neutro tiene una sola cuenta de *sales tax payable* (`2135`) sin dimensión estatal; el *income tax payable* corporativo no existe.
- *US:* `ROLES_NEUTROS` reapunta `iva_trasladado`/`iva_acreditable` a impuesto sobre ventas (`account-roles-seed.ts:334-337`); en US el *sales tax* pagado en compras no es acreditable (es costo), así que `1136 «Impuesto Acreditable sobre Compras»` representa un tratamiento que US no tiene. `chart-seed.ts:115-117` dice que el nombre «no promete un tratamiento fiscal que este motor no implementa»; aun así el rol `iva_acreditable` lo exigirá `ar-ap-posting` en cuanto una factura de compra traiga impuesto.
- *Ambas:* `prepaid-service.ts:171-178` documenta que no hay roles de gasto por naturaleza (seguros, rentas, suscripciones): todo devengo cae en `gasto → 6100`.
- *Ambas:* «ante la duda, mexicana» (`pais-contable.ts:19-24,43`) es default de producto, no del panel; `entity-accounting.ts:74` vuelve a poner `'MX'` si la columna viene nula aunque el esquema la declara `NOT NULL` (`001:85`).

**Parámetros**

| Parámetro | archivo:línea | Hoy | Debería |
|---|---|---|---|
| Catálogo base (códigos, nombres, `fs_category`, banderas `system`) | `chart-seed.ts:44-127`; bancos con moneda en el nombre `:93-94`; cuentas de sistema `3100/3200/3900/3300` `:62-65` | quemado | ley (MX: agrupador Anexo 24 por cuenta) + casa (una tabla por jurisdicción) |
| Listas MX/neutro de cuentas y roles | `account-roles-seed.ts:300-311`, `:318-331`, `:334-337` | quemado (dos `Set`) | casa (una tabla por jurisdicción) |
| Roles `4320`/`6320` para utilidad/pérdida cambiaria | `account-roles-seed.ts:280-281` | quemado | quemado |
| Defaults a México | `chart-seed.ts:165`, `account-roles-seed.ts:385`, `entity-accounting.ts:74`, `pais-contable.ts:19-24,43` | quemado | casa (producto, no política) |
| Esquemas de mapeo; nivel 2 de cobertura por omisión | `account-service.ts:452-457`; `:559` | quemado | casa |
| Segundo conmutador de nómina («lo demás es México») | `payroll-account-mapping-seed.ts:264-267,275-283`; `:266` | quemado | debe pasar por `esContabilidadMexicana` |
| `catalogo_entidad_no_mexicana` | `pending-catalog.ts:50` → `entity-accounting.ts:84` | panel | panel con valor «US» explícito |

**Puerta:** CLI `entity create`, `init`, `account role`, `account map`, `account`; REST sólo CRUD de cuentas; agente sólo lectura de roles; `rolesSinMapear` **sin puerta** (§5).

---

### 1.10 Devengo de pagos anticipados — `accruals/`

**Estado:** parcial · ambas jurisdicciones (umbral en MXN).
**Archivo:** `src/services/accruals/amortization-math.ts:239` (`calcularAmortizacion`), `amortization-run.ts:145` (`runMonthlyAmortization`), `prepaid-service.ts:337` (`registrarPagoAnticipado`), `:652` (`revisionDeAmortizacionAlCierre`).

**Reglas implementadas**
- Aritmética pura sin Postgres (`amortization-math.ts:10-22`); dos convenciones `proporcional_dias` (default) y `meses_completos` (`:65`, `:83`, `:155-217`); días contados por componentes locales para no perder un día en cambios de horario (`:110-128`); **tapón en el último renglón** para que Σ renglones = importe exacto (`:221-238`, `:275-282`); 4 decimales (`:54`).
- El módulo **adopta** un saldo ya posteado en la 1160 y nunca lo carga (`prepaid-service.ts:16-32`); exige asiento origen si `origen = 'cfdi'` (`:343-348`).
- Políticas: `amortizacion_anticipados_convencion` (se **congela** en el alta, `:44`, `:448`); `umbral_anticipado_mxn` (materialidad; bajo el umbral detiene salvo `--forzar`, que deja nota; `:353-368`); `amortizacion_faltante_al_cierre` (`:657`, `:708`). Valor fuera de vocabulario **detiene** el alta (`:252-259`).
- Respaldo en el mayor medido y consumido en la misma transacción con `FOR UPDATE` sobre la fila de la cuenta (`:382-425`); lo adoptado se calcula contra el mayor, no contra `remaining_amount` (`:498-523`).
- Corrida mensual: freno de doble corrida por renglón **vigente** (asiento posteado y sin espejo; `RENGLON_VIGENTE` `:109-114`; `amortization-run.ts:233-239`); índice por diferencia de meses de calendario (`:263-268`); tope contra lo que el mayor respalda (`:274-295`); asiento `adjusting` con `source_type = 'prepaid_amortization'` fechado al fin del periodo (`:124-126`, `:322-345`); renglón anulado se retira antes de reponer (`:362-371`); ficha derivada de la suma posteada, estado en ambos sentidos (`:426-449`).
- Hueco heredado: cargos a 1160 que ningún calendario reclama (`prepaid-service.ts:572-616`).
- Pruebas: `tests/services/accruals/amortization-math.spec.ts`, `tests/cli/prepaid-*.spec.ts`.

**Reglas por definir**
- *Ambas:* sólo existe devengo de **activo** (gasto pagado por anticipado). No hay motor de **pasivos devengados** (gastos incurridos no facturados: NIF C-9; ASC 450 / base de acumulación IRC §446) ni de **ingreso diferido por calendario** (devengo mensual de un cobro anticipado por servicio continuado: NIF D-1; ASC 606 *contract liabilities*). **Corrección al original**, que decía «cero tablas ni servicios» de ingresos diferidos: el pasivo por anticipo de cliente y su liberación por aplicación **sí existen** (`2150`; `ar-ap-posting.ts:544-565, 679-690, 916-937`; `cfdi-taxonomy.ts:196,288-299`; §1.2). Lo que no existe es su devengo por tiempo. Las únicas tablas de devengo son `prepaid_expenses` y `prepaid_amortization_schedules` (`059:98,212`).
- *US:* el umbral de materialidad es `umbral_anticipado_mxn` (clave y mensajes en pesos: `pending-catalog.ts:451-472`; `prepaid-service.ts:358,366` `toFixed(2)} MXN`); nada en `src/services/accruals` lee `functional_currency`. Una entidad con moneda funcional USD compara dólares contra «5 000 MXN».
- *Ambas:* la casilla de cierre `revisionDeAmortizacionAlCierre` **no está en el checklist** (§1.5) y su mensaje remite a `accruals run` (`prepaid-service.ts:716`: «Corre `accruals run` antes de cerrar») mientras el comando real es `prepaid` con alias `pago-anticipado` (`src/cli/prepaid-command.ts:513-514`) y hoja `run` (`:953-955`); grep `accruals run|command('accruals` en `src/cli`: cero.
- *Ambas:* cuentas por rol `gasto_anticipado`/`gasto` (`prepaid-service.ts:194`); sin rol de gasto por naturaleza (`:171-178`).

**Parámetros**

| Parámetro | archivo:línea | Hoy | Debería |
|---|---|---|---|
| 4 decimales | `amortization-math.ts:54` | quemado | quemado |
| Default `proporcional_dias` (duplica el default del panel) | `amortization-math.ts:240` (`input.convencion ?? 'proporcional_dias'`); `pending-catalog.ts:403` | quemado + panel | panel (una sola fuente) |
| Tipo `adjusting`; `source_type = 'prepaid_amortization'`; descripciones en inglés | `amortization-run.ts:325`; `:344`; `:326,332,338` | quemado | quemado (idioma: casa) |
| Roles `['gasto_anticipado','gasto']`; mensajes que nombran `1160` | `prepaid-service.ts:194`; `:203,209` | quemado | casa (roles por naturaleza) |
| Mensaje `accruals run` (comando inexistente) | `prepaid-service.ts:716` | quemado (erróneo) | quemado (`prepaid run`) |
| `amortizacion_anticipados_convencion` | `pending-catalog.ts:403` → `prepaid-service.ts:249`, `amortization-run.ts:167` | panel | panel |
| `umbral_anticipado_mxn` = 5000 | `pending-catalog.ts:451` → `prepaid-service.ts:250` | panel (moneda en la clave) | panel en la moneda funcional de la entidad |
| `amortizacion_faltante_al_cierre` | `pending-catalog.ts:428` → `prepaid-service.ts:657` | panel | panel, con lector en el checklist |

**Puerta:** sólo CLI `prepaid create/list/show/run`; sin REST, GraphQL ni agente (§5).

---

### 1.11 Moneda extranjera: origen y verificación de la conversión — `fx/conversion.ts`

**Estado:** completo · ambas jurisdicciones.
**Archivo:** `src/services/fx/conversion.ts:112` (`verificarOrigenFx`), `:79` (`convertirImporte`).

**Reglas implementadas**
- Los cuatro campos FX viajan juntos (`currency_code`, `foreign_debit|credit`, `exchange_rate`; CHECK de la 001) y la conversión **se calcula, no se afirma**: funcional = extranjero × tasa, 4 decimales, `ROUND_HALF_UP` explícito, **sin tolerancia** (`:79-83`, `:222-240`).
- Rechazos con mensaje: campos FX sin moneda (`:122-134`); moneda no ISO 4217 (`:136-141`); moneda igual a la funcional (`:146-153`, «NIF B-15 habla de operaciones en moneda extranjera»); origen incompleto (`:156-168`); lados cruzados o dobles (`:171-190`); más de 4 decimales de importe o 10 de tasa (`:198-215`, para que Postgres no redondee en silencio).
- Precisión 40 clonada para importes grandes (`:41-47`).
- Corre en `createJournalEntry` sólo si alguna línea trae campos FX (`posting.ts:132-142`); la reversa espeja el origen (§1.3).
- Pruebas: `tests/services/fx/conversion.spec.ts`, `tests/integration/r4-moneda-en-el-origen.int.spec.ts`.

**Reglas por definir**
- *Ambas:* el reconocimiento **inicial** al tipo histórico está completo (NIF B-15; ASC 830-20-30-1). Lo que falta es el **posterior** (§1.14).
- *Ambas:* el redondeo half-up a 4 decimales se justifica por el Anexo 20 del SAT (`:21-27`); US GAAP no prescribe redondeo y la práctica es 2 decimales: es un parámetro por moneda/jurisdicción, no una constante.
- *Ambas:* existen **dos funciones de conversión**: `convertirImporte` (`conversion.ts:79-83`, redondeo explícito) y `convertirAFuncional` (`moneda-origen.ts:31-33`, `toFixed(ESCALA)` sin modo). Coinciden hoy porque el redondeo por omisión de decimal.js es `ROUND_HALF_UP` y ambas clonan `precision: 40` (`conversion.ts:47`; `moneda-origen.ts:25`); `conversion.ts:43-45` lo reconoce.

**Parámetros**

| Parámetro | archivo:línea | Hoy | Debería |
|---|---|---|---|
| 4 decimales de importe, 10 de tasa | `conversion.ts:37-39` | quemado | ley (MX: Anexo 20) / casa (US: 2 decimales de práctica) |
| `ROUND_HALF_UP` | `conversion.ts:82` (justificación `:21-27`) | quemado | ley (Anexo 20) / casa |
| Regex ISO 4217 | `conversion.ts:136` | quemado | quemado |
| Segunda conversión sin modo explícito | `moneda-origen.ts:31-33` | quemado (duplicado declarado) | una sola función |

**Puerta:** sin puerta propia; corre dentro de todo posteo con líneas FX. `verificarOrigenFx` aparece además en `src/plan/criterios.ts` (criterio del plan, no puerta).

---

### 1.12 Tipos de cambio y política de fuente — `fx/rate-service.ts`, `moneda-origen.ts`

**Estado:** parcial · MX. La puerta `fx rate download` es **inerte** (no escribe).
**Archivo:** `src/services/fx/rate-service.ts:282` (`tipoParaConversion`), `:217` (`fijarTipo`), `:177` (`verTipo`); `src/services/accounting/moneda-origen.ts:237` (`resolverTipoCambio`).

**Reglas implementadas**
- `exchange_rates` es **global** (sin tenant ni entidad): el DOF de un día es un hecho del mundo (`rate-service.ts:10-18`); la escritura se acota por permisos, no por filas.
- Fuentes del CHECK de la 057: `manual, dof, banco_mexico, ecb, fed, xe, openexchangerates` (`057:29-30`; `rate-service.ts:41-44`); unicidad `(par, fecha, tipo, fuente)` (`057:54`): DOF y FIX del mismo día conviven.
- Política `fuente_tipo_cambio` con **tres lectores idénticos a propósito** (`rate-service.ts:20-33`): `tipoParaConversion` (pool), `resolverTipoCambio` (transaccional, el que usa el pago), y el marcador de `fx rate list`. **Los dos resolutores de producción no cruzan nunca:** buscan el par directo o inverso de la **misma fuente y fecha** con `rate_type = 'spot'` y, si no está, fallan (`FX_RATE_MISSING` / `FX_SIN_TIPO_DE_LA_FUENTE`; `rate-service.ts:300-329`; `moneda-origen.ts:266-299`). Nunca otra fuente ni arrastre de fecha.
- Mapa política→fuente **duplicado** en dos archivos: `FUENTE_DE_LA_POLITICA` (`rate-service.ts:57-61`) y `FUENTE_POR_POLITICA` (`moneda-origen.ts:207-211`): `dof → dof`, `fix_banxico → banco_mexico`, `manual → manual`.
- `verTipo` → `fx rate show` es el **único** consumidor de `get_exchange_rate()` del esquema (`rate-service.ts:183`; directo → inverso → cruce vía USD con arrastre `effective_date <= fecha`, `001:396-440`, cruce en `:433-439`) y **dice en voz alta** de qué fecha arrastró (`rate-service.ts:162-168`, `:199-201`). **Corrección al original**, que atribuía el cruce por USD al camino de producción (§6).
- `fijarTipo`: tasa positiva, ≤ 10 decimales (`:229`), conflicto de unicidad remite a `fx rate correct` «fase 3» (`:217-262`).
- Fecha del pago formateada por componentes locales, jamás `toISOString` (`moneda-origen.ts:257-264`).
- `fx rate download` **no descarga**: nombra `fed`/`ecb` entre sus fuentes (`src/cli/fx-command.ts:150-151`) pero falla cerrado para toda fuente (`:511-517`: «no hay cliente declarado para esa fuente… fx rate set… o fx rate import (fase 2)»). Puerta inerte.
- `TIPOS_DE_TASA` (`rate-service.ts:47`: `spot|average|historical`) sólo aparece como filtro de `fx rate list` (`:145`) y default de `verTipo`/`fijarTipo` (`:180,235`); `average`/`historical` no tienen consumidor.

**Reglas por definir**
- *MX:* la regla fiscal está (CFF art. 20: tipo del DOF; default `dof`, `pending-catalog.ts:708-732`). Falta el matiz de **qué día del DOF** aplica (el publicado el día hábil anterior) y el uso del FIX para efectos financieros vs. DOF para efectos fiscales en la misma operación — `rep_moneda_extranjera` lo reconoce (`pending-catalog.ts:733-759`: «two different rates the system does not yet tell apart»).
- *US:* IRC §988 y Treas. Reg. §1.988-1 no imponen fuente única; el IRS exige un tipo «consistently used» (Fed H.10, Treasury Reporting Rates o bancario). **La política sólo ofrece DOF, FIX y manual**: un despacho US no puede declarar `fed` aunque el CHECK lo admita (`057:30`) y el downloader lo nombre (`fx-command.ts:150-151`). Tampoco hay lector de `average` para conversión de resultados (ASC 830-30-45-3).
- *Ambas:* para un pago en EUR de una entidad MXN el problema **no** es la ruta de cruce sino que **no hay cruce**: hace falta el par EUR/MXN (o MXN/EUR) de la fuente de la política, fijado a mano con `fx rate set`.
- *Ambas:* `tipoParaConversion` **no tiene consumidor de producción** (grep en `src/`, `scripts/`: sólo su definición `rate-service.ts:282` y comentarios; consumidor único `tests/integration/r4-moneda-en-el-origen.int.spec.ts:7,168,178`; `rate-service.ts:22-23` lo admite). El gemelo transaccional es el vivo. Deuda declarada (`rate-service.ts:26-28`).

**Parámetros**

| Parámetro | archivo:línea | Hoy | Debería |
|---|---|---|---|
| Mapa política→fuente (sin `fed`/`ecb`) | `rate-service.ts:57-61`; `moneda-origen.ts:207-211` | quemado, duplicado | ley (MX: CFF art. 20 → DOF) / casa (US: fuente consistente) en una sola tabla |
| `rate_type = 'spot'` fijo | `rate-service.ts:303,314`; `moneda-origen.ts:270,284` | quemado | casa / ley (ASC 830-30-45-3 admite promedio para resultados) |
| Moneda de cruce `USD` en `get_exchange_rate()` | `001:433-439` | quemado | casa — sólo afecta a `fx rate show` |
| 10 decimales de tasa | `rate-service.ts:229` | quemado | quemado |
| `fuente_tipo_cambio` (default `dof`) | `pending-catalog.ts:708` → `rate-service.ts:288`, `moneda-origen.ts:242` | panel | panel con vocabulario ampliado (`fed`, `ecb`) y default por jurisdicción |

**Puerta:** CLI `fx rate list/show/set`; `fx rate download` inerte; interna `payment-service.ts:365-371`; sin REST, GraphQL ni agente; `tipoParaConversion` sin puerta (§5).

---

### 1.13 Diferencia cambiaria realizada — `moneda-origen.ts`, `ar-ap-posting.ts`

**Estado:** parcial (sólo pagos a proveedores) · ambas jurisdicciones.
**Archivo:** `src/services/accounting/moneda-origen.ts:125` (`desgloseCambiarioDelPago`), `:54` (`diferenciaCambiariaRealizada`); `ar-ap-posting.ts:987` (`postVendorPaymentEntry` con `fx`).

**Reglas implementadas**
- Cada pasivo se extingue al tipo **histórico del documento** (`bills.exchange_rate`), el efectivo sale al tipo **del pago**, y la brecha —resta exacta de importes ya redondeados a 4 decimales— es la diferencia realizada (`moneda-origen.ts:117-123`, `:135-176`); `creditos > debitos` = pérdida, al revés utilidad (`:171-176`).
- Descuento por pronto pago y anticipo de proveedor tratados a su tasa (`:149-159`, `:162-166`).
- Aterriza en los roles `perdida_cambiaria` (6320) / `utilidad_cambiaria` (4320), pedidos sólo si la diferencia existe (`ar-ap-posting.ts:1010-1022`, `:1076-1083`; `account-roles-seed.ts:280-281`); las líneas conservan `currency_code`, `foreign_*`, `exchange_rate` por documento (`ar-ap-posting.ts:1030-1060`).
- `payment-service.ts:392-398` escribe siempre `exchange_rate` en el pago y anota fuente y diferencia en metadatos (`:453-455`, `:479`); `resolverTipoCambio` se invoca una sola vez, en el camino del pago a proveedor (`payment-service.ts:365`).
- Pruebas: `tests/services/accounting/moneda-origen.spec.ts`.

**Reglas por definir**
- *Ambas:* sólo **pagos a proveedores**. `postCustomerPaymentEntry(client, payment, userId)` no recibe `fx` (`ar-ap-posting.ts:521-525`); `payment-service.ts:613` lo llama sin él. `rep_moneda_extranjera` default `no_casar` lo declara (`pending-catalog.ts:733-759`, «the REP matcher still does not»).
- *MX:* LISR art. 8 (la ganancia o pérdida cambiaria devengada recibe el tratamiento de interés) exige distinguir la fluctuación **devengada** (no realizada) de la realizada para el ajuste anual por inflación; sin §1.14 no hay dato.
- *US:* ASC 830-20-35-1 exige reconocer en resultados del periodo también las **no realizadas** al cierre. Mismo hueco (§1.14).

**Parámetros**

| Parámetro | archivo:línea | Hoy | Debería |
|---|---|---|---|
| Escala 4; `toFixed` sin modo explícito | `moneda-origen.ts:28`; `:32` | quemado | ley / casa (§1.11) |
| Comentario con `6320`/`4320`; nombres de rol | `moneda-origen.ts:171-172`; `ar-ap-posting.ts:1017-1020` | quemado | quemado |
| `rep_moneda_extranjera` (default `no_casar`) | `pending-catalog.ts:733-759` | panel | panel con lector en cobros |

**Puerta:** CLI `payment create/apply`; REST `bills.ts`; GraphQL resolvers; `diferenciaCambiariaRealizada` **sin puerta** (fuera de su definición sólo `tests/services/accounting/moneda-origen.spec.ts:4,41-77`) (§5).

---

### 1.14 Diferencia cambiaria NO realizada / remedición al cierre — ausente

**Estado:** ausente · ninguna jurisdicción.
**Dónde se declara pendiente:** `moneda-origen.ts:12-13` («La fase NO realizada —revaluar saldos vivos al cierre— es fase 2 y no vive aquí»); `ar-ap-posting.ts:984-985`; `batch-service.ts:82,356` («revaluaciones … llegarán con su productor»). Grep `revalu|unrealized|remeasur|ASC 830|remedic|no realizada` en `src/`: sólo esos comentarios y docs del agente.

**Qué exige**
- *MX:* NIF B-15, reconocimiento posterior: partidas monetarias en moneda extranjera al tipo de cierre, fluctuación a resultados del periodo. LISR art. 8 trata la fluctuación devengada como interés.
- *US:* ASC 830-20-35-1/35-2 (remedición de partidas monetarias); ASC 830-30 (conversión de estados financieros con *cumulative translation adjustment* en OCI); ASC 830-10-45-2 a 45-6 (determinación de la moneda funcional). `legal_entities.functional_currency` (`001:86`) tiene lectores (§0) y ningún motor que la determine ni la use para remedir.

**Lo que ya hay para construirlo:** origen conservado en cada línea (§1.11), tabla de tipos con `rate_type` `average|historical` sin consumidor (`rate-service.ts:47`), roles 4320/6320, tipo de asiento `adjusting`, y la casilla de cierre como sitio natural.

**Parámetros:** ninguno (no hay motor). **Puerta:** ninguna.

---

### 1.15 Bloqueo por presentación (`locked`) y cierre de ejercicio (`fiscal_years.status`) — ausente

**Estado:** ausente · ninguna jurisdicción. Estados del esquema sin escritor.
**Dónde está el estado:** `fiscal_periods.status … 'locked'` (`001:204`); `fiscal_years.status IN ('open','closed')` (`001:187`).

**Lectores de `locked`:** `posting.ts:466`, `journal-entry-service.ts:421,626`, `fiscal-calendar-service.ts:248`, `ledger-checks.ts:244`, `report-service.ts:1078`, `match-service.ts:641`, `treasury-posting.ts:658`, `period-command.ts:443`, `iva-ppd-reclass.ts:170`, `close-explain.ts:99`, `period-close.ts:155`, `draft-service.ts:277`, `src/plan/criterios.ts:839`. **Escritores:** cero (grep `status = 'locked'|status: 'locked'` con asignación en `src/`, `scripts/`: ninguno). `fiscal_years.status`: sólo INSERT `'open'` (`fiscal-calendar-service.ts:513-515`; `seed.ts:48`). `fiscal-calendar-service.ts:215-217` describe el candado («la información ya salió del sistema: dictamen, declaración anual») y nada lo pone.

**Qué exige**
- *MX:* la declaración anual (LISR art. 76 fr. V) y el dictamen fiscal (CFF art. 32-A) son los hechos que deberían disparar el candado.
- *US:* presentación de Form 1120/1065 y, para emisoras, cierre de libros del 10-K; misma necesidad.

**Parámetros:** ninguno. **Puerta:** ninguna.

---

### Funciones inertes dentro de motores vivos

| Función | Definición | Por qué es inerte |
|---|---|---|
| `rolesSinMapear` | `entity-accounting.ts:155` | ningún llamador en `src/`, `scripts/`, `tests/`; el comentario `:151-153` dice que `doctor` lo reporta y `src/ai/doctor-service.ts` no lo importa |
| `tipoParaConversion` | `rate-service.ts:282` | sin consumidor de producción; sólo `tests/integration/r4-moneda-en-el-origen.int.spec.ts:7,168,178` |
| `diferenciaCambiariaRealizada` | `moneda-origen.ts:54` | sólo `tests/services/accounting/moneda-origen.spec.ts:4,41-77`; el vivo es `desgloseCambiarioDelPago` |
| `fx rate download` | `fx-command.ts:511-517` | puerta que no escribe: falla cerrado para toda fuente |
| `restorePeriodStatus` | `fiscal-calendar-service.ts:302` | sin puerta CLI; único llamador `iva-ppd-reclass.ts:275` — y es el único camino, junto con recerrar diciembre, para rehacer un arrastre perdido (hallazgo B) |

### Módulos del directorio que son puerta o pertenecen a otro subsistema (no inventariados como motor)

- `journal-entry-service.ts` — lecturas, borradores y su forma (`MANUAL_ENTRY_TYPES = standard|adjusting|correction`, `:59`; `validateDraftShape` `:283-299`; `previewEntryPosting` `:588`; `updateDraftEntry` `:675`). Reutiliza las siete reglas; no postea.
- `batch-service.ts`, `entry-import-service.ts` — lote importado (`staged → checked → posted`, `:23-26`); layouts `csv|ndjson` (`entry-import-service.ts:25`), propietarios rechazados (`:26`). Reutiliza las siete reglas (`batch-service.ts:37-40`).
- `ar-ap-posting.ts`, `iva-cash-basis.ts`, `iva-ppd-reclass.ts` — posteo de documentos e IVA en flujo de efectivo (LIVA art. 5, PUE/PPD, REP). Aquí sólo se citan las líneas que consumen §1.12-1.13 y las del pasivo por anticipo (§1.2).
- `account-service.ts` — CRUD de cuentas; sólo se inventarió su bloque de mapeos estatutarios (§1.9).

---

## 2. Parámetros quemados consolidados

Todo lo de la tabla está hoy en código. La columna «debería» usa el vocabulario de parámetro.

| Parámetro | archivo:línea | Debería | Por qué es de jurisdicción |
|---|---|---|---|
| Año calendario y 12 periodos | `fiscal-calendar-service.ts:513-515,518` | ley | CFF art. 11 (MX) lo fija; IRC §441 (US) permite otro; `fiscal_year_start_month` (`001:89`) ya existe y nadie la lee |
| Año del folio = año calendario del documento | `src/utils/sequence.ts:47` | casa | en ejercicio no calendario la serie `JE-AAAA-N` se parte |
| Formato de folio `JE-AAAA-N` | `posting.ts:147`; `ledger-checks.ts:287,292`; `043:51`; `048:85` | casa | serie por ejercicio fiscal, que en US puede no ser el año |
| Códigos de cierre `3900/3200/3300` | `period-close.ts:1086-1092,1006-1012` | casa | US cierra a *Retained Earnings* sin cuenta intermedia |
| Default del destino del resultado (`dos_pasos_hasta_asamblea`) | `pending-catalog.ts:639` | panel con default por jurisdicción | práctica LGSM aplicada a toda entidad; en US debería ser `directo_a_acumulados` |
| Reserva legal 5 % / 20 % | — (no existe) | ley | LGSM art. 20 |
| Tolerancia 0.01 de balanza y de FX | `period-close.ts:459,461,463`; `close-explain.ts:252`; `validation.ts:13` | casa | depende de moneda y escala; la de FX está muerta para líneas nuevas |
| 4 decimales half-up (Anexo 20) | `conversion.ts:37-39,82`; `moneda-origen.ts:28,32` | ley / casa | US: 2 decimales, sin norma de redondeo |
| Mapa política→fuente de tipo (sin `fed`/`ecb`) | `rate-service.ts:57-61`; `moneda-origen.ts:207-211` | ley (MX) / casa (US) | IRC §988: cualquier fuente consistente |
| `rate_type = 'spot'` fijo | `rate-service.ts:303,314`; `moneda-origen.ts:270,284` | casa / ley | ASC 830-30-45-3 admite promedio para resultados |
| Moneda de cruce `USD` | `001_core_schema.sql:433-439` | casa | sólo alcanza a `fx rate show`; producción no cruza |
| Umbral de materialidad en MXN | `pending-catalog.ts:451`; `prepaid-service.ts:250,358,366` | panel en moneda funcional | una entidad USD compara dólares contra pesos |
| Casillas REP en el checklist | `period-close.ts:522-589` | ley (sólo MX) | deben pasar por `esContabilidadMexicana` |
| Severidades fijas de casillas | `period-close.ts:165,233,337,409,438,536` | casa | criterio del despacho; la de `:438` tiene clave (`pending-catalog.ts:160`) que el panel dice leer (`:163-166`) y no lee |
| Orden de cierre | `period-close.ts:145-150` | casa | bifurcación declarada sin clave |
| Fecha por omisión de la reversa | `posting.ts:649,703` | casa | periodo abierto vs. reabrir origen |
| Catálogo base sin agrupador SAT | `chart-seed.ts:16-27,44-127` | ley | Anexo 24 exige `c_CodAgrup` por cuenta; dos columnas para lo mismo (`001:130`; `037:28-31`) |
| Listas MX/neutro de cuentas y roles | `account-roles-seed.ts:300-337` | casa | una tabla por jurisdicción, no dos `Set` |
| Default «ante la duda, mexicana» | `pais-contable.ts:42-43`; `chart-seed.ts:165`; `entity-accounting.ts:74`; `account-roles-seed.ts:385`; `payroll-account-mapping-seed.ts:266` | casa | producto, no política; cuatro conmutadores con bordes distintos (§0) |
| Regex `anticipo` e idioma de citas | `validation.ts:322,82,149,326,337` | casa | motor monolingüe |
| Citas NIF serie A antigua | `validation.ts:59,82,149-150,184-185`; `amortization-math.ts:83`; `prepaid-service.ts:323`; `journal-entry-service.ts:35` | ley | NIF A-1 vigente desde 2023; `src/ai/docs/nif-marco.md:1,8-13` ya cita bien |
| 30 días de borrador viejo | `ledger-checks.ts:356` | casa | criterio del despacho |
| Exención de SoD por `source_type` nulo | `posting.ts:354` | panel | el panel lo cuenta en prosa (`pending-catalog.ts:909-911`) |
| Mensaje `accruals run` | `prepaid-service.ts:716` | quemado (corregir a `prepaid run`) | error de texto, no de jurisdicción |

---

## 3. Lo que Estados Unidos exige y no existe

1. **Remedición de partidas monetarias al cierre** (ASC 830-20-35-1/35-2): declarada «fase 2» en `moneda-origen.ts:12-13` y `ar-ap-posting.ts:984-985`; grep sin implementación (§1.14).
2. **Conversión de estados financieros y CTA en OCI** (ASC 830-30) y **determinación de moneda funcional** (ASC 830-10-45): `functional_currency` (`001:86`) con lectores y sin motor.
3. **Ejercicio fiscal no calendario y 52-53 semanas** (IRC §441, §441(f)): `fiscal_year_start_month` sin lector; `ensureFiscalYear` fija enero-diciembre (`fiscal-calendar-service.ts:513-515`); la serie de folio se partiría (`sequence.ts:47`).
4. **Periodo 13 de ajuste**: esquema lo admite (`001:197-202`), ningún código lo crea (`fiscal-calendar-service.ts:528-530` escribe `'regular'`).
5. **Fuente de tipo de cambio estadounidense** (Fed H.10 / Treasury; IRC §988 consistencia): `fed`/`ecb` en el CHECK (`057:30`) y nombrados en el downloader (`fx-command.ts:150-151`), pero sin mapeo de política (`rate-service.ts:57-61`; `moneda-origen.ts:207-211`) y con descarga que falla cerrado (`fx-command.ts:511-517`).
6. **Default de cierre a *Retained Earnings* por jurisdicción**: la opción existe (`directo_a_acumulados`), el default es LGSM (`pending-catalog.ts:639`) y **se aplica a toda entidad** (`period-close.ts:1006-1012,1145-1146`).
7. **Provisión de impuesto sobre la renta al cierre** (ASC 740-10) y su cuenta: ni motor ni cuenta en `ESTRATO_FISCAL_NEUTRO` (`chart-seed.ts:123-127`); grep `ASC 740` en `src/services`, `src/cli`: cero. Puede corresponder al subsistema fiscal, pero el cierre anual no lo exige ni lo avisa.
8. **Pasivos devengados e ingreso diferido por calendario** (ASC 450, ASC 710, ASC 606-10-45; base de acumulación IRC §446): sólo existe devengo de activo (`accruals/`) y el pasivo por anticipo de cliente con liberación por aplicación (§1.2); ninguna tabla ni servicio de devengo por tiempo (`059:98,212` son las únicas tablas).
9. **Umbral de materialidad en la moneda funcional** (SAB 99 / ASC 340): `umbral_anticipado_mxn` (`pending-catalog.ts:451`).
10. **Checklist de cierre consciente de jurisdicción**: `rep-parked`/`rep-missing` corren sobre entidades US contando todo pago sin CFDI (`period-close.ts:541-550`); ninguna casilla US GAAP (lista cerrada `:24-37`).
11. **Catálogo US GAAP y semilla de `us_gaap_code`** (líneas Form 1120/1065, Schedule L): columna sin escritor automático (`account-service.ts:456`); estrato neutro con *sales tax* único y un «impuesto acreditable sobre compras» que US no tiene (`chart-seed.ts:125`; `account-roles-seed.ts:334-337`). Las nueve cuentas de nómina US (`payroll-account-mapping-seed.ts:159-199`) no incluyen impuesto corporativo.
12. **Corrección de errores de periodos anteriores por *restatement*** (ASC 250-10-45-23): sólo reversa en periodo abierto o reapertura (`fiscal-calendar-service.ts:223-281`).
13. **Candado por presentación** (`locked` tras Form 1120 / 10-K): estado sin escritor (§1.15).
14. **Disparo de la segregación de funciones por tipo de emisora** (SOX §404): la clave existe y se acota por entidad (`policy-service.ts:137-138`); nada la enciende por jurisdicción ni por condición de emisora.

## 4. Lo que México exige y no existe

1. **NIF B-15 fase no realizada** (valuación de partidas monetarias al tipo de cierre) y **LISR art. 8** (fluctuación devengada como interés): declarada «fase 2» (`moneda-origen.ts:12-13`); sin dato para el ajuste anual por inflación.
2. **NIF B-10 efectos de la inflación** (detector de entorno inflacionario: inflación acumulada trienal ≥ 26 %, y reexpresión): grep `B-10|inflaci|reexpres` en `src/services`, `src/cli`: cero (sólo `src/ai/docs/niif-interpretaciones.md:73-74`).
3. **Reserva legal** (LGSM art. 20: 5 % anual de la utilidad neta hasta 20 % del capital social) y verificación LGSM art. 19: sólo citada como razón de un default (`pending-catalog.ts:642`); el agente conoce la regla (`src/ai/docs/nif-registro.md:90-91`); ningún cálculo ni cuenta.
4. **Segundo paso de la aplicación del resultado** (`3300 → 3200` tras la asamblea, «a separate, audited act» `pending-catalog.ts:635,647`): sin motor ni comando; grep `3300` en `src/services`: sólo `chart-seed.ts:64` y `period-close.ts`.
5. **Código agrupador SAT en el catálogo sembrado y validación contra `c_CodAgrup`** (CFF art. 28 fr. III, RCFF art. 33, RMF 2.8.1.6 / Anexo 24): `ChartAccountSpec` sin campo (`chart-seed.ts:16-27`); `ensureBaseChart` no escribe `mx_nif_code` (`:179-186`); `importAccountMappings` no valida (`account-service.ts:513-516`). **[nuevo]** Dos columnas para lo mismo: `accounts.mx_nif_code` (`001:130`, la viva) y `accounts.codigo_agrupador_sat` (`037:28-31`, sin lector ni escritor); el «checklist de F07» que la 037 promete no existe. La generación del XML no vive en este subsistema; aquí sólo la compuerta de cobertura (`account-service.ts:559-577`).
6. **Provisiones NIF C-9** (pasivos devengados) e **ingreso diferido por calendario NIF D-1**: el pasivo por anticipo de cliente y su liberación por aplicación **existen** (`2150`; `ar-ap-posting.ts:544-565,679-690,916-937`; `cfdi-taxonomy.ts:196,288-299`); lo que falta es el devengo por tiempo y los pasivos por gastos sin factura. La regla 7 (`validation.ts:319-329`) es sólo red para pólizas manuales.
7. **NIF B-1 reexpresión retrospectiva** de errores de ejercicios anteriores: sólo reversa o reapertura (§1.3, §1.4).
8. **Ejercicio irregular** (CFF art. 11 segundo párrafo: constitución a mitad de año, liquidación): `ensureFiscalYear` siempre doce meses enteros (`fiscal-calendar-service.ts:518-538`).
9. **Candado por presentación** (`locked` tras declaración anual LISR art. 76 fr. V o dictamen CFF art. 32-A) y **cierre del ejercicio como objeto** (`fiscal_years.status = 'closed'`): estados sin escritor (§1.15); `year list --status closed` nunca casa (`period-command.ts:572-577`).
10. **Casillas de devengo en el checklist**: `amortizacion_faltante_al_cierre` (`prepaid-service.ts:652`) fuera de `CLOSE_CHECK_CODES`; `depreciacion_faltante_al_cierre` no leída por `depreciation-posted` (`period-close.ts:438`) aunque el panel (`pending-catalog.ts:163-166`) y `depreciation-command.ts:83` digan que la gobierna.
11. **Actualización de citas normativas**: NIF A-2/A-4/A-5 → NIF A-1 Marco Conceptual (2023) en `validation.ts:59,82,149-150,184-185`, `amortization-math.ts:83`, `prepaid-service.ts:323`, `journal-entry-service.ts:35` (documental, no aritmético; `src/ai/docs/nif-marco.md:8-13` ya lo dice bien).
12. **Vínculo póliza ↔ UUID del CFDI** (CFF art. 28 fr. IV, RCFF art. 33-34) como verificación del mayor: `journal_entries` sin `cfdi_uuid` (`001:232-233,260`); `ledger-checks.ts` no lo comprueba. Puede vivir en la ingesta; aquí no está.
13. **Conmutador de jurisdicción único**: cuatro criterios con bordes distintos para «es mexicana» (`pais-contable.ts:42-43`; `iva-ppd-reclass.ts:101`; `iva-cash-basis.ts:304-310`; `doctor-service.ts:190`) más el de nómina (`payroll-account-mapping-seed.ts:266`); un país nulo es mexicano para el catálogo y no para `doctor` ni para el IVA en flujo de efectivo.

---

## 5. Puertas

| Motor | CLI | REST | GraphQL | Agente | Sin puerta / inerte |
|---|---|---|---|---|---|
| 1.1 Posteo | `entry create` (`entry-command.ts:533-535`), `entry post` (`:887-890`), `entry preview` (`:713-716`) | `POST /v1/journal-entries` (`journal-entries.ts:174-175`), `POST /:id/post` (`:211-212`) | `createJournalEntry`, `postJournalEntry` (`schema.ts:466-467`) | `draft-service.ts:583` (aprobación de borradores de IA) | — |
| 1.2 Siete reglas | `entry check` (`entry-command.ts:635-637`); dentro de `entry post`; `batch check` (`batch-service.ts:37-40`) | dentro de `POST /:id/post` | dentro de `postJournalEntry` | — | — |
| 1.3 Reversa/anulación | `entry reverse` (`entry-command.ts:957-960`; `--date` `:962`), `entry void` (`:1047-1050`), `batch reverse` (`batch-service.ts:531-535`) | `POST /:id/void` (`journal-entries.ts:229-230`), `POST /:id/reverse` (`:249-250`; `reversal_date` `:72,254,260`) | `voidJournalEntry`, `reverseJournalEntry` (`schema.ts:468-469`) | — | `void` siempre fecha hoy (`posting.ts:703`) |
| 1.4 Calendario | `period list/show/open/reopen` (`period-command.ts:223-399`; `reopen` exige `--force --reason` `:460-466`), `year list/show/create` (`:562-639`), `init` (`cli/init/s1-identity.ts`) | `GET /v1/fiscal-periods` (`fiscal-periods.ts:20`) sólo lectura | — | — | sin REST/GraphQL de apertura o reapertura; `restorePeriodStatus` sin CLI (único llamador `iva-ppd-reclass.ts:275`) |
| 1.5 Checklist y cierre | `close [--period] [--check] [--hard] [--reason]` (`close-command.ts:146-158`, `:264-266`; `--hard` pide teclear el nombre `:104-107`); `closing preview/check/explain` (`closing-command.ts:238-395`) | `GET /:id/close-status`, `POST /:id/soft-close`, `POST /:id/hard-close` (`fiscal-periods.ts:38-62`) | `softClosePeriod`, `hardClosePeriod` (`schema.ts:479-480`) | `ai/close-service.ts:2` (sólo lectura del checklist más bloqueos propios de IA) | — |
| 1.6 Cierre anual | sólo dentro de `close --hard` del último periodo (`period-close.ts:720-735`) | ídem vía `hard-close` | ídem | — | **sin comando ni ruta propia, sin previsualización**; segundo paso `3300→3200` sin motor |
| 1.7 Arrastre | dentro de `close --hard` (`period-close.ts:740`) y de la restauración tras `period reopen` (`fiscal-calendar-service.ts:331`) | ídem | ídem | — | sin reintento cuando el año siguiente nace después (hallazgo B) |
| 1.8 Integridad | `ledger check [--check a,b] [--account] [--period]` (`ledger-command.ts:134-136`; sale 4 con hallazgos), `ledger stale-draft list` (`:170-176`) | — | — | — | casilla `ledger-integrity` (`period-close.ts:482`); verificador de respaldo (`backup/ledger-en-base.ts`) |
| 1.9 Catálogo y roles | `entity create` (`entity-command.ts:177-180`), `init`, `account role list/set/seed` (`account-command.ts:537-597`), `account map set/list/import/check` (`:619-738`), `account create/edit/archive/set/restore` (`:316-777`); script `scripts/rellenar-roles-de-cuenta.ts` | `accounts.ts:64-138` (CRUD de cuentas) | — | `policy-tools.ts:319` `get_accounting_policies` (lee `listAccountRoles`) | sin REST/GraphQL para roles ni mapeos; `rolesSinMapear` sin llamador |
| 1.10 Devengo anticipados | `prepaid create/list/show/run` (`prepaid-command.ts:623-956`; alias `pago-anticipado` `:513-514`; `run` `:953-955`) | — | — | — | sin REST, GraphQL ni agente; casilla de cierre fuera del checklist |
| 1.11 Origen FX | dentro de todo posteo con líneas FX (`posting.ts:132-142`) | ídem | ídem | ídem | — |
| 1.12 Tipos de cambio | `fx rate list/show/set` (`fx-command.ts:221-470`); interna `payment-service.ts:365-371` | — | — | — | `fx rate download` inerte (`fx-command.ts:511-517`); `tipoParaConversion` sin consumidor |
| 1.13 Diferencia realizada | `payment create/apply` (`payment-command.ts:192-272` → `payment-service`) | `bills.ts` | `resolvers/index.ts` | — | `diferenciaCambiariaRealizada` sin puerta; cobros sin `fx` (`ar-ap-posting.ts:521-525`) |
| 1.14 Remedición | — | — | — | — | motor ausente |
| 1.15 `locked` / ejercicio cerrado | `period-command.ts:443` y `period-command.ts:572-577` **leen** el estado | — | — | — | ningún escritor |

Productores internos que entran por 1.1 (`createJournalEntry`): `ar-ap-posting.ts`, `gl-posting-service.ts:160` (nómina), `depreciation.ts:363`, `treasury-posting.ts:921,1198,1506`, `reconciliation-service.ts:2844`, `pre-registration-service.ts:1158`, `batch-service.ts`, `amortization-run.ts:322`. Consumidores de 1.3: `invoice-service.ts:641` y `payment-service.ts:1305` (`voidJournalEntryInTx`), `ap-controls.ts` (`reverseWithinTransaction`), recierre anual (`period-close.ts:1195`).

---

## 6. Lo que el escéptico refutó o corrigió

Para que el lector sepa qué **no** creerse del inventario original.

**Refutado (la afirmación era falsa)**
1. *«No hay motor de pasivo por anticipo de cliente»* (§1.2 y §1.10 del original). Falso: el rol `anticipo_clientes` → `2150` se siembra en toda entidad (`account-roles-seed.ts:100,242`) y tiene tres escritores en `ar-ap-posting.ts` (`:544,558-565` cobro con remanente; `:619-622,679-690` aplicación; `:916-937` desaplicación) más la taxonomía CFDI (`cfdi-taxonomy.ts:196,288-299`). El original buscó `deferred_revenue|NIF D-1|ASC 606` y no el nombre de rol. Sigue faltando el devengo por calendario.
2. *«`payroll-account-mapping-seed.ts:273` compara contra `'USA'`»* como defecto (§1.9 del original). Falso: `normalizarPais` acepta `US` y `USA` (`:264-267`) y la comparación es sobre el país normalizado (`:275-283`); el comentario `:245-256` describe el defecto antiguo ya corregido. Sigue siendo un segundo conmutador «lo demás es México» (`:266`).
3. *«`get_exchange_rate()` cruza siempre vía USD; la ruta debería ser parametrizable»* (§1.12 del original). Falso como problema de producción: el cruce (`001:433-439`) sólo lo ejecuta `verTipo` → `fx rate show` (`rate-service.ts:183`); los dos resolutores que usan los pagos (`moneda-origen.ts:266-299`; `rate-service.ts:300-329`) no cruzan nunca y fallan si falta el par directo o inverso. El problema real es que no hay cruce, no la ruta.

**Corregido de fondo (la afirmación era inexacta)**
4. *«La segregación de funciones no se puede exigir ni por jurisdicción ni por tipo de entidad»* (§1.1). Por entidad sí: `policy-service.ts:137-138` y `pending-command.ts:293,335`. Falta sólo el disparo por jurisdicción.
5. *«`3300` es un renglón que la entidad neutra recibe sin usarlo»* (§1.6). Con el default `dos_pasos_hasta_asamblea` el cierre barre a `3300` en toda entidad (`period-close.ts:1006-1012,1145-1146`); el defecto es un default mexicano aplicado a una entidad US.
6. *«Si el año siguiente no existe, el arrastre no ocurre y nada lo reintenta»* (§1.7). Cierto, pero incompleto: la consecuencia es que **enero no cierra** (`ledger-checks.ts:230,234-247`; `period-close.ts:482`) y el único remedio sin recerrar diciembre (`restorePeriodStatus`) no tiene puerta.
7. *«Ingresos diferidos: cero tablas ni servicios»* (§1.10). El pasivo por anticipo existe (punto 1); lo ausente es el devengo por tiempo y los pasivos devengados.

**Líneas corregidas** (el original citaba una línea vecina): `posting.ts:492` → `:491-492`; `period-close.ts:711-717` → `:710-716`; `prepaid-service.ts:712-714` → `:716`; `prepaid-command.ts:954-956` → `:953-955`; `fx-command.ts:468-470,514` → `:511-517` (y `:150-151` para `fed`/`ecb`); `ar-ap-posting.ts:1019-1020` → `:1017-1020`; `moneda-origen.ts:172` → `:171-172`; `rate_type = 'spot'` también en `rate-service.ts:314` y `moneda-origen.ts:284`; lectores de `locked` ampliados con `journal-entry-service.ts:421`, `close-explain.ts:99`, `period-close.ts:155`, `draft-service.ts:277`, `src/plan/criterios.ts:839`.

**Hallazgos nuevos incorporados** (ninguno estaba en el original): **A** dos columnas para el agrupador SAT, una sin lector ni escritor (§1.9, §4.5); **B** enero no cierra tras crear el año siguiente después de cerrar diciembre (§1.7); **C** el panel promete que `depreciacion_faltante_al_cierre` gobierna la casilla y no la gobierna (§1.5); **D** tercer conmutador de jurisdicción a mano en `doctor-service.ts:190`, con borde distinto para país nulo (§0); **E** `rep-missing` no distingue PUE de PPD dentro de México — pregunta abierta, no defecto (§1.5). Detalles menores también nuevos: año del folio calendario (`sequence.ts:47`); regex del folio repetida en migraciones `043:51`, `048:85`; `year list --status closed` nunca casa (`period-command.ts:572-577`); código y docs del agente se contradicen en las citas NIF (`src/ai/docs/nif-marco.md:1,8-13`); la entidad US recibe nueve cuentas de nómina (`payroll-account-mapping-seed.ts:159-199`).
