import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { ValidationError } from '../../src/utils/errors.js';

// ============================================================
// T23b · THE VENDOR ADVANCE HAS A CURRENCY TOO, AND IT WAS HARDCODED
//
// The mirror of T23, found while resealing its manuals: `payables.md` describes
// the vendor advance and nothing guarded it.
//
// It is worse than the customer side was. There the currency at least came from
// the customer; here `monedaDe(documentos)` falls back to a LITERAL:
//
//     function monedaDe(documentos: DocumentoAplicado[]): string {
//       return documentos[0]?.moneda ?? 'MXN';
//     }
//
// With no documents there is no `documentos[0]`, so every pure vendor advance
// was written as MXN — never asking the vendor (whose column defaults to USD),
// never asking the caller, and never asking the entity what it keeps its books
// in. A US entity paying a US vendor an advance recorded pesos.
// ============================================================

let fx: Fixture;
let vendorUsd: string;
let vendorMxn: string;

beforeAll(async () => {
  fx = await crearInquilino('t23b-anticipo-proveedor');
  vendorUsd = uuidv4();
  vendorMxn = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'V-T23B-USD', 'Proveedor en dólares', 'USD', $3),
            ($4, $2, 'V-T23B-MXN', 'Proveedor en pesos', 'MXN', $3)`,
    [vendorUsd, fx.entityId, fx.userId, vendorMxn]
  );
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

const advance = (vendorId: string, currencyCode?: string) =>
  recordVendorPayment(
    {
      entityId: fx.entityId,
      counterpartyId: vendorId,
      paymentAmount: '1000.00',
      paymentDate: fechaEnPeriodo(5),
      paymentMethod: 'spei',
      applications: [],
      onAccount: true,
      ...(currencyCode ? { currencyCode } : {}),
    },
    fx.userId
  );

describe('un anticipo a proveedor sin documento que le dé la moneda', () => {
  it('el del proveedor en la moneda funcional entra, y queda registrado en ella', async () => {
    const r = await advance(vendorMxn);
    const { rows } = await query<{ currency_code: string }>(
      'SELECT currency_code FROM vendor_payments WHERE id = $1',
      [r.paymentId]
    );
    expect(rows[0].currency_code).toBe('MXN');
  });

  it('el del proveedor en DÓLARES se rehúsa: no se asienta como pesos', async () => {
    // EL DEFECTO: la moneda no salía del proveedor ni del parámetro, sino de un
    // literal 'MXN' en el respaldo de `monedaDe`. Mil dólares quedaban asentados
    // como mil pesos sin que nadie preguntara nada.
    await expect(advance(vendorUsd)).rejects.toThrow(ValidationError);
  });

  it('tampoco se cuela por el parámetro explícito', async () => {
    await expect(advance(vendorMxn, 'EUR')).rejects.toThrow(ValidationError);
  });

  it('el rechazo nombra las dos monedas', async () => {
    await expect(advance(vendorUsd)).rejects.toThrow(/USD/);
    await expect(advance(vendorUsd)).rejects.toThrow(/MXN/);
  });
});
