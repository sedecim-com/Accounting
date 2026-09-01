# Proveedores de modelo

mnemosine no está casado con un proveedor. Hay dos motores de sesión —el nativo de Anthropic, con caché de prompt y bloques de razonamiento, y un adaptador OpenAI-compatible que sirve a todo lo demás— y encima de ellos un catálogo de perfiles predefinidos que se extiende desde un archivo de configuración.

El README ya cuenta [cómo arrancar con un modelo local](https://github.com/sedecim-com/Accounting/blob/main/README.md). Esta página cubre lo que viene después: la precedencia exacta, por qué el esquema del archivo es estricto, dónde vive la llave, y cómo saber cuál de todos está respondiendo de verdad.

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
| `gemini` | OpenAI-compatible | `gemini-2.5-pro` | `GEMINI_API_KEY` | Endpoint compatible de Google AI Studio |
| `grok` | OpenAI-compatible | `grok-4` | `XAI_API_KEY` | |
| `qwen` | OpenAI-compatible | `qwen3-max` | `DASHSCOPE_API_KEY` | DashScope en modo compatible |
| `minimax` | OpenAI-compatible | `MiniMax-M2` | `MINIMAX_API_KEY` | Endpoint global; para China se cambia `base_url` |
| `openrouter` | OpenAI-compatible | `openrouter/auto` | `OPENROUTER_API_KEY` | Una llave, muchos modelos |
| `copilot` | OpenAI-compatible | `gpt-5.1` | `COPILOT_API_TOKEN` | El token sale del flujo OAuth de GitHub, no es una llave clásica |
| `hermes` | OpenAI-compatible | `Hermes-4-405B` | `NOUS_API_KEY` | *Function calling* estándar: las herramientas contables funcionan |
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

El modelo se elige aparte: `--model` sobrescribe el `model` del perfil sin cambiar de perfil, que es lo que quieres cuando tu cuenta tiene otra versión disponible del mismo proveedor.

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

**El perfil sólo nombra de dónde sale la llave.** `api_key_env` lleva el *nombre* de una variable de entorno (`"NOUS_API_KEY"`), no su valor. `api_key_cmd` lleva un comando que imprime la credencial: un gestor de secretos, una bóveda, o el token de una suscripción ya autenticada. `api_key_cmd` se intenta **sólo si el entorno no resolvió**, corre con un tiempo límite de diez segundos, y si no imprime nada, falla ruidosamente en vez de seguir sin credencial.

**El escritor de configuración se niega a guardar secretos.** `writeConfigPatch` pasa todo por `assertNoSecrets` antes de tocar el disco, y rechaza dos formas: un valor que **parece** credencial por su prefijo (`sk-`, `ghp_`, `xoxb-`, `AKIA`, `eyJ`), y una llave con nombre de credencial (`key`, `token`, `secret`, `password`) cuyo valor no tiene forma de nombre de variable de entorno. La excepción son las llaves `*_cmd`, que legítimamente llevan comandos — aunque a esas les sigue aplicando la revisión por prefijo, por si alguien pegó ahí la llave de verdad. El mensaje de error dice el porqué: los archivos de configuración se comparten y acaban en git.

**El esquema es estricto: `.strict()` en todos los niveles.** Una llave desconocida es *siempre* un error. Un `api_key_evn` mal tecleado, si el esquema fuera permisivo, se ignoraría en silencio y el sistema caería a los valores por omisión — el peor modo de fallo posible para un archivo que gobierna credenciales. Aquí truena.

Y cuando truena, no se pierde la evidencia: `quarantineInvalidConfig` copia el archivo rechazado a `<archivo>.rejected-<hash>` antes de lanzar la excepción. El nombre lleva el hash del contenido, así que reintentar es idempotente —el mismo archivo inválido produce siempre el mismo respaldo, sin basura por corrida— y un archivo roto de otra manera obtiene su propia copia. Un archivo que **existe** pero es inválido nunca se reemplaza en silencio por valores por omisión.

Más sobre credenciales del sistema (las fiscales, que son otra cosa) en [[Seguridad-y-credenciales]].

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

Para contabilidad con herramientas sobre Hermes, el perfil es `hermes` (el de Nous Portal), que usa *function calling* estándar.

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
