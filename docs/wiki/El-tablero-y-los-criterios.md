# El estado no se escribe: se pregunta

Este repositorio no tiene una tabla de estado. Tuvo una, escrita a mano, y mentía: marcaba resueltos paquetes que no lo estaban y pendientes otros que sí. El comentario de cabecera de [`src/plan/criterios.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/plan/criterios.ts) lo dice sin rodeos — era «un espejo escrito a mano del repositorio», y un espejo así se desincroniza justo cuando el trabajo avanza, que es cuando más se le consulta.

La sustitución no fue una tabla mejor. Fue un comando:

```bash
npm run plan:status
```

El documento del plan **cita** los criterios; este comando los **decide**. Es la diferencia entre una afirmación y una medición, y es el eje de gobierno de todo el proyecto.

---

## Tres espejos rotos, no uno

Conviene decir primero lo que costó aprender esto, porque explica por qué la regla es tan rígida.

Hubo tres espejos del repositorio mantenidos a mano, y los tres se rompieron igual:

1. **La tabla de estado del plan de cierre.** Declaraba cerrados paquetes abiertos.
2. **La portada de `docs/cli-command-catalog.md`.** Decía «~30 comandos, casi todos de plomería del agente» cuando el binario ya respondía más de cien, doce familias de ellas contables. Duró 42 commits.
3. **El artefacto navegable del catálogo.** Llevaba las filas copiadas dentro de su HTML, con citas a un archivo ya borrado y un conteo equivocado por uno.

De ahí sale la regla de la casa: **dos marcadores, cero copias**. `npm run plan:status` decide el estado de los paquetes; `npm run catalogo:estado` decide el recuento de filas del catálogo (ver [[Catalogo-de-comandos]]). Cualquier cifra escrita a mano en un documento es deuda con fecha de caducidad desconocida.

---

## Anatomía de un criterio

Un criterio es un objeto de TypeScript. Su tipo está en [`src/plan/criterios.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/plan/criterios.ts):

```ts
export interface Criterio {
  paquete: string;
  /** Qué se afirma, en términos de comportamiento observable. */
  enunciado: string;
  /** Precondición que el runner comprueba antes de evaluar. */
  necesita?: 'base-de-datos' | 'red';
  evaluar: () => Promise<Resultado> | Resultado;
}
```

Y así es uno real, completo, del paquete E1.4 (activos fijos). Está en rojo hoy:

```ts
{
  paquete: 'E1.4',
  enunciado: 'La depreciación mensual tiene por dónde invocarse',
  evaluar: () => {
    const cons = consumidoresDe('runMonthlyDepreciation', 'depreciation.ts');
    return cons.length > 0
      ? ok(`invocable desde ${cons.join(', ')}`)
      : falla('runMonthlyDepreciation no tiene llamador: el motor existe y no hay puerta');
  },
},
```

Tres piezas, y las tres importan:

- **El enunciado** afirma una propiedad observable del sistema, no un identificador. La regla está escrita en la cabecera del archivo y viene de un error concreto: el cerrojo antisimulación del timbrado se construyó bien y falló el cien por ciento de sus criterios *escritos* porque su autor eligió nombres en español. Un criterio puede nombrar un archivo solo cuando el plan está prescribiendo dónde va el código.
- **La comprobación** es código que se ejecuta. Aquí usa `consumidoresDe`, un ayudante que busca qué archivos —fuera del que lo define y fuera de las pruebas— nombran un símbolo. Es la forma de detectar **capacidad huérfana**: código que existe, compila y no llama nadie.
- **El mensaje de falla dice la razón exacta**, no el síntoma. «El motor existe y no hay puerta» es accionable; «falta depreciación» no lo sería, y además sería falso.

Ese tercer punto es una regla dura: el detalle de una falla es lo único que se imprime cuando el criterio se pone en rojo, así que tiene que bastar para actuar sin abrir el código.

### Los ayudantes, y el error que cada uno recuerda

Casi todos los criterios se apoyan en cuatro funciones exportadas del mismo archivo, y cada una nació de un falso veredicto:

| Ayudante | Qué hace | El error que evita |
|---|---|---|
| `sinComentarios` | Quita comentarios de línea y de bloque antes de buscar | Un criterio afirmó que dos políticas se consumían, y su única evidencia era una frase dentro de un comentario. Una mención en prosa no ejecuta nada |
| `codigoDe` | Lee un archivo ya sin comentarios | Un comentario que narraba código **ya borrado** produjo un rojo falso contra un endpoint que hoy se niega a mentir |
| `dondeAparece` | Archivos donde casa un patrón, opcionalmente solo en código | Distinguir el uso real de la cita |
| `consumidoresDe` | Quién nombra un símbolo fuera de su definición y de las pruebas | Capacidad muerta que parece viva |

Y hay una exclusión deliberada que conviene conocer: `fuentes()` **no recorre `src/plan`**. El archivo de criterios cita los patrones que persigue, y en su primera corrida se acusó a sí mismo — el criterio que busca «TODO junto a un acto externo» encontró el literal de su propia expresión regular. El precio está confesado en el propio comentario: el instrumento de medida no se mide. Lo que sí se mide es el instrumento por otra vía, en [`tests/plan/criterios.spec.ts`](https://github.com/sedecim-com/Accounting/blob/main/tests/plan/criterios.spec.ts), cuyas pruebas nacieron una por una de errores que el comando cometió contra este repositorio.

---

## El estado de un paquete es el PEOR de sus criterios

No hay porcentajes. La función que decide vive en [`src/plan/status.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/plan/status.ts):

```ts
export function estadoDe(evaluaciones: Evaluacion[]): EstadoPaquete {
  const ok = evaluaciones.filter((e) => e.resultado.estado === 'ok').length;
  const fallan = evaluaciones.filter((e) => e.resultado.estado === 'falla').length;
  const evaluables = evaluaciones.filter((e) => e.resultado.estado !== 'no-evaluable').length;

  if (evaluables === 0) return 'sin-evaluar';
  if (ok === evaluaciones.length) return 'resuelto';
  if (fallan === 0) return 'no-demostrado';
  if (ok === 0) return 'pendiente';
  return 'parcial';
}
```

Un paquete con nueve criterios en verde y uno en rojo no está «casi cerrado»: está **abierto**. La razón es práctica. Quien depende de un paquete no consume el promedio de sus criterios, consume la propiedad que falta. Un noventa por ciento de aislamiento entre inquilinos no es aislamiento (ver [[Aislamiento-multi-inquilino]]).

Los cinco estados posibles:

| Estado | Significa |
|---|---|
| `resuelto` | Todos los criterios se evaluaron y pasaron |
| `no-demostrado` | Ninguno falla, pero alguno no se pudo evaluar |
| `parcial` | Unos pasan, otros fallan |
| `pendiente` | Ninguno pasa |
| `sin-evaluar` | No hubo un solo criterio evaluable |

La distinción entre `resuelto` y `no-demostrado` es la que más trabajo costó. La primera corrida marcó E0.2 en verde con un criterio que nadie pudo evaluar: **un hueco no es un acierto, es un hueco**. Y por la misma razón, un criterio que revienta al ejecutarse no cuenta como cumplido — se reporta como no evaluable con la causa, que es lo que hace falta para arreglarlo.

La salida solo detalla lo que **no** está en verde. Una lista de aciertos es ruido que esconde el único renglón que hay que leer. Para filtrar por prefijo de paquete:

```bash
npm run plan:status E5.1
```

---

## El criterio que necesita algo del entorno

El campo `necesita` del tipo `Criterio` existía desde el principio y el runner **no lo miraba nunca**. La consecuencia salió cara y está narrada en el código: alguien escribió un criterio correcto —el sello de un periodo, que solo se puede comprobar contra Postgres—, declaró `necesita: 'base-de-datos'`, y el trabajo de CI que evalúa el plan no tiene base. El criterio se reportó no evaluable, el paquete cayó de verde, el trinquete lo leyó como retroceso y la CI se puso roja. Para desatascarla hubo que **borrar el criterio bueno**.

Un campo declarado que nadie honra es peor que un campo ausente: promete una semántica y entrega otra.

Hoy `bloqueadoPorEntorno` separa las dos cosas. Un criterio bloqueado por una precondición ausente **se sigue mostrando** en la salida, con su causa —«necesita base-de-datos: no cuenta para `--exigir` aquí»—, pero no cuenta para el trinquete. Si contara, el mismo commit pasaría en una portátil con Postgres y fallaría en CI sin él, y una compuerta que depende de dónde corre no es una compuerta.

Hoy hay exactamente un criterio con esa marca, en E0.1, y es la razón por la que ese paquete aparece como no demostrado y no como resuelto.

---

## El trinquete: `--exigir`

Sin `--exigir`, el comando siempre sale con código 0. Un paquete abierto es información, no un fallo del build.

El trabajo `plan` de [`.github/workflows/ci.yml`](https://github.com/sedecim-com/Accounting/blob/main/.github/workflows/ci.yml) corre esta línea, que sí es una compuerta:

```bash
npm run plan:status -- --exigir=E0.0,E0.1,E0.2,E0.3,E1.1,E1.2,E1.3,E2.1,E2.2,E3.1
```

Lo que hace: imprime el estado completo de todos los paquetes y **falla si alguno de los nombrados está abierto por algo que este entorno sí podía medir**. No exige trabajo nuevo; impide el retroceso de lo ya cerrado.

Tres detalles del diseño que no son obvios:

- **Se evalúa contra todos los paquetes, no contra los que el filtro dejó a la vista.** `plan:status E0 --exigir=E1.3` no debe pasar por no haber mirado E1.3.
- **Un paquete que no existe no está cerrado: no se sabe.** `--exigir=E9.9` salía con 0 y en silencio, así que el trinquete se podía vaciar sin ponerse rojo — bastaba renombrar o borrar un paquete en `criterios.ts` para reabrir lo cerrado sin que la CI se enterara. Hoy un id desconocido es un fallo con su mensaje: el instrumento vive en el mismo commit que el cambio que juzga, y ésa era justo la regresión de la que nada lo protegía.
- **La lista solo crece**, con una excepción, que es la parte interesante.

### Reabrir un paquete es un acto que viaja en el diff

Cuando un paquete resulta ser un **falso verde**, el commit que descubre el engaño hace dos cosas a la vez: corrige el criterio para que diga la verdad, y **saca el paquete de la lista de `--exigir`**, con su porqué escrito en el propio workflow. La reapertura no se negocia en un canal ni se anota en un documento aparte: aparece en el diff, al lado del criterio arreglado.

Ha pasado tres veces, y las tres razones están en el YAML:

| Paquete | Por qué se reabrió |
|---|---|
| E1.2 | Prometía rastro en `cfdi_classifications` y la tabla tiene cero menciones en `src` |
| E4.1 | Lee `paycheck_taxes`, `employer_tax_liabilities` y `garnishments`; ningún camino las escribe, así que los 941/940 reportan ceros y los embargos salen de una tabla que nadie puebla |
| E3.2 | Su criterio pasaba porque una expresión regular casaba **dos cadenas de prosa** en una pregunta de política. La descarga masiva del SAT no existe: ni cliente SOAP, ni lector de paquetes ZIP, ni comando |

E1.2 volvió a la lista cuando su salida existió de verdad. E3.2 sigue fuera, y su criterio actual exige un módulo bajo `src/services/sat-download/` — algo que el camino de políticas no puede imitar con una cadena. Ver [[Fiscal-mexicano]] y [[Hoja-de-ruta]].

---

## La disciplina de mutación

Un criterio nuevo no se da por bueno porque salga en verde. Se verifica **en las dos direcciones**: se rompe a propósito la conducta que afirma y se comprueba que el criterio lo acusa. Si al romper la conducta el criterio sigue en verde, el criterio no mide lo que dice medir — mide otra cosa, y esa otra cosa suele ser «el símbolo existe», que ya lo mide el compilador.

Esta disciplina descubrió una familia entera de fallos, siempre la misma: **la expresión regular casa el símbolo equivocado**. Los comentarios de `criterios.ts` la numeran a medida que reaparece; éstas son las variantes documentadas en el árbol de hoy:

| Variante | Caso real |
|---|---|
| **El import en vez de la llamada** | Un `import` huérfano dio verde en la primera mutación del criterio de fronteras por entidad. Hoy exige la forma de llamada: `findByIdInScope[<(]` |
| **La firma de la función vecina** | El criterio de la serie del folio anclaba a `fecha: Date | string`, pero la firma de `añoDeDocumento` también dice eso — y dio verde a la mutación que volvía opcional la fecha del folio. Hoy recorta primero el tramo de `nextEntityNumber` |
| **La firma en vez de la llamada** | «La FIRMA de `checkPermisosEnConflicto()` también casa `nombre()`» — cuarta aparición de la familia. Hoy exige el `checks.push(await checkPermisosEnConflicto())` completo |
| **El sufijo de nombre** | Sin `\b` tras el nombre, un índice renombrado a `uq_xml_documents_entity_cfdi_x` seguía casando. Quinta variante |
| **El substring en prosa** | `cfdi_periodo_cerrado` contaba como política consumida porque su nombre aparece como etiqueta de una decisión del clasificador, no porque nadie llame a `getPolicy` con ella |
| **El re-export como consumidor** | `allDeclarations` tenía «consumidor» porque el barril `kernel/index.ts` lo reexporta. Un archivo que solo reexporta no consume nada; el criterio decía «el puente existe» mientras las herramientas del agente seguían escritas a mano |
| **Contar una donde hay dos** | La comparación por resta de JSONB falta en una de **dos** funciones y el criterio pasaba: contaba una sola ocurrencia. Igual con la medición de uso del agente, que se emite en dos sitios y en tres en el adaptador compatible |

### La regla práctica

De todo lo anterior salen dos instrucciones concretas para quien escriba un criterio nuevo:

1. **Anclar a la forma de LLAMADA, no al nombre.** `getPolicy(` y no `getPolicy`. `checks.push(await unaFuncion())` y no `unaFuncion`. Si el símbolo puede aparecer en un import, en una firma, en un reexport o en una cadena de prosa, el patrón desnudo casará las cuatro.
2. **Contar ocurrencias, nunca comprobar presencia.** Si la conducta vive en dos sitios, el criterio exige dos; si en tres, tres. Un chequeo de presencia sobrevive a que alguien mute el sitio principal y deje el secundario, que es exactamente cómo se cuela una regresión.

Y una tercera, implícita en las dos: si el criterio necesita mirar una función concreta de un archivo que tiene varias, **recórtale el tramo primero** (`indexOf('export async function …')`) en vez de buscar sobre el archivo entero.

---

## Lo que este tablero todavía no mide

Esta sección existe porque una página de wiki que oculte un hueco traiciona al proyecto. Todo lo que sigue es verificable abriendo los archivos citados.

**La mayoría de los criterios son expresiones regulares sobre el fuente, no sobre la conducta.** De los criterios que hay hoy, todos menos un puñado se evalúan leyendo archivos: `codigoDe`, `dondeAparece`, `consumidoresDe`, `readFileSync` sobre una migración. Exactamente **uno** declara `necesita: 'base-de-datos'` y por tanto observa el sistema corriendo; dos consultan a `git` como autoridad externa. El resto afirma cosas sobre el texto del código. Eso es mucho mejor que una tabla escrita a mano —el texto del código no miente sobre sí mismo— pero no es lo mismo que probar la conducta. Lo que prueba la conducta son las suites de [[Pruebas-y-CI]], y son un instrumento distinto con un alcance distinto.

**El trinquete es de granularidad PAQUETE, no criterio.** `--exigir` pregunta si un paquete está abierto; un paquete ya abierto **absorbe cualquier regresión interna** sin cambiar el veredicto. La línea de CI omite E1.4, E3.2, E4.1, E4.2 y E5.1, y esos cinco paquetes concentran hoy diecisiete criterios en verde que **ningún commit puede poner en rojo ante la CI** — trece de ellos en E5.1 solo. Se reproduce contrastando la salida del comando contra la lista `--exigir` del workflow:

```bash
npm run plan:status
```

Entre esos diecisiete está `Ninguna herramienta del agente alcanza el mayor ni ejecuta hacia fuera`, que es la garantía central del producto: el agente propone, un humano dispone (ver [[El-agente-y-sus-limites]]). La auditoría lo reprodujo por mutación —añadiendo un archivo en `src/ai/tools` que solo *nombra* `postJournalEntry`— y la línea literal de CI salió con código 0. El detalle está en [`docs/auditorias/2026-09-01-integral-ii/instrumento.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/auditorias/2026-09-01-integral-ii/instrumento.md) y el arreglo —trinquete a granularidad de criterio— es una partida abierta del plan, no algo ya hecho.

Un matiz a favor del diseño, porque conviene no exagerar el defecto: dentro de un paquete **exigido y verde**, cada criterio sí queda trinquetado individualmente, porque `estadoDe` obliga a que pasen todos. El hueco solo muerde en los paquetes ya abiertos. Y la elección está confesada en el propio workflow: «un paquete abierto es información, no un fallo». El defecto es la consecuencia no advertida de esa elección, no la elección.

**Hay trabajos de CI que ningún criterio vigila.** El criterio de E0.0 exige que exista un solo archivo de workflow y que declare los trabajos `typecheck`, `unit`, `integration` y `aislamiento`. El archivo tiene seis: `lint` y `plan` **no** están en esa lista. Borrar el trabajo de lint del YAML no pondría rojo ningún criterio.

**Las pruebas del instrumento no verifican que los criterios pasen.** `tests/plan/criterios.spec.ts` comprueba que cada criterio tenga enunciado, que su detalle no venga vacío y que los ayudantes se comporten. No afirma el veredicto de ningún criterio, y no debe hacerlo: un criterio en rojo es información legítima, no un test roto.

---

## Para seguir

- [[Catalogo-de-comandos]] — el otro marcador de la casa, y su suelo que solo sube
- [[Pruebas-y-CI]] — los instrumentos que sí observan la conducta
- [[Auditorias]] — de dónde salen los rojos honestos de esta página
- [[Hoja-de-ruta]] — qué paquetes están abiertos y qué falta para cerrarlos
- [[Como-contribuir]] — el orden en que fallan las puertas, de la más barata a la más cara
