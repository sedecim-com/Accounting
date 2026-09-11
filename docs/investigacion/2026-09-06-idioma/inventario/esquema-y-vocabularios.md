# Esquema de base de datos y vocabularios como datos

Superficie: `src/database/migrations/*.sql`, `src/database/enums.ts`, `src/types/index.ts`,
`src/database/rls-policies.sql`, `src/services/policy/pending-catalog.ts` y sus lectores.

Medido sobre `/Users/victor/projects/Accounting` en el commit `b31e62a` (rama que el árbol
tenía al correr los comandos: `j0-1-la-jurisdiccion-deja-de-ser-un-booleano`; el snapshot
inicial de la sesión decía `instrumentos-que-mienten-segun-la-maquina` — el árbol es
compartido y otra sesión cambió de rama entre medias; las cifras son del árbol que había
al ejecutar cada comando, todas el mismo día). Fecha: 2026-09-06. No se editó ningún
archivo del repositorio.

Los tres scripts de conteo (`columnas.py`, `columnas2.py`, `checks.py`) están copiados en
este mismo directorio para poder reproducir cada cifra.

---

## 1. Método y comandos

Todas las rutas relativas a la raíz del repo. `grep` en esta máquina es `ugrep` con
interfaz compatible; `--include` debe ir entrecomillado en zsh.

| # | Qué cuenta | Comando |
|---|---|---|
| C1 | Archivos de migración | `ls src/database/migrations/*.sql \| wc -l` → **74** |
| C2 | Tablas distintas creadas (incluye `public.*`) | `grep -hoiE 'CREATE TABLE (IF NOT EXISTS )?[a-z_.0-9]+' src/database/migrations/*.sql \| sed -E 's/CREATE TABLE (IF NOT EXISTS )?//I' \| sort -u \| wc -l` → **115** |
| C3 | Tablas con nombre en castellano | mismo listado que C2 filtrado con `grep -E "^(inpc\|sat_codigos\|sat_bancos\|sat_anexo\|mx_isn)"` → **5** |
| C4 | Pares (tabla, columna) únicos, con `ADD COLUMN` incluido | `python3 columnas.py` (parsea cuerpos de `CREATE TABLE` y `ALTER TABLE … ADD COLUMN`; deduplica por (tabla, columna)) → **1868** |
| C5 | Columnas con palabra castellana (lista curada de 90 tokens; excluye acrónimos SAT/CFDI/RFC/IMSS/…) | `python3 columnas2.py` → **117** en **25 tablas**, 102 nombres distintos |
| C6 | Columnas con sólo acrónimo fiscal mexicano y resto inglés (`cfdi_uuid`, `is_taxable_isr`…) | `python3 columnas2.py` → **61** |
| C7 | Vistas (materializadas) | `grep -hoiE 'CREATE (OR REPLACE )?(MATERIALIZED )?VIEW (IF NOT EXISTS )?[a-z_.]+' src/database/migrations/*.sql \| sort -u` → **2** (`mv_trial_balance`, `mv_account_balance_summary`) |
| C8 | Funciones | `grep -hoiE 'CREATE (OR REPLACE )?FUNCTION [a-z_.]+' src/database/migrations/*.sql \| sort -u \| wc -l` → **14**, de las que 6 tienen nombre castellano |
| C9 | Índices/constraints/triggers/policies con nombre | extracción con `grep -hoiE "CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?[a-z_0-9]+\|CONSTRAINT [a-z_0-9]+\|CREATE TRIGGER [a-z_0-9]+\|CREATE POLICY [a-z_0-9]+"` sobre migraciones + `rls-policies.sql`, último token, `sort -u` → **321** nombres; con palabra castellana (lista de 60 tokens, script inline en §4.7) → **59** |
| C10 | `CHECK (col IN (...))` en migraciones (incluye `ADD CONSTRAINT`) | `python3 checks.py` → **134** listas, **604** literales |
| C11 | CHECK con valores castellanos (curado a mano, excluye `manual`, `error`, `global`, `ok`) | tabla en §4.3 → **14 CHECK, 43 valores**; 14 son nombres de catálogo del SAT, 29 «de la casa» |
| C12 | Vocabularios censados en `enums.ts` | `grep -c "^  v('" src/database/enums.ts` → **22** |
| C13 | Claves del panel de políticas | `grep -cE "^\s*key: '" src/services/policy/pending-catalog.ts` → **53** |
| C14 | Valores de opción del panel | `grep -oE "value: '[^']*'" src/services/policy/pending-catalog.ts \| wc -l` → **133** (32 numéricos, 8 inglés/neutros, **93 castellanos, 70 distintos**) |
| C15 | Valores por omisión (persistidos en `policy_decisions.default_value`) | `grep -c "defaultValue:" pending-catalog.ts` → **53** (54 con la línea de la interfaz) |
| C16 | Lectores de `resolved_value` | `grep -rn "resolved_value" src --include='*.ts' \| grep -v pending-catalog \| wc -l` → **18** líneas en 4 archivos |
| C17 | Literales de valores del panel (sólo los inequívocos, con `_`) fuera del catálogo | `grep -rnoE "'(base_neutro\|vida_util_nif\|…44 valores…)'" src --include='*.ts' \| grep -v pending-catalog` → **123** ocurrencias en **34** archivos; tests **247** en **47**; docs **83** en **15** |
| C18 | Idem incluyendo palabras sueltas (`avisar`, `bloquear`, `exigir`, `rol`, `lista`…; cota superior, con falsos positivos) | → **326** en src, **511** en tests |
| C19 | Nombres de migración citados fuera de `migrations/` | `grep -rhoE "[0-9]{3}_[a-z_0-9]+\.sql" <área> \| sort -u \| wc -l` → src **25**, tests **22**, docs **80**; en `criterios.ts` **17** |
| C20 | Nombres citados en docs que NO existen en el árbol | `comm -23 <docs> <ls migrations>` → **21** |

---

## 2. Conteos por tabla (columnas con palabra castellana / columnas de la tabla)

Salida de `python3 columnas2.py` (§ «Tablas y proporción castellana»):

| Tabla | ES/total | Origen del vocabulario |
|---|---|---|
| `xml_documents` | 25/48 | atributos del CFDI (Emisor, Receptor, FormaPago, MetodoPago, UsoCFDI, Moneda, TipoCambio…) |
| `xml_document_lines` | 11/16 | atributos de `Concepto` del CFDI (ClaveProdServ, ClaveUnidad, ValorUnitario, Importe, Descuento, ObjetoImp…) |
| `mx_isn_tasas_estatales` | 9/9 | catálogo de la casa (ISN por estado) |
| `reconciling_items` | 8/15 | **de la casa** |
| `inpc_serie` | 7/8 | catálogo (INPC, DOF/INEGI) |
| `sat_anexo24_artefactos` | 7/17 | mezcla: `tipo`/`tipo_envio`/`anio`/`mes` (Anexo 24) y `sellado`/`politica_sellado`/`generado_por` (de la casa) |
| `sat_codigos_agrupadores` | 7/7 | Anexo 24 c_CodAgrup (codigo, nombre, nivel, naturaleza, codigo_padre, vigente_desde/hasta) |
| `employees` | 6/55 | c_TipoContrato/c_TipoJornada/c_TipoRegimen (nómina CFDI) + `puesto`, `departamento`, `riesgo_puesto` |
| `vendors` | 5/34 | DIOT (tipo_tercero, tipo_operacion, id_fiscal_extranjero, nacionalidad, pais_residencia) |
| `customer_payments` | 4/26 | `cuenta_destino`, `banco_destino_sat`, `banco_destino_extranjero` (póliza Anexo 24), `cfdi_pago_indice` |
| `vendor_payments` | 4/25 | idem |
| `reconciliation_match_groups` | 4/13 | **de la casa** (`origen`, `total_banco`, `total_libros`, `total_ajustes`) |
| `sat_bancos` | 4/4 | catálogo c_Banco del SAT (clave, nombre_corto, razon_social, vigente) |
| `bill_lines` | 2/17 | c_TipoFactor (`tipo_factor`) + `valor_actos` (DIOT) |
| `idempotency_keys` | 2/8 | **de la casa** (`clave`, `resultado`) |
| `paychecks` | 2/48 | `subsidio_empleo`, `subsidio_entregado_efectivo` (LISR) |
| `reconciliation_adjustments` | 2/10 | **de la casa** (`tipo`, `importe`) |
| `accounts` | 1/29 | `codigo_agrupador_sat` |
| `ai_ingest_runs` | 1/25 | **de la casa** (`sospecha_count`) |
| `ai_shadow_verdicts` | 1/8 | **de la casa** (`motivo`) |
| `cfdi_classifications` | 1/16 | `tipo_comprobante` (CFDI) |
| `customers` | 1/30 | `uso_cfdi` |
| `legal_entities` | 1/20 | `imss_registro_patronal` |
| `paycheck_deductions` | 1/10 | `cfdi_clave_sat` |
| `paycheck_earnings` | 1/15 | `cfdi_clave_sat` |

Las otras 90 tablas (115 − 25) tienen el 100 % de sus columnas en inglés (o con acrónimo
fiscal y resto inglés). En `src/types/index.ts` (959 líneas) el único campo castellano es
`codigo_agrupador_sat` (`src/types/index.ts:266`); sus 25 enums son todos ingleses.

---

## 3. Ejemplos con archivo:línea y clase

Clase = una de: `identificador` (nombre de tabla/columna/objeto), `dato_vocabulario`
(valor persistido y comparado como literal), `nombre_de_archivo`, `comentario`,
`texto_de_usuario_renderizado`.

### 3.1 Tablas (identificador)

- `src/database/migrations/063_el_agrupador_con_una_sola_verdad.sql:75` — `sat_codigos_agrupadores`
- `src/database/migrations/064_la_poliza_y_su_rastro_de_pago.sql:67` — `sat_bancos`
- `src/database/migrations/065_el_indice_que_actualiza.sql:26` — `inpc_serie`
- `src/database/migrations/067_lo_que_el_patron_paga_y_nadie_apunta.sql:39` — `mx_isn_tasas_estatales`
- `src/database/migrations/062_el_xml_que_se_entrega.sql:33` — `sat_anexo24_artefactos`

### 3.2 Columnas (identificador)

De la casa (renombrables sin perder correspondencia con una norma):
- `054_la_sesion_que_cuadra.sql:67` `reconciling_items.tipo`; `:91` `importe`; `:92` `fecha`; `:95` `responsable`; `:96` `fecha_esperada`; `:97` `escalamiento`; `:99` `notas`; `:101` `resuelta_at`
- `054_la_sesion_que_cuadra.sql:135` `reconciliation_adjustments.tipo`; `:138` `importe`
- `052_el_cotejo.sql:41-43,52` `reconciliation_match_groups.total_banco/total_libros/total_ajustes/origen`
- `039_idempotencia_persistida.sql:36,38` `idempotency_keys.clave/resultado`
- `047_el_veredicto_de_la_sombra.sql:24` `ai_shadow_verdicts.motivo`
- `044_el_agente_medible.sql:43` `ai_ingest_runs.sospecha_count`
- `062_el_xml_que_se_entrega.sql:33-70` `sat_anexo24_artefactos.sellado/politica_sellado/generado_por`
- `065_el_indice_que_actualiza.sql:33-37` `inpc_serie.fuente/publicado_el/capturado_el/capturado_por`
- `067_…:54-56` `mx_isn_tasas_estatales.fundamento/capturado_el/capturado_por`

Derivadas de un catálogo o XSD del SAT/IMSS/DIOT (candidatas a «vocabulario estable»):
- `037_etiquetado_que_encarece.sql:28` `accounts.codigo_agrupador_sat` (c_CodAgrup, Anexo 24)
- `005_xml_ingestion.sql:30-38` `xml_documents.emisor_rfc/emisor_nombre/emisor_regimen_fiscal/receptor_rfc/receptor_nombre/receptor_uso_cfdi/receptor_regimen_fiscal/receptor_domicilio_fiscal`
- `005_xml_ingestion.sql:44-45,57-59` `xml_documents.moneda/tipo_cambio/forma_pago/metodo_pago/condiciones_pago`
- `005_xml_ingestion.sql:74-76` `xml_documents.sat_estado/sat_efecto_cancelacion/sat_fecha_cancelacion`
- `005_xml_ingestion.sql:113-127` `xml_document_lines.clave_prod_serv/clave_unidad/unidad/no_identificacion/descripcion/cantidad/valor_unitario/importe/descuento/impuestos/objeto_imp`
- `008_payroll.sql:45-47` `employees.tipo_regimen_sat/tipo_contrato_sat/tipo_jornada_sat`
- `066_el_tercero_que_la_diot_declara.sql:46-53,83,98` `vendors.tipo_tercero/tipo_operacion/id_fiscal_extranjero/pais_residencia/nacionalidad`, `bill_lines.tipo_factor/valor_actos`
- `064_la_poliza_y_su_rastro_de_pago.sql:34-42` `vendor_payments`/`customer_payments`.`cuenta_destino/banco_destino_sat/banco_destino_extranjero`
- `063_…:76-88` `sat_codigos_agrupadores.codigo/nombre/nivel/codigo_padre/naturaleza/vigente_desde/vigente_hasta`
- `064_…:68-71` `sat_bancos.clave/nombre_corto/razon_social/vigente`
- `032_schema_contract.sql:28` `legal_entities.imss_registro_patronal`
- `008_payroll.sql:219` `paychecks.subsidio_empleo`; `067_…:147` `paychecks.subsidio_entregado_efectivo`

### 3.3 Valores de CHECK (dato_vocabulario)

| archivo:línea | columna | valores castellanos | origen |
|---|---|---|---|
| `054_la_sesion_que_cuadra.sql:67` | `reconciling_items.tipo` | `cheque-en-circulacion`, `deposito-en-transito`, `cargo-del-banco`, `abono-del-banco`, `error-del-banco`, `error-de-libros` | casa |
| `054_la_sesion_que_cuadra.sql:98` | `reconciling_items.escalamiento` | `ninguno`, `avisado`, `vencido` | casa |
| `054_la_sesion_que_cuadra.sql:135` | `reconciliation_adjustments.tipo` | `comision`, `iva-comision`, `interes`, `isr-retenido` (+ `error`) | casa |
| `049_cobrar.sql:45` | `credit_notes.type` | `devolucion`, `descuento`, `correccion`, `anticipo` | casa (columna en inglés, valores en castellano) |
| `059_la_promesa_que_se_devenga.sql:137` | `prepaid_expenses.amortization_convention` | `proporcional_dias`, `meses_completos` | casa (es a la vez valor del panel) |
| `059_la_promesa_que_se_devenga.sql:148` | `prepaid_expenses.origin` | `saldo_preexistente` (+ `cfdi`, `manual`) | casa |
| `067_…:51` | `mx_isn_tasas_estatales.regimen` | `tasa_plana`, `escalonado`, `con_exencion` | casa |
| `052_el_cotejo.sql:53` | `reconciliation_match_groups.origen` | `motor` (+ `manual`) | casa |
| `044_el_agente_medible.sql:62` | `ai_agent_events.kind` | `sospecha` (+ `nudge`, `failover`) | casa |
| `015_account_roles.sql:45` | `cfdi_classifications.direction` | `emitido`, `recibido`, `ajeno` | casa |
| `008_payroll.sql:123` | `pay_schedules.frequency` | `quincenal` (junto a `weekly`, `biweekly`, `semimonthly`, `monthly`) | mixto en la misma lista |
| `005_xml_ingestion.sql:14` | `xml_documents.document_type` | `cfdi_ingreso/egreso/traslado/nomina/pago/retencion` | SAT (TipoDeComprobante I/E/T/N/P) |
| `062_el_xml_que_se_entrega.sql:39` | `sat_anexo24_artefactos.tipo` | `catalogo`, `balanza`, `poliza`, `auxiliar_folios`, `auxiliar_cuentas` | SAT (los cinco XML del Anexo 24) |
| `066_…:84` | `bill_lines.tipo_factor` | `tasa`, `cuota`, `exento` | SAT (c_TipoFactor) |

Además hay CHECK con códigos del SAT que no son palabras: `066_…:47,49` (`'04','05','15'` /
`'03','06','85'` DIOT), `062_…:55` (`'N','C'`), `063_…:86` (`'D','A'`); y nombres propios en
listas inglesas: `banco_mexico` (`001_core_schema.sql:383`, `057_…:30`), `dof`, `inegi`
(`065_…:34`).

### 3.4 `enums.ts` y `types/index.ts`

- `src/database/enums.ts:98` `CREDIT_NOTE_TYPES = ['devolucion', 'descuento', 'correccion', 'anticipo']` — único vocabulario castellano de los 22 censados (`enums.ts:181-203`).
- `src/database/enums.ts:37-44` (comentario): «el esquema lo nombra en inglés como todo lo demás, y la superficie en español se resuelve con la capa de alias» — la **carta fundacional del esquema ya es «inglés en la base, alias en la superficie»**; las excepciones de §3.2/§3.3 son posteriores a la 034 (cuando los títulos de migración pasan al castellano), salvo `005`, `008`, `015`.
- `src/services/banking/reconciliation-math.ts:53-60` `TIPOS_DE_PARTIDA` y `:78-85` `LADO_DE` — copia del CHECK de `reconciling_items.tipo` que **no está en `VOCABULARIOS`** ni tiene terna `'reconciling_items', 'tipo'` (`grep -rn "'reconciling_items', *'tipo'" src` → vacío), así que ni `enum-contract.int.spec.ts` ni el criterio de `criterios.ts:1615` la vigilan.
- `src/types/index.ts:266` `codigo_agrupador_sat: string | null` — el único campo castellano.

### 3.5 Panel de políticas (dato_vocabulario + texto_de_usuario_renderizado)

- `src/services/policy/pending-catalog.ts:50-1432` — 53 `key:` **todas castellanas** (`base_depreciacion`, `destino_del_resultado_del_ejercicio`, `segregacion_de_funciones`…).
- Valores (93 castellanos, 70 distintos): `:887` `dos_pasos_hasta_asamblea`, `:890` `directo_a_acumulados`, `:142`/`:410` `proporcional_dias`, `:114` `vida_util_nif`, `:115` `tasa_lisr`, `:679` `nunca_sellar_en_el_sistema`, `:859` `estado_sin_cierre_balanza_con_cierre`, `:1355` `cuenta_por_cobrar_fisco`, `:1386` `centro_de_trabajo`… Los 8 no castellanos: `off`, `on`, `shadow` (`:1068-1070`), `manual`, `dof`, `fix_banxico` (`:969-971`), `split_85` (`:215`).
- **Los textos de usuario del panel están en inglés**: 131 `label:` inline (92 con artículos ingleses, 0 con artículos castellanos), 48 `question:` (45 inglesas, 0 castellanas). Ejemplo `pending-catalog.ts:61-70`: `value: 'base_neutro'`, `label: 'The house chart without the Mexican tax layer …'`. Es decir, **el panel está hoy invertido respecto al pedido del dueño**: identificador persistido en castellano, texto renderizado en inglés.
- Persistencia (tres sitios): `016_policy_decisions.sql:16` `key`, `:21` `options JSONB` (copia del catálogo en cada fila: `policy-service.ts:51-61` `JSON.stringify(spec.options)`), `:24` `default_value`, `:29` `resolved_value`. Únicos: `uq_policy_tenant_scope`, `uq_policy_entity_scope` sobre `key`.
- Lectura: `policy-service.ts:145-147` devuelve `resolved_value` tal cual; `:235` `spec?.options.some((o) => o.value === value) ?? true` — un valor fuera de lista se acepta con nota, no se rechaza.
- Comparación literal en lectores: `period-close.ts:91` (`=== 'bloquear_cierre'`), `:105`, `:648-667` (`=== 'bloquear'`), `:1136-1138` (`directo_a_acumulados`/`dos_pasos_hasta_asamblea`), `:1155-1157` (`reversar_y_reemitir`/`prohibir`/`incremental`), `:1174-1175`; `avisarValorDesconocido` en `period-close.ts:1128`. (Las líneas 1007-1011 que citaba el encargo ya no son ésas: el archivo tiene 1491 líneas y el barrido está en 1136-1175.)
- Lectores por archivo (C18, cota superior): `period-close.ts` 46, `reporting/cash-flow-service.ts` 28, `reporting/cash-flow-reconcile.ts` 21, `xml-ingestion/cfdi-decisions.ts` 16, `plan/criterios.ts` 16, `xml-ingestion/rep-linkage.ts` 11, `sat/anexo24/catalogo-cuentas.ts` 11, `cli/payroll-isn-command.ts` 11, `banking/reconciliation-service.ts` 9, `accounting/posting.ts` 8, … (45 archivos).
- El agente lee `resolved_value` (`src/ai/tools/policy-tools.ts`, `src/ai/memory-service.ts`) y por tanto ve y cita los literales castellanos.

### 3.6 Nombres de migración (nombre_de_archivo)

- `001_core_schema.sql` … `033_audit_log_append_only.sql`: 38 archivos con título inglés (con los 4 duplicados 012/014/015/018).
- `034_atestaciones_simuladas.sql` … `069_el_predicado_que_se_paga_por_fila.sql`: 36 con título castellano.
- `src/database/migrate.ts:66-68` la tabla `public.migrations` guarda **sólo `filename`** (sin checksum del contenido); `:82` y `:105` consultan/insertan por nombre. Renombrar = re-ejecutar la migración en toda base desplegada. Las cabeceras (prosa castellana) sí podrían cambiar sin efecto en la base — pero `criterios.ts` lee el texto crudo de 17 migraciones y ancla cuerpos SQL concretos (`:1507-1511` nombres de constraint, `:4086-4094` cuerpos de CHECK, `:4218-4224`, `:4490-4497`).

### 3.7 Funciones, índices, constraints, triggers (identificador)

- Funciones castellanas (6/14): `isn_sin_solape`, `ledger_linea_posteada_inmutable`, `ledger_posteado_inmutable`, `ledger_sin_truncate`, `public.audit_log_solo_agrega`, `public.fiscal_credential_access_log_solo_agrega`.
- 59/321 nombres de índice/constraint/trigger castellanos, p. ej. `idx_reconciling_items_tipo`, `idx_xml_docs_fecha`, `sesion_balanceada_con_aritmetica`, `journal_entries_posteado_inmutable`, `uq_exchange_rates_par_fecha_fuente`, `trg_isn_sin_solape`, `paycheck_taxes_un_renglon_por_impuesto`. Comando de conteo:

```
python3 - <<'EOF'
ES=set("cierre posteada posteado asiento cuentas distintas anticipo devengado rango ventana coherente truncate nacional extranjero cobro depreciacion una por corrida amortizacion periodo entidad cuenta gasto abiertas ultimo reales sesion vivos tipo vigencia cheque cobrado emisor fecha receptor clave exencion solo si aplica sello inmutable sin pago renglon impuesto aprobada firma balanceada aritmetica contabilizada rastro tercero identificado solape contenido par fuente verificacion publica agrupadores artefactos".split())
names=[l.strip() for l in open('nombres_objetos.txt') if l.strip() and l.strip() not in ('IF','del','global','violation')]
print(len(names), len([n for n in names if any(t in ES for t in n.split('_'))]))
EOF
```

---

## 4. Qué se rompe al cambiar: coste real por clase

### 4.1 Renombrar una TABLA (5 candidatas)

1. Migración nueva `ALTER TABLE x RENAME TO y` (append-only: permitido). RLS **no** necesita lista: `rls-policies.sql:23-33` descubre tablas por columnas `tenant_id`/`entity_id` en `pg_class` y se reaplica tras cada migración (`migrate.ts:127`); las únicas listas por nombre son `excluded` (`:21`) y `append_only` (`:91`), ninguna castellana. Las policies viajan con el OID.
2. Lectores TS (`grep -rl <tabla> src --include='*.ts'`): `sat_codigos_agrupadores` 5, `sat_bancos` 4, `inpc_serie` 3, `mx_isn_tasas_estatales` 3, `sat_anexo24_artefactos` 3.
3. Tests: 4 / 4 / 3 / 5 / 5 archivos respectivamente; `schema-contract.int.spec.ts` (nombres en FROM/JOIN/INSERT/UPDATE) detecta cualquier referencia vieja en SQL de `src/`.
4. Docs: 2 / 0 / 0 / 2 / 0.
5. `criterios.ts:886-889` extrae `CREATE TABLE`/`DROP TABLE` de migraciones para otro criterio; un RENAME no le afecta.

Coste bajo (≈18 archivos de src, ≈21 de tests). Valor también bajo: los cinco nombres son catálogos SAT/INPC/ISN cuyo nombre en inglés no existe en la norma.

### 4.2 Renombrar COLUMNAS (117)

1. Migración nueva con `ALTER TABLE … RENAME COLUMN` por columna (Postgres reescribe CHECK e índices que la usan; los nombres de índice `idx_reconciling_items_tipo`, `idx_xml_docs_fecha`, `idx_xml_lines_clave` quedan desfasados pero funcionan). Vistas: **0** referencias a columnas castellanas en las 2 materializadas (`grep -cE` sobre 004/010/012/031/042 → 0 en las cinco). RLS: **0** (los predicados sólo usan `tenant_id`/`entity_id` y FK inglesas).
2. Lectores TS: para los nombres compuestos es acotado (`fecha_esperada` 5 archivos src / 7 tests; `codigo_agrupador_sat` 6 / 7 / 15 docs; `subsidio_entregado_efectivo` 3 / 3; `tipo_factor` 2 / 4). Para los nombres de una palabra el grep **no sirve**: `tipo` aparece en 90 archivos de src, `fecha` en 95, `importe` en 92, `valor` en 124, `estado` en 89 — porque son también identificadores de variables en un código cuyos comentarios e identificadores locales están en castellano. El refactor tiene que apoyarse en el tipo (`TipoDePartida`, `reconciling-items.ts:133,179,389`) y en la prueba de contrato.
3. `schema-contract.int.spec.ts:14-20` cubre **sólo** tablas en FROM/JOIN/INSERT/UPDATE, listas de columnas de INSERT y SELECT de una sola tabla sin alias; **no** WHERE, SET, ni SELECT con JOIN. Una columna renombrada y olvidada en un WHERE llega a producción.
4. Pruebas de integración que nombran la tabla: `reconciling_items` 10 archivos, `xml_documents` 14, `reconciliation_adjustments` 5, `reconciliation_match_groups` 2, `policy_decisions` 13.
5. `manifiesto.json` guarda hashes de `src/database/enums.ts`, `rls-policies.sql`, `policy-service.ts`, `policy-tools.ts` y de 8 servicios de banca/AR/AP que leen estas columnas (46 rutas): cada edición obliga a revalidar el manual del agente.
6. `vitest.config.ts` no tiene umbral sobre `src/database/**` ni `src/services/policy/**` ni `period-close.ts` (`:41-44`, deliberado); sí sobre `posting.ts` (99/95/100/99) y `ar-ap-posting.ts`, que citan 8 y 0 literales de panel respectivamente — un cambio ahí exige specs propios (memoria: los llamadores mockean `posting` entero).
7. Columnas sin ningún lector en `src` hoy: `sat_bancos.nombre_corto`, `xml_documents.condiciones_pago`, `employees.departamento` (`doctor` las marcaría huérfanas).

Coste medio-alto y **desigual**: barato para las ~40 columnas «de la casa» con nombre compuesto, caro y arriesgado para las de una palabra, y **sin valor** para las ~77 que copian el nombre del atributo del SAT/IMSS/DIOT (renombrar `metodo_pago` a `payment_method` rompe la correspondencia 1:1 con `MetodoPago` del XSD que hoy documenta qué se está guardando).

### 4.3 Cambiar VALORES de CHECK (43 literales en 14 CHECK)

1. Migración de datos: `ALTER TABLE DROP CONSTRAINT` → `UPDATE … SET col = CASE …` → `ADD CONSTRAINT`. Las tablas son de inquilino: hay que usar el patrón `SET LOCAL row_security = on` + bucle por `tenants` de `docs/migraciones.md` («Migraciones de datos bajo RLS»); sin él, el piso `row_security=off` de `migrate.ts` lanza 42501 y la migración muere (criterio E0.2 lo exige).
2. `criterios.ts:1615-1721` lee los CHECK **de las migraciones en orden** y los compara con las constantes `as const` censadas por terna; la lista acumulada por columna debe seguir coincidiendo con el vocabulario TS, así que cambiar el CHECK obliga a cambiar `enums.ts` (`CREDIT_NOTE_TYPES`) o `reconciliation-math.ts:53-60` el mismo día.
3. Lectores y pruebas por valor (`grep -rn "'<valor>'"`): `cheque-en-circulacion` 5 src / 22 tests, `cargo-del-banco` 4 / 27, `iva-comision` 4 / 23, `proporcional_dias` 10 / 39, `tasa_plana` 6 / 15, `quincenal` 7 / 12, `devolucion` 1 / 2, `emitido`/`recibido` 21+34 src (ambiguo: también prosa).
4. **Fuga a la CLI**: `src/cli/bank-command.ts:1775` documenta `--type cheque-en-circulacion`; el valor del CHECK es el valor del flag. Cambiarlo es un cambio de contrato de línea de comandos → protocolo R9 de `docs/cli-command-catalog.md:208` (alias viejo que avisa por stderr). `prepaid-command.ts:94` reconoce que `proporcional_dias|meses_completos` es «el vocabulario del motor» y la CLI lo traduce — ése es el patrón que ya existe.
5. Docs: 0-9 menciones por valor (`isr-retenido` 9, `iva-comision` 6).

Coste alto por valor (migración de datos + 2 listas TS + tests + CLI). Alternativa sin migración: dejar el literal y traducir en superficie, que es lo que R8 (`cli-command-catalog.md:204`) ya manda.

### 4.4 Cambiar VALORES y CLAVES del panel (93 valores, 53 claves)

1. Migración de datos sobre `policy_decisions` (tabla de inquilino → bucle RLS) reescribiendo **tres** columnas: `resolved_value`, `default_value` y el JSONB `options` (copia congelada del catálogo, `policy-service.ts:51-61`). Una fila resuelta con el valor viejo y un lector que compare con el nuevo cae en `avisarValorDesconocido` (`period-close.ts:1128`) y toma el defecto **en silencio salvo un aviso** — la clase de defecto que el proyecto llama «capacidad inalcanzable».
2. 123 comparaciones literales inequívocas en 34 archivos de src (C17) + 247 en 47 de tests + 83 en 15 docs; con las palabras sueltas (`avisar`, `bloquear`, `exigir`, `rechazar`…) la cota sube a 326 / 511.
3. `criterios.ts` ancla por literal: `:1436-1439` (`key: 'segregacion_de_funciones'` y `'exigir'`), `:3438` (`value: 'shadow'`), `:2162-2185` (todas las claves deben tener lector `getPolicy(` fuera del módulo), y 7 valores más (`grep -noE "'(dos_pasos_hasta_asamblea|…)'" criterios.ts` → 7).
4. Claves: cada `key` tiene 1-4 lectores en src (`getPolicy('clave')`) y hasta 21 docs (`segregacion_de_funciones` 21, `umbral_capitalizacion_mxn` 19, `ingest_auto_post` 18).
5. Memoria del proyecto (`decisiones-contables-configurables.md`): las opciones son **valores persistidos** y se añaden, no se editan.

Coste muy alto; es la clase más acoplada del inventario. Y el beneficio para el usuario es nulo: el usuario **no ve** el valor, ve `label`/`question` — que hoy están en inglés (§3.5).

### 4.5 Nombres de migración

No se tocan (`migrate.ts:66-68,82,105`; `docs/migraciones.md` «Duplicados históricos»). Coste de intentarlo: re-ejecución en toda base desplegada + 17 anclas en `criterios.ts` + 22 nombres en tests (`migracion-051-clabe.int.spec.ts` lleva el número en el propio nombre) + 80 en docs (21 de ellos ya obsoletos, §5).

### 4.6 Funciones, índices, constraints, triggers

`ALTER INDEX/FUNCTION … RENAME`, `ALTER TABLE … RENAME CONSTRAINT` en migración nueva; los triggers hay que recrearlos. `criterios.ts` ancla algunos nombres (`:1507-1511` `uq_xml_documents_entity_cfdi`, `uq_xml_documents_entity_hash`; `:5002-5011` guardias de la 058/033). Coste bajo, valor casi nulo: nadie los teclea.

---

## 5. Dependencias (archivos que referencian esta superficie por nombre o ruta)

- `src/database/migrate.ts:66-68,78,82,105,127` — registro por `filename`; `assertNumeracionUnica`; reaplicación de `rls-policies.sql`.
- `src/database/rls-policies.sql:21,91` — listas `excluded` y `append_only` (inglesas); `:23-33` descubrimiento por `tenant_id`/`entity_id`.
- `src/database/enums.ts:181-203` — `VOCABULARIOS` (22 ternas tabla/columna/constante).
- `src/services/banking/reconciliation-math.ts:53-60,78-85` — `TIPOS_DE_PARTIDA`, `LADO_DE` (copia no censada del CHECK de `054:67`).
- `src/services/accounting/account-service.ts:628` — `'sat-agrupador': 'codigo_agrupador_sat'` (capa de alias esquema-CLI → columna); anclado por `criterios.ts:4884-4906`.
- `src/services/policy/policy-service.ts:34-35,51-61,145-157,235,253,290` — columnas de `policy_decisions`, siembra de `options`, lectura y validación de `resolved_value`.
- `src/ai/tools/policy-tools.ts`, `src/ai/memory-service.ts`, `src/cli/pending-command.ts` — los otros 3 lectores de `resolved_value`.
- `src/plan/criterios.ts` — 35 líneas citan `migrations/`; 17 nombres de migración distintos; `:886-889` (CREATE/DROP TABLE), `:1615-1721` (CHECK ↔ constantes), `:1436-1439`, `:2162-2185`, `:3438` (panel), `:1507-1511`, `:4086-4094`, `:4218-4224`, `:4490-4497` (cuerpos SQL concretos).
- `src/ai/docs/manifiesto.json` — 46 hashes; entre ellos `src/database/enums.ts`, `src/database/rls-policies.sql`, `src/services/policy/policy-service.ts`, `src/ai/tools/policy-tools.ts`, `src/services/banking/{reconciling-items,reconciliation-adjustments,reconciliation-service,match-service,matching,bank-statement-service,book-items,statement-checks}.ts`.
- `tests/integration/enum-contract.int.spec.ts` (pg_constraint ↔ `VOCABULARIOS`), `tests/integration/schema-contract.int.spec.ts` (SQL de src ↔ information_schema; alcance en `:14-20`), `tests/database/migration-numbering.spec.ts:9-22`, `tests/integration/migracion-051-clabe.int.spec.ts`, `tests/integration/migracion-bajo-rls.int.spec.ts`.
- `vitest.config.ts:41-44` (sin umbral en `period-close.ts`/`ledger-checks.ts`), `:97-121` (umbrales en `posting.ts`, `ar-ap-posting.ts`, `validation.ts`, `report-service.ts`, `jurisdiccion.ts`, `criterio-cierre.ts`, `sequence.ts`).
- `docs/migraciones.md` (duplicados 012/014/015/018; patrón RLS para migraciones de datos), `docs/cli-command-catalog.md:204-208` (R8 alias, R9 deprecación), `docs/wiki/Arquitectura.md:122` (biyección alias↔verbo).
- Sembradores de catálogos: `src/services/accounting/sat-agrupadores.ts:67`, `src/services/fiscal/inpc/inpc-service.ts:309`, `src/cli/payroll-isn-command.ts:996`, `src/services/sat/anexo24/artefactos.ts:81`. `sat_bancos` **no tiene INSERT en el árbol** (`grep -rn "INSERT INTO sat_bancos" src migrations` → nada); `polizas-service.ts:301,673` lo lee y declara «false cuando está vacío».

---

## 6. Recomendación: qué es renombrable y qué debe quedarse como vocabulario estable

**Vocabulario estable (no renombrar; documentar en inglés en un glosario del esquema):**

1. Las 5 tablas-catálogo (`sat_codigos_agrupadores`, `sat_bancos`, `inpc_serie`, `mx_isn_tasas_estatales`, `sat_anexo24_artefactos`) y sus columnas que copian campos del Anexo 24 / c_Banco / INPC.
2. Las ~77 columnas que espejan un atributo del CFDI, del c_TipoContrato/c_TipoJornada/c_TipoRegimen, de la DIOT o del IMSS (`xml_documents.*`, `xml_document_lines.*`, `employees.tipo_*_sat`, `vendors.tipo_tercero/tipo_operacion/…`, `bill_lines.tipo_factor/valor_actos`, `*_payments.cuenta_destino/banco_destino_*`, `accounts.codigo_agrupador_sat`, `customers.uso_cfdi`, `legal_entities.imss_registro_patronal`, `paychecks.subsidio_*`). Su «traducción» destruiría la trazabilidad 1:1 con el XSD y con el vocabulario que el contador mexicano usa; el nombre inglés canónico no existe.
3. Los 14 valores de CHECK que nombran catálogos del SAT (`cfdi_ingreso…`, `catalogo/balanza/poliza/auxiliar_*`, `tasa/cuota/exento`) y los códigos (`'04'`, `'N'`, `'D'`).
4. Las 53 claves y los 93 valores del panel: son identificadores persistidos en tres columnas y comparados en 34 archivos; tratarlos como códigos opacos (igual que `soft_close` o `macrs`) y traducir sólo `label`/`question`/`impact` mediante catálogo — hoy están en inglés y el pedido del dueño exige que el **primer** idioma renderizado sea el español, así que ahí sí hay trabajo, pero es trabajo de catálogo de textos, no de migración.
5. Los 74 nombres de migración, incluidas las 36 castellanas, y sus cuerpos SQL.

**Renombrable (con migración `RENAME`, sin migración de datos), por orden de valor/coste:**

1. Columnas «de la casa» con nombre compuesto y pocos lectores: `reconciling_items.fecha_esperada/resuelta_at/escalamiento`, `reconciliation_match_groups.total_banco/total_libros/total_ajustes/origen`, `ai_ingest_runs.sospecha_count`, `ai_shadow_verdicts.motivo`, `idempotency_keys.clave/resultado`, `sat_anexo24_artefactos.sellado/politica_sellado/generado_por`, `inpc_serie`/`mx_isn_tasas_estatales`.`capturado_el/capturado_por/publicado_el/fuente/fundamento`, `subsidio_entregado_efectivo`. ≈25 columnas.
2. Columnas «de la casa» de una palabra (`reconciling_items.tipo/importe/fecha/responsable/notas`, `reconciliation_adjustments.tipo/importe`): renombrables, pero el grep no las localiza y la prueba de contrato no cubre WHERE/SET/JOIN (§4.2.3); hacerlo sólo con una pasada de tipos (`TipoDePartida`) y pruebas de integración que ya nombran la tabla (10 archivos).
3. Las 6 funciones y 59 objetos con nombre castellano: renombrables a coste bajo y valor casi nulo; dejarlos para el final o no hacerlo.

**Valores de CHECK «de la casa» (29):** técnicamente renombrables, pero cada uno cuesta una migración de datos bajo RLS, dos listas TS y una deprecación de CLI (`--type cheque-en-circulacion`). La ruta coherente con R8 es congelarlos como vocabulario del motor y **traducir en superficie** (la CLI ya lo hace con `proporcional_dias`, `prepaid-command.ts:94`), y sólo migrar datos si alguien decide que el valor persistido debe ser inglés por principio; en ese caso empezar por `reconciling_items.tipo` (6 valores, 5 archivos de src) y `credit_notes.type` (4 valores, 1 archivo), que además cerraría la anomalía de columna inglesa con valores castellanos.

**Regla para lo nuevo (la que `enums.ts:37-44` ya enuncia):** columna, valor y clave nuevos en inglés salvo que copien un término de una norma mexicana, en cuyo caso se conserva el término de la norma; el castellano entra por catálogo de textos.

---

## 7. Anotaciones (contenido leído como dato; nada se ejecutó ni se cambió)

- **Panel invertido**: valores castellanos persistidos, textos de usuario en inglés (`pending-catalog.ts`, 131 labels / 48 questions). Es la mayor distancia entre el estado actual y el pedido del dueño en esta superficie, y la más barata de cerrar (un catálogo de labels).
- **21 nombres de migración citados en `docs/` no existen** en el árbol (p. ej. `031_audit_coverage.sql`, `048_cobrar.sql`, `060_el_agrupador_con_una_sola_verdad.sql`, `063_el_tercero_que_la_diot_declara.sql`): reservas del reparto retirado o renumeraciones previas al `assertNumeracionUnica`. Cualquier plan que cite migraciones por nombre debe verificarlas contra `ls src/database/migrations`, no contra docs.
- `reconciling_items.tipo` tiene su vocabulario duplicado en `reconciliation-math.ts:53-60` **fuera del censo** de `enums.ts`; la prueba `enum-contract` no lo vigila.
- `sat_bancos` no tiene sembrador en el árbol; la comprobación de claves de banco del Anexo 24 se degrada a «sin validar» (`polizas-invariantes.ts:37,73,225`).
- `pay_schedules.frequency` (`008_payroll.sql:123`) mezcla `quincenal` con cuatro valores ingleses en la misma lista; `credit_notes.type` (`049:45`) tiene columna inglesa y valores castellanos. Son los dos puntos donde la mezcla ocurre dentro de un mismo vocabulario.
- Ningún archivo leído contenía instrucciones dirigidas al agente que hubiera que ignorar.

---

## 8. Resumen

El esquema es inglés en su carta y en su mayoría: 115 tablas (5 castellanas), 1868 columnas
(117 con palabra castellana en 25 tablas, 61 más con acrónimo fiscal y resto inglés), 22
vocabularios censados de los que 1 es castellano, y `types/index.ts` con un solo campo
castellano. Lo castellano se concentra en dos capas distintas: (a) ~77 columnas y 14 valores
que **copian el nombre de un atributo o catálogo del SAT/IMSS/DIOT** y que conviene
congelar como vocabulario estable documentado en inglés, y (b) ~40 columnas, 29 valores de
CHECK, 53 claves y 93 valores del panel «de la casa», introducidos casi todos a partir de la
migración 034. Renombrar tablas y columnas compuestas es barato (migración `RENAME`, sin
datos, RLS y vistas no se enteran); renombrar valores persistidos —CHECK y sobre todo panel—
exige migración de datos bajo RLS, reescribir 123-326 comparaciones literales en 34-45
archivos de src y 247-511 en tests, anclas en `criterios.ts`, y una deprecación de CLI. Los 74
nombres de migración no se tocan. El punto más alejado del pedido del dueño no son los
valores sino los textos: el panel muestra hoy sus 131 labels y 48 preguntas en inglés sobre
identificadores castellanos, justo al revés de «fuente en inglés, español como primer idioma
renderizado».
