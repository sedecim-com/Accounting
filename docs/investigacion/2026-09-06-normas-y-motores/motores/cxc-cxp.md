# Inventario verificado · CxC, CxP y pagos (mnemosine)

El inventario original lo escribió un lector de código sobre `src/services/ar/`, `src/services/ap/`, `src/services/payments/`, `src/services/accounting/ar-ap-posting.ts` y los dos motores externos que el subsistema consume (antigüedad en `src/services/reporting/report-service.ts:827-962`, recordatorios en `src/ai/jobs/wake-gate.ts:198-215`); lo verificó un escéptico independiente con la instrucción de refutar —abrió cada `archivo:línea`, buscó por grep cada «ausente» y cada «sin escritor» bajo otro nombre en `src/services`, `src/cli`, `src/api` y `src/services/xml-ingestion`, y comprobó que ningún «quemado» venga de `tax_tables` ni del panel— contra el HEAD `812a43c` de la rama `investigacion/normas-y-motores`. Esta fusión se escribe en el HEAD `4b1d8fe` de la misma rama: entre ambos commits no cambió ningún archivo citado (`git diff --stat 812a43c 4b1d8fe` sobre `src/` y `docs/cli-command-catalog.md` está vacío), y cada cita que el escéptico corrigió se reabrió antes de quedar aquí.

**Vocabulario de estado.** `completo`: existe, tiene puerta y hace lo que dice. `parcial`: existe con huecos nombrados. `inerte`: el motor existe pero no tiene puerta, o la tiene y no escribe nada. `ausente`: no hay motor bajo ningún nombre (se buscó por grep antes de afirmarlo).

**Vocabulario de parámetro.** `ley`: número o regla de una ley (tasa, umbral, plazo) que debería vivir en una tabla con vigencia. `panel`: criterio del despacho, ya en `src/services/policy/pending-catalog.ts`. `casa`: constante del motor (tolerancia, tope de listado, prefijo) que puede quedarse en código. `quemado`: ley o criterio contable escrito en código, que es lo que hay que mover.

**Rutas cortas.** Cuando un archivo aparece sin directorio, se resuelve así: `invoice-service.ts`, `customer-service.ts`, `credit-note-service.ts`, `ar-controls.ts` → `src/services/ar/`; `bill-service.ts`, `vendor-service.ts`, `ap-controls.ts` → `src/services/ap/`; `payment-service.ts` → `src/services/payments/`; `ar-ap-posting.ts`, `iva-cash-basis.ts`, `pais-contable.ts`, `entity-accounting.ts`, `chart-seed.ts`, `moneda-origen.ts` → `src/services/accounting/`; `cfdi-taxonomy.ts`, `account-roles-seed.ts`, `rep-linkage.ts`, `sat-catalogs.ts`, `cfdi-decisions.ts`, `cfdi-facts.ts`, `pre-registration-service.ts`, `sat-validation.ts` → `src/services/xml-ingestion/`; `cfdi-status.ts` → `src/services/sat/`; `treasury-posting.ts`, `bank-account-service.ts` → `src/services/banking/`; `report-service.ts` → `src/services/reporting/`; `pending-catalog.ts` → `src/services/policy/`; `*-command.ts` → `src/cli/`; `routes/*.ts` → `src/api/rest/routes/`; `resolvers/index.ts` → `src/api/graphql/resolvers/index.ts`; `wake-gate.ts`, `job-store.ts` → `src/ai/jobs/`; `search-tools.ts`, `report-tools.ts`, `superficie.ts` → `src/ai/tools/`; `sequence.ts` → `src/utils/`; `types/index.ts` → `src/types/index.ts`; `enums.ts` → `src/database/enums.ts`; `002`, `036`, `049`, `050` → `src/database/migrations/002_ap_ar_schema.sql`, `036_pagos_rep.sql`, `049_cobrar.sql`, `050_pagar.sql`; `catalog` → `docs/cli-command-catalog.md`.

---

## 0. Cómo ve la jurisdicción este subsistema

El subsistema **no consulta `esContabilidadMexicana`** (`pais-contable.ts:35-44`). Su único conmutador es `entityUsesCashBasisIva` (`iva-cash-basis.ts:300-311`), que devuelve `incorporation_country === 'MX' || accounting_standard === 'mx_nif'` y **`false` cuando la entidad no existe o ambas columnas vienen nulas** (`:309-310`). `esContabilidadMexicana` devuelve `true` con país nulo o vacío (`pais-contable.ts:42-43`), y es la que usa la siembra del catálogo (`entity-accounting.ts:75, :172`). Son dos convenciones para la misma pregunta: una entidad con país nulo siembra el estrato fiscal mexicano (roles 2125/1135) y a la vez postea su IVA **sin** base de flujo. La cabecera de `pais-contable.ts:1-25` dice haber unificado cuatro sitios y nombra a `iva-cash-basis.ts` entre ellos (`:7`); ese archivo sigue decidiendo por su cuenta.

Fuera de ese conmutador, el subsistema es ciego a la jurisdicción: no hay «panel por jurisdicción», y de las 39 claves de `pending-catalog.ts` las únicas que lee son `fuente_tipo_cambio` (`payment-service.ts:365-372` vía `resolverTipoCambio`; `pending-catalog.ts:708-731`) y `pago_corto_residual` (`payment-service.ts:1525-1541`; `pending-catalog.ts:1055-1090`), más las `rep_*` del lado de recordatorios. Ninguna tiene dimensión de jurisdicción. Grep de `tax_tables|tax_parameters` en `src/services/{ar,ap,payments}` y `ar-ap-posting.ts`: cero. Todo umbral y toda tasa que el subsistema usa está en código.

La única bifurcación explícita por país vive en el padrón de proveedores (`vendor-service.ts:61-66`: `MX→rfc`, `US→ein`). El resto trata a Estados Unidos por omisión: lo que no es MX recibe el estrato neutro (cuenta 2135 «Impuesto sobre Ventas por Pagar», `chart-seed.ts:123-127`) y cero líneas de reclasificación de IVA (`ar-ap-posting.ts:452-454`).

---

## 1. Motores

Formato por motor: estado · jurisdicciones · reglas implementadas · reglas por definir (MX / US / ambas) · parámetros (ley / panel / casa / quemado) · puerta.

### M1 · Facturación a clientes (ciclo de vida del documento y su asiento)

**Archivo principal:** `invoice-service.ts` (1017 líneas) + `ar-ap-posting.ts:109-183` (`postInvoiceEntry`).
**Estado:** parcial. **Jurisdicciones:** MX (por el IVA en flujo); US sólo por omisión (una entidad no-MX postea el impuesto a `iva_trasladado`, que el estrato neutro mapea a 2135, `chart-seed.ts:123-127`).

Reglas implementadas:
- El borrador no toca el mayor: `createInvoice` inserta `status='draft'` (`invoice-service.ts:353`) y sólo `issueInvoice` (`:450`) postea (`:506`). Emitir no es enviar: `sent_at/sent_to` sólo con `markSent` (`:492-500`). Cabecera `:14-48`.
- Asiento único e idempotente: DR cxc (total) / CR ingreso por línea (cuenta de la línea o rol `ingreso`) / CR IVA (`ar-ap-posting.ts:144-169`); idempotencia por `journal_entry_id` (`:115`); total cero no postea (`:116`). Entidad dentro del SQL y `FOR UPDATE` (`invoice-service.ts:475-479`).
- Rol de IVA por MetodoPago (LIVA art. 1-B: PUE → 2120, PPD → 2125 «IVA trasladado no cobrado»): `ar-ap-posting.ts:118-120`, decisión en `iva-cash-basis.ts:131-144`; supuesto conservador PUE del lado emitido (`iva-cash-basis.ts:64-67`), y la suposición queda escrita en el asiento (`ar-ap-posting.ts:101-103, :175`).
- Factura en moneda distinta a la funcional **se niega a postear** (`FX_AR_NOT_WIRED`, `ar-ap-posting.ts:133-142`): la regla de no perder el origen (NIF B-15) se cumple por bloqueo.
- Impuesto por línea = `line_amount × tax_rate/100`, redondeo a 4 decimales por línea (`invoice-service.ts:317-319, :334`); cabecera = suma de líneas (`:344`).
- Anulación con reversa espejo NIF B-1 (`invoice-service.ts:641-648`), con guardas: CFDI timbrado no se anula localmente (`:612-617`; CFF 29-A: la cancelación es ante el SAT) y factura con cobros aplicados no se anula (`:618-622`); `paid`/`void` no se encuentran (`:627-631`). **La ruta REST desactiva ambas guardas** con `allowStamped: true, allowApplied: true` (`routes/invoices.ts:228-240`): por REST se anula en libros una factura vigente ante el SAT.
- Timbrado y cancelación por REST: `POST /:id/cfdi/stamp` (`routes/invoices.ts:242-288`) arma un XML mínimo **sin `Receptor`** (`:248-253`; el comentario remite a un `cfdi.ts` que no existe — `src/services/integrations/mexico/` sólo contiene `pac/`); `POST /:id/cfdi/cancel` lanza `NotImplementedError` (`:290-330`). Por tanto `/:id/void` es hoy el único camino que desliga libros y SAT.
- Borrador editable y borrable sólo sin asiento, sin CFDI y sin cobros (`invoice-service.ts:760-765`, `:884-908`); el folio borrado queda como hueco documentado en `audit_log` (`:913-928`) y `checkInvoiceSeries` distingue hueco explicado de hallazgo (`:951-1017`). Folio anual `INV-AAAA-NNNNN` (`sequence.ts:58-60`).
- Listado con antigüedad y saldo reconstruido a fecha (`amount_due_as_of` desde `payment_allocations` por fecha de cobro, `:168-179`), expuesto en `invoice list --as-of` (`invoice-command.ts:375`), y filtro `overdueDays` (`:140-150`).
- Rastro de auditoría propio en emitir/anular/editar/borrar (`:524-536`, `:652-664`, `:841-852`, `:914-928`).

Reglas por definir:
- **MX** · Toda factura es CFDI (CFF art. 29): `issueInvoice` no timbra ni valida el perfil fiscal del receptor (grep de `tax_profile|rfc|regimen|uso_cfdi` en `invoice-service.ts`: cero; RFC/régimen/CP/UsoCFDI existen en M2). La sonda `missing-uuid` (M10) sólo lo reporta después.
- **MX** · Serie/folio CFDI vs folio interno: `INV-` no es el folio fiscal; nada liga serie/folio del CFDI 4.0 con `invoice_number`.
- **MX** · IVA por tasa y objeto de impuesto por concepto (Anexo 20: 16 %, 0 %, exento, `ObjetoImp`), IEPS trasladado y retenciones al cliente (IVA 2/3 e ISR cuando el cliente es persona moral y el emisor persona física, LIVA 1-A / LISR 106): `tax_rate` es un número libre por línea sin catálogo, y no hay líneas de retención en el asiento.
- **US** · Sales tax por jurisdicción (nexus tras *Wayfair*, tasas estatales/locales, exención por certificado): sólo la cuenta 2135 y un `tax_rate` libre; grep de `sales.?tax|nexus|wayfair` fuera de comentarios: cero.
- **US** ASC 606 / **MX** NIF D-1: el asiento reconoce el 100 % del ingreso a la fecha de la factura (`ar-ap-posting.ts:144-173`); grep de `deferred_revenue|ingreso.?diferido|606`: cero.
- **Ambas** · Límite y estado de crédito: `credit_limit`/`credit_status` se guardan, editan y filtran (`customer-service.ts:64, :210-212, :424-434`; `002:174, :180-181`) pero **ningún camino los lee al crear o emitir**; `customer-command.ts:54` lo declara a propósito («Credit is deliberately absent»). El catálogo lo registra en `catalog:630-636`.
- **Ambas** · FX en ventas (NIF B-15 / ASC 830): pendiente por diseño (`ar-ap-posting.ts:124-142`).

Parámetros:
- `currency_code` por defecto `'USD'` (`invoice-service.ts:357`; `002:206`) — **quemado**: debería ser la funcional de la entidad.
- Prefijos de folio `INV/PMT/BILL/VPMT/JE/CN` (`invoice-service.ts:687-694`) y formato `prefijo-AAAA-NNNNN` (`sequence.ts:58-60`) — **casa**, con la reserva MX de que no son serie/folio fiscal.
- Supuesto PUE cuando no hay MetodoPago (`iva-cash-basis.ts:64-67`) — **quemado**: criterio fiscal declarado en código, no en el panel.
- Estados abiertos `pending,sent,viewed,partially_paid,overdue` (`customer-service.ts:49-51`; espejo en `ar-controls.ts:26` y `report-service.ts:856`) — **casa**.

Puerta: CLI `invoice list|show|create|issue|void|edit|delete|series list|series check` (`src/cli/invoice-command.ts`); REST `GET/POST /v1/invoices`, `/:id/send`, `/:id/void`, `/:id/payments`, `/:id/cfdi/stamp`, `/:id/cfdi/cancel` (`routes/invoices.ts:97-330`); GraphQL `createInvoice`, `voidInvoice` (`resolvers/index.ts:487, :525`). Agente: ninguna herramienta de escritura (`superficie.ts:31-32` sólo `search_customers/search_vendors`).

### M2 · Padrón de clientes, saldo y perfil fiscal CFDI 4.0

**Archivo principal:** `customer-service.ts` (776 líneas). **Estado:** parcial. **Jurisdicciones:** MX (perfil fiscal); saldo y archivo son neutros.

Reglas implementadas:
- Saldo nunca almacenado, siempre derivado de facturas abiertas (`:138-184`, `:288-300`), en dos modos: hoy (`amount_due`) o reconstruido a fecha desde cobros por `payment_date` (`openDocumentExpr`, `:138-157`), con el límite declarado de las anulaciones sin fecha (`:134-136`). Expuesto en `customer show --as-of` (`customer-command.ts:150, :326`).
- Archivar exige saldo cero salvo `--force` con motivo (`:524-543`); `reason` persistido en `audit_log` (`:498-507`).
- Perfil fiscal CFDI 4.0: RFC por forma (`:583`, `:666-675`), régimen contra `c_RegimenFiscal` y UsoCFDI contra `c_UsoCFDI` por separado (`:676-684`, `:691-699`; `SAT_CATALOGS` en `sat-catalogs.ts`), CP de 5 dígitos (`:685-690`); listado de incompletos como control previo a facturar (`:750-776`). Base: `049:100-107`.
- Resolución por número/nombre/uuid con conflicto explícito ante ambigüedad (`:342-380`).

Reglas por definir:
- **MX** · Validación del RFC contra el padrón (LCO) y dígito verificador: sólo forma (`:668`). Grep de `d[ií]gito.?verificador|check.?digit` en `src` sólo encuentra CLABE/ABA (`bank-account-service.ts:21, :50`), y `vendor-service.ts:70` declara que no verifica el dígito del RFC. Régimen–UsoCFDI compatibles (Anexo 20): no se cruzan.
- **US** · Identificador fiscal del cliente (EIN/SSN) y certificado de exención de sales tax: `tax_id_type` libre; no hay validación EIN del lado cliente (sí del lado proveedor, M6).
- **Ambas** · Evaluación y exposición de crédito (`catalog:630-636`).

Parámetros: `payment_terms='Net 30'` y `currency_code='USD'` (`:433-434`; `002:173, :175`) — **quemado**; numeración `C-AAAA-n` por `COUNT(*)` (`:412-416`, autodeclarada propensa a carrera) — **casa**; regex RFC y CP (`:583`, `:686`) — **ley** (forma fijada por el SAT; aceptable en código mientras sea sólo forma).

Puerta: CLI `customer list|show|create|edit|archive|restore|tax show|tax set|tax list` (`src/cli/customer-command.ts`); REST `routes/customers.ts`; agente `search_customers` (lectura, `search-tools.ts:69`).

### M3 · Notas de crédito a clientes

**Archivo principal:** `credit-note-service.ts` (581 líneas) + `ar-ap-posting.ts:333-399` (`postCreditNoteEntry`). **Estado:** parcial. **Jurisdicciones:** MX (IVA por método de pago); el resto neutro.

Reglas implementadas:
- Documento propio con folio `CN`, tipos `devolucion|descuento|correccion|anticipo` (`enums.ts:92`; `049:45`), nace en borrador y **postea al emitir**: DR `devolucion_ventas` (subtotal) / DR IVA / CR cxc (total) (`ar-ap-posting.ts:362-385`). La aplicación no genera asiento: reparte el crédito en el auxiliar (`credit-note-service.ts:13-22`, `:525-538`).
- El rol de IVA sigue al MetodoPago de la factura ligada (PUE → 2120; PPD no cobrada → 2125) (`ar-ap-posting.ts:341-359`); sin factura ligada asume PUE y lo escribe en el asiento (`:329-331, :377`).
- Liga fiscal en la aplicación: nota ligada sólo a su factura; nota suelta no se aplica a factura PPD (`credit-note-service.ts:487-512`) — evita IVA aparcado para siempre.
- Validaciones: subtotal > 0, IVA ≥ 0 (`:94-99`); no acreditar más que la factura (`:129-134`); mismo cliente (`:117-121`, `:470-474`); misma moneda (`:123-128`, `:481-486`); sólo a facturas `sent|viewed|partially_paid|overdue` (`:41`, `:475-480`); no exceder saldo (`:518-523`); `amount_paid` no se toca — una nota no es efectivo (`:530-538`).
- Descuento concedido a cliente **es nota de crédito**, no línea del cobro (`payment-service.ts:178-201`).

Reglas por definir:
- **MX** · CFDI de egreso obligatorio (CFF 29; Anexo 20 tipo «E», `TipoRelacion` 01/02/03): `credit_notes.cfdi_uuid` existe (`049:58-59`) y nada lo escribe desde el servicio; la sonda `missing-uuid` sólo consulta `invoices` (`ar-controls.ts:275-297`).
- **MX** · Nota de tipo `anticipo` (Anexo 20, Apéndice 6): el tipo existe pero el asiento es el mismo para los cuatro tipos (`ar-ap-posting.ts:362-385`; grep de `anticipo` en `credit-note-service.ts`: cero); no descuenta `anticipo_clientes` ni liga al CFDI de anticipo. El criterio contable **ya está escrito** en la taxonomía CFDI como plan de póliza para `TipoRelacion 07` — DR `anticipo_clientes`, DR `iva_trasladado`, CR `cxc` (`cfdi-taxonomy.ts:289-300`) — sin ejecutor del lado emitido (ver M15).
- **Ambas** · Anular una nota emitida (`credit-note void`): la CLI registra sólo `create|show|list|issue|apply` (`credit-note-command.ts:196, :263, :319, :377, :440`); sin backend (`catalog:706`).
- **Ambas** · Nota de cargo / *debit note* al cliente (intereses, gastos de cobranza): grep de `debit.?note|nota.?de.?cargo`: cero (`catalog:707-709`).
- **US** · El reverso de sales tax en devoluciones sigue la misma línea que el IVA; sin motor de sales tax (M1) no hay nada jurisdiccional que revertir.

Parámetros: supuesto PUE sin factura ligada (`ar-ap-posting.ts:359`) — **quemado**; `APLICABLES` (`credit-note-service.ts:41`) — **casa**; tope de listado 50/500 (`:295`) — **casa**.

Puerta: CLI `credit-note create|show|list|issue|apply` (`src/cli/credit-note-command.ts`). Sin REST, GraphQL ni agente.

### M4 · Cobranza: registro de cobro, saldo a cuenta, aplicación, desaplicación y reversa NSF

**Archivo principal:** `payment-service.ts:509-1383` + `ar-ap-posting.ts:521-592` (`postCustomerPaymentEntry`), `:627-708` (`postReceiptApplicationEntry`), `:922-973` (`postReceiptUnapplicationEntry`). **Estado:** parcial. **Jurisdicciones:** MX (liberación de IVA); resto neutro.

Reglas implementadas:
- Sólo se registra lo que ya ocurrió: `status='completed'` único (`payment-service.ts:55`, `:132-141`).
- Aplicaciones: sin duplicados (`:167-176`), suma ≤ pago (`:215-220`), suma exacta salvo `onAccount` explícito (`:221-230`); sólo facturas `sent|viewed|partially_paid|overdue` (`:683`, `:532-537`); misma moneda (`:234-242`); mismo cliente (`:539-544`); no exceder saldo (`:547-551`).
- Asiento: DR banco (cuenta del banco o rol `banco`, `ar-ap-posting.ts:402-416`) / CR cxc por lo aplicado / CR `anticipo_clientes` por el remanente (`:537-565`) + liberación de IVA PPD (M5) con el importe guardado por aplicación (`:580-588`; `049:84-88`).
- Anticipo puro sin documento: exige cliente y toma su moneda (`payment-service.ts:567-577`).
- Aplicación posterior (`applyCustomerPayment`): mueve el crédito de 2150 a cxc y libera IVA por la parte que ESTE evento aplica (`ar-ap-posting.ts:627-708`); base acumulada para que las parciales no deriven (`payment-service.ts:840-846`; `iva-cash-basis.ts:271-291`).
- Desaplicar clausura la fila (nunca la borra) con quién/cuándo/por qué (`payment-service.ts:1002-1007`) y re-aparca el IVA exacto; filas pre-049 se estiman pro-rata y el asiento lo dice (`:985-1000`; `ar-ap-posting.ts:944-961`).
- Reversa NSF: espejo NIF B-1 de todos los asientos del cobro (`:1293-1310`), reapertura de facturas (`:1313-1346`), clausura de aplicaciones (`:1347-1352`), estado `reversed` distinto de `void` (`:1354-1357`; `049:90-98`). La comisión bancaria se **rechaza** (`:1278-1287`) aunque el rol `comision_bancaria` existe en `AccountRole` (`cfdi-taxonomy.ts:40`) y en `ROLE_MAP` con la cuenta 6310 (`account-roles-seed.ts:278`), y aunque **la banca ya la postea** con ese rol e IVA (`treasury-posting.ts:885-897`): el texto del rechazo («la capa semántica aún no tiene») está desactualizado.
- REP: `needsRep` lista cobros sin CFDI tipo P (`:1217-1219`); `cfdi_uuid`+`cfdi_pago_indice` con índice único parcial (`036`).

Reglas por definir:
- **MX** · **IVA sobre anticipos** (LIVA art. 1-B: el impuesto se causa al cobro, incluidos anticipos): el remanente a cuenta se abona íntegro a `anticipo_clientes` sin desglosar IVA trasladado (`ar-ap-posting.ts:558-565`). El plan `ingreso_emitido_anticipo` de la taxonomía sí lo desglosa (CR `anticipo_clientes` subtotal, CR `iva_trasladado`; `cfdi-taxonomy.ts:189-201`), pero nada lo ejecuta del lado emitido (M15).
- **MX** · CFDI de anticipo y su aplicación (Anexo 20, Apéndice 6): sin emisión ni liga.
- **MX** · REP emitido en plazo (RMF 2.7.1.32): el subsistema sólo marca la falta; `rep-command.ts` registra `missing`, `list` y `reconcile` (`:85-128`), no emite; grep de generador (`Pagos20|complemento.?de.?pagos|TipoDeComprobante="P"`) fuera del parser: cero.
- **MX** · `payment_method` (`cash|check|ach|wire|spei|credit_card|other`, `002:122-123`) → `c_FormaPago`: **existe el mapa en la dirección SAT → interno** (`FORMA_PAGO` con las claves `01,02,03,04,28`, `rep-linkage.ts:67-84`; catálogo completo en `sat-catalogs.ts:70-84`) para la ingesta del REP. Lo que falta es la dirección inversa (interno → SAT) para emitir REP y Anexo 24, y cobertura de los 7 valores internos (`wire` y `ach` no tienen clave).
- **US** · Cobros por *lockbox*/remesa y cotejo por subconjunto (`catalog:721, :727`); *refund* real a la pasarela (`catalog:726`, adaptadores simulados).
- **Ambas** · Fecha contable del evento de aplicación/desaplicación = `new Date()` (`ar-ap-posting.ts:682, :965`): no se puede fechar el evento en el periodo del cobro; afecta el corte. (`payment-service.ts:861` también es `new Date()`, pero escribe `last_payment_date` de la factura, no la fecha del asiento.)
- **Ambas** · Comisión por devolución (NSF fee) con rol y motor ya existentes en banca: rechazada aquí (`payment-service.ts:1278-1287`).
- **Ambas** · Intereses moratorios / *finance charges* sobre saldos vencidos (MX: LIVA 18 los grava; US: topes de usura estatales): grep de `finance.?charge|inter[eé]s.{0,10}morator|late.?fee`: cero (`catalog:761`).
- **Ambas** · Estado de cuenta al cliente y recordatorios (M14).

Parámetros: moneda por defecto `'MXN'` cuando no hay documentos (`payment-service.ts:686-688`) frente a `'USD'` en el resto del subsistema — **quemado**; `COBRABLES` (`:683`) — **casa**; topes de listado 50/500 (`:1238`) — **casa**; antigüedad «vieja» de efectivo sin aplicar 30 días (M10) — **quemado**.

Puerta: CLI `receipt record|show|list|apply|unapply|reverse` (`src/cli/receipt-command.ts`); REST `POST /v1/invoices/:id/payments` (`routes/invoices.ts:175-216`, una sola aplicación por el importe total, sin `onAccount`); GraphQL `recordCustomerPayment` (`resolvers/index.ts:569`); ingesta de REP (`rep-linkage.ts:337-338`). Agente: ninguna.

### M5 · Liberación de IVA en flujo de efectivo (transversal AR/AP)

**Archivo principal:** `ar-ap-posting.ts:440-513` (`ivaReclassLines`) + `iva-cash-basis.ts` (fuera de las carpetas, pero es el motor que decide). **Estado:** completo para MX dentro de su alcance declarado. **Jurisdicciones:** MX.

Reglas implementadas:
- LIVA art. 5 (acreditamiento cuando el IVA fue efectivamente pagado) y art. 1-B (causación al cobro): el pago mueve 2125→2120 (emitido) y 1135→1130 (recibido) por la parte pagada (`ar-ap-posting.ts:470-478`; `reclassRoles`, `iva-cash-basis.ts:242-243`).
- Pro-rata acumulado, sin deriva en parciales y con el último pago liberando el resto exacto (`iva-cash-basis.ts:271-291`); tope por lo que realmente quede aparcado (`ivaStillParked`, `:527`).
- Importe liberado guardado por aplicación (`payment_allocations.iva_reclass_amount`, `049:84-85`; `payment_applications.iva_reclass_amount`, `050:39-40`) para desaplicar exacto.
- FX del lado proveedor: liberación valuada a la tasa histórica del documento (`ar-ap-posting.ts:444-450, :487-506`).
- Entidad no mexicana: cero líneas (`:452-454`).

Reglas por definir:
- **MX** · El conmutador es `entityUsesCashBasisIva` y no `esContabilidadMexicana` (§0): país nulo → sin flujo de efectivo mientras la siembra (`entity-accounting.ts:75, :172`) sí da estrato mexicano.
- **MX** · IVA del pago corto: sale de 1135 sin acreditarse (`ar-ap-posting.ts:777-816`) — correcto bajo LIVA 5, pero el reparto «proporcional al peso del IVA en el total» (`:797-799`) es un criterio en código.
- **US** · No aplica (el impuesto sobre ventas se devenga en la venta). Nada que definir salvo asegurar que el estrato neutro no reciba estas líneas (hoy garantizado por `:452`).

Parámetros: `CONSERVATIVE_METODO` (emitido PUE / recibido PPD, `iva-cash-basis.ts:64-67`) — **quemado**; `SCALE=4` (`:262`) — **casa**.

Puerta: ninguna propia; corre dentro de M4, M8 y M9.

### M6 · Padrón de proveedores, identificador fiscal por país y condiciones de pago

**Archivo principal:** `vendor-service.ts` (595 líneas). **Estado:** parcial. **Jurisdicciones:** MX y US (el único motor del subsistema con bifurcación explícita por país).

Reglas implementadas:
- Tipo de identificador por país: `MX→rfc`, `US→ein` (`:61-66`); forma del RFC con fecha plausible (`:79-96`) y sin dígito verificador, declarado (`:70`); EIN `NN-NNNNNNN` (`:99-105`); VAT con prefijo ISO (`:108-112`); la regla aplicada se imprime (`:56-57`).
- Condiciones de pago parseadas: `Net N`, `N días`, `2/10 Net 30`, `Due on receipt|contado|PUE` (`:138-173`); fecha de vencimiento derivada (`:176-183`); `setVendorTerms` rechaza texto no entendido (`:540-547`) y valida ISO-4217 por forma (`:552-555`).
- Datos bancarios cifrados en el alta y redactados por defecto (`:189-207`, `:418-424`); no se editan por esta capa (cabecera `:32-38`; `VENDOR_UPDATABLE_FIELDS` `:450-452`).
- Filtros `is1099` y `missingTaxId` como lista de bloqueos DIOT/1099 (`:256-262`; opciones `--1099`, `--no-tax-id` en `vendor-command.ts:177-190`).
- Auditoría con `old_values/new_values/reason` cuando hay inquilino (`:504-516`, `:578-590`).

Reglas por definir:
- **MX** · Perfil fiscal del proveedor con vigencias (régimen, RESICO, REPSE, perfil de retención) — `catalog:859` (ausente). Escrutinio 69-B CFF / EFOS — `catalog:868` (ausente). **El insumo ya entra**: la consulta de estatus al SAT devuelve `ValidacionEFOS` por CFDI (`cfdi-status.ts:35, :90, :155`) y `sat-validation.ts:51` lo guarda en `rawResponse`; ningún código lo lee después (grep de `EFOS` fuera de esos dos archivos: cero). Es dato capturado, no escrutinio.
- **US** · W-9/TIN matching, caja 1099 y W-8 para extranjeros — grep de `w-?9|tin.?match|w-?8`: cero; sólo `is_1099_vendor` (`002:17`) y los filtros de listado (`catalog:859, :868`).
- **Ambas** · Cambio de datos bancarios con verificación fuera de banda y segunda firma — sin flujo (`catalog:863-865`).
- **Ambas** · Conciliación de estado de cuenta del proveedor — `catalog:873` (ausente).

Parámetros: `payment_terms='Net 30'`, `currency_code='USD'` (`:421-422`; `002:23, :25`) — **quemado**; regex RFC/EIN/VAT (`:46-50`) — **ley** (forma; aceptable en código); tokens de condiciones en inglés/español (`:138, :154-160`) — **casa**; numeración `V-AAAA-n` por `COUNT(*)` (`:403-407`) — **casa**.

Puerta: CLI `vendor list|show|create|edit|terms set` (`src/cli/vendor-command.ts`); REST `routes/vendors.ts`; agente `search_vendors` (lectura, `search-tools.ts:108`).

### M7 · Facturas de proveedor: captura, codificación, aprobación y reconocimiento del pasivo

**Archivo principal:** `bill-service.ts` (612 líneas) + `ar-ap-posting.ts:189-309` (`postBillEntry`). **Estado:** parcial. **Jurisdicciones:** MX (IVA por método de pago, FX NIF B-15, retenciones y LISR 27-III sólo por la vía de ingesta); US por omisión.

Reglas implementadas:
- Aritmética pura sin base de datos: `qty × price`, impuesto aditivo por línea, cabecera = suma (`computeBill`, `:300-338`). Borrador (`:353`).
- Recodificar sólo antes de aprobar (`EDITABLE_STATUSES`, `:43`, `:413-419`); los importes no se editan aquí («`bill edit` sin backend», `:391-395`; `catalog:914`).
- Aprobar = reconocer el pasivo en la misma transacción: DR gasto por línea / DR IVA (rol según MetodoPago, PPD → 1135) / CR cxp (`ar-ap-posting.ts:198-202, :241-295`); idempotente dos veces (`bill-service.ts:474-477`); ensayo con el motor real (`:556`).
- Supuesto conservador PPD cuando el gasto no trae MetodoPago (LIVA 5: no acreditar antes de pagar) (`iva-cash-basis.ts:64-67`; `bill-service.ts:479-485`).
- FX al nacer (NIF B-15): conversión a funcional con la tasa **del documento**, cuatro columnas FX por línea, rechazo si la tasa es nula o 1.0 (`FX_RATE_MISSING`, `ar-ap-posting.ts:211-227`); el abono a cxp es la suma de cargos ya redondeados y las columnas FX del abono sólo si dicen la verdad (`:262-285`).
- Listado por fecha de documento o de posteo (corte de devengo, `:45-52, :98`), `dueBefore` para la corrida de pagos (`:107-110`).
- Descuento por pronto pago `2/10 net 30`: derecho = `amount_due × pct` si `paymentDate − bill_date ≤ discountDays` (`:587-612`); consumido por M9.
- **Retenciones, sólo por ingesta.** Los roles `isr_retenido_por_pagar`/`iva_retenido_por_pagar` (`cfdi-taxonomy.ts:27`; `ROLE_MAP` → 2140, `account-roles-seed.ts:261-262`) **sí tienen escritor**: dos planes de gasto recibido de la taxonomía los abonan con los importes que trae el CFDI (`cfdi-taxonomy.ts:151-152`, `:171-172`; importes de `cfdi-facts.ts:229-234`, `:242-245`) y `pre-registration-service.ts:1150-1165` postea `plan.lineas` con `createJournalEntry`. La puerta es `bill inbox run` (`bill-command.ts:864-940`).
- **LISR 27-III, sólo por ingesta.** `cfdi-decisions.ts:93-94` define `CASH_DEDUCTION_LIMIT_MXN = 2_000` y `:209-227` el punto de decisión bloqueante `efectivo_no_deducible` (base declarada: «LISR art. 27 sec. III; LIVA art. 5 sec. I»), disparado por `pagadoEnEfectivo` (`cfdi-facts.ts:165`, FormaPago 01) y `total > 2000`, con la opción `gasto_no_deducible`.

Reglas por definir:
- **MX** · **Cálculo de retenciones** en CxP (ISR 10 % honorarios y arrendamiento a personas físicas, LISR 106/116; IVA 2/3 partes LIVA 1-A; RESICO 1.25 % LISR 113-J; fletes 4 %): `computeBill` no tiene concepto de retención (`:300-338`) y `postBillEntry` nunca usa los roles 2140. El importe hoy lo trae el CFDI; falta el cálculo con perfil por proveedor, tasa y vigencia, su aplicación al `bill create` manual, y el pasivo y entero del día 17 (`catalog:1063-1074`, ausente).
- **MX** · Requisitos de deducibilidad (LISR 27-I/III/XVIII): la comprobación del medio de pago existe sólo en la ingesta con umbral quemado; no existe en `approveBill` ni en `recordVendorPayment` (grep de `27-III|2,?000` en `src/services/{ap,payments}`: cero), y el umbral no está en el panel (las claves `umbral_*` de `pending-catalog.ts` son de capitalización y anticipados). CFDI válido y comprobante del ejercicio: nada lo comprueba al aprobar ni al pagar.
- **MX** · Nota de crédito del proveedor como documento de CxP: sólo el plan de póliza para el CFDI «E» recibido (`cfdi-taxonomy.ts:273-288`), no un documento capturable ni aplicable a mano.
- **US** · Use tax acumulado sobre compras sin sales tax (`ap accrue --kind use-tax`, `catalog:989`): grep cero.
- **US** · 1099: no hay acumulación por proveedor y año calendario de pagos reportables (IRC §6041/§6041A; umbral $600 histórico, $2,000 para pagos desde 2026 tras OBBBA); sólo la bandera.
- **Ambas** · Anular/reversar un gasto aprobado: la CLI registra `list|show|create|line set|approve|inbox` (`bill-command.ts:423-940`) y REST no tiene ruta (`routes/bills.ts:81-162`); `bill void`/`bill reverse` sin backend (`catalog:939-940`); el estado `void` es inalcanzable.
- **Ambas** · Devengo de servicios recibidos no facturados con reversión automática (`catalog:989`).
- **Ambas** · Tres vías / *three-way match* contra OC y recepción: `purchase_order_id` es sólo una columna (`002:73`); ausente (`catalog:883`).

Parámetros: `currency_code='USD'` (`bill-service.ts:357`; `002:58`) — **quemado**; `APPROVABLE/EDITABLE_STATUSES` (`:41-43`) — **casa**; ventana de descuento contada desde `bill_date` con `Math.floor(ms/86400000)` (`:597-600`) — **casa**, con la reserva de que la base del plazo (factura vs recepción) y la zona horaria son criterio; **base del descuento = `amount_due` con IVA** (`:591, :601`) — **quemado** (LIVA 7); `CASH_DEDUCTION_LIMIT_MXN = 2_000` (`cfdi-decisions.ts:94`) — **ley**, hoy quemado.

Puerta: CLI `bill list|show|create|line set|approve|inbox list|inbox run` (`src/cli/bill-command.ts`); REST `GET/POST /v1/bills`, `/:id/approve` (`routes/bills.ts:81-147`); `/:id/schedule-payment` retirado con 410 (`:149-156`). Ingesta CFDI: `bill inbox run` → `pre-registration-service.ts:1105` (`INSERT INTO bills`) y `:1150-1165` (asiento). Agente: sólo vía esa ingesta.

### M8 · Pagos a proveedor: registro, anticipo, descuento por pronto pago y diferencia cambiaria realizada

**Archivo principal:** `payment-service.ts:246-505` (`recordVendorPayment`) + `ar-ap-posting.ts:987-1196` (`postVendorPaymentEntry`) + `moneda-origen.ts` (aritmética FX, fuera de las carpetas). **Estado:** parcial. **Jurisdicciones:** MX (IVA en flujo, DOF vía política); FX neutro (NIF B-15 / ASC 830 coinciden en lo realizado).

Reglas implementadas:
- Sólo gastos `approved|posted|partially_paid` (`:681`, `:286-291`): el pasivo debe estar en el mayor. Misma moneda (`:292`), mismo proveedor (`:293-298`), `efectivo + descuento ≤ saldo` (`:299-311`).
- Desglose del pago: lo aplicado baja cxp; el descuento extingue pasivo sin salir del banco y se abona a `devolucion_compras` 5200 (`ar-ap-posting.ts:1115-1178`); lo pagado de más es `anticipo_proveedores` 1150 (`:1157-1164`). `amount_paid` recibe sólo efectivo; `amount_due` baja por los dos (`payment-service.ts:414-429`).
- FX: pasivo por documento a su tasa histórica, efectivo a la tasa del día, brecha a `perdida_cambiaria`/`utilidad_cambiaria` (`ar-ap-posting.ts:1009-1088`); tasa del día explícita o resuelta con la política `fuente_tipo_cambio` (DOF por defecto, CFF art. 20) y **se detiene** si falta (`payment-service.ts:354-373`; `pending-catalog.ts:708-731`); gasto extranjero con tasa 1.0/nula se rechaza (`:340-353`); `exchange_rate` siempre escrito (`:405`).
- IVA PPD liberado a la tasa histórica (M5). REP ligado por `cfdi_uuid`+índice (`036`). Auditoría con la diferencia y la fuente (`:461-485`).

Reglas por definir:
- **MX** · **Descuento por pronto pago e IVA** (LIVA art. 7: los descuentos posteriores disminuyen el IVA acreditable y requieren CFDI de egreso del proveedor): el descuento se calcula sobre `amount_due` con IVA y va íntegro a 5200 sin tocar 1130/1135 (`bill-service.ts:601`; `ar-ap-posting.ts:1171-1178`) → IVA sobre-acreditado por la parte del descuento.
- **MX** · LISR 27-III (medio de pago según monto): `payment_method` no se cruza con el importe en este camino (la regla vive sólo en la ingesta, M7).
- **MX** · `payment_method` → `c_FormaPago` para el REP recibido: sólo el sentido SAT → interno (M4).
- **US** · Método bruto vs neto para descuentos de compra (política contable a revelar, ASC 235): sólo bruto, siempre a 5200.
- **US** · Emisión del pago (NACHA CCD/CTX/PPD, cheque impreso, *positive pay*): grep cero (`catalog:1019-1029`); el registro sólo documenta lo ya salido del banco.
- **Ambas** · Anular o desaplicar un pago a proveedor: `payment-command.ts` registra sólo `create|apply` (`:197, :272`); `payment_applications` no tiene clausura (`050:17-36`) y `remanenteDeVendorPago` no filtra (`payment-service.ts:1440-1457`); `catalog:1041-1042`.
- **Ambas** · Pago a cuenta en moneda extranjera y su revaluación al cierre (NIF B-15 no realizada / ASC 830): fase 2 declarada (`ar-ap-posting.ts:981-985`; `moneda-origen.ts:12`).

Parámetros: `PAGABLES` (`payment-service.ts:681`) — **casa**; `fx?.tasaPago ?? '1.0'` en funcional (`:405`) — **casa**; destino fijo del descuento en `devolucion_compras` (`ar-ap-posting.ts:1171-1178`) — **quemado**: debería ser política como lo es el pago corto, y la firma de `postVendorApplicationEntry` ya admite el rol como parámetro (`ar-ap-posting.ts:733`); `fuente_tipo_cambio` — **panel**.

Puerta: CLI `payment create` (`src/cli/payment-command.ts:117-202`, con `--discount`); REST `POST /v1/bills/payments` (`routes/bills.ts:162-199`); ingesta REP recibido (`rep-linkage.ts:337`). Agente: ninguna.

### M9 · Aplicación posterior de pago a proveedor y pago corto

**Archivo principal:** `payment-service.ts:1488-1739` (`applyVendorPayment`) + `ar-ap-posting.ts:721-913` (`postVendorApplicationEntry`). **Estado:** parcial (el único motor del subsistema cuya bifurcación de criterio ya vive en el panel). **Jurisdicciones:** MX (IVA no acreditable del saldo condonado); neutro en lo demás.

Reglas implementadas:
- El efectivo no se toca; se mueve el derecho: DR cxp / CR `anticipo_proveedores` (`ar-ap-posting.ts:846-872`).
- Modo `partial` (el gasto sigue abierto) o `residual` (se cierra pagando de menos) con motivo obligatorio (`payment-service.ts:1459-1468`, `:1508-1515`).
- Destino del saldo condonado por política `pago_corto_residual` (`descuento_compras` 5200 · `otros_ingresos` 4300 · `prohibir`) (`:1525-1541`; `pending-catalog.ts:1055-1090`); la capa de posteo no elige: exige el rol como parámetro (`writeOffRole`, `ar-ap-posting.ts:733`) y falla si falta (`WRITE_OFF_ACCOUNT_UNRESOLVED`, `:726-748`). Base normativa: NIF C-19 / ASC 405-20 (baja de pasivo → resultado) vs NIF C-4 / costo de adquisición.
- Descuento tomado contra el derecho que dan las condiciones (`earlyPaymentDiscount`): tomar más que el derecho se rechaza y se manda a `residual`; fuera de términos se admite y se reporta (`:1600-1616`).
- IVA del saldo condonado sale de 1135 sin acreditarse, proporcional y topado por lo aparcado (`ar-ap-posting.ts:777-816`), y el pago corto sólo lleva a la cuenta destino la parte de costo (`:881-898`).
- Auditoría con motivo, cuenta y si la política estaba definida (`payment-service.ts:1696-1718`).

Reglas por definir:
- **MX** · Un saldo condonado por el proveedor exige CFDI de egreso de éste para el efecto en IVA; aquí se resuelve en libros sin documento fiscal (`prohibir` es la única opción que lo exige, `:1529-1535`).
- **US** · Ninguna adicional a la política existente; falta poder fechar el evento.
- **Ambas** · Fecha del asiento = `new Date()` (`ar-ap-posting.ts:903`). (`payment-service.ts:1649` es `last_payment_date` del gasto, no la fecha contable.)

Parámetros: reparto del IVA condonado proporcional al peso del IVA en el total (`ar-ap-posting.ts:797-799`) — **quemado**; fecha del evento — **quemado**; `pago_corto_residual` — **panel**.

Puerta: CLI `payment apply` (`payment-command.ts:126-128, :274-281`: `--bill`, `--amount`, `--discount`, `--mode`, `--short-pay-reason`). Sin REST.

### M10 · Control auxiliar CxC vs cuenta de control y batería de sondas

**Archivo principal:** `ar-controls.ts` (378 líneas). **Estado:** completo dentro de su alcance («hoy», sin `as-of`, `:18-22`). **Jurisdicciones:** MX en tres sondas (UUID/CFDI); resto neutro.

Reglas implementadas:
- Auxiliar neto = facturas abiertas − notas emitidas por aplicar (`:63-81`); control = Σ(débitos − créditos) de asientos `posted` sobre el rol `cxc` (`:55-61`); cuadra con |Δ| < 0.01 (`:110`); lista los asientos manuales sobre el control excluyendo los cinco `source_type` del motor (`:86-101`).
- Nueve sondas con nivel (`:147-338`): `subledger-delta` (bloqueante), `negative-balance`, `over-application` (cobros + notas > total + 0.005), `orphan-application` (aplicaciones vivas de cobros muertos), `duplicate-invoice` (aviso), `stale-unapplied-cash` (> 30 días, aviso), `missing-uuid` (Anexo 24 RMF, aviso), `cancelled-cfdi-open` (bloqueante), `stamped-without-entry` (bloqueante).

Reglas por definir:
- **Ambas** · Cuadre a fecha (`--as-of`) y por moneda (`catalog:804`): rechazado a propósito (`:18-22`).
- **Ambas** · Consumo por `close --check`: `runArChecks` sólo lo importa `ar-command.ts:3, :184`; grep de `runArChecks|arReconcile|subledger|auxiliar` en `close-command.ts` y `period-close.ts`: cero.
- **US** · Sonda de saldos a favor prescritos (*escheat*, leyes estatales de bienes no reclamados): sólo existe la de 30 días.
- **MX** · Sonda de facturas PPD cobradas sin REP emitido: vive en `rep missing` (`rep-command.ts:85-91`), no en esta batería.

Parámetros: `ABIERTAS` (`:26`) — **casa**; tolerancia 0.01 (`:110`) y 0.005 (`:197, :262`) — **casa**; 30 días de efectivo sin aplicar (`:263`) — **quemado** (prescripción/escheat US; control fiscal MX de anticipos); muestra de 5 (`:144`) y 50 asientos manuales (`:99`) — **casa**.

Puerta: CLI `ar reconcile`, `ar check [--check …]` (`src/cli/ar-command.ts:110, :184`). Sin REST ni agente.

### M11 · Cuadre CxP vs cuenta de control con partidas conciliatorias

**Archivo principal:** `ap-controls.ts` (568 líneas). **Estado:** completo dentro de su alcance (con `as-of` declarado sesgado). **Jurisdicciones:** neutro.

Reglas implementadas:
- Signo del pasivo: mayor = créditos − débitos (`:276-289`); diferencia = subdiario − mayor (`:424`); subdiario con los mismos `PAYABLE_OPEN_STATUSES` de la antigüedad, importados, no copiados (`:4`, `:273`, `:291-303`).
- Tres partidas nombradas y un residuo: `asiento-manual` (excluye reversiones NIF B-1 de asientos del motor, `:326-331`), `gasto-sin-asiento` (`:338-364`), `asiento-sin-gasto` sólo si ningún pago contabilizado lo liquidó (`:366-420`), `residuo` si |sin explicar| ≥ 0.01 (`:450-452`). Totales por ventana sobre todas las filas, no sobre las enumeradas (`:426-430`).
- Corte a fecha en ambos lados dentro del SQL, con advertencia explícita de que `amount_due` es de hoy (`:245-265`, `:478-487`); fecha local, no UTC (`:136-149`); validación de fecha real (`:151-160`).
- `ORIGENES_CXP` = `bill, vendor_payment, vendor_application` (`:54`) — el propio archivo avisa que `payment_run post` debe añadirse el día que exista (`:44-53`).

Reglas por definir:
- **Ambas** · Batería de sondas espejo de M10 (`ap check`): `ap-command.ts` registra sólo `reconcile` (`:105, :139`).
- **Ambas** · Partida para pagos cortos por gasto: la condonación no se guarda por documento (`:365-380`), así que cae al residuo.

Parámetros: `TOLERANCIA=0.01` (`:64`), `MAX_FILAS=200` (`:73`), `0.005` (`:403`) — **casa**.

Puerta: CLI `ap reconcile [--as-of] [--explain]` (`src/cli/ap-command.ts:159`). Sin REST ni agente.

### M12 · Antigüedad de saldos (CxC y CxP)

**Archivo principal:** `report-service.ts:827-962` (fuera de las carpetas) + cubetas en `report-command.ts:722-728`. **Estado:** parcial. **Jurisdicciones:** neutro.

Reglas implementadas:
- Filas por documento abierto con `days_overdue = as_of − due_date` (`report-service.ts:868-887`, `:889-908`); estados abiertos (`:856-857`); total sobre todo el conjunto, no sobre la página (`:920-935`).
- Límite declarado: envejece el vencimiento sobre `amount_due` **actual**, no reconstruye el saldo a la fecha (`:859-867`).
- Cubetas `current / 1-30 / 31-60 / 61-90 / 90+` sólo en el CLI (`bucketOf`, `report-command.ts:722-728`); REST y agente publican fila por fila sin cubetas (`routes/reports.ts:179-200`; `report-tools.ts:185, :215`).
- **La reconstrucción a fecha ya existe fuera del reporte**: `invoice list --as-of` calcula `amount_due_as_of` por factura (`invoice-service.ts:168-179`; `invoice-command.ts:375`, `withAging: true`) y `customer show --as-of` reconstruye el saldo del cliente (`customer-service.ts:138-157`; `customer-command.ts:150, :326`).

Reglas por definir:
- **Ambas** · Cablear esa aritmética al `aged-receivable`, que sigue usando `amount_due`; cubetas configurables y por fecha de factura o de vencimiento; saldos a favor visibles; congelación al cierre (`catalog:803`, parcial; `:807`). Es un cableado, no un motor faltante. Del lado CxP no existe reconstrucción equivalente.
- **Ambas** · La misma antigüedad es el insumo de la estimación (M13), inexistente; NIF C-3 y ASC 326 la necesitan como matriz.

Parámetros: cubetas 30/60/90 (`report-command.ts:724-728`) — **quemado** (grep de `cubetas|aging_buckets` en el panel: cero); estados abiertos (`report-service.ts:856-857`) — **casa**.

Puerta: CLI `report aged-receivable|aged-payable show`; REST `GET /v1/reports/aged-receivables|aged-payables` (`routes/reports.ts:179, :195`); agente `get_aged_receivables`, `get_aged_payables` (`report-tools.ts:185, :215`).

### M13 · Estimación de incobrables y castigo (NIF C-3 / ASC 326 CECL)

**Estado: ausente.** No hay archivo. Evidencia: grep de `incobrabl|uncollectib|bad.?debt|CECL|ASC 326|NIF C-3|allowance` sobre `src` sólo devuelve el estado `uncollectible` del enum (`types/index.ts:105`; `002:215`) **sin ningún escritor** (grep de `'uncollectible'` en asignaciones: cero), un comentario en `customer-service.ts:45`, otro en `src/services/reporting/cash-flow-service.ts:392`, y la línea del manual del agente que lo presenta como estado vivo (`src/ai/docs/receivables.md:8`). No existe cuenta de estimación en `CATALOGO_UNIVERSAL` (`chart-seed.ts:44-82`: 1120 sin contra-cuenta) ni rol de estimación o gasto por incobrables en `AccountRole` (`cfdi-taxonomy.ts:11-45`) ni en `ROLE_MAP` (`account-roles-seed.ts:237-285`). El catálogo lo declara ausente en `catalog:763-776`.

Reglas por definir:
- **MX** · NIF C-3: pérdidas crediticias esperadas desde el reconocimiento inicial (matriz de antigüedad por cubeta con tasas históricas ajustadas), rollforward de la estimación; LISR 27-XV: deducción del crédito incobrable por prescripción o «notoria imposibilidad práctica de cobro» (umbral 30,000 UDIS, aviso por escrito al deudor, informativa al 15 de febrero); el IVA del incobrable no se acredita ni se recupera salvo cancelación del CFDI.
- **US** · ASC 326-20 (CECL) con el recurso práctico de ASU 2025-05 para cuentas por cobrar corrientes; IRC §166 castigo específico (no se permite el método de reserva fiscal); recuperaciones.
- **Ambas** · Castigo con segundo aprobador sobre umbral, reversa y recuperación (`catalog:771-775`).

Parámetros que necesitaría: método (matriz/individual) — **panel**; tasas por cubeta por jurisdicción — **panel**; umbral de segundo aprobador — **panel**; umbral 30,000 UDIS y fecha informativa — **ley**; tratamiento fiscal (LISR 27-XV vs IRC §166) — **ley**.

Puerta: ninguna.

### M14 · Cobranza operativa (recordatorios, promesas, disputas, estados de cuenta)

**Estado: parcial (sólo el disparador).** `checkArReminders` (`wake-gate.ts:198-215`) despierta el job `ar_reminders` (`job-store.ts:18-20`) cuando hay facturas con `due_date < hoy` y saldo; el job sólo produce una pregunta `ask_user` (`wake-gate.ts:190-197`). El estado `overdue` existe (`types/index.ts:102`) pero **nadie lo escribe** (grep de asignación `= 'overdue'`: cero): la mora se deriva siempre de `due_date`, aunque el manual del agente lo lista como estado (`src/ai/docs/receivables.md:8`).

Reglas por definir (ambas jurisdicciones): perfiles de recordatorio, calendario hábil, exclusiones por disputa/promesa, entrega auditada, estado de cuenta por cliente (`catalog:743-760`, ausente; `customers.dunning_profile_id` sin tabla destino, `002:178`; `types/index.ts:511`); **MX** con UUIDs en el estado de cuenta; **US** con *finance charges* sujetos a topes estatales (`catalog:761`; grep cero).

Parámetros: las `rep_*` del panel gobiernan sólo el recordatorio de REP; nada del dunning es configurable — todo por definir.

Puerta: job del agente (`wake-gate.ts`); sin CLI ni REST.

### M15 · Planes de póliza CFDI del lado emitido (anticipo, aplicación de anticipo)

**Archivo:** `cfdi-taxonomy.ts:189-201` (`ingreso_emitido_anticipo`: DR `cxc` total / CR `anticipo_clientes` subtotal / CR `iva_trasladado`) y `:289-300` (`egreso_emitido_aplicacion_anticipo`, `TipoRelacion 07`: DR `anticipo_clientes` / DR `iva_trasladado` / CR `cxc`). **Estado: inerte.** **Jurisdicciones:** MX.

Los dos planes tienen `directions: ['emitido']`, y la ingesta CFDI sólo crea documentos del lado recibido (`pre-registration-service.ts:1105` hace `INSERT INTO bills`; no hay `INSERT INTO invoices` en el archivo). Ningún camino de M1, M3 ni M4 los consulta. Es el criterio contable de LIVA 1-B sobre anticipos y del Apéndice 6 del Anexo 20 ya escrito y sin quien lo postee: el hueco de M3 («`anticipo` postea igual que devolución») y de M4 («el remanente a cuenta va a 2150 sin IVA») tienen aquí la regla que les falta.

Reglas por definir: **MX** · quién ejecuta el plan — la emisión del CFDI de anticipo (M1/M4) o la nota de tipo `anticipo` (M3) — y cómo liga `TipoRelacion 07` con `credit_notes.cfdi_uuid`. **US** · no aplica.

Parámetros: ninguno propio; heredan el rol de IVA de M1.

Puerta: ninguna.

---

## 2. Parámetros quemados que deberían ser configurables por jurisdicción (consolidado)

| Parámetro | Valor | Dónde | Tipo | Por qué es jurisdiccional |
|---|---|---|---|---|
| Moneda por defecto de documentos y terceros | `'USD'` | `invoice-service.ts:357`; `bill-service.ts:357`; `customer-service.ts:434`; `vendor-service.ts:422`; `002:25, :58, :175, :206` | quemado | Debe ser la funcional de la entidad |
| Moneda por defecto de un pago sin documentos | `'MXN'` | `payment-service.ts:686-688` | quemado | Contradice el `'USD'` anterior |
| Condiciones de pago por defecto | `'Net 30'` | `customer-service.ts:433`; `vendor-service.ts:421`; `002:23, :173` | quemado | Plazo comercial y fiscal (PUE/PPD) varía |
| Método de pago supuesto sin MetodoPago | emitido `PUE`, recibido `PPD` | `iva-cash-basis.ts:64-67` | quemado | Criterio fiscal MX; irrelevante en US |
| Método de pago de una nota sin factura ligada | `PUE` | `ar-ap-posting.ts:329-331, :359` | quemado | Ídem |
| Destino del descuento por pronto pago tomado | `devolucion_compras` 5200 | `ar-ap-posting.ts:1171-1178`, `:873-880` | quemado | Bruto vs neto (US); efecto IVA (MX). La firma ya admite el rol (`:733`) |
| Base del descuento por pronto pago | `amount_due` con IVA | `bill-service.ts:591, :601` | quemado | LIVA 7 exige efecto en IVA; US sin IVA |
| Cómputo de la ventana de descuento | días desde `bill_date`, `Math.floor(ms/86400000)` | `bill-service.ts:597-600` | casa | Fecha base y zona horaria son criterio |
| Umbral de pago en efectivo no deducible | `CASH_DEDUCTION_LIMIT_MXN = 2_000` | `cfdi-decisions.ts:94`; uso `:209-227` | ley | LISR 27-III; sólo en la ingesta, no en el camino manual ni en el panel |
| Reparto del IVA del saldo condonado | proporcional IVA/total | `ar-ap-posting.ts:797-799` | quemado | Criterio fiscal MX |
| Fecha contable de aplicar/desaplicar | `new Date()` | `ar-ap-posting.ts:682, :903, :965` | quemado | Corte de periodo |
| Cubetas de antigüedad | 30/60/90 | `report-command.ts:724-728` | quemado | La matriz NIF C-3/ASC 326 las define |
| Efectivo sin aplicar «viejo» | 30 días | `ar-controls.ts:263` | quemado | Prescripción/escheat US; control fiscal MX de anticipos |
| Tolerancias de cuadre | 0.01 y 0.005 | `ar-controls.ts:110, :197, :262`; `ap-controls.ts:64, :403` | casa | Moneda y política del despacho |
| Estados abiertos de CxC / CxP | listas fijas | `customer-service.ts:49-51`; `ar-controls.ts:26`; `report-service.ts:856-857`; `payment-service.ts:681, :683` | casa | `overdue` nunca se escribe; el ciclo real es más corto que la lista |
| Prefijos y formato de folio | `INV/PMT/BILL/VPMT/CN`, `X-AAAA-NNNNN` | `invoice-service.ts:687-694`; `sequence.ts:58-60` | casa | No son serie/folio fiscal MX |
| Métodos de pago admitidos y su mapa SAT | `cash|check|ach|wire|spei|credit_card|other`; mapa `01,02,03,04,28` → interno | `002:122-123`; `rep-linkage.ts:67-84`; `sat-catalogs.ts:70-84` | casa | Falta el inverso interno → `c_FormaPago` (REP, Anexo 24) y las claves de `wire`/`ach`; LISR 27-III |
| Regex de identificadores | RFC, EIN, VAT, CP 5 dígitos | `vendor-service.ts:46-50`; `customer-service.ts:583, :686` | ley | Por país (correcto que bifurque; hoy sólo forma, sin dígito verificador) |
| Tipo de identificador por país | `MX→rfc`, `US→ein` | `vendor-service.ts:61-66` | casa | Única bifurcación explícita del subsistema |
| Conmutador de IVA en flujo | `country==='MX' \|\| standard==='mx_nif'` | `iva-cash-basis.ts:310` | quemado | Diverge de `pais-contable.ts:42-43` con nulos |
| Fuente del tipo de cambio | DOF por defecto | `pending-catalog.ts:708-731`; `payment-service.ts:365-372` | panel | CFF 20; ya configurable, sin dimensión de jurisdicción |
| Destino del pago corto residual | `descuento_compras` · `otros_ingresos` · `prohibir` | `pending-catalog.ts:1055-1090`; `payment-service.ts:1525-1541` | panel | Ya configurable; el patrón a copiar para el descuento |

---

## 3. Motores que Estados Unidos exige y no existen

1. **Estimación CECL (ASC 326-20) y su posteo**, con recurso práctico ASU 2025-05 para CxC corrientes; sin cuenta, rol ni cálculo (M13; `catalog:767-770`).
2. **Castigo específico y recuperación (IRC §166)** — `uncollectible` inalcanzable (M13; `catalog:771-775`).
3. **Sales tax por jurisdicción** (nexus, tasas estatales/locales, certificados de exención) — sólo `tax_rate` libre y cuenta genérica 2135 (M1; `chart-seed.ts:123-127`).
4. **Use tax devengado sobre compras** — `ap accrue --kind use-tax` ausente (`catalog:989`).
5. **Serie 1099 (IRC §6041/§6041A)**: acumulación por proveedor y año de pagos reportables, umbral ($600; $2,000 desde 2026), W-9/TIN matching, cajas — sólo la bandera `is_1099_vendor` y dos filtros de listado (M6/M7; `002:17`; `vendor-command.ts:177-190`; `catalog:859, :868`).
6. **Corrida de pagos y emisión ACH/cheque** (NACHA CCD/CTX/PPD, impresión con MICR, *positive pay*) — `catalog:1019-1029`; el registro sólo documenta pagos ya salidos.
7. **Anulación/desaplicación de pagos a proveedor y anulación/reversa de gastos aprobados** (`payment void|unapply`, `bill void|reverse`) — `payment-command.ts:197, :272`; `bill-command.ts:423-940`; `catalog:939-940, :1041-1042`.
8. **Finance charges / late fees** sobre saldos vencidos con topes estatales — grep cero (`catalog:761`).
9. **Dunning, estados de cuenta, promesas y disputas** — M14 (`catalog:743-760`).
10. **Límite de crédito y bloqueo de crédito aplicados al emitir** — datos sin lector, ausencia deliberada (`customer-command.ts:54`; M1; `catalog:630-636`).
11. **Bienes no reclamados / escheat** de saldos a favor y efectivo sin aplicar prescritos — sólo aviso a 30 días (M10; `catalog:731`).
12. **Reconocimiento de ingresos ASC 606** (obligaciones de desempeño, ingreso diferido) — la factura postea el 100 % al emitir (M1).
13. **FX en ventas y revaluación no realizada al cierre (ASC 830)** — bloqueado por diseño en AR (`ar-ap-posting.ts:133-142`) y fase 2 en AP (`:981-985`; `moneda-origen.ts:12`).
14. **Método neto vs bruto de descuentos de compra** como política contable — sólo bruto a 5200 (M8). El destino ya es parametrizable por rol en la firma de `postVendorApplicationEntry` (`ar-ap-posting.ts:733`): el patrón del panel está a mano.
15. **Nota de cargo (debit memo) a clientes** — `catalog:707-709`.

## 4. Motores que México exige y no existen

1. **Estimación NIF C-3 (pérdidas crediticias esperadas)** y **castigo deducible LISR 27-XV** (prescripción / notoria imposibilidad práctica de cobro, 30,000 UDIS, aviso al deudor, informativa 15-feb) — M13 (`catalog:763-776`).
2. **Cálculo de retenciones en CxP** (ISR 10 % honorarios/arrendamiento LISR 106/116; IVA 2/3 LIVA 1-A; RESICO 1.25 % LISR 113-J; fletes) con su pasivo y entero el día 17 — `computeBill` sin retención (`bill-service.ts:300-338`). **El asiento no falta**: la ingesta abona los roles 2140 con los importes del CFDI (`cfdi-taxonomy.ts:151-152, :171-172` → `pre-registration-service.ts:1150-1165`, puerta `bill inbox run`). Falta el cálculo con perfil por proveedor, el camino manual y el entero (`catalog:1063-1074`).
3. **DIOT (LIVA 32-VIII) en base flujo** — `ap diot show` ausente (`catalog:1074`); el insumo (`payment_applications.iva_reclass_amount`, `050:39-40`) ya existe.
4. **Requisitos de deducibilidad LISR 27** (CFDI válido, pago > $2,000 por transferencia/cheque nominativo, comprobante del ejercicio) al aprobar/pagar — la regla del efectivo existe **sólo en la ingesta**, con umbral quemado (`cfdi-decisions.ts:93-94, :209-227`); nada en `approveBill` ni `recordVendorPayment` (M7/M8).
5. **IVA causado sobre anticipos de clientes (LIVA 1-B)** y **CFDI de anticipo con su aplicación** (Anexo 20 Apéndice 6) — el remanente a cuenta va íntegro a 2150 sin IVA (`ar-ap-posting.ts:558-565`); el tipo de nota `anticipo` no descuenta 2150 (M3/M4). Los planes de póliza ya están escritos (`cfdi-taxonomy.ts:189-201, :289-300`) sin ejecutor del lado emitido (M15).
6. **CFDI de egreso para notas de crédito** (CFF 29; Anexo 20 tipo E, `TipoRelacion`) — `credit_notes.cfdi_uuid` existe sin emisor (`049:58-59`); `missing-uuid` no cubre notas (M3; `ar-controls.ts:275-297`).
7. **Emisión del REP (RMF 2.7.1.32)** — el subsistema sólo marca `needsRep` (`payment-service.ts:1217-1219`); `rep-command.ts` lista y reconcilia, no emite (`:85-128`); grep de generador de complemento: cero.
8. **Descuentos y condonaciones con efecto en IVA acreditable (LIVA art. 7)** — el descuento por pronto pago va íntegro a 5200 sin tocar 1130/1135 (`ar-ap-posting.ts:1171-1178`; `bill-service.ts:601`).
9. **Nota de crédito del proveedor como documento de CxP** — sólo el plan de póliza para el CFDI «E» ingerido (`cfdi-taxonomy.ts:273-288`); sin captura ni aplicación manual.
10. **Mapeo `payment_method` → `c_FormaPago`** para REP y Anexo 24 — sólo existe el sentido SAT → interno con cinco claves (`rep-linkage.ts:67-84`; `sat-catalogs.ts:70-84`); falta el inverso y la cobertura de `wire`/`ach` (`002:122-123`).
11. **Validación del receptor antes de emitir** (RFC contra padrón, régimen–UsoCFDI compatibles) — el perfil existe (M2) pero `issueInvoice` no lo consulta; el timbrado REST arma el XML sin `Receptor` (`routes/invoices.ts:248-253`).
12. **Escrutinio 69-B CFF (EFOS/EDOS) del proveedor** antes de aprobar o pagar — `catalog:868`; `ValidacionEFOS` ya se captura (`cfdi-status.ts:35, :90, :155`; `sat-validation.ts:51`) y nadie lo lee.
13. **Cancelación local de CFDI vigente por REST** — no es un motor faltante sino uno que sobra: `routes/invoices.ts:228-240` pasa `allowStamped: true` y deja el CFDI vigente ante el SAT con la factura anulada en libros (CFF 29-A); `/:id/cfdi/cancel` lanza `NotImplementedError` (`:290-330`).
14. **Intereses moratorios con CFDI** (LIVA 18) — `catalog:761`.
15. **Antigüedad reconstruida a fecha y estado de cuenta con UUIDs** — la reconstrucción existe en `invoice list --as-of` y `customer show --as-of`; falta cablearla al reporte de antigüedad y el estado de cuenta (M12/M14; `catalog:759, :803`).
16. **Anulación/desaplicación de pagos a proveedor y anulación/reversa de gastos** — igual que US (`catalog:939-940, :1041-1042`).
17. **Conmutador de jurisdicción unificado**: `entityUsesCashBasisIva` (`iva-cash-basis.ts:310`) no usa `esContabilidadMexicana` (`pais-contable.ts:35-44`): con país nulo, el IVA deja de ir en flujo mientras el catálogo sigue siendo mexicano (`entity-accounting.ts:75, :172`).

---

## 5. Puertas: mapa completo verificado

| Servicio | CLI | REST | GraphQL | Agente / ingesta |
|---|---|---|---|---|
| `invoice-service` | `invoice *` (incl. `list --as-of`) | `routes/invoices.ts` (`/:id/void` sin guardas; `/:id/cfdi/stamp` sin `Receptor`; `/:id/cfdi/cancel` → `NotImplementedError`) | `createInvoice`, `voidInvoice` | — |
| `customer-service` | `customer *` (incl. `show --as-of`), y consumido por `invoice`, `receipt`, `credit-note` | `routes/customers.ts` | — | `search_customers` (lectura) |
| `credit-note-service` | `credit-note create|show|list|issue|apply` | — | — | — |
| `payment-service` (cobros) | `receipt record|show|list|apply|unapply|reverse` | `POST /v1/invoices/:id/payments` | `recordCustomerPayment` | `rep-linkage.ts:338` |
| `payment-service` (pagos) | `payment create`, `payment apply` | `POST /v1/bills/payments` | — | `rep-linkage.ts:337` |
| `bill-service` | `bill list|show|create|line set|approve|inbox list|inbox run`, consumido por `payment` | `routes/bills.ts` (`/:id/schedule-payment` → 410) | — | `bill inbox run` → `pre-registration-service.ts:1105, :1150-1165` (único escritor de los roles 2140 y única sede de `efectivo_no_deducible`) |
| `vendor-service` | `vendor *`, consumido por `bill` | `routes/vendors.ts` | — | `search_vendors` (lectura) |
| `ar-controls` | `ar reconcile`, `ar check` | — | — | — (no lo consume `close`) |
| `ap-controls` | `ap reconcile` | — | — | — |
| `ar-ap-posting` | ninguna directa | ninguna directa | — | — (sólo vía los servicios) |
| antigüedad (`report-service`) | `report aged-* show` (única con cubetas) | `GET /v1/reports/aged-*` | — | `get_aged_receivables/payables` |
| `iva-cash-basis` (M5) | ninguna | ninguna | — | — (dentro de M4, M8, M9) |
| planes CFDI emitidos (M15) | ninguna | ninguna | — | ninguna: la ingesta sólo recorre `recibido` |
| recordatorios (M14) | — | — | — | job `ar_reminders` (`wake-gate.ts:198-215`) → `ask_user` |
| incobrables (M13) | — | — | — | — |

Fuente: grep de importadores (`src/api/graphql/resolvers/index.ts`, `src/api/rest/routes/{bills,customers,invoices,vendors}.ts`, `src/cli/{ap,ar,bill,credit-note,customer,invoice,payment,receipt,vendor,rep}-command.ts`, `src/services/xml-ingestion/{rep-linkage,pre-registration-service}.ts`) y subcomandos registrados con `.command(...)` en cada archivo CLI.

---

## 6. Lo que el escéptico refutó o corrigió (qué no creerse del original)

1. **«`payment_method` → `c_FormaPago`: grep sin coincidencias» — falso en parte.** Existe el mapa SAT → interno con cinco claves (`rep-linkage.ts:67-84`) y el catálogo completo (`sat-catalogs.ts:70-84`). El hueco real es el sentido inverso y la cobertura de `wire`/`ach`.
2. **«Roles 2140 sembrados sin escritor» — falso.** La ingesta CFDI los abona (`cfdi-taxonomy.ts:151-152, :171-172` → `pre-registration-service.ts:1150-1165`) con puerta `bill inbox run`. Lo que falta es el cálculo de la retención, el perfil por proveedor, el camino manual y el entero; no el asiento.
3. **«LISR 27: ninguna comprobación; grep de 2,000/27 sin coincidencias» — falso en parte.** `cfdi-decisions.ts:93-94, :209-227` la aplica en la ingesta con umbral quemado. Sigue ausente en `approveBill`, `recordVendorPayment` y el panel.
4. **«Antigüedad reconstruida a fecha: motor por definir» — reformulado.** La aritmética existe (`invoice-service.ts:168-179`; `customer-service.ts:138-157`) con dos puertas `--as-of`; lo que falta es cablearla al reporte, cubetear y congelar.
5. **`payment-service.ts:861, :1649` citados como fecha contable** — son `last_payment_date`. La fecha del asiento con `new Date()` está en `ar-ap-posting.ts:682, :903, :965`.
6. **`account-roles-seed.ts:159` (ROLE_MAP 6310)** — real: `src/services/xml-ingestion/account-roles-seed.ts:278`. **`ROLE_MAP :239-267`** — real: `:237-285` (las líneas `:261-262` de los roles 2140 sí caen dentro). El archivo vive en `xml-ingestion`, no en `accounting`.
7. **`cfdi-taxonomy.ts:17` (roles de retención) y `:30` (`comision_bancaria`)** — real: `:27` y `:40`. (El escéptico dio `:39` para la comisión; a este HEAD es `:40`.)
8. **Texto del rechazo de la comisión NSF desactualizado.** `payment-service.ts:1278-1287` dice que la capa semántica «aún no tiene» el rol; `src/services/banking/treasury-posting.ts:885-897` ya postea comisiones bancarias con `comision_bancaria` e IVA.
9. **Rutas que el escéptico dio sin directorio, completadas aquí:** `src/services/banking/treasury-posting.ts`, `src/services/xml-ingestion/sat-validation.ts`, `src/services/banking/bank-account-service.ts`. Y `pais-contable.ts:6` nombra a `iva-ppd-reclass.ts`; la línea que nombra a `iva-cash-basis.ts` es la `:7` (ambas dentro de la lista `:6-9`).
10. **`schema.ts:71` (cita del escéptico para `uncollectible`) no resuelve en `src/` a este HEAD** y no se conserva. En su lugar aparece `src/ai/docs/receivables.md:8`, que le describe al agente `overdue` y `uncollectible` como estados vivos cuando nada los escribe.
11. **Nota general del escéptico sobre el método del original:** el error recurrente fue afirmar «sin escritor» o «grep sin coincidencias» mirando sólo `ar/ap/payments`, cuando el motor vivía en `src/services/xml-ingestion/`. Toda afirmación de ausencia en este documento se buscó también ahí.

Ningún reclamo del original fue eliminado por completo: los cuatro refutados (puntos 1-3 y el de la antigüedad) quedaron como huecos reales con la evidencia corregida. Las 11 confirmaciones sin corrección de fondo (M1, M2, M3, M5, M6, M8, M9, M10, M11, M13, M14) conservan sus citas tal cual.
