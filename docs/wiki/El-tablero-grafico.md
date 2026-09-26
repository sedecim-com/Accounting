# El tablero gráfico

> **W0–W1 entró, y parte de esta página ya es historia.** Lo que existe hoy: un
> **gateway** en `src/gateway/` (proceso aparte: `node dist/gateway/main.js`, o
> `mnemosine web start` para el operador y el desarrollo) que sostiene la sesión
> del navegador y **reenvía sólo lecturas** —GET y HEAD— a `/v1`; una **SPA de
> TypeScript sin marco** con dos pantallas de lectura, la **cartera del
> despacho** y la vista de una entidad; los **tokens de la casa** acuñados como
> archivo (`src/gateway/public/design/tokens.css` y su espejo JSON); y el
> endpoint transversal `GET /v1/portfolio`, que es **de la API**, con sus
> compuertas. Desde el navegador no se escribe nada.
>
> Lo que sigue conserva la investigación del 2026-09-02 porque el argumento
> —por qué no un tercer motor, por qué no low-code— es el que sostiene la forma
> que tomó. Donde la página dice que algo «sería» o «no existe», léase corregido
> por el refresco del final y por `docs/auditorias/W0.md`, que es el registro de
> la auditoría del tramo. Para lo que hace el CLI, ver [[Manual-de-usuario]] y
> [[Arquitectura]].

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


> **Refresco del 2026-09-06.** Esta página se escribió con la investigación del 2 de septiembre; cuatro días después se volvió a abrir cada liga y a leer el repo. El detalle está en [`practicas/conectores.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/investigacion/2026-09-06-normas-y-motores/practicas/conectores.md). Lo que cambió:

- **`trust proxy` ya existe con criterio** (`src/api/rest/trust-proxy.ts`, `src/index.ts:61-69`, `criterios.ts:4415-4425`): la R10 que esta página pedía dentro de W0 está hecha.
- Las veinte ligas del 2 de septiembre responden. Nuevas en la tabla: Backstage (CNCF), Retool *self-hosted* (con permisos propios: la misma objeción que Appsmith), y tres sistemas de diseño —Carbon de IBM, que usa el mismo Plex que la casa; Radix; USWDS 3.14.0—.
- **Sigue sin `web/`** y sin criterio de tres dientes ni tokens visuales versionados. Es la issue [#117](https://github.com/sedecim-com/Accounting/issues/117). Dos de las tres carencias de esta línea ya cayeron: OpenAPI se genera y se verifica en CI, y GraphQL —cuya supervivencia esta misma página recomendaba no revivir— se retiró en T14b.

## Páginas relacionadas

- [[Canales-de-mensajeria]] — la otra superficie investigada: el chat como adaptador, no como motor.
- [[La-contabilidad-como-centro]] — la lente experimental sobre lo que el tablero mostraría a terceros.
- [[Arquitectura]], [[El-agente-y-sus-limites]], [[Aislamiento-multi-inquilino]] — las reglas que el tablero hereda sin excepción.

> **Refresco del 2026-09-16 (W0–W1 entregado).** Lo que cambió respecto de lo
> escrito arriba, punto por punto:
>
> - **La carpeta es `src/gateway/`, no `web/`**, para que el tablero herede sin
>   excepción lo que ya vigila a `src/`: `tsc`, el lint con tipos, el metro del
>   idioma, vitest, Docker y las compuertas del plan. Su entrada de producción
>   no carga `dotenv`, ni `src/config`, ni `src/database`: un gateway
>   comprometido no tiene la credencial del motor.
> - **La hoja es `mnemosine web start`** (`web iniciar`), no `web serve`, porque
>   `start` ya es un verbo del registro.
> - **Sin Vite, React, shadcn, TanStack, Recharts ni Orval.** La SPA es
>   TypeScript sin marco, compilada por `tsconfig.web.json`, porque el metro del
>   idioma y el lint de identificadores sólo cuentan `.ts`: una SPA en `.js`
>   habría salido del alcance de las dos puertas. Una pantalla de lectura no
>   paga un marco, y los estilos en línea de una librería de componentes
>   obligarían a aflojar la CSP.
> - **El cliente no se genera del contrato**: el `openapi.json` de hoy no
>   publica esquemas de respuesta, así que un generador sólo copiaría método y
>   ruta. En su lugar hay una tabla de operaciones y un criterio que la contrasta
>   contra el `openapi.json` versionado; el desfase falla el build, no la demo.
> - **El idioma no es i18next con fuente es-MX**, sino `src/i18n` —el catálogo
>   tipado que ya existe—, con llaves inglesas y español primero, como manda
>   `docs/language.md`.
> - **El semáforo no mapea códigos de salida.** Cada tono repite un hecho que ya
>   existe (un estado de periodo, un contador en cero o no), y nunca inventa un
>   criterio contable: un cero no es «cuadrado», y una entidad sin calendario
>   nunca sale verde.
> - **IBM Plex se nombra, no se empaqueta todavía**: los tokens la piden y caen a
>   la pila del sistema si no está instalada. Versionar los `.woff2` con su
>   sha256 es pendiente, y `tokens.json` todavía no tiene consumidor: la paleta
>   del CLI y las plantillas de documentos siguen con lo suyo.
> - **Los tres dientes del criterio se cumplieron, y crecieron a seis** en
>   `E2.1`, más una prueba de conducta contra base efímera para la frontera de
>   la cartera. Miden lo que el código hace —el cuerpo impreso de cada guarda—,
>   no que el texto esté presente.
> - **Los botones que disparan actos de `/v1` no entraron**: el proxy reenvía
>   GET y HEAD y esa lista es un literal con criterio. Escribir desde el
>   navegador espera a que la API haga cumplir sus propias banderas (marcha
>   seca, compuerta en vivo, `Idempotency-Key`), que es la misma lección de la
>   auditoría integral III que esta página cita arriba.
> - **§5.1 (idioma)** está resuelto por `docs/language.md` y el epic #141.
>   **§5.3 (entidad vs despacho)** se leyó así: el inquilino ES el despacho, y la
>   cartera son las entidades que el token concede dentro de él. No se inventó
>   ningún objeto «despacho» ni migración; si el dueño lee §5.3 de otra manera,
>   lo único que cambia es de dónde sale el conjunto de entidades.
> - **Falta**, y está dicho en `docs/auditorias/W0.md`: el panel de pendientes y
>   la revisión de borradores con el CFDI al lado (que arrastra la migración
>   `ai_drafts.xml_document_id`), la escritura desde el navegador, un camino
>   local sin IdP de verdad, `axe` en CI y la paleta oscura.
