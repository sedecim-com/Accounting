# Canales de mensajería

> **Esta página describe investigación y dirección, no capacidades.** Hoy no se puede conectar WhatsApp, ni Telegram, ni Slack, ni correo a mnemosine. No existe ningún adaptador de canal, el CHECK de la bandeja de salida no admite mensajes, y el webhook de entrada tiene un hoyo conocido que lo inutiliza. Lo que sigue es el resultado de la investigación del 2026-09-02 y la forma que tomaría el tramo F06 si entra al plan.

## El estándar de la casa: gateways de chat, sin herramientas

Dos gateways de mensajería ya están declarados en la configuración de proveedores ([`src/ai/providers/config.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/providers/config.ts)) como **chat puro, `tools: false`** — ver [[Proveedores-de-modelo]]:

- **[hermes-agent](https://github.com/NousResearch/hermes-agent)** (Nous Research, MIT): agente con gateway de mensajería propio — Telegram, Discord, Slack, WhatsApp, Signal y CLI desde un solo proceso — y herramientas que corren del lado del servidor. Su [API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) confirma la nota del perfil al pie de la letra: puerto 8642, bind loopback, llave obligatoria que "da acceso pleno al toolset del agente, incluida la terminal", y **no acepta herramientas del cliente**: las tool calls ya fueron ejecutadas en su servidor. Aquí `tools: false` es limitación técnica además de decisión.
- **[OpenClaw](https://github.com/openclaw/openclaw)** (OpenClaw Foundation, MIT): gateway autoalojado con [más de 30 canales](https://docs.openclaw.ai/channels), [políticas de acceso por remitente](https://docs.openclaw.ai/gateway/config-channels) (`dmPolicy: pairing` por defecto: un desconocido recibe código de aprobación de un solo uso) y un [modelo de seguridad](https://docs.openclaw.ai/gateway/security) que asume la inyección de prompts como amenaza seria. Su [endpoint OpenAI-compatible](https://docs.openclaw.ai/gateway/openai-http-api) viene apagado por defecto y su doc ordena tratarlo como acceso pleno de operador. Matiz honesto: ese endpoint **sí** acepta tools del cliente según su doc oficial — nuestro `tools: false` no es incapacidad del gateway sino decisión de frontera: como el token es credencial de operador completa, darle las herramientas contables por ahí violaría "el agente propone, el humano dispone" (ver [[El-agente-y-sus-limites]]).

Y la limitación que define su lugar: el canal WhatsApp de OpenClaw usa [Baileys](https://docs.openclaw.ai/channels/whatsapp) — WhatsApp Web no oficial, emparejamiento por QR de una cuenta personal. Para un despacho que le escribe a **clientes** eso es inaceptable: identidad débil, riesgo de términos de servicio, sin plantillas ni opt-in formal. Los gateways sirven como frente conversacional del **operador**, en loopback, jamás como canal de salida hacia clientes.

## El canal como adaptador, no como proveedor

La dirección de la investigación: un canal de mensajería es un **adaptador del registry de integraciones** ([`src/services/integrations/index.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/integrations/index.ts)), con `readonly simulado` declarado y credenciales cifradas en `integration_credentials` — nunca en config. La lección que gobierna el molde es la del adaptador SendGrid: se retiró por simulado sin consumidor, y el criterio F03 en [`src/plan/criterios.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/plan/criterios.ts) hoy vigila que no reviva tal cual. **El adaptador no nace hasta que nace su consumidor.**

### Entrada: persistir antes del 200

La infraestructura de entrada existe y está bien armada — [`src/api/rest/routes/ai-webhooks.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/api/rest/routes/ai-webhooks.ts): token dedicado verificado en tiempo constante, cuerpo crudo con tope de 1MB, idempotencia, todo acotado al inquilino — **salvo por el hoyo que la mata**: `ai_webhook_deliveries` no guarda el cuerpo del mensaje, mientras el procesador lo exige. Toda entrega recibida sin el lector vivo en ese instante responde 200 y queda muerta para siempre (`docs/plan-cierre-brechas.md`, hallazgo en la línea 6881). Cerrar ese hoyo es el prerrequisito de cualquier canal: sin él, cada canal nuevo hereda el mismo pozo sin fondo. Y el proveedor lo agrava: Meta reintenta hasta 7 días cuando no respondes 200 — responder 200 sin persistir, como hoy, además desactiva el único mecanismo de recuperación que el proveedor regala.

El patrón que la investigación fija: registrar-y-responder, procesar después. Cada canal verifica la firma de su proveedor sobre el cuerpo crudo, persiste, responde rápido (Slack exige 2xx en 3 segundos) y el lector restringido procesa en su momento. Todo texto entrante es dato, nunca instrucción.

### Salida: solo por la bandeja, con humano

La bandeja ya existe: `ai_external_ops` ([`src/database/migrations/014_ai_external_ops.sql`](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrations/014_ai_external_ops.sql)) — la IA solo encola con su `ai_reasoning` obligatorio, el humano revisa y ejecuta con `mnemosine outbox`, reclamo atómico. Pero su CHECK de `operation` solo admite operaciones contables: **no existe `send_message`**. Mandar un mensaje por la bandeja requiere migración. Esa es la puerta única de salida planeada: el despachador del outbox es el único código que puede llamar `enviar()` de un adaptador de canal — y eso se vigila con un criterio grep-able, no con buenas intenciones.

## Los canales investigados

| Canal | Entrada (verificación) | Salida | Costo | Identidad del remitente | Veredicto |
|---|---|---|---|---|---|
| [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) (Meta) | [Webhook firmado](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks) HMAC-SHA256 (`X-Hub-Signature-256`) sobre el cuerpo crudo; reintentos 7 días | Plantillas aprobadas fuera de ventana; libre + [hasta 3 botones](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages) dentro de la ventana de 24h | [Por mensaje de plantilla entregado](https://developers.facebook.com/docs/whatsapp/pricing) desde jul-2025; servicio dentro de ventana gratis | WABA con nombre de negocio; [opt-in obligatorio](https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in) | El canal de clientes. Adaptador prioritario |
| [Telegram Bot API](https://core.telegram.org/bots/api) | `setWebhook` + `secret_token` en encabezado, o long polling sin endpoint público | `sendMessage` libre | Gratis | @bot público | Secundario barato; bueno para pilotos y operadores |
| [Slack Events API](https://docs.slack.dev/apis/events-api/) | Signing secret; 2xx en 3s o desactiva la suscripción; Socket Mode sin URL pública | `chat.postMessage` | Por plan del workspace | App del workspace | Canal interno del despacho, no de clientes |
| Correo: [SES](https://aws.amazon.com/ses/pricing/) / [Postmark](https://postmarkapp.com/pricing) / [Resend](https://resend.com/pricing) | n/a | API | $0.10 USD/1000 (SES); gratis 100/mes, $15/10k (Postmark); gratis 3,000/mes, $20/50k (Resend) | Dominio propio (DKIM) | Uno solo, con consumidor desde el primer commit — revive la promesa de `invoice send` que el retiro de SendGrid dejó hueca |
| [OpenClaw](https://github.com/openclaw/openclaw) | dmPolicy pairing/allowlist; token = operador | Sus 30+ canales (WhatsApp vía Baileys, no oficial) | MIT | El número/bot vinculado | Frente del operador en loopback; jamás canal de clientes ni herramientas contables |
| [hermes-agent](https://github.com/NousResearch/hermes-agent) | API server 8642, bearer, loopback; no acepta tools del cliente | Telegram/Discord/Slack/WhatsApp/Signal/CLI | MIT | El bot vinculado | Igual que OpenClaw |

## Cómo sobrevive el maker-checker en un chat

El problema de fondo: **un tap en un botón de WhatsApp autentica "alguien con ese teléfono", no "el contador con permiso de aprobar"**. Teléfono no es identidad del sistema. OpenClaw lo dice a su manera: su primera capa es decidir quién puede hablarle al bot, y su token es credencial de operador completa — no existe el token de medio pelo.

La escalera que la investigación propone, cada peldaño como política del panel ([`src/services/policy/pending-catalog.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/policy/pending-catalog.ts)) con su lector, nunca como default:

1. **Notificar** (`canal_notificaciones`, omisión: apagado): el canal avisa "hay 3 operaciones esperando en outbox". Nada más.
2. **Pre-revisar** (`canal_aprobacion_en_chat: pre-revision`): el botón "revisado" adjunta la respuesta del canal a la operación **como evidencia** — pero ejecutar sigue exigiendo la identidad autenticada de `mnemosine outbox` o el panel.
3. **Aprobar con tope** (`canal_aprobacion_en_chat: aprobar-con-tope`): solo con vínculo verificado usuario↔canal registrado (tabla `canal_vinculos` con opt-in fechado y opt-out respetado al instante) y bajo monto máximo. Es una bifurcación de criterio del despacho: nace en apagado y solo el despacho la mueve, con su `whyAsking` y su `ifSkipped` a la vista.

La omisión de todo es apagado. La comodidad no gana por default.

## Qué entraría al plan (tramo F06, propuesto)

1. Persistir el cuerpo en `ai_webhook_deliveries` y drenar entregas registradas — prerrequisito de todo y valioso por sí solo.
2. `send_message` en el CHECK de `ai_external_ops` y el despachador en `mnemosine outbox`.
3. Adaptador `whatsapp-cloud` real (Cloud API oficial, nunca Baileys) con `canal_vinculos` y opt-in.
4. Un adaptador de correo real — esta vez con consumidor desde el primer commit.
5. Las tres políticas del panel, filas de catálogo para la familia `canal` y criterios ejecutables que las vigilen.
6. Documental: la receta del patrón gateway (OpenClaw/hermes en loopback → API de mnemosine con token acotado de lectura + encolar; jamás el mayor).

Nota pendiente de la propia investigación: el detalle del payload cuando un usuario toca un botón de WhatsApp no quedó verificado en la doc consultada — quien implemente la pieza 3 debe verificarlo antes de codificar.

## Páginas relacionadas

- [[El-tablero-grafico]] — la otra superficie investigada; comparte la regla de no ser motor.
- [[El-agente-y-sus-limites]] — por qué la salida pasa por la bandeja y el agente jamás envía solo.
- [[Proveedores-de-modelo]] — donde ya viven los perfiles `tools: false` de los gateways.
- [[Aislamiento-multi-inquilino]] — el acotamiento que todo webhook de entrada hereda.
