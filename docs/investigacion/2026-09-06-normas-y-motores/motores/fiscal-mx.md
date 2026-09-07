# Inventario verificado de motores — subsistema «fiscal-mx»

**Método.** El inventario original lo escribió un lector de código sobre `9da663b` (lectura completa de los 14 archivos de `src/services/xml-ingestion/`, los dos de IVA en `src/services/accounting/`, `src/services/sat/cfdi-status.ts`, `src/services/fiscal-credentials/` y `src/services/vault/`, más `grep` sobre `src/`, `scripts/`, `tests/` y `docs/` para puertas, consumidores y ausencias) y lo verificaron dos pasadas escépticas independientes sobre `812a43c`, que abrieron cada `archivo:línea`, buscaron cada «ausente» bajo otros nombres y comprobaron que ningún «quemado» viniera de `tax_tables` (`009_tax_tables_2026.sql`) ni del panel (`src/services/policy/pending-catalog.ts`, 39 claves). Esta fusión se hizo contra HEAD `4b1d8fe` de la rama `investigacion/normas-y-motores`; `git diff --stat 9da663b..4b1d8fe` sobre los directorios del subsistema está vacío, así que las líneas citadas son las del árbol actual (se volvieron a abrir las que el escéptico corrigió).

**Subsistema.** `src/services/xml-ingestion/` (parser CFDI, hechos, taxonomía, decisiones, clasificador, plan de asiento, pre-registro, motor de reglas, REP, catálogos SAT, siembra de roles), `src/services/accounting/iva-cash-basis.ts`, `src/services/accounting/iva-ppd-reclass.ts`, `src/services/sat/`, `src/services/fiscal-credentials/`, `src/services/vault/`. Rutas relativas a `/Users/victor/projects/Accounting`.

**Vocabulario.** Estado: `completo` (existe, tiene puerta CLI/REST/agente y hace lo que dice) · `parcial` (existe con huecos nombrados) · `inerte` (motor sin puerta, o con puerta que no escribe nada) · `ausente` (no hay motor bajo ningún nombre; se buscó por `grep`). Parámetro: `ley` (debería estar en tabla con vigencia) · `panel` (criterio del despacho, `pending-catalog.ts`) · `casa` (constante del motor) · `quemado` (ley o criterio escrito en código, que es lo que hay que mover). Los veredictos del escéptico se aplican tal cual: lo que corrigió va corregido, lo que refutó va eliminado y §6 dice qué no creerse del original.

**Resultado en una línea.** 25 motores: 11 completos, 7 parciales, 2 inertes, 5 ausentes. Todo lo que existe es mexicano en semántica; la única pregunta de jurisdicción la hace un archivo y dos copias divergentes; ningún parámetro fiscal de este subsistema vive en `tax_tables` ni tiene dimensión de jurisdicción en el panel.

---

## 0. Cómo ve la jurisdicción este subsistema

- **Un solo conmutador, tres redacciones.** `esContabilidadMexicana` (`src/services/accounting/pais-contable.ts:35-44`): `accounting_standard = 'mx_nif'` → México; país nulo, vacío o `MX` → México; sólo un país declarado distinto de MX saca a la entidad del estrato. Los dos consumidores del subsistema **no lo llaman**: `entityUsesCashBasisIva` (`iva-cash-basis.ts:300-311`) e `iva-ppd-reclass.ts:101` repiten `incorporation_country = 'MX' OR accounting_standard = 'mx_nif'`, que devuelve **false** para país nulo y norma nula donde `pais-contable.ts:41-44` devuelve **true**. No es duplicación: es divergencia en el borde, y `pais-contable.ts:2-12` confiesa en su cabecera que nació para unificar cuatro sitios que «difieren en los bordes».
- **La siembra de cuentas pregunta; el resto no.** `seedAccountRoles` recibe `esMexicana` con omisión `true` (`account-roles-seed.ts:385`) desde el alta de entidad (`entity-accounting.ts:4,158`). Todo lo demás es mexicano sin preguntar: el parser sólo acepta raíz `Comprobante` (`cfdi-parser.ts:109-112`), el RFC se valida con expresión mexicana (`:301`), «moneda extranjera» significa distinta de MXN (`cfdi-facts.ts:169`), y el proveedor que nace de un CFDI nace con `currency_code = 'MXN'` y `tax_id_type = 'rfc'` (`pre-registration-service.ts:1081-1082`, `:353`).
- **Ni tabla ni panel con jurisdicción.** `009_tax_tables_2026.sql` sólo carga `('US-FEDERAL','fit')`, `('MX','isr')`, `('MX','subsidio_empleo')`, `('US-NY','sit')`, `('US-CA','sit')` y el bloque `params` de MX (`:38-60`: UMA, salarios mínimos, IMSS); `grep -niE "iva|efectivo|restaur|0\.085"` sobre el archivo → nada; los únicos lectores son de nómina (`src/services/payroll/tax-engine/tax-tables.ts:25,66`). Las 39 claves del panel (`pending-catalog.ts:50-1055`) son planas por inquilino/entidad; las que lee este subsistema: `umbral_capitalizacion_mxn` (:186), `politica_restaurantes` (:208), `tratamiento_ieps` (:229), `lleva_inventarios` (:250), `cfdi_periodo_cerrado` (:271), cinco `rep_*` (:302-401, :733), dos `efirma_*` (:760-806), dos `ingest_*` (:808-859), dos `rep_faltante_*` (:861-911). **Ninguna** para el límite de efectivo, la tasa de restaurante, las tasas de IVA, la regla conservadora de MetodoPago, el «asume ISR», las tolerancias, `is_high_value`, Net 30 ni el mapa c_FormaPago.
- **Lo que le pasa a una entidad US aquí.** La puerta **por documento** (`POST /v1/xml/upload`, `mnemosine ingest`) muere en `cfdi-parser.ts:111` con cualquier XML que no sea `Comprobante`; la puerta **manual** de facturas de proveedor sí existe para cualquier jurisdicción (`POST /v1/bills`, `src/api/rest/routes/bills.ts:120`; `mnemosine bill create`, `src/cli/bill-command.ts:17`; `createBill`, `src/services/ap/bill-service.ts:340`) y el CHECK de `pre_registrations.source_type` admite `manual|api|recurring|import` (`005_xml_ingestion.sql:149-151`). Recibe el estrato neutro 2135/1136 (`account-roles-seed.ts:335-338`; `chart-seed.ts:123-127`); los pagos postean el `tax_amount` que traiga el documento (`ar-ap-posting.ts:118-120,198-200`); sin CFDI, entidad no mexicana → `iva_acreditable` sin flujo (`pre-registration-service.ts:821-901`). No hay sales tax, 1099, W-9 ni deducibilidad IRC (§3).

---

## 1. Motores

### M1 · Parser CFDI (`src/services/xml-ingestion/cfdi-parser.ts`) — **parcial**, MX

**Reglas implementadas**
- Acepta sólo raíz `Comprobante` y versiones 3.3 / 4.0 (`:109-122`; lanza en `:112` y `:121`) — Anexo 20 RMF. Con `removeNSPrefix: true` (`:101`) una constancia `retenciones:Retenciones` se convierte en `Retenciones` y muere en `:111`.
- Extrae cabecera, `Emisor`, `Receptor` (con `DomicilioFiscalReceptor` y `RegimenFiscalReceptor` de 4.0), `Conceptos` con `ObjetoImp` e `Impuestos` por concepto, `Impuestos` globales (`:124-160`, `:195-254`).
- `CfdiRelacionados` con `TipoRelacion` normalizado a dos dígitos (`:179-193`) — c_TipoRelacion.
- Complementos: **sólo** `TimbreFiscalDigital`, `Pagos` y `Nomina` (`parseComplementos`, `:261-289`).
- `validate`: UUID presente, RFC emisor/receptor con regex `^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$` (`:301`), rechazo de NaN/Infinity (`:312-315`), conceptos = subtotal ±0.01 (`:317-324`), subtotal − descuento + trasladados − retenidos = total ±0.01 (`:326-333`).
- `calculateTaxBreakdown`: IVA por tasa 16/8/0 y retenciones ISR (001) / IVA (002) por redondeo de `TasaOCuota*100` (`:338-383`).
- `mapTipoComprobante` I/E/T/N/P (`:385-400`); la letra R se retiró a propósito con la explicación en `:386-391`.

**Reglas por definir (MX)**
- Validación contra XSD del SAT y **verificación criptográfica del sello** (`SelloCFD` contra `NoCertificado`, `SelloSAT` contra `NoCertificadoSAT`) — CFF 29-A, Anexo 20. Hoy `validate` sólo hace aritmética; `:169-173` copia `SelloCFD`/`SelloSAT`/`NoCertificadoSAT` como cadenas (`selloCFD` en `:170`, `selloSAT` en `:171`). `grep -rniE 'xsd|libxml|verifySignature|verificarSello|cadena.?original|xmlsec|xml-crypto' src` → sólo adaptadores PAC (`pac-router.ts:150`, `sovos-reachcore-adapter.ts:199,245,308`), el regex de `camt053.ts:65` y los comentarios de `cfdi-command.ts:174,187` («para verificar el sello **fuera de este sistema**»). Nada verifica el sello de un CFDI recibido.
- Complementos no leídos aunque el resto del subsistema los espera: `ImpuestosLocales` (lo busca `cfdi-facts.ts:269`), `Terceros` (`cfdi-decisions.ts:338`; RMF 2.7.1.13), `ComercioExterior` (`cfdi-taxonomy.ts:235`), `CartaPorte` (`cfdi-taxonomy.ts:368`), `Donatarias`, `INE`, `Leyendas`. `grep -rniE 'ImpuestosLocales|Terceros|ComercioExterior|CartaPorte|Donatarias|Leyendas' src` → sólo esos lectores muertos (`cfdi-facts.ts:269`, `cfdi-decisions.ts:338`, `cfdi-taxonomy.ts:85`, `iva-cash-basis.ts:203-204`) y homónimos ajenos. **Consecuencia verificada:** `extractImpuestosLocales` devuelve siempre `{0,0}`, la decisión `por_cuenta_terceros` nunca aplica, y un CFDI con ISH deja de cuadrar en `cfdi-classifier.ts:108-123` y se bloquea con «A tax complement may not have been read» (honesto; el que no lee es el parser).
- CFDI de retenciones (tipo R, `retenciones:Retenciones` / `retencionpago`) — LISR 76-III, 86-V, 99-III, 106, 116: rechazado en `:111`; la taxonomía lo modela (`cfdi-taxonomy.ts:405-419`) y la tabla admite `cfdi_retencion` (`005_xml_ingestion.sql:14-17`), pero no hay analizador (`grep 'retenciones:Retenciones|retencionpago|cfdi_retencion' src` → `005_xml_ingestion.sql:16`, `cfdi-taxonomy.ts:416`, el comentario del parser).
- Tasa 0 % vs exento: **`xml_documents.total_iva_0` es siempre 0**, verificado en dos puntos. `parseImpuestosList` (`:252`) hace `importe: i['@_Importe'] ? parseFloat(...) : undefined`; con `Importe="0.00"` y `parseAttributeValue: true` (`:102`) el valor es el número 0, falsy → `undefined`; y `calculateTaxBreakdown` (`:359`) exige `&& t.importe` antes de `:363`. `cfdi-facts.ts:221-224` sí usa `t.base`. Consumidores de `total_iva_0`: sólo la escritura (`pre-registration-service.ts:172,188`) y la columna (`005:52`); ningún lector.

**Reglas por definir (US)** — ninguna aplicable al CFDI. Pero **no existe parser alterno** (PDF/OCR, EDI 810, UBL): `grep -rniE '\bocr\b|pdf-parse|tesseract|EDI ?810|\bubl\b|\bx12\b' src` → una cadena de categoría `'ocr'` en `integrations/base/adapter.interface.ts:33` sin implementación; el resto son los generadores W-2/W-3 (PDF de salida). Toda ingesta **por documento** de una entidad US muere en `:111`; la captura manual de facturas de proveedor sí existe (§0).

**Parámetros**
- quemado (ley): cubos de tasa 16 / 8 / 0 por redondeo (`:361-363`); la tasa fronteriza del 8 % es un estímulo por decreto (región fronteriza norte/sur), no una tasa de LIVA: debería ser tabla por vigencia y zona.
- quemado (jurisdicción): expresión del RFC (`:301`) — una entidad US con EIN `NN-NNNNNNN` nunca pasa.
- casa: versiones `'4.0' | '3.3'` (`:120`); tolerancias 0.01 (`:322`, `:331`; el original propone llevarlas al panel `operativa`).

**Puerta:** `processXMLUpload` (`pre-registration-service.ts:136`), `ai/ingest-service.ts:7`, `tests/ai/eval/golden.spec.ts:6`.

---

### M2 · Hechos CFDI (`src/services/xml-ingestion/cfdi-facts.ts`) — **parcial**, MX

**Reglas implementadas**
- Dirección `emitido | recibido | ajeno` comparando RFC de la entidad contra emisor/receptor (`:142-148`).
- Catálogo c_TipoRelacion 01–07 (`:12-20`).
- `pagadoEnEfectivo` = FormaPago `01` (`:117`, `:165`) — insumo de LISR 27-III.
- Moneda extranjera = distinta de MXN y XXX (`:169`).
- Desglose por concepto: IVA 16/8, base a tasa 0 (`:221-224`), importe **exento** por `ObjetoImp = 01` sin traslado (`:206-212`), IEPS 003 (`:225-227`), ISR/IVA retenidos (`:229-234`).
- Fallback al nodo global cuando no hay desglose por concepto (`:238-245`): todo traslado se asume IVA 16 y toda retención se asume **ISR** (`:244`, literal `// no breakdown: assume ISR`).
- Complemento de Pagos 2.0 completo: `Pago` (FechaPago, FormaDePagoP, MonedaP, TipoCambioP, Monto, NumOperacion) y `DoctoRelacionado` (ImpSaldoAnt, ImpPagado, ImpSaldoInsoluto, NumParcialidad, MonedaDR, EquivalenciaDR, ObjetoImpDR) (`:291-331`); IVA de la parcialidad desde `ImpuestosDR/TrasladosDR` sólo impuesto 002 (`:342-359`).
- Anticipo por clave `84111506` o palabra «anticipo» (`:116`, `:373-378`) — Apéndice 6 de la Guía de llenado del Anexo 20.

**Reglas por definir (MX)**
- `ObjetoImp = 03` (sí objeto, no obligado al desglose) y `04`/`05` (CFDI 4.0 rev. 2023) no se distinguen: sólo `01` se trata como exento (`:210`); el comentario `:206` menciona 03 pero el código no lo trata.
- Retenciones locales del complemento `ImpuestosLocales` nunca llegan (M1): `extractImpuestosLocales` (`:268-276`) devuelve siempre `{0,0}`.
- El «asumir ISR» del fallback (`:242-245`) es un criterio quemado sin clave en el panel; debería ser decisión visible o política.
- `EquivalenciaDR`/`TipoCambioP` se leen (`:311`, `:324`) y ningún otro archivo los consume: `grep -rn 'tipoCambioP\|equivalenciaDR\|numParcialidad\|impSaldoAnt\|impSaldoInsoluto\|objetoImpDR' src | grep -v cfdi-facts.ts` → **vacío**. La valuación en moneda extranjera la detiene `rep-linkage.ts:133-147` (M9).

**Reglas por definir (US)** — no aplica: los hechos son del CFDI.

**Parámetros**
- quemado (ley): tasas 16/8/0 (`:216-224`).
- quemado (criterio): «retención global = ISR» (`:244`).
- quemado (jurisdicción): monedas `'MXN' | 'XXX'` (`:169`) presuponen moneda funcional MXN.
- quemado (catálogo): `CLAVE_ANTICIPO = '84111506'` (`:116`), `FORMA_PAGO_EFECTIVO = '01'` (`:117`).
- casa: corte de descripción 500 (`:185`).

**Puerta:** `classifyParsed` (`cfdi-classifier.ts:101`), `procesarREP` (`pre-registration-service.ts:953`), `iva-cash-basis.ts:6` (tipo).

---

### M3 · Taxonomía contable del CFDI (`src/services/xml-ingestion/cfdi-taxonomy.ts`) — **completo** para lo que declara, MX

**Reglas implementadas** (matriz declarativa `(tipo, dirección, condición) → asiento por roles`, `:93-420`)
- Bloqueos: `ajeno` (`:97-107`), `sin_timbre` (`:108-117`) — CFF 29-A fracc. IX.
- I recibido: anticipo a proveedor (`:122-138`), **PPD** con IVA a `iva_pendiente_acreditar` (`:139-160`; LIVA 5-III), **PUE** con IVA a `iva_acreditable` (`:161-183`); IEPS a `ieps_acreditable`, locales a gasto, retenciones ISR/IVA a pasivo (`:147-152`, `:168-172`).
- I emitido: anticipo de cliente (`:188-201`), **PPD** con IVA a `iva_trasladado_no_cobrado` (`:202-221`; LIVA 1-B), **PUE** a `iva_trasladado` (`:222-237`); retenciones que nos hacen a activo a favor.
- E: aplicación de anticipo (TipoRelacion 07) recibido/emitido (`:242-258`, `:288-302`), sustitución 04 sin asiento y revisión humana (`:259-271`), nota de crédito/devolución (`:272-287`, `:303-316`).
- P: `pago_recibido`/`pago_emitido` declarados como descripción, no como camino de posteo (`:321-355`; notas `:331-337`, `:350-353`): el REP postea por la puerta de pagos (M9).
- T: sin asiento (`:360-370`). N emitida: sueldos/ISR/neto (`:375-389`); N recibida: sin asiento (`:390-400`).
- R recibido: retenciones a favor contra ingreso (`:405-419`) — **inalcanzable** mientras no exista parser tipo R (M1).
- `matchCase` por prioridad descendente (`:423-428`).

**Reglas por definir (MX)**
- Nota de crédito **recibida** sobre factura PPD: el asiento va contra `iva_acreditable` (`:280`) y la nota `:283-286` reconoce que debería ir contra `iva_pendiente_acreditar`. El hueco está vivo: en el lado AP no hay servicio de notas de proveedor que lo corrija (`ls src/services/ap` → `ap-controls.ts`, `bill-service.ts`, `vendor-service.ts`); la taxonomía es el único camino. En el lado AR, `credit-note-service.ts:496-507` **sí** bloquea aplicar una nota sin liga sobre factura PPD (`if (metodo.metodo === 'PPD') throw new ValidationError(...)`), pero eso no toca el caso recibido.
- Nota de débito (TipoRelacion 02) y traslados 05/06 sin caso propio: `TIPO_RELACION` define los siete (`cfdi-facts.ts:12-20`) pero la taxonomía sólo prueba `SUSTITUCION` y `APLICACION_ANTICIPO` (`:247,264,293`); 01/02/03/05/06 caen en `egreso_*_nota_credito` (`grep "XAXX\|XEXX\|nota_debito\|'02'\|'05'\|'06'" cfdi-taxonomy.ts` → vacío).
- Exportación (0 % con ComercioExterior) sólo en la nota `:235`; sin complemento leído no hay regla.
- Residentes en el extranjero (`XEXX010101000`) y público en general (`XAXX010101000`, CFDI global RMF 2.7.1.21) no se distinguen; XAXX/XEXX en `src` sólo en `database/seed.ts:41,148,157` y defaults de `cfdi-nomina-generator.ts:105-106`.

**Reglas por definir (US)** — la matriz es del CFDI. No existe matriz equivalente de documentos de venta/compra con **sales tax** (acumulado al facturar); el único gesto es que `iva_trasladado`/`iva_acreditable` apuntan a 2135/1136 en entidad no mexicana (`account-roles-seed.ts:335-338`).

**Parámetros:** ninguno numérico; roles abstractos (`:11-44`), mapa rol→cuenta en `account_roles` (M13). casa.

**Puerta:** `matchCase` desde el clasificador (`cfdi-classifier.ts:102`) y desde `ivaRoleFor` (`iva-cash-basis.ts:227`).

---

### M4 · Decisiones y deducibilidad (`src/services/xml-ingestion/cfdi-decisions.ts`) — **parcial**, MX

**Reglas implementadas** (12 puntos de decisión, `:105-393`)
- `gasto_vs_activo` (bloqueante): umbral de capitalización o prefijos de c_ClaveProdServ de activo fijo (`:107-145`) — LISR 31-38.
- `gasto_vs_anticipado` (consultiva): piso de importe + regex de descripción (`:146-206`) — NIF A-2 / A-4.
- `efectivo_no_deducible` (bloqueante): efectivo > 2 000 (`:209-227`) — LISR 27-III; LIVA 5-I.
- `consumo_restaurante` (consultiva): 8.5 % deducible (`:228-250`) — LISR 28-XX.
- `combustible_efectivo` (bloqueante): prefijo 1510 en efectivo (`:251-266`) — LISR 27-III.
- `cuenta_ambigua`, `anticipo_o_gasto` (Anexo 20 ap. 6), `ieps_acreditable` (LIEPS 4), `por_cuenta_terceros` (RMF 2.7.1.13), `proveedor_nuevo`, `periodo_cerrado` (NIF B-1), `cfdi_cancelado` (CFF 29-A) (`:268-392`). Las 12 citan LISR/LIVA/LIEPS/RMF/NIF (`:141`, `:226`, `:249`, `:265`, `:305`, `:322`, `:340`, `:392`).
- Umbrales inyectables `capitalizationThreshold`, `restaurantPolicy`, `iepsTreatment`, `inventoryPolicy`, `prepaidThreshold` (`:73-92`). **`prepaidThreshold` no se inyecta:** `pre-registration-service.ts:763-768` lee cuatro políticas y `:803-808` pasa exactamente esas cuatro; `umbral_anticipado_mxn` sólo lo leen `prepaid-service.ts:250` y `prepaid-command.ts`. La decisión `gasto_vs_anticipado` (`:193-195`) cae al default 5 000.

**Reglas por definir (MX)**
- LISR 36-II: tope de deducción de automóviles (175 000; 250 000 híbridos/eléctricos) — `gasto_vs_activo` capitaliza sin tope.
- LISR 28-V: viáticos — ausente.
- LISR 27-XVIII / 28-XXX: CFDI del ejercicio y no deducibilidad ligada a fecha — ausente.
- LISR 27-V y 27-XIX: la deducción exige que la **retención se haya efectuado y enterado**; el subsistema lee la retención pero no verifica que exista cuando el emisor es PF 612/606 (`sat-catalogs.ts:28,32`; ningún `612|606` en `cfdi-decisions.ts`).
- CFF 69-B (EFOS): `ValidacionEFOS` llega (`sat/cfdi-status.ts:90,155`) y sólo se guarda en `rawResponse` (`sat-validation.ts:51`); no hay decisión «emisor en lista 69-B».
- `por_cuenta_terceros` exige `f.complementos.includes('Terceros')` (`:338`) que el parser nunca produce (M1).
- `grep -rniE '175[,._ ]?000|250[,._ ]?000|vi[aá]ticos|36-II|28-V\b|69-B|EFOS|IRC ?§|§ ?162|§ ?274|280F|§ ?179' src` → sólo `validacionEFOS` guardado y dos ejemplos de ayuda CLI («1,250,000.50» en `asset-command.ts:152`, `prepaid-command.ts:176`).

**Reglas por definir (US)** — deducibilidad federal (IRC §162 ordinario y necesario; §274 comidas 50 %; §280F automóviles; §179/§168(k)) sin ningún punto de decisión; toda la capa está expresada en LISR.

**Parámetros**
- quemado (ley): `CASH_DEDUCTION_LIMIT_MXN = 2_000` (`:94`) — LISR 27-III; **sin clave en el panel**.
- quemado (ley), **dos veces**: `RESTAURANT_DEDUCTIBLE_RATE = 0.085` (`:96`) y `total * 0.085` / `total * 0.915` en `src/services/policy/policy-preview.ts:143-144`. `politica_restaurantes` (`pending-catalog.ts:208-228`) sólo ofrece `split_85|no_deducible`: la tasa no es configurable en ningún sitio.
- panel con default quemado: `CAPITALIZATION_THRESHOLD_MXN = 20_000` (`:54`; clave `umbral_capitalizacion_mxn` sí llega) y `PREPAID_THRESHOLD_MXN = 5_000` (`:67`; clave `umbral_anticipado_mxn` existe y **no llega**).
- quemado (heurística del despacho): prefijos `ACTIVO_FIJO_PREFIXES`, `RESTAURANTE_PREFIXES`, `COMBUSTIBLE_PREFIXES` (`:99-103`); regex en castellano (`:197`, `:248`, `:282`) — una entidad no hispanohablante no dispara ninguna.
- panel con default quemado: `DEFAULT_THRESHOLDS.restaurantPolicy = 'split_85'`, `iepsTreatment = 'costo'`, `inventoryPolicy = 'directo'` (`:86-92`).

**Puerta:** `decisionsFor` desde el clasificador (`cfdi-classifier.ts:140`).

---

### M5 · Clasificador y plan de asiento (`cfdi-classifier.ts`, `cfdi-posting-plan.ts`) — **completo**, MX

**Reglas implementadas**
- Integridad aritmética con tolerancia 0.05, exento para tipo P (`cfdi-classifier.ts:108-123`).
- Sin caso → `blocked`; caso sin posting → `blocked` (prioridad ≥ 999 o ajeno) o `no_posting` (`:125-136`).
- Decisiones aplicables por hechos + contexto (proveedor nuevo, periodo cerrado, SAT cancelado) (`:138-158`); aviso si no está validado ante SAT (`:155-157`).
- Opción `inventario` sólo con `lleva_inventarios = 'perpetuos'` (`:169-178`).
- Reemplazo de rol de gasto por la respuesta (`:184-185`, `:279-290`); mapa rol→cuenta de `account_roles` con `qualifier IS NULL` (`:66-74`).
- Avisos: descuadre, moneda extranjera, activo fijo sin ficha, anticipados sin calendario, partidas exentas (`:205-250`).
- Veredicto `ready | needs_input | no_posting | blocked` (`:252-254`); ligadura a UUIDs relacionados (`:269-273`).
- Plan: abre la línea de gasto en renglones si cuadra ±0.01 y todos tienen cuenta, si no cuenta genérica con aviso (`cfdi-posting-plan.ts:137-169`); `planContabilizable` exige `ready`, cuentas resueltas y cuadre (`:221-245`).

**Reglas por definir:** ninguna propia; hereda las de M1–M4.

**Parámetros:** casa — tolerancia `'0.05'` (`cfdi-classifier.ts:117`), `0.005` para omitir líneas (`:191`), `'0.01'` de cuadre (`cfdi-posting-plan.ts:147`). Ninguno de los dos archivos lee el panel.

**Puerta:** `planearAsiento` ← `PreRegistrationService.planDeAsiento` (`pre-registration-service.ts:784`); `classifyXml` en pruebas.

---

### M6 · Pre-registro, ingesta y motor de reglas del inquilino (`pre-registration-service.ts`, `rules-engine.ts`) — **completo**, MX

**Reglas implementadas**
- Dedupe **por entidad** por UUID o hash (`pre-registration-service.ts:145-156`; índices `046_el_espejo_del_cfdi.sql:25-30`).
- Espejo `xml_documents` + `xml_document_lines` (`:161-213`); validación SAT asíncrona no bloqueante (`:219-222`).
- Tipo de documento `I → bill`, `P → payment`, resto `credit_note` (`:29-33`).
- Cotejo de proveedor: RFC exacto → trigram > 0.7 → nuevo (`:308-357`).
- Sugerencia de cuenta: proveedor → `sat_code_mappings` → patrón histórico (`:389-436`).
- Motor de reglas: 15 operadores, acciones de cuenta/centro/modo/aprobación/rechazo/etiquetas (`rules-engine.ts:7-50`, `:73-250`); contexto con `is_high_value ≥ 50 000` (`:126`).
- Auto-proceso sólo si `processing_mode='auto'`, válido, sin aprobación y `ready`, y **nunca crea proveedores** (`:237-259`); alta de proveedor sólo con autorización explícita (`:1041-1087`; error `PROVEEDOR_NUEVO_SIN_AUTORIZAR` `:54-78`).
- Políticas del panel inyectadas: `umbral_capitalizacion_mxn`, `politica_restaurantes`, `tratamiento_ieps`, `lleva_inventarios`, `cfdi_periodo_cerrado` (`:763-782`); respuesta contestada del panel = respuesta automática de su decisión (`:769-771`).
- Rastro `cfdi_classifications` escrito antes del veredicto (`:649-655`, `:694-724`).
- Sin CFDI: mismo `decideMetodoPago` conservador y mismo `ivaRoleFor`; entidad no mexicana → `iva_acreditable` sin flujo (`:821-901`).
- REP: liga, no postea (`:925-1032`); ajeno → decisión (`:968-974`). Reproceso de lotes (`:1182-1235`).

**Reglas por definir (MX)**
- `pre_registrations.tax_amount` = `parsed.impuestos.totalImpuestosTrasladados || 0` (`:297`): IEPS y locales quedan dentro de «impuesto» sin separar; `bill_lines.tax_amount` toma el **primer** traslado del concepto (`line.impuestos?.traslados?.[0]?.importe`, `:1130`).
- Vencimiento por regex de `payment_terms` con omisión Net 30 (`:438-447`).
- `sat_code_mappings` sin escritor: `grep -rn sat_code_mappings src scripts` → `CREATE TABLE`/índices (`005:359-375`), un `SELECT` (`:401-406`) y el `warn` de doctor (`ai/doctor-service.ts:264-272`). Ninguna de las 19 rutas de `xml-ingestion.ts` (`:130-781`) la toca; `grep -rniE "satCodeMapping|sat-code-mapping"` → vacío.

**Reglas por definir (US)** — la ingesta entera presupone CFDI: la escritura pone `source_type` literal `'xml_cfdi'` (`:285`) aunque el CHECK admite `manual|api|recurring|import` (`005:149-151`).

**Parámetros**
- quemado (jurisdicción): proveedor nuevo con `currency_code = 'MXN'` y `tax_id_type = 'rfc'` (`:1081-1082`, `:353`) — debería ser la moneda funcional de la entidad.
- quemado (códigos de cuenta): `CODIGO_HEREDADO` 2110 / 1130 / 1135 (`:1257-1261`).
- casa: similaridad `> 0.5` / `> 0.7` (`:331`, `:335`); confianza `0.8` (`:397`) y `Math.min(0.9, 0.5 + freq * 0.1)` (`:430`); `let days = 30; // default Net 30` (`:440`); `is_high_value: … >= 50000` (`rules-engine.ts:126`, importe sin moneda). El original propone panel para los cuatro.

**Puerta:** REST `xml-ingestion.ts:130,370,470,695`; CLI `bill inbox run` (`bill-command.ts:1477,1576`); `mnemosine ingest` vía `ai/ingest-service.ts:111`; `rep reconcile` (`rep-pendientes.ts:145`).

---

### M7 · IVA en base de flujo (`src/services/accounting/iva-cash-basis.ts`) — **completo**, MX

**Reglas implementadas** (LIVA 1-B y 5-III)
- Regla conservadora cuando el documento no trae MetodoPago: emitido → PUE (causa ya), recibido → PPD (no acredita todavía) (`:50-67`).
- Lectura del MetodoPago: fila → CFDI espejado → token `PUE|PPD` en texto libre con delimitadores estrictos (`:76-145`); ambiguo → default.
- Rol de IVA preguntado a la taxonomía con hechos sonda (`:174-239`); pareja pendiente→causado (`:242-244`).
- Prorrateo del IVA liberado como **diferencia de acumulados** para que la última parcialidad libere el resto exacto (`:264-289`).
- Conmutador de jurisdicción (`:295-311`) — copia divergente, §0.
- Aplicaciones vivas: sólo `unapplied_at IS NULL` en cobros (`:456-471`); espejo para pagos (`:479-502`).
- Tope de lo **realmente aparcado** leído del mayor, con doble salto hasta la reclasificación del backfill (`:527-591`); distingue «cero aparcado» de «entidad sin capa semántica» (`:570-589`).
- Conversión FX de los acumulados a la tasa histórica del documento, telescopada (`:646-676`); columnas FX sólo cuando reproducen la cifra (`:690-700`).

**Reglas por definir (MX)**
- LIVA 5-C / 5-V: **acreditamiento proporcional** (factor de acreditamiento) — `grep -rniE 'factor de acreditamiento|5-C|acreditamiento proporcional|actividades mixtas|prorrata' src` → vacío; el subsistema aparca y libera el 100 % del IVA del documento.
- LIVA 1-B segundo párrafo (cheque cobrado): hoy `postVendorPaymentEntry` libera en la fecha del pago; el motor que debería corregirlo existe y es inerte (M7-b).
- TC DOF de la fecha de pago para el IVA acreditable en moneda extranjera: se usa la tasa histórica del documento (`:646-657`); `pending-catalog.ts:733-758` (`rep_moneda_extranjera`) confiesa que el sistema «does not yet tell apart».
- PUE no pagado en el mes → reexpedir como PPD (Guía Anexo 20 / RMF 2.7.1.32): `grep -rniE "reexped|reexpid"` → vacío.
- Determinación mensual del IVA (LIVA 5-D): M23.

**Reglas por definir (US)** — correctamente excluido (sales tax se acumula al facturar). No existe el motor equivalente de sales & use tax (§3).

**Parámetros**
- quemado (criterio contable): `CONSERVATIVE_METODO` (`:64-67`). `grep -n 'getPolicy\|policy' iva-cash-basis.ts` → vacío: el archivo no lee el panel. Es una bifurcación de criterio que la casa manda al panel.
- quemado (conmutador): regla de jurisdicción `:310`, distinta en el borde de `pais-contable.ts:41-44`.
- casa: `SCALE = 4` (`:262`); roles candidatos `ISSUED_IVA_ROLES` / `RECEIVED_IVA_ROLES` (`:69-70`).

**Puerta:** `ar-ap-posting.ts:118-120,198-200,341-359,452-465,634-658,749-774,947`; `treasury-posting.ts:1459`; `payment-service.ts:24`; `credit-note-service.ts:497-507`; `pre-registration-service.ts:839-846`.

---

### M7-b · IVA del pago con cheque al cobro del cheque (`conciliarCheque`, `src/services/banking/treasury-posting.ts:1370`) — **inerte**, MX

Hallazgo del escéptico, no del original. LIVA 1-B segundo párrafo: el pago con cheque se considera cobrado al **cobro del cheque**. Existe un motor con puerta: `conciliarCheque` (`treasury-posting.ts:1370`), invocado desde `bank-command.ts:89,5598`, que prueba el cheque contra el movimiento bancario, escribe el cobro y contabiliza la reclasificación de IVA en el mes del cobro con la aritmética de M7 (`ivaReclassificationsFor`). Su propio comentario (`:1360-1368`) explica que hoy reclasifica **cero**: `postVendorPaymentEntry` ya liberó el IVA en la fecha del pago, `ivaStillParked` devuelve cero, y «cerrarlo del todo pide que el asiento del pago con cheque DEJE el IVA aparcado … y eso se decide en `ar-ap-posting.ts`». Motor con puerta que no escribe nada por el orden de posteo: inerte, no ausente.

**Parámetros:** ninguno propio (usa los de M7).

**Puerta:** `mnemosine bank …` (`bank-command.ts:5598`).

---

### M8 · Reclasificación histórica de IVA PPD (`src/services/accounting/iva-ppd-reclass.ts`) — **completo**, MX

**Reglas implementadas**
- Censo de asientos de gastos PPD cuyo IVA fue a `iva_acreditable` (rol, con red por código 1130/1135) para entidades mexicanas (`:53-111`; filtro `:101`).
- Reclasifica sólo la **parte no pagada** (`saldo/total × importe`, `:187-196`) — LIVA 5-III.
- Asiento de corrección fechado en el periodo del hecho, `source_type = 'iva_reclass'`, idempotente dentro de la transacción (`:213-255`); `locked` nunca, cerrados sólo con `--reabrir` (`:170-177`); atestación posterior al commit (`:263`, `:285-288`).

**Reglas por definir:** ninguna; es un motor de corrección.

**Parámetros:** quemado (códigos de cuenta) `a.code = '1130'` (`:61`) y `'1135'` (`:68`); quemado (conmutador) regla de jurisdicción repetida y divergente (`:101`, §0).

**Puerta:** sólo script — `npm run reclass:iva-ppd` (`package.json:28` → `scripts/reclasificar-iva-ppd.ts:5-8,81,100`). Sin puerta `mnemosine` ni REST (`grep censarIvaPpd src/cli src/api` → vacío).

---

### M9 · REP: ligadura al pago (`src/services/xml-ingestion/rep-linkage.ts`) — **completo** para casar/crear, MX

**Reglas implementadas**
- El REP **nunca postea**: casa con un pago existente o lo crea por la puerta de pagos, que libera el IVA (`:12-35`).
- Idempotencia `(entidad, uuid, índice de nodo Pago)` + índice único (`:107-122`; `036_pagos_rep.sql:48-54`).
- Moneda distinta de la funcional → revisión salvo `rep_moneda_extranjera = 'tc_documento'` (`:126-152`; `:133-147` devuelve `revision` con el texto «La diferencia cambiaria no se calcula todavía»).
- Documentos desconocidos → revisión salvo `rep_documento_desconocido = 'postear_sin_iva'` (`:154-183`).
- Un solo tercero por nodo de pago (`:193-202`).
- Fecha del pago = `FechaPago` del complemento, no la del CFDI (`:59-64`) — LIVA 1-B.
- **Cotejo** del IVA declarado en `ImpuestosDR` contra el prorrateo sobre la factura, con tolerancia del panel (`:210-237`) — LIVA 5-III.
- Búsqueda del pago existente: mismo tercero, importe ± tolerancia, fecha ± ventana, sin CFDI ligado, `completed` y **aplicado** a alguno de los documentos del REP (`:426-471`).
- Casar = anotar `cfdi_uuid`/`cfdi_pago_indice`, sin asiento (`:266-282`); crear sólo con `rep_pago_no_registrado = 'crear_pago'` (`:284-357`).
- Resolución UUID→documento: facturas por `invoices.cfdi_uuid`, gastos vía pre-registro→xml_documents→bills (`:366-415`).

**Reglas por definir (MX)**
- **Emisión** del REP propio (RMF 2.7.1.32 / 2.7.1.35: 5.º día natural del mes siguiente al cobro) — `rep-command.ts:31-33`: «Emitir y corregir REPs (stamp/correct) siguen fuera: dependen del PAC».
- Diferencia cambiaria realizada y TC DOF de la fecha de pago — declarado no computado (`:139-147`; `pending-catalog.ts:733-758`).
- `NumParcialidad` / `ImpSaldoAnt` / `ImpSaldoInsoluto` se leen (`cfdi-facts.ts:306-309`) y no se validan contra el saldo del documento (sin consumidor fuera de `cfdi-facts.ts`, M2).
- REP con `ObjetoImpDR = 01`: el cotejo `:219` es `if (r.ivaTrasladadoDR === undefined) continue;` — un DR sin `ImpuestosDR` (lo normal con ObjetoImpDR=01) salta el cotejo y el prorrateo libera IVA igual. `objetoImpDR` se extrae en `cfdi-facts.ts:312` y no tiene consumidor.

**Parámetros:** panel — `rep_pago_no_registrado`, `rep_tolerancia_importe`, `rep_documento_desconocido`, `rep_ventana_dias`, `rep_moneda_extranjera` (`pending-catalog.ts:302-401,733`; leídos en `:134-285`). casa — omisiones `'0.01'` (`:206`) y `'3'` (`:208`) si el panel no responde. quemado (catálogo) — mapa `FORMA_PAGO` c_FormaPago → `payment_method` con sólo 5 códigos (`:73-79`).

**Puerta:** `procesarREP` (`pre-registration-service.ts:980`) ← REST `xml-ingestion.ts:370` (guarda `invoices:create` para REP emitido, `:383-398`) y CLI `bill inbox run` / `rep reconcile`.

---

### M10 · REP pendientes y cierre (`rep-pendientes.ts`, `period-close.ts`) — **completo**, MX

**Reglas implementadas**
- Pagos a proveedor sobre PPD sin REP (IVA en 1135 no acreditable) y cobros propios sin REP emitido, con método leído del espejo y `desconocido` si no está espejado (`rep-pendientes.ts:36-89`).
- REPs aparcados en `needs_review` y su reproceso idempotente sin crear proveedores (`:99-160`).
- Cierre: casillas `rep-parked` y `rep-missing` acotadas al periodo; bloquean sólo con el literal `bloquear` de `rep_faltante_recibido` / `rep_faltante_emitido` (`period-close.ts:508-575`).

**Reglas por definir (MX)**
- Plazo legal del REP emitido (5.º día natural del mes siguiente) no se calcula: `edad_dias` es informativo (`rep-pendientes.ts:50`). `grep -rniE "d[ií]a natural|quinto d[ií]a"` → sólo prosa «plazo del SAT» (`receipt-command.ts:374`, `rep-command.ts:113`, `period-close.ts:587`, `pending-catalog.ts:884`).
- **Opción muerta:** la firma de `listPagosSinRep` declara `overdueOnly?: boolean` (`rep-pendientes.ts:38`) pero ninguna de las dos consultas lo usa (`:45-92` filtran sólo por `minAmount` y `limit`) y `rep-command.ts:104-108` no lo pasa (`grep overdue src/cli/rep-command.ts` → vacío). Promesa falsa en la firma; refuerza que el plazo no se calcula en ningún sitio.

**Parámetros:** panel — `rep_faltante_recibido/emitido` (`pending-catalog.ts:861-911`; `period-close.ts:559-560`). casa — límites `?? 200` (`:43`), `= 100` (`:99`), `?? 50` (`:133`).

**Puerta:** `mnemosine rep missing list` / `rep reconcile` (`rep-command.ts:85-134`); cierre (`period-close.ts:508`).

---

### M11 · Estatus del CFDI ante el SAT (`src/services/sat/cfdi-status.ts`, `xml-ingestion/sat-validation.ts`) — **completo**, MX

**Reglas implementadas**
- Cliente SOAP real de `ConsultaCFDIService` (público, anónimo, sin e.firma) armado a mano (`cfdi-status.ts:46-115`); reintento 3× (`:113`); expresión impresa con total a 6 decimales y reintento con total crudo ante N-60x (`:117-147`).
- Apagado honesto: `SAT_STATUS_MODE=off` → `DISABLED`, nunca «Vigente» simulado (`:126-136`; `src/config/index.ts:154-159`).
- Mapeo `Vigente|Cancelado|No Encontrado` a los dos vocabularios (`:161-176`); persiste `sat_validation_status`, `sat_estado`, `sat_efecto_cancelacion` (`sat-validation.ts:113-128`; `cfdi-status.ts:227-233`).
- Barrido por entidad: obsoletos primero, lotes de 5, 200 ms (`:191-249`).
- El clasificador recibe el estatus y bloquea con `cfdi_cancelado` (`pre-registration-service.ts:801`, `mapearEstadoSat` `:1239-1248`; `cfdi-decisions.ts:379-392`) — CFF 29-A.

**Reglas por definir (MX)**
- `ValidacionEFOS` (CFF 69-B) se extrae en `:90` y se devuelve en `:155`, y **no se consume**: sólo llega a `rawResponse` (`sat-validation.ts:51`); ningún otro consumidor.
- `EsCancelable` / `EstatusCancelacion` se persisten en `sat_efecto_cancelacion` (`:228-232`) y sólo se **muestran** (`cfdi-command.ts:209-226`, `cfdi-query-service.ts:31,73,103`, `xml-ingestion.ts:320`). La cancelación **con aceptación del receptor** (CFF 29-A cuarto párrafo; RMF 2.7.1.34-2.7.1.38) exige responder en 3 días hábiles y nada lo vigila.
- Reversa de asientos cuyo CFDI se canceló tras contabilizarse: `grep sat_validation_status src` → clasificador **antes** de postear (`pre-registration-service.ts:734-801`) y lecturas; nada reacciona a un `cancelled` posterior. `plan/criterios.ts:2340-2344` lo lista como faltante de E3.2.

**Parámetros:** casa — URL por omisión (`config/index.ts:155-157`), `SOAP_ACTION` (`cfdi-status.ts:46`), `maxAttempts: 3, initialDelayMs: 1000` (`:113`), `staleHours ?? 24` (`:195`), `limit ?? 100` (`:205`), `LOTE = 5` (`:211`), `setTimeout(r, 200)` (`:245`), `BATCH_SIZE = 10` / `DELAY_MS = 1000` (`sat-validation.ts:75-76`).

**Puerta:** `mnemosine cfdi status show --refresh` / `cfdi status sync` (`cfdi-command.ts:201-246`); ingesta asíncrona (`pre-registration-service.ts:220`).

---

### M12 · Catálogos SAT (`src/services/xml-ingestion/sat-catalogs.ts`) — **parcial**, MX

**Implementado:** c_RegimenFiscal (17), c_UsoCFDI (15), c_MetodoPago, c_FormaPago (22), tasas de IVA como cadenas decimales, motivos de cancelación 01-04 (`:22-112`). Declarado «NOT a validation whitelist» (`:17-19`).

**Por definir (MX):** c_ClaveProdServ, c_ClaveUnidad, c_TipoRelacion (vive aparte en `cfdi-facts.ts:12-20`), c_ObjetoImp, c_Impuesto, c_TipoFactor, c_Exportacion, c_Periodicidad/c_Meses (CFDI global); versionado por fecha de publicación. c_CodAgrup (Anexo 24) «no existe en el sistema» (`src/cli/account-command.ts:632,640`; `account-service.ts:519`), y el agrupador tiene **dos columnas** en `accounts` sin catálogo detrás de ninguna: `mx_nif_code` (`001_core_schema.sql:130`, la que escribe `account-service.ts:455`) y `codigo_agrupador_sat` (`037_etiquetado_que_encarece.sql:28`).

**Parámetros:** quemado (ley) — `IVA_RATES` (`:99-103`) repite 16/8/0 por tercera vez; quemado (catálogo) — todo el archivo es dato sin tabla ni vigencia; motivos 01-04 (`:106-111`) duplicados en `invoices.ts:311`.

**Puerta:** `customer-service.ts:8` y `tests/api/routes/withdrawn-endpoints.spec.ts:191`. Nadie **del subsistema** lo consume para validar; fuera de él, `customer-service.ts:677-692` **sí** valida `tax_regime` contra `REGIMEN_FISCAL` y `uso_cfdi` contra `USO_CFDI` con `ValidationError`.

---

### M13 · Siembra de cuentas y roles del estrato fiscal (`src/services/xml-ingestion/account-roles-seed.ts`) — **completo**, ambas (única pieza con conmutador)

**Reglas implementadas**
- 23 cuentas requeridas por la taxonomía (`:29-231`) y mapa rol→código (`:237-282`).
- Separación MX/no-MX: `CODIGOS_FISCALES_MX` (10 códigos, `:300-311`), `ROLES_FISCALES_MX` (12 roles, `:319-332`), `ROLES_NEUTROS` `iva_trasladado → 2135` e `iva_acreditable → 1136` (`:335-338`); `cuentasRequeridasPara` / `rolesPara` (`:341-363`); siembra idempotente (`:376-435`).
- Coherente con `chart-seed.ts`: `CATALOGO_UNIVERSAL` (`:44`), `ESTRATO_FISCAL_MX` (`:92`), `ESTRATO_FISCAL_NEUTRO` (`:123-127`), `catalogoBasePara` (`:141-144`).

**Por definir (US):** el estrato «neutro» es una cuenta de sales tax por pagar y una de impuesto acreditable sobre compras; no hay `ESTRATO_FISCAL_US` ni `ROLES_FISCALES_US` (sales tax por estado/jurisdicción, use tax accrual, 1099 reportable, backup withholding payable).

**Parámetros:** casa — todos los códigos de cuenta; `esMexicana ?? true` (`:385`). quemado (criterio) — las dos retenciones y el ISR de nómina comparten 2140 (`isr_retenido_por_pagar: '2140'`, `iva_retenido_por_pagar: '2140'` `:261-262`; `isr_nomina_por_pagar: '2140'` `:273`).

**Puerta:** `entity-accounting.ts:4,158`, `account-command.ts:31`, `npm run backfill:account-roles` (`package.json:29`).

---

### M14 · Custodia de la e.firma (`src/services/fiscal-credentials/service.ts`, `certificate.ts`) — **completo** como custodia, MX

**Reglas implementadas**
- Parseo DER/PEM con node-forge, RFC del subject, clasificación e.firma vs CSD por `keyUsage` (`certificate.ts:56-99`); desencriptado PKCS#8 3-KeyTripleDES (`:125-134`); verificación del par por módulo RSA (`:112-122`).
- `storeCredential`: **rechaza CSD** (`service.ts:108-113`), verifica par, vigencia, RFC = entidad (`:114-145`); una activa por entidad (`:164-168`); consentimiento versionado (`:21-44`, `:174`).
- Revocación = destrucción criptográfica + auditoría (`:344-385`).

**Reglas por definir (MX)**
- **Custodia del CSD** para sellar CFDI propios (CFF 29-II): rechazado por diseño (`:108-113`) aunque `CHECK (credential_type IN ('efirma', 'csd'))` lo admite (`014_fiscal_credentials.sql:13-14`) y el único PAC no simulado exige XML **ya sellado** (`docs/wiki/Fiscal-mexicano.md:19`).
- Ventana horaria para `bloquear_fuera_horario` «mientras la ventana horaria no exista» (`:250-252`).
- Aviso de caducidad (la e.firma dura 4 años): sólo `days_to_expiry` informativo (`:339`).

**Reglas por definir (US):** no hay tipo de credencial para IRS e-Services / TCC (FIRE/IRIS) ni portales estatales: `credential_type` sólo `efirma|csd` (`014:13-14`); `SecretContext.kind` es libre (`vault/types.ts:18-23`) pero el servicio sólo escribe `kind: 'efirma'` (`:151`) y el literal `'efirma'` en el INSERT (`:161-170`).

**Parámetros:** panel — `efirma_max_accesos_diarios`, `efirma_accion_anomalia` (`pending-catalog.ts:760-806`; `service.ts:259-264`). casa — `CONSENT_VERSION = '2026-08-1'` (`:21`), `unattendedAccess ?? true, maxDailyAccess ?? 24` (`:183`), `purpose: 'sat_auth'` (`:195`), ventana `INTERVAL '24 hours'` (`:255`), tope `Math.min(500, …)` del log (`:392`). quemado (jurisdicción) — regex RFC (`certificate.ts:83`).

**Puerta:** `mnemosine sat cred add/status/audit/revoke` (`sat-commands.ts:70-286`; `add` exige `--live` y teclear `accept`, `:163-185`).

---

### M14-b · Uso de la e.firma: autenticación ante el SAT (`withCredential`, `privateKeyToPem`) — **inerte**, MX

`withCredential` (`service.ts:207-305`) es la única vía de descifrado: bitácora siempre; deniega expirada, desatendida no permitida, techo diario = mín(credencial, `efirma_max_accesos_diarios`); reacción por `efirma_accion_anomalia` (`:230-279`); zeroize en `finally` (`:300-304`). `privateKeyToPem` (`certificate.ts:137-139`) deja la llave «ready for signing (XML-DSig of the SAT token)». **Ninguno tiene llamador productivo:** `grep -rn "withCredential\|privateKeyToPem\|sat_auth" src scripts | grep -v fiscal-credentials/` → sólo dos comentarios (`config/index.ts:151`, `cfdi-status.ts:11`). El propósito declarado de la custodia (`service.ts:26-28`: autenticar la descarga masiva) no existe (M20). Motor sin puerta: inerte.

**Parámetros:** los de M14.

**Puerta:** ninguna.

---

### M15 · Bóveda de secretos (`src/services/vault/`) — **completo**, neutral

**Implementado:** interfaz `put/get/destroy/healthCheck` con contexto tenant/entidad/kind (`types.ts:18-54`); AWS Secrets Manager con nombre determinista, tags, `ForceDeleteWithoutRecovery`, comprobación de que el ARN contiene el nombre del contexto (`aws-secrets-manager.ts:53-158`); bóveda local AES-256-GCM con AAD del contexto, llave 0600, rechazo en producción (`local-dev.ts:21-148`); fábrica por `VAULT_BACKEND` (`index.ts:31-57`).

**Por definir:** `kms-envelope` anunciado como futuro (`types.ts:7-8`). Nada jurisdiccional.

**Parámetros:** casa — `MAX_SECRET_BYTES = 65_536` (`aws-secrets-manager.ts:29`), el único fijo. El prefijo (`process.env.VAULT_PREFIX` con omisión `mnemosine/<NODE_ENV>`, `index.ts:40`) y el directorio (`opts.dir ?? path.join(process.cwd(), '.mnemosine-vault')`, `local-dev.ts:42`) son **omisiones configurables**, no quemados (el original los contaba como quemados; §6).

**Puerta:** `getVault()` desde `fiscal-credentials/service.ts:147,281,358` y `sat-commands.ts:7`.

---

### M16 · IEPS — **parcial** (sólo lectura y decisión), MX

**Implementado:** lectura del traslado 003 por concepto (`cfdi-facts.ts:225-227`); roles `ieps_acreditable` / `ieps_por_pagar` (`cfdi-taxonomy.ts:30`, `:147`, `:168`, `:213`, `:232`); decisión `ieps_acreditable` con base LIEPS 4 (`cfdi-decisions.ts:307-323`); política `tratamiento_ieps` inyectada como respuesta (`pre-registration-service.ts:766,771`; `pending-catalog.ts:229-247`); cuentas 1165 / 2180 (`account-roles-seed.ts:76-80`, `:114-118`).

**Por definir (MX):** **cálculo** de IEPS por tasa (LIEPS 2-I) o por **cuota** (gasolinas, bebidas saborizadas, tabacos: LIEPS 2-I D), G), C)); acreditamiento **proporcional** LIEPS 4 fracc. II-V; retención (LIEPS 5-A); declaración mensual (LIEPS 5). `xml_documents` **no tiene columna de IEPS**: `005:48-54` lista `total_impuestos_trasladados/retenidos`, `total_iva_16/8/0`, `total_isr_retenido`, `total_iva_retenido`; `grep -rni ieps src/database/migrations` → sólo nombres de cuenta en `053`; `policy-preview.ts:148-151`: «The current schema has no IEPS column in xml_documents». El espejo pierde el dato y `rules-engine` no puede condicionar por IEPS. Sobre `TipoFactor = 'Cuota'`: `cfdi-facts.ts:225-227` suma `importe` para todo 003, y para **leer** el impuesto eso es correcto — el `Importe` del CFDI ya es el IEPS causado, sea por tasa o por cuota; el defecto es que no hay cálculo, no que la lectura sea mala (§6).

**Parámetros:** panel — `tratamiento_ieps`. panel con default quemado — `'costo'` (`cfdi-decisions.ts:89`, `:319`).

**Puerta:** la de M5/M6.

---

### M17 · Retenciones (ISR/IVA a personas físicas, honorarios, arrendamiento) — **parcial** (sólo lectura), MX

**Implementado:** lectura de retenciones 001/002 por concepto y fallback global «asume ISR» (`cfdi-facts.ts:229-245`); roles pasivo/activo (`cfdi-taxonomy.ts:27-28`) y su posteo en I recibido/emitido (`:151-152`, `:171-172`, `:210-211`, `:229-230`); cuentas 1145/1146/2140 (`account-roles-seed.ts:51-65`, `:261-264`); ISR retenido por el banco sobre intereses como pago provisional a favor (fuera del subsistema, `treasury-posting.ts:1052-1062`).

**Por definir (MX)**
- **Cálculo** al emitir/registrar (el subsistema sólo copia lo que el CFDI trae): ISR 10 % honorarios de PF (LISR 106) y arrendamiento de PF (LISR 116); IVA dos terceras partes (LIVA 1-A II a); RLIVA 3-I: 10.6667 %); IVA 4 % autotransporte (RLIVA 3-II); RESICO PF 1.25 % (LISR 113-J); plataformas digitales (LISR 113-A/113-C, LIVA 18-J). `grep -rniE 'honorarios|arrendamiento|resico|0\.1067|10\.6667|two.?thirds|dos terceras|113-J|plataformas digitales' src` (excluidos catálogo y el regex de `cfdi-decisions.ts:282`) → `entry-command.ts:222` (ejemplo), `docs-tools.ts:39` (etiqueta NIIF 16), `account-roles-seed.ts:55` (comentario). `grep -rniE 'retenci[oó]n|withholding' src/services/ar src/services/ap src/api/rest/routes/invoices.ts` → vacío. `grep asimilados|honorarios src/services/payroll` → vacío.
- Verificación de que un CFDI recibido de PF 612/606 **traiga** la retención que la ley exige (LISR 27-V) — ausente.
- Parser tipo R y **constancias de retenciones** (LISR 76-III, 86-V, 99-III; RMF 2.7.5.4) — ausentes (M1).
- Entero mensual (LISR 96, 106, 116; LIVA 1-A penúltimo párrafo: día 17) — ausente.

**Parámetros:** quemado (criterio) — «asume ISR» (`cfdi-facts.ts:244`); 2140 compartido (`account-roles-seed.ts:261-262,273`).

**Puerta:** la de M5/M6.

---

### M18 · DIOT — **ausente**, MX

- Norma: LIVA 32-VIII (información mensual de operaciones con proveedores), RMF 4.5.1; formato vigente por proveedor con IVA pagado en el mes a 16 %, 8 %, 0 %, exento, retenido, importaciones — justo lo que M7 sabe por documento y no agrega.
- `grep -rniE "\bdiot\b" src scripts` → prosa: filtro de proveedores sin RFC «the DIOT/1099 blockers» (`vendor-service.ts:24,227`; `vendor-command.ts:108,178,347`), un comentario (`pre-registration-service.ts:1104`), y la nota de que el generador anterior se **eliminó** por estar sobre el formato de devengo derogado (`sat-catalogs.ts:8-15`; `docs/wiki/Fiscal-mexicano.md:237` «DIOT. No se genera»).
- Existe `skills/diot-checklist/SKILL.md`: guion en prosa para el agente que enseña que presentar la DIOT es acto humano en el portal del SAT (`docs/plan-cierre-brechas.md:3933,3946`; `tests/ai/system-prompt.spec.ts:123` espera la skill). Puerta de prosa, no motor.

---

### M19 · Contabilidad electrónica (Anexo 24) — **ausente** como motor; materia prima fuera del subsistema, MX

- Norma: CFF 28-III y IV; RCFF 33-34; RMF 2.8.1.5-2.8.1.7 y Anexo 24 (XML de catálogo con c_CodAgrup, balanza mensual, pólizas y auxiliares a requerimiento; sello con e.firma y envío por Buzón Tributario).
- Lo que hay (fuera de este subsistema): columna `mx_nif_code` y mapeo `sat-agrupador` (`account-service.ts:445-458`), importación y compuerta de cobertura (`:522-575`; CLI `account map …` `account-command.ts:621-742`), auxiliar con la forma del XC (`report-service.ts:965-1000`), control `missing-uuid` (`ar-controls.ts:276-297`).
- Lo que no hay: escritor de XML `BCE`/`CAT`/`PLZ`/`XC` — `grep -rnE 'BCE|PLZ:|ContabilidadE|www\.sat\.gob\.mx/esquemas/ContabilidadE' src` → vacío; `grep -rln xmlns src/services` → sólo adaptadores PAC, `camt053.ts`, `cfdi-status.ts` (SOAP) y `cfdi-nomina-generator.ts`. Las menciones a «Anexo 24» son ayuda CLI y comentarios (`account-command.ts:187,208,621,738`; `ledger-command.ts:69,218`; `fiscal-calendar-service.ts:297`; `account-service.ts:449,560`; `report-service.ts:968`). Catálogo c_CodAgrup (`account-command.ts:632-640`), sellado y envío: `docs/wiki/Fiscal-mexicano.md:21` «El XML del Anexo 24 no se genera»; `:232` «ninguno de los dos está escrito. El envío al buzón tributario tampoco».

---

### M20 · Descarga masiva del SAT — **ausente**, MX

- Norma/servicio: CFF 28 y 30; WS de Solicitud de Descarga Masiva (`SolicitaDescarga` / `VerificaSolicitudDescarga` / `Descargar`, token firmado con e.firma).
- `ls src/services/sat` → sólo `cfdi-status.ts`; `src/services/sat-download` no existe. `grep -rniE 'SolicitaDescarga|VerificaSolicitud|descarga-masiva|sat download' src | grep -v criterios.ts` → tres comentarios (`sat-commands.ts:66`, `pre-registration-service.ts:966`, `pending-catalog.ts:852`). El criterio E3.2 lo declara **rojo** y enumera lo que falta (SOAP, ZIP, comando `sat download`, reversa de contabilizados cancelados) (`src/plan/criterios.ts:2332-2364`); `sat-commands.ts:71` «the CFDI bulk download is not built yet»; `pending-catalog.ts:852-856` retiró `pac_ofrece_descarga` por no tener conducta que cambiar. La e.firma se custodia **para esto** (`service.ts:26-28`) y nada la usa (M14-b).

---

### M21 · Timbrado (emisión de CFDI) — **parcial**, fuera del subsistema, MX

- Norma: CFF 29 fracc. I-VI, 29-A; Anexo 20; RMF 2.7.1.x (PAC).
- Lo que hay: router multi-PAC con failover y cerrojo antisimulación (`src/services/integrations/mexico/pac/pac-router.ts:25-30,147-214`; `simulacion.ts:35-73`); 3 de 4 adaptadores simulados (`simulado = true` en `finkok-adapter.ts:27`, `edicom-adapter.ts:26`, `sw-sapien-adapter.ts:27`; `false` sólo en `sovos-reachcore-adapter.ts:128`); `POST /v1/invoices/:id/cfdi/stamp` arma un `Comprobante` **mínimo** con sólo Version/Folio/Total/SubTotal/Moneda (`invoices.ts:248-253`), el comentario `:247` «real implementation would use cfdi.ts generateCfdiXml» apunta a un módulo borrado (`sat-catalogs.ts:10-11`), y persiste `failed` si es simulado (`:262-274`); CFDI de nómina: `cfdi-nomina-generator.ts` sí arma un XML N real y lo manda a `pacRouter.stamp` (`:136`), pero `grep -n 'Sello\|cadena\|NoCertificado\|Certificado=\|firmar\|sign'` en ese archivo → vacío. **Ninguno de los dos caminos de emisión sella.** Permisos GraphQL `stampCfdi`/`cancelCfdi` declarados sin resolutor a propósito (`api/graphql/permisos.ts:163-175`).
- Lo que no hay: generador de XML 4.0 completo de ingreso/egreso/pago, **cadena original + sellado con CSD** (la custodia rechaza el CSD, M14), REP emitido (M9), CFDI global, Carta Porte. `docs/wiki/Fiscal-mexicano.md:15-19`.
- Parámetros: casa con default simulado — `PAC_PROVIDER || 'finkok'` (`config/index.ts:128`); preferencias por omisión `finkok → sw_sapien → edicom` (`pac-router.ts:68-72`, `:93-95`), los tres simulados.

---

### M22 · Cancelación de CFDI ante el SAT — **ausente**, MX

- Norma: CFF 29-A párrafos 4.º-6.º (con/sin aceptación del receptor, plazo), RMF 2.7.1.34-2.7.1.38, motivos 01-04.
- `POST /v1/invoices/:id/cfdi/cancel` valida motivo y `replacement_uuid` (`invoices.ts:311-317`; `validReasons = ['01','02','03','04']` repetidos de `sat-catalogs.ts:106-111`) y **lanza `NotImplementedError`** (`:330-335`), con el comentario de que el endpoint anterior marcaba cancelado en la base sin cancelar ante el SAT. `pacRouter.cancel` existe (`pac-router.ts:219`) sin llamador: `grep -rn 'pacRouter\.' src | grep -v pac-router.ts` → `getPreferences`, `getAllHealth`, `savePreferences` (`integrations.ts:150-166`) y dos `stamp` (`invoices.ts:256`, `cfdi-nomina-generator.ts:136`); `grep -rn "\.cancel(" src` → sólo `pac-router.ts:240`, interno. Sin acuse archivado, sin reversa encadenada, sin aceptación del receptor; el criterio E3.1 sólo vigila que la ruta no finja (`plan/criterios.ts:2320-2329`).

---

### M23 · Determinación mensual del IVA y declaraciones — **ausente**, MX

- Norma: LIVA 5-D (pago mensual definitivo al día 17), 5-C (factor de acreditamiento), 6 (saldo a favor: acreditamiento, compensación o devolución), CFF 31.
- El subsistema distingue por cuenta el IVA causado/acreditable del aparcado (M7) pero **no** determina el IVA del mes, no aplica factor, no lleva saldos a favor, no genera pre-llenado. `grep -rniE 'declaraci[oó]n mensual|pago provisional|iva_por_pagar|saldo a favor|iva a pagar' src/services src/cli` → sólo comentarios (`treasury-posting.ts:40,590,1020,1057`; `rep-linkage.ts:26`; `bank-command.ts:1205,5461,5517`) y el «saldo a favor» de clientes en notas de crédito (`credit-note-service.ts:21,241`). `report-command.ts` sólo tiene `trial-balance|balance-sheet|income-statement|general-ledger|view` (`:265-686`); no hay `report iva` ni comando `tax`/`diot`.

---

## 2. Parámetros quemados consolidados

Todo lo que sigue está en código; ninguno viene de `tax_tables` (§0) ni tiene clave en el panel salvo donde se indica.

| Parámetro | Valor | Archivo:línea | Norma / naturaleza | Clase | Dónde debería vivir |
|---|---|---|---|---|---|
| Límite de pago en efectivo deducible | 2 000 MXN | `cfdi-decisions.ts:94` | LISR 27-III | quemado (ley) | `tax_tables` MX con vigencia, o panel `fiscal` por jurisdicción |
| Porcentaje deducible de restaurante | 8.5 % | `cfdi-decisions.ts:96`; `policy-preview.ts:143-144` | LISR 28-XX | quemado (ley), **dos veces** | `tax_tables` / panel; `politica_restaurantes` sólo elige `split_85\|no_deducible` |
| Tasas de IVA reconocidas | 16 / 8 / 0 | `cfdi-parser.ts:361-363`; `cfdi-facts.ts:216-224`; `sat-catalogs.ts:99-103` | LIVA 1; decreto fronterizo | quemado (ley), **tres veces** | `tax_tables` (jurisdicción MX, tipo `iva`, vigencia y zona) |
| Umbral de capitalización (default) | 20 000 | `cfdi-decisions.ts:54` | política del despacho | panel con default quemado | ya en panel (`umbral_capitalizacion_mxn`) |
| Piso de pagos anticipados (default) | 5 000 | `cfdi-decisions.ts:67` | NIF A-4 | panel con default quemado, **no inyectado** (`pre-registration-service.ts:803-808`) | ya en panel (`umbral_anticipado_mxn`); falta cablearlo |
| Prefijos c_ClaveProdServ activo fijo / restaurante / combustible | listas | `cfdi-decisions.ts:99-103` | heurística | quemado (criterio) | catálogo editable por el despacho |
| Regex de descripciones en castellano | — | `cfdi-decisions.ts:197,248,282`; `cfdi-facts.ts:377` | heurística | quemado (criterio) | catálogo por idioma |
| Regla conservadora de MetodoPago ausente | emitido PUE / recibido PPD | `iva-cash-basis.ts:64-67` | criterio contable | quemado (criterio) | panel (bifurcación de criterio) |
| Fallback «retención global = ISR» | — | `cfdi-facts.ts:244` | criterio | quemado (criterio) | panel o decisión visible |
| Regla de jurisdicción | `MX` / `mx_nif` | `iva-cash-basis.ts:310`; `iva-ppd-reclass.ts:101` | conmutador; **divergente** de `pais-contable.ts:41-44` en el borde nulo | quemado (conmutador) | `pais-contable.ts:35` (una sola) |
| Expresión del RFC | regex MX | `cfdi-parser.ts:301`; `certificate.ts:83` | identificador fiscal | quemado (jurisdicción) | validador por `tax_id_type` |
| Moneda funcional presunta | `MXN` / `XXX` | `cfdi-facts.ts:169` | — | quemado (jurisdicción) | moneda funcional de la entidad |
| Alta de proveedor desde CFDI | `MXN`, `rfc` | `pre-registration-service.ts:1081-1082,353` | — | quemado (jurisdicción) | moneda funcional y `tax_id_type` de la entidad |
| Clave de anticipo / FormaPago efectivo | `84111506` / `01` | `cfdi-facts.ts:116-117` | Anexo 20 ap. 6; c_FormaPago | quemado (catálogo) | catálogo |
| Mapa c_FormaPago → payment_method | 5 códigos | `rep-linkage.ts:73-79` | c_FormaPago (22) | quemado (catálogo) | catálogo completo |
| Motivos de cancelación | 01-04 | `sat-catalogs.ts:106-111`; `invoices.ts:311` | c_MotivoCancelacion | quemado (catálogo), dos veces | catálogo |
| Códigos de cuenta fuera de roles | 1130 / 1135 / 2110 | `iva-ppd-reclass.ts:61,68`; `pre-registration-service.ts:1257-1261` | red por código | quemado (códigos) | `account_roles` |
| 2140 compartido por tres pasivos | ISR retenido, IVA retenido, ISR nómina | `account-roles-seed.ts:261-262,273` | criterio de catálogo | quemado (criterio) | cuentas separadas por rol |
| Tolerancias aritméticas | 0.01 / 0.05 / 0.005 | `cfdi-parser.ts:322,331`; `cfdi-classifier.ts:117,191`; `cfdi-posting-plan.ts:147` | operativa | casa | el original propone panel `operativa` |
| Similaridad / confianzas / Net 30 / `is_high_value` | 0.5, 0.7, 0.8, 0.9 / 30 / 50 000 | `pre-registration-service.ts:331,335,397,430,440`; `rules-engine.ts:126` | operativa | casa | el original propone panel |
| Cadencia de consulta SAT | 24 h, 100, 5, 200 ms, 10, 1000 ms, 3 reintentos | `cfdi-status.ts:195,205,211,245,113`; `sat-validation.ts:75-76` | operativa | casa | config |
| e.firma: accesos/día, desatendido | 24, `true` | `service.ts:183` | seguridad | casa (el techo sí está en panel) | — |
| PAC por omisión y orden de failover | `finkok`, `sw_sapien`, `edicom` | `config/index.ts:128`; `pac-router.ts:68-72,93-95` | — | casa, default **simulado** | preferencias del inquilino con default no simulado |
| `MAX_SECRET_BYTES` | 65 536 | `aws-secrets-manager.ts:29` | operativa | casa | — |

**Lo que sí vive en el panel y lee este subsistema:** `umbral_capitalizacion_mxn`, `politica_restaurantes`, `tratamiento_ieps`, `lleva_inventarios`, `cfdi_periodo_cerrado` (`pre-registration-service.ts:763-777`); `rep_pago_no_registrado`, `rep_tolerancia_importe`, `rep_documento_desconocido`, `rep_ventana_dias`, `rep_moneda_extranjera` (`rep-linkage.ts:134-285`); `efirma_max_accesos_diarios`, `efirma_accion_anomalia` (`service.ts:259-264`); `rep_faltante_recibido/emitido` (`period-close.ts:559-560`); `ingest_auto_post`, `ingest_auto_post_max_monto` (`ai/ingest-thresholds.ts:67,118`). **Ninguna tiene dimensión de jurisdicción.** No quemados aunque el original lo dijera: `VAULT_PREFIX` (`vault/index.ts:40`) y el directorio de la bóveda local (`local-dev.ts:42`).

---

## 3. Lo que Estados Unidos exige y no existe en este subsistema

1. **Sales & use tax** (leyes estatales; nexo, tasas estado+condado+ciudad, taxabilidad por producto, certificados de exención, declaraciones periódicas). `grep -rniE 'sales.?tax|use.?tax|nexus|nexo|taxab' src` → sólo `taxable_wages_*`/`is_taxable_*` de nómina (`008_payroll.sql:167-283`), prosa (`chart-seed.ts:116`, `pending-catalog.ts:62,85`) y los nombres de cuenta 2135/1136 (`chart-seed.ts:123-127`; `account-roles-seed.ts:335-338`) a las que `ar-ap-posting.ts:118-120,198-200` manda el `tax_amount` que traiga el documento. Sin cálculo de tasa, nexo ni declaración.
2. **Information returns 1099-NEC / 1099-MISC** (IRC §6041, §6041A; Form 1096; e-file desde 10 formas, Treas. Reg. §301.6011-2, vía IRIS). Existe la bandera `is_1099_vendor` (`002_ap_ar_schema.sql:17`; `types/index.ts:400`; `vendors.ts:46`; `search-tools.ts:111,133`; `vendor-service.ts:225-258,396-420`; `vendor-command.ts:90-190,260,331`) y `contractor_1099` como `salary_type` (`008:65`). `tax_form_filings.form_type` admite `1099_nec` en su comentario (`008_payroll.sql:486`) pero sus seis escritores son 940 (`form-940-generator.ts:98`), 941 (`form-941-generator.ts:115`), W-2 (`w2-generator.ts:150`), W-3 (`w3-generator.ts:100`), SUA (`sua-generator.ts:117`) e IMSS-IDSE (`imss-idse-adapter.ts:139`); **ninguno escribe 1099**. `ls src/services/payroll/usa/forms/` → 940, 941, W-2, W-3. Sin acumulación anual por proveedor, generación ni transmisión.
3. **W-9 y TIN Matching** (IRC §6109). `grep -rniE 'w-?9\b|tin.?match|\btin\b' src` → vacío.
4. **Backup withholding** 24 % (IRC §3406). `grep -rniE 'backup.?withholding|3406'` → vacío; el subsistema sólo copia retenciones de CFDI (`cfdi-facts.ts:229-234`).
5. **Parser de documentos de proveedor no-CFDI** (no es exigencia legal; es la puerta por documento): `cfdi-parser.ts:109-112` rechaza todo lo que no sea `Comprobante`; la escritura pone `source_type = 'xml_cfdi'` (`pre-registration-service.ts:285`). **Corrección del escéptico:** la puerta **manual** sí existe para cualquier jurisdicción — `POST /v1/bills` (`bills.ts:120`), `mnemosine bill create` (`bill-command.ts:17`), `createBill` (`bill-service.ts:340`) — y el CHECK admite `manual|api|recurring|import` (`005:149-151`). Lo ausente es el parser, no toda la ingesta.
6. **Custodia de credenciales IRS/estatales** (TCC para FIRE/IRIS, cuentas estatales de sales tax): `credential_type` sólo `efirma|csd` (`014:13-14`); el servicio sólo escribe `'efirma'` (`service.ts:151,170`).
7. **Matriz de tratamiento contable de documentos de venta/compra US** equivalente a M3 (sales tax acumulado al facturar; use tax auto-liquidado en compras sin impuesto) — la taxonomía es del CFDI (`cfdi-taxonomy.ts:56-75`).
8. **Deducibilidad federal** (IRC §162, §274 comidas 50 %, §280F automóviles, §179/§168(k)) como puntos de decisión — las 12 decisiones citan LISR (`cfdi-decisions.ts:141,226,249,265`).
9. **Tipo de identificación fiscal:** `tax_id_type` admite `'ein'` (`001:84`, `002:16,167`; ejemplo `vendor-command.ts:125`) pero el alta desde CFDI escribe `'rfc'` (`pre-registration-service.ts:353,1082`).

## 4. Lo que México exige y no existe en este subsistema

1. **Descarga masiva del SAT** (CFF 28, 30; WS SolicitaDescarga/VerificaSolicitud/Descargar con token e.firma) — `src/services/sat-download` no existe; E3.2 en rojo (`plan/criterios.ts:2332-2364`); la e.firma se custodia para esto y `withCredential` no tiene llamador (M14-b, M20).
2. **DIOT** (LIVA 32-VIII; RMF 4.5.1) — eliminado, no reescrito (`sat-catalogs.ts:8-15`; `docs/wiki/Fiscal-mexicano.md:237`); `skills/diot-checklist/SKILL.md` es guion humano (M18).
3. **Contabilidad electrónica Anexo 24** (CFF 28-III/IV; RMF 2.8.1.5-2.8.1.7): XML de catálogo, balanza, pólizas y auxiliares, c_CodAgrup, sellado y envío — ningún escritor XML (`grep BCE|PLZ:|ContabilidadE` vacío); sólo agrupador en dos columnas sin catálogo (`001:130`, `037:28`), cobertura y auxiliar (`account-service.ts:445-575`; `report-service.ts:965-1000`) (M19).
4. **Cancelación de CFDI** con acuse, aceptación del receptor y reversa encadenada (CFF 29-A; RMF 2.7.1.34-2.7.1.38) — `invoices.ts:330` lanza `NotImplementedError`; `pacRouter.cancel` sin llamador (M22).
5. **Sellado propio del CFDI** (cadena original Anexo 20 + CSD) y **custodia del CSD** (CFF 29-II) — `storeCredential` rechaza CSD (`service.ts:108-113`); el XML de `invoices.ts:248-253` es un `Comprobante` vacío; el de nómina (`cfdi-nomina-generator.ts`) tampoco sella; 3 de 4 PAC simulados (M21, M14).
6. **Emisión del REP** propio (RMF 2.7.1.32/2.7.1.35, 5.º día natural del mes siguiente) — `rep-command.ts:31-33`; sólo se listan faltantes (`rep-pendientes.ts:68-89`) y el plazo no se calcula (`overdueOnly` muerto, M10).
7. **Parser de CFDI de retenciones (tipo R)** y **constancias** (LISR 76-III, 86-V, 99-III, 106, 116; RMF 2.7.5.4) — `cfdi-parser.ts:109-112,386-391`; caso de taxonomía inalcanzable (`cfdi-taxonomy.ts:405-419`) (M1).
8. **Cálculo de retenciones** al emitir/registrar: ISR 10 % honorarios y arrendamiento de PF (LISR 106, 116), IVA 2/3 (LIVA 1-A II a); RLIVA 3-I), IVA 4 % fletes (RLIVA 3-II), RESICO 1.25 % (LISR 113-J), plataformas (LISR 113-A; LIVA 18-J); verificación LISR 27-V — sólo lectura (`cfdi-facts.ts:229-245`) (M17).
9. **Determinación mensual del IVA** (LIVA 5-D), **acreditamiento proporcional** (LIVA 5-C, 5-V) y saldos a favor/compensación/devolución (LIVA 6; CFF 22-23) — el subsistema sólo aparca y libera por documento (`iva-cash-basis.ts:271-289,593-704`) (M7, M23).
10. **IEPS**: cálculo por tasa y cuota (LIEPS 2), acreditamiento proporcional (LIEPS 4), retención (LIEPS 5-A), declaración (LIEPS 5) — sólo lectura y decisión costo/acreditable (`cfdi-facts.ts:225-227`; `cfdi-decisions.ts:307-323`); `xml_documents` sin columna IEPS (`005:48-54`) (M16).
11. **Lectura de complementos** `ImpuestosLocales`, `Terceros` (RMF 2.7.1.13), `ComercioExterior`, `CartaPorte` — el parser sólo emite TFD/Pagos/Nomina (`cfdi-parser.ts:261-289`), lo que deja muertas `cfdi-facts.ts:268-276` y `cfdi-decisions.ts:326-340` (M1).
12. **Verificación del sello y del certificado** del CFDI recibido (CFF 29-A; Anexo 20) — `validate` sólo hace aritmética (`cfdi-parser.ts:291-336`) (M1).
13. **Lista 69-B (EFOS)** — `ValidacionEFOS` recibido y no consumido (`cfdi-status.ts:90,155`; `sat-validation.ts:51`) (M11).
14. **Reexpedición PUE → PPD** (Guía Anexo 20 / RMF 2.7.1.32) y **CFDI global** (RMF 2.7.1.21) — ausentes (M7, M3).
15. **Diferencia cambiaria y TC DOF de la fecha de pago en el REP** (LIVA 1-B; NIF B-15) — declarado no computado (`rep-linkage.ts:139-147`; `pending-catalog.ts:733-758`) (M9).
16. **Reversa de asientos por CFDI cancelado tras contabilizarse** (CFF 29-A) — faltante en `plan/criterios.ts:2340-2344`; el estatus se guarda (`cfdi-status.ts:227-233`) y nada reacciona (M11).
17. **IVA del cheque al cobro** (LIVA 1-B 2.º párrafo) — no ausente: motor con puerta que reclasifica cero (`treasury-posting.ts:1360-1370`; `bank-command.ts:89,5598`) hasta que `ar-ap-posting.ts` deje el IVA aparcado (M7-b).

---

## 5. Puertas

### CLI (`mnemosine …`)

| Comando | Archivo:línea | Motor |
|---|---|---|
| `cfdi list` / `show` / `status show [--refresh]` / `status sync` / `explain` | `src/cli/cfdi-command.ts:114-292` (`:140,167,201,206,240,289`) | espejo (`cfdi-query-service.ts`), estatus SAT (`sat-validation.ts`, `sat/cfdi-status.ts:191`) — M11 |
| `rep missing list` / `rep reconcile` | `src/cli/rep-command.ts:59-134` (`:85,89,128`) | `rep-pendientes.ts:36,127` — M10; `overdueOnly` no cableado (`:104-108`) |
| `bill inbox list` / `bill inbox run` | `src/cli/bill-command.ts:864-943`, `:1477`, `:1576` | `PreRegistrationService.processToAccounting` — M5, M6, M9 |
| `bill create` | `src/cli/bill-command.ts:17` → `bill-service.ts:340` | captura manual sin CFDI, cualquier jurisdicción (M6 `:821-901`) |
| `ingest` (alias `ingesta`) | `src/cli/mnemosine.ts:1771-1782` → `src/ai/ingest-service.ts:98-111` | `processXMLUpload` + clasificación IA + umbrales del panel (`src/ai/ingest-thresholds.ts:42`) — M1–M6 |
| `init` (S5 import) | `src/cli/init/s5-import.ts:12` | `ingestCfdiFiles` |
| `sat cred add` / `status` / `audit` / `revoke` | `src/cli/sat-commands.ts:70-286` (`:75,217,252,282`) | `fiscal-credentials/service.ts`, `certificate.ts`, `vault/` — M14, M15 |
| `account …` (siembra de roles) | `src/cli/account-command.ts:31` | `account-roles-seed.ts:376` — M13 |
| `bank …` (conciliar cheque) | `src/cli/bank-command.ts:89,5598` | `conciliarCheque` — M7-b (reclasifica cero) |

### REST (`/v1`)

| Ruta | Archivo:línea | Motor |
|---|---|---|
| `POST /xml/upload` | `src/api/rest/routes/xml-ingestion.ts:130` | `processXMLUpload` — M1–M6 |
| `GET /xml/pre-registrations[/stats\|/:id]`, `POST …/:id/reject`, `POST …/:id/approve` | `xml-ingestion.ts:203,261,317,433,450` | espejo y flujo de aprobación |
| `POST /xml/pre-registrations/:id/process` | `xml-ingestion.ts:370` | `processToAccounting` (REP incluido, `:383-398`) — M5, M6, M9 |
| `POST /xml/pre-registrations/bulk`, `GET/POST /xml/processing-batches`, `POST …/:id/execute`, `GET …/:id/progress`, `POST …/:id/cancel` | `xml-ingestion.ts:470,634,657,695,705,730` | `processBatch` — M6 |
| `GET/POST/PUT/DELETE /xml/processing-rules` | `xml-ingestion.ts:544,567,593,623` | escribe `processing_rules` que consume `rules-engine.ts` — M6 |
| `GET /xml/xml-documents[/:id]` | `xml-ingestion.ts:748,781` | espejo |
| `POST /bills` | `src/api/rest/routes/bills.ts:120` | `createBill` — captura manual (§0) |
| `POST /invoices/:id/cfdi/stamp` | `src/api/rest/routes/invoices.ts:242` | `pac-router.ts:147` con `Comprobante` mínimo — M21 |
| `POST /invoices/:id/cfdi/cancel` | `invoices.ts:290` → **`NotImplementedError` en `:330`** | ninguno — M22 |
| `POST /payroll/paychecks/:id/cfdi-nomina` | `src/api/rest/routes/payroll.ts:256` | `cfdi-nomina-generator.ts:136` → `pacRouter.stamp` — M21 |

### GraphQL

`stampCfdi(invoiceId, pacProvider)` y `cancelCfdi(invoiceId, cancellationReason, replacementUuid)` están **declaradas en el esquema** (`src/api/graphql/schemas/schema.ts:476-477`) y **sin resolutor a propósito** (`src/api/graphql/permisos.ts:163-175`: acto externo e irreversible, sin servicio en el que delegar, sin rastro de auditoría por esa puerta). Ninguna otra operación GraphQL toca el subsistema (`grep -rniE 'cfdi|xmlDocument|\brep\b|sat_' src/api/graphql` → sólo `permisos.ts`, `schema.ts`, `resolvers/index.ts`).

### Agente

- **Sin herramienta directa.** `grep -rniE 'xml-ingestion|ligarPagoREP|revalidateEntityCfdis|listPagosSinRep|cfdi-query|sat-validation|fiscal-credentials' src/ai/tools/` → vacío (`ls src/ai/tools/` → docs, draft, external, ledger, observer, policy, question, report, search, session-search, skills, status, superficie). El único puente es `src/ai/ingest-service.ts:6-7,111`, que sirve a `mnemosine ingest` y a `init` S5.
- **Puertas de prosa** (skills que instruyen al agente y mandan al humano a la CLI; no son motores): `skills/diot-checklist/SKILL.md` («you never file anything»; M18) y `skills/sat-reconciliation/SKILL.md` (conciliación CFDI↔mayor; paso 2 «the human runs `mnemosine ingest`»). La segunda no estaba en ninguno de los dos informes; se añadió en esta fusión tras `ls skills/`.

### Scripts y servicios

| Puerta | Archivo:línea | Motor |
|---|---|---|
| `npm run reclass:iva-ppd` | `package.json:28` → `scripts/reclasificar-iva-ppd.ts:5-8,81,100` | `iva-ppd-reclass.ts:114,144` — M8 (única puerta) |
| `npm run eval` | `package.json:31` → `scripts/eval-clasificador.ts` | mismo camino que `mnemosine ingest` |
| `npm run backfill:account-roles` | `package.json:29` | M13 |
| alta de entidad | `src/services/accounting/entity-accounting.ts:4,158` | `seedAccountRoles`, `rolesPara` — M13 |
| cierre de periodo | `src/services/accounting/period-close.ts:508-575` | REP aparcados/faltantes, `rep_faltante_*` — M10 |
| pagos AR/AP y tesorería | `ar-ap-posting.ts:118-120,198-200,452-465`; `treasury-posting.ts:7,1459` | `iva-cash-basis.ts` — M7 |
| notas de crédito | `src/services/ar/credit-note-service.ts:7,497-507` | `resolveInvoiceMetodoPago` — M7 |

### Motores sin puerta o con puerta que no escribe

- `withCredential` (`fiscal-credentials/service.ts:207`) y `privateKeyToPem` (`certificate.ts:137-139`): sin llamador fuera de pruebas (M14-b, inerte).
- `conciliarCheque` (`treasury-posting.ts:1370`): con puerta (`bank-command.ts:5598`) y reclasifica cero (M7-b, inerte).
- `pacRouter.cancel` (`pac-router.ts:219`): sin llamador (fragmento de M22, ausente).
- `censarIvaPpd` (`iva-ppd-reclass.ts`): sólo script, sin `mnemosine` ni REST (M8).
- `listPagosSinRep({ overdueOnly })` (`rep-pendientes.ts:38`): opción declarada que ninguna consulta usa (M10).
- `sat_code_mappings` (`005:359-375`): tabla con un lector (`pre-registration-service.ts:401-406`) y ningún escritor (M6).

---

## 6. Lo que el escéptico refutó o corrigió del original

Ningún reclamo cayó entero: no apareció ningún motor bajo otro nombre, ninguna puerta olvidada ni ningún parámetro que ya viniera de tabla o panel. Lo que **no** hay que creerse del original, tal como estaba escrito:

1. **«Toda ingesta US muere en `cfdi-parser.ts:111`»** — falso como estaba: sólo la ingesta **por documento**. La captura manual de facturas de proveedor existe para cualquier jurisdicción (`bills.ts:120`; `bill-command.ts:17`; `bill-service.ts:340`) y `source_type` admite `manual|api|recurring|import` (`005:149-151`). Lo ausente es el parser (M1, §3.5).
2. **M15 contaba tres «quemados»** — dos eran falsos: `VAULT_PREFIX` (`vault/index.ts:40`) y el directorio local (`local-dev.ts:42`) son omisiones configurables. Sólo `MAX_SECRET_BYTES` (`aws-secrets-manager.ts:29`) está fijo.
3. **«Regla de jurisdicción duplicada»** (M7, M8) — corto: no sólo duplica, **contradice** el borde. País nulo y norma nula → México en `pais-contable.ts:41-44`, no-México en `iva-cash-basis.ts:310` e `iva-ppd-reclass.ts:101`.
4. **«El cheque hoy libera en fecha de pago» (M7)** — exacto pero incompleto: existe `conciliarCheque` (`treasury-posting.ts:1370`; `bank-command.ts:89,5598`), motor con puerta que reclasifica cero por decisión de `ar-ap-posting.ts`. Es inerte, no ausente (M7-b, §4.17).
5. **«`TipoFactor='Cuota'` cae al mismo cubo» (M16)** — la lectura del `Importe` es correcta para tasa y cuota; el defecto es que no hay **cálculo** (LIEPS 2), no que la lectura sea mala.
6. **«Nadie lo consume para validar» (M12)** — sólo vale acotado a `xml-ingestion/`: `customer-service.ts:677-692` sí valida régimen y UsoCFDI contra el catálogo.
7. **Tasa 8.5 % (M4)** — está quemada **dos veces**, no una: `cfdi-decisions.ts:96` y `policy-preview.ts:143-144`; `politica_restaurantes` no la hace configurable.
8. **Nota de crédito PPD (M3)** — el lado AR (`credit-note-service.ts:496-507`) sí bloquea la nota sin liga sobre PPD; el hueco es exclusivamente el lado **recibido**, donde no hay servicio AP alterno.
9. **Agrupador SAT (M12)** — no una columna sino dos, `mx_nif_code` (`001:130`) y `codigo_agrupador_sat` (`037:28`), sin catálogo detrás de ninguna.
10. **`overdueOnly` (M10)** — hallazgo nuevo: opción declarada en `rep-pendientes.ts:38` que ninguna consulta usa ni `rep-command.ts:104-108` pasa.
11. **DIOT (M18)** — existe `skills/diot-checklist/SKILL.md` como guion humano; no es motor y no cambia el `ausente`.
12. **Timbrado (M21)** — el generador de nómina (`cfdi-nomina-generator.ts`) tampoco sella; el «sin sellado propio» alcanza a los dos caminos de emisión.
13. **1099 (§3.2)** — `tax_form_filings.form_type` admite `1099_nec` (`008:486`) y tiene seis escritores, ninguno de 1099.
14. **Líneas corregidas:** `validacionEFOS` se devuelve en `cfdi-status.ts:155` (no `:153`); `Importe="0.00"` se vuelve `undefined` en `cfdi-parser.ts:252` (no `:253`); `selloCFD`/`selloSAT` en `:170-171`.
