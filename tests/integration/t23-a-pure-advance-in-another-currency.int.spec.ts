import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { recordCustomerPayment } from '../../src/services/payments/payment-service.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { ValidationError } from '../../src/utils/errors.js';

// ============================================================
// T23 · A PURE ADVANCE IN A CURRENCY THAT IS NOT THE FUNCTIONAL ONE
//
// `recordCustomerPayment` with no applications is a customer advance: there is
// no invoice to take the currency from, so it comes from the customer's own
// `currency_code` — and nothing compared it with the entity's functional
// currency. A USD advance against an MXN entity was written raw and the ledger
// entry recorded the same figure: a thousand dollars booked as a thousand pesos.
//
// The vendor side already refuses the equivalent case, and `accounting.md` says
// the rule out loud for AR: «a foreign-currency invoice REFUSES to post (phase
// 2) rather than record dollars as pesos». The advance is the door where that
// promise was not kept.
//
// Refusing is the whole fix. Converting would mean choosing a rate and a
// source, and that is the firm's decision (`fuente_tipo_cambio`), not a default
// this function gets to invent.
// ============================================================

let fx: Fixture;
let customerMxn: string;
let customerUsd: string;

beforeAll(async () => {
  fx = await crearInquilino('t23-advance');
  customerMxn = uuidv4();
  customerUsd = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'C-T23-MXN', 'Cliente en pesos', 'MXN', $3),
            ($4, $2, 'C-T23-USD', 'Cliente en dólares', 'USD', $3)`,
    [customerMxn, fx.entityId, fx.userId, customerUsd]
  );
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

const advance = (customerId: string, currencyCode?: string) =>
  recordCustomerPayment(
    {
      entityId: fx.entityId,
      counterpartyId: customerId,
      paymentAmount: '1000.00',
      paymentDate: fechaEnPeriodo(5),
      paymentMethod: 'spei',
      applications: [],
      onAccount: true,
      ...(currencyCode ? { currencyCode } : {}),
    },
    fx.userId
  );

describe('un advance puro sin factura que le dé la moneda', () => {
  it('la entidad es MXN: el advance de un cliente en pesos entra', async () => {
    const r = await advance(customerMxn);
    const { rows } = await query<{ currency_code: string; payment_amount: string }>(
      'SELECT currency_code, payment_amount FROM customer_payments WHERE id = $1',
      [r.paymentId]
    );
    expect(rows[0].currency_code).toBe('MXN');
  });

  it('el advance de un cliente en DÓLARES se rehúsa, no se registra como pesos', async () => {
    // EL DEFECTO: la moneda salía de `customers.currency_code` y se escribía
    // cruda, sin compararla nunca con la funcional de la entidad. Mil dólares
    // quedaban asentados como mil pesos, y el asiento cuadraba.
    await expect(advance(customerUsd)).rejects.toThrow(ValidationError);
  });

  it('tampoco se cuela por el parámetro explícito', async () => {
    // La otra puerta: `currencyCode` gana sobre la del cliente, así que un
    // cliente en pesos con el parámetro puesto entraba igual.
    await expect(advance(customerMxn, 'EUR')).rejects.toThrow(ValidationError);
  });

  it('el rechazo dice las dos monedas y por qué no convierte solo', async () => {
    await expect(advance(customerUsd)).rejects.toThrow(/USD/);
    await expect(advance(customerUsd)).rejects.toThrow(/MXN/);
  });

  it('y no deja el cobro a medias: nada se escribió', async () => {
    const rows = await query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM customer_payments WHERE entity_id = $1 AND currency_code <> 'MXN'",
      [fx.entityId]
    );
    expect(rows.rows[0].n).toBe('0');
  });
});
