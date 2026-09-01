# Glosario

Este código mezcla dos vocabularios que casi nadie tiene completos a la vez: el de la contabilidad fiscal mexicana y el de la casa. Un desarrollador que llega de fuera de México se topa con `iva_trasladado_no_cobrado` y no puede adivinar por qué existe esa cuenta; una persona no contable se topa con `partida doble` y `arrastre de saldos` y tampoco. Esto es el diccionario, sin condescendencia y sin adornos.

Cuando un término tiene consecuencias en el motor, el enlace lleva a donde se explican: [[Fiscal-mexicano]] para casi todo lo fiscal, [[El-tablero-y-los-criterios]] para el vocabulario del plan, [[El-agente-y-sus-limites]] para el del agente.

## Fiscal y contable mexicano

**Agrupador SAT** — Código de un catálogo oficial (`c_CodAgrup`) con el que cada cuenta del catálogo propio se homologa al catálogo del SAT, para que la autoridad pueda leer contabilidades de empresas distintas con la misma clave. Es requisito del XML de catálogo del Anexo 24. En mnemosine vive en `accounts.mx_nif_code` y se fija con `mnemosine account map set`.

**Anexo 24** — El anexo de la Resolución Miscelánea Fiscal que define la **contabilidad electrónica**: los XML de catálogo de cuentas, balanza de comprobación y pólizas que el contribuyente entrega al SAT. Hoy mnemosine produce la materia prima (el agrupador por cuenta, el auxiliar con la forma del XC) pero **no genera esos XML**.

**Arrastre de saldos** — Que el saldo final de un periodo sea el saldo inicial del siguiente. Sin arrastre, un periodo empieza en cero y su «saldo» es sólo la actividad del mes, no el acumulado. En mnemosine lo siembra únicamente el **cierre duro**; mientras tanto el auxiliar lo declara con `inicial_confiable`.

**Asiento** — El registro contable de un hecho económico: un conjunto de líneas con cargos y abonos que suman lo mismo. En la base es `journal_entries` con sus `journal_entry_lines`. Ver también *póliza*.

**Auxiliar** — El detalle de **una** cuenta en **un** periodo: saldo inicial, cada movimiento en orden, saldo final. Es la vista que un auditor pide cuando la balanza le sorprende. `mnemosine ledger auxiliary show`.

**Balanza de comprobación** — El listado de todas las cuentas con sus cargos, abonos y saldo a una fecha, con la suma que demuestra que los libros cuadran. Es el primer informe que se mira y el que el Anexo 24 exige en XML.

**CFDI** — *Comprobante Fiscal Digital por Internet*. La factura electrónica mexicana: un XML con estructura fijada por el SAT, firmado por el emisor y **timbrado** por un PAC. Sin timbre no es un comprobante válido. La versión vigente es la 4.0; mnemosine analiza 4.0 y 3.3.

**Cierre suave y cierre duro** — Dos grados de cierre de un periodo fiscal. El **suave** (`soft_close`) impide capturar de rutina pero admite reapertura controlada; el **duro** (`hard_close`) genera los asientos de cierre y siembra los saldos iniciales del periodo siguiente. En mnemosine el duro exige que el periodo esté ya en suave. Los estados posibles son `future`, `open`, `soft_close`, `hard_close` y `locked`.

**CSD** — *Certificado de Sello Digital*. El certificado que el SAT emite para **firmar comprobantes**, y sólo eso. Se distingue de la e.firma por su `keyUsage`: el CSD únicamente firma, la e.firma además cifra. Es la diferencia funcional real y es verificable desde el propio certificado.

**CUCA** — *Cuenta de Capital de Aportación Actualizada*. Registro fiscal del capital que los socios aportaron, actualizado por inflación; determina cuánto puede devolverse sin que se considere dividendo. mnemosine **no la lleva**.

**CUFIN** — *Cuenta de Utilidad Fiscal Neta*. Registro fiscal de las utilidades por las que la empresa ya pagó ISR; los dividendos que salen de ahí no vuelven a causarlo. mnemosine **no la lleva**.

**Devengado vs. flujo** — Las dos bases para reconocer un hecho. **Devengado**: se registra cuando ocurre, aunque no se haya cobrado ni pagado — es la base de los estados financieros bajo NIF. **Flujo de efectivo**: se registra cuando el dinero se mueve. La contabilidad mexicana usa las dos a la vez y en el mismo libro: el ingreso y el gasto se devengan, y el IVA se causa por flujo. De ahí las cuentas de control del IVA aparcado.

**DIOT** — *Declaración Informativa de Operaciones con Terceros*. La declaración mensual donde se reporta el IVA de cada proveedor, uno por uno, con su RFC. mnemosine **no la genera**; sí lista los proveedores sin RFC en el expediente, que son los que la bloquean (`mnemosine vendor list --no-tax-id`).

**e.firma** — El certificado y la llave privada con los que un contribuyente se identifica ante el SAT (antes «FIEL»). No es para facturar sino para **actuar como el contribuyente**: presentar declaraciones, consultar el buzón, pedir la descarga masiva. Perderla o filtrarla es grave. mnemosine la guarda en bóveda cifrada y registra cada acceso; ver [[Seguridad-y-credenciales]].

**IMSS** — *Instituto Mexicano del Seguro Social*. Seguridad social obligatoria: el patrón retiene una parte al trabajador y aporta otra. En la nómina aparece como retención y como gasto patronal, con cuentas por pagar propias.

**INFONAVIT** — El instituto del crédito de vivienda para los trabajadores. Cuando un empleado tiene crédito, el patrón lo **retiene de la nómina y lo entera**, además de su aportación patronal.

**INPC** — *Índice Nacional de Precios al Consumidor*. El índice oficial de inflación. Muchos cálculos fiscales lo usan para actualizar cifras entre dos fechas (ajuste anual por inflación, actualización de saldos a favor, CUFIN y CUCA).

**IVA acreditable** — El IVA que la empresa **pagó** a sus proveedores y puede restar del que trasladó. En el catálogo de referencia es la cuenta 1130. Su pariente `1135 IVA Pendiente de Acreditar` es donde espera el impuesto de una factura PPD que aún no se paga.

**IVA en flujo** — La regla de que el IVA se causa y se acredita cuando el dinero se mueve, no cuando se emite el comprobante (LIVA art. 1-B y art. 5 fr. III). Es la diferencia estructural entre un sistema contable mexicano y uno traducido, y está explicada con ejemplo numérico en [[Fiscal-mexicano]].

**IVA trasladado** — El IVA que la empresa **cobró** a sus clientes y debe enterar al SAT. Cuenta 2120 en el catálogo de referencia. Su pariente `2125 IVA Trasladado No Cobrado` guarda el impuesto de una venta PPD hasta que el cliente paga.

**Mayor** — El libro que agrupa por cuenta todos los movimientos posteados. Es la fuente contra la que se comprueba cualquier informe: si una vista de reportes discrepa del mayor, la que está mal es la vista.

**NIF** — *Normas de Información Financiera*, el marco contable mexicano, emitido por el CINIF. Es el equivalente local de las IFRS o del US GAAP, y no siempre coinciden. En la base, una entidad declara su marco en `accounting_standard` (por ejemplo `mx_nif`), y ese campo es uno de los dos que deciden si a esa entidad le aplica el IVA en flujo — porque esa regla es LIVA, no NIF.

**Nómina** — El cálculo y pago de sueldos, con sus retenciones (ISR, IMSS, INFONAVIT) y su subsidio. En México cada recibo se timbra como un CFDI **tipo N** con complemento Nómina 1.2: el recibo de nómina es una factura.

**PAC** — *Proveedor Autorizado de Certificación*. La empresa que el SAT autoriza para **timbrar** comprobantes. Sin PAC no hay CFDI válido. mnemosine trae cuatro adaptadores y sólo uno no es simulado; el detalle y el cerrojo que impide guardar folios inventados están en [[Fiscal-mexicano]].

**Papel de trabajo** — El documento donde el contador deja escrito cómo llegó a una cifra: el detalle, la fuente y el criterio. No es un informe para terceros sino la evidencia de que el número se puede reconstruir. mnemosine no tiene una superficie con ese nombre; lo más cercano es el rastro del clasificador (`mnemosine cfdi explain`) y la bitácora de auditoría.

**Partida doble** — El principio de que todo hecho económico se registra al menos dos veces, en cargo y en abono, por el mismo importe. Es lo que hace que un asiento «cuadre» y lo que permite detectar un registro incompleto sin saber nada del negocio.

**Póliza** — En el vocabulario mexicano, el documento que contiene uno o varios asientos: póliza de ingresos, de egresos, de diario. Es el término que usan el Anexo 24 y la mayoría de los despachos donde un texto en inglés diría *journal entry*.

**PPD** — *Pago en parcialidades o diferido*. Método de pago de un CFDI que declara que la operación **no** se liquidó al emitir el comprobante. Consecuencia fiscal: el IVA no se causa ni se acredita todavía, y se libera cuando llega el REP de cada parcialidad.

**PUE** — *Pago en una sola exhibición*. Método de pago que declara que la operación se liquidó al emitirse el comprobante. El IVA se causa o se acredita en ese momento, y no hace falta REP.

**REP** — *Recibo Electrónico de Pago*, o complemento de pago: un CFDI **tipo P** que documenta que un dinero se movió y contra qué facturas se aplicó. Es la pieza que libera el IVA aparcado de una operación PPD. Emitirlo cuando cobramos es obligación propia con plazo; recibirlo cuando pagamos es condición para acreditar.

**RESICO** — *Régimen Simplificado de Confianza*. Régimen fiscal con tasas reducidas y obligaciones aligeradas para personas físicas y morales de ingresos acotados. Aparece en el catálogo de regímenes con la clave 626 (y 625 para las actividades empresariales).

**Retención** — Impuesto que una parte descuenta a la otra y entera al SAT en su nombre. Tiene dos caras contables opuestas y por eso hay cuatro roles distintos en el motor: cuando **retenemos** a un proveedor es un pasivo (lo debemos al SAT); cuando **nos retienen** es un activo a favor (ya se pagó por nosotros).

**RFC** — *Registro Federal de Contribuyentes*. La clave fiscal de una persona o empresa en México. Todo CFDI lleva el del emisor y el del receptor, y es lo que decide si un comprobante es nuestro, del otro lado, o **ajeno**.

**SAT** — *Servicio de Administración Tributaria*. La autoridad fiscal federal mexicana: publica los catálogos, autoriza a los PAC, timbra por medio de ellos, y ofrece servicios de consulta —algunos públicos y anónimos, otros que exigen e.firma—.

**Timbrado** — El acto por el que un PAC valida un CFDI ya firmado por el emisor y le agrega el **Timbre Fiscal Digital**: UUID, fecha, sello del SAT y número de certificado. Antes del timbre el XML no es un comprobante fiscal; después, existe ante la autoridad.

**UUID fiscal** — El folio de 36 caracteres que el timbre asigna a un CFDI. Es la identidad del comprobante ante el SAT y la llave con la que todo lo demás se liga: el REP a su factura, el egreso a lo que corrige, la consulta de estatus al documento.

## Vocabulario de mnemosine

**Borrador (*draft*)** — La forma en que el agente **propone**. Un borrador es un asiento completo y validable que existe sin efecto contable hasta que una persona lo aprueba. Es la materialización de la regla de la casa: el agente propone, la persona dispone. Ver [[El-agente-y-sus-limites]].

**Criterio** — Una afirmación **ejecutable** sobre el comportamiento del sistema, escrita como código en [`src/plan/criterios.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/plan/criterios.ts). Dos reglas lo gobiernan: un criterio afirma comportamiento observable, no identificadores —un cerrojo bien construido no puede fallar por haber elegido nombres en español—; y un criterio que no se puede evaluar se declara *no evaluable* y dice por qué, porque un verde inventado hace que un trabajo imposible parezca de una hora. Se corren con `npm run plan:status`. Ver [[El-tablero-y-los-criterios]].

**Entidad (*legal entity*)** — La persona moral o física cuyos libros se llevan: un RFC, un catálogo de cuentas, un calendario fiscal, una moneda funcional. Un inquilino puede tener varias. Casi todo en el motor está delimitado por entidad, empezando por la unicidad del UUID fiscal en el espejo. Ver [[Aislamiento-multi-inquilino]].

**Espejo del CFDI** — La tabla `xml_documents`: la copia local de cada comprobante ingerido, con sus bytes originales, su hash y lo que el analizador extrajo. Se llama espejo porque no es la fuente de verdad —esa es el SAT— sino el reflejo que el sistema consulta. Su unicidad es `(entidad, uuid)`, para que el mismo XML pueda entrar por los dos lados cuando ambas partes son clientes del despacho.

**Fila del catálogo** — Una línea de `docs/cli-command-catalog.md`, el documento de diseño que enumera la superficie completa de comandos que el producto pretende tener. La mayoría de esas filas todavía no son invocables, y esa proporción **no se escribe a mano**: la genera y la verifica `npm run catalogo:estado`. La versión escrita a mano duró cuarenta y dos commits antes de mentir. Ver [[Catalogo-de-comandos]].

**Inquilino (*tenant*)** — El cliente del sistema: un despacho, un grupo, una empresa. Es la frontera de aislamiento más alta, y la impone PostgreSQL con RLS forzada, no el código de la aplicación. Ver [[Aislamiento-multi-inquilino]].

**Modo sombra** — Estado en el que las compuertas de posteo automático **corren completas** y su veredicto se registra en `ai_shadow_verdicts`, pero nada se postea. Sirve para medir qué habría hecho el sistema antes de dejarlo actuar. Sólo lo enciende el panel (`ingest_auto_post = 'shadow'`): no hay bandera ni archivo, porque la sombra es una decisión del despacho y no un ajuste de una corrida.

**Panel de políticas** — El catálogo de todo lo que el sistema **no puede decidir solo** porque depende del criterio del despacho: el umbral de capitalización, el tratamiento de restaurantes, qué hacer con un REP cuyo pago no está registrado, si la ingesta postea sola. Cada entrada declara la pregunta, el impacto, las opciones, el valor que rige mientras nadie conteste y por qué ése. Se consulta y se contesta con `mnemosine pending`. La regla de la casa: una bifurcación de criterio contable no se pregunta en el momento ni se cablea en el código — se añade al panel.

**Suelo (*floor*)** — Los límites duros de seguridad, aplicados **en código** y en el punto de llamada, nunca en el prompt ni en la configuración. La configuración se combina con el suelo mediante `Math.min` —gana el más estricto—, jamás con `Math.max`, de modo que ninguna política guardada, bandera de línea de comandos ni regla futura puede subirlos. Hoy fija tres cosas: el importe máximo que se puede postear sin humano (`FLOOR_MAX_AUTO_POST`), que un borrador sólo se aplica en periodo abierto, y que una operación externa encolada hace más de `FLOOR_MAX_OP_AGE_DAYS` días está caduca y hay que volver a revisarla. Ver [`src/ai/floor.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/floor.ts).

**Trinquete (*ratchet*)** — Un mínimo medido que sólo puede subir. Se usa para que las métricas de calidad no retrocedan en silencio: la cobertura por archivo del motor contable, el tope de avisos de ESLint congelado en lo medido, el estado de los paquetes del plan. Un trinquete convierte «esto empeoró» en una CI roja en vez de en una conversación que nadie tiene.

**Turno correctivo** — El respaldo determinista de la regla que obliga al agente a consultar la documentación antes de afirmar hechos del sistema. Cuando un turno produce una respuesta sustantiva con **cero** llamadas a herramientas y la sesión no ha consultado documentación alguna, el arnés inyecta **un** turno que fuerza al modelo a fundamentarse o a sostener explícitamente una respuesta que no lo necesitaba. Es una sola vez por sesión, no una cola: cierra el peor modo de fallo —contestar de memoria— sin perseguir al modelo en bucle. Se contabiliza como evento, porque cuántas veces contestó de memoria es una métrica de salud del agente. Ver [`src/ai/grounding.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/grounding.ts) y [[El-agente-y-sus-limites]].

---

Relacionado: [[Home]] · [[Fiscal-mexicano]] · [[Arquitectura]] · [[El-agente-y-sus-limites]] · [[Aislamiento-multi-inquilino]] · [[El-tablero-y-los-criterios]] · [[Catalogo-de-comandos]]
