# Propuesta: `mnemosine init` — configuración guiada de todos los proveedores

> Estado: propuesta de diseño (no implementado). Compone con lo ya construido:
> `doctor`, `providers`, `sat cred`, `memoria`, `onboard`, `outbox`, RLS por tenant.

## 1. Filosofía (buenas prácticas tomadas de Hermes Agent)

Del onboarding de Hermes Agent heredamos seis principios:

1. **Wizard interactivo por secciones, re-ejecutable e idempotente** — `init` se
   puede correr N veces; detecta lo ya configurado y lo muestra como
   `✔ Conectado` (los badges del panel de Hermes), solo pregunta lo que falta.
2. **Mínimo para arrancar, lo demás diferible** — 3 secciones obligatorias
   (infraestructura, entidad, proveedor de IA); todo lo demás es `[s]altar
   por ahora` y queda visible como `○ pendiente` en `init --status`.
3. **Los secretos nunca tocan el archivo de config** — el config nombra
   variables (`api_key_env`) o comandos (`api_key_cmd`, patrón credential
   helper); los valores viven en `.env`/keychain/vault, y las credenciales
   SAT van cifradas a BD con auditoría (ya existe: `sat cred`).
4. **Cada sección se PRUEBA en vivo al configurarla** — no "guardé tu key"
   sino "guardé tu key y Contalink respondió la balanza de agosto". La misma
   prueba es la que `doctor` re-ejecuta después.
5. **"Get a key" con deep-links** — cada prompt de credencial imprime la URL
   exacta donde obtenerla (portal.nousresearch.com, Contalink → Configuración
   API, aistudio.google.com, etc.).
6. **Modo no-interactivo completo** — `init --yes` + flags/env para CI y
   aprovisionamiento por script; el wizard es azúcar sobre operaciones puras.

## 2. Relación init ↔ doctor

- `init` = **configurar** (escribe). `doctor` = **verificar** (lee). 
- Cada sección implementa la interfaz común `SetupSection { id, title,
  status(), configure(rl), verify() }`; `doctor` consume los mismos
  `verify()` — una sola fuente de verdad para "¿esto funciona?".
- `init` cierra ejecutando `doctor` completo y mostrando el tablero final.

## 3. Flujo por secciones

Cada sección sigue el mismo ritmo: **detectar → mostrar estado → configurar →
probar en vivo → badge**.

### S0 · Infraestructura (obligatoria)
- `DATABASE_URL` (probar conexión), migraciones (`npm run migrate` ofrecido si
  faltan), escritura de `.env` si no existe (a partir de `.env.example`).

### S1 · Identidad: tenant y entidad legal (obligatoria)
- Elegir tenant existente o crear (tenant → organización → entidad legal con
  RFC, país, moneda, norma contable NIF/GAAP) + año/periodos fiscales del
  ejercicio en curso.
- Fija `MNEMOSINE_TENANT` en `.env` (aislamiento RLS desde el arranque).

### S2 · Usuarios, roles y acceso
- Usuario administrador inicial (email + password hasheado) si no existe.
- Roles propuestos (JSONB ya soportado por `users.roles/permissions`):
  | Rol | review | outbox | onboard | sat cred | dudas | solo lectura |
  |---|---|---|---|---|---|---|
  | `owner` | ✔ | ✔ | ✔ | ✔ | ✔ | — |
  | `contador` | ✔ | ✔ | — | — | ✔ | — |
  | `revisor` | ✔ | — | — | — | ✔ | — |
  | `auditor` | — | — | — | — | — | ✔ |
- El wizard ofrece alta de usuarios adicionales con rol; los comandos que
  atribuyen (`review`, `outbox`, `dudas`) ya exigen identidad — init define
  QUIÉNES existen. (Proveedor de autenticación externo — OIDC/Auth0 — queda
  como sección diferible S2b: hoy el API usa JWT propio; el wizard registra
  el issuer/audience y deja el mapping de claims→roles documentado.)

### S3 · Proveedor de IA (obligatoria)
- Menú con los 12 perfiles integrados + estado de credencial (lo que ya lista
  `providers`), en tres sabores como Hermes:
  a) **API key** (anthropic, gemini, grok, minimax, qwen, openrouter…): pegar
     key → escribe la env correspondiente en `.env`.
  b) **Local** (ollama): detectar server + listar modelos instalados y elegir.
  c) **Suscripción vía OAuth**: registrar `api_key_cmd` (token del Codex CLI,
     `op read`…) o apuntar al broker `hermes-agent`/`openclaw` local.
- Prueba en vivo doble: (1) chat mínimo, (2) **sonda de tool-calling** (una
  llamada con una tool trivial) — un proveedor que no soporta tools se marca
  `⚠ solo chat` y el wizard sugiere `tools:false` o cambiar de perfil.
- Elegir `default_provider` (escribe `mnemosine.config.json`) y opcionalmente
  un perfil de respaldo.

### S4 · Fiscal MX: credenciales SAT + PACs (diferible; obligatoria si CFDI)
- CSD/e.firma vía el flujo ya existente `sat cred add` (cifrado en BD,
  status/audit/revoke); init solo lo invoca y verifica `sat cred status`.
- PACs de timbrado: pegar credenciales Finkok / SW Sapien / Edicom (las que
  se tengan) y ordenar la cadena de failover (pac_primary/secondary/tertiary
  ya soportado por el registry); prueba en sandbox si el PAC lo ofrece.

### S5 · Plataforma contable actual (diferible)
- Para cada sistema externo registrado (hoy: contalink): `CONTALINK_API_KEY`
  (+ base URL si difiere) → prueba en vivo con un pull de balanza.
- Si conecta, ofrecer el siguiente paso natural: «¿Importar la contabilidad
  ahora? → corre `mnemosine onboard --provider contalink --dry-run`».

### S6 · Memoria (diferible)
- Proveedor de precedentes: **pg local (default, ya implementado)**; opciones
  futuras declaradas en config (`memory.provider`): archivo exportable /
  compartido entre entidades del tenant.
- Políticas: ¿los precedentes expiran? ¿quién puede `memoria enseña`?
- Siembra inicial: ofrecer cargar criterios del despacho desde un .md/.csv
  (cada línea → `memoria enseña`).

### S7 · Políticas de operación (diferible)
- Umbrales de ingesta (`ingest.auto_post*` del config), revisor por defecto,
  idioma/tono de respuestas si se quisiera.

### S8 · Cierre
- `doctor` completo + tablero de badges + "siguientes pasos" contextuales
  (p. ej. «tienes 0 precedentes: corre `memoria enseña`», «Contalink conectado
  sin importar: corre `onboard`»).

## 4. Dónde vive cada cosa (tabla de almacenamiento)

| Dato | Dónde | Por qué |
|---|---|---|
| Secretos (API keys, tokens) | `.env` (o keychain vía `api_key_cmd`) | nunca en config versionable |
| CSD/e.firma SAT | BD cifrada (`fiscal-credentials`) con auditoría | material sensible + trazabilidad |
| Perfiles IA, default, umbrales | `mnemosine.config.json` | versionable, sin secretos |
| Tenant/entidad/usuarios/roles | BD (RLS) | datos del dominio |
| PAC failover, integraciones | BD (registry por tenant) | por-tenant, cifrado |

## 5. Modos de ejecución

```bash
mnemosine init                 # wizard completo (solo pregunta lo que falta)
mnemosine init --status        # tablero de badges, no configura nada
mnemosine init --section ia    # re-configurar una sección puntual
mnemosine init --yes \
  --provider gemini --entity "Despacho X" ...   # no-interactivo (CI)
```

## 6. Seguridad transversal

- Input de secretos con eco oculto; jamás se imprimen ni van a logs.
- Todo lo que escribe init queda atribuido (quién/cuándo) igual que review.
- `init` corre con el tenant fijado ANTES de cualquier consulta (RLS).
- Las pruebas en vivo usan operaciones de solo lectura.

## 7. Boceto de implementación

```ts
interface SetupSection {
  id: 'infra'|'entidad'|'usuarios'|'ia'|'fiscal'|'contabilidad'|'memoria'|'politicas';
  title: string;
  required: boolean;
  status(): Promise<'ok'|'partial'|'missing'>;     // para badges/--status
  configure(rl: Interface, opts: Flags): Promise<void>;
  verify(): Promise<CheckResult[]>;                 // compartido con doctor
}
```
- `src/cli/init-command.ts` orquesta `SECTIONS: SetupSection[]`.
- Reutiliza: resolveProfile/providers, sat-commands, registry de integraciones,
  onboarding-service, memoria. Nada de lógica nueva de dominio: init solo
  detecta, pregunta, escribe `.env`/config/BD y delega las pruebas a verify().
- Estimación: S0-S3 en una iteración (lo obligatorio), S4-S7 en la segunda.
