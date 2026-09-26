# Decisiones de arquitectura (ADR)

Una decisión que no es obvia y que alguien va a querer deshacer sin saber por qué se tomó va aquí, en un archivo `NNNN-slug-en-ingles.md`. Se escribe en el mismo PR que la aplica.

| ADR | Decisión | Estado |
|---|---|---|
| [0000](0000-legacy-baseline.md) | Cómo está construido hoy, y por qué: el punto de partida | Registro (2026-09-25) |
| [0001](0001-agentic-framework-adoption.md) | Adoptar el Framework de Desarrollo Agéntico, adaptado a un solo repositorio | Aceptada (2026-09-25); fila §1 sustituida por 0002 |
| [0002](0002-platform-coordination.md) | Este repo es uno de la plataforma Sedecim: ficha, inventario y ciclo de desarrollo compartidos | Propuesta (2026-09-25) |
| [0003](0003-source-of-truth-over-accounting-manager.md) | Accounting es la fuente de verdad; `accounting-manager` se apaga y se archiva | Sustituida por 0004 (2026-09-26) |
| [0004](0004-coexistence-with-accounting-manager.md) | `accounting-manager` y este repo conviven: un solo escritor por compañía de Contalink, identificada por RFC | Aceptada (2026-09-26) |
| [0005](0005-typescript-6-until-typescript-eslint-supports-7.md) | TypeScript 6; el 7 espera a que typescript-eslint lo admita | Propuesta (2026-09-26) |

Cada ADR tiene esta forma:

- **Contexto:** qué problema había, con evidencia.
- **Decisión:** qué se hace y qué se descartó.
- **Consecuencias:** qué cambia para quien trabaja aquí, y cuándo se revisa.

Un ADR no se reescribe. Si la decisión cambia, se escribe otro que lo sustituye y se marca el viejo como «sustituido por NNNN».

Las decisiones de **criterio contable** no van aquí: van al panel de políticas, con su lector (invariante 6 de `AGENTS.md`).
