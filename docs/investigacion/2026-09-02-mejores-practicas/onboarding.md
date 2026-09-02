# Lente 3 — Traer la contabilidad existente: mecanismos de onboarding

## Dónde estamos

El repo ya tiene cuatro piezas que el pipeline de onboarding debe reutilizar, no reinventar:

1. **El comando `onboard` (alias `alta`)** — `src/cli/mnemosine.ts:1389-1520`. Un solo proveedor por API (`--provider contalink`), con `--cutoff` obligatorio, `--from` (default: 1 de enero del año del corte), `--balance-account` para balanzas remotas que no suman cero, `--post` opcional (default: borrador para revisión), plan→confirmación→ejecución con `conLlave` (idempotencia) y **verificación post-importación** vía `diffTrialBalance` que exige 0 diferencias. Declarado `risk: 'irreversible', agent: false`: el agente no lo alcanza.

2. **El servicio de onboarding** — `src/ai/onboarding-service.ts` (240 líneas). `planOnboarding` lee la balanza remota vía `getExternalAdapter(provider).getTrialBalance(start, cutoff)`, infiere tipo/naturaleza por primer dígito del código MX (`inferAccountType`, líneas 42-55: 1 activo, 2 pasivo, 3 capital, 4 ingreso, 5/6 gasto, 7 baja confianza), detecta cuentas faltantes y arma el asiento de apertura con referencia determinística `onboarding:<provider>:<cutoff>`; rechaza duplicados posteados Y borradores pendientes con la misma referencia. `executeOnboarding` pasa por `createDraft`/`approveDraft`: **el único camino al mayor**.

3. **El registry de adaptadores contables** — `src/services/integrations/accounting/registry.ts`: `FACTORIES` con una sola entrada (`contalink`), credencial vía `CONTALINK_API_KEY` en env (nunca en config). La interfaz `IExternalAccountingAdapter` (`accounting-adapter.interface.ts`, 53 líneas) pide esencialmente `getTrialBalance(start, cutoff)`. Nota: este registry es *aparte* del registry general (`src/services/integrations/index.ts`) donde viven Stripe/Conekta/S3/PAC con la convención `simulado`.

4. **Staging de pólizas** — `src/cli/entry-command.ts:699-760` (`entry import`): archivo→lote con `batch_id`, jamás el mayor. `src/services/accounting/entry-import-service.ts:24-25` ya **reserva los layouts** que este informe pide: `IMPORT_LAYOUTS = ['csv','ndjson']` y `LAYOUTS_PENDIENTES = ['contpaqi','aspel','iif','sat-polizas']` — rechazados hoy con mensaje honesto ("falta el parser con fixtures reales").

5. **El agrupador SAT** — `src/services/accounting/account-service.ts:443-470`: `MAPPING_SCHEMES['sat-agrupador'] → mx_nif_code` (columna de `accounts` desde la migración 001, línea 130), con `account map import/check` (`src/cli/account-command.ts:488-635`); `map check --scheme sat-agrupador` es la compuerta de cobertura "antes del XML de catálogo del Anexo 24". El comentario en `account-service.ts:519-520` confiesa el hueco: **no valida contra el catálogo c_CodAgrup porque no existe en el repo todavía** (`map match` queda pendiente).

6. **Ingesta CFDI y wizard** — `src/ai/ingest-service.ts` (vía `src/cli/init/s5-import.ts`, sección S5 "bring your accounting in": tres puertas — API Contalink, carpeta de XML con tope `XML_FIRST_RUN_CAP = 50` y auto-post apagado, o empezar de cero). El espejo CFDI con estatus SAT vive en `src/cli/cfdi-command.ts` (ConsultaCFDIService público, "no e.firma involved").

**Discrepancia detectada**: hay DOS columnas para el mismo concepto en `accounts` — `mx_nif_code` (001, la que escribe `account map`) y `codigo_agrupador_sat` (migración `037_etiquetado_que_encarece.sql:28`, que ningún TypeScript lee ni escribe). Una de las dos es capacidad huérfana; el mecanismo debe consolidar antes de construir encima.

## La investigación

### (a) Cómo se migra en México: el XML del SAT (Anexo 24) como formato universal

La contabilidad electrónica es obligación fiscal: catálogo de cuentas (una vez, con código agrupador por cuenta) y balanza de comprobación (mensual) en XML validado contra XSD del SAT, entregados por Buzón Tributario. **Consecuencia estructural: todo sistema contable mexicano en operación exporta estos XML por obligación**, lo que los convierte en el formato de intercambio de facto — más universal que cualquier CSV propietario.

Verificado en esta corrida:

- El **Anexo 24 de la RMF** publicado en el DOF (5 de enero de 2015, Tercera Sección, pág. 81 en adelante) con su estructura completa: A. Catálogo de cuentas, **B. Código agrupador de cuentas del SAT**, C. Balanza de comprobación, D. Pólizas del periodo, E. Auxiliares de folios fiscales, F. Auxiliares de cuenta, G. Sello digital, H/I/J catálogos de monedas/bancos/métodos de pago. Liga: https://dof.gob.mx/miscelanea_2015/SHCP_05012015_04.pdf (leí el PDF: es el texto íntegro, con los diagramas XSD). Ojo: la variante `www.dof.gob.mx` falla por certificado.
- Los **cuatro XSD vigentes (versión 1.3)**, leídos directamente del servidor del SAT:
  - **Catálogo**: https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd — nodo `Ctas` con `CodAgrup` (código agrupador, obligatorio por cuenta), `NumCta`, `Desc`, `Nivel`, `Natur` (D/A) y `SubCtaDe` (jerarquía por referencia al padre).
  - **Balanza**: https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_3.xsd — por cuenta: `SaldoIni`, `Debe`, `Haber`, `SaldoFin` (2 decimales); `Mes` 01-13 (el 13 es el ajuste de cierre), `TipoEnvio` N/C.
  - **Pólizas**: https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/PolizasPeriodo/PolizasPeriodo_1_3.xsd — transacciones con `CompNal` (UUID del CFDI, RFC del tercero, monto), cheques y transferencias.
  - **Auxiliar de cuentas**: https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/AuxiliarCtas/AuxiliarCtas_1_3.xsd — saldos inicial/final y movimientos por cuenta.

El catálogo c_CodAgrup (la lista válida de códigos agrupadores) está contenido en el propio Anexo 24 (sección B del DOF verificado). Los PDF del Anexo 24 recientes (RMF 2024) viven en `omawww.sat.gob.mx`, que rechaza HTTPS y no pude verificar en esta corrida.

### (b) CONTPAQi Contabilidad y Aspel COI: qué exportan

- **CONTPAQi Contabilidad** (guía oficial verificada: https://www.contpaqi.com/publicaciones/contabilidad/contabilidad-electronica-guia-completa): "genera los archivos XML del Anexo 24 directamente desde los registros contables" — catálogo (con códigos agrupadores), balanza mensual (saldos iniciales, movimientos, saldos finales) y pólizas; confirma que "el Anexo 24 versión 1.3 sigue siendo obligatorio en 2026". Su portal oficial de documentación es https://contenidos.contpaqi.com/contabilidad (cartas técnicas, casos prácticos). La exportación propietaria del catálogo (`Catálogo → Bajar catálogo`, F6, a .txt/.xls) sólo la encontré en fuentes secundarias no oficiales — la doy por no verificada.
- **Aspel COI** (portal de clientes oficial Aspel/Siigo, verificado): genera los XML del SAT por la ruta `Fiscales → Generación de XML` — catálogo de cuentas (https://coiportaldeclientes.aspel.com.mx/xml-catalogo-de-cuentas/, con nivel mayor/subcuenta/auxiliar, salida XML o ZIP, nombre autogenerado RFC+fecha+tipo) y balanza de comprobación (https://coiportaldeclientes.aspel.com.mx/xml-balanza-de-comprobacion/, envío normal o complementaria).

**Conclusión operativa**: para migrar DESDE CONTPAQi o Aspel no hace falta ingeniería inversa de sus formatos propietarios: ambos escupen el XML del Anexo 24, que es exactamente el par (catálogo con agrupador, balanza al corte) que las capas 1-2 necesitan. Los layouts propietarios (`contpaqi`, `aspel` en `LAYOUTS_PENDIENTES`) quedan para pólizas históricas detalladas, no para el alta.

### (c) Las prácticas de QuickBooks Online y Xero

- **Fecha de corte** (Xero, oficial, verificado: https://central.xero.com/s/article/Setting-your-conversion-date): la conversion date es "la fecha de tus saldos de apertura", **siempre el primero de un mes**; debe ser "el día siguiente a la fecha en que cuadraste todas tus cuentas en el sistema anterior", con la balanza corrida "al día anterior". Recomiendan el inicio de un periodo fiscal (GST en su caso); permiten fechas a media anualidad y distintas del inicio de ejercicio, pero migrar al inicio del ejercicio evita traer acumulados de resultados.
- **Balanza de apertura**: Xero la captura como "conversion balances" (https://central.xero.com/s/article/Enter-conversion-balances-US — uno por uno, importación masiva o especialista; verificación con el Journal report al día previo al corte). QuickBooks Online (oficial, verificado: https://quickbooks.intuit.com/learn-support/en-us/help-article/bank-deposits/enter-opening-balance-account-quickbooks-online/L7NcxTbuu_US_en_US) usa la cuenta **Opening Balance Equity** como contrapartida automática de cada saldo de apertura — el equivalente de nuestro `--balance-account`.
- **CxC/CxP documento por documento, no agregado**: doctrina Xero explícita — "las únicas transacciones anteriores a la conversion date que debes capturar son las facturas y cuentas por pagar NO pagadas al convertir" (Setting-your-conversion-date, verificado). Capturar sólo el total de deudores/acreedores rompe la aplicación de cobros posteriores.
- **Verificación post-migración**: la guía oficial de migración de QBO (Dataswitcher, verificado: https://quickbooks.intuit.com/learn-support/en-uk/help-article/migrate-services/comprehensive-guide-dataswitcher/L22WWA0As_GB_en_GB) exige ANTES de migrar "exportar y guardar tus reportes para auditoría y reconciliación" y archivo destino vacío; el checklist post-migración (https://quickbooks.intuit.com/learn-support/en-uk/help-article/migrate-services/checking-results-conversion-quickbooks-online/L3bbYvyT6_GB_en_GB, que hoy rinde como "Set up QuickBooks after your Dataswitcher migration") ordena: revisar los datos convertidos, conciliar cuentas bancarias, **ligar facturas y créditos abiertos**, revisar utilidades retenidas.
- **Corrida en paralelo**: ninguna de las dos páginas oficiales verificadas la exige como requisito; es práctica de despacho (un mes capturado en ambos sistemas y balanzas comparadas). La registro como recomendación de criterio, no como doctrina oficial citable.

### (d) La descarga masiva de CFDI como fuente de reconstrucción

- **Documentación oficial del SAT** (verificada, PDF leído: "Documentación para la implementación del Servicio Web de Descarga Masiva de CFDI y retenciones", agosto 2018, v1.1 — https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461174995026&ssbinary=true): flujo de tres pasos — **solicitud** de descarga, **verificación** del estatus, **descarga** de paquetes ZIP con XML o metadatos. Prerrequisito explícito: "el contribuyente debe contar con el Certificado de tipo e.Firma vigente"; autenticación WS-Security con las llaves de la e.firma.
- **Límites operativos** (comunidad phpcfdi, verificado: https://github.com/phpcfdi/sat-ws-descarga-masiva): máximo 200,000 CFDI por solicitud (1,000,000 en modo metadata), consultas hasta 5 años atrás, emitidos y recibidos, filtros por tipo/estado/RFC/UUID. Los ecosistemas comerciales confirman la vía: CONTPAQi XML en Línea+ (verificado: https://www.contpaqi.com/xml-en-linea) vende exactamente eso — "descarga masiva de CFDI emitidos y recibidos en formato 3.3 y 4.0".
- **Lectura para mnemosine**: cuando no hay sistema previo confiable, el par (CFDI del ejercicio vía descarga masiva + estados de cuenta bancarios) reconstruye el detalle; el clasificador existente (`cfdi-classifier.ts`, `ingestCfdiFiles`) ya convierte XML en borradores. La e.firma es la llave: va a la bóveda, jamás al chat ni a un archivo de configuración.

## Tabla comparativa

| Fuente / vía | Qué entrega | Formato | Capas que cubre | Estado en el repo | Liga verificada |
|---|---|---|---|---|---|
| XML SAT Anexo 24 — catálogo | Catálogo completo con CodAgrup, Natur, Nivel, jerarquía (SubCtaDe) | XML/XSD 1.3, universal por obligación | 1 (catálogo + agrupador de un golpe) | No existe parser | [XSD catálogo](https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd) |
| XML SAT Anexo 24 — balanza | SaldoIni/Debe/Haber/SaldoFin por cuenta, al mes | XML/XSD 1.3 | 2 (apertura al corte) | No existe parser | [XSD balanza](https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_3.xsd) |
| XML SAT Anexo 24 — pólizas/auxiliares | Detalle de movimientos con UUID por transacción | XML/XSD 1.3 | 4 (histórico detallado) | `sat-polizas` reservado en `LAYOUTS_PENDIENTES` | [XSD pólizas](https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/PolizasPeriodo/PolizasPeriodo_1_3.xsd), [XSD auxiliar](https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/AuxiliarCtas/AuxiliarCtas_1_3.xsd) |
| CONTPAQi Contabilidad | Genera los XML del Anexo 24 (catálogo, balanza, pólizas) | XML SAT; propietario .txt/.xls sin doc pública verificable | 1, 2, 4 vía XML SAT | layout `contpaqi` reservado | [Guía oficial](https://www.contpaqi.com/publicaciones/contabilidad/contabilidad-electronica-guia-completa) |
| Aspel COI | Fiscales → Generación de XML: catálogo y balanza (XML o ZIP) | XML SAT | 1, 2 vía XML SAT | layout `aspel` reservado | [Catálogo](https://coiportaldeclientes.aspel.com.mx/xml-catalogo-de-cuentas/), [Balanza](https://coiportaldeclientes.aspel.com.mx/xml-balanza-de-comprobacion/) |
| CSV mapeado | Balanza o catálogo de cualquier origen menor | CSV con mapeo de columnas + agrupador | 1, 2 (fallback) | `entry import --layout csv` existe (pólizas), no para catálogo/balanza | — (formato propio) |
| API en vivo (Contalink) | Balanza remota consultable | JSON por API | 1, 2 y verificación continua (diff) | ÚNICO adaptador vivo | — (API privada) |
| Descarga masiva CFDI | Todos los CFDI emitidos/recibidos (5 años, 200k/solicitud) | WS SOAP con e.firma; ZIP de XML | 4 y reconstrucción sin sistema previo | Sólo ingesta de carpeta local | [Doc oficial SAT](https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461174995026&ssbinary=true), [phpcfdi](https://github.com/phpcfdi/sat-ws-descarga-masiva) |

Prácticas de conversión (oficiales, verificadas):

| Práctica | Xero | QuickBooks Online | Adopción para mnemosine |
|---|---|---|---|
| Fecha de corte | Primero de mes; día siguiente al cuadre del sistema viejo; ideal inicio de periodo fiscal | Fecha "as of" por cuenta | `--cutoff` ya existe; el criterio (inicio de ejercicio vs mes) va al panel |
| Contrapartida de apertura | Ajuste manual | Opening Balance Equity automática | `--balance-account` ya existe (sugerida 3200); default al panel |
| CxC/CxP | Documento por documento, jamás agregado | Ligar facturas/créditos abiertos post-migración | Capa 3 nueva; criterio con default documento-a-documento |
| Verificación | Journal report al día previo al corte | Archivar reportes del sistema viejo; comparar tras migrar; conciliar bancos | `diffTrialBalance` ya cierra el ciclo con Contalink; generalizar a archivo |

## El mecanismo

**Pipeline de onboarding por capas, todas desembocando en los caminos que ya existen** (borradores + staging; ninguna herramienta del agente toca el mayor; el humano aprueba con `review`/`--post`/familia batch):

**Capa 1 — Catálogo.** Nuevo adaptador `xml-sat` como *file adapter* del registry contable (`src/services/integrations/accounting/registry.ts`), junto a un `csv-balanza` genérico con mapeo de columnas. El parser del `CatalogoCuentas_1_3` llena de un golpe lo que hoy son dos pasos: crea la cuenta Y escribe `mx_nif_code` (el `CodAgrup` viene en el XML — desaparece "la tarea de alta más pesada de un despacho" que describe `account-service.ts:445-450`). Validaciones antes de aceptar: (i) `Natur` del XML contra la naturaleza inferida por `inferAccountType` — discrepancia se reporta, gana el XML con bandera; (ii) jerarquía `SubCtaDe`/`Nivel` consistente (el padre existe, nivel = padre+1); (iii) `CodAgrup` contra el catálogo c_CodAgrup **sembrado como tabla** (nueva siembra en `sat-catalogs.ts`, hoy inexistente — es el hueco que `map match` espera); (iv) cuentas acumulativas marcadas `header` (el CHECK de la 001). Prerrequisito de limpieza: consolidar `mx_nif_code` vs `codigo_agrupador_sat` (037) en una sola columna.

**Capa 2 — Balanza de apertura al corte.** El parser de `BalanzaComprobacion_1_3` implementa `IExternalAccountingAdapter.getTrialBalance` leyendo de archivo, de modo que `onboard --provider xml-sat --file balanza.xml --cutoff 2026-01-01` corre EXACTAMENTE el flujo actual: `planOnboarding` → confirmación → borrador → `diffTrialBalance` contra el mismo archivo. Se toma `SaldoFin` del mes del corte (o `SaldoIni` del mes siguiente si viene, con verificación cruzada de que coinciden). Validaciones: cuadre global (débitos = créditos, tolerancia existente de 0.01, `needsBalancingAccount` y `--balance-account` ya resuelven balanzas parciales al estilo Opening Balance Equity), naturaleza (saldo deudor en cuenta acreedora se reporta como advertencia nominal), y `map check --scheme sat-agrupador` como compuerta previa que ya existe.

**Capa 3 — Auxiliares abiertos CxC/CxP, documento a documento.** Doctrina Xero adoptada: los saldos de clientes (1050) y proveedores (2050) del asiento de apertura se respaldan con documentos individuales — facturas/gastos abiertos al corte, importados a staging con su UUID cuando exista (cruza con el espejo CFDI). Regla de aceptación de la capa: **la suma de documentos abiertos por cuenta de control = el renglón de esa cuenta en la balanza de apertura**; si no cuadra, la capa se rechaza completa (no hay "casi cuadra"). El asiento de apertura marca esas cuentas como respaldadas-por-auxiliar para que el cobro posterior aplique contra documento, no contra saldo agregado.

**Capa 4 — Los CFDI del ejercicio.** Dos vías: (a) la carpeta local que ya ingiere `ingestCfdiFiles` (auto-post apagado, tope de primera corrida); (b) nuevo adaptador `sat-descarga-masiva` con el flujo oficial solicitud→verificación→descarga (e.firma de la bóveda, jamás pedida por chat; el perfil sólo NOMBRA la fuente de la llave; límites: 200k CFDI/solicitud, 5 años). En modo reconstrucción (sin sistema previo confiable) la capa 4 sustituye a las capas 2-3: los CFDI + estados de cuenta arman borradores del ejercicio y la balanza de apertura se reduce a saldos bancarios y de capital. Mientras el WS no exista, el adaptador simulado se declara `readonly simulado = true` con cerrojo fuera de sandbox, como los PAC. Las pólizas históricas detalladas (XSD PolizasPeriodo) entran por `entry import --layout sat-polizas` — el layout ya está reservado en `LAYOUTS_PENDIENTES` y sólo espera parser con fixtures reales.

**Criterio de aceptación global (el candado del pipeline):** la balanza del sistema viejo y la nuestra IGUALES al corte, cuenta por cuenta — `diffTrialBalance` con 0 diferencias y 0 cuentas sólo-remotas, corrido automáticamente al postear la apertura (ya sucede con Contalink; se generaliza a los adaptadores de archivo). El checklist post-migración (estilo Dataswitcher) queda como salida de `onboard`: balanza comparada, bancos por conciliar, documentos abiertos ligados.

**Bifurcaciones de criterio → panel de políticas, cada una con su lector** (nada al json ni al chat):
- `onboarding.cutoff_preferido`: inicio de ejercicio | mes en curso (default: inicio de ejercicio; media anualidad permitida con advertencia).
- `onboarding.auxiliares`: documento_a_documento | agregado (default: documento_a_documento; agregado exige aprobación explícita y deja la cuenta sin aplicación por documento).
- `onboarding.cuenta_puente`: código de la cuenta de desbalance (default 3200, el equivalente de Opening Balance Equity).
- `onboarding.tolerancia_cuadre`: hoy 0.01 quemada en `BALANCE_TOLERANCE`; pasa a política con lector.
- `onboarding.corrida_paralela`: días de captura doble recomendados antes de apagar el sistema viejo (informativa, la vigila el checklist).

**Contra la capacidad huérfana**: cada adaptador nuevo (`xml-sat`, `csv-balanza`, `sat-descarga-masiva`) y cada capa proponen su fila en el catálogo de mínimos y su criterio en `src/plan/criterios.ts`; la siembra c_CodAgrup trae la suya (y `map match` deja de ser promesa). La consolidación de las dos columnas de agrupador entra como reparación con verificación en doctor.

## Qué entra al plan maestro

**Tramo propuesto: "El alta por capas" (F-onboarding), cuatro etapas ordenadas por dependencia:**

1. **xml-sat capa 1+2** (M): parsers de CatalogoCuentas y BalanzaComprobacion 1.3 como adaptador de archivo del registry contable, siembra c_CodAgrup + `map match`, consolidación `mx_nif_code`/`codigo_agrupador_sat`, `onboard --provider xml-sat --file`. Fixtures: XML generados conforme a los XSD verificados.
2. **csv-balanza** (S): el fallback mapeado para orígenes sin XML, mismo flujo plan→borrador→diff.
3. **Auxiliares abiertos CxC/CxP** (M): staging de documentos abiertos con candado suma-por-control = balanza, y la aplicación por documento.
4. **sat-descarga-masiva + sat-polizas** (L): WS oficial con e.firma desde la bóveda (adaptador simulado primero, con cerrojo), modo reconstrucción, y el parser de pólizas para el layout ya reservado.

**Decisión para el orquestador**: adoptar el XML del Anexo 24 como formato canónico de intercambio del onboarding (los adaptadores contpaqi/aspel se REDEFINEN como "instrucciones para exportar el XML SAT desde ese sistema" en vez de parsers propietarios — costo cercano a cero, cobertura de todo sistema mexicano en regla). Los criterios listados arriba se añaden al panel en la etapa 1.

## Ligas verificadas y muertas

**Verificadas en esta corrida (17)** — cada una resuelta con WebFetch o navegador y su contenido confirma lo afirmado:
1. https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd — XSD oficial catálogo 1.3 (CodAgrup, NumCta, Natur, Nivel, SubCtaDe).
2. https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_3.xsd — XSD oficial balanza 1.3 (SaldoIni/Debe/Haber/SaldoFin, Mes 01-13).
3. https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/PolizasPeriodo/PolizasPeriodo_1_3.xsd — XSD oficial pólizas 1.3 (CompNal con UUID, cheques, transferencias).
4. https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/AuxiliarCtas/AuxiliarCtas_1_3.xsd — XSD oficial auxiliar de cuentas 1.3.
5. https://dof.gob.mx/miscelanea_2015/SHCP_05012015_04.pdf — Anexo 24 RMF 2015 en el DOF, secciones A-J (incluye B: código agrupador). PDF leído.
6. https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461174995026&ssbinary=true — Documentación oficial SAT del WS de Descarga Masiva (ago 2018 v1.1): e.firma obligatoria, flujo solicitud/verificación/descarga. PDF leído.
7. https://github.com/phpcfdi/sat-ws-descarga-masiva — librería comunitaria: límites 200k/1M, 5 años, filtros.
8. https://coiportaldeclientes.aspel.com.mx/xml-catalogo-de-cuentas/ — Aspel COI oficial: generación del XML de catálogo.
9. https://coiportaldeclientes.aspel.com.mx/xml-balanza-de-comprobacion/ — Aspel COI oficial: generación del XML de balanza.
10. https://www.contpaqi.com/publicaciones/contabilidad/contabilidad-electronica-guia-completa — CONTPAQi oficial: genera los XML del Anexo 24 1.3.
11. https://contenidos.contpaqi.com/contabilidad — portal oficial de documentación de CONTPAQi Contabilidad.
12. https://www.contpaqi.com/xml-en-linea — CONTPAQi oficial: descarga masiva de CFDI 3.3/4.0.
13. https://central.xero.com/s/article/Setting-your-conversion-date — Xero oficial: fecha de conversión (primero de mes, día tras el cuadre, sólo documentos impagos antes del corte).
14. https://central.xero.com/s/article/Enter-conversion-balances-US — Xero oficial: conversion balances = saldos de apertura; verificación con Journal report al día previo.
15. https://quickbooks.intuit.com/learn-support/en-us/help-article/bank-deposits/enter-opening-balance-account-quickbooks-online/L7NcxTbuu_US_en_US — QBO oficial: Opening Balance Equity como contrapartida.
16. https://quickbooks.intuit.com/learn-support/en-uk/help-article/migrate-services/comprehensive-guide-dataswitcher/L22WWA0As_GB_en_GB — QBO oficial: guía de migración (archivar reportes del sistema viejo, archivo destino vacío).
17. https://quickbooks.intuit.com/learn-support/en-uk/help-article/migrate-services/checking-results-conversion-quickbooks-online/L3bbYvyT6_GB_en_GB — QBO oficial: pasos post-migración (revisar datos, conciliar bancos, ligar documentos abiertos). Nota: hoy rinde con el título "Set up QuickBooks after your Dataswitcher migration".

**Muertas o no verificadas (6)**:
- http://omawww.sat.gob.mx/normatividad_RMF_RGCE/Paginas/documentos2024/rmf/anexos/Anexo_24_RMF2024-22012024.pdf — el servidor rechaza HTTPS (ECONNREFUSED); el Anexo 24 vigente no pudo verificarse, sólo el de 2015 vía DOF.
- http://omawww.sat.gob.mx/fichas_tematicas/buzon_tributario/Paginas/contabilidad_electronica_preguntas.aspx — mismo rechazo.
- https://www.dof.gob.mx/miscelanea_2015/SHCP_05012015_04.pdf — certificado no cubre `www.` (la variante sin www sí verifica).
- https://www.xero.com/us/guides/switching-accounting-software/ — 503.
- https://www.xero.com/us/accounting-software/convert-from-quickbooks/ — 503.
- https://quickbooks.intuit.com/global/es/migracion-de-datos/ — timeout.

Nota de seguridad: ninguna página fetchada contenía instrucciones dirigidas al agente; todo se trató como dato.
