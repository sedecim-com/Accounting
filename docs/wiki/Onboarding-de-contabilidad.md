# Onboarding de contabilidad

Nadie llega a mnemosine con la contabilidad en cero. Llega con años de historia en CONTPAQi, en Aspel COI, en Contalink, o en una carpeta de XML y estados de cuenta. Esta página cuenta las dos mitades con honestidad: **lo que ya funciona hoy** (una vía por API y un staging de pólizas) y **el pipeline por capas que es dirección, no capacidad** — el lector no debe salir creyendo que ya puede importar el XML de su balanza.

---

## Lo que existe hoy

**El comando `onboard` (alias `alta`), con un solo proveedor.** [`src/cli/mnemosine.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/mnemosine.ts) lo declara con `--provider contalink` como única opción viva, `--cutoff` obligatorio, `--from` (por omisión el 1 de enero del año del corte), `--balance-account` para balanzas remotas que no suman cero, y `--post` opcional — sin él, el asiento de apertura queda en **borrador para revisión**. El flujo es plan → confirmación → ejecución, con idempotencia por llave y una verificación post-importación que exige **cero diferencias** entre la balanza remota y la nuestra (`diffTrialBalance`). Está declarado `risk: 'irreversible'` y `agent: false`: el agente no lo alcanza; lo corre una persona.

**El servicio detrás.** [`src/ai/onboarding-service.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/onboarding-service.ts) lee la balanza remota, infiere tipo y naturaleza por el primer dígito del código mexicano (1 activo, 2 pasivo, 3 capital, 4 ingreso, 5/6 gasto, 7 con baja confianza), detecta cuentas faltantes y arma el asiento de apertura con referencia determinística `onboarding:<provider>:<cutoff>` — rechaza duplicados posteados **y también** borradores pendientes con la misma referencia. `executeOnboarding` pasa por `createDraft`/`approveDraft`: el único camino al mayor, como todo lo demás.

**El adaptador.** [`src/services/integrations/accounting/registry.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/integrations/accounting/registry.ts) tiene una sola fábrica: `contalink`, con credencial vía `CONTALINK_API_KEY` en el entorno — nunca en un archivo de configuración. La interfaz ([`accounting-adapter.interface.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/integrations/accounting/accounting-adapter.interface.ts)) pide esencialmente una cosa: `getTrialBalance(start, cutoff)`. Esa parquedad es deliberada: cualquier cosa que sepa entregar una balanza puede ser un adaptador, incluido un archivo — que es exactamente el plan.

**El staging de pólizas.** `entry import` ([`src/cli/entry-command.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/entry-command.ts)) lleva un archivo a un lote con `batch_id`, jamás al mayor. Los layouts vivos son `csv` y `ndjson`; en [`entry-import-service.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/entry-import-service.ts) están **reservados y rechazados con mensaje honesto** `contpaqi`, `aspel`, `iif` y `sat-polizas` — «falta el parser con fixtures reales». Reservar el nombre y rechazar es mejor que fingir que se soporta.

**El agrupador SAT.** `account map import/check --scheme sat-agrupador` ([`account-command.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/account-command.ts)) escribe el código agrupador por cuenta en la columna `mx_nif_code`, y `map check` es la compuerta de cobertura antes de cualquier XML de catálogo del Anexo 24. La limitación está confesada en el propio código ([`account-service.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/account-service.ts)): **no valida contra el catálogo c_CodAgrup porque ese catálogo no existe en el repo todavía**; `map match` queda pendiente.

**El asistente `init`, sección S5.** Tres puertas para «traer tu contabilidad» ([`src/cli/init/s5-import.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/init/s5-import.ts)): la API de Contalink, una carpeta de XML de CFDI (con tope de 50 en la primera corrida y auto-posteo apagado), o empezar de cero. Ver [[Puesta-en-marcha]].

**Una discrepancia que confesar:** hay dos columnas para el mismo concepto en `accounts` — `mx_nif_code` (migración 001, la que `account map` escribe) y `codigo_agrupador_sat` (migración 037, que ningún TypeScript lee ni escribe). Una de las dos es capacidad huérfana; el plan la consolida **antes** de construir encima.

---

## Por qué el XML del SAT es el formato universal

La contabilidad electrónica es obligación fiscal en México: catálogo de cuentas (una vez, con código agrupador por cuenta) y balanza de comprobación (mensual) en XML validado contra los XSD del SAT. La consecuencia estructural importa más que el trámite: **todo sistema contable mexicano en operación exporta estos XML por obligación.** Eso los vuelve el formato de intercambio de facto — más universal que cualquier CSV propietario.

Los cuatro esquemas vigentes (versión 1.3), leídos directamente del servidor del SAT en la investigación del 2-sep-2026:

| XSD | Qué trae | Capa que cubre |
|---|---|---|
| [Catálogo de cuentas](https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd) | `NumCta`, `Desc`, `CodAgrup` (obligatorio por cuenta), `Nivel`, `Natur` (D/A), `SubCtaDe` (jerarquía por referencia al padre) | Catálogo **y** agrupador de un golpe |
| [Balanza de comprobación](https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_3.xsd) | Por cuenta: `SaldoIni`, `Debe`, `Haber`, `SaldoFin`; `Mes` 01-13 (el 13 es el ajuste de cierre) | Apertura al corte |
| [Pólizas del periodo](https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/PolizasPeriodo/PolizasPeriodo_1_3.xsd) | Transacciones con UUID del CFDI, RFC del tercero, cheques, transferencias | Histórico detallado |
| [Auxiliar de cuentas](https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/AuxiliarCtas/AuxiliarCtas_1_3.xsd) | Saldos inicial/final y movimientos por cuenta | Histórico detallado |

La estructura completa del Anexo 24 —incluida la sección B, el catálogo de códigos agrupadores— está en el [DOF del 5 de enero de 2015](https://dof.gob.mx/miscelanea_2015/SHCP_05012015_04.pdf). Advertencia: el Anexo 24 vigente más reciente vive en un servidor del SAT (`omawww`) que rechaza HTTPS y no pudo verificarse; lo verificado es el de 2015 y la confirmación de CONTPAQi de que «el Anexo 24 versión 1.3 sigue siendo obligatorio en 2026».

**Y los dos grandes lo exportan de fábrica.** CONTPAQi Contabilidad genera los XML del Anexo 24 directamente desde los registros contables ([guía oficial](https://www.contpaqi.com/publicaciones/contabilidad/contabilidad-electronica-guia-completa)); Aspel COI los genera por `Fiscales → Generación de XML` — [catálogo](https://coiportaldeclientes.aspel.com.mx/xml-catalogo-de-cuentas/) y [balanza](https://coiportaldeclientes.aspel.com.mx/xml-balanza-de-comprobacion/). Conclusión operativa: **migrar desde CONTPAQi o Aspel no requiere ingeniería inversa de formatos propietarios.** Los layouts `contpaqi` y `aspel` reservados en el staging quedan para pólizas históricas detalladas, no para el alta — y la dirección propuesta los redefine como «instrucciones para exportar el XML del SAT desde ese sistema», a costo cercano a cero y con cobertura de todo sistema mexicano en regla.

---

## El pipeline por capas (propuesto — nada de esto existe todavía)

Cuatro capas, todas desembocando en los caminos que ya existen: borradores y staging. Ninguna herramienta del agente toca el mayor; el humano aprueba con `review`, `--post` o la familia `batch`.

**Capa 1 — Catálogo.** Un adaptador `xml-sat` de archivo en el registry contable, con el parser de `CatalogoCuentas_1_3`. Llena de un golpe lo que hoy son dos pasos: crea la cuenta **y** escribe el agrupador, porque `CodAgrup` viene en el XML — desaparece la tarea de alta más pesada de un despacho. Validaciones antes de aceptar: la `Natur` del XML contra la naturaleza inferida (discrepancia se reporta; gana el XML, con bandera), jerarquía `SubCtaDe`/`Nivel` consistente, `CodAgrup` contra el catálogo c_CodAgrup **sembrado como tabla** (la siembra que hoy no existe y que `map match` espera), y cuentas acumulativas marcadas como encabezado. Prerrequisito: consolidar las dos columnas de agrupador.

**Capa 2 — Balanza de apertura al corte.** El parser de `BalanzaComprobacion_1_3` implementa `getTrialBalance` leyendo de archivo, de modo que `onboard --provider xml-sat --file balanza.xml --cutoff ...` correría **exactamente el flujo actual**: plan → confirmación → borrador → verificación contra el mismo archivo. Se toma `SaldoFin` del mes del corte (o `SaldoIni` del mes siguiente si viene, verificando que coincidan). Un `csv-balanza` genérico con mapeo de columnas queda como fallback para orígenes sin XML.

**Capa 3 — Auxiliares abiertos de CxC/CxP, documento a documento.** Los saldos de clientes y proveedores del asiento de apertura se respaldan con documentos individuales — las facturas y cuentas por pagar **no pagadas** al corte, con su UUID cuando exista. La regla de aceptación no negocia: **la suma de documentos abiertos por cuenta de control debe ser igual al renglón de esa cuenta en la balanza de apertura**; si no cuadra, la capa se rechaza completa. No hay «casi cuadra».

**Capa 4 — Los CFDI del ejercicio.** Dos vías: la carpeta local que ya ingiere el clasificador (auto-posteo apagado, tope de primera corrida — esto sí existe), y un futuro adaptador del servicio de descarga masiva del SAT ([documentación oficial](https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461174995026&ssbinary=true): flujo solicitud → verificación → descarga, e.firma obligatoria; límites según la [comunidad phpcfdi](https://github.com/phpcfdi/sat-ws-descarga-masiva): 200,000 CFDI por solicitud, hasta 5 años atrás). La e.firma es la llave de ese servicio: **va a la bóveda, jamás al chat ni a un archivo de configuración.** En modo reconstrucción —cuando no hay sistema previo confiable— la capa 4 sustituye a las capas 2-3: CFDI más estados de cuenta arman los borradores del ejercicio, y la apertura se reduce a saldos bancarios y de capital. Las pólizas históricas detalladas entrarían por `entry import --layout sat-polizas`, el layout ya reservado.

---

## Las validaciones: el candado del pipeline

El criterio de aceptación global, tomado del flujo que ya funciona con Contalink y generalizado a archivo:

> **La balanza del sistema viejo y la nuestra IGUALES al corte, cuenta por cuenta** — `diffTrialBalance` con 0 diferencias y 0 cuentas solo-remotas, corrido automáticamente al postear la apertura.

Debajo de ese candado, las validaciones por capa: cuadre global (débitos = créditos, con la tolerancia existente de 0.01 y `--balance-account` para balanzas parciales), naturaleza (un saldo deudor en cuenta acreedora se reporta como advertencia, no se corrige en silencio), agrupador contra c_CodAgrup, y la igualdad exacta auxiliar-contra-control de la capa 3. La salida de `onboard` terminaría en un checklist post-migración: balanza comparada, bancos por conciliar, documentos abiertos ligados.

---

## Las prácticas de corte

Lo que la doctrina oficial de los convertidores grandes dice, verificado en las fuentes, y cómo se adopta:

**La fecha de corte es el primero de un mes, y de preferencia el inicio del ejercicio.** Xero lo escribe sin rodeos ([conversion date](https://central.xero.com/s/article/Setting-your-conversion-date)): la fecha de conversión es la de tus saldos de apertura, siempre el primero de un mes, y debe ser «el día siguiente a la fecha en que cuadraste todas tus cuentas en el sistema anterior», con la balanza corrida al día previo. Migrar a media anualidad se permite — pero arrastra acumulados de resultados que el inicio de ejercicio evita. `--cutoff` ya existe; la preferencia (inicio de ejercicio contra mes en curso) es una bifurcación de criterio y va al panel, no a una pregunta en el chat.

**La contrapartida de apertura tiene nombre.** QuickBooks Online usa la cuenta [Opening Balance Equity](https://quickbooks.intuit.com/learn-support/en-us/help-article/bank-deposits/enter-opening-balance-account-quickbooks-online/L7NcxTbuu_US_en_US) como contrapartida automática de cada saldo de apertura. Nuestro equivalente ya existe: `--balance-account` (sugerida la 3200).

**CxC y CxP se capturan documento a documento, jamás como agregado.** Doctrina Xero explícita: las únicas transacciones anteriores al corte que se capturan son las facturas y cuentas por pagar no pagadas al convertir. Capturar solo el total de deudores rompe la aplicación de cobros posteriores — cada pago que llegue después ya no tiene contra qué aplicarse. De ahí la regla dura de la capa 3.

**Antes de migrar, archivar; después de migrar, comparar.** La [guía de migración de QBO](https://quickbooks.intuit.com/learn-support/en-uk/help-article/migrate-services/comprehensive-guide-dataswitcher/L22WWA0As_GB_en_GB) exige exportar y guardar los reportes del sistema viejo para auditoría antes de tocar nada, y su [checklist posterior](https://quickbooks.intuit.com/learn-support/en-uk/help-article/migrate-services/checking-results-conversion-quickbooks-online/L3bbYvyT6_GB_en_GB) ordena revisar lo convertido, conciliar bancos y ligar los documentos abiertos.

**La corrida en paralelo** —un mes capturado en ambos sistemas, balanzas comparadas— es práctica sana de despacho, no doctrina oficial citable. Se registra como recomendación de criterio.

Cada una de estas bifurcaciones (fecha preferida de corte, documento-a-documento contra agregado, cuenta puente, tolerancia de cuadre, días de corrida paralela) está propuesta para el panel de políticas **con su lector** — porque en esta casa una bifurcación de criterio contable no se pregunta ni se decide en caliente: se configura y se audita. Ver [[El-agente-y-sus-limites]].

---

## Qué entra al plan maestro

Cuatro etapas ordenadas por dependencia, ninguna empezada:

1. **xml-sat, capas 1+2** (mediana): parsers de catálogo y balanza 1.3 como adaptador de archivo, siembra de c_CodAgrup con `map match`, consolidación de las dos columnas de agrupador, `onboard --provider xml-sat --file`. Fixtures generados conforme a los XSD verificados.
2. **csv-balanza** (chica): el fallback mapeado, mismo flujo plan → borrador → diff.
3. **Auxiliares abiertos CxC/CxP** (mediana): staging de documentos abiertos con el candado suma-por-control, y la aplicación por documento.
4. **sat-descarga-masiva + sat-polizas** (grande): el WS oficial con la e.firma desde la bóveda (adaptador simulado primero, con el mismo cerrojo que los PAC), el modo reconstrucción, y el parser del layout ya reservado.

---

## Para seguir

- [[Puesta-en-marcha]] — el asistente `init` y su sección de importación, que es lo que hoy sí corre.
- [[Fiscal-mexicano]] — el espejo CFDI y el agrupador SAT en su contexto fiscal.
- [[Conectores-PAC]] — la otra frontera con el SAT: el timbrado.
- [[El-agente-y-sus-limites]] — por qué `onboard` es `agent: false` y todo desemboca en borradores.
- [[Hoja-de-ruta]] — dónde caen las cuatro etapas.
- [[Glosario]] — balanza de comprobación, código agrupador, CFDI, e.firma.
