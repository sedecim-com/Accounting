# MIGRATION — de artefactos de Claude Code a GitHub, versionado

Este documento explica la migración en sí: qué se movió, qué no se pudo mover y por qué, y las decisiones que tomé al ejecutarla.

## Qué se hizo

1. **`docs/SCOPE.md`, `docs/PROCESS.md`, `docs/ROUTING.md`, `AGENTS.md`, `CLAUDE.md`, `.github/ISSUE_TEMPLATE/ticket.md`** — nuevos, fuente de verdad desde ahora.
2. **`docs/HISTORY.md`** — reconstruido **verificando cada commit contra `git log`**, no citando la prosa de artefactos anteriores. Ver la lección completa en el propio archivo: el "Plan de cierre" citaba commits de un "Sprint 1" y "Sprint 2" que ya no existen en `main`.
3. **`docs/archive/claude-artifacts/`** — los cuatro artefactos HTML de Claude Code, copiados sin editar. Ver su propio `README.md`.
4. **Milestones de GitHub** — uno por sprint histórico (verificado) más `Vía A` y `Vía B` para el trabajo pendiente.
5. **Issues de GitHub** — retroactivas (cerradas, una por PR "sustantivo"; los PRs de mantenimiento de dependencias se agrupan en una sola issue por sprint) y nuevas (abiertas, una por tramo de la Vía A y de la Vía B).

## Decisiones que tomé, y por qué

### La Issue de scope no es la #1

El repositorio ya tiene un **Pull Request #1**. Los números de issue y PR comparten la misma secuencia en GitHub — no hay forma de forzar que una Issue nueva sea la #1 cuando ya existen 54 PRs. La Issue de scope (label `scope`, pineada) es la primera Issue creada por esta migración, con el número que le tocó en turno. Ver el número real en el propio repositorio (label `scope`).

### Los "Sprint 1/2/3" del Plan de cierre no sobrevivieron la verificación

Antes de escribir `docs/HISTORY.md`, verifiqué contra `git log` los commits que el Plan de cierre citaba para sus tres primeros sprints (IVA-1, IVA-2, IVA-3, AUD-1, ESQ-1, HON-1, TEN-1, E1.1-a, E1.1-b, E2.2, E1.4-b, AUD-3). **Ninguno de esos hashes existe en `main`.** El propio artefacto explica por qué, en su prosa: una "sesión paralela" hizo un trabajo equivalente por otro camino, y ese trabajo es el que sobrevivió. Reescribir la historia con esos hashes habría sido fabricar un historial falso, así que `docs/HISTORY.md` se construyó desde cero contra `git log --first-parent` y `gh pr view`, con el método descrito en el propio archivo.

### Retroactivas por PR, no por tramo

El repositorio tiene ~60 "tramos" nombrados (S0.1, F03, G1a, etc.) pero 41 PRs mergeados. Crear una Issue retroactiva por tramo habría sido ruido — varios tramos comparten PR. Cada Issue retroactiva corresponde a un PR "sustantivo"; los PRs de dependabot se agrupan en una sola Issue de mantenimiento por sprint.

### El tablero de GitHub Projects no se creó

El token de esta sesión tiene scopes `gist, read:org, repo, workflow` — **no `project`**. Crear un Project (v2) requiere ese scope, y obtenerlo exige un flujo de autorización interactivo en el navegador que esta sesión no puede completar. **Paso manual pendiente**: quien tenga acceso de administrador debe correr `gh auth refresh -s project` (o crear el Project desde la interfaz web) y luego añadir las columnas To do / Doing / Review / Done con las Issues que esta migración creó.

## Cómo verificar esta migración

```bash
gh issue list --label scope                    # la issue de scope pineada
gh api repos/sedecim-com/Accounting/milestones  # los milestones creados
gh issue list --state all --limit 100           # todas las issues, retroactivas y nuevas
```

Si alguna cifra de este documento o de `docs/HISTORY.md` no coincide con lo anterior, gana lo que devuelva `gh`.
