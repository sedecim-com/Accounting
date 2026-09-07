# El idioma del código

Desde el 2026-09-06 la regla es una frase: **el código en inglés; la interfaz en el idioma del usuario, español primero.** El documento rector es [`docs/idioma.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/idioma.md); el inventario que lo sostiene, con el comando de cada cifra, está en [`docs/investigacion/2026-09-06-idioma/`](https://github.com/sedecim-com/Accounting/tree/main/docs/investigacion/2026-09-06-idioma).

## Tres capas, tres tratamientos

| Capa | Idioma | Cómo se cambia |
|---|---|---|
| **Lo que lee la máquina y el programador** — identificadores, archivos, comentarios, claves, códigos de error, verbos del CLI, columnas nuevas | inglés | renombrando, con *codemod* y los instrumentos actualizados en el mismo commit |
| **Lo que lee el usuario** — ayuda y mensajes del CLI, errores de la API, rótulos, preguntas del panel, avisos de `doctor`, respuestas del agente | el del usuario: español primero y por omisión, inglés segundo | extrayendo la fuente inglesa a un catálogo y renderizando en el idioma resuelto |
| **Lo que es dato** — valores persistidos, textos históricos, artefactos que una autoridad exige en su idioma (el XML del SAT en español, las formas del IRS en inglés) | el que tiene; lo nuevo nace inglés | no se renombra ni se traduce: se documenta como vocabulario estable |

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
5. **I18–I20, el final**: el motor sellado, con sus cuatro tablas de umbral movidas a la vez; `tests/` y el instrumento; y los comentarios existentes sólo si el dueño lo decide.

**J0 nace en inglés**: `jurisdictionOf`, `JurisdictionPackage`, `legal_parameters`, `src/jurisdictions/`. El primer paso de J0 está en curso con los nombres españoles en una rama sin fusionar; renombrar antes de fusionar es el renombre más barato de todo el plan.

## Lo que decide el dueño

Si los comentarios que ya existen se traducen (omisión: no en masa); si los commits y la documentación pasan al inglés (omisión: siguen en español, la voz de la casa); si la ayuda del CLI sale en español por omisión (omisión: sí); y cuál es el tercer idioma.

## Para seguir

- [[Jurisdicciones]] — la otra dimensión que atraviesa todo el código, y que este cambio renombra.
- [[Catalogo-de-comandos]] — por qué los nombres canónicos de comando siguen ingleses con alias español.
- [[Como-contribuir]] — donde vive la regla del idioma.
