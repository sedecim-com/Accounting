# NIF — Marco conceptual (NIF A-1, 2023)

Las Normas de Información Financiera (NIF) las emite el CINIF y son el marco
contable mexicano. Esta guía es tu referencia para **validar registros, explicar
por qué un asiento se hace de cierta forma, y citar la norma** cuando el usuario
pregunte.

> **Cómo citar (importante):** desde el 1-ene-2023 toda la Serie A se consolidó
> en una sola **NIF A-1 "Marco Conceptual"** organizada por capítulos; las
> antiguas A-2…A-8 sobreviven como capítulos con el contenido casi intacto.
> La cita correcta hoy es "NIF A-1, cap. 20" — añade la clave antigua entre
> paréntesis porque los contadores aún dicen "NIF A-2": p. ej. *"NIF A-1
> cap. 20 (antes A-2), devengación contable"*. Para las series B/C/D las claves
> siguen vigentes tal cual (NIF B-1, C-4, D-1…).

> Alcance: resumen operativo para el registro diario. Para casos límite
> (combinaciones de negocios, instrumentos derivados, consolidación) indica al
> usuario que consulte a su contador con la NIF específica en mano; no improvises.

## Estructura (cap. 10) y jerarquía

Series: **A** (marco conceptual, hoy una sola NIF A-1), **B** (estados
financieros en su conjunto), **C** (activos, pasivos y capital), **D**
(resultados: ingresos, costos, impuestos, beneficios a empleados), **E**
(actividades especializadas). Jerarquía: NIF particulares > Interpretaciones
(INIF/ONIF) > orientaciones. **Supletoriedad (cap. 90):** donde las NIF callan
aplican las NIIF (IFRS), documentando la elección — el corpus NIIF completo
vive en `niif-indice` (todas las normas vigentes, su estado y su doc de
detalle).

## Postulados básicos (cap. 20, antes A-2)

Los 8 postulados son el fundamento de TODO registro. Son tu primera línea de
validación:

1. **Sustancia económica** — El registro refleja la esencia económica de la
   operación, no su forma legal. *Ejemplo operativo: un "anticipo" que en
   realidad liquida una factura ya devengada se registra como pago, no como
   anticipo — sin importar cómo lo titule el documento.*

2. **Entidad económica** — La contabilidad es de la entidad, no de sus dueños.
   *Validación: gastos personales del socio NO son gastos de la empresa; si
   aparecen, van a cuenta por cobrar al socio o a no deducibles.*

3. **Negocio en marcha** — Se asume que la entidad continuará operando; los
   valores no son de liquidación.

4. **Devengación contable** — Los efectos de las transacciones se reconocen
   **cuando ocurren**, no cuando se cobran o pagan. *Este es el postulado que
   más registros determina: la factura de diciembre es gasto de diciembre
   aunque se pague en enero; la venta se reconoce al entregar, no al cobrar
   ni al facturar. (El momento FISCAL del IVA es otra cosa: ver PUE/PPD en
   mexico-cfdi.)*

5. **Asociación de costos y gastos con ingresos** — Los costos se reconocen en
   el mismo periodo que los ingresos que generan. *Es la razón de ser de los
   inventarios (el costo espera a la venta) y de los pagos anticipados (el
   seguro anual se devenga mes a mes).*

6. **Valuación** — Toda transacción se cuantifica en términos monetarios con
   el valor más objetivo disponible (costo histórico al reconocer inicialmente).

7. **Dualidad económica** — Todo evento afecta al menos dos elementos: recursos
   (activos) y fuentes (pasivos + capital). *Es la partida doble: cargos =
   abonos, SIEMPRE y exactamente. El sistema lo valida en cada póliza.*

8. **Consistencia** — Ante operaciones iguales, mismo tratamiento contable en
   el tiempo. *Es la razón de los PRECEDENTES: si el despacho clasificó un
   gasto de cierta forma, la misma operación se clasifica igual — cambiar de
   criterio exige justificación y revelación (y NIF B-1 si es un cambio formal
   de política).*

## Elementos básicos (cap. 50, antes A-5)

Definiciones que determinan a qué tipo de cuenta va cada cosa:

- **Activo**: recurso económico presente controlado por la entidad, resultado
  de eventos pasados, con **potencial** de producir beneficios económicos (la
  NIF A-1 2023 convergió aquí con el Marco IASB: ya no se exige que los
  beneficios sean "fundadamente esperados"). *Por eso un anticipo a proveedor
  es activo (derecho a recibir), y un pago anticipado también.*
- **Pasivo**: obligación presente, virtualmente ineludible, de transferir
  recursos, proveniente de eventos pasados. *Por eso un anticipo DE cliente es
  pasivo: existe la obligación de entregar el bien/servicio.*
- **Capital contable**: el valor residual de los activos menos los pasivos.
  Sus movimientos derivan de actos formales (aportaciones, dividendos,
  acuerdos de asamblea) — ver NIF C-11.
- **Ingreso**: incremento de activos o disminución de pasivos que aumenta el
  capital, distinto de las aportaciones de dueños. *Cobrar una cuenta por
  cobrar NO es ingreso (ya se reconoció al facturar la entrega): es intercambio
  de activos.*
- **Costo y gasto**: disminución de activos o aumento de pasivos que reduce el
  capital, distinto de distribuciones a dueños. *Pagar una cuenta por pagar NO
  es gasto: el gasto se reconoció al devengar.*

## Reconocimiento y valuación (caps. 60-70, antes A-6)

Reconocimiento inicial al **costo histórico** (contraprestación pactada) cuando
la partida cumple la definición del cap. 50. Reconocimiento posterior según la
norma particular de cada rubro (depreciación, deterioro, valuación).

## Presentación y revelación (cap. 80, antes A-7)

Todo lo relevante se revela. Para el registro diario implica: **descripciones
de póliza que expliquen la operación** (quién, qué, por qué), referencias a
documentos (UUID del CFDI, número de contrato), y notas cuando el tratamiento
no sea obvio.

## Cómo usar esta referencia

- Al **validar**: los mensajes del motor citan la NIF que fundamenta cada regla.
  Si el usuario pregunta por qué, lee aquí la explicación completa.
- Al **explicar un asiento**: cita el postulado o la norma ("se registra como
  pasivo por NIF D-1: el ingreso se reconoce al transferir el control").
- Al **dudar entre dos tratamientos**: los postulados deciden — sustancia
  económica y devengación resuelven la mayoría de las ambigüedades.
- Registro concreto por tipo de operación → `nif-registro`.
- Qué valida el sistema automáticamente y qué norma respalda cada regla →
  `nif-validaciones`.

> Nota de vigencia (verificada ago-2026): en dic-2025 el CINIF promulgó nuevas
> NIF B-1 "Bases para la preparación de los estados financieros" y B-3
> (convergencia con NIIF 18), vigentes desde el 1-ene-2028 con adopción
> anticipada 2027. Hasta entonces rigen la B-1 (cambios contables y
> correcciones) y la B-3 actuales, que son las descritas en estos documentos.
