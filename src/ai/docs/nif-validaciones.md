# NIF — Qué valida este sistema y qué norma respalda cada regla

Mapa entre las validaciones automáticas del motor contable y la NIF que las
fundamenta. Úsalo para explicar al usuario POR QUÉ el sistema rechazó o advirtió
algo, y para saber qué NO se valida solo (y por tanto exige tu criterio).

> Los postulados básicos (devengación, dualidad económica, asociación de
> costos con ingresos) son desde 2023 el capítulo 20 de la NIF A-1
> consolidada, y así los cita el motor: "[NIF A-1, cap. 20, …]" (MNE-001-077).
> **No los cites como "NIF A-2"**: desde el 1-ene-2026 esa clave es otra norma
> vigente, *Incertidumbres sobre negocio en marcha*, y citarla por un
> postulado manda al contador a leer la norma equivocada. Algunos mensajes
> aún usan claves antiguas de otros capítulos ("NIF A-4", "NIF A-5"); el
> mapeo a capítulos de la NIF A-1 está en `nif-marco`.

## Validaciones que BLOQUEAN (errores)

| Regla del motor | Qué verifica | Fundamento |
|---|---|---|
| `balance` | Cargos = abonos, igualdad EXACTA (sin tolerancia) | NIF A-1, cap. 20, dualidad económica. El CHECK de la BD también lo exige al postear |
| `lineAmount` | Cada línea tiene exactamente uno de cargo/abono, y positivo | Partida doble bien formada |
| `periodStatus` | No se postea a periodos hard_close/locked | NIF A-1, cap. 20, devengación + control interno de cierre |
| `accountPermission` | La cuenta existe, está activa, no es de agrupación, acepta pólizas manuales | Integridad del catálogo |
| `currency` | Moneda extranjera exige tipo de cambio y montos en ambas monedas, conversión aritméticamente correcta | NIF B-15: reconocimiento al tipo de cambio histórico de la fecha de transacción |

## Validaciones que ADVIERTEN (no bloquean — tu criterio decide)

| Regla | Qué detecta | Fundamento |
|---|---|---|
| `accountType` | Cargo/abono contra-natural (p. ej. gasto abonado) | NIF A-5. Un movimiento contra-natural suele ser cuenta equivocada o una corrección — y las correcciones van por REVERSA, no editando (NIF B-1) |
| `nifSubstance` | Ingreso abonado en póliza que menciona "anticipo" | NIF D-1: el anticipo de cliente es PASIVO hasta transferir el control; reconocerlo como ingreso adelanta utilidades |
| `nifSubstance` | Cualquier línea a una cuenta de capital contable (la regla no distingue la póliza manual de la automática) | NIF C-11: los movimientos de capital derivan de actos formales — verifica que exista el acta o acuerdo |
| `periodStatus` | Posteo a periodo futuro o en soft_close | NIF A-1, cap. 20, devengación |

## Validaciones de la capa de IA (antes de crear el borrador)

- Estructura y balance exacto del borrador; cuentas existentes y posteables;
  periodo fiscal abierto para la fecha (todo en `validateDraftPayload`).
- Clasificación CFDI (taxonomía): PUE vs PPD decide el momento del IVA (LIVA,
  y devengación NIF A-1, cap. 20 para el gasto); tipo P jamás genera gasto ni ingreso;
  TipoRelacion 07 = aplicación de anticipo, no devolución; el asiento propuesto
  debe cuadrar exactamente contra el total del CFDI.
- Al aprobar, TODO vuelve a pasar por el motor (`createJournalEntry` con
  autoPost): la capa de IA nunca esquiva las validaciones del motor.

## Lo que el sistema NO valida solo (exige criterio humano)

| Decisión | Por qué no se automatiza | Norma de referencia |
|---|---|---|
| Gasto vs activo fijo | El umbral de capitalización es política de la empresa | NIF C-6 define QUÉ es PPyE; el umbral práctico no lo fija ninguna norma |
| El periodo de cobertura de un gasto plurianual | Lo dice una persona al registrar el calendario con `prepaid create`. Desde ahí la amortización de cada mes ya no es criterio: la postea el motor (`prepaid run`, o `closing run`) | NIF A-1, cap. 20, asociación de costos con ingresos; NIF C-5 |
| Inventario vs costo directo | Depende del sistema de inventarios de la entidad | NIF C-4 |
| Estimación de cuentas incobrables | Juicio sobre pérdidas crediticias esperadas | NIF C-3 |
| Provisiones de garantías, litigios y otras de monto o fecha inciertos | Estimación de monto y probabilidad; no hay motor | NIF C-9 |
| Reconocer un ingreso por avance de obra | Medición del grado de cumplimiento | NIF D-1/D-2 |

Cuando el usuario te pida uno de estos registros, hazlo como borrador con tu
mejor propuesta, cita la norma aplicable, y deja explícito qué parte es
estimación o política que él debe confirmar.

Dos provisiones NO están en esa lista, porque tienen motor. **Aguinaldo,
vacaciones y prima vacacional** se devengan cada mes (`payroll accrue`, o
`closing run`). La **PTU** del ejercicio tiene motor al cierre (`ptu close`):
parte de tres cifras que captura el contador, deja un borrador y hoy se niega
porque falta el porcentaje en `legal_parameters`. Qué hace cada motor, y qué
normas no tienen ninguno, está en la tabla «Lo que este sistema devenga, y lo
que declara no devengar» de `nif-registro`: léela antes de decirle al usuario
que el sistema calcula algo.

## Correcciones de errores (NIF B-1) — regla de oro del sistema

Un asiento posteado **no se edita jamás**. Si está mal:
1. Se genera la **reversa**: el sistema crea el asiento espejo posteado,
   enlazado en ambas direcciones (`reverses_entry_id` /
   `reversed_by_entry_id`). El original **permanece posteado** — anulado se
   expresa por el enlace, no mutando su estado (así saldos, balanza y vistas
   siempre cuadran).
2. Se registra el asiento correcto.
3. El error y su corrección quedan visibles en el historial — eso es
   exactamente lo que NIF B-1 exige: las correcciones se revelan, no se ocultan.

Candados del motor: solo se reversa un asiento POSTEADO (un borrador nunca
tocó saldos — se rechaza o anula, no se reversa) y solo UNA vez (una segunda
reversa volvería a golpear los saldos). El estado `void` queda reservado para
borradores cancelados antes de postear.

Si el error es de un ejercicio YA CERRADO, no se reversa en el periodo
cerrado: póliza de ajuste en el periodo actual contra utilidades acumuladas
(ver B-1 en `nif-registro`).

Si un usuario pide "cámbiale el monto a la póliza", explícale esto y ofrécele
el flujo reversa + registro correcto.
