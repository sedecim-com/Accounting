# Nómina México — inventario verificado de motores

> **Método.** Lo escribió un lector de código sobre `src/services/payroll/mx/`, `common/`, `integrations/` y `tax-engine/` de la rama `investigacion/normas-y-motores`, y lo verificó un escéptico independiente con la instrucción de refutar, que reabrió cada `archivo:línea` con `cat -n`, repitió cada `grep` de ausencia sobre `src/` y `tests/`, y contrastó cada «parámetro quemado» con `tax_parameters`/`tax_tables` (`009_tax_tables_2026.sql`) y con el panel (`pending-catalog.ts`); ambos leyeron el árbol en HEAD `812a43c`. Este documento funde los dos informes y se escribe en HEAD `4b1d8fe` de la misma rama, donde `git diff --stat 812a43c 4b1d8fe` sobre `src/services/payroll`, `src/api/rest/routes/payroll.ts`, `src/database/migrations`, `src/cli`, `src/ai`, `src/plan/criterios.ts`, `src/services/policy/pending-catalog.ts` y `tests/payroll` está vacío: toda cita apunta hoy a la misma línea que cuando se verificó.

**Vocabulario de estado.** `completo`: existe, tiene puerta y hace lo que dice para su alcance. `parcial`: existe con huecos nombrados frente a la norma. `inerte`: el motor existe pero no tiene puerta, o la tiene y no escribe nada. `ausente`: no hay motor bajo ningún nombre (se buscó por `grep` antes de afirmarlo).
**Vocabulario de parámetro.** `ley`: debería estar en tabla con vigencia (hoy está en `tax_tables`/`tax_parameters` indexada por año). `panel`: criterio del despacho en `pending-catalog.ts`. `casa`: constante propia del motor o del formato. `quemado`: ley o criterio escrito en código, que es lo que hay que mover.

Las cifras de decretos 2024-2026 (subsidio, UMA/SMG 2026, tabla de CyV, tarifa quincenal) se marcan **«por verificar contra DOF/Anexo 8»** donde el repo no las trae; ninguno de los dos informes las inventa.

---

## 0. Cómo ve la jurisdicción este subsistema

**El conmutador no es el de contabilidad.** Nómina no pregunta `esContabilidadMexicana` (`src/services/accounting/pais-contable.ts:35-44`) sino `employees.country_code`: `paycheck-service.ts:153` `if (emp.country_code === 'US') … else { // MEXICO }`. La columna tiene `CHECK (country_code IN ('MX','US'))` (`src/database/migrations/008_payroll.sql:35`) y todo lo distinto de `'US'` cae en México, igual que en `pais-contable.ts`. La entidad legal no interviene en la bifurcación; el país es del empleado.

**La ley vive en tablas indexadas por año, sin vigencia.** `tax_tables` y `tax_parameters` se leen por `(jurisdiction, tax_year)` (`tax-tables.ts:44-49` `getBrackets`, `:74-77` `getTaxParameters`); `tax_parameters` tiene `UNIQUE(jurisdiction, tax_year)` (`008:381`) y `tax_tables` trae `effective_from/effective_to` (`008:367-368`) que **nadie filtra**: `effective_from`/`effective_to` no se leen en ninguna parte de `src/services/payroll` (lo que sí aparece es `effective_date`, en `nacha-generator.ts`, `benefits-service.ts`, `imss-idse-adapter.ts` y `employee-service.ts`, que es otra cosa). Un solo juego de UMA/SMG por año, cuando la UMA cambia el 1 de febrero y el SMG el 1 de enero (ver M17). La semilla MX sólo trae 2026 (`009:37-38`), y con valores de 2025 (ver M17).

**Frecuencias.** `pay_schedules.frequency` admite `weekly, biweekly, semimonthly, monthly, quincenal` (`008:122-123`) y `PayFrequency` añade `annual` (`tax-engine.interface.ts:6`); la semilla ISR sólo trae `monthly` y `quincenal` (ver M1).

**Métricas sin país.** Las transiciones de estado de la corrida se etiquetan `country: 'unknown'` (`pay-run-service.ts:105,126,137`) aunque el país del empleado se conoce en el mismo servicio.

**Lo que está en otra rama.** El commit `675b2a9` («F08a: el subsidio que el trabajador no recibía, y un impuesto entero que no existía») **no es ancestro de este HEAD** (`git merge-base --is-ancestor 675b2a9 HEAD` → no; `git branch --contains 675b2a9` → sólo `instrumentos-que-mienten-segun-la-maquina`). Ese commit añade `src/services/payroll/mx/isn-calculator.ts`, `src/services/payroll/mx/subsidio-entregado.ts`, `src/services/payroll/common/employer-liability-service.ts`, `src/cli/payroll-isn-command.ts`, las migraciones 067/068 y 112 líneas de `pending-catalog.ts`. En este árbol no existe ninguno (`ls` → No such file; `ls src/database/migrations/ | grep -E "^06[5-9]|^07"` vacío; `grep -rn "Math.max(0, isr" src/services/payroll/common/paycheck-service.ts` → línea 247 sigue ahí). Este inventario describe **este** árbol; donde la otra rama tapa un hueco, se dice.

**Mapa del subsistema**

| Archivo | Líneas | Qué es |
|---|---|---|
| `src/services/payroll/mx/isr-calculator.ts` | 88 | ISR art. 96 + subsidio al empleo |
| `src/services/payroll/mx/imss-calculator.ts` | 148 | Cuotas IMSS obrero y patronal |
| `src/services/payroll/mx/infonavit-calculator.ts` | 86 | INFONAVIT patronal 5 % + descuento de crédito |
| `src/services/payroll/mx/finiquito-math.ts` | 337 | Aritmética pura del finiquito (LFT 76/79/80/87, LSS 27) |
| `src/services/payroll/mx/finiquito-calculator.ts` | 176 | Cáscara del finiquito: Postgres + panel de políticas |
| `src/services/payroll/mx/cfdi-nomina-generator.ts` | 162 | XML CFDI 4.0 tipo N + complemento Nómina 1.2, timbrado vía `pacRouter` |
| `src/services/payroll/mx/sua-generator.ts` | 131 | Archivo SUA mensual (layout «simplificado») |
| `src/services/payroll/integrations/imss-idse-adapter.ts` | 159 | Lote IDSE de movimientos afiliatorios (layout «simplificado») |
| `src/services/payroll/common/paycheck-service.ts` | 402 | Orquestador bruto→neto; bifurca MX/US por `employees.country_code` |
| `src/services/payroll/common/pay-run-service.ts` | 139 | Ciclo de la corrida: draft→calculating→calculated→approved→paid |
| `src/services/payroll/common/pay-period-service.ts` | 142 | Calendarios de pago (weekly/biweekly/semimonthly/monthly/quincenal) |
| `src/services/payroll/common/employee-service.ts` | 179 | Alta/consulta/salario/baja del empleado |
| `src/services/payroll/common/gl-posting-service.ts` | 175 | Asiento compuesto de la corrida al mayor |
| `src/services/payroll/common/payroll-account-mapping-seed.ts` | 372 | Siembra de buckets contables MX/USA |
| `src/services/payroll/tax-engine/tax-tables.ts` | 122 | Lectura cacheada de `tax_tables` y `tax_parameters` |
| `src/services/payroll/tax-engine/register-all.ts` | 62 | Registro de calculadoras (MX: 6) |

**Pruebas que tocan MX.** `tests/payroll/mx/` sólo trae `finiquito-math.spec.ts`, `finiquito.spec.ts`, `imss-idse-batch.spec.ts`; `tests/payroll/tax-engine/tax-tables.spec.ts` cubre `applyBrackets` y `periodsPerYear`. **No hay ninguna prueba** de `MexicoIsrCalculator`, `MexicoSubsidioEmpleoCalculator`, `MexicoImss*`, `MexicoInfonavit*`, `generateAndStampCfdiNomina`, `generateSuaFile` ni `calculatePaycheck` (`grep -rln "paycheck-service|isr-calculator|imss-calculator|infonavit-calculator|cfdi-nomina-generator|sua-generator" tests/` → vacío).

**Sobre la granularidad.** El inventario consolidado (`../motores-inventario.md` §5) califica a grano grueso («completo» = existe, tiene puerta y hace lo que dice para su alcance) y da `completo` a ISR, subsidio, IMSS, INFONAVIT, SUA e IDSE. Aquí cada motor se mide contra la norma completa, y por eso los mismos motores salen `parcial`. No se contradicen: cambia la vara, no los hechos.

---

## 1. Motores, uno por uno

### M1 · ISR retenido sobre salarios (LISR art. 96) — `isr-calculator.ts:9-45` — **parcial**

**Reglas implementadas**
- Tarifa progresiva por tramo (límite inferior, cuota fija, % sobre excedente): `applyBrackets` en `tax-tables.ts:88-103`; la tarifa se lee de `tax_tables` con `jurisdiction='MX', tax_type='isr', pay_frequency ∈ {monthly, quincenal}` (`isr-calculator.ts:27-28`). Norma: LISR art. 96, tarifas del Anexo 8 RMF.
- Semilla: `009_tax_tables_2026.sql:150-161` (mensual, 11 tramos) y `:164-175` (quincenal, 11 tramos).
- Base cero → impuesto cero (`isr-calculator.ts:16-24`). Sin tabla del año **lanza** (`:30-31`): falla cerrado, al contrario que IMSS e INFONAVIT (ver M3, M5).

**Lo que el escéptico precisó sobre la semilla**
- La tarifa mensual sembrada (0.01–746.04 al 1.92 % … 375,975.62+ con cuota 117,912.32 al 35 %) coincide con el Anexo 8 RMF vigente desde 2024, que según el conocimiento del escéptico sigue rigiendo en 2026 (inflación acumulada < 10 %, LISR art. 152 último párrafo). **El dato mensual no está mal**; lo que falta es el mecanismo de vigencia, y la etiqueta «estimado» (`009:147`) miente en la dirección contraria. Por verificar contra Anexo 8.
- **Hallazgo nuevo (por verificar contra Anexo 8).** La quincenal es «same structure, divided by 2» (`009:163`): el tramo 1 cierra en 373.02 = 746.04/2. La tarifa quincenal publicada se obtiene con ×15/30.4 (tramo 1 cierra en 368.10). **No es la tabla publicada.**

**Reglas por definir (MX)**
- Frecuencias distintas de mensual/quincenal: `isr-calculator.ts:27` `const freq = pay_frequency === 'quincenal' ? 'quincenal' : 'monthly'`. Una nómina MX semanal o catorcenal (permitidas por el CHECK de `pay_schedules`, `008:122-123`) aplica la tarifa **mensual** a un ingreso de periodo → retiene de menos. LISR art. 96 y Anexo 8 publican tarifas diaria, semanal, decenal, catorcenal, quincenal y mensual.
- Ajuste anual de retenciones (LISR art. 97) y constancias (art. 99 fr. III): `grep -rniE "ajuste anual|art\.? ?97\b|constancia" src/services src/api src/cli` → ninguna coincidencia de nómina. El YTD sí acumula `isr_taxable_wages`/`isr_withheld` (`ytd-service.ts:90,97,123,130`); sus lectores MX son `gl-posting-service.ts:74` y `cfdi-nomina-generator.ts:53`, ninguno anual. Ver M22.
- Asimilados a salarios (LISR art. 94 fr. IV-VI): ver M23.
- Pagos extraordinarios (aguinaldo, PTU, prima vacacional, finiquito): RLISR art. 174 y LISR art. 95. Ausente: `paycheck-service.ts:129-131` suma todo `is_taxable_isr !== false` menos pre-tax, sin distinguir.
- Ingresos exentos (LISR art. 93): ver M13.
- Actualización de tarifa por inflación acumulada > 10 % (art. 152 último párrafo): `getBrackets` (`tax-tables.ts:44-49`) filtra por `tax_year` y no por `effective_from/effective_to`. Ver M17.

**Reglas por definir (US)** — no aplica: el equivalente (FIT) vive en `usa/federal/fit-calculator.ts`.

**Parámetros**
- Tarifa mensual y quincenal — `ley` (en `tax_tables`, una fila por año, sin vigencia; la quincenal derivada, no publicada).
- Mapeo de frecuencia «todo lo no quincenal → mensual» — `quemado` (`isr-calculator.ts:27`).
- Redondeo a centavos `Math.round(tax * 100) / 100` en `number` — `casa` (`:39`; `applyBrackets` opera en `number`, `tax-tables.ts:88-103`; el finiquito ya migró a `Decimal`, `finiquito-math.ts:28-30`).

**Puerta**: `POST /v1/payroll/pay-runs/:id/calculate` (`routes/payroll.ts:207-219`) → `calculatePayRun` (`pay-run-service.ts:46`) → `calculatePaycheck` (`paycheck-service.ts:238-240`).

---

### M2 · Subsidio al empleo — `isr-calculator.ts:52-88` — **parcial**

**Reglas implementadas**
- Búsqueda del tramo mensual en `tax_tables` (`tax_type='subsidio_empleo'`, `pay_frequency='monthly'`) y lectura de `base_tax` como importe del subsidio (`isr-calculator.ts:62-74`). Conversión quincenal: `:60` `taxable_wages * 2`, `:77` `monthlySubsidy / 2`; todo lo no quincenal se trata como mensual. Marcado `is_credit: true` (`:84`).
- Semilla: `009:182-194`.
- Aplicación contra el ISR: `paycheck-service.ts:247` `const netIsr = Math.max(0, isr.tax_amount - sub.tax_amount)`. El comentario de `:246` («if negative, employee receives as cash») describe lo contrario de lo que hace la línea siguiente.

**Reglas por definir (MX)**
- **La semilla mezcla dos regímenes.** Los importes 407.02 / 406.83 / 406.62 / 392.77 / 382.46 / 354.23 / 324.87 / 294.63 / 253.54 / 217.61 y el corte 7,382.33 son, exactamente, la tabla mensual del art. Décimo transitorio LISR (DOF 11-dic-2013); el tramo 11 `7382.34–10171.00 → 0.00` injerta el tope de ingreso del Decreto DOF 31-dic-2024 (13.8 % de la UMA mensual, para quien no rebase 10,171.00). Los Decretos DOF 01-may-2024 y 31-dic-2024 sustituyeron la tabla por **un importe único mensual como porcentaje de la UMA mensual**; ese importe no está en el código ni en `tax_parameters`. Regla por definir con cita al decreto del año y vigencia intra-anual (el de 2024 entró el 1 de mayo). Cifras por verificar contra DOF.
- **Entrega en efectivo cuando el subsidio supera al ISR.** Este árbol la niega (`Math.max(0,…)`, `paycheck-service.ts:247`). F08a (otra rama) la afirma: `git show 675b2a9 -- src/services/payroll/common/paycheck-service.ts` borra esa línea (`-387`) y entrega el excedente vía `aplicarSubsidioAlEmpleo` de `subsidio-entregado.ts` (`+391..+397`). Bifurcación de criterio resuelta en código en dos ramas en sentidos opuestos: exactamente lo que la casa manda llevar al panel con vigencia, no elegir en código.
- **Observación del escéptico (por verificar contra DOF).** Según su lectura de los Decretos DOF 01-may-2024 y 31-dic-2024, bajo el régimen vigente el subsidio sólo se **acredita** contra el ISR y **no se entrega** excedente; la entrega en efectivo era del transitorio 2013. Si es así, F08a eligió el criterio del régimen derogado. Refuerza la tesis: parámetro con vigencia, no decisión en código.
- Complemento Nómina 1.2: nodo `OtrosPagos TipoOtroPago=002` con `SubsidioAlEmpleo SubsidioCausado` (obligatorio cuando hay subsidio causado aunque no se entregue): `grep -rniE "OtrosPagos|SubsidioCausado|TipoOtroPago" src/` → vacío. El XML (`cfdi-nomina-generator.ts:99-133`) no tiene el nodo.
- Frecuencias distintas de mensual/quincenal: `:60,77` sólo saben ×2/÷2.
- **Efecto en el mayor**: ver el hallazgo grave de M20 (el posteo revienta con un solo trabajador cuyo subsidio supere al ISR).

**Parámetros**
- Tabla de subsidio — `ley` (en `tax_tables`, híbrida de dos regímenes, sin vigencia).
- Factor 2 quincenal — `quemado` (`isr-calculator.ts:60,77`; debería derivarse de `periodsPerYear`).
- Regla de no entrega del excedente — `quemado` (`paycheck-service.ts:247`; es criterio con vigencia: régimen 2013 vs decretos 2024/2025).

**Puerta**: misma que M1 (`paycheck-service.ts:242-248`).

---

### M3 · IMSS cuota obrera (LSS arts. 25, 106, 107, 147, 168) — `imss-calculator.ts:51-93` — **parcial**

**Reglas implementadas**
- SBC diario topado a 25 UMA (`:62-64`; LSS art. 28 con UMA por el Decreto de desindexación DOF 27-ene-2016).
- Excedente sobre 3 UMA para Enfermedades y Maternidad (`:65,72`; LSS art. 106 fr. II).
- Ramos obreros: prestaciones en dinero (`:74`, art. 107), gastos médicos pensionados (`:76`, art. 25), invalidez y vida (`:78`, art. 147), cesantía y vejez (`:80`, art. 168 fr. II). Todo × `days_in_period`.
- Tasas desde `tax_parameters.params.imss_employee` (`:67`; semilla `009:45-51`). El resto de la semilla obrera es correcto: PD 0.25 %, GMP 0.375 %, IV 0.625 %, CyV 1.125 %.

**Reglas por definir (MX)**
- **Tasa obrera E&M excedente sembrada en 0.00625** (`009:46`): LSS art. 106 fr. II con el transitorio vigente fija **0.40 %** obrera / 1.10 % patronal; 0.625 % es la cuota obrera de Invalidez y Vida (art. 147; `009:49` la trae bien). La patronal `0.011` (`009:54`) es correcta. **Error de dato confirmado**: sobrecobra al trabajador con SBC > 3 UMA.
- Días de cotización ≠ días naturales: `paycheck-service.ts:106-107` toma días naturales del periodo y `:146` hace `Math.floor(daysInPeriod)`. Incapacidades y ausentismos (LSS art. 31): `grep -rniE "incapacidad|ausentismo|dias_cotizados" src/services/payroll src/database/migrations` → nada (las coincidencias de «falta» son prosa).
- Trabajador con salario mínimo: el patrón absorbe la cuota obrera (LSS art. 36). Nada en el archivo.
- SBC: `paycheck-service.ts:145` `sbc_daily: emp.sbc ? parseFloat(emp.sbc) : undefined` — dato manual. No se integra desde el salario (LSS art. 27; `factorDeIntegracion` sólo lo usa `salarioDiarioDesdeSbc`, `finiquito-math.ts:183-207`, llamador único `finiquito-calculator.ts:139`) ni se recalcula por variables bimestralmente (LSS art. 30 fr. II-III).
- Registro en `paycheck_taxes` por ramo: la tabla existe (`008:309-319`, «imss_ivcm, imss_em, imss_rt, imss_gmp, imss_prestaciones») y **nadie la escribe** (`grep -rniE "INSERT\s+INTO\s+paycheck_taxes" src/` → vacío). Menciones: `rls-policies.sql:176`, `criterios.ts:2398-2405`, `doctor-service.ts:695` (la clasifica «numero-falso»), `routes/payroll.ts:481` (SELECT). El criterio E4.1 (`criterios.ts:2392-2416`) lo mide y falla.
- **Hallazgo nuevo (grave): IMSS = 0 en silencio si falta la fila del año.** `getTaxParameters` devuelve `{}` cuando `tax_parameters` no tiene `(MX, tax_year)` (`tax-tables.ts:79`); `imss-calculator.ts:67,72-80` multiplican por `(x || 0)`. Una corrida de 2027 calcula IMSS obrero 0 sin error, mientras el ISR sí lanza (`isr-calculator.ts:30-31`). La semilla sólo trae 2026 (`009:37-38`). Debe fallar cerrado.

**Parámetros**
- Tasas por ramo — `ley` (en `tax_parameters` por año; una de ellas errónea).
- UMA de respaldo `113.14` — `quemado` (`imss-calculator.ts:62`; es la UMA 2025, DOF 10-ene-2025; la migración la etiqueta 2026 «estimada», `009:4,36`).
- Tope `uma * 25` — `quemado` (`:63`): `imss_tope_sbc_multiplier` está sembrado (`009:44`) y **nadie lo lee** (`grep -rn imss_tope_sbc_multiplier src/` → sólo la migración).
- Excedente `3 * uma` — `quemado` (`:65`).
- `days_in_period = 15` — `casa`, **default muerto** (`:56`): es un valor de destructuración que el único llamador (`paycheck-service.ts:146`) siempre sobreescribe. Literal que no debería existir, pero hoy no altera ninguna cuota (matiz del escéptico).

**Puerta**: `paycheck-service.ts:251-254` desde `POST /pay-runs/:id/calculate`.

---

### M4 · IMSS cuota patronal (LSS arts. 25, 71-74, 106, 107, 147, 168, 211) — `imss-calculator.ts:99-148` — **parcial**

**Reglas implementadas**
- Cuota fija E&M = UMA × 20.40 % × días (`:119`; art. 106 fr. I). Excedente 3 UMA (`:121`; art. 106 fr. II). Prestaciones en dinero (`:123`; art. 107). GMP (`:125`; art. 25). IV (`:127`; art. 147). Guarderías y prestaciones sociales 1 % (`:129`; art. 211). Riesgo de trabajo por clase 01-05 (`:36-45,131`; primas medias del art. 73). CyV (`:133`; art. 168 fr. II). Retiro 2 % (`:135`; art. 168 fr. I).
- Tasas desde `tax_parameters.params.imss_employer` (`:114`; semilla `009:52-66`).

**Reglas por definir (MX)**
- **Prima de riesgo de trabajo es del registro patronal, no del puesto.** LSS arts. 72-74 y RACERF fijan la prima por patrón según siniestralidad (declaración anual en febrero, rango 0.5 %–15 %); las primas medias del art. 73 sólo rigen al inscribirse. El motor la deriva de `employees.riesgo_puesto` (`:104` destructura, `paycheck-service.ts:147` la pasa, `:131` `riesgoRate(er, riesgo_puesto)`), que es la clase del **puesto** para el CFDI (`c_RiesgoPuesto`); `:36-45` mapea clase 01-05 a cinco tasas fijas (`009:59-63`) con default clase 1 (`:43`). Debe ser parámetro de `legal_entities` (registro patronal) con vigencia anual.
- **Cesantía y vejez patronal por tramo de SBC.** La reforma de pensiones (DOF 16-dic-2020, LSS art. 168 fr. II y transitorios) sustituyó el 3.150 % plano por una tabla por múltiplos de UMA que sube cada año de 2023 a 2030. La semilla trae `0.03150` plano (`009:64`), que sólo corresponde al tramo de 1 SMG.
- Días de cotización con incidencias (art. 31): igual que M3.
- Bimestralidad de RCV e INFONAVIT (LSS art. 39): no se distingue, todo por periodo de pago (`:133,135`; `infonavit-calculator.ts:36`).
- Pasivo patronal por tipo y fecha de entero (LSS art. 39: día 17 del mes siguiente): `employer_tax_liabilities` existe (`008:329-348`) y **nadie la escribe** (`grep -rniE "INSERT\s+INTO\s+employer_tax_liabilities" src/` → vacío). Lectores: `form-941-generator.ts:63`, `form-940-generator.ts:51`, `doctor-service.ts:285-292` (nivel `fail`). F08a (otra rama) añade `employer-liability-service.ts`.
- **Hallazgo nuevo (grave), igual que M3**: `:114,119-135` multiplican por `(x || 0)`; sin fila del año, cuota patronal 0 en silencio.

**Parámetros**
- Tasas por ramo — `ley` (en `tax_parameters`; CyV plana es dato erróneo en tabla).
- Prima de RT por clase del **puesto** — `quemado` (`:36-45,131`; debe ser `ley`/`panel` por registro patronal con vigencia anual).
- Clase de riesgo por defecto `'01'` — `quemado` (`:43`).
- UMA 113.14 (`:110`), tope 25 (`:111`), 3 UMA (`:113`) — `quemado`.
- `days_in_period = 15` (`:104`) — `casa`, default muerto (ver M3).

**Puerta**: `paycheck-service.ts:256-260`.

---

### M5 · INFONAVIT aportación patronal 5 % (Ley INFONAVIT art. 29 fr. II) — `infonavit-calculator.ts:20-47` — **completo** (para su alcance)

**Reglas implementadas**: 5 % del SBC topado a 25 UMA × días (`:30-36`); tasa desde `params.infonavit_employer_rate` (`:32`, semilla `009:67`).

**Reglas por definir (MX)**: bimestralidad y entero con el SUA (Ley INFONAVIT art. 29 fr. II + LSS art. 39); días de cotización con incidencias; pasivo en `employer_tax_liabilities` (sin escritor, ver M4). **Hallazgo nuevo**: sin fila del año en `tax_parameters`, `:32` cae a `0.05` y `:31` a UMA 113.14 sin error — falla abierto con valores de respaldo, no lanza.

**Parámetros**
- Tasa 5 % — `ley` (en `tax_parameters`).
- Respaldo `|| 0.05` (`:32`), UMA 113.14 (`:31`), tope `uma * 25` (`:33`) — `quemado` (el respaldo sobra si la tabla es obligatoria).
- `days_in_period = 15` (`:25`) — `casa`, default muerto (ver M3).

**Puerta**: `paycheck-service.ts:263-266`.

---

### M6 · INFONAVIT descuento por crédito del trabajador (Ley INFONAVIT art. 29 fr. III) — `infonavit-calculator.ts:50-86` — **parcial**

**Reglas implementadas**: tres tipos de descuento — `factor` (fracción del SBC × días, `:67-68`), `vsm` (SMG × veces × días, `:70-71`), `pesos` (importe mensual × días/30, `:73-74`). Sólo se invoca si el empleado tiene `infonavit_credit_type` y `infonavit_credit_value` (`paycheck-service.ts:269-280`).

**Reglas por definir (MX)**
- Base del tipo `vsm`: `:61` `salario_minimo_general_diario || 278.80`, `:71` `smg * credit_value * days_in_period`. Si la base debe ser SMG o UMA es una decisión de jurisdicción y de fecha (desindexación 2016) que hoy está clavada; debe ser parámetro.
- Tipo `pesos`: `:74` `credit_value * (days_in_period / 30)` — mes de 30 días.
- Seguro de daños INFONAVIT (cuota fija bimestral que se suma al descuento): `grep -rniE "seguro de da" src/services src/database` → vacío.
- Aviso de retención / suspensión: `employees` sólo trae `infonavit_credit_number/type/value` (`008:41-43`), sin fechas de vigencia del crédito.
- Deducción CFDI `010`: el generador sólo emite `Deduccion` a partir de `paycheck_deductions` (`cfdi-nomina-generator.ts:78-80,96`) y el ISR `002` (`:129`); el INFONAVIT vive en `paychecks.infonavit_withheld` (`paycheck-service.ts:357`) y sólo entra en `TotalOtrasDeducciones` (`:86`). Ver M14.

**Parámetros**
- SMG de respaldo `278.80` — `quemado` (`:61`; valor 2025, DOF 4-dic-2024).
- Base VSM = SMG — `quemado` (`:61,71`; SMG vs UMA es parámetro de jurisdicción y fecha).
- UMA 113.14 (`:62`), tope 25 (`:63`), mes de 30 días (`:74`) — `quemado`.
- `days_in_period = 15` (`:55`) — `casa`, default muerto (ver M3).

**Puerta**: `paycheck-service.ts:268-280`.

---

### M7 · Finiquito (LFT arts. 76, 79, 80, 87; LSS art. 27) — `finiquito-math.ts:245-337` + `finiquito-calculator.ts:79-176` — **completo** (como finiquito; no es liquidación)

**Reglas implementadas**
- Tabla de vacaciones art. 76 reformado 2023 («vacaciones dignas»): 12 el primer año, +2 hasta 20 al quinto, +2 por quinquenio después, sin tope (`finiquito-math.ts:80-88`; pruebas `tests/payroll/mx/finiquito-math.spec.ts:29-95`).
- Salarios devengados no pagados (`:258-259`).
- Aguinaldo proporcional desde la fecha de alta, inclusive, con divisor 365/366 según bisiesto (`:275-283`; art. 87).
- Prima vacacional proporcional sobre el año de servicio, de aniversario a aniversario (`:297-308`; arts. 79 y 80).
- Vacaciones pendientes de años cumplidos a salario diario (`:311-313`).
- Factor de integración LSS art. 27 y su inversa para reconstruir el salario diario desde el SBC (`:183-207`).
- Antigüedad por aniversario de calendario, no por `días/365` (`:145-150`).
- Todo en `Decimal` a 4 decimales; el total es suma de los redondeados (`:317-320`).
- **Lee el panel**: `dias_aguinaldo` y `prima_vacacional_pct` (`finiquito-calculator.ts:100-105`; catálogo `src/services/policy/pending-catalog.ts:474-515`), con la entidad del **empleado** (`:98`) y el inquilino dentro del SQL (`:84-90`).

**Reglas por definir (MX)**
- **Liquidación** (despido injustificado / rescisión): indemnización constitucional de tres meses (LFT arts. 48 y 50 fr. III), 20 días por año (art. 50 fr. II), salarios vencidos hasta 12 meses + intereses (art. 48), **prima de antigüedad** de 12 días por año topada a 2 SMG (arts. 162, 485, 486). `grep -rniE "indemnizaci|prima de antig|salarios (ca[ií]dos|vencidos)" src/` → vacío. `PAY_RUN_TYPES` (`src/database/enums.ts:45`) y el CHECK (`008:159-160`) sólo tienen `final`; `run_type` se inserta (`pay-run-service.ts:39-41`) y **nadie lo lee después** (`grep -rn run_type src/services/payroll` → sólo esas líneas).
- **ISR del finiquito/liquidación**: exención de 90 UMA por año de servicio (LISR art. 93 fr. XIII), tasa efectiva (art. 95), RLISR art. 174; aguinaldo exento 30 UMA y prima vacacional 15 UMA (art. 93 fr. XIV). El motor devuelve brutos (`finiquito-math.ts:322-336`), sin retención.
- **Del cálculo al recibo**: `routes/payroll.ts:278-288` devuelve el JSON y nada más; único llamador de `calculateFiniquito` es `routes/payroll.ts:283`. No crea `pay_run`, ni `paycheck`, ni percepciones (`002` aguinaldo, `021` prima vacacional, `022` prima de antigüedad, `023` pagos por separación, `025` indemnizaciones), ni CFDI `TipoNomina=E`.
- Vacaciones pendientes vienen del llamador (`pending_vacation_days?`, `finiquito-calculator.ts:31,151`): no hay libro de devengo/disfrute.
- Salario diario de trabajador por hora: sin `annual_salary` se des-integra el SBC o vale `'0.0000'` (`:131-144`); `hourly_rate` no aparece.

**Parámetros**
- `dias_aguinaldo`, `prima_vacacional_pct` — `panel` (`pending-catalog.ts:474-515`); los mínimos legales (15 días, 25 %) ya no están clavados.
- Divisor 365 — `casa` (`finiquito-math.ts:47`, documentado como constante LSS art. 27, con bisiesto aparte `:134-136`; `finiquito-calculator.ts:134` `dividedBy(365)`). Confirmado que no es error.

**Puerta**: `POST /v1/payroll/finiquito` (`routes/payroll.ts:278-288`, con `requireEntityAccess`).

---

### M8 · Aguinaldo como motor de nómina (LFT art. 87) — **parcial** (sólo el proporcional dentro del finiquito)

- Implementado: prorrateo en el finiquito (`finiquito-math.ts:275-283`).
- Por definir (MX): corrida de aguinaldo anual (pago antes del 20 de diciembre, art. 87) — no existe; `run_type: 'bonus'` no cambia nada (ver M7). Parte exenta 30 UMA (LISR art. 93 fr. XIV), retención por RLISR art. 174, percepción CFDI `002`. Provisión mensual (NIF D-3): `grep -rniE "provisi[oó]n|provision" src/services/payroll src/services/accounting` → una sola coincidencia, el comentario de `payroll-account-mapping-seed.ts:69` sobre la cuenta 211 de seguridad social; ningún código de provisión. `earning_type='aguinaldo'` sólo en el comentario de esquema (`008:275`); ningún `aguinaldo` en `paycheck-service.ts` ni en el CFDI.
- **Hallazgo nuevo: el panel promete y niega a la vez.** `pending-catalog.ts:477-478` dice que `dias_aguinaldo` «Drives both the settlement calculation and the monthly provision» — la provisión no existe; y `:478-479` dice «The engine currently hardcodes a value and never reads it from anywhere» — falso desde D1a: `finiquito-calculator.ts:100-105` lo lee. El texto del panel miente en las dos direcciones.
- Parámetro: `dias_aguinaldo` — `panel` (sólo lo consume el finiquito).
- Puerta: sin puerta propia (entra como una percepción más en `pay-runs/:id/calculate`, gravada al 100 %).

### M9 · Prima vacacional y vacaciones (LFT arts. 76, 79, 80) — **parcial** (sólo en finiquito)

- Implementado: tabla art. 76 y prorrateo en el finiquito (`finiquito-math.ts:80-88, 297-308`); `prima_vacacional_pct` en el panel.
- Por definir (MX): libro de vacaciones — ninguna tabla de devengo/disfrute (`grep -rniE "vacacion" src/database/migrations` → nada estructural); `diasDeVacacionesPorAnio` sólo lo llama `finiquito-calculator.ts:113`. Pago de la prima al disfrutar, parte exenta 15 UMA (LISR art. 93 fr. XIV), percepción CFDI `021`, provisión mensual (NIF D-3, ver M8), prescripción de un año (LFT arts. 81/516).
- Parámetro: `prima_vacacional_pct` — `panel`.
- Puerta: sin puerta propia.

### M10 · Liquidación por despido (LFT arts. 48, 50, 162, 485, 486) — **ausente**
`grep -rniE "indemnizaci|prima de antig|salarios (ca[ií]dos|vencidos)|liquidaci[oó]n por despido" src/ --include='*.ts' --include='*.sql'` → vacío. Ver M7.

### M11 · PTU (LFT arts. 117-131; LISR art. 9; art. 127 fr. II y VIII) — **ausente**
`grep -rniE "\bptu\b|reparto de utilidades|participaci[oó]n de los trabajadores" src/ --include='*.ts' --include='*.sql'` → vacío. Coincidencias sólo en `src/ai/docs/nif-*.md`, `niif-*.md` y en `docs/cli-command-catalog.md:535,580`, que lo declaran fuera (familia fiscal MX, cuentas de orden). No hay renta gravable, ni reparto 50/50 por días y por salario (art. 123), ni tope de tres meses / promedio de tres años (art. 127 fr. VIII, reforma 2021), ni exención 15 UMA (LISR art. 93 fr. XIV), ni percepción CFDI `003`, ni provisión (NIF D-3).

### M12 · Horas extra y prima dominical (LFT arts. 66-68, 71, 73; LISR art. 93 fr. I y II) — **ausente**
`grep -rniE "horas? extra|tiempo extra|prima dominical|overtime|flsa" src/ --include='*.ts' --include='*.sql'` → una sola coincidencia, el comentario `008:275`. Las percepciones llegan ya calculadas por el llamador (`paycheck-service.ts:15-29`). El nodo `HorasExtra` del complemento no se emite.

### M13 · Ingresos exentos (LISR art. 93) e `ImporteExento` — **ausente**
- `grep -rniE "exent|art\.? ?93\b" src/services/payroll src/api/rest/routes/payroll.ts src/cli` → sólo los dos `"0.00"` del generador: `cfdi-nomina-generator.ts:95` `ImporteExento="0.00"` en toda percepción y `:124` `TotalExento="0.00"`. `paycheck-service.ts:129-131` grava el 100 % de lo marcado `is_taxable_isr`.
- Normas: LISR art. 93 fr. I-II (tiempo extra y descanso), XIII (separación, 90 UMA/año), XIV (aguinaldo 30 UMA, prima vacacional 15 UMA, PTU 15 UMA), XV-XVII (previsión social, tope 7 UMA anuales), XI (fondo de ahorro), art. 27 fr. XI (deducibilidad patronal de previsión social). Todo por definir; todo depende de la UMA vigente (M17).

---

### M14 · CFDI 4.0 tipo N + Nómina 1.2 — `cfdi-nomina-generator.ts:18-158` — **parcial**

**Reglas implementadas**
- Estructura `cfdi:Comprobante TipoDeComprobante="N"` con `Conceptos` único y complemento `nomina12:Nomina Version="1.2"` (`:99-133`; Anexo 20 CFDI 4.0 y guía de llenado del complemento Nómina 1.2).
- Percepciones desde `paycheck_earnings.cfdi_clave_sat`, deducciones desde `paycheck_deductions` no patronales (`:74-81, 95-96`).
- ISR neto de subsidio como `Deduccion 002` (`:84-85, 129`).
- Timbrado vía `pacRouter.stamp` con failover y candado de simulación (`:136-148`; `estadoParaPersistir`).
- Persistencia de `cfdi_uuid/cfdi_status/cfdi_provider/cfdi_stamped_at` en `paychecks` (`:145-149`).
- `tipo_regimen_sat` del empleado sí sale como `TipoRegimen` (`:121`) — es el único sitio donde la columna se consulta (ver M23).

**Reglas por definir (MX)** — cada una es motivo de rechazo del PAC/SAT o de dato falso ante la autoridad
- IMSS obrero e INFONAVIT **no salen como nodos** `Deduccion 001` / `010`: sólo se suman en `TotalOtrasDeducciones` (`:86-88`), que entonces no cuadra con la suma de los nodos `Deduccion` (`:96,129`).
- `OtrosPagos 002 SubsidioAlEmpleo SubsidioCausado`: ausente (ver M2).
- `RegistroPatronal="B0000000000"` clavado (`:117`) aunque `legal_entities.imss_registro_patronal` existe (`032_schema_contract.sql:28`) y el IDSE sí lo lee (`imss-idse-adapter.ts:64-68`).
- `RegimenFiscal="601"` del emisor clavado (`:105`). **Corrección del escéptico**: la columna de la que debería leerse **no existe**. `legal_entities` (`001_core_schema.sql`, `032:20-28`) sólo trae `tax_id`, `tax_id_type`, dirección, `postal_code`, `imss_registro_patronal`; el `tax_regime` de `049_cobrar.sql:105-106` es de `customers`. Hay que crear la columna, no sólo leerla.
- `LugarExpedicion="00000"` (`:104`) y `DomicilioFiscalReceptor="00000"` (`:107`): CFDI 4.0 exige el CP real del emisor y el CP registrado del receptor. **Hallazgo nuevo**: `legal_entities.postal_code` (`032:25`) y `employees.postal_code` (`008:80`) existen y bastarían; el generador no los consulta.
- `ClaveEntFed="MEX"` clavado (`:123`): en `c_Estado` `MEX` es **Estado de México**; todo trabajador queda declarado ahí, con efecto en ISN.
- `PeriodicidadPago="04"` (quincenal) clavado (`:123`) sin mirar `pay_schedules.frequency` (la consulta `:51-67` ni la trae).
- `TipoNomina` se decide con `r.emp_second_last === 'EXTRAORDINARIA'` (`:113`): compara el **apellido materno** del empleado; debe salir de `pay_runs.run_type`.
- `Antiguedad="P0W"` clavado (`:119`); debe ser semanas desde `FechaInicioRelLaboral`.
- `NumDiasPagados` = días naturales del periodo (`:91-93`), no días pagados (incidencias).
- RFC genérico `XAXX010101000` como respaldo del emisor y del receptor (`:105-106`) y CURP inventada `XAXX010101HDFNNN00` (`:118`): un comprobante de nómina a un RFC genérico no es válido. Debe rechazar, no rellenar.
- `Nombre` del receptor sin apellido materno (`:106`); 4.0 exige el nombre exacto del padrón.
- Nodos ausentes (`grep` → vacío): `Incapacidades`, `HorasExtra`, `SeparacionIndemnizacion`, `JubilacionPensionRetiro`, `EntidadSNCF`, `Emisor/Curp` para persona física.
- `Fecha` con hora fija `T10:00:00` (`:102`) y `Folio` derivado (`:101`).
- Aritmética en `parseFloat` (`:83-88`), fuera del `Decimal` que el finiquito ya adoptó.

**Parámetros**
- `quemado` (indebidos): `Folio` (`:101`), `Fecha T10:00:00` (`:102`), `RegimenFiscal 601` (`:105`), `LugarExpedicion`/`DomicilioFiscalReceptor 00000` (`:104,107`), `RegistroPatronal B0000000000` (`:117`), `Antiguedad P0W` (`:119`), `PeriodicidadPago 04` y `ClaveEntFed MEX` (`:123`), `TipoNomina` por apellido (`:113`), `ImporteExento`/`TotalExento "0.00"` (`:95,124`), RFC/CURP genéricos (`:105-106,118`), defaults `TipoPercepcion '001'` y `TipoDeduccion '004'` (`:95-96`), `TipoContrato '01'`, `TipoJornada '01'`, `TipoRegimen '02'`, `RiesgoPuesto '01'` (`:120-122`).
- `casa` (constantes de norma, **no** parámetros — corrección del escéptico): `FormaPago="99"`, `MetodoPago="PUE"`, `UsoCFDI="CN01"`, `RegimenFiscalReceptor="605"`, `Exportacion="01"`, `ClaveProdServ="84111505"`, `ClaveUnidad="ACT"`, `ObjetoImp="01"`. Son los valores que la guía de llenado del complemento exige al tipo N; el original los contaba como quemados (y a `FormaPago 99` como defecto «aunque exista depósito»), y no lo son.

**Puerta**: `POST /v1/payroll/paychecks/:id/cfdi-nomina` (`routes/payroll.ts:256-259`). Sin frontera de inquilino en el SELECT (`:51-69` `WHERE p.id = $1`).

---

### M15 · SUA (IMSS, Sistema Único de Autodeterminación) — `sua-generator.ts:34-131` — **parcial**

**Reglas implementadas**: agregación mensual por empleado MX de cuotas IMSS obrero/patronal e INFONAVIT desde `paychecks` de corridas `approved/paid` (`:59-76`); registro de ancho fijo (`:97-110`); persistencia en `tax_form_filings(form_type='sua')` (`:116-128`).

**Reglas por definir (MX)**
- **El layout no es el del SUA**: `:95-96` «Simplified SUA layout (real SUA has ~150 fixed positions per record). This captures the critical positions for integration testing». El archivo no es importable al SUA.
- **Hallazgo nuevo: excluye los periodos que cruzan el mes.** El filtro `pp.period_start >= $3 AND pp.period_end <= $4` (`:72`) deja fuera todo periodo que empiece en un mes y termine en otro (semanales, catorcenales): esas cuotas no entran al archivo del mes.
- Bimestralidad de RCV/INFONAVIT vs mensualidad de las demás ramas (LSS art. 39).
- Incidencias (incapacidades, ausentismos) y movimientos del mes; el SBC sale de `employees.sbc` estático (`:62`), no del vigente en cada periodo.
- Sólo suma totales, no desglosa por ramo (el SUA exige el desglose que `paycheck_taxes` guardaría si alguien la escribiera, ver M3).

**Parámetros**: anchos de campo inventados (`:98-109`) y `padN(e.days_worked, 2)` (`:105`) — `quemado` (deben ser el layout oficial versionado); `country_code='MX'` (`:73`) — `casa`.

**Puerta**: `POST /v1/payroll/sua` (`routes/payroll.ts:262-267`).

### M16 · IDSE (movimientos afiliatorios IMSS) — `imss-idse-adapter.ts:59-149` — **parcial**

**Reglas implementadas**: lote de ancho fijo 270 posiciones (`:118-130`) con tipos alta/baja/modificación/reingreso (`:17-23`), motivo de baja (`:25-34`), SBC en centavos con `Decimal` y rechazo de importes malformados (`:96-115`; pruebas `tests/payroll/mx/imss-idse-batch.spec.ts`); registro patronal desde `legal_entities.imss_registro_patronal` (`:64-68`); persistencia en `tax_form_filings('imss_idse')` (`:138-146`). La transmisión fue **retirada a propósito** (`:151-159`; `routes/payroll.ts:404-410` responde 501).

**Reglas por definir (MX)**: `:117` «simplified layout»; códigos 08/02/07/11 (`:18-23`) y motivos de baja por verificar contra el manual IDSE vigente; plazos legales (LSS art. 15 fr. I: 5 días hábiles; art. 34: modificaciones de salario). **Dos superficies desconectadas**: `createEmployee` (`employee-service.ts:55-109`), `updateSalary` (`:149-168`) y `terminateEmployee` (`:170-179`) no llaman a `generateIdseBatch`; el único llamador es `routes/payroll.ts:385`, con `movements` que manda el cliente.

**Parámetros**: códigos (`:18-23`) y anchos (`:119-130`) — `quemado` (layout oficial versionado); `tax_year = new Date().getUTCFullYear()` (`:141`) — `quemado` (debe ser el del movimiento).

**Puerta**: `POST /v1/payroll/imss-idse/batch` (`routes/payroll.ts:382-387`). Los SELECT de `:64-67` y `:77-79` van por `id` sin inquilino.

---

### M17 · Vigencia intra-anual de UMA y salarios mínimos — **ausente**

- `tax_parameters` tiene `UNIQUE(jurisdiction, tax_year)` (`008_payroll.sql:381`; la tabla ocupa `:375-386`) y `getTaxParameters` busca por `(jurisdiction, tax_year)` (`tax-tables.ts:74-77`): **un solo juego de UMA/SMG por año**. La UMA cambia el 1 de febrero (Ley para Determinar el Valor de la UMA, art. 5) y el salario mínimo el 1 de enero (CONASAMI; y por decreto extraordinario a mitad de año, como en 2016).
- `tax_tables` tiene `effective_from/effective_to` (`008:367-368`) y `getBrackets` **no los filtra** (`tax-tables.ts:44-49`); `effective_from`/`effective_to` no se leen en ninguna parte de `src/services/payroll`.
- Cachés de proceso sin invalidación salvo `clearCache()` (`tax-tables.ts:18-19,119-122`).
- Zona Libre de la Frontera Norte: `salario_minimo_frontera_diario` está sembrado (`009:43`) y nadie lo lee; tampoco `uma_monthly` (`009:40`) ni `uma_annual` (`009:41`) (`grep -rn` de los tres nombres → sólo la migración). El SMG que usa el código es siempre el general (`infonavit-calculator.ts:61`).
- Valores sembrados como 2026: UMA 113.14 y SMG 278.80 / 419.88 son los publicados para 2025 (DOF 10-ene-2025; DOF 4-dic-2024); la migración lo reconoce (`009:4` «best estimates», `:36` «estimated UMA»). Según el conocimiento del escéptico, los de 2026 son UMA 117.31 y SMG 315.04 / 440.87 — **por verificar contra DOF**. Confirmado que están etiquetados 2026 y no lo son.

**Reglas por definir (ambas)**: el mecanismo de vigencia (fila por fecha de entrada en vigor, no por año) sirve igual a US, donde las tablas federales cambian por año pero las estatales y locales no siempre el 1 de enero. **(MX)**: UMA 1-feb, SMG 1-ene y decretos, zona frontera.

**Parámetros**: UMA, SMG general y frontera, `uma_monthly/annual` — `ley` (sembrados en `tax_parameters` sin vigencia y con valores del año anterior).

**Puerta**: ninguna para editar tablas; sólo la migración.

---

### M18 · Orquestador bruto→neto — `paycheck-service.ts:67-402` — **parcial**

**Reglas implementadas**: bases gravables por bandera de percepción (`:119-133`), deducciones pre/post impuesto (`:112-117`), despacho a las seis calculadoras MX (`:237-281`), neto (`:316-320`), persistencia de `paychecks`, `paycheck_earnings`, `paycheck_deductions` en transacción (`:323-390`).

**Reglas por definir (MX)**
- `taxableImss = taxableIsr` (`:132`), persistido en `taxable_wages_imss` (`:330,353`), mientras el IMSS se calcula sobre `sbcCapped * days` (`imss-calculator.ts:88`): la columna miente sobre la base real.
- SBC estático y sin integración ni variables (ver M3). Días trabajados vs naturales (`:106-107`).
- Pensión alimenticia: `garnishments.garnishment_type` prevé `pension_alimenticia` sólo en comentarios de esquema (`008:296,427`); el motor de embargos sólo corre para US (`:287`). Norma: LFT art. 110 fr. V y CFDI `Deduccion 007`.
- Descuentos legales MX: FONACOT (LFT art. 110 fr. VII, CFDI `011`), cuotas sindicales (`019`), tope de descuentos (LFT art. 110): `grep` → vacío.
- `paycheck_taxes` sin escritor (ver M3).

**Reglas por definir (ambas)**
- El SELECT del empleado va por `id` sin inquilino (`:82-87` `SELECT … FROM employees WHERE id = $1`); el finiquito ya lo corrigió (`finiquito-calculator.ts:84-90`), aquí no.

**Reglas por definir (US)** — se anotan porque el orquestador es compartido
- `is_exempt_fit`/`is_exempt_fica` (`008:58-59`) no están en el SELECT (`:82-85`) ni en ningún `.ts` (`grep` → sólo la migración).
- `breakdown.local` se calcula (`:229-231`) y `local_tax_withheld` (`008:227`) **no está en el INSERT** (`:326-360`); `w2-generator.ts:93` lo suma para la casilla 19 → siempre 0.
- `is_supplemental` se persiste por percepción (`:372`) pero `baseTaxInput` (`:141-151`) no lo lleva → la tasa plana de suplementarios de `fit-calculator.ts:19-31` es **inalcanzable** desde `calculatePaycheck`.

**Parámetros**: lista `'401k','roth_401k'` como únicas pre-tax gravables para FICA (`:125`) — `casa`; mapa de frecuencias para embargos (`:289-292`) — `casa`.

**Puerta**: `POST /v1/payroll/pay-runs/:id/calculate` (`routes/payroll.ts:207-219`), sin `validateBody` y con `...req.body` directo a `calculatePayRun`.

### M19 · Calendarios de pago — `pay-period-service.ts:50-142` — **completo** (para su alcance)

- Implementado: quincenal MX 1-15 / 16-fin de mes (`:65-75`), semanal, catorcenal, semimensual, mensual (`:57-90`); `tax_year` = año del `period_end` (`:96`); `ON CONFLICT DO NOTHING` (`:135`).
- Por definir (MX): LFT art. 88 (plazo máximo semanal para trabajo material, quincenal para los demás) — `createPaySchedule` (`:20-31`) no valida país ni frecuencia y el CHECK (`008:122-123`) tampoco: un `pay_schedule` MX puede ser `monthly`. **(ambas)**: pago en día hábil (LFT art. 109) — `pay_day_offset` es aritmético (`:91`).
- Parámetros: ninguno de ley; la frecuencia es dato del `pay_schedule`.
- Puerta: `POST /pay-schedules`, `POST /pay-schedules/:id/generate-periods` (`routes/payroll.ts:165-178`), sin `validateBody`.

### M20 · Posteo al mayor — `gl-posting-service.ts:21-175` — **parcial**

- Implementado: cargo a sueldos por el bruto (`:101-106`), cargo a impuestos patronales (`:109-116`), abono a banco por el neto (`:119-124`), abonos a `isr_payable` (neto de subsidio, `:74,139`), `imss_payable` EE+ER en una cuenta (`:140`), `infonavit_payable` EE+ER (`:141`), beneficios y embargos (`:143-150`), verificación de cuadre con tolerancia 0.01 (`:152-158`); mapeo por bucket desde `payroll_account_mapping` (`:11-19`; `required` `:87`; semilla MX `payroll-account-mapping-seed.ts:120-127`: 6110, 6115, 1111, 2130, 2170, 2175, 2165, 2185).
- **Hallazgo nuevo (grave): el posteo revienta con subsidio > ISR.** `:74` agrega `SUM(isr_withheld - subsidio_empleo)` mientras el recibo retuvo `Math.max(0, isr - sub)` (`paycheck-service.ts:247`) y persistió el subsidio íntegro (`:357`). Con un solo trabajador cuyo subsidio supere al ISR en más de 0.01, el abono a `isr_payable` queda por debajo de lo retenido, débitos ≠ créditos y `:156-157` lanza «Payroll GL entry unbalanced». **Toda corrida MX con un salario bajo no se puede postear.**
- Por definir (MX): provisiones de aguinaldo, vacaciones/prima y PTU (NIF D-3); ISN por pagar (estatal, ver M21); separar pasivo IMSS obrero de patronal y RCV/INFONAVIT bimestral; el subsidio entregado en efectivo si la regla cambia (M2). **(ambas)**: aritmética en `parseFloat` (`:95-98,153-155`).
- Parámetros: tolerancia 0.01 (`:156`) — `casa`; buckets de `payroll_account_mapping` — `casa` (semilla por país).
- Puerta: `POST /pay-runs/:id/post-to-gl` (`routes/payroll.ts:230-237`).

### M21 · ISN, impuesto sobre nóminas estatal — **ausente** (en este árbol)
`grep -rniE "impuesto sobre n[oó]minas|\bisn\b" src/` → sólo `src/ai/doctor-service.ts:20` («isn't»). `git log --all -- src/services/payroll/mx/isn-calculator.ts` → sólo `675b2a9`, en `instrumentos-que-mienten-segun-la-maquina`. Norma: leyes de hacienda de las 32 entidades (tasas 1 %–4 % sobre remuneraciones, carga patronal, declaración mensual). F08a (otra rama) lo crea con `isn-calculator.ts`, migración 067 (tabla de tasas por estado y vigencia, vacía a propósito) y CLI `payroll-isn-command.ts`. Parámetro esperado: `ley` con vigencia por estado.

### M22 · Ajuste anual de ISR retenido (LISR art. 97) y constancias (art. 99 fr. III) — **ausente**
Ver M1. Los acumulados existen en `ytd-service.ts:60-138` sin consumidor anual.

### M23 · Retención a asimilados a salarios (LISR arts. 94, 96) — **ausente**
`employees.tipo_regimen_sat` existe (`008:45`, «09=Honorarios», «05=Asimilados»); `paycheck-service.ts:73,82` la lee y no vuelve a aparecer en el archivo: el ISR, el subsidio y el IMSS corren igual para `02` que para `05`/`09`. **Matiz del escéptico**: la columna sí se consulta en `cfdi-nomina-generator.ts:121` (`TipoRegimen`). «Nunca se consulta» vale para el cálculo, no para el CFDI.

### M24 · Tabla de vacaciones LFT art. 76 — `finiquito-math.ts:80-88` — **completo**
Único motor MX con prueba exhaustiva (`tests/payroll/mx/finiquito-math.spec.ts:29-95`) y con criterio de plan que vigila su regresión (`src/plan/criterios.ts:4271-4279`); único consumidor `finiquito-calculator.ts:113`. Sin libro de devengo (ver M9).

---

## 2. Parámetros quemados que deberían ser configurables por jurisdicción (consolidado)

| Parámetro | Dónde | Hoy | Debería vivir en |
|---|---|---|---|
| UMA diaria de respaldo 113.14 (valor 2025) | `imss-calculator.ts:62,110`; `infonavit-calculator.ts:31,62` | quemado | `tax_parameters` con vigencia (1-feb), sin respaldo: fallar cerrado |
| SMG diario de respaldo 278.80 (valor 2025) | `infonavit-calculator.ts:61` | quemado | `tax_parameters` con vigencia y zona (general / frontera) |
| Tope SBC = 25 UMA | `imss-calculator.ts:63,111`; `infonavit-calculator.ts:33,63` | quemado | `params.imss_tope_sbc_multiplier` (ya sembrado en `009:44`, no leído) |
| Excedente 3 UMA | `imss-calculator.ts:65,113` | quemado | `tax_parameters` |
| Tasa INFONAVIT 0.05 de respaldo | `infonavit-calculator.ts:32` | quemado | `tax_parameters` (ya está; el respaldo sobra) |
| `(x \|\| 0)` sobre toda tasa IMSS | `imss-calculator.ts:67,72-80,114,119-135` | quemado (falla abierto) | lanzar sin fila del año, como `isr-calculator.ts:30-31` |
| `days_in_period = 15` | `imss-calculator.ts:56,104`; `infonavit-calculator.ts:25,55` | casa, default muerto | derivado del periodo, sin default |
| Clase de riesgo por defecto `'01'` | `imss-calculator.ts:43` | quemado | prima de RT en `legal_entities` (registro patronal) |
| Prima de RT por clase del **puesto** | `imss-calculator.ts:36-45,131` | quemado | prima anual del **patrón**, con vigencia |
| Mes de 30 días para crédito INFONAVIT en pesos | `infonavit-calculator.ts:74` | quemado | parámetro |
| Base VSM = SMG | `infonavit-calculator.ts:61,71` | quemado | parámetro (SMG vs UMA, por fecha) |
| Frecuencia no-quincenal → tarifa mensual | `isr-calculator.ts:27` | quemado | tarifas por frecuencia en `tax_tables` (las columnas existen) |
| Factor 2 quincenal del subsidio | `isr-calculator.ts:60,77` | quemado | derivado de `periodsPerYear` |
| No entrega del subsidio en efectivo | `paycheck-service.ts:247` | quemado | parámetro con vigencia (régimen 2013 vs decretos 2024/2025) |
| `RegistroPatronal="B0000000000"` | `cfdi-nomina-generator.ts:117` | quemado | `legal_entities.imss_registro_patronal` (existe, `032:28`) |
| `RegimenFiscal="601"` | `cfdi-nomina-generator.ts:105` | quemado | columna de régimen fiscal en `legal_entities` — **no existe hoy**; hay que crearla |
| `LugarExpedicion="00000"`, `DomicilioFiscalReceptor="00000"` | `cfdi-nomina-generator.ts:104,107` | quemado | `legal_entities.postal_code` (`032:25`) y `employees.postal_code` (`008:80`), ambas existentes |
| `ClaveEntFed="MEX"` | `cfdi-nomina-generator.ts:123` | quemado | estado del centro de trabajo (también decide el ISN) |
| `PeriodicidadPago="04"` | `cfdi-nomina-generator.ts:123` | quemado | `pay_schedules.frequency` |
| `TipoNomina` por apellido materno | `cfdi-nomina-generator.ts:113` | quemado | `pay_runs.run_type` |
| `Antiguedad="P0W"` | `cfdi-nomina-generator.ts:119` | quemado | calculado desde `hire_date` |
| `Fecha T10:00:00`, `Folio` derivado | `cfdi-nomina-generator.ts:101-102` | quemado | hora real de emisión; folio de serie |
| `ImporteExento="0.00"`, `TotalExento="0.00"` | `cfdi-nomina-generator.ts:95,124` | quemado | motor art. 93 (M13) |
| RFC/CURP genéricos de respaldo | `cfdi-nomina-generator.ts:105-106,118` | quemado | rechazar, no rellenar |
| Defaults `'001'`/`'004'`, `'01'/'01'/'02'/'01'` | `cfdi-nomina-generator.ts:95-96,120-122` | quemado | datos del empleado y del concepto |
| `FormaPago 99`, `MetodoPago PUE`, `UsoCFDI CN01`, `RegimenFiscalReceptor 605`, `Exportacion 01`, `84111505`/`ACT`/`ObjetoImp 01` | `cfdi-nomina-generator.ts:99-133` | **casa** (constantes que la guía de llenado impone al tipo N) | donde están; **no son parámetros** |
| Códigos y anchos IDSE/SUA | `imss-idse-adapter.ts:18-23,119-130`; `sua-generator.ts:98-109` | quemado | layouts oficiales versionados |
| `tax_year = new Date().getUTCFullYear()` en IDSE | `imss-idse-adapter.ts:141` | quemado | año del movimiento |
| Tarifa ISR y tabla de subsidio «2026 estimadas» | `009_tax_tables_2026.sql:150-194` | ley sin vigencia | tablas con vigencia y fuente (DOF/Anexo 8); la mensual coincide con Anexo 8, la quincenal es ÷2 y no ×15/30.4, la de subsidio mezcla 2013 y 2024 |
| Cuota obrera E&M excedente 0.00625 | `009:46` | ley (dato erróneo) | 0.004 (LSS art. 106 fr. II) |
| CyV patronal 0.03150 plano | `009:64` | ley (dato incompleto) | tabla por tramo de SBC (LSS art. 168 fr. II, transitorio 2023-2030) |
| UMA/SMG etiquetados 2026 con valores 2025 | `009:36-43` | ley (dato viejo) | fila con vigencia y fuente DOF |
| `salario_minimo_frontera_diario`, `uma_monthly`, `uma_annual` sembrados y no leídos | `009:40,41,43` | ley sin lector | consumidor en los motores |
| Etiqueta `country: 'unknown'` en métricas | `pay-run-service.ts:105,126,137` | quemado | país del empleado / entidad |

---

## 3. Lo que Estados Unidos exige y no existe en este subsistema

(Alcance: `common/` es el orquestador compartido; se verificó con `grep` en todo `src/services/payroll/` que tampoco existen en `usa/`. Los detalles viven en `nomina-us.md`.)

1. **Horas extra FLSA** (29 U.S.C. §207: 1.5× sobre 40 h/semana; excepciones por estado): `grep -rniE "overtime|flsa" src/` → vacío (ver M12). Las percepciones llegan ya calculadas (`paycheck-service.ts:15-29`).
2. **Salario mínimo federal/estatal** (FLSA §206): sólo `FMW_PER_HOUR = 7.25` en `usa/garnishments/garnishment-engine.ts:36`, único uso, para embargos; no hay validación de tarifa por hora.
3. **Exención de retención W-4 y de FICA** (`is_exempt_fit`, `is_exempt_fica`, `008:58-59`): columnas no leídas por `paycheck-service.ts:82-85` ni por ningún `.ts` (ver M18).
4. **Salarios suplementarios** (IRS Pub 15 §7: 22 % / 37 %): el cálculo existe en `usa/federal/fit-calculator.ts:19-31` pero `paycheck-service.ts:141-151` nunca pasa `is_supplemental`; **motor sin puerta** desde `calculatePaycheck`.
5. **Impuestos locales persistidos**: `breakdown.local` se calcula (`paycheck-service.ts:229-231`) y `local_tax_withheld` (`008:227`) no está en el INSERT (`:326-360`); `w2-generator.ts:93` lo suma → casilla 19 siempre 0.
6. **Ingreso imputado** (IRC §79 seguro de vida en grupo > $50,000; §132): `grep -rniE "imputed|group.term" src/` → vacío.
7. **Propinas y crédito por propinas** (FLSA §203(m), Form 8027): `grep -rniE "\btips?\b"` **no es vacío** — `w2-generator.ts:23` («Wages, tips, other compensation») y `008:275` (`tips` como `earning_type`) — pero son comentarios; no hay motor (matiz del escéptico al original, que decía «vacío»).
8. **Calendario de depósitos y pasivo patronal** (IRC §6302; Pub 15): `employer_tax_liabilities` con `deposit_frequency` y `due_date` (`008:329-348`) **sin escritor** (ver M4).
9. **Desglose por impuesto en `paycheck_taxes`** (base de 941/940/W-2): tabla sin escritor (ver M3).
10. **Embargos**: `garnishments` tampoco tiene INSERT (`grep -rniE "INSERT\s+INTO\s+garnishments" src/` → vacío) y `garnishment-engine.ts:68-79` la lee. **Por vecindad**: el esquema documenta `amount_type` como `fixed, percent_disposable, percent_gross` (`008:429`) y el motor sólo casa `'fixed'` y `'percentage'` (`garnishment-engine.ts:70-71`); el ramal porcentual es inalcanzable. Pertenece a `nomina-us`.
11. **Pago final por estado** (plazos de última nómina, liquidación de PTO acumulado): `grep -rniE "final pay|\bpto\b|accru" src/services/payroll` → sólo prosa (`imss-idse-adapter.ts:154`, `finiquito-calculator.ts:16`); `terminateEmployee` (`employee-service.ts:170-179`) sólo cambia estado.
12. **Reporte de nuevas contrataciones** (42 U.S.C. §653a, 20 días): `grep -rniE "new.hire"` → vacío.

---

## 4. Lo que México exige y no existe en este subsistema

1. **PTU** (LFT arts. 117-131; LISR art. 9; art. 127 fr. II y VIII) — `grep` vacío en código (M11).
2. **Ingresos exentos LISR art. 93** (aguinaldo 30 UMA, prima vacacional y PTU 15 UMA, tiempo extra 50 % hasta 5 UMA semanales, separación 90 UMA/año, previsión social 7 UMA anuales) y su `ImporteExento` en el CFDI (M13).
3. **Liquidación** (LFT arts. 48, 50, 162, 485, 486): indemnización constitucional, 20 días por año, prima de antigüedad topada, salarios vencidos (M10).
4. **ISR sobre pagos por separación y extraordinarios** (LISR arts. 95, 96; RLISR art. 174) (M1, M7).
5. **Ajuste anual de retenciones** (LISR art. 97) y **constancias** (art. 99 fr. III) (M22).
6. **Asimilados a salarios** (LISR arts. 94, 96) (M23).
7. **ISN estatal** (32 leyes de hacienda) — existe sólo en la rama `instrumentos-que-mienten-segun-la-maquina` (F08a) (M21).
8. **Integración del SBC** (LSS art. 27) y **SBC variable bimestral** (LSS art. 30): el SBC es dato manual en `employees.sbc` (M3).
9. **Incidencias** — incapacidades, faltas, días de cotización (LSS art. 31; LFT arts. 42, 58) y su nodo `Incapacidades` en el CFDI (M3, M14).
10. **Horas extra y prima dominical** (LFT arts. 66-68, 71, 73) con su parte gravada/exenta y nodo `HorasExtra` (M12).
11. **Vigencia intra-anual de UMA (1-feb) y SMG (1-ene / decretos), y zona libre de frontera norte** — `UNIQUE(jurisdiction, tax_year)` (`008:381`) lo impide; `salario_minimo_frontera_diario` sembrado y no leído; valores 2025 etiquetados 2026 (M17).
12. **Tarifas ISR por frecuencia** (diaria, semanal, decenal, catorcenal) y **tarifa quincenal publicada** (hoy ÷2, no ×15/30.4; por verificar contra Anexo 8) (M1).
13. **Prima de riesgo de trabajo por registro patronal** (LSS arts. 72-74, RACERF; declaración anual de febrero) — hoy es clase por puesto del empleado (M4).
14. **Cesantía y vejez patronal por tramo de SBC** (LSS art. 168 fr. II reformado 2020; transitorio 2023-2030) (M4).
15. **Cuota obrera E&M excedente correcta** (0.40 %, LSS art. 106 fr. II) — la semilla trae 0.625 % (M3).
16. **Absorción patronal de la cuota obrera del salario mínimo** (LSS art. 36) (M3).
17. **Fallo cerrado en IMSS/INFONAVIT** cuando no hay fila del año en `tax_parameters` — hoy cuota 0 en silencio o valores de respaldo (M3, M4, M5).
18. **Pensión alimenticia, FONACOT, cuotas sindicales y tope de descuentos** (LFT art. 110; CFDI `007`, `011`, `019`) — el motor de embargos sólo corre para US (M18).
19. **Subsidio al empleo conforme a los Decretos DOF 01-may-2024 / 31-dic-2024** (importe único como % de UMA mensual, con vigencia; criterio de acreditar vs entregar como parámetro) y **`OtrosPagos 002 / SubsidioCausado`** en el CFDI (M2).
20. **Posteo al mayor que cuadre con subsidio > ISR** — hoy lanza «Payroll GL entry unbalanced» (M20).
21. **Corrida de aguinaldo** (LFT art. 87, antes del 20 de diciembre) y **libro de vacaciones** (devengo/disfrute/prescripción, arts. 76-81, 516) (M8, M9).
22. **Provisiones mensuales** de aguinaldo, vacaciones/prima y PTU (NIF D-3) y su asiento — y un texto de panel que no las prometa mientras no existan (M8, M20).
23. **CFDI de nómina válido ante el SAT**: nodos `Deduccion 001/010`, CP reales (las columnas existen), registro patronal real (la columna existe), régimen del emisor (**la columna no existe**), `ClaveEntFed` del centro de trabajo, `PeriodicidadPago` real, `TipoNomina` por tipo de corrida, `Antiguedad` calculada, nombre completo del receptor, sin RFC/CURP genéricos (M14).
24. **SUA e IDSE en su layout oficial** (hoy «simplified», `sua-generator.ts:95`, `imss-idse-adapter.ts:117`), **SUA que incluya periodos que cruzan el mes** (`sua-generator.ts:72`) y **movimientos afiliatorios disparados por alta/baja/cambio de salario** (`employee-service.ts` no los genera) (M15, M16).
25. **Pasivo patronal por contribución y fecha de entero** (LSS art. 39: día 17; ISR retenido: día 17, CFF art. 6) — `employer_tax_liabilities` sin escritor (M4).
26. **Frecuencias de pago conforme a LFT art. 88** (semanal para trabajo material) y pago en día hábil (art. 109) (M19).
27. **Pruebas** de ISR, subsidio, IMSS, INFONAVIT, CFDI, SUA y del orquestador: ninguna (§0).

---

## 5. Puertas

**Una sola superficie: REST.** `src/api/rest/routes/payroll.ts`, montada en `src/index.ts:238` (`app.use(\`${apiPrefix}/payroll\`, payrollRouter)`); el registro de calculadoras se importa por efecto secundario en `src/index.ts:47`.

| Motor | Puerta REST | Observación |
|---|---|---|
| M1-M6, M18 (bruto→neto) | `POST /v1/payroll/pay-runs/:id/calculate` (`routes/payroll.ts:207-219`) | sin `validateBody`; `...req.body` directo a `calculatePayRun`; SELECT del empleado sin inquilino (`paycheck-service.ts:82-87`) |
| M7 (finiquito) | `POST /v1/payroll/finiquito` (`:278-288`) | con `requireEntityAccess`; devuelve JSON y no escribe nada |
| M14 (CFDI) | `POST /v1/payroll/paychecks/:id/cfdi-nomina` (`:256-259`) | SELECT sin inquilino (`cfdi-nomina-generator.ts:51-69`) |
| M15 (SUA) | `POST /v1/payroll/sua` (`:262-267`) | — |
| M16 (IDSE) | `POST /v1/payroll/imss-idse/batch` (`:382-387`); transmisión `:404-410` → 501 | `movements` los manda el cliente; SELECT sin inquilino (`imss-idse-adapter.ts:64-67,77-79`) |
| M19 (calendarios) | `POST /pay-schedules`, `POST /pay-schedules/:id/generate-periods` (`:165-178`) | sin `validateBody` |
| M20 (mayor) | `POST /pay-runs/:id/post-to-gl` (`:230-237`) | — |
| M8, M9 | ninguna propia | entran como percepción en `calculate`, gravadas al 100 % |
| M17 | ninguna | sólo la migración edita las tablas |

- **CLI: no hay comando de nómina.** `ls src/cli/` → ningún `payroll-*`/`nomina-*`; `grep -niE "payroll|nomina" src/cli/mnemosine.ts` → vacío. `grep -rn -i -E "payroll|finiquito|generateSuaFile|generateIdseBatch|CfdiNomina|calculatePayRun|createPayRun" src/cli/` sólo encuentra menciones en descripciones de `entry`, `approvals` y `entity create` (`src/cli/entry-command.ts:391`, `src/cli/approvals-command.ts:125`, `src/cli/entity-command.ts:180,249,253`); la única mención en `src/cli/README.md:257` es el doc `nomina` que lee el agente. F08a (otra rama) añade `payroll-isn-command.ts`, sólo para ISN.
- **Agente: sin herramientas.** `src/ai/docs/payroll.md:29`: «You have no payroll tools yet … direct the human to the correct /v1/payroll/... endpoint». Ningún archivo bajo `src/ai/tools/` importa `services/payroll` (importadores: sólo `src/ai/doctor-service.ts`, `src/api/rest/routes/payroll.ts`, `src/index.ts`, `src/plan/criterios.ts`); `grep -rl payroll src/ai/tools` → sólo `docs-tools.ts`, que sirve el `.md`.
- **GraphQL: nada** (`grep -rln -i payroll src/api/graphql/` → vacío).

---

## 6. Lo que el escéptico refutó o corrigió del original

Para que el lector sepa qué **no** creerse del inventario de primera mano:

1. **Refutado — `legal_entities.tax_regime` no existe.** El original citaba `049_cobrar.sql:106` como prueba de que la columna existía y el CFDI no la leía. `049:105-106` es `ALTER TABLE customers ADD COLUMN tax_regime`; `legal_entities` (`001_core_schema.sql`, `032:20-28`) no tiene régimen fiscal. El 601 clavado sigue siendo defecto, pero la corrección es crear la columna, no sólo leerla.
2. **Refutado — `FormaPago 99`, `MetodoPago PUE`, `UsoCFDI CN01`, `RegimenFiscalReceptor 605`, `Exportacion 01`, `ClaveProdServ 84111505`, `ClaveUnidad ACT`, `ObjetoImp 01` no son parámetros quemados.** Son los valores que la guía de llenado del complemento exige al tipo N: constantes de norma (`casa`). El original los contaba entre los quemados de `:101-123` y a `FormaPago 99` como defecto «aunque exista depósito».
3. **Matizado — `days_in_period = 15` es un default muerto.** El original lo listaba como parámetro quemado en M3-M6 (`imss-calculator.ts:56,104`; `infonavit-calculator.ts:25,55`); el único llamador (`paycheck-service.ts:146`) siempre lo sobreescribe. No debería existir, pero hoy no altera ninguna cuota.
4. **Matizado — la tarifa ISR mensual sembrada es la vigente.** El original la trataba como «estimada»; coincide con el Anexo 8 vigente desde 2024. Lo ausente es el mecanismo de vigencia; la etiqueta «estimado» de `009:147` miente al revés. (La quincenal, en cambio, sí es derivada: ÷2 en vez de ×15/30.4.)
5. **Corregido — el `grep effective_` en payroll no es vacío.** Hay `effective_date` en `nacha-generator.ts`, `benefits-service.ts`, `imss-idse-adapter.ts`, `employee-service.ts`. Lo cierto es que `effective_from`/`effective_to` no se leen en ninguna parte de `src/services/payroll`. Y el `UNIQUE(jurisdiction, tax_year)` está en `008:381`, no en la línea que el original daba.
6. **Matizado — `tipo_regimen_sat` sí se consulta en el CFDI** (`cfdi-nomina-generator.ts:121`, `TipoRegimen`). «Nunca se consulta» vale para el cálculo (ISR, subsidio, IMSS), no para el comprobante.
7. **Matizado — el `grep` de propinas no es vacío**: dos comentarios (`w2-generator.ts:23`, `008:275`). No hay motor; matiz de redacción, no de fondo.

**Hallazgos que el original no traía y el escéptico añadió** (ya incorporados arriba): IMSS/INFONAVIT = 0 en silencio sin fila del año (M3-M5); posteo al mayor que revienta con subsidio > ISR (M20); tarifa quincenal ÷2 (M1); columna de régimen fiscal inexistente (M14); SUA que excluye periodos que cruzan el mes (M15); panel que promete una provisión inexistente y niega una lectura que sí ocurre (M8); `garnishments.amount_type` con ramal inalcanzable (§3, por vecindad); y `postal_code` disponible en `legal_entities` y `employees` sin que el CFDI lo consulte (M14).
