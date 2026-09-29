# ADR-0006 · Opciones configurables, con la mejor práctica por omisión

> Gemela en español de [`0006-configurable-options-best-practice-default.md`](0006-configurable-options-best-practice-default.md) · source_sha: 88b95a87a2bb7ac21f761fdac1deae2ed68696fd

- **Fecha:** 2026-09-29
- **Estado:** aceptada por el owner (@vic2099).
- **Amplía:** el invariante 6 de [`AGENTS.md`](../../AGENTS.md). No lo sustituye.
- **Primera aplicación:** las decisiones del owner sobre retenciones del 2026-09-29, en #309.

## Contexto

El invariante 6 ya dice que una bifurcación entre dos tratamientos contables legítimos no se elige en el código: se vuelve una clave del panel de políticas (`src/services/policy/`), con su porqué y su lector. No dice dos cosas:

1. **Cuál opción va por omisión.** Cada clave lleva un `defaultValue` y un `defaultRationale` (`src/services/policy/pending-catalog.ts`), y la omisión es lo que recibe una entidad mientras nadie contesta. Nada decía cómo elegirla. Lo cómodo es lo que el código ya hacía, y eso no siempre es lo correcto.
2. **Las elecciones que no son contables.** Si una corrección guarda historia o sobrescribe, cómo se acota una consulta a la entidad, si una escritura es idempotente, si una bitácora es sólo de anexar. Sin regla, un agente que duda puede mandar cualquiera de estas al panel y llamarla «configurable», y le entrega al contador una pregunta que no le toca.

El 2026-09-29, al revisar el PR de retenciones (#478, MNE-001-056), el owner decidió tres bifurcaciones en #309: en qué cuentas van el ISR y el IVA retenidos, qué pasa con las entidades existentes que lo tienen todo en 2140, y qué hacer con un CFDI de honorarios sin ISR retenido declarado. En las tres dejó en el panel todas las opciones legítimas y fijó una por omisión. Luego enunció la regla, textual:

> «Mantén las opciones configurables pero establece la que sea la mejor práctica de sistemas y con las opciones por default en la mejor práctica contable. Esto es algo que debes recordar para elegir cómo crear el sistema.»

## Decisión

1. **Una bifurcación contable, fiscal o de política del despacho es una clave del panel, y su omisión es la mejor práctica contable.**
   - La clave ofrece todas las opciones legítimas, no sólo la que el código ya implementa.
   - La omisión es lo que debe hacer un despacho mexicano según la norma: NIF, LISR, LIVA, CFF, la RMF y las reglas del SAT. Su `defaultRationale` cita el artículo, la regla o la norma que la hace la mejor práctica.
   - Cuando la norma deja margen, la omisión es la opción más conservadora: la que no postea sin revisión, no pierde deducibilidad y no reescribe historia.
2. **Una elección de diseño de sistemas no es una clave del panel. Sigue la mejor práctica de sistemas.**
   - Historia antes que sobrescritura; bitácora sólo de anexar; escrituras idempotentes; toda consulta acotada por `entity_id` / `tenant_id`; mínimo privilegio; minimización de datos; nombres en inglés (ver `docs/language.md`).
   - Volver una de estas configurable «por si acaso» se descarta: multiplica los caminos que hay que probar y le hace al contador una pregunta que no es contable.
3. **Cuando una elección es las dos cosas** (por ejemplo, reasignar los roles de las entidades existentes en #309), la parte contable va al panel y la de sistemas se fija: elija lo que elija el despacho, el cambio queda auditado, tiene `--dry-run` y nunca sobrescribe en silencio un mapeo manual.

**Descartado:**

- **Dejar por omisión el comportamiento que ya existía.** Convierte un accidente de implementación en política.
- **Sin omisión: obligar al despacho a contestar antes de que algo corra.** Bloquea el alta, y el panel ya pregunta por prioridad.
- **Todo configurable.** Las elecciones de sistemas que varían por entidad rompen los invariantes de la casa, que suponen un solo comportamiento.

## Consecuencias

- Cada clave nueva del panel nombra su omisión y cita en `defaultRationale` por qué es la mejor práctica contable. Una clave cuyo porqué es «esto hacía el código» no pasa revisión.
- Un PR que toma una de estas elecciones la lista en «Open points» en su cuerpo: la clave, sus opciones, la omisión y la cita. El owner puede cambiarla ahí; mientras tanto, rige la omisión.
- Un PR que vuelve configurable una elección de sistemas se devuelve, salvo que muestre que la elección es en realidad contable.
- El invariante 6 de `AGENTS.md` apunta aquí.
- **Se revisa** si el panel acumula claves cuya omisión hay que cambiar a menudo: sería señal de que la regla está eligiendo mal.
