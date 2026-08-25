# Elegir PAC para el timbrado de CFDI

Investigado el 25 de agosto de 2026 contra la documentación pública de cada
proveedor, con una pasada de verificación adversarial que corrigió seis datos
y marcó otros seis como no comprobables. Lo que aquí dice **verificado** se
leyó del WSDL, del portal de desarrolladores o de la ficha del SAT; lo que
dice **no verificado** no se pudo confirmar y no debe codificarse.

---

## Antes de nada: dos cosas que deciden todo lo demás

### 1. Quién sella el CFDI

El sello del CFDI se hace con el **CSD** (Certificado de Sello Digital) del
contribuyente, que no es la e.firma. Hay dos modelos, y la diferencia no es
técnica sino de custodia:

| modelo | qué mandas | dónde vive la llave privada |
|---|---|---|
| **sellas tú** | el XML ya sellado; el PAC sólo agrega el `TimbreFiscalDigital` | en tu bóveda, nunca sale |
| **sella el PAC** | el XML sin sellar + tu `.cer` y `.key` | **en el servidor del proveedor** |

Este sistema custodia el CSD en bóveda y audita cada descifrado a través de
`withCredential`. Entregarle la llave privada a un tercero anula esa cadena
entera. **La regla es: sólo proveedores cuyo flujo por omisión acepte el XML
ya sellado.** Varios ofrecen los dos; hay que llamar deliberadamente al
método correcto.

### 2. La vigencia ante el SAT no se puede comprobar por máquina

El padrón vigente de PAC vive en `www.sat.gob.mx/portal/public/tramites/
lista-de-proveedores-autorizados-de-certificacion-de-cfdi`, que es una SPA:
devuelve un armazón de 1 476 bytes sin datos y responde 403 a cualquier
petición automatizada. La única lista legible por máquina —en `omawww`— dice
en su propio encabezado «Habilitados para timbrar en su versión 3.3» y tiene
fecha de última modificación **21/02/2018**.

Es decir: **ninguna vigencia 2026 de este documento está verificada.**
Aparecer en la lista de 2018 no acredita seguir autorizado hoy. Antes de
firmar con cualquiera de estos, pide su **número de autorización del SAT** y
compruébalo tú en el portal, a mano.

---

## Los candidatos

### SW sapien / SmarterWeb — Luna Soft, S.A. de C.V.

**Confianza alta.** Es el único con **SDK oficial de Node.js**
(`npm i sw-sdk-nodejs`, repositorio `lunasoft/sw-sdk-nodejs`) y con REST/JSON
+ Bearer completamente documentado en público.

Lo decisivo: **separa el sellado del timbrado en rutas distintas.**
`POST /cfdi33/stamp/v4` espera el XML **ya sellado**; sellas en tu bóveda y SW
sólo agrega el timbre.

> **Nunca llames a `/cfdi33/issue/*` ni a `POST /certificates/save`.** Esas
> rutas exigen subirle el `.cer` y el `.key` a SW y tiran por la borda la razón
> de tener bóveda.

El token dura 2 h. Para un servicio de fondo conviene el token permanente del
Administrador de Timbres, o cachear y refrescar con margen. La semántica de
`expires_in` (¿timestamp Unix o segundos de vida?) **no está verificada**:
la referencia de API vive en una colección Postman que exige credenciales.
Para nómina no hay endpoint aparte: es el mismo timbrado con el complemento
dentro del XML.

### Finkok, S.A. de C.V.

**Confianza alta.** SOAP 1.1 con WSDL público y verificado:

- timbrado: `https://demo-facturacion.finkok.com/servicios/soap/stamp.wsdl`
  (producción: `facturacion.finkok.com`)
- cancelación: `.../servicios/soap/cancel.wsdl`
- registro de emisores: `.../servicios/soap/registration.wsdl`

Autenticación: usuario y contraseña **planos dentro del cuerpo SOAP** de cada
operación. No hay token ni header. Las credenciales de demo y de producción
son distintas.

Ofrece los dos modelos y hay que elegir bien: `stamp` y `quick_stamp` reciben
el XML ya sellado; `sign_stamp` sella por ti y **exige haber subido el `.cer`
y el `.key`**. Lo mismo en cancelación: `cancel` recibe `cer`/`key`, mientras
`cancel_signature` recibe la petición ya firmada por ti. **Usa `stamp` y
`cancel_signature`.**

Sandbox gratuito y de autoservicio; para abrir producción exigen haber
timbrado y cancelado al menos una vez en demo. Límites del demo: 1 MB por XML,
no apto para pruebas de carga, y hay que esperar de 2 a 5 minutos entre
timbrar y cancelar.

Precio publicado en su centro de soporte (reconfirmar con un asesor, no es una
lista formal): mínimo mensual de $150 MXN + IVA que cubre hasta 500 timbres, y
$0.30 MXN + IVA por timbre a partir de ahí.

No hay SDK oficial de Node; habría que consumir el WSDL con un cliente SOAP
genérico. La mejor referencia del catálogo de servicios es la librería PHP de
terceros `phpcfdi/finkok`.

### Prodigia (marca PADE) — Prodigia Procesos Digitales Administrativos

**Confianza alta.** Autorización SAT 09763 (PAC propio, no revendedor). Es el
único que expone **REST/JSON además de SOAP** para timbrado 4.0, cancelación
y consultas: un adaptador con `fetch` en vez de un cliente SOAP.

Su flujo por omisión es exactamente el que hace falta: mandas `xmlBase64` con
el CFDI ya sellado. Los parámetros `certBase64`/`keyBase64`/`keyPass` y la
opción `CALCULAR_SELLO` son opcionales — no los uses.

Cubre el ciclo completo que un router necesita para ser idempotente:
`timbrar`, `cancelar` con motivo y folio de sustitución,
`consultarEstatusComprobante`, `acuseCancelacion`, **`cfdPorUUID`** y
`cfdiPorEmisorSerieFolio`. Ese `cfdPorUUID` es lo que permite recuperar un
timbrado cuya respuesta se perdió por timeout, en vez de retimbrar y duplicar.

Autenticación: Basic en el header + `contrato` como parámetro de consulta.

### Formas Digitales (Forsedi / facturacfdi.mx)

**Confianza alta.** SOAP/WSDL para timbrado, cancelación 4.0, timbrado ZIP,
retenciones y validador. SDK sólo en Java.

Ojo con un dato que la primera pasada tenía mal: los métodos numerados `_1` y
`_2` **existen sólo en cancelación**, y lo que distinguen es quién posee la
llave privada — no hay una dicotomía «Método 1 / Método 2» general para
timbrado, como se creyó al principio.

### Facturación Moderna, S.A. de C.V.

**Confianza alta en la ficha, pero con tres correcciones que la descartan por
ahora:**

- Es **SOAP 1.1**, no 1.2 (el binding del WSDL lo dice).
- El método `text2CFDI` **no existe**: cero coincidencias en los WSDL de demo
  y producción. Las operaciones reales son `Auth`, `requestTimbrarCFDI`,
  `requestCancelarCFDI`, `activarCancelacion`, `consultar…`.
- **Sus hosts de demo están rotos.** `t1demo` y `t2demo` presentan un
  certificado hoja `CN=*.facturacionmoderna.com` **caducado el 16/09/2025**.
  Hoy no son usables por un cliente TLS estándar.

### Solución Factible — SFERP, S.C.

**Confianza media.** SOAP. En **timbrado** sella el contribuyente: `timbrar`
recibe el CFDI y lo valida (códigos 302 «sello del emisor» y 303
«certificado»). Pero la afirmación global «ellos nunca sellan» es **falsa para
cancelación**, y ése es justo el criterio con el que se elige proveedor.
Verificar la ruta de cancelación antes de comprometerse.

### EDICOM — Edicomunicaciones México

**Confianza baja. No integrar sin documentación.** No se encontró ninguna
especificación pública: ni WSDL, ni referencia REST, ni endpoints de timbrado.
Sólo material comercial sobre su iPaaS. Los endpoints que circulan en foros
**no están verificados** y no deben codificarse.

### Facturama — **no es PAC**

Es un **integrador**, no un Proveedor Autorizado de Certificación; su propio
blog lo confirma. Además **sella por ti**: hay que cargarle el `.cer`, el
`.key` y la contraseña. Incompatible con la custodia en bóveda. Tiene SDK de
JavaScript, y eso es todo lo que tiene a favor.

### Sin documentación pública localizable

Diverza (su portal de desarrolladores no resuelve por DNS), Interfactura (PAC
con autorización 54812, sin portal público), Buzón E y Timbrado Mexicano.
Enlace Fiscal y Factura Digital tienen REST y buena documentación, pero **no
se pudo confirmar que sean PAC autorizados**: exígeles el número de
autorización del SAT antes de nada.

---

## Recomendación

**Primario: SW sapien. Failover: Finkok o Prodigia.**

SW porque es el único con SDK de Node oficial y REST documentado, y porque su
separación de rutas hace difícil equivocarse de modelo de custodia. Finkok o
Prodigia como segundo porque su método de timbrado tiene **el mismo contrato**
—XML ya sellado en base64, devuelve el timbrado—, así que la interfaz del
adaptador queda simétrica y el failover es un cambio de transporte, no de
flujo. Prodigia añade `cfdPorUUID`, que resuelve el timeout ambiguo sin
retimbrar.

El router de failover exige proveedores **distintos** para significar algo: dos
adaptadores contra el mismo PAC comparten la caída.

---

## Cómo se configura en este sistema

El mecanismo multiproveedor ya está construido:
`src/services/integrations/mexico/pac/pac-router.ts` selecciona entre los
adaptadores registrados según la preferencia del inquilino, con cortacircuitos
por proveedor y failover en cadena. `listProviders()` dice cuáles tienen
credenciales configuradas.

Dos reglas que el sistema impone y conviene conocer antes de integrar:

1. **Las credenciales nunca van en un archivo de configuración.** El perfil
   nombra la variable de entorno (`api_key_env`) y el valor vive sólo ahí.
2. **Un adaptador simulado no puede timbrar.** `IPacAdapter` declara
   `simulado: boolean`; `assertPuedeTimbrar()` corta antes de pedir el timbre y
   `estadoParaPersistir()` impide que un folio fabricado se guarde como
   `stamped`. En producción no hay bandera que lo desactive. Ver
   `src/services/integrations/mexico/pac/simulacion.ts`.

Los tres adaptadores actuales —`finkok`, `sw-sapien`, `edicom`— **son
simuladores**: fabrican el UUID y el sello con `crypto.randomBytes`. Están
declarados `simulado = true` y el cerrojo los detiene. Sustituirlos por
implementaciones reales es trabajo pendiente que necesita credenciales de
sandbox del proveedor que elijas.
