# mnemosine

Un agente contable que se usa desde la terminal. Lleva contabilidad de partida
doble sobre PostgreSQL —catálogo, pólizas, clientes y proveedores, bancos,
periodos, reportes— con el cumplimiento fiscal mexicano (CFDI 4.0, catálogos del
SAT, IVA sobre base de flujo) dentro del motor, no encima de él.

Lo que lo distingue no es que un modelo hable de contabilidad: es **quién puede
escribir**. La IA nunca postea el mayor ni toca un sistema externo. Propone en
dos tiempos —`ai_drafts` para los asientos, `ai_external_ops` para todo lo que
sale al mundo (timbrar, enviar, pagar)— y una persona aprueba. La aprobación es
un registro con integridad, no una bandera; los límites que la gobiernan viven
en `src/ai/floor.ts` y sólo se combinan con `Math.min`, así que ninguna
configuración, política guardada ni bandera futura puede subirlos.

El repositorio se llama `Accounting` y el paquete `accounting-core` por su
origen: un servidor REST/GraphQL. Ese motor sigue ahí y es el que el agente
opera, pero el producto es el CLI.

---

## En qué estado está

Este proyecto no publica una tabla de estado escrita a mano. La pregunta se le
hace al código:

```bash
npm run plan:status
```

Ese comando evalúa criterios ejecutables (`src/plan/criterios.ts`) contra el
árbol y decide el estado de cada paquete de trabajo. Responde cuántos paquetes
tienen todos sus criterios en verde, y para los restantes imprime la razón
exacta de su rojo. La CI corre `plan:status --exigir=...` sobre los ya cerrados:
es un trinquete contra el retroceso, no un informe. Un paquete que resulta ser
un falso verde se **reabre** en el mismo commit que lo quita de esa lista, con
su porqué.

Lo mismo con la superficie del CLI: el número de comandos lo cuenta
`npm run catalogo:estado` sobre el árbol del binario y lo escribe en
[`docs/cli-command-catalog.md`](docs/cli-command-catalog.md); la CI verifica que
el bloque esté al día.

Las cifras de abajo llevan commit a propósito. Este archivo no es un marcador —
lo son los dos comandos— y una cifra escrita a mano caduca en cuanto alguien
empuja. Si no coinciden con lo que responde tu árbol, gana el comando.

| Al commit `29d0b35` | |
|---|---:|
| Paquetes con todos sus criterios en verde | **9** de 15 |
| Comandos que el binario ejecuta | **134** en 45 familias |
| Filas del catálogo ya invocables | **119** de 1 624 |
| Fase 1 —el compromiso— | **108** de 379 |
| Migraciones · tablas | **52** · 99 |
| Pruebas unitarias | **2 205** en 143 archivos |

### Lo que todavía no es lo que parece

Se dice aquí porque descubrirlo leyendo el código sería peor:

- **La atestación en blockchain está simulada.** Todos los adaptadores de cadena
  declaran `simulado = true` (`src/services/blockchain/chain-adapters.ts`,
  `zkverify-client.ts`): no hay transacción en ninguna red. Por eso la
  verificación pública está **apagada por omisión** —se enciende con
  `PUBLIC_VERIFICATION_ENABLED=true`— y, aun encendida, cada endpoint se niega a
  servir una fila simulada.
- **El timbrado con PAC es real en un solo proveedor, y ese no se puede
  configurar.** De los cuatro adaptadores, tres (Finkok, Edicom, SW Sapien) se
  declaran simulados y un cerrojo les impide timbrar fuera de sandbox; sólo
  Sovos/Reachcore declara `simulado = false`. Pero
  `src/services/integrations/index.ts:12-15` registra únicamente Stripe, Conekta,
  SendGrid y S3: **ningún adaptador de PAC entra al registro**, así que
  configurar cualquiera de ellos por `/v1/integrations/:provider` muere en
  `PROVIDER_NOT_FOUND`. Contratar un PAC es una decisión de negocio; poder
  intentarlo es un renglón que falta.
- **La descarga masiva del SAT no existe.** Ni SOAP, ni ZIP, ni comando. Un
  despacho no puede afirmar completitud de CFDI recibidos desde aquí.
- **La nómina reporta ceros en 941/940.** `paycheck_taxes`,
  `employer_tax_liabilities` y `garnishments` se leen y ningún camino las
  escribe.
- **GraphQL está desmontado por omisión** (`GRAPHQL_ENABLED=true` lo devuelve).
  Sus mutaciones ya exigen el mismo permiso que su ruta REST, y una compuerta
  contrasta el esquema al cargar: una mutación declarada que no esté
  implementada-con-permiso o listada como ausente impide cargar los
  resolutores. Sigue apagado por lo que falta: vive fuera del prefijo auditado
  `/v1` —no deja la fila de PETICIÓN en `audit_log`, aunque el hecho contable
  sí queda registrado por los servicios— y diez de sus quince mutaciones son
  contrato sin código.
- De los 151 manejadores REST, **7 están retirados** y lanzan
  `NotImplementedError` en vez de fingir que hicieron algo.
- **No hay respaldo ni restauración.** Ni una línea en todo el árbol. Y lo que
  el proyecto hizo bien lo empeora: desde la migración 041 el mayor es
  físicamente inmutable y `audit_log` es de sólo agregar, así que un error de
  datos **no se puede reparar a mano**. Quien opere esto tiene que resolver su
  propio respaldo de PostgreSQL mientras el proyecto no lo traiga. Es la brecha
  abierta más grande y por eso está aquí arriba y no en una nota al pie.
- **El sueldo bruto de la nómina cae en la cuenta equivocada.** Dos catálogos
  semilla reclaman el código `5200`: los roles fiscales lo crean como
  *Devoluciones y Descuentos sobre Compras*
  (`src/services/xml-ingestion/account-roles-seed.ts:126`) y el mapeo de nómina,
  que corre después (`src/services/accounting/entity-accounting.ts:77`), salta la
  creación porque el código ya existe y apunta `wages_expense` a esa misma
  cuenta. No truena: la guarda es por código y la colisión es de significado.

---

## Arranque rápido

**Requisitos:** Node ≥ 20 (`engines` lo exige), PostgreSQL 15. Redis es opcional
(caché y limitador; el CLI no lo necesita).

```bash
git clone https://github.com/sedecim-com/Accounting.git
cd Accounting
npm ci

cp .env.example .env
# Como mínimo: DATABASE_URL y MIGRATION_DATABASE_URL.
# JWT_SECRET y ENCRYPTION_KEY pueden ir vacíos en desarrollo: el arranque se
# NIEGA a correr con los valores de desarrollo bajo NODE_ENV=production.

createdb mnemosine
npm run migrate      # 52 migraciones; reaplica rls-policies.sql al final
npm run seed         # tenant, entidad, catálogo y periodos de demostración
```

El binario no está instalado como comando global: se invoca por npm.

```bash
npm run mnemosine -- init      # asistente: infraestructura, entidad, usuarios, proveedor de IA
npm run mnemosine -- doctor    # base, migraciones, proveedor, credenciales, aislamiento
npm run mnemosine -- chat      # la sesión conversacional
```

Con RLS activo cada comando necesita saber sobre qué inquilino trabaja: pon
`MNEMOSINE_TENANT` en `.env` o pasa `-T <uuid>`.

El primer ciclo real es corto:

```bash
npm run mnemosine -- ingest facturas/*.xml   # CFDI → reglas → clasificación → BORRADORES
npm run mnemosine -- drafts                  # qué propuso la IA
npm run mnemosine -- review                  # aprobar (postea de verdad) o rechazar
npm run mnemosine -- report trial-balance    # y ver el efecto
```

La referencia exacta de comandos y banderas —generada del propio programa, nunca
a mano— está en [`src/ai/docs/cli-reference.md`](src/ai/docs/cli-reference.md).

---

## El proveedor del modelo

mnemosine no está casado con un proveedor. Hay dos motores de sesión: el nativo
de Anthropic (`MnemosineAgent`, con caché de prompt y bloques de razonamiento) y
un adaptador OpenAI-compatible (`OpenAiCompatSession`) que sirve a todo lo demás.
Vienen once perfiles predefinidos —anthropic, openai, gemini, grok, qwen,
minimax, openrouter, copilot, hermes y dos pasarelas locales (`ollama` y
`openclaw`)— y se añaden más en el archivo de configuración
(`src/ai/providers/config.ts`).

**Funciona con modelos locales y sin API key.** El `mnemosine.config.json` del
repositorio ya viene apuntando a Ollama:

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

El modelo local debe soportar *tool calling*: sin herramientas el agente puede
conversar, pero no consultar el mayor ni dejar un borrador.

**Los secretos nunca van en el archivo de configuración.** El perfil sólo
*nombra* de dónde sale la credencial: `api_key_env` (una variable de entorno) o
`api_key_cmd` (un comando que la imprime — un gestor de secretos, o el token de
una suscripción ya autenticada). El esquema es estricto y falla ruidosamente
ante una llave desconocida: un `api_key_evn` mal tecleado caería en los valores
por omisión, que es el peor modo de fallo para un archivo que gobierna
credenciales.

Precedencia: `--provider` > `MNEMOSINE_PROVIDER` > `default_provider` >
`anthropic`. `npm run mnemosine -- providers` lista lo que hay configurado;
`status` sondea cuál responde de verdad.

Dos avisos que el propio catálogo lleva escritos: `hermes-agent` y `openclaw`
corren **sus propias** herramientas del lado del servidor y no devuelven las
llamadas al cliente — por ese canal las herramientas contables no se invocan.

---

## Arquitectura

Cinco capas, de fuera hacia dentro:

1. **CLI (`src/cli/`)** — comandos de commander sobre un núcleo compartido
   (`src/cli/kernel/`) que impone lo transversal: declaración de riesgo por
   comando, puerta de confirmación en las mutaciones, alcance por entidad,
   formato de salida y códigos de salida.
2. **Agente (`src/ai/`)** — sesión, prompt de sistema, herramientas, compactación
   del historial, memoria de la firma (precedentes que el usuario puede corregir
   y borrar), *skills* de la firma con divulgación progresiva, trabajos
   programados, webhooks de entrada y una bitácora de uso y costo por llamada.
3. **Escrituras en dos tiempos** — `draft-service` (asientos) y `external-service`
   (bandeja de salida hacia sistemas externos), más `approval-policy` y el suelo
   inamovible de `floor.ts`.
4. **Servicios (`src/services/`)** — el motor: contabilidad y posteo, cierre de
   periodo, AP/AR, pagos, bancos, activos, nómina MX/USA, ingesta de CFDI,
   reportes, bóveda de credenciales fiscales, auditoría.
5. **Base (`src/database/`)** — 52 migraciones, 99 tablas, y las políticas de RLS
   que se reaplican después de cada migración.

Todas las escrituras físicas al mayor pasan por un único módulo
(`services/accounting/posting.ts`). El borrador aprobado no toma un atajo: crea
el asiento por `createJournalEntry`, con todas las validaciones del motor.

La API REST (`/v1`) sigue viva y auditada; el CLI y ella comparten servicios.
Los trabajos desatendidos —ingesta, tareas programadas— corren con una
superficie de herramientas **nombrada**, no con la completa, y sin la red de
seguridad conversacional: no hay nadie mirando el turno correctivo.

---

## Aislamiento entre inquilinos

No es un `WHERE` en TypeScript. Es *row-level security* de PostgreSQL:

- La aplicación conecta como `mnemosine_app`, un rol **sujeto a RLS** que sólo
  puede DML y no posee nada. `mnemosine_owner` posee el esquema y sólo lo usa
  `npm run migrate`. Ambos se crean con `scripts/provision-roles.sql`, que no es
  una migración porque los roles son objetos de nivel clúster.
- El contexto se abre con `enterTenant`, que emite
  `set_config('app.current_tenant', …, true)` sobre la conexión ya tomada —
  parametrizado, porque el inquilino viene de datos.
- `src/database/rls-policies.sql` es **idempotente y se reejecuta después de
  cada migración**. La razón es una cicatriz: una migración de endurecimiento
  protege lo que existe cuando corre, y `ai_external_ops` nació nueve minutos
  después, sin política y en silencio.
- Cruzar la frontera de entidad devuelve **404, siempre**. Un 403 confirmaría
  que el recurso existe.
- La CI tiene un job aparte para esto, y conecta como `mnemosine_app` a
  propósito: corriendo como superusuario la RLS no filtra nada y una política
  ausente jamás se detectaría.

`src/config/index.ts` se niega a arrancar en producción con los secretos de
desarrollo, y el arranque comprueba que el rol no ignore RLS.

---

## Lo fiscal mexicano

Es la parte que no se puede improvisar y la razón de que el motor sea propio:

- **CFDI 4.0**: analizador, catálogos del SAT, validación, taxonomía contable y
  plan de posteo por comprobante. Lo que escribió un tercero —el XML— entra
  envuelto como no confiable: es dato, jamás instrucción.
- **IVA sobre base de flujo** (LIVA art. 1-B y art. 5 fr. III). El `MetodoPago`
  decide: en **PUE** el IVA se causa o acredita al emitir; en **PPD** no, y se
  estaciona en *IVA trasladado no cobrado* / *IVA pendiente de acreditar* hasta
  que llega el complemento de pago (REP), que lo mueve a las cuentas efectivas.
  La liga del REP con el documento original y la reclasificación existen como
  motor y como comando.
- **e.firma y CSD** en una bóveda cifrada, con bitácora de accesos; el material
  no se lee fuera de `withCredential`.
- **Timbrado** enrutado entre PAC con failover — con la limitación de simulación
  dicha arriba.
- **NIF mexicanas** e IFRS/NIIF viven como conocimiento consultable del agente
  en `src/ai/docs/`, no como prosa en el prompt: la sesión paga contexto sólo
  por lo que abre.

También hay nómina de EE. UU. y motor de impuestos por jurisdicción, en el
estado que `plan:status` declara.

---

## Pruebas

```bash
npm run typecheck        # tsc --noEmit sobre src/
npm run typecheck:tests
npm test                 # unitarias: 2 205 casos en 143 archivos
npm run test:integration # contra Postgres real: 28 archivos
```

La suite de integración crea y destruye una base efímera por corrida, por lo que
pide `TEST_ADMIN_DATABASE_URL` (un rol con `CREATE DATABASE`) y se niega a
arrancar sin ella. Corre en serie a propósito: varias pruebas cuentan filas.

`npm run lint` ya no es un adorno: corre ESLint 9 con información de tipos
(`eslint.config.mjs`) sobre `src/`, `tests/` y `scripts/`, y la CI lo exige. Los
errores rompen la compilación; las advertencias llevan trinquete
(`--max-warnings 1239`, congelado en lo medido) para que sólo puedan bajar.

---

## Cómo contribuir

Lee [CONTRIBUTING.md](CONTRIBUTING.md): están ahí el flujo, los invariantes de la
casa y por qué los mensajes de commit explican el *porqué* y no el diff.

En corto: un PR por idea, contra `main`, con **1 aprobación** y la CI en verde
—Tipos, Lint, Pruebas unitarias, Integración contra Postgres, Aislamiento por
inquilino y Estado del plan—. Un push nuevo invalida las aprobaciones
anteriores, y Copilot revisa cada PR automáticamente; su comentario es insumo,
no la aprobación que exige la regla. Si tu cambio cierra un paquete del plan,
añádelo a la lista `--exigir` de `.github/workflows/ci.yml` en el mismo commit;
si lo reabre, quítalo ahí mismo y di por qué.

Los comentarios y la documentación van en español. Nada de emoji, nada de
`feat:` ni `chore:`.

## Seguridad

Si encontraste una vulnerabilidad, **no abras un issue ni un PR con el arreglo**:
un diff público es la divulgación. El canal privado y las prioridades están en
[SECURITY.md](SECURITY.md).

## Licencia

Apache 2.0 — ver [LICENSE](LICENSE) y [NOTICE](NOTICE). No hace falta CLA: la
sección 5 de la propia licencia cubre las contribuciones.

## Más documentación

La **[wiki del repositorio](https://github.com/sedecim-com/Accounting/wiki)** es
el sitio largo: cómo funciona por dentro y por qué se decidió así. Este README
responde qué es y cómo arrancar; la wiki responde todo lo demás —arquitectura,
el modelo de autonomía del agente, el aislamiento por inquilino, lo fiscal
mexicano con ejemplos numéricos, el glosario para quien no es contador, y
solución de problemas—. Su fuente vive en
[`docs/wiki/`](docs/wiki/) y se publica desde ahí.

Dentro del repositorio:

- [`docs/cli-command-catalog.md`](docs/cli-command-catalog.md) — la superficie de
  comandos a la que se aspira, contrastada fila por fila contra el backend, con
  el recuento generado.
- [`src/ai/docs/cli-reference.md`](src/ai/docs/cli-reference.md) — la superficie
  exacta de hoy, generada del binario.
- [`docs/migraciones.md`](docs/migraciones.md) — numeración, rangos y los cuatro
  duplicados históricos que no se pueden renumerar.
- [`docs/pac-proveedores.md`](docs/pac-proveedores.md) — proveedores de timbrado.
- [`docs/plan-catalogo.md`](docs/plan-catalogo.md) — «Doce sprints o sesenta»: el
  modelo de coste por fila y el orden por flujos.
- [`docs/plan-cierre-brechas.md`](docs/plan-cierre-brechas.md) — las garantías
  heredadas, dispuestas partida por partida.
- [`docs/auditorias/`](docs/auditorias/) — las auditorías adversariales. La de
  agosto abrió con siete lentes; la de septiembre subió a doce y cada hallazgo
  mayor pasó por un escéptico con el encargo de refutarlo.
