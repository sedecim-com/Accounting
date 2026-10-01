# ADR-0007 · Identidad de plataforma: issuer Cognito, tenant por `external_ref`, entidad por RFC, prefijo `/mnemosine/`

- **Fecha:** 2026-09-30
- **Estado:** aceptada por el owner (@vic2099), en [#371](https://github.com/sedecim-com/Accounting/issues/371) (MNE-001-106, comentario del 2026-09-30).
- **Numeración:** el 0007 estaba reservado para esta decisión ([ADR-0008](0008-develop-release-branches.md)); el 0005 lo ocupó la decisión de TypeScript.
- **Relacionada:** [ADR-0002](0002-platform-coordination.md) (coordinación de plataforma) y [ADR-0004](0004-coexistence-with-accounting-manager.md) (el RFC como llave natural).

## Contexto

La revisión de armonía del 2026-09-26 ([`docs/platform/harmony-review.md`](../platform/harmony-review.md)) encontró cómo autentica la plataforma Sedecim:

- El gateway nginx hace `auth_request` a `authentication-server-api`, que valida el JWT de Cognito, consulta roles y tenant en `acceso-rbac` y pasa a los servicios un header `x-jwt-payload`: un JSON **sin firma** en el que los servicios confían.
- `authentication-server-api` **no es un issuer OIDC**, y su `POST /internal/token` firma cualquier payload sin autenticar al llamador. El inventario lo nombraba por error como contraparte OIDC.
- El tenant de `acceso-rbac` (uuid, subdomain, schema) corresponde al tenant (despacho) de Accounting; la `organization` con RFC de `acceso-organizations` corresponde a la `entity`. Los roles de acceso son globales y no se relacionan todavía con permisos.
- El bloque `AUTH_OIDC_*` de Accounting ya acepta access tokens de Cognito con `AUTH_OIDC_PROVIDER=cognito` (#369, MNE-001-104).

## Decisión

1. **Issuer.** El user pool de Cognito de la plataforma de Acceso, configurado por el bloque `AUTH_OIDC_*`. No se usa `authentication-server-api` como issuer ni su JWKS.
2. **Autenticación.** Accounting sigue autenticando él mismo (API keys, OIDC y RLS). **No confía en `x-jwt-payload`.** Es una divergencia consciente de la norma de plataforma «el servicio no autentica»: un header sin firma que cualquier proceso dentro de la red puede fabricar no puede ser la frontera de un sistema que escribe un mayor contable, y el RLS de Accounting necesita un sujeto verificado por el propio servicio. El costo es validar el JWT dos veces (gateway y servicio); se acepta.
3. **Tenant.** No sale del token. Se resuelve por `tenants.external_ref` = uuid del tenant de `acceso-rbac` cuando el token trae el claim de tenant de Acceso; `AUTH_OIDC_TENANT_ID` sigue como modo de un solo tenant. Un claim sin coincidencia se rechaza; nunca se crea un tenant al vuelo. Migración y lector: MNE-001-264.
4. **Entidad.** La organization de Acceso se resuelve a la `entity` del tenant por **RFC**, la misma llave natural del ADR-0004. Sin coincidencia, o con dos, se rechaza con mensaje. MNE-001-265.
5. **Roles.** Los grupos del token (`cognito:groups`) son informativos. Se mapean a permisos de Accounting sólo por configuración; sin mapeo, un grupo no otorga nada, y un grupo desconocido nunca amplía permisos. MNE-001-266.
6. **Prefijo del gateway.** `/mnemosine/` y la variable `MNEMOSINE_SERVICE_URL`. `/accounting` ya es de `accounting-manager`.

**Lo que se descartó:**

- Confiar en `x-jwt-payload`: más simple, pero deja la identidad en manos de la red y no de una firma.
- Tomar el tenant del token: acopla el esquema de tenants de Accounting al de Acceso y hace que un claim mal emitido elija los datos de otro despacho.
- Resolver la entidad por nombre o por id de organization: el RFC es la llave que ya comparten Contalink, `accounting-manager` y el SAT.

## Consecuencias

- Este ADR fija la decisión; no cambia código. El código llega en MNE-001-264, 265 y 266, cada uno con su issue y su prueba.
- Hasta entonces, el tenant sale de `AUTH_OIDC_TENANT_ID` y los grupos del token no otorgan permisos.
- El aislamiento por tenant y entidad sigue en el SQL (invariante 4 de `AGENTS.md`); esta decisión sólo dice cómo se elige el alcance, no lo afloja.
- Se revisa si la plataforma publica un issuer OIDC propio o firma el `x-jwt-payload`: el punto 2 podría relajarse en otro ADR que sustituya a éste.
