# Sprint 01 · Que los ✅ se puedan comprobar

> Propuesta. Derivada de una verificación de los quince paquetes del backlog contra el código, no
> contra los documentos. Resultado de esa verificación: **ningún paquete está cerrado del todo** —
> once parciales, cuatro sin empezar — y aparecieron 43 brechas que ninguno de los dos planes lista.

## El diagnóstico en una frase

No hay un problema de trabajo pendiente; hay un problema de **verificabilidad**. La CI existe y
nunca ha corrido. Los criterios de cierre están escritos como comprobaciones ejecutables y nadie los
ha ejecutado. Los dos planes marcan cosas como resueltas apoyándose en commits, no en el código. Y
la mitad de este sprint es más barata que la conversación de decidir si hacerla.

Por eso el sprint no persigue capacidad nueva: persigue que **cada ✅ futuro sea una comprobación y
no una afirmación**. Sin eso, cualquier sprint siguiente se planifica sobre un estado imaginario.

---

## S1 · Retirar el daño activo · **un día**

Cuatro defectos vivos, todos verificados hoy, todos de un cambio pequeño. Es la única clase de
trabajo que quita un peligro en vez de agregar capacidad, y por eso nadie la agenda.

| # | Qué | Por qué ahora |
|---|---|---|
| **S1.1** | ~~Guardar `cancel` en `pac-router` con el mismo cerrojo antisimulación que `stamp`~~ · **hecho** | Cancelar es irreversible ante el SAT: un acuse fabricado es peor que un timbre fabricado |
| **S1.2** | ~~Retirar `POST /v1/invoices/:id/cfdi/cancel`~~ · **hecho** | Era `// TODO: enviar al PAC` seguido de `UPDATE cfdi_status='cancelled'` y un HTTP 200. El mayor creía cancelado un CFDI que el SAT sigue considerando vigente |
| **S1.3** | Corregir las cinco referencias a `p.futa_employer` en `form-940-generator` — la columna real es `paychecks.futa` | La forma 940 revienta en tiempo de ejecución la primera vez que alguien la invoca |
| **S1.4** | Extender el escáner SQL a los SELECT de una tabla **con alias** | Es la razón de que el contrato de esquema esté verde con S1.3 vivo: su alcance declarado excluye consultas con alias o JOIN |

S1.1 y S1.2 ya están aplicados: el commit CLI-5 afirmaba haber retirado todo el código que reporta
éxito de actos que no realiza, y `cancel` se le escapó. Corregirlo era hacer verdadero el mensaje de
un commit propio.

S1.4 es el que importa a plazo: sin él, esta clase de defecto vuelve. La prueba de contrato declara
su propio alcance como «columnas de SELECT cuando la consulta toca UNA sola tabla sin alias ni
JOIN», así que está verde mientras el bug vive. Un verificador por `PREPARE` sobre los literales SQL
del árbol encontró tres defectos de esta clase en una pasada; conviértelo en la comprobación.

**Pregunta de cierre:** ¿un `grep` encuentra cero funciones que reporten éxito de un acto externo
que no ejecutan, y el escáner extendido corre en CI?

---

## S2 · Hacer que la CI exista de hecho · **dos días**

La CI está escrita y **nunca ha corrido**: no hay remoto, así que el workflow no se ha disparado
jamás. Y cuando corra, uno de sus cuatro jobs está garantizado en rojo.

1. **Dar remoto al repositorio y empujar.** Hoy los siete commits del CLI viven en una rama sin
   fusionar y nada los ha ejecutado fuera de esta máquina.
2. **Resincronizar `package-lock.json`.** `npm ci` falla por una dependencia ausente del lock, y los
   cuatro jobs empiezan por ahí: hoy morirían en el primer paso.
3. **Arreglar el job de aislamiento.** Necesita `SUPERUSER_URL`, la contraseña del rol de
   aplicación, un paso previo que aprovisione los roles, y la siembra — sin ellos el script sale con
   código 1 en su línea 9.
4. **Correr la aplicación como rol no privilegiado.** Es el único requisito que **los dos planes
   levantaron por separado** y que ninguno cerró. Ambos jobs de base usan el superusuario, y con eso
   una política RLS ausente jamás se detecta. La suite de integración ya lo rodea con honestidad
   —cambia de rol a uno que la RLS sí filtra— pero eso prueba las políticas, no la conexión de la
   aplicación.
5. **Reparar `test:coverage`**, que hoy ni siquiera arranca: el paquete de cobertura está declarado
   y no instalado, no hay umbrales configurados y no hay paso en CI. Los umbrales del backlog no se
   miden en ningún sitio.

**Pregunta de cierre:** ¿un `push` dispara los cuatro jobs, los cuatro pasan, y el de base de datos
conecta como `mnemosine_app`?

---

## S3 · Generar el estado en vez de escribirlo · **dos días**

Es el punto de mayor palanca del sprint y el que evita repetir esta verificación cada dos semanas.

Los criterios de cierre del backlog ya están redactados como comprobaciones ejecutables: greps,
conteos SQL, comandos con su código de salida. Nueve de los doce de un solo paquete son literalmente
una línea de shell. **Nadie los ha corrido nunca como conjunto.**

- `npm run plan:status` evalúa cada paquete y imprime ✅/🟡/⬜ **nombrando la comprobación que
  falla**.
- Borrar la tabla de estado escrita a mano y publicar la generada.
- Reescribir los criterios que nombran identificadores para que asserten **comportamiento**. El
  cerrojo antisimulación es el caso de prueba: el trabajo aterrizó, está mejor documentado que su
  especificación, y falla el 100% de sus criterios escritos porque su autor eligió nombres en
  español. Un criterio como «con un adaptador simulado y la bandera apagada, timbrar falla y no
  escribe folio» sobrevive a cualquier decisión de nomenclatura.
- Añadir a `doctor` un chequeo de **capacidad huérfana**, generalizando el patrón que ya introdujo
  `checkLookupTables`: cualquier tabla con lector y sin escritor, cualquier función exportada sin
  consumidor. Hoy detectaría al menos dos: `sat_code_mappings` y el registro de riesgos del kernel,
  que no tiene ningún consumidor.

**Pregunta de cierre:** ¿`npm run plan:status` corre en CI y su salida contradice a alguien?

### Cerrado · `CLI-7`

Sí a las dos cosas. El job `Estado del plan` corre en cada push, y `--exigir` convierte en rojo el
retroceso de los ocho paquetes cerrados; la lista sólo crece, y se amplía en el mismo commit que
cierra un paquete. La salida contradijo a la tabla que sustituye —que daba E1.2 por pendiente con su
arreglo ya en el historial— y contradijo cuatro veces a los criterios recién escritos:

- El escáner se acusó a sí mismo en su estreno: el criterio que persigue «un TODO junto a un acto
  externo» encontró el literal de su propia expresión regular. `src/plan` quedó fuera del barrido,
  con el precio dicho en voz alta: el instrumento de medida no se mide.
- Un comentario contaba como conducta. Produjo un verde falso —dos políticas «consumidas» por una
  frase en prosa— y un rojo falso contra el endpoint de conciliación, cuyo comentario narra el
  código que CLI-5 ya borró. Hoy todo criterio de comportamiento lee el archivo sin comentarios.
- «`requireEntityAccess` es un no-op» resultó **falso**, y el hallazgo real es peor. Ver S4.
- Tres criterios afirmaban identificadores. El peor —«existe `src/auth/roles.ts`»— no podía detectar
  nada; hoy compara los dos catálogos y nombra los roles que el CLI reparte y la API desconoce.

`doctor` gana `Orphaned capability`, que generaliza `checkLookupTables` a las 96 tablas y las 587
funciones exportadas: **4 tablas con lector y ningún escritor** en todo el repositorio
(`employer_tax_liabilities`, `garnishments`, `paycheck_taxes`, `sat_code_mappings`) y **28 funciones
exportadas que nada referencia** —la capa de caché entera, el motor de inventarios,
`generateSequenceNumber`, y `allDeclarations`, el registro de riesgo del kernel que S3 predijo.
Nunca es `fail`: doctor sale con 1 ante un `fail`, y poner en rojo una instalación que trabaja
enseña a la gente a ignorar doctor —el mismo principio que ya justificaba `appliesWhen`.

---

## S4 · Cerrar el perímetro · **cuatro días**

Es el siguiente eslabón de la ruta crítica y ya tiene su primera mitad: el contexto de inquilino se
monta una vez para todo `/v1`, así que ningún router puede olvidarlo.

Lo que falta es lo que decide si el perímetro existe:

- **La entidad que comprueba la guarda no es la que usa el *handler*.** Corregido en S3: la
  afirmación anterior —«la guarda no guarda porque el encabezado siempre puebla la entidad»— era
  falsa. `requireEntityAccess` **sí** comprueba que la entidad del encabezado pertenezca al usuario
  (`assertEntityAccess`, `middleware/auth.ts`). El defecto es otro y es peor: la guarda mira
  `req.entityId`, `req.params` y `req.body`, y **no mira `req.query`**, mientras que once archivos
  de rutas sacan de ahí la entidad con la que trabajan. Un usuario manda su propia entidad en el
  encabezado y una ajena del mismo inquilino en `?entity_id=`: la guarda aprueba la primera y el
  handler lee la segunda. RLS no lo ve, porque el inquilino es el mismo. La prueba de la batería que
  lo demuestra ya está redactada como criterio ejecutable.
- **`runInTenant` no existe.** El backlog lo llama «la mitigación más barata del mayor riesgo de
  reproceso del plan» y su fuga sigue viva: dos rutas se montan antes de la autenticación.
- **La batería del perímetro**: un test rojo por cada vector —entidad por query string, recurso de
  otra entidad por id, ruta pública anónima— antes de escribir el código que los cierra.

**Pregunta de cierre:** ¿puede una prueba corriendo como `mnemosine_app` demostrar que el mayor de
la entidad B es inalcanzable desde un principal que solo tiene la A?

---

## Lo que este sprint deliberadamente NO hace

**Ningún comando nuevo.** El catálogo tiene más de mil filas sin construir y ninguna entra aquí. La
razón está medida: casi todas leen una tabla que no existe, y la superficie de comandos **es** la
superficie de herramientas del agente — cada comando somero sobre un motor roto es una herramienta
que el modelo va a invocar con confianza.

**Nada de emisión de CFDI.** Sigue fuera de la versión 1. Lo único que se toca es el cerrojo, que ya
está.

**No se toca el cierre anual**, aunque sea un defecto conocido y confirmado —resuelve las cuentas de
cierre por código literal y devuelve vacío en silencio sobre cualquier catálogo importado. Es la
compuerta G4 y merece su propio sprint con su decisión contable, no un hueco al final de éste.

---

## Decisiones que necesito de ti

Ninguna bloquea S1–S3. Las tres primeras bloquean S4 y lo que venga después.

| # | Decisión | Por qué no la tomo yo |
|---|---|---|
| **D1** | Cuando un recurso pertenece a **otra entidad del mismo inquilino**: ¿403 o 404? | Define las aserciones de toda la batería del perímetro y no se puede cambiar sin reescribirlas |
| **D2** | ¿Una transacción por consulta, o una conexión por petición? | Es la decisión de arquitectura de conexiones del sistema entero; cambiarla después significa reescribir el middleware y revisar cada servicio |
| **D3** | ¿Se retira la rama de firma JWT cuyo secreto cae por defecto en el de desarrollo, o basta con abortar el arranque? | Hay una rama sin ningún emisor legítimo detrás |
| **D4** | **GraphQL: borrar o mantener.** Lo dejé desactivado tras una bandera, que es un tercer estado que ningún plan contemplaba | Son 891 líneas sin consumidor, y mientras exista un criterio de cierre del backlog las cuenta como «una de las cuatro superficies de reportes». Una bandera no es una decisión |
| **D5** | **DIOT quedó sin dueño.** Se borró con el archivo que la contenía y ningún paquete la recoge | Es la compuerta G3 de la carta de alcance. O vuelve con dueño, o G3 cambia |

Y una que ya tomé sobre la marcha y conviene que ratifiques: cuando el catálogo de una entidad
onboardeada no tiene las cuentas que el mapa de roles espera, **el sistema las crea si son
obligatorias** (las cuatro de IVA lo son en México) y **reporta como no mapeables** las que
reutiliza del catálogo base, en vez de bloquear el alta. Funciona y está probado, pero es una
decisión de producto.

---

## Por qué este orden

S1 quita daño hoy. S2 hace que cualquier afirmación futura sea comprobable. S3 hace que el estado
deje de ser un documento que alguien mantiene a mano. Recién entonces S4 avanza la ruta crítica —
porque avanzarla antes significa escribir el perímetro sin poder demostrar que muerde.

Dicho de otro modo: los tres primeros no construyen nada y son los que hacen que lo construido
cuente.
