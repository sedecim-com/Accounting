# ADR-0002 · Este repo es uno de la plataforma Sedecim: ficha, inventario y ciclo de desarrollo compartidos

- **Fecha:** 2026-09-25
- **Estado:** propuesta; los campos `# inferido` de `catalog-info.yaml` los confirma el owner.
- **Sustituye:** la fila §1 del ADR-0001 («Platform Scope, catálogo, matriz de impacto: adaptado, un solo repo»). El resto del ADR-0001 sigue vigente.
- **Fuentes:** el [Framework de Desarrollo de Software Agéntico](https://claude.ai/artifact/V5nLbNQmVkbCDpZfMkUx6A) y la *Guía de implementación del Framework Agéntico en una plataforma multirepositorio existente* (2026-09-25), que fija el arranque en sedecim-com (§13).

## Contexto

El ADR-0001 adaptó el framework a un solo repositorio, y por eso no creó `catalog-info.yaml`: sin un catálogo que lo lea, sería una ficha sin lector.

**La premisa cambió.** La guía de implementación trata a sedecim-com como una plataforma de 127 repos que se adopta por olas. Su Fase 1 arma el inventario sumando el `catalog-info.yaml` de cada repo, y su modelo de madurez N0–N4 se calcula repo por repo. El lector ya existe: es el inventario de la plataforma, y este repo es una de sus filas.

**Lo que se encontró al revisar los repos vecinos:**

- Ninguno de los repos activos revisados tiene todavía artefactos del framework (`catalog-info.yaml`, `AGENTS.md`, SCOPE). Tampoco existen `platform-docs` ni el repo `.github` de la organización. Este repo va adelante; lo que entregue fija, de hecho, el formato para los demás.
- `accounting-manager` hace una parte de lo que hace este repo (CFDI → pólizas → Contalink), con otro stack y sin pruebas. Es una variante en el sentido de la Fase 1, y la fuente de verdad no está decidida.

## Decisión

1. **`catalog-info.yaml` en la raíz,** con el esquema del framework (§1.1) y cada campo inferido marcado. Propone dos extensiones, `external` y `related_repos`, porque la guía pide una lista de dependencias externas y el esquema no tiene dónde ponerla.
2. **`docs/platform/`** guarda lo que este repo le entrega a `platform-docs` —inventario, nivel de madurez, contrato v0— en el formato de destino. Cuando `platform-docs` exista, se copia y aquí queda un enlace.
3. **Los documentos por repo que faltaban** en la lista obligatoria del framework (§8): `docs/ARCHITECTURE.md`, `docs/RUNBOOK.md` y `docs/adr/0000-legacy-baseline.md`.
4. **El ciclo de cada desarrollo nuevo** (framework §12) entra como regla, con sus plantillas en `docs/prd/README.md`: informe de contexto de plataforma, entrevista, PRD, system design y backlog con IDs `MNE-<PRD>-<nnn>`.
5. **Prefijo `MNE`,** por mnemosine, y no `ACC`: `acc*` choca con la familia `acceso-*`, uno de los clusters que la guía manda resolver primero.

**Descartado:**

- **Crear `platform-docs` o el repo `.github` de la organización desde aquí.** Es trabajo del equipo núcleo (guía, Fase 0) y exige decisiones que este repo no puede tomar.
- **Decidir entre este repo y `accounting-manager`.** Es #342, y pregunta abierta en `docs/SCOPE.md` con dueño.

## Consecuencias

- Este repo queda en **N0 formal** (`docs/platform/maturity.md`). N1 exige `develop` y `release`, que el ADR-0001 difirió (#333). Si la plataforma aplica al pie de la letra la regla «ningún agente escribe código por debajo de N3», este repo quedaría detenido. El owner y el arquitecto de plataforma deciden si se adelanta #333 o se registra una excepción.
- Un PR que cambie lo que el repo expone o consume actualiza `catalog-info.yaml` en el mismo PR (framework §1, «Mantenimiento»).
- Se revisa cuando exista `platform-docs`, o cuando se decida la fuente de verdad frente a `accounting-manager`.
