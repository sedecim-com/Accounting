# Jurisdicciones

mnemosine empieza por México y Estados Unidos y aspira a más países. Esta página dice qué significa eso **hoy** en el código y qué significa en el diseño; el documento rector completo es [`docs/jurisdicciones.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/jurisdicciones.md) y el inventario verificado de qué motor existe para cada país, [`motores-inventario.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/investigacion/2026-09-06-normas-y-motores/motores-inventario.md).

## Dos clases de diferencia, dos sitios

Lo que varía entre países se configura en sitios distintos según **quién lo fija**:

| | Lo fija | Cambia por | Vive en |
|---|---|---|---|
| **La ley** — tasa de IVA, UMA, tope del Seguro Social, límite de efectivo deducible, tablas MACRS | el legislador, publicándolo | fecha de vigencia | una tabla con `effective_from/effective_to` y la URL oficial de la fuente |
| **El criterio** — base de depreciación contable o fiscal, destino del resultado del ejercicio, severidad de un faltante al cierre | el contador, entre dos tratamientos legítimos | despacho o entidad | el panel de políticas (`mnemosine pending`) |

Nadie decide la tasa de IVA y ninguna ley dice cómo deprecia un despacho. Meter una en el sitio de la otra es el error que el diseño prohíbe: **la ley no se decide y el criterio no se legisla**. Y una tercera clase —las constantes de la casa, como el prefijo `JE` del folio— se queda en código.

## Lo que hay hoy

- **Una sola pregunta, con cuatro copias.** «¿Lleva contabilidad mexicana?» tiene respuesta canónica en [`pais-contable.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/pais-contable.ts) (país MX, nulo o desconocido → México; norma `mx_nif` → México). La usan dos sitios al sembrar una entidad. Cuatro copias siguen vivas sin usarla —en el IVA de flujo, en la reclasificación PPD, en `doctor` y en la nómina— y tres de ellas responden **lo contrario** cuando el país viene nulo.
- **La entidad ya sabe de dónde es.** `legal_entities` guarda país (ISO-2), norma contable (`us_gaap`, `mx_nif`, `ifrs`), moneda funcional, tipo de sociedad, tipo de identificador fiscal y mes de inicio del ejercicio. Ese último campo **no lo lee nadie**: el calendario es siempre el año natural.
- **El catálogo es mexicano o neutro.** Una entidad estadounidense recibe tres cuentas de marcador («impuestos por pagar»), no un catálogo de su país. La nómina sí distingue: tiene catálogo MX y catálogo US.
- **El panel no sabe de países.** 39 políticas, todas sembradas en toda entidad; catorce sólo tienen sentido en México (las siete `rep_*`, IEPS, e.firma, restaurantes…) y cuatro umbrales están en pesos aunque la entidad lleve dólares.
- **La ley vive en dos sitios equivocados.** La nómina la tiene en tablas indexadas **por año** (y la UMA cambia el 1 de febrero); el resto está en código: 16 % de IVA, 2 000 pesos de efectivo, 8.5 % de restaurantes, 7.25 dólares de salario mínimo. Sin tabla del año, el ISR se niega a calcular; el IMSS deja las tasas en cero y el INFONAVIT aplica un 5 % quemado, ambos sobre una UMA quemada de 113.14: **cifras inventadas** sin avisar.

## El diseño, en cinco piezas

1. **Un solo conmutador que devuelve una jurisdicción**, no un booleano: `jurisdiccionDe(entidad)` → `{ fiscal: 'MX' | 'US', libros: 'mx_nif' | 'us_gaap' | 'ifrs', monedaLegal }`. Las copias se borran.
2. **Un paquete por jurisdicción** (`src/jurisdicciones/mx`, `/us`): estrato fiscal del catálogo, roles, reglas de calendario, ajustes del panel, parámetros legales sembrados con su fuente, motores fiscales, formatos de informe y el corpus que el agente abre. Añadir un país es añadir una carpeta.
3. **El panel gana la dimensión.** Cada política puede declarar por jurisdicción si aplica, su default y su texto. La resolución pasa a ser *entidad > inquilino × jurisdicción > inquilino > default de la jurisdicción > default universal*, y `mnemosine pending --jurisdiction US` lista sólo lo que aplica. Ninguna clave existente cambia de nombre.
4. **Una tabla de parámetros legales con vigencia**, no una fila por año: `parametros_legales(jurisdiction, clave, valor, effective_from, effective_to, fuente_url)`. Se lee por la fecha del hecho y, sin vigencia que la cubra, **lanza** — el fallo cerrado que hoy sólo tiene el ISR.
5. **Catálogo y calendario por paquete**: nace `ESTRATO_FISCAL_US`; la 3300 «Resultado del Ejercicio» —la cuenta puente del cierre en dos pasos de la LGSM— se queda universal porque el cierre la busca por código, y es el default por jurisdicción quien decide si una entidad estadounidense la usa (no la usa: cierra directo a 3200); el mes de inicio del ejercicio se lee, México lo fuerza a enero (CFF 11) y Estados Unidos lo deja libre (IRC §441).

## El orden

El tramo se llama **J0** y va **antes** de cualquier motor nuevo por país (*sales tax*, 1099, DIOT, retenciones): cada uno de esos motores necesita preguntar de qué jurisdicción es la entidad y leer un parámetro con vigencia, y construirlos antes es construirlos sobre el booleano y sobre constantes. Cada paso lleva su criterio ejecutable en `src/plan/criterios.ts`; nada de esta página cuenta como hecho hasta que `npm run plan:status` lo diga.

## Para seguir

- [[Motores-contables]] — qué motor existe para cada jurisdicción, y cuál falta.
- [[Fiscal-mexicano]] — el paquete mexicano por dentro.
- [[El-tablero-y-los-criterios]] — cómo se pregunta el estado.
- [`docs/jurisdicciones.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/jurisdicciones.md) — el diseño completo, con `archivo:línea`.
