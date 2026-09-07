import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

// ============================================================
// LOS TOPES DE LOTE DE LA INGESTA.
//
// Los dos endpoints de lote de xml-ingestion recorren su arreglo con al menos
// un viaje a la base por elemento, y `bulk` con action:'process' POSTEA AL
// MAYOR en cada vuelta. El freno por petición no ve esa amplificación: una
// sola petición gasta 1 de las 1000 del bucket horario del inquilino y ata un
// worker y el pool durante tantas operaciones en serie como elementos traiga.
// Por eso el tope vive en el ESQUEMA, donde se rechaza antes de tocar nada.
//
// Esta suite existe porque los dos topes son una línea cada uno y nada los
// sostenía: `xml_contents` estaba acotado desde el principio y nadie lo
// probaba, e `ids` nació sin acotar y nadie lo notó hasta que una auditoría lo
// buscó a propósito. Un tope sin prueba se borra en una refactorización sin
// que nadie se entere, y lo que queda es este mismo agujero otra vez.
//
// Se afirma el par completo: en el tope se pasa, uno por encima se rechaza.
// Sólo la mitad de arriba dejaría pasar un tope de cero.
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  withTransaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) })
  ),
  withTenant: vi.fn(async (_t: string, fn: () => Promise<unknown>) => fn()),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
  getClient: vi.fn(),
  setTenantSchema: vi.fn(),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  getPool: vi.fn(),
}));

import xmlIngestionRouter from '../../../src/api/rest/routes/xml-ingestion.js';
import bankReconciliationRouter from '../../../src/api/rest/routes/bank-reconciliation.js';
import journalEntriesRouter from '../../../src/api/rest/routes/journal-entries.js';
import invoicesRouter from '../../../src/api/rest/routes/invoices.js';
import billsRouter from '../../../src/api/rest/routes/bills.js';
import { errorHandler } from '../../../src/api/rest/middleware/error-handler.js';
import {
  MAX_APLICACIONES_POR_PAGO,
  MAX_MOVIMIENTOS_POR_IMPORTACION,
  MAX_RENGLONES_POR_DOCUMENTO,
} from '../../../src/api/rest/topes.js';

/** El tope que declara xml-ingestion.ts para AMBOS lotes. */
const TOPE = 100;

/** La entidad del token. UUID de verdad: media API la valida como tal. */
const ENTIDAD = '11111111-1111-4111-8111-111111111111';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // Sustituye a `authenticate` con un operador comodín: así todo rechazo que
  // observemos viene del esquema, no de la puerta de permisos.
  app.use((req, _res, next) => {
    req.user = {
      user_id: 'u-1',
      tenant_id: 't-1',
      entities: [ENTIDAD],
      permissions: ['*'],
    } as never;
    req.tenantId = 't-1';
    req.entityId = ENTIDAD;
    next();
  });

  app.use('/v1', xmlIngestionRouter);
  app.use('/v1/bank-accounts', bankReconciliationRouter);
  app.use('/v1/journal-entries', journalEntriesRouter);
  app.use('/v1/invoices', invoicesRouter);
  app.use('/v1/bills', billsRouter);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function postear(path: string, body: unknown): Promise<number> {
  return (await postearCon(path, body)).status;
}

/** Como `postear`, pero devuelve además el cuerpo: el mensaje del rechazo importa. */
async function postearCon(
  path: string,
  body: unknown
): Promise<{ status: number; texto: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, texto: await res.text() };
}

const idsDe = (n: number): string[] => Array.from({ length: n }, () => randomUUID());
const xmlsDe = (n: number): string[] => Array.from({ length: n }, (_, i) => `<x>${i}</x>`);

describe('los lotes de la ingesta están acotados en el esquema', () => {
  it(`bulk rechaza ${TOPE + 1} ids`, async () => {
    // El caso del hallazgo: sin tope, un lote de cientos de miles de ids
    // atravesaba la validación y el manejador los recorría uno a uno.
    expect(await postear('/v1/pre-registrations/bulk', { action: 'approve', ids: idsDe(TOPE + 1) })).toBe(422);
  });

  it(`bulk acepta ${TOPE} ids: el tope no está por debajo de lo que promete`, async () => {
    // No se afirma 2xx —el manejador habla con una base simulada—, sino que el
    // ESQUEMA no lo rechaza: un tope de cero también haría pasar la prueba de
    // arriba, y sería otra forma de romper el endpoint.
    expect(await postear('/v1/pre-registrations/bulk', { action: 'approve', ids: idsDe(TOPE) })).not.toBe(422);
  });

  it('bulk sigue exigiendo al menos un id', async () => {
    expect(await postear('/v1/pre-registrations/bulk', { action: 'approve', ids: [] })).toBe(422);
  });

  it(`upload rechaza ${TOPE + 1} xml, y acepta ${TOPE}`, async () => {
    // El tope hermano, el que sí existía y tampoco tenía quien lo sostuviera.
    expect(await postear('/v1/upload', { xml_contents: xmlsDe(TOPE + 1) })).toBe(422);
    expect(await postear('/v1/upload', { xml_contents: xmlsDe(TOPE) })).not.toBe(422);
  });
});

// ============================================================
// LOS ARREGLOS HERMANOS, QUE SEGUÍAN SIN TOPE.
//
// Los dos de arriba se acotaron y ahí se quedó el trabajo. La auditoría de
// G4a encontró cuatro más con la MISMA forma —recorrer el arreglo con al
// menos un viaje a la base por elemento— y ninguno acotado:
//
//   · `transactions` en POST /v1/bank-accounts/:id/import. El peor: DOS
//     viajes por movimiento, en serie, y sin transacción que los agrupe.
//   · `lines` en póliza, factura y factura de proveedor. Un INSERT por
//     renglón DENTRO de la transacción que crea el documento, con el
//     periodo fiscal bloqueado mientras dura.
//   · `applications` en POST /v1/bills/payments, que además es una ruta
//     IRREVERSIBLE: cada aplicación mueve `amount_due` y entra en la póliza.
//
// Se afirma el par completo, como arriba, pero con una medida más fina que
// el código de estado: en el tope, el rechazo QUE NO OCURRE es el del tope.
// Estas cuatro rutas contestan 422 por muchas otras razones legítimas
// contra una base simulada —«no hay periodo abierto», «las aplicaciones no
// suman el pago»—, así que un `not.toBe(422)` mediría cualquier cosa menos
// el tope. Lo que se mira es si el mensaje del tope aparece.
// ============================================================

/** El final del mensaje que arma `arregloAcotado`. Sólo lo dice el tope. */
const FRASE_DEL_TOPE = 'por petición.';

const movimientosDe = (n: number): unknown[] =>
  Array.from({ length: n }, (_, i) => ({
    bank_transaction_id: `T-${i}`,
    transaction_date: '2026-01-15',
    amount: '100.00',
    description: `movimiento ${i}`,
  }));

const renglonesDe = (n: number, campos: (i: number) => Record<string, unknown>): unknown[] =>
  Array.from({ length: n }, (_, i) => campos(i));

/** Rechazado POR EL TOPE: 422, y el mensaje nombra cuántos llegaron y cuántos caben. */
async function rechazaPorTope(path: string, body: unknown, llegaron: number, caben: number): Promise<void> {
  const r = await postearCon(path, body);
  expect(r.status).toBe(422);
  expect(r.texto).toContain(`llegaron ${llegaron}`);
  expect(r.texto).toContain(`caben ${caben} ${FRASE_DEL_TOPE}`);
}

/** El tope NO es lo que rechaza: pase lo que pase después, no fue por longitud. */
async function elTopeNoRechaza(path: string, body: unknown): Promise<void> {
  const r = await postearCon(path, body);
  expect(r.texto, 'el tope está por debajo de lo que promete').not.toContain(FRASE_DEL_TOPE);
}

describe('los arreglos que multiplican viajes a la base están acotados', () => {
  const importacion = (n: number): unknown => ({ transactions: movimientosDe(n) });
  const rutaImport = `/v1/bank-accounts/${randomUUID()}/import`;

  it(`el extracto bancario rechaza ${MAX_MOVIMIENTOS_POR_IMPORTACION + 1} movimientos, y dice adónde ir`, async () => {
    await rechazaPorTope(
      rutaImport,
      importacion(MAX_MOVIMIENTOS_POR_IMPORTACION + 1),
      MAX_MOVIMIENTOS_POR_IMPORTACION + 1,
      MAX_MOVIMIENTOS_POR_IMPORTACION
    );
    // El rechazo no deja al operador sin salida: nombra el camino que sí
    // lotea la escritura.
    expect((await postearCon(rutaImport, importacion(MAX_MOVIMIENTOS_POR_IMPORTACION + 1))).texto)
      .toContain('bank import');
  });

  it(`el extracto bancario acepta ${MAX_MOVIMIENTOS_POR_IMPORTACION}`, async () => {
    await elTopeNoRechaza(rutaImport, importacion(MAX_MOVIMIENTOS_POR_IMPORTACION));
  });

  it('el extracto bancario sigue exigiendo al menos un movimiento', async () => {
    // El mínimo tenía que sobrevivir al cambio: `superRefine` devuelve un
    // ZodEffects sin `.min()`, así que se pasa por dentro de `arregloAcotado`.
    expect(await postear(rutaImport, { transactions: [] })).toBe(422);
  });

  const poliza = (n: number): unknown => {
    const cuenta = randomUUID();
    return {
      entity_id: ENTIDAD,
      entry_date: '2026-01-15',
      lines: renglonesDe(n, (i) =>
        i % 2 === 0
          ? { account_id: cuenta, debit_amount: '1.00' }
          : { account_id: cuenta, credit_amount: '1.00' }
      ),
    };
  };

  it(`una póliza rechaza ${MAX_RENGLONES_POR_DOCUMENTO + 1} renglones y acepta ${MAX_RENGLONES_POR_DOCUMENTO}`, async () => {
    await rechazaPorTope(
      '/v1/journal-entries',
      poliza(MAX_RENGLONES_POR_DOCUMENTO + 1),
      MAX_RENGLONES_POR_DOCUMENTO + 1,
      MAX_RENGLONES_POR_DOCUMENTO
    );
    await elTopeNoRechaza('/v1/journal-entries', poliza(MAX_RENGLONES_POR_DOCUMENTO));
  });

  it('una póliza sigue exigiendo dos renglones', async () => {
    const r = await postearCon('/v1/journal-entries', {
      entity_id: ENTIDAD,
      entry_date: '2026-01-15',
      lines: [{ account_id: randomUUID(), debit_amount: '1.00' }],
    });
    expect(r.status).toBe(422);
    expect(r.texto).toContain('At least 2 lines required');
  });

  const factura = (n: number): unknown => ({
    entity_id: ENTIDAD,
    customer_id: randomUUID(),
    invoice_date: '2026-01-15',
    due_date: '2026-02-15',
    lines: renglonesDe(n, () => ({ unit_price: '10.00', revenue_account_id: randomUUID() })),
  });

  it(`una factura rechaza ${MAX_RENGLONES_POR_DOCUMENTO + 1} renglones y acepta ${MAX_RENGLONES_POR_DOCUMENTO}`, async () => {
    await rechazaPorTope(
      '/v1/invoices',
      factura(MAX_RENGLONES_POR_DOCUMENTO + 1),
      MAX_RENGLONES_POR_DOCUMENTO + 1,
      MAX_RENGLONES_POR_DOCUMENTO
    );
    await elTopeNoRechaza('/v1/invoices', factura(MAX_RENGLONES_POR_DOCUMENTO));
  });

  const comprobante = (n: number): unknown => ({
    entity_id: ENTIDAD,
    vendor_id: randomUUID(),
    bill_date: '2026-01-15',
    due_date: '2026-02-15',
    lines: renglonesDe(n, () => ({ account_id: randomUUID(), unit_price: '10.00' })),
  });

  it(`una factura de proveedor rechaza ${MAX_RENGLONES_POR_DOCUMENTO + 1} renglones y acepta ${MAX_RENGLONES_POR_DOCUMENTO}`, async () => {
    await rechazaPorTope(
      '/v1/bills',
      comprobante(MAX_RENGLONES_POR_DOCUMENTO + 1),
      MAX_RENGLONES_POR_DOCUMENTO + 1,
      MAX_RENGLONES_POR_DOCUMENTO
    );
    await elTopeNoRechaza('/v1/bills', comprobante(MAX_RENGLONES_POR_DOCUMENTO));
  });

  const pago = (n: number): unknown => ({
    entity_id: ENTIDAD,
    vendor_id: randomUUID(),
    payment_amount: String(n),
    payment_method: 'transfer',
    payment_date: '2026-01-15',
    applications: renglonesDe(n, () => ({ bill_id: randomUUID(), amount_applied: '1.00' })),
  });

  it(`un pago rechaza ${MAX_APLICACIONES_POR_PAGO + 1} aplicaciones y acepta ${MAX_APLICACIONES_POR_PAGO}`, async () => {
    await rechazaPorTope(
      '/v1/bills/payments',
      pago(MAX_APLICACIONES_POR_PAGO + 1),
      MAX_APLICACIONES_POR_PAGO + 1,
      MAX_APLICACIONES_POR_PAGO
    );
    await elTopeNoRechaza('/v1/bills/payments', pago(MAX_APLICACIONES_POR_PAGO));
  });
});
