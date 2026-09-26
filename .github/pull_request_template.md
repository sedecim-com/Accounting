Closes #

<!-- Un PR resuelve una issue. Menos de ~400 líneas sin contar lo generado; si no cabe, la issue se divide. Ábrelo como Draft mientras CI no esté en verde. -->

## Qué cambia

<!-- Una o dos frases. El "qué", no el "cómo". -->

## Por qué

<!-- El problema que existía antes de este cambio. Si no había problema,
     explica qué se gana. Un PR sin porqué no se puede revisar: sólo leer. -->

## Tipo

- [ ] corrección · - [ ] funcionalidad · - [ ] refactor · - [ ] docs · - [ ] mantenimiento · - [ ] cambia un contrato

## Impacto

- **Contratos modificados:** ninguno | API `docs/openapi.json` | entregable SAT/IMSS | esquema (migración) | CLI (catálogo) — (compatible / rompe)
- **Decisiones de criterio contable:** ninguna | clave nueva en el panel con su lector (invariante 6)

## Cómo probar (persona)

1. `npm ci && scripts/verify.sh`
2. <!-- el comando del CLI que muestra el cambio, con datos sintéticos -->
3. Resultado esperado: …

## Cómo probar (agente)

- **Comando único:** `scripts/verify.sh`. Si saltó la integración, di por qué.
- **Criterios de aceptación y su prueba:**

  | Criterio | Prueba · criterio del plan |
  |---|---|
  | CA-1 | `tests/…` · `id-del-criterio` |

- **Mutantes:** el criterio muere con su mutante (`npm run mutantes`), o no aplica porque …

## Evidencia

<!-- Salida de consola, cifras antes/después, reproducción del defecto. -->

## Riesgos y rollback

- **Riesgo:** …
- **Rollback:** revertir el PR | migración nueva que deshace (nunca editar una aplicada) | clave del panel

## Invariantes de la casa que este cambio toca

<!-- Marca lo que aplique y explica cómo se sostiene. Si no toca ninguno, borra
     esta sección. -->

- [ ] La IA no escribe el libro ni sistemas externos: todo queda en
      `ai_drafts` / `ai_external_ops` y lo aprueba una persona.
- [ ] Los `UPDATE` llevan predicado de estado, alcance por entidad y revisión de
      `rowCount`.
- [ ] Toda consulta está acotada por `entity_id` / `tenant_id`.
- [ ] Los límites de `src/ai/floor.ts` sólo se combinan con `Math.min`.
- [ ] El contenido de terceros (CFDI, webhooks, skills) va envuelto como no
      confiable, con los delimitadores neutralizados.

## Checklist

- [ ] `scripts/verify.sh` en verde (o lo que no corrió, dicho arriba)
- [ ] Bloques generados regenerados, no editados a mano
- [ ] Documentación y comentarios tocados en el mismo PR
- [ ] Sin secretos ni datos reales
- [ ] Revisé el diff completo, también si lo escribió un agente
- [ ] Si lo escribió un agente: etiqueta `agent-authored` y el modelo aquí → <!-- modelo / herramienta -->
