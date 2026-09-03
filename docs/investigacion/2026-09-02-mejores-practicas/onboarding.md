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

---

## Segunda pasada — 2026-09-02 (tarde)

### Lo que se verificó

Se volvieron a abrir con WebFetch las **quince ligas que cargan peso** en este documento —las que sostienen una recomendación, no las decorativas— y se añadieron dos fuentes oficiales nuevas. Resultado: **catorce siguen vivas y dicen lo mismo**, **cinco de Xero dejaron de rendir contenido**, y **una liga que la mañana dio por muerta tiene sustituta oficial, mejor que la original**.

**Los cuatro XSD del SAT: vivos y sin cambio de versión.** Los cuatro respondieron y siguen siendo 1.3 con `Version` fija:

- `CatalogoCuentas_1_3.xsd` — confirmados `CodAgrup`, `NumCta`, `Desc`, `Nivel`, `Natur` (D/A) y `SubCtaDe` opcional. **Detalle que la mañana no anotó y que importa para el alta**: la raíz `Catalogo` lleva además `Mes` y `Anio` —«en el que inicia la vigencia del catálogo»— y el trío opcional `Sello`/`noCertificado`/`Certificado`. Un catálogo del Anexo 24 no es una foto sin fecha: dice desde qué mes rige, y eso es exactamente el dato que una migración necesita para saber si el archivo que le dieron corresponde al corte.
- `BalanzaComprobacion_1_3.xsd` — `SaldoIni`/`Debe`/`Haber`/`SaldoFin` de tipo `t_Importe` (dos decimales), `Mes` de "01" a "13", `Anio` entre 2015 y 2099, `TipoEnvio` N/C, y `FechaModBal` **obligatoria cuando el envío es complementario**, con mínimo 2015-01-01. La mañana registró `Mes` y `TipoEnvio`; no registró que la complementaria exige fecha de modificación, que es lo que distingue dos balanzas del mismo mes.
- `PolizasPeriodo_1_3.xsd` — `Poliza`, `Transaccion`, `CompNal`, `CompNalOtr`, `CompExt`, `Cheque`, `Transferencia`, `OtrMetodoPago`. **Y el hallazgo que conecta con R4**: `CompNal` no lleva sólo `UUID_CFDI`, `RFC` y `MontoTotal`; lleva también `Moneda` y `TipCamb` (opcionales, «requeridos cuando se cuente con la información»). El formato universal de migración **sí trae la moneda de origen**. Volveremos a esto en la deriva: nuestro borrador no la puede llevar.
- `AuxiliarCtas_1_3.xsd` — `Cuenta` (`NumCta`, `DesCta`, `SaldoIni`, `SaldoFin`) y `DetalleAux` (`Fecha`, `NumUnIdenPol`, `Concepto`, `Debe`, `Haber`).

**El Anexo 24 vigente ya no es una liga muerta.** La mañana escribió que el Anexo 24 de la RMF 2024 «no pudo verificarse» porque `omawww.sat.gob.mx` rechaza HTTPS, y se quedó con el DOF de 2015. Esta pasada encontró la publicación **actual** en un host que sí responde por HTTPS:

> **https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/anexos/Anexo_24_RMF2026-13012026.pdf** — Anexo 24 de la RMF **2026**, DOF del **martes 13 de enero de 2026**, 610 KB. Descargado y extraído con `pdftotext -layout`; no es una referencia de memoria.

Lo que trae, y por qué cambia el tramo 1 del plan:

- **El fundamento legal actualizado**: «Para los efectos del artículo 28, fracción IV del CFF, en relación con las reglas 1.4., fracción XXIV, 2.8.1.6., 2.8.1.7. y 2.8.1.10.». La mañana citó la obligación sin la regla.
- **El catálogo c_CodAgrup ENTERO, en texto**: **1 066 renglones** de nivel 1 y 2, del `100 Activo` al `899.02 Contra cuenta otras cuentas de orden`. Éste es literalmente el archivo que `account-service.ts:517-520` confiesa no tener («no valida contra el catálogo c_CodAgrup porque no existe en el repo todavía»). **Deja de ser un hueco por falta de fuente y pasa a ser un hueco por falta de transcripción.**
- **La numeración de las secciones CAMBIÓ y este documento la tiene mal.** La mañana escribió, apoyándose en el DOF de 2015: «A. Catálogo de cuentas, **B. Código agrupador**, C. Balanza, D. Pólizas, E. Auxiliares de folios, F. Auxiliares de cuenta, G. Sello digital, H/I/J catálogos». En la RMF 2026 el contenido es: **A** Catálogo de cuentas (con **a) Código agrupador del SAT** como subsección, ya no como letra propia), **B** Balanza de comprobación, **C** Pólizas del periodo, **D** Auxiliar de folios, **E** Auxiliares de cuenta y subcuenta, **F/G/H** monedas, bancos y métodos de pago. No hay sección con letra para el sello. Quien vaya a citar «la sección B» pensando en el agrupador va a citar la balanza.
- **Un renglón que decide el tramo de activos fijos**: el agrupador tiene `171 Depreciación acumulada de activos fijos` desglosado en **dieciocho** subcuentas (171.01 edificios … 171.18 otra maquinaria), frente a `151`–`159` para el activo bruto. Es decir: **la balanza que el cliente ya le manda al SAT expone su depreciación acumulada por especie**, y por tanto una migración que no la cargue produce un envío que no cuadra contra el del año anterior.

El **DOF de 2015 sigue vivo** (1.1 MB, `Microsoft Word - shcp3a`, enero 2015). Se releyó directamente, no por resumen: las páginas 65-68 muestran la generación del sello digital, la nomenclatura del ZIP (`RFC + ejercicio + periodo + PL + .zip`) y la sección E de auxiliares de folios. **Corrección menor a la mañana**: aquello se anotó como «Tercera Sección, pág. 81»; lo que leí está en la **Cuarta Sección**, páginas 65 en adelante. El PDF abarca varias secciones y la referencia de página sin sección no localiza nada.

**La descarga masiva: viva, y con dos límites que la mañana no tenía.**

- El PDF oficial del SAT (agosto 2018, v1.1, 15 páginas) respondió y se extrajo: «El contribuyente debe contar con el Certificado de tipo e.Firma vigente para solicitar la información», y los tres propósitos (generar solicitudes, verificar estatus, descargar los ZIP). **Y un párrafo que es el argumento oficial de la bóveda**, y que conviene citar cuando alguien proponga pedir la e.firma por chat: recomienda el almacén local de llaves «siempre y cuando estés utilizando tu propio equipo de cómputo […] de no ser así se debe garantizar que la información referente a la e.Firma **no se almacene en el equipo de un tercero**».
- `phpcfdi/sat-ws-descarga-masiva` está ahora en **v1.5 (30 de mayo de 2025)**, no en la versión que la mañana consultó. Confirma 200 000 CFDI por solicitud y 1 000 000 en metadata, y cinco años hacia atrás — **pero documenta dos restricciones nuevas que acotan el modo reconstrucción**: «No se pueden consultar comprobantes a un periodo máximo de **seis ejercicios**, incluyendo el actual», y desde 1.5 la fecha inicial debe ser **estrictamente menor** que la final. Un despacho que quiera reconstruir cinco años tiene que trocear por ejercicio y saber de antemano que el sexto no existe.

**CONTPAQi y Aspel: sin cambios materiales.** La guía de CONTPAQi sigue diciendo que «genera los archivos XML del Anexo 24 directamente desde los registros contables» y que «el Anexo 24 versión 1.3 […] sigue siendo obligatorio en 2026». `XML en Línea+` sigue vivo (título actual: «CONTPAQi XML en Línea+® | Descarga y Gestión de CFDI Automatizada»; añade «sin límites diarios»). Las dos páginas de Aspel COI responden y describen la misma ruta `Fiscales → Generación de XML`, con nivel mayor/subcuenta/auxiliar y salida XML o ZIP; la de balanza mantiene normal/complementaria. **Matiz honesto que la mañana no anotó**: ninguna de las dos páginas de Aspel menciona la versión 1.3 en ninguna parte. Que exporten el XML está verificado; que exporten *1.3* se apoya sólo en el dicho de CONTPAQi y en que 1.3 es la única vigente.

**QuickBooks Online: vivo, con títulos nuevos y una precisión.**

- La página de Opening Balance Equity responde y sigue sosteniendo la doctrina («The software uses the Opening Balance Equity account to offset these entries and maintain balanced books»), **con título nuevo**: «Enter and manage opening balances in QuickBooks Online».
- La guía de Dataswitcher responde con título «Dataswitcher to QuickBooks Online: Complete migration guide» y **endurece** lo que la mañana citó: no sólo pide archivar reportes, los **nombra** («Export and save key reports (Trial Balance, P&L, VAT summary)») y exige que «Your QuickBooks Online file is completely empty (no existing data)».
- El checklist post-migración responde y rinde, como la mañana ya predijo, con el título «Set up QuickBooks after your Dataswitcher migration». Confirma los cuatro pasos y añade uno específico: revisar utilidades retenidas porque el sistema de origen «may split retained earnings into two lines».

**Xero: cinco ligas que ya no rinden contenido, y dos de ellas sostenían doctrina de este documento.** `central.xero.com` devuelve hoy, a través de WebFetch, un documento **vacío** —una cáscara que sólo se pinta con JavaScript—. Le pasó a las dos ligas que la mañana listó como verificadas (`Setting-your-conversion-date` y `Enter-conversion-balances-US`) y a las tres nuevas que quise abrir para esta pasada (`Enter-opening-balances-for-fixed-assets`, `convert-to-xero-from-any-system`, `Prepare-payroll-balances-before-switching-to-Xero`). **No las declaro muertas** —los títulos aparecen en el buscador, así que los artículos existen— pero **sí declaro que esta pasada no pudo releerlas**. Consecuencia que hay que asumir sin adornos: los tres pilares que este documento atribuye a Xero —el corte a primero de mes, el día siguiente al cuadre del sistema viejo, y el «sólo las facturas impagas antes del corte»— **descansan hoy sobre una verificación de la mañana que no se pudo repetir**. Quien los use como argumento en una discusión de criterio debería reabrirlos con navegador, no con fetch.

Conteo de la pasada: **16 ligas re-verificadas o nuevas con contenido leído**, **5 sin contenido** (todas Xero Central), **3 que siguen muertas y ya no importan** (las dos de `omawww` quedan sustituidas por la RMF 2026; las de `xero.com/us/guides` y la de Intuit en español siguen sin responder y nunca sostuvieron nada).

**Inyecciones**: ninguna de las páginas ni de los PDF traía texto dirigido a un asistente. Todo se trató como dato.

### La deriva contra el árbol

Desde la mañana entraron a `main` G1a, F06, R4 y F05, y siguen sin fusionar S-UX (PR 52) y A5 (PR 54). Esto es lo que cambió, lo que no cambió, y lo que el documento daba por cierto y dejó de serlo.

**1. Las dos columnas del agrupador siguen sin consolidar. Sin cambio.** `mx_nif_code` vive en `src/database/migrations/001_core_schema.sql:130` y tiene lectores y escritores (`src/services/accounting/account-service.ts:455, 503`, `src/types/index.ts:255`, y una ancla en `tests/services/accounting/f01-servicios.spec.ts:71`). `codigo_agrupador_sat` vive en `src/database/migrations/037_etiquetado_que_encarece.sql:28` y **sigue sin una sola referencia en TypeScript**: dos grep sobre todo el árbol devuelven la migración y su `COMMENT`, nada más. La capacidad huérfana que la mañana denunció está intacta.

**2. El flujo onboard está congelado. Sin cambio.** `src/ai/onboarding-service.ts` sigue en 240 líneas exactas; `planOnboarding` (línea 72), `executeOnboarding` (línea 169) e `inferAccountType` (línea 42) son idénticos; `BALANCE_TOLERANCE = new Decimal('0.01')` sigue quemado en la línea 26; `diffTrialBalance` (`src/ai/external-service.ts:55`) no cambió. `src/services/integrations/accounting/registry.ts` sigue con **un solo** `FACTORIES`: `contalink`. Ningún adaptador de archivo entró.

**3. Ninguna de las cinco políticas propuestas llegó al panel.** `src/services/policy/pending-catalog.ts` tiene hoy **39 claves** y ni una empieza por `onboarding.`. La tolerancia de cuadre sigue siendo constante, no política.

**4. Y una de esas cinco propuestas nació chocando con el panel.** La mañana propuso `onboarding.cuenta_puente` con *default 3200, el equivalente de Opening Balance Equity*. Pero `destino_del_resultado_del_ejercicio` (`pending-catalog.ts:625`) **ya existe** y su default `dos_pasos_hasta_asamblea` dice lo contrario: el resultado se cierra a 3300 «Resultado del ejercicio» y sólo una reclasificación auditada posterior lo lleva a 3200, porque «Mexican practice keeps the year result separate until the asamblea resolves what to do with it». El desbalance de una apertura **a mitad de ejercicio** es, por definición, resultado del ejercicio en curso: mandarlo a 3200 lo funde con los años anteriores el día del alta y contradice el criterio que la casa ya eligió. **La propuesta se corrige aquí: el default de la cuenta puente es 3300 cuando el corte cae a media anualidad, y 3200 sólo cuando el corte es inicio de ejercicio** (que es cuando el resultado ya se barrió). Y no es una política nueva: es un lector de la que ya existe.

**5. `entry import` dejó de ser un callejón sin salida, y con eso apareció el "deshacer" — para la puerta equivocada.** La mañana escribió que el staging de pólizas es «archivo→lote con `batch_id`, jamás el mayor». Sigue siendo cierto, pero F06c le puso la familia completa: `src/cli/batch-command.ts` tiene `list`, `show`, `check`, `post` y **`reverse`** (líneas 338, 408, 491, 599, 747), y `docs/catalogo-minimos.json` lo registra: «Cierra el agujero que F01 dejó abierto: `entry import` depositaba pólizas en el staging de la 045 y ningún comando podía aplicarlas, verificarlas ni reversarlas». La ayuda de `batch reverse` dice exactamente lo que el encargo de esta pasada pide: «Mirror every entry the batch posted, **as the unit it always was**».

   **Y no alcanza a la migración.** `reverseBatch` (`src/services/accounting/batch-service.ts:814-844`) localiza las pólizas por `JOIN journal_entry_import_rows r ON r.id = je.source_id … AND je.source_type = ORIGEN_LOTE_IMPORTADO`. La póliza de apertura no nace de un lote: nace de `createDraft` (`onboarding-service.ts:218`), sin `batch_id` y sin ese `source_type`. **El primitivo de deshacer en bloque ya está construido y la migración no lo puede usar.**

**6. F06a le dio escritor a los activos fijos, y con eso la migración de activos pasó de hipótesis a problema real.** La migración `056_el_activo_y_su_corrida.sql` abre confesando lo que había: «El módulo de activos lleva desde la 003 con el esquema entero y **ningún escritor**». Hoy hay `crearActivo` (`src/services/assets/asset-service.ts:491`), `planDeDepreciacion`, `runMonthlyDepreciation` con llamador, `asset-command.ts` y `depreciation-command.ts`, y dos políticas propias (`base_depreciacion`, `convencion_primer_mes`). El documento de la mañana no mencionó activos fijos ni una vez. Ahora hay que mirarlos, y lo que se ve son dos cerrojos (sección siguiente, punto B).

**7. R4 escribió la moneda de origen en el mayor, y el borrador de apertura no la puede llevar.** La 057 y el trabajo de R4 hicieron que `createJournalEntry` por fin escriba las cuatro columnas de la 001: `JournalEntryLineInput` acepta `currency_code`, `foreign_debit`, `foreign_credit` y `exchange_rate` (`src/services/accounting/posting.ts:37-40`) y el INSERT las persiste (`:173-180`); hasta la reversa las espeja cruzadas a propósito (`:574-577`). Pero `DraftLine` (`src/ai/draft-service.ts:19-24`) tiene **cuatro campos y ninguno es de moneda**: `account_code`, `debit`, `credit`, `description`. Y `executeOnboarding` va **siempre** por `createDraft`. Conclusión: **la póliza de apertura de un cliente con cuenta en dólares nace en funcional y pierde el origen** — la pérdida exacta que R4 arregló, reintroducida por la puerta del onboarding. El daño no es teórico: el `CompNal` del XSD de pólizas trae `Moneda` y `TipCamb`, así que la fuente sí lo dice y somos nosotros quienes lo tiramos.

**8. Los comandos que este documento propuso ya estaban reservados en el catálogo, con otro nombre.** La mañana propuso «nuevo adaptador `xml-sat` como *file adapter* del registry contable» y «`csv-balanza` genérico». `docs/cli-command-catalog.md` ya tenía, desde antes, tres filas que son esa misma capacidad:
   - línea 420 — `mnemosine chart import <file>` · `catalogo importar`: «Carga un catálogo desde CSV/XLSX, export de CONTPAQi/Aspel o **`CatalogoCuentas_1_3`**», con `--layout`, `--map`, `--dry-run`;
   - líneas 536-537 — `opening-balance import <file>` y `opening-balance show`, descritos literalmente como «**el gemelo dirigido por archivo de `onboard`, que no se toca**», con `--as-of`, `--layout`, `--balance-account`, y con la nota de que **no** se expone `--post`.
   El catálogo mandó primero. **La propuesta de la mañana se re-encauza: no son adaptadores nuevos del registry contable, son las tres filas del catálogo, y el registry contable se queda para proveedores por API.** La diferencia importa: un `IExternalAccountingAdapter` que en realidad lee un archivo tiene que fingir `getTrialBalance(start, cutoff)` ignorando el rango, y esa mentira se paga en `diffTrialBalance`.

**9. El c_CodAgrup sigue sin sembrar — pero ya no por falta de fuente.** `src/services/xml-ingestion/sat-catalogs.ts` tiene `REGIMEN_FISCAL`, `USO_CFDI` y compañía; no tiene agrupador. `account map` sigue con `set|list|import|check` y **`match` sigue sin existir** (`src/cli/account-command.ts:619-736`). El comentario de `account-service.ts:517-520` sigue vigente palabra por palabra. Lo que cambió es que la lista de 1 066 renglones está verificada arriba.

**10. Lo que la mañana no miró y es lo que peor duele: `executeOnboarding` crea cuentas con siete columnas de treinta.** El INSERT de `onboarding-service.ts:180-185` pone `id, code, name, account_type, normal_balance, entity_id, created_by`. La tabla `accounts` de la 001 tiene además `parent_id`, `account_level` (NOT NULL DEFAULT **1**), `full_code`, `account_subtype`, `fs_category`, `is_control_account`, `is_header`, `allow_manual_entries`, `require_subsidiary`, `currency_code`, `mx_nif_code` y `tags JSONB`. Consecuencias medibles el primer día de un cliente migrado:
   - **cobertura de agrupador 0 %** — `account map check --scheme sat-agrupador` reprueba entero, en el cliente donde más se necesitaba porque venía de un sistema que *sí* lo tenía en el XML;
   - **catálogo plano** — todas las cuentas en nivel 1, sin padre, aunque el `SubCtaDe` del XML lo dice;
   - **cuentas acumulativas que aceptan pólizas** — `is_header = false` por default y el CHECK `is_header = false OR allow_manual_entries = false` no se opone;
   - **sin moneda de cuenta** — `currency_code` nulo aunque la balanza de origen distinga bancos en dólares.

### Lo que falta para ser perfecto

No «qué sigue». Qué le falta para que un despacho migre cuarenta clientes sin miedo, y qué echa de menos hoy. Ordenado por consecuencia.

---

**A. La cuenta migrada nace sin agrupador, y el despacho lo descubre en el envío mensual.** *Tamaño S/M. Bloqueada por: nada, desde esta pasada.*

Es la brecha de peor razón de existir: el archivo de origen **trae** el `CodAgrup` por cuenta, y nuestro alta lo tira. Cerrarla son tres piezas que ya no dependen de nadie: sembrar los 1 066 renglones del Anexo 24 RMF 2026 verificado arriba (con su fuente escrita al lado, como hizo `asset-service.ts` con las tasas de la LISR — «media tasa recordada de memoria es peor que ninguna»), consolidar `mx_nif_code` y `codigo_agrupador_sat` en una sola columna con reparación vigilada por `doctor`, y hacer que el alta escriba el agrupador. `map match` deja de ser promesa el mismo día. **Consecuencia de no hacerlo**: el despacho migra cuarenta catálogos y luego mapea cuarenta catálogos a mano, que es «la tarea de alta más pesada de un despacho» según nuestro propio código.

---

**B. La depreciación acumulada de un activo migrado no se puede cargar — y si se cargara, la primera corrida la borraría.** *Tamaño M. Bloqueada por: una decisión de diseño, no por trabajo.*

Son **dos** cerrojos y hay que abrir los dos:

1. **No hay por dónde entrarla.** `DatosDeAlta` (`src/services/assets/asset-service.ts:287-316`) tiene veinte campos y ninguno dice cuánto lleva depreciado el activo ni cuántos meses de vida le quedan. `montosDelAlta` (`:416`) valida costo y salvamento y nada más.
2. **Y si se entrara, se pierde en el primer cierre.** `src/services/assets/depreciation.ts:445-457`: después de cada corrida, `accumulated_depreciation = p.acumulada` y `current_book_value = fa.acquisition_cost - p.acumulada`, donde `p.acumulada = SUM(ds.depreciation_expense) WHERE ds.is_posted = true`. Es decir, **la acumulada se re-deriva de los renglones que ESTE sistema posteó**. Un activo con tres años de historia ajena queda, tras su primer mes aquí, con la acumulada de un mes y un valor en libros inflado en tres años.

   Y ojo: ese SQL **está bien** para lo que fue escrito. La 059 documenta por qué —«la ficha del activo llegó a afirmar una acumulada que el mayor no respaldaba justo por copiar el renglón»— y es la misma lección de `amortization-run.ts`. El invariante es *la ficha no afirma lo que el mayor no respalda*. La migración no lo rompe: lo **extiende**, porque en un activo migrado el mayor **sí** respalda la acumulada ajena — está en el renglón `171.xx` de la póliza de apertura.

**La decisión que hay que tomar, escrita para que alguien la resuelva**: ¿la historia ajena entra como (a) renglones en `depreciation_schedules` con `is_posted = false`, `schedule_type` propio y `calculation_metadata` diciendo que vienen de una migración —lo que deja papel de trabajo por mes y hace que la fórmula actual siga siendo verdad sin tocarla si se cuenta el bloque migrado aparte—, o (b) una columna `depreciacion_acumulada_de_apertura` que la corrida **sume** en vez de pisar? (b) es una línea de SQL y (a) es lo que un auditor querrá ver. La respuesta previsible es (b) con una tabla de respaldo, pero es una bifurcación de criterio contable y **va al panel, no al chat** — con el argumento del árbol ya escrito: «una bifurcación de criterio contable no se pregunta ni se elige: se añade al panel».

**Por qué duele hoy y no antes**: el agrupador del SAT desglosa la depreciación acumulada en dieciocho subcuentas (`171.01`–`171.18`, verificadas arriba). La balanza mensual que el cliente ya le envía al SAT **expone su acumulada por especie**. Un cliente migrado envía en enero una balanza cuyo 171 no se parece al de diciembre del año anterior, y ese salto lo ve el SAT antes que el despacho.

Añadidos que la misma puerta necesita: `montosDelAlta` rechaza `salvamento >= costo` por buena razón, pero un activo **totalmente depreciado** que sigue en operación es normalísimo en una migración y hoy no tiene forma de existir; y `inicioDeDepreciacion` normaliza al día 1 del mes de adquisición, lo que para un activo comprado hace seis años y migrado hoy hay que poder decir sin que el motor intente correr setenta y dos meses hacia atrás.

---

**C. No hay papel de trabajo: la prueba de que la migración no perdió nada se evapora al cerrar la terminal.** *Tamaño S. Bloqueada por: nada.*

`diffTrialBalance` (`src/ai/external-service.ts:55-110`) devuelve un objeto en memoria: `matched_equal`, `differences`, `only_local`, `only_remote`. **Nada lo escribe.** No hay tabla, no hay archivo, no hay adjunto en la póliza de apertura. El criterio de aceptación que este documento llama «el candado del pipeline» produce hoy una prueba que dura lo que dura el scrollback.

Compárese con lo que exige la guía que este mismo documento cita: antes de migrar, «Export and save key reports (Trial Balance, P&L, VAT summary)» del sistema viejo. Nosotros no guardamos ni los del viejo ni los del nuevo.

Lo que falta es un **expediente de migración** que sobreviva al año: la balanza de origen tal como llegó (con su hash), la balanza nuestra al corte, el diff cuenta por cuenta con sus ceros, la lista de cuentas creadas, la cuenta puente y su importe con el criterio que lo justificó, y el folio de la póliza de apertura. Un solo artefacto, firmado, al que se llegue con `opening-balance show`. Sin él, cuando dentro de dos años alguien pregunte por qué el saldo inicial de 2026 es ése, la única respuesta es que alguien vio ceros en una pantalla.

---

**D. No se deshace una migración que salió mal.** *Tamaño M. Bloqueada por: nada.*

Hoy el repertorio es: `entry reverse` sobre la póliza de apertura —una a la vez, y **una sola reversa por póliza para siempre** (`entry-command.ts:89`, «one reversal per entry, ever»)— y `account archive` cuenta por cuenta. Las N cuentas que `executeOnboarding` creó **no tienen marca de procedencia**: nada en `accounts` dice «esta cuenta nació de la migración `onboarding:contalink:2026-01-01`», así que ni siquiera se pueden listar para archivarlas.

Y sin embargo el primitivo existe: `batch reverse` espeja un lote entero «as the unit it always was». Sólo que se ata a `journal_entry_import_rows`, y la apertura no pasa por ahí (punto 5 de la deriva).

**La vara está baja y podemos saltarla holgadamente.** El competidor que este documento estudia responde así a una migración fallida, verificado esta tarde: si la empresa tiene **menos de 60 días**, se *purga* entera —y sólo en Essentials, Plus o Advanced, no en Simple Start—, escribiendo «YES» y aceptando que «permanently damage[s] connections to banks or third-party apps»; si tiene 60 días o más, **no hay purga**: se cancela la empresa y se abre otra, con acceso de sólo lectura a la vieja durante un año. Es decir: **QuickBooks Online no sabe deshacer una migración; sabe tirar la empresa.**

Nosotros podemos hacerlo mejor sin inventar nada, porque la apertura ya lleva la referencia determinística `onboarding:<provider>:<cutoff>`. Lo que falta:
- que la migración sea **una unidad reversable** (el mismo concepto que `batch`, aplicado a la apertura: la póliza, las cuentas creadas, los documentos abiertos y los activos entran y salen juntos);
- **procedencia en las cuentas** — y aquí no hace falta migración: `accounts.tags` es `JSONB DEFAULT '{}'` y está sin usar;
- que deshacer sea **reversa y no borrado**, como manda la 041 y NIF B-1: el mayor es inviolable, la apertura errónea se espeja, y lo que se archiva son las cuentas que quedaron sin uso;
- y el caso feo, dicho en voz alta: **una migración sobre la que ya se posteó un mes de operación no se deshace** — se corrige con pólizas fechadas. La herramienta tiene que negarse y decir por qué, no intentarlo.

---

**E. CxC/CxP documento a documento: llegaron las tablas, falta la puerta de carga.** *Tamaño M/L. Bloqueada por: nada.*

La mañana propuso esto como «Capa 3 nueva». Desde entonces, 049 y 050 trajeron notas de crédito, aplicaciones con su historia de desaplicación, el cobro devuelto (`reversed`, que «ocurrió y se deshizo») y el perfil fiscal del cliente. El esquema para sostener la doctrina Xero **ya está**.

Lo que no está es la entrada: ni `invoice` ni `bill` tienen `import --file`. Migrar los documentos abiertos de cuarenta clientes significa teclearlos. Y el candado que este documento propuso —**suma de documentos abiertos por cuenta de control = renglón de esa cuenta en la balanza de apertura, o la capa se rechaza completa**— no tiene dónde vivir: no hay comando que lo compruebe.

Detalle mexicano que la mañana rozó y conviene fijar: los documentos abiertos al corte **traen su UUID de CFDI**, y `credit_notes.relates_to_uuid` (049) ya está pensado justo para «una nota sobre una factura pre-mnemosine». La migración de CxC no es sólo importe y fecha: es el UUID, porque de él dependen el REP y el cruce con el espejo CFDI.

---

**F. Nómina y provisiones a media anualidad: no hay acumulados por empleado.** *Tamaño L. Bloqueada por: nada más que alcance.*

La 053 arregló el mapeo de cuentas (la nómina dejó de cargarse a «Devoluciones sobre Compras»), pero eso es el **destino contable**, no el **saldo de arranque**. Un corte a mitad de ejercicio necesita, por empleado y acumulado del año: sueldos gravados y exentos, ISR retenido, subsidio al empleo entregado, IMSS obrero y patronal, INFONAVIT y las deducciones vigentes. Sin eso, el ajuste anual del ISR sale mal y el primer CFDI de nómina timbrado arranca desde cero un acumulado que no está en cero.

La referencia que sí se pudo verificar esta tarde es la de QuickBooks: pide exactamente eso —«employee pay stubs or payroll reports with year-to-date amounts that show each pay item, deduction, tax and net pay», más «a quarterly tax liability report from your prior payroll provider»— y **sólo lo acepta antes del primer cheque**: «Entering prior payroll data can only be done if no paycheck has been run yet». Esa ventana que se cierra es el diseño correcto y hay que copiarlo: los acumulados de apertura se cargan antes de la primera corrida o no se cargan.

Del lado de las provisiones a medio ejercicio, el panel ya tiene `dias_aguinaldo` y `prima_vacacional_pct`, pero devengan **hacia adelante**. Una empresa que se migra en julio llega con siete meses de aguinaldo ya provisionados en el sistema viejo: hoy ese saldo entra como un renglón mudo de la balanza de apertura y el devengo de agosto no sabe que existe.

*Corolario*: cuando no hay sistema viejo confiable, la reconstrucción de nómina sale de los **CFDI de nómina** por descarga masiva — la misma vía de la capa 4, con el límite recién verificado de seis ejercicios incluido el actual.

---

**G. Cuarenta clientes es un problema de lote, y no hay lote.** *Tamaño M. Bloqueada por: nada.*

`onboard` corre **uno**, interactivo, con su `--yes` y su `--idempotency-key`. Para cuarenta hace falta: un manifiesto (entidad, archivo o proveedor, corte, cuenta puente, criterio) que se corra de un tirón en seco; un informe agregado que diga cuáles cuadraron, cuáles necesitaron puente y de cuánto, y cuáles reprobaron; y la capacidad de reanudar sin repetir —que la idempotencia por referencia ya casi regala—. Sin esto, el despacho hace cuarenta corridas y lleva la cuenta en una hoja de cálculo, que es exactamente donde se pierden las migraciones.

---

**H. La cuenta puente contradice el criterio que la casa ya eligió.** *Tamaño S. Bloqueada por: nada.* Ver el punto 4 de la deriva: el default correcto es 3300 en corte a media anualidad, 3200 en corte a inicio de ejercicio, y el lector es de la política que ya existe.

---

**I. La apertura pierde la moneda de origen.** *Tamaño S. Bloqueada por: nada.* Ver el punto 7 de la deriva: `DraftLine` necesita las cuatro columnas que `JournalEntryLineInput` ya acepta. Es la brecha más barata de esta lista y la que más rápido se vuelve irreparable: una vez posteada la apertura, el mayor es inviolable y el origen no se puede añadir después.

---

**J. La puerta de reconstrucción sigue sin existir.** *Tamaño L. Bloqueada por: la e.firma y su bóveda.*

Sin adaptador de descarga masiva, «no hay sistema previo confiable» sigue significando «capture usted». El diseño que la mañana propuso sigue en pie —simulado primero con `readonly simulado = true` y cerrojo fuera de sandbox, como los PAC— y ahora tiene además el argumento oficial del SAT para la bóveda, citado arriba: la e.firma «no se almacene en el equipo de un tercero». Y tiene dos límites nuevos que hay que codificar desde el principio, no descubrir en producción: seis ejercicios incluido el actual, y fecha inicial estrictamente menor que la final.

---

**Lo que un despacho todavía echaría de menos aunque A–J estuvieran hechas**, y que dejo nombrado sin desarrollar porque cada uno es su propio tramo: la **corrida en paralelo** (un mes capturado en los dos sistemas con las dos balanzas comparadas) sigue sin ser doctrina citable de nadie —lo comprobé otra vez esta tarde, ninguna guía oficial la exige— y por tanto entra como criterio del despacho, no como candado; la migración de **inventarios** con su costeo, que ni la mañana ni esta pasada tocaron; y el **cierre del ciclo** — que la balanza que este sistema produzca al mes siguiente del corte sea la que el cliente le envía al SAT, porque una migración que no termina en un envío aceptado no terminó.
