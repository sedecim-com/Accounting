# El idioma del código

> Gemela en español de [[Code-language]] · source_sha: 122276e152a10070a262adfcf0e1e2b7063b37fc

Desde el 2026-09-06 la regla es una frase, precisada dos veces el mismo día hasta no dejar excepción: **todo al inglés de origen —código, comentarios, commits, documentación, informes, vocabulario persistido, contratos publicados, migraciones— y toda la experiencia de usuario ajustable a otro idioma, con el español configurado primero.** Lo único que no va al inglés es lo que no es origen: las filas ya escritas en la base y los nombres propios (SAT, CFDI, RFC, IMSS no se traducen, como IRS no se traduce en español). El documento rector es [`docs/language.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/language.md) (con su gemela española [`language.es.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/language.es.md)); el inventario que lo sostiene, con el comando de cada cifra, está en [`docs/investigacion/2026-09-06-idioma/`](https://github.com/sedecim-com/Accounting/tree/main/docs/investigacion/2026-09-06-idioma).

## Tres capas, tres tratamientos

| Capa | Idioma | Cómo se cambia |
|---|---|---|
| **Lo que lee la máquina y el programador** — identificadores, archivos, comentarios, claves, códigos de error, verbos del CLI, columnas nuevas | inglés | renombrando, con *codemod* y los instrumentos actualizados en el mismo commit |
| **Lo que lee el usuario** — ayuda y mensajes del CLI, errores de la API, rótulos, preguntas del panel, avisos de `doctor`, respuestas del agente | el del usuario: español primero y por omisión, inglés segundo | extrayendo la fuente inglesa a un catálogo y renderizando en el idioma resuelto |
| **Lo que es vocabulario persistido o contrato publicado** — claves y valores del panel, roles de cuenta, `CHECK`, códigos de error, claves del JSON, nombres de migración | inglés en la fuente; lo guardado se migra | migración de datos bajo RLS, ventana de alias y salto de versión del contrato |
| **Lo que no es origen** — filas ya escritas, artefactos ya firmados, nombres propios y acrónimos oficiales | el que tiene | no se toca |

## Lo que hay hoy

- El 45 % de las 4 637 declaraciones de `src/` está en español, y no por capa sino por fecha: lo que se escribió en agosto es inglés; lo de septiembre, español. 41 archivos y 35 migraciones llevan nombre español (las migraciones no se renombran nunca).
- El 78 % de las 29 309 líneas de comentario está en español **porque una regla lo ordena** (`CONTRIBUTING.md:158`). Esa regla se invierte para lo nuevo; lo existente no se traduce en masa.
- La ayuda del CLI es inglesa al 99 % y así lo vigilan tres instrumentos; pero la ejecución contesta en español en 24 archivos, y nadie lo medía.
- El panel de políticas está al revés del pedido: claves y valores en español (persistidos, intocables) bajo preguntas y etiquetas en inglés.
- Unas 120 plantillas de descripción de póliza están en inglés y **viajan al SAT como `Concepto`** del Anexo 24, que además se persiste entero con su hash. Es un defecto fiscal antes que de idioma.
- `account_roles.role` es un vocabulario de 36 valores españoles persistidos sin `CHECK` y leídos en 26 archivos; y los textos ingleses del panel están persistidos por inquilino, así que cambiarlos es cambiar lectores, no sólo etiquetas.
- No hay `Intl`, ni columna de idioma, ni bandera `--lang`; el único resolutor de idioma lo usa sólo el agente.

## Lo que se propone, en orden

Veintiún tramos (I0–I20; epic [#141](https://github.com/sedecim-com/Accounting/issues/141), tramos [#142](https://github.com/sedecim-com/Accounting/issues/142)–[#162](https://github.com/sedecim-com/Accounting/issues/162)), cada uno con su criterio ejecutable; cada uno deja el árbol verde y la línea base más baja, y parar en cualquiera es un estado válido.

1. **I0–I4, los cimientos**: identidad estable para los instrumentos que hoy usan texto español como clave; el léxico y la regla escrita; el metro `language:status` con cifras que sólo bajan; el lint `house/english-identifiers` que hace fallar un identificador español nuevo, con línea base por archivo; y el vocabulario estable —claves y valores del panel, los 36 roles de cuenta, los `CHECK`, los códigos publicados, las migraciones— registrado con glosa inglesa. **I5**: J0 nace en inglés.
2. **I6–I11, el usuario lee en su idioma**: un resolutor de locale (`--locale`, `es-MX` por omisión), un catálogo **tipado** (una clave sin traducción al español es un error de compilación) con formateador propio sobre `Intl`; el kernel del CLI y el piloto `bank`; las hojas por familia; la API con `Accept-Language` y códigos congelados; el panel preguntando en el idioma del contador sin tocar lo persistido; informes, `doctor` y agente.
3. **I12–I15, los renombres**: el *codemod* que actualiza criterios, umbrales, manifiesto y catálogo en el mismo commit, ensayado en un módulo sin acoplamiento; `scripts/` con alias `npm` permanentes; la API interna que cruza carpetas; SAT, DIOT, Anexo 24 y nómina sin tocar un byte de lo que sale al SAT.
4. **I16–I17, lo persistido**: clave y parámetros en pólizas, auditoría y periodos, con el `Concepto` del Anexo 24 en español desde la clave; las semillas renderizadas al sembrar por la jurisdicción.
5. **I18–I22**: el motor sellado, con sus cuatro tablas de umbral movidas a la vez; `tests/` y el instrumento; los comentarios existentes por tramo con trinquete; la documentación como experiencia de usuario (fuente inglesa y gemela española por página); y los commits en inglés.
6. **I23–I26, lo que tiene red debajo**: el vocabulario persistido con migración de datos y ventana de alias; los contratos publicados con `SCHEMA_VERSION 2` y código heredado durante una versión; las migraciones y el esquema con un mapa de nombres heredados en el migrador; y los informes fechados con su gemela. Son los últimos porque cada uno toca datos de inquilinos o clientes ajenos. **La obligación de las gemelas entra con I21 e I26**; hasta entonces cada página sin gemela cuenta en la línea base del metro, que sólo baja, empezando por los 23 informes de esta investigación. Esta página y el rector ya cumplen: fuente inglesa y gemela española con `source_sha`.

**J0 nace en inglés**: `jurisdictionOf`, `JurisdictionPackage`, `legal_parameters`, `src/jurisdictions/`. El primer paso de J0 está en curso con los nombres españoles en una rama sin fusionar; renombrar antes de fusionar es el renombre más barato de todo el plan.

## Lo que decide el dueño

Ya decididas: todo al inglés de origen, incluidos comentarios, commits, documentación, informes fechados, vocabulario persistido, contratos publicados y migraciones; toda la experiencia de usuario —la ayuda del CLI incluida— se ajusta al idioma del usuario con el español primero; los términos de dominio se traducen y sólo los nombres propios se quedan. Y sólo dos idiomas por ahora, `es-MX` y `en-US`. Queda: el alcance del lint desde el día uno.

## Para seguir

- [[Jurisdicciones]] — la otra dimensión que atraviesa todo el código, y que este cambio renombra.
- [[Catalogo-de-comandos]] — por qué los nombres canónicos de comando siguen ingleses con alias español.
- [[Como-contribuir]] — donde vive la regla del idioma.
