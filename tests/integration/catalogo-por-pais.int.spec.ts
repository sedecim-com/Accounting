import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { ensureEntityAccounting } from '../../src/services/accounting/entity-accounting.js';
import { query, withTransaction, closeDatabase } from '../../src/database/connection.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { postInvoiceEntry } from '../../src/services/accounting/ar-ap-posting.js';
import type { Invoice, InvoiceLine } from '../../src/types/index.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';

// ============================================================
// UNA ENTIDAD EXTRANJERA NO NACE CON IVA
//
// `ensureEntityAccounting` sembraba el catálogo base MEXICANO y los diecisiete
// renglones de la taxonomía del CFDI en TODA entidad, sin mirar el país: sólo
// ramificaba al final, y sólo para la nómina. Una sociedad estadounidense
// creada por el asistente —que ofrece «Country [MX/USA]»— nacía con IVA
// Acreditable, IVA Trasladado, IVA Pendiente de Acreditar, IEPS por Pagar,
// Impuestos Locales por Pagar, ISR por Pagar y una cuenta de banco denominada
// en pesos.
//
// Estas pruebas fijan las DOS mitades del arreglo, porque una sola es una
// trampa: es fácil dejar limpia a la entidad extranjera rompiéndole el
// catálogo a la mexicana, que es el 100% de los clientes de este producto.
//
// La prueba que de verdad importa es la última: que la entidad extranjera
// pueda POSTEAR. Quitarle el estrato fiscal mexicano sin dejarle uno neutro la
// habría dejado sin dónde poner el impuesto de su primera factura, y el
// síntoma habría sido MISSING_ROLE_ACCOUNT — el mismo error que toda esta capa
// existió para eliminar.
// ============================================================

let mx: Fixture;
let usa: Fixture;

/** code → name de todo el catálogo de la entidad. */
async function catalogoDe(entityId: string): Promise<Record<string, string>> {
  const { rows } = await query<{ code: string; name: string }>(
    'SELECT code, name FROM accounts WHERE entity_id = $1',
    [entityId]
  );
  return Object.fromEntries(rows.map((r) => [r.code, r.name]));
}

beforeAll(async () => {
  mx = await crearInquilino('Catálogo · entidad mexicana');
  usa = await crearInquilino('Catálogo · entidad extranjera', { pais: 'US' });
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('la entidad mexicana recibe exactamente lo de siempre', () => {
  it('conserva su estrato fiscal completo', async () => {
    const cat = await catalogoDe(mx.entityId);
    expect(cat['1130']).toBe('IVA Acreditable');
    expect(cat['2120']).toBe('IVA Trasladado');
    expect(cat['2130']).toBe('ISR por Pagar');
    expect(cat['2140']).toBe('Retenciones por Pagar');
    expect(cat['1111']).toBe('Banco Nacional - MXN');
  });

  it('conserva las cuentas del CFDI que sólo tienen sentido en México', async () => {
    const cat = await catalogoDe(mx.entityId);
    expect(cat['1135']).toBe('IVA Pendiente de Acreditar');
    expect(cat['2125']).toBe('IVA Trasladado No Cobrado');
    expect(cat['2180']).toBe('IEPS por Pagar');
    expect(cat['2190']).toBe('Impuestos Locales por Pagar');
  });

  it('no recibe el estrato neutro, que es para las otras', async () => {
    const cat = await catalogoDe(mx.entityId);
    for (const code of ['1115', '1136', '2135']) {
      expect(cat[code], `la entidad mexicana no debería tener ${code}`).toBeUndefined();
    }
  });

  it('mantiene los roles fiscales mexicanos mapeados', () => {
    for (const rol of [
      'iva_trasladado', 'iva_acreditable', 'iva_trasladado_no_cobrado',
      'iva_pendiente_acreditar', 'ieps_por_pagar', 'imss_por_pagar',
      'isr_retenido_por_pagar', 'impuestos_locales_por_pagar',
    ]) {
      expect(mx.roles[rol], `falta el rol ${rol}`).toBeTruthy();
    }
  });
});

describe('la entidad extranjera no recibe nada mexicano', () => {
  it('no tiene ninguna cuenta de impuesto mexicano', async () => {
    const cat = await catalogoDe(usa.entityId);
    // Las cuatro del catálogo base y las seis del CFDI.
    for (const code of ['1130', '1135', '1145', '1146', '1165', '2120', '2125', '2130', '2140', '2170', '2180', '2190']) {
      expect(cat[code], `${code} «${cat[code]}» no debería existir en una entidad extranjera`).toBeUndefined();
    }
  });

  it('no tiene una cuenta de banco denominada en pesos', async () => {
    const cat = await catalogoDe(usa.entityId);
    expect(cat['1111']).toBeUndefined();
    expect(cat['1112']).toBeUndefined();
    expect(Object.values(cat).some((n) => /MXN/.test(n))).toBe(false);
  });

  it('recibe el estrato neutro que le permite operar', async () => {
    const cat = await catalogoDe(usa.entityId);
    expect(cat['1115']).toBe('Cuenta Bancaria Operativa');
    expect(cat['1136']).toBe('Impuesto Acreditable sobre Compras');
    expect(cat['2135']).toBe('Impuesto sobre Ventas por Pagar');
  });

  it('conserva el andamiaje universal de partida doble', async () => {
    const cat = await catalogoDe(usa.entityId);
    // Sin estas, catorce roles quedan sin mapear y AR/AP no postea nada.
    for (const code of ['1120', '2110', '1110', '4100', '6100', '1140', '1210', '3200']) {
      expect(cat[code], `falta la cuenta universal ${code}`).toBeTruthy();
    }
  });

  it('conserva las cuentas del CFDI que en realidad son universales', async () => {
    // Anticipos, pagos anticipados, sueldos por pagar y devoluciones no son
    // mexicanos: vivían en la semilla del CFDI por accidente de dónde se
    // escribieron, no por su naturaleza.
    const cat = await catalogoDe(usa.entityId);
    expect(cat['1150']).toBe('Anticipo a Proveedores');
    expect(cat['1160']).toBe('Pagos Anticipados');
    expect(cat['2150']).toBe('Anticipos de Clientes');
    expect(cat['4400']).toBe('Devoluciones y Descuentos sobre Ventas');
    expect(cat['5200']).toBe('Devoluciones y Descuentos sobre Compras');
  });

  it('mapea los roles que AR/AP exige, y ninguno mexicano', () => {
    for (const rol of ['cxc', 'cxp', 'banco', 'ingreso', 'gasto', 'iva_trasladado', 'iva_acreditable']) {
      expect(usa.roles[rol], `falta el rol ${rol}`).toBeTruthy();
    }
    for (const rol of [
      'iva_trasladado_no_cobrado', 'iva_pendiente_acreditar', 'ieps_acreditable',
      'ieps_por_pagar', 'imss_por_pagar', 'isr_retenido_por_pagar',
      'impuestos_locales_por_pagar', 'isr_nomina_por_pagar',
    ]) {
      expect(usa.roles[rol], `el rol ${rol} no debería existir en una entidad extranjera`).toBeFalsy();
    }
  });

  it('manda su impuesto al estrato neutro, no a una cuenta de IVA', async () => {
    const { rows } = await query<{ role: string; code: string; name: string }>(
      `SELECT r.role, a.code, a.name
         FROM account_roles r JOIN accounts a ON a.id = r.account_id
        WHERE r.entity_id = $1 AND r.qualifier IS NULL
          AND r.role IN ('iva_trasladado','iva_acreditable')
        ORDER BY r.role`,
      [usa.entityId]
    );
    expect(rows).toEqual([
      { role: 'iva_acreditable', code: '1136', name: 'Impuesto Acreditable sobre Compras' },
      { role: 'iva_trasladado', code: '2135', name: 'Impuesto sobre Ventas por Pagar' },
    ]);
  });

  it('se declara estadounidense, que es el catálogo que de verdad recibió', async () => {
    // El `country` del resultado se recalculaba con `=== 'USA'` en vez de
    // salir de la misma normalización que escoge el catálogo, y lo que esta
    // columna guarda es 'US' —es CHAR(2), y COUNTRY_PROFILES.USA.iso2 es
    // 'US'—, así que la entidad recibía el catálogo estadounidense correcto y
    // se declaraba mexicana. Salía al mundo: `entity create --json` vuelca el
    // resultado entero.
    //
    // Se re-siembra sobre la entidad ya creada porque `ensureEntityAccounting`
    // es idempotente: no escribe nada nuevo y devuelve el mismo veredicto que
    // devolvió en el alta, leyendo el país de la base y no de un literal.
    const { rows } = await query<{ incorporation_country: string }>(
      'SELECT incorporation_country FROM legal_entities WHERE id = $1',
      [usa.entityId]
    );
    expect(rows[0].incorporation_country.trim()).toBe('US');

    const resultado = await withTransaction((client) =>
      ensureEntityAccounting(usa.entityId, usa.tenantId, usa.userId, { client })
    );
    expect(resultado.nomina.country).toBe('USA');
    expect(resultado.nomina.bucketsAlreadyMapped).toContain('futa_payable');
    expect(resultado.nomina.bucketsAlreadyMapped).not.toContain('imss_payable');
  });

  it('paga la nómina desde su banco, no desde uno en pesos', async () => {
    const { rows } = await query<{ code: string; name: string }>(
      `SELECT a.code, a.name FROM payroll_account_mapping m
         JOIN accounts a ON a.id = m.account_id
        WHERE m.entity_id = $1 AND m.bucket = 'cash_payroll'`,
      [usa.entityId]
    );
    expect(rows).toEqual([{ code: '1115', name: 'Cuenta Bancaria Operativa' }]);
  });
});

describe('la prueba que importa: la entidad extranjera postea', () => {
  it('una factura CON impuesto se contabiliza sin MISSING_ROLE_ACCOUNT', async () => {
    const customerId = uuidv4();
    await query(
      `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type,
        payment_terms, currency_code, created_by)
       VALUES ($1, $2, $3, 'Foreign customer', '12-3456789', 'ein', 'Net 30', 'USD', $4)`,
      [customerId, usa.entityId, `C-US-${customerId.slice(0, 8)}`, usa.userId]
    );

    const invId = uuidv4();
    const fecha = fechaEnPeriodo(3);
    await query(
      `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount,
        total_amount, amount_due, invoice_date, due_date, status, currency_code, created_by)
       VALUES ($1,$2,$3,$4,'1000.00','80.00','1080.00','1080.00',$5,$5,'sent','USD',$6)`,
      [invId, usa.entityId, `INV-US-${invId.slice(0, 8)}`, customerId, fecha, usa.userId]
    );
    // Mismo INSERT que usa la suite de AR/AP: revenue_account_id y
    // total_amount son NOT NULL, así que el renglón trae su cuenta de ingreso
    // y el rol `ingreso` no llega a usarse. Lo que esta prueba persigue es el
    // OTRO renglón, el del impuesto, que sí sale de un rol y es el que
    // reventaba sin estrato fiscal.
    await query(
      `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price,
        revenue_account_id, tax_amount, line_amount, total_amount)
       VALUES ($1,$2,1,'Consulting',1,1000,$3,80,1000,1080)`,
      [uuidv4(), invId, usa.roles.ingreso]
    );

    const { rows: inv } = await query<Invoice>('SELECT * FROM invoices WHERE id = $1', [invId]);
    const { rows: lineas } = await query<InvoiceLine>(
      'SELECT * FROM invoice_lines WHERE invoice_id = $1', [invId]
    );

    const entry = await withTransaction((client) =>
      postInvoiceEntry(client, inv[0], lineas, usa.userId)
    );
    expect(entry).not.toBeNull();

    // El impuesto tiene que haber caído en «Impuesto sobre Ventas por Pagar»,
    // que es el punto entero del estrato neutro.
    const { rows: renglones } = await query<{ code: string; name: string; credit_amount: string }>(
      `SELECT a.code, a.name, jel.credit_amount
         FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id
        WHERE jel.journal_entry_id = $1 AND jel.credit_amount IS NOT NULL
        ORDER BY a.code`,
      [entry!.id]
    );
    const impuesto = renglones.find((r) => r.code === '2135');
    expect(impuesto, 'el impuesto no llegó a la cuenta neutra').toBeTruthy();
    expect(Number(impuesto!.credit_amount)).toBe(80);
    expect(renglones.some((r) => /IVA/.test(r.name))).toBe(false);
  });
});

// ============================================================
// LA RAMA 'ninguno', QUE NINGUNA PRUEBA MIRABA.
//
// La opción decía «On no chart I seed nothing» y la entidad nacía con
// dieciséis cuentas: el interruptor llega al catálogo base y no a las otras dos
// semillas. Al reescribir ese texto se coló una afirmación nueva y también
// falsa —que la entidad nace con «las cuentas que los roles y los buckets de
// nómina necesitan»—, cuando `cash_payroll` es obligatorio y apunta a una
// cuenta que SÓLO crea el catálogo base. Esta prueba existe para que el texto
// del panel no vuelva a poder decir algo que el código desmiente.
//
// La política se resuelve ANTES de crear la entidad a propósito: la siembra es
// idempotente, así que sobre una entidad ya sembrada 'ninguno' llega tarde y no
// se puede observar. Eso mismo le pasa hoy al asistente `init`, que siembra la
// contabilidad de la primera entidad antes de preguntar la política.
// ============================================================
describe("el catálogo 'ninguno' y lo que de verdad deja", () => {
  let base: Fixture;
  const entityId = uuidv4();

  beforeAll(async () => {
    base = await crearInquilino('Catálogo · sin catálogo base', { pais: 'US' });
    await seedPolicies({ tenantId: base.tenantId });
    await resolvePolicy({ tenantId: base.tenantId }, 'catalogo_entidad_no_mexicana', 'ninguno', base.userId);

    const org = await query<{ id: string }>(
      'SELECT organization_id AS id FROM legal_entities WHERE id = $1',
      [base.entityId]
    );
    await query(
      `INSERT INTO legal_entities (id, tenant_id, organization_id, name, entity_type, tax_id, tax_id_type,
        incorporation_country, functional_currency, accounting_standard, fiscal_year_start_month, is_active)
       VALUES ($1, $2, $3, $4, 'corporation', $5, 'ein', 'US', 'USD', 'us_gaap', 1, true)`,
      [entityId, base.tenantId, org.rows[0].id, 'Filial sin catálogo', '99-9999999']
    );
  }, 120_000);

  it('no siembra el catálogo base, pero la entidad NO nace vacía', async () => {
    const r = await withTransaction((client) =>
      ensureEntityAccounting(entityId, base.tenantId, base.userId, { client })
    );
    // La mitad que la palabra «ninguno» promete: cero cuentas del catálogo base.
    expect(r.cuentasBaseCreadas).toEqual([]);
    // Y la mitad que NO promete y el panel ahora sí declara: las otras dos
    // semillas corren igual. Se afirma que HAY, no cuántas: el número es de las
    // semillas y puede crecer sin que el texto mienta.
    expect(r.accountsCreated.length + r.nomina.accountsCreated.length).toBeGreaterThan(0);
  }, 120_000);

  it('deja cash_payroll sin mapear, así que la primera nómina falla igual', async () => {
    // El hecho que el texto del panel afirmaba al revés: cash_payroll es
    // obligatorio (gl-posting-service) y apunta a 1115 en el estrato neutro,
    // que sólo crea el catálogo base — el que 'ninguno' apaga.
    const r = await withTransaction((client) =>
      ensureEntityAccounting(entityId, base.tenantId, base.userId, { client })
    );
    expect(r.nomina.bucketsUnmappable.map((u) => u.bucket)).toContain('cash_payroll');
  }, 120_000);
});
