# ADR-0000 · Cómo está construido hoy, y por qué

- **Fecha:** 2026-09-25
- **Estado:** registro del punto de partida, no una decisión nueva. Lo pide el paquete de arranque de la guía de implementación (Fase 6).
- **Cómo se escribió:** un agente, desde el código, el historial, `docs/HISTORY.md` y la wiki. Lo que nadie ha confirmado va marcado `[inferido]`, y la entrevista que lo confirma es #337.

## De dónde viene

El repositorio nació como `accounting-core`: un servidor REST, y hasta T14b también GraphQL, con la contabilidad de partida doble sobre PostgreSQL. Encima creció el producto actual, **mnemosine**, un agente contable que se usa desde la terminal. El motor sigue ahí y es el que el agente opera, pero el producto es el CLI (`README.md`). Por eso el repo se llama `Accounting`, el paquete `accounting-core` y el binario `mnemosine`.

## Decisiones de construcción que ya están tomadas

| Decisión | Por qué | Dónde se sostiene |
|---|---|---|
| TypeScript estricto sobre Node 20 | Un error de tipo en importes o fechas es dinero mal contado | `tsconfig.json`, CI «Tipos» |
| PostgreSQL como dueño único del mayor, con RLS forzada por inquilino | El aislamiento entre despachos no puede depender de que cada consulta se acuerde del filtro | `src/database/rls-policies.sql`, invariante 4 |
| Una sola puerta al mayor | Todo asiento pasa por el mismo cuadre, periodo abierto y rastro de auditoría | `src/services/accounting/posting.ts` |
| La IA propone, una persona aprueba | Un modelo puede equivocarse; el mayor y los sistemas externos no admiten «casi» | `src/ai/floor.ts`, `ai_drafts`, `ai_external_ops`, invariante 1 |
| Migraciones inmutables | Una migración aplicada es historia de las bases de los despachos | `src/database/migrations/`, `CODEOWNERS` |
| El plan como código | Una cifra escrita en un documento envejece; un criterio ejecutable no | `src/plan/criterios.ts`, `npm run plan:status` |
| Express 4, no 5 `[inferido]` | El porqué que da `package.json` («_overrides_por_que») es la integración de Apollo en `src/index.ts`, y esa integración ya no está ahí desde que salió GraphQL. La razón hay que reconfirmarla | `package.json` |
| Español para el contador, inglés para la máquina | Quien lee decide el idioma; lo que identifica no se traduce | `AGENTS.md`, «El idioma» |

## Lo frágil `[inferido]`

- `src/plan/criterios.ts`: un solo archivo de más de 14 000 líneas donde chocan casi todos los PRs (#294).
- Los archivos de 1 000 líneas o más que lista `docs/REPO_MAP.md`.
- Configuración sin consumidor: `PLAID_*` y `ELASTICSEARCH_URL` se leen y nadie las usa (`docs/platform/inventory.md`).
- El anclaje en blockchain después del posteo existe como orquestador, y hoy está simulado (`docs/wiki/Arquitectura.md`).

## Lo que no se sabe todavía

- SLO, retención y cifrado exigidos por dato: preguntas abiertas en `docs/SCOPE.md`.
- ~~Si este repo o `accounting-manager` es la fuente de verdad de lo que llega a Contalink~~: cada uno de lo suyo, con un solo escritor por compañía de Contalink (ADR-0004, que sustituye al 0003).
- Cuándo hay primer despliegue compartido: #333.
