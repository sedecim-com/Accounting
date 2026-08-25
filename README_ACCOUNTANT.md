# Accounting Core — Guia Funcional

Una plataforma contable completa diseñada para empresas que operan en México y Estados Unidos, con soporte para NIF mexicanas, US GAAP e IFRS. Incluye **contabilidad de triple entrada** con atestación criptográfica en blockchain y anclaje en Bitcoin.

---

## Contenido

1. [Qué es Accounting Core](#qué-es-accounting-core)
2. [Catálogo de Cuentas](#catálogo-de-cuentas)
3. [Pólizas Contables (Asientos de Diario)](#pólizas-contables-asientos-de-diario)
4. [Cuentas por Cobrar (Clientes y Facturación)](#cuentas-por-cobrar-clientes-y-facturación)
5. [Cuentas por Pagar (Proveedores y Gastos)](#cuentas-por-pagar-proveedores-y-gastos)
6. [Conciliación Bancaria](#conciliación-bancaria)
7. [Activos Fijos y Depreciación](#activos-fijos-y-depreciación)
8. [Control de Inventarios](#control-de-inventarios)
9. [Cierre de Periodo](#cierre-de-periodo)
10. [Reportes Financieros](#reportes-financieros)
11. [Ingesta Automática de XML (CFDI de Proveedores)](#ingesta-automática-de-xml-cfdi-de-proveedores)
12. [Cumplimiento Fiscal México (CFDI / SAT)](#cumplimiento-fiscal-méxico-cfdi--sat)
13. [Multimoneda](#multimoneda)
14. [Multi-Empresa](#multi-empresa)
15. [Seguridad y Control de Acceso](#seguridad-y-control-de-acceso)
16. [Pista de Auditoría](#pista-de-auditoría)
17. [Notificaciones Automáticas (Webhooks)](#notificaciones-automáticas-webhooks)
18. [Contabilidad de Triple Entrada (Blockchain)](#contabilidad-de-triple-entrada-blockchain)

---

## Qué es Accounting Core

Accounting Core es un motor contable de partida doble que automatiza el registro, validación y reporteo de todas las operaciones financieras de una empresa. Está diseñado para:

- Empresas mexicanas (SA, SAPI, SC) que requieren cumplimiento con el SAT
- Empresas estadounidenses (Corporation, LLC, Partnership) bajo US GAAP
- Grupos corporativos con múltiples entidades legales y consolidación
- Operaciones en múltiples monedas (MXN, USD y cualquier otra divisa)

El sistema garantiza que **cada transacción se registre como partida doble** — todo cargo tiene un abono correspondiente y viceversa. No es posible registrar una póliza desbalanceada.

---

## Catálogo de Cuentas

### Qué puede hacer

- **Crear un catálogo de cuentas jerárquico** con cuentas padre e hijas a cualquier nivel de profundidad (ejemplo: 1000 Activo > 1100 Activo Circulante > 1110 Bancos > 1111 BBVA MXN)
- **Clasificar cada cuenta** por tipo: Activo, Pasivo, Capital, Ingreso, Gasto, Contra-cuenta
- **Asignar categorías para estados financieros** automáticamente: activo circulante, activo fijo, pasivo a corto plazo, pasivo a largo plazo, capital, ingresos, costo de ventas, gastos de operación, otros ingresos, otros gastos, impuestos
- **Mapear a distintas normas contables**: cada cuenta puede tener un código US GAAP, un código NIF mexicana y un código IFRS simultáneamente
- **Establecer la naturaleza de la cuenta** (deudora o acreedora)
- **Cuentas de encabezado**: marcar cuentas que solo sirven como agrupadores y no permiten movimientos directos
- **Cuentas de sistema**: cuentas creadas automáticamente (Capital Social, Resultados de Ejercicios Anteriores, Resultado del Ejercicio) que el sistema usa para cierres
- **Desactivar cuentas** sin perder histórico — una cuenta desactivada no aparece para nuevos movimientos pero conserva su saldo y pólizas anteriores
- **Buscar cuentas** por código, nombre o etiquetas personalizadas

### Catálogo de ejemplo incluido (México)

El sistema incluye un catálogo de cuentas mexicano estándar pre-cargado con 38 cuentas:

| Código | Cuenta | Tipo |
|--------|--------|------|
| 1000 | Activo | Encabezado |
| 1110 | Caja y Bancos | Activo circulante |
| 1111 | Banco Nacional - MXN | Activo circulante |
| 1112 | Banco Nacional - USD | Activo circulante |
| 1120 | Cuentas por Cobrar | Activo circulante |
| 1130 | IVA Acreditable | Activo circulante |
| 1140 | Inventarios | Activo circulante |
| 1210 | Mobiliario y Equipo | Activo fijo |
| 1220 | Equipo de Cómputo | Activo fijo |
| 1290 | Depreciación Acumulada | Contra-activo |
| 2110 | Cuentas por Pagar | Pasivo circulante |
| 2120 | IVA Trasladado | Pasivo circulante |
| 2130 | ISR por Pagar | Pasivo circulante |
| 3100 | Capital Social | Capital |
| 3200 | Resultado de Ejercicios Anteriores | Capital |
| 4100 | Ventas | Ingreso |
| 4200 | Ingresos por Servicios | Ingreso |
| 5100 | Costo de Ventas | Gasto |
| 6110 | Sueldos y Salarios | Gasto de administración |
| 6120 | Renta de Oficina | Gasto de administración |
| 6140 | Depreciación | Gasto de administración |
| 6300 | Gastos Financieros | Otros gastos |

---

## Pólizas Contables (Asientos de Diario)

### Qué puede hacer

- **Crear pólizas manuales** con mínimo dos líneas (cargos y abonos)
- **Validación automática de partida doble**: el sistema no permite guardar una póliza donde los cargos no sean iguales a los abonos
- **Tipos de póliza**:
  - Estándar (operaciones normales del día a día)
  - De ajuste (correcciones de fin de periodo)
  - De cierre (generadas automáticamente al cerrar el ejercicio)
  - De reversión (cancelan una póliza previa)
  - De corrección
  - Automáticas por factura, pago, depreciación o conciliación
- **Flujo de aprobación**: las pólizas pasan por un ciclo de vida:

```
Borrador → Pendiente de Aprobación → Aprobada → Contabilizada → Anulada
```

- **Contabilizar**: al contabilizar una póliza, los saldos de las cuentas se actualizan inmediatamente
- **Anular**: anular una póliza contabilizada genera automáticamente una póliza de reversión (invierte cargos y abonos) y requiere un motivo
- **Reversar**: crear manualmente una póliza de reversión con fecha específica
- **Asociar documentos**: cada póliza puede vincularse a una factura, nota de crédito, pago, o cualquier documento fuente
- **Adjuntar archivos**: se pueden asociar comprobantes digitalizados (XML, PDF) a cada póliza
- **Dimensiones contables**: cada línea de póliza puede asignarse a un centro de costos, departamento, proyecto o clase

### Pólizas automáticas

El sistema genera pólizas automáticamente cuando se registran:

| Operación | Cargo | Abono |
|-----------|-------|-------|
| Factura de venta | Cuentas por Cobrar | Ingresos + IVA Trasladado |
| Factura de compra | Gasto + IVA Acreditable | Cuentas por Pagar |
| Cobro de cliente | Bancos | Cuentas por Cobrar |
| Pago a proveedor | Cuentas por Pagar | Bancos (+ Descuento si aplica) |
| Depreciación mensual | Gasto por Depreciación | Depreciación Acumulada |
| Venta de inventario | Cuentas por Cobrar + Costo de Ventas | Ingresos + Inventario |

Esto elimina la necesidad de capturar pólizas manualmente para la mayoría de las operaciones del día a día.

---

## Cuentas por Cobrar (Clientes y Facturación)

### Gestión de clientes

- Registrar clientes con nombre de empresa o persona física
- RFC o Tax ID con validación de tipo (RFC México, EIN Estados Unidos, VAT internacional)
- Dirección de facturación y de envío
- Condiciones de pago por defecto (Neto 30, Neto 15, etc.)
- Límite de crédito con estados: aprobado, en espera, suspendido
- Cuenta contable de ingresos y de cuentas por cobrar por defecto
- Historial completo de facturas y pagos por cliente

### Facturación

- **Crear facturas** con múltiples líneas, cada una con cantidad, precio unitario, cuenta de ingreso, código de impuesto y tasa de IVA
- El sistema calcula automáticamente subtotal, IVA y total
- Numeración automática secuencial (INV-2026-00001, INV-2026-00002, ...)
- **Ciclo de vida de factura**:

```
Borrador → Pendiente → Enviada → Vista → Pagada
                                      → Pago Parcial
                                      → Vencida
                                      → Incobrable
```

- **Registrar cobros**: parciales o totales, el sistema actualiza automáticamente el saldo pendiente y cambia el estado
- **Métodos de cobro**: efectivo, cheque, tarjeta de crédito, tarjeta de débito, ACH, transferencia, SPEI, Stripe, Conekta, PayPal
- **Enviar factura** por correo electrónico
- **Anular factura** (solo si no está pagada)
- **Generar PDF** de la factura

### Timbrado CFDI (México)

- Timbrar factura ante el SAT a través de un PAC (Proveedor Autorizado de Certificación)
- Obtener UUID del CFDI
- Cancelar CFDI con los motivos oficiales del SAT:
  - 01: Comprobante emitido con errores con relación
  - 02: Comprobante emitido con errores sin relación
  - 03: No se llevó a cabo la operación
  - 04: Operación nominativa relacionada en la factura global

---

## Cuentas por Pagar (Proveedores y Gastos)

### Gestión de proveedores

- Registrar proveedores con RFC, EIN o VAT
- Marcar como proveedor 1099 (para reporteo fiscal en EE.UU.)
- Datos bancarios almacenados con encriptación (número de cuenta, CLABE, número de ruta)
- Condiciones de pago por defecto
- Cuenta de gasto por defecto
- Límite de crédito

### Gestión de facturas de compra (bills)

- **Crear facturas de compra** con múltiples líneas y asignación a cuentas de gasto
- Asociar a orden de compra
- Adjuntar XML o PDF del comprobante
- **Ciclo de aprobación**:

```
Borrador → Pendiente de Aprobación → Aprobada → Contabilizada → Pagada
```

- **Aprobar facturas**: control de quién puede aprobar pagos (separación de funciones)

### Pagos a proveedores

- Pagar una o varias facturas en un solo pago
- Aplicar descuentos por pronto pago (el sistema analiza los términos de pago, por ejemplo "2/10 Neto 30" significa 2% de descuento si se paga en 10 días)
- Programar pagos a futuro con fecha específica
- Métodos de pago: efectivo, cheque, ACH, transferencia, SPEI
- Registro automático del número de cheque o referencia de transferencia

---

## Conciliación Bancaria

### Importación de movimientos bancarios

- Importar transacciones desde archivos CSV, OFX, o directamente desde:
  - **Plaid** (bancos de EE.UU.)
  - **Fintoc** (bancos de Chile y México)
  - **Belvo** (bancos de Latinoamérica)
- Detección automática de duplicados (no importa el mismo movimiento dos veces)
- Cada transacción importada incluye: fecha, monto, tipo (cargo/abono), descripción, nombre del comercio

### Conciliación automática inteligente

El sistema intenta automáticamente emparejar cada movimiento bancario con su registro contable correspondiente usando un algoritmo de 4 niveles:

1. **Monto exacto + misma fecha**: si hay un solo registro contable con el mismo monto y la misma fecha, se concilia automáticamente con 100% de confianza
2. **Monto exacto + fecha cercana (3 días)**: si el monto coincide exactamente pero la fecha varía hasta 3 días, se concilia con 90% de confianza
3. **Coincidencia por descripción**: el sistema analiza la descripción del movimiento bancario y la compara con nombres de clientes, proveedores y descripciones de facturas usando análisis de similitud de texto
4. **Predicción inteligente**: combina la diferencia de monto, diferencia de fechas y similitud de descripción para calcular una probabilidad de coincidencia

Los movimientos con confianza igual o mayor al 85% se concilian automáticamente. Los demás se presentan como sugerencias para revisión manual.

### Sesiones de conciliación

- Crear una sesión de conciliación para un periodo específico (por ejemplo, marzo 2026)
- Ingresar el saldo según el estado de cuenta del banco
- El sistema calcula: saldo según libros, cheques en tránsito, depósitos en tránsito, cargos bancarios, intereses, y diferencia
- Completar la conciliación cuando la diferencia sea cero
- Historial completo de todas las sesiones de conciliación

---

## Activos Fijos y Depreciación

### Registro de activos

- Registrar activos con: nombre, fecha de adquisición, costo, proveedor, número de serie, fabricante, modelo, ubicación física
- Asignar categoría (mobiliario, equipo de cómputo, vehículos, maquinaria, etc.)
- Establecer valor residual y vida útil en años/meses
- Asignar cuentas contables: activo fijo, depreciación acumulada, gasto por depreciación
- Asignar a centro de costos y departamento
- Seguimiento de responsable del activo

### 6 métodos de depreciación

| Método | Descripción | Cuándo usarlo |
|--------|-------------|---------------|
| **Línea recta** | Gasto igual cada mes durante toda la vida útil | Método más común, aceptado por NIF y GAAP |
| **Saldos decrecientes 150%** | Depreciación acelerada al inicio, se reduce con el tiempo | Cuando el activo pierde valor rápidamente al inicio |
| **Saldos decrecientes 200%** | Depreciación doblemente acelerada | Depreciación agresiva en los primeros años |
| **Suma de dígitos de los años** | Depreciación mayor al inicio, menor al final | Alternativa a saldos decrecientes |
| **MACRS** | Tablas del IRS de EE.UU. con convención de medio año | Obligatorio para depreciación fiscal en Estados Unidos |
| **Unidades de producción** | Depreciación basada en uso real (horas, unidades, kilómetros) | Maquinaria y equipo de manufactura |

### Depreciación mensual automática

- El sistema calcula y registra automáticamente la depreciación de todos los activos activos cada mes
- Genera una póliza automática por cada activo: cargo a Gasto por Depreciación, abono a Depreciación Acumulada
- Actualiza el valor en libros del activo
- La depreciación para MACRS incluye las tablas oficiales del IRS para activos de 3, 5, 7, 10, 15 y 20 años

### Estados de activos

```
Activo → Totalmente Depreciado
       → Dado de Baja (con registro de ganancia o pérdida)
       → Inactivo
```

---

## Control de Inventarios

### Registro de artículos

- Cada artículo de inventario tiene un código, nombre, método de costeo, y cuentas contables asignadas (inventario, costo de ventas, ingresos)
- El sistema mantiene automáticamente la cantidad actual, valor actual y costo unitario promedio

### 4 métodos de costeo

| Método | Cómo funciona | Efecto en COGS |
|--------|--------------|----------------|
| **PEPS (FIFO)** | Se venden primero las unidades más antiguas | En inflación: menor costo de ventas, mayor utilidad |
| **UEPS (LIFO)** | Se venden primero las unidades más recientes | En inflación: mayor costo de ventas, menor utilidad |
| **Costo promedio ponderado** | Un solo costo promedio para todas las unidades | Costo de ventas suavizado entre periodos |
| **Identificación específica** | Se selecciona exactamente qué lote se vende | El más preciso, ideal para artículos de alto valor |

### Capas de inventario

Cada compra crea una "capa" de inventario con su fecha, cantidad y costo unitario. Al vender:

1. El sistema selecciona las capas según el método de costeo configurado
2. Calcula el costo de ventas exacto
3. Genera automáticamente una póliza con 4 líneas:
   - Cargo a Cuentas por Cobrar (por el precio de venta)
   - Abono a Ingresos (por el precio de venta)
   - Cargo a Costo de Ventas (por el costo calculado)
   - Abono a Inventarios (por el costo calculado)
4. Registra qué capas fueron consumidas (para auditoría)

---

## Cierre de Periodo

### Cierre suave (soft close)

Antes de cerrar un periodo, el sistema verifica una lista de verificación:

- Todas las pólizas están contabilizadas (no hay borradores pendientes)
- Conciliaciones bancarias completadas para todas las cuentas de banco
- Todas las facturas de venta revisadas
- Depreciación calculada y registrada para todos los activos
- Balanza de comprobación cuadrada (cargos = abonos)

Si hay problemas bloqueantes, el sistema indica exactamente qué falta. El cierre suave permite aún registrar pólizas de ajuste.

### Cierre duro (hard close)

- Solo se puede ejecutar después del cierre suave
- Si es el último periodo del ejercicio fiscal, el sistema genera automáticamente las pólizas de cierre:
  1. Cierra todas las cuentas de ingresos contra Resultado del Ejercicio
  2. Cierra todas las cuentas de gastos contra Resultado del Ejercicio
  3. Traspasa el Resultado del Ejercicio a Resultados de Ejercicios Anteriores
- Bloquea todas las pólizas del periodo (no se pueden modificar)
- Registra quién cerró el periodo y cuándo

---

## Reportes Financieros

### Balanza de comprobación

- Muestra todas las cuentas con sus saldos de cargos, abonos y saldo final
- Filtrar por periodo fiscal, fecha corte, o nivel de cuenta (1-5)
- Valida que el total de cargos sea igual al total de abonos
- Exportable a JSON, PDF, CSV y Excel

### Estado de situación financiera (Balance General)

- Muestra activos, pasivos y capital contable a una fecha determinada
- Desglosa por subsecciones: activo circulante, activo fijo, pasivo a corto plazo, pasivo a largo plazo, capital
- Dentro de cada sección, lista las cuentas individuales con su saldo

### Estado de resultados (PyG)

- Ingresos, costos, gastos de operación y utilidad neta para un rango de fechas
- Detalle cuenta por cuenta dentro de cada sección

### Estado de flujo de efectivo

- Método indirecto: parte de la utilidad neta y ajusta por:
  - Depreciación (sumada de vuelta)
  - Cambios en cuentas por cobrar
  - Cambios en cuentas por pagar
- Actividades de inversión: compras y ventas de activos fijos
- Resultado: flujo neto de efectivo del periodo

### Libro mayor (Mayor General)

- Todas las pólizas contabilizadas que afectan una cuenta específica
- Filtrar por rango de fechas
- Muestra: fecha, número de póliza, tipo, descripción, cargo, abono

### Antigüedad de saldos

- **Cuentas por cobrar**: lista de facturas pendientes por cliente con días de atraso
- **Cuentas por pagar**: lista de facturas pendientes por proveedor con días de atraso
- Útil para gestión de cobranza y planeación de pagos

---

## Ingesta Automática de XML (CFDI de Proveedores)

Este módulo permite recibir los XML de los CFDIs que emiten los proveedores y convertirlos automáticamente en facturas de compra y pólizas contables, sin captura manual.

### Flujo de trabajo

1. **Subir el XML** — El área de compras o el sistema del proveedor sube el archivo XML del CFDI al sistema
2. **Validación automática** — El sistema parsea el CFDI, verifica la estructura y los catálogos del SAT (RFC, regímenes, claves de producto)
3. **Pre-registro** — El documento queda almacenado en estado *pendiente* con toda la información extraída: emisor, receptor, conceptos, impuestos, total
4. **Reglas de procesamiento** — Se aplican las reglas configuradas para enrutar automáticamente el documento:
   - Asignar cuenta contable de gasto según el proveedor o descripción
   - Asignar centro de costos o proyecto
   - Decidir si requiere aprobación o se procesa automáticamente
   - Poner en espera documentos que no cumplen criterios
5. **Procesar** — El documento aprobado genera automáticamente la factura de compra y su póliza contable

### Reglas de procesamiento automatizado

Se pueden configurar reglas con condiciones simples:

| Condición | Ejemplo |
|-----------|---------|
| RFC del proveedor | Si RFC = `ABC010101XYZ` → cuenta 6120 Renta de Oficina |
| Descripción del concepto | Si contiene "Nómina" → requiere aprobación del Director |
| Monto total | Si total > $50,000 → poner en espera para revisión |
| Régimen fiscal | Si régimen = 626 RESICO → cuenta de gasto especial |

Las reglas se aplican en orden de prioridad y son gestionables desde la interfaz sin necesidad de programación.

### Procesamiento por lotes

Se pueden agrupar múltiples CFDIs pendientes en un lote y procesarlos en una sola operación, con seguimiento del estado de cada documento.

---

## Cumplimiento Fiscal México (CFDI / SAT)

### Facturación electrónica CFDI 4.0

- Generación de XML conforme al estándar CFDI versión 4.0 del SAT
- Integración con **tres PACs** con conmutación automática por fallas (Finkok → SW Sapien → Edicom)
- Cada factura timbrada recibe un UUID único del SAT
- Soporte para cancelación con los 4 motivos oficiales

### Catálogos del SAT incluidos

- **Régimen Fiscal**: 17 códigos (601 General de Ley PM, 612 Personas Físicas con AE y P, 625 RESICO, 626 Régimen Simplificado de Confianza, etc.)
- **Uso del CFDI**: 14 códigos (G01 Adquisición de mercancías, G03 Gastos en general, S01 Sin efectos fiscales, etc.)
- **Método de Pago**: PUE (pago en una sola exhibición), PPD (pago en parcialidades)
- **Forma de Pago**: 25 códigos (01 Efectivo, 02 Cheque, 03 Transferencia electrónica, 04 Tarjeta de crédito, etc.)
- **Tasas de IVA**: 16% (general), 8% (zona fronteriza), 0% (tasa cero)

### Reportes fiscales

- **DIOT** (Declaración Informativa de Operaciones con Terceros): genera el archivo en formato delimitado por pipes conforme a las especificaciones del SAT, con el desglose de operaciones por proveedor

### Campos CFDI en facturas

Cada línea de factura puede incluir:
- Clave de producto/servicio del SAT
- Clave de unidad del SAT
- Estos códigos se incluyen en el XML del CFDI

---

## Multimoneda

### Tipos de cambio

- Registrar tipos de cambio de múltiples fuentes: manual, Banco de México, BCE, Fed, XE, Open Exchange Rates
- Tipos de cambio: spot, promedio, presupuesto, histórico
- Cada tipo de cambio tiene una fecha de vigencia

### Conversión automática

- Al registrar una póliza en moneda extranjera, se captura el monto en moneda original, el tipo de cambio y se calcula automáticamente el monto en moneda funcional
- El sistema valida que la conversión sea correcta (tolerancia de 0.01)
- Los tipos de cambio se buscan automáticamente: primero tasa directa, luego tasa inversa, y finalmente tasa cruzada vía USD

### Moneda funcional por entidad

Cada entidad legal tiene su propia moneda funcional (MXN, USD, EUR, etc.). Todas las operaciones se registran tanto en la moneda original como en la moneda funcional.

---

## Multi-Empresa

### Estructura organizacional

```
Compañía (Tenant)
  └── Organización (Holding o Operadora)
        └── Entidad Legal
              ├── Tipo: Corporation, LLC, Partnership, SAPI, SA, SC
              ├── País de constitución
              ├── Moneda funcional
              ├── Norma contable (US GAAP, NIF, IFRS)
              └── Mes de inicio del ejercicio fiscal
```

### Aislamiento de datos

- Cada empresa tiene sus datos completamente separados de las demás
- Un usuario puede tener acceso a una o varias entidades legales
- Los reportes se generan por entidad legal
- Es imposible que datos de una empresa se mezclen con otra

---

## Seguridad y Control de Acceso

### Roles predefinidos

| Rol | Qué puede hacer |
|-----|-----------------|
| **Propietario** | Todo. Acceso sin restricciones. |
| **Administrador** | Gestionar cuentas, pólizas, facturas, reportes y usuarios. Sin acceso a facturación del sistema. |
| **Contralor** | Ver y crear cuentas, crear y contabilizar pólizas, cerrar periodos, generar reportes. |
| **Contador** | Ver cuentas, crear pólizas (sin contabilizar), gestionar facturas y gastos, ver reportes. |
| **Visualizador** | Solo lectura en todos los módulos. |
| **Auditor** | Solo lectura + acceso a bitácora de auditoría + exportación de reportes. |

### Separación de funciones

El sistema impide que una misma persona realice funciones que podrían generar conflictos de interés:

- Quien registra un proveedor **no puede** aprobar pagos a ese proveedor
- Quien crea una póliza **no puede** contabilizarla (requiere otra persona)
- Quien cierra un periodo **no puede** reabrirlo

### Datos sensibles encriptados

Los datos bancarios de proveedores (número de cuenta, CLABE, número de ruta) se almacenan encriptados. Ni siquiera un administrador de base de datos puede leerlos sin la llave de encriptación.

---

## Pista de Auditoría

Cada acción que modifica datos queda registrada automáticamente:

- **Quién** realizó la acción (usuario)
- **Qué** se hizo (crear, modificar, eliminar, contabilizar, anular, aprobar, cerrar)
- **Sobre qué** (tipo de registro e identificador)
- **Cuándo** (fecha y hora exacta)
- **Desde dónde** (dirección IP)
- **Valores nuevos** del registro

Esta bitácora es inmutable — no se puede borrar ni modificar. Los auditores tienen acceso de solo lectura a toda la bitácora.

---

## Notificaciones Automáticas (Webhooks)

El sistema puede enviar notificaciones automáticas a sistemas externos cuando ocurren eventos importantes:

| Evento | Cuándo se dispara |
|--------|-------------------|
| Póliza contabilizada | Al contabilizar una póliza |
| Factura pagada | Cuando una factura se marca como pagada |
| Factura vencida | Cuando una factura pasa su fecha de vencimiento |
| CFDI timbrado | Al timbrar exitosamente un CFDI |
| CFDI cancelado | Al cancelar un CFDI |
| Factura de compra aprobada | Al aprobar una factura de proveedor |
| Pago recibido | Al registrar un cobro de cliente |
| Pago realizado | Al registrar un pago a proveedor |
| Movimiento bancario importado | Al importar transacciones del banco |
| Movimiento bancario conciliado | Al conciliar un movimiento |
| Conciliación completada | Al completar una sesión de conciliación |
| Periodo cerrado | Al cerrar un periodo fiscal |

Estas notificaciones permiten integrar el sistema contable con otros sistemas de la empresa (CRM, ERP, sistemas de cobranza, dashboards, etc.).

---

## Contabilidad de Triple Entrada (Blockchain)

### Qué es

La **contabilidad de triple entrada** extiende la partida doble tradicional con una **tercera anotación criptográfica** registrada en una red blockchain pública. Mientras que la partida doble garantiza que los registros internos de la empresa están balanceados, la triple entrada garantiza que esos registros son **inmutables y verificables por cualquier tercero** sin necesidad de confiar en la empresa ni en su auditor.

```
Partida doble (interna):
  Cargo → Cuentas por Cobrar    $116,000
  Abono → Ingresos por Ventas   $100,000
  Abono → IVA Trasladado         $16,000

Tercera entrada (blockchain):
  Hash SHA-256 de la póliza → Atestación en Arbitrum + Anclaje en Bitcoin
```

La tercera entrada no se puede borrar, modificar ni falsificar, porque vive fuera de los sistemas de la empresa.

### Qué hace el sistema

Cuando se **contabiliza una póliza**, el sistema automáticamente:

1. **Calcula un hash criptográfico** de la póliza y todas sus líneas. Si se cambia cualquier dato, el hash cambia.
2. **Genera un compromiso de privacidad** que prueba que el monto es válido (entre cero y un billón) sin revelar la cifra exacta.
3. **Envía una prueba criptográfica** (ZK-proof / UltraPLONK) a zkVerify, que la verifica de forma independiente.
4. **Publica la atestación** en el blockchain configurado (Arbitrum, Base, Polygon, Ethereum o Solana).

Cuando se **cierra un periodo fiscal**, el sistema:

5. **Construye un árbol de Merkle** con todos los hashes de las pólizas del periodo.
6. **Registra la raíz del árbol** en blockchain — un único valor que representa criptográficamente todo el periodo contable.
7. **Ancla en Bitcoin** via `OP_RETURN`: la raíz del árbol queda incrustada en la blockchain de Bitcoin bajo el protocolo TRPA, el registro más resistente a la censura del mundo.

### Para qué sirve en la práctica

| Escenario | Cómo ayuda la triple entrada |
|-----------|------------------------------|
| **Auditoría externa** | El auditor puede verificar cualquier póliza de forma independiente comparando su hash con el registro en blockchain, sin acceso a los sistemas internos |
| **Due diligence** | Un comprador potencial puede comprobar que los estados financieros no fueron alterados después de ser generados |
| **Disputas legales** | La fecha y el contenido de una póliza quedan anclados en un registro con timestamp de Bitcoin, con validez probatoria |
| **Reguladores** | Las autoridades pueden verificar la integridad de los registros sin necesidad de una auditoría tradicional |
| **Inversores** | Pueden tener certeza de que los reportes financieros publicados corresponden exactamente a los registros contables reales |

### Privacidad

Los datos confidenciales (montos exactos, nombres de clientes, proveedores) **no se publican en blockchain**. Solo se publica:
- El hash de la póliza (no revela los datos, solo permite verificarlos)
- El compromiso criptográfico del monto (prueba que es válido sin revelarlo)
- La raíz del árbol de Merkle del periodo (representa todo el historial sin exponer transacciones individuales)

Los **agregados publicados** (totales por tipo de cuenta) se redondean y solo se publican si el grupo tiene al menos 5 transacciones, para proteger la confidencialidad de operaciones individuales.

### Verificación independiente

Cualquier persona con acceso a Bitcoin puede verificar la integridad de un periodo contable:

1. Consultar la transacción de Bitcoin en mempool.space
2. Localizar el `OP_RETURN` con el identificador `TRPA`
3. Extraer la raíz del árbol de Merkle
4. Verificar que el hash de cualquier póliza pertenece a ese árbol

El sistema genera automáticamente el código de verificación para cada póliza anclada.

---

## Resumen de Capacidades

| Módulo | Funcionalidades principales |
|--------|---------------------------|
| **Catálogo de Cuentas** | Jerárquico, multi-norma (NIF/GAAP/IFRS), clasificación automática para estados financieros |
| **Pólizas** | Partida doble validada, 6 tipos de póliza, flujo de aprobación, generación automática |
| **Cuentas por Cobrar** | Clientes, facturación, cobros parciales/totales, CFDI, antigüedad de saldos |
| **Cuentas por Pagar** | Proveedores, facturas de compra, aprobación, programación de pagos, descuentos por pronto pago |
| **Bancos** | Importación automática, conciliación inteligente con IA, sesiones de conciliación |
| **Activos Fijos** | 6 métodos de depreciación, depreciación automática mensual, seguimiento físico |
| **Inventarios** | 4 métodos de costeo (PEPS, UEPS, promedio, identificación específica), capas de inventario |
| **Cierre** | Cierre suave y duro, lista de verificación automática, pólizas de cierre del ejercicio |
| **Reportes** | Balanza, balance general, estado de resultados, flujo de efectivo, mayor general, antigüedad |
| **Ingesta XML** | Upload de CFDIs de proveedores, validación SAT, reglas de enrutamiento automático, procesamiento por lotes |
| **Fiscal México** | CFDI 4.0, timbrado con failover multi-PAC (Finkok/SW Sapien/Edicom), cancelación, catálogos SAT, DIOT |
| **Multimoneda** | Tipos de cambio múltiples, conversión automática, moneda funcional por entidad |
| **Seguridad** | 6 roles, separación de funciones, encriptación, pista de auditoría inmutable |
| **Triple Entrada** | Hash criptográfico por póliza, ZK-proofs, atestación en EVM/Solana, anclaje en Bitcoin (TRPA) |
