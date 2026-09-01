import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn() }));

import { classifyXml } from '../../src/services/xml-ingestion/cfdi-classifier.js';
import type { AccountRole } from '../../src/services/xml-ingestion/cfdi-taxonomy.js';

const ENTITY = { entityId: 'e1', entityRfc: 'XAXX010101000' };
const PROVEEDOR = 'SIN060101AB1';

/** Complete role → account map, to test the resulting entry. */
const ROLE_MAP = new Map<string, { code: string; name: string }>(
  ([
    ['ingreso', '4100'], ['devolucion_ventas', '4200'], ['anticipo_clientes', '2130'],
    ['cxc', '1120'], ['banco', '1110'],
    ['iva_trasladado', '2140'], ['iva_trasladado_no_cobrado', '2145'],
    ['gasto', '6100'], ['gasto_no_deducible', '6900'], ['gasto_anticipado', '1180'],
    ['inventario', '1150'], ['activo_fijo', '1210'],
    ['devolucion_compras', '5200'], ['anticipo_proveedores', '1190'], ['cxp', '2110'],
    ['iva_acreditable', '1130'], ['iva_pendiente_acreditar', '1135'],
    ['isr_retenido_por_pagar', '2150'], ['iva_retenido_por_pagar', '2155'],
    ['isr_retenido_a_favor', '1140'], ['iva_retenido_a_favor', '1145'],
    ['ieps_acreditable', '1160'], ['ieps_por_pagar', '2160'],
    ['impuestos_locales_gasto', '6200'], ['impuestos_locales_por_pagar', '2170'],
    ['sueldos_gasto', '6110'], ['sueldos_por_pagar', '2120'],
    ['isr_nomina_por_pagar', '2125'], ['imss_por_pagar', '2127'],
  ] as Array<[AccountRole, string]>).map(([r, code]) => [r, { code, name: `Cuenta ${code}` }])
);

interface CfdiOpts {
  tipo?: string;
  emisor?: string;
  receptor?: string;
  metodoPago?: string;
  formaPago?: string;
  subtotal?: number;
  iva?: number;
  total?: number;
  moneda?: string;
  isrRet?: number;
  ivaRet?: number;
  ieps?: number;
  claveProdServ?: string;
  descripcion?: string;
  objetoImp?: string;
  relacion?: { tipo: string; uuid: string };
  pagos?: Array<{ uuid: string; pagado: number; saldoAnt: number; saldoInsoluto: number }>;
  uuid?: string;
  sinTimbre?: boolean;
}

function cfdi(o: CfdiOpts = {}): string {
  const tipo = o.tipo ?? 'I';
  const subtotal = o.subtotal ?? 1000;
  const iva = o.iva ?? 160;
  const ieps = o.ieps ?? 0;
  const isrRet = o.isrRet ?? 0;
  const ivaRet = o.ivaRet ?? 0;
  const total = o.total ?? subtotal + iva + ieps - isrRet - ivaRet;
  const uuid = o.uuid ?? 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

  const traslados = [
    iva > 0 ? `<cfdi:Traslado Base="${subtotal}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${iva}"/>` : '',
    ieps > 0 ? `<cfdi:Traslado Base="${subtotal}" Impuesto="003" TipoFactor="Tasa" TasaOCuota="0.080000" Importe="${ieps}"/>` : '',
  ].join('');
  const retenciones = [
    isrRet > 0 ? `<cfdi:Retencion Base="${subtotal}" Impuesto="001" TipoFactor="Tasa" TasaOCuota="0.100000" Importe="${isrRet}"/>` : '',
    ivaRet > 0 ? `<cfdi:Retencion Base="${subtotal}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.106667" Importe="${ivaRet}"/>` : '',
  ].join('');

  const impuestosConcepto = (traslados || retenciones)
    ? `<cfdi:Impuestos>${traslados ? `<cfdi:Traslados>${traslados}</cfdi:Traslados>` : ''}${retenciones ? `<cfdi:Retenciones>${retenciones}</cfdi:Retenciones>` : ''}</cfdi:Impuestos>`
    : '';

  const pagosComplemento = o.pagos
    ? `<pago20:Pagos Version="2.0"><pago20:Pago FechaPago="2026-08-20T12:00:00" FormaDePagoP="03" MonedaP="MXN" Monto="${o.pagos.reduce((s, p) => s + p.pagado, 0)}">` +
      o.pagos.map((p) => `<pago20:DoctoRelacionado IdDocumento="${p.uuid}" MonedaDR="MXN" NumParcialidad="1" ImpSaldoAnt="${p.saldoAnt}" ImpPagado="${p.pagado}" ImpSaldoInsoluto="${p.saldoInsoluto}"/>`).join('') +
      `</pago20:Pago></pago20:Pagos>`
    : '';

  const timbre = o.sinTimbre ? '' :
    `<tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}" FechaTimbrado="2026-08-20T12:05:00" RfcProvCertif="SAT970701NN3" SelloCFD="s" NoCertificadoSAT="30001" SelloSAT="s"/>`;

  const relacionados = o.relacion
    ? `<cfdi:CfdiRelacionados TipoRelacion="${o.relacion.tipo}"><cfdi:CfdiRelacionado UUID="${o.relacion.uuid}"/></cfdi:CfdiRelacionados>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" xmlns:pago20="http://www.sat.gob.mx/Pagos20"
  Version="4.0" Serie="A" Folio="1" Fecha="2026-08-20T12:00:00"
  ${o.formaPago ? `FormaPago="${o.formaPago}"` : 'FormaPago="03"'} ${tipo !== 'P' ? `MetodoPago="${o.metodoPago ?? 'PUE'}"` : ''}
  TipoDeComprobante="${tipo}" Moneda="${o.moneda ?? 'MXN'}" ${o.moneda && o.moneda !== 'MXN' ? 'TipoCambio="18.50"' : ''}
  SubTotal="${tipo === 'P' ? 0 : subtotal}" Total="${tipo === 'P' ? 0 : total}" LugarExpedicion="06600">
  ${relacionados}
  <cfdi:Emisor Rfc="${o.emisor ?? PROVEEDOR}" Nombre="Proveedor SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${o.receptor ?? ENTITY.entityRfc}" Nombre="Demo Corp MX" UsoCFDI="G03" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="${o.claveProdServ ?? '01010101'}" ClaveUnidad="E48" Descripcion="${o.descripcion ?? 'Servicio general'}"
      Cantidad="1" ValorUnitario="${tipo === 'P' ? 0 : subtotal}" Importe="${tipo === 'P' ? 0 : subtotal}" ObjetoImp="${o.objetoImp ?? '02'}">
      ${tipo === 'P' ? '' : impuestosConcepto}
    </cfdi:Concepto>
  </cfdi:Conceptos>
  ${tipo === 'P' || (iva === 0 && ieps === 0 && isrRet === 0) ? '' : `<cfdi:Impuestos TotalImpuestosTrasladados="${iva + ieps}" ${isrRet + ivaRet > 0 ? `TotalImpuestosRetenidos="${isrRet + ivaRet}"` : ''}/>`}
  <cfdi:Complemento>${timbre}${pagosComplemento}</cfdi:Complemento>
</cfdi:Comprobante>`;
}

const classify = (o: CfdiOpts = {}, extra: Record<string, unknown> = {}) =>
  classifyXml(cfdi(o), { ...ENTITY, roleMap: ROLE_MAP, satStatus: 'vigente', vendorExists: true, periodOpen: true, ...extra });

/** Sums debits and credits of the proposed entry. */
function totals(lines: Array<{ debit: number | null; credit: number | null }>) {
  return {
    debits: lines.reduce((s, l) => s + (l.debit ?? 0), 0),
    credits: lines.reduce((s, l) => s + (l.credit ?? 0), 0),
  };
}
const roleOf = (c: Awaited<ReturnType<typeof classify>>, role: string) =>
  c.lines.find((l) => l.role === role);

// ══════════════════════════════════════════════════════════════
describe('direction: issued vs received', () => {
  it('detects RECEIVED and records it as an expense', async () => {
    const c = await classify();
    expect(c.facts.direction).toBe('recibido');
    expect(c.case!.id).toBe('ingreso_recibido_pue');
    expect(roleOf(c, 'gasto')!.debit).toBe(1000);
    expect(roleOf(c, 'cxp')!.credit).toBe(1160);
  });

  it('detects ISSUED and records it as a SALE, not an expense', async () => {
    // This is the bug the previous pipeline had: it recorded the entity's
    // own sales as purchases.
    const c = await classify({ emisor: ENTITY.entityRfc, receptor: 'CLI010101AAA' });
    expect(c.facts.direction).toBe('emitido');
    expect(c.case!.id).toBe('ingreso_emitido_pue');
    expect(roleOf(c, 'ingreso')!.credit).toBe(1000);
    expect(roleOf(c, 'cxc')!.debit).toBe(1160);
    expect(roleOf(c, 'gasto')).toBeUndefined();
  });

  it('BLOCKS a CFDI that is neither inbound nor outbound', async () => {
    const c = await classify({ emisor: 'OTR010101AAA', receptor: 'TER010101AAA' });
    expect(c.facts.direction).toBe('ajeno');
    expect(c.verdict).toBe('blocked');
    expect(c.reason).toMatch(/wrong entity/);
  });
});

describe('PUE vs PPD: the timing of VAT', () => {
  it('received PUE credits the VAT immediately', async () => {
    const c = await classify({ metodoPago: 'PUE' });
    expect(roleOf(c, 'iva_acreditable')!.debit).toBe(160);
    expect(roleOf(c, 'iva_pendiente_acreditar')).toBeUndefined();
  });

  it('received PPD does NOT credit the VAT yet', async () => {
    // The VAT is credited when paying (with the REP), not when the invoice arrives.
    const c = await classify({ metodoPago: 'PPD' });
    expect(c.case!.id).toBe('ingreso_recibido_ppd');
    expect(roleOf(c, 'iva_pendiente_acreditar')!.debit).toBe(160);
    expect(roleOf(c, 'iva_acreditable')).toBeUndefined();
  });

  it('issued PPD does NOT trigger the VAT yet', async () => {
    const c = await classify({ emisor: ENTITY.entityRfc, receptor: 'CLI010101AAA', metodoPago: 'PPD' });
    expect(roleOf(c, 'iva_trasladado_no_cobrado')!.credit).toBe(160);
    expect(roleOf(c, 'iva_trasladado')).toBeUndefined();
  });
});

describe('type P (payment): neither revenue nor expense', () => {
  it('received REP applies the payment against the vendor, without touching expenses', async () => {
    const c = await classify({
      tipo: 'P', metodoPago: undefined,
      pagos: [{ uuid: 'FACT-1', pagado: 580, saldoAnt: 1160, saldoInsoluto: 580 }],
    });
    expect(c.case!.id).toBe('pago_recibido');
    expect(roleOf(c, 'cxp')!.debit).toBe(580);
    expect(roleOf(c, 'banco')!.credit).toBe(580);
    expect(roleOf(c, 'gasto')).toBeUndefined();
    expect(c.linkage).toEqual([{ uuid: 'FACT-1', amount: 580 }]);
  });

  it('issued REP records the collection, not new revenue', async () => {
    const c = await classify({
      tipo: 'P', emisor: ENTITY.entityRfc, receptor: 'CLI010101AAA', metodoPago: undefined,
      pagos: [{ uuid: 'FACT-9', pagado: 1160, saldoAnt: 1160, saldoInsoluto: 0 }],
    });
    expect(c.case!.id).toBe('pago_emitido');
    expect(roleOf(c, 'banco')!.debit).toBe(1160);
    expect(roleOf(c, 'cxc')!.credit).toBe(1160);
    expect(roleOf(c, 'ingreso')).toBeUndefined();
  });

  it('sums several related documents in a single payment', async () => {
    const c = await classify({
      tipo: 'P', metodoPago: undefined,
      pagos: [
        { uuid: 'F-1', pagado: 500, saldoAnt: 500, saldoInsoluto: 0 },
        { uuid: 'F-2', pagado: 300, saldoAnt: 800, saldoInsoluto: 500 },
      ],
    });
    expect(roleOf(c, 'cxp')!.debit).toBe(800);
    expect(c.linkage).toHaveLength(2);
  });
});

describe('type E (egreso): the TipoRelacion changes everything', () => {
  it('relation 01 received is a credit note on purchases', async () => {
    const c = await classify({ tipo: 'E', relacion: { tipo: '01', uuid: 'F-1' } });
    expect(c.case!.id).toBe('egreso_recibido_nota_credito');
    expect(roleOf(c, 'cxp')!.debit).toBe(1160);
    expect(roleOf(c, 'devolucion_compras')!.credit).toBe(1000);
  });

  it('relation 07 received is an ADVANCE APPLICATION, not a return', async () => {
    const c = await classify({ tipo: 'E', relacion: { tipo: '07', uuid: 'ANT-1' } });
    expect(c.case!.id).toBe('egreso_recibido_aplicacion_anticipo');
    expect(roleOf(c, 'anticipo_proveedores')!.credit).toBe(1000);
    expect(roleOf(c, 'devolucion_compras')).toBeUndefined();
  });

  it('relation 04 (substitution) generates no journal entry: the prior one must be reversed', async () => {
    const c = await classify({ tipo: 'E', relacion: { tipo: '04', uuid: 'F-CANCELADA' } });
    expect(c.case!.id).toBe('egreso_recibido_sustitucion');
    expect(c.verdict).toBe('no_posting');
    expect(c.reason).toMatch(/replaces/);
  });

  it('an issued credit note is a return on SALES', async () => {
    const c = await classify({
      tipo: 'E', emisor: ENTITY.entityRfc, receptor: 'CLI010101AAA',
      relacion: { tipo: '01', uuid: 'F-9' },
    });
    expect(roleOf(c, 'devolucion_ventas')!.debit).toBe(1000);
    expect(roleOf(c, 'cxc')!.credit).toBe(1160);
  });
});

describe('types without a journal entry', () => {
  it('transfer (T) generates no entry', async () => {
    const c = await classify({ tipo: 'T', iva: 0, total: 1000 });
    expect(c.verdict).toBe('no_posting');
    expect(c.lines).toHaveLength(0);
  });

  it('a received payroll receipt does not belong to the company', async () => {
    const c = await classify({ tipo: 'N', iva: 0, total: 1000 });
    expect(c.case!.id).toBe('nomina_recibida');
    expect(c.verdict).toBe('no_posting');
  });

  it('BLOCKS a CFDI without a fiscal stamp', async () => {
    const c = await classify({ sinTimbre: true });
    expect(c.verdict).toBe('blocked');
    expect(c.reason).toMatch(/UUID/);
  });
});

describe('withholdings: withholder vs withheld', () => {
  it('received with withholdings: the company is the WITHHOLDER (liability)', async () => {
    const c = await classify({ isrRet: 100, ivaRet: 106.67, total: 953.33 });
    expect(roleOf(c, 'isr_retenido_por_pagar')!.credit).toBe(100);
    expect(roleOf(c, 'iva_retenido_por_pagar')!.credit).toBe(106.67);
    expect(roleOf(c, 'cxp')!.credit).toBe(953.33);
    const t = totals(c.lines);
    expect(t.debits).toBeCloseTo(t.credits, 2);
  });

  it('issued with withholdings: the company IS WITHHELD FROM (asset in favor)', async () => {
    const c = await classify({
      emisor: ENTITY.entityRfc, receptor: 'CLI010101AAA',
      isrRet: 100, ivaRet: 106.67, total: 953.33,
    });
    expect(roleOf(c, 'isr_retenido_a_favor')!.debit).toBe(100);
    expect(roleOf(c, 'iva_retenido_a_favor')!.debit).toBe(106.67);
    expect(roleOf(c, 'cxc')!.debit).toBe(953.33);
    const t = totals(c.lines);
    expect(t.debits).toBeCloseTo(t.credits, 2);
  });
});

describe('taxes: IEPS and exempt vs 0% rate', () => {
  it('separates IEPS from VAT', async () => {
    const c = await classify({ ieps: 80, total: 1240 });
    expect(c.facts.iepsTrasladado).toBe(80);
    expect(roleOf(c, 'ieps_acreditable')!.debit).toBe(80);
  });

  it('warns about EXEMPT items (they generate no creditable VAT)', async () => {
    const c = await classify({ iva: 0, objetoImp: '01', total: 1000 });
    expect(c.facts.importeExento).toBe(1000);
    expect(c.warnings.some((w) => /EXEMPT/.test(w))).toBe(true);
  });
});

describe('decisions for the user', () => {
  it('asks expense vs fixed asset when the amount exceeds the threshold', async () => {
    const c = await classify({ subtotal: 50000, iva: 8000, total: 58000 });
    const d = c.decisions.find((x) => x.id === 'gasto_vs_activo');
    expect(d).toBeDefined();
    expect(d!.severity).toBe('blocking');
    expect(c.verdict).toBe('needs_input');
    // F02 · lleva_inventarios: con la política por defecto ('directo') la
    // opción de inventario NO se ofrece — un despacho a costo directo no
    // capitaliza compras en 1140 por un click distraído.
    expect(d!.options.map((o) => o.value)).toEqual(['activo_fijo', 'gasto']);
  });

  it("F02: la política 'perpetuos' devuelve la opción de inventario a la mesa", async () => {
    const c = await classify(
      { subtotal: 50000, iva: 8000, total: 58000 },
      {
        thresholds: {
          capitalizationThreshold: 20000, restaurantPolicy: 'split_85',
          iepsTreatment: 'costo', inventoryPolicy: 'perpetuos',
        },
      }
    );
    const d = c.decisions.find((x) => x.id === 'gasto_vs_activo');
    expect(d!.options.map((o) => o.value)).toEqual(['activo_fijo', 'gasto', 'inventario']);
  });

  it('the answer changes the account in the entry', async () => {
    const c = await classify(
      { subtotal: 50000, iva: 8000, total: 58000 },
      { answers: { gasto_vs_activo: 'activo_fijo' } }
    );
    expect(roleOf(c, 'activo_fijo')!.debit).toBe(50000);
    expect(roleOf(c, 'gasto')).toBeUndefined();
    expect(c.verdict).toBe('ready');
  });

  it('blocks a cash payment above $2,000 (non-deductible)', async () => {
    const c = await classify({ formaPago: '01', subtotal: 5000, iva: 800, total: 5800 });
    const d = c.decisions.find((x) => x.id === 'efectivo_no_deducible');
    expect(d).toBeDefined();
    expect(d!.basis).toMatch(/LISR/);
  });

  it('suggests the 8.5% split for restaurant meals', async () => {
    // Fixture description stays in Spanish: it is invoice data matched by the Spanish-language rules.
    const c = await classify({ descripcion: 'Consumo de alimentos en restaurante', subtotal: 2000, iva: 320, total: 2320 });
    const d = c.decisions.find((x) => x.id === 'consumo_restaurante');
    expect(d!.severity).toBe('advisory');
    expect(d!.default).toBe('split_85');
    // Advisory does not block the record
    expect(c.verdict).toBe('ready');
  });

  it('asks about the vendor when it does not exist in the catalog', async () => {
    const c = await classify({}, { vendorExists: false });
    expect(c.decisions.some((d) => d.id === 'proveedor_nuevo')).toBe(true);
    expect(c.verdict).toBe('needs_input');
  });

  it('asks when the period is closed', async () => {
    const c = await classify({}, { periodOpen: false });
    expect(c.decisions.some((d) => d.id === 'periodo_cerrado')).toBe(true);
  });

  it('asks when the SAT reports the CFDI as cancelled', async () => {
    const c = await classify({}, { satStatus: 'cancelado' });
    const d = c.decisions.find((x) => x.id === 'cfdi_cancelado');
    expect(d!.default).toBe('rechazar');
  });

  it('warns if the CFDI was not validated against the SAT', async () => {
    const c = await classify({}, { satStatus: 'sin_validar' });
    expect(c.warnings.some((w) => /has not been validated/.test(w))).toBe(true);
  });
});

describe('integrity', () => {
  it('every proposed entry balances', async () => {
    const scenarios: CfdiOpts[] = [
      {},
      { metodoPago: 'PPD' },
      { emisor: ENTITY.entityRfc, receptor: 'CLI010101AAA' },
      { emisor: ENTITY.entityRfc, receptor: 'CLI010101AAA', metodoPago: 'PPD' },
      { tipo: 'E', relacion: { tipo: '01', uuid: 'F-1' } },
      { tipo: 'E', relacion: { tipo: '07', uuid: 'A-1' } },
      { tipo: 'E', emisor: ENTITY.entityRfc, receptor: 'CLI010101AAA', relacion: { tipo: '01', uuid: 'F-1' } },
      { isrRet: 100, ivaRet: 106.67, total: 953.33 },
      { ieps: 80, total: 1240 },
      { descripcion: 'Anticipo de servicios', claveProdServ: '84111506' },
    ];
    for (const s of scenarios) {
      const c = await classify(s);
      if (c.lines.length === 0) continue;
      const t = totals(c.lines);
      expect(t.debits, `imbalance in ${c.case?.id}`).toBeCloseTo(t.credits, 2);
    }
  });

  it('BLOCKS a CFDI whose total does not match its parts', async () => {
    const c = await classify({ subtotal: 1000, iva: 160, total: 9999 });
    expect(c.verdict).toBe('blocked');
    expect(c.reason).toMatch(/does not balance/);
  });

  it('reports roles without a configured account', async () => {
    const c = await classifyXml(cfdi(), {
      ...ENTITY, roleMap: new Map(), satStatus: 'vigente', vendorExists: true, periodOpen: true,
    });
    expect(c.verdict).toBe('needs_input');
    expect(c.missingRoles).toContain('gasto');
    expect(c.reason).toMatch(/Missing accounts/);
  });

  it('warns on foreign currency', async () => {
    const c = await classify({ moneda: 'USD' });
    expect(c.facts.esMonedaExtranjera).toBe(true);
    expect(c.warnings.some((w) => /USD/.test(w))).toBe(true);
  });
});
