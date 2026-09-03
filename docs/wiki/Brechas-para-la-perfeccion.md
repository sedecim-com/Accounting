# Brechas para la perfección

> Qué le falta al sistema, ordenado por **consecuencia para un despacho mexicano** y por
> **prerrequisito** — no por tema ni por tamaño. Una brecha que bloquea a tres va antes que una
> grande que no bloquea a ninguna.
>
> El documento completo, con cada renglón citando el archivo donde se verificó, vive en
> [`docs/BRECHAS-PARA-LA-PERFECCION.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/BRECHAS-PARA-LA-PERFECCION.md).
> El expediente del que sale —seis temas rectores, dos pasadas, 121 ligas re-verificadas— está en
> [`docs/investigacion/`](https://github.com/sedecim-com/Accounting/tree/main/docs/investigacion).

## La respuesta honesta a la pregunta

El encargo era «las brechas para que el sistema sea perfecto». **«Perfecto» es la pregunta
equivocada para un sistema contable**, y no por modestia: por una razón estructural que se puede
señalar con el dedo.

`tax_parameters` se indexa por `tax_year` y **no tiene vigencia**. La UMA cambia el 1 de febrero. Una
fila por año no puede expresar el dato correcto ni en principio: del 1 al 31 de enero rige la del año
anterior. No es que el dato esté mal —que también— es que **el esquema no tiene dónde escribirlo
bien**.

Un sistema contable no persigue la perfección: persigue que el **tiempo hasta la verdad** sea corto.
Cuando una cifra está mal, ¿cuánto tarda alguien en enterarse, y cuánto en corregirla sin romper lo
que ya se firmó?

## 1 · Lo que ya sale mal, hoy, sobre documentos que alguien firma

No son brechas —no es algo que falte— son cifras falsas que el sistema **ya emite**. Las cuatro
estaban donde ninguna auditoría había mirado.

| | Qué | Dónde |
|---|---|---|
| 1.1 | **Todo CFDI de nómina declara cero ingresos exentos.** El art. 93 LISR exime treinta días de aguinaldo y quince de prima vacacional y PTU. Ese comprobante alimenta el prellenado de la anual del trabajador | `cfdi-nomina-generator.ts:95` y `:124` |
| 1.2 | **El tipo de nómina se decide con el apellido materno**, más ocho valores fiscales quemados | `cfdi-nomina-generator.ts:113` |
| 1.3 | **Las tablas fiscales «2026» son las de 2025**, y el esquema no admite vigencia | `009_tax_tables_2026.sql:36-43` |
| 1.4 | **El publicador de cifras al público sella `total` y publica `rounded`**, y agrega por tipo de cuenta con `SUM(debit − credit)`: ingresos y pasivos salen **en negativo** | `orchestrator.ts:445-452` |

## 2 · La brecha que sostiene un tema entero

**No hay sellador de CFDI.** `invoices.ts:248` lo confiesa por escrito —*«real implementation would
use cfdi.ts generateCfdiXml»*— y esa función no existe en ningún archivo. El XML que se manda al PAC
no lleva Emisor, Receptor, Conceptos, NoCertificado, Certificado ni Sello.

Toda la estrategia de PACs descansa en «mandamos el XML ya sellado, el CSD nunca sale de la bóveda».
**La premisa no tiene productor**, y la regla de la bóveda no protege nada porque no hay firma que
hacer.

**El orden de trabajo se invierte respecto a lo que parecía:** la nómina tiene el XML casi completo,
así que sellarla produciría un CFDI *aceptado y equivocado*; facturación lo tiene incompleto, así que
produciría un rechazo. Se arregla primero lo que sale mal aceptado.

## 3 · Lo barato que evita el error caro

- Los **dos relojes del timbrado** sin verificar antes de salir a la red: 72 h desde la generación y
  5 min de adelanto (65 en Quintana Roo).
- **Cinco de doce perfiles de IA sin precio**, así que `budget.monthly_usd` lee **$0.00** y nunca
  corta en ruta desatendida.
- **Coherencia padre-hijo de `fs_category`** por disparador.
- Una **aprobación por canal** escrita en `reviewed_by` se contaría como humana, inflando justo la
  estadística con la que se decide encender el auto-posteo.

Los dos del medio son de seguridad, no de comodidad: **desarman un freno que el sistema cree tener**.

## 4 · El punto ciego del encargo

Lo que un despacho usa a diario y no caía en ninguno de los seis temas: **la contabilidad electrónica
que se ENVÍA** (art. 28-IV CFF, con diseño escrito y cero código), **las declaraciones** (DIOT,
coeficiente, CUFIN, CUCA, ajuste anual por inflación, PTU — todos en cero en el árbol), **el estado
de variaciones en el capital contable**, **el paquete de revisión**, **dos ejercicios abiertos a la
vez** y **el usuario que no es contador** (no hay `i18n`, sólo `toLocaleString('es-MX')`).

## 5 · Lo que sigue sin medirse

**Cero corridas contra un despacho real.** Todo esto es verificación contra fuente oficial y contra
código; nada contra un contador usando el producto. El instrumento que falta no es otra lista.

---

*Ver también: [[Hoja-de-ruta]] · [[Conectores-PAC]] · [[Proveedores-de-modelo]] ·
[[Onboarding-de-contabilidad]] · [[El-tablero-grafico]] · [[Canales-de-mensajeria]] ·
[[La-contabilidad-como-centro]]*
