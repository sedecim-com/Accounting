> Lente 5 — Cumplimiento fiscal mexicano, después de F02. Auditado sobre HEAD `6e280dd` (la rama avanzó desde el `a149e62` del encargo; verificado con `git diff --stat a149e62..HEAD` sobre `src/services/xml-ingestion`, `src/services/sat`, `src/services/integrations/mexico`, `src/services/payroll`, `src/api/rest/routes/invoices.ts` y `src/services/accounting/period-close.ts`: **cero cambios** — F02 sigue siendo la última palabra fiscal; lo posterior es endurecimiento de API y CodeQL).
> Medidores vivos corridos hoy: `npm run plan:status` → 10 de 15 verdes; `npm run catalogo:estado -- --check` → al día (134 comandos, 119 filas invocables de 1624).

## FORTALEZAS

**1. El espejo por entidad está cerrado de verdad, y probado por mutación en las dos direcciones.**
`046_el_espejo_del_cfdi.sql:25-31` tira el `UNIQUE` global de `cfdi_uuid` y lo sustituye por dos índices por entidad (`uq_xml_documents_entity_cfdi`, `uq_xml_documents_entity_hash`); el dedupe de código lo acompaña (`pre-registration-service.ts:90-100`: `WHERE entity_id = $1 AND (cfdi_uuid = $2 OR xml_hash = $3)`). Y no es una migración a ciegas: `tests/integration/f02-espejo-y-fiscal.int.spec.ts:57-58` mete el MISMO XML en dos entidades y exige direcciones opuestas, y exige que la misma entidad dos veces siga siendo duplicado. La 046 además se declara inmune al modo de fallo de la 043 (no lee filas, sólo DDL) — el tipo de honestidad que hace auditables las migraciones.

**2. El estatus SAT dejó de ser mentira y el apagado significa apagado.**
`src/services/sat/cfdi-status.ts` arma el sobre SOAP a mano contra `ConsultaCFDIService` (`config/index.ts:154-158`, servicio público y anónimo), y `statusMode:'off'` devuelve un resultado que **lo dice** (`cfdi-status.ts:126-136`, `codigoEstatus:'DISABLED'`) en vez del «Vigente» de sandbox que clasificaba como vigente un CFDI cancelado. El detalle de la expresión impresa con seis decimales y el reintento único para folios históricos (`:139-147`) es criterio de campo, no de manual. `sat-validation.ts:21-62` ya sólo delega. Con pruebas de unidad reales: `tests/sat/cfdi-status.spec.ts:38-99` (sobre, reintento N-601, respuesta ilegible, HTTP no-200, y los dos vocabularios de salida).

**3. El rastro del clasificador se escribe, y el instrumento lo vigila.**
`pre-registration-service.ts:642` inserta en `cfdi_classifications` (creada en la 015 y huérfana durante meses), `cfdi-query-service.ts:141` lo lee, y `cfdi explain` lo expone (`cli/cfdi-command.ts:229+`). El criterio de `plan/criterios.ts:1201-1211` busca literalmente el `INSERT INTO cfdi_classifications` — la promesa quedó al trinquete, no en la prosa.

**4. REP-2: la lista de faltantes existe en las dos direcciones y GOBIERNA el cierre.**
`rep-pendientes.ts:35-89` distingue lo recibido (IVA aparcado en 1135, no acreditable) de lo emitido (obligación propia), saca el método de pago del espejo y lista con la marca `desconocido` cuando el CFDI propio no está espejado — listar de más con la duda dicha. `reprocesarREPsAparcados` (`:123-152`) reintenta los `needs_review` que antes «nada reintentaba». Y entra al cierre: `period-close.ts:120-186` añade dos ítems y consulta `rep_faltante_recibido`/`rep_faltante_emitido` (`pending-catalog.ts:387,411`) donde **sólo el literal 'bloquear' bloquea**. Probado por mutación en ambas direcciones: `f02-espejo-y-fiscal.int.spec.ts:126-127` («con 'bloquear' detiene el cierre; con 'avisar', avisa») y `tests/xml-ingestion/rep-pendientes.spec.ts:22-42`.

**5. El tipo 'R' se retiró con la razón escrita, no se parcheó.**
`cfdi-parser.ts:386-399`: 'R' sale del mapa con la explicación de por qué no podía llegar (otra raíz, otro namespace, rechazada tres candados antes en `:107-113`) y de por qué soportar constancias es un parser propio.

**6. El IDSE dejó de recibir credenciales por el cuerpo del POST, y las cuatro transmisiones fingidas son 501 honestos.**
`generateIdseBatch(tenantId, entityId, movements)` (`imss-idse-adapter.ts:59-63`) ya no toma `.cer/.key`; el registro patronal sale de la base (`:64-68`, `legal_entities.imss_registro_patronal`, columna de la `032_schema_contract.sql:28`). Los cuatro transmisores (IMSS, IRS ×2, SSA) devuelven `NotImplementedError` nombrando el archivo y el portal (`routes/payroll.ts:374-420`), y **no** se borraron a propósito: un 404 invitaría al reintento.

**7. Las retenciones sí se postean, en las dos direcciones.**
`cfdi-taxonomy.ts:137-138` y `:157-158` acreditan `isr_retenido_por_pagar`/`iva_retenido_por_pagar` en el gasto; `:196-197` y `:215-216` cargan `isr_retenido_a_favor`/`iva_retenido_a_favor` en el ingreso. Con `omitIfZero`. (El problema está aguas abajo — ver brecha 22.)

**8. El cerrojo antisimulación y la cancelación retirada siguen firmes.**
`assertPuedeTimbrar` antes de timbrar y de cancelar (`pac-router.ts:157,221`); `POST /v1/invoices/:id/cfdi/cancel` sigue siendo `NotImplementedError` con la ruta manual escrita (`routes/invoices.ts:314`), y el criterio `E3.1` lo vigila por la negativa (`criterios.ts:1580-1584`: si aparece `cfdi_status = 'cancelled'`, falla).

**9. El panel de políticas creció a 17 decisiones con lectores reales.**
`pending-catalog.ts` (17 claves) y 10 puntos de lectura verificados fuera del servicio (`ingest-thresholds.ts:48,72`; `period-close.ts:172,178`; `posting.ts:318`; `fiscal-credentials/service.ts:264`; `rep-linkage.ts:134,167,206,208,285`; `pre-registration-service.ts:698-710`). La regla de la casa (a) se está respetando.

## BRECHAS

### 1. El único PAC no simulado del repositorio es inalcanzable por una línea que falta — y `E3.1` está verde. **SIGUE-ABIERTA (agravada y precisada)**
`SovosReachcoreAdapter` es real: `readonly simulado = false` (`sovos-reachcore-adapter.ts:128`), y su `configure()` (`:134-157`) valida ambiente, valida que la variable de entorno de la API key no esté vacía, y guarda por `integrationRegistry.saveCredentials`. Pero `pac-router.ts:21-23` registra **tres** adaptadores —`finkok`, `swSapien`, `edicom`, los tres simulados por confesión propia (`simulacion.ts:8-12`: «Los tres adaptadores… fabrican el UUID»)— y **sovos no está entre ellos**, aunque sí aparece en el mapa `PAC_ADAPTERS` de la línea `:26`. Las tres rutas de administración pasan por `integrationRegistry.get()` (`routes/integrations.ts:62,83,101`) → `PROVIDER_NOT_FOUND` (`base/registry.ts:24`), y `list()` (`:25`) ni lo enseña. Resultado: el adaptador terminado no se puede configurar nunca.
Y el tablero dice `✅ E3.1 2/2`: sus dos criterios (`criterios.ts:1562-1584`) miden el **cerrojo antisimulación** y que la ruta no finja cancelar — no miden que se pueda timbrar. La cabecera de la sección dice «E3.1 · Timbrado real» (`criterios.ts:1560`). El enunciado es honesto; la etiqueta promete otra cosa.

### 2. El XML timbrable sigue siendo un `Comprobante` vacío. **SIGUE-ABIERTA**
`routes/invoices.ts:232-238`: `Version`, `Folio`, `Total`, `SubTotal`, `Moneda` y nada más — sin `Emisor`, sin `Receptor`, sin `Conceptos`, sin `Impuestos`, sin `LugarExpedicion`, sin `FormaPago`/`MetodoPago`, sin `Exportacion`, sin `ObjetoImp`. El comentario remite a un `cfdi.ts generateCfdiXml` que **no existe** (grep: única ocurrencia, la del propio comentario). Ningún PAC lo aceptaría. Nada de esto necesita PAC ni e.firma: Sovos sella con su CSD del lado del PAC (`sovos-reachcore-adapter.ts:172`, «el XML se sella de nuestro lado»), así que ni el CSD del emisor es prerrequisito para *armar y validar* el XML contra el XSD.

### 3. Contabilidad electrónica (Anexo 24): cero generadores, y ahora **dos columnas para el mismo dato**. **SIGUE-ABIERTA + MUTÓ**
Ni catálogo, ni balanza, ni pólizas, ni auxiliares: `e-accounting` son 12 filas de catálogo, cero invocables. Lo que mutó es peor que el vacío: la `037_etiquetado_que_encarece.sql:27-31` añadió `accounts.codigo_agrupador_sat` con un `COMMENT` que promete «el checklist de F07 exigirá que ninguna cuenta con movimientos lo tenga vacío» — y F01 escribió el agrupador en **otra** columna, `mx_nif_code` de la 001 (`account-service.ts:447-451`, esquema `'sat-agrupador' → mx_nif_code`). Hoy `codigo_agrupador_sat` no tiene un solo lector ni escritor fuera de su propia migración (grep sobre `src/`), y la promesa del comentario apunta a la columna equivocada.

### 4. La compuerta de cobertura del agrupador mide lo que no prometió. **NUEVA (menor, dentro de la 3)**
`checkMappingCoverage` (`account-service.ts:555-568`) filtra por `account_level <= $2` (por omisión 2, `cli/account-command.ts:606`). La promesa de la 037 era **cuentas con movimientos**. Una cuenta de nivel 3 con saldo y sin agrupador pasa la compuerta; una de nivel 2 sin un solo movimiento la ensucia. Además `map set` no valida contra `c_CodAgrup` (el propio código lo admite, `account-service.ts:509-511`) y la columna destino es `VARCHAR(50)` (`001_core_schema.sql:130`) para un código de seis caracteres.

### 5. DIOT: cero generadores. **SIGUE-ABIERTA**
4 filas de catálogo, cero invocables. Los insumos existen (`iva_acreditable`/`iva_pendiente_acreditar` separados desde IVA-5) y hay una lista de bloqueadores (`vendor-command.ts:131,297`: proveedores sin RFC no pueden aparecer en DIOT). El generador en base de efectivo por tasa, no.

### 6. Pagos provisionales ISR / IVA definitivo / papeles de trabajo: sólo el almacén de tarifas. **SIGUE-ABIERTA**
`filing` 7 filas, `obligation` 4, `annual` 7 — cero invocables. Cero ocurrencias de `coeficiente` en `src/`. Sin prorrateo del art. 5-V LIVA, sin saldos a favor, sin papel de trabajo.

### 7. REP emisión: el faltante-list se construyó, el `pago20` no. **PARCIALMENTE CERRADA**
La mitad barata de la recomendación 9 de la auditoría I se pagó (brecha cerrada arriba, fortaleza 4). Sigue sin existir el nodo `Pago20` (cero ocurrencias en `src/`) y el subledger `cfdi_pago_docto`. Un cliente que cobra PPD sigue sin poder cumplir el día 5 desde mnemosine. `rep` son 7 filas, 2 invocables.

### 8. Nómina: los datos de juguete siguen íntegros. **SIGUE-ABIERTA**
`cfdi-nomina-generator.ts`: `RegistroPatronal="B0000000000"` (`:117`), `LugarExpedicion="00000"` (`:104`), `DomicilioFiscalReceptor="00000"` (`:107`), `Antiguedad="P0W"` (`:119`), `PeriodicidadPago="04"` y `ClaveEntFed="MEX"` fijos (`:123`), CURP de relleno `XAXX010101HDFNNN00` (`:118`), y todo `ImporteExento="0.00"` (`:99`) que sobredeclara el gravado.
**Agravante NUEVA:** el registro patronal **ya está en la base y ya se lee** — `legal_entities.imss_registro_patronal` (`032_schema_contract.sql:28`), consultado por el IDSE en `imss-idse-adapter.ts:64-68`. La constante `B0000000000` no está bloqueada por nada: es una consulta que no se hizo. Igual `LugarExpedicion` (el CP fiscal de la entidad) y `Antiguedad` (calculable desde `hire_date`, que el generador **ya trae** en su `SELECT`, `:60`).

### 9. El subsidio al empleo se netea contra el ISR y nunca se reporta. **NUEVA**
`cfdi-nomina-generator.ts:84`: `isrNet = max(0, isr_withheld − subsidio_empleo)`, y ese neto es lo único que sale como `Deduccion TipoDeduccion="002"` (`:129`). No hay un solo nodo `OtrosPagos`/`OtroPago` en el repositorio (grep sobre `src/`, cero resultados). El CFDI de nómina 1.2 exige el subsidio causado como `OtroPago TipoOtroPago="002"` con su nodo `SubsidioAlEmpleo`; sin él, el timbrado real lo rechaza y la declaración informativa de subsidio no cuadra. El motor de subsidio existe y es serio (`isr-calculator.ts`, tabulado) — lo que falla es cómo se reporta. Nada de esto depende de PAC ni de e.firma: es la forma del XML.

### 10. Tres obligaciones fiscales distintas caen en la misma cuenta 2140. **NUEVA**
`account-roles-seed.ts:164-165` mapea `isr_retenido_por_pagar → '2140'` **y** `iva_retenido_por_pagar → '2140'`; `:176` añade `isr_nomina_por_pagar → '2140'`. La cuenta es la genérica «Retenciones por Pagar» del catálogo base (`chart-seed.ts:50`). Son tres enteros distintos, con líneas distintas de la declaración y (nómina aparte) plazos distintos. El saldo de 2140 no se puede amarrar a ninguna línea de ninguna declaración, el auxiliar del Anexo 24 sobre 2140 mezclará tres impuestos, y la conciliación «qué le debo al SAT por retenciones este mes, por concepto» es imposible desde el mayor. Y el `doctor` no lo ve: `checkAccountRoles` sólo falla por los cuatro roles de IVA (`doctor-service.ts:204-207`).

### 11. `EsCancelable` y `ValidacionEFOS` se le piden al SAT y se tiran a la basura. **NUEVA**
`cfdi-status.ts:88,90` los parsea y `:154-155` los devuelve. Pero `xml_documents` no tiene columna para ninguno de los dos (`005_xml_ingestion.sql:70-76`: sólo `sat_validation_status`, `sat_validated_at`, `sat_estado`, `sat_efecto_cancelacion`, `sat_fecha_cancelacion`; grep de `efos` sobre `src/database/migrations/`: cero). El barrido `revalidateEntityCfdis` no los escribe (`:227-233`), y `cfdi status show` no los enseña — su propia descripción los perdió (`cli/cfdi-command.ts:151`: «Estado, EsCancelable and EstatusCancelacion», y el `SELECT` de `:166-169` no trae `EsCancelable`).
Lo grave es que la fila 1985 del catálogo, cuya descripción dice literalmente «`Estado`, `EsCancelable`, `EstatusCancelacion` y `ValidacionEFOS`», quedó marcada **✅ hecha en F02** — y su propio texto anterior ya advertía «`ValidacionEFOS` no se persiste». Es un verde de fila con un cuarto de la promesa sin construir, exactamente la clase que la regla (d) proscribe. Y `EsCancelable` es justo el dato que dice si el emisor puede cancelarte sin aceptación.

### 12. Cada barrido de revalidación borra la fecha de cancelación. **NUEVA**
`cfdi-status.ts:230`: `SET … sat_efecto_cancelacion = $3, sat_fecha_cancelacion = NULL`, incondicional. `ConsultaCFDIService` no devuelve fecha, pero el `NULL` fijo destruye lo que hubiera escrito cualquier otra vía. `validateAndUpdate` tiene el mismo agujero por otro camino (`sat-validation.ts:110-124`, con `result.fechaCancelacion` que `validate()` nunca puebla). Corriendo `cfdi status sync` cada 24 h, el campo es permanentemente nulo.

### 13. Un CFDI cancelado DESPUÉS de posteado no dispara nada. **NUEVA (y el bloqueo por E3.2 no le aplica)**
El clasificador sí frena en la ingesta (`cfdi-classifier.ts:151-155`). Después, nada: `cfdi status sync` detecta la cancelación y su única reacción es un aviso a stderr — «revisa su efecto contable con `cfdi list --json`» (`cli/cfdi-command.ts:218-221`). Sin ítem de cierre, sin reversa encadenada, sin lista de expuestos. El comentario del criterio E3.2 nombra el hueco («ni la reversa de facturas contabilizadas cuyo CFDI el emisor canceló», `criterios.ts:1598-1599`) y lo mete en el paquete bloqueado por e.firma — pero desde F02 la detección ya existe y es pública. La mitad que reacciona no depende de nada externo.

### 14. El plazo del día 5 se nombra y no se computa; hay un parámetro muerto. **NUEVA (menor)**
`listPagosSinRep` declara `overdueOnly?: boolean` en su firma (`rep-pendientes.ts:38`) y **ninguna de las dos consultas lo usa** (`:45-88`); el CLI tampoco expone la bandera (`cli/rep-command.ts:94-95`: sólo `--direction` y `--min-amount`). Se calcula `edad_dias` y no se compara contra nada. Mientras tanto el cierre llama a esa población «obligación fiscal propia **con plazo**» (`period-close.ts:180`). El plazo no existe en el código.

### 15. Las declaraciones mexicanas no se registran en ninguna parte. **NUEVA**
`tax_form_filings` tiene seis escritores: 940, 941, W-2, W-3 (EE.UU.) y SUA (`grep "INSERT INTO tax_form_filings"`). Cero de DIOT, IVA mensual, ISR provisional, anual, retenciones o contabilidad electrónica. El checklist de cierre tampoco pregunta por ninguna. Cuando existan los generadores (brechas 5 y 6), no hay dónde asentar que se presentó ni con qué acuse.

### 16. Plazo de cancelación del emisor (CFF 29-A). **SIGUE-ABIERTA**
Los motivos 01-04 y la regla «01 exige sustituto» se validan (`routes/invoices.ts:293-302`) — pero corren justo antes de un `NotImplementedError` (`:314`), así que hoy son aritmética sin destino. Nadie valida el plazo del emisor. Es lógica de fechas pura: cero dependencias externas.

### 17. 69-B / EFOS: nada. **SIGUE-ABIERTA**
Cero ocurrencias de `69-B` en `src/`. Sin tabla append-only `(rfc, list, status, published_at)`, sin `party check --as-of`, sin efecto sobre la deducción. Las listas del SAT son **públicas y descargables sin credencial** — este bloqueo nunca fue de e.firma. Peor: el SAT ya regala el dato por CFDI en cada consulta y se descarta (brecha 11).

### 18. Buzón tributario y opinión 32-D. **SIGUE-ABIERTA (bloqueo REAL, parcialmente)**
Las tres filas del buzón (catálogo 1997-1999) están bien diseñadas: se modelan como **atestiguación humana**, no como scraper, porque no hay API pública. Esa mitad —registrar la revisión y alertar a los 3 días hábiles de la ventana de aceptación tácita— **no necesita credencial ninguna** y es la contraparte defensiva de la brecha 13. La 32-D (fila 2004) sí consume credencial del cliente: bloqueo real.

### 19. Ajuste anual por inflación, CUFIN, CUCA, pérdidas fiscales, PTU base, DIM, INPC. **SIGUE-ABIERTA**
Cero ocurrencias de `INPC`, `CUFIN`, `CUCA` en `src/` (las únicas de INPC están en `src/ai/docs/niif-*.md`, documentación NIIF). La tabla de serie mensual del INPC —prerrequisito compartido de los cuatro— sigue sin existir. El plan maestro ya la adoptó en F07a; nadie la ha escrito.

### 20. ISN. **SIGUE-ABIERTA**
2 filas de catálogo, cero código, cero tasas por estado.

### 21. Descarga masiva SAT. **SIGUE-ABIERTA — bloqueo REAL**
`⬜ E3.2 0/1` en el tablero de hoy, con el rojo honesto bien escrito (`criterios.ts:1592-1603`, que además documenta el falso verde anterior por dos cadenas de prosa). `SolicitaDescarga`/`VerificaSolicitud` exigen e.firma. Aquí el bloqueo es real y completo.

### 22. Enteros y constancias de retenciones. **NUEVA**
Se postean (fortaleza 7) y ahí muere el hilo: no hay acumulado mensual por concepto para el entero, no hay emisión de la constancia (CFDI de Retenciones e Información de Pagos), y la ingesta de constancias **recibidas** —intereses bancarios, dividendos, plataformas— sigue sin decisión de alcance escrita (0 filas de catálogo para `retencion`/`constancia`, y `cfdi-parser.ts:386-391` lo declaró explícitamente fuera del parser actual). La auditoría I pidió esa decisión escrita; sigue sin escribirse.

### 23. Personas físicas (RESICO PF, arrendamiento, honorarios). **SIGUE-ABIERTA**
La familia `annual` es de persona moral. La decisión de alcance —aunque sea «fuera de alcance v1»— sigue sin estar en el plan maestro.

### 24. El checklist de cierre: dos compuertas fiscales de cuatro. **PARCIALMENTE CERRADA**
`period-close.ts` pasó de 5 ítems a 7, y los dos nuevos son fiscales y gobernados (fortaleza 4). Faltan las otras dos de la recomendación 5 de la auditoría I: (a) cuentas con movimientos sin agrupador —imposible hoy sin resolver la brecha 3, que además apunta a la columna equivocada— y (d) IVA aparcado en 1135/2125 contra el saldo contable. El plan maestro ya las tiene asignadas a F06.

---

## CUÁNTO DEL BLOQUEO ES REAL Y CUÁNTO ES PEREZA

La pregunta del encargo merece respuesta numérica. Repartidas las ~36 filas de catálogo de la mitad de PRESENTACIÓN (`diot` 4, `e-accounting` 12, `filing` 7, `obligation` 4, `annual` 7, `isn` 2), más lo que arrastran:

**Bloqueo REAL (e.firma o contrato de PAC, sin sustituto):**
- Descarga masiva SAT (brecha 21). E3.2, rojo honesto, ~11 tareas de motor.
- Transmisión de la contabilidad electrónica y los acuses (`file`) — F07b.
- Timbrar de verdad, cancelar de verdad ante el PAC.
- Opinión 32-D (credencial del cliente contra un tercero).

**Falso bloqueo — construible HOY, sin PAC y sin e.firma:**
1. **Todo el XML del Anexo 24** — catálogo con agrupador, balanza, pólizas, auxiliares, con `generate|check|diff` contra el XSD. La e.firma sólo sella el envío. El prerrequisito real es la taxonomía del apartado B como dato sembrado, más resolver el cisma de columnas de la brecha 3.
2. **DIOT completa** (`generate|check|export`). Los insumos ya están separados desde IVA-5. Presentar es un acto humano por el portal — la propia skill `diot-checklist` ya lo enseña.
3. **Papeles de trabajo de IVA y de provisionales de ISR**, con el prorrateo del art. 5-V. Aritmética sobre el mayor.
4. **La serie mensual del INPC como tabla propia**, y encima de ella inflación anual, CUFIN, CUCA y pérdidas. Datos públicos y aritmética.
5. **El XML del CFDI de emisión completo** (conceptos, impuestos, cadena original, validación XSD). Sovos sella con su CSD: ni el CSD del emisor hace falta para armarlo y validarlo.
6. **Registrar `sovosReachcoreAdapter` en el registry** — una línea (brecha 1). Es la pereza en estado puro: el adaptador está terminado y probado y no se puede configurar.
7. **El armado del `pago20`** (brecha 7). El faltante-list ya se construyó; el nodo no depende del PAC hasta que se timbra.
8. **Persistir `EsCancelable` y `ValidacionEFOS`** (brecha 11) — el SAT ya los está mandando.
9. **Reaccionar a la cancelación posterior** (brecha 13): compuerta de cierre y lista de expuestos. La detección ya existe desde F02.
10. **Ingesta de las listas 69-B/69** (brecha 17): CSV público del DOF, sin credencial.
11. **El plazo de cancelación del emisor** y **el plazo del día 5 del REP** (brechas 16 y 14): lógica de fechas.
12. **Todos los datos de juguete del CFDI de nómina y el nodo `OtrosPagos` del subsidio** (brechas 8 y 9): forma del XML y una consulta a una columna que ya existe.
13. **La mitad de atestiguación del buzón tributario** (brecha 18): `tax-mailbox record`/`check` es una obligación fechada y firmada, no un scraper.
14. **Separar la cuenta 2140 en tres** (brecha 10): tres filas de catálogo y tres mapeos de rol.

**El veredicto: de los dos bloqueos externos, sólo uno bloquea de verdad, y bloquea menos de lo que se le atribuye.** El plan maestro ya absorbió la corrección principal de la auditoría I —F07 partido en «F07a generadores, DESBLOQUEADOS» y «F07b transmisión»— y eso es un acierto que hay que reconocer. Lo que la auditoría II añade es que el bloqueo sigue siendo más ancho de lo que el plan cree en tres puntos que el plan aún atribuye a E3.1/E3.2: la reacción a la cancelación ajena, el 69-B, y —el más caro— el propio contrato de PAC, cuyo primer eslabón no es un contrato sino un `integrationRegistry.register` que falta.

---

## RECOMENDACIONES

1. **(S · F03, o hoy mismo)** Añadir `integrationRegistry.register(sovosReachcoreAdapter)` en `pac-router.ts:23`, y un criterio en `plan/criterios.ts` que exija que todo adaptador de `PAC_ADAPTERS` esté registrado —la asimetría entre el mapa `:26` y los `register` `:21-23` es la clase de hueco que sólo un instrumento ve. Y renombrar la cabecera «E3.1 · Timbrado real» (`criterios.ts:1560`) a lo que sus dos criterios miden de verdad, o añadirle el tercero que falta: *el sistema puede configurar al menos un PAC no simulado*.
2. **(M · F07a)** Resolver el cisma del agrupador **antes** de escribir un solo generador del Anexo 24: elegir una columna (`mx_nif_code` tiene los escritores; `codigo_agrupador_sat` tiene el nombre y el `COMMENT`), migrar la otra, y reapuntar la promesa de la 037. Después, corregir `checkMappingCoverage` para que mida **cuentas con movimientos** —lo prometido— en vez de `account_level <= 2`, y sembrar el catálogo `c_CodAgrup` para que `map set` valide. Es el prerrequisito compartido de todo F07a y cada mes de captura lo encarece: el mismo argumento con el que la 037 se justificó a sí misma.
3. **(S · F02, deuda de F02)** Añadir columnas `sat_es_cancelable` y `sat_validacion_efos` a `xml_documents`, escribirlas en `revalidateEntityCfdis` y en `validateAndUpdate`, mostrarlas en `cfdi status show`, y **dejar de escribir `sat_fecha_cancelacion = NULL`** incondicionalmente (`cfdi-status.ts:230`). Hasta que exista, degradar la fila 1985 del catálogo de ✅ a 🟡: su descripción promete cuatro campos y el espejo guarda dos y medio. Rojos honestos > verdes falsos, también en las filas del catálogo.
4. **(M · F06)** Cerrar el bucle de la cancelación ajena, que ya no depende de nada externo: una compuerta de cierre «CFDI posteados que el SAT reporta cancelados», la lista de expuestos con su asiento, y la reversa encadenada como acto humano explícito. Y sacar esa mitad del paquete E3.2 en `criterios.ts:1598-1599`, donde hoy la esconde el bloqueo de la descarga masiva.
5. **(M · F08)** Nómina, en un solo paquete porque son el mismo XML: leer `legal_entities.imss_registro_patronal` en vez de `B0000000000`, el CP fiscal en vez de `00000`, calcular `Antiguedad` desde `hire_date` (que el `SELECT` ya trae), derivar `PeriodicidadPago` y `ClaveEntFed` de los datos, y **añadir el nodo `OtrosPagos` con `TipoOtroPago="002"` para el subsidio al empleo en vez de netearlo contra el ISR** (`cfdi-nomina-generator.ts:84`). Las exenciones con topes UMA por concepto quedan como el trozo grande; el resto son consultas que no se hicieron.
6. **(M · F07a)** Separar la cuenta 2140 en tres —ISR retenido a terceros, IVA retenido a terceros, ISR de nómina— con migración de saldos históricos, y extender `IVA_ROLES` del doctor (`doctor-service.ts:204-207`) para que también falle por los roles de retención sin cuenta propia. Hacerlo **antes** de la DIOT y del auxiliar del Anexo 24, que son sus consumidores.
7. **(S · F07a)** La tabla de serie mensual del INPC. El plan ya la adoptó; nadie la ha escrito, y desbloquea cuatro cosas en cadena.
8. **(S · F02/F06)** Dos plazos de fechas: el del emisor para cancelar (CFF 29-A, sobre `cfdi cancel`) y el del día 5 para el REP emitido. Para el segundo, **cablear o retirar** `overdueOnly` (`rep-pendientes.ts:38`): hoy es una opción muerta bajo un cierre que promete «plazo».
9. **(M · F07a)** Ingesta append-only de las listas 69-B/69 con fecha de publicación y `party check --as-of`. Es un CSV público; el único motivo por el que no existe es que vive en un paquete etiquetado como bloqueado.
10. **(S · plan maestro)** Escribir dos decisiones de alcance que la auditoría I ya pidió y siguen sin escribirse: personas físicas (aunque sea «fuera de alcance v1») y constancias de Retenciones recibidas. Y actualizar la ficha de F08, que sigue prometiendo mover el `.cer/.key` del IDSE a la bóveda — ya está hecho (`imss-idse-adapter.ts:59-63`).
11. **(S · F06)** La mitad de atestiguación del buzón (`tax-mailbox record`/`check`, con la alerta a los 3 días hábiles). No necesita credencial y es la única defensa contra la aceptación tácita de una cancelación ajena — la contraparte humana de la recomendación 4.

---

## VERIFICACIÓN ADVERSARIA DEL HALLAZGO MAYOR

**Hallazgo:** El único PAC no simulado del repositorio es inalcanzable por una línea que falta: `SovosReachcoreAdapter` (`simulado = false`, sovos-reachcore-adapter.ts:128, con `configure()` completo en :134-157) nunca se registra —`pac-router.ts:21-23` registra sólo los tres simulados aunque `:26` lo liste en `PAC_ADAPTERS`— así que `integrationRegistry.get()` (routes/integrations.ts:62) muere en PROVIDER_NOT_FOUND (base/registry.ts:24) y el PAC no se puede configurar jamás; mientras tanto el tablero muestra `✅ E3.1 2/2` bajo la cabecera «Timbrado real» (criterios.ts:1560) porque sus dos criterios miden el cerrojo antisimulación, no la capacidad de timbrar.

**¿Refutado?** No: se sostiene

SE SOSTIENE en su núcleo, pero con tres imprecisiones y una omisión que lo hace más grave de lo que dice.

LO QUE CONFIRMO CON EVIDENCIA PROPIA:
1. `SovosReachcoreAdapter` es el único PAC no simulado: `sovos-reachcore-adapter.ts:128` (`readonly simulado = false`) contra `finkok-adapter.ts:27`, `sw-sapien-adapter.ts:27` y `edicom-adapter.ts:26`, los tres `simulado = true`. Exacto.
2. Nunca se registra. `grep -rn "\.register(" src/` devuelve exactamente 4 sitios de integraciones: `src/services/integrations/index.ts:12-15` (stripe, conekta, sendgrid, s3) y `pac-router.ts:21-23` (finkok, swSapien, edicom). Cero ocurrencias de `integrationRegistry.register(sovosReachcoreAdapter)` en todo `src/`. El adaptador se importa en `pac-router.ts:9` y aparece en `PAC_ADAPTERS` en `:26`, pero la línea de registro no existe. Y `registry.register` es idempotente (`registry.ts:17`), así que añadirla sería inocuo.
3. `integrationRegistry.get()` muere en `PROVIDER_NOT_FOUND` (`registry.ts:21-26`, throw en `:24`). Confirmado.
4. `configure()` está completo y es inalcanzable: `sovos-reachcore-adapter.ts:134-157` valida apiKey/apiKeyEnv y ambiente uat|production, y su ÚNICO llamador en `src/` es `routes/integrations.ts:86`, precedido por el `registry.get` de `:83`. Fuera de ese archivo, `grep -rn "sovosReachcoreAdapter\|sovos_reachcore" src/` sólo devuelve `pac-router.ts:9,26` y el propio adaptador — no hay CLI ni ninguna otra puerta.
5. El tablero da verde: corrí `npx tsx src/plan/status.ts` y la línea 15 imprime `✅ E3.1   2/2 criterios`. Sus dos criterios son `criterios.ts:1564-1574` (cuenta ≥3 ocurrencias de `assertPuedeTimbrar` en pac-router — hay 3: import `:7` + usos `:157` y `:221`) y `criterios.ts:1579-1584` (que `invoices.ts` no tenga `cfdi_status = 'cancelled'`; la línea 325 usa `:` no `=`, así que no matchea). Ninguno de los dos mide capacidad de timbrar. Exacto.

DONDE EL HALLAZGO SE PASA O SE QUEDA CORTO:
a) «Inalcanzable» es demasiado amplio. Sovos SÍ es alcanzable para timbrar y cancelar: `pacRouter.stamp` resuelve el adaptador desde `PAC_ADAPTERS` (`pac-router.ts:150`), no desde el registry, y `cancel` igual (`:212`); `getAllHealth` lo recorre (`:235`). Lo que está roto es sólo el camino de credenciales, y por eso `credenciales()` (`sovos-reachcore-adapter.ts:393`) lanza «Sovos no está configurado» (`:401`) en cada intento. Routable pero inconfigurable — no inalcanzable.
b) No es sólo `configure()`: las cuatro rutas admin mueren igual (`integrations.ts:62` GET, `:83` PUT, `:101` test) y el listado `integrationRegistry.list()` de `:25` lo omite, así que el PAC real ni siquiera aparece en el inventario de integraciones.
c) La «cabecera Timbrado real» no la muestra el tablero. `grep -rn "Timbrado real" src/` da UN solo hit: `criterios.ts:1560`, y es un COMENTARIO de código. La salida del CLI imprime `✅ E3.1   2/2 criterios`, sin etiqueta. El falso verde existe, pero no bajo ese rótulo visible.
d) Se queda corto en la consecuencia. Como los otros tres son `simulado = true` y `simulacion.ts:36` hace que `simulacionPermitida()` devuelva `false` en producción sin forma de habilitarlo, el efecto neto no es «un PAC no se puede configurar»: es que en producción NO SE PUEDE TIMBRAR NINGÚN CFDI. Los tres registrados chocan contra `assertPuedeTimbrar` (`simulacion.ts:44-56`) y el único que pasaría el cerrojo no tiene cómo recibir credenciales.
e) No es un defecto oculto: `docs/cli-command-catalog.md:1902` ya lo documenta literalmente («el adaptador **nunca se registra** … Registrarlo es el prerrequisito de esta fila») y `docs/pac-proveedores.md:237-238` fija la postura «Sovos: escrito y listo, a la espera de contrato». Es un hueco conocido y trazado en el propio repo, no una sorpresa — lo que atenúa el tono de denuncia, no el hecho.

**Formulación corregida:** El único adaptador de PAC no simulado del repositorio (`SovosReachcoreAdapter`, `simulado = false` en sovos-reachcore-adapter.ts:128) es ROUTABLE pero INCONFIGURABLE: `pac-router.ts` lo importa (:9) y lo incluye en `PAC_ADAPTERS` (:26) —así que `pacRouter.stamp`/`cancel` sí lo resuelven (:150, :212)— pero omite la cuarta línea de registro: `:21-23` registra sólo finkok, sw_sapien y edicom, y `grep -rn "\.register(" src/` confirma que no hay ninguna otra. Por eso las cuatro rutas admin que pasan por `integrationRegistry.get()` (integrations.ts:62 GET, :83 PUT, :101 test) mueren en PROVIDER_NOT_FOUND (registry.ts:24), el PAC ni figura en el listado (`list()`, :25), su `configure()` completo (:134-157) no tiene un solo llamador alcanzable, y todo intento de timbrar acaba en «Sovos no está configurado» (:401).

La consecuencia real es más dura que «un PAC no se puede dar de alta»: los otros tres adaptadores son `simulado = true` (finkok:27, sw-sapien:27, edicom:26) y `simulacionPermitida()` devuelve false sin escape en producción (simulacion.ts:36), así que en producción NO se puede timbrar ningún CFDI — los tres registrados los corta `assertPuedeTimbrar` (simulacion.ts:44-56) y el único real no puede recibir credenciales.

Mientras tanto `npx tsx src/plan/status.ts` imprime `✅ E3.1 2/2 criterios`, porque sus dos criterios miden el cerrojo antisimulación (criterios.ts:1564-1574, cuenta ocurrencias de `assertPuedeTimbrar`) y que la ruta de cancelación no finja (criterios.ts:1579-1584) — ninguno mide capacidad de timbrar. Precisión: el rótulo «Timbrado real» sólo existe como comentario en criterios.ts:1560; el tablero no lo imprime. Y el hueco ya está documentado en docs/cli-command-catalog.md:1902 y docs/pac-proveedores.md:237-238 («escrito y listo, a la espera de contrato»), así que la corrección es una línea idempotente (registry.ts:17), no un rediseño.

