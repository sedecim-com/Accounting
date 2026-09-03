# Onboarding de contabilidad

Nadie llega a mnemosine con la contabilidad en cero. Llega con años de historia en CONTPAQi, en Aspel COI, en Contalink, o en una carpeta de XML y estados de cuenta. Esta página cuenta tres cosas: **lo que ya funciona hoy**, **los cerrojos que el alta tiene puestos y que casi nadie había mirado**, y **el pipeline por capas que es dirección, no capacidad**. El lector no debe salir creyendo que ya puede importar el XML de su balanza; tampoco debe salir creyendo que lo que sí corre deja el catálogo en buen estado.

> **Esta página cambió el 2-sep-2026 (tarde).** La segunda pasada de investigación desmintió cinco afirmaciones que aquí se leían como ciertas. Están listadas una por una al final, en [Qué se corrigió](#qué-se-corrigió-en-esta-pasada). Si la leíste antes, empieza por ahí.

---

## Lo que existe hoy

**El comando `onboard` (alias `alta`), con un solo proveedor.** [`src/cli/mnemosine.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/mnemosine.ts) lo declara con `--provider contalink` como única opción viva, `--cutoff` obligatorio, `--from` (por omisión el 1 de enero del año del corte), `--balance-account` para balanzas remotas que no suman cero, y `--post` opcional — sin él, el asiento de apertura queda en **borrador para revisión**. El flujo es plan → confirmación → ejecución, con idempotencia por llave y una verificación post-importación que exige **cero diferencias** entre la balanza remota y la nuestra (`diffTrialBalance`). Está declarado `risk: 'irreversible'` y `agent: false`: el agente no lo alcanza; lo corre una persona.

**El servicio detrás.** [`src/ai/onboarding-service.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/onboarding-service.ts) —240 líneas, sin un cambio desde la primera pasada— lee la balanza remota, infiere tipo y naturaleza por el primer dígito del código mexicano (1 activo, 2 pasivo, 3 capital, 4 ingreso, 5/6 gasto, 7 con baja confianza), detecta cuentas faltantes y arma el asiento de apertura con referencia determinística `onboarding:<provider>:<cutoff>` — rechaza duplicados posteados **y también** borradores pendientes con la misma referencia. `executeOnboarding` pasa por `createDraft`/`approveDraft`: el único camino al mayor, como todo lo demás. La tolerancia de cuadre es la constante `BALANCE_TOLERANCE = 0.01`, quemada en el archivo, no una política.

**El adaptador.** [`registry.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/integrations/accounting/registry.ts) sigue con una sola fábrica: `contalink`, con credencial vía `CONTALINK_API_KEY` en el entorno — nunca en un archivo de configuración. La interfaz ([`accounting-adapter.interface.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/integrations/accounting/accounting-adapter.interface.ts)) pide esencialmente `getTrialBalance(start, cutoff)`.

**El staging de pólizas — y desde F06c, su familia completa.** `entry import` ([`entry-command.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/entry-command.ts)) lleva un archivo a un lote con `batch_id`, jamás al mayor. Lo nuevo es que ese lote ya no es un callejón sin salida: [`batch-command.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/batch-command.ts) tiene `list`, `show`, `check`, `post` y **`reverse`** — este último espeja el lote entero «as the unit it always was». Los layouts vivos siguen siendo `csv` y `ndjson`; `contpaqi`, `aspel`, `iif` y `sat-polizas` están **reservados y rechazados con mensaje honesto** en [`entry-import-service.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/entry-import-service.ts).

**El agrupador SAT.** `account map import/check --scheme sat-agrupador` ([`account-command.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/account-command.ts)) escribe el código agrupador por cuenta en `mx_nif_code`, y `map check` es la compuerta de cobertura antes de cualquier XML de catálogo del Anexo 24. `map match` **sigue sin existir**, y [`account-service.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/account-service.ts) sigue confesando por qué: no valida contra el catálogo c_CodAgrup «porque ese catálogo no existe en el repo todavía». Lo que cambió es la razón del hueco: ya no es falta de fuente, es falta de transcripción (ver abajo).

**Los activos fijos, con escritor desde F06a.** La migración `056_el_activo_y_su_corrida.sql` abre confesando que «el módulo de activos lleva desde la 003 con el esquema entero y ningún escritor». Hoy hay `crearActivo`, `planDeDepreciacion` y `runMonthlyDepreciation` ([`asset-service.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/assets/asset-service.ts), [`depreciation.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/assets/depreciation.ts)), sus comandos, y dos políticas propias en el panel (`base_depreciacion`, `convencion_primer_mes`). Eso convirtió la migración de activos de hipótesis en problema real — sección siguiente.

**El asistente `init`, sección S5.** Tres puertas para «traer tu contabilidad» ([`s5-import.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/init/s5-import.ts)): la API de Contalink, una carpeta de XML de CFDI (tope de 50 en la primera corrida y auto-posteo apagado), o empezar de cero. Ver [[Puesta-en-marcha]].

**La discrepancia sigue en pie.** Hay dos columnas para el mismo concepto en `accounts`: `mx_nif_code` (migración 001, con lectores y escritores) y `codigo_agrupador_sat` (migración 037), que **sigue sin una sola referencia en TypeScript**. Capacidad huérfana intacta; el plan la consolida **antes** de construir encima.

---

## Los tres cerrojos del alta

Esto es lo que la primera pasada no miró y es lo que peor duele. No son ausencias del roadmap: son cosas que el código que hoy corre hace mal.

### 1. El catálogo migrado nace mutilado

El INSERT de `executeOnboarding` escribe **siete columnas de las veintiocho** que tiene `accounts` en la migración 001: `id, code, name, account_type, normal_balance, entity_id, created_by`. Se quedan fuera `parent_id`, `account_level` (NOT NULL DEFAULT **1**), `full_code`, `account_subtype`, `fs_category`, `is_control_account`, `is_header`, `allow_manual_entries`, `require_subsidiary`, `currency_code`, `mx_nif_code` y `tags`. Consecuencias medibles el primer día de un cliente migrado:

- **cobertura de agrupador 0 %** — `account map check --scheme sat-agrupador` reprueba entero, precisamente en el cliente que venía de un sistema que *sí* tenía el agrupador en el XML;
- **catálogo plano** — todas las cuentas en nivel 1, sin padre, aunque el `SubCtaDe` del XML lo dice;
- **cuentas acumulativas que aceptan pólizas** — `is_header` queda en `false` y el CHECK `is_header = false OR allow_manual_entries = false` no se opone;
- **sin moneda de cuenta** — `currency_code` nulo aunque la balanza de origen distinga bancos en dólares.

### 2. La depreciación acumulada de un activo migrado no se puede cargar — y si se cargara, la primera corrida la borraría

Son dos cerrojos y hay que abrir los dos. **No hay por dónde entrarla**: `DatosDeAlta` tiene veinte campos y ninguno dice cuánto lleva depreciado el activo ni cuántos meses de vida le quedan; `montosDelAlta` valida costo y salvamento y nada más. **Y si se entrara, se pierde en el primer cierre**: tras cada corrida, `depreciation.ts` fija `accumulated_depreciation = SUM(depreciation_expense) WHERE is_posted = true` — la acumulada se **re-deriva** de los renglones que *este* sistema posteó. Un activo con tres años de historia ajena queda, tras su primer mes aquí, con la acumulada de un mes y un valor en libros inflado en tres años.

Ese SQL **está bien** para lo que fue escrito: la 059 documenta que «la ficha del activo llegó a afirmar una acumulada que el mayor no respaldaba justo por copiar el renglón». El invariante —*la ficha no afirma lo que el mayor no respalda*— la migración no lo rompe: lo **extiende**, porque en un activo migrado el mayor sí respalda la acumulada ajena: está en el renglón `171.xx` de la póliza de apertura.

**La bifurcación, escrita para que alguien la resuelva:** ¿la historia ajena entra como (a) renglones en `depreciation_schedules` con `is_posted = false` y metadatos que digan que vienen de una migración —papel de trabajo por mes, y la fórmula actual sigue siendo verdad—, o (b) una columna de acumulada de apertura que la corrida **sume** en vez de pisar? (b) es una línea de SQL; (a) es lo que un auditor querrá ver. Va al panel, no al chat. Y por la misma puerta hacen falta dos permisos que hoy no existen: un activo **totalmente depreciado** que sigue en operación (hoy `montosDelAlta` rechaza salvamento ≥ costo, con buena razón para altas nuevas y mala para migraciones) y un activo comprado hace seis años cuyo inicio de depreciación no debe hacer que el motor intente correr setenta y dos meses hacia atrás.

**Por qué duele ahora y no antes:** el agrupador del SAT desglosa `171 Depreciación acumulada de activos fijos` en **dieciocho** subcuentas (171.01 edificios … 171.18 otra maquinaria). La balanza mensual que el cliente ya le envía al SAT expone su acumulada por especie. Un cliente migrado manda en enero un 171 que no se parece al de diciembre, y ese salto lo ve el SAT antes que el despacho.

### 3. «Deshacer una migración» no funciona

El primitivo existe y no alcanza a la migración. `reverseBatch` localiza las pólizas del lote con un `JOIN journal_entry_import_rows r ON r.id = je.source_id … AND je.source_type = ORIGEN_LOTE_IMPORTADO`. **La póliza de apertura no nace de un lote**: nace de `createDraft`, sin `batch_id` y sin ese `source_type`. El repertorio real es `entry reverse` sobre la apertura —una a la vez, y «one reversal per entry, ever»— y `account archive` cuenta por cuenta. Y las N cuentas que creó `executeOnboarding` **no tienen marca de procedencia**: nada dice «esta cuenta nació de `onboarding:contalink:2026-01-01`», así que ni siquiera se pueden listar para archivarlas — aunque `accounts.tags` es `JSONB DEFAULT '{}'` y está sin usar.

La vara está baja y se salta holgadamente: QuickBooks Online no sabe deshacer una migración, sabe **tirar la empresa** (purga total si tiene menos de 60 días y sólo en ciertos planes; si tiene más, se cancela la empresa y se abre otra). Nosotros ya tenemos la referencia determinística. Faltan: que la migración sea **una unidad reversable** (póliza, cuentas, documentos abiertos y activos entran y salen juntos), procedencia en `tags`, que deshacer sea **reversa y no borrado** (la 041 y NIF B-1: el mayor es inviolable), y que el caso feo se diga en voz alta — **una migración sobre la que ya se posteó un mes de operación no se deshace**: se corrige con pólizas fechadas, y la herramienta tiene que negarse y explicar por qué.

### Y dos más, baratas

**La apertura pierde la moneda de origen.** R4 hizo que `createJournalEntry` por fin escriba las cuatro columnas cambiarias de la 001 (`currency_code`, `foreign_debit`, `foreign_credit`, `exchange_rate` en `JournalEntryLineInput`). Pero `DraftLine` ([`draft-service.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/draft-service.ts)) tiene cuatro campos y ninguno es de moneda, y `executeOnboarding` va **siempre** por `createDraft`. La póliza de apertura de un cliente con cuenta en dólares nace en funcional y pierde el origen — la pérdida exacta que R4 arregló, reintroducida por la puerta del onboarding. Y no es culpa de la fuente: el `CompNal` del XSD de pólizas trae `Moneda` y `TipCamb`. Es la brecha más barata de esta página y la que más rápido se vuelve irreparable: una vez posteada la apertura, el mayor es inviolable.

**No hay papel de trabajo.** `diffTrialBalance` devuelve un objeto en memoria: `matched_equal`, `differences`, `only_local`, `only_remote`. **Nada lo escribe.** El criterio que esta página llama «el candado del pipeline» produce hoy una prueba que dura lo que dura el scrollback. Falta un **expediente de migración** que sobreviva al año: la balanza de origen tal como llegó con su hash, la nuestra al corte, el diff cuenta por cuenta, las cuentas creadas, la cuenta puente con su importe y su criterio, y el folio de la póliza de apertura — un solo artefacto al que se llegue con `opening-balance show`.

---

## Por qué el XML del SAT es el formato universal

La contabilidad electrónica es obligación fiscal en México (art. 28 fr. IV del CFF, reglas 1.4. fr. XXIV, 2.8.1.6., 2.8.1.7. y 2.8.1.10. de la RMF): catálogo de cuentas una vez, con código agrupador por cuenta, y balanza de comprobación mensual, en XML validado contra los XSD del SAT. La consecuencia estructural importa más que el trámite: **todo sistema contable mexicano en operación exporta estos XML por obligación**, lo que los vuelve el formato de intercambio de facto, más universal que cualquier CSV propietario.

**El Anexo 24 vigente ya no es una liga muerta.** *(Corrección: esta página decía que sólo pudo verificarse el DOF de 2015 porque el host `omawww` rechaza HTTPS.)* La publicación actual —**Anexo 24 de la RMF 2026, DOF del 13 de enero de 2026**— vive en un host que sí responde: [`Anexo_24_RMF2026-13012026.pdf`](https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/anexos/Anexo_24_RMF2026-13012026.pdf) (610 KB, descargado y extraído con `pdftotext`, no citado de memoria). Trae **el catálogo c_CodAgrup entero, 1 066 renglones** de nivel 1 y 2, del `100 Activo` al `899.02 Contra cuenta otras cuentas de orden`. Ése es literalmente el archivo que `account-service.ts` confiesa no tener.

**Y trae una corrección de numeración.** *(Corrección: esta página citaba «la sección B, el catálogo de códigos agrupadores», apoyándose en el DOF de 2015.)* En la RMF 2026 el contenido es **A** Catálogo de cuentas —con *a) Código agrupador del SAT* como subsección, ya no como letra propia—, **B** Balanza de comprobación, **C** Pólizas del periodo, **D** Auxiliar de folios, **E** Auxiliares de cuenta y subcuenta, **F/G/H** monedas, bancos y métodos de pago; no hay sección con letra para el sello. Quien cite «la sección B» pensando en el agrupador va a citar la balanza. El [DOF de 2015](https://dof.gob.mx/miscelanea_2015/SHCP_05012015_04.pdf) sigue vivo y sigue sirviendo para el sello digital y la nomenclatura del ZIP (`RFC + ejercicio + periodo + PL + .zip`), en la **Cuarta** Sección, páginas 65 en adelante.

Los cuatro esquemas vigentes (versión 1.3), releídos en la segunda pasada y sin cambio de versión:

| XSD | Qué trae | Capa que cubre |
|---|---|---|
| [Catálogo de cuentas](https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd) | `NumCta`, `Desc`, `CodAgrup` (obligatorio por cuenta), `Nivel`, `Natur` (D/A), `SubCtaDe`; y en la raíz, **`Mes` y `Anio` de inicio de vigencia** más `Sello`/`noCertificado`/`Certificado` opcionales | Catálogo **y** agrupador de un golpe |
| [Balanza de comprobación](https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_3.xsd) | `SaldoIni`, `Debe`, `Haber`, `SaldoFin` (dos decimales); `Mes` 01-13 (el 13 es el ajuste de cierre), `Anio` 2015-2099, `TipoEnvio` N/C y **`FechaModBal` obligatoria cuando el envío es complementario** | Apertura al corte |
| [Pólizas del periodo](https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/PolizasPeriodo/PolizasPeriodo_1_3.xsd) | Transacciones con `CompNal` (UUID del CFDI, RFC, monto **y `Moneda`/`TipCamb`**), cheques, transferencias | Histórico detallado |
| [Auxiliar de cuentas](https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/AuxiliarCtas/AuxiliarCtas_1_3.xsd) | `SaldoIni`/`SaldoFin` por cuenta y `DetalleAux` con fecha, folio de póliza, concepto, debe y haber | Histórico detallado |

Tres de esos detalles son operativos, no decorativos: el catálogo **dice desde qué mes rige**, que es cómo se comprueba que el archivo entregado corresponde al corte; la complementaria exige fecha de modificación, que es lo que distingue dos balanzas del mismo mes; y el `CompNal` **sí trae la moneda de origen**, o sea que en el cerrojo de la moneda somos nosotros quienes la tiramos.

**Y los dos grandes lo exportan de fábrica.** CONTPAQi Contabilidad genera los XML del Anexo 24 directamente desde los registros contables y confirma que «el Anexo 24 versión 1.3 sigue siendo obligatorio en 2026» ([guía oficial](https://www.contpaqi.com/publicaciones/contabilidad/contabilidad-electronica-guia-completa)); Aspel COI los genera por `Fiscales → Generación de XML` — [catálogo](https://coiportaldeclientes.aspel.com.mx/xml-catalogo-de-cuentas/) y [balanza](https://coiportaldeclientes.aspel.com.mx/xml-balanza-de-comprobacion/), con nivel mayor/subcuenta/auxiliar y envío normal o complementario. *Matiz honesto:* ninguna de las dos páginas de Aspel menciona la versión 1.3; que exporte el XML está verificado, que exporte **1.3** se apoya en el dicho de CONTPAQi y en que 1.3 es la única vigente. Conclusión operativa que no cambia: **migrar desde CONTPAQi o Aspel no requiere ingeniería inversa de formatos propietarios**, y los layouts `contpaqi` y `aspel` reservados se redefinen como «instrucciones para exportar el XML del SAT desde ese sistema».

---

## El pipeline por capas (propuesto — nada de esto existe todavía)

Cuatro capas, todas desembocando en los caminos que ya existen: borradores y staging. Ninguna herramienta del agente toca el mayor; el humano aprueba con `review`, `--post` o la familia `batch`.

> **Corrección de rumbo.** Esta página proponía «un adaptador `xml-sat` de archivo en el registry contable» y «un `csv-balanza` genérico». [`docs/cli-command-catalog.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/cli-command-catalog.md) **ya tenía reservada esa capacidad, con otro nombre**: `chart import <file>` («carga un catálogo desde CSV/XLSX, export de CONTPAQi/Aspel o `CatalogoCuentas_1_3`»), y la familia `opening-balance` — `import`, `show`, `check`, `suspense generate` — descrita literalmente como «el gemelo dirigido por archivo de `onboard`, que no se toca», sin `--post` expuesto. El catálogo mandó primero. **El registry contable se queda para proveedores por API**, porque un `IExternalAccountingAdapter` que en realidad lee un archivo tiene que fingir `getTrialBalance(start, cutoff)` ignorando el rango, y esa mentira se paga en `diffTrialBalance`.

**Capa 1 — Catálogo (`chart import`).** El parser de `CatalogoCuentas_1_3` llena de un golpe lo que hoy son dos pasos: crea la cuenta **y** escribe el agrupador, porque `CodAgrup` viene en el XML. Desaparece la tarea de alta más pesada de un despacho. Validaciones antes de aceptar: la `Natur` del XML contra la naturaleza inferida (discrepancia se reporta; gana el XML, con bandera), jerarquía `SubCtaDe`/`Nivel` consistente, `CodAgrup` contra c_CodAgrup **sembrado como tabla** con su fuente escrita al lado, y cuentas acumulativas marcadas como encabezado. Prerrequisitos: consolidar las dos columnas de agrupador, y que el alta escriba las veintiocho columnas y no siete.

**Capa 2 — Balanza de apertura al corte (`opening-balance import`).** El parser de `BalanzaComprobacion_1_3` alimenta el mismo flujo plan → confirmación → borrador → verificación. Se toma `SaldoFin` del mes del corte (o `SaldoIni` del mes siguiente si viene, verificando que coincidan), y se comprueba que el `Mes`/`Anio` de vigencia del catálogo corresponda al corte. Un layout CSV mapeado queda como fallback para orígenes sin XML.

**Capa 3 — Auxiliares abiertos de CxC/CxP, documento a documento.** Las tablas ya llegaron: 049 y 050 trajeron notas de crédito, aplicaciones con su historia de desaplicación, el cobro devuelto y el perfil fiscal del cliente; `credit_notes.relates_to_uuid` está pensado justo para «una nota sobre una factura pre-mnemosine». **Lo que no hay es la puerta**: ni `invoice` ni `bill` tienen `import --file`, así que migrar cuarenta clientes significa teclear. La regla de aceptación no negocia: **la suma de documentos abiertos por cuenta de control debe igualar el renglón de esa cuenta en la balanza de apertura**; si no cuadra, la capa se rechaza completa. No hay «casi cuadra» — y hoy tampoco hay comando donde ese candado viva (sería `opening-balance check --subledger`). El UUID no es un adorno: de él dependen el REP y el cruce con el espejo CFDI.

**Capa 4 — Los CFDI del ejercicio.** Dos vías: la carpeta local que ya ingiere el clasificador (auto-posteo apagado, tope de primera corrida), y un futuro adaptador del servicio de descarga masiva del SAT ([documentación oficial](https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461174995026&ssbinary=true): flujo solicitud → verificación → descarga, e.firma obligatoria). Los límites, según la [comunidad phpcfdi](https://github.com/phpcfdi/sat-ws-descarga-masiva) —ahora en v1.5, mayo de 2025—: 200 000 CFDI por solicitud (1 000 000 en metadata), y **dos restricciones que hay que codificar desde el principio: no se consultan comprobantes a más de seis ejercicios incluido el actual, y la fecha inicial debe ser estrictamente menor que la final.** Un despacho que quiera reconstruir cinco años tiene que trocear por ejercicio. La e.firma va a la bóveda, jamás al chat ni a un archivo de configuración — y el argumento ya no es nuestro: el propio SAT pide garantizar que la e.firma «no se almacene en el equipo de un tercero». En modo reconstrucción, la capa 4 sustituye a las capas 2-3 y la apertura se reduce a saldos bancarios y de capital. Las pólizas históricas entrarían por `entry import --layout sat-polizas`, el layout ya reservado.

---

## Las validaciones: el candado del pipeline

> **La balanza del sistema viejo y la nuestra IGUALES al corte, cuenta por cuenta** — `diffTrialBalance` con 0 diferencias y 0 cuentas solo-remotas, corrido automáticamente al postear la apertura.

Debajo: cuadre global (débitos = créditos, tolerancia de 0.01 y `--balance-account` para balanzas parciales), naturaleza (un saldo deudor en cuenta acreedora se reporta como advertencia, no se corrige en silencio), agrupador contra c_CodAgrup, y la igualdad exacta auxiliar-contra-control de la capa 3. La salida de `onboard` debería terminar en un checklist post-migración —balanza comparada, bancos por conciliar, documentos abiertos ligados, utilidades retenidas revisadas— y ese checklist, junto con el diff, **debe quedar escrito**: hoy no lo está (ver cerrojos, «no hay papel de trabajo»).

---

## Las prácticas de corte

**La fecha de corte es el primero de un mes, y de preferencia el inicio del ejercicio.** Doctrina de Xero ([conversion date](https://central.xero.com/s/article/Setting-your-conversion-date)): la fecha de conversión es la de tus saldos de apertura, siempre el primero de un mes, «el día siguiente a la fecha en que cuadraste todas tus cuentas en el sistema anterior». Migrar a media anualidad se permite, pero arrastra acumulados de resultados que el inicio de ejercicio evita.

> **Advertencia sobre las fuentes de Xero.** *(Corrección al tono de esta página, que las daba por verificadas sin reservas.)* En la segunda pasada, `central.xero.com` devolvió documentos **vacíos** —cáscaras que sólo se pintan con JavaScript— en las cinco ligas consultadas. No están muertas (los títulos siguen en el buscador), pero **esta pasada no pudo releerlas**. Los tres pilares que aquí se les atribuyen —corte a primero de mes, el día siguiente al cuadre, y «sólo las facturas impagas antes del corte»— descansan hoy sobre una verificación que no se pudo repetir. Quien los use como argumento en una discusión de criterio debería reabrirlos con navegador, no con fetch.

**La contrapartida de apertura tiene nombre — y el nuestro no es 3200 siempre.** QuickBooks Online usa [Opening Balance Equity](https://quickbooks.intuit.com/learn-support/en-us/help-article/bank-deposits/enter-opening-balance-account-quickbooks-online/L7NcxTbuu_US_en_US) como contrapartida automática de cada saldo de apertura. *(Corrección: esta página sugería 3200 sin matiz.)* El panel ya tiene `destino_del_resultado_del_ejercicio`, cuyo default `dos_pasos_hasta_asamblea` dice lo contrario: el resultado se cierra a 3300 «Resultado del ejercicio» y sólo una reclasificación auditada posterior lo lleva a 3200, porque la práctica mexicana mantiene el resultado separado hasta que la asamblea resuelva. El desbalance de una apertura **a media anualidad** es, por definición, resultado del ejercicio en curso: mandarlo a 3200 lo funde con los años anteriores el día del alta. **El default correcto es 3300 cuando el corte cae a media anualidad y 3200 sólo cuando el corte es inicio de ejercicio** — y no es una política nueva, es un lector de la que ya existe.

**CxC y CxP se capturan documento a documento, jamás como agregado.** Capturar sólo el total de deudores rompe la aplicación de cobros posteriores: cada pago que llegue después no tiene contra qué aplicarse. De ahí la regla dura de la capa 3.

**Antes de migrar, archivar; después de migrar, comparar.** La [guía de migración de QBO](https://quickbooks.intuit.com/learn-support/en-uk/help-article/migrate-services/comprehensive-guide-dataswitcher/L22WWA0As_GB_en_GB) —releída y más dura de lo que aquí se decía— **nombra** los reportes a guardar («Trial Balance, P&L, VAT summary») y exige que el archivo destino esté «completamente vacío». Su [checklist posterior](https://quickbooks.intuit.com/learn-support/en-uk/help-article/migrate-services/checking-results-conversion-quickbooks-online/L3bbYvyT6_GB_en_GB) ordena revisar lo convertido, conciliar bancos, ligar los documentos abiertos y **revisar utilidades retenidas**, porque el sistema de origen «puede partirlas en dos renglones».

**La corrida en paralelo** —un mes capturado en ambos sistemas, balanzas comparadas— se volvió a buscar en la segunda pasada y sigue sin ser doctrina oficial de nadie. Entra como criterio del despacho, no como candado.

Cada una de estas bifurcaciones va al panel **con su lector**, porque en esta casa una bifurcación de criterio contable no se pregunta ni se decide en caliente: se configura y se audita. Hoy el panel tiene 39 claves y **ninguna empieza por `onboarding.`**; conviene recordar, antes de proponer cinco más, que el panel es también un recurso escaso. Ver [[El-agente-y-sus-limites]] y [[El-tablero-y-los-criterios]].

---

## Lo que falta, ordenado por consecuencia

| | Brecha | Tamaño | Bloqueada por |
|---|---|---|---|
| **A** | La cuenta migrada nace sin agrupador y el despacho lo descubre en el envío mensual: sembrar los 1 066 renglones, consolidar las dos columnas, y que el alta escriba el agrupador. `map match` deja de ser promesa el mismo día | S/M | nada, desde esta pasada |
| **B** | La depreciación acumulada migrada: los dos cerrojos, y la decisión (a) o (b) al panel | M | una decisión de diseño |
| **C** | No hay papel de trabajo: el expediente de migración que sobreviva al año | S | nada |
| **D** | No se deshace una migración: unidad reversable, procedencia en `tags`, reversa y no borrado, negarse cuando ya hay operación encima | M | nada |
| **E** | CxC/CxP: llegaron las tablas, falta `invoice import` / `bill import` y el candado suma-por-control | M/L | nada |
| **F** | Nómina y provisiones a media anualidad: no hay acumulados por empleado (gravado/exento, ISR, subsidio, IMSS, INFONAVIT). QBO sólo los acepta **antes del primer cheque**, y esa ventana que se cierra es el diseño correcto a copiar | L | alcance |
| **G** | Cuarenta clientes es un problema de lote y no hay lote: manifiesto, corrida en seco, informe agregado, reanudación | M | nada |
| **H** | La cuenta puente contradice el criterio que la casa ya eligió (3300 vs 3200) | S | nada |
| **I** | La apertura pierde la moneda de origen: `DraftLine` necesita las cuatro columnas que `JournalEntryLineInput` ya acepta | S | nada |
| **J** | La puerta de reconstrucción (descarga masiva) sigue sin existir; simulado primero, con cerrojo fuera de sandbox como los PAC | L | la e.firma y su bóveda |

Y lo que un despacho echaría de menos aunque A–J estuvieran hechas: la migración de **inventarios** con su costeo, que ninguna pasada ha tocado; y el **cierre del ciclo** — que la balanza que este sistema produzca al mes siguiente del corte sea la que el cliente le envía al SAT, porque una migración que no termina en un envío aceptado no terminó.

---

## Qué se corrigió en esta pasada

- **El Anexo 24 vigente ya no es inverificable**: está en `www.sat.gob.mx`, es el de la RMF 2026 (DOF 13-ene-2026) y trae el c_CodAgrup entero, 1 066 renglones. Antes esta página decía que sólo se pudo verificar el DOF de 2015.
- **La numeración de las secciones está mal en la versión anterior**: el código agrupador ya no es «la sección B» sino una subsección de la A; la B es la balanza.
- **`xml-sat` y `csv-balanza` no son adaptadores nuevos del registry**: son `chart import` y la familia `opening-balance`, reservadas desde antes en el catálogo de comandos.
- **La cuenta puente no es 3200 siempre**: 3300 a media anualidad, 3200 en inicio de ejercicio, por coherencia con `destino_del_resultado_del_ejercicio`.
- **Las fuentes de Xero no se pudieron releer**: la doctrina que esta página les atribuye queda marcada como verificada una sola vez, no dos.
- **Y se añadió lo que la versión anterior no miraba**: el alta escribe siete columnas de veintiocho, la depreciación acumulada no se puede migrar, deshacer no funciona, la apertura pierde la moneda y el diff no se escribe en ninguna parte.

---

## Para seguir

- [[Puesta-en-marcha]] — el asistente `init` y su sección de importación, que es lo que hoy sí corre.
- [[Fiscal-mexicano]] — el espejo CFDI y el agrupador SAT en su contexto fiscal.
- [[Conectores-PAC]] — la otra frontera con el SAT: el timbrado.
- [[El-agente-y-sus-limites]] — por qué `onboard` es `agent: false` y todo desemboca en borradores.
- [[El-tablero-y-los-criterios]] — el panel donde viven las bifurcaciones de criterio.
- [[Hoja-de-ruta]] — dónde caen A–J.
- [[Glosario]] — balanza de comprobación, código agrupador, CFDI, e.firma.
