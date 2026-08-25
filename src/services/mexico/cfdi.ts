import { query } from '../../database/connection.js';
import { config } from '../../config/index.js';
import { AccountingError } from '../../utils/errors.js';
import type { Invoice, InvoiceLine } from '../../types/index.js';

// SAT catalog codes for common use cases
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

  // IVA Rates
  IVA_RATES: {
    '16': 0.16,   // General rate
    '8': 0.08,    // Border zone rate
    '0': 0.00,    // Zero rate (exempt)
  },

  // Cancellation reasons
  CANCELLATION_REASONS: {
    '01': 'Comprobante emitido con errores con relación',
    '02': 'Comprobante emitido con errores sin relación',
    '03': 'No se llevó a cabo la operación',
    '04': 'Operación nominativa relacionada en la factura global',
  },
} as const;

// CFDI XML generation interface
interface CfdiData {
  invoice: Invoice;
  lines: InvoiceLine[];
  emisor: {
    rfc: string;
    nombre: string;
    regimen_fiscal: string;
  };
  receptor: {
    rfc: string;
    nombre: string;
    regimen_fiscal: string;
    uso_cfdi: string;
    domicilio_fiscal: string;
  };
  metodo_pago: string;
  forma_pago: string;
  moneda: string;
  tipo_cambio?: number;
}

export function generateCfdiXml(data: CfdiData): string {
  const conceptos = data.lines.map((line) => `
    <cfdi:Concepto
      ClaveProdServ="${line.cfdi_product_code || '01010101'}"
      NoIdentificacion="${line.item_id || ''}"
      Cantidad="${line.quantity}"
      ClaveUnidad="${line.cfdi_unit_code || 'E48'}"
      Descripcion="${escapeXml(line.description || '')}"
      ValorUnitario="${line.unit_price}"
      Importe="${line.line_amount}"
      ObjetoImp="02">
      <cfdi:Impuestos>
        <cfdi:Traslados>
          <cfdi:Traslado
            Base="${line.line_amount}"
            Impuesto="002"
            TipoFactor="Tasa"
            TasaOCuota="${line.tax_rate ? parseFloat(line.tax_rate) / 100 : 0.160000}"
            Importe="${line.tax_amount}" />
        </cfdi:Traslados>
      </cfdi:Impuestos>
    </cfdi:Concepto>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante
  xmlns:cfdi="http://www.sat.gob.mx/cfd/4"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.sat.gob.mx/cfd/4 http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd"
  Version="4.0"
  Serie="A"
  Folio="${data.invoice.invoice_number}"
  Fecha="${new Date(data.invoice.invoice_date).toISOString().replace('Z', '')}"
  FormaPago="${data.forma_pago}"
  SubTotal="${data.invoice.subtotal}"
  Moneda="${data.moneda}"
  ${data.tipo_cambio ? `TipoCambio="${data.tipo_cambio}"` : ''}
  Total="${data.invoice.total_amount}"
  TipoDeComprobante="I"
  Exportacion="01"
  MetodoPago="${data.metodo_pago}"
  LugarExpedicion="${data.receptor.domicilio_fiscal}">
  <cfdi:Emisor
    Rfc="${data.emisor.rfc}"
    Nombre="${escapeXml(data.emisor.nombre)}"
    RegimenFiscal="${data.emisor.regimen_fiscal}" />
  <cfdi:Receptor
    Rfc="${data.receptor.rfc}"
    Nombre="${escapeXml(data.receptor.nombre)}"
    RegimenFiscalReceptor="${data.receptor.regimen_fiscal}"
    DomicilioFiscalReceptor="${data.receptor.domicilio_fiscal}"
    UsoCFDI="${data.receptor.uso_cfdi}" />
  <cfdi:Conceptos>${conceptos}
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="${data.invoice.tax_amount}">
    <cfdi:Traslados>
      <cfdi:Traslado
        Base="${data.invoice.subtotal}"
        Impuesto="002"
        TipoFactor="Tasa"
        TasaOCuota="0.160000"
        Importe="${data.invoice.tax_amount}" />
    </cfdi:Traslados>
  </cfdi:Impuestos>
</cfdi:Comprobante>`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// PAC integration stub (Finkok, Dicom, etc.)
export async function stampWithPAC(xml: string): Promise<{ uuid: string; xml_timbrado: string; cadena_original: string }> {
  // In production, this would call the actual PAC API
  // For now, return a simulated response
  if (config.pac.environment === 'sandbox') {
    const uuid = `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`.toUpperCase();
    return {
      uuid,
      xml_timbrado: xml.replace('</cfdi:Comprobante>', `
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital
      xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
      Version="1.1"
      UUID="${uuid}"
      FechaTimbrado="${new Date().toISOString()}"
      SelloCFD="..."
      NoCertificadoSAT="00001000000500000000"
      SelloSAT="..." />
  </cfdi:Complemento>
</cfdi:Comprobante>`),
      cadena_original: `||1.1|${uuid}|${new Date().toISOString()}|...|...|00001000000500000000||`,
    };
  }

  throw new AccountingError('PAC_NOT_CONFIGURED', 'PAC provider not configured for production');
}

export async function cancelWithPAC(
  uuid: string,
  rfc: string,
  reason: string,
  replacementUuid?: string
): Promise<{ status: string; acuse: string }> {
  if (config.pac.environment === 'sandbox') {
    return {
      status: 'cancelled',
      acuse: `<?xml version="1.0"?><Acuse Fecha="${new Date().toISOString()}" RfcEmisor="${rfc}"><Folios><UUID>${uuid}</UUID><EstatusUUID>201</EstatusUUID></Folios></Acuse>`,
    };
  }

  throw new AccountingError('PAC_NOT_CONFIGURED', 'PAC provider not configured for production');
}

// DIOT report generation (Declaración Informativa de Operaciones con Terceros)
export async function generateDIOT(entityId: string, month: number, year: number): Promise<string[]> {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0);

  const result = await query<{
    vendor_name: string;
    tax_id: string;
    tax_id_type: string;
    total_amount: string;
    tax_amount: string;
  }>(
    `SELECT v.company_name as vendor_name, v.tax_id, v.tax_id_type,
            SUM(b.subtotal) as total_amount, SUM(b.tax_amount) as tax_amount
     FROM bills b
     JOIN vendors v ON v.id = b.vendor_id
     WHERE b.entity_id = $1 AND b.status IN ('posted', 'paid', 'partially_paid')
       AND b.bill_date BETWEEN $2 AND $3
       AND v.tax_id IS NOT NULL
     GROUP BY v.id, v.company_name, v.tax_id, v.tax_id_type
     ORDER BY v.company_name`,
    [entityId, startDate, endDate]
  );

  // Generate DIOT pipe-delimited format
  return result.rows.map((row) => {
    const tipoTercero = row.tax_id_type === 'rfc' ? '04' : '05';
    return `${tipoTercero}|${row.tax_id}|||${row.vendor_name}||||${row.total_amount}|${row.tax_amount}||||||||`;
  });
}
