# La jurisdicción como dimensión

> Documento rector. Propuesta de diseño del **panel de configuración por jurisdicción**, escrita el 2026-09-06 sobre la verificación escéptica del código que vive en [`docs/investigacion/2026-09-06-normas-y-motores/motores/`](investigacion/2026-09-06-normas-y-motores/). Todo lo que aquí se dice que **existe** lleva `archivo:línea`; todo lo que se dice que **se propone** no existe todavía y no debe leerse como capacidad. Cuando este documento y el código discrepen, gana el código — y este documento se corrige en el mismo PR.

> **Nombres en inglés (2026-09-06).** Después de escribir este documento, el dueño fijó la regla de que todo el código nace en inglés ([`docs/language.md`](language.md), gemela [`language.es.md`](language.es.md)). Los identificadores que aquí se proponen en español se leen con su nombre inglés: `jurisdiccionDe` → `jurisdictionOf`, `Jurisdiccion` → `Jurisdiction`, `CodigoJurisdiccion` → `JurisdictionCode`, `PaqueteDeJurisdiccion` → `JurisdictionPackage`, `AjusteDeClave` → `PolicyKeyOverride`, `parametros_legales` → `legal_parameters`, `parametroLegal` → `legalParameter`, `src/jurisdicciones/` → `src/jurisdictions/`. Los valores de opciones del panel que este documento cita (`directo_a_acumulados`, `dos_pasos_hasta_asamblea`) y las claves de política son **vocabulario persistido**: por la regla 4 de `language.md` se registran con glosa inglesa en I4 y se renombran al inglés en I23, con migración de datos bajo RLS y ventana de alias en los lectores; hasta ese tramo se leen y escriben tal como están aquí, y no hay excepción para ellos. Lo que J0.2–J0.8 persista por primera vez (columnas, claves, valores) nace en inglés.

## 0. La pregunta

mnemosine arranca con dos jurisdicciones —México y Estados Unidos— y aspira a más. La instrucción de diseño es una sola frase: *mantén todo configurable para que exista un panel de configuración por jurisdicción que permita ajustar las diferencias a cada una*.

Esa frase esconde dos clases de «diferencia» que no se configuran igual, y confundirlas es el error que este documento existe para evitar:

| Clase | Ejemplos | Quién la fija | Cómo cambia | Dónde debe vivir |
|---|---|---|---|---|
| **Lo que la ley fija** | tasa de IVA 16 %, UMA diaria, tope del Seguro Social, límite de 2 000 MXN en efectivo, tabla MACRS | El legislador o la autoridad, publicándolo | Por **fecha de vigencia** (1-ene, 1-feb, decreto a mitad de año) | Una **tabla con vigencia**, sembrada con la fuente oficial |
| **Lo que el despacho decide** | base de depreciación contable o fiscal, convención del primer mes, destino del resultado del ejercicio, severidad de un faltante al cierre | El contador, entre dos tratamientos legítimos | Por **despacho o por entidad**, cuando el contador lo decide | El **panel de políticas** (`src/services/policy/`) |

Nadie «decide» la tasa de IVA, y ninguna ley dice si el despacho deprecia en línea recta o por unidades. El panel de hoy guarda sólo la segunda clase y no sabe de jurisdicciones; la primera clase vive mitad en tablas de nómina indexadas por año y mitad quemada en código. El diseño consiste en darle **al panel una dimensión** y **a la ley una tabla**, y en que ambas cuelguen de **una sola respuesta** a la pregunta «¿de qué jurisdicción es esta entidad?».

Hay una tercera clase que conviene nombrar para no meterla donde no va: las **constantes de la casa** —el prefijo `JE` del folio (`src/services/accounting/posting.ts:147`), el texto `Reversal:` (`:566`), la regex del folio (`ledger-checks.ts:287-292`), la tolerancia `0.01` del cuadre (`validation.ts:13`)—. No son ley ni criterio contable: son convenciones del motor. Se quedan en código; si alguna debe variar por jurisdicción (el rótulo de un estado financiero en inglés o en castellano), pertenece al **paquete de jurisdicción** (§3.2), no al panel.

## 1. Lo que hay hoy, verificado

### 1.1 El conmutador

La pregunta «¿lleva contabilidad mexicana?» tiene una respuesta canónica y booleana: `esContabilidadMexicana(incorporation_country, accounting_standard)` en [`src/services/accounting/pais-contable.ts:35-44`](../src/services/accounting/pais-contable.ts) — verdadero si la norma es `mx_nif` **o** si el país es MX, nulo, vacío o desconocido («ante la duda, mexicana»). La consumen exactamente dos sitios: `entity-accounting.ts:75` (qué catálogo sembrar) y `:172` (qué roles).

Pero el encabezado del archivo (`:4-12`) dice haber unificado cuatro copias y **cuatro siguen vivas sin usarlo**, tres de ellas con el borde nulo al revés:

| Copia | Regla | Borde nulo | Veredicto |
|---|---|---|---|
| `iva-cash-basis.ts:310` | `country === 'MX' \|\| standard === 'mx_nif'` | **falso** | divergente |
| `iva-ppd-reclass.ts:101` | mismo predicado, en SQL | **falso** | divergente |
| `src/ai/doctor-service.ts:190` | `incorporation_country = 'MX'` a secas, sin mirar la norma | **falso** | divergente (y es una de las cuatro que la cabecera de `pais-contable.ts:8` dice haber unificado) |
| `payroll-account-mapping-seed.ts:260-262` (`normalizarPais`) | `'US'`/`'USA'` → USA, lo demás → MX | verdadero (MX) | coincide, pero es otro conmutador |

Y los módulos que más deberían preguntar, no preguntan: `period-close.ts` no importa `pais-contable` (sus renglones `rep-parked` y `rep-missing` corren en toda entidad; el segundo cuenta `cfdi_uuid IS NULL` en pagos y cobros, `period-close.ts:541-551`, y el primero los pre-registros de pago en revisión, `:525-540`), ni lo hacen `src/services/reporting/`, `src/services/policy/` ni `fiscal-calendar-service.ts`.

### 1.2 La entidad

`legal_entities` ([`001_core_schema.sql`](../src/database/migrations/001_core_schema.sql), bloque `CREATE TABLE legal_entities`) ya trae los datos que una jurisdicción necesita: `incorporation_country CHAR(2)`, `accounting_standard IN ('us_gaap','mx_nif','ifrs')`, `functional_currency`, `entity_type IN ('corporation','llc','partnership','sapi','sa','sc')`, `tax_id_type IN ('rfc','ein','vat')` y `fiscal_year_start_month INTEGER CHECK 1..12`. De todos ellos, **`fiscal_year_start_month` no lo lee ni lo escribe nadie** (grep en `src/`: sólo `types/index.ts:904`; el INSERT de `entity-service.ts:236-245` no lo incluye).

Las puertas de alta escriben siempre desde `COUNTRY_PROFILES` ([`src/services/entity/entity-service.ts:57-77`](../src/services/entity/entity-service.ts)): `MX → mx_nif/MXN/rfc/sa`, `USA → us_gaap/USD/ein/corporation`, y guardan el ISO-2 (`iso2`, `:243`). El tipo `Country = 'MX' | 'USA'` (`:33`) hace que **ninguna puerta pueda crear una entidad `ifrs`**: el CHECK lo admite, el producto no.

### 1.3 El catálogo y los roles

`catalogoBasePara(esMexicana)` ([`chart-seed.ts:141-144`](../src/services/accounting/chart-seed.ts)) compone `CATALOGO_UNIVERSAL` (`:44`) con `ESTRATO_FISCAL_MX` (`:92`) o con `ESTRATO_FISCAL_NEUTRO` (`:123`: tres cuentas, 2135 «impuestos por pagar» y 1136 entre ellas). **No existe `ESTRATO_FISCAL_US`**: una sociedad de Delaware nace con un marcador neutro, no con un catálogo estadounidense. Los roles siguen el mismo patrón (`ROLES_FISCALES_MX`, `ROLES_NEUTROS` en `account-roles-seed.ts:318-338`). La cuenta 3300 «Resultado del Ejercicio» (`chart-seed.ts:64`) es la cuenta puente del cierre en dos pasos que la LGSM (arts. 19-20) impone en México —el resultado espera ahí hasta la asamblea— y el cierre anual la busca **por código** (`period-close.ts:1086-1092`) con el default `dos_pasos_hasta_asamblea` (`:1006-1012`): una entidad estadounidense, que no tiene asamblea que esperar, barre igualmente a 3300 porque el default es mexicano. La nómina sí distingue: `MX_PAYROLL_ACCOUNTS` (`payroll-account-mapping-seed.ts:85`) y `US_PAYROLL_ACCOUNTS` (`:157`), elegidas por `chartFor` (`:269-278`); una entidad US recibe, además del neutro, nueve cuentas de nómina estadounidense.

### 1.4 El panel

`POLICY_CATALOG` ([`pending-catalog.ts`](../src/services/policy/pending-catalog.ts)) declara 39 claves —25 `contable`, 5 `fiscal`, 6 `operativa`, 3 `seguridad`— y `PolicySpec` (`:16-38`) **no tiene campo de jurisdicción**. `policy_decisions` (`016:9-46`) no tiene columna de país. La resolución es entidad > inquilino (`policy-service.ts:136-138`), y `seedPolicies` siembra las 39 en todo inquilino (`:47-68`). Consecuencias medibles:

- Una entidad estadounidense recibe catorce claves que no pueden aplicarle: las siete `rep_*`, `tratamiento_ieps`, `cfdi_periodo_cerrado`, `politica_restaurantes` (el 8.5 % de la LISR 28-XX), las dos `efirma_*`, `dias_aguinaldo` y `prima_vacacional_pct`. (Las dos `ingest_*` son de auto-posteo genérico y sí le aplican.)
- Cuatro umbrales están denominados en pesos o con `$` implícito: `umbral_capitalizacion_mxn` (`:186`), `umbral_anticipado_mxn` (`:451`, y éste sí dice «MXN» en sus etiquetas), `ingest_auto_post_max_monto` (`:831-840`), `cotejo_monto_maximo_auto` (`:1026-1038`).
- Tres bifurcaciones son universales con **etiqueta** mexicana: `base_depreciacion` (LISR), `convencion_primer_mes`, `destino_del_resultado_del_ejercicio` (LGSM, cuenta 3300). Lo atado a MX es el texto de la opción, no la pregunta.
- `fuente_tipo_cambio` ofrece `dof | fix_banxico | manual` (`:707-731`) mientras el CHECK de `exchange_rates.source` ya admite `fed` y `ecb` (`001:383`, `057:30`) y el descargador los lista (`fx-command.ts:150-151`). Ninguna fuente tiene cliente: `fx rate download` falla cerrado a propósito para todas (`fx-command.ts:484-488,512-517`, «este proyecto no habla HTTP con terceros»).
- Una política decidida en el panel **no siempre llega a la terminal**: `cotejo_umbral_confianza` y `cotejo_monto_maximo_auto` sólo se leen en la ruta REST `auto-match` (`matching.ts:587-588`); la CLI `bank match preview|run` usa su propio `0.85` y su propio `50 000` (`match-service.ts:117,997,1003-1004`).
- El texto de al menos cinco claves no dice lo que el código hace: `depreciacion_faltante_al_cierre` promete gobernar el renglón del checklist (`:163-164`) y `period-close.ts:419-446` no la lee (la leen `depreciation-plan.ts:224` y `depreciation-command.ts`); `amortizacion_faltante_al_cierre` dice que «el renglón del checklist se pone en rojo» (`:435`) y el checklist no tiene renglón de anticipados; `dias_aguinaldo` dice que ningún motor la lee (`:478-479`) y `finiquito-calculator.ts:101` la lee; `cotejo_monto_maximo_auto` se describe como «segunda compuerta de `bank match run`» (`:1030`) y ese comando no lee el panel; `base_depreciacion` promete que «ambos calendarios se pueden calcular» (`:111-112`) y la corrida persiste un solo `schedule_type`.

### 1.5 Los parámetros legales

Sólo la nómina tiene tablas: `tax_tables` (`008_payroll.sql:354-372`, con `effective_from/effective_to` que **nadie usa en la búsqueda**: `tax-tables.ts:46` filtra por `tax_year`) y `tax_parameters` con `UNIQUE(jurisdiction, tax_year)` (`008:375-382`): **una fila por año**, sin vigencia intra-anual, aunque la UMA cambia el 1 de febrero y el salario mínimo el 1 de enero. Y el fallo es asimétrico: sin fila del año, `getTaxParameters` devuelve `{}` (`tax-tables.ts:79`) y las calculadoras **inventan en silencio**: el IMSS deja las tasas en cero (`imss-calculator.ts:72-80,119-135`, `|| 0`) sobre una UMA quemada de 113.14 (`:62,110`), y el INFONAVIT aplica un 5 % quemado sobre esa misma UMA (`infonavit-calculator.ts:31-32`, `|| 113.14`, `|| 0.05`); sólo el ISR lanza (`isr-calculator.ts:31`).

Los dos pisos irrompibles del agente están en «moneda» sin decir cuál: `FLOOR_MAX_AUTO_POST = 50 000` en la funcional de la entidad (`src/ai/floor.ts:36-39`) y `FLOOR_MAX_TOLERANCIA_CONCILIACION = 500` en la moneda de la cuenta que se concilia (`:108-114`). 500 MXN y 500 USD difieren un orden de magnitud y el piso no distingue — un piso por jurisdicción es parte del paquete (§3.2), nunca del panel.

Fuera de nómina, la ley está en código: el límite de 2 000 MXN en efectivo (`cfdi-decisions.ts:94`), el 8.5 % de restaurantes (`:96`, y otra vez en `policy-preview.ts:143-144`), las tasas 16/8/0 del IVA (`cfdi-parser.ts:361-363`, `cfdi-facts.ts:216-224`, `sat-catalogs.ts:99-103`), las tasas de la LISR por categoría de activo (`CATALOGO_LISR`, `asset-service.ts:100-153`), las tablas MACRS, el salario mínimo federal de 7.25 USD (`garnishment-engine.ts:36`) y los topes del CCPA (`:48-49,94-95`). Ninguno viene de tabla ni de panel.

### 1.6 El calendario y los informes

El calendario es siempre el año natural con doce periodos (`fiscal-calendar-service.ts:513-534`; el propio código declara fuera de alcance 52-53 semanas, 4-4-5 y periodo 13 en `:485-487`). `period_type='adjustment'` está admitido y jamás se crea; `fiscal_years.status='closed'` y `fiscal_periods.status='locked'` no tienen escritor en todo `src/`. Los informes (`report-service.ts`) no leen jurisdicción: rótulos en inglés, sin ORI, sin estado de cambios en el capital, sin notas ni comparativos — les falta lo mismo a México y a Estados Unidos.

## 2. La regla que ordena todo

**Cada dato de configuración pertenece a exactamente uno de tres sitios, y el sitio se decide por quién lo fija, no por dónde caiga más cómodo:**

1. **Lo fija la ley** → tabla `parametros_legales` con vigencia y fuente (§3.4). Nunca al panel: no hay pregunta que hacerle al contador.
2. **Lo decide el despacho** → panel de políticas, con su lector en el mismo commit y, si varía por jurisdicción, con su default y su texto por jurisdicción (§3.3). Nunca a una tabla de ley: no hay DOF que lo publique.
3. **Lo fija la casa** → constante en el paquete de jurisdicción o en el motor (§3.2). Nunca al panel: ofrecerlo como opción es inventar una bifurcación que el oficio no tiene.

Y una cuarta, que ya es ley de la casa y aquí sólo se extiende: **la jurisdicción se deriva de la entidad y no se guarda en ningún otro sitio.** Ni en la política, ni en el parámetro, ni en el asiento: se calcula desde `legal_entities` con una sola función, y todo lo demás la recibe.

## 3. El diseño

### 3.1 Un solo conmutador, y devuelve una jurisdicción, no un booleano

Se propone `src/services/jurisdiccion/jurisdiccion.ts`:

```ts
export type CodigoJurisdiccion = 'MX' | 'US';
export type NormaContable = 'mx_nif' | 'us_gaap' | 'ifrs';

export interface Jurisdiccion {
  /** La que manda sobre catálogo fiscal, calendario, impuestos y formatos. */
  fiscal: CodigoJurisdiccion;
  /** La que manda sobre reconocimiento, medición y presentación. */
  libros: NormaContable;
  /** Moneda en la que se expresan los umbrales legales de `fiscal`. */
  monedaLegal: 'MXN' | 'USD';
  /** Sub-jurisdicción cuando la hay (estado de EE. UU.). Se lee de la entidad cuando exista la columna. */
  estado?: string;
}

export function jurisdiccionDe(e: {
  incorporation_country?: string | null;
  accounting_standard?: string | null;
}): Jurisdiccion;
```

Reglas, en este orden: (a) `accounting_standard` decide `libros`; si viene nulo, lo decide el país (`MX → mx_nif`, `US → us_gaap`). (b) `incorporation_country` decide `fiscal`; nulo, vacío o desconocido → `MX`, que es la regla que hoy ya rige en `pais-contable.ts:41-44` y la segura para este producto. (c) `libros` y `fiscal` **pueden diferir**: la filial constituida fuera que lleva libros en NIF necesita catálogo fiscal de su país y reconocimiento mexicano; hoy el booleano colapsa ambas cosas.

`esContabilidadMexicana` se conserva como envoltura —`jurisdiccionDe(e).fiscal === 'MX'`— para no tocar a sus dos consumidores, y **las cuatro copias del §1.1 se borran** y pasan a llamarla. El criterio que lo vigila: `grep -rn "incorporation_country = 'MX'\|accounting_standard === 'mx_nif'\|country === 'MX'" src/` (todo `src/`, no sólo `services/`: la copia del doctor vive en `src/ai/`) devuelve cero fuera de `jurisdiccion.ts`; la inferencia del tipo de identificador fiscal por país (`vendor-service.ts:63-64`, `'USA' → 'ein'`) no es un conmutador de jurisdicción y queda fuera del criterio —o pasa a leer `jurisdiccionDe`, que es lo limpio—.

### 3.2 El paquete de jurisdicción

Todo lo que varía por jurisdicción y **lo fija la casa o la ley** se agrupa en un módulo por país, con la misma forma:

```ts
// src/jurisdicciones/mx/index.ts · src/jurisdicciones/us/index.ts
export interface PaqueteDeJurisdiccion {
  codigo: CodigoJurisdiccion;
  /** Cambia cuando cambia la ley sembrada o el catálogo. Va al informe de `jurisdiction show`. */
  version: string;
  catalogo: {
    estratoFiscal: ChartAccountSpec[];                    // hoy ESTRATO_FISCAL_MX; falta el US
    rolesFiscales: Partial<Record<AccountRole, string>>;  // hoy ROLES_FISCALES_MX; falta el US
    esquemaDeCodigos?: 'sat-agrupador' | 'us-tax-line';   // ya existen como --scheme en `account map`
  };
  calendario: {
    ejercicioNaturalObligatorio: boolean;   // MX: true (CFF 11); US: false (IRC §441)
    permitePeriodoDeAjuste: boolean;        // periodo 13
    primerEjercicioIrregular: boolean;      // MX: desde la fecha de constitución
    folioPorEjercicio: boolean;             // hoy: año natural del documento (sequence.ts:36-46)
  };
  panel: Record<string, AjusteDeClave>;     // §3.3: por clave, si aplica y con qué default y texto
  parametrosLegales: SemillaDeParametroLegal[]; // §3.4: con vigencia y fuente, sembrados por migración
  motoresFiscales: () => void;              // hoy register-all.ts registra MX y US juntos
  informes: { idioma: 'es' | 'en'; formatos: string[] }; // 'anexo24-xml', 'balanza-4col' / '941', 'w2'
  corpus: string[];                         // los src/ai/docs que el agente abre para esta jurisdicción
}
export const JURISDICCIONES: Record<CodigoJurisdiccion, PaqueteDeJurisdiccion>;
```

Añadir una tercera jurisdicción es añadir una carpeta, una migración con sus parámetros legales y su corpus para el agente — y ninguna línea en el motor común. Es el patrón de las localizaciones de Odoo (`l10n_*`) y de las regionales de ERPNext; el informe [`practicas/arquitectura.md`](investigacion/2026-09-06-normas-y-motores/practicas/arquitectura.md) recoge lo que la industria hace y lo que no conviene copiar.

### 3.3 El panel gana la dimensión

**Tipo.** `PolicySpec` gana un campo opcional:

```ts
interface AjusteDeClave {
  /** false = la clave no existe para esta jurisdicción: no se siembra, no se lista, no se pregunta. */
  aplica?: boolean;
  defaultValue?: string;
  defaultRationale?: string;
  options?: PolicyOption[];
  question?: string; impact?: string;
  whyAsking?: string; whatIDo?: string; ifSkipped?: string;
}
interface PolicySpec {
  // … lo de hoy …
  jurisdicciones?: Partial<Record<CodigoJurisdiccion, AjusteDeClave>>;
}
```

Sin el campo, la clave es universal y se comporta como hoy: **ninguna clave existente cambia de nombre ni de lector.**

**Esquema.** `policy_decisions` gana `jurisdiction CHAR(2) NULL` (NULL = todas) y la unicidad pasa a un índice `(tenant_id, COALESCE(entity_id, uuid_nil()), COALESCE(jurisdiction, ''), key)`.

**Resolución.** De lo particular a lo general, y la primera fila resuelta gana:

```
entidad  >  inquilino × jurisdicción  >  inquilino  >  default de la jurisdicción (código)  >  default universal (código)
```

```sql
SELECT … FROM policy_decisions
 WHERE tenant_id = $1 AND key = $2
   AND (entity_id IS NULL OR entity_id = $3::uuid)
   AND (jurisdiction IS NULL OR jurisdiction = $4)
 ORDER BY entity_id IS NULL ASC, jurisdiction IS NULL ASC
 LIMIT 1;
```

`$4` **no lo pasa nadie a mano**: `getPolicy` lo deriva con `jurisdiccionDe` cuando el contexto trae `entityId`; una lectura de alcance inquilino sin entidad sigue resolviendo la fila universal. El fallback sin fila es `spec.jurisdicciones?.[j]?.defaultValue ?? spec.defaultValue`.

**Siembra.** `seedPolicies(ctx)` siembra sólo las claves que **aplican** a las jurisdicciones de las entidades del inquilino. Un despacho sin entidades mexicanas no ve `rep_*` en `/pendientes`.

**Puerta.** `mnemosine pending [--jurisdiction MX|US]` lista lo que aplica; `pending define <clave> <valor> --jurisdiction US` escribe la fila inquilino×jurisdicción; `pending explain <clave> --entity X` imprime la cadena completa de resolución y qué eslabón ganó. La bandera `--jurisdiction <código>` entra al diccionario único de banderas del kernel con ese único significado (hoy no existe ni `--country` ni `--jurisdiction` en `src/cli/kernel/`). REST y GraphQL siguen sin escribir políticas, como hoy (ninguna ruta `polic*` en `src/api/rest/routes/`, ningún tipo de política en `schema.ts`), y el agente sólo las lee (`src/ai/tools/policy-tools.ts:319-330`).

**Reclasificación de las 39 claves.** Es la parte del trabajo que no admite atajo: cada clave se lee y se decide.

| Grupo | Claves | Qué se hace |
|---|---|---|
| Universales sin tocar | `segregacion_de_funciones`, `conciliacion_tolerancia`, `cotejo_umbral_confianza`, `flujo_efectivo_*` (3), `informes_asientos_de_cierre`, `cierre_recierre_de_periodo_reabierto`, `severidad_resultado_sin_barrer`, `amortizacion_anticipados_convencion`, `amortizacion_faltante_al_cierre`, `depreciacion_faltante_al_cierre`, `linea_banco_sin_partida_al_cierre`, `pago_corto_residual`, `catalogo_entidad_no_mexicana`, `lleva_inventarios`, `ingest_auto_post` | Nada. Se corrigen los dos textos que mienten (`depreciacion_faltante_al_cierre`, `dias_aguinaldo`). |
| Universales con default o etiqueta por jurisdicción | `base_depreciacion` (MX: LISR 31-35 vs NIF C-6 · US: MACRS/§179 vs libro), `convencion_primer_mes` (US añade `half_year`/`mid_quarter`, Pub 946), `destino_del_resultado_del_ejercicio` (MX: `dos_pasos_hasta_asamblea` por LGSM 19-20 · US: `directo_a_acumulados`, el valor que `period-close.ts:1007-1011` ya compara), `fuente_tipo_cambio` (MX: `dof`/`fix_banxico` · US: `fed`/`ecb`; el mapeo política→fuente de `rate-service.ts:57-61` y `moneda-origen.ts:207-211` se unifica en el paquete) | `jurisdicciones: { MX: {…}, US: {…} }` |
| Sólo México (`aplica: false` en US) | `rep_pago_no_registrado`, `rep_tolerancia_importe`, `rep_documento_desconocido`, `rep_ventana_dias`, `rep_moneda_extranjera`, `rep_faltante_recibido`, `rep_faltante_emitido`, `tratamiento_ieps`, `cfdi_periodo_cerrado`, `politica_restaurantes`, `efirma_max_accesos_diarios`, `efirma_accion_anomalia`, `dias_aguinaldo`, `prima_vacacional_pct` | `jurisdicciones: { US: { aplica: false } }` |
| Umbrales denominados en moneda | `umbral_capitalizacion_mxn`, `umbral_anticipado_mxn`, `ingest_auto_post_max_monto`, `cotejo_monto_maximo_auto` | El valor se interpreta **en la moneda legal de la jurisdicción fiscal**; el default y la etiqueta van por jurisdicción (MX «20,000 MXN» · US «2,500 USD», el *de minimis safe harbor* del Treas. Reg. §1.263(a)-1(f), 5 000 con estados auditados). El sufijo `_mxn` es un nombre desafortunado; **no se renombra** (los lectores lo usan): se documenta y, si algún día se aliasa, la migración copia las filas. |
| Nuevas, sólo Estados Unidos | `metodo_costeo_inventario` (FIFO/promedio/**LIFO**, que sólo US permite y con conformidad IRC §472), `depreciacion_convencion_fiscal_us` (half-year/mid-quarter/mid-month), `estados_con_nexo_sales_tax` (lista), `provision_isr_al_cierre` (ASC 740; también aplica a MX como ISR anual, con otra etiqueta) | Nacen con `jurisdicciones: { MX: { aplica: false } }` o con default por país, **cuando tengan lector** — no antes. |

**La guardia contra el texto que miente.** La regla de la casa dice que la bifurcación se declara en el panel *con su lector en el mismo commit*. Hoy nada lo comprueba, y el §1.4 encontró dos textos desfasados. Se propone una prueba unitaria que, para cada `key` de `POLICY_CATALOG`, exige al menos un `getPolicy(…, 'key')` o `getPolicyNumber(…, 'key')` en `src/` fuera de `policy/`. Es la misma idea que la capacidad huérfana de `doctor`, aplicada al panel. Lo que la prueba no puede comprobar —que el texto describa al lector correcto— se queda como regla de revisión.

### 3.4 Los parámetros legales: una tabla con vigencia, no una fila por año

```sql
CREATE TABLE parametros_legales (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  jurisdiction  VARCHAR(20) NOT NULL,        -- 'MX', 'US', 'US-CA' (el vocabulario que tax_tables ya usa)
  clave         VARCHAR(80) NOT NULL,        -- 'iva.tasa_general', 'uma.diaria', 'ss.wage_base', 'lisr.efectivo_max'
  valor         JSONB NOT NULL,              -- número, tabla de tramos, o lista
  effective_from DATE NOT NULL,
  effective_to   DATE,                        -- NULL = vigente
  fuente_url    TEXT NOT NULL,               -- DOF, SAT, IRS, SSA, CONASAMI, INEGI…
  publicado_el  DATE,
  notas         TEXT,
  EXCLUDE USING gist (jurisdiction WITH =, clave WITH =,
                      daterange(effective_from, effective_to, '[)') WITH &&)
);
```

Lectura: `parametroLegal(jurisdiccion, clave, fecha)`. **Sin vigencia que cubra la fecha, lanza** `PARAMETRO_LEGAL_SIN_VIGENCIA` — el fallo cerrado que hoy tiene el ISR y no tienen el IMSS ni el INFONAVIT. La fecha es la del hecho (fecha de pago, fecha del comprobante), nunca `hoy`.

`tax_parameters` gana `effective_from/effective_to` (la migración rellena `AAAA-01-01`/`AAAA-12-31` desde `tax_year`) y pierde `UNIQUE(jurisdiction, tax_year)`; `getTaxParameters` y `getBrackets` pasan a buscar por fecha de pago. La ruta larga es fundir `tax_parameters` en `parametros_legales`; la corta, que basta para el primer tramo, es darles la misma disciplina.

Lo que se mueve primero de código a tabla, con la fuente que el informe normativo correspondiente verificó (ver [`normas/fiscal-mx.md`](investigacion/2026-09-06-normas-y-motores/normas/fiscal-mx.md) y [`normas/fiscal-us.md`](investigacion/2026-09-06-normas-y-motores/normas/fiscal-us.md)):

| Jurisdicción | Clave | Hoy vive en | Por qué cambia por fecha |
|---|---|---|---|
| MX | `uma.diaria` | `tax_parameters` (una fila por año) | INEGI la publica en enero, **vige el 1 de febrero** |
| MX | `smg.diario`, `smg.zlfn` | `tax_parameters` | CONASAMI, 1 de enero; y a veces decreto a mitad de año |
| MX | `subsidio_empleo.tabla` | `tax_tables` (doce tramos `('MX','subsidio_empleo')`, `009:182-194`), una fila por año | Decretos DOF 2024/2025 con vigencias propias |
| MX | `iva.tasa_general`, `iva.tasa_frontera`, `iva.tasa_cero` | `cfdi-parser.ts:361-363`, `cfdi-facts.ts:216-224`, `sat-catalogs.ts:99-103` | LIVA arts. 1 y 2; la del 8 % es por decreto regional |
| MX | `lisr.efectivo_max` (2 000) | `cfdi-decisions.ts:94` | LISR 27-III |
| MX | `lisr.restaurantes_deducible` (8.5 %) | `cfdi-decisions.ts:96` **y** `policy-preview.ts:143-144` (quemado dos veces) | LISR 28-XX |
| MX | `lisr.tasas_depreciacion` | `CATALOGO_LISR`, `asset-service.ts:100-153` | LISR 31-35 |
| MX | `retencion.honorarios_isr`, `retencion.iva_dos_tercios` | no existe el **cálculo** ni el entero; el asiento con el importe que trae el CFDI sí se postea (`cfdi-taxonomy.ts:151-152,171-172`) | LISR 106, LIVA 1-A y 3 |
| US | `ss.wage_base` (184 500 en 2026), `medicare.rate`, `medicare.additional` | `tax_parameters` | SSA, 1 de enero |
| US | `futa.rate`, `futa.wage_base` | `tax_parameters` (`009:23-25`) | 1 de enero |
| US | `futa.credit_reduction_states` | no existe (ni tabla, ni código, ni panel) | DOL publica los estados en noviembre |
| US | `flsa.min_wage` (7.25) | `garnishment-engine.ts:36` | FLSA §6; los estatales, por estado |
| US | `ccpa.limites` | `garnishment-engine.ts:48-49,94-95` | 15 U.S.C. §1673 |
| US | `irc.de_minimis` (2 500 / 5 000) | no existe | Treas. Reg. §1.263(a)-1(f) |
| US | `macrs.tablas`, `sec179.limite`, `bonus.pct` | `MACRS_TABLES` en código; §179 y bonus ausentes | Pub 946; el bonus cambia por año de puesta en servicio |
| US | `retirement.401k_limit` (24 500 en 2026), `fsa.limit` | `tax_parameters` / benefits | IRS Notice anual |

Puerta: `mnemosine parametros list --jurisdiction MX [--vigentes-al 2026-02-01]` (lectura) y `parametros import <archivo.json> --fuente <url> --reason "…"` (escritura, por `gateMutation`, y **la fuente es obligatoria**: un parámetro legal sin URL oficial no entra). `doctor` marca `fail` —no `warn`— cuando una entidad con actividad pertenece a una jurisdicción cuyos parámetros obligatorios no tienen vigencia que cubra la fecha de hoy: es la misma severidad que ya tiene «la nómina de EE. UU. reporta ceros al IRS».

### 3.5 El catálogo y los roles por jurisdicción

`catalogoBasePara(esMexicana: boolean)` pasa a `catalogoBasePara(j: Jurisdiccion)` y compone `CATALOGO_UNIVERSAL + JURISDICCIONES[j.fiscal].catalogo.estratoFiscal`. Nace `ESTRATO_FISCAL_US` con lo que una PyME estadounidense necesita para postear desde el primer día: *Sales Tax Payable*, *Federal Income Tax Payable*, *State Income Tax Payable*, *Accrued Liabilities*, *Prepaid Income Tax*, y el estrato de nómina que `US_PAYROLL_ACCOUNTS` ya siembra (se coordina para no duplicar). La 3300 «Resultado del Ejercicio» **se queda en el universal**: el cierre la busca por código y quitársela a una entidad rompería su cierre anual; lo que cambia es el **default por jurisdicción** de `destino_del_resultado_del_ejercicio` (§3.3), que para US pasa a `directo_a_acumulados` y deja la 3300 en cero sin tocarla. `ESTRATO_FISCAL_NEUTRO` queda para jurisdicciones sin paquete, que es lo que hoy debería ser Estados Unidos y no lo es.

Códigos oficiales: México tiene un catálogo obligatorio (c_CodAgrup del Anexo 24) y hoy **dos columnas para el mismo dato** —`mx_nif_code` (`001:130`, la que escribe `account-service.ts:455`) y `codigo_agrupador_sat` (`037:27-31`, sin lector ni escritor)—; consolidarlas es del tramo F07 (issue [#112](https://github.com/sedecim-com/Accounting/issues/112)). Estados Unidos no tiene catálogo obligatorio: lo que tiene es la línea de la forma (1120/1065) y `account map set --scheme us-tax-line` ya la escribe (`account-service.ts:456`).

### 3.6 El calendario por entidad

`ensureFiscalYear` lee `legal_entities.fiscal_year_start_month` y construye los doce periodos desde ese mes. El paquete decide si el mes es libre: **MX lo fuerza a 1** (CFF 11: el ejercicio fiscal coincide con el año de calendario) y la puerta de alta lo rechaza si viene otro; **US lo permite** (IRC §441). El periodo 13 se crea sólo si `permitePeriodoDeAjuste`. El primer ejercicio irregular (CFF 11, desde la constitución) queda declarado y pendiente. Quién escribe `fiscal_years.status='closed'` y `fiscal_periods.status='locked'` es el conductor del cierre, tramo A6 (issue [#121](https://github.com/sedecim-com/Accounting/issues/121)) — este documento no lo duplica, lo enlaza.

### 3.7 Los informes por jurisdicción

El paquete fija el idioma de los rótulos y la lista de formatos que sabe producir. Lo que falta es lo mismo en ambas jurisdicciones y está censado en `motores/informes-y-panel.md`: para México el XML del Anexo 24 (F07) y la balanza de cuatro columnas; para Estados Unidos el balance clasificado (ASC 210), el estado de cambios en el capital y el resultado integral (ASC 220); para ambas los comparativos y las notas. No es materia del primer tramo de este diseño; queda enlazado desde la Vía B.

### 3.8 El agente

El paquete lista el `corpus` que el agente abre para la jurisdicción de la entidad activa: México → `nif-*.md`, `niif-*.md`, `mexico-cfdi.md` y el corpus fiscal mexicano; Estados Unidos → el corpus US GAAP (espejo de `ifrs-registry.json`, que hoy **no existe**: `ls src/ai/docs/` no tiene nada de ASC) y el fiscal federal. `DOC_TOPICS` (`src/ai/tools/docs-tools.ts`) gana los temas nuevos y el manifiesto (`src/ai/docs/manifiesto.json`) los registra en el mismo commit. Lo que **no cambia**: el agente lee ley y criterio y los explica; no decide ninguno de los dos.

## 4. Lo que no cambia

- Los siete invariantes de [`AGENTS.md`](../AGENTS.md): el agente propone y el humano dispone; una sola puerta al mayor; ningún secreto en configuración; el suelo se combina con `Math.min`.
- «Ante la duda, mexicana»: el borde nulo sigue resolviendo a México, ahora en un solo sitio.
- Los nombres de las 39 claves y sus lectores: ninguna política existente se renombra ni cambia de default para México.
- La resolución entidad > inquilino que `policy-service.ts:136-138` ya tiene: se **añade** un eslabón intermedio, no se reordena.

## 5. La secuencia: tramo J0, con sus criterios

Cada paso añade su criterio a `src/plan/criterios.ts` **en el mismo commit que lo cierra**, y ningún criterio se declara verde por prosa (la lección de E3.2). El orden importa: cada paso deja el árbol verde sin el siguiente.

| Paso | Qué entrega | Criterio ejecutable |
|---|---|---|
| **J0.1** | `jurisdiccionDe` en `src/services/jurisdiccion/`; `esContabilidadMexicana` como envoltura; las tres copias del §1.1 borradas | grep cero predicados inline en `src/services` fuera de `jurisdiccion.ts`; prueba de borde: nulo → MX en **todos** los consumidores |
| **J0.2** | Migración `06x_la_jurisdiccion_como_dimension.sql` (la siguiente libre; `docs/migraciones.md` manda): `policy_decisions.jurisdiction` + índice; `parametros_legales`; `tax_parameters.effective_from/to` rellenados | la columna existe **y tiene lector** (`policy-service.ts`); la tabla existe y tiene escritor (la semilla) y lector |
| **J0.3** | `PolicySpec.jurisdicciones`; resolución de cinco eslabones; siembra filtrada; `pending --jurisdiction`, `pending explain`; reclasificación de las 39 claves | prueba de integración: dos entidades del mismo inquilino, MX y US, resuelven **distinto** `destino_del_resultado_del_ejercicio` sin fila alguna; la US no tiene `rep_*` sembradas |
| **J0.4** | UMA, SMG, subsidio, tasas de IVA, 2 000, 8.5 %, SS wage base, FUTA, FMW y CCPA a `parametros_legales`; lectura por fecha; fallo cerrado; `doctor` | mutación en memoria: borrar la vigencia → **error**, no cero ni un valor quemado (en IMSS, INFONAVIT y en el clasificador CFDI); `tax_tables` se busca por fecha, no por `tax_year` |
| **J0.5** | `ESTRATO_FISCAL_US`, `ROLES_FISCALES_US`, `catalogoBasePara(j)` (la 3300 sigue universal; su uso lo decide el default por jurisdicción de J0.3) | entidad US sembrada: sin IVA, con *Sales Tax Payable*, y su cierre anual barre a 3200 sin fila del panel; entidad MX: idéntica a hoy (prueba de no-regresión sobre el catálogo sembrado) |
| **J0.6** | `fiscal_year_start_month` leído por `ensureFiscalYear`; MX lo fuerza a 1 en la puerta de alta; periodo 13 por paquete | el campo tiene lector; alta MX con mes 7 → rechazo; alta US con mes 7 → periodos jul→jun |
| **J0.7** | La guardia del panel: toda clave con lector | la prueba pasa; los cinco textos desfasados del §1.4 corregidos |
| **J0.8** | Corpus por jurisdicción en el agente (depende de N1 y N2, la investigación normativa) | `DOC_TOPICS` y `manifiesto.json` registran los documentos nuevos; prueba de sincronía del registro GAAP como la de NIIF (`tests/ai/niif-registry.spec.ts`) |

El coste no se estima aquí: el modelo de coste por fila vive en [`docs/plan-catalogo.md`](plan-catalogo.md) y se mide, no se promete. Lo que sí se afirma es el **orden**: J0.1 y J0.2 van antes que cualquier motor nuevo por jurisdicción (sales tax, 1099, DIOT, retenciones), porque cada uno de esos motores necesita preguntar «¿de qué jurisdicción es esto?» y leer un parámetro con vigencia, y construirlos antes es construirlos sobre el booleano y sobre constantes.

## 6. Preguntas que se deciden después, y dónde

- **¿Entidad con libros IFRS?** El CHECK lo admite, `Country` lo impide. Se mantiene impedido hasta que un cliente lo necesite; entonces `libros: 'ifrs'` ya tiene sitio en `Jurisdiccion` y el corpus NIIF ya existe.
- **¿El estado como sub-jurisdicción?** `tax_tables.jurisdiction` ya habla en `US-CA`; `legal_entities` no tiene columna de estado. Para SIT/SUTA basta el estado del empleado (ya en nómina); para *sales tax* hace falta la lista de estados con nexo, que es una **decisión del despacho** → clave del panel, no columna.
- **¿Renombrar las claves `_mxn`?** No en el primer tramo. Si se hace, con alias y migración que copie filas; nunca rompiendo lectores.
- **¿Fundir `tax_parameters` en `parametros_legales`?** Después de J0.4, cuando ambas tengan la misma disciplina de vigencia y se vea si sobra una.

## Para seguir

- Evidencia por subsistema: [`docs/investigacion/2026-09-06-normas-y-motores/motores/`](investigacion/2026-09-06-normas-y-motores/)
- Las fuentes normativas: [`normas/`](investigacion/2026-09-06-normas-y-motores/) — GAAP/ASC, el delta IFRS↔NIF, fiscal MX, fiscal US
- La secuencia completa y las issues: J0 es [#123](https://github.com/sedecim-com/Accounting/issues/123); J1/J2 son [#124](https://github.com/sedecim-com/Accounting/issues/124) y [#125](https://github.com/sedecim-com/Accounting/issues/125); N1/N2/N3 son [#131](https://github.com/sedecim-com/Accounting/issues/131), [#132](https://github.com/sedecim-com/Accounting/issues/132) y [#133](https://github.com/sedecim-com/Accounting/issues/133); los defectos T19–T23, [#126](https://github.com/sedecim-com/Accounting/issues/126)–[#130](https://github.com/sedecim-com/Accounting/issues/130). Etiqueta `jurisdiccion`; `docs/HISTORY.md` («Lo que sigue»)
- Cómo se pregunta el estado: `npm run plan:status` — nada de este documento cuenta como hecho hasta que su criterio esté verde
