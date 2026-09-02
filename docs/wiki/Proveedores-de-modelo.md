# Proveedores de modelo

mnemosine no está casado con un proveedor. Hay dos motores de sesión —el nativo de Anthropic, con caché de prompt y bloques de razonamiento, y un adaptador OpenAI-compatible que sirve a todo lo demás— y encima de ellos un catálogo de perfiles predefinidos que se extiende desde un archivo de configuración.

El README ya cuenta [cómo arrancar con un modelo local](https://github.com/sedecim-com/Accounting/blob/main/README.md). Esta página cubre lo que viene después: la precedencia exacta, por qué el esquema del archivo es estricto, dónde vive la llave, cómo saber cuál de todos está respondiendo de verdad — y, al final, lo que la investigación de septiembre de 2026 encontró: qué defaults del catálogo ya derivaron, qué proveedores faltan y qué se planea hacer al respecto. Esa última parte es dirección, no capacidad.

---

## Los perfiles predefinidos

Viven en `BUILTIN_PROFILES`, en [`src/ai/providers/config.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/providers/config.ts). Para verlos con el estado real de sus credenciales en tu máquina:

```bash
mnemosine providers
```

| Perfil | Motor | Modelo por omisión | Credencial | Notas |
|---|---|---|---|---|
| `anthropic` | nativo | `claude-opus-5` | `ANTHROPIC_API_KEY` | El proveedor por omisión |
| `openai` | OpenAI-compatible | `gpt-5.1` | `OPENAI_API_KEY` | Usa `max_completion_tokens` |
| `gemini` | OpenAI-compatible | `gemini-2.5-pro` | `GEMINI_API_KEY` | Endpoint compatible de Google AI Studio (capa aún en beta; ver deriva) |
| `grok` | OpenAI-compatible | `grok-4` | `XAI_API_KEY` | Modelo derivado; ver abajo |
| `qwen` | OpenAI-compatible | `qwen3-max` | `DASHSCOPE_API_KEY` | DashScope en modo compatible; URL en ruta de deprecación (ver deriva) |
| `minimax` | OpenAI-compatible | `MiniMax-M2` | `MINIMAX_API_KEY` | Endpoint global; para China se cambia `base_url` |
| `openrouter` | OpenAI-compatible | `openrouter/auto` | `OPENROUTER_API_KEY` | Una llave, muchos modelos. El alias `auto` es deriva garantizada por diseño |
| `copilot` | OpenAI-compatible | `gpt-5.1` | `COPILOT_API_TOKEN` | El token sale del flujo OAuth de GitHub y es corto: útil solo detrás de un intermediario que lo refresque |
| `hermes` | OpenAI-compatible | `Hermes-4-405B` | `NOUS_API_KEY` | *Function calling* estándar; la propia doc de Nous advierte que Hermes 4 está afinado para chat y razonamiento, no para bucles intensivos de herramientas |
| `hermes-agent` | OpenAI-compatible | `hermes-agent` | `HERMES_AGENT_KEY` | Pasarela local. **`tools: false`** |
| `ollama` | OpenAI-compatible | `llama3.1` | ninguna | Local, sin llave |
| `openclaw` | OpenAI-compatible | `openclaw:main` | `OPENCLAW_GATEWAY_TOKEN` | Pasarela local. **`tools: false`** |

El catálogo no se cuenta a mano: `mnemosine providers` imprime la lista efectiva —predefinidos más los del archivo— con el modelo, el endpoint, si el perfil lleva herramientas y si la variable de entorno que nombra está puesta. (El README enumera once porque agrupa `hermes` y `hermes-agent`; el archivo define los dos por separado, y son cosas distintas, como se explica más abajo.)

---

## Quién gana: la precedencia

```text
--provider  >  MNEMOSINE_PROVIDER  >  default_provider del archivo  >  'anthropic'
```

La bandera es la elección explícita de quien está tecleando; la variable de entorno es de la sesión de la terminal; `default_provider` es del proyecto o del usuario; y si nada dice otra cosa, `anthropic`. La resuelve `listProfiles` y la consume `resolveProfile`.

El modelo se elige aparte: `--model` sobrescribe el `model` del perfil sin cambiar de perfil, que es lo que quieres cuando tu cuenta tiene otra versión disponible del mismo proveedor — y es el remedio inmediato para cualquier default derivado de la tabla de arriba, sin esperar a que el catálogo se actualice.

Los comandos que hablan con un modelo (`chat`, `ask`, `ingest`) aceptan las dos banderas.

---

## El archivo `mnemosine.config.json`

Se busca en dos lugares, y **gana el primero que exista**:

1. `./mnemosine.config.json` — del proyecto.
2. `~/.mnemosine/config.json` — del usuario.

No se fusionan: el archivo del proyecto, si existe, es el que manda entero.

Un perfil del archivo con el mismo nombre que uno predefinido lo **reemplaza**, no lo fusiona. La razón está escrita junto al código: heredar campos invisibles como `api_key_env` o `tools: false` produciría comportamientos imposibles de desactivar desde la configuración.

Las secciones que el archivo admite:

| Sección | Para qué |
|---|---|
| `language` | Idioma en que responde el **agente** (`en` \| `es`, por omisión `es`). La interfaz del CLI es inglés siempre; los alias en español de los comandos existen de todos modos. |
| `default_provider` | El perfil por omisión. |
| `providers` | Perfiles propios, o reemplazos de los predefinidos. |
| `ingest` | `auto_post`, `auto_post_min_confidence`, `auto_post_max_amount`. Ver [[El-agente-y-sus-limites]] para la precedencia completa con el panel de políticas. |
| `budget` | `daily_usd`, `monthly_usd`, `on_exceed`. Sin esta sección no se consulta gasto alguno. |
| `compaction` | `threshold_tokens` (0 = apagar), `keep_recent_tokens`, `identifier_policy`. La compactación automática está **encendida por omisión**. |

Y los campos de un perfil:

| Campo | Para qué |
|---|---|
| `type` | `anthropic` o `openai-compatible`. |
| `model` | Obligatorio. |
| `base_url` | El endpoint, para los OpenAI-compatibles. |
| `api_key_env` | **Nombre** de la variable de entorno con la credencial. |
| `api_key_cmd` | Comando que **imprime** la credencial. |
| `max_tokens_param` | `max_tokens` o `max_completion_tokens`, según lo que acepte el endpoint. |
| `stream_usage` | `false` para no mandar `stream_options` a servidores viejos que responden 400 ante el campo desconocido. |
| `stream` | Si la respuesta se transmite en flujo. |
| `headers` | Cabeceras extra, para proxies. |
| `max_iterations` | Tope de vueltas de herramienta por turno (1–100). |
| `tools` | `false` desactiva por completo las herramientas en ese canal. |
| `failover` | Cadena ordenada de perfiles de respaldo. |
| `skills` | Lista blanca de habilidades del despacho visibles para ese perfil. |
| `note` | Texto libre que `mnemosine providers` imprime. |

---

## Los secretos nunca van en el archivo

Ésta es la regla dura de la página, y está aplicada en tres lugares distintos.

**El perfil sólo nombra de dónde sale la llave.** `api_key_env` lleva el *nombre* de una variable de entorno (`"NOUS_API_KEY"`), no su valor. `api_key_cmd` lleva un comando que imprime la credencial: un gestor de secretos, una bóveda, o el token de una suscripción ya autenticada. `api_key_cmd` se intenta **sólo si el entorno no resolvió**, corre con un tiempo límite de diez segundos, y si no imprime nada, falla ruidosamente en vez de seguir sin credencial. Una limitación conocida: el comando se ejecuta **una vez por resolución** —en la práctica, una vez por corrida del CLI— sin noción de caducidad; para tokens que expiran en una hora (el caso de Google Cloud, abajo) una sesión muy larga puede sobrevivir a su token. Suficiente hoy; documentado para que no sorprenda.

**El escritor de configuración se niega a guardar secretos.** `writeConfigPatch` pasa todo por `assertNoSecrets` antes de tocar el disco, y rechaza dos formas: un valor que **parece** credencial por su prefijo (`sk-`, `ghp_`, `xoxb-`, `AKIA`, `eyJ`), y una llave con nombre de credencial (`key`, `token`, `secret`, `password`) cuyo valor no tiene forma de nombre de variable de entorno. La excepción son las llaves `*_cmd`, que legítimamente llevan comandos — aunque a esas les sigue aplicando la revisión por prefijo, por si alguien pegó ahí la llave de verdad. El mensaje de error dice el porqué: los archivos de configuración se comparten y acaban en git.

**El esquema es estricto: `.strict()` en todos los niveles.** Una llave desconocida es *siempre* un error. Un `api_key_evn` mal tecleado, si el esquema fuera permisivo, se ignoraría en silencio y el sistema caería a los valores por omisión — el peor modo de fallo posible para un archivo que gobierna credenciales. Aquí truena.

Y cuando truena, no se pierde la evidencia: `quarantineInvalidConfig` copia el archivo rechazado a `<archivo>.rejected-<hash>` antes de lanzar la excepción. El nombre lleva el hash del contenido, así que reintentar es idempotente —el mismo archivo inválido produce siempre el mismo respaldo, sin basura por corrida— y un archivo roto de otra manera obtiene su propia copia. Un archivo que **existe** pero es inválido nunca se reemplaza en silencio por valores por omisión.

Más sobre credenciales del sistema (las fiscales, que son otra cosa) en [[Seguridad-y-credenciales]].

---

## El asistente de conexión: probar antes de guardar

La sección de IA del `init` ([`src/cli/init/s3-ai.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/init/s3-ai.ts)) ya trabaja con una disciplina que conviene conocer porque el plan de abajo se apoya en ella:

- **Deep-links por credencial** (`KEY_URLS`): para cada proveedor, la URL exacta de la consola donde se genera la llave. Menos búsqueda, menos llaves pegadas en el lugar equivocado.
- **Sonda viva doble antes de persistir**: una llamada de chat y una de *tool calling*. No basta con que el endpoint conteste; tiene que devolver llamadas de herramienta, porque sin eso el agente contable no es agente. Las fallas se categorizan (autenticación, conexión, otro) para que el mensaje diga qué hacer, no solo que falló.
- **Persistir solo tras prueba**: la configuración se escribe vía `writeConfigPatch` —con sus dos compuertas— únicamente cuando la sonda pasó. Un perfil que nunca respondió no queda guardado como si sirviera.

Esa sonda es, en la práctica, la verificación que ningún catálogo estático puede dar: la tabla de perfiles dice lo que se espera del proveedor; la sonda dice lo que el proveedor hace hoy con tu llave.

---

## La deriva: lo que la investigación de septiembre de 2026 encontró

Los defaults de un catálogo estático envejecen. La verificación con fuentes vivas del 2-sep-2026 encontró estas derivas en los perfiles ya cableados — ninguna rompe el perfil hoy (la sonda del init sigue siendo el árbitro), pero conviene saberlas antes de extrañarse:

| Perfil | Lo cableado | Lo encontrado |
|---|---|---|
| `grok` | `grok-4` | La [doc de xAI](https://docs.x.ai/docs/api-reference) ya lista la familia 4.x posterior (`grok-4.6`, `grok-4.3`, …). El endpoint y la autenticación siguen correctos. |
| `gemini` | `gemini-2.5-pro` | Los modelos citados hoy son familia 3.x; además la [capa OpenAI-compatible de Google](https://ai.google.dev/gemini-api/docs/openai) sigue declarándose **en beta**. |
| `minimax` | `MiniMax-M2` | Sigue listado, pero el vigente es M3; la [doc de MiniMax](https://platform.minimax.io/docs/guides/text-generation) además recomienda ya su endpoint Anthropic-compatible (irrelevante mientras el perfil sea OpenAI-compatible). Letra chica verificada del modo compatible: `n` solo 1, penalizaciones ignoradas ([referencia](https://platform.minimax.io/docs/api-reference/text-openai-api)). |
| `qwen` | `dashscope-intl.aliyuncs.com/compatible-mode/v1` | **La deriva más seria.** La [doc oficial de Model Studio](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope) ya empuja URLs por región y por *workspace*; la URL cableada sigue funcionando según terceros activos, pero está en ruta de deprecación. La misma doc acota el *function calling* a ciertos modelos. Existen snapshots fechados (`qwen3-max-2026-01-23`) útiles para fijar la deriva. |
| `anthropic` | — | El endpoint no cambió, pero la documentación se mudó: docs.anthropic.com redirige a [platform.claude.com](https://platform.claude.com/docs/en/api/overview). Referencias internas por actualizar. |
| `openai` | `gpt-5.1`, `max_completion_tokens` | Consistente con todo lo observado, pero la doc profunda no es verificable por máquina (la consola responde 403 a fetch automatizado); la [referencia nueva](https://developers.openai.com/api/reference/chat-completions/overview) confirma chat completions como API viva. La sonda es la verificación real. |
| `ollama` | — | Vigente; [su doc](https://docs.ollama.com/api/openai-compatibility) confirma tools en `/v1/chat/completions` y que `tool_choice` **no** está soportado (la sonda no lo usa, así que no afecta). |
| `hermes` | `Hermes-4-405B` | Vigente en [Nous Portal](https://hermes-agent.nousresearch.com/docs/integrations/nous-portal), con el matiz ya incorporado a la tabla: afinado para chat y razonamiento, no para bucles intensivos de herramientas. El Portal ahora rutea además cientos de modelos de terceros bajo una suscripción. |
| `copilot` | — | `api.githubcopilot.com` sigue sin documentación oficial como API pública; la ruta oficial es el SDK con *device flow* OAuth. La advertencia del perfil sigue siendo exacta. |

La moraleja no es «actualiza a mano cada tres meses». Es doble: a corto plazo, `--model` corrige cualquier default viejo sin tocar el catálogo; a mediano plazo, el plan de abajo prefiere ids **fechados** donde el proveedor los ofrezca y marca los alias tipo `latest` como deriva garantizada.

---

## Los proveedores que faltan (plan de la matriz v2 — todavía no existen)

La misma investigación verificó, en documentación oficial, seis proveedores OpenAI-compatibles con *tool calling* serio que hoy no tienen perfil, más tres nubes que piden trato especial. **Ninguno de estos perfiles está en el catálogo todavía**; esto es lo que se planea precargar:

| Candidato | base_url verificada | Credencial | Nota |
|---|---|---|---|
| Mistral | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | `tools` y `tool_choice` plenos ([doc](https://docs.mistral.ai/api/)) |
| DeepSeek | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | Compatibilidad declarada; [guía oficial de tool calls](https://api-docs.deepseek.com/guides/function_calling); modelos vigentes familia v4 |
| Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | Tools en todos sus modelos ([doc](https://console.groq.com/docs/tool-use)); [exclusiones conocidas](https://console.groq.com/docs/openai). **Peligro de teclado: `groq` y `grok` difieren en una letra** — las notas de ambos perfiles se nombrarán mutuamente |
| Together | `https://api.together.ai/v1` | `TOGETHER_API_KEY` | Ids de modelo con namespace (`meta-llama/...`); [doc](https://docs.together.ai/docs/openai-api-compatibility) |
| Fireworks | `https://api.fireworks.ai/inference/v1` | llave simple | Tools **por modelo** ([guía](https://docs.fireworks.ai/guides/function-calling)); ids largos `accounts/fireworks/models/...` |
| Cerebras | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` | Tools soportado ([doc](https://inference-docs.cerebras.ai/resources/openai)), con un caveat que no nos toca |
| Azure OpenAI | `https://{RECURSO}.openai.azure.com/openai/v1/` | llave o token Entra | [API v1 GA desde ago-2025](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle), cliente OpenAI plano sin `api-version`. No precargable con URL fija: irá como **plantilla del init** que pregunta el recurso |
| AWS Bedrock | `https://bedrock-runtime.{region}.amazonaws.com/openai/v1` | `AWS_BEARER_TOKEN_BEDROCK` | [Chat completions compatibles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions-mantle.html); tool calling por esa capa **no verificado** — exactamente el caso para el que la sonda existe. Plantilla del init con región |
| Vertex AI | patrón por proyecto/región, verificado solo en terceros | token de `gcloud` (~1 h) vía `api_key_cmd` | El peor ajuste para un contador: token que expira contra un `api_key_cmd` sin TTL. Irá como **receta documentada, no como perfil precargado** |

---

## La conexión del contador (dirección, no capacidad)

Hoy la única ruta de conexión es la del init actual: elegir proveedor, abrir el deep-link, pegar la llave, sonda doble, persistir tras prueba. Funciona, pero exige abrir una cuenta por proveedor. El plan investigado propone tres rutas, en lenguaje de despacho:

- **Ruta A (la recomendada del plan): una sola llave para todo.** OpenRouter ofrece [OAuth con PKCE](https://openrouter.ai/docs/use-cases/oauth-pkce) con modo *headless*: mnemosine imprimiría la URL, el contador la abre, aprueba con un click y pega el código que ve en pantalla; mnemosine lo canjea por una llave que va a `.env` — jamás al config, que solo diría `api_key_env: OPENROUTER_API_KEY`. Luego la sonda doble de siempre. Cero registro por proveedor.
- **Ruta B: ya tengo proveedor y llave.** El flujo actual, tal cual; solo crece la lista de perfiles y de deep-links.
- **Ruta C: suscripción.** Copilot sigue detrás de un intermediario que refresque el token (`api_key_cmd`); si algún día se implementa el *device flow* propio ([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)), el token irá a `.env` o a un helper, nunca al config. La e.firma y el CSD ni se mencionan en este flujo: esto es solo credencial de modelo.

Y la pieza contra la deriva silenciosa, también plan: una **instantánea fechada del modelo** — al pasar la primera sonda se guardaría el modelo pedido, el modelo que el proveedor **reporta** en la respuesta, su *fingerprint* cuando exista, y el hash de un muestreo fijo de prompts contables a temperatura 0. Un chequeo en `doctor` compararía después y reportaría `warn` cuando algo cambió: «el modelo que responde hoy no es el que probaste el día X». Nunca `fail` por sí solo — el agente propone, el humano dispone — y la reacción (avisar, o congelar el auto-posteo de la ingesta mientras haya deriva sin reconocer) sería una bifurcación de criterio en el panel, con su lector y su fila de catálogo. Ver [[El-agente-y-sus-limites]].

---

## Modelos locales, sin API key

El perfil `ollama` no declara `api_key_env`: no hay credencial que resolver. El SDK de OpenAI exige una cadena de todos modos, así que se le pasa un marcador de posición. `mnemosine providers` lo muestra como `no key`.

Un archivo mínimo apuntando a un modelo local:

```json
{
  "default_provider": "ollama",
  "providers": {
    "ollama": {
      "type": "openai-compatible",
      "model": "gemma4:26b",
      "base_url": "http://localhost:11434/v1"
    }
  }
}
```

**El modelo local tiene que soportar *tool calling*.** Sin herramientas el agente conversa, pero no consulta el mayor, no lee la normativa y no deja un borrador — es decir, no hace nada de lo que esta aplicación es. Antes de elegir un modelo instalado, verifica que su plantilla soporte llamadas a función.

---

## El aviso que trae el catálogo: `tools: false`

Dos perfiles predefinidos llevan `tools: false`, y su `note` lo dice en mayúsculas: `hermes-agent` y `openclaw`. No es una limitación de mnemosine, es lo que son esas pasarelas: **corren sus propias herramientas del lado del servidor y no devuelven llamadas de herramienta al cliente.** Por ese canal las herramientas contables de mnemosine **no se invocan nunca**. Es chat genérico.

Para contabilidad con herramientas sobre Hermes, el perfil es `hermes` (el de Nous Portal), que usa *function calling* estándar — con el matiz honesto de que Hermes 4 está afinado para chat y razonamiento antes que para bucles intensivos de herramientas.

El canal `tools: false` no se queda callado sobre lo que es. En [`openai-compat.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/providers/openai-compat.ts) pasan dos cosas al construir la sesión:

1. Se le anexa al prompt del sistema una nota de canal explícita: en esta sesión no tienes acceso a ninguna herramienta —ni siquiera a `read_docs`—, ignora el protocolo y las reglas que te piden llamarlas, y no cites cifras, endpoints ni flujos como si fueran reales.
2. Se **desactiva el guardia de fundamentación**. Ese guardia normalmente inyecta un turno correctivo cuando el modelo da una respuesta sustantiva sin haber consultado nada; en un canal sin herramientas exigiría lo imposible.

Además, `openclaw` necesita `gateway.http.endpoints.chatCompletions.enabled=true` en su propia configuración, y su token es una credencial de operador: sólo por *loopback*.

---

## Cadenas de respaldo

Un perfil puede declarar `failover: ["otro", "otro-mas"]`. La cadena se expande transitivamente en anchura —los respaldos de un respaldo se anexan después de él— y `resolveFailoverChain` valida cerrando puertas: todo nombre referenciado debe existir, un perfil no puede referenciarse a sí mismo, y un perfil que aparece en **su propia** ruta de expansión es un ciclo y se rechaza. Un rombo —el mismo respaldo alcanzable por dos caminos— no es un ciclo: se deduplica en silencio y conserva su primera posición.

El salto no ocurre ante cualquier error. [`failover.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/providers/failover.ts) clasifica primero y sólo salta donde cambiar de proveedor puede ayudar:

| Categoría | ¿Salta? | Por qué |
|---|---|---|
| `auth`, `rate_limit`, `server`, `timeout`, `billing` | Sí | Otro proveedor puede responder. |
| `overflow` | **No** | El prompt no cabe en ningún proveedor de ventana parecida. Eso es trabajo de la compactación. |
| `refusal` | **No** | Una negativa de seguridad tiene que llegarle a la persona, no irse de compras hasta que algún modelo obedezca. |
| `aborted` | **No** | Un Ctrl+C no es una falla del proveedor; reintentar reanudaría una corrida que alguien acaba de cancelar. |
| `unknown` | **No** | Saltar ante un error sin clasificar esconde defectos. Mejor fallar ruidosamente. |

`billing` gana sobre el código 429 a propósito: cuota agotada llega como HTTP 429, y «pon saldo» es una acción muy distinta de «espera un minuto».

Los enfriamientos son escalonados por proveedor —30 s la primera vez, duplicando hasta un tope de 5 min, en memoria— y el recorrido **siempre arranca en la cabeza de la cadena**: en cuanto expira el enfriamiento del principal, la siguiente llamada lo vuelve a probar a él primero. Los respaldos son temporales.

La atribución del modelo es correcta por construcción: la retrollamada del intento recibe el perfil **realmente usado**, así que un borrador creado por el modelo de respaldo queda atribuido a ese modelo, no al que se pidió. Y cada salto deja una fila en `ai_agent_events` con `kind = 'failover'`.

---

## Cuál está respondiendo de verdad

Dos comandos, con propósitos distintos.

**`mnemosine providers`** es el inventario: qué perfiles hay, cuál es el por omisión, qué modelo y endpoint lleva cada uno, si trae herramientas, y si la variable de entorno que nombra está puesta o falta. Al final imprime la ruta del archivo de configuración en uso — o, si no hay ninguno, cómo crear uno.

```bash
mnemosine providers
```

**`mnemosine status`** es la prueba en vivo. Además del resumen de configuración, la conectividad de la base y la comprobación de que RLS está activa, hace una **sonda real** contra cada proveedor de la cadena activa:

```bash
mnemosine status
```

```bash
mnemosine status --all
```

La sonda ([`probe.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/providers/probe.ts)) contesta una sola pregunta por proveedor —¿puede servir una petición ahora mismo?— con la llamada más barata que el endpoint ofrece: `GET {base_url}/models` para los OpenAI-compatibles, que no cuesta tokens, y para Anthropic un `POST /v1/messages` con `max_tokens: 1`, porque no hay endpoint autenticado más barato y un token es el piso. Diez segundos de tiempo límite, sin reintentos, aisladas entre sí, y el error **categorizado con la misma taxonomía** que usa la cadena de respaldo: `auth` y `billing` piden acciones distintas del operador.

Sin `--all`, sondea la cadena de respaldo activa. Con `--all`, todos los perfiles configurados.

Lo importante para el uso práctico: **la salida está redactada por diseño.** [`status-command.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/status-command.ts) nunca imprime valores de variables de entorno, sólo **nombres** con puesta/no puesta; colapsa el directorio del usuario a `~`; y los detalles de la sonda pasan por un redactor que tacha la credencial si el endpoint la devuelve en el eco y elimina el *userinfo* de las URLs, porque un error de red puede traer de vuelta `https://usuario:secreto@host/...`. Los umbrales de auto-posteo se muestran **después** del recorte por el suelo — lo que de verdad aplica, no lo que el archivo pidió.

Eso significa que `mnemosine status --json` es seguro de pegar en un ticket de soporte. Ése fue el criterio de diseño explícito.

Si algo no responde, el diagnóstico paso a paso está en [[Solucion-de-problemas]].

---

## Para seguir

- [[El-agente-y-sus-limites]] — qué puede y qué no puede hacer el modelo que elijas aquí.
- [[Puesta-en-marcha]] — el asistente `init`, que también configura el proveedor.
- [[Seguridad-y-credenciales]] — credenciales fiscales y qué queda registrado.
- [[Solucion-de-problemas]] — sondas en rojo, llaves faltantes y canales sin herramientas.
- [[Arquitectura]] — dónde encajan los dos motores de sesión.
- [[Hoja-de-ruta]] — dónde cae la matriz v2 y la conexión del contador.
