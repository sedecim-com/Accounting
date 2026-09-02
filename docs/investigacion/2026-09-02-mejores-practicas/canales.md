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
