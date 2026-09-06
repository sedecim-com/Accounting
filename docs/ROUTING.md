# ROUTING — qué modelo/CLI ejecuta cada nivel

Este archivo decide **quién implementa**, no **qué** se implementa (eso vive en la issue) ni **cómo** se trabaja (eso es `PROCESS.md`).

## Niveles

| Nivel | Cuándo aplica | Ejecutor | Notas |
|---|---|---|---|
| **Scope / plan** | Redactar o corregir `docs/SCOPE.md`, issues, la secuencia del plan | Claude, **solo-lectura sobre código** | Puede leer todo el árbol para fundamentar una issue; no escribe `src/`. |
| **L1** | Cambio mecánico, de una línea, sin invariante de la casa de por medio (typo, mensaje de error, actualizar una cifra derivada) | Ejecutor barato | Si toca alguno de los siete invariantes de `AGENTS.md`, **no es L1** aunque parezca pequeño. |
| **L2** | Feature acotada, un archivo o unos pocos, con criterio de aceptación claro y sin tocar RLS/migraciones/`floor.ts`/CI | Codex o Grok Build | Debe poder correr `npm run typecheck && npm test` localmente antes de abrir el PR. |
| **L3** | Toca el motor contable, RLS/multi-inquilino, migraciones, credenciales fiscales, `src/ai/floor.ts`, o cualquier ruta con dueño reforzado en `.github/CODEOWNERS` | Claude Code | Ver la lista exacta de rutas reforzadas en `CODEOWNERS` — no es una opinión, es lo que la organización ya declaró como de alto riesgo. |

## Review

La revisión de un PR la hace **un vendor distinto** del que lo implementó. Un L2 (Codex/Grok) se revisa con Claude o viceversa; nunca el mismo modelo que escribió el diff aprueba su propio trabajo. Esto es además de — no en vez de — la aprobación humana que `CONTRIBUTING.md` exige.

## L3 nunca corre overnight sin supervisión

Un cambio de nivel L3 (motor contable, perímetro multi-inquilino, credenciales, CI) no se deja correr desatendido durante la noche ni se aprueba automáticamente al amanecer. Alguien lo revisa despierto. Esto no es desconfianza en el modelo: es la misma regla que `AGENTS.md` aplica al propio agente del producto — un cambio que puede tocar el dinero de alguien espera a una persona.

## Cómo se decide el nivel en la práctica

1. ¿La issue toca alguna ruta de `.github/CODEOWNERS` con dueño reforzado? → L3.
2. ¿Implica una bifurcación de criterio contable (invariante 6 de `AGENTS.md`)? → L3: sólo se declara en el panel de políticas, y eso exige entender el resto del panel.
3. ¿Es puramente mecánico y no toca ninguno de los siete invariantes? → L1.
4. Todo lo demás con criterio de aceptación claro → L2.

Si dudas entre dos niveles, sube uno. El costo de sobre-asignar es una revisión que sobra; el costo de sub-asignar es un invariante roto en producción.
