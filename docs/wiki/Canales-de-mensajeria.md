# Canales de mensajería

> **Esta página describe investigación y dirección, no capacidades.** Hoy no se puede conectar WhatsApp, ni Telegram, ni Slack, ni correo a mnemosine. Un grep de `whatsapp|telegram|canal_` sobre todo `src/` no devuelve **nada**; no existe `src/services/integrations/canales/`; el CHECK de la bandeja de salida sigue sin admitir mensajes y el webhook de entrada conserva el hoyo que lo inutiliza. Lo que sigue es el resultado de la investigación del 2026-09-02 —la de la mañana y la **segunda pasada de la tarde**, que corrigió varias cosas de esta misma página— y la forma que tomaría el tramo F06 si entra al plan. El expediente completo, con sus ligas y sus muertos, está en `docs/investigacion/2026-09-02-mejores-practicas/canales.md`.

## Lo primero, porque decide la arquitectura: el CFDI no cabe por WhatsApp

No es una preferencia de diseño, es un tipo MIME. La tabla de documentos de la Cloud API —verificada en dos páginas oficiales distintas, [`cloud-api/reference/media`](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media) y la de [números de negocio](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media)— admite `.txt`, `.doc/.docx`, `.xls/.xlsx`, `.ppt/.pptx` y `.pdf`, todos hasta 100 MB. **No admite `application/xml` ni `text/xml`.** Y un CFDI es un XML.

Lo que el cliente mandaría por WhatsApp es el PDF, que es la representación impresa y **no** el documento fiscal: no se valida contra el SAT, no trae sello ni cadena original, y termina con alguien tecleando el UUID a mano. Ese fallo no hace ruido: llena el sistema de PDFs durante meses y se descubre en el cierre.

La frontera queda así, y de aquí cuelga todo lo demás:

- **El canal de documentos fiscales es el CORREO** (o el webhook que ya existe). Por ahí entra el XML.
- **WhatsApp lleva la CONVERSACIÓN** y, como mucho, un PDF de evidencia. El adaptador debe saber responder «mándame el XML a *tal dirección*» cuando reciba un PDF con pinta de CFDI.

**Corrección a lo que esta página decía ayer:** la tabla daba a WhatsApp Cloud API el veredicto «el canal de clientes, adaptador prioritario» sin distinguir conversación de documento. Sigue siendo el canal de clientes para hablar; deja de serlo para transportar comprobantes.

Y aunque el tipo sí quepa, hay un segundo reloj: el webhook **no trae los bytes**, trae un id de medio, y la doc oficial es explícita en que las URLs de medio caducan a los **5 minutos** y los ids de medio de un webhook a los **7 días**. Persistir el cuerpo antes del 200 —la pieza que abajo se llama prerrequisito— guarda entonces *un puntero a algo que va a desaparecer*: un canal con adjuntos exige además descargar los bytes dentro de una ventana corta y guardarlos donde `s3Adapter` lleva un año esperando su primer consumidor.

## Los gateways: frente del operador, jamás canal de clientes

Dos gateways de mensajería ya están declarados en la configuración de proveedores ([`src/ai/providers/config.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/providers/config.ts)) como **chat puro, `tools: false`** — ver [[Proveedores-de-modelo]]:

- **[hermes-agent](https://github.com/NousResearch/hermes-agent)** (Nous Research, MIT): agente con gateway propio — «Telegram, Discord, Slack, WhatsApp, Signal y CLI desde un solo proceso»— y herramientas del lado del servidor. Su [API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) confirma la nota del perfil palabra por palabra: puerto 8642, bind `127.0.0.1`, llave obligatoria en todo despliegue que «da acceso pleno al toolset del agente, incluida la terminal», y las tool calls llegan **ya ejecutadas**, nunca como pendientes para el cliente. Aquí `tools: false` es limitación técnica además de decisión.
- **[OpenClaw](https://github.com/openclaw/openclaw)** (MIT): gateway autoalojado con [canales](https://docs.openclaw.ai/channels), [políticas por remitente](https://docs.openclaw.ai/gateway/config-channels) (`dmPolicy: pairing` por omisión; los códigos de emparejamiento caducan a la hora y hay tope de tres pendientes por cuenta) y un [modelo de seguridad](https://docs.openclaw.ai/gateway/security) que asume la inyección de prompts como amenaza seria. Su [endpoint OpenAI-compatible](https://docs.openclaw.ai/gateway/openai-http-api) viene apagado por omisión y **sí acepta un subconjunto de function tools del cliente**: nuestro `tools: false` es decisión de frontera, no incapacidad. La razón la da su propia doc: un token válido de ese endpoint «equivale a una credencial de dueño/operador, no a un alcance estrecho por usuario» — darle las herramientas contables por ahí rompería «el agente propone, el humano dispone» ([[El-agente-y-sus-limites]]).

**Corrección menor:** esta página decía «más de 30 canales… WebChat viene en el núcleo». El catálogo de hoy lista **31**, y el núcleo trae **WebChat y Telegram**; 27 plugins oficiales y 3 externos. Es un inventario que envejece en semanas: no se cita de memoria.

Dato nuevo y útil: el `sandbox.mode` de OpenClaw admite perfiles por agente, incluido uno *messaging-only* para bots de cara al público — que es exactamente el molde del canal acotado que aquí se propone.

Y la limitación que fija su lugar: su [canal WhatsApp](https://docs.openclaw.ai/channels/whatsapp) usa **Baileys** —WhatsApp Web no oficial, sesión vinculada por QR— y la doc de hoy agrava el veredicto: los montajes con número personal y self-chat «están plenamente soportados». Para un despacho que le escribe a **clientes** eso es inaceptable: identidad débil, riesgo de términos de servicio, sin plantillas ni opt-in formal. Los gateways sirven como frente conversacional del **operador**, en loopback, y nunca como salida hacia clientes.

**Deuda documental que empeoró sola.** La investigación de la mañana pidió corregir la nota del perfil `openclaw` en `config.ts`. No se aplicó, y el tramo A5 **multiplicó la afirmación inexacta por tres**: hoy vive en el `note` (`config.ts:462`), en `ventana.razon` (`:465-468`) y en `reproducibilidad.razon` (`:471-475`). El tercero ya no es prosa: un veredicto de reproducibilidad `no-admite` se justifica sobre una premisa que la doc oficial contradice. Un renglón por corregir se volvieron tres. El perfil `hermes-agent` (`:230-256`) sí es exacto.

## El canal como adaptador, no como proveedor

Un canal de mensajería es un **adaptador del registry de integraciones** ([`src/services/integrations/index.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/integrations/index.ts)), con `readonly simulado` declarado y credenciales cifradas en `integration_credentials` — nunca en config. La lección que gobierna el molde es la del adaptador SendGrid: se retiró por simulado sin consumidor, y el criterio F03 en [`src/plan/criterios.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/plan/criterios.ts) vigila que no reviva. **El adaptador no nace hasta que nace su consumidor.**

Con un agravante que la segunda pasada encontró y que cambia el trabajo: **la regla ya está rota hoy**. `s3Adapter` está registrado (`index.ts:5`, `:13`) y, fuera de su propio archivo y de esa línea de registro, **no lo llama nadie**. Y el criterio que debería cazarlo sólo sabe vigilar **por el nombre**: `criterios.ts:3251` comprueba que no exista `sendgrid-adapter.ts`. Un `email-resend-adapter.ts` igual de huérfano pasaría por debajo sin despeinarse. Antes de escribir un adaptador de canal, el criterio tiene que generalizarse de «sendgrid no existe» a «ningún adaptador registrado carece de consumidor» — la forma que `s3Adapter` ya reprobaría.

### Entrada: persistir antes del 200

La infraestructura existe y está bien armada — [`src/api/rest/routes/ai-webhooks.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/api/rest/routes/ai-webhooks.ts): token dedicado verificado en tiempo constante, cuerpo crudo con tope de 1 MB, idempotencia, todo acotado al inquilino — **salvo por el hoyo que la mata**: `ai_webhook_deliveries` no guarda el cuerpo del mensaje, mientras el procesador lo exige.

Sigue abierto, comprobado en la segunda pasada contra el árbol de hoy: la migración `028_ai_webhooks.sql` enumera sus columnas y ninguna es el cuerpo; `src/ai/webhooks/intake.ts` lo confirma desde el otro lado (`DELIVERY_COLUMNS` son id, token_id, tenant_id, entity_id, document_key, received_at, status, suspicion, drafts_created) y su `INSERT` manda seis valores, ninguno el cuerpo. La última migración del árbol es la **060** y ninguna lo añade. Toda entrega recibida sin el lector vivo en ese instante responde 200 y queda muerta para siempre (`docs/plan-cierre-brechas.md:6881-6889`, con su recomendación —guardar `raw_body` y vaciarlo al salir de `received`, tope de 7 días— sin ejecutar).

Y el proveedor lo agrava: Meta [reintenta hasta 7 días](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks) cuando no respondes 200 — responder 200 sin persistir, como hoy, desactiva además el único mecanismo de recuperación que el proveedor regala.

**Precisión de cita respecto a la versión anterior de esta página:** el HMAC-SHA256 en `X-Hub-Signature-256` y el handshake `hub.verify_token`/`hub.challenge` **no** están en la página de webhooks de WhatsApp, sino en la de [webhooks de Graph API](https://developers.facebook.com/docs/graph-api/webhooks/getting-started) («genera una firma SHA256 con el payload y el App Secret… todo lo que va después de `sha256=`»). El diseño no cambia; la liga que hay que leer, sí.

El patrón queda igual: registrar-y-responder, procesar después. Cada canal verifica la firma de su proveedor sobre el cuerpo crudo, persiste, responde rápido —[Slack exige 2xx en 3 segundos](https://docs.slack.dev/apis/events-api/), reintenta a los pocos segundos, al minuto y a los cinco, y desactiva la suscripción si fallas más del 95 % de los intentos en una hora— y el lector restringido procesa en su momento. Todo texto entrante es dato, nunca instrucción.

### Salida: solo por la bandeja, con humano

La bandeja ya existe: `ai_external_ops` ([`014_ai_external_ops.sql`](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrations/014_ai_external_ops.sql)) — la IA solo encola con su `ai_reasoning` obligatorio, el humano revisa y ejecuta con `mnemosine outbox`, reclamo atómico. Su CHECK de `operation` sigue admitiendo exactamente `create_policy`, `update_policy`, `upload_xml`, `bank_transaction` y `reconcile_invoice`: **no existe `send_message`** y mandar un mensaje por la bandeja exige migración. Verificado de nuevo en la segunda pasada; las únicas migraciones posteriores que tocan la tabla son la 019 y menciones en comentarios.

Esa es la puerta única de salida planeada: el despachador del outbox es el único código que puede llamar `enviar()` de un adaptador de canal — y eso se vigila con un criterio grep-able, no con buenas intenciones.

## Los canales investigados

| Canal | Entrada (verificación) | Salida | Costo | Identidad del remitente | Veredicto |
|---|---|---|---|---|---|
| [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) (Meta) | Webhook firmado HMAC-SHA256 (`X-Hub-Signature-256`, [Graph API](https://developers.facebook.com/docs/graph-api/webhooks/getting-started)) sobre el cuerpo crudo; reintentos 7 días | Plantillas aprobadas fuera de ventana; libre + [hasta 3 botones](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages) dentro de la ventana de 24 h | [Por plantilla entregada](https://developers.facebook.com/docs/whatsapp/pricing) desde jul-2025; los no plantilla, gratis; **las plantillas *utility* dentro de ventana abierta son gratis, las de *authentication* no** | WABA con nombre de negocio; [opt-in obligatorio](https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in) | La conversación con el cliente. **No transporta CFDI** |
| [Telegram Bot API](https://core.telegram.org/bots/api) | `setWebhook` + `secret_token` (1-256) devuelto en `X-Telegram-Bot-Api-Secret-Token`; sin firma del cuerpo. O long polling sin endpoint público | `sendMessage` libre | Gratis | @bot público | Secundario barato; pilotos y operadores |
| [Slack Events API](https://docs.slack.dev/apis/events-api/) | Signing secret; 2xx en 3 s o desactiva la suscripción; Socket Mode sin URL pública | `chat.postMessage` | Por plan del workspace | App del workspace | Canal interno del despacho, no de clientes |
| Correo — [SES](https://aws.amazon.com/ses/pricing/) | **Sí recibe**: $0.10 USD/1000 recibidos + $0.09/1000 «chunks» de entrada | API/SMTP | $0.10 USD/1000 a la carta ($0.16 en Essentials) | Dominio propio (DKIM) | **El canal de documentos.** El más barato; más fricción inicial |
| Correo — [Postmark](https://postmarkapp.com/pricing) | Entrante **no** viene en Basic: está en Pro ($16.50/mes) y Platform | API | Gratis 100/mes; Basic $15/mes por 10 000 | Dominio propio | Sirve si se paga Pro; el plan Basic no recibe CFDIs |
| Correo — [Resend](https://resend.com/pricing) | — | API | Gratis 3 000/mes (100/día); $20/mes por 50 000 | Dominio propio | El DX más simple para **salida**; la entrada hay que resolverla aparte |
| [OpenClaw](https://github.com/openclaw/openclaw) | `dmPolicy` pairing/allowlist; token = credencial de operador | Sus 31 canales (WhatsApp vía Baileys, no oficial) | MIT | El número/bot vinculado | Frente del operador en loopback; jamás clientes ni herramientas contables |
| [hermes-agent](https://github.com/NousResearch/hermes-agent) | API server 8642, bearer, loopback; no acepta tools del cliente | Telegram/Discord/Slack/WhatsApp/Signal/CLI | MIT | El bot vinculado | Igual que OpenClaw |

**Corrección a la tabla anterior:** decía «Postmark: gratis 100/mes, $15/10k» sin el matiz del entrante, y omitía que SES cobra también por recibir. Con el correo convertido en el canal de documentos, ese matiz es justo el que decide el proveedor.

**A la lista de vigilancia, no al plan:** Meta cobra desde el **16-feb-2026** a los [«AI Providers»](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers) los mensajes **no plantilla**. La definición apunta a quien *vende* el asistente sobre la plataforma, no a un negocio que usa IA en su propia atención; México no está en la lista de mercados cobrados. No nos aplica hoy, ni por definición ni por país — pero es el primer precio que depende de **quién** está detrás del mensaje, y si algún día el despacho vende el agente como producto, cambia de casilla.

**Sin verificar, y por eso no se afirma nada:** WhatsApp Flows. Su doc de `aboutflowsjson` responde 404 y la raíz sirve una página vacía. Nadie debe apoyar un diseño en formularios cifrados dentro de WhatsApp hasta que alguien lea esa documentación con un navegador de verdad.

## La trampa de `reviewed_by`, que es de seguridad y no de comodidad

El hallazgo más barato de arreglar y más caro de olvidar, y no estaba en la primera pasada.

`ai_drafts.reviewed_by` es texto libre con un convenio de espacio de nombres: `policy:<id>` cuando aprueba una política, y el correo del revisor cuando es humano ([`src/ai/draft-service.ts:501`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/draft-service.ts)). Lo humano se calcula como **residuo**: `stats-service.ts:100-104` cuenta como `aprobados_humano` todo lo aprobado que no es auto-posteo ni `policy:%`, y `shadow-verdicts.ts:57-63` hace lo mismo con `NOT LIKE 'policy:%'` para medir la concordancia sombra-contra-humano.

Consecuencia: una aprobación llegada por canal y escrita como `whatsapp:+52…` **se contaría como humana** y entraría en `decididos`. Y esa es exactamente la estadística con la que el despacho decide si enciende `ingest_auto_post`: el canal inflaría el número que autoriza a quitarle el humano al sistema. `ai_external_ops.reviewed_by` es un `VARCHAR(255)` con la misma forma y la misma trampa.

Es pequeño pero **indivisible**: o el canal resuelve a un usuario real, o reclama su propio prefijo **y** cambia esas tres consultas en el mismo commit. Está recogido como §3.4 en `docs/BRECHAS-PARA-LA-PERFECCION.md`, junto a las otras brechas que desarman un freno que el sistema cree tener.

## Un teléfono no es un aprobador, y ahora se dice con la ley en la mano

El argumento de la primera pasada era bueno y no tenía fuente. La fuente existe y es mejor que el argumento.

El **Código de Comercio, art. 90** ([Cámara de Diputados](https://www.diputados.gob.mx/LeyesBiblio/index.htm)) presume que un mensaje de datos proviene del emisor si lo envió él, si se usaron «medios de identificación, tales como claves o contraseñas» suyas o de persona facultada, o si lo generó un sistema programado por él. **Un tap en un botón de WhatsApp no es ninguna de las tres.** El **art. 90 bis, fracción I** abre la única puerta: vale cuando el destinatario aplicó adecuadamente **el procedimiento acordado previamente** con el emisor.

Traducido a diseño: la tabla `canal_vinculos` **no es una comodidad, es el procedimiento acordado previamente**. Por eso el alta tiene que hacerse desde una sesión autenticada, con fecha, método y alcance, y poder mostrarse después. Desde el otro lado, [NIST SP 800-63B rev. 4](https://pages.nist.gov/800-63-4/sp800-63b.html) dice lo mismo en su idioma: el uso de la red telefónica para verificación fuera de banda está *restringido*, y un número no prueba posesión del dispositivo.

Y el árbol confirma que hoy **no hay dónde escribirlo**: `public.users` (`001_core_schema.sql:28-43`) tiene `email` y `password_hash` y **ninguna columna de teléfono**; `audit_log` (`:454-470`) exige `user_id UUID NOT NULL` y tiene `ip_address` y `user_agent`, pero **ninguna columna de canal ni de id de mensaje**. Literalmente no existe el lugar donde anotar «quién aprobó por chat y desde qué mensaje».

De ahí la escalera, cada peldaño como política del panel ([`pending-catalog.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/policy/pending-catalog.ts)) con su lector, nunca como omisión:

1. **Notificar** (`canal_notificaciones`, omisión: apagado): el canal avisa «hay 3 operaciones esperando en outbox». Nada más.
2. **Pre-revisar** (`canal_aprobacion_en_chat: pre-revision`): el botón «revisado» adjunta la respuesta del canal a la operación **como evidencia** — ejecutar sigue exigiendo la identidad autenticada de `mnemosine outbox` o el panel.
3. **Aprobar con tope** (`canal_aprobacion_en_chat: aprobar-con-tope`): sólo con vínculo verificado usuario↔canal y bajo monto máximo. Es una bifurcación de criterio del despacho: nace apagada y sólo el despacho la mueve, con su `whyAsking` y su `ifSkipped` a la vista. La regla de la casa es que una bifurcación de criterio no se pregunta en el chat ni se elige en un json: se añade al panel, y el catálogo la vigila ([[El-tablero-y-los-criterios]]).

La omisión de todo es apagado. La comodidad no gana por default.

## Lo que se conserva diez años

Una aprobación por chat no se acaba cuando termina la sesión. El **CCom art. 49** obliga a conservar **diez años como mínimo** los mensajes de datos «en que se consignen contratos, convenios o compromisos que den nacimiento a derechos y obligaciones», con la información «íntegra e inalterada… y accesible para su ulterior consulta»; el **art. 93 bis** define esa integridad y la **NOM-151-SCFI-2016** (DOF 30-03-2017) fija el cómo: constancia de conservación de un prestador de servicios de certificación acreditado, con sello de tiempo RFC 3161 sobre la huella y firma electrónica avanzada del prestador, con vigencia mínima de diez años. *(Al buscarla: el certificado de `dof.gob.mx` no cubre el host con `www`, y media investigación mexicana lo cita así.)*

La mitad buena, que no sabíamos que teníamos: la **integridad ya está resuelta**. `019_approval_integrity.sql` guarda el sha256 canónico de lo aprobado en `ai_drafts` y en `ai_external_ops`, y A5 lo recalcula sobre lo que el humano realmente aprobó tras corregir. La mitad que falta es **el mensaje**: hoy el cuerpo de lo que llegó no se guarda en ningún lado, así que una aprobación por chat sería una aprobación que no se puede enseñar. El paso honesto es pequeño —guardar el mensaje, atarlo a la operación y registrar qué hash aprobó—; perseguir la constancia con un PSC acreditado es grande, y es decisión del despacho con su porqué escrito, no omisión nuestra.

## Consentimiento expreso: la LFPDPPP ya no es la que citábamos

La primera pasada dijo «buena práctica LFPDPPP» al pasar. La ley en vigor es **otra**: publicada en el DOF el **20-03-2025**, última reforma 14-11-2025, y el INAI ya no existe — la autoridad garante es «Transparencia para el Pueblo», órgano desconcentrado de la Secretaría Anticorrupción y Buen Gobierno.

Su **art. 7** admite consentimiento tácito como regla general, pero exige **consentimiento expreso** para los **datos financieros o patrimoniales**, y obliga a que el aviso de privacidad establezca los mecanismos y procedimientos de revocación. Todo lo que un despacho manda por un canal —un saldo, una balanza, una lista de pagos por hacer— es dato financiero o patrimonial. El opt-in de Meta, que sólo exige [nombrar al negocio](https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in) al que uno se suscribe, **no cubre eso**. El art. 8 sube un escalón para datos sensibles: firma electrónica o mecanismo de autenticación equivalente.

Conclusión práctica: el registro de vínculo nace con consentimiento expreso por persona y con su vía de revocación, o nace mal. Diseñarlo así en la primera migración de `canal_vinculos` es barato; retrofitearlo tras un año de vínculos creados sin ese campo es de lo más caro que hay en esta lista.

## El reloj que multa no es el de las 24 horas

Toda la investigación inventarió WhatsApp, Telegram, Slack y correo, y se dejó fuera **el único canal con plazo legal**. El **CFF art. 17-K** (texto vigente, última reforma DOF 09-04-2026) obliga a consultar el buzón tributario **dentro de los tres días** siguientes al aviso electrónico del SAT; y quien no lo habilita o registra medios de contacto erróneos o desactualizados «se entenderá que se opone a la notificación», con notificación por estrados (art. 134, fr. III).

Para un despacho, el valor de tener canales no es platicar con el cliente: es **no perder un plazo de tres días**. Dos consecuencias de diseño:

- La familia `canal` está incompleta sin un **vigilante del buzón** — y el panel ya tiene el molde para lo que eso toca, en `efirma_max_accesos_diarios` y `efirma_accion_anomalia` (`pending-catalog.ts:760`, `:782`). Necesita e.firma, así que es grande y va después.
- **Ningún plazo fiscal puede colgar de una ventana que no controlamos.** Fuera de la ventana de 24 h sólo sale una plantilla *utility* aprobada, y esa plantilla dice «hay algo que ver»: nunca lleva la decisión.

## La gramática del «sí», en un canal que no tiene bucle

El tramo A5 cerró una puerta que un canal de chat vuelve a abrir, multiplicada: en `mnemosine questions`, teclear «si» se tomaba como **la respuesta** y se grababa como precedente firme que entra al digest de todas las sesiones siguientes. La gramática que lo cerró vive en [`src/cli/kernel/confirmacion.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/kernel/confirmacion.ts) (el sí es anclado, el token completo, bilingüe; EOF y vacío jamás son consentimiento; **exactamente una** repregunta) y en `src/cli/mnemosine.ts:1375-1433` y `:2585-2700`. Es el contrato que cualquier canal tiene que cumplir, y conviene leerlo antes de escribir una línea de canal ([[El-agente-y-sus-limites]]).

Qué exige eso de un canal, punto por punto:

1. **La repregunta deja de ser un bucle y pasa a ser estado.** La respuesta llega tres horas después, desde un teléfono, sin sesión: la pregunta queda pendiente, sale **un** mensaje de aclaración y el tope de uno se hereda literal. Un canal que repregunta sin tope no es un ciclo infinito en un cron: es un ciclo infinito **facturado por plantilla**.
2. **El botón es la única forma inequívoca, y la doc lo permite.** Verificado en [mensajes interactivos de respuesta](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages): llega `interactive.button_reply.id` con tope de **256 caracteres** y título de 20, máximo tres botones. El id puede llevar la referencia completa (`draft:<uuid>:opcion:2`) mientras el usuario lee tres palabras — que es justo el «número de la opción» que A5 acepta como inequívoco. Corolario: **por un canal, el texto libre nunca siembra un precedente firme**; sirve como notas de revisión o queda pendiente.
3. **Dos «sí» seguidos siguen sin ser criterio.** La regla no tiene excepción por insistencia, y un canal no puede inventarse una: en un chat, repetir es más barato que pensar.
4. **La atribución es el nudo.** `teachMemory` exige `taughtBy`, y la siembra de precedentes se atribuye a quien lo dice. Un mensaje de WhatsApp trae `wa_id`, que **es el teléfono**. Sembrar un precedente firme atribuido a un número es exactamente lo que A5 gastó cientos de pruebas en impedir, y por un canal ocurriría a escala.
5. **La valla del digest se hereda gratis.** El texto de tercero ya se neutraliza a una línea y viaja entre marcadores, precisamente porque puede venir de un CFDI o de un payload hostil. Ahí no hay trabajo nuevo; sí hay una prueba que escribir.

**Cerrado desde la versión anterior de esta página:** decía que el payload del botón de WhatsApp «no quedó verificado» y que quien implementara la pieza debía verificarlo. Ya está verificado, y es el punto 2 de arriba.

## Un canal es, por definición, superficie desatendida

A5 encontró que `createLlmSessionWithFailover` reenviaba las opciones **enumerando** campos, y `herramientas` no estaba entre ellos: la corrida desatendida creía pasar 23 herramientas y pasaban 25, con lecturas contra el sistema del cliente dentro. Se arregló la clase, no el caso (reenvío por exclusión).

Un canal entra por ese mismo sitio y con la agravante de que **nadie está mirando cuando llega el mensaje**. La sesión de canal tiene que declarar su superficie explícitamente, quedar bajo el mismo cerrojo desatendido, y tener una prueba que ejerza la costura de lado a lado: probar el callee por su cuenta y el caller contra un doble sordo es exactamente cómo esa fuga sobrevivió. No es una brecha nueva; es un requisito que hay que dejar escrito **antes** de que el canal exista.

## Qué entraría al plan (tramo F06, propuesto)

Ordenado por consecuencia para un despacho, no por dificultad ni por tema:

1. **La frontera de documentos**: decidir y escribir que el CFDI entra por correo y WhatsApp lleva la conversación, con el adaptador de correo que la sostiene — y ese adaptador nace con **dos** consumidores desde el primer commit (el despachador del outbox y la entrada de CFDI), o repite la historia de SendGrid.
2. **Persistir el cuerpo en `ai_webhook_deliveries`** y drenar entregas registradas. Prerrequisito de todo y valioso por sí solo; insuficiente para adjuntos mientras no se descarguen los bytes dentro de su ventana.
3. **El prefijo de `reviewed_by`** resuelto con sus tres consultas en el mismo commit, antes de que exista la primera aprobación por canal.
4. **`canal_vinculos` con consentimiento expreso** fechado, con método, alcance y revocación — el «procedimiento acordado previamente» del art. 90 bis, más las columnas de canal y de id de mensaje que hoy le faltan a `audit_log`.
5. **`send_message` en el CHECK de `ai_external_ops`** y el despachador en `mnemosine outbox`, con el criterio grep-able de que `enviar(` sólo aparece ahí.
6. **Adaptador `whatsapp-cloud` real** (Cloud API oficial, nunca Baileys), con botones como única forma inequívoca y el tope de una repregunta.
7. **Las tres políticas del panel** (`canal_notificaciones`, `canal_aprobacion_en_chat`, `canal_respuesta_auto`), sus filas de catálogo y los criterios que las vigilan — incluido generalizar el criterio del adaptador huérfano, que `s3Adapter` ya reprobaría.
8. **El vigilante del buzón tributario** (grande, necesita e.firma) y, sin costo, la regla de que ningún plazo fiscal cuelga de la ventana de 24 h.
9. **Documental**: corregir las tres copias de la nota de `openclaw` en `config.ts` y escribir la receta del patrón gateway (OpenClaw/hermes en loopback → API de mnemosine con token acotado de lectura + encolar; jamás el mayor).

Dos cosas que este tramo **no puede decidir solo**, y están en `docs/BRECHAS-PARA-LA-PERFECCION.md`: canales pide una excepción a la invariante de «una petición actúa sobre una entidad» que otros dos temas también piden —tres excepciones a la misma regla significan que la regla está mal puesta—, y propone tres claves nuevas a un panel de 39 que nadie ha preguntado si aguanta crecer la mitad.

## Lo que esta página decía y ya no dice

Una wiki que se reescribe en silencio le miente a quien la leyó ayer. Lo corregido en esta pasada:

- WhatsApp era «el canal de clientes, adaptador prioritario» sin matiz. Sigue siendo el canal de conversación; **no transporta CFDIs**, por tipo MIME.
- El HMAC y el handshake se atribuían a la página de webhooks de WhatsApp; están en la de webhooks de Graph API.
- «Más de 30 canales, WebChat en el núcleo» → 31 canales, y el núcleo trae WebChat **y** Telegram.
- La fila de Postmark daba $15/10k sin decir que el **entrante no viene en ese plan**, y la de SES omitía que **cobra por recibir**.
- El costo de WhatsApp se resumía como «servicio dentro de ventana gratis»: es más preciso decir que los no plantilla son gratis y que dentro de ventana abierta las plantillas *utility* son gratis pero las de *authentication* **se cobran**.
- La nota pendiente sobre el payload del botón de WhatsApp queda **cerrada**: verificada, con sus topes de 256 y 20 caracteres.
- Lo que no cambió y conviene repetir: los dos agujeros que sostienen el tramo —el cuerpo que no se guarda y el CHECK sin `send_message`— **siguen abiertos** en el árbol de hoy.

## Páginas relacionadas

- [[El-agente-y-sus-limites]] — por qué la salida pasa por la bandeja y el agente jamás envía solo.
- [[Proveedores-de-modelo]] — donde viven los perfiles `tools: false` de los gateways y la nota de `openclaw` por corregir.
- [[Seguridad-y-credenciales]] — el cifrado de credenciales que el registry de integraciones ya aplica.
- [[Fiscal-mexicano]] — el CFDI y el calendario que un canal no puede hacer perder.
- [[El-tablero-grafico]] — la otra superficie investigada; comparte la regla de no ser motor y la misma excepción pedida a la invariante de entidad.
- [[El-tablero-y-los-criterios]] — dónde se escriben los criterios que vigilarían un adaptador huérfano.
- [[Aislamiento-multi-inquilino]] — el acotamiento que todo webhook de entrada hereda.
