# Lo que este repo le entrega a la plataforma

La guía de implementación del framework pone el inventario, el nivel de madurez, los contratos y `PLATFORM.md` en un repo central, `platform-docs`, y las plantillas comunes en el repo `.github` de la organización. **Al 2026-09-25 ninguno de los dos existe en sedecim-com.** Esta carpeta guarda lo que este repo aporta, en el formato de destino, para que la migración sea copiar y no reescribir.

| Aquí | Destino en `platform-docs` | Qué es |
|---|---|---|
| [`../../catalog-info.yaml`](../../catalog-info.yaml) | `catalog/` (lo agrega un workflow) | La ficha del repo: dominio, tier, datos, qué expone y qué consume. Se queda en la raíz del repo; la plataforma la lee de ahí |
| [`inventory.md`](inventory.md) | `inventory/accounting.md` | Inventario de la Fase 1 y la relación con los demás repos de Sedecim |
| [`harmony-review.md`](harmony-review.md) | `reviews/accounting-2026-09-26.md` | Revisión de armonía con los 135 repos de `sedecim-com`: normas observadas, relaciones y ajustes propuestos |
| [`maturity.md`](maturity.md) | fila en `maturity.md` | Autoevaluación N0–N4 con evidencia |
| [`../openapi.json`](../openapi.json) | `contracts/mnemosine-rest-v1.yaml` | Contrato v0 de la API REST; se genera del código (`npx tsx scripts/openapi.ts`) |

## Qué hacer cuando exista `platform-docs`

1. Copiar `inventory.md` y `maturity.md` a sus destinos, y dejar aquí un enlace a ellos.
2. Publicar el contrato con `x-status: descubierto` y cambiar `provides` en `catalog-info.yaml` para que apunte a él.
3. Si la plataforma adopta las extensiones que propone `catalog-info.yaml` (`external` y `related_repos`), documentarlas en su esquema; si no, moverlas a `PLATFORM.md`.

## Qué necesita este repo de la plataforma

- **`PLATFORM.md` y su glosario.** Este repo tiene el suyo en `docs/wiki/Glosario.md`. Los términos que se cruzan con otros dominios («póliza» contable frente a «póliza» de seguro, «cliente», «pago») deben coincidir.
- **Que la frontera con `accounting-manager` se respete de los dos lados:** un solo escritor por compañía de Contalink, identificada por RFC ([ADR-0004](../adr/0004-coexistence-with-accounting-manager.md)). Si Promessa llegara a ser una entidad de este repo, el cambio de escritor lo decide otro ADR.
- **El informe de contexto de plataforma** (framework §12.1) antes de cada desarrollo nuevo: [`../prd/README.md`](../prd/README.md).
