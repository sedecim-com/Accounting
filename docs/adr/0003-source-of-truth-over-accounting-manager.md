# ADR-0003 · Accounting es la fuente de verdad de la contabilidad; `accounting-manager` se apaga y se archiva

- **Fecha:** 2026-09-26
- **Estado:** sustituida por el [ADR-0004](0004-coexistence-with-accounting-manager.md) (2026-09-26). La auditoría del código de `accounting-manager` mostró que no es una variante de este repo, y que apagarlo quitaría un flujo de producción sin reemplazo. La lista de apagado de abajo no se ejecuta.
- **Resuelve:** #342. Deja fuera de vigor la pregunta abierta de `docs/SCOPE.md` y la relación «variante» de `catalog-info.yaml`.

## Contexto

El ADR-0002 encontró que `sedecim-com/accounting-manager` hace una parte de lo que hace este repo: recibe XML de CFDI, genera pólizas y las envía a Contalink. Si los dos escriben pólizas para la misma entidad, la misma factura se contabiliza dos veces y ninguno lo ve (`docs/platform/inventory.md`).

**Un hecho cambia el orden de las cosas: `accounting-manager` está desplegado en producción.**

- Tiene tres workflows de despliegue: `dev-deploy.yaml`, `uat-deploy.yaml` y `production-deploy.yaml`, este último sobre cada push a `main`.
- Su último merge a `main` fue el 2026-09-02.
- Este repo, en cambio, no tiene despliegue compartido (`lifecycle: experimental`, #333).

Archivar un repo lo deja en sólo lectura, pero **no apaga lo que ya corre**: el servicio seguiría escribiendo en Contalink, y ya nadie podría corregirlo ni redesplegarlo.

## Decisión

1. **Este repo es la fuente de verdad** de la contabilidad: la póliza, el mayor y lo que se envía a sistemas contables externos, Contalink incluido.
2. **`accounting-manager` se apaga y después se archiva,** en ese orden, con la lista de abajo.
3. Lo que valga la pena de `accounting-manager` no se copia. Si falta algo, entra aquí como adaptador, por el ciclo de `docs/prd/README.md` y con pruebas.

**Descartado:**

- **Archivar primero.** Deja un servicio de producción huérfano que sigue escribiendo en Contalink.
- **Mantener los dos con una regla de reparto por entidad.** Dos escritores del mismo libro externo es justo el riesgo que se quiere eliminar.

## Lista de apagado

La ejecuta el equipo con acceso a la infraestructura y a GitHub; ningún agente la hace. Se sigue en #342.

- [ ] **Quién lo usa.** Identificar quién llama hoy a `POST /policies/manual` en producción y para qué entidades.
- [ ] **Con qué se reemplaza.** Para cada entidad, el flujo pasa a mnemosine (`mnemosine ingest` y el envío a Contalink por la cola revisada `ai_external_ops`) o se hace a mano mientras este repo no tenga despliegue (#333). Nadie se queda sin camino sin saberlo.
- [ ] **Respaldo de datos.** Respaldar la base MySQL de `accounting-manager`, con las pólizas que generó, y conservarla el plazo que exige el CFF para la contabilidad.
- [ ] **Apagar.** Bajar el servicio en dev, uat y producción.
- [ ] **Revocar credenciales.** La llave de Contalink del servicio (`API_KEY`), y sus credenciales de AWS y de base. Revocar la llave es lo único que garantiza que no quede nada escribiendo en Contalink.
- [ ] **Fusionar el aviso.** Fusionar en `accounting-manager` el PR que quita los workflows de despliegue y pone el aviso en el README. Como el mismo commit borra los workflows, fusionarlo no dispara ningún despliegue.
- [ ] **Archivar.** Settings → Danger Zone → *Archive this repository*.
- [ ] **Cerrar aquí.** En `catalog-info.yaml`, `related_repos` pasa a `relation: archivado`; se actualiza `docs/platform/inventory.md` y se cierra #342.

## Consecuencias

- Hasta que este repo tenga despliegue, **apagar `accounting-manager` puede quitarle a alguien un flujo automático**. Por eso la lista empieza por quién lo usa, y no por el botón de archivar.
- Todo lo que toque Contalink o la generación de pólizas desde CFDI se construye aquí.
