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

---

## Segunda pasada — 2026-09-02 (tarde)

Esta sección no reescribe la de la mañana: la audita. Donde algo quedó desmentido se dice con la línea vieja a la vista, porque un documento rector que se corrige en silencio deja de servir para saber quién se equivocó.

### Lo que se verificó

**Quince ligas re-verificadas con WebFetch esta tarde, seis muertas o refusadas.** Lo que sostiene una recomendación se volvió a abrir; lo decorativo (el home de Interfactura, el marketing de Edicom) no se tocó porque no carga peso.

**Siguen en pie, sin cambio de fondo:**

- **El PDF del SAT sigue accesible y ahora está leído de verdad.** La liga `blobwhere=1461173552641` devolvió hoy 965 KB, 86 páginas, `Lang=es-MX`. La mañana lo citó desde el resumen del fetch; esta tarde se extrajo el texto con `pdftotext -layout` y se comprobaron los datos uno por uno. Todo lo que la tabla afirmaba se confirma: Expidetufactura = CPA Control de Comprobantes Digitales, RFC `CCC1007293K0`, autorización **55505**, publicada 2011-04-14; Reachcore = Advantage Security, `ASE0201179X0`; FINKOK `FIN1203015JA`, autorización **10852**, publicada 2013-03-22; SW SmarterWeb `LSO1306189R5`, autorización **16543**, publicada 2013-12-12. **«Facturama» aparece cero veces en las 86 páginas** — el `grep -c` da 0, así que la exclusión por fuente oficial es firme, no inferida. Y el apéndice «cuya autorización ha quedado sin efectos» dice de DIVERZA, textual: «estará vigente hasta el 27 de diciembre de 2018».
- **Un dato del PDF que la mañana no usó y vale oro:** cada ficha trae el **CSD para Timbrado** del proveedor. Finkok `00001000000405332712`; SW SmarterWeb `00001000000301634628`. Ese número es el `NoCertificadoSAT` que aparece dentro del `TimbreFiscalDigital`. Se usa abajo.
- **SW sapien.** `developers.sw.com.mx` responde y sigue con **ambiente de pruebas de autoservicio, credenciales y CSD de prueba**; documenta además Retenciones, Cancelaciones y validadores (CFDI 4.0, RFC contra el SAT, certificados). La página de `customId` confirma literal las 72 horas: «su vigencia es de 72 horas a partir de su primer uso», máximo 100 caracteres, y el reenvío devuelve **`CFDI3307 - Timbre duplicado`**. Matiz nuevo: la misma página documenta **dos rutas**, `/v4/cfdi33/stamp/` que recibe «un comprobante CFDI 4.0 previamente sellado» y `/v4/cfdi33/issue/` que **sella y timbra en un solo paso**. La ruta buena es la primera; la segunda es el equivalente de SW a `EmitirComprobante` de Sovos, y merece entrar a `METODOS_PROHIBIDOS` igual que aquélla.
- **Finkok.** El WSDL de demo respondió otra vez y define las **ocho** operaciones: `sign_stamp`, `stamped`, `stamp`, `stamp_async`, `query_pending`, `get_pdf`, `quick_stamp`, `get_result_async`. `stamp` recibe `xml` (base64Binary), `username`, `password`. Sin cambios respecto de la mañana.
- **Sovos / Reachcore.** El WSDL de producción responde: una sola operación `TimbrarComprobante`, `ApiKey` como parte de cabecera SOAP (`<soap:header … part="ApiKey">`) y `<sp:HttpsToken RequireClientCertificate="false"/>` — HTTPS obligatorio, sin certificado de cliente. Coincide con el adaptador.
- **Solución Factible.** Las dos páginas viven. Cancelación expone **cuatro** métodos, no uno: `cancelarAsincrono`, `getStatusCancelacionAsincrona` («le retorna el acuse de la cancelación»), **`enviarSolicitudCancelacionAsincrono`** («Recibe una solicitud de cancelación ya firmada») y `cancelarSectorPrimario`. Es decir, la ruta que respeta la bóveda no sólo existe: **su pareja para recoger el acuse también** — y el acuse es justamente lo que la ruta de cancelación del repositorio dice que no sabe archivar. Timbrado confirma `timbrar` / `timbrarBase64` y credenciales de prueba publicadas (`testing@solucionfactible.com` / `timbrado.SF.16672`), más `cancelar`, `cancelarBase64` y `cancelarPorNotaCredito`.
- **XPD / Expidetufactura.** Vive, y ahora con las rutas completas, no sólo los hosts: producción `https://appliance.expidetufactura.com.mx:8585/CoreTimbrado.produccion/TimbradoWSSoapSingle?wsdl`, QA `…appliance-qa…:8585/CoreTimbrado.test/TimbradoWSSoapSingle?wsdl`, y REST `…/CoreTimbrado.test/TimbradoWSRest/timbrarCfdiSingle`. «Deberá contener el CFDI a timbrar codificado en base64», usuario/contraseña, demo `testUser`/`1234`.
- **Formas Digitales.** `forsedi.facturacfdi.mx/developers/api-docs` responde y es más explícito de lo que decía la mañana: **«Para poder timbrar los CFDI, primero se necesitan firmarlos»**, con utilería propia `UtilSignature.signInvoice()`. Documenta timbrado, cancelación y consulta. Las URLs concretas siguen en subpáginas que hay que navegar.
- **Facturama.** Sin cambio y sin salida: la carga de CSD sigue exigiendo `Certificate` + `PrivateKey` (base64) + `PrivateKeyPassword`, y la propia guía dice que para la API Multiemisor «la carga de CSDs se realiza **exclusivamente** por este medio». No hay ruta de XML pre-sellado. Queda excluido por la regla de la casa además de por no ser PAC.
- **La tienda de SW** sigue publicando 1,200 timbres a **$2,266 MXN + IVA** y sigue marcada «Not Available For Sale». Referencia, no oferta — igual que en la mañana.

**Lo que cambió, y hay que decirlo alto:**

**Prodigia se debilita como secundario.** La mañana escribió, línea 25: «`docs.prodigia.com.mx/api-timbrado-xml.html` confirma: SOAP y REST, **XML pre-sellado aceptado**, `certBase64`/`keyBase64` **condicionales**». Re-leída hoy con una pregunta más estrecha, la documentación **no describe** un modo en que el cliente mande un XML ya sellado y Prodigia sólo timbre. Lo que documenta es al revés: el XML llega sin sellar y la opción **`CALCULAR_SELLO`** le pide a Prodigia que calcule el sello; como alternativas, `certBase64`/`keyBase64` en la llamada, o **`CERT_DEFAULT`**, que usa un certificado **previamente cargado en su base de datos**. Cuando `CALCULAR_SELLO` se omite, la guía sólo dice que el comprobante «deberá estar previamente llenado con la estructura correcta» — no aclara si acepta un sello ajeno o lo rechaza. No es que Prodigia esté descartada: es que **la afirmación que la puso de secundaria no está acreditada**, y `CERT_DEFAULT` es exactamente la trampa que en Sovos costó una lista de métodos prohibidos. Antes de escribir una línea del adaptador de Prodigia hay que hacerle la pregunta por escrito al proveedor.

Consecuencia directa sobre el orden: **los tres «de reserva» tienen mejor documentación de pre-sellado que el secundario**. Formas Digitales lo dice con todas sus letras, XPD lo dice y publica credenciales de prueba, Solución Factible expone `timbrarBase64` con endpoints y usuario de pruebas abiertos. El Tramo C del plan («Prodigia real») debería reabrirse: el segundo proveedor de verdad distinto puede ser XPD o Solución Factible con menos riesgo de acabar entregando el CSD.

**Muertas o refusadas hoy (6):**

1. `http://omawww.sat.gob.mx/factura/Paginas/documentos/cancelacion/servicio_cancelacion.pdf` — **ECONNREFUSED 200.33.84.128:443**.
2. `http://omawww.sat.gob.mx/informacion_fiscal/factura_electronica/Paginas/pac_timbre_fiscal.aspx` — ECONNREFUSED, mismo host.
3. `http://omawww.sat.gob.mx/tramitesyservicios/Paginas/anexo_20.htm` — ECONNREFUSED. **Ésta duele**: es donde el SAT publica el Anexo 20, la matriz de errores (.xls), los XSD y los catálogos de CFDI 4.0.
4. `https://www.sat.gob.mx/consulta/30795/consulta-los-proveedores-de-facturas-electronicas` — HTTP **403**. Candidato nuevo a padrón vivo; refusado igual que `aplicacion/30796`.
5. `https://www.finkok.com/precios` — HTTP 404.
6. `https://www.finkok.info/en/faq/` — **certificado caducado**. Es el sitio donde los buscadores indexan el precio de Finkok ($150 + IVA hasta 500 timbres/mes, $0.30 + IVA a partir del 501). Con el TLS caído, ese precio **no queda verificado en fuente oficial**; sigue en «no reconfirmado», y ahora se sabe por qué.

**Dos fuentes oficiales NUEVAS que la pasada de la mañana no tenía, y que cambian el tamaño de este tema:**

- **`https://www.sat.gob.mx/minisitio/Factura/documentos/EsquemaCancelacionCFDI.pdf`** — «**Esquema de cancelación de CFDI 2026**». Vivo, servido por `www.sat.gob.mx` (no por omawww), 3 MB. Trae los cuatro motivos con su uso, los supuestos sin aceptación, las excepciones, la máquina de estados completa y los pasos con el CSD.
- **`https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/rmf/RMF_2026-DOF-28122025.pdf`** — **RMF 2026, DOF del domingo 28 de diciembre de 2025**, 666 páginas. Vivo y descargable. De aquí salen, con texto literal, las reglas 2.7.1.32, 2.7.1.34, 2.7.2.2, 2.7.2.9 y 2.7.5.1 que se citan abajo.

Que estas dos vivan en `www.sat.gob.mx/minisitio/…` y todo lo técnico siga en `omawww` caído es la forma exacta del problema: **lo normativo es legible por máquina; lo técnico no**.

**Nota de seguridad:** ninguna de las páginas abiertas esta tarde traía texto dirigido a un asistente. Ni instrucciones, ni «ignora tus reglas», ni nada que hubiera que desobedecer. Se anota porque en la pasada de agosto sí ocurrió (dos páginas de AWS) y el silencio de hoy sólo vale si se declara.

### La deriva contra el árbol

Nueve cosas se movieron desde las 09:44. Cinco a favor, cuatro en contra, y una que la mañana no vio y es la más grave.

**1. Sovos ya NO es capacidad huérfana. La línea 9 de este documento está desmentida.** Decía: «**`sovosReachcoreAdapter` está en el diccionario `PAC_ADAPTERS` (línea 28) pero nunca pasa por `integrationRegistry.register()`**». Ya no. `src/services/integrations/mexico/pac/pac-router.ts:45-47` recorre el diccionario:

```ts
for (const adaptador of Object.values(PAC_ADAPTERS)) {
  integrationRegistry.register(adaptador);
}
```

Y arriba, en las líneas 32-44, quedó escrito el porqué con el efecto medido: `PUT /v1/admin/integrations/sovos_reachcore` moría en `PROVIDER_NOT_FOUND`, «así que el ÚNICO adaptador que no fabrica el folio (`simulado = false`) era el único que no se podía dar de alta por la API». Entró por **`a7f11a7` — G1a (#51)**, que está en `main`. `PAC_ADAPTERS` se exporta a propósito para que una prueba pueda cotejarlo contra el registry. El Tramo A del plan pierde su primer punto: ya está hecho.

**2. Pero `edicom` sigue de terciario por omisión.** El punto 6 del orden de implementación («retirar `edicom` de los defaults y del registro») no se ejecutó. `pac-router.ts:68-73` sigue devolviendo `finkok → sw_sapien → edicom`, y `savePreferences` (líneas 93-95) vuelve a incrustar los mismos tres literales como respaldo del `COALESCE`. Peor que en la mañana en un sentido: como el registro ahora recorre el diccionario, `edicom` **también** quedó registrado, así que el simulador sin documentación pública es hoy más visible en `GET /v1/admin/integrations` que antes. El cerrojo de `simulacion.ts` lo detiene en producción, pero un terciario que nunca podrá ser real sigue ocupando el lugar de uno que sí.

**3. `pac_preferences` sigue fuera del panel de políticas.** La recomendación del Tramo B era migrar la elección primario/secundario/terciario y `auto_failover` al panel con su lector. `src/services/policy/pending-catalog.ts` tiene hoy 39 claves —`cfdi_periodo_cerrado`, `rep_ventana_dias`, `efirma_max_accesos_diarios`, `fuente_tipo_cambio`…— y **ninguna de PAC**. La tabla `pac_preferences` sólo aparece en el router y en la lista de tablas que exporta `src/services/backup/exportacion-inquilino.ts:486`. Sigue siendo una decisión de criterio del despacho que no es auditable como las otras.

**4. `PacProviderSpec` y `PacAdapterBase` no existen.** El único `autorizacionSat` de todo el árbol está escrito a mano en `src/services/integrations/mexico/pac/sovos-reachcore-adapter.ts:156` y `:171` (el `'55267'` de Reachcore, que el PDF del SAT confirma), con su prueba en `tests/integrations/sovos-reachcore-adapter.spec.ts:298`. No hay `timbradoPresellado`, ni `dedupReintento`, ni `customId` en ninguna parte del código. La ficha sigue siendo un dibujo de este documento.

**5. LO QUE LA MAÑANA NO VIO: no hay generador de CFDI, y por lo tanto no hay nada que sellar.** Todo este documento —y el de agosto— se apoya en la regla «solo proveedores cuyo flujo por omisión acepte el XML ya sellado». El árbol no produce ese XML. `src/api/rest/routes/invoices.ts:248` lo confiesa en un comentario:

```ts
// Build minimal CFDI XML for stamping (real implementation would use cfdi.ts generateCfdiXml)
```

`generateCfdiXml` **no existe en ningún archivo del repositorio** (única aparición: ese comentario). El XML que se le manda al PAC es un `<cfdi:Comprobante>` con `Version`, `Folio`, `Total`, `SubTotal` y `Moneda`, y nada más: **sin `Emisor`, sin `Receptor`, sin `Conceptos`, sin `NoCertificado`, sin `Certificado` y sin `Sello`**. No hay `createSign` ni cadena original en todo `src/services/`; los `cadena_original` de `finkok-adapter.ts:103`, `sw-sapien-adapter.ts:93` y `edicom-adapter.ts:79` son literales fabricados por los simuladores. La regla de la bóveda, hoy, no protege nada: no hay llave que se pudiera entregar porque no hay firma que se pudiera hacer.

Esto no invalida la investigación de PACs — la vuelve **condicional**. Ningún adaptador real puede timbrar hasta que exista el sellador, y el propio SAT lo dice en la regla que sigue.

**6. La nómina SÍ timbra por el router, y hereda el mismo hueco.** `src/services/payroll/mx/cfdi-nomina-generator.ts:2` importa `pacRouter` y la línea 136 llama a `pacRouter.stamp(xml, …)`, con `estadoParaPersistir` puesto (línea 143), de modo que un folio simulado tampoco se guarda como timbrado en `paychecks`. Es más completo que el de facturas —lleva `Emisor`, `Receptor`, `Conceptos` y el complemento `nomina12:Nomina` entero— pero **tampoco lleva `Sello`, `NoCertificado` ni `Certificado`**, y va lleno de rellenos que un PAC real rechaza en la primera pasada: `RegistroPatronal="B0000000000"`, `LugarExpedicion="00000"`, `Antiguedad="P0W"`, `PeriodicidadPago="04"` fijo y `Curp` por omisión `XAXX010101HDFNNN00`. Y el comentario de la línea 138 quedó desfasado: dice «failover Finkok → SW Sapien → Edicom», que es el default de hoy, pero el router ya enruta cuatro proveedores.

**7. La validación del CFDI recibido contra el SAT YA EXISTE, y es mejor de lo que este documento suponía.** `src/services/sat/cfdi-status.ts` (entró en F02) es un cliente **real** de `ConsultaCFDIService` —`SOAPAction: http://tempuri.org/IConsultaCFDIService/Consulta`, sobre SOAP armado a mano, `withRetry` de 3 intentos— y lee los cinco campos: `CodigoEstatus`, `Estado`, **`EsCancelable`**, **`EstatusCancelacion`** y **`ValidacionEFOS`**. El comentario de cabecera deja claro que es público y anónimo, que no consume cupo de e.firma, y que el stub anterior respondía «Vigente» siempre — «un estatus simulado es peor que ninguno». Hay hasta el reintento por expresión mal formada (códigos `N-*`) con el total sin relleno. Se expone por `mnemosine cfdi` (`src/cli/cfdi-command.ts:203`). **Consecuencia:** la precondición que el SAT exige antes de cancelar —consultar si el comprobante es Cancelable, y si con o sin aceptación— ya está resuelta en el árbol. Lo que falta es lo que va después.

**8. La cancelación se retiró a propósito y hay un criterio vigilándola.** `src/api/rest/routes/invoices.ts:321-337` lanza `NotImplementedError` con el motivo escrito: «Media cancelación es peor que ninguna», y enumera las cuatro piezas que faltan — llamar al PAC por `pac-router`, esperar el acuse, archivarlo por bytes, encadenar la reversa del asiento. El criterio de `src/plan/criterios.ts:2322` («Cancelar un CFDI no marca la factura como cancelada sin llamar al PAC») falla si reaparece `cfdi_status = 'cancelled'`. La validación de motivos 01-04 y el `replacement_uuid` obligatorio para el 01 (líneas 262-270) **ya coinciden** con el esquema oficial del SAT verificado hoy.

**9. El vocabulario de `cfdi_status` no alcanza para la cancelación real.** `src/database/migrations/002_ap_ar_schema.sql:223`: `CHECK (cfdi_status IN ('pending', 'stamped', 'cancelled', 'failed'))`. El esquema del SAT tiene, del lado del emisor, al menos: *En espera de aceptación*, *Cancelado con aceptación*, *Solicitud rechazada* y *Cancelado plazo vencido*. Cuatro desenlaces contra un valor. Y es la misma clase de defecto que ya tiene criterio en el árbol: `criterios.ts:1346` falla cuando una clave «esconde» valores que el `CHECK` admite y nadie alcanza — aquí es al revés, el `CHECK` no admite los estados que la realidad produce.

### Lo que falta para ser perfecto

Ordenado por consecuencia para un despacho, no por dificultad. «Perfecto» aquí significa: que al contador no se le ocurra nada que su sistema no sepa hacer el día 17 a las once de la noche.

**1. El sellador de CFDI. Sin esto, todo lo demás de este documento es teoría.** (XL, bloquea a casi todo)
No hay `generateCfdiXml`, no hay cadena original, no hay firma. La RMF 2026 lo pone como condición de certificación en la regla **2.7.2.9**, fracciones III y IV: el PAC valida «que el CSD del contribuyente emisor, **con el que se selló el documento**, haya estado vigente en la fecha de generación» y «que el CSD con el que se selló el documento corresponda al contribuyente que aparece como emisor del CFDI, y que **el sello digital corresponda al documento enviado**». Y la misma regla define cuándo el comprobante existe: «El CFDI se considera expedido una vez **generado y sellado con el CSD del contribuyente**, siempre que se obtenga el Timbre Fiscal Digital del SAT». Las piezas de bóveda ya están (`src/services/fiscal-credentials/certificate.ts` descifra el `.key` PKCS#8 del SAT con node-forge, distingue e.firma de CSD por `keyUsage`, y `service.ts:302` hace `zeroize`); falta la cadena original (XSLT del Anexo 20) y el `SHA256withRSA`. Hasta que exista, **elegir PAC es elegir a quién no llamar todavía**.

**2. El failover entre PACs distintos puede producir dos folios para la misma factura, y la norma no lo impide.** (M, no lo bloquea nada)
Esto es lo más peligroso que se encontró hoy. La RMF 2026, regla **2.7.2.9 fracción II**, obliga al proveedor a validar «Que el documento no haya sido previamente certificado **por el propio proveedor de certificación**». *Por el propio proveedor.* La deduplicación es **por PAC, no global**. El router ya no hace failover cuando el primero contesta `PAC_YA_TIMBRADO` —está bien razonado en `pac-router.ts:185-196`, «el mismo documento acaba con DOS folios fiscales, y el segundo no se puede cancelar sin que el primero quede huérfano»—, pero ese camino sólo se recorre **cuando el primero contesta**. En el timeout, que es el caso para el que existe el failover, el router pasa al siguiente proveedor y el siguiente **no tiene forma de saber** que el primero ya timbró. La regla que falta escribir es una sola: *antes de mandar el mismo XML a un proveedor distinto, hay que resolver el timeout consultando al primero* — `stamped` en Finkok, `cfdiPorUUID`/`cfdPorUUID` en Prodigia, `customId` en SW (que devuelve `CFDI3307` en vez de un segundo folio). Reintentar contra el MISMO proveedor con `customId` es seguro; cambiar de proveedor sin consultar, no. Es barato, es local, y es la diferencia entre un failover y una duplicación fiscal.

**3. La cancelación completa: acuse, plazos y su máquina de estados.** (L, bloqueada por el punto 1)
El árbol tiene la precondición (`cfdi-status.ts` lee `EsCancelable`) y tiene la guarda (la ruta no finge). Falta el resto, y ahora hay fuente oficial para cada pieza:
- **Quién firma.** RMF 2026, regla 2.7.2.9, último párrafo: «Los contribuyentes emisores de CFDI, para efectuar la cancelación de los mismos, deberán hacerlo **con su CSD**». El «Esquema de cancelación de CFDI 2026» lo repite en su paso 3: «el sistema le solicitará cargar el Certificado de Sello Digital o e.firma para autorizar la cancelación». Esto convierte la observación de la mañana sobre Solución Factible en una **regla de arquitectura**: el método del PAC tiene que aceptar una solicitud **ya firmada** (`enviarSolicitudCancelacionAsincrono` en SF, `cancel_signature` en Finkok), porque si no, cancelar exige entregarles el CSD — y cancelar es irreversible.
- **El plazo del receptor.** Regla **2.7.1.34**: el receptor «deberá manifestar a través del Portal del SAT, a más tardar dentro de los **tres días** siguientes contados a partir de la recepción de la solicitud», y «El SAT considerará que el receptor **acepta** la cancelación si transcurrido el plazo… no realiza manifestación alguna». El silencio cancela. Eso significa que una cancelación es **asíncrona con espera de tres días**, no una llamada que devuelve 200.
- **El orden.** Misma regla: «Cuando se cancele un CFDI que tiene relacionados otros CFDI, **estos deberán cancelarse previamente**». Y el esquema del SAT: «Un CFDI es **No cancelable** si tiene al menos un documento relacionado vigente». Una factura PPD con REP vivo no se puede cancelar hasta cancelar el REP.
- **El plazo del emisor.** Art. 29-A cuarto y sexto párrafos del CFF, según el esquema del SAT: la cancelación «se podrá efectuar a más tardar en el mes que se deba presentar la declaración anual de ISR correspondiente al ejercicio fiscal en el que se expidió el comprobante» — marzo para morales, abril para físicas. Después de eso, el sistema debe **negarse** y decir por qué, no intentar y fallar. (RESICO: CFDI global sólo en el mes en que se genera, LISR 113-G-V; y regla 3.13.29 para los globales, hasta el último día de abril del ejercicio siguiente.)
- **Y el acuse.** El acuse es el documento que prueba la cancelación ante una revisión. `getStatusCancelacionAsincrona` de Solución Factible lo devuelve; la ruta del repositorio ya dice que hay que «archivarlo por bytes». Sin acuse archivado, la cancelación es un rumor.
- **El vocabulario.** `cfdi_status` necesita los estados intermedios o una tabla de solicitudes de cancelación aparte. Hoy no hay dónde escribir «en espera de aceptación», y ese estado dura tres días.

**4. Los dos relojes del timbrado, verificados antes de salir a la red.** (S, no lo bloquea nada — y es lo más barato de esta lista)
RMF 2026, regla **2.7.2.9 fracción I**: el PAC valida «Que el periodo entre la fecha de generación del documento y la fecha en la que se pretende certificar **no exceda de 72 horas**, o que dicho periodo sea **menor a cero horas**, esto lo validarán haciendo uso del **huso horario correspondiente al Código Postal registrado en el campo `LugarExpedicion`**». El catálogo de errores de Solución Factible lo traduce a la práctica en su error 401: «La fecha de emisión no puede ser mayor a 72 horas de antigüedad; y no puede ser mayor a **65 minutos** si la fecha y hora local es en el estado de **Quintana Roo**, o mayor a **5 minutos** en el resto de la República». Tres consecuencias concretas: (a) una factura fechada hace cuatro días **no se puede timbrar**, y el sistema debe decirlo antes de gastar un timbre; (b) el `LugarExpedicion` fijo en `"00000"` de la nómina hace imposible resolver el huso horario, así que el rechazo es seguro; (c) el reloj del servidor importa — cinco minutos de adelanto son un rechazo. Un validador local de estas dos ventanas es media tarde de trabajo y evita la clase de rechazo que más consulta genera.

**5. El REP como emisión, no sólo como recepción.** (L)
El árbol sabe **recibir** REPs muy bien —`rep-command.ts`, `rep-pendientes.ts`, `rep-linkage.ts`, cuatro políticas del panel (`rep_ventana_dias`, `rep_tolerancia_importe`, `rep_faltante_recibido`, `rep_faltante_emitido`), la migración `036_pagos_rep.sql`— y el propio comando lo declara: «Emitir y corregir REPs (stamp/correct) siguen fuera: dependen del PAC (§5)». Lo que hace falta cuando el PAC llegue, con fuente:
- **El plazo.** Regla **2.7.1.32**, último párrafo: «El CFDI con "Complemento para recepción de Pagos" deberá emitirse a más tardar al **quinto día natural del mes inmediato siguiente** al que corresponda el o los pagos recibidos». Natural, no hábil. Cae en fin de semana y sigue siendo el quinto.
- **La forma.** Misma regla: `Total` en **cero**, `MetodoPago` y `FormaPago` **vacíos**. Un REP con `Total` distinto de cero es un rechazo.
- **La agrupación.** «Podrá emitirse uno solo por cada pago recibido **o uno por todos los pagos recibidos en un periodo de un mes**, siempre que estos correspondan a un mismo receptor». Eso es una bifurcación de criterio del despacho, o sea: una clave del panel de políticas, no una decisión del código.
- **Y la trampa de la cancelación.** El esquema del SAT lista, entre las excepciones a la regla 2.7.1.35, «Los CFDI con **Complemento para recepción de pagos, sin importar el monto**». Traducido: **un REP siempre requiere aceptación del receptor para cancelarse**, aunque sea de cinco pesos. Corregir un REP mal emitido es un trámite de tres días, no un botón.

**6. La nómina: el plazo depende del tamaño de la plantilla, y nadie lo está contando.** (M)
RMF 2026, regla **2.7.5.1**: el CFDI de nómina puede emitirse antes del pago o después, dentro de un plazo en **días hábiles** que depende del número de trabajadores — **1 a 50: 3 días; 51 a 100: 5; 101 a 300: 7; 301 a 500: 9; más de 500: 11**. El árbol tiene `paychecks`, tiene empleados y tiene el generador; no tiene el reloj. Un despacho con cuatro clientes de tamaños distintos tiene cuatro plazos distintos, y ese cálculo es exactamente lo que un sistema debe hacer por él. Nota a favor: el CFDI de **nómina se cancela sin aceptación del receptor** (está en la lista de supuestos de la regla 2.7.1.35 del esquema del SAT), lo que hace la corrección de nómina más simple que la de una factura — y hay además una facilidad de una sola vez para errores de 2025 hasta el 28 de febrero de 2026 (regla 2.7.5.6).

**7. El Anexo 20 no está en el árbol, y su fuente oficial no responde.** (M)
No hay un solo `.xsd` en el repositorio (`find . -name "*.xsd"` fuera de `node_modules`: vacío), ni matriz de errores, ni catálogos completos. Lo que hay son listas a mano: `src/services/ar/customer-service.ts:680,695` valida `c_RegimenFiscal` y `c_UsoCFDI` contra códigos escritos en el código. El PAC va a rechazar por la fracción V de la 2.7.2.9 («Que el documento cumpla con la especificación técnica del Anexo 20») y por la VII (Anexo 29), y el despacho verá un código de error que su sistema no sabe traducir. Y la liga canónica —`omawww.sat.gob.mx/tramitesyservicios/Paginas/anexo_20.htm`— **no acepta conexiones**. O sea: hay que versionar los XSD y los catálogos **dentro del repositorio**, con su fecha y su procedencia, porque no se puede depender de bajarlos cuando hagan falta. Ésta es una decisión de arquitectura que la caída de un host acaba de forzar.

**8. Precio y volumen por timbre: hoy no se puede presupuestar con fuente.** (M)
De los siete proveedores integrables, **sólo SW publica un precio verificable** ($2,266 + IVA por 1,200 timbres, y hoy sin stock). Finkok tenía precio público y su sitio de FAQ está con el certificado caducado. Prodigia, Sovos, Solución Factible, Formas Digitales y XPD no publican nada. Tampoco publica ninguno **límites de tasa** (peticiones por segundo), **caducidad de timbres** (si el paquete comprado vence) ni **qué pasa al agotarse el saldo a mitad de un lote** — y esa última es la que rompe un cierre. Lo que le falta al sistema no es la tarifa: es (a) leer el saldo cuando el PAC lo exponga (Prodigia tiene `CONSULTAR_SALDO`, SW tiene «Administrador de Timbres»), (b) avisar con umbral antes de agotarlo, y (c) una fila por proveedor en el expediente con lo que **de verdad se contrató**, porque el precio de lista no existe. Sin eso, un despacho descubre que se quedó sin timbres el día que factura.

**9. La ficha `PacProviderSpec` — y con el cuadro reordenado.** (M)
Sigue valiendo lo de la mañana, con dos correcciones que salen de hoy: `metodosProhibidos` debe incluir **`/v4/cfdi33/issue/` de SW** y **`CALCULAR_SELLO` / `CERT_DEFAULT` de Prodigia**, no sólo los de Sovos; y `timbradoPresellado: true` como tipo literal ahora tiene un segundo efecto útil — **no se puede escribir la ficha de Prodigia** hasta que el proveedor confirme por escrito que acepta un XML con sello ajeno. La invariante del compilador se vuelve la salvaguarda de una pregunta comercial sin responder.

**10. Un ancla antifabricación que el PDF del SAT regala.** (S)
El PDF publica el **CSD para Timbrado** de cada PAC: Finkok `00001000000405332712`, SW SmarterWeb `00001000000301634628`. Ese número es el `NoCertificadoSAT` que debe venir en el `TimbreFiscalDigital`. Los simuladores del árbol devuelven `00001000000500000000` (`finkok-adapter.ts:93`), `…600000000` (`sw-sapien-adapter.ts:83`) y `…700000000` (`edicom-adapter.ts:69`) — números redondos que ningún SAT emitió. Una comprobación de una línea, con fuente oficial detrás, que ningún folio fabricado sobrevive. Y la regla **2.7.2.2** confirma que ese dato es publicación obligatoria del SAT: «en el Portal del SAT se da a conocer, el logotipo, el nombre… la clave en el RFC y **el número del CSD del SAT**… de los proveedores de certificación de CFDI autorizados».

**11. Qué pasa cuando el PAC se cae el día 17. La respuesta honesta: la RMF no tiene régimen de contingencia.** (M)
Se buscó en las 666 páginas: no hay regla de contingencia por caída de proveedor. La única red que la norma da es el reloj de la 2.7.2.9-I — **72 horas desde la fecha de generación**. Eso es todo. De ahí se sigue lo que el sistema tiene que hacer, y no hace:
- **Un segundo PAC con credenciales cargadas y probadas de antemano.** El router tiene `getAllHealth()` (`pac-router.ts:255-268`), que consulta salud y si está configurado, pero **nadie lo llama en frío**: no hay comando ni chequeo periódico. Un failover cuyo destino nunca se ejercitó no es un failover, es una esperanza. Un `mnemosine pac health` que corra contra el sandbox de los dos proveedores y falle ruidosamente cuando el secundario no tiene credenciales convierte el descubrimiento del día 17 en un aviso del día 3.
- **Y el failover tiene que ser el del punto 2**, no el de hoy: consultar antes de reenviar a otro proveedor, porque la caída y el timeout se parecen mucho y sólo uno de los dos es seguro.
- **La cola.** Con 72 horas de margen, un timbrado que falla no debería perderse: debería quedar encolado y reintentarse con su reloj a la vista, y morir con un aviso cuando le queden pocas horas. Hoy `pacRouter.stamp` lanza `ALL_PACS_FAILED` y ahí termina.

**12. El PAC puede perder la autorización, y Diverza es el precedente que ya está en este expediente.** (S)
La RMF 2026 dedica tres reglas a eso: **2.7.2.11** (amonestaciones), **2.7.2.12** (revocación, con su lista de causas) y **2.7.2.13** (liquidación, concurso mercantil o extinción — con aviso noventa días antes). El PDF del SAT trae los cuatro apéndices poblados. Un despacho no puede enterarse de que su PAC dejó de serlo por un rechazo. Como el padrón vivo del SAT es inalcanzable por máquina (403 en dos rutas distintas, ECONNREFUSED en la tercera), lo que queda es lo menos malo y hay que decirlo así: **la fecha de la última verificación manual de la autorización, escrita en la ficha del proveedor**, y un aviso cuando pase de un año. No es automatizable hoy. Fingir que lo es sería la clase de falso verde que este repositorio ya purgó una vez.

**Lo que ya no hace falta pedir,** porque el árbol lo tiene: la validación del CFDI recibido contra el SAT (`src/services/sat/cfdi-status.ts`, con `EsCancelable`, `EstatusCancelacion` y `ValidacionEFOS`), el registro de Sovos (`pac-router.ts:45-47`), la guarda contra el failover del «ya timbrado» (`pac-router.ts:185-196`), la validación de motivos 01-04 y del folio de sustitución (`invoices.ts:262-270`), y el cerrojo antisimulación en las dos vías. Eso es más de lo que la mañana daba por hecho, y es lo que hace que las doce brechas de arriba sean las que quedan y no una lista de todo.

### Ligas de esta pasada

**Verificadas hoy con WebFetch (15):**
1. https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461173552641&ssbinary=true — PDF SAT «Proveedores de Certificación — Contacto», 86 pp., texto extraído y cotejado
2. https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/rmf/RMF_2026-DOF-28122025.pdf — **NUEVA** · RMF 2026, DOF 28-dic-2025, 666 pp. (reglas 2.7.1.32, 2.7.1.34, 2.7.2.2, 2.7.2.9, 2.7.5.1)
3. https://www.sat.gob.mx/minisitio/Factura/documentos/EsquemaCancelacionCFDI.pdf — **NUEVA** · «Esquema de cancelación de CFDI 2026»
4. https://developers.sw.com.mx/ — portal vivo, sandbox de autoservicio con CSD de prueba
5. https://developers.sw.com.mx/knowledge-base/timbradov4-customid/ — customId 72 h, `CFDI3307`, y las dos rutas `/stamp/` y `/issue/`
6. https://tienda.sw.com.mx/shop/ecommerce-1200-timbres-fiscales-digitales-para-odoo-2649 — $2,266 + IVA / 1,200 timbres, sigue sin stock
7. https://demo-facturacion.finkok.com/servicios/soap/stamp.wsdl — ocho operaciones
8. https://go.reachcore.com/api/ws/6.0/pacservices/Timbre.svc/basic?wsdl — `TimbrarComprobante`, ApiKey en cabecera, HttpsToken
9. https://docs.prodigia.com.mx/api-timbrado-xml.html — **CORRIGE la línea 25**: `CALCULAR_SELLO`, `CERT_DEFAULT`, pre-sellado no documentado
10. https://solucionfactible.com/sfic/capitulos/timbrado/ws-timbrado.jsp — `timbrar`/`timbrarBase64`, endpoints, credenciales de prueba
11. https://solucionfactible.com/sfic/capitulos/timbrado/ws-cancelacion.jsp — cuatro métodos, incluido el del acuse
12. https://solucionfactible.com/sfic/manuales/manual-errores/401.jsp — **NUEVA** · las ventanas de 72 h / 5 min / 65 min (Quintana Roo)
13. https://forsedi.facturacfdi.mx/developers/api-docs — «primero se necesitan firmarlos», `UtilSignature.signInvoice()`
14. https://xpd.mx/soporte/servicio-web-wsdl-en-sus-diferentes-ambientes.html — WSDLs completos QA/producción + REST
15. https://apisandbox.facturama.mx/guias/api-multi/csds — sigue exigiendo llave privada + contraseña, sin alternativa

**Muertas o refusadas hoy (6):**
1. http://omawww.sat.gob.mx/tramitesyservicios/Paginas/anexo_20.htm — ECONNREFUSED 200.33.84.128:443 · **es la fuente del Anexo 20, la matriz de errores y los XSD**
2. http://omawww.sat.gob.mx/factura/Paginas/documentos/cancelacion/servicio_cancelacion.pdf — ECONNREFUSED
3. http://omawww.sat.gob.mx/informacion_fiscal/factura_electronica/Paginas/pac_timbre_fiscal.aspx — ECONNREFUSED
4. https://www.sat.gob.mx/consulta/30795/consulta-los-proveedores-de-facturas-electronicas — HTTP 403 (candidato nuevo a padrón vivo, refusado)
5. https://www.finkok.com/precios — HTTP 404
6. https://www.finkok.info/en/faq/ — certificado TLS caducado (deja el precio de Finkok sin fuente verificable)
