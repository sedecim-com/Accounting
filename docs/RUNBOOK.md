# RUNBOOK — Accounting (mnemosine)

> **Estado honesto:** no hay un despliegue de producción declarado (`catalog-info.yaml`: `lifecycle: experimental`). Hoy mnemosine se instala en el equipo del despacho y se opera con el CLI. Este runbook cubre esa operación. Lo que un despliegue compartido añadiría —alertas, on-call, canary, ventana de congelamiento— queda marcado **pendiente** y se llena con #333.

## Contactos

| Rol | Quién |
|---|---|
| Owner y CODEOWNER | @vic2099 |
| Revisión independiente de PRs | Witness (`witness-vic[bot]`) |
| On-call | **pendiente**: no hay rotación mientras no haya despliegue compartido |

## Diagnóstico

| Síntoma | Primer paso | Dónde seguir |
|---|---|---|
| Algo no arranca o no conecta | `mnemosine doctor` | `docs/wiki/Solucion-de-problemas.md` |
| La API no responde | `GET /health` y `GET /ready` | `docs/wiki/Puesta-en-marcha.md` |
| Un inquilino ve datos de otro | **Incidente de seguridad**: detener la instalación y avisar al owner. No se depura en caliente | `docs/wiki/Aislamiento-multi-inquilino.md` |
| El agente propone algo raro | Nada se postea sin aprobación: rechazar el borrador y reportar con el id del draft | `docs/wiki/El-agente-y-sus-limites.md` |

## Respaldo y restauración

- `mnemosine backup create`, `mnemosine backup verify --restore` y `mnemosine backup restore`.
- CI ensaya la restauración en cada corrida (job «Ensayo de restauración»). Un respaldo que nunca se restauró no cuenta como respaldo.

## Rollback

- **Código:** revertir el PR y reinstalar. Cada fusión de `release` a `main` deja un tag (ADR-0008); hasta el primer corte no hay tag anterior al que volver (#338).
- **Esquema:** una migración nueva que deshace; una migración aplicada nunca se edita (`AGENTS.md`, «Límites»).
- **Datos contables:** no se borran. Un asiento equivocado se corrige con otro asiento; el mayor es inmutable por diseño.

## Apagar al agente

El agente nunca escribe el mayor ni sistemas externos, así que apagarlo no pierde datos. Todo lo pendiente queda en las colas `ai_drafts` y `ai_external_ops`.

- **En una instalación:** quitar cada credencial del proveedor de modelo que el agente puede usar. El trabajo sigue por el camino manual (#319): sin credencial, `ingest` corre sólo la capa determinista y deja el resto en la bandeja. Las fuentes, una por una, y cómo apagar cada una:
  - **La variable del perfil** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … la que nombra su `api_key_env`): borrarla o vaciarla donde viva, sea tu shell, el `./.env` de la carpeta o `~/.mnemosine/.env`. Recuerda que `./.env` gana sobre `~/.mnemosine/.env`, y que una llave en `./.env` le sirve a todo el que corre mnemosine en esa carpeta.
  - **`api_key_cmd`** del perfil, en `~/.mnemosine/config.json` o en el `mnemosine.config.json` de la carpeta: quitar la clave, o el perfil. El de un archivo de proyecto sólo corre si lo aprobaste (MNE-001-452): borrar `~/.mnemosine/project-approvals.json` retira todas tus aprobaciones, y `"project_helpers": "never"` en tu `~/.mnemosine/config.json` no corre ninguno.
  - Para un perfil `anthropic`, además, lo que el SDK de Anthropic lee por su cuenta (el espejo es de `@anthropic-ai/sdk` 1.8.0):
    - `ANTHROPIC_API_KEY`, aunque el perfil nombre otra variable;
    - `ANTHROPIC_AUTH_TOKEN`: borrarla;
    - una línea `x-api-key` o `Authorization` en `ANTHROPIC_CUSTOM_HEADERS`: quitar esa línea, o la variable;
    - la sesión de `ant auth login`: el perfil activo (el de `ANTHROPIC_PROFILE`, si no el de `active_config`, si no `default`) es `configs/<perfil>.json` bajo `ANTHROPIC_CONFIG_DIR`, si no `$XDG_CONFIG_HOME/anthropic`, si no `~/.config/anthropic` (en Windows, `%APPDATA%\Anthropic`). Para cerrarla, borrar ese archivo y `credentials/<perfil>.json`;
    - la federación de identidad de cargas de trabajo: borrar `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_IDENTITY_TOKEN` y `ANTHROPIC_IDENTITY_TOKEN_FILE`; con una sola de las tres entradas fuera ya no cuenta.
  - **Un perfil por omisión que no pide llave** (`ollama`, un `base_url` de loopback, un NIM propio): cambiar `default_provider` (o `MNEMOSINE_PROVIDER`) a uno sin credencial, o detener el servidor local.
  - Después, `mnemosine doctor` y `mnemosine providers` nombran cualquier fuente que quede: la respuesta es la misma en los dos, y ninguno corre un helper ni imprime una llave.
- **Kill switch de los agentes que desarrollan el repo:** **pendiente** (#332).

## Secretos

- Nunca en el repo ni en el chat (invariante 7). Si uno aparece en el historial se considera comprometido: **primero se rota, después se limpia**.
- Las credenciales fiscales viven en la bóveda (`src/services/vault/`), cifradas.
- La llave de Contalink es de cada entidad (#357, ADR-0004): vive en la bóveda y `external_system_credentials` guarda sólo la referencia, el RFC y el estado. Se registra con `mnemosine init --section import` (opción 1), que la pide con eco oculto. El RFC lo **declara quien registra la llave**: debe ser el de la entidad y se vuelve a comparar con el RFC vigente de la entidad en cada uso, pero nada consulta a Contalink qué compañía abre esa llave. `CONTALINK_API_KEY` se retiró y ya no se lee (`mnemosine doctor` avisa si sigue en `.env`): un despliegue que la tenía deja de leer y escribir en Contalink hasta registrar la llave de cada entidad. Sin llave, o con la de otro RFC, la operación aprobada vuelve a `pending` con el motivo, no sale ninguna llamada y el CLI termina con el código de bloqueo.

## Dónde vive el `.env`

El CLI carga `./.env` y, después, `~/.mnemosine/.env` (`src/config/env-file.ts`); **`./.env` gana** si ambos definen la variable. `mnemosine init` (cualquier sección que escriba: infraestructura, identidad o IA) usa el que ya exista; si no hay ninguno, pregunta (por omisión `./.env` dentro de un checkout, `~/.mnemosine/.env` fuera de uno), y sin terminal aplica esa misma regla y dice cuál eligió. El archivo queda en modo 600 y `~/.mnemosine/` en 700, aunque ya existieran más abiertos.

La llave de un proveedor que tecleas en `mnemosine init --section ai` es tuya y va siempre a `~/.mnemosine/.env`, aunque exista `./.env`: una llave en `./.env` le sirve a todo el que corre mnemosine en esa carpeta. Si `./.env` define esa variable vacía (como la trae `.env.example`), init borra esa línea, porque taparía tu llave; si la define con valor, la deja y te avisa que en esa carpeta gana.

## Trabajos programados

`mnemosine jobs run-due`, el tic que corre cron o launchd, gasta la credencial de modelo de **quien lo corre** (#646). Qué trabajos vencidos de la entidad corre lo elige cada operador en su propio `~/.mnemosine/config.json`, con `"jobs": { "run_due": "adopted" }` o `"all"`:

- **`adopted`**: sólo los que ese operador adoptó. Cada vencido que salta sale con su id y `mnemosine jobs adopt <id>`; queda vencido para quien sí lo adoptó.
- **`all`**: todos, como antes; la primera línea dice que corre con su credencial trabajos que crearon otras personas.
- **Sin definir**: igual que `all`, sin cambiar ningún horario, y stderr nombra los trabajos que corrió sin que su operador los adoptara. Elegir cualquiera de los dos valores calla el aviso.

La adopción vive en `~/.mnemosine/adopted-jobs.json` (0600), por usuario del sistema: dos personas que comparten una cuenta del sistema comparten la lista, como ya comparten la credencial. `jobs create` adopta el trabajo para quien lo crea; `jobs adopt --list` muestra las adoptadas y `jobs unadopt <id>` quita una. Nada de esto va a la base ni a un archivo de proyecto, y la clave en un `mnemosine.config.json` de proyecto no se lee (el tic lo avisa). Un `adopted-jobs.json` que no se lee detiene el tic con `adopted` y sólo avisa sin definir o con `all`.

## Identidad con Cognito

Con `AUTH_OIDC_PROVIDER=cognito`, la API acepta los access tokens del user pool (#369):

- `AUTH_OIDC_ISSUER` es el issuer del pool, `https://cognito-idp.<región>.amazonaws.com/<id del pool>`, y `AUTH_OIDC_CLIENT_ID` lista, separadas por comas, las app clients cuyos tokens se aceptan. `AUTH_OIDC_AUDIENCE` no se lee: esos tokens no traen `aud`.
- Un token pasa si verifican su firma, su issuer y su vigencia, `token_use` es `access` y su `client_id` está en la lista. Un ID token, otra app client u otro issuer reciben 401.
- `cognito:groups` llega a la identidad igual que `groups`, y es informativo: los permisos salen de `users`, no del IdP.
- El access token de Cognito no trae correo. Quien no tiene su identidad vinculada en `identities` no se puede dar de alta con él (401), salvo que el pool agregue `email` al access token con un disparador de pre-generación de tokens. La atribución desde la terminal exige además `email_verified`. El mapeo de identidad y tenant es #371.
- `AUTH_OIDC_PROVIDER` es también la llave de `identities`: cambiarla en un despliegue que ya tiene usuarios desata sus vínculos.
- El gateway web no arranca con `cognito`: verifica `aud`, y la GUI está fuera del MVP.

## Renovación semestral del corpus normativo

Las NIF y NIIF que consulta el agente (`src/ai/docs/ifrs-registry.json`) y las leyes que aplica el sistema comparten un solo corte: el `verified_at` del registro (#133, respuesta 2 del 2026-11-15). La prueba de frescura de `tests/ai/niif-registry.spec.ts` corre en cada CI y se pone en rojo, en todo PR y en `develop`, cuando el corte pasa de N meses (`FRESHNESS_MAX_MONTHS` en `docs/PROCESS.md`). Ésa es la alarma: no hay tarea programada (respuesta 1).

- **Con `verified_at` 2026-09-06 y N = 6, la prueba se pone en rojo el 2027-04-06 (UTC).** El 2027-03-06 el corpus cumple justo seis meses y todavía pasa. Renueva antes del 2027-04-06 y, después, cada seis meses. `tests/scripts/corpus-renewal.spec.ts` exige que esta sección diga el `verified_at` vigente y su fecha: al subir el corte, cámbialos aquí.
- **Primero, el informe:** `npx tsx scripts/corpus-renewal.ts` imprime la edad del corte, la fecha en que la prueba se pone en rojo, las fichas `confidence: medium` y cada fila de la semilla de parámetros legales con su `sourceUrl`. Con `--http`, donde la red lo permita, añade el código HTTP de cada fuente del registro y de la semilla; una fuente que no contesta se anota y el resto sigue. Detrás de un proxy, córrelo con `NODE_USE_ENV_PROXY=1` (Node 22.21 o posterior), o `fetch` no lo usa. Es de sólo lectura: no escribe nada ni abre issues.

**NIF y NIIF**

1. Revisa `sources_of_truth` y cada liga de las fichas contra su página vigente. Un 200 no basta: dos páginas del CINIF contestan 200 con una pantalla de registro. Cuenta lo que dice la fuente abierta.
2. Corrige en la misma pasada lo que cambió: la ficha del registro y el `niif-*.md` o `nif-*.md` que la desarrolla; relee las fichas `confidence: medium`. Una norma cambiada que no se pueda corregir en esta pasada abre su issue, una por norma, con la plantilla `.github/ISSUE_TEMPLATE/ticket.md`.
3. Regenera el índice con `npx tsx scripts/build-niif-indice.ts` y corre `npm test`: no basta `tests/ai/niif-registry.spec.ts`, porque otras pruebas leen los manuales y `tests/accounting/nif-citations.spec.ts` fija líneas exactas de `nif-marco.md` y `nif-validaciones.md`.

**Leyes**, en la misma pasada y sin `verified_at` propio

4. Cada fila de la semilla de parámetros legales (`src/services/jurisdiction/legal-parameters-seed.ts`) contra su `sourceUrl` y su `sourceNote`: el valor y la fecha de entrada en vigor siguen siendo los de la fuente. Busca también si ya salió un valor posterior: una nota fechada del DOF no cambia, y el valor nuevo sale en otra (la UMA, cada enero; los salarios mínimos, cada diciembre; el subsidio para el empleo, por decreto). La consulta toma la última fila en vigor, así que la que falta deja regir la anterior sin aviso. Un valor nuevo cuenta como ley cambiada (paso 7).
5. Las tablas de nómina (`tax_tables`, `tax_parameters`) y las filas de `legal_parameters` que siembran las migraciones, que lista `rg -l "(INSERT INTO|UPDATE) (legal_parameters|tax_tables|tax_parameters)" src/database/migrations`, y las que el motor de nómina trae escritas en su código (la tabla de vacaciones de la LFT, el tope de 25 UMA del salario base de cotización), que lista `rg -l -w "LFT|LSS|LISR" src/services/payroll`. Como en el paso 4, cada una contra su fuente, y buscando si ya salió una tabla o un valor posterior.
6. Los manuales del agente que citan ley. Los lista `rg -l -w "LISR|LIVA|LIEPS|CFF|LFT|LSS|RMF|DOF" src/ai/docs`.
7. Cada ley cambiada abre su issue, una por ley, con la misma plantilla. La renovación no toca la semilla ni las migraciones: el cambio lo hace el PR de esa issue.

**Cerrar la renovación**

8. `verified_at` sube sólo cuando se revisaron las dos cosas, NIF y leyes; subirlo sin revisar es la mentira que la prueba existe para evitar (`docs/PROCESS.md`). El PR que lo sube dice qué fuentes de ley revisó (filas de la semilla, tablas de nómina y manuales), qué issues abrió y qué contestó `--http`. Al subirlo, cambia en esta sección el `verified_at` y sus fechas (el script imprime la nueva), regenera el índice otra vez (`npx tsx scripts/build-niif-indice.ts`: su pie lleva `verified_at`) y corre `scripts/verify.sh` antes de abrir el PR.

## Pendiente para un despliegue compartido

Alertas sobre los SLO que declara `docs/SCOPE.md` («Operación»), on-call, canary con rollback automático, y ventana de congelamiento en el cierre de mes de los despachos: #333.
