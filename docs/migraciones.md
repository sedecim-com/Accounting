# Migraciones: numeración y reparto de rangos

## Regla

Cada migración lleva prefijo de tres dígitos. `npm run migrate` **falla** si dos
archivos comparten número (`assertNumeracionUnica` en `src/database/migrate.ts`),
y el test `tests/database/migration-numbering.spec.ts` lo fija.

## Duplicados históricos

Estos cuatro números quedaron duplicados antes de que existiera la guarda y **ya
están aplicados en bases desplegadas**. Renumerarlos rompería esas instalaciones,
así que se toleran de forma explícita:

| Número | Archivos |
|---|---|
| 012 | `012_ai_drafts_unique_source.sql`, `012_fix_mv_account_balance_summary.sql` |
| 014 | `014_ai_external_ops.sql`, `014_fiscal_credentials.sql`, `014_rls_tenant_isolation.sql` |
| 015 | `015_account_roles.sql`, `015_identities.sql` |
| 018 | `018_ai_sessions.sql`, `018_fix_account_roles_unique.sql` |

## El reparto de rangos, retirado

Aquí vivía una tabla que reservaba los números 031–053 por etapa del plan de
cierre («Última migración existente: **030**»). **Murió sin que nadie la
tocara**: las migraciones 031–037 las quemó el trabajo correctivo —auditorías,
bitácoras, la ligadura del REP, el etiquetado— y ninguna pertenecía a los
paquetes que los rangos reservaban. Una reserva que nadie consulta no
coordina: desinforma, porque promete un orden que el historial ya contradice.

La regla vigente es la simple:

- **Secuencial estricto.** El siguiente número es `max + 1` sobre lo que hay
  en `src/database/migrations/`. Hoy: **044** (la 043 es la última en el árbol).
- **La guarda decide, no este documento.** `assertNumeracionUnica` falla ante
  cualquier duplicado nuevo; los cuatro históricos de arriba son los únicos
  tolerados.
- **Dos sesiones que colisionen** en el mismo número lo descubren en el
  primer `npm run migrate` o en CI — que es más pronto y más fuerte que una
  tabla de reservas que había que recordar leer.
