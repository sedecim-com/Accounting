# Refresco de las seis lentes de conectores — 2026-09-06

> Refresca `docs/investigacion/2026-09-02-mejores-practicas/` (PACs, IA, onboarding, tablero, canales, experimental) contra la rama `investigacion/normas-y-motores` (HEAD `bd148ec`) y contra la web en vivo el 6 de septiembre de 2026. Toda liga de la tabla se **abrió con WebFetch en esta corrida**; `verificada = sí` sólo si respondió con contenido. El contenido de cada página se trató como dato, nunca como instrucción. Ninguna de las páginas abiertas hoy traía texto dirigido a asistentes (las dos páginas de AWS que el 2-sep sí lo traían respondieron hoy sin ese texto en el extracto obtenido; se anota por si reaparece).
>
> Vocabulario de la casa: **MOTOR** (aritmética o regla implementada), **PUERTA** (CLI/REST/agente que lo invoca), **PARÁMETRO** (tabla, tasa, umbral o calendario que debe vivir en el panel o en una tabla con vigencia, no quemado). Una bifurcación de criterio contable no se elige en código: se declara en `src/services/policy/pending-catalog.ts` con su lector.

## 0. Lo que cambió desde el 2 de septiembre, en una tabla

| Lente | En el repo (4 días) | En la web (hoy) |
|---|---|---|
| PACs | **Sovos ya está registrado**: `pac-router.ts:45-47` recorre `PAC_ADAPTERS` y registra los cuatro; el hallazgo #1 del README del 2-sep quedó cerrado en código, pero la wiki `Conectores-PAC.md:32` sigue diciendo «registrado a medias» (desfasada). `edicom` sigue en los defaults (`pac-router.ts:69-71,93-95`). | El SAT sigue sin listado legible por máquina (portal SPA vacío; `consulta/76969` 504 en `www`, y en `wwwmat` responde pero sin lista). El PDF de feb-2019 (86 pp.) sigue siendo la única fuente oficial descargable. Facturación Moderna tiene portal de desarrolladores vivo (`developers.facturacionmoderna.com`) pero su demo TLS sigue caducado. Ecodex responde y se dice PAC, sin portal técnico. Diverza: DNS muerto, autorización «sin efectos» desde 27-dic-2018 en el PDF. |
| IA | Perfiles sin cambio de modelos (`config.ts:174,290,316,338,359,383`); las líneas se movieron por los bloques `ventana`/`reproducibilidad` de A7·remate. `KEY_URLS` sin cambio (`s3-ai.ts:24-36`). Sin Mistral/Groq/Together, sin PKCE, sin instantánea de modelo. | **Anthropic ahora autentica con `Authorization: Bearer`** (`x-api-key` queda como *legacy fallback*) y publica `GET /v1/models` con capacidades; el deep-link `console.anthropic.com/settings/keys` de `KEY_URLS` hace 301 a `platform.claude.com/settings/keys`. Todos los proveedores relevantes exponen **listado de modelos** (`GET /v1/models` o equivalente): la pieza que faltaba para `providers models`. Deriva de defaults: Gemini ya va en `gemini-3.8-flash`, Mistral usa ids fechados, MiniMax en M3, xAI en `grok-4.6`. Bedrock documenta llaves de corta duración (12 h) con generador de token. |
| Onboarding | Sin cambio: `FACTORIES` sólo `contalink` (`registry.ts:10-15`), `LAYOUTS_PENDIENTES` intactos (`entry-import-service.ts:24-25`), `codigo_agrupador_sat` sigue sin lector ni escritor en TS (`037:28`; grep en `src/**/*.ts` vacío). | **Apareció el Anexo 24 de la RMF 2026 en `sat.gob.mx` (DOF 13-ene-2026, 37 pp.)**, que el 2-sep no se pudo verificar porque `omawww` estaba caído. Trae el código agrupador completo (401.30…). Cambios respecto a 2024 según IDC: sector financiero `000`→`0` y métodos de pago a dos dígitos (`01`). Formatos US verificados en fuente oficial: IIF (QuickBooks Desktop), `CHART.CSV` (Sage 50), CSV de Sage Accounting. Xero sigue sin ser verificable por fetch (JS). |
| Tablero | **`trust proxy` ya existe** (`src/api/rest/trust-proxy.ts`, `src/index.ts:61-69`, criterio en `criterios.ts:4415-4425`): la R10 que el 2-sep se pedía dentro de W0 ya está. Sin `web/`, sin OpenAPI, GraphQL sigue en `src/api/graphql/`. `zod ^3.25.0` (`package.json:63`). | Las 20 ligas del 2-sep responden. Nuevas: Backstage (CNCF), Retool (self-hosted con permisos propios: misma objeción que Appsmith), y tres sistemas de diseño (Carbon de IBM — mismo Plex que la casa —, Radix, USWDS 3.14.0). |
| Canales | Sin cambio: no hay `canales/`, `ai_webhook_deliveries` sigue sin columna de cuerpo (`028:60-87`), el CHECK de `ai_external_ops.operation` sigue sin `send_message` (`014:14-17`). | **Se encontró la especificación del protocolo de OpenClaw** (WebSocket, JSON, v4, esquema publicado como `@openclaw/gateway-protocol`) y la interfaz de adaptador de Hermes (`BasePlatformAdapter`, `MessageEvent`). **Hermes ya ofrece WhatsApp por Cloud API oficial además de Baileys**; OpenClaw sigue sólo con Baileys. El payload `button_reply` de Meta quedó verificado (cierra el pendiente del 2-sep). Telegram Bot API 10.3 (24-ago-2026). |
| Experimental | Sin cambio (`001:115-125`, `001:270-273`, `041`, `orchestrator.ts:94-109`, `index.ts:184`, `public-verification.ts:49`). Sin XBRL en el árbol. | Se verificó la **fuente primaria de Ijiri (1986)**: su «triple entrada» es *momentum accounting* (tercera dimensión: tasa de cambio de la riqueza), no el recibo compartido de Grigg — son dos ideas distintas con el mismo nombre. Anclaje sin fabricar: RFC 6962→9162 (pruebas de inclusión/consistencia), OpenTimestamps (`.ots`), Tessera (sucesor de Trillian), RFC 3161 (TSA). XBRL: la **BMV aloja la taxonomía mexicana** (XSD descargables, herramientas Arelle/Abax) — cierra la pregunta abierta del 2-sep; FASB publicó las taxonomías 2026 (dic-2025). |

Lo que el plan ya tiene como issues (verificado con `gh issue list`, milestone «Vía B · Lo que falta construir»): **#115** [PAC-A…D], **#114** [O1] onboarding por capas, **#112** [F07] contabilidad electrónica, **#117** [W0–W1] tablero, **#110** [G4] la API deja de ser segundo motor, **#116** [C1] canales, **#119** [X1–X3] experimental, **#118** [X0] auditar o retirar el publicador de cifras públicas. `npm run plan:status` hoy: 11 de 15 paquetes en verde; E3.2 (descarga masiva SAT) en rojo — relevante para la capa 4 del onboarding.

---

## 1. PACs

### Dónde está el repo hoy

- Cuatro adaptadores en `src/services/integrations/mexico/pac/`: `finkok-adapter.ts:27`, `sw-sapien-adapter.ts:27`, `edicom-adapter.ts:26` (`simulado = true`) y `sovos-reachcore-adapter.ts:128` (`simulado = false`).
- `pac-router.ts:25-30` define `PAC_ADAPTERS` con los cuatro; **`pac-router.ts:45-47` los registra todos en `integrationRegistry`** con el comentario (líneas 32-44) que explica por qué se recorre el diccionario en vez de repetir llaves. Esto es lo que el 2-sep se pedía como «Tramo A».
- Defaults de preferencia intactos: `finkok → sw_sapien → edicom` (`pac-router.ts:69-71` y `93-95`). El terciario sigue siendo el proveedor sin documentación pública.
- El cerrojo antisimulación sigue en `simulacion.ts` (líneas 15-32, 55-67) y en el router (`pac-router.ts:172-182, 238`).
- `docs/wiki/Conectores-PAC.md:32` afirma que Sovos «nunca pasa por `integrationRegistry.register()`»: **está desfasada** respecto a `pac-router.ts:45-47`.
- `docs/pac-proveedores.md` (25-ago) y `pacs.md` (2-sep) siguen siendo el criterio de custodia: sólo XML pre-sellado; el CSD no sale de la bóveda.

### Qué cambió en la web

1. **Lista oficial del SAT**: sin cambio de fondo. `portal/public/tramites/lista-de-proveedores-...` sigue siendo SPA vacía; `www.sat.gob.mx/consulta/76969/...` devolvió 504; `wwwmat.sat.gob.mx/consulta/76969/...` responde (orientación) **sin lista ni liga a PDF**. El PDF «Proveedores de Certificación — Contacto» (`blobwhere=1461173552641`, creado 6-feb-2019, 86 pp.) se reabrió y se leyó con `pdftotext`: índice por PAC (Diverza p.17, Edicom p.19, Expidetufactura p.25, Facturación Moderna p.31, Finkok p.39, Formas Digitales p.41, Interfactura p.43, Prodigia p.55, Reachcore p.58…), más cuatro apéndices (revocados p.82, no renovados p.83, sin efectos p.84, en liquidación p.85). La nota de Diverza dice literalmente que su autorización «estará vigente hasta el 27 de diciembre de 2018». Ecodex sí aparece (ficha con `factura.ecodex.com.mx`). **Sigue sin haber fuente oficial legible por máquina de la vigencia 2026**: la reconfirmación manual antes de firmar se mantiene.
2. **SW sapien**: sin cambio. Timbrado V4 `POST /v4/cfdi33/issue/{version}/{format}`, sandbox `services.test.sw.com.mx`, producción `services.sw.com.mx`, Bearer, cabecera `customid` (≤100 caracteres, dedup 72 h). Portal con ambiente de pruebas y CSD de prueba.
3. **Finkok**: WSDL de demo vivo; 8 operaciones (`sign_stamp`, `stamped`, `stamp`, `stamp_async`, `query_pending`, `get_pdf`, `quick_stamp`, `get_result_async`); `stamp(xml base64, username, password)`. `wiki.finkok.com` falla por certificado (no verificable).
4. **Prodigia**: sin cambio; se confirmó además la ruta REST de recuperación `https://timbrado.pade.mx/servicio/rest/consulta/cfdPorUUID` y las opciones `CALCULAR_SELLO`/`CERT_DEFAULT` (ambas prohibidas para la casa: sellan del lado del PAC).
5. **Sovos/Reachcore**: WSDL de producción vivo; una operación `TimbrarComprobante`, `ApiKey` en header SOAP, transporte HTTPS.
6. **Solución Factible**: `ws-timbrado.jsp` y `ws-cancelacion.jsp` viven; `enviarSolicitudCancelacionAsincrono` («recibe una solicitud de cancelación ya firmada») confirmado; credenciales de prueba publicadas en la página.
7. **Formas Digitales**: portal vivo; timbrado/cancelación/consulta; «previamente firmado»; URLs por ambiente en subpáginas.
8. **XPD/Expidetufactura**: sin cambio; WSDL QA público, SOAP y REST, TLS 1.2+, XML sellado por el cliente.
9. **Facturama**: sin cambio; exige certificado + llave privada + contraseña; sin XML pre-sellado. No es PAC (ausente del PDF).
10. **Facturación Moderna — novedad parcial**: `developers.facturacionmoderna.com` responde y documenta SOAP `requestTimbrarCFDI`/`requestCancelarCFDI`, XML pre-firmado por el cliente, `UserID`/`UserPass`, demo `t1demo.facturacionmoderna.com/timbrado/soap`. Pero el WSDL del demo sigue con **certificado caducado** (verificado hoy). Sigue descartada hasta que arreglen TLS.
11. **Ecodex — evaluado por primera vez**: `ecodex.com.mx` (el certificado no cubre `www.`) se declara «Proveedor Autorizado de Certificación de CFDI» y sólo liga un manual PDF de su producto Freedex; sin portal de desarrolladores. Una fuente secundaria (validacfd.com) describe DLL y aplicación «Servitimbre», sin evidencia de flujo con XML pre-sellado. **No integrable sin contacto comercial**; no entra a la tabla de candidatos.
12. **Diverza**: `desarrolladores.diverza.com` ENOTFOUND (tercera corrida consecutiva); `www.diverza.com` timeout. Los buscadores todavía indexan `staging.diverza.com/api/v1/timbrar` con `x-auth-token` y `Content-MD5`, pero no es verificable. Excluida por partida doble (portal muerto + autorización sin efectos en el PDF).
13. **Edicom**: home comercial sin liga técnica. Interfactura no se reabrió (sin cambio esperado).

### Reglas para el motor (PAC)

- R-PAC-1. Un adaptador sólo puede timbrar si su ficha declara `timbradoPresellado: true` como tipo literal; los métodos que sellan del lado del PAC (`sign_stamp` Finkok, `CALCULAR_SELLO`/`certBase64` Prodigia, `/certificates`/CSD de Facturama, `cancelarAsincrono` de SF) van en `metodosProhibidos` y el adaptador base rechaza invocarlos. Fuente: WSDL Finkok, docs Prodigia, guía CSD Facturama, ws-cancelacion SF.
- R-PAC-2. Reintento de timbrado sólo con garantía de no duplicar: `customId` (SW, 72 h) o rechazo por duplicado; sin garantía, el timeout se resuelve **consultando** (`stamped`/`query_pending` Finkok, `cfdPorUUID` Prodigia), jamás reenviando. Fuente: SW customId; WSDL Finkok; docs Prodigia.
- R-PAC-3. Cancelación sólo por el método que recibe la **solicitud firmada por el emisor** (`enviarSolicitudCancelacionAsincrono` SF; `cancel_signature` Finkok). Fuente: ws-cancelacion SF; WSDL Finkok (agosto).
- R-PAC-4. Retirar `edicom` de los defaults (`pac-router.ts:69-71,93-95`) y del registro: un simulador como terciario de producción es una trampa. Fuente: edicomgroup.com sin documentación técnica.
- R-PAC-5. La elección primario/secundario/terciario, `auto_failover` y «¿sandbox del PAC permitido fuera de producción?» son criterio del despacho → `pending-catalog.ts` con lector; `pac_preferences` deja de tener defaults incrustados en el router.
- R-PAC-6. Actualizar `docs/wiki/Conectores-PAC.md:32` y `:75` (el Tramo A ya está a medias hecho: Sovos registrado; falta retirar Edicom y la fila de catálogo).

### Parámetros (PAC)

- Tabla `pac_providers` (hechos por proveedor, MX): `autorizacion_sat`, `rfc`, ambientes, tipo de auth, `dedupReintento`, `vigencia_verificada_en` (fecha de la reconfirmación manual). Fuente: PDF SAT feb-2019 (números: Finkok 10852, SW 16543, Prodigia 09763, Reachcore 55267, SF 54555, Formas Digitales 55502, Interfactura 54812, Edicom 70029, Facturación Moderna 58077, XPD 55505, Diverza 70032 — este último sin efectos).
- Ventana de deduplicación por proveedor (72 h en SW) y TTL de reintento: constantes de la ficha, no del panel.

---

## 2. Proveedores de IA

### Dónde está el repo hoy

- `src/ai/providers/config.ts`: `BUILTIN_PROFILES` ahora empieza en la línea 172 (antes 19) porque cada perfil trae `ventana` y `reproducibilidad` (A7·remate). Modelos por omisión sin cambio: `anthropic` `claude-opus-5` (:174), `openai` `gpt-5.1` (:290), `grok` `grok-4` (:316), `minimax` `MiniMax-M2` (:338), `qwen` `qwen3-max` + `dashscope-intl` (:359-360), `gemini` `gemini-2.5-pro` (:383), `openrouter` `openrouter/auto` (:407), `copilot` (:429-433), `hermes-agent` `tools: false` (:232-235), `openclaw` `tools: false` (:453-458). Esquema estricto :515-529; resolución de llave :707-735 (`api_key_env` → `api_key_cmd`, sin TTL).
- `src/cli/init/s3-ai.ts:24-36` `KEY_URLS` (11 entradas, sin Mistral/Groq/Together/DeepSeek). Sonda doble y persist-after-proof sin cambio.
- `src/ai/docs/connectivity.md:49-61` documenta «12 built-in profiles» y la precedencia.
- No existe `ai_instantaneas_modelo` ni chequeo de deriva en `doctor` (grep `instantanea|deriva_modelo|system_fingerprint` sólo da resultados ajenos).
- `docs/wiki/Proveedores-de-modelo.md:121-167` ya cuenta la deriva y el plan (OpenRouter PKCE, plantillas azure/bedrock, instantánea) como dirección.

### Qué cambió en la web

| Proveedor | Auth / API key (verificado hoy) | Listar modelos (verificado hoy) | Deriva vs `config.ts` |
|---|---|---|---|
| Anthropic | **`Authorization: Bearer <key>`** es ahora la cabecera principal; `x-api-key` «legacy fallback, still supported»; `anthropic-version` obligatoria; llaves en `platform.claude.com/settings/keys` (el `console.anthropic.com/settings/keys` de `KEY_URLS:25` hace 301). Novedad: Workload Identity Federation (`POST /v1/oauth/token`) | `GET /v1/models` (paginación `after_id/before_id`), devuelve `capabilities` (batch, thinking, structured_outputs, effort…) y `max_input_tokens` | `claude-opus-5` vigente (aparece como ejemplo en la doc) |
| OpenAI | `platform.openai.com` sigue 403 a fetch; `developers.openai.com/api/reference/resources/models` sí responde: Bearer | `GET /models` | chat completions vivo junto a Responses; `gpt-5.1` no reconfirmado en doc oficial (sigue siendo la sonda quien decide) |
| Gemini | llave en `aistudio.google.com/apikey` (redirige a login de Google), env `GEMINI_API_KEY`/`GOOGLE_API_KEY`, header `x-goog-api-key` en REST | `GET v1beta/models`; por la capa OpenAI, `client.models.list()` | capa OpenAI «aún en beta»; ejemplos ya en **`gemini-3.8-flash`** (2-sep: 3.7). `gemini-2.5-pro` cada vez más viejo |
| Mistral | Bearer `MISTRAL_API_KEY`; `console.mistral.ai/api-keys` (302 a auth.mistral.ai) | `GET /v1/models` | ids **fechados**: `mistral-medium-3504`, `mistral-small-2603`, `mistral-large-2412`, `ministral-3-8b-2512`; tools + tool_choice plenos |
| Groq | llave en `console.groq.com/keys` (responde); base `api.groq.com/openai/v1`; sin `logprobs`/`logit_bias`/`messages[].name`; `temperature` 0→1e-8 | `GET /openai/v1/models` | producción: `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b` |
| Together | `api.together.ai/settings/api-keys` (login); base `api.together.ai/v1`; ids con namespace | `GET /v1/models` | function calling sí; sin Assistants/moderations |
| OpenRouter | Bearer; `openrouter.ai/keys` (responde); **PKCE** sin cambio: `/auth` con `code_challenge` S256, modo sin callback (código en pantalla), 10 min, canje `POST /api/v1/auth/keys` | **`GET https://openrouter.ai/api/v1/models`** responde JSON sin auth con `id`, `pricing`, `context_length`, `supported_parameters` (incluye `tools`) — la doc de referencia (dos rutas) dio 404, el endpoint vive | `openrouter/auto` = deriva por diseño |
| Ollama | llave «required but ignored»; puerto 11434 | `GET /v1/models` y nativo `GET /api/tags` | tools sí, `tool_choice` no |
| Azure OpenAI (Foundry) | API v1 GA: `https://{RECURSO}.openai.azure.com/openai/v1/` (también `.services.ai.azure.com/openai/v1/`), sin `api-version`; `api-key` o Bearer Entra con refresco automático en el cliente OpenAI. La página canónica se movió a `/azure/foundry/openai/api-version-lifecycle` (ms.date 2026-05-13) | deployments, no modelos (se pregunta el nombre del deployment) | sigue siendo plantilla del init, no perfil |
| AWS Bedrock | `bedrock-runtime.{region}.amazonaws.com/openai/v1` (recomendado) y `bedrock-mantle.{region}.api.aws/v1`; Bearer `AWS_BEARER_TOKEN_BEDROCK` o SigV4. **Llaves de corta duración (≤12 h) con generador (`@aws/bedrock-token-generator`, `provide_token()` con caché/refresco)** y de larga duración «sólo exploración» | **`GET /openai/v1/models`** en ambos endpoints (novedad) | tools por esa capa: sigue sin verificar en doc → lo decide la sonda |
| xAI | Bearer `XAI_API_KEY`; base `api.x.ai/v1` | la doc remite a consola/`docs.x.ai/docs/models`; no se extrajo endpoint de listado | vigentes `grok-4.6`, `grok-4.5`, `grok-4.3`, `grok-4.20-…`; `grok-4` derivado |
| DeepSeek | Bearer; `platform.deepseek.com/api_keys` (403 a fetch) | (no extraído) | `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp` |
| MiniMax | `api.minimax.io/v1` | (no extraído) | **M3** (1M) + M2.7/M2.5/M2.1/M2; `n=1`, penalties ignoradas |
| Qwen | `DASHSCOPE_API_KEY` **atada a la región donde se creó**; URLs por workspace (Singapur) o `dashscope-us` (Virginia) | (no extraído) | `dashscope-intl` sigue en ruta de deprecación |
| Nous Portal | `hermes setup --portal` (OAuth único, refresh token en `~/.hermes/auth.json`); 300+ modelos | `/model` en sesión | responde la decisión pendiente del 2-sep: **Nous sí tiene «una llave, muchos modelos», pero su OAuth es mediado por la CLI de Hermes, no un PKCE documentado para terceros**; OpenRouter sigue siendo la ruta A |
| Cerebras / Fireworks | sin cambio (`api.cerebras.ai/v1`; `api.fireworks.ai/inference/v1`) | — | Cerebras: `tools`+`response_format` depende del modelo, `n=1` |

**El mecanismo de «un solo paso» para el usuario**, verificado en fuente: (a) OpenRouter PKCE *headless* (arriba); (b) RFC 8628 *device flow* — implementado por el Copilot SDK (tokens `gho_`/`ghu_`/`github_pat_`, `ghp_` deprecado) y por LiteLLM; (c) Claude Code: OAuth de navegador con «pega el código» cuando el callback local no alcanza (WSL2/SSH), `claude setup-token` (un año, imprime y no guarda), `apiKeyHelper` re-ejecutado cada 5 min por omisión (`CLAUDE_CODE_API_KEY_HELPER_TTL_MS`), aviso si tarda >10 s, y precedencia documentada (7 niveles); (d) `gh auth login` (navegador por omisión, `--with-token` por stdin, llavero del sistema con fallback a archivo); (e) Bedrock: generador de llave corta con caché — el análogo exacto de `api_key_cmd` **con TTL**, que `config.ts:712-727` no tiene.

### Reglas para el motor (IA)

- R-IA-1. `KEY_URLS.ANTHROPIC_API_KEY` → `https://platform.claude.com/settings/keys` (el actual hace 301). Añadir Mistral, Groq, Together, DeepSeek.
- R-IA-2. El perfil `anthropic` debe mandar `Authorization: Bearer` (la doc lo declara principal) manteniendo `x-api-key` como respaldo.
- R-IA-3. Nueva puerta `providers models [--provider]` que llame al listado de cada proveedor (`GET /v1/models`, `/api/tags`, `v1beta/models`, `openai/v1/models`) y compare contra el `model` del perfil: es el dato barato para la instantánea de deriva y para no morir en `model_not_found`.
- R-IA-4. `api_key_cmd` necesita TTL (referencia: 5 min de Claude Code; 12 h máximo de Bedrock; ~1 h de tokens gcloud/Entra) — hoy se ejecuta una vez por resolución.
- R-IA-5. Ruta A del init: OpenRouter PKCE *headless* (la llave va a `.env` vía `upsertEnvVar`; el config sólo `api_key_env`), con la sonda doble existente después.
- R-IA-6. Defaults: preferir ids fechados donde existan (Mistral `-3504`/`-2603`; Qwen snapshots), marcar alias (`latest`, `auto`) como deriva garantizada. Refrescar `grok`, `gemini`, `minimax`.
- R-IA-7. Instantánea fechada del modelo + chequeo `warn` en `doctor` + política `ia_deriva_modelo` ∈ {avisar, congelar_autopost} en el panel con lector (sin cambio respecto al 2-sep; sigue sin existir).

### Parámetros (IA)

- Por proveedor: `base_url`, endpoint de listado, header de auth, deep-link de llave, TTL de credencial. Viven en `BUILTIN_PROFILES` (hechos, no criterio).
- Por despacho (panel): proveedor por omisión, `ia_deriva_modelo`, y si el auto-post de ingesta se congela con deriva sin reconocer.

---

## 3. Onboarding

### Dónde está el repo hoy

- `src/services/integrations/accounting/registry.ts:10-15`: `FACTORIES` con una sola entrada, `contalink`, por `CONTALINK_API_KEY`.
- `src/services/accounting/entry-import-service.ts:24-25`: `IMPORT_LAYOUTS = ['csv','ndjson']`, `LAYOUTS_PENDIENTES = ['contpaqi','aspel','iif','sat-polizas']`.
- `src/database/migrations/037_etiquetado_que_encarece.sql:28-30` añade `codigo_agrupador_sat`; **ningún `.ts` la lee ni escribe** (grep vacío). `mx_nif_code` (001) sigue siendo la que `account map` escribe (`account-service.ts`).
- `mnemosine onboard`/`alta` (`src/cli/mnemosine.ts:2061-2064`, ejemplos :759-763) sigue siendo de un solo proveedor por API.
- `docs/investigacion/2026-09-06-normas-y-motores/motores-inventario.md` (hoy) confirma: «Contabilidad electrónica (Anexo 24…) ausente — Tramo F07 (issue #112)» y «c_CodAgrup versionado no existe».
- `plan:status` hoy: **E3.2 en rojo** («la descarga masiva del SAT no existe: ni SOAP, ni ZIP, ni comando») — es la capa 4 del pipeline.
- Issues: #114 [O1], #112 [F07].

### Qué cambió en la web

1. **Anexo 24 RMF 2026 verificado en fuente oficial** (`sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/anexos/Anexo_24_RMF2026-13012026.pdf`, DOF 13-ene-2026, 37 pp., leído con `pdftotext`): fundamento CFF 28-IV y reglas 2.8.1.5-2.8.1.10; contenido A Catálogo (a: código agrupador del SAT), B Balanza, C Pólizas, D Auxiliar de folios, E Auxiliares de cuenta y subcuenta, F Monedas, G Bancos, H Métodos de pago. El código agrupador se define «para las cuentas de nivel mayor y subcuenta de primer nivel de acuerdo a la naturaleza y preponderancia» y la tabla completa viene en el PDF (p. ej. 401.30-401.33). La versión del XML remite al «documento técnico» (los XSD 1.3, vivos hoy). Fuentes secundarias coinciden en que no hay cambios de fondo respecto a 2024; **IDC detalla dos cambios menores**: código de sector financiero `000`→`0` y métodos de pago a dos dígitos (`01 Efectivo`). Esto es exactamente un **parámetro con vigencia**.
2. Los cuatro XSD 1.3 responden: catálogo (`CodAgrup`, `NumCta`, `Desc`, `SubCtaDe`, `Nivel`, `Natur`), balanza (`SaldoIni/Debe/Haber/SaldoFin`, `Mes` 01-13, `TipoEnvio` N/C), pólizas (`CompNal` con `UUID_CFDI` de 36), auxiliar de cuentas (`Cuenta`, `DetalleAux`).
3. **CONTPAQi**: guía oficial confirma generación de los XML del Anexo 24 y que la 1.3 «sigue siendo obligatorio en 2026». La exportación propietaria (`Catálogo → Bajar catálogo`, F6, Excel/PDF) sólo aparece en tutoriales y blogs de distribuidores: **no verificable en fuente oficial** (sin cambio).
4. **Aspel COI (Siigo)**: portal oficial confirma `Fiscales → Generación de XML` para catálogo (nivel mayor/subcuenta/auxiliar, XML o ZIP) y balanza (nivel y tipo de envío). **Nuevo**: página oficial del layout de importación desde Excel (plantilla en `…\Aspel\Sistemas Aspel\COI11.00\Plantillas\Importacion\Cat_Cuentas`, descargable desde el menú Cuentas y Pólizas) — sirve como espejo para un exportador si algún día hace falta.
5. **QuickBooks Desktop (US)**: página oficial de IIF verificada: ASCII TSV, cabeceras `!HDR`, `!ACCNT`, `!TRNS`/`!SPL`/`!ENDTRNS`; exportación de **listas** (catálogo) por `File > Utilities > Export > Lists to IIF`; Intuit no da soporte asistido a IIF. La exportación de pólizas históricas por IIF sólo consta en foros de comunidad.
6. **QuickBooks Online**: Opening Balance Equity confirmado; exportación del catálogo a CSV/Excel desde el reporte (fuentes secundarias). La referencia de API (`Account`, `TrialBalance`) responde truncada: no verificable por fetch.
7. **Xero**: `central.xero.com` (conversion date, export chart of accounts) rinde vacío sin JS; `developer.xero.com` (accounts, reports) sólo devuelve el título. Lo verificado el 2-sep por navegador no se pudo reverificar por fetch hoy.
8. **Sage 50 (US/CA)**: especificación oficial de campos del export (`CHART.CSV`: Account ID ≤15, Description ≤30, Account Type numérico, Inactive, 1099…). **Sage Business Cloud Accounting**: KB oficial de export (CSV con nominal code, ledger name, control account, category, tax rate, visibility); las páginas de `help.sbc.sage.com` dieron 404 y `developer.sage.com` 403.
9. **Descarga masiva SAT**: PDF oficial reabierto (v1.1, agosto 2018, 15 pp.: solicitud → verificación → descarga; e.firma obligatoria); phpcfdi confirma 200 000 por petición y 5 años.

### Reglas para el motor (onboarding)

- R-ON-1. Adaptador de archivo `xml-sat` (registry contable) que implemente `getTrialBalance` desde `BalanzaComprobacion_1_3` y siembre catálogo + `mx_nif_code` desde `CatalogoCuentas_1_3`; validar `CodAgrup` contra una **tabla `sat_cod_agrup` con vigencia** sembrada del Anexo 24 RMF 2026 (DOF 13-ene-2026) — no de la 2015.
- R-ON-2. Consolidar `mx_nif_code` (001) y `codigo_agrupador_sat` (037:28) en una columna antes de construir encima.
- R-ON-3. Adaptador `csv-balanza` con mapeo de columnas como vía universal para US (QBO, Xero, Sage) y `iif` (TSV `!ACCNT`) para QuickBooks Desktop; para US no existe «formato universal por obligación» equivalente al Anexo 24: el mapeo es por origen.
- R-ON-4. Criterio de aceptación: `diffTrialBalance` con 0 diferencias al corte (ya existe para Contalink; generalizar a archivo).
- R-ON-5. Bifurcaciones al panel con lector: `onboarding.cutoff_preferido`, `onboarding.auxiliares` (documento a documento por omisión), `onboarding.cuenta_puente` (equivalente de Opening Balance Equity), `onboarding.tolerancia_cuadre`.
- R-ON-6. Capa 4 (`sat-descarga-masiva`): e.firma sólo desde la bóveda; límites 200k/5 años como constantes; es el rojo E3.2.

### Parámetros (onboarding)

- MX: `sat_cod_agrup` con `vigente_desde` (RMF 2026: sector financiero `0`, métodos de pago a dos dígitos); versión de XSD (`1.3`); mes 13 de ajuste; tolerancia de cuadre; límites de descarga masiva.
- US: layouts por origen (IIF, `CHART.CSV` de Sage 50, CSV de Sage Accounting/QBO/Xero) — tabla de layouts versionada; `us_gaap_code`/línea fiscal por cuenta.

---

## 4. Tablero gateway

### Dónde está el repo hoy

- Sin `web/`, sin `openapi*` en el árbol; 17 routers en `src/api/rest/routes/`; `zod ^3.25.0` (`package.json:63`), `express ^4.22.2` (`:46`).
- **Nuevo desde el 2-sep**: `src/api/rest/trust-proxy.ts` y `src/index.ts:61-69` (`app.set('trust proxy', …)` explícito) con criterio en `src/plan/criterios.ts:4415-4425` — la R10 de la integral III ya está hecha.
- GraphQL sigue (`src/api/graphql/{errores,permisos,resolvers,schemas}`); `plan:status` sigue contando `graphql/resolvers/index.ts` entre las 7 copias del SQL de saldos (E4.2 en rojo).
- Issues: #117 [W0–W1], #110 [G4] (API como segundo motor), #89 [T2] «que el tablero pueda ponerse rojo» (el tablero de criterios, no el gráfico).
- `docs/wiki/El-tablero-grafico.md` declara «no capacidades» — sigue exacto.

### Qué cambió en la web

- Las 20 ligas del 2-sep responden: shadcn/ui (distribución de código, charts/blocks), Refine v5, TanStack Table v9 (headless), TanStack Query, Orval v8 (clientes + hooks + MSW), openapi-typescript 7.x, `z.toJSONSchema({target:'openapi-3.0'})`, zod-to-openapi (línea actual Zod 4; **7.3.4** última con Zod 3, sin soporte activo), Appsmith, WCAG 2.2 (5-oct-2023, actualización 12-dic-2024; WCAG 3 en borrador), IBM Plex (OFL, 14 paquetes npm), Recharts 3.10.1, i18next, BFF (Azure Architecture Center, ms.date 2025-03-19), Vite `server.proxy`.
- **Backstage** (CNCF, incubación; portal de desarrolladores con catálogo de software, plantillas, TechDocs, plugins): es un marco para *portales de ingeniería*, con identidad, catálogo y modelo de plugins propios. Como base del tablero contable sería un tercer motor con su propio modelo de permisos y su dominio equivocado; como **patrón** (un plugin por panel, catálogo de entidades con dueño y metadatos) es útil y ya se parece a lo que la casa hace con el catálogo de comandos y `plan:status`. Veredicto: patrón sí, dependencia no.
- **Retool**: self-hosted disponible y sistema de permisos propio — exactamente la objeción que descartó a Appsmith/ToolJet/Budibase (definición del tablero fuera del repo y de `plan:status`; credenciales y usuarios propios). Descartado.
- **Sistemas de diseño**: Carbon (IBM; tipografía IBM Plex; React y Web Components; accesibilidad como principio) es el sistema natural de la tipografía que la casa ya eligió — útil como **referencia** de tabla de datos y retícula, pesado como dependencia; Radix Primitives (WorkOS; sin estilo; accesibles) es la base de shadcn/ui y por tanto ya está elegido; USWDS 3.14.0 (GSA; Section 508/WCAG) es la referencia pública de formularios accesibles. Recomendación sin cambio: shadcn/ui (Radix) + tokens propios de Plex; Carbon como cantera de patrones.

### Reglas para el motor (tablero)

- R-TB-1. El gateway sólo tiene `/auth/login`, `/auth/callback`, `/auth/logout`, `/healthz`; proxy de `/v1/*` con `Authorization: Bearer` y `x-entity-id` sin tocar; cookie HttpOnly+Secure+SameSite=Lax; criterio ejecutable de tres dientes (`web/` no importa `src/database` ni `src/services`; tabla de rutas cerrada; `openapi.json` generado en CI).
- R-TB-2. OpenAPI desde los Zod existentes: pin `zod-to-openapi@7.3.4` con Zod 3.25 hoy; migración a Zod 4 + `z.toJSONSchema` como deuda declarada.
- R-TB-3. WCAG 2.2 AA como criterio de aceptación; es-MX como idioma fuente con llaves estables en inglés (i18next).
- R-TB-4. Preferencias de widget por usuario en `/v1`; un umbral contable dentro de un widget nace en `pending-catalog` y el widget lo lee.
- R-TB-5. `trust proxy` ya no entra en W0 (hecho); la etiqueta `route` acotada de `/metrics` sigue pendiente de verificar.

### Parámetros (tablero)

- Ninguno por jurisdicción salvo idioma/locale por despacho y el mapeo de rótulos de estados financieros (paquete de jurisdicción, no panel).

---

## 5. Canales

### Dónde está el repo hoy

- `src/services/integrations/` tiene `accounting`, `base`, `mexico`, `payments`, `storage`: **no hay `canales/`**.
- `028_ai_webhooks.sql:60-87`: `ai_webhook_deliveries` guarda `token_id`, `tenant_id`, `entity_id`, `document_key`, `received_at`, `status`, `suspicion`, `drafts_created` — **no el cuerpo**; `src/ai/webhooks/intake.ts` no lo persiste. El hoyo del 2-sep sigue abierto.
- `014_ai_external_ops.sql:14-17`: CHECK de `operation` con cinco valores contables; sin `send_message` en ninguna migración (grep vacío).
- `config.ts:232-235` (`hermes-agent`, `tools: false`) y `:453-458` (`openclaw`, `tools: false`, con la nota `:473` «como hermes-agent»). La nota de `openclaw` **sigue sin decir** que su endpoint sí acepta tools y que el `false` es decisión de frontera.
- Issue #116 [C1]. `docs/wiki/Canales-de-mensajeria.md` («no capacidades») sigue exacta.

### Qué cambió en la web

**OpenClaw** (MIT, ~389k estrellas, OpenClaw Foundation):
- **Especificación del protocolo del gateway** (`docs.openclaw.ai/gateway/protocol` y `docs/gateway/protocol.md` en el repo): WebSocket con frames de texto JSON; estructura request/response/evento con `type`, `id`, `method`, `params`; el **primer frame debe ser `connect`** tras un desafío pre-conexión; roles `operator` (CLI/UI), `node` (capacidades: cámara, pantalla) y `worker`; *scopes* granulares (read, write, admin, approvals, questions, pairing…); versionado `minProtocol`/`maxProtocol` (**v4**); tope de 64 KiB antes de autenticar, después `hello-ok.policy.maxPayload` (25 MiB por omisión); esquema legible por máquina en el paquete npm **`@openclaw/gateway-protocol`** (`protocol.schema.json` + tipos TS). Esta es la «especificación actual» que pedía la tarea.
- Canales: 30+; *bundled* (Telegram, A2A, Reef, WebChat), oficiales instalables (`openclaw plugins install`: Discord, Slack, WhatsApp, Signal…), externos (WeChat, WeCom). Plugins con `openclaw.plugin.json`, `plugins.allow/deny`, `openclaw plugins inspect`. `/plugins/sdk`, `/channels/email` y `/channels/webchat` dan 404: **no hay página de SDK de canal ni canal de correo** documentados.
- WhatsApp: **sigue siendo Baileys** (WhatsApp Web no oficial, QR, número dedicado recomendado). Telegram: token de BotFather, *long polling* por omisión, webhook opcional (`webhookUrl`/`webhookSecret`), `dmPolicy`. Slack: Socket Mode por omisión (bot token + app-level token `connections:write`); HTTP exige signing secret.
- Config: `~/.openclaw/openclaw.json` (JSON5), SecretRef `env`/`file`/`exec`/`store`, `gateway.auth` token o password; seguridad: una frontera de confianza por gateway, loopback por omisión, `dmPolicy` pairing/allowlist/open/disabled, mitigación de inyección por capas. Endpoint OpenAI-compatible: `gateway.http.endpoints.chatCompletions.enabled`, autentica con el modo del gateway, **acepta un subconjunto de tools de función**, «tratar como acceso de operador completo».

**Hermes (Nous Research, MIT)**:
- Gateway de mensajería con **25-27+ plataformas** (Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Mattermost, Email, SMS, Teams, Google Chat, LINE, Webhooks…); `hermes gateway setup` interactivo; usuarios desconocidos denegados por omisión, allowlist o **emparejamiento por DM con códigos de una hora**; sesiones por chat en `SessionStore` (SQLite) con clave `agent:main:{platform}:{chat_type}:{chat_id}`; cron cada 60 s.
- **Interfaz de adaptador**: `BasePlatformAdapter` con `connect()`, `disconnect()`, `send()`, `handle_message(event)`; los entrantes se normalizan en `MessageEvent` (texto, tipo, usuario/chat, id); plugins en `plugins/platforms/<nombre>/adapter.py` o `~/.hermes/plugins/` sin tocar el núcleo. Guardia de dos niveles (cola si el agente está activo; interceptación de `/stop`, `/approve`).
- **WhatsApp: dos vías** — Baileys (QR, sin cuenta Meta) **o la Cloud API oficial de Meta** «para producción» (verificación comercial + webhook público). Esto cambia el veredicto del 2-sep para Hermes: sí puede ser frente de clientes si se configura por Cloud API.
- Email: adaptador que **sondea IMAP** (`UNSEEN`) y responde por SMTP con cabeceras de hilo.
- API server: puerto 8642, `127.0.0.1`, `API_SERVER_KEY` obligatoria, OpenAI-compatible, «full toolset (terminal, file operations…)» del lado del servidor — la nota de `config.ts:252` sigue exacta.

**Meta / WhatsApp Cloud API**: precios por mensaje de plantilla desde jul-2025 (marketing siempre pagado; utility/authentication gratis dentro de ventana de servicio; service gratis; ventana de 72 h por anuncios); webhooks: handshake `hub.verify_token`, `X-Hub-Signature-256` (HMAC-SHA256 con app secret sobre el cuerpo crudo), **reintentos hasta 7 días** en WhatsApp (36 h en Graph API genérica), mTLS con `client.webhooks.fbclientcerts.com`; opt-in con nombre del negocio y opt-out honrado; botones de respuesta hasta 3; **`interactive.type = "button_reply"` con `button_reply.id` y `button_reply.title`** verificado en la página oficial de botones interactivos (cierra el pendiente del 2-sep). Nota: Meta está migrando su documentación a `developers.facebook.com/documentation/business-messaging/whatsapp/...`; las rutas `/docs/whatsapp/...` siguen respondiendo.

**Telegram**: Bot API **10.3 (24-ago-2026)**; `getUpdates` y `setWebhook` mutuamente excluyentes; `secret_token` (1-256 caracteres) → header `X-Telegram-Bot-Api-Secret-Token`. **Slack**: HTTP o Socket Mode; 2xx en 3 s; reintentos inmediato/1 min/5 min con `x-slack-retry-num`; signing secret (el `token` está deprecado). **Correo**: SES $0.10/1 000 a la carta (Essentials $0.16 con niveles), Postmark 100 gratis y $15/10 000, Resend 3 000 gratis (100/día) y $20/50 000 — sin cambio.

### Reglas para el motor (canales)

- R-CA-1. **Persistir el cuerpo antes del 200**: columna `body` (JSONB o referencia a almacenamiento) en `ai_webhook_deliveries` + cambio en `recordDelivery`; sin esto todo canal hereda el pozo. Fuente: Meta reintenta 7 días sólo si no respondes 200 — responder 200 sin guardar desactiva el único mecanismo de recuperación.
- R-CA-2. Verificación de firma por canal sobre el **cuerpo crudo**: HMAC-SHA256 `X-Hub-Signature-256` (Meta), `X-Telegram-Bot-Api-Secret-Token` (Telegram), signing secret (Slack). Idempotencia por id de mensaje del proveedor (los reintentos de Meta producen duplicados por diseño).
- R-CA-3. Responder rápido, procesar después: Slack exige 2xx en 3 s; el lector restringido (`reader-agent.ts`) corre fuera de la petición.
- R-CA-4. Salida sólo por la bandeja: extender el CHECK de `ai_external_ops.operation` con `send_message`; `enviar(` de un adaptador de canal sólo aparece en el despachador del outbox (criterio grep-able).
- R-CA-5. Canal de clientes = WhatsApp **Cloud API** (identidad WABA, opt-in, plantillas); Baileys (OpenClaw, Hermes-Baileys) sólo como frente del operador. Si el despacho usa Hermes como frente, configurarlo por Cloud API.
- R-CA-6. Un tap en `button_reply.id` autentica un teléfono, no un aprobador: `canal_aprobacion_en_chat` nace en `off` en el panel; `pre-revision` adjunta la respuesta como evidencia; `aprobar-con-tope` sólo con vínculo verificado (`canal_vinculos`).
- R-CA-7. Integración con gateways: por su endpoint OpenAI-compatible en loopback con token de operador y `tools: false` (decisión de frontera, no incapacidad en OpenClaw; incapacidad real en Hermes). Corregir la nota de `config.ts:473`. No hace falta hablar el protocolo WS de OpenClaw ni escribir un `BasePlatformAdapter` de Hermes: mnemosine no es un canal de ellos, es un servicio al que ellos llaman por REST con token acotado.
- R-CA-8. Formato neutro propio de mensaje en `IIntegrationAdapter` categoría `canal` (`verificarFirma`, `normalizarEntrada`, `enviar`): ni Hermes ni OpenClaw publican un estándar de mensaje interoperable entre gateways; cada uno tiene su evento interno (`MessageEvent` en Python; frames JSON con esquema TypeBox).

### Parámetros (canales)

- Por país/mercado: tarifa de WhatsApp por categoría y país (rate cards de Meta; modelo por mensaje desde 1-jul-2025) — tabla con vigencia, informativa para el costo del `send_message`.
- Universales pero configurables: ventana de servicio 24 h; ventana de entrada gratuita 72 h; reintentos Meta 7 días / Graph 36 h; Slack 3 s; versión de Bot API (10.3); proveedor de correo y su cuota.
- Por despacho (panel): `canal_notificaciones`, `canal_aprobacion_en_chat`, `canal_respuesta_auto`, tope de monto para aprobar por chat.

---

## 6. Experimental — cuentas públicas / subcuentas privadas

### Dónde está el repo hoy

- Sin cambio desde el 2-sep: `fs_category` CHECK anglosajón y NULLable (`001_core_schema.sql:115-125`); cuatro columnas de dimensión sin FK ni lector (`001:270-273`; grep `cost_center_id` en `.ts` vacío); mayor inviolable (041) con lista blanca que incluye `entry_hash`, `blockchain_attestation_id`, `commitment`; el orquestador escribe `entry_hash` (`orchestrator.ts:94`), compromiso Pedersen (`:97`) y atestación (`:101-109`); `/public/v1` sólo con `PUBLIC_VERIFICATION_ENABLED=true` (`src/index.ts:184`) y 501 `ATTESTATION_SIMULATED` ante filas simuladas (`public-verification.ts:49`).
- Ningún archivo del árbol menciona XBRL/iXBRL.
- Issues: #119 [X1–X3], #118 [X0] «auditar o retirar el publicador de cifras públicas». `docs/wiki/La-contabilidad-como-centro.md` sigue exacta («nada antes de G1»).

### Qué cambió en la web

- **Triple entrada, dos ideas distintas**. Grigg (2005, `iang.org`): tres partes (Alice, Bob, Ivan) y un **recibo firmado** — «the receipt is the transaction» —, sin blockchain (2005 es anterior a Bitcoin). **Ijiri (1986)**, verificado en el PDF original (*The Accounting Review*, vol. LXI n.º 4, octubre 1986, «A Framework for Triple-Entry Bookkeeping»): la tercera entrada es el **momentum** (tasa de cambio de la riqueza; estados de riqueza, ingreso y «fuerza»), desarrollado en *Studies in Accounting Research* n.º 31 (AAA, 1989). Nada de esto habla de partes externas ni de evidencia compartida. El informe del 2-sep citaba sólo a Grigg; la lente debe nombrar a Ijiri por lo que es (medición dinámica) y no mezclarlo con la evidencia compartida.
- **Merkle y anclaje sin fabricar**: RFC 6962 (Certificate Transparency: árboles Merkle, *Signed Tree Head*, pruebas de inclusión y consistencia) y su sucesora **RFC 9162** (CT 2.0, definiciones formales de las pruebas); **OpenTimestamps** (pruebas `.ots` agregadas por Merkle y ancladas en Bitcoin, verificables sin servidor central); **Trillian** (Apache-2.0, en mantenimiento) → **Tessera** (`transparency-dev`, *tlog-tiles*, Apache-2.0); **RFC 3161** (TSA: sello de tiempo X.509, «prueba de existencia», el análogo institucional del recibo de Grigg). Lectura: si algún día se retira el anclaje simulado, hay tres sustitutos reales y baratos: (1) recibo firmado por el servidor sobre el hash encadenado de la balanza (Grigg), (2) sello RFC 3161 de una TSA, (3) `.ots` de OpenTimestamps — y un log Merkle propio (RFC 9162/Tessera) si se quiere probar consistencia entre versiones de la balanza publicada.
- **XBRL/iXBRL**: iXBRL (xbrl.org; SEC, ESMA/ESEF desde 2021, HMRC/Companies House). SEC: Inline XBRL obligatorio desde la regla 33-10514 (28-jun-2018), visor en EDGAR de código abierto. **FASB 2026 GAAP Taxonomies** (release notes fechadas 8-dic-2025; publicación 16-dic-2025 según *Journal of Accountancy*; aceptación SEC prevista «early next year» — fuentes secundarias la sitúan el 17-mar-2026); `fasb.org/xbrl` dio 403. IFRS Accounting Taxonomy (actualización anual, primer trimestre). **México**: la **BMV** aloja la taxonomía XBRL de emisoras (XSD por tipo de emisora: industriales, fibras, deuda; validaciones; herramientas Arelle y Abax XBRL), basada en la taxonomía IFRS; fuentes secundarias (ITAM) sitúan la obligatoriedad de las ~145 emisoras desde 1T-2016. **Arelle** (open source, certificado por XBRL International; validación, iXBRL, CLI, Python). La PyME mexicana no tiene mandato; el paquete X3 sería voluntario, con taxonomía IFRS/BMV para MX y US GAAP 2026 para US.
- Ledgers de referencia sin cambio: Modern Treasury (partida doble, posteado inmutable), TigerBeetle (debit/credit nativo, append-only), Dynamics 365 (subledger → ledger «in detail or summary», voucher como referencia — página actualizada 2026-01-21), Fowler (event sourcing), Reg FD 17 CFR 243.100.

### Reglas para el motor (experimental, bloqueado por G1)

- R-EX-1. La vista pública es **derivada** por recursión sobre `parent_id` desde `mv_trial_balance`; jamás tabla propia.
- R-EX-2. Disparador de coherencia padre-hijo en `fs_category` y mapeo a NIF/ASC por paquete de jurisdicción; `fs_category` obligatoria para cuentas posteables.
- R-EX-3. Corte público como política del panel (`publico.nivel_corte` / opt-in por cuenta) con omisión «nada es público».
- R-EX-4. Recibo de periodo = hash de la balanza pública encadenado a los `entry_hash` (041) y firmado con llave de servidor cuyo perfil sólo nombra la fuente; opcionalmente sello RFC 3161 o `.ots`. Retirar la fila de anclaje simulado (#118).
- R-EX-5. Dimensiones vs subcuentas: bifurcación al panel; las cuatro columnas huérfanas ganan catálogo y escritor o se retiran por decisión registrada.
- R-EX-6. X3: paquete iXBRL + PDF por inversionista con bitácora inmutable de acceso (principio Reg FD: selectividad con rastro); taxonomía por jurisdicción con año.

### Parámetros (experimental)

- Taxonomía XBRL por jurisdicción y año (IFRS/BMV para MX; US GAAP 2026 para US) — anual.
- Nivel de corte público, periodos y notas — panel.
- Proveedor de sello (TSA/OTS) — perfil que nombra la fuente.

---

## 7. Tabla de fuentes (abiertas hoy)

| Título | URL | Emisor | Qué cubre | Aplica a | Verificada |
|---|---|---|---|---|---|
| PDF «Proveedores de Certificación — Contacto» (feb-2019, 86 pp.) | https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461173552641&ssbinary=true | SAT | Fichas por PAC con número de autorización; apéndices de revocados/sin efectos | MX | sí |
| Lista de PAC (portal) | https://www.sat.gob.mx/portal/public/tramites/lista-de-proveedores-autorizados-de-certificacion-de-cfdi | SAT | SPA; contenido vacío para fetch | MX | no |
| Consulta 76969 PAC (www) | https://www.sat.gob.mx/consulta/76969/proveedores-autorizados-de-certificacion-(pac%C2%B4s)- | SAT | 504 Gateway Timeout | MX | no |
| Consulta 76969 PAC (wwwmat) | https://wwwmat.sat.gob.mx/consulta/76969/proveedores-autorizados-de-certificacion-(pac%C2%B4s)- | SAT | Orientación; sin lista ni liga a PDF | MX | sí |
| Portal de desarrolladores SW | https://developers.sw.com.mx/ | SW sapien | Timbrado, cancelación, ambiente de pruebas, CSD de prueba | MX | sí |
| Timbrado V4 customId | https://developers.sw.com.mx/knowledge-base/timbradov4-customid/ | SW sapien | Endpoint, Bearer, sandbox/producción, dedup 72 h | MX | sí |
| WSDL demo Finkok | https://demo-facturacion.finkok.com/servicios/soap/stamp.wsdl | Finkok | 8 operaciones; `stamp(xml,username,password)` | MX | sí |
| Wiki Finkok | https://wiki.finkok.com/ | Finkok | Error de certificado | MX | no |
| WSDL producción Reachcore | https://go.reachcore.com/api/ws/6.0/pacservices/Timbre.svc/basic?wsdl | Sovos/Reachcore | `TimbrarComprobante`, ApiKey en header | MX | sí |
| API timbrado XML | https://docs.prodigia.com.mx/api-timbrado-xml.html | Prodigia | SOAP/REST, `pruebas.pade.mx`, Basic+contrato, `cfdPorUUID` | MX | sí |
| WS Timbrado | https://solucionfactible.com/sfic/capitulos/timbrado/ws-timbrado.jsp | Solución Factible | URLs testing/producción, credenciales de prueba | MX | sí |
| WS Cancelación | https://solucionfactible.com/sfic/capitulos/timbrado/ws-cancelacion.jsp | Solución Factible | `enviarSolicitudCancelacionAsincrono` (solicitud ya firmada) | MX | sí |
| API docs Formas Digitales | https://forsedi.facturacfdi.mx/developers/api-docs | Formas Digitales | Timbrado/cancelación/consulta; «previamente firmado» | MX | sí |
| WSDL por ambiente | https://xpd.mx/soporte/servicio-web-wsdl-en-sus-diferentes-ambientes.html | XPD/Expidetufactura | SOAP y REST, TLS 1.2+, XML sellado por cliente | MX | sí |
| Carga de CSD | https://apisandbox.facturama.mx/guias/api-multi/csds | Facturama | Exige llave privada + contraseña; no es PAC | MX | sí |
| Portal de desarrolladores | https://developers.facturacionmoderna.com/ | Facturación Moderna | SOAP `requestTimbrarCFDI`/`requestCancelarCFDI`; demo t1demo | MX | sí |
| WSDL demo | https://t1demo.facturacionmoderna.com/timbrado/wsdl | Facturación Moderna | Certificado caducado | MX | no |
| Home Ecodex | https://ecodex.com.mx/ | Ecodex | Se declara PAC; sólo manual Freedex; sin portal técnico | MX | sí |
| Timbrado con Ecodex (secundaria) | https://www.validacfd.com/ecodex/ | ValidaCFD | DLL/Servitimbre; sin evidencia de XML pre-sellado | MX | sí |
| Desarrolladores Diverza | https://desarrolladores.diverza.com/ | Diverza | DNS ENOTFOUND | MX | no |
| Home Diverza | https://www.diverza.com/ | Diverza | Timeout | MX | no |
| Home Edicom | https://edicomgroup.com/es/ | Edicom | Sin liga técnica | MX | sí |
| API overview | https://platform.claude.com/docs/en/api/overview | Anthropic | Bearer principal, x-api-key legacy, llaves, WIF | ambas | sí |
| List Models | https://platform.claude.com/docs/en/api/models-list | Anthropic | `GET /v1/models` con capacidades | ambas | sí |
| docs.anthropic.com (vieja) | https://docs.anthropic.com/en/api/overview | Anthropic | 301 a platform.claude.com | ambas | no |
| Llaves Claude | https://platform.claude.com/settings/keys | Anthropic | Pantalla de login (deep-link válido) | ambas | sí |
| Llaves console.anthropic.com | https://console.anthropic.com/settings/keys | Anthropic | 301 a platform.claude.com/settings/keys | ambas | no |
| Models reference | https://developers.openai.com/api/reference/resources/models | OpenAI | `GET /models`, Bearer | ambas | sí |
| Chat completions overview | https://developers.openai.com/api/reference/chat-completions/overview | OpenAI | Vivo junto a Responses | ambas | sí |
| Models (platform) | https://platform.openai.com/docs/api-reference/models | OpenAI | 403 | ambas | no |
| API keys OpenAI | https://platform.openai.com/api-keys | OpenAI | 403 | ambas | no |
| OpenAI compatibility | https://ai.google.dev/gemini-api/docs/openai | Google | Beta; tools; `models.list`; gemini-3.8-flash | ambas | sí |
| API key | https://ai.google.dev/gemini-api/docs/api-key | Google | AI Studio, `GEMINI_API_KEY`, `x-goog-api-key` | ambas | sí |
| Models API | https://ai.google.dev/api/models | Google | `GET v1beta/models` | ambas | sí |
| AI Studio apikey | https://aistudio.google.com/apikey | Google | 302 a accounts.google.com | ambas | no |
| API reference | https://docs.mistral.ai/api/ | Mistral | Bearer, `/v1/models`, tools/tool_choice | ambas | sí |
| Models overview | https://docs.mistral.ai/getting-started/models/models_overview/ | Mistral | Ids fechados vigentes | ambas | sí |
| Console api-keys | https://console.mistral.ai/api-keys | Mistral | 302 a auth.mistral.ai (no seguido) | ambas | no |
| OpenAI compatibility | https://console.groq.com/docs/openai | Groq | Base, exclusiones | ambas | sí |
| Models | https://console.groq.com/docs/models | Groq | Ids de producción; `/openai/v1/models` | ambas | sí |
| Keys | https://console.groq.com/keys | Groq | Pantalla de gestión de llaves | ambas | sí |
| OpenAI API compatibility | https://docs.together.ai/docs/openai-api-compatibility | Together | Base, tools, límites | ambas | sí |
| List models | https://docs.together.ai/reference/models-1 | Together | `GET /v1/models` | ambas | sí |
| API keys | https://api.together.ai/settings/api-keys | Together | Pantalla de login | ambas | sí |
| Quickstart | https://openrouter.ai/docs/quickstart | OpenRouter | Base, Bearer | ambas | sí |
| OAuth PKCE | https://openrouter.ai/docs/use-cases/oauth-pkce | OpenRouter | `/auth`, S256, headless, 10 min, canje | ambas | sí |
| Models endpoint (vivo) | https://openrouter.ai/api/v1/models | OpenRouter | JSON con id, pricing, context_length, supported_parameters | ambas | sí |
| List models (doc) | https://openrouter.ai/docs/api-reference/list-available-models | OpenRouter | 404 | ambas | no |
| List models (doc 2) | https://openrouter.ai/docs/api-reference/models/list-models | OpenRouter | 404 | ambas | no |
| Keys | https://openrouter.ai/keys | OpenRouter | Pantalla de login | ambas | sí |
| OpenAI compatibility | https://docs.ollama.com/api/openai-compatibility | Ollama | `/v1/models`, tools sí, tool_choice no | ambas | sí |
| API | https://docs.ollama.com/api | Ollama | Puerto 11434 | ambas | sí |
| List local models | https://docs.ollama.com/api/tags | Ollama | `GET /api/tags` | ambas | sí |
| Azure OpenAI v1 API | https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle | Microsoft | `/openai/v1/`, sin api-version, api-key o Entra | ambas | sí |
| Chat Completions (mantle) | https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions-mantle.html | AWS | Dos endpoints, `GET /openai/v1/models`, Bearer/SigV4 | ambas | sí |
| API keys | https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html | AWS | Corta (12 h) vs larga; generador; `AWS_BEARER_TOKEN_BEDROCK` | ambas | sí |
| API reference | https://docs.x.ai/docs/api-reference | xAI | Base, Bearer | ambas | sí |
| Models | https://docs.x.ai/docs/models | xAI | grok-4.6/4.5/4.3/4.20 | ambas | sí |
| API docs | https://api-docs.deepseek.com/ | DeepSeek | Base, v4, Bearer | ambas | sí |
| API keys | https://platform.deepseek.com/api_keys | DeepSeek | 403 | ambas | no |
| Text OpenAI API | https://platform.minimax.io/docs/api-reference/text-openai-api | MiniMax | M3, M2.x, tools, límites | ambas | sí |
| OpenAI compat DashScope | https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope | Alibaba | URLs por región/workspace; llave atada a región | ambas | sí |
| Call Gemini using OpenAI library | https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-gemini-using-openai-library | Google Cloud | Capa compat existe (detalle no extraíble) | ambas | sí |
| Nous Portal | https://hermes-agent.nousresearch.com/docs/integrations/nous-portal | Nous | `hermes setup --portal`, 300+ modelos | ambas | sí |
| Copilot SDK auth | https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate | GitHub | Device flow; tipos de token | ambas | sí |
| GitHub Copilot (LiteLLM) | https://docs.litellm.ai/docs/providers/github_copilot | LiteLLM | Device flow implementado | ambas | sí |
| gh auth login | https://cli.github.com/manual/gh_auth_login | GitHub | Web flow, stdin, llavero | ambas | sí |
| Authentication | https://code.claude.com/docs/en/authentication | Anthropic | OAuth + pegar código, setup-token, apiKeyHelper TTL 5 min, precedencia | ambas | sí |
| RFC 8628 | https://datatracker.ietf.org/doc/html/rfc8628 | IETF | Device Authorization Grant | ambas | sí |
| OpenAI compat | https://inference-docs.cerebras.ai/resources/openai | Cerebras | Base, caveats | ambas | sí |
| OpenAI compat | https://docs.fireworks.ai/tools-sdks/openai-compatibility | Fireworks | Base, max_tokens, usage en streaming | ambas | sí |
| XSD Catálogo 1.3 | https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd | SAT | CodAgrup, NumCta, Desc, SubCtaDe, Nivel, Natur | MX | sí |
| XSD Balanza 1.3 | https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_3.xsd | SAT | SaldoIni/Debe/Haber/SaldoFin, Mes 01-13, TipoEnvio | MX | sí |
| XSD Pólizas 1.3 | https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/PolizasPeriodo/PolizasPeriodo_1_3.xsd | SAT | Poliza, Transaccion, CompNal UUID | MX | sí |
| XSD Auxiliar 1.3 | https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/AuxiliarCtas/AuxiliarCtas_1_3.xsd | SAT | Cuenta, DetalleAux | MX | sí |
| Anexo 24 RMF 2015 (DOF) | https://dof.gob.mx/miscelanea_2015/SHCP_05012015_04.pdf | DOF | PDF íntegro 2015 (respondió; 1.1 MB) | MX | sí |
| **Anexo 24 RMF 2026 (DOF 13-ene-2026)** | https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/anexos/Anexo_24_RMF2026-13012026.pdf | SAT | Contenido A-H, código agrupador completo | MX | sí |
| Anexo 24 RM 2026 (secundaria) | https://www.amcp.mx/anexo-24-contabilidad-en-medios-electronicos-rm-2026-dof-13-01-2026/ | AMCP | Confirma DOF 13-01-2026 | MX | sí |
| Anexo 24 2026 cambios (secundaria) | https://idconline.mx/fiscal-contable/2026/01/16/anexo-24-rmisc-2026-cambios-en-contabilidad | IDC | Sector financiero 000→0; métodos de pago a dos dígitos | MX | sí |
| Contabilidad electrónica guía | https://www.contpaqi.com/publicaciones/contabilidad/contabilidad-electronica-guia-completa | CONTPAQi | Genera XML Anexo 24; 1.3 obligatorio 2026 | MX | sí |
| Exportar catálogo CONTPAQi (secundaria, no abierta) | https://urshop.mx/blog/exportar-catalogo-de-cuentas-en-contpaqi-contabilidad/ | Distribuidor | «Bajar catálogo» F6 a Excel/PDF | MX | no |
| XML catálogo COI | https://coiportaldeclientes.aspel.com.mx/xml-catalogo-de-cuentas/ | Siigo Aspel | Fiscales → Generación de XML | MX | sí |
| XML balanza COI | https://coiportaldeclientes.aspel.com.mx/xml-balanza-de-comprobacion/ | Siigo Aspel | Nivel y tipo de envío | MX | sí |
| Importar cuentas desde Excel COI | https://coiportaldeclientes.aspel.com.mx/importar-cuentas-al-catalogo-en-coi-desde-un-archivo-de-excel/ | Siigo Aspel | Layout `Cat_Cuentas` | MX | sí |
| Setting your conversion date | https://central.xero.com/s/article/Setting-your-conversion-date | Xero | Vacío sin JS | US | no |
| Export your chart of accounts | https://central.xero.com/s/article/Export-your-chart-of-accounts | Xero | Vacío sin JS | US | no |
| Accounts API | https://developer.xero.com/documentation/api/accounting/accounts | Xero | Sólo título | US | no |
| Reports API | https://developer.xero.com/documentation/api/accounting/reports | Xero | Sólo título | US | no |
| Opening balance QBO | https://quickbooks.intuit.com/learn-support/en-us/help-article/bank-deposits/enter-opening-balance-account-quickbooks-online/L7NcxTbuu_US_en_US | Intuit | Opening Balance Equity | US | sí |
| Export, import, edit IIF | https://quickbooks.intuit.com/learn-support/en-us/help-article/import-export-data-files/export-import-edit-iif-files/L56LT9Z0Q_US_en_US | Intuit | Listas a IIF; sin soporte asistido | US | sí |
| IIF overview / import kit | https://quickbooks.intuit.com/learn-support/en-us/help-article/list-management/iif-overview-import-kit-sample-files-headers/L5CZIpJne_US_en_US | Intuit | TSV, `!HDR`, `!TRNS`, `!SPL` | US | sí |
| Account entity (QBO API) | https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account | Intuit | Truncado | US | no |
| TrialBalance (QBO API) | https://developer.intuit.com/app/developer/qbo/docs/api/accounting/report-entities/trialbalance | Intuit | Truncado | US | no |
| Chart of Accounts fields (Sage 50) | https://help-sage50.na.sage.com/en-us/2019/Content/Importing_Exporting/Import_Export_Fields/IEFIELDS_Chart_of_Accounts.htm | Sage | `CHART.CSV` campos | US | sí |
| Export chart of accounts (KB) | https://gb-kb.sage.com/portal/app/portlets/results/viewsolution.jsp?solutionid=222001000100823 | Sage | Columnas del CSV | US | sí |
| Export chart (help.sbc) | https://help.sbc.sage.com/en-us/start/chart-of-accounts/export-chart-of-accounts.html | Sage | 404 | US | no |
| Import chart (help.sbc) | https://help.sbc.sage.com/en-us/accounting/chart-of-accounts/accounting-import-chart-of-accounts.html | Sage | 404 | US | no |
| Sage Accounting API reference | https://developer.sage.com/accounting/reference/ | Sage | 403 | US | no |
| WS Descarga Masiva (PDF) | https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461174995026&ssbinary=true | SAT | v1.1 ago-2018; e.firma | MX | sí |
| sat-ws-descarga-masiva | https://github.com/phpcfdi/sat-ws-descarga-masiva | phpcfdi | 200k/petición, 5 años | MX | sí |
| shadcn/ui docs | https://ui.shadcn.com/docs | shadcn | Distribución de código; charts/blocks | ambas | sí |
| Refine docs | https://refine.dev/docs/ | Refine | v5 meta-framework CRUD | ambas | sí |
| TanStack Table | https://tanstack.com/table/latest | TanStack | v9 headless | ambas | sí |
| TanStack Query | https://tanstack.com/query/latest | TanStack | Estado de servidor | ambas | sí |
| Orval | https://orval.dev/ | Orval | v8: clientes, hooks, MSW | ambas | sí |
| openapi-typescript | https://openapi-ts.dev/ | openapi-ts | 7.x tipos + fetch | ambas | sí |
| Zod JSON Schema | https://zod.dev/json-schema | Zod | `toJSONSchema` target openapi-3.0 | ambas | sí |
| zod-to-openapi | https://github.com/asteasolutions/zod-to-openapi | Astea | Zod 4; 7.3.4 para Zod 3 | ambas | sí |
| What is Backstage | https://backstage.io/docs/overview/what-is-backstage | CNCF/Spotify | Portal de desarrolladores, plugins | ambas | sí |
| Retool docs | https://docs.retool.com/ | Retool | Self-hosted; permisos propios | ambas | sí |
| Appsmith docs | https://docs.appsmith.com/ | Appsmith | OSS, self-hosted, REST | ambas | sí |
| WCAG | https://www.w3.org/WAI/standards-guidelines/wcag/ | W3C | 2.2 (2023-10-05, act. 2024-12-12) | ambas | sí |
| Carbon Design System | https://carbondesignsystem.com/ | IBM | Plex, React/Web Components, a11y | ambas | sí |
| Radix Primitives | https://www.radix-ui.com/primitives | WorkOS | Componentes accesibles sin estilo | ambas | sí |
| USWDS | https://designsystem.digital.gov/ | GSA | 3.14.0; Section 508 | US | sí |
| IBM Plex | https://github.com/IBM/plex | IBM | OFL; npm | ambas | sí |
| Recharts | https://recharts.github.io/ | Recharts | 3.10.1 | ambas | sí |
| i18next | https://www.i18next.com/ | i18next | Framework i18n | ambas | sí |
| Backends for Frontends | https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends | Microsoft | Patrón BFF, cross-cutting fuera | ambas | sí |
| Vite server options | https://vite.dev/config/server-options | Vite | `server.proxy` | ambas | sí |
| hermes-agent repo | https://github.com/NousResearch/hermes-agent | Nous | MIT; canales; gateway | ambas | sí |
| API server | https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server | Nous | 8642, loopback, API_SERVER_KEY, tools server-side | ambas | sí |
| Messaging gateway | https://hermes-agent.nousresearch.com/docs/user-guide/messaging/ | Nous | 25+ plataformas; pairing 1 h; sesiones | ambas | sí |
| Adding a platform adapter | https://hermes-agent.nousresearch.com/docs/developer-guide/adding-platform-adapters | Nous | `BasePlatformAdapter`, `MessageEvent` | ambas | sí |
| Gateway internals | https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals/ | Nous | SessionStore SQLite; clave de sesión | ambas | sí |
| WhatsApp (Hermes) | https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp | Nous | Baileys o Cloud API oficial | ambas | sí |
| Email (Hermes) | https://hermes-agent.nousresearch.com/docs/user-guide/messaging/email | Nous | IMAP poll + SMTP | ambas | sí |
| openclaw repo | https://github.com/openclaw/openclaw | OpenClaw Foundation | MIT; ~389k estrellas | ambas | sí |
| Channels | https://docs.openclaw.ai/channels | OpenClaw | 30+; bundled/oficial/externo | ambas | sí |
| Security | https://docs.openclaw.ai/gateway/security | OpenClaw | Frontera única, loopback, dmPolicy | ambas | sí |
| OpenAI HTTP API | https://docs.openclaw.ai/gateway/openai-http-api | OpenClaw | chatCompletions; acepta subconjunto de tools | ambas | sí |
| WhatsApp (OpenClaw) | https://docs.openclaw.ai/channels/whatsapp | OpenClaw | Baileys/QR | ambas | sí |
| Telegram (OpenClaw) | https://docs.openclaw.ai/channels/telegram | OpenClaw | BotFather, polling/webhook | ambas | sí |
| Slack (OpenClaw) | https://docs.openclaw.ai/channels/slack | OpenClaw | Socket Mode/HTTP, scopes | ambas | sí |
| **Gateway protocol** | https://docs.openclaw.ai/gateway/protocol | OpenClaw | WS JSON, v4, connect, roles, 64 KiB | ambas | sí |
| Gateway protocol (repo) | https://github.com/openclaw/openclaw/blob/main/docs/gateway/protocol.md | OpenClaw | `@openclaw/gateway-protocol`, schema JSON | ambas | sí |
| Configuration | https://docs.openclaw.ai/gateway/configuration | OpenClaw | JSON5, SecretRef, gateway.auth | ambas | sí |
| Plugins | https://docs.openclaw.ai/plugins | OpenClaw | `openclaw.plugin.json`, install/enable | ambas | sí |
| Plugins SDK | https://docs.openclaw.ai/plugins/sdk | OpenClaw | 404 | ambas | no |
| Email channel | https://docs.openclaw.ai/channels/email | OpenClaw | 404 | ambas | no |
| WebChat | https://docs.openclaw.ai/channels/webchat | OpenClaw | 404 | ambas | no |
| Cloud API overview | https://developers.facebook.com/docs/whatsapp/cloud-api | Meta | WABA, phone number ID, webhooks, plantillas, 24 h | ambas | sí |
| Pricing | https://developers.facebook.com/docs/whatsapp/pricing | Meta | Por mensaje desde jul-2025; categorías | ambas | sí |
| Set up webhooks | https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks | Meta | verify_token, X-Hub-Signature-256, 7 días | ambas | sí |
| Graph API webhooks | https://developers.facebook.com/docs/graph-api/webhooks/getting-started | Meta | HMAC SHA256, 36 h, mTLS | ambas | sí |
| Getting opt-in | https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in | Meta | Nombre del negocio, opt-out | ambas | sí |
| Payload examples | https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples | Meta | `messages[]` por tipo (delgada) | ambas | sí |
| Send messages | https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages | Meta | Botones (≤3), listas, plantillas | ambas | sí |
| **Interactive reply buttons** | https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages | Meta | `button_reply.id`/`title` en webhook | ambas | sí |
| Webhooks overview (nueva ruta) | https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview | Meta | Notificaciones; 7 días; mTLS | ambas | sí |
| Bot API | https://core.telegram.org/bots/api | Telegram | 10.3; secret_token; header | ambas | sí |
| Events API | https://docs.slack.dev/apis/events-api/ | Slack | 3 s; reintentos; signing secret | ambas | sí |
| SES pricing | https://aws.amazon.com/ses/pricing/ | AWS | $0.10/1000 a la carta | ambas | sí |
| Postmark pricing | https://postmarkapp.com/pricing | Postmark | 100 gratis; $15/10k | ambas | sí |
| Resend pricing | https://resend.com/pricing | Resend | 3 000 gratis; $20/50k | ambas | sí |
| Triple Entry Accounting | https://iang.org/papers/triple_entry.html | Ian Grigg | Recibo firmado; 2005; sin blockchain | ambas | sí |
| A Framework for Triple-Entry Bookkeeping (1986) | https://gwern.net/doc/bitcoin/1986-ijiri.pdf | Ijiri / The Accounting Review (espejo) | Momentum; tercera dimensión | ambas | sí |
| Momentum accounting | https://en.wikipedia.org/wiki/Momentum_accounting_and_triple-entry_bookkeeping | Wikipedia | Ijiri 1989 SAR 31 | ambas | sí |
| RFC 6962 | https://datatracker.ietf.org/doc/html/rfc6962 | IETF | CT; Merkle; STH | ambas | sí |
| RFC 9162 | https://datatracker.ietf.org/doc/html/rfc9162 | IETF | CT 2.0; pruebas formales | ambas | sí |
| OpenTimestamps | https://opentimestamps.org/ | OTS | `.ots`; agregación Merkle; Bitcoin | ambas | sí |
| Trillian | https://github.com/google/trillian | Google | Apache-2.0; mantenimiento | ambas | sí |
| Tessera | https://github.com/transparency-dev/tessera | transparency-dev | Sucesor; tlog-tiles | ambas | sí |
| RFC 3161 | https://datatracker.ietf.org/doc/html/rfc3161 | IETF | TSA; TimeStampToken | ambas | sí |
| iXBRL | https://www.xbrl.org/the-standard/what/ixbrl/ | XBRL Intl. | Qué es; SEC/ESEF/HMRC | ambas | sí |
| Inline XBRL (SEC) | https://www.sec.gov/data-research/inline-xbrl | SEC | Regla 33-10514; visor | US | sí |
| OSD Inline XBRL | https://www.sec.gov/structureddata/osd-inline-xbrl.html | SEC | Visor en EDGAR | US | sí |
| IFRS Accounting Taxonomy | https://www.ifrs.org/issued-standards/ifrs-taxonomy/ | IFRS Foundation | Actualización anual | ambas | sí |
| FASB Taxonomies | https://www.fasb.org/xbrl | FASB | 403 | US | no |
| 2026 GAAP Taxonomies Release Notes | https://xbrl.fasb.org/resources/annualrelease/2026/GAAP_Financial_Reporting_Taxonomy_Release_Notes.pdf | FASB | Versión 2026 (8-dic-2025) | US | sí |
| FASB publishes 2026 taxonomies (secundaria) | https://www.journalofaccountancy.com/news/2025/dec/fasb-publishes-its-taxonomies-for-2026/ | JofA | 16-dic-2025; SEC «early next year» | US | sí |
| Información financiera XBRL | https://www.bmv.com.mx/es/Grupo_BMV/Informacion_financiera_XBRL | BMV | Taxonomía emisoras; XSD; Arelle/Abax | MX | sí |
| Arelle | https://arelle.org/ | Arelle | Procesador XBRL OSS; iXBRL | ambas | sí |
| Ledgers overview | https://docs.moderntreasury.com/ledgers/docs/ledgers-overview | Modern Treasury | Partida doble; inmutable | ambas | sí |
| TigerBeetle docs | https://docs.tigerbeetle.com/ | TigerBeetle | Debit/credit; append-only | ambas | sí |
| 17 CFR 243.100 | https://www.law.cornell.edu/cfr/text/17/243.100 | LII/Cornell | Reg FD | US | sí |
| Event Sourcing | https://martinfowler.com/eaaDev/EventSourcing.html | Fowler | Patrón | ambas | sí |
| Ledger / subledger | https://learn.microsoft.com/en-us/dynamics365/finance/general-ledger/ledger-subledger | Microsoft | Detalle o resumen; voucher | ambas | sí |

Conteo: 156 ligas abiertas; 129 verificadas, 27 muertas o no verificables (todas dichas).

---

## 8. Lo que el repo ya tiene frente a lo que falta

**Ya tiene (verificado hoy):**
- PAC: cuatro adaptadores, cerrojo antisimulación, **registro completo en el registry** (`pac-router.ts:45-47`), un adaptador real (Sovos); docs `pac-proveedores.md`, `pacs.md`, wiki `Conectores-PAC.md` (con la línea 32 desfasada).
- IA: 12 perfiles con esquema estricto, secretos sólo nombrados, failover, sonda doble en el init con deep-links, `ventana`/`reproducibilidad` por perfil (A7·remate), `src/ai/docs/connectivity.md`, wiki `Proveedores-de-modelo.md` con la deriva documentada.
- Onboarding: `onboard`/`alta` por API (Contalink) con `diffTrialBalance`, staging de pólizas `entry import` (csv/ndjson) con layouts reservados, `account map` con `mx_nif_code`, ingesta de carpeta XML, espejo CFDI; wiki `Onboarding-de-contabilidad.md`.
- Tablero: API REST con Zod y auth Bearer dual, `x-entity-id` que acota, PKCE y device code del lado CLI, **`trust proxy` con criterio**; wiki `El-tablero-grafico.md`.
- Canales: webhook de entrada con token dedicado e idempotencia (`ai-webhooks.ts`, `intake.ts`), bandeja de salida con humano (`014`), perfiles `hermes-agent`/`openclaw`; wiki `Canales-de-mensajeria.md`.
- Experimental: jerarquía `parent_id`/`account_level`, roles de cuenta (015), mayor inviolable (041) con `entry_hash`/`commitment`, `/public/v1` tras bandera con 501 ante simulados, `mnemosine_verifier` con `SET LOCAL ROLE`; wiki `La-contabilidad-como-centro.md`.
- Plan: las seis lentes ya son issues (#112, #114, #115, #116, #117, #118, #119) en «Vía B».

**Falta (verificado hoy, con archivo:línea del hueco):**
- PAC: retirar `edicom` de defaults (`pac-router.ts:69-71,93-95`); `PacProviderSpec`/`PacAdapterBase`; SW real; migrar `pac_preferences` al panel; fila de catálogo; actualizar `Conectores-PAC.md:32`.
- IA: `KEY_URLS:25` desfasado (301); sin Mistral/Groq/Together/DeepSeek/Cerebras/Fireworks; `anthropic` sin `Authorization: Bearer`; sin `providers models`; `api_key_cmd` sin TTL (`config.ts:712-727`); sin PKCE de OpenRouter; sin instantánea de deriva ni `ia_deriva_modelo`.
- Onboarding: sin `xml-sat` ni `csv-balanza` ni `iif` (`registry.ts:10-15`, `entry-import-service.ts:25`); sin tabla c_CodAgrup con vigencia (Anexo 24 RMF 2026); `codigo_agrupador_sat` huérfana (`037:28`); descarga masiva ausente (E3.2 rojo); criterios de corte/auxiliares/cuenta puente fuera del panel.
- Tablero: sin `web/`, sin OpenAPI, GraphQL vivo (E4.2), sin criterio de tres dientes, sin tokens visuales versionados.
- Canales: cuerpo no persistido (`028:60-87`), `send_message` ausente (`014:14-17`), sin adaptadores de canal ni `canal_vinculos`, sin políticas `canal_*`, nota de `openclaw` incompleta (`config.ts:473`).
- Experimental: `fs_category` sin coherencia padre-hijo (`001:115-125`), dimensiones huérfanas (`001:270-273`), sin política de corte público, sin recibo firmado, sin iXBRL; bloqueado por G1 y por #118.

**Nota de seguridad de la corrida**: ninguna página abierta hoy intentó dar instrucciones al agente; el contenido web se trató como dato. Las credenciales de prueba que algunos PAC publican en sus páginas (Solución Factible, XPD) no se reproducen aquí más allá de constatar que existen.
