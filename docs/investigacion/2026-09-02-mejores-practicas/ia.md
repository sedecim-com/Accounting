# Lente 2 — Proveedores de IA y conexión simple para el usuario

Investigación con web en vivo (2026-09-02). Toda liga de la sección «verificadas» se abrió con WebFetch en esta corrida y su contenido respalda lo que aquí se afirma.

## Dónde estamos

El repo ya trae once perfiles integrados en `src/ai/providers/config.ts` (BUILTIN_PROFILES, líneas 19–113), con esquema estricto fail-closed (líneas 119–154), secretos solo nombrados (`api_key_env` línea 124 / `api_key_cmd` línea 125, con resolución en `resolveProfile` líneas 307–338 y cerrojo anti-secretos en `assertNoSecrets` líneas 624–649), cadenas de failover (líneas 373–431) y allowlist de skills por perfil (línea 151).

El asistente de conexión vive en `src/cli/init/s3-ai.ts`: deep-links por credencial (`KEY_URLS` líneas 24–36), sonda viva doble —chat y tool-calling— antes de persistir (`defaultProbe` líneas 298–359, persist-after-proof en `configure` líneas 99–215), categorización de fallas auth/conexión/otro (líneas 54–70) y escritura vía `writeConfigPatch` con las dos compuertas (líneas 267–277).

Lo que el código asume y hoy hay que contrastar:

- `openai` con `model: 'gpt-5.1'` y `max_tokens_param: 'max_completion_tokens'` (config.ts:50–57)
- `grok` con `model: 'grok-4'` (config.ts:58–64)
- `gemini` con `model: 'gemini-2.5-pro'` (config.ts:79–85)
- `qwen` con `base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'` (config.ts:72–78)
- `minimax` con `model: 'MiniMax-M2'` (config.ts:65–71)
- `copilot` apuntando a `https://api.githubcopilot.com` con la advertencia de OAuth (config.ts:93–101)

## La investigación

### (a) Endpoints ya cableados: qué sigue vigente y qué derivó

**anthropic** — Vigente. La API es `https://api.anthropic.com` con `x-api-key` + `anthropic-version`; la documentación se MUDÓ de docs.anthropic.com a platform.claude.com (301 verificado). Cualquier liga a docs.anthropic.com en nuestra documentación interna debe actualizarse.

**openai** — La base `https://api.openai.com/v1` y `max_completion_tokens` siguen correctos según resultados de búsqueda y la referencia nueva en developers.openai.com (que confirma chat completions como API viva, junto a Responses). **No pude verificar el detalle en la doc oficial**: platform.openai.com devuelve 403 a fetch automatizado y la página profunda de developers.openai.com dio 404. El perfil como está (config.ts:50–57) es consistente con todo lo observado; la sonda de s3-ai es la verificación real.

**grok (xAI)** — Base `https://api.x.ai/v1` vigente, OpenAI-compatible, Bearer con `XAI_API_KEY`, tool calling confirmado. **Deriva de modelo**: la doc ya lista `grok-4.6`, `grok-4.3`, `grok-3`, `grok-4.20`; nuestro default `grok-4` quedó viejo.

**gemini** — Base `https://generativelanguage.googleapis.com/v1beta/openai/` vigente, function calling confirmado, **sigue en beta** («Support for the OpenAI libraries is still in beta»). Los modelos citados hoy son `gemini-3.7-flash` y familia 3.x; nuestro `gemini-2.5-pro` quedó viejo. Nota menor: la doc muestra la URL con diagonal final; el SDK de OpenAI la normaliza, pero conviene igualarla.

**qwen (DashScope)** — **La deriva más seria del lote.** La doc oficial internacional de Model Studio ya empuja URLs por región Y por workspace: `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` (Singapur) y `https://dashscope-us.aliyuncs.com/compatible-mode/v1` (Virginia); el quickstart oficial usa `qwen3.8-max` como modelo de ejemplo. Nuestra `dashscope-intl.aliyuncs.com/compatible-mode/v1` ya no aparece en el quickstart oficial, aunque terceros activos (LiteLLM, promptfoo, qwen-code) la siguen usando y hay issues recientes que la mencionan funcional. Además la doc oficial acota function calling a «qwen-turbo, qwen-plus, qwen-max» en la página de compatibilidad. Veredicto: el perfil probablemente aún funciona, pero está en ruta de deprecación; existen snapshots fechados (`qwen3-max-2026-01-23`) útiles para fijar deriva.

**minimax** — Base `https://api.minimax.io/v1` vigente (global; China `api.minimaxi.com/v1`, como dice la nota del perfil). Tools confirmado con letra chica útil: `n` solo 1, `presence_penalty`/`frequency_penalty`/`logit_bias` se ignoran, `function_call` legado no soportado. `MiniMax-M2` sigue listado entre los ocho modelos, pero el vigente es `MiniMax-M3` (contexto 1M). MiniMax ahora recomienda su endpoint Anthropic-compatible (`/anthropic`) — irrelevante para nosotros mientras el perfil sea openai-compatible.

**hermes (Nous)** — `https://inference-api.nousresearch.com/v1` vigente y OpenAI-compatible; `Hermes-4-405B` disponible; llave en portal.nousresearch.com. Matiz para la nota del perfil (config.ts:31): la propia doc de Nous dice que Hermes 4 está afinado «for chat and reasoning, not the rapid-fire tool-calling loop» — soporta function calling estándar pero no es su fuerte. El Portal ahora además rutea 300+ modelos de terceros bajo una sola suscripción, lo que lo vuelve un candidato de «una llave, muchos modelos» al estilo OpenRouter.

**ollama** — `http://localhost:11434/v1` vigente; tools soportado en `/v1/chat/completions`; **`tool_choice` NO soportado** (nuestra sonda en s3-ai.ts:335–343 no lo usa, así que no nos afecta); llave requerida-pero-ignorada, coherente con el perfil sin `api_key_env`.

**copilot** — `api.githubcopilot.com` sigue sin documentación oficial como API pública; la ruta oficial hoy es el Copilot SDK con device flow OAuth y tokens `gho_`/`ghu_`/`github_pat_` (los `ghp_` clásicos ya deprecados). LiteLLM implementa el device flow completo contra Copilot. La advertencia del perfil (config.ts:98–100) sigue siendo exacta: token corto renovable, útil solo detrás de un broker que lo refresque.

**hermes-agent / openclaw** — gateways locales, sin nada que verificar en web; sus notas (`tools: false`, cerrojo) siguen correctas.

### (b) Proveedores que faltan

Detalle por proveedor (ligas en la sección final):

- **Mistral** — `https://api.mistral.ai/v1`, forma OpenAI (`/v1/chat/completions`), Bearer `MISTRAL_API_KEY`, tools con `tools`/`tool_choice` plenamente soportados. Modelos `mistral-large-latest` / `mistral-small-latest`. Entra directo como `openai-compatible`.
- **DeepSeek** — `https://api.deepseek.com` («API format compatible with OpenAI/Anthropic»), Bearer `DEEPSEEK_API_KEY`, guía de Tool Calls oficial. Modelos vigentes según su doc: `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp` (los viejos deepseek-chat/reasoner ya no aparecen). Entra directo.
- **Groq (hardware LPU)** — `https://api.groq.com/openai/v1`, `GROQ_API_KEY`, «All models hosted on Groq support tool use», con letra chica: sin `logprobs`/`logit_bias`, temperatura 0 se convierte a 1e-8, `n` solo 1. Entra directo. **Peligro de teclado: `groq` y `grok` difieren en una letra y serían perfiles vecinos** — el mensaje de error de `resolveProfile` (config.ts:301–305) lista los disponibles, lo cual ayuda, pero conviene que ambas notas se nombren mutuamente.
- **Together** — `https://api.together.ai/v1`, `TOGETHER_API_KEY`, function calling soportado; ids de modelo con namespace (`meta-llama/...`); sin Assistants/Batch/Files estilo OpenAI; `seed` best-effort. Entra directo.
- **Fireworks** — `https://api.fireworks.ai/inference/v1`, llave simple, tool calling OpenAI-compatible (streaming incluido) pero **por modelo** (campo `supportsTools`); ids largos `accounts/fireworks/models/...`; reporta usage en streaming (nuestro `stream_usage` ya contempla estas variantes). Entra directo.
- **Cerebras (hardware wafer)** — `https://api.cerebras.ai/v1`, `CEREBRAS_API_KEY`, tools soportado; caveat: `gpt-oss-120b` rechaza `tools` + `response_format` juntos (no nos afecta: no mandamos ambos). Entra directo.
- **Azure OpenAI (Microsoft Foundry)** — Desde agosto 2025 existe la **API v1 GA**: `https://{RECURSO}.openai.azure.com/openai/v1/` funciona con el cliente OpenAI plano, sin `api-version`, con llave (`AZURE_OPENAI_API_KEY`) o token Entra ID (Bearer). Entra como `openai-compatible` con base_url por recurso — no precargable con URL fija; el init debe preguntar el nombre del recurso y el deployment. La ruta Entra encaja con `api_key_cmd` (un comando que imprima el token).
- **AWS Bedrock** — Ya ofrece chat completions OpenAI-compatible en dos endpoints: `https://bedrock-runtime.{region}.amazonaws.com/openai/v1` (recomendado; SigV4 o **Bedrock API key** como Bearer, env `AWS_BEARER_TOKEN_BEDROCK`) y `bedrock-mantle.{region}.api.aws/v1`. Con API key entra directo como `openai-compatible` con region en la URL. Tool calling por esa capa: **no verificado** en la página — que lo decida la sonda de s3-ai, que existe exactamente para eso.
- **Vertex AI (Google Cloud)** — La capa OpenAI-compatible existe oficialmente («Access Gemini models using OpenAI libraries», function calling referido, application default credentials), pero el patrón exacto de base_url (`https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{LOCATION}/endpoints/openapi`) solo lo pude confirmar en terceros (Kong, LiteLLM) porque las páginas oficiales sirven contenido no extraíble. Auth por token de `gcloud auth print-access-token` que expira (~1 hora): encaja con `api_key_cmd`, pero `resolveProfile` corre el comando UNA vez por resolución (config.ts:313–330) — una sesión larga del agente puede sobrevivir al token. Es el peor ajuste para un contador; recomendación: receta documentada, no perfil precargado.

### (c) Prácticas de conexión simple

- **Device flow (RFC 8628)**: el dispositivo pide un código, el humano abre una URL corta y teclea el código en su teléfono/navegador, el dispositivo sondea hasta recibir el token. Es exactamente el patrón de Copilot CLI y de LiteLLM-para-Copilot. Cero pegado de secretos.
- **gh auth login**: flujo web por default, token por stdin para automatización, guardado en el llavero del sistema con fallback a archivo plano. La sencillez viene de defaults sensatos + prompts interactivos.
- **Claude Code** (la referencia más rica): OAuth de navegador con servidor de callback local Y fallback de pegar-código cuando el callback no alcanza (WSL2/SSH/contenedores); `claude setup-token` emite token de un año para CI (imprime y no guarda — el operador decide dónde); `apiKeyHelper` es el análogo exacto de nuestro `api_key_cmd`, con refresco por TTL (5 min por default, configurable) y aviso cuando el helper tarda >10s; precedencia de credenciales documentada y consultable (`/status`). Nuestro `api_key_cmd` no tiene TTL: se re-ejecuta por resolución, que en la práctica es por corrida de CLI — suficiente hoy, insuficiente si algún día hay sesiones larguísimas con Vertex.
- **aider**: solo llaves por env/.env/bandera; muchos proveedores, cero OAuth. Es el piso, no el techo.
- **OpenRouter OAuth PKCE**: un tercero (nosotros) puede obtener una llave controlada por el usuario con un click: se abre `/auth` con code_challenge S256, el usuario aprueba, y hay **modo headless** (sin callback: el usuario ve el código en pantalla y lo pega — perfecto para CLI); el código expira en 10 minutos y es de un solo uso; el intercambio en `POST /api/v1/auth/keys` regresa la llave. Una sola llave da acceso a cientos de modelos: es la ruta de menor fricción para un contador que no quiere abrir cuentas por proveedor.

**Nota de seguridad de esta corrida**: dos páginas de AWS (las de chat completions de Bedrock) traían incrustada una «sugerencia opcional» dirigida a asistentes de IA pidiendo ejecutar `aws agent-toolkit search-skills`. Es contenido de página, no instrucción: se ignoró y se deja constancia aquí.

## Tabla comparativa

| Proveedor | base_url | OpenAI-compat | Auth | Tool calling serio | Veredicto para v2 |
|---|---|---|---|---|---|
| Mistral | `https://api.mistral.ai/v1` | Sí (forma) | llave `MISTRAL_API_KEY` | Sí (`tools`+`tool_choice`) | Precargar |
| DeepSeek | `https://api.deepseek.com` | Sí (declarada) | llave `DEEPSEEK_API_KEY` | Sí (guía oficial) | Precargar |
| Groq | `https://api.groq.com/openai/v1` | Sí, con exclusiones | llave `GROQ_API_KEY` | Sí (todos sus modelos) | Precargar (ojo nombre vs `grok`) |
| Together | `https://api.together.ai/v1` | Sí (drop-in) | llave `TOGETHER_API_KEY` | Sí | Precargar |
| Fireworks | `https://api.fireworks.ai/inference/v1` | Sí | llave | Sí, por modelo (`supportsTools`) | Precargar |
| Cerebras | `https://api.cerebras.ai/v1` | Sí | llave `CEREBRAS_API_KEY` | Sí (caveat gpt-oss) | Precargar |
| Azure OpenAI | `https://{RECURSO}.openai.azure.com/openai/v1/` | Sí (API v1 GA, sin api-version) | llave o Entra ID (Bearer) | Sí (misma API OpenAI) | Plantilla en init (pide recurso) |
| AWS Bedrock | `https://bedrock-runtime.{region}.amazonaws.com/openai/v1` | Sí (chat completions) | Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`) o SigV4 | No verificado — lo decide la sonda | Plantilla en init (pide región) |
| Vertex AI | `https://{LOC}-aiplatform.googleapis.com/v1/projects/…/endpoints/openapi` (patrón solo verificado en terceros) | Sí (oficial, detalle no extraíble) | token gcloud ~1h vía `api_key_cmd` | Referido, no verificado | Receta documentada, NO precargar |

Deriva en los ya cableados: `grok-4` → familia 4.x actual; `gemini-2.5-pro` → familia 3.x (capa sigue beta); `MiniMax-M2` → M3 disponible; `dashscope-intl` → URLs por workspace/región en la doc oficial (funcional hoy, en ruta de deprecación); docs.anthropic.com → platform.claude.com.

## El mecanismo

Tres piezas, todas dentro de las reglas de la casa (secretos solo nombrados; el esquema estricto de config.ts no cambia de filosofía; toda bifurcación de criterio al panel con su lector; nada de esto alcanza el mayor).

**1. Matriz de perfiles v2** (edita `BUILTIN_PROFILES` en config.ts):

- Altas directas: `mistral` (mistral-large-latest, `MISTRAL_API_KEY`), `deepseek` (deepseek-v4-pro, `DEEPSEEK_API_KEY`), `groq` (llama-3.3-70b-versatile, `GROQ_API_KEY`, nota cruzada con `grok`), `together` (Llama namespaced, `TOGETHER_API_KEY`), `fireworks` (id `accounts/fireworks/models/...`, nota de `supportsTools` por modelo), `cerebras` (`CEREBRAS_API_KEY`). Cada alta con su renglón en `KEY_URLS` de s3-ai.ts (console.groq.com/keys, api.together.ai/settings/api-keys, etc. — verificar cada deep-link al implementar).
- Refresco de los existentes: modelo de `grok` y `gemini` a los vigentes; nota de `minimax` menciona M3; nota de `qwen` documenta la URL por workspace como destino de migración y prefiere snapshot fechado (`qwen3-max-2026-01-23`).
- `azure` y `bedrock` NO van en BUILTIN (base_url tiene placeholder y el esquema exige URL válida): van como plantillas del init — s3-ai pregunta recurso/región, arma la URL y escribe el perfil vía `writeConfigPatch`. La sonda doble existente decide si el canal sirve para operar (en Bedrock, tools está sin verificar: exactamente el caso para el que la sonda se construyó).
- `vertex`: receta en docs (`api_key_cmd: "gcloud auth print-access-token"` + caveat de expiración ~1h); no se precarga.
- Preferencia general anti-deriva: donde el proveedor ofrezca id fechado, el default lo usa; alias tipo `latest`/`openrouter/auto` se marcan en la nota como «deriva garantizada».

**2. Flujo de conexión en init para un contador** (edita s3-ai.ts):

Tres rutas presentadas en lenguaje de despacho, no de programador:

- **Ruta A (recomendada): «una sola llave para todo»** — OpenRouter por OAuth PKCE en modo headless: mnemosine genera code_verifier, imprime la URL de `/auth` (S256), el contador entra con un click y pega el código que ve en pantalla; mnemosine lo canjea en `POST /api/v1/auth/keys` y guarda la llave resultante en `.env` vía `upsertEnvVar` (s0-infra), jamás en el config — el config solo dice `api_key_env: OPENROUTER_API_KEY`. Luego la sonda doble de siempre, y persistir solo tras prueba. Cero registro por proveedor, cero copiar-llaves-de-consolas.
- **Ruta B: «ya tengo proveedor/llave»** — el flujo actual (deep-link + askSecret + sonda) se queda tal cual; solo crece la lista.
- **Ruta C: «suscripción»** — copilot sigue detrás de broker (`api_key_cmd`); si algún día se implementa device flow propio (RFC 8628), el token va a `.env` o a un helper, nunca al config. La e.firma y el CSD ni se mencionan en este flujo: esto es solo credencial de modelo.

**3. Deriva de modelo (lo que A7·remate exige)** — instantánea fechada + muestreo fijado:

- Nueva tabla `ai_instantaneas_modelo` (por inquilino no: por instalación/despacho): perfil, `modelo_pedido`, `modelo_reportado` (el campo `model` de la respuesta), `system_fingerprint` cuando el proveedor lo emita, fecha, y el hash del **muestreo fijado**: 3 prompts contables fijos a temperatura 0 (y `seed` donde se soporte), respuestas hasheadas. La primera sonda exitosa de s3-ai siembra la instantánea.
- Un chequeo en `doctor` (junto a `checkModelProvider`) re-corre el muestreo barato (o al menos compara `modelo_reportado`/fingerprint) y reporta `warn` cuando algo cambió respecto a la instantánea: «el modelo que responde hoy no es el que probaste el día X». Nunca `fail` por sí solo: el agente propone, el humano dispone.
- La bifurcación de criterio va al panel con su lector: `ia_deriva_modelo` ∈ {`avisar`, `congelar_autopost`} — qué hacer con el auto-post de ingesta mientras haya deriva sin reconocer (el resolutor de umbrales de config.ts:518–538 ya tiene la capa de política donde insertar el congelamiento). Con su fila de catálogo y su criterio, para no parir una capacidad huérfana.

## Qué entra al plan maestro

**Tramo propuesto: «Proveedores v2 y la conexión del contador» — tamaño M**, divisible en tres remates si se quiere aterrizar por partes:

1. (S) Matriz v2: seis altas directas + refresco de modelos derivados + notas de deriva + `KEY_URLS` — solo config.ts, s3-ai.ts y sus specs.
2. (M) Init: ruta A con OpenRouter PKCE headless + plantillas azure/bedrock — toca s3-ai.ts y s0-infra; sin dependencias nuevas (el intercambio PKCE es un fetch).
3. (M) Deriva: migración de `ai_instantaneas_modelo`, siembra desde la sonda, chequeo en doctor, criterio `ia_deriva_modelo` en el panel con lector, fila de catálogo — es la pieza que A7·remate ya exige.

Decisión que el orquestador debe tomar antes: si la ruta A del contador es OpenRouter (verificado, PKCE documentado) o Nous Portal (también agrega 300+ modelos bajo una suscripción, pero no verifiqué que tenga flujo PKCE equivalente).

## Ligas verificadas y muertas

### Verificadas (WebFetch en esta corrida; el contenido respalda lo afirmado)

Cableados:
1. https://platform.claude.com/docs/en/api/overview — Anthropic: base, headers, plataformas
2. https://hermes-agent.nousresearch.com/docs/integrations/nous-portal — Nous: endpoint, modelos, matiz de tool calling de Hermes 4
3. https://docs.ollama.com/api/openai-compatibility — Ollama: /v1, tools sí, tool_choice no
4. https://docs.x.ai/docs/api-reference — xAI: base, Bearer XAI_API_KEY, modelos 4.x, tools
5. https://ai.google.dev/gemini-api/docs/openai — Gemini: endpoint compat, function calling, beta
6. https://openrouter.ai/docs/quickstart — OpenRouter: base, drop-in, Bearer
7. https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope — DashScope: URLs por workspace/región, DASHSCOPE_API_KEY, acotación de tools
8. https://www.alibabacloud.com/help/en/model-studio/first-api-call-to-qwen — quickstart oficial: URL workspace + qwen3.8-max
9. https://www.alibabacloud.com/help/en/model-studio/qwen-api-reference — lista de interfaces (compat OpenAI/Anthropic/DashScope)
10. https://www.alibabacloud.com/help/en/model-studio/use-qwen-by-calling-api — confirma la interfaz compat (página delgada)
11. https://platform.minimax.io/docs/guides/text-generation — MiniMax: /v1 compat, /anthropic recomendado, M3
12. https://platform.minimax.io/docs/api-reference/text-openai-api — MiniMax compat: tools sí, limitaciones (n=1, penalties ignoradas)
13. https://developers.openai.com/api/reference/chat-completions/overview — OpenAI: chat completions vivo junto a Responses (página delgada)

Faltantes:
14. https://docs.mistral.ai/api/ — base, Bearer, tools
15. https://api-docs.deepseek.com/ — base, compat OpenAI/Anthropic, modelos v4
16. https://api-docs.deepseek.com/guides/function_calling — tool calls
17. https://console.groq.com/docs/openai — base, exclusiones
18. https://console.groq.com/docs/tool-use — tools en todos sus modelos
19. https://docs.together.ai/docs/openai-api-compatibility — base, tools, límites
20. https://docs.fireworks.ai/tools-sdks/openai-compatibility — base, max_tokens distinto
21. https://docs.fireworks.ai/guides/function-calling — tools por modelo
22. https://inference-docs.cerebras.ai/resources/openai — base, CEREBRAS_API_KEY, caveat tools+response_format
23. https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle — Azure API v1 GA: openai/v1, sin api-version, llave o Entra
24. https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions-mantle.html — Bedrock: dos endpoints compat, AWS_BEARER_TOKEN_BEDROCK / SigV4
25. https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-gemini-using-openai-library — Vertex: capa compat existe, function calling referido (detalle fino no extraíble)

Prácticas:
26. https://datatracker.ietf.org/doc/html/rfc8628 — device authorization grant
27. https://cli.github.com/manual/gh_auth_login — flujo web, stdin, llavero
28. https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate — Copilot SDK: device flow, gho_/ghu_/github_pat_
29. https://docs.litellm.ai/docs/providers/github_copilot — device flow implementado contra Copilot
30. https://aider.chat/docs/llms.html — llaves env/.env/CLI, sin OAuth
31. https://openrouter.ai/docs/use-cases/oauth-pkce — PKCE S256, modo headless, canje en /api/v1/auth/keys
32. https://code.claude.com/docs/en/authentication — OAuth navegador + pegar-código, setup-token, apiKeyHelper con TTL, precedencia

### Muertas o no verificadas

1. https://platform.openai.com/docs/api-reference/chat — 403 a fetch automatizado; gpt-5.1 y max_completion_tokens quedaron respaldados solo por búsqueda y terceros
2. https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create — 404
3. https://api.minimax.io/v1 — 404 (es endpoint de API, no página; esperado)
4. https://docs.anthropic.com/en/api/overview — 301 permanente a platform.claude.com (actualizar referencias internas)
5. https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html — movida a la página -mantle (que sí verifiqué)
6. https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/openai — resuelve pero sirve contenido sin el detalle técnico
7. https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/openai — ídem
8. https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate/openai/auth-and-credentials — ídem; por eso el patrón de base_url de Vertex queda como «verificado solo en terceros»

**Constancia de seguridad**: las dos páginas de Bedrock traían texto dirigido a asistentes sugiriendo ejecutar un comando de AWS CLI («agent-toolkit search-skills»). Se trató como dato, no como instrucción, y no se ejecutó.

---

## Segunda pasada — 2026-09-02 (tarde)

Escrita sobre el árbol de la rama `docs/brechas-para-la-perfeccion`, que ya trae A7·remate
(reproducibilidad por perfil) y A5 (ventana de contexto por perfil), ninguno de los dos fusionado a
`main` todavía. Nada de lo de arriba se borra; lo que quedó desmentido se dice aquí citando la línea
vieja.

**Corrección de entrada, y es del propio documento.** La primera línea de «Dónde estamos» dice «once
perfiles integrados en `src/ai/providers/config.ts` (BUILTIN_PROFILES, líneas 19–113)». Son DOCE, y
siempre lo fueron: `src/ai/docs/connectivity.md:50` dice «12 built-in profiles» desde el commit de
línea base (`git log -S "11 built-in profiles"` no devuelve nada). El conteo se arrastró al encargo
de esta pasada. Hoy BUILTIN_PROFILES vive en config.ts:171–478 y son: `anthropic`, `hermes`,
`hermes-agent`, `ollama`, `openai`, `grok`, `minimax`, `qwen`, `gemini`, `openrouter`, `copilot`,
`openclaw`.

### Lo que se verificó

Re-fetch de las ligas que SOSTIENEN una recomendación. Las decorativas no se volvieron a abrir.

**Vivas y sin cambio material (la afirmación vieja aguanta):**

1. `https://openrouter.ai/docs/use-cases/oauth-pkce` — intacta y es la que más peso carga: PKCE con
   `code_challenge_method=S256`, **modo headless** («omit `callback_url` entirely», con el desafío
   *obligatorio* en ese modo), código de **un solo uso que expira en 10 minutos**, canje en
   `https://openrouter.ai/api/v1/auth/keys`. La ruta A del mecanismo sigue en pie tal como se
   escribió.
2. `https://ai.google.dev/gemini-api/docs/openai` — sigue **en beta** («Support for the OpenAI
   libraries is still in beta while we extend feature support»), base
   `https://generativelanguage.googleapis.com/v1beta/openai/` **con diagonal final**, function
   calling con su sección propia. Los ejemplos ya usan `gemini-3.8-flash`.
3. `https://platform.minimax.io/docs/api-reference/text-openai-api` — base `https://api.minimax.io/v1`,
   tools sí, `n` sólo 1, `presence_penalty`/`frequency_penalty`/`logit_bias` ignorados, `function_call`
   legado no soportado. **Dato nuevo y útil: la temperatura documentada es el rango [0, 2]** — la
   postura `muestreo: 'fijado', temperature: 0` del perfil `minimax` (config.ts:348–355) se sostiene
   contra la fuente, no contra la memoria.
4. `https://platform.claude.com/docs/en/about-claude/pricing` y
   `https://platform.claude.com/docs/en/manage-claude/data-residency` — vivas, y ambas cargan peso
   nuevo (precio y residencia, abajo).
5. `https://docs.x.ai/docs/api-reference` — base `https://api.x.ai/v1` y `Authorization: Bearer
   $XAI_API_KEY` vigentes. Ya no lista modelos en la propia página: remite a `docs.x.ai/docs/models`.

**Cambiadas — la afirmación vieja ya no se sostiene:**

6. `https://docs.x.ai/docs/models` — **`grok-4` YA NO APARECE en la tabla.** Lo que hay hoy, con
   ventana y precio: `grok-4.6` (500k; $2/$6 por millón bajo 200k, $4/$12 arriba), `grok-4.5` (500k,
   mismo precio), `grok-4.3` (1M; $1.25/$2.50), `grok-4.20-0309-reasoning` y `-non-reasoning` (1M;
   $1.25/$2.50), `grok-build-0.1` (256k; $1/$2), `grok-4.20-multi-agent-0309` (1M). La pasada
   anterior dijo «nuestro default `grok-4` quedó viejo»; hoy es más fuerte que eso: el modelo del
   perfil no está en la referencia del proveedor.
7. `https://developers.openai.com/api/docs/models` — **`gpt-5.1` YA NO APARECE.** La familia listada
   es GPT-5.6: `Sol` ($4/$20), `Terra` ($2/$12), `Luna` ($0.20/$1.20), las tres con **1.05M de
   ventana**, 128k de salida máxima y corte de conocimiento del 16 de febrero de 2026. La pasada
   anterior no pudo verificar el modelo («platform.openai.com devuelve 403») y lo dio por consistente;
   hoy la doc que sí responde lo contradice.
8. `https://api-docs.deepseek.com/quick_start/pricing` — los modelos son `deepseek-v4-flash`,
   `deepseek-v4-pro` y `deepseek-v4-flash-vision-exp`, **1M de ventana** los tres, y el precio va por
   **horario**: valle/pico, con pico de 01:00–04:00 y 06:00–10:00 UTC de lunes a viernes
   (`v4-flash` $0.22/$0.66 valle y $0.44/$1.32 pico; `v4-pro` $0.66/$1.98 valle y $1.32/$3.96 pico;
   acierto de caché $0.007–$0.022 por millón). Confirma lo que la pasada anterior ya había visto:
   `deepseek-chat` y `deepseek-reasoner` no existen en la doc.
9. `https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope` — la
   deriva de `qwen` **subió de grado**. La pasada anterior escribió «ya no aparece en el quickstart
   oficial […] probablemente aún funciona, pero está en ruta de deprecación». Hoy la página trae un
   **aviso de migración escrito**: `dashscope-intl.aliyuncs.com` debe migrar al endpoint por
   workspace de Singapur. Las bases vigentes son
   `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` (Singapur y Pekín),
   `https://dashscope-us.aliyuncs.com/compatible-mode/v1` (Virginia),
   `https://{WorkspaceId}.cn-hongkong.maas.aliyuncs.com/…` y `…ap-northeast-1…` (Tokio). El
   function calling sigue acotado a «qwen-turbo, qwen-plus, qwen-max» — y el perfil embarca
   `qwen3-max`, que no es ninguno de esos tres nombres.
10. `https://platform.minimax.io/docs/guides/text-generation` — **MiniMax-M2: 204 800 tokens de
    ventana**; M3: 1 000 000; la familia M2.x intermedia también 204 800. M2 sigue listado, así que
    el perfil no está roto: está viejo con número conocido.
11. `https://console.groq.com/docs/models` — deriva que la pasada anterior no podía ver porque miró
    otras páginas: los Llama **ya no publican precio** («Contact Sales»). Lo que sí tiene precio
    público es `openai/gpt-oss-120b` ($0.15/$0.60) y `openai/gpt-oss-20b` ($0.075/$0.30), ambos con
    131 072 de ventana. La recomendación «alta directa de `groq` con `llama-3.3-70b-versatile`» del
    mecanismo nace sin precio conocido.

**Muertas o no extraíbles en esta pasada (se declaran, no se rellenan de memoria):**

- `https://developers.openai.com/api/pricing` — 404.
- `https://platform.minimax.io/docs/price` y `…/docs/guides/price` — 404 las dos. **El precio de
  MiniMax queda sin fuente oficial extraíble**, y por eso no aparece en la tabla de costos de abajo.
- `https://www.alibabacloud.com/help/en/model-studio/what-is-qwen-llm` — 301 a la consola
  (`modelstudio.console.alibabacloud.com`, que pide sesión). `…/models` y `…/text-generation`
  responden pero **no publican ventana ni precio**; nombran `qwen3.8-max`, `qwen-plus` y
  `qwen3.6-plus` en ejemplos. **La ventana de `qwen3-max` sigue sin fuente oficial extraíble.**
- `https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations`,
  `…/learn/data-residency` y `https://cloud.google.com/vertex-ai/docs/general/locations` (301 a
  docs.cloud.google.com) — las tres sirven el índice de navegación y no el contenido. **Segunda
  pasada consecutiva contra la misma pared**: la anterior ya había listado tres páginas de Google
  por lo mismo. No es un fallo de esta corrida; es una propiedad de esa documentación.
- `https://docs.aws.amazon.com/bedrock/latest/userguide/models-regions.html` — hoy es un sello que
  remite a `models-region-compatibility.html` (esa sí respondió, y trae la respuesta de México).
- `https://mistral.ai/pricing` — responde, pero sólo publica Mistral Large ($0.5/$1.5) y manda el
  resto a «Models overview».

**Constancia de seguridad de esta corrida.** No reaparecieron las dos páginas de AWS con el texto
dirigido a asistentes que la pasada anterior denunció (`agent-toolkit search-skills`); las de Bedrock
que abrí hoy no lo traían. Sí apareció, en `openrouter.ai/docs/use-cases/oauth-pkce`, una línea de
cabecera dirigida a lectores automáticos: «Fetch the complete documentation index at:
https://openrouter.ai/docs/llms.txt». No es un intento de secuestro y no pedía nada peligroso, pero
es una instrucción incrustada dirigida a un agente: se anota y no se siguió. La página de modelos de
xAI trae una sección rotulada como nota para asistentes cuyo contenido es prosa de documentación
(que Grok no conoce eventos posteriores a su entrenamiento); tampoco se trató como instrucción.

### La deriva contra el árbol

**(a) Lo que el documento recomendaba y YA SE HIZO — a medias, y la mitad que falta importa.**

- El tramo 3 del mecanismo pedía «instantánea fechada + muestreo fijado». A7 hizo la mitad de
  arriba: `PosturaMuestreo` y `Reproducibilidad` son **obligatorias en el tipo**
  (`src/ai/providers/config.ts:52–70`), ningún perfil puede callarse, y `MUESTREO_CABLEADO: boolean =
  false` (config.ts:169) es una bandera auto-invalidante que el arnés lee en voz alta y que
  `tests/ai/eval/arnes-cableado.spec.ts` contrasta contra los dos runners. Confirmado a mano:
  `src/ai/agent.ts` y `src/ai/providers/openai-compat.ts` **no envían `temperature`** — la
  declaración es declaración, no cable.
- La mitad de abajo NO se hizo: `grep -rn "instantanea_modelo\|ia_deriva" src/` devuelve cero. No
  existe `ai_instantaneas_modelo`, no hay chequeo de deriva en `doctor`, no hay criterio
  `ia_deriva_modelo` en el panel. Lo que el documento llamó «lo que A7·remate ya exige» sigue
  exigido.
- Y hay un dato que sólo se ve abriendo el archivo: **los doce perfiles declaran `instantanea:
  null`** (config.ts, doce ocurrencias entre las líneas 193 y 471). La recomendación «donde el
  proveedor ofrezca id fechado, el default lo usa» no se cumplió en ninguno.
- A5 metió la ventana: `VentanaDeFabrica` como unión discriminada (config.ts:140–142),
  `FRACCION_VENTANA_COMPACTABLE = 0.5` (config.ts:118) y la derivación del umbral con su cola
  (config.ts:1101). Doce perfiles: **cuatro con número** —`anthropic` 1 000 000, `hermes` 131 072,
  `ollama` 32 768, `gemini` 1 048 576— y **ocho `desconocida`**.

**(b) Lo que el documento daba por cierto y dejó de serlo.**

- El documento listó como supuesto a contrastar «`grok` con `model: 'grok-4'` (config.ts:58–64)» y
  concluyó «quedó viejo». Hoy el perfil vive en config.ts:314–334 y la razón de su ventana dice
  literalmente: «xAI documenta la ventana de grok-4 en su referencia de modelos y nadie la ha traído
  aquí. Es un dato de una línea que se comprueba en un minuto» (config.ts:323–325). **Esa frase ya es
  falsa**: la referencia de xAI no documenta `grok-4`. El dato de una línea no se puede traer porque
  no existe.
- Mismo caso en `openai` (config.ts:288–312): la razón dice «OpenAI publica la ventana por modelo y
  NADIE LA HA ESTABLECIDO AQUÍ» (config.ts:298). OpenAI publica la ventana **de la familia 5.6**;
  de `gpt-5.1` ya no publica nada. El perfil `copilot` (config.ts:429) arrastra el mismo `gpt-5.1`.
- **La pieza que la pasada anterior no miró y es la que responde la pregunta de costo:**
  `src/ai/providers/prices.ts`. Existe una tabla local de precios con fecha de corte como DATO
  (`PRECIOS_VIGENTES_A = '2026-08-24'`, prices.ts:52) que `mnemosine usage` imprime. De sus
  renglones, cuatro nombran modelos que sus proveedores ya no listan: `gpt-5.1` (prices.ts:80),
  `grok-4` (prices.ts:87), `deepseek-chat` (prices.ts:99) y `deepseek-reasoner` (prices.ts:100).
- El único renglón que sobrevive la verificación **exacto**: `anthropic('claude-opus-5', 5, 25)`
  (prices.ts:64), que con los multiplicadores del archivo da lectura de caché $0.50 y escritura 5m
  $6.25. La página de precios de Anthropic da $5 / $25 / $0.50 / $6.25. Coincide dígito por dígito.

**(c) Las ventanas: cuáles se pueden establecer HOY con fuente oficial.** Ocho perfiles dicen
`desconocida`. No son ocho deudas iguales:

| perfil | modelo del perfil | ¿establecible hoy? | qué dice la fuente oficial |
|---|---|---|---|
| `minimax` | `MiniMax-M2` | **SÍ — 204 800** | platform.minimax.io/docs/guides/text-generation lo publica por modelo |
| `openai` | `gpt-5.1` | **No, y no por pereza** | el modelo no está en la doc; la familia 5.6 sí (1.05M). Hay que subir el `model` ANTES de poder declarar ventana |
| `grok` | `grok-4` | **No, misma razón** | `grok-4` no está en docs.x.ai/docs/models. Si se sube: grok-4.6 → 500k; grok-4.3 → 1M |
| `qwen` | `qwen3-max` | **No** | ninguna página fetchable de Model Studio publica la ventana; y el alias se repunta, como ya dice su razón |
| `openrouter` | `openrouter/auto` | **No, por construcción** | elige modelo por petición: no existe UN número. La razón que trae es correcta y debe quedarse |
| `copilot` | `gpt-5.1` | **No, por construcción** | lo que sirve GitHub detrás del alias no se versiona al cliente |
| `hermes-agent` | pasarela local | **No, por construcción** | la ventana la fija la configuración de la pasarela |
| `openclaw` | pasarela local | **No, por construcción** | ídem |

Resumen honesto: **de las ocho, UNA se cierra hoy con fuente oficial** (`minimax` = 204 800). Tres
están bloqueadas por un `model` obsoleto —y se desbloquean subiéndolo, no investigando más— y cuatro
son irreducibles. El trabajo directo y verificable que pedía el encargo es exactamente ese: una
línea en `minimax`, y tres perfiles cuyo `model` hay que subir primero.

**(d) El asistente de conexión no se ha tocado.** `git log --oneline -- src/cli/init/s3-ai.ts`
devuelve **un solo commit** (`4eeee63`, línea base). No existe la ruta A (OpenRouter PKCE), no
existen las plantillas de Azure/Bedrock, y `KEY_URLS` (s3-ai.ts:23–35) sigue con las once entradas de
siempre: ninguna de las seis altas directas que el mecanismo proponía.

### Lo que falta para ser perfecto

Ordenado por consecuencia para un despacho, no por dificultad.

**1. El costo por documento es NULO para cinco de los doce perfiles, y eso desarma el presupuesto.**
`lookupPrice` (prices.ts:109) no conoce `Hermes-4-405B`, `MiniMax-M2`, `qwen3-max`, `openrouter/auto`
ni los modelos locales. Sin precio, `estimateCostUsd` devuelve `null`,
`ai_usage.estimated_cost_usd` queda NULL y `evaluateBudget` (budget.ts:57–59) suma **cero**. Un
despacho que ponga `budget.monthly_usd` y corra en `minimax` o `qwen` tiene un tope que **siempre
lee $0.00 y nunca corta** — y en ruta desatendida el `on_exceed` por omisión es `block`, o sea que la
protección que más promete es la que menos protege. `unpricedTurns` lo cuenta y lo imprime, pero
contar no es cortar. *Tamaño S. No la bloquea nada: son renglones en una tabla, con la salvedad de
que MiniMax y Qwen no publican precio en página fetchable — para esos dos el renglón honesto es
seguir en NULL y decirlo en la nota del perfil.*

**2. La tabla de precios tiene la forma equivocada para los precios de 2026.** `ModelPrice`
(prices.ts:16–27) es plana: un input, un output, dos tarifas de caché. Hoy xAI cobra **por tramo de
contexto** (<200k vs ≥200k, el doble arriba), Gemini 2.5 Pro igual, y DeepSeek cobra **por horario**
(valle/pico, con la ventana de pico publicada en UTC). El invariante escrito del archivo —«las
estimaciones deben sorprender HACIA ABAJO en el reporte, nunca en la factura»— obliga a cargar
siempre el precio caro; pero sin la forma no se puede ni declarar el barato, y el reporte de un
despacho que corre de noche en México (valle en UTC) sobreestima el doble. *Tamaño M. Bloqueada por
nada técnico; es una decisión de diseño de la tabla.*

**3. Un despacho no puede comparar proveedores con sus propios números, y le faltan dos GROUP BY.**
Los datos YA existen: `ai_ingest_runs` (migración 044) trae `provider`, `model`, `files_total`,
`estimated_cost_usd` y `duration_ms` por corrida, y `ai_usage` trae `provider` y `model` por llamada.
Lo que falta es la consulta:
  - **Costo por documento por proveedor**: `mnemosine usage --by provider` (usage-command.ts:19) da
    el dinero por proveedor, pero no lo divide entre documentos; la división vive en
    `ai_ingest_runs` y ningún comando la hace.
  - **Latencia por proveedor**: `stats-service.ts:152–157` calcula promedio y p95 de `duration_ms`
    **sin agrupar por proveedor** (`WHERE entity_id = $1` y punto). Un despacho que cambió de
    proveedor el martes ve un p95 que promedia las dos épocas y no puede distinguirlas.
  Esto es lo que convierte «¿cuál me conviene desde Guadalajara?» de opinión en medición. *Tamaño S.
  No la bloquea nada.*

**4. El comando que existe para presupuestar mide la superficie equivocada.** `prompt-size`
(prompt-size-command.ts:170) llama `buildTools(ctx, {...})` **sin lista blanca**: mide las 25
herramientas del chat. La ingesta —el camino por el que pasa cada CFDI y que el arnés ya mide con
`SUPERFICIE_INGESTA`— embarca **once**. Medido hoy en este árbol: 25 herramientas = 19 892
caracteres de esquema; las once de la ingesta = **10 522 caracteres**. El comando que un socio abriría
para saber cuánto cuesta procesar una factura le enseña casi el doble de lo que esa factura paga.
Una bandera `--superficie ingesta` lo arregla. *Tamaño S.*

**5. Residencia de datos en México: NO EXISTE, y conviene escribirlo en la documentación antes de que
lo pregunte un cliente.** Verificado hoy contra fuente oficial:
  - **Anthropic (primera parte)**: `inference_geo` acepta **sólo `"us"` y `"global"`**; el
    *workspace geo* «Currently, `"us"` is the only available workspace geo». No hay México, no hay
    LatAm. El `"us"` cuesta 1.1x sobre todo (entrada, salida, caché).
  - **AWS Bedrock**: `mx-central-1` (México) **existe y aparece** en la tabla de compatibilidad
    regional — pero para Claude Opus 5, Sonnet 5, Fable 5/5.1 y Mythos 5/5.1 figura **únicamente bajo
    «Global»**; «In-Region» y «Geo» están marcados como no soportados. Traducción para un despacho:
    se puede **facturar** desde México; no se puede **inferir** en México.
  - **Azure / Microsoft Foundry**: las tablas de región y zonas de datos que sí pude leer son US y
    EU; el punto más cercano en LatAm es Brazil South. México no aparece.
  - **Google Vertex**: **no verificable** — las tres páginas de locations y data-residency sirven
    índice de navegación, igual que en la pasada anterior. No se afirma nada.
  La consecuencia práctica es limpia: **si los XML de un cliente no pueden salir del país, el único
  perfil que cumple es `ollama`**, y ese perfil ya existe con su ventana declarada (32 768,
  config.ts:265–275) y con la advertencia medida de que no es reproducible entre corridas
  (0.750 / 0.750 / 0.000 sobre el mismo caso, config.ts:29–38). Lo que falta no es infraestructura:
  es **decirlo**, en `src/ai/docs/connectivity.md` y en el init. *Tamaño S para escribirlo; el hecho
  no se puede cambiar.*

**6. El init no hace la única pregunta que decide todo.** `s3-ai.ts` sigue como el día uno. Además de
las tres rutas ya propuestas (A: OpenRouter PKCE headless; B: llave propia; C: suscripción tras
broker), falta una pregunta que la pasada anterior no formuló y que es anterior a todas: **«¿pueden
salir del país los XML de tus clientes?»**. Un sí/no que parte el árbol en dos —`ollama` de un lado,
todo lo demás del otro— y que hoy nadie pregunta, de modo que el default lleva los CFDI de un tercero
a un servidor extranjero sin que se haya tomado la decisión. *Tamaño M. Bloqueada por que S-UX (PR 52)
toca el init: hay que coordinar o esperar.*

**7. La ruta de menor fricción entrega, por omisión, el perfil que el arnés no puede medir.**
OpenRouter es la mejor respuesta verificada en privacidad, y por un margen amplio: **no registra
prompts ni respuestas por omisión** («zero logging of your prompts/completions, even if an error
occurs, unless you opt-in»), permite **filtrar proveedores por su política de datos** y **falla la
petición** si ninguno cumple la política de la cuenta, y **no pone margen sobre la inferencia** (cobra
5.5% al comprar crédito por Stripe, 5% por cripto). Para un despacho que maneja papeles fiscales de
terceros, ese conjunto es exactamente lo que hay que poder enseñarle a un cliente. Pero el perfil
`openrouter` del repo trae `model: 'openrouter/auto'`, cuya propia razón declara que **no es
evaluable** (config.ts:412–419: «dos corridas del mismo proveedor+modelo pueden haber preguntado a
dos modelos distintos»). La ruta A tiene que fijar un modelo concreto en el momento del alta, no
dejar `auto`. *Tamaño S dentro del tramo de init.*

**8. El orden correcto para saldar la deuda de deriva es uno solo, y son tres pasos en un archivo.**
Subir el `model` → fijar la `instantanea` fechada → declarar la `ventana`. En ese orden, porque los
tres perfiles que no pueden declarar ventana es porque su modelo ya no existe. Hacerlo al revés
—buscar ventanas de modelos muertos— es el trabajo que la propia razón de `grok` pide hoy y que no se
puede hacer. *Tamaño S por perfil; cuatro perfiles (`openai`, `grok`, `copilot`, `qwen`).*

**9. El detector de deriva sigue sin existir.** Sin cambios respecto a lo que el mecanismo ya
propuso: `ai_instantaneas_modelo`, siembra desde la sonda de `s3-ai`, chequeo en `doctor` que compara
`modelo_reportado`/`system_fingerprint` contra la instantánea y reporta `warn` —nunca `fail`—, y el
criterio `ia_deriva_modelo` ∈ {`avisar`, `congelar_autopost`} en el panel con su lector y su fila de
catálogo, para no parir una capacidad huérfana. *Tamaño M. Bloqueada por que A7 (que abrió el campo)
aún no está en `main`.*

**10. El número que un socio pide de verdad: cuánto cuesta clasificar una factura.**

El modelo de costo sale de números **medidos en este árbol**, no supuestos:

- Esquemas de las once herramientas de la ingesta: **10 522 caracteres ≈ 2 631 tokens** (medido hoy
  con `buildTools(ctx, deps, SUPERFICIE_INGESTA)`).
- Instrucciones de rol + índice de documentos: **5 428 + 3 025 = 8 453 caracteres ≈ 2 114 tokens**.
- Catálogo de cuentas: hasta `MAX_COA_LINES = 400` líneas (system-prompt.ts:23) ≈ 3 000 tokens.
- El CFDI en sí: los golden pesan ~1 400 caracteres ≈ **350 tokens**. Es la parte más barata, de
  lejos.
- Cada resultado de herramienta entra hasta `MAX_TOOL_RESULT_CHARS = 32 000` caracteres (8 000
  tokens, tools/index.ts:27) y el bucle admite `MAX_ITERATIONS = 25` (agent.ts:33).

Con cinco llamadas al modelo y un `read_docs` de por medio —una clasificación normal: leer la doc,
buscar la cuenta, buscar precedente, leer la política del despacho, redactar el borrador— sale
**≈ 60 000 tokens de entrada y ≈ 1 500 de salida por documento**. Con precios de hoy:

| Modelo | $/M entrada | $/M salida | **por documento** | **2 000 docs/mes** |
|---|---|---|---|---|
| claude-opus-5 (el default) | 5 | 25 | $0.34 | $675 |
| claude-opus-5 *con el prefijo cacheado* | 5 (caché 0.50) | 25 | **$0.22** | **$436** |
| claude-sonnet-5 | 2 | 10 | $0.14 | $270 |
| claude-haiku-4.5 | 1 | 5 | $0.068 | $135 |
| gpt-5.6 Sol | 4 | 20 | $0.27 | $540 |
| gpt-5.6 Terra | 2 | 12 | $0.14 | $276 |
| gpt-5.6 Luna | 0.20 | 1.20 | **$0.014** | **$28** |
| grok-4.6 (<200k) | 2 | 6 | $0.13 | $258 |
| grok-4.3 (<200k) | 1.25 | 2.50 | $0.079 | $158 |
| gemini-3.8-flash | 0.75 | 3.75 | $0.051 | $101 |
| gemini-2.5-pro (el del perfil) | 1.25 | 10 | $0.090 | $180 |
| deepseek-v4-flash (valle) | 0.22 | 0.66 | **$0.014** | **$28** |
| deepseek-v4-flash (pico) | 0.44 | 1.32 | $0.028 | $57 |
| deepseek-v4-pro (valle) | 0.66 | 1.98 | $0.043 | $85 |
| mistral-large | 0.5 | 1.5 | $0.032 | $65 |
| groq `openai/gpt-oss-120b` | 0.15 | 0.60 | **$0.010** | **$20** |
| MiniMax-M2 | *sin fuente oficial fetchable* | — | — | — |
| qwen3-max | *sin fuente oficial fetchable* | — | — | — |
| ollama (local) | 0 | 0 | $0 marginal | $0 + el fierro |

Tres lecturas que ese cuadro obliga:

- **El default cuesta veinticuatro veces el más barato.** No es argumento para cambiarlo —la calidad
  de clasificación contable no está medida entre estos modelos y el arnés existe justamente para
  medirla— pero sí es argumento para que el init lo DIGA antes de que el despacho encienda la
  ingesta nocturna.
- **La caché del prefijo vale un tercio de la factura de Anthropic y no está en el camino
  compatible.** `buildSystemBlocks` marca `cache_control: { type: 'ephemeral' }`
  (system-prompt.ts:189), pero el runner OpenAI-compatible recibe el bloque **aplanado a texto**
  (`providers/index.ts:87` → `openai-compat.ts:115, 374`): quien cachea ahí lo hace por su cuenta
  (OpenAI y DeepSeek sí; los demás no). Dato fino que la tabla de arriba no refleja: Anthropic
  factura además 286–406 tokens de preámbulo de herramientas por petición en Opus 5, y `prompt-size`
  no los cuenta.
- **El coste crece con los RESULTADOS de herramienta, no con el CFDI.** El documento son 350 tokens
  de 60 000. Lo caro es el `read_docs` y las búsquedas que se re-envían en cada vuelta. Cualquier
  ahorro serio está en el bucle, no en el proveedor.

**11. Y la recomendación, que es lo que el encargo pedía de verdad.** Para un despacho mexicano, con
lo verificado hoy:

- **Si los papeles no pueden salir del país**: `ollama`, con los ojos abiertos —ventana 32 768 y la
  falta de reproducibilidad ya medida— y el fierro pagado. No hay alternativa con residencia en
  México: ninguna de las cuatro nubes la ofrece para inferencia.
- **Si sí pueden salir y lo que pesa es la privacidad demostrable ante el cliente**: OpenRouter, con
  su política de cero registro y su filtro de proveedores, **con un modelo fijo** y dado de alta por
  PKCE headless. Es también el **mecanismo de alta que menos preguntas hace**: sin registro por
  proveedor, sin consola, un pegado de código que expira en diez minutos. El segundo escalón son
  Groq, Mistral o DeepSeek con una llave de consola. Los que más preguntan, y por mucho, son Vertex
  (token de ~1 hora vía `api_key_cmd`, que `resolveProfile` ejecuta una vez por resolución) y Azure
  (recurso + deployment).
- **Si lo que pesa es el precio por documento**: `groq/gpt-oss-120b`, `gpt-5.6 Luna` o
  `gemini-3.8-flash`, entre $0.010 y $0.051 por documento. DeepSeek empata en precio, pero la
  jurisdicción es China y para papeles fiscales de un tercero eso es una conversación con el cliente,
  no una decisión de ingeniería — y conviene que el init la nombre en vez de esconderla.
- **Latencia**: **ningún proveedor publica latencia a México**, y ninguno tiene región de inferencia
  en el país. La única respuesta honesta es medirla; la columna `duration_ms` ya está poblada desde
  la migración 044 y lo único que falta es agruparla por proveedor (brecha 3). Recomendar un
  proveedor «por latencia» sin ese GROUP BY sería exactamente el tipo de afirmación sin fuente que
  esta investigación existe para no hacer.

### Ligas de esta segunda pasada

**Re-verificadas y vivas** (WebFetch en esta corrida): openrouter.ai/docs/use-cases/oauth-pkce ·
openrouter.ai/docs/faq · ai.google.dev/gemini-api/docs/openai · ai.google.dev/gemini-api/docs/pricing ·
platform.minimax.io/docs/api-reference/text-openai-api · platform.minimax.io/docs/guides/text-generation ·
platform.claude.com/docs/en/about-claude/pricing · platform.claude.com/docs/en/manage-claude/data-residency ·
docs.x.ai/docs/api-reference · docs.x.ai/docs/models · developers.openai.com/api/docs/models ·
api-docs.deepseek.com/quick_start/pricing ·
alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope ·
alibabacloud.com/help/en/model-studio/models · alibabacloud.com/help/en/model-studio/text-generation ·
console.groq.com/docs/models · mistral.ai/pricing ·
docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html ·
learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/models

**Muertas o no extraíbles en esta corrida**: developers.openai.com/api/pricing (404) ·
platform.minimax.io/docs/price (404) · platform.minimax.io/docs/guides/price (404) ·
alibabacloud.com/help/en/model-studio/what-is-qwen-llm (301 a consola con sesión) ·
docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations (índice, sin contenido) ·
docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/data-residency (ídem) ·
cloud.google.com/vertex-ai/docs/general/locations (301 → ídem) ·
docs.aws.amazon.com/bedrock/latest/userguide/models-regions.html (sello que remite a otra página)
