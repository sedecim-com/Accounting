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

## Reparto de rangos del plan de cierre

Catorce paquetes de trabajo van a crear migraciones. Para que no choquen, cada
etapa tiene su rango reservado. Última migración existente: **030**.

| Etapa | Rango | Paquetes |
|---|---|---|
| E0 · Cimientos | 031–034 | E0.0, E0.1, E0.2, E0.3 |
| E1 · Contabilidad | 035–039 | E1.1, E1.2, E1.3, E1.4 |
| E2 · Perímetro | 040–042 | E2.1, E2.2 |
| E3 · Fiscal | 043–046 | E3.1, E3.2 |
| E4 · Ciclos | 047–050 | E4.1, E4.2 |
| E5 · Agente | 051–053 | E5.1 |

Si un rango se agota, se toma del siguiente libre por encima de 053 y se anota aquí.
