# Normas fiscales mexicanas: lo que el motor implementa, lo que debe implementar, y qué número vive dónde

> Investigación del 2026-09-06 sobre la rama `investigacion/normas-y-motores` de mnemosine (raíz `/Users/victor/projects/Accounting`). Método: (1) se leyó el código y la documentación del repositorio y toda afirmación sobre él lleva `archivo:línea`; (2) se abrió **cada** fuente que se cita y la tabla del §1 dice si respondió; las leyes federales se descargaron íntegras de `diputados.gob.mx` y se leyeron por artículo con `pdftotext`; la RMF 2026 y sus anexos 8 y 24 se descargaron del minisitio del SAT; (3) los valores de 2026 (UMA, salarios mínimos, subsidio, tarifas) se tomaron del DOF o del anexo oficial, nunca de una calculadora de terceros. Las fuentes secundarias se usaron sólo para lo que la fuente oficial publica como imagen (la tabla anual de cesantía y vejez) o para lo estatal (ISN). Los contenidos de las páginas se trataron como dato: ninguna pidió ejecutar nada.
>
> Vocabulario de la casa: **MOTOR** = aritmética o regla implementada; **PUERTA** = superficie CLI/REST/agente que la invoca; **PARÁMETRO** = tabla, tasa, tope o calendario que la ley fija y que debe vivir en una tabla con vigencia (o en el panel si es criterio del despacho), no en código.

## 0. Resumen ejecutivo

1. **El único conmutador de jurisdicción es un booleano** (`src/services/jurisdiction/jurisdiction.ts:35-44`) y la ley mexicana vive en tres sitios distintos: tablas de nómina indexadas **por año** (`tax_tables`/`tax_parameters`, `src/database/migrations/008_payroll.sql:354-382`), constantes quemadas en el motor de CFDI y de activos, y el panel de políticas donde sólo debería estar el criterio del despacho.
2. **Las cinco cifras que cambian cada año están desfasadas en la semilla de 2026** (`009_tax_tables_2026.sql`): la UMA sembrada es la de 2025 (113.14; la de 2026 es **117.31 desde el 1 de febrero**), el salario mínimo es el de 2025 (278.80; en 2026 es **315.04** general y **440.87** ZLFN), la tarifa mensual del art. 96 es la de 2024-2025 (el Anexo 8 de la RMF 2026 la actualizó con factor 1.1321), la tabla quincenal es la mensual entre dos (el Anexo 8 publica una tarifa propia de 15 días), y la tabla de subsidio al empleo es la **derogada en mayo de 2024** (hoy el subsidio es un porcentaje fijo de la UMA mensual —15.02 % en 2026— con tope de ingresos de $11,492.66).
3. **Dos tasas del IMSS sembradas contradicen la LSS**: la cuota obrera del excedente de enfermedades y maternidad está en 0.625 % y la ley la fija en **0.40 %** (LSS 106-II con el transitorio XIX de 1997); la cuota patronal de cesantía y vejez está en 3.150 % —la de 2022— y desde 2023 es una **tabla por tramo de SBC** que en 2026 va de 3.150 % a 7.513 % (LSS 168-II-a y transitorio Segundo del decreto DOF 16-12-2020).
4. **Una regla del plan está al revés de la ley**: `plan-cierre-brechas.md:6580-6606` (E4.1-i) propone entregar en efectivo el subsidio que exceda al ISR; el decreto del DOF 01-05-2024 dice que en ese caso «ni se entregará cantidad alguna». El `Math.max(0, …)` de `paycheck-service.ts:247` es hoy, por accidente, el comportamiento correcto; el comentario de la línea 246 y el plan no.
5. **Lo que no existe en absoluto** (verificado por grep, no por memoria): exenciones del art. 93 (el CFDI de nómina timbra `TotalExento="0.00"`, `cfdi-nomina-generator.ts:124`), PTU, prima de antigüedad e indemnización en el finiquito, retenciones al registrar (10 % ISR honorarios/arrendamiento, 2/3 del IVA), pagos provisionales de ISR e IVA mensual, XML del Anexo 24, DIOT, calendario de obligaciones, conservación CFF 30, tope de deducción de automóviles (36-II), RESICO 113-E, ISN estatal, jornada de 40 horas (LFT 59 reformado el 01-05-2026, gradual 2026-2030).
6. **Lo que sí está y está bien**: el IVA en base de flujo con el REP como liberador (LIVA 1-B y 5-III; `iva-cash-basis.ts`, `rep-linkage.ts`), la tabla de vacaciones del art. 76 y el prorrateo del aguinaldo del art. 87 (`finiquito-math.ts:80-88, 257-268`), el tope de 25 UMA y la cuota fija de EM (`imss-calculator.ts:63, 119`), el 5 % de INFONAVIT (`infonavit-calculator.ts:32`), las tasas de depreciación del art. 34 (`asset-service.ts:100-153`, quemadas pero correctas), el límite de $2,000 en efectivo y el 8.5 % de restaurantes (`cfdi-decisions.ts:94, 96`, quemados y correctos), la consulta de estatus de CFDI ante el SAT (`cfdi-status.ts`).

## 1. Fuentes

`verificada = true` sólo si la URL se abrió en esta sesión y respondió con contenido. Cuando una página oficial no respondió se dice, y se indica la ruta alterna que sí lo hizo.

| # | Título | URL | Emisor | Qué cubre | Aplica a | Verificada |
|---|---|---|---|---|---|---|
| 1 | Ley del Impuesto sobre la Renta (texto vigente, última reforma DOF 01-04-2024, 313 pp.) | https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf | Cámara de Diputados | Arts. 9, 14, 27, 28, 31-36, 76, 93, 96, 97, 99, 106, 113-E, 116, 150, 152, 206 | MX | true (descargado y leído por artículo) |
| 2 | LISR: ficha de reformas | https://www.diputados.gob.mx/LeyesBiblio/ref/lisr.htm | Cámara de Diputados | Fecha de última reforma y decretos | MX | true |
| 3 | Ley del Impuesto al Valor Agregado (última reforma DOF 12-11-2021 según la ficha, 128 pp.) | https://www.diputados.gob.mx/LeyesBiblio/pdf/LIVA.pdf | Cámara de Diputados | Arts. 1, 1-A, 1-B, 2-A, 5, 5-D, 32 | MX | true |
| 4 | LIVA: ficha de reformas | https://www.diputados.gob.mx/LeyesBiblio/ref/liva.htm | Cámara de Diputados | Fecha de última reforma | MX | true |
| 5 | Reglamento de la LIVA (última reforma DOF 25-09-2014) | https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_LIVA_250914.pdf | Cámara de Diputados | Art. 3: retención de dos terceras partes y 4 % | MX | true (la ruta `regley/Reg_LIVA.pdf` da 404; la buena está en `regla.htm`) |
| 6 | Índice de reglamentos | https://www.diputados.gob.mx/LeyesBiblio/regla.htm | Cámara de Diputados | Rutas del RLIVA, RLISR (`Reg_LISR_060516.pdf`), RCFF (`Reg_CFF.pdf`) | MX | true |
| 7 | Código Fiscal de la Federación (última reforma DOF 09-04-2026, 377 pp.) | https://www.diputados.gob.mx/LeyesBiblio/pdf/CFF.pdf | Cámara de Diputados | Arts. 11, 12, 17-H, 17-H Bis, 20, 28, 29, 29-A, 30, 69-B | MX | true |
| 8 | CFF: ficha de reformas | https://www.diputados.gob.mx/LeyesBiblio/ref/cff.htm | Cámara de Diputados | Fecha de última reforma | MX | true |
| 9 | Ley Federal del Trabajo (última reforma DOF 14-05-2026, 457 pp.) | https://www.diputados.gob.mx/LeyesBiblio/pdf/LFT.pdf | Cámara de Diputados | Arts. 48, 50, 59, 61, 76-81, 87, 117-127, 162; transitorios del decreto de 40 horas | MX | true |
| 10 | LFT: ficha de reformas | https://www.diputados.gob.mx/LeyesBiblio/ref/lft.htm | Cámara de Diputados | Decretos 2024-2026 (plataformas, jornada) | MX | true |
| 11 | Ley del Seguro Social (última reforma DOF 15-01-2026, 181 pp.) | https://www.diputados.gob.mx/LeyesBiblio/pdf/LSS.pdf | Cámara de Diputados | Arts. 15, 25, 27, 28, 39, 71-74, 106, 107, 147, 168, 211; transitorios 1997 y 2020 | MX | true |
| 12 | LSS: ficha de reformas | https://www.diputados.gob.mx/LeyesBiblio/ref/lss.htm | Cámara de Diputados | Fecha de última reforma | MX | true |
| 13 | Ley del INFONAVIT (última reforma DOF 21-02-2025, 93 pp.) | https://www.diputados.gob.mx/LeyesBiblio/pdf/LIFNVT.pdf | Cámara de Diputados | Arts. 29-II (5 %) y 35 (pago) | MX | true (la ficha `ref/linfonavit.htm` da 404; la buena es `ref/lifnvt.htm`, no abierta) |
| 14 | Índice de leyes federales | https://www.diputados.gob.mx/LeyesBiblio/index.htm | Cámara de Diputados | Rutas y fechas de LISR, LSS, LIFNVT | MX | true |
| 15 | Resolución Miscelánea Fiscal para 2026 (DOF 28-12-2025, 4.5 MB) | https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/rmf/RMF_2026-DOF-28122025.pdf | SAT | Reglas 2.7.1.8, 2.7.1.32, 2.7.1.34, 2.7.1.35, 2.7.5.1, 2.8.1.5, 2.8.1.6, 3.13.x, 4.5.1 | MX | true (descargada; extraída con pdftotext) |
| 16 | Anexo 8 RMF 2026: tarifas ISR (DOF 28-12-2025) | https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/anexos/Anexo-8-RMF-2026_DOF-28122025.pdf | SAT | Tarifas 2026 diaria, 7, 10 y 15 días y mensual del art. 96 | MX | true |
| 17 | Anexo 24 RMF 2026: contabilidad en medios electrónicos (DOF 13-01-2026) | https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/anexos/Anexo_24_RMF2026-13012026.pdf | SAT | Catálogo, código agrupador, balanza, pólizas, auxiliares, catálogos de monedas/bancos/métodos de pago | MX | true |
| 18 | XSD BalanzaComprobacion 1.3 | https://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_3.xsd | SAT | Esquema de la balanza: atributos y tipos | MX | true |
| 19 | UMA 2026 (INEGI, DOF 09-01-2026) | https://dof.gob.mx/nota_detalle.php?codigo=5778072&fecha=09/01/2026 | INEGI / DOF | 117.31 diario, 3,566.22 mensual, 42,794.64 anual; vigente 01-02-2026 | MX | true |
| 20 | INEGI: página de la UMA | https://www.inegi.org.mx/temas/uma/ | INEGI | Debería listar los valores; respondió sin contenido extraíble | MX | true (respondió, sin datos) |
| 21 | Salarios mínimos 2026 (DOF 09-12-2025) | https://dof.gob.mx/nota_detalle.php?codigo=5775534&fecha=09/12/2025 | CONASAMI / DOF | 315.04 general (6.5 % + MIR 17.01 = 13 %), 440.87 ZLFN (5 %); vigente 01-01-2026 | MX | true (`www.dof.gob.mx` falla por certificado; `dof.gob.mx` responde) |
| 22 | CONASAMI: incremento a los salarios mínimos para 2026 | https://www.gob.mx/conasami/articulos/incremento-a-los-salarios-minimos-para-2026?idiom=es | CONASAMI | Mismos importes y composición | MX | true |
| 23 | Decreto que modifica el subsidio para el empleo (DOF 31-12-2025) | https://dof.gob.mx/nota_detalle.php?codigo=5777649&fecha=31/12/2025 | SHCP / DOF | Tope $11,492.66; 15.02 % de la UMA mensual (15.59 % en enero 2026); prorrateo /30.4; exclusiones; vigor 01-01-2026 | MX | true |
| 24 | Decreto que modifica el subsidio para el empleo (DOF 01-05-2024) | https://dof.gob.mx/nota_detalle.php?codigo=5725287&fecha=01/05/2024 | SHCP / DOF | Subsidio como % de UMA; **el excedente sobre el ISR no se entrega**; prorrateo /30.4 | MX | true |
| 25 | Decreto que prorroga los estímulos de región fronteriza norte y sur (DOF 30/31-12-2025) | https://sidof.segob.gob.mx/notas/docFuente/5777697 | SEGOB (copia SIDOF) | Vigencia hasta 31-12-2026 del IVA al 8 % (crédito del 50 %) y crédito de ISR | MX (franja fronteriza) | true |
| 26 | Decreto que compila beneficios fiscales, art. 5.1 (DOF 26-12-2013) | https://dof.gob.mx/nota_detalle.php?codigo=5328028&fecha=26/12/2013&print=true | SHCP / DOF | Días hábiles adicionales al 17 según sexto dígito del RFC; exclusiones | MX | true |
| 27 | SAT: presenta tu DIOT | https://wwwmat.sat.gob.mx/declaracion/74295/presenta-tu-declaracion-informativa-de-operaciones-con-terceros-(diot)- | SAT | Obligados, plazo, plataforma `pstcdi.clouda.sat.gob.mx`, campos por proveedor | MX | true |
| 28 | SAT: envía tu contabilidad electrónica | https://wwwmat.sat.gob.mx/aplicacion/42150/envia-tu-contabilidad-electronica | SAT | Archivos, niveles, ZIP, fundamento CFF 28-III/IV | MX | true (`www.sat.gob.mx/aplicacion/42150/…` respondió 403) |
| 29 | SAT (gob.mx): preguntas frecuentes de contabilidad electrónica | https://www.gob.mx/sat/acciones-y-programas/contabilidad_electronica_preguntas_buzon | SAT | Obligados, archivos, balanza anual; cita reglas de 2015 | MX | true (contenido desactualizado) |
| 30 | SAT: formato de factura electrónica (Anexo 20) | https://wwwmat.sat.gob.mx/consultas/35025/formato-de-factura-electronica-(anexo-20) | SAT | Única versión válida 4.0 desde 01-04-2023 | MX | true (`www.sat.gob.mx/consultas/35025/…` respondió 504) |
| 31 | SAT: comprobante de recepción de pagos | https://wwwmatnp.sat.gob.mx/consultas/92764/comprobante-de-recepcion-de-pagos | SAT | Complemento 2.0 obligatorio desde 01-04-2023 | MX | true |
| 32 | SAT: comprobante de nómina | https://wwwmat.sat.gob.mx/consultas/97722/comprobante-de-nomina | SAT | Nómina 1.2 revisión C sobre CFDI 4.0; plazos de la regla 2.7.5.1 | MX | true |
| 33 | SAT: complemento Carta Porte | https://wwwmat.sat.gob.mx/consultas/68823/complemento-carta-porte- | SAT | Versión 3.1 obligatoria desde 17-07-2024 | MX | true (`www.sat.gob.mx/consultas/68823/…` respondió 504) |
| 34 | SAT (omawww): Anexo 20 | http://omawww.sat.gob.mx/tramitesyservicios/Paginas/anexo_20_version3-3.htm | SAT | Estándar, XSD, catálogos c_* | MX | **false** (ECONNREFUSED desde esta sesión) |
| 35 | SAT (omawww): complemento de pagos | http://omawww.sat.gob.mx/tramitesyservicios/Paginas/complemento_pagos.htm | SAT | Estándar y guía del REP 2.0 | MX | **false** (ECONNREFUSED) |
| 36 | SAT (omawww): complemento de nómina | http://omawww.sat.gob.mx/tramitesyservicios/Paginas/complemento_nomina.htm | SAT | Estándar, catálogos de nómina 1.2 | MX | **false** (ECONNREFUSED) |
| 37 | SAT (omawww): Carta Porte | http://omawww.sat.gob.mx/cartaporte/Paginas/default.htm | SAT | Estándar e instructivos | MX | **false** (ECONNREFUSED) |
| 38 | SAT: calendario para empresas | https://www.sat.gob.mx/empresas/calendario | SAT | Calendario de obligaciones | MX | **false** (respondió vacío) |
| 39 | SAT: cambios en las guías de llenado | https://www.sat.gob.mx/noticias/70404/conoce-los-cambios-en-las-guias-de-llenado | SAT | Fechas de revisión de guías | MX | **false** (504) |
| 40 | STPS: todo lo que necesitas saber del reparto de utilidades | https://www.gob.mx/stps/articulos/todo-lo-que-necesitas-saber-del-reparto-de-utilidades | STPS | PTU 10 %; PM a más tardar 30 de mayo, PF 29 de junio; excluidos | MX | true |
| 41 | Resolución de la Comisión Nacional de PTU (DOF 18-09-2020) | (no localizada en dof.gob.mx en esta sesión) | Comisión Nacional PTU / DOF | Fija el 10 % de la renta gravable | MX | **false** (no abierta; el 10 % se sostiene con la fuente 40) |
| 42 | Decreto de desindexación del salario mínimo (DOF 27-01-2016) | https://dof.gob.mx/nota_detalle.php?codigo=5423663&fecha=27/01/2016 | DOF | Las referencias a «salario mínimo» como unidad se leen como UMA | MX | **false** (apareció en la búsqueda, no se abrió) |
| 43 | IDC: actualización del subsidio al empleo para 2026 | https://idconline.mx/fiscal-contable/2026/01/02/actualizacion-del-subsidio-al-empleo-para-2026 | IDC (secundaria) | Confirma porcentajes y prorrateo del decreto | MX | true |
| 44 | Manuel Nevárez y Asociados: tabla CEAV patronal 2026 | https://www.manuelnevarez.com.mx/es/journal/tabla-para-el-calculo-de-las-cuotas-patronales-de-cesantia-en-edad-avanzada-y-vejez-aplicable-en-2026/ | Despacho (secundaria) | Renglones 2026 de la tabla gradual (la LSS la publica como imagen) | MX | true |
| 45 | El Contribuyente: impuesto sobre nóminas por estado | https://www.elcontribuyente.mx/impuesto-sobre-nominas/ | Medio (secundaria) | ISN 2026: CDMX 4 %, rango 2.4-5 % | MX (estatal) | true |

## 2. Reglas concretas para el motor, por ley

Cada regla lleva: qué dice la fuente, qué clase es (MOTOR/PUERTA/PARÁMETRO), y qué tiene hoy el repo con `archivo:línea`.

### 2.1 LISR: deducciones (arts. 27, 28, 36)

| Regla | Fuente | Clase | Estado en el repo |
|---|---|---|---|
| Pagos cuyo monto exceda de **$2,000.00** deben hacerse por transferencia, cheque nominativo, tarjeta o monedero; para **combustibles** aplica aunque no excedan | LISR 27-III (lisr.txt, art. 27 fr. III) | PARÁMETRO (`lisr.efectivo_max` = 2000; la regla de combustibles es MOTOR) | Quemado: `CASH_DEDUCTION_LIMIT_MXN = 2_000` en `src/services/xml-ingestion/cfdi-decisions.ts:94`. La excepción de combustibles no se modela (hay `COMBUSTIBLE_PREFIXES` en `:103` sólo para clasificar). |
| Consumos en restaurantes: **91.5 % no deducible** (8.5 % deducible) y sólo si se paga con tarjeta o monedero; bares nunca | LISR 28-XX | PARÁMETRO (`lisr.restaurantes_deducible` = 0.085) + criterio del despacho (cómo asentarlo) | Tasa quemada `RESTAURANT_DEDUCTIBLE_RATE = 0.085` en `cfdi-decisions.ts:96`; el criterio sí está en el panel: `politica_restaurantes` (`src/services/policy/pending-catalog.ts:208-227`). El requisito de forma de pago (tarjeta) no se valida contra `FormaPago` del CFDI. |
| Renta de automóviles deducible hasta **$200.00 diarios** por automóvil | LISR 28-XIII | PARÁMETRO | Ausente. |
| Inversión en automóviles deducible hasta **$175,000**; eléctricos/híbridos **$250,000** | LISR 36-II | PARÁMETRO (`lisr.auto_tope`, `lisr.auto_tope_electrico`) | Ausente: `asset-service.ts` no topa el MOI de «Equipo de Transporte» (`:127-134`). |
| Nómina deducible sólo si se cumplen retención y entero (27-V) y se expide CFDI (99-III) | LISR 27-V, 99-III | MOTOR (control de cierre) | No hay control «nómina sin CFDI = no deducible». |

### 2.2 LISR: deducción de inversiones (arts. 31-35)

| Regla | Fuente | Clase | Estado en el repo |
|---|---|---|---|
| Se deduce aplicando **por cientos máximos** sobre el MOI; en ejercicios irregulares y en el año de alta/baja, en proporción a **meses completos** de uso sobre doce | LISR 31 párr. 1 | MOTOR | `base_depreciacion` (`pending-catalog.ts:104-128`) y `convencion_primer_mes` con default `mes_completo` (`:132-155`), que coincide con la ley. |
| El MOI incluye impuestos pagados (**excepto IVA**), derechos, fletes, seguros de transporte, instalación, montaje, honorarios aduanales; en autos, el blindaje | LISR 31 párr. 2 | MOTOR (definición de base) | No hay regla que excluya el IVA del MOI al capitalizar desde un CFDI; `gasto_vs_activo` (`cfdi-decisions.ts:106-110`) decide cuenta, no base. |
| El contribuyente puede aplicar **por cientos menores**; el elegido es obligatorio y el segundo cambio exige cinco años | LISR 31 párr. 4 | Criterio del despacho (panel, por activo) | No existe un «por ciento elegido» por activo distinto del máximo. |
| Tasas por tipo de bien: construcciones **5 %** (10 % monumentos), mobiliario **10 %**, embarcaciones 6 %, aviones 10 % (25 % aerofumigación), **automóviles/camiones 25 %**, **cómputo 30 %**, **troqueles/moldes 35 %**, semovientes 100 %, telefonía 5-25 %, satélites 8-10 %, adaptaciones para discapacidad 100 %, **energía renovable 100 %** (mínimo 5 años en operación), bicicletas y motos eléctricas 25 %, usufructo 5 % | LISR 34 fr. I-XV | PARÁMETRO (`lisr.tasas_depreciacion`, tabla con vigencia) | `CATALOGO_LISR` en `src/services/assets/asset-service.ts:100-153` trae seis especies (5/10/30/25/10/35) con fundamento correcto; quemado y sin las demás fracciones. |
| Maquinaria por actividad: 5 % electricidad/molienda/azúcar/aceites/marítimo, 6 % metales, 7 % papel, 8 % automotriz/alimentos, 9 % química/plástico/imprenta, 10 % transporte eléctrico e hidrocarburos, 11 % textil, 12 % minería/aeronaves/autotransporte, 16 % transporte aéreo/radio-TV, … **XIV 10 % «otras actividades»** | LISR 35 | PARÁMETRO | Sólo la fr. XIV (10 %) en `asset-service.ts:137-142`. |
| Gastos y cargos diferidos: por cientos del art. 33 | LISR 33 | PARÁMETRO | Ausente (el motor de anticipados `prepaid-service.ts` es contable, no fiscal). |

### 2.3 LISR: sueldos y salarios (arts. 93, 96, 97, 99) y subsidio al empleo

| Regla | Fuente | Clase | Estado en el repo |
|---|---|---|---|
| **Exentos del art. 93** (en UMA por la desindexación de 2016): horas extra 50 % exento hasta **5 UMA semanales** (100 % para salario mínimo), primas de antigüedad/indemnizaciones **90 UMA por año de servicio** (fr. XIII), **aguinaldo 30 UMA**, **prima vacacional y PTU 15 UMA** cada una, **prima dominical 1 UMA por domingo** (fr. XIV) | LISR 93 fr. I, XIII, XIV | MOTOR (por concepto) + PARÁMETRO (los múltiplos y la UMA vigente) | **Ausente.** `taxableIsr` suma toda percepción no marcada como no gravable (`src/services/payroll/common/paycheck-service.ts:129-131`); el CFDI timbra `TotalExento="0.00"` (`src/services/payroll/mx/cfdi-nomina-generator.ts:124`). El plan lo tiene como E4.1 (`docs/plan-cierre-brechas.md:5372-5417`, propone `exenciones-lisr.ts`); no existe el archivo ni la migración (`ls src/database/migrations` termina en `060_…`). |
| **Retención mensual** con la tarifa del art. 96 (publicada actualizada en el **Anexo 8** de la RMF cuando la inflación acumulada supera 10 %, art. 152 último párrafo); **no se retiene** a quien sólo percibe un salario mínimo; se disminuye el impuesto local a salarios si su tasa ≤ 5 % | LISR 96, 152; Anexo 8 RMF 2026 | MOTOR + PARÁMETRO (`isr.tarifa_96` por periodicidad y vigencia) | `MexicoIsrCalculator` (`src/services/payroll/mx/isr-calculator.ts:9-45`) aplica tramos de `tax_tables` por `tax_year` y sólo `monthly`/`quincenal` (`:27-28`). **La semilla de 2026 es la tarifa 2024-2025** (`009_tax_tables_2026.sql:147-161`: 746.04…375,975.62) y la quincenal es «la mensual entre dos» (`:163`); el Anexo 8 2026 publica tarifas propias de 1, 7, 10 y 15 días y mensual (ver §3). No hay tarifa semanal ni decenal aunque `PayFrequency` admite `weekly` (`tax-engine.interface.ts:6`). La excepción del salario mínimo y el impuesto local no se modelan. |
| **Subsidio al empleo 2026**: a quien tenga ingresos mensuales base ≤ **$11,492.66**, un subsidio mensual = **15.02 % de la UMA mensual** (**15.59 %** sobre la UMA de 2025 durante enero 2026, art. Segundo transitorio); en periodos menores a un mes se divide entre **30.4** y se multiplica por los días, sin exceder el tope mensual; se excluyen primas de antigüedad, retiro e indemnizaciones; **si el subsidio excede al ISR, «ni se entregará cantidad alguna»** (regla vigente desde el 01-05-2024) | DOF 31-12-2025 (fuente 23); DOF 01-05-2024 (fuente 24) | MOTOR (fórmula) + PARÁMETRO (`subsidio.pct_uma`, `subsidio.tope_ingresos`, con vigencia mensual en enero) | `MexicoSubsidioEmpleoCalculator` (`isr-calculator.ts:52-88`) busca un **tramo con `base_tax`** y la semilla (`009:178-194`) es la tabla escalonada anterior a mayo de 2024 (407.02 … 217.61) con el tope de 2025 (10,171): estructura derogada + valor viejo. `paycheck-service.ts:247` hace `Math.max(0, isr − sub)`, lo que coincide con la ley por accidente; el comentario `:246` («employee receives as cash») y el plan E4.1-i (`plan-cierre-brechas.md:6580-6606`) contradicen el decreto de 2024. La fila de Nómina 1.2 sí debe seguir mostrando el subsidio causado (`OtroPago` 002) aunque no se entregue. |
| **Ajuste anual** (art. 97): el patrón calcula el impuesto del año con la tarifa del 152 y acredita las retenciones; el trabajador puede optar por no presentar anual si sus ingresos ≤ $400,000 (150) | LISR 97, 150 | MOTOR (corrida de diciembre) | Ausente (`docs/wiki/Motores-contables.md:27` lo lista como ausente). |
| CFDI de nómina: expedir y entregar en la fecha del pago (99-III); la RMF permite hasta **3/5/7/9/11 días hábiles** después según 1-50/51-100/101-300/301-500/>500 trabajadores, o un CFDI mensual con un complemento por pago | LISR 99-III; RMF 2026 regla 2.7.5.1 | PUERTA + PARÁMETRO (tabla de días hábiles) | El generador existe (`cfdi-nomina-generator.ts`), ninguna puerta vigila el plazo. |
| Retención de **10 %** de ISR por PM a personas físicas por honorarios (106) y por arrendamiento (116), enterada con las del 96 | LISR 106, 116 | MOTOR + PARÁMETRO (`retencion.isr_honorarios` = 0.10, `retencion.isr_arrendamiento` = 0.10) | Ausente como cálculo: la taxonomía sólo **contabiliza** la retención que el CFDI ya trae (`src/services/xml-ingestion/cfdi-taxonomy.ts:151-152, 171-172, 210-211, 229-230`). `Motores-contables.md:27` lo confirma. |

### 2.4 LISR: régimen y pagos de la entidad (arts. 9, 14, 76, 113-E, 206)

| Regla | Fuente | Clase | Estado en el repo |
|---|---|---|---|
| PM: tasa **30 %** sobre el resultado fiscal (9); **pagos provisionales mensuales a más tardar el 17** con coeficiente de utilidad (14); declaración anual dentro de los **tres meses** siguientes al cierre (76-V) | LISR 9, 14, 76-V | MOTOR (provisión y pagos provisionales) + PARÁMETRO (tasa, calendario) | Ausente: ni provisión de ISR (NIF D-4) ni pagos provisionales (`motores-inventario.md`, fila «Asientos de cierre anual»; `Motores-contables.md:27`). |
| **RESICO PF** (113-E): ingresos del ejercicio anterior ≤ **$3,500,000**; pago **mensual el día 17** sobre ingresos efectivamente cobrados sin deducción, tabla 1.00 % (≤25,000) / 1.10 % (≤50,000) / 1.50 % (≤83,333.33) / 2.00 % (≤208,333.33) / 2.50 % (≤3,500,000); al exceder, sale del régimen al mes siguiente | LISR 113-E; RMF 3.13.1-3.13.12 | MOTOR + PARÁMETRO (`resico_pf.tabla`, `resico_pf.tope`) | Ausente: RESICO sólo aparece como código de régimen en `README_ACCOUNTANT.md:405, 426`. |
| **RESICO PM** (206): PM constituidas sólo por personas físicas con ingresos ≤ **35 millones** | LISR 206 | PARÁMETRO | Ausente. |
| PF: anual en **abril** (150) | LISR 150 | PARÁMETRO (calendario) | Ausente. |

### 2.5 LIVA y RLIVA

| Regla | Fuente | Clase | Estado en el repo |
|---|---|---|---|
| Tasa general **16 %** (1); **0 %** (2-A); el art. 2 (franja fronteriza) está derogado: el **8 %** es un crédito del 50 % por decreto de estímulos, **prorrogado hasta el 31-12-2026** | LIVA 1, 2, 2-A; decreto (fuente 25) | PARÁMETRO (`iva.tasa_general`, `iva.tasa_cero`, `iva.tasa_frontera` con vigencia hasta 2026-12-31 y con lista de municipios) | Quemado en tres sitios: `cfdi-parser.ts:359-363`, `cfdi-facts.ts:214-224`, `sat-catalogs.ts:99-103` (`IVA_RATES` como cadenas decimales, bien hecho). No hay vigencia ni región. |
| **Retención de IVA** por PM (1-A): a PF por servicios personales independientes, comisiones y uso o goce → **dos terceras partes** (RLIVA 3-I); autotransporte de bienes → **4 %** (RLIVA 3-II); desperdicios; se entera **a más tardar el 17** y sólo por lo efectivamente pagado | LIVA 1-A; RLIVA 3 | MOTOR + PARÁMETRO (`retencion.iva_fraccion` = 2/3, `retencion.iva_autotransporte` = 0.04) | Ausente como cálculo (igual que ISR 106/116). |
| **Base de flujo**: contraprestaciones efectivamente cobradas (1-B); el **cheque** se cobra en la fecha de cobro; acreditamiento sólo del IVA **efectivamente pagado en el mes** (5-III) | LIVA 1-B, 5-III | MOTOR | Implementado: `src/services/accounting/iva-cash-basis.ts:9-25, 64-67` (PUE/PPD, roles 1130/1135/2120/2125), REP como liberador `src/services/xml-ingestion/rep-linkage.ts:12-35`, cheque al cobro (`src/ai/docs/mexico-cfdi.md:10`, `bank check reconcile`). |
| IVA **mensual definitivo**, pago a más tardar el **17** (5-D); acreditamiento proporcional por actividades mixtas (5-V) | LIVA 5-D, 5-V | MOTOR (determinación mensual) + PARÁMETRO (calendario) | Ausente (`Motores-contables.md:27`: «acreditamiento proporcional, determinación mensual del IVA»). |
| **DIOT** (32-V y VIII): información mensual de retenciones y de pago/acreditamiento/traslado por proveedor, desglosada **por tasa** e incluyendo actividades no gravadas; la ley dice día 17 y la **regla 4.5.1** lo extiende a «durante el mes inmediato posterior»; plataforma `pstcdi.clouda.sat.gob.mx` | LIVA 32-V, 32-VIII; RMF 4.5.1; SAT (fuente 27) | MOTOR (agregación por RFC y tasa desde la base de flujo) + PUERTA + PARÁMETRO (calendario) | Ausente: `docs/wiki/Fiscal-mexicano.md:237` («No se genera»); existe la lista de bloqueadores `vendor list --no-tax-id` (`src/cli/vendor-command.ts:178`) y la skill `skills/diot-checklist/SKILL.md`. La base de flujo que la DIOT necesita ya la produce el motor de IVA (§2.5 fila 3). |

### 2.6 CFF: contabilidad, CFDI, cancelación, conservación

| Regla | Fuente | Clase | Estado en el repo |
|---|---|---|---|
| **Ejercicio fiscal = año de calendario**; irregular si la PM inicia después del 1 de enero; los meses son de calendario | CFF 11 | MOTOR (calendario) | `ensureFiscalYear` siembra siempre año natural con 12 periodos (`src/services/accounting/fiscal-calendar-service.ts:513-534`); el primer ejercicio irregular no existe (`docs/jurisdicciones.md` §3.6). |
| **Días inhábiles** para plazos: sábados, domingos, 1-ene, primer lunes de febrero, tercer lunes de marzo, 1 y 5 de mayo, 16-sep, tercer lunes de noviembre, 1-dic sexenal, 25-dic | CFF 12 | PARÁMETRO (`calendario.inhabiles`) | Ausente. |
| **Tipo de cambio**: el que Banxico publica en el DOF **el día anterior** a la causación | CFF 20 | MOTOR | Regla escrita en prosa y no aplicada (`motores-inventario.md`, fila «Conversión FX»: `fx-command.ts:144`). |
| **Contabilidad** (28): registros en medios electrónicos (fr. III); **envío mensual** al SAT (fr. IV) | CFF 28-III, 28-IV | MOTOR + PUERTA | Ver §2.7. |
| **CFDI** (29): e.firma vigente, CSD, remitir al SAT para validación/folio/sello, complementos obligatorios; **29-A**: RFC/nombre/**régimen** del emisor, lugar y fecha, RFC/nombre/**CP** y **uso** del receptor, catálogos de cantidad/unidad/clase, y **cancelación a más tardar en el mes en que se deba presentar la anual del ejercicio de expedición** con aceptación del receptor (párrafo reformado DOF 07-11-2025); cancelar ingresos exige **justificar y soportar** el motivo | CFF 29, 29-A | MOTOR (validación) + PUERTA (timbrado/cancelación) + PARÁMETRO (plazo) | El parser exige 4.0/3.3 (`docs/wiki/Fiscal-mexicano.md:27`); el generador de nómina quema `RegimenFiscal="601"`, `LugarExpedicion="00000"`, `DomicilioFiscalReceptor="00000"` (`cfdi-nomina-generator.ts:104-107`). Sin sellado propio ni timbrado real (`Fiscal-mexicano.md:15-19`). La cancelación REST responde 501 (`mexico-cfdi.md:16`; ruta en `src/api/rest/routes/invoices.ts:289-294`); el plazo de cancelación y la aceptación no se modelan. |
| Reglas de cancelación: el receptor tiene **3 días** para aceptar o negar y el silencio es aceptación (2.7.1.34); sin aceptación si total ≤ **$1,000**, nómina, egresos, traslado, retenciones, público en general, o **dentro del día hábil siguiente** (2.7.1.35) | RMF 2026 2.7.1.34, 2.7.1.35 | PARÁMETRO (`cfdi.cancel_sin_aceptacion_max` = 1000; plazo 3 días) | Ausente; `sat-catalogs.ts:106-111` sólo lista los motivos 01-04. |
| **CSD sin efectos / restricción temporal** (17-H fr. X, 17-H Bis): entre otras causas, omitir la anual un mes después de vencida o **dos o más provisionales** | CFF 17-H, 17-H Bis | MOTOR (alerta de cumplimiento) | Ausente; la custodia de e.firma existe (`src/services/fiscal-credentials/service.ts:15-44`) pero no la de CSD. |
| **Conservación**: contabilidad y documentación **5 años** desde la declaración relacionada; actas, aumentos de capital, dividendos, declaraciones: **toda la vida** de la sociedad | CFF 30 | MOTOR (retención de registros) + PARÁMETRO (5 años) | Ausente (`motores-inventario.md`, fila «Integridad del mayor»: «Retención de registros (CFF 30 · IRC §6001) sin motor»). |
| **69-B**: presunción de operaciones inexistentes; el `ValidacionEFOS` viaja en la consulta de estatus | CFF 69-B | MOTOR (control) | La consulta lo captura (`src/services/xml-ingestion/sat-validation.ts:51`, `src/services/sat/cfdi-status.ts:35`) sin control que lo use en el cierre. |
| **Plazo del REP**: uno por pago o uno mensual por receptor; a más tardar el **quinto día natural del mes siguiente** al pago; `Total="0"`, sin `MetodoPago`/`FormaPago` | RMF 2026 2.7.1.32 | PUERTA (alerta sobre PPD cobrados sin REP) + PARÁMETRO (5 días naturales) | El repo liga REP recibidos y emitidos (`rep-linkage.ts`; políticas `rep_faltante_recibido`/`rep_faltante_emitido`, `pending-catalog.ts:861-899`) pero no mide el plazo. |
| Complementos publicados en el Portal son obligatorios **30 días naturales** después | RMF 2026 2.7.1.8 | PARÁMETRO (versión vigente por complemento) | Versiones quemadas: `cfdi/4`, `nomina12` 1.2 (`cfdi-nomina-generator.ts:100-101, 113`). |
| Versiones vigentes: **CFDI 4.0** única válida desde 01-04-2023; **REP 2.0** obligatorio desde 01-04-2023; **Nómina 1.2 rev. C** sobre 4.0 desde 01-01-2022; **Carta Porte 3.1** desde 17-07-2024 | SAT (fuentes 30-33) | PARÁMETRO (`cfdi.version`, `rep.version`, `nomina.version`, `cartaporte.version`, con vigencia) | Carta Porte no existe en el repo (grep en `src`: cero). |

### 2.7 RMF 2026 y Anexo 24: contabilidad electrónica

| Regla | Fuente | Clase | Estado en el repo |
|---|---|---|---|
| **Qué se lleva en XML** (2.8.1.5): (I) catálogo de cuentas del periodo con **código agrupador** por cuenta de mayor y subcuenta de primer nivel; (II) balanza con **saldos iniciales, movimientos y finales** de activo, pasivo, capital, resultados y orden, que **distinga impuestos por cobrar/pagar, trasladados cobrados y acreditables pagados** y los ingresos **por tasa** (RCFF 33-B-III); la balanza de cierre incluye **ajustes fiscales**; (III) pólizas y auxiliares con UUID, RFC, monto, moneda y tipo de cambio, y cheques/transferencias identificados | RMF 2.8.1.5; Anexo 24 apartados A-E | MOTOR (generación de los tres XML) + PARÁMETRO (catálogo `c_CodAgrup`, versión 1.3) | Hay materia prima, no XML: columna del agrupador `mx_nif_code` escrita por `account map set --scheme sat-agrupador` (`src/services/accounting/account-service.ts:445-456`), compuerta `map check` (`src/cli/account-command.ts:738-742`), auxiliar con forma XC (`src/services/reporting/report-service.ts:968`). El catálogo `c_CodAgrup` versionado **no existe** (`account-command.ts:632-640` rechaza `--year`; `account-service.ts:519-520`). Las cuentas 1130/1135/2120/2125 del estrato MX (`chart-seed.ts:92-…`) ya separan trasladado-cobrado y acreditable-pagado, que es justo lo que la fr. II exige. |
| **Cuándo se envía** (2.8.1.6): catálogo con la **primera balanza** y cuando se modifique; balanza **PM: primeros 3 días del segundo mes posterior**; **PF: primeros 5 días**; emisoras: trimestral (3 de mayo/agosto/noviembre/marzo); **balanza ajustada de cierre: PM 20 de abril, PF 22 de mayo**; reenvíos por error hasta el vencimiento, y 5 días tras el aviso de rechazo | RMF 2.8.1.6 | PARÁMETRO (calendario) + PUERTA (envío) | Ausente (`Fiscal-mexicano.md:232`: «El envío al buzón tributario tampoco»). |
| **Estructura del XML de balanza** (XSD 1.3): `Balanza` con `Version="1.3"`, `RFC`, `Mes` (01-**13**: el 13 es la balanza de cierre), `Anio` (2015-2099), `TipoEnvio` N/C, `FechaModBal` (obligatoria en complementaria), `Sello`/`noCertificado`/`Certificado`; `Ctas` con `NumCta`, `SaldoIni`, `Debe`, `Haber`, `SaldoFin` (importe a 2 decimales) | XSD (fuente 18); Anexo 24 B | MOTOR | El mayor guarda cuatro decimales (`finiquito-math.ts:39` como convención de la casa); el XML exige 2: hace falta la regla de redondeo por cuenta y el «periodo 13» que el calendario admite y nunca crea (`docs/jurisdicciones.md` §1.6). |
| **Código agrupador**: apartado A a) del Anexo 24 (nivel 1 y 2: 100 Activo … 401.39 «Ventas y/o servicios gravados realizados en zona fronteriza norte» … 810 «Deducción de inversión»), publicado en el DOF 13-01-2026 | Anexo 24 A a) | PARÁMETRO (tabla con vigencia = versión del anexo) | No está sembrado; el despacho captura el código a mano sin validación (`Fiscal-mexicano.md:212-218`). |
| Catálogos F/G/H del Anexo 24 (monedas, bancos, **métodos de pago** 01-17/98/99) para las pólizas | Anexo 24 F-H | PARÁMETRO | Ausentes. |

### 2.8 LFT: prestaciones, PTU, terminación y jornada

| Regla | Fuente | Clase | Estado en el repo |
|---|---|---|---|
| **Vacaciones** (76, reforma DOF 27-12-2022): 12 días el primer año, +2 por año hasta 20 al quinto; **desde el sexto, +2 por cada cinco años**; proporcional si termina antes del año (79); **prima ≥ 25 %** (80); se otorgan dentro de los 6 meses siguientes al aniversario (81) | LFT 76, 79, 80, 81 | MOTOR (tabla) + panel (prima > mínimo) | Implementado: `src/services/payroll/mx/finiquito-math.ts:80-88` (tabla sin tope, correcto), prima proporcional `:277-291`; el porcentaje viene del panel `prima_vacacional_pct` (`pending-catalog.ts:496`) leído en `finiquito-calculator.ts:102-105`. |
| **Aguinaldo** (87): **≥ 15 días** de salario, pagado **antes del 20 de diciembre**, proporcional por tiempo trabajado | LFT 87 | MOTOR + panel (`dias_aguinaldo`) + PARÁMETRO (fecha límite) | Prorrateo desde la fecha de alta y con año bisiesto: `finiquito-math.ts:257-268`; días desde el panel `dias_aguinaldo` (`pending-catalog.ts:474`). La provisión mensual y el vencimiento del 20-dic no existen. |
| **PTU**: 10 % de la renta gravable (Comisión Nacional; base = renta gravable LISR, art. 120); reparto **dentro de los 60 días** siguientes a la anual (122) → PM 30 de mayo, PF 29 de junio; **tope: 3 meses de salario o promedio de los 3 últimos años, lo más favorable** (127-VIII); mitad por días trabajados y mitad por salario (123); excluidos directores/gerentes generales, honorarios, trabajo doméstico | LFT 117-127; STPS (fuente 40) | MOTOR (reparto) + PARÁMETRO (`ptu.pct` = 0.10, calendario) | Ausente (grep `PTU` en `src`: cero; `Motores-contables.md:27`). Y la exención de 15 UMA (§2.3) tampoco. |
| **Prima de antigüedad** (162): **12 días por año**, con salario topado al doble del mínimo (485-486); se paga en despido, separación justificada, o retiro voluntario con ≥ 15 años | LFT 162 | MOTOR | Ausente en el finiquito (`finiquito-math.ts:246-306` sólo salario pendiente, aguinaldo, prima vacacional y vacaciones no gozadas). |
| **Indemnización** (48, 50): 3 meses + **20 días por año** (tiempo indeterminado); salarios vencidos hasta 12 meses + interés 2 % mensual sobre 15 meses | LFT 48, 50 | MOTOR | Ausente; el CFDI de liquidación exige además la exención 93-XIII (90 UMA/año) que tampoco existe. |
| **Jornada** (59, reforma DOF 01-05-2026): máximo **40 horas semanales**, gradual **48 (2026) → 46 (2027) → 44 (2028) → 42 (2029) → 40 (2030)**; horas extra máximas 9/9/10/11/12 por semana (transitorios Segundo y Cuarto); diaria 8/7/7.5 (61) | LFT 59, 61 y transitorios | PARÁMETRO (`lft.jornada_semanal` y `lft.horas_extra_max` con vigencia anual) | Ausente (grep `horas extra` en `src/services/payroll`: cero). Afecta al cálculo de horas extra dobles/triples y a la exención 93-I. |
| Plazos de pago del salario: semana (trabajo material) / quince días (88) | LFT 88 | PARÁMETRO | `PayFrequency` admite `weekly`, `quincenal`, `monthly` (`tax-engine.interface.ts:6`); sin regla. |

### 2.9 LSS e INFONAVIT: cuotas, SBC, UMA

| Regla | Fuente | Clase | Estado en el repo |
|---|---|---|---|
| **SBC** (27): cuota diaria + gratificaciones, primas, comisiones, prestaciones en especie; **exclusiones** (herramientas, ahorro paritario, cuotas patronales e INFONAVIT, **PTU**, alimentación/habitación onerosas ≥ 20 % SMG, **despensa ≤ 40 % SMG**, **premios de asistencia y puntualidad ≤ 10 % SBC** cada uno, fondos de pensiones, tiempo extra dentro de la LFT); los excedentes sí integran; **factor de integración** = (365 + aguinaldo + vacaciones × prima)/365 | LSS 27 | MOTOR (integración) + PARÁMETRO (topes de exclusión) | Factor de integración: `finiquito-math.ts:183-188` (correcto, incluida la constante 365 de `:47`); la integración con topes de exclusión **no existe**: `taxableImss = taxableIsr` (`paycheck-service.ts:132`) y el SBC se toma del alta del empleado. |
| **Tope 25 veces el SMG del DF** (→ **25 UMA** por desindexación) y piso el SMG del área (28) | LSS 28 | PARÁMETRO (`imss.tope_uma` = 25) | Tope 25 UMA en `imss-calculator.ts:63, 111` e `infonavit-calculator.ts:33, 63` (multiplicador quemado; la semilla lo trae en `imss_tope_sbc_multiplier` `009:44` pero nadie lo lee). El **piso** (SMG) no se valida. |
| Cuotas **mensuales vencidas, pago a más tardar el 17** (39); el patrón determina y entera (15-III) | LSS 39, 15-III | PARÁMETRO (calendario) | Ausente; SUA e IDSE existen como archivos (`src/services/payroll/mx/sua-generator.ts`, `src/services/payroll/integrations/imss-idse-adapter.ts`), sin calendario. |
| **Riesgos de trabajo** (71-74): prima = [(S/365)+V(I+D)]·(F/N)+M, con V=28, F=2.3 (2.2 con sistema acreditado), **M=0.005**; al inscribirse se paga la **prima media de la clase** (I 0.54355 %, II 1.13065 %, III 2.59840 %, IV 4.65325 %, V 7.58875 %); revisión **anual** con variación máx. ±1 %; empresas < 10 trabajadores pueden quedarse en la prima media | LSS 71-74 | PARÁMETRO **por entidad** (`imss.prima_rt` con vigencia anual) + PARÁMETRO (primas medias) | Las primas medias sembradas (`009:59-63`) son correctas, pero el motor las aplica por **clase** (`imss-calculator.ts:36-45, 131`): después del primer año la prima es de la empresa, no de la clase. |
| **Enfermedades y maternidad**: cuota fija patronal **20.40 % de la UMA** por asegurado (106-I: 13.9 % + 0.65 × 10 años del transitorio XIX de 1997); excedente sobre **3 UMA**: patrón **1.10 %**, trabajador **0.40 %** (106-II: 6 %/2 % − 0.49/0.16 × 10 años); prestaciones en dinero **1 %**: patrón 0.70 %, trabajador 0.25 % (107); **GMP 1.5 %**: patrón 1.05 %, trabajador 0.375 % (25) | LSS 25, 106, 107 y transitorio XIX (1997) | PARÁMETRO (tasas por ramo con vigencia) | Semilla `009:45-58`: cuota fija 0.204 ✓, excedente patronal 0.011 ✓, prestaciones 0.007/0.0025 ✓, GMP 0.0105/0.00375 ✓, **excedente obrero 0.00625 ✗ (debe ser 0.0040)** (`009:46`). El motor aplica bien las bases (`imss-calculator.ts:62-80, 110-135`). |
| **Invalidez y vida**: patrón **1.75 %**, trabajador **0.625 %** (147) | LSS 147 | PARÁMETRO | ✓ (`009:50, 57`). |
| **Guarderías y prestaciones sociales**: **1 %** patronal (211) | LSS 211 | PARÁMETRO | ✓ (`009:58`). |
| **Retiro 2 %** patronal; **cesantía y vejez**: trabajador **1.125 %**; patrón por **tabla de SBC** (168-II-a), gradual desde 2023 hasta 2030 (transitorio Segundo, DOF 16-12-2020). Meta 2030: 1 SM 3.150 % · 1.01-1.50 UMA 4.202 % · 1.51-2.00 6.552 % · 2.01-2.50 7.962 % · 2.51-3.00 8.902 % · 3.01-3.50 9.573 % · 3.51-4.00 10.077 % · 4.01+ 11.875 %. **2026** (fuente 44, coherente con la interpolación lineal de la ley): 3.150 · 3.676 · 4.851 · 5.556 · 6.026 · 6.361 · 6.613 · **7.513 %** | LSS 168; transitorio Segundo 2020 | PARÁMETRO (`imss.ceav_patronal` = tabla por tramo **y por año** hasta 2030) | Semilla `cesantia_vejez: 0.03150` (`009:64`) = tasa única de 2022; el motor multiplica una sola tasa (`imss-calculator.ts:133`). **Incorrecto desde 2023.** |
| **INFONAVIT 5 %** del salario (base y tope según LSS) (29-II); pago por mensualidades vencidas a más tardar el 17 (35); descuentos de crédito en VSM, factor o pesos | LIFNVT 29-II, 35 | PARÁMETRO (`infonavit.tasa` = 0.05) | ✓ `infonavit-calculator.ts:32` (default 0.05, y `009:67`); crédito `:66-76`; el VSM usa `salario_minimo_general_diario` (`:61`) con default **278.80** (2025). |
| **UMA**: 2026 = **117.31** diario, **3,566.22** mensual, **42,794.64** anual, **vigente desde el 1 de febrero de 2026**; 2025 = 113.14 / 3,439.46 / 41,273.52 | DOF 09-01-2026 (fuente 19) | PARÁMETRO con vigencia **intra-anual** | Semilla 2026 = valores de 2025 (`009:39-41`); defaults quemados 113.14 en `imss-calculator.ts:62, 110` e `infonavit-calculator.ts:31, 62`; `tax_parameters` es **una fila por año** (`008:381`) y `getTaxParameters` filtra por año (`tax-tables.ts:75`): no puede expresar enero ≠ febrero. |
| **Salario mínimo 2026**: **315.04** general (6.5 % + MIR 17.01 = 13 %), **440.87** ZLFN (5 %), vigente 01-01-2026 | DOF 09-12-2025 (fuente 21) | PARÁMETRO (`smg.general`, `smg.zlfn`, vigencia 1-ene) | Semilla = 278.80 / 419.88 (2025) (`009:42-43`). |

### 2.10 Calendario de obligaciones (lo que un motor de vencimientos debe conocer)

| Obligación | Plazo | Fuente | Estado |
|---|---|---|---|
| Pagos provisionales ISR PM, retenciones ISR (96, 106, 116), IVA definitivo, retenciones IVA, RESICO PF | **Día 17** del mes siguiente, **más 1-5 días hábiles según el sexto dígito del RFC** (1-2: +1; 3-4: +2; 5-6: +3; 7-8: +4; 9-0: +5), salvo dictaminados (32-A), 32-H, entes públicos e integradoras | LISR 14, 96, 113-E; LIVA 1-A, 5-D; Decreto 26-12-2013 art. 5.1 (fuente 26) | Ausente |
| DIOT | Durante el **mes inmediato posterior** (ley: 17) | LIVA 32-VIII; RMF 4.5.1 | Ausente |
| Contabilidad electrónica (balanza) | PM: **primeros 3 días del segundo mes posterior**; PF: 5 días; cierre: **20-abr** PM / **22-may** PF | RMF 2.8.1.6 | Ausente |
| Cuotas IMSS mensuales; INFONAVIT y RCV | **Día 17** del mes siguiente (LSS 39; LIFNVT 35) | LSS 39; LIFNVT 35 | Ausente |
| Declaración anual PM | **Dentro de los 3 meses** siguientes al cierre (31-mar) | LISR 76-V | Ausente |
| Declaración anual PF | **Abril** | LISR 150 | Ausente |
| PTU | **60 días** tras la anual: PM 30-may, PF 29-jun | LFT 122; STPS | Ausente |
| Aguinaldo | **Antes del 20 de diciembre** | LFT 87 | Ausente |
| CFDI de nómina | 3-11 días hábiles tras el pago según plantilla | RMF 2.7.5.1 | Ausente |
| REP | **5.º día natural** del mes siguiente al pago | RMF 2.7.1.32 | Ausente |
| Cancelación de CFDI | Hasta el mes de la anual del ejercicio de expedición | CFF 29-A | Ausente |
| Prima de riesgo de trabajo (revisión anual) | Anual (febrero, por reglamento) | LSS 74 | Ausente |
| Conservación de contabilidad | 5 años desde la declaración relacionada | CFF 30 | Ausente |

## 3. Parámetros por jurisdicción y año (los que deben vivir en tabla con vigencia)

Formato: clave propuesta (compatible con la tabla `parametros_legales` de `docs/jurisdicciones.md` §3.4) · valor 2026 · vigencia · fuente · dónde vive hoy.

| Clave | Valor 2026 | Vigencia | Fuente | Hoy en el repo |
|---|---|---|---|---|
| `uma.diaria` / `uma.mensual` / `uma.anual` | 117.31 / 3,566.22 / 42,794.64 (2025: 113.14 / 3,439.46 / 41,273.52) | **2026-02-01 → 2027-01-31** | DOF 09-01-2026 | `009:39-41` (2025), defaults quemados `imss-calculator.ts:62,110`, `infonavit-calculator.ts:31,62` |
| `smg.general` / `smg.zlfn` | 315.04 / 440.87 (2025: 278.80 / 419.88) | 2026-01-01 → | DOF 09-12-2025 | `009:42-43` (2025); default `infonavit-calculator.ts:61` |
| `isr.tarifa_96.mensual` | 11 tramos: 0.01-844.59 1.92 % · 844.60-7,168.51 6.40 % (16.22) · 7,168.52-12,598.02 10.88 % (420.95) · 12,598.03-14,644.64 16 % (1,011.68) · 14,644.65-17,533.64 17.92 % (1,339.14) · 17,533.65-35,362.83 21.36 % (1,856.84) · 35,362.84-55,736.68 23.52 % (5,665.16) · 55,736.69-106,410.50 30 % (10,457.09) · 106,410.51-141,880.66 32 % (25,659.23) · 141,880.67-425,641.99 34 % (37,009.69) · 425,642.00+ 35 % (133,488.54) | 2026-01-01 → (hasta la próxima actualización por inflación > 10 %, LISR 152) | Anexo 8 RMF 2026, apartado B-V | `009:147-161` trae la tarifa 2024-2025 |
| `isr.tarifa_96.quincenal` (15 días) | 0.01-416.70 1.92 % · 416.71-3,537.15 6.40 % (7.95) · 3,537.16-6,216.15 10.88 % (207.75) · 6,216.16-7,225.95 16 % (499.20) · 7,225.96-8,651.40 17.92 % (660.75) · 8,651.41-17,448.75 21.36 % (916.20) · 17,448.76-27,501.60 23.52 % (2,795.25) · 27,501.61-52,505.25 30 % (5,159.70) · 52,505.26-70,006.95 32 % (12,660.75) · 70,006.96-210,020.70 34 % (18,261.30) · 210,020.71+ 35 % (65,866.05) | 2026-01-01 → | Anexo 8 RMF 2026, B-IV | `009:163-175` es la mensual entre dos |
| `isr.tarifa_96.semanal` (7 días) | 0.01-194.46 1.92 % · 194.47-1,650.67 6.40 % (3.71) · 1,650.68-2,900.87 10.88 % (96.95) · 2,900.88-3,372.11 16 % (232.96) · 3,372.12-4,037.32 17.92 % (308.35) · 4,037.33-8,142.75 21.36 % (427.56) · 8,142.76-12,834.08 23.52 % (1,304.45) · 12,834.09-24,502.45 30 % (2,407.86) · 24,502.46-32,669.91 32 % (5,908.35) · 32,669.92-98,009.66 34 % (8,521.94) · 98,009.67+ 35 % (30,737.49) | 2026-01-01 → | Anexo 8 RMF 2026, B-II | Ausente |
| `isr.tarifa_96.diaria` y `.decenal` | Diaria: 0.01-27.78 1.92 % … 14,001.39+ 35 % (4,391.07); decenal: 0.01-277.80 1.92 % … 140,013.81+ 35 % (43,910.70) | 2026-01-01 → | Anexo 8 RMF 2026, B-I y B-III | Ausente |
| `subsidio.tope_ingresos_mensual` | 11,492.66 (2025: 10,171.00; may-2024: 9,081.00) | 2026-01-01 → | DOF 31-12-2025 | `009:193` (10,171 en tabla derogada) |
| `subsidio.pct_uma_mensual` | **15.59 % sobre UMA 2025** (ene-2026, = 536.21) · **15.02 % sobre UMA vigente** (feb-2026 →, = 535.65 con UMA 3,566.22) | Mensual | DOF 31-12-2025 | Estructura de tramos derogada `009:178-194`; motor `isr-calculator.ts:62-74` |
| `subsidio.divisor_prorrateo` | 30.4 | Desde 2024-05-01 | DOF 01-05-2024 | Motor divide entre 2 para quincenal (`isr-calculator.ts:77`) |
| `subsidio.excedente_se_entrega` | **false** | Desde 2024-05-01 | DOF 01-05-2024 | Plan E4.1-i dice lo contrario (`plan-cierre-brechas.md:6580-6606`) |
| `imss.tope_uma` | 25 | LSS 28 (estable) | LSS 28 | Quemado (`imss-calculator.ts:63`); semilla `009:44` sin lector |
| `imss.em_cuota_fija_pct_uma` | 0.2040 | Desde 2007 | LSS 106-I + trans. XIX | ✓ `009:53` |
| `imss.em_excedente_patron` / `_trabajador` | 0.0110 / **0.0040** | Desde 2007 | LSS 106-II + trans. XIX | `009:54` ✓ / `009:46` ✗ (0.00625) |
| `imss.prestaciones_dinero_patron` / `_trabajador` | 0.0070 / 0.0025 | LSS 107 | LSS 107 | ✓ `009:55`, `:47` |
| `imss.gmp_patron` / `_trabajador` | 0.0105 / 0.00375 | LSS 25 | LSS 25 | ✓ `009:56`, `:48` |
| `imss.iv_patron` / `_trabajador` | 0.0175 / 0.00625 | LSS 147 | LSS 147 | ✓ `009:57`, `:50` |
| `imss.guarderias` | 0.01 | LSS 211 | LSS 211 | ✓ `009:58` |
| `imss.retiro` | 0.02 | LSS 168-I | LSS 168-I | ✓ `009:65` |
| `imss.ceav_trabajador` | 0.01125 | LSS 168-II-b | LSS 168-II-b | ✓ `009:51` |
| `imss.ceav_patron` (tabla por tramo de SBC en UMA, **por año**) | 2026: 1 SM 3.150 % · 1.01-1.50 3.676 % · 1.51-2.00 4.851 % · 2.01-2.50 5.556 % · 2.51-3.00 6.026 % · 3.01-3.50 6.361 % · 3.51-4.00 6.613 % · 4.01+ 7.513 % (2030: 3.150 … 11.875 %) | 2026-01-01 → 2026-12-31; cambia cada 1-ene hasta 2030 | LSS 168-II-a + trans. Segundo (DOF 16-12-2020); renglones 2026 en fuente 44 | `009:64` (0.0315 único) |
| `imss.prima_rt_media` (por clase) | I 0.54355 % · II 1.13065 % · III 2.59840 % · IV 4.65325 % · V 7.58875 % | LSS 73 (estable) | LSS 73 | ✓ `009:59-63` |
| `imss.prima_rt` (**por entidad**, resultado de la declaración anual) | prima de la empresa (mín. 0.5 %, máx. 15 %) | Anual (marzo → febrero) | LSS 72-74 | Ausente; el motor usa la clase (`imss-calculator.ts:131`) |
| `infonavit.tasa` | 0.05 | LIFNVT 29-II | LIFNVT 29-II | ✓ `009:67` |
| `lisr.exento.aguinaldo_uma` / `.prima_vacacional_uma` / `.ptu_uma` / `.prima_dominical_uma` / `.horas_extra_uma_semana` / `.separacion_uma_por_anio` | 30 / 15 / 15 / 1 / 5 / 90 | LISR 93 (estable) | LISR 93-I, XIII, XIV | Ausente |
| `lisr.efectivo_max` | 2,000.00 | LISR 27-III | LISR 27-III | Quemado `cfdi-decisions.ts:94` |
| `lisr.restaurantes_deducible` | 0.085 | LISR 28-XX | LISR 28-XX | Quemado `cfdi-decisions.ts:96` |
| `lisr.auto_renta_dia` / `lisr.auto_moi_tope` / `lisr.auto_moi_tope_electrico` | 200.00 / 175,000 / 250,000 | LISR 28-XIII, 36-II | LISR | Ausente |
| `lisr.tasas_depreciacion` (arts. 34-35, por fracción) | ver §2.2 | LISR 34-35 | LISR | Seis especies quemadas `asset-service.ts:100-153` |
| `lisr.tasa_pm` | 0.30 | LISR 9 | LISR 9 | Ausente |
| `resico_pf.tope_ingresos` / `resico_pf.tabla` | 3,500,000 / 1.00-1.10-1.50-2.00-2.50 % con cortes 25,000 / 50,000 / 83,333.33 / 208,333.33 / 3,500,000 | LISR 113-E | LISR 113-E | Ausente |
| `resico_pm.tope_ingresos` | 35,000,000 | LISR 206 | LISR 206 | Ausente |
| `retencion.isr_honorarios` / `retencion.isr_arrendamiento` / `retencion.iva_fraccion` / `retencion.iva_autotransporte` | 0.10 / 0.10 / 2/3 / 0.04 | LISR 106, 116; RLIVA 3 | LISR, RLIVA | Ausente |
| `iva.tasa_general` / `iva.tasa_cero` / `iva.tasa_frontera` | 0.16 / 0 / 0.08 (crédito 50 %) | 16 % estable; **frontera hasta 2026-12-31** | LIVA 1, 2-A; decreto (fuente 25) | Quemado en `cfdi-parser.ts:359-363`, `cfdi-facts.ts:214-224`, `sat-catalogs.ts:99-103` |
| `cfdi.version` / `rep.version` / `nomina.version` / `cartaporte.version` | 4.0 / 2.0 / 1.2 rev. C / 3.1 | 01-04-2023 / 01-04-2023 / 01-01-2022 / 17-07-2024 | SAT (fuentes 30-33) | Quemadas en el generador de nómina |
| `cfdi.cancel_sin_aceptacion_max` / `cfdi.cancel_plazo_aceptacion_dias` / `cfdi.cancel_fecha_limite` | 1,000 / 3 / mes de la anual | RMF 2.7.1.34-35; CFF 29-A | RMF, CFF | Ausente |
| `rep.plazo_dias_naturales` | 5 | RMF 2.7.1.32 | RMF | Ausente |
| `nomina.plazo_cfdi_dias_habiles` (por plantilla) | 3 / 5 / 7 / 9 / 11 para ≤50 / ≤100 / ≤300 / ≤500 / >500 | RMF 2.7.5.1 | RMF | Ausente |
| `ce.plazo_balanza_pm_dias` / `_pf_dias` / `ce.cierre_pm` / `ce.cierre_pf` / `ce.version_xml` | 3 / 5 / 20-abr / 22-may / 1.3 | RMF 2.8.1.6; XSD | RMF, SAT | Ausente |
| `ce.codagrup` (catálogo del Anexo 24 A a)) | tabla nivel 1-2 | Versión DOF 13-01-2026 | Anexo 24 | Ausente |
| `diot.plazo` | mes inmediato posterior | RMF 4.5.1 | RMF | Ausente |
| `calendario.dia_pago` / `calendario.dias_adicionales_rfc` | 17 / {1-2:1, 3-4:2, 5-6:3, 7-8:4, 9-0:5} | LISR 14, LIVA 5-D; Decreto 26-12-2013 art. 5.1 | DOF | Ausente |
| `calendario.inhabiles` | lista CFF 12 | CFF 12 | CFF | Ausente |
| `lft.aguinaldo_min_dias` / `lft.prima_vacacional_min` / `lft.vacaciones_tabla` / `lft.prima_antiguedad_dias` / `lft.indemnizacion` | 15 / 0.25 / art. 76 / 12 / 3 meses + 20 días/año | LFT 87, 80, 76, 162, 50 | LFT | Mínimos como defaults del panel (`pending-catalog.ts:474-510`); tabla 76 en `finiquito-math.ts:80-88`; resto ausente |
| `lft.jornada_semanal_max` / `lft.horas_extra_max` | 48 / 9 (2026) → 46/9 (2027) → 44/10 (2028) → 42/11 (2029) → 40/12 (2030) | Cada 1-ene | LFT 59 y transitorios (DOF 01-05-2026) | Ausente |
| `ptu.pct` / `ptu.tope` / `ptu.fecha_pm` / `ptu.fecha_pf` | 0.10 / 3 meses o promedio 3 años / 30-may / 29-jun | LFT 117-127; STPS | LFT, STPS | Ausente |
| `cff.conservacion_anios` | 5 (y «toda la vida» para actas, capital, dividendos, declaraciones) | CFF 30 | CFF | Ausente |
| `isn.tasa` (**por estado**) | CDMX 4 % (desde 2025); rango nacional 2.4-5 % | Anual, por congreso local | Fuente 45 (secundaria) | Ausente (`Motores-contables.md:27`) |

## 4. Lo que el repo ya tiene frente a lo que falta

### 4.1 Ya tiene (con su clase)

| Capacidad | MOTOR | PUERTA | PARÁMETRO | Evidencia |
|---|---|---|---|---|
| IVA en base de flujo (LIVA 1-B, 5-III): PUE/PPD, cuentas de control, liberación por pago, cheque al cobro, moneda extranjera con suma telescópica | ✓ | CLI/REST/agente | Tasas quemadas | `iva-cash-basis.ts:9-25, 64-67`; `rep-linkage.ts:12-35`; `mexico-cfdi.md:5-10` |
| Parser CFDI 4.0/3.3 con hechos (dirección, IVA 16/8/0, exento, IEPS, retenciones, relacionados, anticipos) y taxonomía declarativa | ✓ | `mnemosine ingest`, `bill inbox` | Catálogos SAT como tablas de códigos (`sat-catalogs.ts`) | `Fiscal-mexicano.md:25-44` |
| Consulta de estatus de CFDI ante el SAT (ConsultaCFDIService, incluye `ValidacionEFOS`) | ✓ | `cfdi-command.ts`, REST | — | `cfdi-status.ts:8-27`; `sat-validation.ts:22-53` |
| Custodia de e.firma con bitácora y consentimiento | ✓ | `sat cred` | Panel `efirma_*` | `fiscal-credentials/service.ts:15-44` |
| ISR de nómina por tramos (art. 96) mensual/quincenal | ✓ (aritmética) | REST `/v1/payroll` | `tax_tables` por año, **valores 2024-25** | `isr-calculator.ts:9-45`; `009:147-175` |
| IMSS obrero-patronal con tope 25 UMA, excedente 3 UMA, cuota fija, riesgo por clase | ✓ (bases) | REST | `tax_parameters` por año, **dos tasas mal, CEAV 2022** | `imss-calculator.ts`; `009:36-68` |
| INFONAVIT 5 % y descuentos de crédito (factor/VSM/pesos) | ✓ | REST | ✓ tasa | `infonavit-calculator.ts` |
| Finiquito: vacaciones art. 76, prima 80, aguinaldo 87 proporcional, salario diario vs. SBC | ✓ | REST `/finiquito` | Panel `dias_aguinaldo`, `prima_vacacional_pct` | `finiquito-math.ts`, `finiquito-calculator.ts:100-105` |
| CFDI de nómina 1.2 (XML) + SUA + IDSE (archivos, sin envío) | ✓ (parcial) | REST | Versiones quemadas | `cfdi-nomina-generator.ts`; `sua-generator.ts`; `payroll.md:12-15` |
| Depreciación fiscal por tasas del art. 34 y criterio contable/fiscal en el panel | ✓ | `depreciation run`, `asset` | `CATALOGO_LISR` quemado | `asset-service.ts:100-153`; `pending-catalog.ts:104-155` |
| Límite de efectivo (27-III) y restaurantes (28-XX) como decisiones de clasificación | ✓ | ingesta | Quemados | `cfdi-decisions.ts:93-96, 208-227` |
| Agrupador SAT por cuenta, compuerta de cobertura y auxiliar con forma XC | ✓ (materia prima) | `account map set/check`, `ledger auxiliary` | Sin catálogo `c_CodAgrup` | `account-service.ts:445-456, 519-520`; `account-command.ts:632-640, 738-742`; `report-service.ts:968` |
| Bloqueadores de DIOT (proveedores sin RFC) y skill guía | — | `vendor list --no-tax-id`; `skills/diot-checklist` | — | `vendor-command.ts:178` |
| Año fiscal natural (CFF 11) | ✓ | `year create` | — | `fiscal-calendar-service.ts:513-534` |
| Panel con las bifurcaciones mexicanas: `politica_restaurantes`, `tratamiento_ieps`, `rep_*` (7), `cfdi_periodo_cerrado`, `dias_aguinaldo`, `prima_vacacional_pct`, `efirma_*`, `umbral_capitalizacion_mxn`, `fuente_tipo_cambio` (dof/fix) | — | `pending` | 39 claves sin dimensión de jurisdicción | `pending-catalog.ts`; `docs/jurisdicciones.md` §1.4 |

### 4.2 Falta (ordenado por lo que hoy calcula mal frente a lo que no calcula)

**A. Calcula con números equivocados (corregir primero: es dinero que se paga o retiene mal a personas)**

1. UMA y salarios mínimos de 2026 (`009:39-43`); y la UMA cambia el **1 de febrero**, cosa que `tax_parameters UNIQUE(jurisdiction, tax_year)` (`008:381`) no puede decir. Consecuencia: topes del IMSS, cuota fija de EM, VSM de INFONAVIT y —cuando existan— exentos del 93, todos con base de 2025.
2. Tarifa mensual del art. 96 de 2024-2025 en lugar de la del Anexo 8 2026 (`009:147-161`); quincenal inventada (`:163`); sin semanal ni decenal.
3. Subsidio al empleo con estructura derogada (`009:178-194`, `isr-calculator.ts:52-88`); la ley es un porcentaje fijo de UMA con tope de ingresos y prorrateo /30.4, y en enero 2026 cambia el porcentaje.
4. Cuota obrera del excedente de EM 0.625 % en vez de 0.40 % (`009:46`).
5. CEAV patronal 3.150 % único en vez de la tabla 2026 por tramo (3.150-7.513 %) (`009:64`; `imss-calculator.ts:133`).
6. Riesgo de trabajo por clase en vez de la prima propia de la entidad (`imss-calculator.ts:36-45, 131`).
7. Fallo silencioso: sin fila del año, IMSS e INFONAVIT calculan **cero** (`imss-calculator.ts:72-80` con `|| 0`; `tax-tables.ts:79` devuelve `{}`), mientras el ISR lanza (`isr-calculator.ts:30-31`).
8. Un texto que miente y un plan al revés: `paycheck-service.ts:246` y `plan-cierre-brechas.md:6580-6606` sobre entregar el subsidio excedente.

**B. No calcula (motores ausentes, en orden de dependencia)**

1. **Exentos del art. 93** por concepto (aguinaldo, prima vacacional, PTU, prima dominical, horas extra, separación) → prerequisito para que `TotalExento` del CFDI de nómina deje de ser 0.00 y para el ISR correcto de diciembre.
2. **Integración del SBC** con las exclusiones y topes del LSS 27 (hoy `taxableImss = taxableIsr`).
3. **Retenciones al registrar** honorarios/arrendamiento/autotransporte de PF: 10 % ISR y 2/3 (o 4 %) del IVA, con su entero el 17 (la contabilización de la retención ya existe; falta el cálculo y el CFDI de retenciones tipo R, cuyo parser tampoco existe: `cfdi-taxonomy.ts:406-416`).
4. **Determinación mensual de IVA** (5-D) y **pagos provisionales de ISR** (14) con calendario del 17 + días adicionales: son la salida natural de la base de flujo que ya existe.
5. **DIOT**: agregación por RFC y por tasa de lo efectivamente pagado; la base ya la produce el motor de IVA; plazo de la regla 4.5.1.
6. **Contabilidad electrónica**: XML de catálogo (con `c_CodAgrup` sembrado del Anexo 24), balanza 1.3 (incluido el periodo 13 y el redondeo a 2 decimales) y pólizas con UUID/RFC/moneda/TC; calendario de la 2.8.1.6.
7. **PTU** (10 %, tope 127-VIII, reparto por días y salario, fechas), **prima de antigüedad** (162) e **indemnización** (48/50) en el finiquito; ISR de la liquidación con la exención 93-XIII.
8. **Provisión anual de ISR** (30 %) y **ajuste anual** de salarios (97).
9. **RESICO PF** (113-E) como régimen de la entidad, con su tabla y su tope.
10. **Calendario de obligaciones** (§2.10) con `dia 17 + sexto dígito`, días inhábiles del CFF 12 y vencimientos de nómina/IMSS/DIOT/CE/anual/PTU/aguinaldo.
11. **Controles del CFF**: plazo de cancelación (29-A) y reglas de aceptación (2.7.1.34-35), plazo del REP (2.7.1.32), plazo del CFDI de nómina (2.7.5.1), conservación (30), EFOS (69-B) como control de cierre, causales de restricción del CSD (17-H Bis).
12. **Jornada de 40 horas** (LFT 59, gradual 2026-2030) en el cálculo de horas extra y en su exención.
13. **Topes de automóviles** (36-II, 28-XIII) en activos y en gastos; MOI sin IVA (31).
14. **ISN estatal** (parámetro por estado, CDMX 4 %).
15. **Carta Porte 3.1** (sólo si el despacho lleva transportistas: hoy cero referencias en `src`).
16. **Sellado propio del CFDI (CSD) y timbrado real**; descarga masiva del SAT (`Fiscal-mexicano.md:11-19`): fuera de este informe, pero condicionan la completitud que la DIOT y la CE presumen.

**C. Sitio equivocado (funciona, pero la ley está en código o el criterio no tiene jurisdicción)**

- Ley quemada: `iva.tasa_*` (tres copias), `lisr.efectivo_max`, `lisr.restaurantes_deducible`, `lisr.tasas_depreciacion`, versiones de complementos, tope 25 UMA, defaults 113.14/278.80 en tres calculadoras.
- Tabla sin vigencia: `tax_parameters` y `tax_tables` (columnas `effective_from/effective_to` existen en `tax_tables` `008:367-368` y **nadie las usa**: `tax-tables.ts:46, 75`).
- Panel sin jurisdicción: 39 claves sembradas en todo inquilino (`docs/jurisdicciones.md` §1.4), 14 de ellas sólo mexicanas.
- Umbral capitalización `umbral_capitalizacion_mxn` (`pending-catalog.ts:186`) es criterio del despacho (correcto en el panel); el tope de automóviles del 36-II **no** lo es (ley) y no debe ir al panel.

## 5. Notas de verificación y límites de este informe

- La tabla anual de cesantía y vejez 2023-2030 está en el decreto del DOF 16-12-2020 como **imagen**; el PDF de diputados sólo trae el texto del transitorio Segundo («de manera gradual, a partir del 1 de enero de 2023, de conformidad con la siguiente tabla») y la tabla meta de 2030 en el art. 168. Los renglones de 2026 se tomaron de la fuente 44 y se comprobó que coinciden con la interpolación lineal entre 3.150 % (2022) y la meta de 2030 en cada tramo (p. ej. 4.01+ UMA: 3.150 + 4 × 1.090625 = 7.5125 %).
- Los importes en pesos del subsidio (536.21 en enero, 535.65 desde febrero) son **derivados** del decreto (porcentaje × UMA mensual); una fuente secundaria publica 536.22 para el tramo general, que no reproduce la aritmética del decreto con la UMA del DOF. El motor debe guardar el **porcentaje y la UMA**, no el importe.
- La ficha de diputados da la LIVA con última reforma 12-11-2021; no se verificó si el paquete 2026 (DOF 07-11-2025, que sí reformó el CFF 29-A) tocó la LIVA. Para lo que aquí se cita (1, 1-A, 1-B, 2-A, 5, 5-D, 32) el texto vigente es el leído.
- El decreto de región fronteriza se leyó en la copia de SIDOF; la fecha exacta de publicación (30 o 31 de diciembre de 2025) debe confirmarse en `dof.gob.mx` al sembrar la vigencia.
- `omawww.sat.gob.mx` rechazó todas las conexiones desde esta sesión; las cuatro fichas técnicas se verificaron por sus espejos en `wwwmat.sat.gob.mx`/`wwwmatnp.sat.gob.mx`. Los documentos técnicos (XSD, guías, catálogos `c_*`) viven en `omawww` y no se pudieron abrir, salvo el XSD de balanza que sí está en `www.sat.gob.mx/esquemas`.
- El RLISR (art. 174, retención opcional de aguinaldo/PTU; art. 177) y el RACERF (mes de la declaración de prima de RT) no se abrieron; sus reglas se mencionan sólo como pendientes.
