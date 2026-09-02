# Auditoría adversarial de G1b «El flujo de efectivo, amarrado al efectivo»

**Objeto:** el commit del tramo G1b, segunda y última mitad de G1.
**Fecha:** 2026-09-02.
**Método:** dos agentes de motor → un agente de superficie → dos verificadores
adversariales. El adversarial escribió **29 ataques** contra Postgres y
confirmó **un defecto de gravedad 1**, que arregló.

## Lo que el tramo cerró

El estado de flujos era **el único informe que nunca se extrajo a la capa de
servicios**: vivía entero dentro de `src/api/rest/routes/reports.ts`. De ahí
salían sus cuatro mentiras y una quinta consecuencia:

1. **El parámetro `method` no hacía nada.** Se aceptaba, se DEVOLVÍA en la
   respuesta y jamás cambiaba el cálculo: quien pidió el método directo
   recibió el indirecto, etiquetado como directo.
2. **El financiamiento estaba fijo en la cadena `'0.0000'`.** No se calculaba
   de ningún sitio: se afirmaba.
3. **AR y AP se detectaban con `name ILIKE '%receivable%'` y `'%payable%'`** —
   en INGLÉS, contra el catálogo de cuentas que este mismo producto siembra en
   español («Clientes», «Proveedores»). No casaba nada, así que los cambios en
   capital de trabajo salían en cero. Y cero es un número perfectamente
   presentable: nadie lo notaba.
4. **Nada lo amarraba contra el efectivo real**, siendo el único estado
   financiero cuyo error se comprueba desde fuera: cualquiera lo contrasta
   contra su banco.
5. Y como vivía en la ruta, **el CLI y el agente no lo tenían**, mientras REST
   era un segundo motor de los que G4 existe para impedir.

Ahora el motor vive en `src/services/reporting/cash-flow-service.ts`, la ruta
quedó como llamador delgado, la clasificación pasa por el MAPA DE ROLES —que
sobrevive a renombres, traducciones y catálogos importados, que es justo lo
que los nombres no hacen— y `cashflow reconcile` contrasta contra el
movimiento real de efectivo **imprimiendo el residuo en vez de absorberlo**.

## El defecto de gravedad 1, y por qué es el más instructivo del mes

`cash-flow-service.ts` llamaba a `getPolicy` con las tres claves nuevas del
panel. Y `getPolicy` **no devuelve el defecto cuando la clave no está en el
catálogo: LANZA**. Como las tres filas del panel se habían perdido (ver más
abajo), `cashflow generate` no arrancaba ni una vez, en toda entidad y toda
instalación:

```
Error: Policy "flujo_efectivo_metodo" does not exist in the catalog or in the database
  ❯ getPolicy src/services/policy/policy-service.ts:154
  ❯ politicasDeFlujo src/services/reporting/cash-flow-service.ts:122
```

**Lo grave no es el defecto: es cómo se veía desde el instrumento.** Las 55
pruebas del implementador —23 de integración y 32 unitarias— pasaban EN VERDE
con el defecto puesto. El verificador lo comprobó revirtiendo el arreglo y
corriéndolas. Pasaban porque la suite de integración importaba **sólo** la
mitad que envuelve su lectura en `try/catch`, y nunca llamaba al informe; y
porque las unitarias mockean la base. Es exactamente el defecto que este
proyecto lleva un mes persiguiendo: **un instrumento verde sobre un informe
muerto**.

## Nota de proceso: el tramo se escribió dos veces

A media ejecución, otra sesión que trabaja sobre el mismo árbol archivó todo
G1b en un `git stash` («G1b a medias, taller detenido») y el árbol quedó
limpio bajo los agentes. Consecuencias, todas reales y todas registradas aquí
porque forman parte de cómo se hizo el tramo:

- Los archivos del CLI y el bloque de `flags.ts` **no entraron en el stash**:
  se borraron. El agente de superficie los había copiado fuera del árbol y los
  restauró desde ahí.
- **Las tres políticas del panel se perdieron**, y ésa es la causa raíz del
  defecto de gravedad 1 de arriba.
- El verificador adversarial atacó el motor en un worktree aislado y NO tocó
  el stash ajeno, que es lo correcto: desarchivar el trabajo que otra sesión
  aparcó no es de quien pasaba por ahí.
- La ruta REST adelgazada sólo existía dentro del stash; se extrajo con
  `git checkout stash@{0} -- <archivo>`, sin aplicarlo ni borrarlo.

La lección para el taller es de diseño, no de nadie: **un tramo no se
paraleliza sobre un árbol compartido sin decirlo**. Y su corolario, ya
aplicado aquí: las políticas del panel y su lector viajan en el MISMO commit,
porque separados uno de los dos se pierde y el otro revienta.

## Lo reportado y NO hecho, con domicilio

- `cashflow category set` (fase 2 del catálogo): necesita una columna
  `cash_flow_category` en `accounts`, o sea migración.
- `cashflow explain` y `cashflow check` (fase 3).
- El método DIRECTO: se ofrece la opción en el panel, pero exige que cada
  movimiento de efectivo esté clasificado por concepto en el momento de
  registrarlo. Mientras no lo esté, pedirlo falla cerrado en vez de devolver
  el indirecto disfrazado.

## Veredicto

G1b **cierra, y con él G1 entero**. El estado que se firma ya no puede no
tener relación con el banco sin que nadie lo diga, y el que la tiene lo
demuestra con su residuo a la vista.
