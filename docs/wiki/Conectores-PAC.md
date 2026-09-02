# Conectores PAC

Un PAC —Proveedor Autorizado de Certificación— es quien timbra el CFDI ante el SAT: recibe el comprobante, le estampa el folio fiscal y lo reporta. Esta página es el mapa de conexión: qué hay en el código hoy, qué proveedores se investigaron y con qué evidencia, y en qué orden se planea construir.

Lo que no es: una promesa. **Hoy mnemosine no timbra en producción con ningún PAC.** Hacerlo requerirá un contrato firmado con el proveedor, credenciales que este repositorio no trae, y una verificación manual de vigencia que ninguna fuente legible por máquina acredita (ver abajo). Lo que sí existe en materia fiscal —el espejo de CFDI, la consulta de estatus ante el SAT— está en [[Fiscal-mexicano]].

---

## La regla de custodia, primero

El CSD —el certificado de sello digital del contribuyente, con su llave privada— vive en la bóveda y **no sale de ahí**. Al PAC solo viaja XML **ya sellado** por mnemosine. De esa regla se deriva todo lo demás de esta página:

- Solo se consideran proveedores cuyo flujo **por omisión** acepte el XML pre-sellado. El que exige subir la llave `.key` con su contraseña queda fuera sin discusión: Facturama la pide «exclusivamente por este medio», por RFC emisor, sin alternativa — y además el PDF oficial del SAT confirma que ni siquiera es PAC ([guía de carga de CSD](https://apisandbox.facturama.mx/guias/api-multi/csds)).
- Los métodos del proveedor que sellan por ti se declaran **prohibidos en el propio adaptador**. El de Sovos ya trae la lista `METODOS_PROHIBIDOS` ([`sovos-reachcore-adapter.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/integrations/mexico/pac/sovos-reachcore-adapter.ts), línea 66); el plan de fichas (abajo) codifica lo mismo por proveedor: `sign_stamp` de Finkok, los campos `certBase64`/`keyBase64` de Prodigia, etcétera.
- En cancelación aplica la misma vara: la solicitud de cancelación la **firma el emisor** y el PAC solo la transmite. Esa exigencia degradó a Solución Factible en la primera pasada de investigación y la rehabilitó la segunda, cuando se verificó que su método `enviarSolicitudCancelacionAsincrono` recibe la solicitud ya firmada ([ws-cancelacion](https://solucionfactible.com/sfic/capitulos/timbrado/ws-cancelacion.jsp)).

---

## El estado real del código

Cuatro adaptadores en [`src/services/integrations/mexico/pac/`](https://github.com/sedecim-com/Accounting/blob/main/src/services/integrations/mexico/pac/):

| Adaptador | `simulado` | Qué hace hoy |
|---|---|---|
| `finkok-adapter.ts` | `true` | Fabrica el UUID con `crypto.randomBytes`. No habla con nadie. |
| `sw-sapien-adapter.ts` | `true` | Ídem. |
| `edicom-adapter.ts` | `true` | Ídem. |
| `sovos-reachcore-adapter.ts` | **`false`** (línea 128) | El único escrito contra el contrato real: ambientes `oat.reachcore.com` / `go.reachcore.com` (líneas 53-54) y `METODOS_PROHIBIDOS` declarados. Sin credenciales, no timbra. |

Dos hechos incómodos que conviene decir antes que las virtudes:

**Sovos está registrado a medias.** [`pac-router.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/integrations/mexico/pac/pac-router.ts) lo tiene en el diccionario `PAC_ADAPTERS` (línea 28) pero nunca lo pasa por `integrationRegistry.register()` (líneas 21-23 registran solo finkok, sw_sapien y edicom): el router lo enruta y el registry no lo conoce. Es la forma exacta de capacidad huérfana que `doctor` reporta pero nunca marca como `fail`.

**El terciario por omisión es el proveedor sin documentación.** Los defaults de `getPreferences()` (líneas 52-54) son `finkok → sw_sapien → edicom`, y Edicom es el único de los tres sin documentación pública verificable: su antigua página de desarrolladores hoy redirige en cadena hasta [material comercial](https://edicomgroup.com/es/) sin WSDL ni referencia de API. Un simulador como terciario de producción es una trampa esperando; el plan lo retira.

Lo que sí protege desde ya: el cerrojo antisimulación de [`simulacion.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/integrations/mexico/pac/simulacion.ts). `simulacionPermitida()` es falso en producción sin excepción, y un resultado simulado se persiste como `failed`, nunca como `stamped`. Los simuladores no pueden colar folios inventados al mayor — pero tampoco existe hoy ningún camino que timbre de verdad.

---

## Los proveedores investigados

Verificación del 2 de septiembre de 2026 (segunda pasada; la primera está en [`docs/investigacion/pac-proveedores.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/investigacion/pac-proveedores.md)). La columna de autorización sale del PDF oficial del SAT [«Proveedores de Certificación — Contacto»](https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461173552641&ssbinary=true) (86 páginas, con razón social, RFC y número de autorización por PAC). Ojo con la fecha: ese PDF es de **febrero de 2019**. Sirve para identificar, no para acreditar vigencia en 2026 — el portal moderno del SAT no es consultable por máquina (la SPA devuelve armazón vacío y las rutas viejas responden 403 o rechazan la conexión).

| Proveedor | Aut. SAT | API | XML pre-sellado | Sandbox | Documentación verificada | Papel en el plan |
|---|---|---|---|---|---|---|
| SW sapien (Luna Soft) | 16543 | REST/JSON | Sí; `customId` deduplica reintentos 72 h | Autoservicio, con CSD de prueba | [Timbrado V4](https://developers.sw.com.mx/knowledge-base/timbradov4-customid/) · [portal](https://developers.sw.com.mx/) | **Primario** |
| Prodigia (PADE) | 09763 | REST y SOAP | Sí (`certBase64`/`keyBase64` son opcionales — no se usan); `cfdiPorUUID` para el timeout ambiguo | `pruebas.pade.mx`, infraestructura aparte | [api-timbrado-xml](https://docs.prodigia.com.mx/api-timbrado-xml.html) (solo el subdominio docs responde; los dominios comerciales fallan) | **Secundario** |
| Finkok | 10852 | SOAP (WSDL público) | Sí (`stamp`, `quick_stamp`; jamás `sign_stamp`) | Gratuito, autoservicio | [stamp.wsdl](https://demo-facturacion.finkok.com/servicios/soap/stamp.wsdl) — incluye `stamp_async` y `stamped` para consultar sin reenviar | **Terciario, diferido** |
| Sovos (Reachcore) | 55267 | SOAP (una operación: `TimbrarComprobante`, ApiKey en header) | Sí | `oat.reachcore.com` | [WSDL de producción](https://go.reachcore.com/api/ws/6.0/pacservices/Timbre.svc/basic?wsdl) | Adaptador ya escrito; falta registrarlo |
| Solución Factible (SFERP) | 54555 | SOAP | Sí; cancelación firmada vía `enviarSolicitudCancelacionAsincrono` | `testing.solucionfactible.com`, credenciales publicadas | [ws-timbrado](https://solucionfactible.com/sfic/capitulos/timbrado/ws-timbrado.jsp) · [ws-cancelacion](https://solucionfactible.com/sfic/capitulos/timbrado/ws-cancelacion.jsp) | Reserva documentada, sin código |
| Formas Digitales | 55502 | SOAP | Sí («previamente firmado») | Sí (URLs dentro del portal) | [api-docs](https://forsedi.facturacfdi.mx/developers/api-docs) | Reserva |
| XPD / Expidetufactura | 55505 | SOAP y REST | Sí (base64, sellado por el cliente) | QA público, credenciales de prueba publicadas | [WSDLs por ambiente](https://xpd.mx/soporte/servicio-web-wsdl-en-sus-diferentes-ambientes.html) | Reserva |
| Edicom | 70029 | Sin documentación pública | No verificable | — | Solo [marketing](https://edicomgroup.com/es/) | Se retira de defaults y registro |
| Interfactura | 54812 | Sin documentación pública | No verificable | — | [Home sin liga técnica](https://www.interfactura.com) | Excluido |
| Facturación Moderna | 58077 | SOAP | Sí (según la primera pasada) | **Demo roto: certificado TLS caducado desde sep-2025, seguía así en sep-2026** | — | Descartada |
| Facturama | **No es PAC** (ausente del PDF del SAT) | REST | **No**: exige llave privada + contraseña | Sí | [carga de CSD](https://apisandbox.facturama.mx/guias/api-multi/csds) | Excluido por la regla de custodia |
| Diverza | 70032 — **sin efectos desde el 27-dic-2018** según el PDF | — | — | — | Portal muerto por DNS | Excluido por partida doble |

Sobre precios: el único público verificado es el de SW (1,200 timbres, $2,266 MXN + IVA, [tienda](https://tienda.sw.com.mx/shop/ecommerce-1200-timbres-fiscales-digitales-para-odoo-2649), hoy marcado sin stock — referencia, no oferta). Todos los demás: no publicados. Contar con negociar.

---

## El plan de precarga

Nada de esta sección existe todavía. Es la dirección acordada, con su porqué.

La clave: **precargar no es simular.** Un adaptador real sin credenciales es seguro por construcción — `listProviders()` lo reporta como sin configurar y no puede timbrar. Lo peligroso es lo que hoy existe: adaptadores que fabrican folios. La precarga consiste en **sustituir simuladores por esqueletos reales vacíos**, no en agregar simuladores.

**La ficha por proveedor (`PacProviderSpec`).** Hechos, no criterio, así que vive en código junto al adaptador, jamás en un json de configuración: número de autorización del SAT, RFC del proveedor, URLs base por ambiente (nunca rutas con datos), tipo de autenticación con la **fuente nombrada** de la credencial (`api_key_env` o `api_key_cmd` — el valor jamás está en la ficha), y las capacidades: `timbradoPresellado: true` como **tipo literal**, de modo que la regla de la casa se vuelve invariante del compilador — la ficha de Facturama no compila. También el mecanismo de deduplicación (`customId` en SW, consulta por UUID en Prodigia y Finkok) y los métodos prohibidos.

**El esqueleto común (`PacAdapterBase`).** Resolución de credenciales desde la fuente nombrada (nunca de disco), timeouts, mapeo de errores del proveedor a códigos canónicos (`PAC_AUTH`, `PAC_RECHAZO`, `PAC_DUPLICADO`, `PAC_INDISPONIBLE`) y la política de reintento condicionada a la deduplicación: **solo se reintenta un timbrado cuando el proveedor garantiza no duplicar**; sin garantía, un timeout se resuelve consultando (`stamped`, `cfdiPorUUID`), jamás reenviando. Un timbre duplicado es un problema fiscal, no un reintento inocente.

**El orden.**

1. **Tramo A (chico)** — higiene, sin red ni credenciales: registrar `sovosReachcoreAdapter` en el registry, retirar `edicom` de los defaults y del registro (sus apariciones se van juntas), y dar a la capacidad PAC su fila en el catálogo de mínimos con su criterio.
2. **Tramo B (mediano)** — `PacProviderSpec` + `PacAdapterBase` + **SW sapien real contra sandbox** (requiere alta autoservicio en su portal). El simulador actual se reemplaza, no convive. Incluye migrar la elección de proveedores de `pac_preferences` al panel de políticas con su lector: primario/secundario/terciario, `auto_failover`, y si un ambiente no productivo puede timbrar contra el sandbox del PAC son bifurcaciones de criterio, y el criterio vive en el panel, no incrustado en un router.
3. **Tramo C (mediano)** — **Prodigia real** y la prueba de failover SW→Prodigia con dos proveedores de verdad distintos.
4. **Tramo D (grande, diferido)** — Finkok por SOAP, cuando haga falta un tercero real o un cliente lo pida.

**La decisión que no es del código:** antes de firmar contrato, reconfirmar **a mano** en el portal del SAT la vigencia 2026 de las autorizaciones 16543 (SW) y 09763 (Prodigia). El PDF de 2019 identifica; no acredita. Ninguna fuente legible por máquina lo hace hoy.

---

## Para seguir

- [[Fiscal-mexicano]] — lo fiscal que sí existe hoy: espejo CFDI, estatus ante el SAT.
- [[Onboarding-de-contabilidad]] — la otra mitad de la relación con el SAT: el XML del Anexo 24 como formato de intercambio.
- [[Hoja-de-ruta]] — dónde caen los tramos A-D en el plan.
- [[El-agente-y-sus-limites]] — por qué timbrar jamás será una herramienta que el agente invoque solo.
- [[Arquitectura]] — el registry de integraciones y la convención `simulado`.
