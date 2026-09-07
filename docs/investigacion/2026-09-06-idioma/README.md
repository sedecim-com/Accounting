# Inventario del idioma del código · 2026-09-06

El pedido: *todo el código basado en inglés y, a partir de ahí, traducido a distintos idiomas dejando primero el español*. Antes de escribir un plan había que saber cuánto hay de cada cosa y qué se rompe al moverlo. Ocho lectores, uno por superficie, con la consigna de publicar **el comando exacto** de cada cifra; escépticos que volvieron a correr los comandos; y un panel de diseño (tres arquitectos con lentes distintas, dos jueces) cuya síntesis alimenta [`docs/idioma.md`](../../idioma.md), el documento rector.

| Informe | Superficie | Lo que decide |
|---|---|---|
| [`inventario/identificadores.md`](inventario/identificadores.md) | Identificadores y nombres de archivo en `src/` | 4 637 declaraciones: 49 % inglés, 45 % español, 5 % mixto (1,5 % de error medido); la partición es por fecha, no por capa; 51 de 133 criterios se rompen con un renombre masivo |
| [`inventario/cli.md`](inventario/cli.md) | Textos de usuario del CLI | Ayuda 99 % inglesa y ejecución 30 % española: 24 archivos enseñan en inglés y contestan en español; el kernel es la costura para un catálogo |
| [`inventario/api.md`](inventario/api.md) | REST y GraphQL | 72 códigos de error, 24 con vocablo español; servicios 81 % español, `src/api` 81 % inglés, mismo sobre; cero `Accept-Language` |
| [`inventario/textos-emitidos-y-persistidos.md`](inventario/textos-emitidos-y-persistidos.md) | Lo que se escribe en la base o se emite a terceros | ~120 plantillas de póliza en inglés que viajan al SAT como `Concepto`; nombres de periodo persistidos en `en-US`; el panel con claves españolas bajo textos ingleses |
| [`inventario/esquema-y-vocabularios.md`](inventario/esquema-y-vocabularios.md) | Esquema y vocabularios como datos | 5 tablas y 117 columnas españolas (77 espejan al SAT/IMSS/DIOT), 43 valores de `CHECK`, 53 claves y 93 valores del panel: qué es renombrable y qué es vocabulario estable |
| [`inventario/pruebas-criterios-ci.md`](inventario/pruebas-criterios-ci.md) | Pruebas, criterios, CI y metros | El piso usa el enunciado español como identidad; umbrales por archivo por triplicado; 232 de 336 spec con títulos en español; la secuencia viable empieza por un PR cero |
| [`inventario/comentarios-y-corpus.md`](inventario/comentarios-y-corpus.md) | Comentarios y corpus del agente | 29 309 líneas de comentario, 78 % en español **por regla** (`CONTRIBUTING.md:158`); el prompt y las herramientas del agente ya en inglés; el manifiesto sella 46 archivos con comentarios incluidos |
| [`inventario/formato-y-locale.md`](inventario/formato-y-locale.md) | Formato y locale | Cero `Intl`; 8 `toLocaleString` cableados; 313 plurales a mano; un solo resolutor de idioma, y sólo lo usa el agente; ni columna ni bandera de idioma |

`verificacion/` guarda lo que los escépticos corrigieron; `diseno/` las tres propuestas y `juicio/` las dos evaluaciones que las puntuaron. Los conteos del documento rector son los **corregidos**; cuando un escéptico no llegó a correr (el límite de sesión de la cuenta mató agentes en dos corridas), la cifra es la del lector y el informe lo dice.

Ninguna página ni archivo leído traía instrucciones dirigidas a un asistente; el contenido se trató como dato.
