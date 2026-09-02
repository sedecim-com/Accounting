# PACs para precargar: verificación del 2 de septiembre de 2026

Extiende `docs/investigacion/pac-proveedores.md` (25-ago-2026). No repite lo ya verificado: dice qué cambió, qué se confirmó de nuevo y qué se encontró que la pasada anterior no tenía. La regla central se conserva intacta: **solo proveedores cuyo flujo por omisión acepte el XML ya sellado** — el CSD no sale de la bóveda.

## Dónde estamos

- Cuatro adaptadores en `src/services/integrations/mexico/pac/`: `finkok-adapter.ts`, `sw-sapien-adapter.ts`, `edicom-adapter.ts` (los tres `simulado = true`, fabrican UUID con `crypto.randomBytes`) y `sovos-reachcore-adapter.ts` (`simulado = false`, línea 128, con `METODOS_PROHIBIDOS` en la línea 66 y ambientes `oat.reachcore.com` / `go.reachcore.com` en las líneas 53-54).
- El cerrojo antisimulación vive en `simulacion.ts`: `simulacionPermitida()` es falso en producción sin excepción, y un resultado simulado se persiste como `failed`, nunca `stamped`.
- `pac-router.ts` registra en el registry solo tres adaptadores (líneas 21-23: finkok, sw_sapien, edicom). **`sovosReachcoreAdapter` está en el diccionario `PAC_ADAPTERS` (línea 28) pero nunca pasa por `integrationRegistry.register()`**: el router lo enruta y el registry no lo conoce. Es exactamente la forma de capacidad huérfana que `doctor` no marca como `fail`.
- Los defaults de `getPreferences()` (líneas 52-54) son `finkok → sw_sapien → edicom`. El terciario por omisión es el único proveedor **sin documentación pública verificable** (ver abajo).
- El registro general está en `src/services/integrations/index.ts`; los PAC entran por el import de `pac-router.js` (línea 8).

## La investigación: qué cambió desde el 25 de agosto

**1. Apareció una fuente oficial del SAT descargable — con límites.** El portal moderno sigue siendo inservible por máquina: la SPA de trámites devuelve armazón vacío, `sat.gob.mx/aplicacion/30796/...` responde 403 y el host `omawww` ya ni acepta conexiones en 443. Pero el buscador sacó un PDF servido por `www.sat.gob.mx` (Satellite/MungoBlobs): **«Proveedores de Certificación — Contacto»**, 86 páginas, una ficha por PAC con razón social, RFC, **número de autorización del SAT**, CSD de timbrado y fecha de publicación, más cuatro apéndices (revocados, no renovados, sin efectos, en liquidación). Metadatos del PDF: creado el 6-feb-2019. Es mejor que la lista 3.3 de 2018 que teníamos —trae los números de autorización que antes solo conocíamos para Prodigia y Sovos— pero **sigue sin acreditar vigencia 2026**: la advertencia de agosto se mantiene, hay que comprobar cada autorización a mano en el portal antes de firmar.

Números de autorización extraídos del PDF (todos con RFC): Finkok **10852** (FIN1203015JA), SW SmarterWeb/Luna Soft **16543** (LSO1306189R5), Prodigia **09763** (PPD101129EA3), Reachcore **55267** (ASE0201179X0), Solución Factible/SFERP **54555** (SFE0807172W8), Formas Digitales **55502** (FCG840618N51), Interfactura **54812** (INT020124V62), Edicom **70029** (EME000602QR9), Facturación Moderna **58077** (FMO1007168C6), Expidetufactura/XPD **55505** (CCC1007293K0), Diverza **70032** (DIA031002LZ2).

Dos datos duros del mismo PDF: **Facturama no aparece en ninguna parte** — confirma con fuente oficial que no es PAC, lo que en agosto solo sabíamos por su blog. Y **Diverza aparece en el apéndice «autorización ha quedado sin efectos», vigente hasta el 27-dic-2018**. Con su portal de desarrolladores todavía muerto por DNS (reintentado hoy: ENOTFOUND), Diverza queda excluida por partida doble.

**2. SW sapien: se verificó el mecanismo de idempotencia que faltaba.** La página de Timbrado V4 confirma el endpoint que recibe XML **previamente sellado**, Bearer token, sandbox `services.test.sw.com.mx` y producción `services.sw.com.mx` — y documenta **`customId`**: valor propio de hasta 100 caracteres que **deduplica reintentos durante 72 horas**. Eso resuelve el timeout ambiguo por otra vía que la de Prodigia (`cfdPorUUID`) y no estaba en el informe de agosto. El portal (`developers.sw.com.mx`) tiene sección de ambiente de pruebas con credenciales y CSD de prueba en autoservicio. Precio público en su tienda oficial: 1,200 timbres $2,266 MXN + IVA (la página lo marca «Not Available For Sale» hoy, tomarlo como referencia, no como oferta).

**3. Finkok: WSDL vivo y con dos operaciones no registradas antes.** El WSDL de demo volvió a resolverse hoy y define `stamp`, `quick_stamp`, `sign_stamp`, `stamped`, `query_pending`, `get_pdf` y —no mencionadas en agosto— **`stamp_async` y `get_result_async`**. `stamp` recibe `xml` (base64), `username`, `password`, como se documentó. El precio de agosto ($150 MXN/mes hasta 500 timbres) no se pudo reconfirmar hoy en página oficial: queda «no reconfirmado».

**4. Prodigia: la documentación oficial verificada, pero sus dominios comerciales fallan.** `docs.prodigia.com.mx/api-timbrado-xml.html` confirma: SOAP y REST, XML pre-sellado aceptado, `certBase64`/`keyBase64` **condicionales** (solo si quieres que ellos sellen — no usarlos), Basic + `contrato`, producción `timbrado.pade.mx`, pruebas `pruebas.pade.mx` con infraestructura independiente, y **`cfdiPorUUID` existe en SOAP y REST**. Ojo operativo nuevo: `pade.mx` corta la conexión (ECONNRESET) y `pade.com.mx` falla el handshake TLS desde aquí; la documentación vive solo en el subdominio `docs.prodigia.com.mx`. Precios: no publicados en fuente verificable.

**5. Sovos/Reachcore: el contrato sigue en pie.** El WSDL de producción responde hoy y define exactamente una operación, `TimbrarComprobante`, con `ApiKey` como header SOAP y transporte HTTPS obligatorio. Coincide con el adaptador escrito. Sin cambios.

**6. Solución Factible: la objeción de agosto tiene salida verificada.** El informe anterior la degradó porque «en cancelación sella el PAC». Hoy la página de su webservice de cancelación documenta **`enviarSolicitudCancelacionAsincrono`: recibe una solicitud de cancelación ya firmada** por el emisor, la verifica y la programa contra el SAT. Es decir: sí hay ruta que respeta la bóveda, igual que `cancel_signature` en Finkok — hay que llamar a ese método y no a `cancelarAsincrono`. Timbrado confirmado de nuevo: `timbrar`/`timbrarBase64`, testing `testing.solucionfactible.com/ws/services/Timbrado`, producción `solucionfactible.com/ws/services/Timbrado`, credenciales del panel del cliente. Sube de «confianza media» a candidata de reserva.

**7. Formas Digitales: portal de desarrolladores verificado.** `forsedi.facturacfdi.mx/developers/api-docs` documenta WS Timbrado y WS Cancelación y dice expresamente que el CFDI se manda «previamente firmado». La subpágina de URLs que intenté adivinar dio 404; las URLs concretas hay que sacarlas navegando el portal.

**8. Facturama: confirmado y cerrado.** Su guía de carga de CSD exige RFC + certificado base64 + **llave privada base64 + contraseña**, obligatorio por RFC emisor, «exclusivamente por este medio», sin alternativa de XML pre-sellado. Incompatible con la bóveda, y el PDF del SAT confirma que ni siquiera es PAC. Sus precios sí son públicos ($1,650 MXN/año el módulo API + $0.40-0.50 por timbre según volumen, IVA incluido) — irrelevantes dada la exclusión.

**9. Edicom e Interfactura: siguen sin documentación pública.** La antigua página de desarrolladores de Edicom (`cfdi.edicomgroup.com/en/resources/soft-developers/`) hoy redirige en cadena hasta `edicomgroup.com/es/`, puro material comercial sin WSDL ni referencia de API. El home de Interfactura no tiene ni liga a documentación técnica. Ninguno es integrable sin contacto comercial.

**10. Facturación Moderna: un año después, el demo sigue roto.** `t1demo.facturacionmoderna.com` presenta hoy (sep-2026) el mismo certificado caducado que se detectó en agosto (vencido 16-sep-2025). Sigue descartada.

**11. Candidato nuevo: XPD / Expidetufactura (autorización SAT 55505).** Su página de soporte publica WSDLs de QA y producción (`appliance-qa.expidetufactura.com.mx:8585` / `appliance.expidetufactura.com.mx:8585`), **SOAP y REST**, el cliente genera el XML **ya sellado** y lo manda en base64, autenticación usuario/contraseña, TLS 1.2+, y hasta credenciales de prueba publicadas (`testUser`/`1234`). Documentación de conexión más abierta que la de varios grandes. Entra a la tabla como reserva.

## Tabla comparativa

| Proveedor | Aut. SAT (PDF feb-2019) | API | XML pre-sellado | Autenticación | Sandbox | Documentación de conexión (verificada hoy) | Precio público |
|---|---|---|---|---|---|---|---|
| SW sapien (Luna Soft) | 16543 | REST/JSON + SDK Node | Sí (`stamp`; `customId` dedup 72 h) | Bearer token | Autoservicio, CSD de prueba | [Timbrado V4 customId](https://developers.sw.com.mx/knowledge-base/timbradov4-customid/) · [portal](https://developers.sw.com.mx/) | 1,200 timbres $2,266+IVA ([tienda](https://tienda.sw.com.mx/shop/ecommerce-1200-timbres-fiscales-digitales-para-odoo-2649), hoy sin stock) |
| Finkok | 10852 | SOAP 1.1 (WSDL público) | Sí (`stamp`, `quick_stamp`; jamás `sign_stamp`) | user/pass en cuerpo SOAP | Gratuito, autoservicio | [stamp.wsdl](https://demo-facturacion.finkok.com/servicios/soap/stamp.wsdl) | No reconfirmado hoy |
| Prodigia (PADE) | 09763 | REST/JSON y SOAP | Sí (cert/key opcionales — no usarlos); `cfdiPorUUID` | Basic + `contrato` | `pruebas.pade.mx`, infraestructura aparte | [docs api-timbrado-xml](https://docs.prodigia.com.mx/api-timbrado-xml.html) | No publicado |
| Sovos (Reachcore) | 55267 | SOAP (WCF); REST solo consultas | Sí (`TimbrarComprobante`, CDATA) | ApiKey (header SOAP) | `oat.reachcore.com` | [WSDL producción](https://go.reachcore.com/api/ws/6.0/pacservices/Timbre.svc/basic?wsdl) | No publicado |
| Solución Factible (SFERP) | 54555 | SOAP | Sí; cancelación firmada vía `enviarSolicitudCancelacionAsincrono` | user/pass del panel | `testing.solucionfactible.com` con credenciales publicadas | [ws-timbrado](https://solucionfactible.com/sfic/capitulos/timbrado/ws-timbrado.jsp) · [ws-cancelacion](https://solucionfactible.com/sfic/capitulos/timbrado/ws-cancelacion.jsp) | No publicado |
| Formas Digitales | 55502 | SOAP; SDK Java | Sí («previamente firmado») | user/pass | Sí (URLs dentro del portal) | [api-docs](https://forsedi.facturacfdi.mx/developers/api-docs) | No publicado |
| XPD / Expidetufactura | 55505 | SOAP y REST | Sí (base64, sellado por el cliente) | user/pass (demo publicado) | QA público | [WSDLs por ambiente](https://xpd.mx/soporte/servicio-web-wsdl-en-sus-diferentes-ambientes.html) | No publicado |
| Facturama | **No es PAC** (ausente del PDF SAT) | REST + SDKs | **No**: exige `.key` + contraseña por RFC | Basic | Sí | [carga de CSD](https://apisandbox.facturama.mx/guias/api-multi/csds) | $1,650/año + $0.40-0.50/timbre ([precios](https://facturama.mx/api-facturacion-electronica)) |
| Diverza | 70032 — **sin efectos desde 27-dic-2018** según el PDF | — | — | — | — | Portal muerto por DNS | — |
| Edicom | 70029 | Sin documentación pública | No verificable | — | — | Solo [marketing](https://edicomgroup.com/es/) | No publicado |
| Interfactura | 54812 | Sin documentación pública | No verificable | — | — | [Home sin liga técnica](https://www.interfactura.com) | No publicado |
| Facturación Moderna | 58077 | SOAP | Sí (agosto) | user/pass | **Demo roto: TLS caducado desde sep-2025, sigue así hoy** | — | No publicado |

## El mecanismo: precargar N adaptadores sin violar la regla de simulados

La clave: **precargar no es simular**. Un adaptador real sin credenciales es seguro por construcción — `listProviders()` lo reporta sin configurar y no puede timbrar. Lo peligroso es lo que hoy existe: adaptadores que fabrican folios. La precarga consiste en sustituir simuladores por esqueletos reales vacíos, no en agregar simuladores.

**1. La ficha por proveedor (`PacProviderSpec`)** — hechos, no criterio, así que vive en código junto al adaptador, jamás en json de configuración:

```ts
interface PacProviderSpec {
  providerId: string;                 // 'sw_sapien'
  autorizacionSat: string;            // '16543' — del PDF feb-2019; reconfirmar a mano
  rfcProveedor: string;               // 'LSO1306189R5'
  ambientes: { sandbox: string; produccion: string };  // solo base_url, nunca rutas con datos
  auth: { tipo: 'bearer' | 'soap_body_userpass' | 'apikey_soap_header' | 'basic_mas_contrato';
          fuente: 'api_key_env' | 'api_key_cmd' };     // NOMBRA la fuente; el valor jamás está aquí
  capacidades: {
    timbradoPresellado: true;         // literal true: un spec sin esto no compila
    cancelacionFirmada: boolean;
    recuperacionPorUuid: boolean;     // cfdiPorUUID (Prodigia), stamped (Finkok)
    dedupReintento: 'custom_id' | 'rechazo_311' | 'refid' | 'ninguno';
    transporte: 'rest' | 'soap';
    metodosProhibidos: readonly string[];  // sign_stamp, /certificates/save, EmitirComprobante…
  };
}
```

`timbradoPresellado: true` como tipo literal convierte la regla de la casa en invariante del compilador: no se puede escribir la ficha de Facturama.

**2. El esqueleto común.** `IPacAdapter` ya existe; falta una clase base `PacAdapterBase` que concentre lo que hoy repetiría cada adaptador: resolución de credenciales desde la fuente nombrada (nunca de disco), timeouts, mapeo de errores del proveedor a códigos canónicos (`PAC_AUTH`, `PAC_RECHAZO`, `PAC_DUPLICADO`, `PAC_INDISPONIBLE`) y la política de reintento condicionada a `dedupReintento` — solo se reintenta un timbrado cuando el proveedor garantiza no duplicar (customId en SW, rechazo 311 en Sovos, refid si algún día vuelve Diverza); con `'ninguno'`, el timeout se resuelve consultando (`stamped`/`cfdiPorUUID`), jamás reenviando.

**3. Orden de implementación recomendado.**
1. **Corregir el registro de Sovos** (`pac-router.ts:21-23`): está enrutable sin estar registrado.
2. **SW sapien real** (primario): REST, sandbox autoservicio, `customId` — el simulador actual se reemplaza, no convive.
3. **Prodigia real** (secundario): mismo contrato de timbrado (XML sellado en base64), `cfdiPorUUID` para el timeout ambiguo. Failover con proveedor de verdad distinto.
4. **Finkok** (terciario): exige cliente SOAP; su WSDL está verificado y estable.
5. **Reserva documentada, sin código**: Solución Factible (con `enviarSolicitudCancelacionAsincrono` obligatorio), Formas Digitales, XPD.
6. **Retirar `edicom` de los defaults** de `getPreferences()` y del registro: sin documentación pública no habrá implementación real, y un simulador como terciario de producción es una trampa esperando. Sus tres apariciones (import, register, PAC_ADAPTERS, default terciario) se van juntas.

**4. Qué decide quién.**
- **Ficha (código)**: hechos del proveedor — URLs, tipo de auth, capacidades, métodos prohibidos.
- **Registro + credenciales por inquilino**: qué proveedor tiene credenciales configuradas y de qué variable de entorno vienen (`api_key_env`); es estado, no criterio.
- **Panel de políticas (con su lector)**: las bifurcaciones de criterio — proveedor primario/secundario/terciario del inquilino, `auto_failover` sí/no, y si un ambiente no productivo permite timbrar contra sandbox del PAC. Hoy `pac_preferences` es una tabla suelta con defaults incrustados en el router; migrar esa elección al panel con lector la vuelve auditable como las demás decisiones contables.
- **Catálogo**: cada adaptador nuevo entra con su fila en el catálogo de mínimos y su criterio; el que no la tenga es capacidad huérfana por definición — exactamente el estado actual de `sovos_reachcore` en el registry.

## Qué entra al plan maestro

- **Tramo A (S)** — higiene: registrar `sovosReachcoreAdapter` en el registry, retirar `edicom` de defaults y registro, fila de catálogo + criterio para la capacidad PAC. Sin red, sin credenciales.
- **Tramo B (M)** — `PacProviderSpec` + `PacAdapterBase` + **SW sapien real contra sandbox** (requiere alta autoservicio en developers.sw.com.mx), con la migración de `pac_preferences` al panel de políticas y su lector.
- **Tramo C (M)** — **Prodigia real** (REST + `cfdiPorUUID`) y prueba de failover SW→Prodigia con proveedores de verdad distintos.
- **Tramo D (L, diferido)** — Finkok por SOAP; se activa cuando haga falta un tercer proveedor real o un cliente lo pida.
- **Decisión para el humano**: reconfirmar a mano, en el portal del SAT, la vigencia 2026 de las autorizaciones 16543 (SW) y 09763 (Prodigia) antes de firmar contrato — ninguna fuente legible por máquina lo acredita hoy.

## Ligas verificadas y muertas

**Verificadas hoy con WebFetch (16):**
1. https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461173552641&ssbinary=true — PDF oficial SAT «Proveedores de Certificación — Contacto» (feb-2019, 86 pp.)
2. https://developers.sw.com.mx/ — portal de desarrolladores SW sapien
3. https://developers.sw.com.mx/knowledge-base/timbradov4-customid/ — timbrado V4 pre-sellado, Bearer, customId
4. https://tienda.sw.com.mx/shop/ecommerce-1200-timbres-fiscales-digitales-para-odoo-2649 — precio público SW
5. https://demo-facturacion.finkok.com/servicios/soap/stamp.wsdl — WSDL Finkok con stamp/quick_stamp/sign_stamp
6. https://go.reachcore.com/api/ws/6.0/pacservices/Timbre.svc/basic?wsdl — WSDL Sovos, TimbrarComprobante + ApiKey
7. https://docs.prodigia.com.mx/api-timbrado-xml.html — Prodigia REST/SOAP, cfdiPorUUID, cert/key opcionales
8. https://solucionfactible.com/sfic/capitulos/timbrado/ws-timbrado.jsp — timbrado SF, URLs testing/producción
9. https://solucionfactible.com/sfic/capitulos/timbrado/ws-cancelacion.jsp — enviarSolicitudCancelacionAsincrono (solicitud ya firmada)
10. https://forsedi.facturacfdi.mx/developers/api-docs — Formas Digitales, CFDI previamente firmado
11. https://xpd.mx/soporte/servicio-web-wsdl-en-sus-diferentes-ambientes.html — XPD, WSDLs QA/producción, XML sellado por el cliente
12. https://apisandbox.facturama.mx/guias/api-multi/csds — Facturama exige llave privada + contraseña
13. https://apisandbox.facturama.mx/guias/historial-actualizaciones — historial API Facturama
14. https://facturama.mx/api-facturacion-electronica — precios públicos Facturama
15. https://www.interfactura.com — sin liga a documentación técnica
16. https://edicomgroup.com/es/ — solo material comercial, sin WSDL ni API reference

**Muertas o no verificables (9):**
1. https://www.sat.gob.mx/portal/public/tramites/lista-de-proveedores-autorizados-de-certificacion-de-cfdi — SPA, contenido vacío para fetch
2. https://www.sat.gob.mx/aplicacion/30796/proveedor-de-certificacion-de-factura-electronica- — HTTP 403
3. http://omawww.sat.gob.mx/informacion_fiscal/factura_electronica/Paginas/PACS3_3.aspx — ECONNREFUSED en 443 (en agosto aún servía la lista 3.3 de 2018)
4. https://desarrolladores.diverza.com/timbre/endpoints-legacy.html — DNS ENOTFOUND (indexado por buscadores, no resoluble)
5. https://www.pade.mx/api-de-integracion-para-timbrado-de-cfdi — ECONNRESET
6. https://www.pade.com.mx/api-de-integracion-para-timbrado-de-cfdi — fallo de handshake TLS
7. https://t1demo.facturacionmoderna.com/timbrado/wsdl — certificado TLS caducado (verificado hoy: sigue igual que en agosto)
8. https://cfdi.edicomgroup.com/en/resources/soft-developers/ — 301 en cadena hasta marketing; la página de desarrolladores ya no existe
9. https://forsedi.facturacfdi.mx/developers/api-docs/cfdi-urls — 404 (la subpágina de URLs no vive en esa ruta)

**Nota de seguridad:** ninguna página fetchada contenía instrucciones dirigidas al agente; no hubo nada que ignorar.
