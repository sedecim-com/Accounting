# Proveedores de modelo

mnemosine no está casado con un proveedor. Hay dos motores de sesión —el nativo de Anthropic, con caché de prompt y bloques de razonamiento, y un adaptador OpenAI-compatible que sirve a todo lo demás— y encima de ellos un catálogo de perfiles predefinidos que se extiende desde un archivo de configuración.

El README ya cuenta [cómo arrancar con un modelo local](https://github.com/sedecim-com/Accounting/blob/main/README.md). Esta página cubre lo que viene después: la precedencia exacta, por qué el esquema del archivo es estricto, dónde vive la llave, cómo saber cuál de todos está respondiendo de verdad — y, al final, lo que la investigación de septiembre de 2026 encontró: qué defaults del catálogo ya derivaron, qué cuesta un documento, dónde se puede y dónde no se puede procesar, qué proveedores faltan y qué se planea hacer al respecto. Esa última parte es dirección, no capacidad.

> **Dos avisos de la segunda pasada (2-sep-2026, tarde), antes de cualquier otra cosa.**
>
> 1. **Hay perfiles apuntando a modelos que ya no existen.** `openai` y `copilot` embarcan
>    `gpt-5.1`; `grok` embarca `grok-4`. **Ninguno de los dos aparece ya en la documentación de su
>    proveedor.** No es «quedó viejo»: es que el id no está en la referencia. El remedio inmediato
>    es `--model`; el remedio de fondo tiene un orden obligatorio que esta página explica.
> 2. **El presupuesto lee `$0.00` en cinco perfiles y por eso nunca corta.** La tabla local de
>    precios no conoce el modelo con el que arrancan `hermes`, `minimax`, `qwen`, `openrouter` ni
>    `ollama`. Sin precio no hay costo estimado, y sin costo estimado `budget.monthly_usd` suma
>    cero — con `on_exceed` en `block` por omisión en ruta desatendida, o sea que la protección que
>    más promete es la que menos protege.
>
> Lo que esta página afirmaba antes y ya no es cierto está al final, en
> **Lo que esta página decía y ya no es cierto**.

---

## Los perfiles predefinidos

Viven en `BUILTIN_PROFILES`, en [`src/ai/providers/config.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/providers/config.ts). Para verlos con el estado real de sus credenciales en tu máquina:

```bash
mnemosine providers
```

| Perfil | Motor | Modelo por omisión | Credencial | ¿Precio local? | Notas |
|---|---|---|---|---|---|
| `anthropic` | nativo | `claude-opus-5` | `ANTHROPIC_API_KEY` | sí | El proveedor por omisión, y el único renglón de precios que la verificación confirmó dígito por dígito |
| `openai` | OpenAI-compatible | `gpt-5.1` ⚠ | `OPENAI_API_KEY` | sí, pero del modelo muerto | Usa `max_completion_tokens`. **El id ya no está en la doc de OpenAI** |
| `gemini` | OpenAI-compatible | `gemini-2.5-pro` | `GEMINI_API_KEY` | sí | Endpoint compatible de Google AI Studio, **todavía en beta**; la familia viva es 3.x |
| `grok` | OpenAI-compatible | `grok-4` ⚠ | `XAI_API_KEY` | sí, pero del modelo muerto | **`grok-4` ya no está en la referencia de modelos de xAI** |
| `qwen` | OpenAI-compatible | `qwen3-max` | `DASHSCOPE_API_KEY` | **no** | DashScope en modo compatible; la URL cableada ya tiene aviso de migración escrito |
| `minimax` | OpenAI-compatible | `MiniMax-M2` | `MINIMAX_API_KEY` | **no** | Endpoint global; para China se cambia `base_url`. Ventana ya conocida: 204 800 |
| `openrouter` | OpenAI-compatible | `openrouter/auto` | `OPENROUTER_API_KEY` | **no** | Una llave, muchos modelos. El alias `auto` es deriva garantizada por diseño |
| `copilot` | OpenAI-compatible | `gpt-5.1` ⚠ | `COPILOT_API_TOKEN` | sí, pero del modelo muerto | El token sale del flujo OAuth de GitHub y es corto: útil solo detrás de un intermediario que lo refresque |
| `hermes` | OpenAI-compatible | `Hermes-4-405B` | `NOUS_API_KEY` | **no** | *Function calling* estándar; la propia doc de Nous advierte que Hermes 4 está afinado para chat y razonamiento, no para bucles intensivos de herramientas |
| `hermes-agent` | OpenAI-compatible | `hermes-agent` | `HERMES_AGENT_KEY` | **no** | Pasarela local. **`tools: false`** |
| `ollama` | OpenAI-compatible | `llama3.1` | ninguna | **no**, y es local | Sin llave. El único perfil que procesa dentro de México — ver residencia de datos |
| `openclaw` | OpenAI-compatible | `openclaw:main` | `OPENCLAW_GATEWAY_TOKEN` | **no** | Pasarela local. **`tools: false`** |

La columna de precio es el aviso 2 de arriba puesto en su sitio: **cinco perfiles operativos corren
con un modelo que `lookupPrice` no conoce** — `hermes`, `minimax`, `qwen`, `openrouter` y `ollama`
([`prices.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/providers/prices.ts)). Las
dos pasarelas tampoco tienen precio, pero por ellas no pasa contabilidad porque llevan
`tools: false`. Y de los que sí lo tienen, tres lo tienen de un modelo muerto.

El catálogo no se cuenta a mano: `mnemosine providers` imprime la lista efectiva —predefinidos más los del archivo— con el modelo, el endpoint, si el perfil lleva herramientas y si la variable de entorno que nombra está puesta. (El [README](https://github.com/sedecim-com/Accounting/blob/main/README.md) sigue diciendo «once perfiles predefinidos» y **el número está mal**: su lista simplemente omite `hermes-agent`. Son doce, y siempre lo fueron — `src/ai/docs/connectivity.md:50` dice «12 built-in profiles» desde el commit de línea base.)

---

## Quién gana: la precedencia

```text
--provider  >  MNEMOSINE_PROVIDER  >  default_provider del archivo  >  'anthropic'
```

La bandera es la elección explícita de quien está tecleando; la variable de entorno es de la sesión de la terminal; `default_provider` es del proyecto o del usuario; y si nada dice otra cosa, `anthropic`. La resuelve `listProfiles` y la consume `resolveProfile`.

El modelo se elige aparte: `--model` sobrescribe el `model` del perfil sin cambiar de perfil, que es lo que quieres cuando tu cuenta tiene otra versión disponible del mismo proveedor — y es el remedio inmediato para los tres perfiles que apuntan a un modelo muerto, sin esperar a que el catálogo se actualice. **Dos cosas que `--model` no arregla**, y conviene saberlas: no mueve la **ventana de contexto**, que es una declaración del *perfil* y no del modelo (quien sepa lo que hace manda con `compaction.threshold_tokens`, que gana sobre todo); y no siembra ninguna **instantánea fechada**, así que la deriva del proveedor sigue sin detectarse.

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
| `budget` | `daily_usd`, `monthly_usd`, `on_exceed`. Sin esta sección no se consulta gasto alguno — **y con ella, hoy el tope lee $0.00 en cinco perfiles**: ver «Lo que cuesta un documento». |
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

## La deriva: qué default del catálogo ya no corresponde a nada

Los defaults de un catálogo estático envejecen. Esta tabla es el resultado de dos verificaciones
contra documentación viva el 2-sep-2026 —la de la mañana y la de la tarde, que **subió de grado**
varias filas—. Ninguna deriva rompe el perfil por sí sola (la sonda del `init` sigue siendo el
árbitro), pero tres de ellas ya no son matices.

| Perfil | Lo cableado | Lo que dice hoy la fuente |
|---|---|---|
| `openai` | `gpt-5.1` | **El id ya no aparece** en la [referencia de modelos de OpenAI](https://developers.openai.com/api/docs/models). La familia listada es GPT-5.6 —`Sol`, `Terra`, `Luna`—, las tres con 1.05 M de ventana y 128 k de salida. |
| `grok` | `grok-4` | **El id ya no aparece** en [docs.x.ai/docs/models](https://docs.x.ai/docs/models). Lo que hay: `grok-4.6` y `grok-4.5` (500 k), `grok-4.3` y la familia `grok-4.20` (1 M), `grok-build-0.1` (256 k). El endpoint y la autenticación (`https://api.x.ai/v1`, Bearer) siguen exactos. |
| `copilot` | `gpt-5.1` | Arrastra el mismo modelo muerto. Además `api.githubcopilot.com` sigue sin documentación oficial como API pública: la ruta oficial es el SDK con *device flow*. |
| `qwen` | `dashscope-intl.aliyuncs.com/compatible-mode/v1` | **Subió de grado.** Ya no es «ruta de deprecación»: la [doc de compatibilidad de Model Studio](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope) trae **aviso de migración escrito** hacia el endpoint por *workspace* de Singapur (`https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`), con variantes de Virginia, Hong Kong y Tokio. Y la misma página acota el *function calling* a «qwen-turbo, qwen-plus, qwen-max» — el perfil embarca `qwen3-max`, que no es ninguno de esos tres nombres. |
| `gemini` | `gemini-2.5-pro` | Los ejemplos de la doc ya usan la familia 3.x (`gemini-3.8-flash`), y la [capa OpenAI-compatible de Google](https://ai.google.dev/gemini-api/docs/openai) **sigue declarándose en beta**. La base lleva diagonal final. |
| `minimax` | `MiniMax-M2` | Sigue listado —el perfil no está roto—, pero el vigente es M3 (1 M). **Dato nuevo y accionable: M2 son 204 800 tokens de ventana** ([fuente](https://platform.minimax.io/docs/guides/text-generation)), que es la única de las ocho ventanas desconocidas que se puede cerrar hoy. |
| `anthropic` | — | Sin deriva. El endpoint no cambió y el precio coincide dígito por dígito con la [página oficial](https://platform.claude.com/docs/en/about-claude/pricing). La documentación sí se mudó: docs.anthropic.com redirige a platform.claude.com. |
| `hermes` | `Hermes-4-405B` | Vigente en [Nous Portal](https://hermes-agent.nousresearch.com/docs/integrations/nous-portal), con el matiz ya incorporado a la tabla de perfiles. Sin precio en la tabla local. |
| `ollama` | — | Vigente; [su doc](https://docs.ollama.com/api/openai-compatibility) confirma tools en `/v1/chat/completions` y que `tool_choice` **no** está soportado (la sonda no lo usa, así que no afecta). |

Y la deriva alcanza también a la tabla de precios, que es un archivo aparte:
[`prices.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/providers/prices.ts) lleva su
fecha de corte como dato (`PRECIOS_VIGENTES_A = '2026-08-24'`, línea 52, que `mnemosine usage`
imprime) y **cuatro de sus renglones nombran modelos que sus proveedores ya no listan**: `gpt-5.1`
(línea 80), `grok-4` (87), `deepseek-chat` (99) y `deepseek-reasoner` (100).

La moraleja no es «actualiza a mano cada tres meses». Es doble: a corto plazo, `--model` saca de
apuros a quien tiene un default muerto —aunque no mueva la ventana ni siembre instantánea—; a
mediano plazo, el catálogo debe preferir ids **fechados** donde el proveedor los ofrezca, y hoy
**los doce perfiles declaran `instantanea: null`**, o sea que esa preferencia no se cumplió en
ninguno.

---

## El orden obligatorio: primero el modelo, luego la instantánea, luego la ventana

Ésta es la parte que hay que aprenderse, porque el trabajo hecho en el orden equivocado se tira.

```text
subir el `model`  →  fijar la `instantanea` fechada  →  declarar la `ventana`
```

**Por qué ese orden y no otro.** Cada perfil declara su ventana de contexto en
[`config.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/providers/config.ts), y de
los doce sólo cuatro traen número: `anthropic` (1 000 000), `gemini` (1 048 576), `hermes` (131 072)
y `ollama` (32 768). Los otros ocho dicen `desconocida` y caen al respaldo global de 150 000. Buscar
la ventana de un modelo que ya no existe es trabajo tirado: la razón que hoy trae el perfil `grok`
—«xAI documenta la ventana de grok-4 […] es un dato de una línea que se comprueba en un minuto»— ya
es falsa, porque la referencia de xAI no documenta `grok-4`. El dato de una línea no se puede traer.

Las ocho desconocidas no son ocho deudas iguales:

| Perfil | ¿Se cierra hoy? | Por qué |
|---|---|---|
| `minimax` | **Sí — 204 800** | MiniMax lo publica por modelo. Es una línea. |
| `openai`, `grok` | No, **hasta subir el `model`** | El id del perfil no está en la doc del proveedor. Se desbloquean subiéndolo, no investigando más: OpenAI publica la ventana de la familia 5.6, xAI la de 4.6 y 4.3. |
| `qwen` | No, **hasta fijar la instantánea** | Ninguna página recuperable de Model Studio publica la ventana, y `qwen3-max` es un alias que el proveedor repunta: la ventana viaja con la instantánea concreta que sirva ese día. |
| `openrouter`, `copilot`, `hermes-agent`, `openclaw` | No, **por construcción** | `auto` elige modelo por petición; lo que GitHub sirve tras su alias no se versiona al cliente; y en las pasarelas la ventana la fija la configuración de la pasarela. Sus razones actuales son correctas y deben quedarse. |

Resumen honesto: **de ocho, una se cierra hoy con fuente oficial** (`minimax`). Tres se desbloquean
tocando el `model` —`openai`, `grok` y `qwen`— y cuatro son irreducibles. Nótese que `copilot` cae en
las irreducibles aunque arrastre un modelo muerto: subirle el id sigue siendo necesario, pero no le
va a dar una ventana declarable.

La otra mitad de esta deuda —el **detector** de deriva— sigue sin existir: `ai_instantaneas_modelo`,
el chequeo en `doctor` y el criterio `ia_deriva_modelo` del panel están propuestos y no escritos
(ni `instantanea_modelo` ni `ia_deriva` aparecen en una sola línea de `src/`). Lo que sí se hizo es la mitad de
arriba: cada perfil declara obligatoriamente su postura de muestreo, y la bandera
`MUESTREO_CABLEADO = false` (config.ts:169) dice en voz alta que **hoy ningún runner envía
`temperature`** — la declaración es declaración, no cable.

Así está diseñado el detector que falta, para que quien lo escriba no tenga que reinventarlo: al
pasar la primera sonda se guarda el modelo pedido, el modelo que el proveedor **reporta** en la
respuesta, su *fingerprint* cuando exista, y el hash de un muestreo fijo de prompts contables a
temperatura 0. Un chequeo en `doctor` compara después y reporta `warn` cuando algo cambió —«el
modelo que responde hoy no es el que probaste el día X»—, nunca `fail` por sí solo: el agente
propone, el humano dispone. Y la reacción (avisar, o congelar el auto-posteo de la ingesta mientras
haya deriva sin reconocer) es una bifurcación de criterio, así que va al panel con su lector y su
fila de catálogo, no a una bandera suelta. Ver [[El-agente-y-sus-limites]].

---

## Lo que cuesta un documento — y por qué hoy el presupuesto no corta

**Primero el freno roto.** `budget` es la sección del archivo que promete un tope de gasto
(`daily_usd`, `monthly_usd`, `on_exceed`). El tope se calcula sumando `ai_usage.estimated_cost_usd`,
y ese costo sale de la tabla local de precios. Cuando `lookupPrice` no conoce el modelo, el costo
estimado es `NULL`, la suma da cero, y el tope **nunca se alcanza**. Un despacho que ponga
`budget.monthly_usd` y corra en `minimax`, `qwen`, `hermes`, `openrouter` u `ollama` tiene un
presupuesto que **siempre lee `$0.00`**. En ruta desatendida el `on_exceed` por omisión es `block`
([`src/ai/budget.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/budget.ts)), o sea
que la protección que más promete es exactamente la que menos protege. El contador de turnos sin
precio existe y `mnemosine usage` lo imprime, pero **contar no es cortar**.

Para dos de esos cinco el renglón honesto es seguir en `NULL` y decirlo: MiniMax y Qwen **no
publican precio en ninguna página recuperable** (los tres URLs de precio de MiniMax dan 404 y la
página de modelos de Qwen redirige a una consola con sesión). Para los otros tres el renglón se
puede escribir.

**Y ahora el número que un socio pide de verdad.** Una clasificación normal —leer la doc, buscar la
cuenta, buscar precedente, leer la política del despacho, redactar el borrador— son unas cinco
llamadas al modelo. Medido en este árbol, no supuesto: los esquemas de las once herramientas de la
ingesta pesan 10 522 caracteres (≈ 2 631 tokens), las instrucciones de rol más el índice de
documentos 8 453 (≈ 2 114), el catálogo de cuentas hasta 400 líneas (≈ 3 000), y cada resultado de
herramienta entra hasta 32 000 caracteres. Sale **≈ 60 000 tokens de entrada y ≈ 1 500 de salida por
documento**.

| Modelo | $/M entrada | $/M salida | **por documento** | **2 000 docs/mes** |
|---|---|---|---|---|
| `claude-opus-5` (el default) | 5 | 25 | $0.34 | $675 |
| `claude-opus-5` con el prefijo cacheado | 5 (caché 0.50) | 25 | **$0.22** | **$436** |
| `claude-sonnet-5` | 2 | 10 | $0.14 | $270 |
| `claude-haiku-4.5` | 1 | 5 | $0.068 | $135 |
| `gpt-5.6 Sol` | 4 | 20 | $0.27 | $540 |
| `gpt-5.6 Terra` | 2 | 12 | $0.14 | $276 |
| `gpt-5.6 Luna` | 0.20 | 1.20 | **$0.014** | **$28** |
| `grok-4.6` (<200 k) | 2 | 6 | $0.13 | $258 |
| `grok-4.3` (<200 k) | 1.25 | 2.50 | $0.079 | $158 |
| `gemini-3.8-flash` | 0.75 | 3.75 | $0.051 | $101 |
| `gemini-2.5-pro` (el del perfil) | 1.25 | 10 | $0.090 | $180 |
| `deepseek-v4-flash` (valle) | 0.22 | 0.66 | **$0.014** | **$28** |
| `deepseek-v4-pro` (valle) | 0.66 | 1.98 | $0.043 | $85 |
| `mistral-large` | 0.5 | 1.5 | $0.032 | $65 |
| groq `openai/gpt-oss-120b` | 0.15 | 0.60 | **$0.010** | **$20** |
| `MiniMax-M2`, `qwen3-max` | *sin fuente oficial recuperable* | — | — | — |
| `ollama` (local) | 0 | 0 | $0 marginal | $0 + el fierro |

Tres lecturas que ese cuadro obliga, y ninguna es «cambia de modelo mañana»:

- **El default cuesta veinticuatro veces el más barato.** No es argumento para cambiarlo —la calidad
  de clasificación contable **no está medida** entre estos modelos, y el arnés existe justamente para
  medirla— pero sí es argumento para que el `init` lo diga antes de que el despacho encienda la
  ingesta nocturna.
- **La caché del prefijo vale un tercio de la factura de Anthropic y no viaja por el camino
  compatible.** Los bloques de sistema se marcan cacheables, pero el runner OpenAI-compatible los
  recibe **aplanados a texto**: quien cachea ahí lo hace por su cuenta (OpenAI y DeepSeek sí; los
  demás no).
- **El coste crece con los RESULTADOS de herramienta, no con el CFDI.** El documento son 350 tokens
  de 60 000. Lo caro es el `read_docs` y las búsquedas que se re-envían en cada vuelta. Cualquier
  ahorro serio está en el bucle, no en el proveedor.

Un aviso sobre la forma de la tabla de precios, que hoy no lo soporta: `ModelPrice` es plana —un
input, un output, dos tarifas de caché—, y los precios de 2026 ya no lo son. xAI cobra **por tramo
de contexto** (el doble por encima de 200 k) y DeepSeek cobra **por horario** (valle y pico, con la
ventana de pico publicada en UTC). Mientras la forma no cambie, el invariante del archivo —«las
estimaciones deben sorprender hacia abajo en el reporte, nunca en la factura»— obliga a cargar
siempre el precio caro, y un despacho que corra de noche en México sobreestima el doble.

---

## Residencia de datos: en México no existe, en ninguna nube

Ésta es la pregunta que parte el árbol en dos y que hoy **el `init` no hace**: *¿pueden salir del
país los XML de tus clientes?* Verificado contra fuente oficial el 2-sep-2026:

- **Anthropic** — `inference_geo` acepta **sólo `"us"` y `"global"`**, y el *workspace geo* declara
  que «`us` es el único disponible» ([residencia de
  datos](https://platform.claude.com/docs/en/manage-claude/data-residency)). No hay México ni LatAm.
  El `"us"` cuesta 1.1× sobre todo.
- **AWS Bedrock** — la región `mx-central-1` **existe**, pero para los modelos de la familia Claude
  figura únicamente bajo «Global»: «In-Region» y «Geo» aparecen como no soportados. Traducción para
  un despacho: se puede **facturar** desde México; no se puede **inferir** en México.
- **Azure / Microsoft Foundry** — las tablas de región y zonas de datos legibles son US y EU; el
  punto más cercano en LatAm es Brazil South.
- **Google Vertex** — **no verificable.** Sus páginas de *locations* y *data residency* sirven índice
  de navegación y no contenido, en dos pasadas consecutivas. No se afirma nada.

**La consecuencia es limpia: si los papeles de un cliente no pueden salir del país, el único perfil
que cumple es `ollama`.** No es una limitación del producto que se pueda arreglar comprando otra
nube: ninguna de las cuatro ofrece inferencia en México. Y `ollama` se elige con los ojos abiertos:
ventana declarada de 32 768 (config.ts:265–275) y la falta de reproducibilidad ya **medida** —tres
corridas del mismo caso dieron 0.750, 0.750 y 0.000, y la tercera ni siquiera clasificó
(config.ts:29–38)—.

Lo que falta aquí no es infraestructura: es **decirlo**, en el `init` y en
`src/ai/docs/connectivity.md`. Hoy el default lleva los CFDI de un tercero a un servidor extranjero
sin que nadie haya tomado la decisión.

---

## Los proveedores que faltan (plan de la matriz v2 — todavía no existen)

La misma investigación verificó, en documentación oficial, seis proveedores OpenAI-compatibles con *tool calling* serio que hoy no tienen perfil, más tres nubes que piden trato especial. **Ninguno de estos perfiles está en el catálogo todavía**; esto es lo que se planea precargar:

| Candidato | base_url verificada | Credencial | Nota |
|---|---|---|---|
| Mistral | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | `tools` y `tool_choice` plenos ([doc](https://docs.mistral.ai/api/)) |
| DeepSeek | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | Compatibilidad declarada; [guía oficial de tool calls](https://api-docs.deepseek.com/guides/function_calling). Familia v4 (`v4-flash`, `v4-pro`), **1 M de ventana** y precio **por horario**: valle y pico, con el pico publicado en UTC ([precios](https://api-docs.deepseek.com/quick_start/pricing)). Jurisdicción China: para papeles fiscales de un tercero eso es conversación con el cliente, no decisión de ingeniería |
| Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | Tools en todos sus modelos ([doc](https://console.groq.com/docs/tool-use)); [exclusiones conocidas](https://console.groq.com/docs/openai). Ojo al elegir el default: **los Llama ya no publican precio** («Contact Sales»); el que sí lo publica es `openai/gpt-oss-120b`, $0.15/$0.60 y 131 072 de ventana ([modelos](https://console.groq.com/docs/models)) — y es el más barato por documento de toda la tabla de costos. **Peligro de teclado: `groq` y `grok` difieren en una letra** — las notas de ambos perfiles se nombrarán mutuamente |
| Together | `https://api.together.ai/v1` | `TOGETHER_API_KEY` | Ids de modelo con namespace (`meta-llama/...`); [doc](https://docs.together.ai/docs/openai-api-compatibility) |
| Fireworks | `https://api.fireworks.ai/inference/v1` | llave simple | Tools **por modelo** ([guía](https://docs.fireworks.ai/guides/function-calling)); ids largos `accounts/fireworks/models/...` |
| Cerebras | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` | Tools soportado ([doc](https://inference-docs.cerebras.ai/resources/openai)), con un caveat que no nos toca |
| Azure OpenAI | `https://{RECURSO}.openai.azure.com/openai/v1/` | llave o token Entra | [API v1 GA desde ago-2025](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle), cliente OpenAI plano sin `api-version`. No precargable con URL fija: irá como **plantilla del init** que pregunta el recurso |
| AWS Bedrock | `https://bedrock-runtime.{region}.amazonaws.com/openai/v1` | `AWS_BEARER_TOKEN_BEDROCK` | [Chat completions compatibles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions-mantle.html); tool calling por esa capa **no verificado** — exactamente el caso para el que la sonda existe. Plantilla del init con región |
| Vertex AI | patrón por proyecto/región, verificado solo en terceros | token de `gcloud` (~1 h) vía `api_key_cmd` | El peor ajuste para un contador: token que expira contra un `api_key_cmd` sin TTL. Irá como **receta documentada, no como perfil precargado** |

---

## La conexión del contador (dirección, no capacidad)

Hoy la única ruta de conexión es la del init actual: elegir proveedor, abrir el deep-link, pegar la llave, sonda doble, persistir tras prueba. Funciona, pero exige abrir una cuenta por proveedor. El plan investigado propone tres rutas, en lenguaje de despacho:

- **Ruta A (la recomendada del plan): una sola llave para todo.** OpenRouter ofrece [OAuth con PKCE](https://openrouter.ai/docs/use-cases/oauth-pkce) con modo *headless*: mnemosine imprimiría la URL, el contador la abre, aprueba con un click y pega el código que ve en pantalla —de un solo uso, expira en diez minutos—; mnemosine lo canjea por una llave que va a `.env` — jamás al config, que solo diría `api_key_env: OPENROUTER_API_KEY`. Luego la sonda doble de siempre. Cero registro por proveedor.

  Y es también la mejor respuesta verificada en **privacidad demostrable ante un cliente**, por un margen amplio: OpenRouter no registra prompts ni respuestas por omisión, permite filtrar proveedores por su política de datos y **falla la petición** si ninguno cumple la política de la cuenta, y no pone margen sobre la inferencia (cobra al comprar crédito, no al inferir). Para un despacho que maneja papeles fiscales de terceros, ese conjunto es exactamente lo que hay que poder enseñar.

  **Con una condición que no es opcional:** el alta tiene que **fijar un modelo concreto**. El perfil `openrouter` del catálogo trae `model: 'openrouter/auto'`, cuya propia razón declara que no es evaluable — «dos corridas del mismo proveedor+modelo pueden haber preguntado a dos modelos distintos» (config.ts:412–419). La ruta de menor fricción no puede entregar, por omisión, el único perfil que el arnés no puede medir.
- **Ruta B: ya tengo proveedor y llave.** El flujo actual, tal cual; solo crece la lista de perfiles y de deep-links.
- **Ruta C: suscripción.** Copilot sigue detrás de un intermediario que refresque el token (`api_key_cmd`); si algún día se implementa el *device flow* propio ([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)), el token irá a `.env` o a un helper, nunca al config. La e.firma y el CSD ni se mencionan en este flujo: esto es solo credencial de modelo.

Y **antes de las tres rutas falta una pregunta**, que hoy nadie hace: *¿pueden salir del país los XML de tus clientes?* Un sí/no que parte el árbol en dos —`ollama` de un lado, todo lo demás del otro— y que decide más que cualquier comparación de precio. Mientras el `init` no la haga, el default manda los CFDI de un tercero a un servidor extranjero por omisión. El asistente sigue **sin tocarse desde el commit de línea base**: no existe la ruta A, no existen las plantillas de Azure/Bedrock, y `KEY_URLS` (`src/cli/init/s3-ai.ts:23–35`) sigue con las once entradas de siempre.

**La recomendación corta, con lo verificado hoy.** Si los papeles no pueden salir del país: `ollama`, y no hay alternativa. Si sí pueden salir y lo que pesa es la privacidad demostrable: OpenRouter con modelo fijo, dado de alta por PKCE headless. Si lo que pesa es el precio por documento: `groq/gpt-oss-120b`, `gpt-5.6 Luna` o `gemini-3.8-flash`, entre $0.010 y $0.051. Y sobre **latencia**: ningún proveedor publica latencia a México y ninguno tiene región de inferencia en el país — la columna `duration_ms` ya está poblada desde la migración 044, pero `stats-service.ts` la promedia **sin agrupar por proveedor**, así que hoy el sistema no puede contestar «¿cuál me conviene desde Guadalajara?» con sus propios números. Recomendar por latencia sin ese `GROUP BY` sería una opinión disfrazada de medición.

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

Y hay una segunda razón para elegir este perfil que no tiene nada que ver con el costo: **es el único que procesa dentro de México**. Si los papeles de un cliente no pueden salir del país, la decisión ya está tomada por él. Los dos costos de esa decisión están medidos y escritos en el propio perfil: ventana de 32 768 y falta de reproducibilidad entre corridas.

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

## Lo que esta página decía y ya no es cierto

Una wiki que se reescribe en silencio le miente a quien la leyó ayer. Esto es lo que esta página
afirmaba antes de la segunda pasada del 2-sep-2026 y que hoy está corregido arriba:

- **Decía que el perfil `openai` era «consistente con todo lo observado».** Falso. Se dijo cuando la
  doc profunda de OpenAI no era verificable por máquina (403); la referencia que sí responde hoy
  contradice el perfil: `gpt-5.1` no aparece.
- **Decía de `grok` que «la doc ya lista la familia 4.x posterior», o sea que el default había
  quedado viejo.** Es más fuerte que eso: `grok-4` **no está** en la referencia de modelos de xAI.
  «Viejo» y «no existe» piden trabajos distintos.
- **Decía que la URL de `qwen` estaba «en ruta de deprecación».** Hoy la doc oficial trae **aviso de
  migración escrito** hacia el endpoint por *workspace*. Y se añade un dato que la página no tenía:
  el *function calling* está acotado a `qwen-turbo`, `qwen-plus` y `qwen-max`, y el perfil embarca
  `qwen3-max`, que no es ninguno de esos tres nombres.
- **Decía que el README «enumera once porque agrupa `hermes` y `hermes-agent`».** No los agrupa: los
  omite. El README está mal y son doce perfiles — `src/ai/docs/connectivity.md:50` dice «12 built-in
  profiles» desde el commit de línea base.
- **De `minimax` sólo decía que M3 ya existía.** Se añade lo accionable: **M2 son 204 800 tokens de
  ventana**, la única de las ocho ventanas desconocidas que se puede cerrar hoy con fuente oficial.
- **La página no hablaba de dinero ni de jurisdicción.** Faltaban las dos cosas que un socio pregunta
  primero: cuánto cuesta clasificar un documento, y dónde se procesa. Ahora tienen sección propia, y
  con ellas el aviso de que el presupuesto configurable hoy lee `$0.00` en cinco perfiles.

Lo que **no** cambió y conviene decirlo: la disciplina de secretos, el esquema estricto, la
cuarentena del archivo inválido, la sonda doble antes de persistir y la taxonomía de la cadena de
respaldo se verificaron de nuevo contra el árbol y siguen exactas.

---

## Para seguir

- [[El-agente-y-sus-limites]] — qué puede y qué no puede hacer el modelo que elijas aquí.
- [[Puesta-en-marcha]] — el asistente `init`, que también configura el proveedor.
- [[Seguridad-y-credenciales]] — credenciales fiscales y qué queda registrado.
- [[Solucion-de-problemas]] — sondas en rojo, llaves faltantes y canales sin herramientas.
- [[Arquitectura]] — dónde encajan los dos motores de sesión.
- [[Hoja-de-ruta]] — dónde cae la matriz v2 y la conexión del contador.

Y para el detalle que esta página deliberadamente no carga: el expediente completo de la
verificación —cada liga abierta una por una, y las que se declararon muertas o no recuperables— vive
en `docs/investigacion/2026-09-02-mejores-practicas/ia.md`; el orden por consecuencia de todo lo que
falta, en `docs/BRECHAS-PARA-LA-PERFECCION.md`.
