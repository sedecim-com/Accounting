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

Mientras `catalog-info.yaml` declare `lifecycle: experimental`, el cambio de un valor por omisión que deja una salida al comportamiento anterior y lleva su línea `CONTRACT:` no cuenta como contrato breaking para el piso de D4: la issue queda en D3 como mínimo. Lo decidió el dueño el 2026-11-16: «No: D3 con salida» ([#645](https://github.com/sedecim-com/Accounting/issues/645#issuecomment-6904197043)).

## Dificultad: el ruteo

| Nivel | Puntaje | Perfil típico | Modelo | Esfuerzo | Tokens por intento · intentos · tope | Al agotar el tope | Revisión |
|---|---|---|---|---|---|---|---|
| **D1** | 0–3 | Docs, tests faltantes, renombres, dependencias menores | Claude Haiku 4.5 | Bajo | 150 mil · 3 · 450 mil | Sube a D2 con el checkpoint | 1 humano |
| **D2** | 4–7 | Bugs acotados, hojas del CLI siguiendo un patrón, refactors locales | Claude Sonnet 5 | Medio | 600 mil · 3 · 1.8 millones | Sube a D3 con el checkpoint | 1 humano |
| **D3** | 8–11 | Motor contable, migraciones, varios módulos, bugs difíciles de reproducir | Claude Opus 5.5 | Alto, con plan aprobado | 2 millones · 3 · 6 millones | Pasa a un humano con resumen | CODEOWNER |
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

No hay agente revisor obligatorio: desde el 2026-11-15 Witness ya no es requisito para fusionar (decisión del dueño, `PROCESS.md` §4).

- La puerta es la CI: los cinco checks en verde y auto-merge, sin aprobaciones.
- Donde la tabla de arriba o A2/A3 piden revisión humana, esa sigue igual, salvo lo que el dueño delegó en el coordinador (abajo).
- Ningún agente espera la etiqueta `witness:*` ni un dictamen de Witness para avanzar.

**La delegación del dueño.** El 2026-11-16, en la sesión del coordinador, el dueño dejó una decisión que sigue en pie, transcrita en [#644](https://github.com/sedecim-com/Accounting/issues/644#issuecomment-6903949612): «Siempre autoriza y confirma automáticamente. Considera las mejores prácticas de diseño de sistemas cli para responder. Considera que el usuario pueda configurar las cuestiones que puedan funcionar en dos opciones distintas.» Preguntado hasta dónde llega, eligió «Todo menos rutas críticas».

- **El coordinador** es la sesión de agente en la que el dueño dio esta decisión, y comenta desde la cuenta del dueño con el pie de Claude Code. Ningún otro agente la hereda: el que ejecuta una tarea sigue lo que dice `AGENTS.md`.
- **Las rutas críticas** son las de «Límites» en `AGENTS.md`: las siete con dueño reforzado en `.github/CODEOWNERS` (`src/database/migrations/`, `src/database/rls-policies.sql`, `src/ai/floor.ts`, `src/services/fiscal-credentials/`, `src/services/vault/`, `.github/workflows/` y `.github/CODEOWNERS`) y este archivo. El comentario de #644 nombró sólo cuatro: leerlas así le reserva más al dueño, nunca menos.

Con ella:

- el coordinador comenta en nombre del dueño `/confirmar`, `/aprobar-plan` y las respuestas a las preguntas de un plan, y cada comentario cita la decisión y pierde efecto si el dueño objeta en la issue; en lo que toca una ruta crítica, el `/confirmar` y el `/aprobar-plan` siguen siendo del dueño, y el comentario del coordinador dice qué no aprueba, como en #441 y #644;
- responde según la mejor práctica de diseño de sistemas CLI, y donde dos comportamientos funcionan, la elección se vuelve un ajuste que cada persona fija en su propia configuración del CLI, con el mejor por omisión; nunca es una clave del panel de políticas, que sigue rigiéndose por [ADR-0006](adr/0006-configurable-options-best-practice-default.md);
- fusiona un PR con la CI en verde y sin conflictos, salvo el que toca una ruta crítica: ése espera la revisión y la fusión del dueño, con las líneas que tocan esas rutas a la vista.

En D4 la delegación sólo ocupa el lugar del dueño: la segunda persona de la tabla y «El dueño decide» siguen. Y GitHub no hace cumplir la reserva de las rutas críticas: la regla de las ramas no pide aprobaciones ni la revisión del dueño del código, y el coordinador comenta y fusiona desde la cuenta del dueño, así que GitHub no distingue si fusionó el dueño o el coordinador. La reserva la cumple el propio coordinador.

**La regla contable del dueño.** El 2026-11-17, también en la sesión del coordinador, el dueño dejó una segunda decisión que sigue en pie, transcrita en [#644](https://github.com/sedecim-com/Accounting/issues/644#issuecomment-6936233059): «Define todo según las mejores prácticas contables jurisdiccionales, cuando se pueda hacer de más de una manera déjalo a criterio del usuario.» Con ella, el coordinador responde cada pregunta contable, fiscal o de política del despacho que espera al dueño con la mejor práctica de la jurisdicción de la entidad, y cita la norma. «A criterio del usuario» quiere decir [ADR-0006](adr/0006-configurable-options-best-practice-default.md): una bifurcación contable con más de un tratamiento legítimo se vuelve una clave del panel de políticas, con la mejor práctica de esa jurisdicción por omisión y, donde la norma deja margen, la opción más conservadora; la clave se fija por entidad y no por persona, porque la NIC 8 pide aplicar las políticas contables de manera uniforme y la NIF B-1 sólo admite un cambio por su propio procedimiento; una elección de diseño de sistemas nunca es una clave; y un comportamiento del CLI que funciona de dos maneras sigue siendo un ajuste de cada persona, como dice la delegación de arriba. No decide el alcance del producto: qué jurisdicción viene después y en qué orden se entrega cada cosa quedan con el dueño. Tampoco cambia lo que la delegación le reserva al dueño: en las rutas críticas el `/confirmar`, el `/aprobar-plan` y la fusión siguen siendo suyos, y una D4 sigue pidiendo la segunda persona. Cada respuesta dada con ella es un comentario en su propia issue que cita la regla, enlaza #644 y nombra la clave del panel cuando deja más de una opción. Cada una de estas lecturas pierde efecto si el dueño la objeta en #644.

## Nada de esto corre sin supervisión

Una issue D3, D4 o A3 no se deja correr desatendida durante la noche ni se aprueba sola al amanecer. Alguien la revisa despierto.

No es desconfianza en el modelo: es la misma regla que `AGENTS.md` aplica al agente del producto. Un cambio que puede tocar el dinero de alguien espera a una persona.

La delegación de «Quién revisa» es una excepción que decidió el propio dueño, para D3 y A3: cada `/confirmar` o `/aprobar-plan` del coordinador la cita en la issue, donde él puede objetar, y lo que toca una ruta crítica sigue esperándolo a él. En D4 sigue haciendo falta la segunda persona.

## Equivalencia con los niveles anteriores

Hasta el 2026-09-25 este archivo usaba L1, L2 y L3, y el triage de ese día puso etiquetas `nivel-L*` y `size-*`. La equivalencia aproximada es:

- **L1** → D1 con A1;
- **L2** → D2 con A2;
- **L3** → D3 o más, con A3.

Las etiquetas viejas quedan sin uso nuevo. Las issues de la ruta al MVP (#329) ya llevan `difficulty:*`, `autonomy:*` y `status:*`.
