import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn() }));

import {
  DECISIONS,
  DEFAULT_THRESHOLDS,
  PREPAID_THRESHOLD_MXN,
  decisionsFor,
} from '../../src/services/xml-ingestion/cfdi-decisions.js';
import { classifyXml } from '../../src/services/xml-ingestion/cfdi-classifier.js';
import type { CfdiFacts } from '../../src/services/xml-ingestion/cfdi-facts.js';

/**
 * NO SE PROMETE UN ACTO QUE NO SE REALIZA — LA SEGUNDA VEZ.
 *
 * Hermana de `dep-promesa.spec.ts`, y el caso era peor. La pantalla donde el
 * usuario clasifica un desembolso ofrecía «Prepaid expenses (accrued month by
 * month)» y su fundamento citaba la NIF A-2, cuando en el sistema NADA
 * devengaba: ni tabla, ni migración, ni motor, ni comando. El importe entraba
 * a la 1160 y se quedaba ahí para siempre — el gasto no llegaba nunca al
 * resultado, el balance cuadraba todos los meses y sólo lo delataba un saldo
 * que crecía. Citar la norma como respaldo de un acto que no ocurre es peor
 * que no ofrecer la opción.
 *
 * D1a entregó la 059, el alta y la corrida. Lo que estas pruebas fijan es que
 * la etiqueta suba SÓLO hasta donde es verdad: elegir esto no da de alta el
 * calendario, y sin calendario no hay devengo. Y que la opción deje de
 * ofrecerse por debajo del piso de materialidad, que es lo que hacía que una
 * suscripción de 900 pesos recibiera la misma pregunta que una póliza de
 * 60 000.
 */
describe('la opción de gasto anticipado dice lo que de verdad ocurre', () => {
  const d = DECISIONS.find((x) => x.id === 'gasto_vs_anticipado')!;
  const opcion = d.options.find((o) => o.value === 'gasto_anticipado')!;

  it('existe la decisión y su opción: si se renombran, esto deja de vigilar', () => {
    expect(d).toBeDefined();
    expect(opcion).toBeDefined();
    expect(opcion.role).toBe('gasto_anticipado');
  });

  it('la etiqueta NO afirma a secas que se devengue mes a mes', () => {
    expect(
      opcion.label,
      'elegir esto sólo lleva el importe a la 1160: sin calendario nada lo saca de ahí'
    ).not.toMatch(/^Prepaid expenses \(accrued month by month\)$/);
  });

  it('dice a dónde va el importe y qué paso falta para que se devengue', () => {
    expect(opcion.label).toMatch(/1160/);
    expect(opcion.label.toLowerCase()).toMatch(/prepaid create/);
  });

  it('el contexto que se muestra al decidir lo repite, no sólo la etiqueta', () => {
    // La etiqueta se lee de pasada en una lista; el contexto es lo que se lee
    // cuando alguien duda. La advertencia tiene que estar en los dos.
    const ctx = d.context({
      emisorNombre: 'Aseguradora SA',
      subtotal: 60000,
      moneda: 'MXN',
      conceptosDescripcion: 'Póliza de seguro anual',
      clavesProdServ: [],
    } as unknown as CfdiFacts);
    expect(ctx).toMatch(/prepaid create/);
    expect(ctx).toMatch(/prepaid run/);
    expect(ctx).toMatch(/does not reach the income statement without the schedule/i);
  });

  it('el contexto enseña el piso con el que se está decidiendo', () => {
    // La cifra que decide si la pregunta se hace es parte de la pregunta.
    const ctx = d.context(
      {
        emisorNombre: 'X', subtotal: 60000, moneda: 'MXN',
        conceptosDescripcion: 'Póliza anual', clavesProdServ: [],
      } as unknown as CfdiFacts,
      { ...DEFAULT_THRESHOLDS, prepaidThreshold: 20000 }
    );
    expect(ctx).toMatch(/20,000\.00 MXN/);
  });

  it('el fundamento nombra el comando, no sólo la norma', () => {
    // Es la diferencia entre respaldar un acto y respaldar una intención.
    expect(d.basis).toMatch(/NIF A-2/);
    expect(d.basis).toMatch(/prepaid create/);
    expect(d.basis).toMatch(/prepaid run/);
    expect(d.basis).toMatch(/umbral_anticipado_mxn/);
  });
});

describe('el piso de importe, que no existía', () => {
  const hechos = (subtotal: number): CfdiFacts =>
    ({
      direction: 'recibido',
      tipo: 'I',
      subtotal,
      moneda: 'MXN',
      emisorRfc: 'SIN060101AB1',
      emisorNombre: 'Aseguradora SA',
      conceptosDescripcion: 'Póliza de seguro anual de flotilla',
      clavesProdServ: [],
      iepsTrasladado: 0,
      importeExento: 0,
      complementos: [],
      pagadoEnEfectivo: false,
      total: subtotal,
      esAnticipo: false,
    }) as unknown as CfdiFacts;

  const aplica = (subtotal: number, thresholds = DEFAULT_THRESHOLDS): boolean =>
    decisionsFor(hechos(subtotal), thresholds).some((x) => x.id === 'gasto_vs_anticipado');

  it('el defecto declarado es el mismo que el del panel', () => {
    expect(PREPAID_THRESHOLD_MXN).toBe(5000);
    expect(DEFAULT_THRESHOLDS.prepaidThreshold).toBe(5000);
  });

  it('ya NO pregunta por una suscripción de 900 pesos', () => {
    // Partirla en doce asientos de 75 cuesta más en teneduría que la precisión
    // que compra (NIF A-4), y el alta la rechazaría de todos modos: ofrecerla
    // aquí era además una pregunta sin salida.
    expect(aplica(900)).toBe(false);
  });

  it('pregunta justo en el umbral, no sólo por encima', () => {
    expect(aplica(5000)).toBe(true);
    expect(aplica(4999.99)).toBe(false);
  });

  it('obedece el umbral que el despacho contestó, no la constante', () => {
    const alto = { ...DEFAULT_THRESHOLDS, prepaidThreshold: 20000 };
    expect(aplica(6000, alto)).toBe(false);
    expect(aplica(25000, alto)).toBe(true);
  });

  it('sin umbral en el objeto cae al defecto declarado y no a cero', () => {
    // El constructor de umbrales de pre-registration-service.ts todavía no
    // pasa este campo. Con `?? 0` la regex volvería a ser el único filtro.
    const sinCampo = {
      capitalizationThreshold: 20000, restaurantPolicy: 'split_85',
      iepsTreatment: 'costo', inventoryPolicy: 'directo',
    };
    expect(aplica(900, sinCampo)).toBe(false);
    expect(aplica(9000, sinCampo)).toBe(true);
  });

  it('la descripción sigue mandando: un importe grande sin cobertura no pregunta', () => {
    const otro = { ...hechos(60000), conceptosDescripcion: 'Papelería de oficina' };
    expect(decisionsFor(otro, DEFAULT_THRESHOLDS).some((x) => x.id === 'gasto_vs_anticipado')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// EL AVISO QUE VIAJA CON EL DOCUMENTO
// ══════════════════════════════════════════════════════════════

const ENTITY = { entityId: 'e1', entityRfc: 'XAXX010101000' };
const ROLE_MAP = new Map<string, { code: string; name: string }>([
  ['gasto', { code: '6100', name: 'Gastos Generales' }],
  ['gasto_anticipado', { code: '1160', name: 'Pagos Anticipados' }],
  ['cxp', { code: '2110', name: 'Proveedores' }],
  ['iva_acreditable', { code: '1130', name: 'IVA Acreditable' }],
]);

function cfdi(subtotal: number, descripcion: string): string {
  const iva = Math.round(subtotal * 0.16 * 100) / 100;
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="4.0" Serie="A" Folio="1" Fecha="2026-08-20T12:00:00" FormaPago="03" MetodoPago="PUE"
  TipoDeComprobante="I" Moneda="MXN" SubTotal="${subtotal}" Total="${subtotal + iva}" LugarExpedicion="06600">
  <cfdi:Emisor Rfc="SIN060101AB1" Nombre="Aseguradora SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${ENTITY.entityRfc}" Nombre="Demo Corp MX" UsoCFDI="G03" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="84131500" ClaveUnidad="E48" Descripcion="${descripcion}"
      Cantidad="1" ValorUnitario="${subtotal}" Importe="${subtotal}" ObjetoImp="02">
      <cfdi:Impuestos><cfdi:Traslados>
        <cfdi:Traslado Base="${subtotal}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${iva}"/>
      </cfdi:Traslados></cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="${iva}"/>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"
      FechaTimbrado="2026-08-20T12:05:00" RfcProvCertif="SAT970701NN3" SelloCFD="s" NoCertificadoSAT="30001" SelloSAT="s"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}

const clasificar = (subtotal: number, answers: Record<string, string> = {}) =>
  classifyXml(cfdi(subtotal, 'Póliza de seguro anual de flotilla'), {
    ...ENTITY, roleMap: ROLE_MAP, satStatus: 'vigente', vendorExists: true, periodOpen: true, answers,
  });

describe('el aviso del clasificador: diferir sin calendario no devenga', () => {
  it('manda el importe a la 1160 cuando se elige diferir', () => {
    // La precondición del aviso: si el rol dejara de llegar a la línea, el
    // aviso no se emitiría y esta prueba tiene que caerse primero.
    return clasificar(60000, { gasto_vs_anticipado: 'gasto_anticipado' }).then((c) => {
      const linea = c.lines.find((l) => l.role === 'gasto_anticipado');
      expect(linea?.accountCode).toBe('1160');
      expect(linea?.debit).toBe(60000);
    });
  });

  it('avisa de que NADA lo devenga solo, y nombra las dos hojas', async () => {
    const c = await clasificar(60000, { gasto_vs_anticipado: 'gasto_anticipado' });
    const aviso = c.warnings.find((w) => /prepaid expenses/i.test(w));
    expect(aviso, 'el equivalente del aviso de activo fijo, para el anticipado').toBeDefined();
    expect(aviso).toMatch(/NO schedule accrues it/);
    expect(aviso).toMatch(/prepaid create/);
    expect(aviso).toMatch(/prepaid run/);
    expect(aviso).toMatch(/never reaches the income statement/i);
  });

  it('no avisa cuando el gasto se reconoce completo: no hay nada que devengar', async () => {
    const c = await clasificar(60000, { gasto_vs_anticipado: 'gasto' });
    expect(c.lines.some((l) => l.role === 'gasto_anticipado')).toBe(false);
    expect(c.warnings.some((w) => /prepaid create/.test(w))).toBe(false);
  });

  it('la pregunta llega con el piso dentro del contexto que se enseña', async () => {
    const c = await clasificar(60000);
    const pregunta = c.decisions.find((x) => x.id === 'gasto_vs_anticipado');
    expect(pregunta).toBeDefined();
    expect(pregunta!.context).toMatch(/5,000\.00 MXN/);
    expect(pregunta!.options.map((o) => o.value)).toEqual(['gasto', 'gasto_anticipado']);
  });

  it('por debajo del piso la pregunta ya no se hace', async () => {
    const c = await clasificar(900);
    expect(c.decisions.some((x) => x.id === 'gasto_vs_anticipado')).toBe(false);
  });
});
