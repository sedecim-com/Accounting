# Lente 5 — Canales de comunicación configurables (estándar hermes-agent / OpenClaw)

Investigación con corrida de verificación web del 2026-09-02. Toda liga de la tabla y del cuerpo fue resuelta con WebFetch en esta corrida y su contenido respalda lo que aquí se afirma.

## Dónde estamos

**Los dos gateways ya están en el config de proveedores, como chat sin herramientas.** `src/ai/providers/config.ts:33-43` declara `hermes-agent` (`http://127.0.0.1:8642/v1`, `api_key_env: HERMES_AGENT_KEY`, `tools: false`, con la advertencia de que corre SUS herramientas del lado del servidor) y `:102-112` declara `openclaw` (`http://127.0.0.1:18789/v1`, `api_key_env: OPENCLAW_GATEWAY_TOKEN`, `tools: false`, nota: requiere `gateway.http.endpoints.chatCompletions.enabled=true`, token de operador, loopback only). Ambas notas resultaron EXACTAS contra la documentación oficial (ver hallazgos), con un matiz en OpenClaw que se anota abajo.

**El registry de adaptadores existe y tiene el molde que pide la regla de la casa.** `src/services/integrations/index.ts:10-14` registra hoy `stripeAdapter`, `conektaAdapter` y `s3Adapter` (los PAC entran vía `pac-router.ts`). La interfaz exige `readonly simulado: boolean` (`src/services/integrations/base/adapter.interface.ts:59`) y el registry guarda credenciales cifradas en `integration_credentials` (`src/services/integrations/base/registry.ts:47-96`, `encrypt()` sobre el JSON). El adaptador SendGrid ya NO está: se retiró por simulado sin consumidor (la historia completa en `docs/auditorias/2026-09-01-integral-ii/maestro-vs-codigo.md:148-156` y `docs/auditorias/2026-09-01-integral-iii/planes-vs-realidad.md:249-251`; el criterio F03 en `src/plan/criterios.ts:3088-3099` hoy VIGILA que `sendgrid-adapter.ts` no exista y que `index.ts` no lo mencione — cablear correo real no puede revivir ese archivo tal cual: nace adaptador nuevo o se ajusta el criterio en el mismo commit).

**La entrada por webhook existe y está bien armada… salvo por el hoyo que la mata.** `src/api/rest/routes/ai-webhooks.ts` monta `POST /v1/ai/webhooks/:tokenName` con token bearer dedicado (sha256, verificación en tiempo constante), cuerpo crudo con tope de 1MB, idempotencia por `documentKey`, y todo acotado al inquilino del token vía `withTenant`. Pero la auditoría lo dice sin rodeos en `docs/plan-cierre-brechas.md:6881`: **`ai_webhook_deliveries` (028_ai_webhooks.sql:68-87) no guarda el cuerpo**, mientras `processDelivery` (`src/ai/webhooks/reader-agent.ts:213`) lo exige — toda entrega recibida sin `runReaderTurn` vivo responde 200 y queda muerta para siempre. Ese es el canal de entrada «que responde 200 y no guarda».

**La salida ya tiene bandeja con humano.** `src/database/migrations/014_ai_external_ops.sql` define `ai_external_ops`: la IA solo ENCOLA, el humano ejecuta con `mnemosine outbox`, reclamo atómico pending→executing, `ai_reasoning NOT NULL`, `reviewed_by/reviewed_at`. Detalle clave: el CHECK de `operation` solo admite operaciones contables (`create_policy`, `update_policy`, `upload_xml`, `bank_transaction`, `reconcile_invoice`) — **no existe `send_message`**; mandar un mensaje por la bandeja requiere migración.

**El panel de políticas tiene el molde del criterio.** `src/services/policy/pending-catalog.ts:14-38` (PolicySpec con `question/impact/options/defaultValue/whyAsking`) y el ejemplo vivo de compuerta operativa en `ingest_auto_post` (`:391-413`, con su modo sombra). El trinquete del catálogo vive en `docs/catalogo-minimos.json` (suelo que solo sube, verificado por `scripts/catalogo-estado.ts --check` en CI).

## La investigación

### (a) OpenClaw y hermes-agent

**OpenClaw** ([repo](https://github.com/openclaw/openclaw), MIT, ~389k estrellas, de la OpenClaw Foundation) es un gateway autoalojado que conecta apps de mensajería con agentes de IA: un solo proceso Gateway como «plano de control local de sesiones, herramientas, eventos y conexiones de canal».

- **Canales**: 30+ plataformas ([docs de canales](https://docs.openclaw.ai/channels)): Discord, Slack, Telegram, WhatsApp, Teams, Signal, iMessage, Matrix, IRC, Google Chat… WebChat viene en el núcleo; la mayoría son plugins oficiales (`openclaw plugins install`); hay externos (WeChat, Zalo). Varios canales pueden correr a la vez y el gateway enruta por chat.
- **Configuración** ([config-channels](https://docs.openclaw.ai/gateway/config-channels), [configuration](https://docs.openclaw.ai/gateway/configuration)): `~/.openclaw/openclaw.json` (JSON5), espacio `channels.*` con `dmPolicy` (`pairing` por defecto: remitente desconocido recibe código de aprobación de un solo uso; `allowlist`; `open` exige `allowFrom: ["*"]`; `disabled`) y `groupPolicy` (`allowlist` por defecto). Secretos por `${VAR}` y objetos SecretRef (`env`/`file`/`exec`/`store`) — el mismo patrón api_key_env/api_key_cmd que mnemosine ya practica.
- **Modelo de seguridad** ([security](https://docs.openclaw.ai/gateway/security)): UNA frontera de confianza por gateway (rechaza multi-tenant hostil), loopback por defecto, identidad primero (quién puede hablarle al bot antes que qué puede hacer), negación de herramientas de alto riesgo para agentes no confiables, `openclaw security audit`. Asume la inyección de prompts como amenaza seria.
- **Endpoint OpenAI-compatible** ([openai-http-api](https://docs.openclaw.ai/gateway/openai-http-api)): deshabilitado por defecto; se enciende con `gateway.http.endpoints.chatCompletions.enabled=true`; autentica con el token del gateway; la doc ordena tratarlo como «acceso pleno de operador» y mantenerlo en loopback/tailnet. **Matiz contra nuestra nota**: la doc dice que el endpoint SÍ acepta `tools` de función del cliente. Nuestro `tools: false` no es entonces una limitación técnica sino una decisión correcta: como el token es credencial de operador y la petición corre por el mismo camino de agente confiable del gateway, darle las herramientas contables por ahí violaría «el agente propone, el humano dispone». La nota del perfil merece una línea aclarando que es decisión, no incapacidad.
- **OJO con su canal WhatsApp** ([channels/whatsapp](https://docs.openclaw.ai/channels/whatsapp)): usa **Baileys (WhatsApp Web no oficial, emparejamiento por QR de una cuenta personal)**, NO la Cloud API de Meta. La identidad del bot es el número vinculado; la doc recomienda número dedicado. Para un despacho mexicano que le escribe a CLIENTES esto es inaceptable (identidad débil, riesgo de términos de servicio, sin plantillas ni opt-in formal): OpenClaw sirve como frente conversacional del OPERADOR, no como canal de salida hacia clientes.

**hermes-agent** ([repo](https://github.com/NousResearch/hermes-agent), MIT, Nous Research): agente auto-mejorable con gateway de mensajería propio — «Telegram, Discord, Slack, WhatsApp, Signal y CLI desde un solo proceso gateway» — y Tool Gateway de Nous (búsqueda, imagen, TTS, navegador) del lado del servidor. Su [API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) confirma nuestra nota al pie de la letra: puerto **8642** por defecto, bind `127.0.0.1`, `API_SERVER_KEY` obligatoria («da acceso pleno al toolset del agente, incluida la terminal»), y **no acepta herramientas del cliente**: las tool calls «ya fueron ejecutadas del lado del servidor». Nuestro `tools: false` aquí sí es limitación técnica además de decisión.

### (b) Canales que un despacho mexicano usa de verdad

**WhatsApp Business Platform (Cloud API de Meta)** — [visión general](https://developers.facebook.com/docs/whatsapp/cloud-api): alojada por Meta sobre Graph API; conceptos: WABA, phone number ID, webhooks (todo mensaje entrante llega por webhook), plantillas pre-aprobadas (lo único enviable fuera de ventana), y la **ventana de servicio de 24 horas** que abre cada mensaje del usuario.
- **Precios** ([pricing](https://developers.facebook.com/docs/whatsapp/pricing)): desde el **1 de julio de 2025 se cobra POR MENSAJE de plantilla entregado**, ya no por conversación. Marketing siempre se cobra; utility y authentication son gratis dentro de la ventana de servicio; los mensajes libres dentro de la ventana son gratis; punto de entrada gratis de 72h vía anuncios click-to-WhatsApp. Para el caso del despacho (el cliente pregunta, el despacho responde; avisos utility) el costo marginal es bajo o cero.
- **Webhooks** ([set-up-webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks) + [Graph API webhooks](https://developers.facebook.com/docs/graph-api/webhooks/getting-started)): handshake GET con `hub.verify_token`/`hub.challenge`; cada POST viene **firmado con HMAC-SHA256 del app secret en `X-Hub-Signature-256`** (se valida contra el cuerpo CRUDO — otra razón para el `express.raw` que ai-webhooks.ts ya usa); si no respondes 200, Meta **reintenta hasta 7 días** — es decir, responder 200 sin persistir el cuerpo, como hoy, además desactiva el único mecanismo de recuperación que el proveedor regala. Soporta mTLS.
- **Opt-in** ([getting-opt-in](https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in)): exige permiso previo del destinatario, comunicando con claridad **el nombre del negocio** al que se suscribe; cualquier método (web, SMS, papel) conforme a ley local; opt-out transparente y respeto inmediato; Meta degrada números con mala retroalimentación.
- **Botones**: [mensajes interactivos](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages) con hasta 3 botones de respuesta predefinidos y listas — el material para un «aprobar / rechazar / ver detalle» dentro de la ventana de servicio.

**Telegram Bot API** ([core.telegram.org/bots/api](https://core.telegram.org/bots/api)): actualizaciones por `getUpdates` (long polling — sin endpoint público) o `setWebhook`; el webhook se protege con `secret_token`, que Telegram devuelve en el encabezado `X-Telegram-Bot-Api-Secret-Token` (autenticación por secreto compartido, sin firma HMAC del cuerpo). Trivial de montar; identidad del bot pública (@bot).

**Slack (Events API)** ([docs.slack.dev/apis/events-api](https://docs.slack.dev/apis/events-api/)): endpoint HTTP o **Socket Mode** (WebSocket, sin URL pública); reto `url_verification` al configurar; verificación por **signing secret**; exige **2xx en 3 segundos** con reintentos (inmediato, 1 min, 5 min) y desactiva la suscripción si fallas >95% en una hora — o sea: persistir y responder rápido, procesar después, exactamente el patrón bandeja.

**Correo transaccional** (el hueco que dejó el retiro del adaptador SendGrid simulado):
- **Amazon SES** ([precios](https://aws.amazon.com/ses/pricing/)): **$0.10 USD por 1,000 correos** a la carta (planes con niveles desde $0.16/1000); el más barato con mucho, pero pide más trabajo de entregabilidad (dominio, DKIM, salir del sandbox) y firma SigV4 o SMTP.
- **Postmark** ([precios](https://postmarkapp.com/pricing)): gratis 100/mes para desarrollo (no expira), $15 USD/mes por 10,000; especializado en transaccional, API simple, webhooks de rebote.
- **Resend** ([precios](https://resend.com/pricing)): gratis 3,000/mes (100/día), $20 USD/mes por 50,000; el DX más simple (una API key, un POST JSON).
- **Costo de cablear uno de verdad**: el adaptador SendGrid retirado eran 88 líneas sin consumidor; un adaptador Resend/Postmark real es del mismo tamaño (un POST con bearer token) más el consumidor que le faltó al muerto: el despachador de la bandeja de salida. La lección de F03 aplica: el adaptador no nace hasta que nace su consumidor.

### (c) Prácticas de agentes por mensajería

- **Identidad del remitente**: en la Cloud API la identidad es el WABA con nombre visible verificable ante Meta — el mensaje llega «del despacho», no de un número anónimo; el opt-in debe nombrar al negocio. En OpenClaw/Baileys la identidad es un número personal vinculado — otra razón para separar canal de clientes (Cloud API) y canal de operador (gateway).
- **Opt-in**: registro con fecha, método y alcance del consentimiento por destinatario, y opt-out que se respeta al instante (requisito de Meta y buena práctica LFPDPPP).
- **Maker-checker cuando el canal es un chat**: el patrón que la evidencia sostiene es NO mover la aprobación al chat, sino mover la *notificación* y a lo sumo la *pre-revisión* al chat. Un tap en un botón de WhatsApp autentica «alguien con ese teléfono», no «el contador con permiso de aprobar»: teléfono ≠ identidad del sistema. OpenClaw mismo lo dice a su manera: su capa uno es «decidir quién puede hablarle al bot» y su endpoint es credencial de operador completa — no existe el token de medio pelo. La escalera segura: (1) el canal notifica «hay 3 operaciones esperando en outbox»; (2) el botón «revisado» adjunta la respuesta del canal a la operación como evidencia, pero ejecutar sigue exigiendo la identidad autenticada de `mnemosine outbox` o el panel; (3) solo con vínculo verificado usuario↔canal registrado en el panel y bajo tope de monto, la respuesta del canal cuenta como aprobación — y eso es una bifurcación de criterio del despacho, no un default.

## Tabla comparativa

| Canal / pieza | Entrada (verificación) | Salida | Costo | Identidad del remitente | Veredicto para mnemosine |
|---|---|---|---|---|---|
| **WhatsApp Cloud API** (Meta) | Webhook firmado `X-Hub-Signature-256` (HMAC-SHA256, app secret) + handshake verify_token; reintentos 7 días | Plantillas aprobadas fuera de ventana; libre + botones dentro de 24h | Por mensaje de plantilla entregado (jul-2025); servicio dentro de ventana gratis | WABA con nombre de negocio; opt-in obligatorio | **El canal de clientes.** Adaptador prioritario |
| **Telegram Bot API** | `setWebhook` + `secret_token` en encabezado (o long polling sin endpoint) | `sendMessage` libre | Gratis (sin costo declarado en la doc) | @bot público | Canal secundario barato; bueno para pilotos y operadores |
| **Slack Events API** | Signing secret; 2xx en 3s; o Socket Mode sin URL pública | chat.postMessage (bot token) | Por plan del workspace | App/bot del workspace | Canal interno del despacho, no de clientes |
| **Correo: SES** | (entrada n/a) | API/SMTP | $0.10 USD/1000 a la carta | Dominio propio (DKIM) | El más barato; más fricción inicial |
| **Correo: Postmark** | — | API | Gratis 100/mes; $15/mes 10k | Dominio propio | Transaccional puro, DX simple |
| **Correo: Resend** | — | API | Gratis 3,000/mes; $20/mes 50k | Dominio propio | **El candidato para F03-bis**: adaptador mínimo real |
| **OpenClaw** (gateway) | dmPolicy pairing/allowlist; token gateway = operador | Sus 30+ canales (WhatsApp vía Baileys, NO oficial) | Software libre (MIT) | El número/bot vinculado al gateway | Frente conversacional del OPERADOR vía chatCompletions loopback; jamás canal de clientes ni herramientas contables |
| **hermes-agent** (gateway) | API server 8642, bearer obligatorio, loopback; no acepta tools del cliente | Telegram/Discord/Slack/WhatsApp/Signal/CLI | MIT (Tool Gateway vía suscripción Nous) | El bot vinculado | Igual que OpenClaw: canal de chat, tools server-side, cero contable |

## El mecanismo

El canal es un **adaptador del registry**, no un proveedor de IA. Seis piezas, cada una con su dueño:

**1. Primero el hoyo: la entrada persiste ANTES del 200.** Migración que añade el cuerpo a `ai_webhook_deliveries` (columna `body` JSONB o referencia a almacenamiento, con el sha256 que ya se calcula) y cambio en `recordDelivery` (`src/ai/webhooks/intake.ts`) para guardarlo; `processDelivery` deja de depender de tener `runReaderTurn` vivo en el instante de la entrega — cierra el hallazgo de `docs/plan-cierre-brechas.md:6881`. Es prerequisito de todo lo demás: sin esto, cualquier canal nuevo hereda el mismo pozo sin fondo.

**2. Adaptadores de canal en el registry** (`src/services/integrations/canales/`): nueva categoría `canal` en `IIntegrationAdapter`, con `whatsapp-cloud` (Cloud API oficial, nunca Baileys), `telegram-bot`, `slack-bot` y `email-resend` (o `email-ses`; uno solo, con consumidor desde el día uno). Cada uno: `readonly simulado` declarado con cerrojo fuera de sandbox, credenciales por `integration_credentials` cifradas o nombradas por env — jamás en config. La interfaz del canal: `verificarFirma(rawBody, headers)` (HMAC de Meta, secret_token de Telegram, signing de Slack), `normalizarEntrada(payload)` → mensaje neutro con id idempotente del proveedor, y `enviar(mensaje)` — que **solo el despachador del outbox puede llamar**.

**3. Entrada por webhook firmado, por canal.** Rutas hermanas de `ai-webhooks.ts` (`POST /v1/canales/:adaptador/webhook`): cuerpo crudo, verificación de firma del proveedor (además del secreto de ruta), persistencia (pieza 1), idempotencia por id del proveedor, y 200 rápido — Slack exige 3s y Meta reintenta 7 días: registrar-y-responder, procesar después con el lector RESTRINGIDO que ya existe (`reader-agent.ts`). Todo texto entrante pasa por `scanImportedText` como hoy: dato, nunca instrucción.

**4. Salida SOLO por la bandeja.** Migración que extiende el CHECK de `ai_external_ops.operation` con `send_message` (payload: adaptador, destinatario resuelto por el enrutamiento, plantilla o texto, ventana). El agente encola con su `ai_reasoning`; `mnemosine outbox` muestra y el humano ejecuta; el despachador reclama atómico y llama a `adaptador.enviar()`. Criterio de arquitectura: **grep-able** — `enviar(` de un adaptador de canal solo aparece en el despachador del outbox.

**5. Enrutamiento y criterio en el panel, no en el json.** Tabla `canal_vinculos` (tenant, entidad/usuario ↔ adaptador ↔ dirección verificada, opt-in con fecha/método/alcance, opt-out) administrada por CLI/panel. Y las bifurcaciones de criterio como PolicySpec con su lector: `canal_notificaciones` (off / solo-operadores / operadores-y-clientes; default off), `canal_aprobacion_en_chat` (off / pre-revision / aprobar-con-tope; default **off** — un tap de WhatsApp autentica un teléfono, no un aprobador; `pre-revision` adjunta la respuesta del canal como evidencia pero la ejecución sigue en outbox; `aprobar-con-tope` solo con vínculo verificado y monto máximo, decisión del despacho con su whyAsking), y `canal_respuesta_auto` (off / solo-consultas-de-solo-lectura-dentro-de-ventana; default off).

**6. El patrón gateway, acotado.** OpenClaw o hermes-agent como frente conversacional del OPERADOR: el gateway (loopback, token de operador, dmPolicy pairing) delega en mnemosine **vía su API REST con un token acotado** (lectura + encolar en outbox; jamás el mayor, jamás herramientas contables) — el mismo contrato que ya declaran los perfiles `tools: false` de `config.ts`. Ajuste menor de doc: la nota del perfil `openclaw` debe decir que el endpoint SÍ acepta tools según su doc oficial y que el `tools: false` es decisión de frontera nuestra (el token es credencial de operador completa), no incapacidad del gateway; la de `hermes-agent` queda como está (verificada: no acepta tools del cliente).

**Para no nacer huérfano**: filas de catálogo para la familia `canal` (`canal list`, `canal vincular`, `canal probar`, y `outbox` mostrando `send_message`) que suben el suelo de `docs/catalogo-minimos.json` en el mismo commit; y criterios en `src/plan/criterios.ts`: (i) todo adaptador con categoría `canal` registrado tiene fila de catálogo y PolicySpec lector (o entra a `HUERFANOS_CONGELADOS` con destino — la recomendación 8 de la auditoría II que sigue sin aplicarse); (ii) mutante: quitar la persistencia del cuerpo en intake pone el criterio en rojo; (iii) `enviar(` fuera del despachador del outbox pone en rojo el criterio de la salida.

## Qué entra al plan maestro

Propuesta de tramo **F06 — Canales** (total M/L), desglosado:

1. **(S)** Persistir el cuerpo en `ai_webhook_deliveries` + drenado de entregas registradas — cierra `plan-cierre-brechas.md:6881`. Prerequisito de todo lo demás y valioso por sí solo.
2. **(S)** `send_message` en el CHECK de `ai_external_ops` + despachador en `mnemosine outbox`.
3. **(M)** Adaptador `whatsapp-cloud` real: firma X-Hub-Signature-256, handshake, plantillas, ventana de 24h, botones; tabla `canal_vinculos` con opt-in.
4. **(S)** Adaptador de correo real (Resend o SES) que revive la promesa de `invoice send` de F03 — esta vez con consumidor (el outbox) desde el primer commit.
5. **(M)** Panel: `canal_notificaciones`, `canal_aprobacion_en_chat`, `canal_respuesta_auto` con lectores; filas de catálogo y los tres criterios; extensión de `HUERFANOS_CONGELADOS` a los adaptadores restantes.
6. **(S, opcional/documental)** Receta del patrón gateway: OpenClaw/hermes-agent loopback → API mnemosine con token acotado; corrección de la nota del perfil `openclaw` en `config.ts`.

**Decisión para el panel (no para el chat ni el json)**: si la respuesta de un canal puede contar como aprobación maker-checker y bajo qué tope — nace en `off` y es el despacho quien la mueve.

## Ligas verificadas y muertas

**Verificadas en esta corrida (20)** — todas resueltas con WebFetch y con contenido conforme:

OpenClaw: https://github.com/openclaw/openclaw · https://docs.openclaw.ai/channels · https://docs.openclaw.ai/gateway/config-channels · https://docs.openclaw.ai/gateway/configuration · https://docs.openclaw.ai/gateway/security · https://docs.openclaw.ai/gateway/openai-http-api · https://docs.openclaw.ai/channels/whatsapp

hermes-agent: https://github.com/NousResearch/hermes-agent · https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server

WhatsApp/Meta: https://developers.facebook.com/docs/whatsapp/cloud-api · https://developers.facebook.com/docs/whatsapp/pricing · https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks · https://developers.facebook.com/docs/graph-api/webhooks/getting-started · https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in · https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages

Telegram: https://core.telegram.org/bots/api — Slack: https://docs.slack.dev/apis/events-api/ — Correo: https://aws.amazon.com/ses/pricing/ · https://postmarkapp.com/pricing · https://resend.com/pricing

**Muertas o no verificadas (0 muertas; 2 notas):**
- https://api.slack.com/apis/events-api responde 302 hacia docs.slack.dev — usar la liga de destino (verificada), no la vieja.
- El detalle del payload de webhook cuando el usuario toca un botón de WhatsApp (id/payload del botón) NO quedó verificado en la página consultada; el diseño no depende de ese detalle, pero quien implemente la pieza 3 debe verificarlo en la doc de mensajes interactivos antes de codificar.

**Nota de seguridad**: ninguna página consultada intentó inyectar instrucciones; todo el contenido web se trató como dato.

## Segunda pasada — 2026-09-02 (tarde)

Corrida de re-verificación y de contraste contra el árbol. Se re-resolvieron con WebFetch las 19
ligas que SOSTIENEN una recomendación de la mañana (no las decorativas) y se añadieron 11 nuevas,
casi todas de fuente oficial mexicana, que la primera pasada no tocó. Nada de lo anterior se borra:
donde algo quedó desmentido se cita la línea vieja y se dice en qué se equivocaba.

### Lo que se verificó

**Los dos gateways: confirmados, y uno con la cita más dura de lo que teníamos.**

- `docs.openclaw.ai/gateway/openai-http-api` — VIVA. Confirma lo que la mañana ya había corregido:
  «/v1/chat/completions supports a function-tool subset compatible with common OpenAI Chat
  clients», con `tools` y `tool_choice`. Y trae una frase que endurece nuestra decisión de
  frontera: «A valid Gateway token/password for this endpoint is equivalent to an owner/operator
  credential, not a narrow per-user scope». Deshabilitado por defecto; «Keep it on
  loopback/tailnet/private ingress only».
- `docs.openclaw.ai/channels/whatsapp` — VIVA. Baileys confirmado: «production-ready via WhatsApp
  Web (Baileys). The gateway owns the linked session(s)». Y un matiz que agrava el veredicto de la
  mañana: «personal-number/self-chat setups are fully supported». Sigue sin ser canal de clientes.
- `docs.openclaw.ai/gateway/security` — VIVA. Una frontera de confianza por gateway, loopback,
  `dmPolicy: pairing`, `openclaw security audit`. Dato NUEVO y útil para nosotros: su
  `sandbox.mode` admite perfiles por agente, incluido «messaging-only for public-facing bots» —
  que es exactamente el molde del canal acotado que este documento propone.
- `docs.openclaw.ai/gateway/config-channels` — VIVA. `dmPolicy` pairing/allowlist/open/disabled y
  `groupPolicy: allowlist` por defecto, confirmados. NUEVO: los códigos de emparejamiento caducan
  a la hora y hay tope de 3 pendientes por cuenta.
- `docs.openclaw.ai/channels` — VIVA, y CAMBIÓ. La mañana escribió «30+ plataformas … WebChat
  viene en el núcleo; la mayoría son plugins oficiales». Hoy el catálogo lista **31** y **el
  núcleo trae WebChat Y Telegram**; 27 plugins oficiales y 3 externos (WeChat, WeCom, Zalo).
  Corrección menor, pero enseña que el inventario de canales de ese proyecto envejece en semanas.
- `github.com/openclaw/openclaw` — VIVA. MIT, ~388.7k estrellas, el gateway sigue descrito como
  «the local control plane for sessions, tools, events, and channel connections».
- `github.com/NousResearch/hermes-agent` — VIVA. MIT, y el listado de canales textual: «Telegram,
  Discord, Slack, WhatsApp, Signal, and CLI — all from a single gateway process».
- `hermes-agent.nousresearch.com/docs/user-guide/features/api-server` — VIVA y literal: puerto
  8642, bind `127.0.0.1`, «API_SERVER_KEY is required for every deployment», «gives full access to
  hermes-agent's toolset, including terminal commands», y la frase que hace de su `tools: false`
  una limitación real y no una decisión: las tool calls «were already executed server-side … never
  as pending calls for the client to execute».

**WhatsApp: el modelo de precio se confirma y una afirmación nuestra se cae.**

- `developers.facebook.com/docs/whatsapp/pricing` — VIVA. Confirmado el cobro por mensaje desde el
  1-jul-2025: «You are only charged when a template message is delivered». Confirmado que los no
  plantilla son gratis. **DESMENTIDO** lo que la mañana escribió —«Marketing siempre se cobra;
  utility y authentication son gratis dentro de la ventana de servicio»—: la página dice
  «Utility templates delivered within an open customer service window are free» y **no extiende esa
  gratuidad a authentication**, que se cobra. Para nuestro caso cambia poco (un despacho manda
  utility), pero una tabla de costos que regala la categoría equivocada es la clase de error que
  después se presupuesta.
- NUEVO en esa misma página y NUEVO del todo:
  `developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers` — VIVA.
  Desde el **16-feb-2026** Meta cobra a los «AI Providers» los mensajes NO plantilla. La definición
  apunta a «providers and developers of artificial intelligence or machine learning technologies …
  who provide certain services on WhatsApp Business Platform»: el producto ES el asistente, no
  un negocio que usa IA en su propia atención. Mercados cobrados a la fecha de consulta: Italia
  (16-feb, exenta 13-may), 29 países EU/EEA (11-mar a 12-may, exentos 13-may) y **Brasil, vigente**;
  tarifas nuevas anunciadas para el 1-jul-2026. **México no está en la lista y un despacho no cae
  en la definición** — pero es la primera vez que Meta pone precio a un mensaje según QUIÉN está
  detrás, y eso va a la lista de vigilancia, no al plan.
- `developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks` — VIVA. Confirma el
  reintento: «Meta retries delivery with decreasing frequency until the request succeeds, for up to
  7 days», y avisa de notificaciones duplicadas. **Precisión contra la mañana**: esta página NO
  contiene el HMAC ni el handshake; ese material está en la de Graph API, que también se verificó
  (`developers.facebook.com/docs/graph-api/webhooks/getting-started`, VIVA): `hub.mode`,
  `hub.challenge`, `hub.verify_token`, y «Generate a SHA256 signature using the payload and your
  app's App Secret … everything after `sha256=`». La mañana atribuyó las dos cosas a la página de
  WhatsApp; el diseño no cambia, la cita sí.
- `developers.facebook.com/docs/whatsapp/overview/getting-opt-in` — VIVA, y literal en lo que
  importa: «Businesses must clearly state the business's name that a person is opting in to receive
  messages from», cualquier método conforme a la ley aplicable.
- `developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages` — VIVA: «When a WhatsApp
  user messages you or calls you, a 24-hour timer called a customer service window starts» y
  «When the window closes, you can only send pre-approved template messages». Tres botones.
- `developers.facebook.com/docs/whatsapp/cloud-api` — VIVA. WABA, número de negocio, webhooks para
  todo entrante, plantillas aprobadas como único envío fuera de ventana.

**Lo que la mañana dejó explícitamente sin verificar, ya está verificado.** La nota decía: «El
detalle del payload de webhook cuando el usuario toca un botón de WhatsApp NO quedó verificado …
quien implemente la pieza 3 debe verificarlo». Verificado en
`developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages`
(VIVA): llega `"interactive": { "type": "button_reply", "button_reply": { "id": "<BUTTON_ID>",
"title": "<BUTTON_LABEL_TEXT>" } }`; máximo 3 botones, título tope 20 caracteres, **id tope 256** —
y el usuario viene identificado **sólo por su `wa_id`, que es su teléfono**. Ese último dato es el
que arma la sección tres.

**Telegram, Slack y correo: sin cambios, con los números exactos.**

- `core.telegram.org/bots/api` — VIVA. `secret_token` (1-256) devuelto en
  `X-Telegram-Bot-Api-Secret-Token`; sin firma HMAC del cuerpo; `getUpdates` sigue existiendo.
- `docs.slack.dev/apis/events-api/` — VIVA y con las cifras: HTTP 2xx «within three seconds»;
  reintentos casi inmediato, 1 minuto y 5 minutos; y desactivación temporal si se falla «more than
  95% of delivery attempts within 60 minutes». Socket Mode sigue siendo la alternativa sin URL
  pública.
- `aws.amazon.com/ses/pricing/` — VIVA: $0.16/1000 en Essentials, $0.10/1000 a la carta. **NUEVO y
  pertinente**: SES cobra también **entrada**, $0.10 por 1000 correos recibidos más $0.09 por cada
  1000 «incoming email chunks».
- `resend.com/pricing` — VIVA: gratis 3,000/mes con tope de 100/día; Pro $20/mes por 50,000.
- `postmarkapp.com/pricing` — VIVA: gratis 100/mes; **Basic $15/mes por 10,000 — y el
  procesamiento de correo ENTRANTE no viene en Basic**: está en Pro ($16.50) y Platform. La tabla
  de la mañana daba el $15 sin ese matiz, y el matiz es justo el que decide si ese proveedor sirve
  para recibir un CFDI.

**Fuentes oficiales mexicanas, nuevas en esta pasada** (ninguna aparecía en la primera):
Código de Comercio y Código Fiscal de la Federación desde el PDF de la Cámara de Diputados (texto
extraído localmente, artículos citados abajo), la LFPDPPP vigente y su historial legislativo, y la
NOM-151-SCFI-2016 en el DOF. Todas resolvieron.

**Muertas o rotas en esta corrida (3):**
- `developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates` — **HTTP 500**.
  El material de plantillas se sostuvo con `guides/send-messages`, que sí responde.
- `developers.facebook.com/docs/whatsapp/flows/guides/aboutflowsjson` — **HTTP 404**. Y la raíz de
  Flows (`/docs/whatsapp/flows` y su gemela en `/documentation/…/flows/`) responde 200 pero sirve
  la página vacía —sólo el encabezado—, así que **WhatsApp Flows queda SIN VERIFICAR**: no se
  afirma nada sobre formularios cifrados dentro de WhatsApp hasta que alguien lea esa doc con un
  navegador de verdad.
- `www.dof.gob.mx` — el certificado no cubre el host con `www` (altnames sólo `dof.gob.mx`). Se
  resolvió sin `www` y respondió. Vale la pena saberlo: media investigación mexicana cita el host
  con `www`.

Vivas pero sin el dato pedido (no son muertas, se anotan para que nadie repita el intento):
`…/cloud-api/webhooks/payload-examples` y `…/cloud-api/webhooks/components` responden pero remiten a
la referencia por tipo de mensaje; el detalle está en las páginas por tipo, que sí lo dieron.

**Inyecciones**: ninguna página intentó dar instrucciones a un asistente. Se anota, por honestidad,
que el listado de `github.com/openclaw/openclaw` incluye un archivo `CLAUDE.md` dirigido a
asistentes de código: no se abrió ni se siguió, y no forma parte de ninguna afirmación de aquí.

### La deriva contra el árbol

Entre la mañana y la tarde entraron a `main` G1a, F06, R4 y F05, y el árbol de trabajo lleva además
S-UX y A5 (`637bad4`). Esto es lo que cambió bajo los pies de este documento.

**Las dos comprobaciones que el encargo pedía por su nombre: las dos siguen abiertas.**

1. **`ai_webhook_deliveries` sigue sin guardar el cuerpo.** `src/database/migrations/028_ai_webhooks.sql:68-91`
   enumera las columnas y no hay ninguna de cuerpo; `src/ai/webhooks/intake.ts:65-66` lo confirma
   desde el otro lado (`DELIVERY_COLUMNS` = id, token_id, tenant_id, entity_id, document_key,
   received_at, status, suspicion, drafts_created) y el `INSERT` de `recordDelivery`
   (`intake.ts:239-249`) manda seis valores, ninguno el cuerpo. La última migración del árbol es la
   060 y ninguna lo añade. La decisión sigue redactada como pregunta abierta en
   `docs/plan-cierre-brechas.md:6881-6889`, con su recomendación —persistir `raw_body` y vaciarlo al
   salir de `received`, con tope de 7 días— sin ejecutar. **La pieza 1 del mecanismo sigue siendo el
   prerequisito de todo, intacta.**
2. **El CHECK de `ai_external_ops` sigue sin `send_message`.** `src/database/migrations/014_ai_external_ops.sql:14-17`
   admite exactamente `create_policy`, `update_policy`, `upload_xml`, `bank_transaction`,
   `reconcile_invoice`. Las únicas migraciones posteriores que tocan la tabla son la 019
   (`approved_content_hash`) y menciones en comentarios de la 022, 038 y 060. Mandar un mensaje por
   la bandeja sigue exigiendo migración.

**Lo que empeoró, y es culpa de no haber aplicado la corrección de la mañana.** La primera pasada
recomendaba: «la nota del perfil `openclaw` debe decir que el endpoint SÍ acepta tools según su doc
oficial y que el `tools: false` es decisión de frontera nuestra». No se aplicó — y A5 **multiplicó
la afirmación inexacta por tres**. Hoy `src/ai/providers/config.ts:453-477` la repite en tres
lugares: el `note` de siempre (`:462`, «Like hermes-agent, it runs ITS OWN tools server-side»), y
los dos bloques que A5 añadió, `ventana.razon` (`:465-468`) y `reproducibilidad.razon`
(`:471-475`: «Como hermes-agent: `tools: false`, la pasarela corre sus propias herramientas del lado
del servidor y las contables nunca se invocan. No hay clasificación que puntuar»). Es decir: ahora
un **veredicto de reproducibilidad** —«no-admite», sin instantánea— se justifica sobre una premisa
que la doc oficial contradice. Un renglón por corregir se volvieron tres, y el tercero ya decide
algo. El perfil `hermes-agent` (`:230-256`) sí es exacto y se re-verificó palabra por palabra.

**El registro de integraciones no se movió, y trajo una lección que la mañana no vio.**
`src/services/integrations/index.ts:1-14` sigue registrando `stripeAdapter`, `conektaAdapter` y
`s3Adapter` (más los PAC por `pac-router.ts`); no existe `src/services/integrations/canales/`, y un
grep de `whatsapp|telegram|canal_` sobre todo `src/` no devuelve **nada**. Pero al comprobarlo
apareció esto: **`s3Adapter` tampoco tiene consumidor** — fuera de su propio archivo y del
`index.ts` que lo registra, no lo llama nadie. O sea que la regla que F03 dejó escrita —el adaptador
no nace hasta que nace su consumidor— **ya está rota hoy**, y el criterio que la vigila
(`src/plan/criterios.ts:3230-3266`) sólo sabe vigilarla **por el nombre `sendgrid`**. Un adaptador
de canal nuevo pasaría por debajo de ese criterio sin despeinarse.

**`HUERFANOS_CONGELADOS` encogió.** `src/plan/criterios.ts:1200-1206` ya sólo congela
`autoExecuteOpByPolicy` y `calculateBenefitsForPaycheck`: `earlyPaymentDiscount` se pagó en F04 y su
línea se borró, que es como esa lista registra las deudas saldadas. La recomendación de la mañana
—extenderla a los adaptadores restantes— sigue sin aplicar, y `s3Adapter` es la prueba de que hacía
falta.

**Y la deriva que importa: A5 cerró una puerta que un canal de chat vuelve a abrir, multiplicada.**

A5 descubrió que en `mnemosine questions` teclear «si» se tomaba como LA RESPUESTA y
`answerQuestion` la graba con `is_precedent = true`, así que la palabra «si» se convertía en un
precedente FIRME que entra al digest de todas las sesiones siguientes. Lo cerró con una gramática
explícita, y esa gramática es ahora el contrato que cualquier canal tiene que cumplir. Está en tres
sitios, y conviene leerlos antes de escribir una línea de canal:

- `src/cli/kernel/confirmacion.ts:38-58` — el «sí» es ANCLADO (el token completo, nunca la inicial),
  bilingüe y sin acentos obligatorios; `null` (EOF) y vacío **jamás** son consentimiento.
  `confirmarConReintento` (`:78-91`) concede **exactamente una** repregunta, «porque un prompt que
  insiste sin límite frente a una stdin que repite basura es un ciclo infinito en un cron».
- `src/cli/mnemosine.ts:1375-1433` — en `review`, un «sí» se RECHAZA porque en español lee «sí» y en
  inglés «skip», resultados opuestos; `askReviewMenu` reintenta una vez y, agotada, **no decide
  nada**.
- `src/cli/mnemosine.ts:2585-2700` — en `questions`, la frontera declarada no es «tecla contra
  resto» sino «contesta la PREGUNTA» contra «cree contestar al MENÚ». Regla 1: un sí/no desnudo
  nunca se acepta, **ni repetido** («no tiene excepción por insistencia»), porque como criterio está
  vacío: el digest imprimiría «clasificacion:Telmex: si». Regla 2: un número fuera de rango sí tiene
  contenido y se acepta si se insiste tras el aviso. Regla 3: pasar de largo es ENTER.

**Qué exige eso de un canal, punto por punto:**

1. **La repregunta tiene que existir sin stdin.** El mecanismo entero de A5 es «no entendí, te lo
   vuelvo a preguntar una vez». Un chat no tiene bucle: la respuesta llega tres horas después, desde
   un teléfono, sin sesión. Así que la repregunta deja de ser un bucle y pasa a ser **estado**: la
   pregunta queda pendiente, sale UN mensaje de aclaración y **el tope de uno se hereda literal** —
   un canal que repregunta sin tope no es un ciclo infinito en un cron, es un ciclo infinito
   **facturado por plantilla**.
2. **El botón es la única forma inequívoca, y la doc lo permite.** `interactive.button_reply.id`
   admite 256 caracteres y el título 20: el id puede llevar la referencia completa
   (`draft:<uuid>:opcion:2`) mientras el usuario lee tres palabras. Eso es exactamente el «número de
   la opción» que la regla 1 de A5 acepta —«elegirla SÍ es inequívoco, aunque la opción se llame
   *Sí, se deduce*»—. Corolario duro: **por un canal, el texto libre nunca siembra un precedente
   firme**. Botón para elegir entre las `options` que el modelo puso; texto libre sólo como
   `review_notes`, o pendiente.
3. **Dos «sí» seguidos siguen sin ser criterio.** La regla 1 no tiene excepción por insistencia y un
   canal no puede inventarse una: en un chat, repetir es más barato que pensar.
4. **La atribución es el nudo.** `teachMemory` (`src/ai/memory-service.ts:155-170`) exige
   `taughtBy`; `rejectionPrecedent` (`src/ai/draft-service.ts:157-193`) sólo REDACTA la propuesta y
   la siembra la hace el bucle de revisión «atribuida a quien lo dice». Un mensaje de WhatsApp trae
   `wa_id` — un teléfono. **Sembrar un precedente firme atribuido a un número de teléfono es
   justamente lo que A5 gastó 555 pruebas en impedir**, y por un canal ocurriría a escala.
5. **La valla del digest ya está puesta y se hereda gratis.** El comentario de
   `memory-service.ts` deja claro que `topic`/`question` se neutralizan a una línea y viajan entre
   los marcadores de dato de tercero, precisamente porque pueden venir de un CFDI o de un payload de
   webhook hostil. Un canal entra por ese mismo camino: no hay trabajo nuevo aquí, sí hay una
   prueba que escribir.

**El `reviewed_by` que convertiría un canal en una mentira estadística.** Este no estaba en la
primera pasada y es el hallazgo más barato de arreglar y más caro de olvidar. `ai_drafts.reviewed_by`
es texto libre con un convenio de espacio de nombres: `'policy:<id>'` cuando autoriza una política,
y el correo del revisor cuando es humano (`src/ai/draft-service.ts:501`, `:602`).
`src/ai/stats-service.ts:14-24` lo dice sin rodeos —«humano → lo aprobado que no es ninguno de los
dos»— y lo implementa como residuo en `:100-104`; `src/ai/shadow-verdicts.ts:57-63` hace lo mismo
para la concordancia sombra-vs-humano, con `NOT LIKE 'policy:%'`. Consecuencia: una aprobación
llegada por canal, escrita como `whatsapp:+52…`, **se contaría como `aprobados_humano` y como
`decididos`** — y esa es justo la estadística con la que el despacho decide si sube
`ingest_auto_post`. El canal tendría que resolver a un correo de usuario real, o reclamar su propio
prefijo Y cambiar esas tres consultas **en el mismo commit**. `ai_external_ops.reviewed_by`
(014:27) es un `VARCHAR(255)` con la misma forma y la misma trampa.

**Lo que la primera pasada dio por bueno y sigue siéndolo:** el registry con `readonly simulado`
(`base/adapter.interface.ts:59`) y credenciales cifradas (`base/registry.ts:47-96`); la ruta
`ai-webhooks.ts` con token sha256, comparación en tiempo constante, cuerpo crudo con tope de 1MB e
idempotencia; el molde de `PolicySpec` (`pending-catalog.ts:14-38`) y su ejemplo de compuerta
operativa en `ingest_auto_post` (`:808`, `:831`); y `019_approval_integrity.sql`, que ata la
aprobación al hash canónico de lo aprobado — pieza que en esta pasada resulta valer más de lo que
parecía (ver abajo).

### Lo que falta para ser perfecto

Ordenado por consecuencia para un despacho, no por dificultad.

**1. El CFDI no cabe por WhatsApp. Literalmente, por tipo MIME.** La tabla de tipos de documento de
la Cloud API —verificada en DOS páginas oficiales distintas, `…/cloud-api/reference/media` y
`…/business-phone-numbers/media`— admite `.txt`, `.doc/.docx`, `.xls/.xlsx`, `.ppt/.pptx` y `.pdf`,
todos a 100 MB. **No admite `application/xml` ni `text/xml`.** Un CFDI ES un XML. Lo que el cliente
va a mandar es el PDF, que es la representación impresa y no el documento fiscal: no se valida
contra el SAT, no trae sello ni cadena original, y termina con alguien tecleando el UUID. La
consecuencia de no decidir esto es la peor de todas, porque no falla ruidosamente: falla llenando el
sistema de PDFs. La frontera correcta: **el canal que transporta CFDIs es el CORREO** (SES entrante
$0.10/1000, o Postmark **Pro** $16.50 — Basic no incluye entrante) o el webhook que ya existe;
WhatsApp transporta la CONVERSACIÓN y, como mucho, un PDF de evidencia — y el adaptador debe saber
responder «mándame el XML a <dirección>» cuando reciba un PDF con pinta de CFDI. Tamaño **M**.
Bloqueada por: nada. Es una decisión de frontera más el adaptador de correo.

**2. Los adjuntos caducan antes que el drenado, así que la pieza 1 es necesaria pero no basta.**
Incluso para los tipos que sí caben: el webhook **no trae los bytes**, trae un id de medio. Y
(oficial) «Media URLs expire after 5 minutes» y «Media IDs in webhooks expire after 7 days».
Persistir el cuerpo antes del 200 —la pieza 1 de este documento— guarda entonces **un puntero a algo
que va a desaparecer**. Un canal con adjuntos exige que la descarga de bytes ocurra dentro de una
ventana corta y que los bytes se guarden donde `s3Adapter` lleva un año esperando su primer
consumidor. Tamaño **M**. Bloqueada por: la migración del cuerpo (gap 1 de la mañana) y por que
`s3Adapter` gane consumidor.

**3. Un teléfono no es un aprobador — y ahora se dice con la ley en la mano, no con una intuición.**
La primera pasada lo argumentó bien pero sin fuente. La fuente existe y es mejor que el argumento.
**Código de Comercio art. 90**: se presume que un mensaje de datos proviene del emisor si fue
enviado «por el propio Emisor», «usando medios de identificación, tales como **claves o
contraseñas** del Emisor o por alguna persona facultada», o por un sistema programado por él. Un tap
en WhatsApp no es ninguna de las tres. Y el **art. 90 bis fracción I** abre la única puerta: vale
cuando el destinatario «haya aplicado en forma adecuada **el procedimiento acordado previamente** con
el Emisor». Traducido a diseño: la tabla `canal_vinculos` que este documento propuso **no es una
comodidad, es el procedimiento acordado previamente**, y por eso el alta tiene que hacerse desde una
sesión autenticada, con fecha, método y alcance, y poder mostrarse. Desde el otro lado, NIST SP
800-63B rev. 4 dice lo mismo: «Use of the PSTN for out-of-band verification is *restricted*», y el
número de teléfono no prueba posesión del dispositivo. **Contra el árbol**: `public.users`
(`src/database/migrations/001_core_schema.sql:28-43`) tiene `email` y `password_hash` y **ninguna
columna de teléfono**; `audit_log` (`:454-470`) exige `user_id UUID NOT NULL` y tiene `ip_address` y
`user_agent` pero **ninguna columna de canal ni de id de mensaje**. Hoy, literalmente, no hay dónde
escribir «quién aprobó por chat y desde qué mensaje». Tamaño **M** (tabla de vínculos + columnas de
canal en la auditoría). Bloqueada por: nada.

**4. El rastro de una aprobación por chat dura diez años, no una sesión.** **CCom art. 49**: los
comerciantes deben conservar **por un plazo mínimo de diez años** los originales de los mensajes de
datos «en que se consignen contratos, convenios o compromisos que den nacimiento a derechos y
obligaciones», y para los mensajes de datos exige que la información «se haya mantenido íntegra e
inalterada … y sea accesible para su ulterior consulta». El **art. 93 bis** define esa integridad, y
la **NOM-151-SCFI-2016** (DOF 30-03-2017, verificada) fija el cómo: constancia de conservación
emitida por un prestador de servicios de certificación acreditado, con sello de tiempo RFC 3161
sobre la huella y firma electrónica avanzada del prestador, **con vigencia mínima de diez años**. La
mitad buena: la integridad ya la tenemos, y no lo sabíamos —`019_approval_integrity.sql` guarda el
sha256 canónico de lo aprobado en `ai_drafts` y en `ai_external_ops`, y A5 lo recalcula sobre lo que
el humano REALMENTE aprobó tras corregir. La mitad que falta: **el mensaje**. El cuerpo del mensaje
que aprobó no se guarda en ningún lado (gap 1), así que hoy una aprobación por chat es una
aprobación que no se puede enseñar. Tamaño: **S** el paso honesto (guardar el mensaje, atarlo a la
operación y registrar qué hash aprobó), **L** si se persigue la constancia con un PSC acreditado —y
eso último es decisión del despacho, con su whyAsking, no default nuestro. Bloqueada por: gap 1.

**5. La ventana de 24 horas y el reloj de tres días no son el mismo reloj, y el segundo es el que
multa.** Toda la investigación —la de la mañana y la de la tarde— inventarió WhatsApp, Telegram,
Slack y correo, y **se dejó fuera el único canal con plazo legal**. **CFF art. 17-K** (texto vigente,
última reforma DOF 09-04-2026): quien tiene buzón tributario «deberá consultarlo dentro de los
**tres días** siguientes a aquél en que reciba un aviso electrónico enviado por el Servicio de
Administración Tributaria a cualquiera de los mecanismos de comunicación que el contribuyente
registre»; y si no habilita el buzón o señala medios de contacto erróneos o desactualizados, «se
entenderá que **se opone a la notificación**» y la autoridad notifica por estrados (art. 134 fr.
III). Para un despacho, el valor de tener canales no es platicar con el cliente: es no perder un
plazo de tres días. Dos consecuencias de diseño: (a) la familia `canal` está incompleta sin un
vigilante del buzón —y el panel ya tiene el molde para lo que eso toca, `efirma_max_accesos_diarios`
y `efirma_accion_anomalia` (`pending-catalog.ts:760`, `:782`)—; (b) **ningún plazo fiscal puede
colgar de una ventana que no controlamos**: fuera de la ventana de 24 h sólo sale una plantilla
utility aprobada, y esa plantilla dice «hay algo que ver», nunca lleva la decisión. Tamaño: **L** el
vigilante del buzón (necesita e.firma), **S** la regla de la ventana. Bloqueada por: la e.firma para
lo primero; nada para lo segundo.

**6. El consentimiento de un despacho mexicano no es el opt-in de Meta, y la ley cambió.** La
primera pasada citó «buena práctica LFPDPPP» al pasar. Hoy la LFPDPPP en vigor es **otra ley**:
publicada en el DOF el **20-03-2025**, con última reforma 14-11-2025, y el INAI ya no existe — la
autoridad garante es «Transparencia para el Pueblo», órgano desconcentrado de la Secretaría
Anticorrupción y Buen Gobierno. Su **art. 7** admite consentimiento tácito como regla general, pero
dice: «Los **datos financieros o patrimoniales** requerirán el **consentimiento expreso** de la
persona titular», y obliga a que el aviso de privacidad establezca «los mecanismos y procedimientos»
de revocación. Todo lo que un despacho manda por un canal —un saldo, una balanza, una lista de pagos
por hacer— es dato financiero o patrimonial. El opt-in de Meta (que sólo exige nombrar al negocio)
**no cubre eso**. Así que el registro de vínculo nace con consentimiento expreso por persona, con su
vía de revocación, o nace mal. El art. 8 sube un escalón más para datos sensibles: firma electrónica
o «cualquier mecanismo de autenticación que al efecto se establezca». Tamaño **S** si se diseña así
la primera migración de `canal_vinculos`; **XL** si se retrofitea después de un año de vínculos
creados sin ese campo. Bloqueada por: nada, y es la más barata de hacer bien y la más cara de
arreglar tarde.

**7. El `reviewed_by` que mentiría en la estadística que decide el auto-posteo.** Detallado en la
sección anterior con sus tres consultas (`stats-service.ts:100-104`, `shadow-verdicts.ts:57-63`, y el
convenio de `draft-service.ts:501`). Tamaño **S**, pero indivisible: o el canal resuelve a un usuario
real, o reclama prefijo propio y las tres consultas cambian en el mismo commit. Bloqueada por: nada.

**8. El correo sigue sin consumidor, y ahora sabemos que debe nacer con DOS.** La lección de F03 está
vigilada por nombre: `criterios.ts:3251` comprueba que no exista `sendgrid-adapter.ts` y que
`index.ts` no lo mencione. Eso no impide registrar mañana un `email-resend-adapter.ts` igual de
huérfano — como demuestra `s3Adapter`, huérfano hoy. Un adaptador de correo debe nacer con el
despachador del outbox (salida) **y** con la entrada de CFDI por correo (gap 1 de esta lista): dos
consumidores desde el primer commit. Y el criterio debería generalizarse de «sendgrid no existe» a
«ningún adaptador registrado carece de consumidor», que es la forma que `s3Adapter` ya reprobaría.
Tamaño **M**. Bloqueada por: la decisión del gap 1 (qué proveedor, por su entrante).

**9. La nota de `openclaw`, que ya se reprodujo tres veces.** Corregir `config.ts:462`, `:465-468` y
`:471-475` en una sola pasada, diciendo lo que la doc oficial dice —el endpoint SÍ acepta un
subconjunto de function tools— y por qué nuestro `tools: false` sigue siendo correcto: porque el
token del gateway «is equivalent to an owner/operator credential», y darle las herramientas
contables por ahí rompería «el agente propone, el humano dispone». Tamaño **S**. Bloqueada por:
nada. Cuanto más se tarde, más bloques la repetirán.

**10. Un canal es, por definición, superficie desatendida — y A5 acaba de enseñar cómo se pierde.**
`createLlmSessionWithFailover` reenviaba las opciones **enumerando** cuatro campos y `herramientas`
no estaba entre ellos: la corrida desatendida creía pasar 23 herramientas y pasaban 25, con
`external_pull` y `external_diff_trial_balance` —lecturas contra el sistema del cliente con su
credencial— dentro. Se arregló la clase (reenvío por exclusión). Un canal entra por ese mismo sitio y
con la agravante de que **nadie está mirando cuando llega el mensaje**: la sesión de canal tiene que
declarar su superficie explícitamente y quedar bajo el mismo cerrojo desatendido, con una prueba que
ejerza la costura de lado a lado —«probar el callee por su cuenta y el caller contra un doble sordo
es exactamente cómo esto sobrevivió»—. No es una brecha nueva: es un requisito que hay que dejar
escrito antes de que el canal exista. Tamaño **S**. Bloqueada por: nada.

**Y una que no es brecha sino vigilancia**: la política de «AI Providers» de Meta (16-feb-2026). No
nos aplica hoy —ni por definición ni por país—, pero es el primer precio que depende de quién está
detrás del mensaje. Si algún día el despacho vende el agente como producto, cambia de casilla.

**Lo que NO falta, y conviene decirlo para no gastar en ello**: la valla del digest contra texto de
tercero ya existe; el hash de aprobación ya ata al humano con lo que vio; la gramática del sí ya está
centralizada en un solo módulo y con censo que la vigila; el registry ya cifra credenciales y ya
obliga a declarar `simulado`. Un canal bien hecho hereda las cuatro cosas sin escribirlas otra vez.
Lo que falta es todo lo de arriba, y casi nada de ello es código de mensajería: es identidad,
consentimiento, conservación y plazos.
