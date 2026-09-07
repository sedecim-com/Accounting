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
- Unas 120 plantillas de descripción de póliza están en inglés y **viajan al SAT como `Concepto`** del Anexo 24. Es un defecto fiscal antes que de idioma.
- No hay `Intl`, ni columna de idioma, ni bandera `--lang`; el único resolutor de idioma lo usa sólo el agente.

## Lo que se propone, en orden

1. **I0** — las reglas escritas, el metro `i18n:estado` con cifras que sólo bajan, el lint que hace fallar un identificador español nuevo, y un PR cero que dé identidad estable a los instrumentos que hoy usan texto español como clave.
2. **I1** — el catálogo (`src/i18n/`, ICU MessageFormat), un resolutor de idioma, `--lang`, y la ayuda de Commander traducida al renderizar mientras los instrumentos siguen midiendo la fuente inglesa.
3. **I2–I5** — el CLI por familias, la API con `Accept-Language` y códigos congelados, el panel preguntando en el idioma del contador, y lo persistido guardado como clave y parámetros (con el `Concepto` del Anexo 24 en español desde la clave).
4. **I6** — el formato sigue a la jurisdicción y a la moneda, nunca al idioma.
5. **I7** — los renombres, un subsistema por PR, con un *codemod* que actualiza criterios, umbrales, manifiesto y catálogo en el mismo commit; `accounting` y el propio instrumento al final.
6. **I8–I9** — el agente lee el mismo resolutor; un tercer idioma como prueba de que el sistema es un sistema.

**J0 nace en inglés**: `jurisdictionOf`, `JurisdictionPackage`, `legal_parameters`, `src/jurisdictions/`. El primer paso de J0 está en curso con los nombres españoles en una rama sin fusionar; renombrar antes de fusionar es el renombre más barato de todo el plan.

## Lo que decide el dueño

Si los comentarios que ya existen se traducen (omisión: no en masa); si los commits y la documentación pasan al inglés (omisión: siguen en español, la voz de la casa); si la ayuda del CLI sale en español por omisión (omisión: sí); y cuál es el tercer idioma.

## Para seguir

- [[Jurisdicciones]] — la otra dimensión que atraviesa todo el código, y que este cambio renombra.
- [[Catalogo-de-comandos]] — por qué los nombres canónicos de comando siguen ingleses con alias español.
- [[Como-contribuir]] — donde vive la regla del idioma.
