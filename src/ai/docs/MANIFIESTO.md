# Manifiesto del corpus del agente

Qué describe cada manual, y con qué hash de sus fuentes se revisó por última
vez. `scripts/corpus-manifiesto.ts --check` compara los hashes de hoy contra
los declarados y falla cuando una fuente cambió sin que su manual se releyera.
Corre en CI, en el job `plan`, y desde T2 comprueba además la COBERTURA: que
cada `.md` del directorio esté o en `manuales` o en `exentos`, y que el catálogo
que el agente puede pedir con `read_docs` (`DOC_TOPICS`) sea exactamente el
directorio. Hasta entonces nada comparaba las tres listas y catorce manuales
eran invisibles para este documento y para la compuerta.

## Por qué existe

El agente lee estos `.md` con `read_docs` y los trata como verdad — el
`grounding` incluso lo manda a leerlos como fuente de *verificación*. Un manual
desfasado por tanto no lo desinforma: **lo mal-instruye**, y su consumidor no
puede dudar como dudaría una persona.

La auditoría integral II encontró dos páginas que le enseñaban al agente
exactamente lo que el sistema tiene módulos para corregir:

- `mexico-cfdi.md` explicaba que el IVA de un CFDI recibido se acredita de
  inmediato — el tratamiento *anterior* a `iva-cash-basis.ts`, que aparca el
  IVA de un PPD en la 1135 hasta que el pago lo libera. El agente proponía
  asientos con el defecto que `iva-ppd-reclass.ts` existe para reparar.
- `accounting.md` prometía que anular un asiento posteado genera su reversa
  «automáticamente y auto-posteada» — imposible desde R1, que dejó el asiento
  posteado inmutable, y contrario a la regla de la casa (post/reverse/void
  jamás son invocables por el agente).

Ambas están corregidas. Este manifiesto existe para que la próxima divergencia
se acuse sola.

## Qué es y qué NO es

Es un **detector de caducidad**, no un verificador de verdad: sabe que la
fuente cambió, no si el manual sigue siendo correcto. Comprobar contenido con
expresiones regulares sería reproducir el antipatrón que la propia auditoría
censura del tablero — medir prosa y llamarlo conducta.

Por eso su mensaje de fallo no dice «arregla el manual» sino «relee este
manual contra esta fuente y, si sigue siendo fiel, actualiza el hash». Quien
actualice el hash sin releer se está mintiendo a sí mismo; el mecanismo hace
visible el acto, no puede impedirlo.

## La deuda declarada

Sellar los trece manuales de golpe habría dicho «revisado» sobre páginas
congeladas desde agosto — la misma mentira que este manifiesto viene a acabar.
Se sellan uno a uno, tras releerlos de verdad contra el código; los que faltan
están nombrados en `sin_revisar` y esa lista **sólo encoge**, con
`SIN_REVISAR_MAXIMO` como trinquete. Un manual sin revisar no puede caducar:
nunca estuvo al día, y lo que lo vigila es que la lista no crezca.

**Las cifras de hoy no se escriben aquí.** Este párrafo decía «cuatro sellados,
nueve sin revisar» cuando ya eran cinco y ocho, que es exactamente la clase de
número escrito a mano que el resto del repositorio dejó de tolerar. La cuenta
la imprime el comando:

    npx tsx scripts/corpus-manifiesto.ts --check

Sellar se hace **por manual**, tras releerlo:

    npx tsx scripts/corpus-manifiesto.ts --actualizar receivables.md

## Qué queda fuera, y por qué

La lista vive en `manifiesto.json`, bajo `exentos`, **con la razón de cada
uno**. Estuvo en prosa aquí hasta T2, y ése era el agujero: un párrafo no lo
lee ningún programa, así que un `.md` nuevo no entraba en ninguna de las dos
listas y nadie lo echaba de menos. Ahora `--check` lo pone en rojo el mismo día.

Las tres razones que hoy admite:

- `cli-reference.md` — se GENERA del binario (`scripts/generate-cli-reference.ts`)
  y ya tiene su propia prueba, que es más fuerte que un hash: compara contra el
  `program` real.
- `niif-indice.md` — su bloque enumerable se genera de `ifrs-registry.json` con
  su prueba de «regenerar no cambia nada».
- Los manuales `nif-*` / `niif-*` — describen NORMAS EXTERNAS (IFRS, NIF
  mexicanas), no este código. Su fuente de verdad es el registro normativo, no
  `src/`. Un hash de código no dice nada sobre ellos.

Exento **no** es «fuera del corpus»: el agente los lee igual. Quiere decir que
su frescura no se puede comprobar con el hash de un archivo de `src/`.
