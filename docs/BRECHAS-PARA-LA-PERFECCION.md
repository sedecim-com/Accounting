# Brechas para la perfección — mnemosine

> Redefinición de las brechas, 2026-09-02 (tarde). Sale de la segunda pasada de investigación
> sobre los seis temas rectores (`docs/investigacion/2026-09-02-mejores-practicas/`), de su
> crítica de completitud, y del contraste de cada afirmación contra el árbol.
>
> **Cómo leerlo.** El orden es por CONSECUENCIA para un despacho mexicano, no por tema ni por
> tamaño. Una brecha que bloquea a tres va antes que una grande que no bloquea a ninguna. Cada
> renglón cita el archivo donde se verificó: lo que no se pudo comprobar se dice.

---

## 0. La respuesta honesta a la pregunta

El encargo pedía «las brechas que se necesitan para que el sistema sea perfecto». La respuesta
honesta es que **«perfecto» es la pregunta equivocada para un sistema contable**, y no por
modestia: por una razón estructural que se puede señalar con el dedo.

`tax_parameters` se indexa por `tax_year` y **no tiene vigencia**. La UMA cambia el 1 de febrero.
Una fila por año no puede expresar el dato correcto ni en principio: del 1 de enero al 31 de enero
rige la UMA del año anterior. No es que el dato esté mal —que también, ver §1— es que **el esquema
no tiene dónde escribirlo bien**.

Un sistema contable no persigue la perfección: persigue que el **tiempo hasta la verdad** sea
corto. Cuando una cifra está mal, ¿cuánto tarda alguien en enterarse, y cuánto en corregirla sin
romper lo que ya se firmó? Esa es la meta alcanzable, y es la que este documento ordena.

Y una advertencia sobre el material: **ninguno de los datos de los seis documentos es un hecho
sobre un despacho real**. Todo se verificó contra fuentes oficiales y contra el código; nada se
verificó contra un contador usando el producto. Esa sigue siendo la medición que falta y ninguna
lista la sustituye.

---

## 1. Lo que ya está saliendo mal, hoy, sobre documentos que alguien firma

Estas cuatro no son brechas: son cifras falsas que el sistema ya emite. Van primero porque el daño
está ocurriendo, no esperando.

### 1.1 · Todo CFDI de nómina declara cero ingresos exentos — XL, nada la bloquea

`src/services/payroll/mx/cfdi-nomina-generator.ts:95` emite cada línea de percepción con
`ImporteExento="0.00"` quemado, y `:124` pone `TotalExento="0.00"` en los totales. El art. 93 LISR
exime, entre otros, treinta días de aguinaldo y quince de prima vacacional y de PTU.

**La consecuencia no se queda en el archivo:** ese CFDI alimenta el prellenado de la declaración
anual del trabajador en el portal del SAT. Un aguinaldo íntegramente gravado es un trabajador
pagando ISR sobre algo exento, con el comprobante del despacho como prueba.

### 1.2 · El tipo de nómina se decide con el apellido materno — S, nada la bloquea

`cfdi-nomina-generator.ts:113`: `TipoNomina="${r.emp_second_last === 'EXTRAORDINARIA' ? 'E' : 'O'}"`.
Un andamio que se embarcó. Un finiquito o un pago de PTU sale marcado como nómina ordinaria salvo
que el empleado se apellide, literalmente, EXTRAORDINARIA.

Y con él, ocho valores fiscales más quemados en el mismo archivo: `RegistroPatronal="B0000000000"`,
`ClaveEntFed="MEX"`, `PeriodicidadPago="04"`, `LugarExpedicion="00000"`, `Antiguedad="P0W"`, y RFC
de respaldo `XAXX010101000` para emisor y receptor.

### 1.3 · Las tablas fiscales «2026» son las de 2025 — S, nada la bloquea

`src/database/migrations/009_tax_tables_2026.sql:36-43` siembra `uma_daily: 113.14`,
`salario_minimo_general_diario: 278.80` y `salario_minimo_frontera_diario: 419.88` bajo el rótulo
`('MX', 2026, …)`. La propia cabecera lo confiesa: *«Mexico 2026 (estimated UMA + IMSS rates)»*. Y
hay respaldos quemados de los mismos números en cuatro archivos más, así que corregir la migración
no basta.

**Con §0 encima:** aunque se corrija el número, el esquema no puede expresar que la UMA cambió el
1 de febrero. La brecha real es `tax_parameters` con vigencia (`vigente_desde`, `vigente_hasta`),
no una fila nueva.

### 1.4 · El publicador de cifras al público ya existe y publica mal — M, nada la bloquea

Lo que el tramo experimental daba por construir **ya está**: `published_aggregates`,
`disclosure_config`, `POST /v1/admin/blockchain/publish-aggregates`, servido por `/public/v1` y
catalogado como `attest issue`. Y tiene cuatro defectos, ninguno documentado:

- El compromiso sella `total` y se publica `rounded` (`orchestrator.ts:445-452`): la prueba no
  corresponde a la cifra.
- Agrega `SUM(debit − credit)` por `account_type`, así que **ingresos y pasivos salen negativos** —
  exactamente la clase de signo que G1a acaba de matar en el asiento de cierre.
- No versiona: una corrección es un `UPDATE` en el sitio.
- No dice con qué tipo de cambio ni a qué fecha se armó la cifra en pesos.

**El experimento dejó de estar bloqueado por G1 y pasó a estar bloqueado por sí mismo.** El primer
paso ya no es X1 en papel: es auditar o retirar lo que hoy publica.

---

## 2. La brecha que sostiene un tema entero

### 2.1 · No hay sellador de CFDI — XL, y bloquea a casi todo el timbrado

`src/api/rest/routes/invoices.ts:248` lo confiesa por escrito: *«real implementation would use
cfdi.ts generateCfdiXml»*. **Esa función no existe en ningún archivo del repositorio.** El XML que
se manda al PAC no lleva Emisor, Receptor, Conceptos, NoCertificado, Certificado ni Sello. No hay
cadena original ni `createSign` en `src/services/`; los `cadena_original` de los adaptadores son
literales de simulador.

Toda la estrategia de PACs de las dos investigaciones descansa en «mandamos el XML ya sellado, el
CSD nunca sale de la bóveda». **La premisa no tiene productor.** Y la regla de la bóveda no protege
nada, porque no hay firma que hacer — con un agravante que la crítica encontró: `withCredential`,
el envoltorio que debería consumir la credencial, tiene **cero consumidores en `src/`**; sólo
pruebas. El detector de capacidad huérfana no lo caza porque consumo-en-pruebas le parece consumo.

**El orden de trabajo se invierte respecto a lo que parecía.** La nómina (§1.1) tiene el XML casi
completo, así que sellarla produciría un CFDI **aceptado y equivocado**. Facturación tiene el XML
incompleto, así que sellarla produce un rechazo. Se arregla primero lo que sale mal aceptado.

---

## 3. Lo barato que evita el error caro

Cinco renglones S que no bloquean nada y cuya ausencia cuesta dinero o tiempo el día 17.

| # | Brecha | Consecuencia | Dónde |
|---|---|---|---|
| 3.1 | Los dos relojes del timbrado sin verificar antes de salir a la red: 72 h desde la generación y 5 min de adelanto (65 en Quintana Roo) | Una factura de hace cuatro días no se puede timbrar y hoy se gasta el intento; el `LugarExpedicion="00000"` de la nómina hace imposible resolver el huso, o sea rechazo seguro | RMF 2026 regla 2.7.2.9 fr. I |
| 3.2 | Cinco de doce perfiles de IA sin precio en la tabla local | `budget.monthly_usd` lee **$0.00** y nunca corta en ruta desatendida: el presupuesto que A3–A4 construyó no frena | `src/ai/providers/prices.ts` |
| 3.3 | Coherencia padre-hijo de `fs_category` por disparador | Un hijo con categoría distinta a su padre descuadra cualquier estado financiero agrupado | catálogo existente |
| 3.4 | Una aprobación por canal escrita en `reviewed_by` se contaría como HUMANA | Infla justo la estadística con la que se decide encender `ingest_auto_post` | `shadow-verdicts.ts:57-63`, `stats-service.ts:100-104` |
| 3.5 | El `NoCertificadoSAT` del timbre no se coteja contra el CSD que el SAT publica | Un timbre con certificado ajeno pasa sin ruido | — |

**3.2 y 3.4 son de seguridad, no de comodidad**: las dos desarman un freno que el sistema cree tener.

---

## 4. Los modelos que ya no existen

`src/ai/providers/config.ts` embarca `gpt-5.1` en el perfil `openai` (y en `copilot`) y `grok-4` en
`grok`. **Ninguno de los dos aparece ya en la documentación de su proveedor** (verificado hoy en
developers.openai.com y docs.x.ai). Cuatro renglones de `prices.ts` nombran modelos muertos.

Hay un orden obligatorio y no se ha empezado: **subir el `model`, después fijar la instantánea
fechada, y sólo entonces declarar la ventana**. Buscar ventanas de modelos muertos es trabajo
tirado — de las ocho ventanas que A5 dejó en `desconocida`, exactamente **una** se cierra hoy con
fuente oficial (`minimax` = 204 800); tres están bloqueadas por un `model` obsoleto y cuatro son
irreducibles por construcción (`openrouter/auto`, `copilot`, `hermes-agent`, `openclaw`), cuyas
razones ya están bien escritas y deben quedarse.

Y sigue sin existir el detector de deriva completo: no hay `ai_instantaneas_modelo`, ni chequeo en
`doctor`, ni criterio `ia_deriva_modelo` en el panel. A7 hizo la mitad de arriba.

---

## 5. El punto ciego del encargo

Los seis temas los fijó el encargo, y un encargo de seis puntos puede tener puntos ciegos. Esto es
lo que un despacho mexicano usa a diario y **no cae en ninguno de los seis**:

- **La contabilidad electrónica que se ENVÍA** (art. 28-IV CFF). El diseño completo está escrito en
  `docs/cli-command-catalog.md:2056-2067`; hay **cero código y cero criterios**.
- **Las declaraciones.** DIOT no aparece en ninguno de los seis documentos.
  `coeficiente`, `cufin`, `cuca`, `ajuste anual por inflación` y `PTU` dan **cero** en todo el árbol.
- **El estado de variaciones en el capital contable.** Falta, y nadie lo había notado.
- **El paquete de revisión**: lo que se entrega cuando el SAT o un auditor lo pide.
- **Dos ejercicios abiertos a la vez**, que es el estado normal de enero a abril.
- **El usuario que no es contador.** El producto es bilingüe por accidente: no hay `i18n`, sólo
  `toLocaleString('es-MX')` — y eso arrastra la decisión §5.1 del plan, que sigue abierta.

---

## 6. Lo que la segunda pasada desmintió

Un documento rector que no dice en qué se equivocó no sirve. Esto es lo que la pasada de la mañana
daba por cierto y no lo es:

- **«Sovos está en el enrutador pero no en el registry.»** Ya no: `pac-router.ts:45-47` recorre el
  diccionario y registra los cuatro (entró con G1a). El renglón sale de G0. **Pero ahora `edicom`
  también quedó registrado** y sale en `GET /v1/admin/integrations` siendo un adaptador sin
  documentación pública.
- **«Prodigia acepta XML pre-sellado.»** Re-leída hoy, su documentación describe `CALCULAR_SELLO`,
  `certBase64`/`keyBase64` y un certificado precargado en su base. **Se debilita como secundario** y
  hay que preguntárselo por escrito.
- **«El aviso de Zod: exige v4 y el árbol trae 3.25.»** Muerto, y en la dirección buena:
  `require('zod/v4').toJSONSchema` **ya es una función** en el árbol, y cinco archivos de
  `src/ai/tools` ya importan de `zod/v4`. R9 no necesita subir dependencia.
- **«Es imposible descuadrar la vista respecto al detalle por construcción.»** Contraejemplo vivo:
  `report-service.ts:309-311` filtra donde el CLI promete agregar.
- **«El mayor es físicamente inmutable.»** La 058 corrige a la 041: hay interrupciones legítimas.
- **«Once perfiles de IA.»** Son **doce**, y siempre lo fueron.

---

## 7. Las contradicciones entre los seis

Seis agentes en paralelo producen recomendaciones que no encajan. Las que hay que resolver antes de
construir:

1. **Tablero, experimental y canales piden cada uno «una excepción explícita»** a la misma
   invariante de `auth.ts` («una petición actúa sobre UNA entidad»). Tres excepciones a la misma
   regla es una regla mal puesta: o se declara una sola forma de operación transversal, o la
   invariante cambia con su porqué.
2. **Cinco de seis proponen «al panel de políticas»** sin que ninguno pregunte si un cuestionario de
   **39 claves** aguanta crecer un 40–50 %. El panel es la vía correcta y también un recurso
   escaso: hace falta decidir qué NO va al panel.

---

## 8. El orden, por prerrequisito

```
1.1 nómina exenta ─┐
1.2 tipo de nómina ─┼─→ (independientes: se hacen ya)
1.3 vigencia fiscal ┘
1.4 auditar o retirar el publicador ──→ desbloquea todo el tramo experimental

2.1 el sellador ──┬─→ cancelación con acuse
                  ├─→ REP como emisión
                  └─→ timbrado de nómina CORRECTO (después de 1.1)

4 modelos vivos ──→ instantáneas ──→ ventanas ──→ detector de deriva

R9 (OpenAPI con el sobre del CLI) ──→ el tablero entero
```

**Si sólo se pudieran hacer tres cosas:** §1.1 y §1.2 juntas (son el mismo archivo y son cifras
falsas que ya salen), §1.4 (retirar o auditar lo que se publica al público), y §3.2 (el presupuesto
que lee cero). Las tres son pequeñas y las tres cierran un daño en curso.

---

## 9. Lo que sigue sin medirse

- **Cero corridas contra un despacho real.** Todo esto es verificación contra fuente y contra
  código. El instrumento que falta no es otra lista: es un contador usando el producto.
- **El arnés del clasificador sigue sin una lectura comprometida** (necesita credencial del dueño).
- **La frecuencia del lazo que aprende se multiplicó por 27** en perfiles de ventana pequeña, y la
  decisión de si eso está bien no se ha tomado.

---

*Fuentes: `docs/investigacion/2026-09-02-mejores-practicas/` (seis temas, segunda pasada, con la
crítica de completitud). Ligas re-verificadas en esta pasada: 121; muertas declaradas: 24.*
