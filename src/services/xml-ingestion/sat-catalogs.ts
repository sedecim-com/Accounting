// ============================================================
// SAT CATALOGS
//
// The catalog codes the CFDI surface reads back to a human: a
// receipt carries RegimenFiscal="601", and only this table says
// that means "General de Ley Personas Morales".
//
// Rescued from src/services/mexico/cfdi.ts when that module was
// deleted; the code tables are unchanged, and IVA_RATES became
// decimal strings on the way out (see below). Everything else in it — an unsigned CFDI
// 4.0 builder, a PAC simulator that minted UUIDs with Math.random
// and answered 'cancelled' without asking the SAT, and a DIOT
// generator built on the repealed accrual layout — claimed acts
// the system never performed. These are just the codes: data,
// with nothing behind them that can lie.
//
// NOT a validation whitelist. The SAT publishes these catalogs
// and revises them; a code missing here is a code we have not
// copied yet, not a code the SAT rejects.
// ============================================================

export const SAT_CATALOGS = {
  // Tax regime (SAT: Régimen Fiscal)
  REGIMEN_FISCAL: {
    '601': 'General de Ley Personas Morales',
    '603': 'Personas Morales con Fines no Lucrativos',
    '605': 'Sueldos y Salarios e Ingresos Asimilados',
    '606': 'Arrendamiento',
    '607': 'Régimen de Enajenación o Adquisición de Bienes',
    '608': 'Demás ingresos',
    '610': 'Residentes en el Extranjero sin Establecimiento Permanente',
    '612': 'Personas Físicas con Actividades Empresariales y Profesionales',
    '614': 'Ingresos por intereses',
    '616': 'Sin obligaciones fiscales',
    '620': 'Sociedades Cooperativas de Producción',
    '621': 'Incorporación Fiscal',
    '622': 'Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras',
    '623': 'Opcional para Grupos de Sociedades',
    '624': 'Coordinados',
    '625': 'Régimen de las Actividades Empresariales (RESICO)',
    '626': 'Régimen Simplificado de Confianza',
  },

  // CFDI use (SAT: Uso CFDI)
  USO_CFDI: {
    'G01': 'Adquisición de mercancías',
    'G02': 'Devoluciones, descuentos o bonificaciones',
    'G03': 'Gastos en general',
    'I01': 'Construcciones',
    'I02': 'Mobiliario y equipo de oficina',
    'I03': 'Equipo de transporte',
    'I04': 'Equipo de computo y accesorios',
    'I08': 'Otra maquinaria y equipo',
    'D01': 'Honorarios médicos, dentales y hospitalarios',
    'D02': 'Gastos médicos por incapacidad',
    'D03': 'Gastos funerales',
    'D04': 'Donativos',
    'P01': 'Por definir',
    'S01': 'Sin efectos fiscales',
    'CP01': 'Pagos',
  },

  // Payment method (SAT: Método de Pago)
  METODO_PAGO: {
    'PUE': 'Pago en una sola exhibición',
    'PPD': 'Pago en parcialidades o diferido',
  },

  // Payment form (SAT: Forma de Pago)
  FORMA_PAGO: {
    '01': 'Efectivo',
    '02': 'Cheque nominativo',
    '03': 'Transferencia electrónica de fondos',
    '04': 'Tarjeta de crédito',
    '05': 'Monedero electrónico',
    '06': 'Dinero electrónico',
    '08': 'Vales de despensa',
    '12': 'Dación en pago',
    '13': 'Pago por subrogación',
    '14': 'Pago por consignación',
    '15': 'Condonación',
    '17': 'Compensación',
    '23': 'Novación',
    '24': 'Confusión',
    '25': 'Remisión de deuda',
    '26': 'Prescripción o caducidad',
    '27': 'A satisfacción del acreedor',
    '28': 'Tarjeta de débito',
    '29': 'Tarjeta de servicios',
    '30': 'Aplicación de anticipos',
    '31': 'Intermediario pagos',
    '99': 'Por definir',
  },

  // IVA rates, as the TasaOCuota string the CFDI carries.
  // Decimal STRINGS, not JS numbers: a rate is one factor of a money
  // computation, and 0.16 as a float is how a centavo goes missing from
  // a traslado. Feed them to Decimal, never to `*`.
  IVA_RATES: {
    '16': '0.160000',  // General rate
    '8': '0.080000',   // Border zone rate
    '0': '0.000000',   // Zero rate (exempt)
  },

  // Cancellation reasons
  CANCELLATION_REASONS: {
    '01': 'Comprobante emitido con errores con relación',
    '02': 'Comprobante emitido con errores sin relación',
    '03': 'No se llevó a cabo la operación',
    '04': 'Operación nominativa relacionada en la factura global',
  },
} as const;
