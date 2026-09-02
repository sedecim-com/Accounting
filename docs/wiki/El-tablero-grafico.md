# El tablero gráfico

> **Esta página describe investigación y dirección, no capacidades.** El tablero no existe: no hay carpeta `web/`, no hay comando `mnemosine web serve`, no hay una sola pantalla. Lo que sigue es el resultado de la investigación del 2026-09-02 y la forma que tomaría el tramo si entra al plan. Para lo que sí existe hoy, ver [[Manual-de-usuario]] y [[Arquitectura]].

## Por qué un tablero

No por moda. Por dos brechas medidas en la auditoría de usabilidad (`docs/auditorias/2026-09-01-usabilidad/SINTESIS-brechas.md`):

- **H7: no existe ninguna vista de todos los clientes a la vez.** Las 85 hojas del CLI son de una entidad por invocación. Un despacho con veinte clientes no tiene forma de preguntar "¿quién tiene periodo abierto, quién tiene borradores esperando, quién tiene preguntas del agente sin contestar?" sin correr veinte veces el mismo comando. La vista de cartera es la pantalla de inicio de QuickBooks Online Accountant ([guía oficial](https://media.intuit.com/en_US/QBOA_welcome_guide_en_US/Content/Topics/guides/qboa_welcome_guide.htm)): una fila por cliente, columnas de estado, salto a los libros de cada uno.
- **E2: la pantalla de revisión no trae el CFDI al lado.** Revisar un borrador contra su comprobante exige dos ventanas hoy — y el modelo de datos ni siquiera lo permite: `011_ai_drafts.sql` no tiene `xml_document_id`. Esa migración es prerrequisito del tablero, no consecuencia.

Un tablero es la superficie natural para ambas cosas. Un CLI no lo es, y forzarlo sería peor que admitirlo.

## Por qué NO un tercer motor

La lección más cara del proyecto está escrita en la auditoría integral III (`docs/auditorias/2026-09-01-integral-iii/superficies-no-cli.md`): la API REST no nació como adaptador del motor sino como **segundo motor con menos reglas** — las cuatro compuertas del CLI viven en [`src/cli/kernel/`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/kernel/) y mientras vivan ahí, la API no las tiene. Ver [[El-agente-y-sus-limites]] para el contexto de las compuertas.

El tablero no puede ser el tercero. La regla de diseño que lo garantiza:

- **El tablero solo habla `/v1`.** La autenticación es la que ya existe: Bearer JWT con HS256 local o RS256/ES256 contra el JWKS de un IdP OIDC ([`src/api/rest/middleware/auth.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/api/rest/middleware/auth.ts)), donde la cabecera `x-entity-id` **elige entre las entidades del token, nunca las amplía**. El alcance no lo escribe el cliente — ver [[Aislamiento-multi-inquilino]].
- **El gateway es plomería, no negocio.** Sus únicas rutas propias serían `/auth/login`, `/auth/callback`, `/auth/logout` y `/healthz`. Cero endpoints contables. Sesión de navegador (Authorization Code + PKCE contra el mismo IdP que `src/auth/login-flows.ts` ya usa, cookie HttpOnly — el token jamás toca JavaScript del cliente) y proxy de `/v1/*`. Es el patrón BFF ([Microsoft, Backends for Frontends](https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends)) deliberadamente anémico: agregar es donde nacen los motores.
- **Lo descartado, y por qué.** Los low-code autoalojados ([Appsmith](https://docs.appsmith.com/), [ToolJet](https://docs.tooljet.ai/docs/), [Budibase](https://docs.budibase.com/docs)) montan un tablero en días, pero traen su propio modelo de usuarios y sus editores invitan a conectar directo a Postgres: con RLS forzada eso es o un rol de base (tercer motor instantáneo, sin compuertas, sin bitácora) o un token de servicio que no distingue quién opera. Además la definición del tablero viviría en la base de la herramienta, fuera del repo, fuera de PR, fuera de `npm run plan:status`. [Grafana](https://grafana.com/docs/grafana/latest/) sí, pero para el operador y sus métricas, no para el contador. Y GraphQL — 918 líneas tras bandera — refuerza la recomendación de retirarlo, no de revivirlo.

## Las fases

**Prerrequisito (R9): el contrato que hoy no existe.** No hay OpenAPI en el árbol; el versionado es tipográfico y conviven dos formas de error. La ruta es generar OpenAPI **desde los esquemas Zod que ya validan cada ruta** — con el matiz de versiones: el árbol trae Zod `^3.25.0`, así que hoy toca [zod-to-openapi](https://github.com/asteasolutions/zod-to-openapi) fijado en 7.3.4 (la última con soporte Zod 3), y la migración a Zod 4 con [`z.toJSONSchema()`](https://zod.dev/json-schema) nativo queda como deuda declarada. Del contrato, [Orval](https://orval.dev/) genera el cliente tipado con hooks de TanStack Query y mocks: la SPA se desarrolla contra el contrato, no contra la base.

**Fase 0 — el gateway que no es motor.** Paquete `web/` con dos mitades: `web/gateway` (el mismo Express del árbol; las cuatro rutas de plomería) y `web/app` (Vite + React + [shadcn/ui](https://ui.shadcn.com/docs) + [TanStack Table](https://tanstack.com/table/latest) y [Query](https://tanstack.com/query/latest) + [Recharts](https://recharts.github.io/) vía shadcn). shadcn/ui se eligió porque no es librería sino distribución de código fuente: el componente copiado es código propio auditable, no dependencia opaca. Dos remedios heredados viajan dentro porque el gateway los vuelve urgentes: `trust proxy` explícito (ausente en todo el árbol) y las métricas con etiquetas acotadas.

**Fase 1 — la cartera y la revisión.** Tres pantallas, todas de lectura más disposición, ninguna con lógica contable propia: la **cartera del despacho** (requiere el endpoint transversal que H7 pide — y ese endpoint es del API, con sus compuertas, no del gateway), el **panel de pendientes** con los campos explicativos que ya trae cada política (`whyAsking`, `ifSkipped` — [`src/services/policy/pending-catalog.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/policy/pending-catalog.ts)), y la **revisión de borradores con el CFDI al lado** (arrastra la migración `xml_document_id` de E2). Los botones disparan los mismos actos de `/v1` con las mismas banderas de riesgo: el tablero es la mano del humano que dispone, no una herramienta del agente.

**Fase 2 — flexible por usuario.** Widgets configurables (qué tarjetas, qué columnas, en qué orden) persistidos por usuario en `/v1`. Con una línea roja explícita: **una bifurcación de criterio contable jamás se resuelve en la configuración de un widget.** Si un widget necesita un umbral contable ("marcar en rojo la antigüedad mayor a N días"), el umbral nace como entrada del panel de políticas con sus cuatro campos, y el widget lo lee. Preferencia de interfaz y criterio del despacho son cosas distintas y viven en lugares distintos.

## La identidad visual: acuñarla, no importarla

Primero la limitación: el sistema visual de los artefactos del plan (IBM Plex, libro rayado, colores semánticos) **no existe en el repo como archivo** — `grep -rn "Plex\|rayado" docs src` devuelve cero. Vive en los artefactos publicados. Llevarlo a `web/` significa acuñarlo por primera vez como archivo versionado (`web/design/tokens.css` y su espejo JSON):

- **[IBM Plex](https://github.com/IBM/plex)** — Sans para interfaz, Mono para cifras y folios. SIL OFL, distribución por npm, autohospedable: nada de CDN de terceros dentro del despacho.
- **Libro rayado** — filas con regla horizontal fina y numerales tabulares, para que los importes cuadren ópticamente en columna, como en un libro de contabilidad de papel.
- **Semáforo semántico con significado contable fijo** — azul = informativo/en curso, verde = cuadrado/posteado, ámbar = borrador/pendiente de disposición, rojo = bloqueado/descuadre. Son los mismos cuatro estados que el CLI ya expresa con sus códigos de salida: terminal, documentos y tablero como la misma casa.
- **[WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/) nivel AA como criterio de aceptación**, no como intención: contraste verificado por test sobre los tokens, tabla navegable por teclado.
- **es-MX como idioma fuente** vía [i18next](https://www.i18next.com/), con llaves estables en inglés. El catálogo de cadenas del tablero sería el primer inventario completo de vocabulario contable es-MX del producto.

## Las decisiones de las que depende

Dos decisiones de producto — humanas, no del agente — preceden al primer commit (`SINTESIS-brechas.md`, sección 5):

1. **§5.1 Idioma.** El tablero nace es-MX, lo cual de facto empuja la opción de español completo con llaves `--json` estables.
2. **§5.3 Entidad vs despacho.** La cartera presupone que el despacho es primera clase. Hoy no lo es: todo es de una entidad por invocación.

El tablero es el argumento más barato a favor de ambas, y por eso conviene proponerlas juntas. Ver [[Hoja-de-ruta]] para dónde encajarían los tramos.

## Contra la capacidad huérfana

Si el tramo entra, entra con su fila y su criterio, como todo en la casa: el comando `mnemosine web serve` con fila en el catálogo y el trinquete de [`docs/catalogo-minimos.json`](https://github.com/sedecim-com/Accounting/blob/main/docs/catalogo-minimos.json) subiendo en el mismo commit; y un criterio ejecutable en [`src/plan/criterios.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/plan/criterios.ts) con tres dientes: (a) `web/` no importa `src/database` ni `src/services` — un grep que falla si el tablero intenta volverse motor; (b) la tabla de rutas propias del gateway es exactamente las cuatro de plomería — cualquier ruta nueva rompe el criterio hasta declararse; (c) el cliente de la SPA se regenera del `openapi.json` de CI — el desfase contrato-cliente falla el build, no la demo. Así `npm run plan:status` puede responder por el tablero igual que responde por todo lo demás.

## Páginas relacionadas

- [[Canales-de-mensajeria]] — la otra superficie investigada: el chat como adaptador, no como motor.
- [[La-contabilidad-como-centro]] — la lente experimental sobre lo que el tablero mostraría a terceros.
- [[Arquitectura]], [[El-agente-y-sus-limites]], [[Aislamiento-multi-inquilino]] — las reglas que el tablero hereda sin excepción.
