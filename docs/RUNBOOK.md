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

- **Código:** revertir el PR en `main` y reinstalar. Mientras no haya `release`, no hay tag anterior al que volver (#338).
- **Esquema:** una migración nueva que deshace; una migración aplicada nunca se edita (`AGENTS.md`, «Límites»).
- **Datos contables:** no se borran. Un asiento equivocado se corrige con otro asiento; el mayor es inmutable por diseño.

## Apagar al agente

El agente nunca escribe el mayor ni sistemas externos, así que apagarlo no pierde datos. Todo lo pendiente queda en las colas `ai_drafts` y `ai_external_ops`.

- **En una instalación:** quitar la llave del proveedor de modelo (variables en `.env.example`). El trabajo sigue por el camino manual (#319).
- **Kill switch de los agentes que desarrollan el repo:** **pendiente** (#332).

## Secretos

- Nunca en el repo ni en el chat (invariante 7). Si uno aparece en el historial se considera comprometido: **primero se rota, después se limpia**.
- Las credenciales fiscales viven en la bóveda (`src/services/vault/`), cifradas.

## Pendiente para un despliegue compartido

Alertas, SLO (pregunta abierta en `docs/SCOPE.md`), on-call, canary con rollback automático, y ventana de congelamiento en el cierre de mes de los despachos: #333.
