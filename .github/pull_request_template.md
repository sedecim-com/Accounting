## Qué cambia

<!-- Una o dos frases. El "qué", no el "cómo". -->

## Por qué

<!-- El problema que existía antes de este cambio. Si no había problema,
     explica qué se gana. Un PR sin porqué no se puede revisar: sólo leer. -->

## Cómo se verificó

- [ ] `npx tsc --noEmit` limpio
- [ ] `npm test` en verde
- [ ] `npm run test:integration` (necesita Postgres) — si el cambio toca la base
- [ ] `npm run plan:status` sin retroceder ningún paquete exigido

<!-- Si algo NO se pudo verificar, dilo aquí. Un hueco declarado es información;
     uno callado es una sorpresa para quien revisa. -->

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
