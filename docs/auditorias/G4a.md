# Auditoría adversarial de G4a «Una sola superficie declarada»

**Objeto:** el commit del tramo G4a, primera mitad de G4.
**Fecha:** 2026-09-02.
**Método:** dos agentes de motor en fases secuenciales (registro → idempotencia,
para que no se pisaran sobre las mismas rutas) → dos verificadores
adversariales. El adversarial escribió **35 ataques** y encontró **tres
defectos**, incluido uno que invalidaba el censo entero.

## La tesis, y por qué era urgente

El registro de riesgo del CLI **es** la arquitectura que hace seguro al agente:
cada hoja declara su clase y, si una declara a la vez «irreversible» y
«accesible al agente», el binario NO ARRANCA. La API no tenía nada de eso —
**87 rutas de escritura en 17 archivos, ninguna declaraba nada**— y G3 acababa
de demostrar que no era teórico: una de ellas posteaba al mayor saltándose el
control de cuatro ojos que el CLI declaraba no exponer.

Ahora `declararRiesgoRuta` traduce el gemelo con las **mismas cuatro palabras**,
para que una ruta y el comando que hace lo mismo se comparen sin traducir. Dos
decisiones de diseño que merecen quedar escritas:

- **La declaración ES un manejador**, el primero. Commander tiene un objeto
  `Command` donde colgarla; Express no. Al viajar dentro de lo que Express
  registra, no puede desincronizarse de lo que la ruta hace. Y no es un
  no-op: deja la clase en `res.locals`, de donde sale el renglón de auditoría
  — un marcador que no hiciera nada se leería como código muerto y alguien lo
  borraría.
- **El censo recorre la pila real** (`_router.stack`), no una lista al lado
  del código. Una lista paralela es el defecto que este proyecto lleva un mes
  cazando, y aquí habría sido el más caro: declararía lo que alguien recordó,
  no lo que la app sirve.

Y añade una prohibición que el CLI no tenía: `soloBorrador` sin `agente` es la
afirmación que habilita al agente, y sola queda como una garantía que nadie
comprueba.

## Los tres del adversarial

**1 · El mismo acto con dos clases según la puerta — el defecto entero del
tramo, en una ruta.** `POST /v1/xml/upload` se declaró `escritura`, y postea
al mayor: `processXMLUpload` → `processToAccounting` → `createJournalEntry`
con auto-posteo; la respuesta ya devolvía `journal_entry_id`. Su hoja gemela,
`mnemosine ingest`, siempre declaró `irreversible`. Y la clase de menos no era
inocua: **`escritura` es la ÚNICA clase abrible al agente**, así que la ruta
que postea quedaba a un booleano de ser invocable por él, y sin llave de
idempotencia.

**2 · El censo aceptaba declaraciones que no llegan a correr.** Buscaba la
marca en TODA la cadena, así que `router.post('/x', manejador, declararRiesgoRuta(...))`
pasaba por declarada — y no lo estaba en ningún sentido útil: el manejador ya
respondió cuando al marcador le tocaría correr. Medido con dos rutas idénticas
salvo el orden, contra filas reales: **declaración delante → 1 fila;
declaración detrás → 2 filas**. La segunda pasaba el censo. Una declaración
que certifica sin proteger es peor que ninguna, porque el censo la cuenta como
cerrada. Ahora la posición se exige, y el arranque muere nombrando la ruta y
su posición.

**3 · Cuatro rutas cruzaban la frontera de entidad**, una de ellas
`irreversible`: `POST /v1/processing-batches/:id/execute` **contabilizaba en
los libros de otra sociedad** del mismo inquilino. El alcance entró en el
UPDATE de arranque y no en un SELECT previo, para no dejar la ventana entre
comprobar y escribir.

## Lo que el orquestador tuvo que completar

El adversarial arregló esas cuatro rutas **dentro del SQL**, que es la regla de
la casa y es necesario — pero **no suficiente**, y el criterio E2.1 lo dijo:
seguían sin `requireEntityAccess`. Son dos comprobaciones distintas y ambas
hacen falta: el SQL comprueba que la FILA sea de esa entidad; el middleware,
que el usuario PUEDA PEDIR esa entidad. Sin él basta la cabecera `x-entity-id`
para elegir a quién apuntar, y el SQL obedecerá encantado. Montado en las
cuatro.

## Lo que la idempotencia enseñó

La llave **se deriva de la declaración**, no de una lista: `exigeLlaveDeIdempotencia`
es cierto para `irreversible` y `externo` —timbrar dos veces ante un PAC
tampoco se deshace—, y son 36 rutas. Declarar la clase obtiene la llave; no
hay un segundo sitio donde acordarse en la ruta 37.

Y el hallazgo del frente: la primera versión grababa la llave escuchando
`finish`, o sea **después de que la respuesta volara**. Entre el 201 que lee el
cliente y el INSERT quedaba una ventana en la que su reintento no encontraba
la llave — exactamente el caso que la idempotencia existe para cubrir, porque
un reintento ocurre cuando la respuesta no llegó.

## Lo reportado y NO hecho, con domicilio

- **OpenAPI generado desde los Zod que ya existen** → G4b.
- **El trabajador de reintentos de webhooks salientes**, cuyo índice existe
  desde la 003 → G4b.
- **La decisión sobre GraphQL**: con el freno por inquilino y los permisos que
  ya ganó, no puede argumentarse por «líneas no recuperables». O entra al
  inventario o sale del árbol, y eso lo decide el despacho, no un tramo.

## Veredicto

G4a **cierra**. La API deja de ser un motor con menos reglas: declara lo mismo
que el CLI, con las mismas palabras, y el arranque muere si una ruta que muta
no lo hace. Lo que queda de G4 —OpenAPI y los reintentos— es superficie, no
asimetría.
