import type { EN } from './en.js';

// ============================================================
// EL CATÁLOGO ESPAÑOL, Y LA PUERTA QUE LO OBLIGA (I6 · issue #148)
//
// `Record<keyof typeof EN, string>` NO ES DECORACIÓN DE TIPOS: es la puerta
// entera del tramo. Una clave que se añade en `en.ts` y se olvida aquí es un
// error de `tsc` —«Property 'x' is missing»— y una clave que sobra aquí
// también lo es, porque la comprobación de propiedades excedentes de un
// literal de objeto contra un tipo mapeado la rechaza. Las dos direcciones,
// sin una sola prueba de por medio y sin esperar a CI: el compilador que ya
// corre antes de cada commit.
//
// POR QUÉ ESTO Y NO UN JSON. Un catálogo en JSON obliga a una prueba que lo
// lea, y esa prueba corre después —y sólo si alguien la corre—. Un `Record`
// tipado falla en el editor, en la tecla siguiente. La sincronía deja de ser
// algo que se vigila y pasa a ser algo que no se puede escribir.
//
// LO QUE `tsc` NO VE, y por eso existe `tests/i18n/sync.spec.ts`: que los
// PARÁMETROS sean los mismos en los dos idiomas (un `{command}` traducido a
// `{comando}` compila igual de bien y sale vacío en pantalla), que las ramas de
// un `select` coincidan, que ninguna cadena esté vacía, que ninguna sea la
// inglesa copiada sin traducir, y que no quede ningún `__TRANSLATE__` dentro.
//
// EL ESPAÑOL DE AQUÍ ES EL QUE EL CLI YA IMPRIME, palabra por palabra, con su
// archivo y su renglón en `en.ts`. No es una traducción nueva: es la que hay,
// mudada a una clave.
// ============================================================

export const ES: Record<keyof typeof EN, string> = {
  // ==== error.* — mensajes de los errores de la API y los servicios (I9) ====
  'error.PERIOD_ALREADY_OPEN': '{period} ya está abierto.',
  // ==== fin de error.* ================================================

  // ==== policy.* — the policy panel, by key (I10 · #152); see en.ts ====
  'policy.non_mexican_entity_chart.question':
    '¿Qué catálogo de cuentas recibe una entidad que no lleva contabilidad mexicana?',
  'policy.non_mexican_entity_chart.impact':
    'Decide con qué nace una entidad extranjera. El catálogo de la casa la deja contabilizando desde el primer día; sin catálogo base se queda con las cuentas de rol de CFDI y los renglones de mapeo de nómina y nada más, y hasta que importe el suyo cada factura falla con MISSING_ROLE_ACCOUNT y la primera corrida de nómina también, porque los roles y los grupos que piden banco, clientes, proveedores o ingresos no tienen a qué cuenta apuntar.',
  'policy.non_mexican_entity_chart.rationale':
    'Una entidad que puede contabilizar el primer día es mejor que una que no puede. El andamiaje universal es partida doble, no algo mexicano, así que sirve en cualquier país; importar un catálogo después sigue funcionando y nunca sobrescribe lo que eligió el despacho.',
  'policy.non_mexican_entity_chart.why':
    'Tu subsidiaria extranjera puede empezar con el mismo catálogo que usan tus entidades mexicanas —sin las cuentas de IVA, ISR y retenciones, que nunca va a usar— o puede empezar sin ese catálogo porque piensas traer el que ya tiene desde otro sistema. Las dos son defendibles; cuál es la correcta depende de si esa entidad ya lleva su contabilidad en otro lado.',
  'policy.non_mexican_entity_chart.what':
    'Con el catálogo de la casa siembro las cuentas universales más una cuenta genérica de banco y de impuesto sobre ventas, así que facturas, cuentas por pagar y pagos se contabilizan de inmediato. Sin catálogo base me salto ESE catálogo y nada más: la entidad nace igual con las cuentas de rol de CFDI y los renglones de mapeo de nómina, así que «sin catálogo» no quiere decir una entidad vacía; cuenta con unas dieciséis cuentas. Lo que no recibe es todo lo que trae el catálogo base: banco, clientes, proveedores, ingresos. Cada factura falla con MISSING_ROLE_ACCOUNT hasta que llegue la importación, y también la primera corrida de nómina: el grupo cash_payroll es obligatorio y apunta a una cuenta de banco (1111 en México, 1115 en el catálogo neutro) que sólo crea el catálogo base, y por eso `entity create` avisa de ella por su nombre. `mnemosine doctor` lista los roles sin cuenta, para que sepas qué le falta todavía a la importación.',
  'policy.non_mexican_entity_chart.if_skipped':
    'Las entidades extranjeras reciben el catálogo de la casa. Si ibas a importar su catálogo real, tendrás unas cuantas cuentas sin uso que desactivar.',
  'policy.non_mexican_entity_chart.option.base_neutro':
    'El catálogo de la casa sin el estrato fiscal mexicano (en su lugar, banco e impuesto sobre ventas genéricos)',
  'policy.non_mexican_entity_chart.option.ninguno':
    'Sin catálogo base: la entidad importa el suyo (las cuentas de rol y de nómina se crean igual)',

  'policy.depreciation_basis.question':
    '¿Qué depreciación mueve el gasto que contabilizas: la vida útil contable o la tasa fiscal?',
  'policy.depreciation_basis.impact':
    'Gobierna `depreciation run`. Con «vida_util_nif» el gasto mensual sigue la vida útil que fijas para cada activo (NIF C-6). Con «tasa_lisr» sigue la tasa fiscal guardada en cada activo, como máximo la de su clase (arts. 34-35 LISR), que es lo que registran la mayoría de las pymes mexicanas para que la contabilidad y la deducción no se separen. Se calcula y se contabiliza UN solo calendario: la otra base no se lleva en paralelo. Un activo sin tasa fiscal guardada (dado de alta antes de que existieran las tasas) sigue corriendo con su vida útil con cualquiera de las dos respuestas. Un activo que ya contabilizó renglones nunca cambia de base: si cambias esta respuesta, la corrida rechaza ese activo y dice por qué, en vez de depreciarlo con la otra base.',
  'policy.depreciation_basis.rationale':
    'Es lo que se supone que muestran los estados financieros, y es la columna que el motor ya usaba. Elegir la tasa fiscal es una simplificación legítima, pero hay que elegirla.',
  'policy.depreciation_basis.why':
    'Una máquina que esperas usar diez años se puede deducir más rápido o más despacio, según la regla que sigas. Las dos respuestas son defendibles y contabilizan importes distintos cada mes; por eso es criterio de tu despacho, no algo que yo pueda consultar.',
  'policy.depreciation_basis.what':
    'Calculo el gasto mensual con la base que elijas y anoto cuál usé en cada renglón del calendario, para que una corrida posterior pueda demostrar que conservó el mismo criterio. Si algún día cambias, los renglones ya contabilizados siguen diciendo lo que fueron.',
  'policy.depreciation_basis.if_skipped':
    'Uso la vida útil contable. Tu deducción puede entonces diferir del gasto registrado, lo cual es normal pero exige una conciliación al cierre del ejercicio.',
  'policy.depreciation_basis.option.vida_util_nif':
    'Contable: la vida útil que le asignaste al activo (NIF C-6)',
  'policy.depreciation_basis.option.tasa_lisr':
    'Fiscal: la tasa de la LISR guardada en el activo, como máximo la de su clase, para que libros y deducción coincidan',

  'policy.first_month_convention.question':
    'Un activo comprado a mediados de mes: ¿se deprecia el mes completo o sólo los días que se tuvo?',
  'policy.first_month_convention.impact':
    'Gobierna el primer y el último importe de cada activo. «mes_completo» carga el mes completo de la fecha de inicio de uso; «proporcional_dias» carga sólo los días que se tuvo y pasa el resto al último mes. A lo largo de la vida del activo el total es idéntico; lo que cambia es qué periodo lo carga y, por lo tanto, cada resultado mensual intermedio.',
  'policy.first_month_convention.rationale':
    'Es lo que cuenta la ley del impuesto sobre la renta, es más fácil de auditar y evita un importe parcial que nadie puede reproducir un año después sin conocer el día exacto de la compra.',
  'policy.first_month_convention.why':
    'Compras una máquina el día 20. Cargar el mes completo sobreestima un poco ese mes; cargar once días lo subestima y deja un remanente al final. Ninguna es incorrecta: tu despacho elige una y se queda con ella.',
  'policy.first_month_convention.what':
    'Aplico la convención que elijas al primer y al último mes de cada activo, y la anoto en el renglón del calendario para que el importe se pueda reproducir.',
  'policy.first_month_convention.if_skipped':
    'Cargo el mes completo, que coincide con cómo cuenta la ley fiscal y es la más fácil de defender de las dos.',
  'policy.first_month_convention.option.mes_completo':
    'Mes completo desde el mes en que empezó a usarse (la LISR cuenta meses completos)',
  'policy.first_month_convention.option.proporcional_dias':
    'En proporción a los días que se tuvo en el primer y el último mes',

  'policy.depreciation_missing_at_close.question':
    'Cerrar un mes con activos cuya depreciación nunca se corrió: ¿avisar o rechazar?',
  'policy.depreciation_missing_at_close.impact':
    'Gobierna el punto «Depreciación calculada y contabilizada» de la lista de verificación del cierre. Con «avisar» el mes cierra y la lista dice qué falta; con «bloquear» se rechaza el cierre hasta que se haga la corrida. Un mes cerrado sin depreciación sobreestima la utilidad y el activo, y el error se acumula porque el mes siguiente parte de un valor en libros equivocado.',
  'policy.depreciation_missing_at_close.rationale':
    'El mismo valor por omisión que las otras dos compuertas de cierre de este panel, y por la misma razón: un bloqueo duro sobre un control que apenas empieza a producir datos atoraría el primer cierre después de que salga esta función. Actívalo cuando la corrida ya sea parte de tu rutina.',
  'policy.depreciation_missing_at_close.why':
    'Olvidar la corrida de depreciación es la forma más fácil de cerrar un mes que se ve mejor de lo que fue y, a diferencia de casi cualquier error, no se corrige solo: el mes siguiente parte de un valor en libros demasiado alto.',
  'policy.depreciation_missing_at_close.what':
    'Cuento los activos vigentes sin depreciación contabilizada en el periodo y te aviso o rechazo el cierre, como elijas. En los dos casos la lista de verificación los nombra.',
  'policy.depreciation_missing_at_close.if_skipped':
    'Aviso pero dejo cerrar el mes, para que el primer mes después de que salga esta función no se atore.',
  'policy.depreciation_missing_at_close.option.avisar':
    'Avisar: el mes cierra y la lista de verificación nombra lo que falta',
  'policy.depreciation_missing_at_close.option.bloquear':
    'Rechazar: ningún mes cierra con depreciación pendiente',

  'policy.capitalization_threshold_mxn.question':
    '¿A partir de qué importe una partida se capitaliza como activo fijo en vez de ir a gasto?',
  'policy.capitalization_threshold_mxn.impact':
    'Determina cuándo el sistema pregunta «gasto o activo fijo» al cargar un CFDI. Un umbral bajo interrumpe seguido; uno alto capitaliza menos de lo que debería. También afecta la depreciación futura.',
  'policy.capitalization_threshold_mxn.rationale':
    'Es el umbral más común en la práctica mexicana. No es una regla legal: es política interna.',
  'policy.capitalization_threshold_mxn.why':
    'Cuando llega una factura de equipo tengo que decidir si es gasto de este mes o un activo que se deprecia a lo largo de años. Esa línea es política de tu empresa, no una regla del SAT: la ley fija tasas de depreciación, no el umbral para capitalizar.',
  'policy.capitalization_threshold_mxn.what':
    'Por encima de ese importe me detengo y te pregunto caso por caso en vez de decidir solo. Por debajo, lo registro como gasto sin interrumpirte.',
  'policy.capitalization_threshold_mxn.if_skipped':
    'Sigo preguntando a partir de $20,000, lo que puede interrumpirte más (o menos) de lo que quieres.',
  'policy.capitalization_threshold_mxn.option.5000':
    '$5,000 — conservador, capitaliza casi todo el equipo',
  'policy.capitalization_threshold_mxn.option.20000':
    '$20,000 — común en las pymes mexicanas',
  'policy.capitalization_threshold_mxn.option.50000':
    '$50,000 — sólo inversiones significativas',

  'policy.restaurant_meal_treatment.question':
    'Consumos en restaurantes (deducibles al 8.5%): ¿cómo se registran?',
  'policy.restaurant_meal_treatment.impact':
    'Define si el sistema divide cada consumo en dos renglones (deducible / no deducible) o manda todo a no deducible y el ajuste se hace en la declaración. Afecta la conciliación contable-fiscal.',
  'policy.restaurant_meal_treatment.rationale':
    'Mantiene los libros alineados con la deducción real sin trabajo extra al cierre.',
  'policy.restaurant_meal_treatment.why':
    'La ley del impuesto sobre la renta sólo te deja deducir el 8.5% de los consumos en restaurantes. El otro 91.5% es un gasto real pero no deducible, y mezclarlos complica la conciliación fiscal al cierre del ejercicio.',
  'policy.restaurant_meal_treatment.what':
    'Divido cada factura de restaurante en dos renglones —deducible y no deducible— o la mando completa a no deducible, lo que elijas.',
  'policy.restaurant_meal_treatment.if_skipped':
    'Divido 8.5/91.5, lo que mantiene los libros alineados pero añade un renglón a cada consumo.',
  'policy.restaurant_meal_treatment.option.split_85':
    'Dividir en la póliza 8.5% deducible / 91.5% no deducible',
  'policy.restaurant_meal_treatment.option.no_deducible':
    'Todo a no deducible; se ajusta en la declaración',

  'policy.ieps_treatment.question':
    '¿La empresa es contribuyente del IEPS y lo traslada?',
  'policy.ieps_treatment.impact':
    'Si no lo es, el IEPS que le trasladan forma parte del costo. Si lo es, es acreditable. Determina la cuenta de cada compra con IEPS (combustible, bebidas, tabaco).',
  'policy.ieps_treatment.rationale':
    'La mayoría de las empresas no son contribuyentes del IEPS (LIEPS art. 4).',
  'policy.ieps_treatment.why':
    'El IEPS sólo es acreditable si tu empresa es contribuyente de ese impuesto y lo traslada. Para todos los demás forma parte del costo de los bienes. Por la factura no puedo saber en qué caso estás.',
  'policy.ieps_treatment.what':
    'Decide la cuenta de cada compra que lleva IEPS: combustible, bebidas, tabaco.',
  'policy.ieps_treatment.if_skipped':
    'Lo trato como costo, lo que es correcto para la mayoría de las empresas pero subestima tu impuesto acreditable si eres contribuyente del IEPS.',
  'policy.ieps_treatment.option.costo':
    'No es contribuyente: el IEPS forma parte del costo',
  'policy.ieps_treatment.option.acreditable':
    'Es contribuyente: el IEPS es acreditable',

  'policy.fees_without_withholding.question':
    'Una persona física (régimen 612) le factura servicios profesionales a tu empresa y el CFDI no declara ISR retenido. ¿Qué pasa?',
  'policy.fees_without_withholding.impact':
    'Gobierna los CFDI recibidos de una persona física del régimen 612 cuyos conceptos son todos servicios profesionales (legales, consultoría, contabilidad, ingeniería, desarrollo de software, médicos): una compra de bienes, o un CFDI con algún concepto que no sea uno de esos servicios, nunca se toma por honorarios. «request_substitute_cfdi» deja el CFDI en espera en la bandeja, no escribe nada en el mayor y dice que se le pida al proveedor un CFDI sustituto con la retención. «withhold_by_law» calcula el 10 % de ISR y las dos terceras partes del IVA con legal_parameters y deja esa póliza en revisión. «record_as_issued» contabiliza el CFDI tal como viene, sin retención, y la lista de verificación del cierre lo muestra en honorarios sin retención.',
  'policy.fees_without_withholding.rationale':
    'Una persona moral que paga honorarios sin retener es responsable solidaria del impuesto (CFF 26-I) y el gasto puede no ser deducible (LISR 27-V). El CFDI es de un tercero: el remedio limpio es un sustituto del proveedor, y no se registra nada sobre una cifra que va a cambiar.',
  'policy.fees_without_withholding.why':
    'Cuando tu empresa le paga servicios profesionales a una persona física tiene que retener parte del ISR y del IVA. Si la factura no muestra la retención, o el proveedor se equivocó o el pago se va a hacer completo. Esperar una factura corregida, retener de todos modos o registrarla como vino es decisión de tu despacho.',
  'policy.fees_without_withholding.what':
    'Por omisión dejo la factura en espera y te digo que le pidas un sustituto al proveedor. Con «withhold_by_law» propongo la póliza con la retención que exige la ley y la dejo para que la revises. Con «record_as_issued» la contabilizo como vino y la listo en la lista de verificación del cierre.',
  'policy.fees_without_withholding.if_skipped':
    'Dejo esas facturas en espera hasta que llegue un CFDI sustituto con la retención: nada llega a tus libros.',
  'policy.fees_without_withholding.option.request_substitute_cfdi':
    'Dejarlo en espera y pedirle al proveedor un CFDI sustituto con la retención',
  'policy.fees_without_withholding.option.withhold_by_law':
    'Calcular la retención de ley y dejar la póliza en revisión',
  'policy.fees_without_withholding.option.record_as_issued':
    'Registrarlo como se emitió, con un aviso en la lista de verificación del cierre',

  'policy.inventory_method.question':
    '¿La empresa lleva inventarios perpetuos?',
  'policy.inventory_method.impact':
    'Si los lleva, las compras de mercancía van a inventario y el costo se reconoce al vender. Si no, van directo a costo. Cambia la póliza de cada compra de mercancía o materia prima.',
  'policy.inventory_method.rationale':
    'Mientras no se defina se pregunta caso por caso; el valor por omisión evita inventar inventarios.',
  'policy.inventory_method.why':
    'Si llevas inventarios perpetuos, una compra de mercancía va a inventario y el costo se reconoce cuando vendes. Si no, va directo a costo de ventas. La factura se ve idéntica en los dos casos.',
  'policy.inventory_method.what':
    'Cambia la póliza de cada compra de mercancía o materia prima.',
  'policy.inventory_method.if_skipped':
    'Te pregunto caso por caso en cada compra de mercancía, lo que es seguro pero repetitivo.',
  'policy.inventory_method.option.perpetuos':
    'Sí: compras a inventario, costo al vender',
  'policy.inventory_method.option.directo':
    'No: compras directo a costo de ventas',

  'policy.cfdi_from_closed_period.question':
    'Un CFDI de un periodo ya cerrado: ¿en qué periodo se registra?',
  'policy.cfdi_from_closed_period.impact':
    'Define si el sistema propone el periodo abierto actual o marca el documento para reabrir el periodo original. Afecta la comparabilidad de los estados financieros.',
  'policy.cfdi_from_closed_period.rationale':
    'Sin política definida, cada caso se escala en vez de suponerse.',
  'policy.cfdi_from_closed_period.why':
    'Una factura de diciembre que llega en febrero no tiene un lugar obvio: registrarla en el periodo cerrado rompe la comparabilidad, registrarla hoy distorsiona el mes en curso. Cada despacho lo resuelve distinto.',
  'policy.cfdi_from_closed_period.what':
    'Decide si propongo el periodo abierto actual, marco el documento para reabrir el original o te pregunto cada vez.',
  'policy.cfdi_from_closed_period.if_skipped':
    'Te pregunto cada vez, que es el valor por omisión más seguro pero el que más interrumpe.',
  'policy.cfdi_from_closed_period.option.periodo_actual':
    'Registrar en el periodo abierto actual',
  'policy.cfdi_from_closed_period.option.preguntar':
    'Preguntar caso por caso',
  'policy.cfdi_from_closed_period.option.reabrir':
    'Reabrir el periodo original (requiere autorización)',

  'policy.cfdi_reconciliation_tolerance.question':
    'Cuando un borrador aprobado se coteja contra su CFDI, ¿cuánta diferencia por cifra sigue contando como redondeo?',
  'policy.cfdi_reconciliation_tolerance.impact':
    'Aprobar el borrador de un CFDI recibido crea la cuenta por pagar, y la póliza aprobada tiene que coincidir con el XML cifra por cifra: total, IVA trasladado, cada retención y subtotal menos descuento. Una diferencia dentro de la tolerancia pasa; una mayor deshace la aprobación completa y nombra la cifra. La diferencia nunca se absorbe moviendo centavos a otra cuenta.',
  'policy.cfdi_reconciliation_tolerance.rationale':
    'El SAT acepta diferencias de redondeo en los impuestos por concepto (Anexo 20), y un centavo por cifra es lo que produce ese redondeo. Más de un centavo no es redondeo: es otro importe distinto del que ampara el CFDI (CFF 29 y 29-A; LIVA art. 5 fracc. II y III).',
  'policy.cfdi_reconciliation_tolerance.why':
    'Cuando apruebas la póliza de una factura de proveedor, la cotejo contra el XML. Necesito saber cuánto redondeo aceptas antes de rechazarla.',
  'policy.cfdi_reconciliation_tolerance.what':
    'Dentro de la tolerancia creo la cuenta por pagar y contabilizo la póliza. Fuera de ella rechazo la aprobación y te digo qué cifra no cuadra y por cuánto.',
  'policy.cfdi_reconciliation_tolerance.if_skipped':
    'Acepto un centavo por cifra.',
  'policy.cfdi_reconciliation_tolerance.option.0_01':
    'Un centavo por cifra — sólo redondeo verdadero',
  'policy.cfdi_reconciliation_tolerance.option.0':
    'Coincidencia exacta o nada',

  'policy.bill_lines_source.question':
    'Cuando un borrador aprobado crea la cuenta por pagar, ¿de dónde salen sus renglones?',
  'policy.bill_lines_source.impact':
    'El encabezado de la cuenta por pagar (subtotal, impuestos, total) siempre sale del CFDI. Esto decide los renglones: tu propia codificación en la póliza aprobada, o un renglón por concepto del CFDI. Los conceptos sólo toman cuenta cuando la póliza se divide uno a uno con ellos; si no, la aprobación se rechaza, nunca se prorratea.',
  'policy.bill_lines_source.rationale':
    'A qué cuentas va un gasto es una decisión interna de quien lo registra: varios conceptos pueden ir a una cuenta, o un concepto puede dividirse. La póliza aprobada ya guarda esa decisión, y la cuenta por pagar debe reflejarla en vez de imponer al mayor la redacción del proveedor.',
  'policy.bill_lines_source.why':
    'Algunos despachos quieren que la cuenta por pagar se lea como la factura del proveedor, concepto por concepto; otros quieren que siga cómo codificaron el gasto.',
  'policy.bill_lines_source.what':
    'Por omisión cada cargo no fiscal de la póliza que aprobaste se vuelve un renglón de la cuenta por pagar. Con «conceptos_cfdi» copio los conceptos y rechazo cuando tu póliza no se divide igual.',
  'policy.bill_lines_source.if_skipped':
    'Los renglones de la cuenta por pagar siguen la póliza que aprobaste.',
  'policy.bill_lines_source.option.poliza':
    'Un renglón por cada cargo no fiscal de la póliza aprobada, con su cuenta y su importe',
  'policy.bill_lines_source.option.conceptos_cfdi':
    'Un renglón por concepto del CFDI (descripción, cantidad, clave SAT); se rechaza si la póliza no se divide uno a uno',

  'policy.unknown_vendor_on_approval.question':
    'Cuando apruebas el borrador de un CFDI recibido cuyo emisor no está en el catálogo de proveedores, ¿qué pasa?',
  'policy.unknown_vendor_on_approval.impact':
    'Aprobar crea la cuenta por pagar, y una cuenta por pagar necesita un proveedor dado de alta. Darlo de alta crea una contraparte con el nombre y el RFC escritos dentro del XML de un tercero. O se rechaza la aprobación hasta que alguien dé de alta al proveedor, o `mnemosine review` te pregunta, y tu sí da de alta al proveedor, la cuenta por pagar y la póliza en una sola transacción.',
  'policy.unknown_vendor_on_approval.rationale':
    'Es la regla que ya sigue `bill inbox run`: no se crea ningún proveedor sin un acto explícito de una persona, y aprobar una póliza no es, por sí solo, aprobar datos maestros nuevos.',
  'policy.unknown_vendor_on_approval.why':
    'Algunos despachos dan de alta a propósito a cada proveedor antes de registrar nada; otros prefieren confirmar un proveedor nuevo mientras revisan su primera factura.',
  'policy.unknown_vendor_on_approval.what':
    'Por omisión rechazo la aprobación, no se contabiliza nada y te digo el comando que da de alta al proveedor. Con «preguntar», la revisión te pregunta, y sólo tu sí crea al proveedor.',
  'policy.unknown_vendor_on_approval.if_skipped':
    'Rechazo la aprobación hasta que el proveedor esté dado de alta.',
  'policy.unknown_vendor_on_approval.option.rechazar':
    'Rechazar la aprobación y nombrar el comando que da de alta al proveedor',
  'policy.unknown_vendor_on_approval.option.preguntar':
    'Preguntar en `mnemosine review` si se da de alta al proveedor; un no quiere decir rechazar',

  'policy.rep_payment_not_recorded.question':
    'Llega un complemento de pago (REP) y no hay un pago registrado que le corresponda: ¿qué pasa?',
  'policy.rep_payment_not_recorded.impact':
    'Decide si cargar un REP puede mover dinero por su cuenta. Crear el pago es lo que libera el IVA pendiente, porque la liberación cuelga de las aplicaciones del pago; pero también quiere decir que el sistema mueve el banco sin que una persona lo haya registrado.',
  'policy.rep_payment_not_recorded.rationale':
    'El REP es prueba documental de que el dinero ya se movió: trae la fecha y la forma de pago. Crear el pago lo hace pasar por la única puerta que además libera el IVA. Una tercera opción —contabilizar el efectivo directo, sin registro de pago— NO se ofrece a propósito: es lo que registra dos veces el movimiento del banco cuando el pago también se capturó a mano, y deja el IVA pendiente para siempre. No hay comportamiento anterior con el cual ser compatible, porque esta puerta nunca funcionó: un CFDI de tipo P moría con UNSUPPORTED_TYPE antes de llegar a contabilizarse.',
  'policy.rep_payment_not_recorded.why':
    'Cuando tu proveedor manda el complemento de una factura que pagaste, puedo tomarlo como el registro de ese pago o esperar a que alguien lo confirme. Los despachos que capturan los movimientos del banco a diario quieren confirmar; los que registran directo desde los CFDI quieren que lo tome.',
  'policy.rep_payment_not_recorded.what':
    'Con «crear_pago» registro el pago y lo aplico a las facturas que nombra el complemento, que es lo que me deja acreditar el IVA que estaba esperando. Con «revision» archivo el complemento y te pregunto.',
  'policy.rep_payment_not_recorded.if_skipped':
    'Creo el pago. Si también capturas pagos a mano, dímelo; si no, podríamos terminar con el mismo pago dos veces.',
  'policy.rep_payment_not_recorded.option.crear_pago':
    'Crear el pago y aplicarlo a cada documento relacionado',
  'policy.rep_payment_not_recorded.option.revision':
    'Registrar el complemento y dejar el vínculo para que una persona lo confirme',

  'policy.rep_amount_tolerance.question':
    '¿Cuánta diferencia entre el complemento y el pago registrado sigue contando como redondeo?',
  'policy.rep_amount_tolerance.impact':
    'Se usa dos veces: para decidir si un pago capturado a mano es el mismo evento que el complemento, y para comparar el IVA que declara el complemento (ImpuestosDR) contra el prorrateo sobre la factura. Fuera de ella, el complemento va a revisión: casar un pago que no es el mismo acredita IVA por un importe distinto del que de verdad se pagó.',
  'policy.rep_amount_tolerance.rationale':
    'La comparación se hace por documento relacionado, no complemento contra pago, y el prorrateo del IVA ya liquida su remanente en la última parcialidad. Una diferencia mayor a un centavo no es redondeo: es otra parcialidad, otro tipo de cambio u otro pago.',
  'policy.rep_amount_tolerance.why':
    'Los complementos y tus propios registros rara vez difieren, pero cuando lo hacen importa si es un centavo de redondeo o un pago completamente distinto.',
  'policy.rep_amount_tolerance.what':
    'Dentro de la tolerancia los caso. Fuera de ella dejo el complemento para que lo revises.',
  'policy.rep_amount_tolerance.if_skipped':
    'Acepto un centavo.',
  'policy.rep_amount_tolerance.option.0_01':
    'Un centavo — sólo redondeo verdadero',
  'policy.rep_amount_tolerance.option.1_00':
    'Un peso',
  'policy.rep_amount_tolerance.option.0':
    'Coincidencia exacta o nada',

  'policy.rep_unknown_document.question':
    'El complemento nombra una factura que el sistema no tiene: ¿qué pasa con ese IVA?',
  'policy.rep_unknown_document.impact':
    'Sin la factura original no hay base para prorratear el IVA de esa parcialidad. Decide si el impuesto espera, se omite con un aviso o se pregunta.',
  'policy.rep_unknown_document.rationale':
    'Las descargas masivas del SAT llegan en desorden, así que un complemento que llega antes que su factura es normal, no excepcional. El IVA no se pierde: se queda pendiente, que es justo donde lo quiere el art. 5 fracc. III de la LIVA hasta que un documento lo ampare. Cuando el complemento SÍ trae ImpuestosDR, esa cifra se coteja contra el prorrateo sobre la factura original: si difieren más allá de la tolerancia, el complemento va a revisión en vez de liberar cualquiera de las dos cifras en silencio.',
  'policy.rep_unknown_document.why':
    'Los complementos suelen llegar antes que la factura a la que se refieren. Puedo dejar pendiente el traslado del impuesto hasta que aparezca la factura, o seguir sin él.',
  'policy.rep_unknown_document.what':
    'Por omisión espero, y el vínculo se resuelve solo el día que se carga la factura.',
  'policy.rep_unknown_document.if_skipped':
    'Espero. No se pierde nada: el impuesto se queda donde estaba.',
  'policy.rep_unknown_document.option.esperar':
    'Esperar: registrar el vínculo pendiente y no trasladar IVA de ese documento',
  'policy.rep_unknown_document.option.postear_sin_iva':
    'Casar el efectivo y dejar el IVA sin trasladar, con un aviso',
  'policy.rep_unknown_document.option.preguntar':
    'Preguntar el importe del IVA',

  'policy.rep_match_window_days.question':
    '¿Cuántos días de diferencia puede haber entre la fecha del complemento y la del pago registrado para que sigan siendo el mismo evento?',
  'policy.rep_match_window_days.impact':
    'Una ventana demasiado estrecha produce falsos negativos, y un falso negativo termina en un pago duplicado, que es justo el daño que el cotejo existe para evitar.',
  'policy.rep_match_window_days.rationale':
    'La fecha es una heurística de cotejo, no un hecho fiscal: lo que revisa el SAT son los importes y la cadena de parcialidades. Los pagos capturados a mano suelen llevar la fecha del estado de cuenta y no la fecha valor, y tres días cubren esa brecha sin abarcar dos parcialidades del mismo documento.',
  'policy.rep_match_window_days.why':
    'Tus registros y el complemento rara vez traen exactamente la misma fecha. ¿Qué tan separadas pueden estar antes de que deje de suponer que son el mismo pago?',
  'policy.rep_match_window_days.what':
    'Dentro de la ventana los considero el mismo evento y los vinculo en vez de crear un segundo pago.',
  'policy.rep_match_window_days.if_skipped':
    'Acepto tres días.',
  'policy.rep_match_window_days.option.0':
    'Exactamente el mismo día',
  'policy.rep_match_window_days.option.3':
    'Tres días naturales',
  'policy.rep_match_window_days.option.15':
    'Quince días, para captura mensual',

  'policy.prepaid_amortization_convention.question':
    'Un pago anticipado que empieza a mediados de mes: ¿el primer mes se devenga completo o sólo por los días que cubre?',
  'policy.prepaid_amortization_convention.impact':
    'Fija cada mes del calendario. Una póliza de seguro del 20 de marzo al 19 de marzo se devenga en 12 meses con una convención y en 13 con la otra, y el último mes del ejercicio cambia.',
  'policy.prepaid_amortization_convention.rationale':
    'Es lo que de verdad dice el postulado de devengación de la NIF A-2 —el gasto pertenece al periodo que consumió el servicio— y es la única convención que mantiene el calendario atado a las fechas del contrato y no al calendario. Los despachos que prefieren meses completos por sencillez pueden decirlo aquí, pero el valor por omisión debe ser el correcto y no el fácil.',
  'policy.prepaid_amortization_convention.why':
    'Tu seguro empieza el día 20, no el 1. Por días se reparte en trece meses de calendario y por meses completos en doce, así que la elección cambia qué mes carga el gasto y qué muestra el último mes del año.',
  'policy.prepaid_amortization_convention.what':
    'Devengo los días que de verdad cubre cada mes.',
  'policy.prepaid_amortization_convention.if_skipped':
    'Devengo por días.',
  'policy.prepaid_amortization_convention.option.proporcional_dias':
    'Por días: el primer y el último mes sólo devengan los días cubiertos',
  'policy.prepaid_amortization_convention.option.meses_completos':
    'Meses completos: el mes inicial devenga completo y el último no',

  'policy.prepaid_amortization_missing_at_close.question':
    'Cerrar un mes con calendarios de pagos anticipados cuya amortización nunca se corrió: ¿avisar o rechazar?',
  'policy.prepaid_amortization_missing_at_close.impact':
    'Un calendario sin correr quiere decir que falta el gasto de ese mes y que el activo está sobreestimado por el mismo importe. Es exactamente la forma del defecto que este sistema ya corrigió para la depreciación.',
  'policy.prepaid_amortization_missing_at_close.rationale':
    'Es la misma respuesta que el despacho ya tiene para la depreciación, y aquí la coherencia entre dos situaciones idénticas importa más que la elección misma: una lista de verificación en la que un devengo bloquea y el otro avisa no le enseña nada a nadie.',
  'policy.prepaid_amortization_missing_at_close.why':
    'Si un calendario nunca se corrió, al mes que estás cerrando le falta ese gasto y el pago anticipado está sobreestimado por el mismo importe; y lo firmarías de todos modos.',
  'policy.prepaid_amortization_missing_at_close.what':
    'Lo señalo en la lista de verificación del cierre y te dejo decidir.',
  'policy.prepaid_amortization_missing_at_close.if_skipped':
    'Aviso.',
  'policy.prepaid_amortization_missing_at_close.option.avisar':
    'Avisar: el punto de la lista de verificación se pone en rojo y el cierre sigue',
  'policy.prepaid_amortization_missing_at_close.option.bloquear':
    'Rechazar: el periodo no cierra hasta que se corra cada calendario',

  'policy.prepaid_threshold_mxn.question':
    '¿Por encima de qué importe un gasto de varios periodos se difiere a pagos anticipados en vez de ir a gasto de una vez?',
  'policy.prepaid_threshold_mxn.impact':
    'Por debajo del umbral el importe completo pega en el mes en que se pagó; por encima, se crea un calendario y el gasto se reparte. `prepaid create` lee tu respuesta y se detiene por debajo de ella salvo que pases --force con un motivo. Al cargar, el clasificador de CFDI también compara contra tu respuesta: sólo ofrece diferir importes iguales o mayores (5,000 MXN hasta que respondas).',
  'policy.prepaid_threshold_mxn.rationale':
    'Importancia relativa (NIF A-4): una suscripción anual de 900 pesos partida en doce pólizas de 75 cuesta más en registro que la precisión que compra, y llena el calendario de renglones que nadie va a revisar. Cinco mil es el orden de magnitud en el que la división empieza a pagarse sola.',
  'policy.prepaid_threshold_mxn.why':
    'No toda suscripción anual vale la pena repartirla en doce meses; tú decides dónde está la línea.',
  'policy.prepaid_threshold_mxn.what':
    'Ofrezco diferir los gastos de varios periodos iguales o mayores a tu umbral (5,000 MXN por omisión) y mando a gasto el resto conforme llegan.',
  'policy.prepaid_threshold_mxn.if_skipped':
    'Uso 5,000 MXN.',
  'policy.prepaid_threshold_mxn.option.0':
    'Sin umbral: diferir todo gasto de varios periodos',
  'policy.prepaid_threshold_mxn.option.5000':
    '5,000 MXN',
  'policy.prepaid_threshold_mxn.option.20000':
    '20,000 MXN',

  'policy.benefit_accrual_wage_base.question':
    '¿Qué salario diario usa como base la provisión mensual de prestaciones?',
  'policy.benefit_accrual_wage_base.impact':
    'Fija el importe de cada devengo de aguinaldo, vacaciones y prima vacacional. El salario integrado es mayor que el nominal, así que la elección mueve la provisión —y la utilidad reportada— cada mes.',
  'policy.benefit_accrual_wage_base.rationale':
    'El salario nominal es la cifra que el despacho de verdad pactó y la que ya tiene la nómina. El SDI es una base de SEGURIDAD SOCIAL (LSS art. 27) hecha para calcular cuotas, y tomarlo prestado para un devengo de la NIF D-3 mete una convención fiscal en una cifra de información financiera. El despacho que lo quiera lo declara; el sistema no infla un pasivo por su cuenta.',
  'policy.benefit_accrual_wage_base.why':
    'El salario nominal y el integrado dan provisiones distintas, y las dos son defendibles. Sólo tu despacho sabe qué convención sigue.',
  'policy.benefit_accrual_wage_base.what':
    'Devengo las prestaciones sobre el salario diario nominal.',
  'policy.benefit_accrual_wage_base.if_skipped':
    'Uso el salario diario nominal.',
  'policy.benefit_accrual_wage_base.option.nominal':
    'Salario diario nominal — lo que dice el contrato',
  'policy.benefit_accrual_wage_base.option.integrado':
    'Salario diario integrado (SDI) — incluye las prestaciones que integra el art. 84 de la LFT',

  'policy.vacation_accrual_timing.question':
    '¿Cuándo se reconoce el pasivo de vacaciones?',
  'policy.vacation_accrual_timing.impact':
    'Decide si la provisión de vacaciones crece mes a mes o aparece completa en el aniversario laboral de cada empleado. El total anual es el mismo; la forma de once de los doce estados mensuales, no.',
  'policy.vacation_accrual_timing.rationale':
    'La NIF D-3 reconoce un beneficio a corto plazo conforme el empleado PRESTA el servicio, no cuando el derecho se vuelve exigible. Devengar en el aniversario concentra doce meses de costo en uno, que es justo la distorsión que la base de devengado existe para quitar. La alternativa sigue disponible porque el art. 76 de la LFT sí hace nacer el derecho en esa fecha, y algunos despachos informan con esa lectura.',
  'policy.vacation_accrual_timing.why':
    'La ley hace nacer el derecho en el aniversario; la norma contable lo reconoce conforme se gana. Las dos lecturas existen en la práctica.',
  'policy.vacation_accrual_timing.what':
    'Devengo las vacaciones en proporción al tiempo laborado, mes a mes.',
  'policy.vacation_accrual_timing.if_skipped':
    'Devengo en proporción.',
  'policy.vacation_accrual_timing.option.proporcional':
    'Mes a mes, en proporción al tiempo laborado',
  'policy.vacation_accrual_timing.option.aniversario':
    'Completo en el aniversario, cuando nace el derecho',

  'policy.monthly_ptu_accrual.question':
    '¿El despacho provisiona la PTU cada mes o sólo al cierre del ejercicio?',
  'policy.monthly_ptu_accrual.impact':
    'Una provisión mensual de PTU necesita una ESTIMACIÓN de la utilidad fiscal del año, que es un juicio. Provisionar sólo al cierre deja once meses sin el cargo y un duodécimo que lo lleva todo.',
  'policy.monthly_ptu_accrual.rationale':
    'Un devengo mensual de PTU descansa en la estimación de una cifra que no existirá hasta la declaración anual, y una provisión construida sobre una suposición es peor que una ausencia revelada: parece una medición. El despacho que tiene un pronóstico confiable la activa y se hace cargo de la estimación.',
  'policy.monthly_ptu_accrual.why':
    'La PTU es el 10 % de la utilidad fiscal (LFT art. 120) y esa utilidad no se conoce hasta que cierra el año. Estimarla cada mes es decisión de tu despacho, no mía.',
  'policy.monthly_ptu_accrual.what':
    'Registro la PTU al cierre del ejercicio, cuando ya se conoce la utilidad fiscal.',
  'policy.monthly_ptu_accrual.if_skipped':
    'La registro sólo al cierre del ejercicio.',
  'policy.monthly_ptu_accrual.option.no':
    'Sólo al cierre del ejercicio, cuando se conoce la utilidad fiscal',
  'policy.monthly_ptu_accrual.option.si':
    'Cada mes, sobre la utilidad fiscal estimada',

  'policy.aguinaldo_days_per_year.question':
    '¿Cuántos días de aguinaldo otorga el despacho por año de servicio?',
  'policy.aguinaldo_days_per_year.impact':
    'Lo leen dos cálculos. El finiquito (finiquito-calculator.ts) prorratea estos días por año sobre los días trabajados en el año de la baja. La provisión mensual de prestaciones (provisions-run.ts, `payroll accrue` y el cierre) devenga aguinaldo sobre ellos cada mes. Los dos comparan el valor contra el mínimo legal vigente a su fecha (LFT art. 87) y se niegan a calcular por debajo de él.',
  'policy.aguinaldo_days_per_year.rationale':
    'El art. 87 de la LFT fija quince días como piso, y un piso es la única cifra que el sistema puede suponer sin conocer el contrato. Lo que pase de ahí es una prestación que otorgó el patrón y debe declararse, nunca adivinarse.',
  'policy.aguinaldo_days_per_year.why':
    'La ley fija un mínimo de quince días; muchos despachos pagan más, y yo no puedo saber cuál es el tuyo.',
  'policy.aguinaldo_days_per_year.what':
    'Calculo el aguinaldo con los días por año que fijes, en proporción al tiempo laborado.',
  'policy.aguinaldo_days_per_year.if_skipped':
    'Uso el mínimo legal de quince días.',
  'policy.aguinaldo_days_per_year.option.15':
    '15 días — el mínimo legal (LFT art. 87)',
  'policy.aguinaldo_days_per_year.option.20':
    '20 días',
  'policy.aguinaldo_days_per_year.option.30':
    '30 días (un mes)',

  'policy.vacation_premium_pct.question':
    '¿Qué prima vacacional paga el despacho sobre los días de vacaciones ganados?',
  'policy.vacation_premium_pct.impact':
    'Se aplica igual al finiquito y a la provisión mensual de vacaciones.',
  'policy.vacation_premium_pct.rationale':
    'El mismo razonamiento que el aguinaldo: el art. 80 de la LFT fija el 25 % como piso, y el piso es la única cifra que es seguro suponer. Un despacho que paga más otorga una prestación, y una prestación se declara, no se infiere.',
  'policy.vacation_premium_pct.why':
    'La ley fija el 25 % como prima vacacional mínima; la tuya puede ser mayor.',
  'policy.vacation_premium_pct.what':
    'Aplico el 25 % sobre los días de vacaciones ganados.',
  'policy.vacation_premium_pct.if_skipped':
    'Uso el mínimo legal del 25 %.',
  'policy.vacation_premium_pct.option.0_25':
    '25 % — el mínimo legal (LFT art. 80)',
  'policy.vacation_premium_pct.option.0_50':
    '50 %',
  'policy.vacation_premium_pct.option.1_00':
    '100 %',

  'policy.cash_flow_method.question':
    '¿El estado de flujos de efectivo se presenta por el método indirecto o por el directo?',
  'policy.cash_flow_method.impact':
    'Decide la cara completa del estado. Antes de G1b el motor aceptaba un parámetro `method`, lo repetía en la respuesta y NUNCA cambiaba una cifra: cada llamada que pedía el método directo recibía el indirecto, rotulado como directo.',
  'policy.cash_flow_method.rationale':
    'La NIF B-2 permite los dos y la práctica mexicana presenta de forma abrumadora el indirecto: se deriva de los mismos saldos que ya tiene la balanza, mientras que el directo necesita que cada movimiento de efectivo se clasifique por concepto en el momento en que se registra. Ofrecer «directo» sobre datos que nunca se clasificaron para eso produciría un estado que se ve bien y no lo está.',
  'policy.cash_flow_method.why':
    'Los dos métodos presentan el mismo efectivo de forma distinta, y la presentación es una decisión del despacho, no un cálculo.',
  'policy.cash_flow_method.what':
    'Armo el estado por el método indirecto y lo rotulo así.',
  'policy.cash_flow_method.if_skipped':
    'Uso el método indirecto.',
  'policy.cash_flow_method.option.indirecto':
    'Indirecto: partir de la utilidad neta y ajustar por partidas que no son efectivo y por movimientos del capital de trabajo',
  'policy.cash_flow_method.option.directo':
    'Directo: cobros y pagos brutos por concepto (clientes, proveedores, empleados, impuestos)',

  'policy.cash_flow_cash_accounts.question':
    '¿Qué cuentas cuentan como «efectivo y equivalentes de efectivo» al cuadrar el estado de flujos de efectivo?',
  'policy.cash_flow_cash_accounts.impact':
    'El estado sólo quiere decir algo si su movimiento neto es igual al cambio real del efectivo, y para eso hay que saber qué cuentas SON efectivo. Antes de G1b la clasificación corría sobre nombres de cuenta comparados con ILIKE «%receivable%» y «%payable%» —en inglés, contra un catálogo de cuentas que este mismo producto siembra en español—, así que no casaba con nada y el capital de trabajo salía en cero.',
  'policy.cash_flow_cash_accounts.rationale':
    'El mapa de roles es la capa semántica que este sistema ya usa en todos lados para responder «qué cuenta es ésta»: sobrevive a renombres, traducciones y catálogos importados, que es justo lo que no hacen los nombres de cuenta. Comparar por nombre es como llegó aquí ese defecto.',
  'policy.cash_flow_cash_accounts.why':
    'Para cuadrar el estado de flujos de efectivo tengo que saber qué cuentas guardan el efectivo del que habla.',
  'policy.cash_flow_cash_accounts.what':
    'Tomo las cuentas mapeadas a los roles de banco y caja.',
  'policy.cash_flow_cash_accounts.if_skipped':
    'Uso el mapa de roles.',
  'policy.cash_flow_cash_accounts.option.rol':
    'Por rol: las cuentas que account_roles marca como banco y caja',
  'policy.cash_flow_cash_accounts.option.subtipo':
    'Por subtipo: cuentas de activo circulante marcadas expresamente como efectivo',
  'policy.cash_flow_cash_accounts.option.lista':
    'Una lista de códigos de cuenta que declara el despacho',

  'policy.cash_flow_mismatch.question':
    'Cuando el estado de flujos de efectivo no es igual al movimiento real del efectivo, ¿lo publico, nombro la diferencia o me niego?',
  'policy.cash_flow_mismatch.impact':
    'Un estado de flujos de efectivo que no cuadra con el efectivo es el único estado financiero cuyo error se puede probar desde fuera: cualquiera lo puede comparar contra el banco. Absorber el residuo en un renglón esconde justo lo que el lector habría detectado.',
  'policy.cash_flow_mismatch.rationale':
    'Negarse dejaría al despacho sin un estado que puede necesitar para un plazo de presentación, y el silencio es como se firma un estado equivocado. Nombrar el residuo mantiene el documento utilizable y pone la discrepancia donde la va a ver quien lo prepara, y el auditor.',
  'policy.cash_flow_mismatch.why':
    'El estado derivado y el movimiento real del efectivo pueden no coincidir. Es el único estado financiero que cualquiera puede revisar contra tu banco, así que si la diferencia se dice o se entierra lo decides tú, no yo.',
  'policy.cash_flow_mismatch.what':
    'Publico el estado y digo la diferencia contra el efectivo real, con su importe.',
  'policy.cash_flow_mismatch.if_skipped':
    'Lo publico y nombro la diferencia.',
  'policy.cash_flow_mismatch.option.avisar':
    'Publicarlo con la diferencia dicha y cuantificada',
  'policy.cash_flow_mismatch.option.bloquear':
    'Negarse a emitir el estado hasta que cuadre',
  'policy.cash_flow_mismatch.option.silencio':
    'Publicar el neto calculado sin contrastarlo',

  'policy.diot_default_operation_type.question':
    'Un proveedor nacional sin tipo de operación declarado: ¿con cuál lo reporta la DIOT?',
  'policy.diot_default_operation_type.impact':
    'La DIOT reporta a cada proveedor con un tipo de operación. Para un proveedor nacional el catálogo 2025 ofrece 02 enajenación de bienes, 03 servicios profesionales, 06 uso o goce temporal de bienes, 08 importación por transferencia virtual y 85 otros. Es por PROVEEDOR, no por factura, así que un valor por omisión equivocado está mal todos los meses hasta que alguien lo corrige. Los proveedores extranjeros tienen su propia clave, diot_default_operation_type_foreign.',
  'policy.diot_default_operation_type.rationale':
    'SAT, Instructivo para el armado del archivo de carga masiva DIOT (Enero 2025), §3.1: 85 «Otros» es la clave residual para un proveedor nacional cuya operación no es una de las específicas (02 bienes, 03 servicios profesionales, 06 uso de bienes, 08 importación por transferencia virtual). El mayor no sabe si un proveedor sin declarar vendió bienes o servicios, así que afirmar 02, 03 o 06 por omisión pondría una afirmación concreta a tu nombre; 85 sólo afirma que no se capturó una clave específica, y cada proveedor que la toma se lista para que se afinen los que importan. 08 no se ofrece como valor por omisión: exige un pedimento aduanal y no puede ser una respuesta general. Negarse bloquearía una declaración mensual por una clasificación que no cambia el impuesto.',
  'policy.diot_default_operation_type.why':
    'El formato clasifica a cada proveedor por el tipo de operación que tienes con él; los que llevan una clave específica me los tienes que decir.',
  'policy.diot_default_operation_type.what':
    'Reporto con 85 a los proveedores nacionales sin tipo declarado, y los listo para que afines los que importan.',
  'policy.diot_default_operation_type.if_skipped':
    'Uso 85 y te digo qué proveedores la tomaron.',
  'policy.diot_default_operation_type.option.85':
    'Otros (85) — la clave residual que da el catálogo',
  'policy.diot_default_operation_type.option.02':
    'Enajenación de bienes (02)',
  'policy.diot_default_operation_type.option.03':
    'Servicios profesionales (03)',
  'policy.diot_default_operation_type.option.06':
    'Uso o goce temporal de bienes (06)',
  'policy.diot_default_operation_type.option.bloquear':
    'Ninguno: negarse a armar la DIOT hasta que cada proveedor declare uno',

  'policy.diot_default_operation_type_foreign.question':
    'Un proveedor extranjero sin tipo de operación declarado: ¿con cuál lo reporta la DIOT?',
  'policy.diot_default_operation_type_foreign.impact':
    'Para un proveedor extranjero (tipo de tercero 05) el catálogo de la DIOT 2025 sólo acepta 02 enajenación de bienes, 03 servicios profesionales y 07 importación de bienes o servicios. 85 y 06 no se aceptan, así que el valor por omisión nacional no se puede reutilizar para ellos.',
  'policy.diot_default_operation_type_foreign.rationale':
    'SAT, Instructivo para el armado del archivo de carga masiva DIOT (Enero 2025), §3.1 limita a un proveedor extranjero a 02, 03 y 07. Según el art. 24 de la LIVA (frac. I–V), introducir bienes, o adquirir o usar en México intangibles o servicios que presta un no residente, es una IMPORTACIÓN, así que 07 es la clave que describe lo que hizo la entidad en el caso habitual, y coincide con las casillas de importación donde el archivo ya pone ese IVA. 02 y 03 siguen disponibles para un despacho cuyos proveedores extranjeros se describan mejor así; un proveedor distinto declara su propia clave.',
  'policy.diot_default_operation_type_foreign.why':
    'Los proveedores extranjeros no pueden usar la clave nacional «otros», y el archivo se rechaza si la llevan.',
  'policy.diot_default_operation_type_foreign.what':
    'Reporto con 07 a los proveedores extranjeros sin tipo declarado, y los listo.',
  'policy.diot_default_operation_type_foreign.if_skipped':
    'Uso 07 y te digo qué proveedores la tomaron.',
  'policy.diot_default_operation_type_foreign.option.07':
    'Importación de bienes o servicios (07)',
  'policy.diot_default_operation_type_foreign.option.03':
    'Servicios profesionales (03)',
  'policy.diot_default_operation_type_foreign.option.02':
    'Enajenación de bienes (02)',
  'policy.diot_default_operation_type_foreign.option.block':
    'Ninguno: negarse a armar la DIOT hasta que cada proveedor extranjero declare uno',

  'policy.diot_third_party_without_rfc.question':
    'Un proveedor con RFC faltante, inválido o genérico al armar la DIOT: ¿negarse o reportarlo como global?',
  'policy.diot_third_party_without_rfc.impact':
    'La DIOT identifica a cada proveedor nacional por su RFC. Hoy el sistema detecta un RFC VACÍO y nada más: ni uno mal formado ni el genérico XAXX010101000, que es precisamente el valor que convierte a un proveedor real en uno anónimo en la declaración.',
  'policy.diot_third_party_without_rfc.rationale':
    'El tipo 15 existe para las ventas genuinas al público en general, no como cajón para proveedores cuyo RFC nadie capturó. Usarlo así presenta una declaración que dice que esas operaciones no tuvieron una contraparte identificable, lo cual es una afirmación sobre tus libros y no una elección de formato; y es justo el tipo de cosa que la autoridad cruza contra las declaraciones de los propios proveedores.',
  'policy.diot_third_party_without_rfc.why':
    'Un proveedor sin RFC válido no se puede identificar en la declaración, y la alternativa a detenerse es declarar que esas compras no tuvieron una contraparte conocida.',
  'policy.diot_third_party_without_rfc.what':
    'Me niego a armar la DIOT y nombro a los proveedores cuyo RFC falta, está mal formado o es genérico.',
  'policy.diot_third_party_without_rfc.if_skipped':
    'Me niego y los nombro.',
  'policy.diot_third_party_without_rfc.option.bloquear':
    'Negarse a armarla y nombrar a los proveedores',
  'policy.diot_third_party_without_rfc.option.declarar_global':
    'Reportarlos con el tipo 15 (global, público en general)',

  'policy.diot_exempt_vat_and_base.question':
    '¿Cómo se reportan los actos exentos cuando el documento de origen no traía su base?',
  'policy.diot_exempt_vat_and_base.impact':
    'La DIOT declara el VALOR de los actos, no sólo el impuesto. Un renglón exento no trae importe de impuesto y, hasta ahora, el lector lo descartaba por completo: un nodo exento de CFDI 4.0 tiene TipoFactor="Exento" y no tiene Importe, así que se tiraba en silencio.',
  'policy.diot_exempt_vat_and_base.rationale':
    'La actividad exenta no es la ausencia de una operación: es una operación que la DIOT quiere contada, y subestimarla subestima el total que la autoridad concilia contra tu declaración de IVA. Derivarla del subtotal acierta tan seguido que es peligroso: se rompe en silencio en cualquier renglón que mezcle conceptos exentos y gravados. La base se captura al cargar: cada renglón de la cuenta por pagar guarda como valor de los actos la Base que su CFDI declaró en el traslado de IVA, así que exigirla es exigir algo que el documento ya dijo. Una Base que el CFDI omitió se queda desconocida —nunca se rellena a partir de un importe—, y lo mismo la base de cada renglón armado desde la póliza aprobada cuando algún concepto de ese CFDI la omitió; a las cuentas por pagar registradas antes de que existiera la captura también les falta.',
  'policy.diot_exempt_vat_and_base.why':
    'Las compras exentas cuentan igual en la declaración, y son aquellas cuyo importe el sistema tiraba sin decírselo a nadie.',
  'policy.diot_exempt_vat_and_base.what':
    'Me detengo y nombro los documentos cuya base exenta se desconoce, en vez de adivinarla.',
  'policy.diot_exempt_vat_and_base.if_skipped':
    'Exijo la base y nombro lo que falta.',
  'policy.diot_exempt_vat_and_base.option.exigir_base':
    'Exigir la base: negarse a reportar un periodo con renglones exentos cuyo valor se desconoce',
  'policy.diot_exempt_vat_and_base.option.derivar_del_subtotal':
    'Derivarla del subtotal del renglón',
  'policy.diot_exempt_vat_and_base.option.omitir_y_avisar':
    'Dejar fuera esos renglones y listarlos',

  'policy.diot_creditable_iva_proportion.question':
    '¿Esta entidad acredita su IVA con la proporción del art. 5 frac. V de la LIVA?',
  'policy.diot_creditable_iva_proportion.impact':
    'El formato de carga masiva de la DIOT 2025 divide el IVA acreditable de cada proveedor en dos casillas: el IVA ligado EXCLUSIVAMENTE a actividades gravadas y el IVA al que se aplicó una proporción porque la entidad también tiene actividades exentas o no objeto. El mayor acredita cada peso de IVA pagado; todavía no calcula esa proporción.',
  'policy.diot_creditable_iva_proportion.rationale':
    'El art. 5 frac. V de la LIVA sólo exige la proporción cuando el contribuyente también realiza actividades exentas o no objeto; un despacho cuyas actividades están todas gravadas acredita el IVA completo, y eso es justo lo que el mayor ya registra en iva_acreditable. Declararlo en la casilla de exclusivamente gravadas (instructivo DIOT del SAT, Enero 2025, §3.3) mantiene el archivo igual a los libros y a la declaración mensual de IVA. La DIOT rechaza este valor por omisión cuando el mayor muestra ingresos exentos en el ejercicio (cuentas mapeadas al agrupador 401.07–401.09), y una entidad que aplica la proporción debe responder «block»: las casillas proporcionales todavía no se calculan aquí, y un factor que nadie calculó no se declara.',
  'policy.diot_creditable_iva_proportion.why':
    'Sólo tú sabes si la entidad también tiene actividades exentas, y eso decide en qué casilla de la DIOT va su IVA acreditable.',
  'policy.diot_creditable_iva_proportion.what':
    'Declaro todo el IVA pagado como ligado exclusivamente a actividades gravadas, y me detengo si el mayor muestra ingresos exentos.',
  'policy.diot_creditable_iva_proportion.if_skipped':
    'Lo declaro como exclusivamente gravado y te lo recuerdo en cada DIOT; responde «block» si la entidad aplica la proporción.',
  'policy.diot_creditable_iva_proportion.option.taxed_only':
    'No: todas las actividades están gravadas, así que todo el IVA pagado va a la casilla de exclusivamente gravadas',
  'policy.diot_creditable_iva_proportion.option.block':
    'Sí: negarse a generar el archivo de carga masiva hasta que exista el tratamiento proporcional (captura en el portal)',

  'policy.efirma_sealing_e_accounting.question':
    '¿El sistema sella los archivos del Anexo 24 con tu e.firma, o los sellas tú?',
  'policy.efirma_sealing_e_accounting.impact':
    'Sellar quiere decir que este software carga y usa la llave privada del contribuyente. Los archivos que produce son una declaración ante la autoridad fiscal firmada a tu nombre.',
  'policy.efirma_sealing_e_accounting.rationale':
    'La e.firma es el contribuyente firmando, no el software. Producir el archivo y firmarlo son actos distintos y corresponden a manos distintas: este sistema arma el XML, te muestra lo que contiene y se detiene. La bóveda existe para las credenciales que el sistema de verdad necesita; la firma de una declaración no es una de ellas. Los despachos que decidan otra cosa pueden decirlo aquí, y entonces cada descifrado queda en bitácora; pero por omisión tu llave nunca entra a este proceso.',
  'policy.efirma_sealing_e_accounting.why':
    'Sellar un archivo del Anexo 24 quiere decir que este software usa tu llave privada para firmar una declaración a tu nombre. No es un detalle técnico que yo pueda suponer por ti: es tu firma.',
  'policy.efirma_sealing_e_accounting.what':
    'Armo el XML sin sellar y te lo entrego; el sellado y el envío son tuyos.',
  'policy.efirma_sealing_e_accounting.if_skipped':
    'Nunca sello: tu llave no entra a este proceso.',
  'policy.efirma_sealing_e_accounting.option.nunca_sellar_en_el_sistema':
    'Nunca: el sistema produce el XML sin sellar y tú lo sellas y lo envías',
  'policy.efirma_sealing_e_accounting.option.sellar_con_custodia':
    'Sellar aquí, con la llave guardada en la bóveda de credenciales y cada uso en bitácora',

  'policy.anexo24_account_without_grouping_code.question':
    'Generar el catálogo del Anexo 24 con cuentas sin código agrupador: ¿negarse o emitirlas?',
  'policy.anexo24_account_without_grouping_code.impact':
    'El nodo CtaCatalogo exige CodigoAgrupador en cada cuenta. Una cuenta sin él o se queda fuera del archivo —y la balanza hace referencia a una cuenta que el catálogo no declara— o entra vacía y el XSD la rechaza.',
  'policy.anexo24_account_without_grouping_code.rationale':
    'Emitir un catálogo incompleto es peor que no emitir ninguno: la balanza que se presenta después hace referencia a cuentas que el catálogo nunca declaró, y esa incongruencia es justo lo que la autoridad valida entre declaraciones. Detenerse cuesta una sesión de mapeo; presentar un catálogo que contradice la balanza cuesta un rechazo con el plazo ya vencido.',
  'policy.anexo24_account_without_grouping_code.why':
    'Cada cuenta del archivo necesita su código agrupador del SAT, y puedo detenerme y decirte cuáles faltan o entregarte un catálogo que no coincide con la balanza que vas a presentar después.',
  'policy.anexo24_account_without_grouping_code.what':
    'Me niego a generar y nombro las cuentas a las que les falta su código agrupador.',
  'policy.anexo24_account_without_grouping_code.if_skipped':
    'Me niego y las nombro.',
  'policy.anexo24_account_without_grouping_code.option.bloquear':
    'Negarse a generar hasta que cada cuenta lleve su código agrupador',
  'policy.anexo24_account_without_grouping_code.option.omitir_y_avisar':
    'Dejarlas fuera del archivo y listarlas',

  'policy.chart_parent_child_coherence.question':
    '¿Una subcuenta puede estar en una sección de los estados distinta de la de su cuenta padre?',
  'policy.chart_parent_child_coherence.impact':
    'Hoy nada ata una cuenta hija a su padre, así que una cuenta de gasto puede colgar de un activo y todos los estados siguen sumando: el importe simplemente aparece en la sección equivocada de un documento que alguien firma. Medido sobre los 80 pares padre-hija que siembra este producto, exigir la MISMA CATEGORÍA fallaría once veces (1200 «Activo Fijo» es non_current_assets bajo 1000 «Activo», que es current_assets, y eso es contabilidad correcta); exigir la misma SECCIÓN se cumple en los 80. Por eso la igualdad no se ofrece: rechazaría el catálogo que el propio producto trae.',
  'policy.chart_parent_child_coherence.rationale':
    'Una cifra en la sección equivocada de un estado firmado no se detecta más adelante: el estado cuadra de cualquier modo. Negarse cuesta una cuenta corregida en el momento en que alguien ya está mirando el catálogo; dejarla pasar cuesta encontrarla en una declaración. Una cuenta sin fs_category en ninguno de los dos lados NO se juzga: la importación del SAT la deja vacía en los dos lados de cada arista que crea, y una regla que leyera la ausencia como falta detendría a un despacho que migra su propio catálogo.',
  'policy.chart_parent_child_coherence.why':
    'Tu catálogo ya tiene padres e hijas, y puedo mantener una subcuenta dentro de la sección de su padre o dejarte ponerla donde el catálogo la necesite.',
  'policy.chart_parent_child_coherence.what':
    'Rechazo una subcuenta cuya categoría cae en una sección distinta de la de su padre, y nombro a las dos.',
  'policy.chart_parent_child_coherence.if_skipped':
    'La rechazo y nombro los dos lados.',
  'policy.chart_parent_child_coherence.option.exigir_misma_seccion':
    'Rechazar la cuenta: una subcuenta se queda en la sección de su padre',
  'policy.chart_parent_child_coherence.option.advertir_misma_seccion':
    'Nombrarla y dejarla pasar',
  'policy.chart_parent_child_coherence.option.sin_regla':
    'Sin regla: el catálogo es asunto del despacho',

  'policy.anexo24_levels_to_report.question':
    '¿Qué niveles del catálogo entran en el catálogo del Anexo 24?',
  'policy.anexo24_levels_to_report.impact':
    'El archivo declara la jerarquía con SubCtaDe y Nivel. Presentar sólo los niveles superiores esconde el detalle que la autoridad usa para seguir una póliza; presentarlo todo expone un catálogo que puede traer cuentas analíticas internas.',
  'policy.anexo24_levels_to_report.rationale':
    'El catálogo es el mapa contra el que la autoridad lee la balanza y las pólizas, así que una cuenta que aparece en cualquiera de las dos tiene que aparecer aquí. Recortarlo crea referencias que el archivo no puede resolver, y la jerarquía es precisamente lo que SubCtaDe existe para llevar.',
  'policy.anexo24_levels_to_report.why':
    'El archivo tiene que declarar la jerarquía de tu catálogo, y qué tan hondo llega decide si una declaración posterior puede hacer referencia a una cuenta que este catálogo nunca mencionó.',
  'policy.anexo24_levels_to_report.what':
    'Incluyo el catálogo completo con su estructura de padres e hijas.',
  'policy.anexo24_levels_to_report.if_skipped':
    'Incluyo todas las cuentas con su jerarquía.',
  'policy.anexo24_levels_to_report.option.jerarquia_completa':
    'Todas las cuentas, con su padre y su nivel',
  'policy.anexo24_levels_to_report.option.hasta_nivel_2':
    'Sólo rubros y cuentas de primer nivel',
  'policy.anexo24_levels_to_report.option.las_que_se_mueven':
    'Sólo las cuentas con movimiento contabilizado, más sus padres',

  'policy.grouping_code_gate_scope.question':
    '¿Qué cuentas tienen que llevar código agrupador del SAT antes de poder presentar la contabilidad?',
  'policy.grouping_code_gate_scope.impact':
    'Decide a quién acusa la compuerta. Hoy filtra por account_level <= 2, lo que en un catálogo real reportó 43 faltantes, de los cuales 42 eran cuentas sin ningún movimiento, mientras que la única cuenta que SÍ se había movido sin código agrupador no se reportó. Falla en las dos direcciones.',
  'policy.grouping_code_gate_scope.rationale':
    'Lo que lee el SAT es la balanza y las pólizas, así que una cuenta que nunca se movió no puede agrupar mal nada. Acusar al catálogo completo entierra la única cuenta que importa bajo decenas que no importan, que es justo como una compuerta deja de leerse.',
  'policy.grouping_code_gate_scope.why':
    'Un catálogo de cuentas siempre tiene renglones a los que nadie contabiliza nunca. Avisarte de ellos es ruido, y el ruido es como un aviso deja de leerse; pero la cuenta que SÍ se movió y no tiene código agrupador es una declaración que no puedes presentar.',
  'policy.grouping_code_gate_scope.what':
    'Sólo señalo las cuentas que de verdad se movieron en el periodo que se presenta.',
  'policy.grouping_code_gate_scope.if_skipped':
    'Señalo las cuentas con movimiento.',
  'policy.grouping_code_gate_scope.option.cuentas_con_movimientos':
    'Sólo las cuentas con movimiento contabilizado en el periodo',
  'policy.grouping_code_gate_scope.option.todas_las_de_detalle':
    'Todas las cuentas de detalle, con o sin movimiento',
  'policy.grouping_code_gate_scope.option.todas':
    'Todas las cuentas del catálogo',

  'policy.grouping_code_missing_at_close.question':
    'Cerrar un mes con cuentas que se movieron y no tienen código agrupador del SAT: ¿avisar o rechazar?',
  'policy.grouping_code_missing_at_close.impact':
    'Sin código agrupador esas cuentas no pueden entrar en el catálogo del Anexo 24, así que la declaración de ese mes es imposible hasta que alguien las mapee.',
  'policy.grouping_code_missing_at_close.rationale':
    'El cierre es un acto contable y el código agrupador es un requisito de la declaración: bloquear los libros por un catálogo fiscal confunde dos obligaciones con plazos distintos. El aviso es lo que te da los días entre el cierre y la presentación para arreglarlo.',
  'policy.grouping_code_missing_at_close.why':
    'Cerrar el mes y presentarlo al SAT son dos plazos distintos, y una cuenta sin mapear sólo rompe el segundo; así que es razonable que quieras cerrar de todos modos y mapear antes de presentar.',
  'policy.grouping_code_missing_at_close.what':
    'Pongo el punto en rojo en la lista de verificación del cierre, con las cuentas, y dejo que el cierre siga.',
  'policy.grouping_code_missing_at_close.if_skipped':
    'Aviso y las nombro.',
  'policy.grouping_code_missing_at_close.option.avisar':
    'Avisar: el punto de la lista de verificación se pone en rojo y el cierre sigue',
  'policy.grouping_code_missing_at_close.option.bloquear':
    'Negarse a cerrar hasta que cada cuenta con movimiento esté mapeada',

  'policy.grouping_code_outside_catalog.question':
    'Un código agrupador que no está en el catálogo oficial del SAT de ese año: ¿aceptar o rechazar?',
  'policy.grouping_code_outside_catalog.impact':
    'La autoridad revisa el catálogo c_CodAgrup, así que un código válido en 2022 puede no serlo en 2026, y una declaración se valida contra el catálogo vigente en su ejercicio.',
  'policy.grouping_code_outside_catalog.rationale':
    'Un código agrupador inválido no falla aquí: falla en el SAT, después de que el archivo se selló con la e.firma y se envió, cuando el plazo ya corrió. Detectarlo al capturar cuesta un mensaje; detectarlo en la autoridad fiscal cuesta una declaración rechazada.',
  'policy.grouping_code_outside_catalog.why':
    'El SAT publica y revisa este catálogo, así que un código que era correcto hace dos años puede estar mal hoy; y el archivo sólo se rechaza después de que ya lo sellaste y lo enviaste.',
  'policy.grouping_code_outside_catalog.what':
    'Rechazo un código agrupador que no esté en el catálogo vigente de ese año, y digo cuál es.',
  'policy.grouping_code_outside_catalog.if_skipped':
    'Rechazo los códigos fuera del catálogo.',
  'policy.grouping_code_outside_catalog.option.rechazar':
    'Rechazar: el código tiene que existir en el catálogo vigente',
  'policy.grouping_code_outside_catalog.option.avisar':
    'Aceptarlo y avisar',

  'policy.anexo24_trial_balance_opening_balance.question':
    '¿De dónde sale el saldo inicial de la balanza de comprobación del Anexo 24?',
  'policy.anexo24_trial_balance_opening_balance.impact':
    'El SAT recalcula SaldoIni + Debe − Haber = SaldoFin sobre la balanza presentada. Hoy el saldo inicial sólo lo siembra el cierre DURO, así que una entidad que sólo hace cierres blandos presentaría ceros en todas las cuentas: una declaración sellada de que la empresa abrió el mes en nada.',
  'policy.anexo24_trial_balance_opening_balance.rationale':
    'El mayor ya tiene la respuesta y la capa de informes ya sabe cómo pedirla, así que derivarlo cuesta una consulta y es verdad sea cual sea el estado del periodo. Exigir un cierre duro haría depender una obligación de presentación de una ceremonia contable interna que la ley no menciona.',
  'policy.anexo24_trial_balance_opening_balance.why':
    'Tu saldo inicial sólo se guarda cuando un periodo se cierra en duro, y la declaración lo necesita cada mes; así que o lo tomo del mayor o me niego a armar la balanza.',
  'policy.anexo24_trial_balance_opening_balance.what':
    'Derivo el saldo inicial de todo lo contabilizado antes del periodo, sea cual sea su estado de cierre.',
  'policy.anexo24_trial_balance_opening_balance.if_skipped':
    'Lo derivo del mayor.',
  'policy.anexo24_trial_balance_opening_balance.option.derivar_del_mayor':
    'Derivarlo del mayor: sumar todo lo contabilizado antes de que empiece el periodo',
  'policy.anexo24_trial_balance_opening_balance.option.exigir_cierre_duro':
    'Exigir un cierre duro: negarse a armar la balanza sin un saldo inicial sembrado',

  'policy.opening_balance_load_mode.question':
    'Cuando se carga la balanza de apertura del Anexo 24, ¿se contabiliza o se deja como borrador?',
  'policy.opening_balance_load_mode.impact':
    'Contabilizar pone la apertura en el mayor en el mismo acto, después del --dry-run y el --yes. Un borrador la deja fuera del mayor hasta que alguien corre `entry post` sobre ella, para que una segunda persona la revise antes; sus renglones y su fecha no se pueden editar, porque mover la fecha dejaría que una segunda carga duplicara cada saldo.',
  'policy.opening_balance_load_mode.rationale':
    'La carga ya muestra el informe completo con --dry-run y pregunta antes de escribir, y la comprobación al centavo la compara después contra el origen. Un borrador añade un segundo paso que sólo se paga cuando otra persona revisa la apertura antes de aplicarla.',
  'policy.opening_balance_load_mode.why':
    'Algunos despachos quieren que una segunda persona mire la apertura migrada antes de que llegue al mayor; otros la cargan ellos mismos.',
  'policy.opening_balance_load_mode.what':
    'Contabilizo la apertura cuando se confirma la carga, o dejo un borrador bloqueado para `entry post`.',
  'policy.opening_balance_load_mode.if_skipped':
    'La contabilizo.',
  'policy.opening_balance_load_mode.option.contabilizar':
    'Contabilizarla: la apertura queda en el mayor en cuanto se confirma la carga',
  'policy.opening_balance_load_mode.option.borrador':
    'Dejar un borrador: `entry post` lo aplica después de una revisión',

  'policy.opening_payable_iva.question':
    'Cuando una factura de proveedor migrada no dice la tasa de IVA dentro de su saldo pendiente, ¿qué hace la carga de apertura?',
  'policy.opening_payable_iva.impact':
    'Una factura de proveedor migrada se vuelve una cuenta por pagar. Con su tasa de IVA, la cuenta por pagar lleva la base y el IVA pendiente de acreditar, así que pagarla pasa ese IVA a acreditable y la DIOT de ese mes lo declara por tasa. Sin la tasa, «require_rate» detiene la carga y nombra los documentos; «assume_zero_rate» los carga al 0 %: pagarlos no acredita IVA y la DIOT los declara como actos al 0 %. El IVA de los documentos también tiene que estar en la cuenta de IVA pendiente de la apertura.',
  'policy.opening_payable_iva.rationale':
    'Con el IVA en flujo de efectivo, el impuesto de una compra no pagada se vuelve acreditable cuando se paga (LIVA art. 1-B y art. 5 fr. III), y la DIOT reporta lo pagado por tasa (LIVA art. 32 fr. VIII). Suponer 0 % pierde el acreditamiento y declara actos a una tasa que no tuvieron; pedir la tasa cuesta una columna en el archivo.',
  'policy.opening_payable_iva.why':
    'El sistema anterior me da lo que se le sigue debiendo a cada proveedor, no siempre cuánto de eso es IVA. O espero a que me lo digas, o lo cargo como si no tuviera IVA.',
  'policy.opening_payable_iva.what':
    'Por omisión detengo la carga y listo los documentos de proveedor sin tasa. Con «assume_zero_rate» los cargo al 0 % y te digo cuáles.',
  'policy.opening_payable_iva.if_skipped':
    'Detengo la carga hasta que cada documento de proveedor diga su tasa de IVA.',
  'policy.opening_payable_iva.option.require_rate':
    'Detener la carga hasta que cada documento de proveedor diga su tasa de IVA',
  'policy.opening_payable_iva.option.assume_zero_rate':
    'Cargarlos al 0 % y avisar: no se acredita IVA cuando se paguen',

  'policy.closing_entries_in_reports.question':
    'Cuando un informe abarca la fecha en que se cerró el ejercicio, ¿sus pólizas de cierre cuentan como actividad?',
  'policy.closing_entries_in_reports.impact':
    'La póliza de cierre lleva fecha del FINAL del periodo que cierra, dentro del rango que consulta el estado de resultados. Contarla deja el año en cero: una empresa con 10,000 de ventas imprime «Utilidad neta 0.0000». Excluirla del estado y conservarla en la balanza es la única combinación en la que los dos documentos son verdad a la vez.',
  'policy.closing_entries_in_reports.rationale':
    'El estado de resultados responde «qué ganó el negocio», y la póliza de cierre no es ganancia: es el acto de guardar la ganancia. La balanza responde «qué dicen los libros», y ahí la póliza SÍ es parte de los libros; esconderla rompería el amarre con el mayor general contra el que se revisa el Anexo 24.',
  'policy.closing_entries_in_reports.why':
    'La póliza que cierra tu ejercicio cae dentro del rango que piden tus informes de fin de año, así que tengo que saber si la cuento.',
  'policy.closing_entries_in_reports.what':
    'Dejo las pólizas de cierre fuera del estado de resultados y las conservo en la balanza.',
  'policy.closing_entries_in_reports.if_skipped':
    'Las excluyo del estado y las incluyo en la balanza.',
  'policy.closing_entries_in_reports.option.estado_sin_cierre_balanza_con_cierre':
    'El estado de resultados las excluye; la balanza las incluye y lo dice',
  'policy.closing_entries_in_reports.option.excluir_siempre':
    'Ningún informe las cuenta nunca',
  'policy.closing_entries_in_reports.option.incluir_siempre_y_advertir':
    'Todos los informes las cuentan y avisan que el rango contiene un cierre',

  'policy.year_result_destination.question':
    'En el cierre del ejercicio, ¿a dónde va el resultado: directo a «Resultado de Ejercicios Anteriores», o antes a «Resultado del Ejercicio»?',
  'policy.year_result_destination.impact':
    'Decide si el balance general todavía puede mostrar lo que ganó ESTE año después del cierre. Barrerlo directo a 3200 lo mezcla con todos los años anteriores el día del cierre, antes de que los accionistas hayan aprobado nada.',
  'policy.year_result_destination.rationale':
    'La práctica mexicana mantiene aparte el resultado del ejercicio hasta que la asamblea resuelve qué hacer con él (dividendos, reserva legal, capitalización): el art. 19 de la LGSM prohíbe repartir utilidades mientras no se absorban las pérdidas, y ese argumento necesita que el año siga siendo identificable. La cuenta 3300 ya existe en el catálogo sembrado y nada escribe en ella.',
  'policy.year_result_destination.why':
    'Después de cerrar diciembre, tu balance general o sigue mostrando lo que ganó este año o lo suma al total acumulado. Es una decisión de presentación, y es tuya.',
  'policy.year_result_destination.what':
    'Cierro el ejercicio en 3300 y dejo el traspaso a 3200 como un acto aparte y auditado.',
  'policy.year_result_destination.if_skipped':
    'Uso la ruta de dos pasos por «Resultado del Ejercicio».',
  'policy.year_result_destination.option.dos_pasos_hasta_asamblea':
    'Cerrar a «Resultado del Ejercicio» (3300); una reclasificación posterior y auditada lo pasa a «Resultado de Ejercicios Anteriores» (3200)',
  'policy.year_result_destination.option.directo_a_acumulados':
    'Cerrar directo a «Resultado de Ejercicios Anteriores» (3200)',

  'policy.reclose_of_reopened_period.question':
    'Si un periodo de fin de año que ya emitió su póliza de cierre se reabre y se vuelve a cerrar, ¿qué pasa con la primera?',
  'policy.reclose_of_reopened_period.impact':
    'Hoy el segundo cierre emite un segundo juego COMPLETO de pólizas de cierre y nada quita el primero: «Resultado de Ejercicios Anteriores» (3200) recibe el resultado dos veces. `period reopen` hizo que esto se pudiera alcanzar desde la terminal, así que la respuesta dejó de ser hipotética.',
  'policy.reclose_of_reopened_period.rationale':
    'Es la única opción que deja los libros diciendo una sola verdad y muestra cómo llegaron ahí: la NIF B-1 corrige por reversión, nunca por edición, y la reversión es la evidencia de que el primer cierre se deshizo a propósito. «Incremental» dependería de que el primer cierre estuviera bien, que es precisamente lo que una reapertura pone en duda.',
  'policy.reclose_of_reopened_period.why':
    'Reabrir un ejercicio cerrado quiere decir que su póliza de cierre ya está en los libros, y volver a cerrar escribirá una segunda. Necesito saber si deshago la primera o la dejo como está.',
  'policy.reclose_of_reopened_period.what':
    'Revierto la póliza de cierre anterior con su motivo registrado, y luego cierro otra vez desde cero.',
  'policy.reclose_of_reopened_period.if_skipped':
    'Revierto y vuelvo a emitir.',
  'policy.reclose_of_reopened_period.option.reversar_y_reemitir':
    'Revertir la póliza de cierre anterior (folio propio, motivo auditado) y emitir otra vez el cierre completo',
  'policy.reclose_of_reopened_period.option.incremental':
    'Dejar en pie el primer cierre; el nuevo sólo barre lo que quedó',
  'policy.reclose_of_reopened_period.option.prohibir':
    'Negarse: un periodo cuyo cierre ya se emitió se corrige con una reclasificación explícita, no cerrando otra vez',

  'policy.unswept_pl_accounts_severity.question':
    'Si el cierre del ejercicio termina y alguna cuenta de ingresos o gastos todavía tiene saldo, ¿es un aviso o una falla?',
  'policy.unswept_pl_accounts_severity.impact':
    'Un cierre que deja cuentas sin barrer no cerró el ejercicio, y el mismo defecto que esta revisión existe para atrapar —el abs() que duplicaba las devoluciones en vez de barrerlas— produjo exactamente eso: cuentas con el doble de su saldo mientras la póliza misma cuadraba y todos los demás indicadores salían en verde.',
  'policy.unswept_pl_accounts_severity.rationale':
    'El cierre es lo que vuelve definitivo el ejercicio; un cierre que funcionó a medias deja el año siguiente sembrado con saldos iniciales equivocados, y para cuando alguien lo nota los estados ya están firmados. Detenerse tiene remedio; un saldo inicial equivocado arrastrado hacia adelante, no.',
  'policy.unswept_pl_accounts_severity.why':
    'Cuando el cierre no puede barrer una cuenta a cero, o se detiene y te lo dice o termina y espera que leas el aviso.',
  'policy.unswept_pl_accounts_severity.what':
    'Deshago el cierre y nombro las cuentas que no se barrieron.',
  'policy.unswept_pl_accounts_severity.if_skipped':
    'Me niego a completar un cierre que deja resultados sin barrer.',
  'policy.unswept_pl_accounts_severity.option.bloquear_cierre':
    'Fallar: el cierre duro se deshace y el periodo sigue abierto',
  'policy.unswept_pl_accounts_severity.option.avisar':
    'Avisar: el cierre se completa y el residuo se reporta con su remedio',
  'policy.unswept_pl_accounts_severity.option.tolerancia':
    'Aceptar hasta la tolerancia de cierre de la entidad y fallar por encima de ella',

  'policy.exchange_rate_source.question':
    'Cuando necesito un tipo de cambio para una fecha, ¿qué fuente publicada uso?',
  'policy.exchange_rate_source.impact':
    'Cada conversión de moneda extranjera lee el tipo de esta fuente para la fecha de la operación. Si esa fuente no tiene tipo para esa fecha, la conversión SE DETIENE y lo dice: nunca toma prestado en silencio un tipo de otra fuente, porque eso sería elegir el criterio fiscal por ti.',
  'policy.exchange_rate_source.rationale':
    'En México el tipo con efectos legales es el que publica el Diario Oficial (art. 20 CFF): el IVA acreditable de un pago en moneda extranjera se convierte al tipo del DOF, y el FIX es otra cifra para el mismo día. Un sistema mexicano que pone primero los libros usa por omisión la fuente contra la que lo va a medir el SAT; los despachos con razones de tesorería para preferir el FIX pueden decirlo aquí.',
  'policy.exchange_rate_source.why':
    'El DOF y el FIX del mismo día son cifras distintas, y cuál usan tus libros es un criterio, no una preferencia.',
  'policy.exchange_rate_source.what':
    'Convierto con el tipo de la fuente elegida para la fecha de la operación, y me detengo si falta.',
  'policy.exchange_rate_source.if_skipped':
    'Uso el tipo del DOF.',
  'policy.exchange_rate_source.option.dof':
    'DOF (Diario Oficial; el tipo fiscal según el art. 20 CFF)',
  'policy.exchange_rate_source.option.fix_banxico':
    'FIX de Banxico (el tipo de referencia, publicado como banco_mexico)',
  'policy.exchange_rate_source.option.manual':
    'Tipos que fijo a mano con `fx rate set`',

  'policy.rep_foreign_currency.question':
    'Un complemento en una moneda distinta de la funcional: ¿registrarlo o dejarlo en revisión?',
  'policy.rep_foreign_currency.impact':
    'Decide si un REP en moneda extranjera crea su pago. Cuando lo hace, pasa por el mismo motor de pagos que un pago tecleado a mano (pagos a proveedores desde R4, cobranza desde MNE-001-082): cada documento se extingue al tipo con el que nació, el efectivo se convierte al tipo del día del pago según `fuente_tipo_cambio`, el IVA se causa a ese mismo tipo y la diferencia se contabiliza en las cuentas de utilidad o pérdida cambiaria. No se lee el TipoCambioP del propio REP; se lee la fuente del despacho.',
  'policy.rep_foreign_currency.rationale':
    'La NIF B-15 quiere la diferencia realizada en el periodo en que el pago liquida el documento, y para el IVA el importe causado o acreditable es el efectivamente pagado convertido al tipo de la fecha del pago (LIVA arts. 1-B, 5-III y 11; art. 20 CFF). El motor de pagos ya registra las dos cosas, así que registrar es sólido; el valor por omisión sigue deteniéndose en revisión porque un REP que el despacho no tecleó se crea sin cuenta de banco y con un tipo que nadie miró, y una persona debería ver los primeros antes de que se contabilicen. No hay una opción que case al tipo del documento y no reconozca diferencia: dejaría el IVA al tipo equivocado y escondería un resultado realizado que exige la B-15.',
  'policy.rep_foreign_currency.why':
    'Un pago en dólares liquida documentos registrados a otro tipo: la diferencia es dinero real y cae en las cuentas de utilidad o pérdida cambiaria.',
  'policy.rep_foreign_currency.what':
    'Dejo el complemento sin casar y te aviso, o lo registro con su diferencia realizada si así lo dices.',
  'policy.rep_foreign_currency.if_skipped':
    'No caso complementos en moneda extranjera, y lo digo cada vez.',
  'policy.rep_foreign_currency.option.no_casar':
    'No casar: dejarlo en revisión con un aviso de varias monedas',
  'policy.rep_foreign_currency.option.payment_day_rate':
    'Registrarlo por el motor de pagos, realizando la diferencia cambiaria al tipo del día del pago',

  'policy.efirma_max_daily_accesses.question':
    '¿Cuántos descifrados de la e.firma al día son normales?',
  'policy.efirma_max_daily_accesses.impact':
    'Es el límite que dispara la negación y la señal de acceso anómalo. Demasiado alto = la señal pierde valor; demasiado bajo = interrumpe sincronizaciones legítimas. Debe salir de la cadencia real de descarga.',
  'policy.efirma_max_daily_accesses.rationale':
    'Uno por hora: holgado para cualquier cadencia razonable, pero pone un tope al abuso.',
  'policy.efirma_max_daily_accesses.why':
    'Tu e.firma se descifra cada vez que me autentico ante el SAT. Un límite convierte un patrón de acceso anormal en una señal visible, pero sólo si refleja tu cadencia real de sincronización.',
  'policy.efirma_max_daily_accesses.what':
    'Por encima de ese número de descifrados en 24 horas niego el acceso y lo registro como anomalía.',
  'policy.efirma_max_daily_accesses.if_skipped':
    'Permito 24 al día (uno por hora), lo que es holgado: un abuso tendría que ser grande antes de que se dispare la señal.',
  'policy.efirma_max_daily_accesses.option.4':
    '4 — sincronizar cada 6 horas',
  'policy.efirma_max_daily_accesses.option.24':
    '24 — uno por hora',
  'policy.efirma_max_daily_accesses.option.96':
    '96 — cada 15 minutos',

  'policy.efirma_anomaly_action.question':
    'Cuando se detecta un patrón anómalo de acceso a la e.firma, ¿bloquear o sólo alertar?',
  'policy.efirma_anomaly_action.impact':
    'Bloquear protege pero puede tumbar la sincronización de un cliente por un falso positivo. Alertar no interrumpe pero exige a alguien vigilando. Define si necesitas guardia.',
  'policy.efirma_anomaly_action.rationale':
    'El límite diario ya niega el exceso; bloquear la credencial completa sin alguien de guardia que lo atienda dejaría al cliente sin servicio hasta que alguien se diera cuenta.',
  'policy.efirma_anomaly_action.why':
    'Cuando el patrón de acceso se ve mal puedo bloquear la credencial o sólo alertar. Bloquear protege pero un falso positivo tumba tu sincronización; alertar nunca interrumpe pero necesita a alguien vigilando.',
  'policy.efirma_anomaly_action.what':
    'Decide qué pasa en el momento en que se detecta una anomalía.',
  'policy.efirma_anomaly_action.if_skipped':
    'Sólo alerto. Si nadie vigila las alertas, un acceso anormal podría seguir sin que nadie lo note.',
  'policy.efirma_anomaly_action.option.bloquear':
    'Bloquear la credencial y notificar',
  'policy.efirma_anomaly_action.option.alertar':
    'Sólo alertar y dejar que siga',
  'policy.efirma_anomaly_action.option.bloquear_fuera_horario':
    'Bloquear sólo fuera del horario definido',

  'policy.ingest_auto_post.question':
    '¿Está activada la contabilización automática al cargar CFDI?',
  'policy.ingest_auto_post.impact':
    'Con la contabilización automática apagada, todo se queda en borrador para revisión. Encendida, el sistema contabiliza sin intervención cuando se cumplen los umbrales de confianza, importe y proveedor conocido.',
  'policy.ingest_auto_post.rationale':
    'Mejor medir durante varias semanas qué tan seguido acertaría antes de dejar que mueva dinero por su cuenta.',
  'policy.ingest_auto_post.why':
    'Puedo clasificar una factura y contabilizarla sin preguntar, o dejarla siempre en borrador para que la apruebes. Encenderla ahorra trabajo; dejarla apagada quiere decir que nada llega a tus libros sin revisión.',
  'policy.ingest_auto_post.what':
    'Apagada, cada factura clasificada por la IA espera tu aprobación en `mnemosine review`. Encendida, las facturas que cumplen los umbrales de confianza, importe y proveedor conocido se contabilizan solas.',
  'policy.ingest_auto_post.if_skipped':
    'Se queda apagada: todo pasa por tu revisión, que es la forma segura de empezar.',
  'policy.ingest_auto_post.option.off':
    'Apagada: todo va a revisión humana',
  'policy.ingest_auto_post.option.shadow':
    'Sombra: correr todas las compuertas, registrar el veredicto y no contabilizar NADA — construye el historial',
  'policy.ingest_auto_post.option.on':
    'Encendida con los umbrales configurados',

  'policy.ingest_auto_post_max_amount.question':
    '¿Cuál es el importe máximo que la IA puede contabilizar sin revisión humana?',
  'policy.ingest_auto_post_max_amount.impact':
    'Tope duro de la contabilización automática. Por encima de este importe siempre pasa por revisión.',
  'policy.ingest_auto_post_max_amount.rationale':
    'Acota la exposición mientras se construye un historial.',
  'policy.ingest_auto_post_max_amount.why':
    'Aun con la contabilización automática encendida, hay un importe por encima del cual seguramente quieres revisar tú antes de que toque los libros.',
  'policy.ingest_auto_post_max_amount.what':
    'Es un tope duro: por encima de ese importe una factura siempre va a revisión, sin importar qué tan segura sea la clasificación.',
  'policy.ingest_auto_post_max_amount.if_skipped':
    'El tope se queda en $10,000.',
  'policy.ingest_auto_post_max_amount.option.5000':
    '$5,000 — sólo gastos menores',
  'policy.ingest_auto_post_max_amount.option.10000':
    '$10,000',
  'policy.ingest_auto_post_max_amount.option.50000':
    '$50,000',

  'policy.rep_missing_received.question':
    'Al cierre, un pago a proveedor de una factura PPD todavía no tiene REP, aunque su IVA ya se acreditó. ¿Bloquear el cierre, sólo avisar o no vigilarlo al cierre?',
  'policy.rep_missing_received.impact':
    'Con «bloquear», el cierre blando se niega mientras algún pago del periodo no tenga su REP; con «avisar» cierra y la lista de verificación registra el acreditamiento sin soporte; con «no_vigilar» el cierre ignora el lado del proveedor y rep missing list es el único lugar que lo muestra.',
  'policy.rep_missing_received.rationale':
    'El IVA de una factura PPD es acreditable cuando se paga (LIVA art. 5 fr. III), y el proveedor debe emitir el REP que ampara ese acreditamiento (CFF art. 29, RMF 2.7.1.35). Un proveedor atrasado no debería congelar tu cierre, pero un acreditamiento sin su complemento es una exposición ante una auditoría, así que el cierre lo mantiene visible; rep missing list nombra a los responsables.',
  'policy.rep_missing_received.why':
    'El REP es lo que ampara el acreditamiento del IVA de una PPD. Algunos despachos se niegan a cerrar un mes cuyos acreditamientos de IVA todavía no tienen su REP; otros cierran y persiguen al proveedor; otros lo siguen fuera del cierre.',
  'policy.rep_missing_received.what':
    'Decide si getPeriodCloseStatus cuenta los REP faltantes de proveedores como un problema que bloquea, como un aviso o no los cuenta.',
  'policy.rep_missing_received.if_skipped':
    'Avisa: el cierre sigue y la lista de verificación muestra los REP pendientes.',
  'policy.rep_missing_received.option.avisar':
    'Avisar: el cierre sigue, el REP faltante sigue visible en la lista de verificación',
  'policy.rep_missing_received.option.bloquear':
    'Bloquear: no hay cierre hasta que cada pago tenga su REP',
  'policy.rep_missing_received.option.no_vigilar':
    'No vigilar al cierre: el acreditamiento ya está registrado; los REP se persiguen desde rep missing list',

  'policy.rep_missing_issued.question':
    'Al cierre, un cobro a cliente no tiene un REP emitido por nosotros. ¿Bloquear el cierre o sólo avisar?',
  'policy.rep_missing_issued.impact':
    'El REP de una factura PPD cobrada es NUESTRA obligación, con un plazo del SAT. «bloquear» se niega a cerrar mientras algún cobro no tenga su REP; «avisar» cierra y lo registra.',
  'policy.rep_missing_issued.rationale':
    'Avisar mantiene el cierre utilizable desde el primer día; cambia a bloquear cuando la emisión de REP (rep stamp) exista en el sistema y la obligación se pueda cumplir desde aquí.',
  'policy.rep_missing_issued.why':
    'A diferencia del caso del proveedor, este REP lo emitimos nosotros y el plazo del SAT es nuestro. Si eso bloquea tu cierre es política del despacho.',
  'policy.rep_missing_issued.what':
    'Decide si getPeriodCloseStatus cuenta nuestros REP no emitidos como un problema que bloquea o como un aviso.',
  'policy.rep_missing_issued.if_skipped':
    'Avisa: el cierre sigue y la lista de verificación muestra la obligación.',
  'policy.rep_missing_issued.option.bloquear':
    'Bloquear: nuestra propia obligación de REP debe cumplirse antes de cerrar',
  'policy.rep_missing_issued.option.avisar':
    'Avisar: el cierre sigue, la obligación se queda en la lista de verificación',

  'policy.segregation_of_duties.question':
    '¿La persona que hizo el trabajo también puede darle el visto bueno?',
  'policy.segregation_of_duties.impact':
    'Control de cuatro ojos, sobre DOS actos que hacen la misma pregunta. En la vía manual: con «exigir», entry post rechaza que quien hizo el borrador contabilice su propia póliza. En la vía del banco: rechaza que quien cerró una sesión de conciliación también la apruebe. Con «alertar» los dos pasan y el renglón de auditoría registra la coincidencia; apagado quiere decir que no hay revisión. Una clave y no dos a propósito: es una sola decisión sobre las manos del despacho, y dos claves para ella acabarían separándose.',
  'policy.segregation_of_duties.rationale':
    'Un despacho de una sola persona no puede separar funciones; exigirlo por omisión congelaría cada contabilización. Actívalo cuando haya al menos dos usuarios.',
  'policy.segregation_of_duties.why':
    'La segregación de funciones es el control clásico contra que una sola persona invente y aplique una póliza. Si tu despacho puede permitírsela depende de cuántas manos tiene.',
  'policy.segregation_of_duties.what':
    'Con «exigir», `entry post` se niega cuando quien contabiliza creó el borrador, y `bank reconciliation approve` se niega cuando quien aprueba es quien cerró la sesión (los flujos del sistema quedan exentos: se rastrean por su origen). Con «alertar», los dos pasan y dejan el hecho en la bitácora de auditoría.',
  'policy.segregation_of_duties.if_skipped':
    'Se queda apagado: no hay revisión de separación, que es el único valor por omisión viable para un inquilino de un solo usuario; un despacho de una sola persona que tuviera que encontrar a un segundo firmante nunca cerraría un mes.',
  'policy.segregation_of_duties.option.off':
    'Apagado: cualquiera puede contabilizar lo que preparó (despacho de una sola persona)',
  'policy.segregation_of_duties.option.alertar':
    'Avisar: la contabilización pasa y la bitácora de auditoría registra la coincidencia',
  'policy.segregation_of_duties.option.exigir':
    'Exigir: quien contabiliza debe ser un usuario distinto de quien preparó el borrador',

  'policy.reconciliation_tolerance.question':
    '¿Una conciliación bancaria tiene que llegar exactamente a cero, o se puede arrastrar un residuo pequeño?',
  'policy.reconciliation_tolerance.impact':
    'Gobierna `bank reconciliation close`. Con «cero_exacto» la sesión sólo llega a `balanced` cuando los dos lados coinciden al centavo, y la lista de verificación del cierre se puede leer como prueba de que el efectivo se verificó. Con una tolerancia, lo que quede por debajo se arrastra como una partida en conciliación con nombre en vez de bloquear: se cierra más rápido, y el residuo hay que perseguirlo después o envejece.',
  'policy.reconciliation_tolerance.rationale':
    'La lista de verificación del cierre lee una sesión cuadrada como evidencia de que el saldo del efectivo se verificó. Una tolerancia hace esa evidencia más débil de lo que parece, así que hay que pedirla, nunca suponerla.',
  'policy.reconciliation_tolerance.why':
    'Una conciliación bancaria que «casi» cuadra es el escondite más viejo para un error: el residuo es pequeño cada mes y nunca es la misma cosa pequeña. Si tu despacho cierra en cero exacto es una política real: algunos lo hacen, otros arrastran una tolerancia y la persiguen.',
  'policy.reconciliation_tolerance.what':
    'Con «cero_exacto» me niego a cerrar una sesión cuyos dos lados difieren por un centavo, y te digo qué falta explicar. Con una tolerancia la cierro y dejo el residuo como partida en conciliación con responsable y fecha, para que no envejezca en silencio.',
  'policy.reconciliation_tolerance.if_skipped':
    'Exijo cero exacto. Nada se rompe; algunos meses tendrás que perseguir un centavo antes de que cierre.',
  'policy.reconciliation_tolerance.option.cero_exacto':
    'Cero exacto: nada cierra hasta que los dos lados coinciden al centavo',
  'policy.reconciliation_tolerance.option.tolerancia_con_residual':
    'Permitir un residuo por debajo de la tolerancia, arrastrado como partida con nombre',

  'policy.unexplained_bank_line_at_close.question':
    'Al cierre, ¿qué pasa con un renglón del banco que no tiene una póliza que lo explique?',
  'policy.unexplained_bank_line_at_close.impact':
    'Gobierna `bank reconciliation close` cuando el estado de cuenta muestra un movimiento que los libros nunca registraron y que nadie ha clasificado. «partida_conciliatoria» lo arrastra como una partida con nombre, responsable y fecha; «bloquear_cierre» se niega a cerrar hasta que una persona diga qué es; «suspenso» lo estaciona en una cuenta de suspenso, que es una práctica real y también el lugar clásico al que una diferencia va a morir.',
  'policy.unexplained_bank_line_at_close.rationale':
    'Mantiene el movimiento visible y perseguible sin detener el cierre. Bloquear es más estricto pero atora el mes por un solo renglón desconocido; el suspenso lo esconde detrás de un saldo.',
  'policy.unexplained_bank_line_at_close.why':
    'Tarde o temprano el banco muestra un movimiento que tus libros nunca registraron y que nadie reconoce. Qué haces con él el día del cierre es una elección entre detener el mes, arrastrarlo a la vista o estacionarlo; y la tercera es como desaparecen las diferencias.',
  'policy.unexplained_bank_line_at_close.what':
    'Por omisión lo arrastro como partida en conciliación, así que aparece en `bank reconciling-item list` con su antigüedad hasta que alguien lo resuelva. Si eliges «suspenso» lo seguiré nombrando cada mes que se quede ahí: una cuenta de suspenso no es un lugar para dejar de buscar.',
  'policy.unexplained_bank_line_at_close.if_skipped':
    'Lo arrastro a la vista como partida en conciliación, que es la opción que lo mantiene visible.',
  'policy.unexplained_bank_line_at_close.option.partida_conciliatoria':
    'Arrastrarlo como partida en conciliación, con responsable y fecha esperada',
  'policy.unexplained_bank_line_at_close.option.bloquear_cierre':
    'Negarse a cerrar hasta que alguien lo clasifique',
  'policy.unexplained_bank_line_at_close.option.suspenso':
    'Contabilizarlo en una cuenta de suspenso y depurarlo después',

  'policy.bank_statement_overlap.question':
    'Cuando un estado de cuenta nuevo repite movimientos ya importados de otro, ¿qué pasa?',
  'policy.bank_statement_overlap.impact':
    'Gobierna `bank statement import`. Compara cada renglón del archivo nuevo, por su huella de contenido y contando repeticiones, contra los renglones de los OTROS estados de cuenta de la misma cuenta. «block» rechaza el archivo completo y nombra cada renglón repetido y el estado de cuenta en el que ya está; «mark» importa el archivo y anota en cada renglón repetido con qué estado de cuenta se traslapa, visible en `bank statement show --lines`; «warn» importa el archivo y sólo nombra los renglones repetidos en la salida de la importación. Con «mark» y «warn» los movimientos repetidos SÍ están dos veces en los libros hasta que alguien quite uno. Dos renglones idénticos dentro del mismo archivo nunca se tocan con esto: el banco cobró dos veces.',
  'policy.bank_statement_overlap.rationale':
    'Es la única opción en la que nada entra dos veces a los libros sin que una persona lo decida. Un trimestral sobre un mensual se detecta antes de duplicar enero; el costo es que quien opera tiene que recortar el archivo o cambiar esta respuesta.',
  'policy.bank_statement_overlap.why':
    'Los bancos reemiten estados de cuenta y mandan archivos trimestrales que contienen los mensuales. El mismo archivo dos veces ya lo rechazo; dos archivos distintos que comparten movimientos no los puedo distinguir de dos movimientos reales sin que tú decidas qué tan cuidadoso ser.',
  'policy.bank_statement_overlap.what':
    'Por omisión rechazo un estado de cuenta que repite movimientos de otro y te digo qué renglones y dónde están ya. Si eliges «mark» lo importo y dejo una marca en cada renglón repetido; con «warn» lo importo y sólo te aviso.',
  'policy.bank_statement_overlap.if_skipped':
    'Rechazo el estado de cuenta que se traslapa, que es la opción que nunca cuenta un movimiento dos veces.',
  'policy.bank_statement_overlap.option.block':
    'Rechazar el archivo y nombrar los renglones que ya están importados',
  'policy.bank_statement_overlap.option.mark':
    'Importarlo y marcar cada renglón repetido con el estado de cuenta con el que se traslapa',
  'policy.bank_statement_overlap.option.warn':
    'Importarlo y sólo avisar qué renglones ya estaban importados',

  'policy.match_confidence_threshold.question':
    '¿Qué tan seguro tiene que estar el motor de cotejo antes de emparejar un renglón del banco por su cuenta?',
  'policy.match_confidence_threshold.impact':
    'Gobierna `bank match run`. Más bajo quiere decir menos renglones para una persona y más parejas equivocadas que deshacer; más alto quiere decir que el motor te pasa más trabajo pero casi nunca adivina. Un cotejo equivocado no es silencioso —`bank match unapply` lo deshace y deja el motivo—, pero cuesta la revisión que pretendía ahorrar.',
  'policy.match_confidence_threshold.rationale':
    'Es lo que el motor ya usaba antes de que se le preguntara a nadie. Se nombra aquí para que deje de ser un accidente del código.',
  'policy.match_confidence_threshold.why':
    'Cada renglón del banco tiene que terminar emparejado con algo de tus libros. Puedo hacerlo por ti cuando el importe y la fecha coinciden, pero «qué tan cerca es suficientemente cerca» es un juicio sobre tu propia tolerancia a deshacer mis errores, no un dato que yo pueda consultar.',
  'policy.match_confidence_threshold.what':
    'Por encima de este número emparejo el renglón y registro qué tan seguro estaba. Por debajo te lo dejo con mi mejor candidato y el motivo por el que no alcanzó. La sola similitud de la descripción NUNCA empareja nada, con ningún umbral.',
  'policy.match_confidence_threshold.if_skipped':
    'Uso 0.85, que empareja cuando importe y fecha coinciden de cerca y te deja el resto.',
  'policy.match_confidence_threshold.option.0_75':
    'Holgado: empareja más por su cuenta; espera deshacer algunos',
  'policy.match_confidence_threshold.option.0_85':
    'Equilibrado: sólo empareja cuando importe y fecha coinciden de cerca',
  'policy.match_confidence_threshold.option.0_95':
    'Estricto: el motor casi no decide nada solo',

  'policy.match_max_auto_amount.question':
    '¿Por encima de qué importe una persona tiene que confirmar un cotejo, por seguro que esté el motor?',
  'policy.match_max_auto_amount.impact':
    'Una segunda compuerta de `bank match run`, independiente de la confianza: por encima de este importe el renglón se le deja a una persona aun con 0.99. Se combina con el piso inquebrantable por Math.min, así que siempre gana el más estricto de los dos y ningún valor de aquí lo puede subir.',
  'policy.match_max_auto_amount.rationale':
    'Se alinea con FLOOR_MAX_AUTO_POST para que haya una sola cifra sobre la cual razonar, no dos. Es un techo para el motor, nunca un permiso: el piso lo sigue acotando.',
  'policy.match_max_auto_amount.why':
    'La confianza mide qué tanto se parecen dos registros, no cuánto cuesta equivocarse. Una transferencia grande que se ve exactamente como una factura sigue siendo la que querrías ver con tus propios ojos.',
  'policy.match_max_auto_amount.what':
    'Por encima de este importe me detengo y te muestro el candidato en vez de emparejarlo, sin importar qué tan seguro esté. Por debajo, decide el umbral de confianza.',
  'policy.match_max_auto_amount.if_skipped':
    'Me detengo en $50,000, el mismo techo que gobierna la contabilización automática.',
  'policy.match_max_auto_amount.option.10000':
    '$10,000 — una persona ve cada movimiento importante',
  'policy.match_max_auto_amount.option.50000':
    '$50,000 — el mismo techo que usa el piso de contabilización automática',
  'policy.match_max_auto_amount.option.0':
    'Sin compuerta de importe: decide sólo la confianza',

  'policy.short_payment_residual.question':
    'Cuando una cuenta por pagar se cierra pagando menos de lo que se debía, ¿a dónde va el faltante?',
  'policy.short_payment_residual.impact':
    'Gobierna `payment apply --mode residual`. Con «descuento_compras» el faltante cae en 5200 (contracosto), la misma cuenta que un descuento por pronto pago, así que el costo de la compra baja. Con «otros_ingresos» es en cambio un ingreso del periodo y el costo no se toca. Con «prohibir» el modo se rechaza de plano y la cuenta por pagar sigue abierta hasta que el proveedor emita una nota de crédito.',
  'policy.short_payment_residual.rationale':
    'Mantiene un pago corto y un descuento por pronto pago en la misma cuenta, que es lo que económicamente son: menos pagado por la misma compra. También evita inflar los ingresos con algo que nunca fue una venta.',
  'policy.short_payment_residual.why':
    'A veces una cuenta por pagar se liquida por menos de su saldo —un flete en disputa, unos pesos de redondeo, una deducción pactada— y el resto nunca se va a pagar. Ese resto tiene que dejar de ser un pasivo, y a dónde lo mandes cambia tu costo de ventas y tus ingresos. Es un criterio de tu despacho, no una regla del SAT.',
  'policy.short_payment_residual.what':
    'Cuando cierras corta una cuenta por pagar con `payment apply --mode residual --short-pay-reason "..."`, contabilizo el faltante en la cuenta que elijas aquí y escribo tu motivo en la póliza, para que el auditor lea por qué desapareció el pasivo. Si eliges «prohibir», me niego a la operación y te digo que le pidas una nota de crédito al proveedor.',
  'policy.short_payment_residual.if_skipped':
    'Los faltantes van a descuentos sobre compras (5200). Nada se rompe, pero si tu criterio es tratarlos como ingreso, el costo de ventas quedará subestimado hasta que lo digas.',
  'policy.short_payment_residual.option.descuento_compras':
    'Contracosto (5200): reduce lo que costó la compra, como un descuento',
  'policy.short_payment_residual.option.otros_ingresos':
    'Otros ingresos: el costo se queda y el faltante es una ganancia del periodo',
  'policy.short_payment_residual.option.prohibir':
    'Negarse: ninguna cuenta por pagar cierra corta; exigir la nota de crédito del proveedor',

  'policy.employment_subsidy_paid_treatment.question':
    'Cuando el subsidio para el empleo excede el ISR retenido y le entregas la diferencia en efectivo al trabajador, ¿es una cuenta por cobrar al fisco o un gasto del despacho?',
  'policy.employment_subsidy_paid_treatment.impact':
    'Decide si el efectivo que entregas regresa como acreditamiento contra el ISR retenido a otros trabajadores, o cae en gasto de nómina y nunca regresa.',
  'policy.employment_subsidy_paid_treatment.rationale':
    'Es lo que permite la ley y lo que de verdad es el dinero: el patrón adelanta efectivo que la autoridad le devuelve vía acreditamiento. Mandarlo a gasto es decidir renunciar a ese acreditamiento, lo que algunos despachos hacen a propósito cuando los importes son pequeños y el papeleo no vale la pena; pero debe ser una decisión, no la consecuencia de un valor por omisión.',
  'policy.employment_subsidy_paid_treatment.why':
    'Cuando el subsidio es mayor que el ISR del periodo, el patrón debe entregarle la diferencia en efectivo al trabajador. Ese dinero sale del despacho y sólo regresa si lo acreditas. Dónde lo registras cambia tu gasto de nómina y lo que le debes al SAT este mes.',
  'policy.employment_subsidy_paid_treatment.what':
    'Calculo el excedente por recibo, lo anoto en el recibo de nómina como efectivo entregado y lo contabilizo en la cuenta que nombra esta política. Con «cuenta_por_cobrar_fisco» además lo compenso contra el ISR retenido que reporta la declaración mensual.',
  'policy.employment_subsidy_paid_treatment.if_skipped':
    'Va a una cuenta por cobrar a la autoridad. Nada se rompe; si tu criterio es absorberlo, el gasto de nómina quedará subestimado hasta que lo digas.',
  'policy.employment_subsidy_paid_treatment.option.cuenta_por_cobrar_fisco':
    'Una cuenta por cobrar: se acredita contra el ISR retenido a otros trabajadores',
  'policy.employment_subsidy_paid_treatment.option.gasto_del_patron':
    'Un gasto: el despacho lo absorbe y no lo acredita',

  'policy.employment_subsidy_rounding.question':
    '¿Cómo redondeas el subsidio para el empleo de un periodo de pago menor a un mes: una vez, sobre el importe del periodo, o primero sobre el importe diario?',
  'policy.employment_subsidy_rounding.impact':
    'Mueve unos centavos el subsidio de una semana o una quincena, y con él el ISR retenido, el efectivo entregado al trabajador y el CFDI de nómina. En 2026 sólo cambia enero: la quincena es de 264.58 con un redondeo y de 264.60 redondeando primero el importe diario.',
  'policy.employment_subsidy_rounding.rationale':
    'Un solo redondeo, hacia arriba en el medio, sobre el resultado es la lectura que sigue el decreto al pie de la letra —un porcentaje de la UMA mensual, dividido entre 30.4 y multiplicado por los días— sin meter una cifra intermedia que el decreto nunca nombra. De febrero a diciembre de 2026 da 535.65 al mes, 264.30 a la quincena y 123.34 a la semana. El 536.22 del considerando del decreto no es una opción: ningún redondeo de la UMA vigente lo produce.',
  'policy.employment_subsidy_rounding.why':
    'El decreto fija el porcentaje de la UMA y dice dividir entre 30.4 y multiplicar por los días, pero no dónde redondear. El software de nómina y los despachos lo hacen de las dos formas, y la diferencia llega al trabajador y al SAT.',
  'policy.employment_subsidy_rounding.what':
    'Cada corrida de nómina mexicana calcula el subsidio mensual al centavo y deriva el del periodo de ese importe mensual redondeado, de la forma que elijas aquí. La nota del recibo nombra el redondeo usado.',
  'policy.employment_subsidy_rounding.if_skipped':
    'Redondeo una vez, sobre el importe del periodo. De febrero a diciembre las dos opciones dan las mismas cifras.',
  'policy.employment_subsidy_rounding.option.producto_al_centavo':
    'Una vez: el importe mensual al centavo, luego mensual × días / 30.4 al centavo',
  'policy.employment_subsidy_rounding.option.diario_al_centavo':
    'Primero el importe diario: mensual / 30.4 al centavo, luego × los días del periodo',

  'policy.isn_taxing_state.question':
    'Para el impuesto sobre nómina (ISN), ¿a qué estado pertenece un trabajador: al estado donde se presta el trabajo, o al del domicilio fiscal del despacho?',
  'policy.isn_taxing_state.impact':
    'Decide en qué estado declaras y a qué tasa: las tasas van de cerca del 1% al 4% y cada estado fiscaliza lo suyo.',
  'policy.isn_taxing_state.rationale':
    'El ISN es un impuesto estatal sobre la nómina pagada por trabajo prestado dentro de ese estado, así que el estado donde se trabaja es el que lo puede exigir. Un despacho cuyos trabajadores están todos en el domicilio fiscal obtiene la misma respuesta de las dos formas; uno con gente en varios estados no, y declarar todo en el estado de la oficina matriz es como un despacho acaba debiéndole a otro estado durante años sin saberlo.',
  'policy.isn_taxing_state.why':
    'Las plantillas remotas y en varios estados hacen de esto una bifurcación real, y no es una regla que el sistema pueda resolver: depende de dónde están tus establecimientos y de lo que dice de ellos la ley de cada estado.',
  'policy.isn_taxing_state.what':
    'Agrupo cada corrida de nómina por el estado al que apunta esta política, busco la tasa de ese estado para el periodo y devengo un pasivo de ISN por estado. Si un estado no tiene tasa capturada, digo qué estado y qué periodo en vez de calcular cero.',
  'policy.isn_taxing_state.if_skipped':
    'Uso el estado donde trabaja el empleado. Si tus establecimientos están todos en un estado, esto no cambia nada.',
  'policy.isn_taxing_state.option.centro_de_trabajo':
    'Donde se presta el trabajo (el estado donde trabaja el empleado)',
  'policy.isn_taxing_state.option.domicilio_fiscal':
    'El estado del domicilio fiscal del despacho, para cada trabajador',

  'policy.isn_recognition_basis.question':
    '¿Devengas el ISN cuando se gana la nómina, o cuando se paga?',
  'policy.isn_recognition_basis.impact':
    'Mueve el gasto entre meses cada vez que un periodo de pago cruza un fin de mes.',
  'policy.isn_recognition_basis.rationale':
    'El gasto de nómina sobre el que va montado está devengado, y separar el impuesto de su base pone los dos en meses distintos sin razón. Los despachos con criterio de flujo de efectivo para los impuestos estatales pueden decirlo aquí.',
  'policy.isn_recognition_basis.why':
    'Un periodo de pago que empieza en un mes y termina en el siguiente tiene que caer en algún lado, y las dos respuestas dan resultados mensuales distintos.',
  'policy.isn_recognition_basis.what':
    'Fecho el pasivo de ISN con el criterio que elijas aquí, y el vencimiento con el calendario del estado en cualquier caso.',
  'policy.isn_recognition_basis.if_skipped':
    'Se devenga con la nómina que lo causó.',
  'policy.isn_recognition_basis.option.devengo':
    'Cuando se gana, con la nómina a la que pertenece',
  'policy.isn_recognition_basis.option.pago':
    'Cuando se paga, con el efectivo que sale',

  'policy.employer_contribution_accrual.question':
    '¿Devengas las cuotas patronales del IMSS y del INFONAVIT con cada corrida de nómina, o una vez al mes cuando se pagan?',
  'policy.employer_contribution_accrual.impact':
    'Decide si una nómina de mediados de mes muestra su costo patronal de inmediato o sólo al fin de mes.',
  'policy.employer_contribution_accrual.rationale':
    'La cuota patronal es un costo del mismo trabajo que paga la nómina, y devengarla con su corrida mantiene completo el costo de un periodo sin esperar al fin de mes. Los despachos que concilian contra el SUA renglón por renglón suelen preferir el devengo mensual, y ése es un criterio real, no un error.',
  'policy.employer_contribution_accrual.why':
    'El IMSS y el INFONAVIT se pagan mensual y bimestralmente, no por corrida de nómina, así que hay una elección genuina entre empatar el costo y empatar el pago.',
  'policy.employer_contribution_accrual.what':
    'Escribo un renglón de pasivo patronal por corrida de nómina o uno por mes según esto, y la conciliación del SUA lee el que hayas elegido.',
  'policy.employer_contribution_accrual.if_skipped':
    'Se devengan con cada corrida de nómina.',
  'policy.employer_contribution_accrual.option.por_corrida':
    'Con cada corrida de nómina, junto a la nómina que la causó',
  'policy.employer_contribution_accrual.option.mensual_al_cierre':
    'Una vez al mes, igual que como de verdad se pagan',

  'policy.archived_accounts_in_reports.question':
    'Una vez archivada una cuenta, ¿conserva su renglón en una balanza donde no tiene nada que mostrar?',
  'policy.archived_accounts_in_reports.impact':
    'Sólo afecta a una cuenta archivada que NUNCA recibió un renglón contabilizado antes de la fecha de corte: una línea del catálogo que se abrió y se retiró sin usarse nunca. En cuanto una cuenta archivada tiene cualquier historial contabilizado, se muestra en todos los informes y ningún valor de aquí la puede esconder: eso es lo que impidió que un estado de resultados firmado cambiara cuando se ordenó el catálogo, y es conservador a propósito; la regla se inclina por mostrar, porque la falla que existe para evitar es dinero que desaparece de un estado firmado. Lo que esto decide es si la línea retirada que nunca se usó conserva su renglón en cero, mes tras mes.',
  'policy.archived_accounts_in_reports.rationale':
    'Es PARA lo que sirve archivar —el despacho retiró la línea para dejar de verla— y es lo que ya hacían los informes, así que ninguna balanza gana renglones que nunca tuvo. Conservarla es un criterio real para un despacho que concilia el Anexo 24 contra un catálogo fijo y quiere el mismo juego de renglones cada periodo; ninguna de las dos respuestas mueve una cifra, que es justo por lo que es una preferencia y no una corrección.',
  'policy.archived_accounts_in_reports.why':
    'Retirar una línea de tu catálogo al cierre del ejercicio es rutina. Lo que no es obvio es si esa línea debe desaparecer de la balanza del año siguiente o quedarse ahí en cero, y las dos son contabilidad defendible.',
  'policy.archived_accounts_in_reports.what':
    'En la balanza siempre incluyo una cuenta archivada que el mayor respalda hasta la fecha de corte del informe —CUALQUIER renglón contabilizado hasta ella, no sólo movimiento en el rango—, así que ninguna cifra desaparece nunca. Con «retirar» dejo fuera las cuentas archivadas que nunca recibieron uno; con «mantener» las conservo, en cero, junto a las cuentas vigentes sin uso que la balanza ya lista. El estado de resultados, el balance general y el mayor no leen esta política en absoluto: ya muestran exactamente las cuentas que llevan algo en el periodo.',
  'policy.archived_accounts_in_reports.if_skipped':
    'Una cuenta archivada que nunca se usó sale de la balanza. Toda cuenta archivada con historial contabilizado se queda, siempre.',
  'policy.archived_accounts_in_reports.option.retirar_cuando_no_tiene_nada':
    'Quitarla: una línea archivada que nunca se usó sale de la balanza',
  'policy.archived_accounts_in_reports.option.mantener_en_la_balanza':
    'Conservarla en cero, como cualquier cuenta sin uso, para que el juego de renglones coincida con el catálogo cada mes',

  'policy.cash_flow_unclassified.question':
    'Cuando una cuenta se movió pero no pertenece a ninguna sección del estado de flujos de efectivo, ¿publico el estado nombrándola o me niego hasta que tenga una?',
  'policy.cash_flow_unclassified.impact':
    'Esta NO es la misma pregunta que la de un estado que no cuadra con el efectivo. Dos cuentas sin clasificar cuyos importes se cancelan dejan el neto cuadrando perfecto contra el banco mientras operación, inversión y financiamiento están cada uno mal por la parte que les tocaba. El residuo es invisible desde fuera: nadie lo puede detectar comparando contra el estado de cuenta del banco.',
  'policy.cash_flow_unclassified.rationale':
    'Negarse dejaría al despacho sin un estado que puede necesitar para un plazo de presentación, y el remedio —darle a la cuenta un fs_category— es una edición del catálogo que quien prepara el estado puede no poder hacer en ese momento. Nombrar las cuentas mantiene el documento utilizable y pone el hueco donde lo ve quien lo prepara.',
  'policy.cash_flow_unclassified.why':
    'Si un estado con una cuenta sin clasificar se puede publicar lo decides tú. Lo único que no voy a hacer es quedarme callado: una cuenta que se movió y no cayó en ninguna sección es un subtotal que está mal sin que el total lo muestre.',
  'policy.cash_flow_unclassified.what':
    'Publico el estado y nombro cada cuenta que se movió sin sección.',
  'policy.cash_flow_unclassified.if_skipped':
    'Lo publico y las nombro.',
  'policy.cash_flow_unclassified.option.avisar':
    'Publicarlo, nombrando cada cuenta que no cayó en ninguna sección',
  'policy.cash_flow_unclassified.option.bloquear':
    'Negarse a emitirlo hasta que cada cuenta que se movió tenga una sección',

  'policy.withholding_accounts_layout.question':
    '¿En qué cuentas se acumulan el ISR y el IVA que esta entidad les retiene a sus proveedores?',
  'policy.withholding_accounts_layout.impact':
    'Decide dónde se registran las retenciones de honorarios y arrendamiento hasta que el día 17 se pagan. El ISR de nómina se queda en 2140 en cualquier esquema. Una cuenta por impuesto da los dos renglones del pago mensual y de la DIOT sin partir un saldo. Tres cuentas siguen el código agrupador del SAT (216.03 arrendamiento, 216.04 servicios profesionales, 216.10 IVA); el ISR retenido sobre algo que no sea arrendamiento se registra como servicios profesionales. Con una cuenta por impuesto, 2141 junta el ISR de arrendamiento y de honorarios, así que su código agrupador en la balanza del Anexo 24 (CFF 28-IV) sólo puede ser uno de los dos. Una sola cuenta necesita el papel de trabajo para separar el ISR del IVA, y la aprobación de un borrador sólo puede revisar su suma.',
  'policy.withholding_accounts_layout.rationale':
    'El retenedor paga el ISR (LISR 106, 116) y el IVA (LIVA 1-A, 5-D) que retuvo con la declaración mensual que vence el día 17, como impuestos separados, y la DIOT reporta el IVA retenido por proveedor (LIVA 32-VIII): un saldo por impuesto es lo que leen las dos sin partir nada. Es con lo que se siembran las entidades.',
  'policy.withholding_accounts_layout.why':
    'Algunos despachos llevan una sola cuenta de retenciones, otros una por impuesto, otros siguen el código agrupador del SAT renglón por renglón.',
  'policy.withholding_accounts_layout.what':
    'Apunto los dos roles de retención a las cuentas del esquema, creo las que falten y registro ahí cada retención.',
  'policy.withholding_accounts_layout.if_skipped':
    'Llevo una cuenta por impuesto: 2141 para el ISR, 2142 para el IVA.',
  'policy.withholding_accounts_layout.option.per_tax':
    'Una cuenta por impuesto: 2141 ISR retenido, 2142 IVA retenido',
  'policy.withholding_accounts_layout.option.single':
    'Una cuenta para los dos: 2143 ISR e IVA retenidos',
  'policy.withholding_accounts_layout.option.by_concept':
    'Tres cuentas: 2144 ISR por arrendamiento (216.03), 2145 ISR por servicios profesionales (216.04), 2142 IVA (216.10)',

  'policy.withholding_accounts_existing.question':
    'Cuando los roles de retención de una entidad existente no siguen el esquema, ¿qué hago?',
  'policy.withholding_accounts_existing.impact':
    'Gobierna las entidades sembradas antes de que existiera el esquema (los dos roles en 2140, con el ISR de nómina) o cuyo esquema cambió. «warn» las nombra en doctor y en la lista de verificación del cierre, sin bloquear, con el comando que las arregla: `account role sync`, que tiene --dry-run. «repoint» lo corre cuando se fija esta clave o el esquema, y avisa de lo que no pudo mover. «keep» no hace ninguna de las dos. El comando crea las cuentas que faltan y reapunta los roles, con auditoría; no contabiliza nada y deja los saldos pasados donde están. Un mapeo que alguien fijó a mano nunca se sobrescribe.',
  'policy.withholding_accounts_existing.rationale':
    'Reapuntar cambia dónde caen las retenciones del mes siguiente, y el saldo que ya está en 2140 se queda ahí hasta que alguien lo reclasifique con una póliza. La contabilidad debe permitir rastrear cada operación hasta su cuenta (CFF 28, RCFF 33): un cambio que una persona revisó con --dry-run es uno que el despacho puede explicarle a un auditor; un cambio que nadie miró, no.',
  'policy.withholding_accounts_existing.why':
    'Mover los roles de una empresa que ya está contabilizando cambia sus libros a partir de la siguiente póliza.',
  'policy.withholding_accounts_existing.what':
    'Aviso y nombro `account role sync`; con «repoint» lo corro yo mismo cuando se fija el esquema.',
  'policy.withholding_accounts_existing.if_skipped':
    'Aviso, y no cambio nada.',
  'policy.withholding_accounts_existing.option.warn':
    'Avisar en doctor y en la lista de verificación del cierre, nombrando el comando',
  'policy.withholding_accounts_existing.option.repoint':
    'Reapuntarlos, con auditoría, cuando se fija el esquema',
  'policy.withholding_accounts_existing.option.keep':
    'Dejarlos como están, sin aviso',

  'policy.time_zone.question':
    '¿En qué zona horaria cae el «hoy» de estos libros?',
  'policy.time_zone.impact':
    'Cada fecha que el sistema llena por su cuenta —una nota de crédito creada sin --date, por ejemplo— es el día de calendario en esta zona en ese momento. A las 20:00 en la Ciudad de México ya es el día siguiente en UTC; una fecha tomada de UTC deja el documento en el día siguiente y, el último día de un mes, en el periodo y la serie de folios siguientes.',
  'policy.time_zone.rationale':
    'La mayoría de los libros mexicanos llevan la hora del centro, que no tiene horario de verano desde 2022. Se acepta cualquier zona IANA; una que el entorno de ejecución no conoce se rechaza, porque una zona mal escrita caería si no en algún otro reloj sin decirlo.',
  'policy.time_zone.why':
    'El reloj del servidor corre en UTC. Si el día con el que se fecha un documento es el de la Ciudad de México, el de Tijuana o el de Cancún es un hecho de tus libros que no puedo adivinar.',
  'policy.time_zone.what':
    'Tomo el día de calendario en esta zona cada vez que no me dan una fecha.',
  'policy.time_zone.if_skipped':
    'Uso el día de la Ciudad de México.',
  'policy.time_zone.option.america_mexico_city':
    'Centro de México (UTC−6 todo el año)',
  'policy.time_zone.option.america_tijuana':
    'Baja California (sigue el horario de verano de EE. UU.)',
  'policy.time_zone.option.america_cancun':
    'Quintana Roo (UTC−5 todo el año)',
  'policy.time_zone.option.america_hermosillo':
    'Sonora (UTC−7 todo el año)',
  // ==== end of policy.* ===============================================

  // --- El kernel: confirmación y salida --------------------------------
  confirm_answer_not_understood:
    'no entendí «{answer}»: responde y/s para sí, n para no',

  no_changes_ledger_untouched: 'Sin cambios: el mayor no se tocó.',

  no_changes_no_terminal:
    'Sin cambios: no hay terminal donde confirmar. Añade -y para que `{command}` corra ' +
    'sin preguntar, o --dry-run para ver el efecto completo sin escribir nada.',

  // --- Los ensayos, que dicen qué se deshizo ---------------------------
  dry_run_rolled_back: 'Ensayo: se escribió de verdad y se deshizo.',

  dry_run_no_asset_created: 'Ensayo: la transacción se deshizo. No se creó ningún activo.',

  dry_run_ledger_untouched: 'Ensayo: el mayor no se tocó y no se escribió ningún renglón.',

  // --- Los tres `(s)` que el plural propio viene a jubilar -------------
  cfdi_cancelled_by_issuer:
    '{count, plural, one {# CFDI cancelado} other {# CFDI cancelados}} por el emisor: ' +
    'revisa su efecto contable con cfdi list --json',

  diot_checks_passed:
    'sin hallazgos: la DIOT pasa ' +
    '{count, plural, one {la # verificación pedida} other {las # verificaciones pedidas}}.',

  diot_findings_summary:
    '{blocking, plural, one {# bloqueante} other {# bloqueantes}}, ' +
    '{warnings, plural, one {# aviso} other {# avisos}}. ' +
    'Un bloqueante impide capturar la declaración.',

  // --- El único `select` de la siembra ---------------------------------
  prepaid_row_skipped:
    '{reason, select, ' +
    'coverage_not_started {la cobertura todavía no empieza} ' +
    'coverage_ended {la cobertura ya terminó} ' +
    'zero_month_row {el renglón del mes es cero} ' +
    'no_balance_left {no queda saldo por devengar} ' +
    'other {no hay nada que devengar este mes}}',

  // --- Prosa de listado ------------------------------------------------
  prepaid_no_live_schedule: 'No hay ningún calendario vivo en esta entidad.',

  prepaid_no_schedule_covers_date: 'Ningún calendario cubre el {date}. Con -a se listan todos.',

  bank_run_hit_cap:
    'La corrida llegó a su tope: quedan movimientos sin evaluar. Vuelve a correrla.',
  // ====================================================================
  // I7 · EL CROMO DEL CLI, EL KERNEL Y LAS HOJAS DE `mnemosine.ts`
  //
  // EL ESPAÑOL DE UN TÍTULO DE COMMANDER NO ES UNA TRADUCCIÓN LIBRE. `Uso:`,
  // `Opciones:` y `Comandos:` son las palabras con las que un contador mexicano
  // ya lee cualquier binario traducido; inventar sinónimos aquí obligaría a
  // aprender dos vocabularios para la misma pantalla.
  //
  // LO QUE NO SE TRADUCE, y está decidido: los NOMBRES de las banderas
  // (`--dry-run`, `--entity`) y de los comandos. La R8 del catálogo dice que
  // el nombre canónico sigue en inglés con alias español; lo que se traduce es
  // el TEXTO que los explica. Por eso `--dry-run` aparece igual en las dos
  // columnas y `compute and show the full effect` no.
  // ====================================================================

  // --- El cromo que Commander maqueta solo -----------------------------
  'cli.chrome.usage': 'Uso:',
  'cli.chrome.arguments': 'Argumentos:',
  'cli.chrome.options': 'Opciones:',
  'cli.chrome.global_options': 'Opciones globales:',
  'cli.chrome.commands': 'Comandos:',
  'cli.chrome.help_description': 'muestra la ayuda del comando',
  'cli.chrome.version_description': 'imprime el número de versión',

  // --- Los errores que Commander escribe por `outputError` -------------
  'cli.error.unknown_command': 'error: no existe el comando «{name}»',
  'cli.error.unknown_option': 'error: no existe la opción «{flag}»',
  'cli.error.missing_argument': 'error: falta el argumento obligatorio «{name}»',
  'cli.error.option_missing_argument': 'error: a la opción «{flags}» le falta su valor',
  'cli.error.missing_mandatory_option': 'error: falta la opción obligatoria «{flags}»',
  'cli.error.did_you_mean': '(¿Querías decir {suggestion}?)',
  'cli.error.did_you_mean_one_of': '(¿Querías decir alguno de {suggestions}?)',

  // --- El diccionario de banderas (`src/cli/kernel/flags.ts`) ----------
  'cli.flag.entity': 'entidad legal sobre la que operar (por omisión, la activa)',
  'cli.flag.tenant_scope': 'inquilino (despacho) al que se acota lo que se lee y se escribe',
  'cli.flag.user': 'usuario que actúa, para la atribución y los permisos',
  'cli.flag.format': 'formato de salida',
  'cli.flag.json': 'atajo de --format json',
  'cli.flag.output': 'escribe en un archivo en vez de en la salida estándar',
  'cli.flag.fields':
    'columnas separadas por comas; sin valor, lista las disponibles',
  'cli.flag.quiet': 'sólo identificadores, uno por renglón, para encadenar por tubería',
  'cli.flag.limit': 'máximo de renglones a devolver',
  'cli.flag.offset': 'salta estos renglones',
  'cli.flag.status': 'filtra por estado del ciclo de vida (se puede repetir)',
  'cli.flag.all': 'sin límite por omisión; incluye lo archivado y lo cerrado',
  'cli.flag.period':
    'selector de periodo: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06',
  'cli.flag.since': 'límite inferior inclusivo (AAAA-MM-DD)',
  'cli.flag.until': 'límite superior inclusivo (AAAA-MM-DD)',
  'cli.flag.as_of': 'fecha de valuación o de saldo (AAAA-MM-DD)',
  'cli.flag.date_basis': 'a qué fecha se aplican los filtros',
  'cli.flag.strict': 'trata los avisos como bloqueantes (salida 4)',
  'cli.flag.force':
    'pasa por encima de una validación bloqueante (periodo cerrado, fecha de bloqueo, ' +
    'duplicado); exige --reason',
  'cli.flag.note': 'anotación libre que se guarda con el registro',

  'cli.flag.error_not_whole_number':
    '{name} tiene que ser un entero no negativo; llegó "{value}".',
  'cli.flag.error_not_port': '{name} tiene que ser un puerto entre 0 y 65535; llegó "{value}".',
  'cli.flag.error_not_origin':
    '{name} tiene que ser sólo un origen —esquema, anfitrión y puerto, sin ruta—; llegó "{value}".',
  'cli.flag.error_empty': '{name} no puede ir vacía.',
  'cli.flag.error_not_date': '{name} tiene que ser una fecha AAAA-MM-DD; llegó "{value}".',

  // --- Las banderas que inyecta la declaración de riesgo (risk.ts) -----
  'cli.flag.dry_run':
    'calcula y muestra el efecto completo; no escribe nada ni llama a nada externo',
  'cli.flag.yes': 'omite la confirmación',
  'cli.flag.idempotency_key':
    'llave de deduplicación del cliente, guardada al tener éxito: un reintento con la misma ' +
    'llave y la misma carga devuelve el resultado registrado',
  'cli.flag.idempotency_key_unhonored':
    'este comando TODAVÍA NO la honra: un reintento vuelve a escribir en vez de devolver el ' +
    'resultado registrado',
  'cli.flag.idempotency_key_unneeded':
    'no hace falta: este comando ya deduplica por el estado que escribe; se acepta y se ignora',
  'cli.flag.live': 'realiza el efecto externo de verdad (por omisión se usa el entorno de pruebas)',
  'cli.flag.reason': 'justificación que queda en el rastro de auditoría (obligatoria)',

  // --- La compuerta de mutación (`src/cli/kernel/risk.ts`) -------------
  'cli.risk.key_not_honored':
    '«{command}» acepta --idempotency-key porque su clase de riesgo la exige, pero TODAVÍA NO ' +
    'LA HONRA: {reason}. La llave «{key}» no deduplicaría nada: un reintento volvería a ' +
    'escribir. Vuelve a ejecutar SIN la llave y comprueba antes el estado del dominio que este ' +
    'comando toca (el documento, el saldo o el asiento), o repite con --dry-run para ver qué haría.',
  'cli.risk.undeclared':
    '«{command}» pide una compuerta de mutación sin haber declarado su riesgo. Toda hoja que ' +
    'muta declara con `declareRisk` junto a su registro; sin declaración no hay confirmación, ' +
    'ni marcha seca, ni rastro de auditoría que decir.',
  'cli.risk.force_needs_reason':
    '--force pasa por encima de una regla de seguridad, así que exige --reason "<por qué>". ' +
    'El motivo queda escrito en el rastro de auditoría.',
  'cli.risk.undo_needs_reason':
    '«{command}» deshace o revoca algo, así que exige --reason "<por qué>".',
  'cli.risk.gate_flags_not_honored':
    '"{command}" acepta {flags} pero su manejador todavía no las honra: ejecutaría de verdad ' +
    'mientras la bandera promete lo contrario. Se rechaza en vez de fingir. (La bandera existe ' +
    'porque la clase de riesgo la exige; el cableado del manejador es trabajo de CLI-F2.)',

  // --- La entidad activa (`src/cli/kernel/entity-context.ts`) ----------
  'cli.entity.database_unreachable':
    'No se pudo llegar a la base al resolver la entidad activa ({entity}): {detail}',
  'cli.entity.database_unreachable_remedy':
    'mnemosine doctor   (y revisa DATABASE_URL en .env)',
  'cli.entity.pinned_unresolved': 'La entidad fijada ({entity}) no se pudo resolver: {detail}',
  'cli.entity.pinned_unresolved_remedy':
    'mnemosine entity use <id|nombre>   (o `mnemosine entity unset` para soltarla)',
  'cli.entity.pin_was_kept': 'La entidad fijada se conservó.',
  'cli.entity.must_be_named':
    'Este comando cambia datos, así que no va a adivinar la entidad. Nómbrala con ' +
    '--entity <id|nombre> o fija una con `mnemosine entity use`.',

  // --- El renderizador (`src/cli/kernel/output.ts`) --------------------
  'cli.output.unknown_format': 'No existe el --format "{value}". Usa uno de: {formats}.',
  'cli.output.unknown_fields': 'Campos que no existen: {unknown}. Disponibles: {available}.',

  // --- La salida (`src/cli/kernel/exit.ts`) ----------------------------
  'cli.exit.aborted': 'Cancelado.',

  // --- La raíz y sus dos banderas globales -----------------------------
  'help.root.description':
    'Asistente contable con IA — conversa con tu contabilidad desde la terminal',
  'cli.flag.tenant_root':
    'Inquilino sobre el que operar. Precedencia: esta bandera > MNEMOSINE_TENANT > ' +
    'mnemosine.config.json. Acota TODA consulta por RLS',
  'cli.flag.locale':
    'Idioma y convenciones de lo que se IMPRIME ({locales}). Precedencia: esta bandera > ' +
    '{envVar} ({envAlias} es su alias permanente) > ~/.mnemosine/config.json > ' +
    './mnemosine.config.json > lo que diga el inquilino > {fallback}. No cambia nada de lo que ' +
    'se entrega a una autoridad',

  // --- Las hojas que `src/cli/mnemosine.ts` registra por su cuenta ------
  'help.entities.description':
    'Lista las entidades legales activas (en desuso: usa `mnemosine entity list`)',
  'help.providers.description':
    'Lista los proveedores de modelos configurados (los de fábrica + mnemosine.config.json)',
  'help.ask.description': 'Hace una sola pregunta y sale',
  'help.chat.description': 'Abre una sesión de conversación (es el comando por omisión)',
  'help.sessions.description':
    'Lista las sesiones de conversación recientes (retoma una con: mnemosine chat --resume <id>)',
  'help.drafts.description': 'Lista los borradores de póliza que creó la IA',
  'help.review.description':
    'Revisa los borradores pendientes: aprobar (crea la póliza y la contabiliza), corregir y ' +
    'aprobar, o rechazar — un rechazo puede sembrar el criterio para la próxima vez',
  'review.draft.bill_to_be_born':
    'Aprobar crea la factura del proveedor del CFDI {uuid} · emisor {issuer} ({rfc}) · método {method} · total {total}',
  'review.draft.invoice_to_be_born':
    'Aprobar crea la factura al cliente del CFDI emitido {uuid} · cliente {customer} ({rfc}) · método {method} · total {total}',
  'review.vendor.register_prompt': '¿Dar de alta al proveedor {name} (RFC {rfc})? [s/N] ',
  'review.vendor.not_registered':
    'No se dio de alta al proveedor: no se contabilizó nada y el borrador sigue pendiente.',
  'help.ingest.description':
    'Ingesta por lote de CFDI (XML): reglas → clasificación por IA → borradores (o alta ' +
    'automática según los umbrales)',
  'help.lang.description':
    'Muestra o fija el idioma de las respuestas del AGENTE (la interfaz del CLI sigue su ' +
    'propio locale; los alias españoles funcionan siempre)',
  'help.onboard.description':
    'Importa la contabilidad de un cliente desde un sistema externo (catálogo de cuentas + ' +
    'saldos iniciales)',
  'help.outbox.description':
    'Operaciones encoladas para sistemas contables externos: listar, revisar y ejecutar',
  'help.outbox.list.description': 'Lista las operaciones externas encoladas (por omisión, las pendientes)',
  'help.outbox.run.description':
    'Ejecuta las operaciones encoladas contra el sistema externo del cliente (el efecto real ' +
    'exige --live)',
  'help.question.description':
    'Las preguntas pendientes del agente: listar, responder (queda como precedente) o descartar',
  'help.question.list.description': 'Lista las preguntas del agente (por omisión, las pendientes)',
  'help.question.answer.description':
    'Responde una pregunta (la respuesta queda como precedente), o atiende la cola de pendientes',
  'help.login.description': 'Inicia sesión con tu proveedor de identidad (OIDC)',
  'help.logout.description': 'Borra la credencial guardada en esta máquina',
  'help.whoami.description': 'Muestra la credencial activa y hasta cuándo sirve',
  'help.subscription.description':
    'Suscripciones a eventos salientes: a quién avisamos y qué no se pudo entregar',

  // --- W0 · `src/cli/web-command.ts`, the web gateway's operator entry ---
  'help.web.description': 'El tablero en el navegador: un gateway de sólo lectura delante de la API',
  'help.web.start.description':
    'Arranca el gateway web, que guarda la sesión del navegador y reenvía lecturas a /v1; corre hasta ' +
    'Ctrl+C (en producción se usa node dist/gateway/main.js)',
  'help.web.start.port': 'Puerto en el que escucha (por omisión: GATEWAY_PORT, si no 8080)',
  'help.web.start.host': 'Dirección en la que escucha (por omisión: GATEWAY_HOST, si no 127.0.0.1)',
  'help.web.start.api_url': 'Origen de la API a la que reenvía (por omisión: GATEWAY_API_URL)',
  'help.web.start.public_origin':
    'Origen que abre el navegador, y bajo el que contesta el gateway (por omisión: GATEWAY_PUBLIC_ORIGIN)',
  'web.start.listening': 'Abre {origin} en el navegador. Ctrl+C detiene el gateway.',

  // ==== I7 · EL PILOTO: `src/cli/bank-command.ts` (issue #149) =====
  // --- Los analizadores de bandera: uso (2), no validación (4) ---------
  'receipt.withholding.unreadable':
    'No entiendo la retención "{spec}": escribe "isr:1000" o "iva:1066.67", y con varias facturas antepón el folio ("INV-2026-00042:isr:1000").',
  'receipt.withholding.which_invoice':
    'Con varias facturas, la retención "{spec}" tiene que decir de cuál es ("INV-2026-00042:{spec}").',
  'receipt.withholding.not_applied':
    'La retención "{spec}" nombra {invoice}, que no está entre las --invoice de esta aplicación.',
  'receipt.withholding.negative': 'Una retención no puede ser negativa ({amount}).',
  'receipt.withholding.cash_required':
    'El efectivo aplicado a {invoice} debe ser mayor que cero (llegó {amount}): una retención viaja con una aplicación de efectivo, nunca se aplica sola.',
  'receipt.withholding.exceeds_due':
    '{invoice} debe {due} y se intentan aplicar {settled} ({cash} cobrado + {withheld} retenido).',
  'receipt.withholding.vat_cap': '{invoice} traslada {cap} de IVA: el cliente no puede retener más que eso.',
  'receipt.withholding.isr_cap': '{invoice} tiene un subtotal de {cap}: el ISR retenido no puede pasar de ahí.',
  'receipt.withholding.booked_at_issuance':
    '{invoice} ya registró la retención del cliente ({amount}) al emitirse: su cuenta por cobrar es el neto que paga el cliente. Aplica sólo el efectivo; --withholding es para facturas cuya cuenta por cobrar se registró en bruto.',
  'bank.parse.date_invalid': '{flag} debe ser una fecha real en formato YYYY-MM-DD; llegó "{value}".',
  'bank.parse.amount_invalid': '{flag} debe ser un importe decimal; llegó "{value}".',
  'bank.parse.rate_invalid': '{flag} debe ser una tasa decimal; llegó "{value}".',
  'bank.parse.rate_out_of_range':
    '{flag} va entre 0 y 1, no en porcentaje: 0.16 para el 16%, 0.0125 para el 1.25%, 0 para ' +
    'ninguna. Llegó "{value}".',
  'bank.parse.account_type_unknown':
    '--type "{value}" no es un tipo de cuenta. Los cinco son: {types}.',
  'bank.parse.account_status_unknown':
    '--status {values} no existe para una cuenta bancaria: sólo active y archived.',
  'bank.parse.transaction_status_unknown':
    '-s {values} no existe para un movimiento bancario: sólo matched y unmatched. El resto de su ' +
    'estado —de qué estado de cuenta vino, qué lo explica— se lee con `bank transaction show`.',
  'bank.parse.unmatched_contradicts_status':
    '--unmatched y `-s matched` piden lo contrario. --unmatched es el atajo de `-s unmatched`: ' +
    'pasa uno de los dos.',
  'bank.parse.direction_unknown':
    '--direction "{value}" no existe: in es dinero que entra (importe positivo) y out el que sale.',
  'bank.parse.id_list_empty': '{flag} llegó vacía: nombra al menos un identificador.',
  'bank.parse.id_list_invalid':
    '{flag} {values} no es un identificador: se esperan uuid separados por comas, como los que ' +
    'imprime `bank transaction list -q`.',
  'bank.parse.uuid_invalid': '{flag} "{value}" no es un identificador: se espera un uuid.',
  'bank.parse.matchable_type_unknown':
    '"{value}" no es un tipo cotejable. Los cinco son: {types}. Escribe <tipo>:<id>, o sólo <id> ' +
    'para una partida de póliza.',
  'bank.parse.book_item_uuid_missing':
    '--book-item "{value}" no trae un identificador válido después del tipo.',
  'bank.parse.residual_unknown':
    '--residual "{value}" no existe. keep deja el residual vivo como partida conciliatoria; ' +
    'write-off lo cancela contra la cuenta que diga --write-off-account.',
  'bank.parse.unapply_reason_required':
    '--reason es obligatorio y es un CÓDIGO, no prosa: {codes}. Una taxonomía cerrada es lo que ' +
    'permite preguntar cuántos cotejos se deshicieron por documento cancelado este trimestre; un ' +
    'campo libre contesta eso con un grep.',
  'bank.parse.item_type_unknown':
    '--type "{value}" no es un tipo de partida conciliatoria. Los seis son: {types}.',
  'bank.parse.adjustment_type_unknown':
    '--type "{value}" no es un tipo de ajuste de conciliación. Los cinco son: {types}.',
  'bank.parse.run_step_unknown':
    '--stop-at "{value}" no es un paso del pase guiado. Los cinco, en orden: {steps}. Ninguno ' +
    'llega a `approve` ni a `post`.',
  'bank.parse.session_status_one_only':
    '-s admite un estado a la vez en esta hoja (llegaron {count}): {statuses}. Sin la bandera ' +
    'salen los cuatro.',
  'bank.parse.session_status_unknown':
    '-s "{value}" no es un estado de sesión de conciliación. Los cuatro son: {statuses}.',
  'bank.parse.item_status_unknown':
    '-s {values} no existe para una partida conciliatoria: sólo open y resolved. Una partida ' +
    'resuelta dejó de explicar una diferencia y por eso no sale por omisión.',
  'bank.query.unclosed_quote': 'La consulta "{query}" abre una comilla y no la cierra.',
  'bank.query.term_unknown':
    'La consulta no conoce el término "{term}:". Los que hay son {terms}, y una palabra sin ' +
    'prefijo busca en la descripción. El resto se acota con banderas (--account, --since, ' +
    '--until, --direction, --type).',
  'bank.query.term_without_value': 'El término "{term}" no trae valor: escribe {key}:<valor>.',
  'bank.query.amount_invalid':
    '"amt:{value}" no es un importe. La forma es amt:250, amt:>1000, amt:<=99.99 o amt:-250 ' +
    '(con signo compara el importe tal cual; sin signo, la magnitud).',
  'bank.query.narrows_nothing':
    'La consulta "{query}" no acota nada. Nombra al menos un término ({terms}), o quítala para ' +
    'listar todo.',

  // --- Lo que comparten todas las hojas de la familia -------------------
  'bank.list.hit_limit':
    'Se {count, plural, one {listó # fila} other {listaron # filas}}, que es el tope de --limit: ' +
    'puede haber más. Sube --limit, o usa --all en `{command}`.',
  'bank.offset.unsupported':
    '--offset no está implementado en esta familia: la consulta ordena y acota con --limit, sin ' +
    'cursor estable. {alternative}',
  'bank.offset.narrow_accounts': 'Acota con [query], --type o --currency, o pide todo con --all.',
  'bank.offset.narrow_statements': 'Acota con --account, --since o --until.',
  'bank.offset.narrow_sessions': 'Acota con --account, --period o -s, o pide todo con --all.',
  'bank.confirm.taken_as_no': '{reason}; lo tomo como no.',
  'bank.aborted.no_changes': 'Sin cambios.',
  'bank.idempotency.hit':
    'Idempotency hit: la llave "{key}" ya consumó este acto — {what}. Nada se ejecutó otra vez; ' +
    'esto es el resultado grabado.',

  // --- bank account -----------------------------------------------------
  'bank.account.create.dry_run':
    'Ensayo: el alta se ejecutó de verdad —índice único incluido— y se deshizo. Nada quedó escrito.',
  'bank.account.show.liability': 'PASIVO',
  'bank.account.show.label.account_number': 'Número de cuenta',
  'bank.account.show.label.routing': 'Ruteo ABA',
  'bank.account.show.label.sat_bank_key': 'Clave de banco SAT',
  'bank.account.show.label.gl_account': 'Cuenta de mayor',
  'bank.account.show.label.book_balance': 'Saldo en libros',
  'bank.account.show.label.bank_balance': 'Saldo del banco',
  'bank.account.show.label.difference': 'Diferencia',
  'bank.account.show.label.last_reconciled': 'Última conciliación',
  'bank.account.show.label.status': 'Estado',
  'bank.account.show.routing_on_file': 'en archivo (cifrado)',
  'bank.account.show.gl_unmapped': 'sin mapear',
  'bank.account.show.bank_balance_never_synced': 'nunca sincronizado',
  'bank.account.show.never_reconciled': 'nunca',
  'bank.account.show.status_active': 'activa',
  'bank.account.show.status_archived': 'archivada',
  'bank.account.edit.nothing_to_change':
    'Nada que cambiar. Pasa --name, --bank, --branch, --type, --currency, --clabe, ' +
    '--account-number, --routing-ach, --routing-wire, --sat-bank-code, --swift o --iban.',
  'bank.account.edit.reason_required':
    '{fields} cambia uno de los identificadores por los que sale el dinero ({sensitive}): exige ' +
    '--reason "<por qué>". El motivo se guarda en la bitácora, que es append-only.',
  'bank.account.edit.confirm': 'Vas a cambiar {fields} de "{account}". ¿Continuar?',
  'bank.account.edit.nothing_changed': 'Nada cambió: los valores ya eran esos.',
  'bank.account.edit.fields_changed': '{count, plural, one {# campo} other {# campos}}',
  'bank.account.edit.dry_run': 'Ensayo: el UPDATE corrió de verdad y se deshizo.',
  'bank.account.set.already_mapped':
    '{account} ya estaba mapeada a {gl}: nada que escribir.',
  'bank.account.set.forced':
    'FORZADO sobre {count, plural, one {# línea contabilizada} other {# líneas contabilizadas}}',

  // --- bank statement ----------------------------------------------------
  'bank.dir.unreadable': 'No se pudo leer --dir {dir}: {error}',
  'bank.dir.no_files': '--dir {dir} no tiene archivos que importar.',
  'bank.import.no_file': 'Qué archivo. Pásalo como argumento o apunta a un directorio con --dir.',
  'bank.import.counts':
    '{added, plural, one {# nueva} other {# nuevas}}, ' +
    '{duplicated, plural, one {# ya estaba} other {# ya estaban}}',
  'bank.import.findings':
    '{file}: {count, plural, one {# hallazgo} other {# hallazgos}} de integridad. Están en ' +
    'staging igual — es `bank statement check` quien sale 4.',
  'bank.import.dry_run': 'Ensayo: se parseó, se verificó y la escritura se deshizo.',
  'bank.import.staging_note':
    'Staging bancario: nada de esto está en el mayor hasta que se cotee y se concilie.',
  'bank.statement.list.status_not_applicable':
    '-s/--status no aplica a un estado de cuenta: no tiene estado de ciclo de vida. Su veredicto ' +
    'se calcula al leerlo (columna `chain`), y quien lo juzga es `bank statement check`, que sale 4.',
  'bank.statement.list.broken_chains':
    '{count, plural, one {# estado} other {# estados}} con la cadena de saldos rota. ' +
    '`bank statement check` dice cuál prueba falló y sale 4.',
  'bank.statement.show.line_count_mismatch':
    'El documento trae {document, plural, one {# línea} other {# líneas}} y la base le atribuye ' +
    '{stored}: las que faltan se dedujeron contra un estado anterior y conservan el statement_id ' +
    'de aquél.',
  'bank.statement.show.lines_omitted':
    '{count, plural, one {# línea más no se listó} other {# líneas más no se listaron}}. Sube --limit.',
  'bank.statement.check.skipped':
    '{count, plural, one {# estado más cumplía} other {# estados más cumplían}} el filtro y no ' +
    'se verificaron: la corrida tiene tope. Acota con --account o con --since.',

  // --- bank transaction · book-item · match -------------------------------
  'bank.transaction.show.no_extractors':
    'Sin extractores todavía ({fields}): lo que el banco escribió está en --raw. Los poblará ' +
    '`bank transaction apply`.',
  'bank.book_item.oldest_unseen':
    'La más antigua lleva {days, plural, one {# día} other {# días}} sin aparecer en el banco ' +
    '({entry}). Un cheque expedido y no cobrado vive aquí y nunca en el extracto.',
  'bank.match.preview.needs_target':
    'Previsualizar necesita saber sobre qué: pasa el id de un movimiento, o --account para ' +
    'recorrer los no cotejados de una cuenta.',
  'bank.match.preview.no_proposal': 'sin propuesta',
  'bank.match.preview.candidate': 'confianza {confidence} · regla {rule}',
  'bank.match.preview.label.amount': 'importe',
  'bank.match.preview.label.date': 'fecha',
  'bank.match.preview.label.description': 'descripción',
  'bank.match.preview.label.period': 'periodo',
  'bank.match.preview.label.verdict': 'veredicto',
  'bank.match.preview.amount_signal':
    '{bank} vs {candidate} · diferencia {difference} · exacto {exact} · misma dirección {sameDirection}',
  'bank.match.preview.date_signal':
    '{days, plural, one {# día} other {# días}} · dentro de ventana {withinWindow}',
  'bank.match.preview.description_signal': 'similitud {similarity}',
  'bank.match.preview.soft_signal': '(señal blanda: nunca aplica sola)',
  'bank.match.preview.would_apply': '`run` lo aplicaría',
  'bank.match.preview.not_applied': 'no se aplica',
  'bank.match.preview.summary':
    '{count, plural, one {movimiento} other {movimientos}} · {applicable} que `bank match run` aplicaría.',
  'bank.match.preview.hit_top':
    'Se previsualizaron {count}, que es el tope de --top: puede haber más.',
  'bank.match.applied': '{count, plural, one {# aplicado} other {# aplicados}}',
  'bank.match.run.tally':
    '· {already, plural, one {# ya lo estaba} other {# ya lo estaban}} · ' +
    '{skipped, plural, one {# omitido} other {# omitidos}} · ' +
    '{evaluated, plural, one {# evaluado} other {# evaluados}}',
  'bank.match.apply.tally':
    '· {already, plural, one {# ya lo estaba} other {# ya lo estaban}} · ' +
    '{skipped, plural, one {# omitido} other {# omitidos}}',
  'bank.match.apply.stdin_empty':
    'La entrada estándar no trajo ningún id. `bank match preview -q` los escupe uno por línea.',
  'bank.match.apply.no_transactions':
    'Qué movimientos. Pásalos como argumento, o encadena `bank match preview -q | mnemosine bank ' +
    'match apply --stdin`.',
  'bank.match.apply.confirm':
    'Vas a aplicar el cotejo que el motor propone para ' +
    '{count, plural, one {# movimiento} other {# movimientos}}. ¿Continuar?',
  'bank.match.apply.no_terminal':
    'Sin cambios: no hay terminal donde confirmar (la entrada estándar es la tubería). Añade -y ' +
    'para aplicar sin preguntar.',
  'bank.match.create.write_off_declared':
    'El residual de {amount} queda DECLARADO como cancelado contra la cuenta, pero no se ' +
    'contabiliza: no hay póliza detrás todavía. Regístrala a mano o espera a F05c.',
  'bank.match.create.dry_run': 'Ensayo: el grupo se escribió de verdad y se deshizo.',
  'bank.match.unapply.confirm':
    'Vas a desaplicar el cotejo {match} y todos los de su grupo (la igualdad ' +
    'Σbanco = Σlibros + Σajustes no sobrevive a que le quiten una pata). ¿Continuar?',
  'bank.match.unapply.closed':
    '{count, plural, one {# cotejo clausurado} other {# cotejos clausurados}}',
  'bank.match.unapply.released':
    '· {transactions, plural, one {# movimiento} other {# movimientos}} y ' +
    '{items, plural, one {# partida} other {# partidas}} de vuelta al flujo · motivo {reason}',
  'bank.match.unapply.group': 'grupo {group}',
  'bank.match.unapply.closure_note':
    'Clausura, no borrado: la fila se queda en el expediente con su motivo, porque el auditor ' +
    'pregunta por qué se deshizo y una fila borrada no contesta.',
  'bank.match.unapply.dry_run': 'Ensayo: se clausuró de verdad y se deshizo.',

  // --- bank reconciliation: la aritmética de dos lados ---------------------
  'bank.reconciliation.not_observed': 'sin observar',
  'bank.reconciliation.side.bank': 'BANCO',
  'bank.reconciliation.side.books': 'LIBROS',
  'bank.reconciliation.label.statement_balance': 'saldo del extracto',
  'bank.reconciliation.label.book_balance': 'saldo de libros',
  'bank.reconciliation.label.adjusted': '= ajustado',
  'bank.reconciliation.label.variance': 'VARIACIÓN',
  'bank.reconciliation.variance_not_computed': 'NO CALCULADA',
  'bank.reconciliation.variance_missing_side':
    'No es cero: es que falta un lado. Un cero aquí significaría «nadie restó nada».',
  'bank.reconciliation.tolerance_line': 'tolerancia {tolerance} · política {policy}',
  'bank.reconciliation.counters.items_label': 'partidas',
  'bank.reconciliation.counters.items':
    '{total} · {unclassified} sin clasificar · {undated} sin fechar · ' +
    '{resolved, plural, one {# resuelta} other {# resueltas}}',
  'bank.reconciliation.counters.statement_label': 'extracto',
  'bank.reconciliation.counters.unexplained':
    '{count, plural, one {# movimiento} other {# movimientos}} sin cotejo y sin partida ({amount})',
  'bank.reconciliation.frozen.title': 'RESUMEN CONGELADO',
  'bank.reconciliation.frozen.caption': '(la aseveración, no la respuesta)',
  'bank.reconciliation.frozen.never_computed':
    'nadie ha hecho la aritmética de esta sesión: la fila guarda variance {variance} por DEFAULT',
  'bank.reconciliation.frozen.line':
    'variance {variance} · libros {books} · cheques {checks} · depósitos {deposits} · ' +
    'cargos {charges} · abonos {credits} · otros {other}',
  'bank.reconciliation.frozen.computed_on': 'calculada el {date}',
  'bank.reconciliation.frozen.drifted':
    'la aritmética viva dice {live} y la sesión afirmó {frozen}: algo cambió debajo desde que se cerró.',
  'bank.reconciliation.ready_to_close': 'lista para `bank reconciliation close`.',
  'bank.reconciliation.whats_missing': 'LO QUE FALTA',
  'bank.reconciliation.session_label': 'sesión {session}',
  'bank.reconciliation.run.file_flags_without_file':
    '--format y --profile describen el archivo de --file, y no hay archivo. Pasa --file, o ' +
    'quítalas para tomar el extracto que ya esté importado.',
  'bank.reconciliation.run.dry_run':
    'Ensayo: los pasos que escriben se ejecutaron de verdad y se deshicieron.',
  'bank.reconciliation.open.summary':
    'saldo inicial {opening} · cierre de banco {closingBank} {currency} · extracto {statement}',
  'bank.reconciliation.open.continues': 'continúa {session}',
  'bank.reconciliation.open.baseline': 'parte de la línea base {balance} al {date}',
  'bank.reconciliation.open.baseline_date_without_baseline':
    '--baseline-date es la fecha de --baseline, y no hay --baseline. Pasa el saldo conciliado con --baseline, o quita --baseline-date.',
  'bank.reconciliation.open.no_arithmetic_yet':
    'La sesión nace sin aritmética (`arithmetic_computed_at` NULL): `bank reconciliation status` ' +
    'la calcula viva y `close` la firma. Nada de esto toca el mayor.',
  'bank.reconciliation.open.dry_run':
    'Ensayo: la sesión se abrió de verdad —continuidad incluida— y se deshizo.',
  'bank.reconciliation.list.variance_blank':
    '{count, plural, one {# sesión} other {# sesiones}} con la variación en blanco: nadie ha ' +
    'hecho su aritmética. La columna de la fila vale 0 por DEFAULT y por eso no se imprime.',
  'bank.reconciliation.status.needs_target':
    'Di qué sesión: `bank reconciliation status <session>`, o --account para la que esté en curso ' +
    'en esa cuenta.',
  'bank.reconciliation.status.two_ways':
    'El identificador y --account dicen lo mismo de dos maneras: da uno de los dos. Con --account ' +
    'se lee la sesión EN CURSO de esa cuenta.',
  'bank.reconciliation.status.statement_line':
    'extracto {statement} · declarado por el banco {declared} · saldo inicial {opening}',
  'bank.reconciliation.status.no_statement':
    'sin extracto atado: el saldo del banco NO se puede observar',
  'bank.reconciliation.status.items_title': 'PARTIDAS',
  'bank.reconciliation.status.adjustments_title': 'AJUSTES',
  'bank.reconciliation.status.adjustments_caption': '(borradores: nada se contabilizó solo)',

  // --- bank reconciling-item · adjustment · close · approve ----------------
  'bank.item.list.ageing':
    'La más antigua lleva {days, plural, one {# día} other {# días}}. ' +
    '{overdue, plural, one {# vencida} other {# vencidas}} y {undated} sin fecha esperada: una ' +
    'partida sin fecha no se persigue, envejece.',
  'bank.item.assign.expected_contradiction':
    '`--expected` y `--clear-expected` piden lo contrario: o se fija una fecha o se quita.',
  'bank.item.assign.nothing_to_assign':
    'No hay nada que asignar: indica al menos --owner, --expected, --clear-expected, --escalation o --note.',
  'bank.item.assign.escalation_unknown': '--escalation admite {values}; llegó "{value}".',
  'bank.adjustment.create.summary':
    '· {type} · {amount} · contrapartida {account} · banco {bankAccount} · borrador {draft}',
  'bank.adjustment.create.draft_note':
    'Es un BORRADOR: espera a `mnemosine review`. `journal_entry_id` queda NULL hasta que ' +
    '`bank reconciliation post` (F05d) lo contabilice detrás de una firma.',
  'bank.reconciliation.close.refused':
    'La sesión {session} no cierra: variación {variance}, ' +
    '{unclassified, plural, one {# partida sin clasificar} other {# partidas sin clasificar}} y ' +
    '{undated} sin fechar.',
  'bank.reconciliation.close.variance_missing_side': 'NO CALCULADA (no es cero: falta un lado)',
  'bank.reconciliation.close.what_balanced_would_claim':
    'Marcarla "balanced" con esto abierto le diría al tablero de cierre que el efectivo de esta ' +
    'cuenta está verificado contra el banco.',
  'bank.reconciliation.close.confirm':
    'Vas a firmar que la cuenta {account} cuadra con el banco al {until} (variación {variance}). ' +
    '`period-close` lo leerá como la evidencia de que el efectivo se verificó. ¿Continuar?',
  'bank.reconciliation.close.no_terminal':
    'Sin cambios: no hay terminal donde confirmar. Añade -y para cerrar sin preguntar.',
  'bank.reconciliation.close.summary':
    '· {status} · variación {variance} · banco ajustado {bankAdjusted} = libros ajustado {booksAdjusted}',
  'bank.reconciliation.close.frozen_summary':
    'resumen congelado: libros {books} · cheques {checks} · depósitos {deposits} · ' +
    'cargos {charges} · abonos {credits} · otros {other}',
  'bank.reconciliation.close.arithmetic_stamp':
    'Aritmética calculada el {date}. Balanceada NO es aprobada ni contabilizada: `approve` exige ' +
    'que el aprobador no sea el preparador, y `post` es lo que mueve el mayor.',
  'bank.reconciliation.close.dry_run': 'Ensayo: se cerró de verdad y se deshizo.',
  'bank.reconciliation.approve.title': 'LO QUE SE VA A FIRMAR',
  'bank.reconciliation.approve.label.session': 'sesión',
  'bank.reconciliation.approve.label.account': 'cuenta',
  'bank.reconciliation.approve.label.statement': 'extracto',
  'bank.reconciliation.approve.label.variance': 'variación',
  'bank.reconciliation.approve.label.members': 'miembros',
  'bank.reconciliation.approve.label.segregation': 'segregación',
  'bank.reconciliation.approve.no_statement': 'ninguno atado a la sesión',
  'bank.reconciliation.approve.variance_value': '{live} (congelada al cerrar: {frozen})',
  'bank.reconciliation.approve.members_value':
    '{items, plural, one {# partida} other {# partidas}} · ' +
    '{matches, plural, one {# cotejo} other {# cotejos}} · ' +
    '{adjustments, plural, one {# ajuste} other {# ajustes}}',
  'bank.reconciliation.approve.segregation_value': 'preparó {preparer} · política {policy}',
  'bank.reconciliation.approve.nobody_recorded': 'nadie registrado',
  'bank.reconciliation.approve.policy_default': '(por omisión)',
  'bank.reconciliation.approve.confirm':
    'Vas a FIRMAR la sesión {session} con la instantánea {hash}… ' +
    '({items, plural, one {# partida} other {# partidas}}, ' +
    '{adjustments, plural, one {# ajuste} other {# ajustes}}, variación {variance}). Volver a ' +
    'aprobarla se rechaza; retirar la firma pide `bank reconciliation reopen` y un motivo. ' +
    '¿Continuar?',
  'bank.reconciliation.approve.already_signed': 'sesión {session} ya firmada',
  'bank.reconciliation.approve.summary': '· {status} · firmada por {by} el {on}',
  'bank.reconciliation.approve.not_posted_yet':
    'Aprobada NO es contabilizada: el mayor lo mueve `bank reconciliation post`, que postea los ' +
    'ajustes que esta firma acaba de congelar.',
  'bank.reconciliation.approve.dry_run':
    'Ensayo: se firmó de verdad y se deshizo. El hash es el que quedaría.',

  'bank.reconciliation.reopen.title': 'LO QUE SE VA A REABRIR',
  'bank.reconciliation.reopen.transition': 'sesión {session} · {from} → {to} · {previous} → in_progress',
  'bank.reconciliation.reopen.reversal':
    'asiento {entry} revertido por {reversal} (nunca borrado); su ajuste vuelve a ser un borrador pendiente',
  'bank.reconciliation.reopen.withdrawn':
    'firma que se retira: {by} el {on} (la bitácora la conserva con su instantánea)',
  'bank.reconciliation.reopen.confirm':
    'Vas a REABRIR la sesión {session} y retirar su firma {hash}…' +
    '{reversals, plural, =0 {} one { Revierte # asiento contabilizado.} other { Revierte # asientos contabilizados.}} ' +
    '¿Continuar?',
  'bank.reconciliation.reopen.already_reopened': 'sesión {session} ya reabierta',
  'bank.reconciliation.reopen.summary': '· {status} · firma retirada',
  'bank.reconciliation.reopen.next':
    'Corrige lo que estaba mal y vuelve a correr `bank reconciliation close` y `approve` sobre el mismo rango.',
  'bank.reconciliation.reopen.dry_run': 'Ensayo: se reabrió de verdad y se deshizo.',

  // --- bank reconciliation post · generate --------------------------------
  'bank.reconciliation.post.already_posted': 'La sesión ya está contabilizada',
  'bank.reconciliation.post.already_posted_detail':
    '{count, plural, one {# asiento} other {# asientos}} en el libro y nada que postear.',
  'bank.reconciliation.post.already_posted_short': 'sesión {session} ya contabilizada',
  'bank.reconciliation.post.entries_title': 'ASIENTOS QUE SE VAN A CREAR',
  'bank.reconciliation.post.no_entries': 'ninguno: la sesión no tiene ajustes que contabilizar',
  'bank.reconciliation.post.adopted': 'adoptado',
  'bank.reconciliation.post.new': 'nuevo',
  'bank.reconciliation.post.entry_ref': '· póliza {entry} · borrador {draft}',
  'bank.reconciliation.post.counterpart_note':
    'contrapartida de cada uno: la que fijó `bank adjustment create` en su borrador',
  'bank.reconciliation.post.sealed_title': 'Y LO QUE SE SELLA',
  'bank.reconciliation.post.sealed_lines':
    '{count, plural, one {línea de libros} other {líneas de libros}} contra la cuenta de mayor del banco',
  'bank.reconciliation.post.sealed_matches':
    '{count, plural, one {cotejo} other {cotejos}} contra el movimiento del extracto que las explica',
  'bank.reconciliation.post.sealed_items':
    '{count, plural, one {partida conciliatoria} other {partidas conciliatorias}} que el ajuste deja sin objeto',
  'bank.reconciliation.post.confirm_noop':
    'La sesión {session} ya está contabilizada y no se va a postear nada. ¿Continuar de todos modos?',
  'bank.reconciliation.post.confirm':
    'Vas a CONTABILIZAR {entries, plural, one {# asiento nuevo} other {# asientos nuevos}} en el ' +
    'mayor de la sesión {session} y sellar {lines, plural, one {# línea} other {# líneas}} de ' +
    'libros. El mayor es inmutable: esto sólo se corrige por reversa. ¿Continuar?',
  'bank.reconciliation.post.summary':
    '· {status} · {posted, plural, one {# posteado} other {# posteados}} · ' +
    '{adopted, plural, one {# adoptado} other {# adoptados}} · ' +
    '{lines, plural, one {# línea sellada} other {# líneas selladas}} · ' +
    '{matches, plural, one {# cotejo} other {# cotejos}} · ' +
    '{items, plural, one {# partida resuelta} other {# partidas resueltas}}',
  'bank.reconciliation.post.seal_note':
    'El sello dice «este renglón ya está explicado por el banco», no «esta sesión terminó»: los ' +
    'cheques en circulación y los depósitos en tránsito siguen abiertos para el cotejo del mes que viene.',
  'bank.reconciliation.post.dry_run':
    'Ensayo: se contabilizó de verdad y se deshizo. No hay póliza en el libro.',
  'bank.reconciliation.generate.no_pdf_or_xlsx':
    '--format {format} no existe todavía: el proyecto no tiene dependencia de PDF ni de XLSX y no ' +
    'se le añade una para fingir un documento que acabaría en un expediente. Lo que hay: --format ' +
    'json (el estado entero, con las dos columnas y el resumen congelado), --format md|csv|tsv ' +
    '(el estado en renglones) y la salida de texto por omisión, que es la que se imprime y se archiva.',
  'bank.reconciliation.generate.title': 'ESTADO DE CONCILIACIÓN BANCARIA',
  'bank.reconciliation.generate.items_title': 'PARTIDAS CONCILIATORIAS',
  'bank.reconciliation.generate.drafts_caption': '(borradores)',
  'bank.reconciliation.generate.prepared_by': 'preparó',
  'bank.reconciliation.generate.approved_by': 'aprobó',
  'bank.reconciliation.generate.not_closed': 'sin cerrar',
  'bank.reconciliation.generate.not_approved': 'sin aprobar',

  // --- bank fee · interest · check ------------------------------------------
  'bank.skipped.title': 'OMITIDAS',
  'bank.entry_ref': '{description} · póliza {entry}',
  'bank.entry_number': 'póliza {entry}',
  'bank.no_description': 'sin descripción',
  'bank.entry_dry_run': '(ensayo)',
  'bank.posting.dry_run': 'Ensayo: se contabilizó de verdad y se deshizo; los ids salen en null.',
  'bank.fee.post.title': 'COMISIONES',
  'bank.fee.post.nothing_to_post': 'ningún cargo que contabilizar',
  'bank.fee.post.totals': 'totales: cargo {charge} · gasto {expense} · IVA {vat}',
  'bank.fee.post.confirm':
    'Vas a CONTABILIZAR {count, plural, one {# comisión} other {# comisiones}} del {from} al {to} ' +
    'en la cuenta {account}, por {total} (IVA {vat}; pasan a IVA acreditable {released}). El ' +
    'mayor es inmutable: esto sólo se corrige por reversa. ¿Continuar?',
  'bank.fee.post.fees': '{count, plural, one {# comisión} other {# comisiones}}',
  'bank.fee.post.summary':
    '· {posted, plural, one {# contabilizada} other {# contabilizadas}} · ' +
    '{skipped, plural, one {# omitida} other {# omitidas}} · cargo {charge} · IVA {vat}',
  'bank.fee.post.vat_release_ref': 'IVA de la comisión a acreditable · póliza {entry}',
  'bank.fee.post.vat_released_note':
    'El IVA de las comisiones ({vat}) pasó de pendiente de acreditar a IVA acreditable en el mes ' +
    'del cargo. Conserva el CFDI del banco: sin él no procede el acreditamiento.',
  'bank.interest.post.title': 'INTERESES',
  'bank.interest.post.withholding': 'retención {rate}',
  'bank.interest.post.nothing_to_post': 'ningún abono que contabilizar',
  'bank.interest.post.totals': 'totales: bruto {gross} · retenido {withheld} · neto {net}',
  'bank.interest.post.confirm':
    'Vas a CONTABILIZAR {count, plural, one {# abono de interés} other {# abonos de interés}} del ' +
    '{from} al {to} en la cuenta {account}: {gross} de ingreso bruto y {withheld} de ISR retenido ' +
    'a favor. El mayor es inmutable: esto sólo se corrige por reversa. ¿Continuar?',
  'bank.interest.post.credits':
    '{count, plural, one {# abono de interés} other {# abonos de interés}}',
  'bank.interest.post.summary':
    '· {posted, plural, one {# contabilizado} other {# contabilizados}} · ' +
    '{skipped, plural, one {# omitido} other {# omitidos}} · bruto {gross} · retenido {withheld}',
  'bank.interest.post.withholding_note':
    'El ISR retenido queda como pago provisional A FAVOR, no como gasto: es lo que se acredita ' +
    'contra el impuesto del ejercicio.',
  'bank.check.reconcile.title': 'EL MES EN QUE CAE EL ASIENTO',
  'bank.check.reconcile.label.check': 'cheque',
  'bank.check.reconcile.label.cleared_on': 'cobrado el',
  'bank.check.reconcile.check_value': '{check} · pago {payment}',
  'bank.check.reconcile.no_number': 'sin folio',
  'bank.check.reconcile.dated_by_bank':
    '(lo fecha el banco: movimiento {transaction}, {amount})',
  'bank.check.reconcile.no_open_period': 'sin periodo abierto en esa fecha',
  'bank.check.reconcile.no_period': 'sin periodo',
  'bank.check.reconcile.why':
    'por qué: bajo la LIVA el pago con cheque se entiende efectuado el día del COBRO y no el de ' +
    'la firma, así que el IVA de este pago se acredita en ese mes.',
  'bank.check.reconcile.entry_title': 'ASIENTO',
  'bank.check.reconcile.no_vat': 'ninguno: no hay IVA que reclasificar',
  'bank.check.reconcile.total': 'total reclasificado {amount}',
  'bank.check.reconcile.confirm':
    'Vas a registrar que el banco cobró el cheque {check} el {date} y a reclasificar {amount} de ' +
    'IVA en el periodo {period}. El mayor es inmutable: esto sólo se corrige por reversa. ¿Continuar?',
  'bank.check.reconcile.already_cleared': 'cheque cobrado el {date}',
  'bank.check.reconcile.summary':
    '· cobrado el {date} · periodo {period} · IVA reclasificado {amount}',
  'bank.check.reconcile.dry_run': 'Ensayo: se registró el cobro de verdad y se deshizo.',
  'bank.transaction.show.unmatched': 'sin cotejar',
  'bank.match.create.summary':
    '· banco {bank} = libros {books} + ajustes {adjustments} · residual {residual} ({mode}) · ' +
    '{matches, plural, one {# cotejo} other {# cotejos}} · ' +
    '{sealed, plural, one {# partida sellada} other {# partidas selladas}}',
  // ==== fin del piloto bank (I7) ====================================
  // ==== W1 · the browser board (issue #117) ========================
  // Same keys, same order as en.ts. The Spanish is what the board shows by
  // default (src/gateway/app/messages.ts falls back to es).
  'web.app.title': 'Tablero del despacho',
  'web.app.skip_to_content': 'Saltar al contenido',
  'web.app.not_found': 'Esa pantalla no existe.',
  'web.session.sign_in': 'Iniciar sesión',
  'web.session.sign_out': 'Cerrar sesión',
  'web.session.sign_out_failed': 'No se confirmó el cierre de sesión: tu sesión puede seguir abierta. Inténtalo de nuevo.',
  'web.session.signed_out': 'No has iniciado sesión, o tu sesión terminó.',
  'web.session.no_access':
    'Tu cuenta no puede leer esto: le faltan los permisos accounts:read y journal_entries:read.',
  'web.session.signin_failed':
    'El inicio de sesión no terminó y no se guardó ninguna sesión. Inténtalo de nuevo.',
  'web.portfolio.title': 'Cartera del despacho',
  'web.portfolio.caption':
    'Entidades que puedes leer, su periodo en curso y el trabajo que espera a una persona',
  'web.portfolio.column.entity': 'Entidad',
  'web.portfolio.column.current_period': 'Periodo en curso',
  'web.portfolio.column.ended_open_periods': 'Periodos vencidos aún abiertos',
  'web.portfolio.column.pending_drafts': 'Borradores por revisar',
  'web.portfolio.column.pending_questions': 'Preguntas pendientes',
  'web.portfolio.no_calendar': 'sin calendario',
  'web.portfolio.inactive': 'inactiva',
  'web.portfolio.empty': 'Tu token no concede ninguna entidad que se pueda leer aquí.',
  'web.portfolio.not_evaluated': 'La preparación para el cierre no se evalúa en esta pantalla.',
  'web.portfolio.as_of': 'Fecha del servidor {date}',
  'web.portfolio.fetched': 'Leído a las {time}, hace {minutes} min',
  'web.portfolio.stale': 'La actualización de las {time} falló: estas cifras son de la última lectura buena.',
  'web.portfolio.omitted': 'Ids de entidad de tu token que no dieron fila: {count}',
  'web.portfolio.refresh': 'Actualizar',
  'web.portfolio.loading': 'Leyendo la cartera…',
  'web.portfolio.legend.title': 'Qué dicen los colores',
  'web.portfolio.legend.info': 'Azul: el periodo en curso está abierto o en cierre blando.',
  'web.portfolio.legend.balanced': 'Verde: el periodo en curso tiene cierre definitivo o está bloqueado.',
  'web.portfolio.legend.pending': 'Ámbar: hay trabajo esperando a una persona.',
  'web.portfolio.legend.neutral': 'Sin color: nada en espera, o todavía sin calendario.',
  'web.period_status.future': 'futuro',
  'web.period_status.open': 'abierto',
  'web.period_status.soft_close': 'cierre blando',
  'web.period_status.hard_close': 'cierre definitivo',
  'web.period_status.locked': 'bloqueado',
  'web.entity.back': 'Volver a la cartera',
  'web.entity.loading': 'Leyendo la entidad…',
  'web.entity.not_granted': 'Tu token no concede esta entidad: sus listas no se pueden leer aquí.',
  'web.entity.drafts': 'Borradores por revisar',
  'web.entity.drafts_limit': 'La API lista como mucho los 100 borradores más recientes.',
  'web.entity.questions': 'Preguntas pendientes',
  'web.entity.periods': 'Periodos fiscales',
  'web.entity.none': 'Ninguno.',
  'web.entity.column.date': 'Fecha',
  'web.entity.column.description': 'Descripción',
  'web.entity.column.confidence': 'Confianza',
  'web.entity.column.question': 'Pregunta',
  'web.entity.column.topic': 'Tema',
  'web.entity.column.period': 'Periodo',
  'web.entity.column.status': 'Estado',
  'web.entity.column.start': 'Inicio',
  'web.entity.column.end': 'Fin',
  'web.entity.verify': 'Las mismas listas en la terminal:',
  'web.error.upstream_unavailable': 'La API no responde en este momento.',
  'web.error.session_expired': 'Tu sesión terminó. Vuelve a iniciar sesión.',
  'web.error.unexpected': 'No se pudo leer la respuesta.',
  // ==== MNE-001-018 · the Anexo 24 migration leaves ====================
  'migration.file_unreadable': 'No se pudo leer el archivo «{file}».',
  'migration.subledger_not_array': '--subledger espera un arreglo JSON de documentos abiertos.',
  'migration.chart.confirm': '¿Crear {count} cuenta(s) en {entity}?',
  'migration.opening.confirm':
    '¿Postear la apertura del ejercicio {year} al {date} (Debe {debit} · Haber {credit})? ' +
    'El mayor no admite deshacer.',
  'migration.opening.confirm_draft':
    '¿Dejar en BORRADOR la apertura del ejercicio {year} al {date} (Debe {debit} · Haber {credit})? ' +
    'No entra al mayor hasta que la apliques con `entry post`.',
  'migration.check.as_of': 'Al {date} · {comparison}',
  // ==== MNE-001-093 · help by key, pilot family `period` (issue #314) ====
  'help.period.description': 'Periodos contables: cuáles existen, en qué estado está cada uno y cómo abrir uno futuro',
  'help.period.list.description': 'Lista todos los periodos con su estado, sus fechas y la marca de vencido',
  'help.period.list.option.year': 'sólo los periodos de este ejercicio fiscal',
  'help.period.show.description':
    'Muestra un periodo: su estado, quién lo cerró, la lista de verificación con que se cerró y sus pólizas',
  'help.period.show.argument.name': 'nombre del periodo, AAAA-MM o id',
  'help.period.open.description': 'Abre un periodo futuro para poder capturar operaciones en él',
  'help.period.open.argument.name': 'nombre del periodo, AAAA-MM o id',
  'help.period.open.option.reason': 'por qué se abre; queda en el rastro de auditoría',
  'help.period.reopen.description':
    'Reabre un periodo cerrado para que una corrección se registre en el mes al que pertenece',
  'help.period.reopen.argument.name': 'nombre del periodo, AAAA-MM o id',
  // ==== MNE-001-093 · help by key, the families merged from main (issue #314) ====
  'help.tenant.description': 'Crea y lista los despachos (inquilinos) de esta instalación',
  'help.tenant.list.description': 'Lista los despachos de esta instalación, incluidos los archivados',
  'help.tenant.create.description': 'Crea el inquilino de un despacho nuevo, con su usuario de sistema',
  'help.tenant.create.argument.name': 'nombre del despacho',
  'help.tenant.create.option.subdomain': 'identificador único del despacho (si se omite, se deriva del nombre)',
  'help.tenant.create.option.json': 'salida en JSON',
  'help.account.role.sync.description': 'Apunta los roles de retención a las cuentas que elige withholding_accounts_layout y crea las que falten',
  'help.account.role.sync.option.dry_run': 'muestra el plan, sin escribir nada',
  'help.receipt.apply.option.withholding':
    'lo que retuvo el cliente, que salda la factura junto con el efectivo: "isr:1000" o "iva:1066.67" (repetible); con varias facturas, "INV-2026-00042:isr:1000"',
  'help.bill.rule.description':
    'Reglas de procesamiento del despacho: con qué se clasifica un CFDI recibido sin que intervenga el modelo',
  'help.bill.rule.create.description':
    'Crea una regla de procesamiento (condiciones → acciones) que aplicará la próxima ingesta',
  'help.bill.rule.create.option.name': 'nombre de la regla; aparece en el rastro de cada CFDI que decide',
  'help.bill.rule.create.option.when': 'repetible; deben cumplirse todas: "<campo> <operador> <valor>"',
  'help.bill.rule.create.option.then': 'repetible: "<acción>=<valor>", p. ej. set_account=6100',
  'help.bill.rule.create.option.type': 'tipo de regla: {types}',
  'help.bill.rule.create.option.priority':
    'la de menor número se evalúa primero; una coincidencia posterior prevalece sobre una anterior',
  'help.bill.rule.create.option.description': 'por qué el despacho conserva esta regla',
  'help.bill.rule.create.option.dry_run': 'valida y muestra la regla; no escribe nada',
  'help.bill.rule.create.option.json': 'salida en JSON',
  'help.bill.rule.list.description':
    'Lista las reglas de procesamiento en orden de evaluación, con cuántas veces se aplicó cada una',
  'help.bill.rule.list.option.type': 'sólo este tipo de regla: {types}',
  'help.pay_run.description':
    'Corridas de nómina de un periodo de pago: crear, calcular de bruto a neto, aprobar y contabilizar la póliza',
  'help.pay_run.create.description':
    'Crea una corrida en borrador sobre un periodo de pago; el ejercicio fiscal se toma del periodo',
  'help.pay_run.create.option.period': 'periodo de pago de la entidad activa (su id)',
  'help.pay_run.create.option.type': 'tipo de corrida: {types}',
  'help.pay_run.calculate.description':
    'Calcula de bruto a neto a cada empleado del archivo de insumos y totaliza la corrida',
  'help.pay_run.calculate.argument.id': 'corrida de nómina por calcular',
  'help.pay_run.calculate.option.file': 'JSON con los insumos de los empleados: un arreglo, o {shape}',
  'help.pay_run.approve.description':
    'Aprueba una corrida calculada: sella sus totales y registra el pasivo patronal; es irreversible',
  'help.pay_run.approve.argument.id': 'corrida calculada por aprobar',
  'help.pay_run.post.description':
    'Arma la póliza de nómina de una corrida aprobada y la deja en borrador para `mnemosine review`; ' +
    'con --post la contabiliza de inmediato',
  'help.pay_run.post.argument.id': 'corrida aprobada cuya póliza se arma',
  'help.pay_run.post.option.post':
    'contabiliza la póliza en el mayor de inmediato, en lugar de dejarla en borrador para revisión',
  // ==== I11 · report labels (issue #153) ============================
  //
  // The names of the sections and of the twelve `fs_category` values are NOT
  // the firm's own criterion but a standard: the entity's accounting framework
  // fixes them, not the reader's language. They are translated here; they do
  // NOT go to the configuration panel.
  'report.section.assets': 'Activo',
  'report.section.liabilities': 'Pasivo',
  'report.section.equity': 'Capital contable',
  'report.section.revenue': 'Ingresos',
  'report.section.expenses': 'Gastos',
  // Both words, always. The label does not depend on the sign.
  'report.section.result_of_the_period': 'Utilidad (pérdida) del ejercicio',
  'report.category.current_assets': 'Activo circulante',
  'report.category.non_current_assets': 'Activo no circulante',
  'report.category.current_liabilities': 'Pasivo a corto plazo',
  'report.category.long_term_liabilities': 'Pasivo a largo plazo',
  'report.category.equity': 'Capital contribuido',
  'report.category.ori': 'Otros resultados integrales',
  'report.category.revenue': 'Ingresos',
  'report.category.cogs': 'Costo de ventas',
  'report.category.operating_expenses': 'Gastos de operación',
  'report.category.other_income': 'Otros ingresos',
  'report.category.other_expenses': 'Otros gastos',
  'report.category.tax': 'Impuestos',
  'report.category.other': 'Otros',
  'report.total_of': 'Total de {name}',
  'report.total_liabilities_and_equity': 'Suma del pasivo y el capital contable',
  'report.net_income': 'Utilidad neta',
  'report.balance_check': 'Activo {assets} = Pasivo + Capital {total}',
  'report.income_summary': 'Ingresos {revenue}   Gastos {expenses}   Utilidad neta {net}',
  // --- pay-run · corrida (MNE-001-068) -----------------------------------
  'payrun.file_invalid': 'El archivo de insumos {path} no se puede usar: {detail}. No se calculó nada.',
  'payrun.file_duplicate_employee':
    'El empleado {employee} aparece dos veces en {path}: una corrida lleva un recibo por empleado. No se calculó nada.',
  'payrun.create.period_required':
    'Falta --period: una corrida es de un periodo de pago de la entidad, y no se adivina del reloj.',
  'payrun.create.next': 'Sigue: `mnemosine pay-run calculate {id} --file <insumos.json>`.',
  'payrun.calculate.file_required':
    'Falta --file: los insumos del periodo (percepciones y deducciones) vienen de un archivo JSON.',
  'payrun.calculate.next': 'Sigue: `mnemosine pay-run approve {id} --dry-run` para ver lo que escribe aprobar.',
  'payrun.approve.confirm':
    'Vas a APROBAR la corrida {id} ({employees, plural, one {# empleado} other {# empleados}}, ' +
    'neto {net}) y a escribir su pasivo patronal. La aprobación no se deshace. ¿Continuar?',
  'payrun.approve.aborted': 'Sin cambios: la corrida no se aprobó.',
  'payrun.approve.done': 'Corrida {id} aprobada · {status}',
  'payrun.approve.repeated': 'La corrida {id} ya se aprobó con esta llave: se muestra el resultado grabado · {status}',
  'payrun.approve.dry_run': 'Ensayo: la corrida {id} se aprobó y se deshizo; sigue en {status}.',

  'prepaid.run.key_replayed':
    'Llave de idempotencia ya consumada: se devuelve el resultado grabado y no se volvió a devengar.',
  'prepaid.run.key_reversed':
    'La llave "{key}" grabó asientos que después se reversaron ({entries}). Devolver ese resultado ' +
    'diría que {period} está devengado cuando no lo está. Vuelve a correr con una llave nueva ' +
    '(es otra corrida, no un reintento) o sin --idempotency-key.',
  'prepaid.run.key_partial':
    'La llave "{key}" grabó una corrida de {period} que falló en {failed} anticipo(s), y {pending} ' +
    'anticipo(s) siguen sin devengar en {period}. Devolver ese resultado repetiría la falla sin ' +
    'volver a intentarlo. Vuelve a correr con una llave nueva (es otra corrida, no un reintento) o ' +
    'sin --idempotency-key; ahí se imprimen los errores.',
  'prepaid.run.key_busy':
    'Otra corrida con la llave "{key}" sigue trabajando. Espera a que termine y reintenta con la ' +
    'misma llave: el reintento devuelve su resultado grabado.',
  'payrun.post.confirm':
    'Vas a CONTABILIZAR la póliza de la corrida {id} (cargos {debits} = abonos {credits}) ' +
    'sin pasar por la revisión. Una póliza contabilizada sólo se deshace con una reversa. ¿Continuar?',
  'payrun.post.aborted': 'Sin cambios: la póliza no se contabilizó.',
  'payrun.post.dry_run': 'Ensayo: la póliza de la corrida {id} cuadra (cargos {debits} = abonos {credits}); no se escribió nada.',
  'payrun.post.drafted': 'La póliza de la corrida {id} quedó como borrador {draft}: apruébala con `mnemosine review`.',
  'payrun.post.posted': 'Póliza de la corrida {id} contabilizada como {number}.',
  'payrun.post.repeated': 'La póliza de la corrida {id} ya se escribió con esta llave: se muestra el resultado grabado.',
};
