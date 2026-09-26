# ROUTING — quién ejecuta, con qué modelo y con cuánta supervisión

Este archivo decide **quién implementa y bajo qué supervisión**. No decide **qué** se implementa (eso vive en la issue) ni **cómo** se trabaja (eso es [`PROCESS.md`](PROCESS.md)). Sigue el [Framework de Desarrollo Agéntico](https://claude.ai/artifact/V5nLbNQmVkbCDpZfMkUx6A), §5 y §10; la adaptación está en [ADR-0001](adr/0001-agentic-framework-adoption.md).

Son **dos ejes independientes**:

- la **dificultad** (D1–D4) decide el modelo, el esfuerzo de razonamiento y el presupuesto;
- la **autonomía** (A1–A3) decide cuánta supervisión humana hay.

Una issue puede ser D1 con A3 (fácil pero toca dinero) o D3 con A2 (compleja pero sin riesgo sobre el mayor).

## Dificultad: el puntaje

Cada dimensión se califica de 0 a 3 y se suman (0–15). El triage deja una línea de justificación por dimensión en la issue.

| Dimensión | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| Alcance | 1 archivo | 2–5 archivos, 1 módulo | Varios módulos del repo | Contratos: API publicada, entregables SAT/IMSS, esquema |
| Ambigüedad | Especificación exacta | Detalles menores abiertos | Requiere decisiones de diseño | Requiere investigar el problema |
| Novedad | Copia un patrón existente | Adapta un patrón | Patrón nuevo en el repo | Sin precedente |
| Riesgo técnico | Sin estado ni datos | Toca estado propio | Migración, concurrencia, rendimiento | Contrato breaking, dinero en el mayor, seguridad o PII |
| Verificabilidad | Tests existentes lo cubren | Tests nuevos simples | Integración contra Postgres o e2e | Difícil de probar automáticamente |

**Pisos:** una dimensión en 3 sube la issue a D3 como mínimo. Un contrato breaking o PII la sube a D4.

## Dificultad: el ruteo

| Nivel | Puntaje | Perfil típico | Modelo | Esfuerzo | Tokens por intento · intentos · tope | Al agotar el tope | Revisión |
|---|---|---|---|---|---|---|---|
| **D1** | 0–3 | Docs, tests faltantes, renombres, dependencias menores | Claude Haiku 4.5 | Bajo | 150 mil · 3 · 450 mil | Sube a D2 con el checkpoint | Agente revisor + 1 humano |
| **D2** | 4–7 | Bugs acotados, hojas del CLI siguiendo un patrón, refactors locales | Claude Sonnet 5 | Medio | 600 mil · 3 · 1.8 millones | Sube a D3 con el checkpoint | Agente revisor + 1 humano |
| **D3** | 8–11 | Motor contable, migraciones, varios módulos, bugs difíciles de reproducir | Claude Opus 5.5 | Alto, con plan aprobado | 2 millones · 3 · 6 millones | Pasa a un humano con resumen | Agente revisor + CODEOWNER |
| **D4** | 12–15 | Contrato breaking, RLS, credenciales fiscales, arquitectura | El modelo más capaz, en modo investigación y propuesta | Máximo | 2 millones por fase, aprobación entre fases | El dueño decide | 2 humanos |

Los presupuestos son valores iniciales y se recalibran con medición ([#336](https://github.com/sedecim-com/Accounting/issues/336)). Mientras no haya orquestador ([#332](https://github.com/sedecim-com/Accounting/issues/332)), los respeta el propio agente con el semáforo:

- **50 %:** checkpoint en la issue;
- **80 %:** deja de explorar y sólo cierra lo que está en curso;
- **100 %:** se detiene, deja el checkpoint y pone la etiqueta `budget-exceeded`.

**Escalamiento:** si `scripts/verify.sh` no sale en verde tras 3 intentos, o se agota el tope, la issue sube un nivel y cambia de modelo. En D4, pasa a un humano. Una D3 que resulta trivial se reclasifica hacia abajo: eso también calibra.

## Autonomía

| Nivel | El agente puede | Cuándo en este repo |
|---|---|---|
| **A1 — Autónomo** | Implementar y abrir el PR; el humano sólo revisa | Documentación pura, tests puros |
| **A2 — Supervisado** | Proponer un plan en la issue, esperar `/aprobar-plan` y luego implementar | Sin tocar dinero, esquema, credenciales, RLS, `src/ai/floor.ts` ni CI: hojas del CLI, texto, el instrumento del plan, parsers que no escriben al mayor |
| **A3 — Asistido** | Investigar y redactar la propuesta; un humano implementa o co-implementa | **El valor por omisión.** Este repo maneja PII (RFC, SSN) y funciones financieras reguladas. Todo lo que toca el mayor, migraciones, RLS, credenciales o los contratos |

Toda ruta con dueño reforzado en [`.github/CODEOWNERS`](../.github/CODEOWNERS) es A3 como mínimo. No es una opinión: la organización ya la declaró de alto riesgo.

## Quién revisa

La revisión la hace **un modelo o CLI distinto** del que implementó. Además, y no en vez de, está la aprobación humana que exige `CONTRIBUTING.md`.

- En D1–D2, el agente revisor puede usar un modelo un nivel abajo del autor, con una lista de chequeo cerrada.
- En D3–D4, el revisor usa el mismo nivel.
- El revisor sólo corre con CI en verde: revisar lo que CI ya rechazó gasta tokens sin decidir nada.

## Nada de esto corre sin supervisión

Una issue D3, D4 o A3 no se deja correr desatendida durante la noche ni se aprueba sola al amanecer. Alguien la revisa despierto.

No es desconfianza en el modelo: es la misma regla que `AGENTS.md` aplica al agente del producto. Un cambio que puede tocar el dinero de alguien espera a una persona.

## Equivalencia con los niveles anteriores

Hasta el 2026-09-25 este archivo usaba L1, L2 y L3, y el triage de ese día puso etiquetas `nivel-L*` y `size-*`. La equivalencia aproximada es:

- **L1** → D1 con A1;
- **L2** → D2 con A2;
- **L3** → D3 o más, con A3.

Las etiquetas viejas quedan sin uso nuevo. Las issues de la ruta al MVP (#329) ya llevan `difficulty:*`, `autonomy:*` y `status:*`.
