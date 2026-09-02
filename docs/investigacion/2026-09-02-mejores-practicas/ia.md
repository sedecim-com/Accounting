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
