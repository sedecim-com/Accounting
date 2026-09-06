# Inventario de motores contables por jurisdicción

> Verificado el 2026-09-06 contra la rama `investigacion/normas-y-motores` (HEAD `bd148ec`) por nueve lectores de código y nueve escépticos independientes con la instrucción de refutar (método en el [README](README.md)). Cada fila cita `archivo:línea`; los informes largos por subsistema viven en [`motores/`](motores/). Las dos jurisdicciones son México (**MX**) y Estados Unidos (**US**).

**Vocabulario de estado.** `completo`: existe, tiene puerta (CLI/REST/agente) y hace lo que dice. `parcial`: existe con huecos nombrados. `inerte`: el motor existe pero no tiene puerta, o la tiene y no escribe nada. `ausente`: no hay motor bajo ningún nombre (se buscó por grep antes de afirmarlo). `—`: no aplica a esa jurisdicción.

**Vocabulario de parámetro.** Dónde vive hoy el número o la regla que el motor usa: `ley` (debería estar en tabla con vigencia: [`docs/jurisdicciones.md` §3.4](../../jurisdicciones.md)), `panel` (criterio del despacho, `pending-catalog.ts`), `casa` (constante del motor), `quemado` (ley o criterio escrito en código, que es lo que hay que mover).

---

## 1. Motor contable (núcleo)

| Motor | MX | US | Estado | Regla que debe definirse | Parámetro | Evidencia |
|---|---|---|---|---|---|---|
| Partida doble y posteo al mayor | ✓ | ✓ | completo | El año del folio es el natural del documento (`sequence.ts:36-46`), no el ejercicio: en un ejercicio no natural (US) la serie se parte | casa: prefijo `JE`, resumen a 2 dec. | `posting.ts:72,147,492` |
| Siete reglas de validación NIF | ✓ | parcial | completo (MX) | R7 y los mensajes sólo citan NIF y en castellano; sin contraparte ASC. Las citas NIF A-2/A-4/A-5 son de la serie que la A-1 (2023) integró: el motor y el corpus del agente (`niif-pymes-convergencia.md:49,95`) citan normas distintas | casa: `BALANCE_TOLERANCE 0.01`, `AUTOMATED_ENTRY_TYPES`, regex `\banticipo\b` | `validation.ts:13,59,82,149,184,197-200,282,322,326-338` |
| Segregación de funciones (SoD) | ✓ | ✓ | completo | La exención por `source_type` nulo se decide en código; el panel sólo la describe. Se puede acotar **por entidad** (`policy-service.ts:137-138`), no por jurisdicción | panel: `segregacion_de_funciones` | `posting.ts:354`; `pending-catalog.ts:909-911` |
| Reversión y anulación | ✓ | ✓ | completo | Fecha por omisión = hoy; la puerta la admite (`entry reverse --date`) pero ninguna política decide el default. Sin reexpresión retrospectiva (NIF B-1 / ASC 250) | casa: `Reversal:`, `Voided:` | `posting.ts:537-712`; `entry-command.ts:281` |
| Calendario fiscal | parcial | parcial | parcial | Siempre año natural, 12 periodos, nombres en inglés. `fiscal_year_start_month` **sin lector**; periodo 13 admitido y nunca creado; `fiscal_years.status='closed'` **sin escritor**; ejercicio irregular (CFF 11) ausente. MX debe forzar año natural; US puede no serlo (IRC §441) | ley/casa | `fiscal-calendar-service.ts:485-487,513-534,551`; `001:89,197-204` |
| Checklist y cierre mensual | parcial | parcial | parcial | `rep-parked`/`rep-missing` sin compuerta de jurisdicción (cuentan `cfdi_uuid IS NULL` en toda entidad); severidades fijas; `depreciacion_faltante_al_cierre` **no la lee** el checklist aunque su texto lo prometa; `amortizacion_faltante_al_cierre` sin casilla; `previous-period-closed` sin clave | panel (parcial) | `period-close.ts:145-165,419-446,522-551,582-590`; `pending-catalog.ts:163-164` |
| Asientos de cierre anual | parcial | parcial | parcial | 3900/3200/3300 por **código**, no por rol; segundo paso 3300→3200 sin motor; reserva legal LGSM art. 20 (5 %/20 %) sin cálculo; provisión de ISR al cierre (NIF D-4 / ASC 740) sin motor ni cuenta | panel: `destino_del_resultado_del_ejercicio` (default LGSM, sin default por jurisdicción) | `period-close.ts:1006-1012,1078-1096,1148-1290`; `chart-seed.ts:64,123-127` |
| Arrastre de saldos | ✓ | ✓ | completo | Sin periodo siguiente → 0 y nadie reintenta; el remedio (`period reopen` + `hard_close`) es manual; `ledger check balance` detecta el hueco | casa | `period-close.ts:837-851`; `ledger-checks.ts:205-260` |
| Integridad del mayor | ✓ | ✓ | completo | UUID↔póliza sólo en controles AR (`missing-uuid`, `stamped-without-entry`); AP sin equivalente; sentido póliza→comprobante nadie lo mira. Retención de registros (CFF 30 · IRC §6001) sin motor | casa: `LIMIT 100`, 30 días | `ledger-checks.ts:117-292,356`; `ar-controls.ts:276-335` |
| Catálogo por país y roles | ✓ | neutro | parcial | No hay `ESTRATO_FISCAL_US` ni `ROLES_FISCALES_US`: US recibe el neutro (2135/1136). Agrupador SAT en **dos columnas** (`mx_nif_code` se escribe; `codigo_agrupador_sat` de la 037 sin lector ni escritor); sin catálogo c_CodAgrup versionado; `us_gaap_code` sólo por `map set --scheme us-tax-line`; `rolesSinMapear` sin puerta pese al comentario | casa | `chart-seed.ts:44-144`; `account-roles-seed.ts:300-338,385`; `037:27-31`; `account-service.ts:455-456,513-516`; `entity-accounting.ts:151-155` |
| Devengo de pagos anticipados (activo) | ✓ | ✓ | completo | Umbral en MXN contra moneda funcional; `prepaidThreshold` **no se inyecta** al clasificador (cae al default 5 000); mensaje remite a `accruals run` y el comando es `prepaid run` | panel: `amortizacion_anticipados_convencion`, `umbral_anticipado_mxn` | `amortization-math.ts:54,240`; `prepaid-service.ts:194-209,358-366,712-714`; `pre-registration-service.ts:763-808` |
| Pasivos devengados (NIF C-9 / ASC 450-710) | ✗ | ✗ | ausente | Provisiones, gastos devengados no facturados | — | grep `accrued_liab\|accrued_expense\|contract_liab` en `src/services` y migraciones: cero |
| Ingreso diferido | parcial | parcial | parcial | El **anticipo de cliente como pasivo** sí existe (alta, aplicación, desaplicación, TipoRelacion 07); falta el devengo **calendarizado** del ingreso facturado por adelantado (espejo de `prepaid_expenses`) — NIF D-1 / ASC 606 | — | `ar-ap-posting.ts:544-565,619-690,916-937`; `cfdi-taxonomy.ts:196,288-299` |
| Conversión FX | ✓ | ✓ | completo | Half-up a 4 dec. (Anexo 20); dos funciones de conversión que hoy coinciden; regla CFF 20 «TC del día hábil anterior» escrita en prosa y no aplicada | casa | `conversion.ts:21-83,222-240`; `moneda-origen.ts:28-33,268-270`; `fx-command.ts:144` |
| Tipos de cambio y fuente | ✓ | parcial | parcial | Sin cliente `fed`/`ecb` aunque el CHECK y el descargador los listan; `rate_type='spot'` clavado en los resolutores; `average`/`historical` con escritor y lector pero sin consumidor de conversión | panel: `fuente_tipo_cambio` (sin opción US) | `rate-service.ts:57-61,193,240-246,282,303,314`; `moneda-origen.ts:207-211,270,284`; `fx-command.ts:141-152,514` |
| Diferencia cambiaria realizada | parcial | parcial | parcial | Sólo en pagos a proveedores. **AR en moneda extranjera no existe**: `postInvoiceEntry` rechaza toda factura en moneda no funcional (`FX_AR_NOT_WIRED`). Borde por verificar: anticipo puro de cliente en moneda no funcional podría asentarse crudo | casa: roles 4320/6320 | `ar-ap-posting.ts:133-141,521-525,987-991,1019-1083`; `payment-service.ts:326-375,555-625,568-575` |
| Diferencia cambiaria no realizada (NIF B-15 / ASC 830) | ✗ | ✗ | ausente | Remedición de saldos monetarios al cierre | — | grep `revalu\|unrealized\|remeasur`: sólo comentarios que lo declaran pendiente |
| Bloqueo `locked` y cierre del ejercicio | ✗ | ✗ | ausente | Ningún `SET status='locked'`; ningún `UPDATE fiscal_years`. Es el conductor del cierre (issue #121) | — | 30 lecturas de `'locked'`, cero escrituras |

## 2. Informes

| Motor | MX | US | Estado | Regla que debe definirse | Parámetro | Evidencia |
|---|---|---|---|---|---|---|
| Resolución de periodos (`--period`) | ✓ | parcial | completo | `FY2026` = año natural; nunca lee `fiscal_years` ni `fiscal_year_start_month` | casa | `report-service.ts:74-76,117-127,133-204` |
| Balanza de comprobación | parcial | ✓ | parcial | La balanza no proyecta SaldoIni ni Natur; **el dato de cuatro columnas existe por cuenta** (`getAccountBalanceByPeriod`) y la invariante `SaldoIni+Debe−Haber=SaldoFin` **sí se verifica** (`ledger-checks.ts:143-185`); `normal_balance` existe (`001:132`). Falta proyectarlo como balanza (Anexo 24) | casa: `'0.01'` | `report-service.ts:242-250,301-368`; `account-service.ts:398-440` |
| Balance general | parcial | parcial | parcial | Sin balance clasificado (ASC 210), sin ORI, `fs_category` único `'equity'` (no distingue contribuido/ganado), sin diferidos (NIF D-4/ASC 740), sin moneda de presentación, sin consolidación (NIF B-8 / ASC 810) | casa: rótulos en inglés | `report-service.ts:545-568`; `001:116-121`; `account-service.ts:461` |
| Estado de resultados | parcial | parcial | parcial | Filtra por `account_type` y no lee `fs_category`; sin subtotales NIF B-3 / ASC 220; sin PTU; `contra_revenue` fuera del CHECK | casa | `report-service.ts:527,633,662-682,695` |
| Mayor general | ✓ | ✓ | completo | — | casa | `report-service.ts:748-820` |
| Antigüedad CxC/CxP | parcial | parcial | parcial | Cubetas sólo en la **puerta CLI** (no en motor, REST ni agente); saldo a fecha de corte sólo CxC (`invoice list --as-of`); **estimación de pérdidas** (NIF C-16 / ASC 326 CECL) ausente | casa: estados abiertos duplicados en SQL | `report-command.ts:722-729`; `invoice-service.ts:164-178`; `report-service.ts:856-902` |
| Auxiliar de cuenta (XC) | parcial | — | parcial | `journal_entry_lines` sin `cfdi_uuid`; sólo `ledger auxiliary show` | casa | `report-service.ts:999,1078`; `cli-command-catalog.md:2018` |
| Estado de flujos de efectivo | parcial | parcial | parcial | Sin saldos inicial/final en el cuerpo (los arma el CLI desde el amarre); intereses/dividendos por `account_type`; sin FX ni efectivo restringido; método directo/indirecto por panel | panel: `flujo_efectivo_*` (3) | `cash-flow-service.ts:91-95,192-199,406-426,767-785`; `cash-flow-reconcile.ts:47,56` |
| Vistas materializadas | ✓ | ✓ | inerte | Ninguna puerta del producto las lee para informar | casa | `materialized-view-service.ts:40,67,147` |
| Estado de cambios en el capital · Notas (NIF A-7 / ASC 235) · Comparativos | ✗ | ✗ | ausente | Las tres faltan igual en ambas jurisdicciones | — | `cli-command-catalog.md:2279-2280,2453-2459` |
| Calendario de obligaciones | ✗ | ✗ | ausente | MX: DIOT mensual, pagos provisionales, anual. US: 941 trimestral, 940, 1120/1065, 1099, *sales tax*. Los **formularios** 941/940/W-2/W-3/EFW2 sí existen como motor; falta el calendario | ley | `payroll.ts:291-333`; `cli-command-catalog.md:2075-2078` |
| Contabilidad electrónica (Anexo 24: catálogo, balanza, pólizas, auxiliares XML) | ✗ | — | ausente | Tramo F07 (issue #112) | ley | grep `BalanzaComprobacion\|CtaCatalogo\|RepAuxFol`: cero |

## 3. Fiscal México

| Motor | Estado | Regla que debe definirse | Parámetro | Evidencia |
|---|---|---|---|---|
| Parser CFDI 3.3/4.0 | parcial | Sólo raíz `Comprobante`; **no verifica el sello** (sin XSD, sin cadena original); complementos sólo TFD/Pagos/Nómina (ImpuestosLocales, Terceros, ComercioExterior, CartaPorte no); CFDI de retenciones (tipo R) rechazado; **`total_iva_0` siempre 0** (`Importe="0.00"` es falsy) | quemado: tasas 16/8/0, tolerancias, regex RFC | `cfdi-parser.ts:101-122,166-173,253-285,301,322-331,359-363,385-391` |
| Hechos, taxonomía, decisiones, clasificador, plan de posteo | completo | 12 decisiones con cita LISR/LIVA/LIEPS; `ObjetoImp` sólo `01`; «asume ISR» sin desglose; nota de crédito **recibida** en PPD contra `iva_acreditable` (debería ir contra `iva_pendiente_acreditar`); sin nota de débito 02, traslados 05/06, RFC genéricos, CFDI global; sin LISR 36-II (autos), 28-V (viáticos), 69-B/EFOS como regla | quemado: 2 000 (LISR 27-III), 8.5 % (LISR 28-XX), 20 000, 5 000 (estos dos también en panel) | `cfdi-facts.ts:116-117,169,185,210,216-227,238-245`; `cfdi-taxonomy.ts:280-286`; `cfdi-decisions.ts:54,67,86-103,193-195` |
| IVA en base de flujo (LIVA 1-B, 5-III) | completo | `CONSERVATIVE_METODO` en código, no lee el panel; **acreditamiento proporcional (LIVA 5-C) ausente**; cheque (LIVA 1-B 2.º párrafo) tiene motor con puerta que **reclasifica cero** (`conciliarCheque`); regla de jurisdicción duplicada y **divergente** en el borde nulo respecto a `pais-contable.ts` | quemado | `iva-cash-basis.ts:64-70,262,310,646-660`; `treasury-posting.ts:1345-1370`; `iva-ppd-reclass.ts:61-68,101` |
| REP: ligadura y pendientes | completo | Moneda extranjera → revisión («la diferencia cambiaria no se calcula todavía»); `ObjetoImpDR`, `NumParcialidad`, `ImpSaldoAnt/Insoluto` se leen y nadie los consume; el 5.º día natural no se calcula; **emisión y corrección de REP fuera** | panel: `rep_*` (7) | `rep-linkage.ts:73-79,133-147,206-219`; `rep-pendientes.ts:43-133`; `rep-command.ts:31-33` |
| Estatus SAT (consulta) | completo | `esCancelable`/`estatusCancelacion` sólo se muestran; EFOS sólo guardado; **reversa por cancelación ausente** (E3.2) | casa | `cfdi-status.ts:46,113,195-245`; `sat-validation.ts:51,75-76` |
| Catálogos SAT | parcial | c_CodAgrup versionado **no existe** | quemado | `sat-catalogs.ts:17-19,99-111`; `account-command.ts:632,640` |
| Custodia e.firma y bóveda | completo | `withCredential` como único lector; CSD rechazado en la custodia de e.firma; `MAX_SECRET_BYTES` fijo | panel: `efirma_*` (2) | `fiscal-credentials/service.ts:21,108-113,151,183,255,339,392`; `vault/*` |
| IEPS | parcial | Sin columna en `xml_documents`; `TipoFactor='Cuota'` al mismo cubo | panel: `tratamiento_ieps` | `cfdi-facts.ts:225-227`; `005:48-54` |
| Retenciones (honorarios 10 % ISR, IVA 2/3, arrendamiento, RESICO) | parcial | La retención que **trae el CFDI** sí se postea (taxonomía → `isr_retenido_por_pagar`/`iva_retenido_por_pagar`, ejecutada por `bill inbox run`); lo ausente es el **cálculo** (perfil por proveedor, tasa, vigencia), su aplicación al `bill create` manual y el pasivo/entero del día 17 | ley | `cfdi-taxonomy.ts:151-152,171-172`; `pre-registration-service.ts:1150-1165`; grep `honorarios\|0\.1067\|dos terceras` en `ar/ap/payments`: cero |
| DIOT (LIVA 32-VIII) | ausente | Existe `skills/diot-checklist/SKILL.md` (guion humano) y `vendor list --no-tax-id` (bloqueadores) | ley | `vendor-command.ts:108,178,347` |
| Descarga masiva SAT | ausente | Criterio E3.2 en rojo con la lista de lo que falta | — | `plan/criterios.ts:2332-2364`; `sat-commands.ts:71` |
| Timbrado | parcial | 1 adaptador real (Sovos Reachcore) y 3 simulados bajo cerrojo; **sin sellado propio** (ni facturas ni nómina); el XML de venta es un `Comprobante` mínimo | casa | `pac-router.ts:67-95`; `invoices.ts:247-256`; `cfdi-nomina-generator.ts:136` |
| Cancelación con acuse (CFF 29-A) | ausente | `pacRouter.cancel` sin llamador; 501 explícito | — | `invoices.ts:311-336` |
| Determinación mensual del IVA · pagos provisionales ISR · ISR anual PM · PTU | ausente | — | ley | grep `pago provisional\|saldo a favor\|PTU`: sólo comentarios y corpus |

## 4. Fiscal Estados Unidos (fuera de nómina)

| Motor | Estado | Regla que debe definirse | Parámetro | Evidencia |
|---|---|---|---|---|
| *Sales & use tax* (nexo económico, *marketplace facilitator*) | ausente | Lista de estados con nexo es decisión del despacho (panel); tasas por estado son ley | ley + panel | grep `sales.?tax\|nexus`: sólo nómina |
| 1099-NEC / MISC / K, 1096 | ausente | `is_1099_vendor` existe; `tax_form_filings.form_type` admite `1099_nec` **sin escritor** | ley | `002:17`; `008:486`; `vendor-command.ts:90-190` |
| W-9 / TIN matching / *backup withholding* (§3406) | ausente | — | ley | grep: cero |
| Impuesto sobre la renta de la entidad (1120 / 1120-S / 1065 / Sch. C) y provisión ASC 740 | ausente | El tipo de entidad ya está en `legal_entities.entity_type` | ley | `001:82-83` |
| Deducibilidad IRC (§162, §274, §280F, §179, *bonus*) | ausente | El clasificador de deducibilidad es 100 % LISR | ley | `cfdi-decisions.ts` |
| Depreciación fiscal MACRS | parcial | Sólo *half-year*; `macrs_class` nunca se escribe; sin §179 ni *bonus*; desalineada del ejercicio | quemado: `MACRS_TABLES` | `motores/activos-inventario.md` |
| Credenciales IRS/estatales (EFTPS, *e-file*) | ausente | `credential_type` sólo `efirma|csd` | — | `014:13-14` |
| Conciliación 1099-K (§6050W) | ausente | La aritmética bruto/comisión/neto existe en `stripe-adapter.ts:76-86` sin consumidor | — | `motores/integraciones-y-publico.md` |
| Tipo de identificación fiscal | parcial | `tax_id_type` admite `ein`, pero el alta desde CFDI escribe `'rfc'` | casa | `pre-registration-service.ts:353,1082` |

## 5. Nómina México

| Motor | Estado | Regla que debe definirse | Parámetro | Evidencia |
|---|---|---|---|---|
| ISR retenido (LISR 96) | completo | Lanza sin tabla del año (fallo cerrado correcto) | ley (`tax_tables`, una fila por año) | `isr-calculator.ts:9-45` |
| Subsidio al empleo | completo | El **signo** del excedente depende del decreto vigente (2024/2025): por verificar contra DOF; refuerza que sea parámetro con vigencia | ley | `isr-calculator.ts:52-88` |
| IMSS obrera y patronal | completo | **Sin fila en `tax_parameters` → cuota 0 en silencio** (`\|\| 0`), mientras el ISR lanza | ley | `imss-calculator.ts:51-148,72-80,119-135`; `tax-tables.ts:79` |
| INFONAVIT patronal y descuento | completo | `vsm` sobre SMG en vez de UMA (desindexación 2016): por verificar contra manual SUA | ley | `infonavit-calculator.ts:20-86` |
| Finiquito · aguinaldo · prima vacacional · vacaciones (LFT 76, 80, 87) | completo | `dias_aguinaldo` **sí se lee** (`finiquito-calculator.ts:101`) aunque el panel diga lo contrario | panel: `dias_aguinaldo`, `prima_vacacional_pct` | `finiquito-math.ts:245-337`; `finiquito-calculator.ts:79-176` |
| CFDI 4.0 tipo N + Nómina 1.2 | parcial | **No sella**; régimen `601` clavado y `legal_entities` **no tiene** `tax_regime`; `FormaPago="99"` fijo | quemado | `cfdi-nomina-generator.ts:18-158,102,136` |
| SUA · IDSE | completo | Códigos IDSE de reingreso/baja por verificar contra el formato IMSS | casa | `sua-generator.ts:34-131`; `imss-idse-adapter.ts:25-34,59-149` |
| Vigencia intra-anual UMA/SMG | ausente | UMA vige 1-feb, SMG 1-ene; hoy una fila por año | ley | `008:375-382` |
| Orquestador bruto→neto · calendarios · posteo | completo | — | casa | `paycheck-service.ts:67-402`; `pay-period-service.ts:50-142`; `gl-posting-service.ts:21-175` |
| Liquidación por despido (LFT 48, 50) · PTU · exentos art. 93 · horas extra y prima dominical · ISN estatal · ajuste anual art. 97 y constancias · asimilados | ausente | Todo en la lista ❌ del catálogo | ley | `cli-command-catalog.md:1777,1789-1791` |
| Puertas | inerte | **Sólo REST**; sin CLI (`mnemosine.ts` no tiene nómina — tramo F08, issue #113); el agente «no tiene herramientas de nómina» | — | `src/index.ts:47,238`; `src/ai/docs/payroll.md:29` |

## 6. Nómina Estados Unidos

| Motor | Estado | Regla que debe definirse | Parámetro | Evidencia |
|---|---|---|---|---|
| Registro de motores fiscales (tax-engine) | completo | — | casa | `register-all.ts` |
| Tablas 2026 | completo | Cifras confirmadas contra SSA/IRS: tope SS 184 500; 401(k) 24 500; deducción estándar 16 100 / 32 200 / 24 150 | ley (`009_tax_tables_2026.sql`) | `motores/nomina-us.md` §Fuentes |
| FIT (Pub 15-T) | completo | `filing_status` no validado → silencio-cero para cualquier valor desconocido (no sólo MFS) | ley | `fit-calculator.ts:14,20` |
| FICA SS · Medicare · Additional Medicare · FUTA · SUTA · SIT (51) · SDI/PFL | completo | — | ley | `register-all.ts` |
| Impuestos locales | parcial | Se calculan y **no se persisten** → la casilla 19 del W-2 siempre 0; un local > 0 descuadraría el asiento | ley | `paycheck-service.ts:229,326-336`; `w2-generator.ts:93` |
| Formularios 941 · 940 | inerte | Suman `employer_tax_liabilities`, tabla que **nadie escribe** → declaran cero impuesto patronal (`doctor` lo marca `fail`) | — | `form-941-generator.ts:63`; `form-940-generator.ts:51` |
| W-2 · W-3 · EFW2 | completo | Registro RW desalineado respecto a la especificación SSA 2026 | ley | `w2-generator.ts`; `w3-generator.ts:100` |
| NACHA | completo | Constantes de formato (`094/10/1/PPD`) son casa; datos de la entidad (`200→220`, `BANK`, `PAYROLL`) están **quemados** y son parámetros | quemado | `motores/nomina-us.md` §17 |
| Embargos (CCPA) | parcial | El motor lee `amount_type='percentage'` y el esquema documenta `percent_disposable/percent_gross` → una orden porcentual **retiene 0 en silencio**; la prelación real es `ORDER BY priority` y no la del encabezado; `garnishments` **sin INSERT** en todo el árbol | quemado: FMW 7.25, 25 %, 50-65 %, 15 % | `garnishment-engine.ts:5,15,36,48-49,71,78,94-95,126,136`; `008:427-429` |
| Beneficios (Sec. 125 / 401(k)) | completo | — | ley | `motores/nomina-us.md` §19 |
| 1099-NEC/MISC · calendario de depósitos (semimonthly/monthly, *lookback*) · FLSA (horas extra, salario mínimo) · *new hire reporting* · propinas · imputado (GTL) · pago final por estado · suplementarios (motor sin puerta) · `is_exempt_fit/fica` (sin lectura) | ausente | — | ley | `motores/nomina-us.md` §2 |

## 7. Activos, diferidos e inventarios

| Motor | MX | US | Estado | Regla que debe definirse | Parámetro | Evidencia |
|---|---|---|---|---|---|---|
| Alta de activo fijo | ✓ | parcial | parcial | Semántica mexicana; folio `AF`; no consulta jurisdicción | casa | `asset-service.ts:491,639` |
| Siembra de categorías LISR (31-35) | inerte | — | inerte | Existe y **nadie la llama** | quemado: `CATALOGO_LISR` | `asset-service.ts:100-153,174` |
| Depreciación (6 métodos) · corrida mensual · plan · posteo | ✓ | parcial | parcial | MACRS sólo *half-year*, `macrs_class` nunca escrito, desalineada del ejercicio; **un solo libro** (sin libro fiscal separado); `status` nunca llega a `fully_depreciated` y contradice al plan; tasa fiscal no gobierna la vida | panel: `base_depreciacion`, `convencion_primer_mes`, `depreciacion_faltante_al_cierre` | `motores/activos-inventario.md` §3-4 |
| Actualización fiscal por INPC (LISR 31) | ✗ | — | ausente | — | ley | id. |
| Inventarios (NIF C-4 / ASC 330; LIFO sólo US) | ✗ | ✗ | ausente | Cascarón de esquema sin escritor; método de costeo es decisión del despacho | panel (futuro): `metodo_costeo_inventario` | id. §6 |
| Intangibles (NIF C-8 / ASC 350) · Deterioro (NIF C-15 / ASC 360) · Baja y enajenación (LISR 37) | ✗ | ✗ | ausente | Cascarones de esquema sin escritor | — | id. §7-9 |
| Arrendamientos (NIF D-5 / ASC 842) | ✗ | ✗ | **fuera del censo** | Ningún subsistema los cubre; se anota como hueco del propio inventario | — | — |

## 8. Integraciones y verificación pública

| Motor | Estado | Regla que debe definirse | Evidencia |
|---|---|---|---|
| Registro de adaptadores, bóveda, cortacircuitos, reintentos, enrutador multi-PAC | completo | `sovosReachcoreAdapter` vive en el router y no en el registry | `motores/integraciones-y-publico.md` §1-4 |
| PAC | parcial | 1 real, 3 simulados; recuperación del timbre ante error 311 ausente; prevalidación local y ventana de 72 h ausentes; alta del RFC ante el PAC / LCO ausente | id. §5-6 |
| Pasarelas (Stripe, Conekta) | parcial | El motor que separa comisión e IVA aparcado en 1135 **ya existe** (`contabilizarComisiones`, `treasury-posting.ts:786-911`); falta cablearlo a la pasarela y llevar la tasa al panel; webhooks entrantes sin HMAC ni tipo de pasarela (`/v1/ai/webhooks`); `integration_events` enterrada (038) | id. §7, §19 |
| Almacenamiento y conservación | parcial | Mayor inmutable (041/058) y `audit_log` sólo-agrega (033) ya son controles de integridad; los XML viven en `xml_documents.xml_content`; S3 huérfano; falta la **política de horizonte** (CFF 30: 5 años · IRS: 3-7) y el WORM de documentos; NOM-151 ausente | id. §8 |
| Contalink (exportación) | completo | UUID↔póliza no viaja en la exportación | id. §9 |
| Hash canónico, atestación, sello de periodo, publicación de agregados, anclaje (BTC/EVM/zkVerify) | inerte | Todo `simulado = true`; verificación pública apagada por omisión y rechaza filas simuladas; recibo firmado re-verificable (Grigg) ausente; opt-in y aviso de privacidad para publicar ausentes | id. §10-16 |
| Webhooks salientes y guardián SSRF | completo | — | id. §17-18 |

## 9. Banca y tesorería

| Motor | MX | US | Estado | Regla que debe definirse | Parámetro | Evidencia |
|---|---|---|---|---|---|---|
| Lectura de estados de cuenta | ✓ | parcial | parcial | CSV (3 perfiles MX + genérico), CAMT.053 y MT940; **OFX/QFX/BAI2 declarados `pendiente` sin lector**; fecha ambigua → DD/MM (convención MX); sin perfil nativo de ningún banco US; `bank format *` es fase 2 aunque los mensajes del código lo nombren | quemado: lista de monedas, `BISAGRA_SIGLO` | `parsers/index.ts:53-120`; `perfiles-csv.ts:197-202`; `fecha.ts:148-158`; `importe.ts:51`; `csv.ts:209` |
| Importación del extracto como documento | parcial | parcial | parcial | Se guarda `file_sha256` y **no los bytes** (`bank_statements` sin BYTEA); `raw_data` conserva la fila parseada; no basta para CFF 28/30 ni para `bank statement apply` (fase 2) | casa: lotes 200/200/50 000 | `bank-statement-service.ts:84-95,493-497,585-596,730`; `051:122-160` |
| Siete pruebas de integridad del extracto | ✓ | ✓ | completo | `DIAS_REVERSO=5` sin bandera CLI | casa | `statement-checks.ts:50-58,135,142,197` |
| Cuenta bancaria como dato maestro | ✓ | parcial | parcial | CLABE ✓ y ABA ✓; c_Banco sólo regex de 3 dígitos (**sin catálogo**); IBAN sin mod-97; una sola columna de routing (ACH ≠ wire rechazado); `bank account archive` nombrado e inexistente | casa | `bank-account-service.ts:79-117,154-184,800-870,990-992` |
| Movimientos y partidas de libros | parcial | parcial | parcial | `CAMPOS_SIN_EXTRACTOR`: clave de rastreo SPEI, número de cheque del banco, *trace number* — nadie los extrae y `bank_transactions` no tiene columna | — | `transactions.ts:97-111` |
| Motor de cotejo | ✓ | ✓ | completo | *Stopwords* en inglés y normalización `a-z0-9` (sin acentos); ventanas y bandas quemadas; el panel (`cotejo_*`) sólo se lee en la ruta REST `auto-match` | panel (parcial), quemado: 3 días, 5/10/1 %, .45/.25/.30, 0.75 | `matching.ts:90-99,174,204,233-236,268-306,373-374,587-588` |
| Cotejo como hecho (grupos N:M, Σ, sello, desaplicación) | ✓ | ✓ | completo | **La CLI `bank match preview\|run` no lee el panel**: usa su propio 0.85 y su propio 50 000 (`opts ?? CONSTANTE`); una política decidida en `pending` no llega a la terminal. `bank match approve --force` nombrado e inexistente | quemado: `CONFIANZA_POR_OMISION 0.85`, `VENTANA_DIAS 3` | `match-service.ts:114,117,127,997,1003-1004`; `bank-command.ts:3184-3185` |
| Sesión de conciliación | ✓ | ✓ | completo | La ruta REST heredada abre sesiones con `beginning_balance 0`; `--format pdf\|xlsx` rechazado; la opción `suspenso` de `linea_banco_sin_partida_al_cierre` bloquea hasta F05d | panel | `reconciliation-service.ts:128,1215-1225`; `bank-reconciliation.ts:247-300`; `bank-command.ts:5106-5121` |
| Aritmética de dos lados | ✓ | ✓ | completo | — | casa (CHECK en 054) | `reconciliation-math.ts:53-84,255,386`; `054:39,67` |
| Partidas conciliatorias | ✓ | ✓ | completo | Sin umbral de días **a propósito**; lo que falta es la **clave del panel** que reciba los plazos (LGTOC en MX; *stale-dated* / *escheatment* en US) | panel (futuro) | `reconciling-items.ts:90-129,385,664-701` |
| Ajustes de conciliación (borradores) | ✓ | parcial | completo | Tipos `comision, iva-comision, interes, isr-retenido, error` (vocabulario fiscal MX); sin NSF / *returned item* / *late fee*; el criterio 1130 vs 1135 vive en un comentario | quemado | `reconciliation-adjustments.ts:53,75-93,100-119,149`; `054:135-136` |
| Comisiones bancarias con IVA aparcado | ✓ | parcial | completo | `--iva-rate` obligatorio por corrida (la tasa no viene de tabla); **sin compuerta de jurisdicción**; **el 1135 de una comisión nunca se libera** (`bank fee apply` no existe y ningún camino de ingesta lo alcanza); el aviso sobre el CFDI se imprime aun con tasa 0 | ley (tasa) | `treasury-posting.ts:29-30,294-323,885-913`; `bank-command.ts:5252-5257,5290,5367-5372` |
| Intereses ganados y retención de ISR | parcial | parcial | parcial | Modelo = fracción del interés (`bruto = neto/(1−tasa)`), no LIF art. 21 (tasa anual sobre capital); tasa por corrida, ninguna fila en `tax_tables`; modo `importes` sin puerta (salvo `bank adjustment create --type isr-retenido`); US: sin 1099-INT ni *backup withholding* | ley | `treasury-posting.ts:245-267,1165-1170`; `bank-command.ts:5405-5413,5439,4491-4512` |
| Cobro de cheque y reclasificación del IVA (LIVA 1-B 2.º párr.) | inerte | — | inerte | `conciliarCheque` reclasifica **cero** porque el pago ya liberó el IVA en su fecha; su compuerta es `entityUsesCashBasisIva` (borde nulo → no MX), divergente de `pais-contable.ts` | — | `treasury-posting.ts:1274-1279,1360-1370,1459`; `iva-cash-basis.ts:300-311` |
| Rutas REST heredadas | parcial | parcial | parcial | Import con dedupe débil; *match* manual sin grupo, Σ ni sello; `complete` → 501 | — | `bank-reconciliation.ts:103-144,163-244,360-369` |
| Pisos irrompibles | ✓ | ✓ | completo | `FLOOR_MAX_AUTO_POST = 50 000` en **moneda funcional**; `FLOOR_MAX_TOLERANCIA_CONCILIACION = 500` en **la moneda de la cuenta**: ninguno sabe de jurisdicción; 500 MXN y 500 USD difieren un orden de magnitud | casa | `src/ai/floor.ts:36-39,108-114` |
| **Faltantes US** | | | ausente | OFX/BAI2; perfiles de bancos US; revaluación FX al cierre (ASC 830 — la fase *realizada* existe en `moneda-origen.ts` y banca no la usa); NSF / *returned items*; *positive pay* / *stop payment*; *escheatment*; 1099-INT; arqueo de caja chica | | `motores/banca.md` §3 |
| **Faltantes MX** | | | ausente | Catálogo c_Banco; extractor de clave de rastreo SPEI; constancia/CFDI de intereses (ingesta y cotejo); liberación del 1135 de comisiones; LIF 21 en `tax_tables`; plazos LGTOC como clave del panel; bytes del extracto (CFF 28/30); cheque nominativo (LISR 27-III) sin campo | | `motores/banca.md` §4 |

## 10. Clientes y proveedores

| Motor | MX | US | Estado | Regla que debe definirse | Parámetro | Evidencia |
|---|---|---|---|---|---|---|
| Facturación a clientes | parcial | parcial | parcial | No valida el perfil fiscal del receptor antes de emitir; el XML de timbrado es mínimo; sin *sales tax*; el ingreso se reconoce al 100 % a la fecha (sin NIF D-1 / ASC 606 diferido); el límite de crédito «deliberadamente ausente»; AR en moneda extranjera **rechazado** (`FX_AR_NOT_WIRED`); `POST /:id/void` desliga libros y SAT | quemado: `'USD'`, prefijos `INV/PMT/BILL/VPMT/CN`, PUE por omisión | `invoice-service.ts:357,450,687-694`; `ar-ap-posting.ts:133-173`; `routes/invoices.ts:228-288` |
| Padrón de clientes y perfil fiscal CFDI 4.0 | ✓ | ✓ | completo | RFC sólo por forma (sin dígito verificador); régimen↔UsoCFDI sin cruce; saldo a fecha existe (`customer show --as-of`) | quemado: `'Net 30'`, `'USD'` | `customer-service.ts:138-157,412-434,583,666-699` |
| Notas de crédito a clientes | parcial | parcial | parcial | `credit_notes.cfdi_uuid` sin escritor; el tipo `anticipo` no tiene asiento propio (el plan TipoRelacion 07 está **escrito en la taxonomía sin ejecutor** del lado emitido); sin `void`; sin nota de cargo | quemado | `credit-note-service.ts:41,295`; `ar-ap-posting.ts:359-385`; `cfdi-taxonomy.ts:189-201,289-300` |
| Cobranza (cobro, saldo a cuenta, aplicación, desaplicación, NSF) | ✓ | ✓ | completo | El IVA sobre el anticipo va íntegro a `anticipo_clientes`; la comisión NSF se rechaza aunque el motor exista en banca; c_FormaPago→`payment_method` sólo **SAT→interno** (falta el inverso; `wire`/`ach` sin clave); fecha contable `new Date()`; `'MXN'` por omisión en pagos sin documento frente a `'USD'` en documentos | quemado | `payment-service.ts:686-688,1278-1287`; `ar-ap-posting.ts:558-565,682,903,965`; `rep-linkage.ts:67-84` |
| Liberación del IVA en flujo (transversal AR/AP) | ✓ | — | completo | Compuerta `entityUsesCashBasisIva` (borde nulo → no MX); el reparto proporcional del IVA del pago corto es criterio en código | quemado: `CONSERVATIVE_METODO`, `SCALE 4` | `ar-ap-posting.ts:440-513,797-799`; `iva-cash-basis.ts:64-67,300-311` |
| Padrón de proveedores | ✓ | parcial | completo | Tipo de identificador por país (**única bifurcación explícita del subsistema**); sin dígito verificador; W-9/TIN ausentes; 69-B: `ValidacionEFOS` se captura y nadie lo lee; cambio de cuenta bancaria sin segunda firma | quemado | `vendor-service.ts:46-70,403-424`; `sat-validation.ts:51` |
| Facturas de proveedor | parcial | parcial | parcial | Sin **cálculo** de retención (la que trae el CFDI sí se postea); LISR 27-III sólo en la ingesta (`efectivo_no_deducible`, umbral quemado 2 000), no en `approveBill` ni en el pago; descuento por pronto pago sobre base **con** IVA (LIVA 7); nota de crédito de proveedor sólo como plan; sin *use tax*, 1099, `bill void`; *three-way match* sólo columna | quemado | `bill-service.ts:41-43,300-338,357,591-601`; `cfdi-decisions.ts:93-94,209-227`; `002:73` |
| Pagos a proveedor | ✓ | ✓ | completo | Descuento tomado íntegro a `devolucion_compras` (bruto vs neto: decisión sin clave, aunque el rol ya es parámetro de la firma); `payment void\|unapply` inexistentes; diferencia cambiaria realizada ✓; NACHA/cheque ausentes | quemado: `tasaPago ?? '1.0'` | `ar-ap-posting.ts:733,1171-1178`; `payment-service.ts:405,681,1440-1457` |
| Aplicación posterior y pago corto | ✓ | ✓ | completo | `pago_corto_residual` leído; `prohibir` exige CFDI de egreso | panel | `payment-service.ts:1525-1541`; `ar-ap-posting.ts:726-748` |
| Control auxiliar CxC · cuadre CxP | ✓ | ✓ | completo | Sólo HOY (no a fecha de corte); **el cierre no los llama**; `ap check` inexistente; condonación no guardada por gasto | casa: 0.01, 0.005, 30 días | `ar-controls.ts:18-26,99-144,263`; `ap-controls.ts:64-73,365-403` |
| Antigüedad de saldos | parcial | parcial | parcial | Envejece sobre `amount_due` actual; la reconstrucción a fecha **ya existe** (`invoice list --as-of`, `customer show --as-of`) y no está cableada al *aged*; cubetas sólo en CLI | quemado | `report-service.ts:856-867`; `invoice-service.ts:168-179`; `report-command.ts:722-728` |
| Estimación de incobrables y castigo (NIF C-3 · ASC 326) | ✗ | ✗ | ausente | `uncollectible` sin escritor; sin contra-cuenta en el catálogo ni rol | — | `customer-service.ts:45`; `chart-seed.ts:44-82` |
| Cobranza operativa | parcial | parcial | parcial | Recordatorios ✓ (`checkArReminders`); `dunning_profile_id` sin tabla; nadie escribe `overdue`; sin intereses moratorios ni *late fees* | — | `wake-gate.ts:198-215`; `002:178` |
| **Faltantes US** | | | ausente | *Sales tax* en factura; ASC 606 diferido; W-9/TIN/*backup withholding*; 1099-NEC/MISC; *use tax*; *three-way match*; NACHA/cheques; CECL; límite de crédito vivo; *escheatment* de saldos a favor; *late fees*; ASC 830 no realizado; *dunning*; estado `overdue` | | `motores/cxc-cxp.md` §3 |
| **Faltantes MX** | | | ausente | Cálculo, perfil y entero de retenciones; LISR 27-III fuera de la ingesta y en el panel; c_FormaPago inverso; ejecutor del CFDI de anticipo emitido; incobrables NIF C-3 / LISR 27-XV; DIOT; CFDI de egreso para notas; emisión del REP; LIVA 7 en descuentos; escrutinio 69-B; cancelación por REST desligada del SAT | | `motores/cxc-cxp.md` §4 |

---

## Lo transversal, en tres frases

1. **Casi todo lo que existe es mexicano en semántica y universal en código**: los motores no preguntan la jurisdicción; la única pregunta (`esContabilidadMexicana`) la hacen dos sitios al sembrar y tres copias divergentes la repiten. Estados Unidos tiene nómina completa y poco más: sin catálogo fiscal propio, sin *sales tax*, sin 1099, sin impuesto de la entidad.
2. **La ley vive en dos sitios equivocados**: en tablas indexadas por año (nómina) y quemada en código (IVA, LISR 27/28/31-35, FLSA, CCPA). Lo que cambia por fecha necesita vigencia; lo que hoy falla abierto (IMSS, INFONAVIT, embargos, locales) debe fallar cerrado.
3. **El panel gobierna criterio pero no sabe de países**: 39 claves sin dimensión de jurisdicción, catorce que no aplican a US y cuatro denominadas en pesos. El diseño que lo resuelve está en [`docs/jurisdicciones.md`](../../jurisdicciones.md).
