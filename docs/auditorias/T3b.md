# Auditoría adversarial de T3b «La regla que no podía fallar» (#90)

**Objeto:** R11 verificaba su propio efecto secundario, y 21 hojas aceptaban
`--idempotency-key` para tirarla.
**Fecha:** 2026-09-07.
**Método:** censo sobre el binario real → motor → verificador adversarial, que
**la tumbó** con seis hallazgos. Los seis se arreglaron aquí.

## Los dos defectos

**1 · Una regla que no puede fallar.** `declareRisk` **inyecta** `--dry-run`,
`--yes` e `--idempotency-key` en el comando, y `audit.ts` comprobaba… que esas
tres banderas existieran. Siempre existen: las acaba de poner él. Medido sobre
el binario: **36 violaciones y cero de R11**, con 36 hojas graves. La misma
tautología estaba copiada en nueve pruebas más.

**2 · La promesa está escrita en la bandera que nadie cumple.** El texto que
`risk.ts` inyecta dice *«a retry with the same key and payload returns the
recorded result»*. De las 36 hojas graves, **15 la honraban y 21 la tiraban** —
entre ellas `receipt record` y `payment create`, donde un reintento tras un
corte escribía dos cobros, dos aplicaciones y dos asientos posteados. En
`receipt-command.ts` la palabra `idempotencyKey` aparecía **una sola vez**, y era
una declaración de tipo.

## La reparación, en tres piezas que no se satisfacen por accidente

- **La declaración deja de tener omisión silenciosa.** `RiskDeclaration` gana un
  campo `llave` con **tres** respuestas posibles (ver abajo por qué tres).
- **R11 comprueba lo que la inyección no puede fabricar**: que la hoja diga qué
  hace con la llave, que el ámbito declarado **viaje hasta una llamada al
  almacén**, y que dos hojas no compartan ámbito —la unicidad de
  `idempotency_keys` es por (inquilino, ámbito, clave), así que dos hojas bajo el
  mismo ámbito **se deduplicarían entre sí**.
- **Las hojas que duplican dinero quedan cableadas** con el patrón que ya existía
  en `entry-command.ts`, no con uno nuevo.

## Lo que el adversarial tumbó, y cómo quedó

**Tres respuestas, no dos.** El parche declaraba `{ sinLlave: 'un reintento
vuelve a escribir' }` para siete hojas que **ya eran idempotentes por su
dominio** y lo decían por escrito en un aviso propio: el estado del borrador y el
hash del contenido (`review`), el UUID del CFDI (`ingest`), la reclamación
atómica de cada operación (`outbox run`), el `X-Webhook-ID` de cada entrega
(`subscription delivery sweep`), el `journal_entry_id` de la factura
(`bill approve`), el consentimiento tipeado (`sat cred add`) y la ausencia de
credencial activa (`sat cred revoke`). Publicar «un reintento vuelve a escribir»
para ellas era afirmar lo contrario de lo que su código hace. Ahora declaran
`{ innecesaria }`: la bandera **sigue funcionando** —no rompe el guion que ya la
pasa—, la ayuda dice que no hace falta, su aviso pasa de código muerto a única
fuente del motivo, y R11 no las acusa. `DEUDA_DE_LLAVES` encogió de 20 a 13, y
encogió **por clasificarse bien**, no por cablearse.

**La carga es la ENTRADA, nunca un derivado.** El hash de `receipt record`
incluía `aplicar.toFixed(2)`, que no es lo que teclea el operador sino
`Decimal.min(monto, saldo)` — derivado del saldo **vivo**. Tras el primer cobro
el saldo bajó, así que el reintento idéntico calculaba otro hash y el mismo
comando **se acusaba a sí mismo de reuso** (salida 6) en vez de devolver el
resultado grabado. Fallaba cerrado —no duplicaba dinero— pero rompía justo la
promesa que el tramo vino a hacer verdadera. Hay caso de integración que lo fija,
y se comprobó que se pone rojo devolviendo el derivado.

**La llave se mira ANTES de trabajar.** `conLlave` envuelve el acto, y para
llegar hasta él hay que pasar por un ensayo y una compuerta de estado que
dependen del saldo. Como el primer cobro ya lo bajó, el reintento idéntico moría
ahí sin llegar nunca al almacén: la promesa sólo se cumplía en la ventana en que
una segunda aplicación seguiría siendo válida, y era **falsa justo en el caso más
frecuente que hay** —cobrar la factura entera—. Se añadió `mirarLlave`, una
lectura que no consuma ni arbitra carreras (de eso sigue encargándose `conLlave`
con su restricción única), y las dos hojas contestan sin tocar el dominio.

**El rechazo no niega el ensayo, y nombra la hoja.** Vivía en el `parseArg` de la
opción, que corre mientras Commander aún no ha leído la línea entera: allí no se
sabe si además vino `--dry-run`, así que reventaba también el **ensayo** — y un
ensayo no escribe nada. Se movió a `gateMutation`, que ve las opciones resueltas
y sigue corriendo antes de cualquier escritura. Y el mensaje decía `apply`; hay
más de una hoja llamada `apply`, así que ahora dice la ruta completa.

**El manual del agente estaba desfasado.** `cli-reference.md` se le sirve al
modelo como «la superficie EXACTA del binario, cítala literalmente», y el parche
cambió la ayuda de 20 hojas sin regenerarlo: el agente seguía prometiendo el
resultado grabado para comandos que hoy la rechazan. Es el defecto de S4b un piso
más abajo, en el texto de las banderas. Se regeneró (41 líneas) **y se añadió la
puerta que faltaba**: la ayuda de `--idempotency-key` del documento tiene que
coincidir con la del `program`, hoja por hoja. Comprobado que muerde contra el
documento viejo.

## La lección del criterio, que es la del tramo

El criterio del parche comprobaba `audit.includes("rule: 'R11 …'")` sobre el
fuente. Con el literal en su sitio, la acusación podía dejar de emitirse y el
criterio seguía verde — **el mismo error que denuncia, un piso más abajo**.

Al sustituirlo por una medición (`auditProgram(program)` sobre el binario real)
aparecieron **dos mutantes vivos**, y la razón importa:

> El seam del arnés gobierna la **lectura de texto** (`crudoDe`, `codigoDe`), no
> los módulos importados. Un criterio que sólo hace `await import(...)` es
> **inmune a su propio espejo**.

Por eso el criterio hace ahora **las dos cosas**: la medición caza que la
acusación deje de emitirse con el literal intacto; el ancla deja que el arnés
siga mordiendo. No era elegir entre medir y anclar.

Y el segundo mutante enseñó otra: el ámbito `'receipt record'` aparecía en **dos**
sitios (la consulta temprana y el consumo), así que el mutante cambiaba el primero
y el segundo seguía en pie. Se hoistó a una constante única —dos literales que
puedan divergir son dos deduplicaciones distintas con el mismo nombre— y el
mutante apunta ahí.

## Batería

247 archivos y 5 255 pruebas unitarias · 88 y 1 193 de integración · 123
mutantes, todos muertos · piso y `--exigir` en verde · lint 1117/1161 ·
`ux:status` y `catalogo-estado` sin deriva.

## Lo que queda de T3

El quinto defecto —«la salida que miente»: `--fields` y la tabla vacía que
ignoran `-o/--output`, y los códigos 8 y 9— sigue fuera. Su parche funciona pero
**introduce una regresión**: `emit('')` en la rama de cero filas trunca el
archivo, y `cfdi show` hace dos `render` consecutivos. Va a tramo propio.
