# Conectores PAC

Un PAC —Proveedor Autorizado de Certificación— es quien timbra el CFDI ante el SAT: recibe el comprobante **ya sellado por el contribuyente**, le estampa el folio fiscal y lo reporta. Esta página es el mapa de conexión: qué hay en el código hoy, qué proveedores se investigaron y con qué evidencia, y en qué orden se planea construir.

---

## Antes que nada: no hay quién selle

**`generateCfdiXml` no existe en ningún archivo del repositorio.** La única aparición del nombre en `src/` es el comentario que lo confiesa, en [`invoices.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/api/rest/routes/invoices.ts) línea 248: *«real implementation would use cfdi.ts `generateCfdiXml`»*. El archivo al que remite se borró hace tiempo (CLI-5, `02aaeea`, según [`docs/cli-command-catalog.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/cli-command-catalog.md) línea 1917) y nadie lo sustituyó. Lo que la ruta de timbrado le manda hoy a un PAC es un `<cfdi:Comprobante>` con cinco atributos —`Version`, `Folio`, `Total`, `SubTotal`, `Moneda`— y nada más: **sin `Emisor`, sin `Receptor`, sin `Conceptos`, sin `NoCertificado`, sin `Certificado` y sin `Sello`**. No hay `createSign` ni cadena original en todo `src/services/`; los `cadena_original` de [`finkok-adapter.ts:103`](https://github.com/sedecim-com/Accounting/blob/main/src/services/integrations/mexico/pac/finkok-adapter.ts), `sw-sapien-adapter.ts:93` y `edicom-adapter.ts:79` son literales que fabrican los simuladores.

Esto reordena la página entera, y hay que decirlo con todas sus letras: **toda la estrategia de PACs descansa en «mandamos el XML ya sellado, el CSD nunca sale de la bóveda», y esa premisa no tiene productor.** La regla de custodia sigue siendo la correcta —abajo se conserva—, pero hoy no protege nada, porque no hay llave que se pudiera entregar: no hay firma que se pudiera hacer.

El SAT lo dice en la norma vigente. La [RMF 2026](https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/rmf/RMF_2026-DOF-28122025.pdf) (DOF 28-dic-2025), regla **2.7.2.9**, obliga al PAC a validar «que el CSD del contribuyente emisor, **con el que se selló el documento**, haya estado vigente» (fr. III) y «que **el sello digital corresponda al documento enviado**» (fr. IV). Y define cuándo el comprobante existe: «El CFDI se considera expedido una vez **generado y sellado con el CSD del contribuyente**, siempre que se obtenga el Timbre Fiscal Digital del SAT».

Las piezas de bóveda ya están: [`fiscal-credentials/certificate.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/fiscal-credentials/certificate.ts) descifra el `.key` PKCS#8 del SAT y distingue e.firma de CSD por `keyUsage`, y `service.ts:302` hace `zeroize`. Falta lo de en medio: la **cadena original** (el XSLT del Anexo 20) y el **`SHA256withRSA`**.

**Consecuencia práctica, sin adornos: elegir PAC es hoy elegir a quién no llamar todavía.** Y hay un orden que no es el intuitivo — la nómina ([`cfdi-nomina-generator.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/payroll/mx/cfdi-nomina-generator.ts)) sí arma un XML casi completo, con `Emisor`, `Receptor`, `Conceptos` y el complemento `nomina12:Nomina` entero, así que **sellarla produciría un CFDI aceptado y equivocado**; facturación produce uno incompleto, que el PAC rechaza. Se arregla primero lo que sale mal *aceptado*: ver §1.1 y §2.1 de [`docs/BRECHAS-PARA-LA-PERFECCION.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/BRECHAS-PARA-LA-PERFECCION.md).

*(Esta sección es nueva del 2 de septiembre de 2026, tarde. La versión anterior de esta página daba por hecho el sellador y no lo mencionaba en ningún renglón.)*

---

## La regla de custodia, que sigue en pie

El CSD —el certificado de sello digital del contribuyente, con su llave privada— vive en la bóveda y **no sale de ahí**. Al PAC solo viaja XML **ya sellado** por mnemosine. Es una regla sobre el futuro mientras no exista el sellador, pero decide desde ya a quién se puede contratar:

- Solo se consideran proveedores cuyo flujo **por omisión** acepte el XML pre-sellado. El que exige subir la llave `.key` con su contraseña queda fuera sin discusión: Facturama la pide «exclusivamente por este medio», por RFC emisor, sin alternativa ([guía de carga de CSD](https://apisandbox.facturama.mx/guias/api-multi/csds)) — y además el PDF oficial del SAT confirma que ni siquiera es PAC.
- Los métodos del proveedor que sellan por ti se declaran **prohibidos en el propio adaptador**. El de Sovos ya trae la lista `METODOS_PROHIBIDOS` ([`sovos-reachcore-adapter.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/integrations/mexico/pac/sovos-reachcore-adapter.ts), línea 66). La segunda pasada añadió dos entradas que faltaban: **`/v4/cfdi33/issue/` de SW** —que sella y timbra en un solo paso, frente a `/v4/cfdi33/stamp/`, que recibe «un comprobante CFDI 4.0 previamente sellado» ([timbrado V4](https://developers.sw.com.mx/knowledge-base/timbradov4-customid/))— y **`CALCULAR_SELLO` / `CERT_DEFAULT` de Prodigia**.
- En cancelación aplica la misma vara, y ahora con fuente normativa: RMF 2026 regla 2.7.2.9, último párrafo — «Los contribuyentes emisores de CFDI, para efectuar la cancelación de los mismos, deberán hacerlo **con su CSD**». Es decir, el método del PAC tiene que aceptar una solicitud **ya firmada** (`enviarSolicitudCancelacionAsincrono` en Solución Factible, `cancel_signature` en Finkok); si no, cancelar exige entregarle el CSD al proveedor, y cancelar es irreversible.

---

## El estado real del código

Cuatro adaptadores en [`src/services/integrations/mexico/pac/`](https://github.com/sedecim-com/Accounting/blob/main/src/services/integrations/mexico/pac/):

| Adaptador | `simulado` | Qué hace hoy |
|---|---|---|
| `finkok-adapter.ts` | `true` | Fabrica el UUID con `crypto.randomBytes`. No habla con nadie. |
| `sw-sapien-adapter.ts` | `true` | Ídem. |
| `edicom-adapter.ts` | `true` | Ídem. |
| `sovos-reachcore-adapter.ts` | **`false`** (línea 128) | El único escrito contra el contrato real: ambientes `oat.reachcore.com` / `go.reachcore.com` (líneas 53-54), `METODOS_PROHIBIDOS` declarados y la autorización `55267` escrita a mano (líneas 156 y 171). Sin credenciales, no timbra. |

**Corrección — Sovos ya está registrado.** Esta página decía que `sovosReachcoreAdapter` estaba en el diccionario `PAC_ADAPTERS` pero nunca pasaba por `integrationRegistry.register()`, y que era «capacidad huérfana». **Ya no es cierto.** [`pac-router.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/integrations/mexico/pac/pac-router.ts) líneas 45-47 recorren el diccionario y registran los cuatro; entró con **G1a**, que está en `main`. El comentario que quedó escrito arriba explica el efecto que se medía: `PUT /v1/admin/integrations/sovos_reachcore` moría en `PROVIDER_NOT_FOUND`, «así que el ÚNICO adaptador que no fabrica el folio (`simulado = false`) era el único que no se podía dar de alta por la API». `PAC_ADAPTERS` se exporta a propósito para que una prueba pueda cotejarlo contra el registry.

Lo que sigue mal, y ahora en peor forma:

**`edicom` continúa de terciario por omisión — y ahora también registrado.** `getPreferences()` (líneas 68-72) sigue devolviendo `finkok → sw_sapien → edicom`, y `savePreferences` (líneas 83-95) vuelve a incrustar los mismos tres literales como respaldo del `COALESCE`. Como el registro ahora recorre el diccionario, el simulador **sin documentación pública verificable** aparece hoy en `GET /v1/admin/integrations`, cosa que antes no pasaba. El cerrojo de simulación lo detiene en producción, pero un terciario que nunca podrá ser real ocupa el lugar de uno que sí.

**La elección de proveedor sigue fuera del panel de políticas.** [`pending-catalog.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/policy/pending-catalog.ts) tiene 39 claves y **ninguna de PAC**. La tabla `pac_preferences` solo aparece en el router y en la lista de tablas exportables. Quién es el primario, quién el secundario y si hay `auto_failover` son bifurcaciones de criterio del despacho, y hoy no son auditables como las demás decisiones contables ([[El-tablero-y-los-criterios]]).

**No existen `PacProviderSpec` ni `PacAdapterBase`.** El único `autorizacionSat` del árbol está escrito a mano en el adaptador de Sovos. No hay `timbradoPresellado`, ni `dedupReintento`, ni `customId` en ninguna parte del código.

Lo que **sí** protege, y conviene saberlo antes de temer de más:

- El **cerrojo antisimulación** de [`simulacion.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/integrations/mexico/pac/simulacion.ts): `simulacionPermitida()` es falso en producción sin excepción, y `estadoParaPersistir` guarda un resultado simulado como `failed`, nunca como `stamped` — en las dos vías, facturas y nómina.
- La **guarda contra el failover del «ya timbrado»** (`pac-router.ts:185-196`): si el primer PAC contesta `PAC_YA_TIMBRADO`, el router no pasa al siguiente, porque «el mismo documento acaba con DOS folios fiscales, y el segundo no se puede cancelar sin que el primero quede huérfano».
- La **cancelación retirada a propósito**: `invoices.ts:321-337` lanza `NotImplementedError` con el motivo escrito —«Media cancelación es peor que ninguna»— y enumera las cuatro piezas que faltan. Hay un criterio vigilándolo ([`criterios.ts:2322`](https://github.com/sedecim-com/Accounting/blob/main/src/plan/criterios.ts)): falla si reaparece `cfdi_status = 'cancelled'` sin llamar al PAC.
- La **consulta de estatus ante el SAT ya es real**: [`cfdi-status.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/sat/cfdi-status.ts) habla con `ConsultaCFDIService` y lee `CodigoEstatus`, `Estado`, `EsCancelable`, `EstatusCancelacion` y `ValidacionEFOS`. La precondición que el SAT exige antes de cancelar ya está resuelta.

---

## Los proveedores investigados

Verificación del 2 de septiembre de 2026, en dos pasadas ([expediente](https://github.com/sedecim-com/Accounting/blob/main/docs/investigacion/2026-09-02-mejores-practicas/pacs.md), que extiende una primera investigación de agosto de 2026). La columna de autorización sale del PDF oficial del SAT [«Proveedores de Certificación — Contacto»](https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461173552641&ssbinary=true), 86 páginas, cuyo texto se extrajo y se cotejó dato por dato. Ojo con la fecha: ese PDF es de **febrero de 2019**. Sirve para identificar, no para acreditar vigencia en 2026 — el padrón moderno del SAT no es consultable por máquina (dos rutas devuelven 403, una tercera ni acepta conexión).

| Proveedor | Aut. SAT | API | XML pre-sellado | Sandbox | Documentación verificada | Papel en el plan |
|---|---|---|---|---|---|---|
| SW sapien (Luna Soft) | 16543 | REST/JSON | Sí, por `/v4/cfdi33/stamp/`; `customId` deduplica reintentos 72 h y devuelve `CFDI3307` | Autoservicio, con CSD de prueba | [Timbrado V4](https://developers.sw.com.mx/knowledge-base/timbradov4-customid/) · [portal](https://developers.sw.com.mx/) | **Primario** |
| Solución Factible (SFERP) | 54555 | SOAP | Sí (`timbrar` / `timbrarBase64`); cancelación firmada por `enviarSolicitudCancelacionAsincrono`, con `getStatusCancelacionAsincrona` para el acuse | `testing.solucionfactible.com`, credenciales publicadas | [ws-timbrado](https://solucionfactible.com/sfic/capitulos/timbrado/ws-timbrado.jsp) · [ws-cancelacion](https://solucionfactible.com/sfic/capitulos/timbrado/ws-cancelacion.jsp) | **Candidato a secundario** |
| XPD / Expidetufactura | 55505 | SOAP y REST | Sí: «el CFDI a timbrar codificado en base64», sellado por el cliente | QA público con credenciales de prueba | [WSDLs por ambiente](https://xpd.mx/soporte/servicio-web-wsdl-en-sus-diferentes-ambientes.html) | **Candidato a secundario** |
| Formas Digitales | 55502 | SOAP | Sí, explícito: «primero se necesitan firmarlos» | Sí (URLs dentro del portal) | [api-docs](https://forsedi.facturacfdi.mx/developers/api-docs) | Reserva documentada |
| Prodigia (PADE) | 09763 | REST y SOAP | **No acreditado** (ver corrección abajo) | `pruebas.pade.mx`, infraestructura aparte | [api-timbrado-xml](https://docs.prodigia.com.mx/api-timbrado-xml.html) (solo el subdominio `docs` responde) | **Degradado**: pregunta abierta al proveedor |
| Finkok | 10852 | SOAP (WSDL público, ocho operaciones) | Sí (`stamp`, `quick_stamp`; jamás `sign_stamp`) | Gratuito, autoservicio | [stamp.wsdl](https://demo-facturacion.finkok.com/servicios/soap/stamp.wsdl) — incluye `stamped` para consultar sin reenviar | Terciario, diferido |
| Sovos (Reachcore) | 55267 | SOAP (una operación: `TimbrarComprobante`, ApiKey en cabecera) | Sí | `oat.reachcore.com` | [WSDL de producción](https://go.reachcore.com/api/ws/6.0/pacservices/Timbre.svc/basic?wsdl) | Adaptador escrito **y ya registrado** |
| Edicom | 70029 | Sin documentación pública | No verificable | — | Solo [marketing](https://edicomgroup.com/es/) | Se retira de defaults y registro |
| Interfactura | 54812 | Sin documentación pública | No verificable | — | [Home sin liga técnica](https://www.interfactura.com) | Excluido |
| Facturación Moderna | 58077 | SOAP | Sí (según agosto) | **Demo roto: certificado TLS caducado desde sep-2025, seguía así en sep-2026** | — | Descartada |
| Facturama | **No es PAC** (cero apariciones en las 86 páginas del PDF) | REST | **No**: exige llave privada + contraseña | Sí | [carga de CSD](https://apisandbox.facturama.mx/guias/api-multi/csds) | Excluido por la regla de custodia |
| Diverza | 70032 — **sin efectos desde el 27-dic-2018**, textual en el apéndice del PDF | — | — | — | Portal muerto por DNS | Excluido por partida doble |

**Corrección — Prodigia se debilita como secundario.** Esta página afirmaba: «Sí (`certBase64`/`keyBase64` son opcionales — no se usan)». Re-leída con una pregunta más estrecha, la documentación de Prodigia **no describe** un modo en que el cliente mande un XML ya sellado y el proveedor solo timbre. Documenta lo contrario: el XML llega sin sellar y la opción **`CALCULAR_SELLO`** le pide a Prodigia que calcule el sello, con `certBase64`/`keyBase64` en la llamada o con **`CERT_DEFAULT`**, un certificado **previamente cargado en su base de datos**. Cuando `CALCULAR_SELLO` se omite, la guía solo pide que el comprobante «esté previamente llenado con la estructura correcta»: no aclara si acepta un sello ajeno. No queda descartada — queda **sin acreditar**, y `CERT_DEFAULT` es exactamente la trampa que en Sovos costó una lista de métodos prohibidos. Antes de escribir una línea de ese adaptador hay que preguntárselo al proveedor **por escrito**.

Consecuencia sobre el orden: **los «de reserva» documentan mejor el pre-sellado que el que era secundario.** Formas Digitales lo dice con todas sus letras, XPD lo dice y publica credenciales de prueba, Solución Factible expone `timbrarBase64` con endpoints y usuario de prueba abiertos. El segundo proveedor real puede ser XPD o Solución Factible con menos riesgo de acabar entregando el CSD.

Sobre precios: el único público verificado es el de SW (1,200 timbres, $2,266 MXN + IVA, [tienda](https://tienda.sw.com.mx/shop/ecommerce-1200-timbres-fiscales-digitales-para-odoo-2649), hoy marcado sin stock — referencia, no oferta). El de Finkok tampoco se pudo reconfirmar: su página de precios da 404 y el FAQ donde lo indexan los buscadores tiene el certificado TLS caducado. Los demás no publican nada, ni tarifa, ni límites de tasa, ni caducidad de timbres, ni qué pasa al agotarse el saldo a mitad de un lote. Contar con negociar, y con anotar lo contratado de verdad.

---

## Lo que la norma exige y el código todavía no sabe

Cinco cosas salieron de leer la RMF 2026 y el [Esquema de cancelación de CFDI 2026](https://www.sat.gob.mx/minisitio/Factura/documentos/EsquemaCancelacionCFDI.pdf) contra el árbol. Ninguna es opinión.

**1. El failover entre PACs distintos puede producir dos folios para la misma factura.** La regla **2.7.2.9 fr. II** obliga al proveedor a validar «que el documento no haya sido previamente certificado **por el propio proveedor de certificación**». *Por el propio.* La deduplicación es **por PAC, no global**. El router ya no cambia de proveedor cuando el primero contesta `PAC_YA_TIMBRADO`, pero ese camino solo se recorre cuando el primero **contesta**; en el timeout —que es justo el caso para el que existe el failover— el segundo no tiene forma de saber que el primero ya timbró. La regla que falta escribir es una sola: **antes de mandar el mismo XML a un proveedor distinto, resolver el timeout consultando al primero** (`stamped` en Finkok, `cfdiPorUUID` en Prodigia, `customId` en SW). Reintentar contra el *mismo* proveedor con `customId` es seguro; cambiar de proveedor sin consultar, no.

**2. Los dos relojes del timbrado, que se verifican sin salir a la red.** Regla **2.7.2.9 fr. I**: entre la generación y la certificación no pueden pasar **más de 72 horas**, ni el periodo puede ser **menor a cero**, «haciendo uso del huso horario correspondiente al Código Postal registrado en el campo `LugarExpedicion`». El [catálogo de errores 401 de Solución Factible](https://solucionfactible.com/sfic/manuales/manual-errores/401.jsp) lo traduce: 72 horas de antigüedad máxima, y no más de **5 minutos** de adelanto —**65 en Quintana Roo**—. Tres consecuencias: una factura de hace cuatro días no se puede timbrar y hoy se gasta el intento averiguándolo; el `LugarExpedicion="00000"` de la nómina (línea 104 del generador) hace imposible resolver el huso, o sea rechazo seguro; y el reloj del servidor importa.

**3. La cancelación es asíncrona y dura días, no una llamada que devuelve 200.** Regla **2.7.1.34**: el receptor tiene **tres días** para manifestarse y «el SAT considerará que el receptor **acepta** la cancelación» si guarda silencio. La misma regla obliga a cancelar antes los CFDI relacionados, y el esquema del SAT lo repite: «Un CFDI es **No cancelable** si tiene al menos un documento relacionado vigente» — una factura PPD con REP vivo no se cancela hasta cancelar el REP. El plazo del emisor llega hasta el mes de la declaración anual del ejercicio en que se expidió (art. 29-A del CFF), después de lo cual el sistema debe **negarse y decir por qué**. Y el **acuse** es lo que prueba la cancelación ante una revisión: sin acuse archivado, la cancelación es un rumor. Nada de esto cabe en el vocabulario actual: [`002_ap_ar_schema.sql:223`](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrations/002_ap_ar_schema.sql) admite `CHECK (cfdi_status IN ('pending','stamped','cancelled','failed'))`, y el SAT tiene del lado del emisor al menos cuatro desenlaces más —en espera de aceptación, cancelado con aceptación, solicitud rechazada, cancelado por plazo vencido—. Hoy no hay dónde escribir «en espera de aceptación», y ese estado dura tres días.

**4. No hay régimen de contingencia. La única red son las 72 horas.** Se buscó en las 666 páginas de la RMF: nada sobre caída de proveedor. De ahí se siguen tres cosas que el sistema no hace: un segundo PAC con credenciales **cargadas y probadas de antemano** (el router tiene `getAllHealth()` en la línea 246, pero su único llamador es la ruta de administración `GET /v1/admin/integrations/pac/preferences/all` — no hay comando ni chequeo periódico, y un failover cuyo destino nunca se ejercitó es una esperanza, no un failover); el failover del punto 1; y una **cola**, porque con 72 horas de margen un timbrado que falla no debería perderse — hoy `pacRouter.stamp` lanza `ALL_PACS_FAILED` y ahí termina.

**5. El PAC puede perder la autorización, y Diverza es el precedente que ya está en el expediente.** La RMF dedica tres reglas al asunto (2.7.2.11 amonestaciones, 2.7.2.12 revocación, 2.7.2.13 liquidación con aviso de noventa días). Como el padrón vivo es inalcanzable por máquina, lo menos malo —y hay que decirlo así— es **anotar en la ficha del proveedor la fecha de la última verificación manual** y avisar cuando pase de un año. No es automatizable hoy; fingir que lo es sería la clase de falso verde que este repositorio ya purgó una vez.

**Y un ancla gratis.** El PDF del SAT publica el **CSD para Timbrado** de cada PAC — Finkok `00001000000405332712`, SW SmarterWeb `00001000000301634628` — que es el `NoCertificadoSAT` que debe venir dentro del `TimbreFiscalDigital`; la regla **2.7.2.2** confirma que su publicación es obligación del SAT. Los simuladores del árbol devuelven `00001000000500000000`, `…600000000` y `…700000000`: números redondos que ningún SAT emitió. Cotejarlo es una línea de código con fuente oficial detrás que ningún folio fabricado sobrevive.

---

## El plan de precarga

Nada de esta sección existe todavía, salvo lo que abajo se marca como hecho. Es la dirección acordada, con su porqué.

La clave: **precargar no es simular.** Un adaptador real sin credenciales es seguro por construcción — `getAllHealth()` lo reporta con `configured: false` (`pac-router.ts:246-258`) y no puede timbrar. Lo peligroso es lo que hoy existe: adaptadores que fabrican folios. La precarga consiste en **sustituir simuladores por esqueletos reales vacíos**, no en agregar simuladores.

**La ficha por proveedor (`PacProviderSpec`).** Hechos, no criterio, así que vive en código junto al adaptador, jamás en un json de configuración: número de autorización del SAT, RFC del proveedor, URLs base por ambiente (nunca rutas con datos), tipo de autenticación con la **fuente nombrada** de la credencial (`api_key_env` o `api_key_cmd` — el valor jamás está en la ficha), la fecha de la última verificación manual de vigencia, y las capacidades: `timbradoPresellado: true` como **tipo literal**, de modo que la regla de la casa se vuelve invariante del compilador. Ese literal tiene ahora un segundo efecto útil: **tampoco se puede escribir la ficha de Prodigia** mientras el proveedor no confirme por escrito que acepta un sello ajeno. La invariante se convierte en la salvaguarda de una pregunta comercial sin responder. `metodosProhibidos` incluye `/v4/cfdi33/issue/` de SW y `CALCULAR_SELLO`/`CERT_DEFAULT` de Prodigia, no solo los de Sovos.

**El esqueleto común (`PacAdapterBase`).** Resolución de credenciales desde la fuente nombrada (nunca de disco), timeouts, mapeo de errores del proveedor a códigos canónicos (`PAC_AUTH`, `PAC_RECHAZO`, `PAC_DUPLICADO`, `PAC_INDISPONIBLE`) y la política de reintento condicionada a la deduplicación: **solo se reintenta un timbrado cuando el proveedor garantiza no duplicar**; sin garantía, un timeout se resuelve consultando, jamás reenviando, y **jamás cambiando de proveedor** sin haber consultado.

**El orden.**

0. **El sellador de CFDI** — cadena original y firma. No es un tramo de esta página, pero está antes que todos: hasta que exista, ningún adaptador real puede timbrar. Ver §2.1 de [`BRECHAS-PARA-LA-PERFECCION.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/BRECHAS-PARA-LA-PERFECCION.md).
1. **Tramo A (chico)** — higiene, sin red ni credenciales. Su primer punto, registrar `sovosReachcoreAdapter`, **ya está hecho** (G1a). Quedan: retirar `edicom` de los defaults y del registro —sus apariciones se van juntas, y ahora incluyen el comentario desfasado de `cfdi-nomina-generator.ts:135`, que sigue diciendo «failover Finkok → SW Sapien → Edicom» cuando el router ya enruta cuatro— y dar a la capacidad PAC su fila en el catálogo de mínimos con su criterio. Cabe aquí, y es barato, el cotejo del `NoCertificadoSAT`.
2. **Tramo B (mediano)** — `PacProviderSpec` + `PacAdapterBase` + **SW sapien real contra sandbox** (requiere alta autoservicio en su portal). El simulador actual se reemplaza, no convive. Incluye la validación local de los dos relojes y migrar la elección de proveedores de `pac_preferences` al panel de políticas con su lector.
3. **Tramo C (mediano) — reabierto** — el segundo proveedor real. Ya no es Prodigia por omisión: la candidatura pasa a **XPD o Solución Factible**, que documentan el pre-sellado, y a Prodigia solo si contesta por escrito. Con él, la prueba de failover *consultando antes de reenviar*.
4. **Tramo D (grande, diferido)** — Finkok por SOAP, cuando haga falta un tercero real o un cliente lo pida.

**Las decisiones que no son del código:** reconfirmar **a mano**, en el portal del SAT, la vigencia 2026 de las autorizaciones antes de firmar contrato —el PDF de 2019 identifica, no acredita—, y hacerle a Prodigia la pregunta del pre-sellado por escrito antes de gastar una línea en su adaptador.

---

## Lo que esta página decía y no era

Se corrige a la vista, porque una wiki que se reescribe en silencio le miente a quien la leyó ayer:

- **«Sovos está registrado a medias / es capacidad huérfana.»** Falso desde G1a: `pac-router.ts:45-47` registra los cuatro adaptadores recorriendo el diccionario. El renglón sale del Tramo A.
- **«Prodigia acepta XML pre-sellado; `certBase64`/`keyBase64` son opcionales.»** No acreditado. Su documentación describe `CALCULAR_SELLO` y un certificado precargado (`CERT_DEFAULT`). Baja de secundario a candidato con pregunta abierta.
- **«Mandamos el XML ya sellado por mnemosine.»** No hay quién lo selle: `generateCfdiXml` no existe. La página lo daba por supuesto en todas sus secciones; ahora lo dice arriba.
- **Efecto lateral de la corrección de Sovos:** al registrar recorriendo el diccionario, `edicom` **también** quedó registrado. La página anterior lo llamaba «terciario por omisión»; hoy además es visible en `GET /v1/admin/integrations`.

---

## Para seguir

- [[Fiscal-mexicano]] — lo fiscal que sí existe hoy: espejo CFDI, estatus ante el SAT, el REP como recepción.
- [[Onboarding-de-contabilidad]] — la otra mitad de la relación con el SAT: el XML del Anexo 24 como formato de intercambio.
- [[Hoja-de-ruta]] — dónde caen el sellador y los tramos A-D en el plan.
- [[El-tablero-y-los-criterios]] — por qué la elección de PAC pertenece al panel de políticas y no al router.
- [[El-agente-y-sus-limites]] — por qué timbrar jamás será una herramienta que el agente invoque solo.
- [[Arquitectura]] — el registry de integraciones y la convención `simulado`.
