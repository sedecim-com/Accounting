# ADR-0004 · `accounting-manager` y este repo conviven: un solo escritor por compañía de Contalink

- **Fecha:** 2026-09-26
- **Estado:** aceptada por el owner (@vic2099).
- **Sustituye:** el [ADR-0003](0003-source-of-truth-over-accounting-manager.md), que ordenaba apagar y archivar `accounting-manager`.
- **Resuelve:** #342, replanteada. La llave atada a la entidad se sigue en #357.

## Contexto

El ADR-0003 se decidió leyendo el README de `accounting-manager` y lo tomó por una variante de este repo. Después se auditó su código en `main@35ccdae`, con tres jueces independientes (producto, arquitectura y costo del cambio) y tres intentos de refutar el resultado. Salió otra cosa.

**Qué es `accounting-manager`.** Es el contabilizador de las comisiones que Grupo Promessa paga a sus agentes de seguros.

- El back office de `promessa.mx` manda un lote de CFDI de agentes (RESICO 626 y 612) a `POST /accounting/policies/manual`, publicada en `api-gateway`.
- El servicio lee los XML de S3 y arma dos pólizas: la de pasivo y la de cancelación del pasivo. Usa subcuentas por agente y por plaza (Tamaulipas y Chihuahua) y paga desde Banorte.
- Las publica en una sola compañía de Contalink con `API_CONTALINK_KEY`.
- Está en producción: despliega en dev, uat y producción, y su último merge a `main` fue el 2026-09-02.

**Qué es este repo.** Contabilidad completa para despachos, multiinquilino, con mayor propio. La IA propone y una persona aprueba. Contalink es un sistema externo: se lee para migrar y comparar balanza, y se escribe sólo por la cola revisada `ai_external_ops`.

**Comparten técnica, no trabajo.** Los dos leen CFDI y arman pólizas, pero para otro usuario, en otro libro y con la regla de aprobación contraria: allá nadie revisa póliza por póliza, aquí nada se escribe sin revisión.

**Este repo no puede sustituirlo hoy:**

- no tiene despliegue (#333);
- su `ingest` no lee de S3 (el adaptador de almacenamiento S3 existe, pero la ingesta no lo usa);
- no crea subcuentas por agente;
- no valida retenciones por régimen (#309);
- cada escritura externa espera a una persona, que es lo contrario de un contabilizador de un botón.

Apagarlo quitaría a Promessa un flujo de producción sin reemplazo.

**Qué dijo mal el ADR-0003:**

- Tomó a `accounting-manager` por una variante de este repo.
- Descartó el reparto por entidad porque «dos escritores del mismo libro externo» es el riesgo. Pero los dos sólo escriben el mismo libro si este repo carga la llave de esa compañía, y hoy no la tiene.
- Su reemplazo (`mnemosine ingest` más `ai_external_ops`) no existe para este flujo.
- Su lista de apagado nombra una llave (`API_KEY`) y una ruta (`POST /policies/manual`) equivocadas, y no quita la ruta del gateway.

**Confianza media.** Faltan los logs del gateway y las fechas de las últimas filas de la tabla `xmls` para probar que se usa hoy.

## Decisión

1. **Los dos repos se justifican y conviven.**
   - Este repo es la fuente de verdad de su propio mayor.
   - `accounting-manager` lo es de las comisiones de agentes en la compañía de Contalink de Grupo Promessa.
2. **Regla de frontera: un solo escritor por compañía de Contalink, identificada por RFC.** `accounting-manager` es el único que escribe en la compañía de Promessa, y sólo comisiones de agentes. Este repo puede leerla, pero no escribir en ella.
3. **La llave de Contalink de este repo se ata a una entidad y a su RFC** (#357). Hoy es una `CONTALINK_API_KEY` global del proceso (`src/services/integrations/accounting/registry.ts`) y no puede cumplir la regla del punto 2.
4. **Si Promessa llegara a ser una entidad de este repo,** el cambio de escritor lo decide otro ADR y va en este orden:
   1. Se revoca `API_CONTALINK_KEY` de `accounting-manager` (secret `secrets`, junto a `CONTALINK_API_URL`).
   2. Se quita la location `/accounting/policies/manual` de `api-gateway` en dev, uat y producción.
   3. Sólo entonces este repo recibe una credencial atada a esa entidad y a ese RFC.
5. **sedecim-com/accounting-manager#99** (aviso de retiro y borrado de los workflows de despliegue) **se cierra sin fusionar.**

**Descartado:**

- **Mantener el ADR-0003.** Apaga producción sin reemplazo. Y construir el reemplazo aquí exigiría un camino de CFDI a póliza sin revisión humana, contra el invariante de este producto.
- **Traer el código de `accounting-manager` a este repo.** Otro stack y otro usuario. Metería un contabilizador desatendido en un producto cuya regla es la aprobación humana.

## Consecuencias

- `catalog-info.yaml`: `related_repos` pasa a `relation: coexiste`. Se corrigen `docs/platform/inventory.md`, `docs/SCOPE.md`, `AGENTS.md`, `README.md`, `docs/ARCHITECTURE.md` y `docs/prd/README.md`.
- La auditoría dejó 23 defectos confirmados en `accounting-manager`. Cuatro son altos: no es idempotente, empareja XML por índice, su ruta no tiene autenticación y escribe a medias si algo falla. Se atienden en aquel repo, no en este.
  - El owner ya eligió autenticar la ruta con `auth_request` del gateway.
  - Dos decisiones quedan como variables de configuración, con estos valores por omisión:
    - el pago se registra desde el movimiento bancario real (`desde_banco`);
    - la póliza se fecha al fin del periodo solicitado (`fin_de_periodo`).
- Lo que se construya aquí sobre Contalink respeta el punto 2: antes de escribir en una compañía, se comprueba que no tiene ya otro escritor.
- **Se revisa** si los logs del gateway muestran que nadie llama a la ruta en meses, o si Promessa pide ser una entidad de este repo.
