import { XMLParser } from 'fast-xml-parser';
import crypto from 'crypto';
import Decimal from 'decimal.js';

// ============================================================
// INTERFACES
// ============================================================

export interface CFDIImpuesto {
  base: number;
  impuesto: string; // '002' = IVA, '001' = ISR
  tipoFactor: string; // 'Tasa', 'Cuota', 'Exento'
  tasaOCuota?: number;
  importe?: number;
}

export interface CFDIConcepto {
  claveProdServ: string;
  claveUnidad: string;
  unidad?: string;
  noIdentificacion?: string;
  descripcion: string;
  cantidad: number;
  valorUnitario: number;
  importe: number;
  descuento?: number;
  objetoImp: string;
  impuestos?: {
    traslados: CFDIImpuesto[];
    retenciones: CFDIImpuesto[];
  };
}

export interface CFDIParsed {
  version: string;
  serie?: string;
  folio?: string;
  fecha: Date;
  formaPago?: string;
  metodoPago?: string;
  tipoDeComprobante: string;
  moneda: string;
  tipoCambio?: number;
  subTotal: number;
  descuento?: number;
  total: number;

  emisor: {
    rfc: string;
    nombre: string;
    regimenFiscal: string;
  };

  receptor: {
    rfc: string;
    nombre: string;
    usoCFDI: string;
    domicilioFiscalReceptor?: string;
    regimenFiscalReceptor?: string;
  };

  conceptos: CFDIConcepto[];

  impuestos: {
    totalImpuestosTrasladados?: number;
    totalImpuestosRetenidos?: number;
    traslados: CFDIImpuesto[];
    retenciones: CFDIImpuesto[];
  };

  timbreFiscalDigital?: {
    uuid: string;
    fechaTimbrado: Date;
    rfcProvCertif: string;
    selloCFD: string;
    selloSAT: string;
    noCertificadoSAT: string;
  };

  complementos: Array<{ type: string; data: Record<string, unknown> }>;
  /**
   * CfdiRelacionados is a sibling of Comprobante, it does NOT live inside
   * <cfdi:Complemento>: looking for it among the complements never finds it,
   * and without the TipoRelacion an egreso applying an advance payment (07)
   * is indistinguishable from a return (03).
   */
  cfdiRelacionados?: { tipoRelacion: string; uuids: string[] };
}

// ============================================================
// CFDI PARSER
// ============================================================

export class CFDIParser {
  private parser: XMLParser;

  constructor() {
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
      parseAttributeValue: true,
      trimValues: true,
    });
  }

  parse(xmlString: string): CFDIParsed {
    const parsed = this.parser.parse(xmlString);
    const comprobante = parsed.Comprobante;

    if (!comprobante) {
      throw new Error('Invalid CFDI: No Comprobante element found');
    }

    // Normalize version (fast-xml-parser may parse "4.0" as number 4)
    const versionRaw = comprobante['@_Version'];
    const version = typeof versionRaw === 'number'
      ? (Number.isInteger(versionRaw) ? `${versionRaw}.0` : String(versionRaw))
      : String(versionRaw);
    if (version !== '4.0' && version !== '3.3') {
      throw new Error(`Unsupported CFDI version: ${version}`);
    }

    const cfdi: CFDIParsed = {
      version,
      serie: comprobante['@_Serie'],
      folio: comprobante['@_Folio']?.toString(),
      fecha: new Date(comprobante['@_Fecha']),
      formaPago: comprobante['@_FormaPago'],
      metodoPago: comprobante['@_MetodoPago'],
      tipoDeComprobante: comprobante['@_TipoDeComprobante'],
      moneda: comprobante['@_Moneda'] || 'MXN',
      tipoCambio: comprobante['@_TipoCambio']
        ? parseFloat(comprobante['@_TipoCambio'])
        : 1,
      subTotal: parseFloat(comprobante['@_SubTotal']),
      descuento: comprobante['@_Descuento']
        ? parseFloat(comprobante['@_Descuento'])
        : undefined,
      total: parseFloat(comprobante['@_Total']),

      emisor: {
        rfc: comprobante.Emisor['@_Rfc'],
        nombre: comprobante.Emisor['@_Nombre'],
        regimenFiscal: comprobante.Emisor['@_RegimenFiscal'],
      },

      receptor: {
        rfc: comprobante.Receptor['@_Rfc'],
        nombre: comprobante.Receptor['@_Nombre'],
        usoCFDI: comprobante.Receptor['@_UsoCFDI'],
        domicilioFiscalReceptor: comprobante.Receptor['@_DomicilioFiscalReceptor'],
        regimenFiscalReceptor: comprobante.Receptor['@_RegimenFiscalReceptor'],
      },

      conceptos: this.parseConceptos(comprobante.Conceptos),
      impuestos: this.parseImpuestos(comprobante.Impuestos),
      complementos: this.parseComplementos(comprobante.Complemento),
      cfdiRelacionados: this.parseCfdiRelacionados(comprobante.CfdiRelacionados),
    };

    // Extract TimbreFiscalDigital
    const timbre = cfdi.complementos.find((c) => c.type === 'TimbreFiscalDigital');
    if (timbre) {
      const t = timbre.data as Record<string, unknown>;
      cfdi.timbreFiscalDigital = {
        uuid: String(t.UUID),
        fechaTimbrado: new Date(String(t.FechaTimbrado)),
        rfcProvCertif: String(t.RfcProvCertif || ''),
        selloCFD: String(t.SelloCFD || ''),
        selloSAT: String(t.SelloSAT || ''),
        noCertificadoSAT: String(t.NoCertificadoSAT || ''),
      };
    }

    return cfdi;
  }

  /** Reads the sibling CfdiRelacionados node (one or several UUIDs). */
  private parseCfdiRelacionados(
    node: Record<string, unknown> | undefined
  ): { tipoRelacion: string; uuids: string[] } | undefined {
    if (!node) return undefined;
    const relNode = node.CfdiRelacionado;
    const rels = Array.isArray(relNode) ? relNode : relNode ? [relNode] : [];
    return {
      // parseAttributeValue turns "07" into the number 7: normalize to 2 digits.
      tipoRelacion: String(node['@_TipoRelacion'] ?? '').padStart(2, '0'),
      uuids: (rels as Array<Record<string, unknown>>)
        .map((r) => String(r['@_UUID'] ?? ''))
        .filter(Boolean),
    };
  }

  private parseConceptos(conceptosNode: Record<string, unknown> | undefined): CFDIConcepto[] {
    if (!conceptosNode || !conceptosNode.Concepto) return [];

    const conceptos = Array.isArray(conceptosNode.Concepto)
      ? conceptosNode.Concepto
      : [conceptosNode.Concepto];

    return conceptos.map((c: Record<string, unknown>) => ({
      claveProdServ: String(c['@_ClaveProdServ']),
      claveUnidad: String(c['@_ClaveUnidad']),
      unidad: c['@_Unidad'] as string | undefined,
      noIdentificacion: c['@_NoIdentificacion'] as string | undefined,
      descripcion: String(c['@_Descripcion']),
      cantidad: parseFloat(String(c['@_Cantidad'])),
      valorUnitario: parseFloat(String(c['@_ValorUnitario'])),
      importe: parseFloat(String(c['@_Importe'])),
      descuento: c['@_Descuento'] ? parseFloat(String(c['@_Descuento'])) : undefined,
      objetoImp: String(c['@_ObjetoImp'] || ''),
      impuestos: c.Impuestos
        ? {
            traslados: this.parseImpuestosList((c.Impuestos as Record<string, unknown>).Traslados, 'Traslado'),
            retenciones: this.parseImpuestosList((c.Impuestos as Record<string, unknown>).Retenciones, 'Retencion'),
          }
        : undefined,
    }));
  }

  private parseImpuestos(impuestosNode: Record<string, unknown> | undefined): CFDIParsed['impuestos'] {
    if (!impuestosNode) {
      return { traslados: [], retenciones: [] };
    }

    return {
      totalImpuestosTrasladados: impuestosNode['@_TotalImpuestosTrasladados']
        ? parseFloat(String(impuestosNode['@_TotalImpuestosTrasladados']))
        : undefined,
      totalImpuestosRetenidos: impuestosNode['@_TotalImpuestosRetenidos']
        ? parseFloat(String(impuestosNode['@_TotalImpuestosRetenidos']))
        : undefined,
      traslados: this.parseImpuestosList(impuestosNode.Traslados, 'Traslado'),
      retenciones: this.parseImpuestosList(impuestosNode.Retenciones, 'Retencion'),
    };
  }

  private parseImpuestosList(node: unknown, itemKey: string): CFDIImpuesto[] {
    if (!node || typeof node !== 'object') return [];
    const obj = node as Record<string, unknown>;
    const items = obj[itemKey];
    if (!items) return [];

    const list = Array.isArray(items) ? items : [items];

    return list.map((i: Record<string, unknown>) => ({
      base: parseFloat(String(i['@_Base'])),
      impuesto: String(i['@_Impuesto']),
      tipoFactor: String(i['@_TipoFactor']),
      tasaOCuota: i['@_TasaOCuota'] ? parseFloat(String(i['@_TasaOCuota'])) : undefined,
      importe: i['@_Importe'] ? parseFloat(String(i['@_Importe'])) : undefined,
    }));
  }

  private parseComplementos(complementoNode: Record<string, unknown> | undefined): Array<{ type: string; data: Record<string, unknown> }> {
    if (!complementoNode) return [];

    const complementos: Array<{ type: string; data: Record<string, unknown> }> = [];

    if (complementoNode.TimbreFiscalDigital) {
      const tfd = complementoNode.TimbreFiscalDigital as Record<string, unknown>;
      complementos.push({
        type: 'TimbreFiscalDigital',
        data: {
          UUID: tfd['@_UUID'],
          FechaTimbrado: tfd['@_FechaTimbrado'],
          RfcProvCertif: tfd['@_RfcProvCertif'],
          SelloCFD: tfd['@_SelloCFD'],
          SelloSAT: tfd['@_SelloSAT'],
          NoCertificadoSAT: tfd['@_NoCertificadoSAT'],
        },
      });
    }

    if (complementoNode.Pagos) {
      complementos.push({ type: 'Pagos', data: complementoNode.Pagos as Record<string, unknown> });
    }

    if (complementoNode.Nomina) {
      complementos.push({ type: 'Nomina', data: complementoNode.Nomina as Record<string, unknown> });
    }

    return complementos;
  }

  calculateHash(xmlString: string): string {
    return crypto.createHash('sha256').update(xmlString).digest('hex');
  }

  validate(cfdi: CFDIParsed): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!cfdi.timbreFiscalDigital?.uuid) {
      errors.push('Missing UUID (TimbreFiscalDigital)');
    }

    if (!cfdi.emisor.rfc) errors.push('Missing Emisor RFC');
    if (!cfdi.receptor.rfc) errors.push('Missing Receptor RFC');

    const rfcRegex = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;
    if (cfdi.emisor.rfc && !rfcRegex.test(cfdi.emisor.rfc)) {
      errors.push('Invalid Emisor RFC format');
    }
    if (cfdi.receptor.rfc && !rfcRegex.test(cfdi.receptor.rfc)) {
      errors.push('Invalid Receptor RFC format');
    }

    // NaN/Infinity would fail every Decimal comparison below OPEN (NaN
    // comparisons return false), persist as Postgres 'NaN' and later defeat
    // the ingest auto-post gates — reject malformed amounts at the source.
    if (!Number.isFinite(cfdi.total) || !Number.isFinite(cfdi.subTotal)) {
      errors.push('Non-numeric Total/SubTotal');
      return { valid: false, errors };
    }

    const conceptosTotal = cfdi.conceptos.reduce(
      (sum, c) => sum.plus(c.importe).minus(c.descuento || 0),
      new Decimal(0)
    );

    if (conceptosTotal.minus(cfdi.subTotal).abs().greaterThan('0.01')) {
      errors.push('Conceptos total does not match SubTotal');
    }

    const calculatedTotal = new Decimal(cfdi.subTotal)
      .minus(cfdi.descuento || 0)
      .plus(cfdi.impuestos.totalImpuestosTrasladados || 0)
      .minus(cfdi.impuestos.totalImpuestosRetenidos || 0);

    if (calculatedTotal.minus(cfdi.total).abs().greaterThan('0.01')) {
      errors.push('Total calculation mismatch');
    }

    return { valid: errors.length === 0, errors };
  }

  // Calculate tax breakdown by rate (16%, 8%, 0%) and retentions
  calculateTaxBreakdown(cfdi: CFDIParsed): {
    iva_16: string;
    iva_8: string;
    iva_0: string;
    isr_retenido: string;
    iva_retenido: string;
  } {
    let iva16 = new Decimal(0);
    let iva8 = new Decimal(0);
    let iva0 = new Decimal(0);
    let isrRetenido = new Decimal(0);
    let ivaRetenido = new Decimal(0);

    // SAT keys arrive as numbers because of parseAttributeValue ("002" -> 2):
    // normalize the width before comparing, or the breakdown comes out all zeros.
    const clave = (v: unknown) => String(v ?? '').padStart(3, '0');

    for (const concepto of cfdi.conceptos) {
      if (concepto.impuestos?.traslados) {
        for (const t of concepto.impuestos.traslados) {
          if (clave(t.impuesto) === '002' && t.importe) {
            const rate = (t.tasaOCuota || 0) * 100;
            if (Math.round(rate) === 16) iva16 = iva16.plus(t.importe);
            else if (Math.round(rate) === 8) iva8 = iva8.plus(t.importe);
            else if (Math.round(rate) === 0) iva0 = iva0.plus(t.importe);
          }
        }
      }

      if (concepto.impuestos?.retenciones) {
        for (const r of concepto.impuestos.retenciones) {
          if (clave(r.impuesto) === '001' && r.importe) isrRetenido = isrRetenido.plus(r.importe);
          if (clave(r.impuesto) === '002' && r.importe) ivaRetenido = ivaRetenido.plus(r.importe);
        }
      }
    }

    return {
      iva_16: iva16.toFixed(4),
      iva_8: iva8.toFixed(4),
      iva_0: iva0.toFixed(4),
      isr_retenido: isrRetenido.toFixed(4),
      iva_retenido: ivaRetenido.toFixed(4),
    };
  }

  mapTipoComprobante(tipo: string): string {
    // F02: 'R' se RETIRÓ del mapa. Una constancia de retenciones no es un
    // CFDI: vive en otro namespace (retenciones:Retenciones, esquema
    // retencionpago) y su raíz no es cfdi:Comprobante — parse() la rechaza
    // tres candados antes de llegar aquí. Anunciar un tipo que no puede
    // llegar era una promesa falsa del parser; soportar constancias es un
    // parser PROPIO con sus pruebas, no una letra en este mapa.
    const mapping: Record<string, string> = {
      I: 'cfdi_ingreso',
      E: 'cfdi_egreso',
      T: 'cfdi_traslado',
      N: 'cfdi_nomina',
      P: 'cfdi_pago',
    };
    return mapping[tipo] || 'other';
  }
}
