import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import {
  createJournalEntry,
  drainAttestations,
  voidJournalEntry,
} from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { setAccountRole } from '../../src/services/accounting/account-roles-service.js';
import { arReconcile } from '../../src/services/ar/ar-controls.js';
import { voidInvoice } from '../../src/services/ar/invoice-service.js';
import { recordCustomerPayment, recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { apReconcile } from '../../src/services/ap/ap-controls.js';
import { prepareOpeningBills } from '../../src/services/ap/opening-bills.js';
import { importSatChart } from '../../src/services/accounting/sat-chart-import.js';
import {
  checkOpeningBalance,
  importOpeningBalance,
  type OpeningDocument,
  type OpeningBalanceReport,
} from '../../src/services/accounting/opening-balance.js';
import {
  compareToSource,
  renderBalanceComparison,
  shapesFromRows,
} from '../../src/services/accounting/opening-balance-check.js';
import { readBalanzaComprobacion } from '../../src/services/sat/anexo24/balance-reader.js';
import { generarBalanza } from '../../src/services/sat/anexo24/balanza-service.js';
import { construirDiot } from '../../src/services/sat/diot/diot-service.js';

// ============================================================
// O1 · LA BALANZA DE APERTURA, MEDIDA CONTRA POSTGRES
//
// LA PRUEBA QUE CIERRA EL TRAMO está en el bloque 4: se toma el XML de balanza
// del sistema viejo, se carga, se genera la balanza de ESTE sistema con
// `balanza-service` y se comparan CUENTA POR CUENTA. Iguales al peso, o la
// prueba falla nombrando la cuenta que difiere y en cuánto.
//
// Lo que las unitarias no pueden probar y esto sí:
//   · que el asiento lo ACEPTE el mayor de verdad —el CHECK de cuadre, el
//     periodo fiscal, `validateJournalEntry`, el disparador de saldos—;
//   · que la balanza que sale de `getTrialBalance` sobre ese mayor sea la del
//     archivo de origen, que es la afirmación entera de este tramo;
//   · que un saldo de CxC AGREGADO rompe `ar reconcile` — el daño que
//     justifica la negativa se MIDE aquí en vez de afirmarse.
//
// EL EJERCICIO. Una migración pequeña y completa: bancos, clientes con dos
// facturas abiertas, activo fijo con su depreciación acumulada colgando del
// MISMO padre —que es la trampa del signo—, proveedores con dos facturas,
// impuestos, capital y un resultado ya llevado a ejercicios anteriores.
//
//   ACTIVO      102-001 Banco           50 000 D
//               105-001 Clientes        12 000 D   (A-123 4 000 + A-456 8 000)
//               153-001 Torno          200 000 D
//               171     Depreciación    30 000 A
//               → 100 Activo           232 000 D
//   PASIVO      201-001 Proveedores     14 000 A   (F-77 9 000 + F-88 5 000)
//               213     Impuestos        3 000 A
//               → 200 Pasivo            17 000 A
//   CAPITAL     301     Capital social 100 000 A
//               304     Resultado ant. 115 000 A
//               → 300 Capital          215 000 A
//
// 232 000 = 17 000 + 215 000. El asiento cuadra solo, sin cuenta puente.
//
// Corre como superusuario a propósito: RLS queda inerte y lo que se comprueba
// es la frontera del CÓDIGO (ver frontera-entidad-ten).
// ============================================================

let f: Fixture;
let hermana: Fixture;

const RFC = 'XAXX010101000';
const NS_CAT = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas';
const NS_BAL = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion';

interface CuentaDelCliente {
  num: string;
  desc: string;
  padre?: string;
  agrup: string;
  nivel: number;
  natur: 'D' | 'A';
  /** SaldoFin al 31 de diciembre de 2025, en la naturaleza de la cuenta. */
  saldo: string;
}

/** El catálogo del despacho, con SUS códigos y su jerarquía. */
const CATALOGO: CuentaDelCliente[] = [
  { num: '100', desc: 'Activo', agrup: '100', nivel: 1, natur: 'D', saldo: '232000.00' },
  { num: '102', desc: 'Bancos', padre: '100', agrup: '102', nivel: 2, natur: 'D', saldo: '50000.00' },
  { num: '102-001', desc: 'Banco del Bajío', padre: '102', agrup: '102.01', nivel: 3, natur: 'D', saldo: '50000.00' },
  { num: '105', desc: 'Clientes', padre: '100', agrup: '105', nivel: 2, natur: 'D', saldo: '12000.00' },
  { num: '105-001', desc: 'Clientes nacionales', padre: '105', agrup: '105.01', nivel: 3, natur: 'D', saldo: '12000.00' },
  { num: '153', desc: 'Maquinaria y equipo', padre: '100', agrup: '153', nivel: 2, natur: 'D', saldo: '200000.00' },
  { num: '153-001', desc: 'Torno CNC', padre: '153', agrup: '153.01', nivel: 3, natur: 'D', saldo: '200000.00' },
  { num: '171', desc: 'Depreciación acumulada', padre: '100', agrup: '171', nivel: 2, natur: 'A', saldo: '30000.00' },
  { num: '200', desc: 'Pasivo', agrup: '200', nivel: 1, natur: 'A', saldo: '17000.00' },
  { num: '201', desc: 'Proveedores', padre: '200', agrup: '201', nivel: 2, natur: 'A', saldo: '14000.00' },
  { num: '201-001', desc: 'Proveedores nacionales', padre: '201', agrup: '201.01', nivel: 3, natur: 'A', saldo: '14000.00' },
  { num: '213', desc: 'Impuestos por pagar', padre: '200', agrup: '213', nivel: 2, natur: 'A', saldo: '3000.00' },
  { num: '300', desc: 'Capital contable', agrup: '300', nivel: 1, natur: 'A', saldo: '215000.00' },
  { num: '301', desc: 'Capital social', padre: '300', agrup: '301', nivel: 2, natur: 'A', saldo: '100000.00' },
  { num: '304', desc: 'Resultado de ejercicios anteriores', padre: '300', agrup: '304', nivel: 2, natur: 'A', saldo: '115000.00' },
  // El ejercicio se cerró en el origen: las de resultado vienen en ceros, que
  // es exactamente lo que la carga exige para no contar dos veces el año viejo.
  { num: '400', desc: 'Ingresos', agrup: '400', nivel: 1, natur: 'A', saldo: '0.00' },
  { num: '401', desc: 'Ventas', padre: '400', agrup: '401', nivel: 2, natur: 'A', saldo: '0.00' },
];

const catalogXml = (chart: CuentaDelCliente[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<catalogocuentas:Catalogo xmlns:catalogocuentas="${NS_CAT}" Version="1.3" RFC="${RFC}" Mes="12" Anio="2025">` +
  chart.map(
    (c) =>
      `<catalogocuentas:Ctas CodAgrup="${c.agrup}" NumCta="${c.num}" Desc="${c.desc}"` +
      `${c.padre === undefined ? '' : ` SubCtaDe="${c.padre}"`} Nivel="${c.nivel}" Natur="${c.natur}"/>`
  ).join('') +
  `</catalogocuentas:Catalogo>`;
const XML_CATALOGO = catalogXml(CATALOGO);

/**
 * La balanza del sistema viejo al 31 de diciembre. SaldoIni = SaldoFin y sin
 * movimiento: lo que la apertura consume es el SaldoFin, y así el recálculo
 * del lector cuadra sin inventar un ejercicio entero de asientos.
 */
function balanzaDeOrigen(saldos: Record<string, string> = {}, chart: CuentaDelCliente[] = CATALOGO): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<BCE:Balanza xmlns:BCE="${NS_BAL}" Version="1.3" RFC="${RFC}" Mes="12" Anio="2025" TipoEnvio="N">` +
    chart.map((c) => {
      const s = saldos[c.num] ?? c.saldo;
      return `<BCE:Ctas NumCta="${c.num}" SaldoIni="${s}" Debe="0.00" Haber="0.00" SaldoFin="${s}"/>`;
    }).join('') +
    `</BCE:Balanza>`
  );
}

const AUXILIAR: OpeningDocument[] = [
  { cuenta: '105-001', documento: 'A-123', contraparte: 'Aceros del Norte SA', fecha: '2025-11-02', vencimiento: '2025-12-02', importe: '4000.00' },
  { cuenta: '105-001', documento: 'A-456', contraparte: 'Bravo Servicios SC', fecha: '2025-11-20', vencimiento: '2026-01-19', importe: '8000.00' },
  { cuenta: '201-001', documento: 'F-77', contraparte: 'Papelera del Centro', fecha: '2025-12-01', vencimiento: '2026-01-15', importe: '9000.00', ivaRate: '0' },
  { cuenta: '201-001', documento: 'F-88', contraparte: 'Tornillos Industriales', fecha: '2025-12-10', vencimiento: '2026-01-24', importe: '5000.00', ivaRate: '0' },
];

const ctxDe = (fx: Fixture) => ({ tenantId: fx.tenantId, entityId: fx.entityId });

/**
 * MNE-001-022/023: the seeded `cxc` and `cxp` roles point at the seeded
 * chart, so a migration points them at the imported control accounts BEFORE
 * the opening. Otherwise the load stops (APE-CXC-OTRA-CUENTA,
 * APE-CXP-OTRA-CUENTA): collections and payments would move one account
 * while the migrated balance sits in another.
 */
async function pointControlRolesAtMigratedAccounts(fx: Fixture): Promise<void> {
  for (const [role, code] of [['cxc', '105-001'], ['cxp', '201-001']] as const) {
    const account = await query<{ id: string }>(
      `SELECT id FROM accounts WHERE entity_id = $1 AND code = $2`,
      [fx.entityId, code]
    );
    await setAccountRole(fx.entityId, fx.tenantId, role, account.rows[0].id, {
      userId: fx.userId,
      notes: 'la cuenta de control del catálogo migrado',
    });
  }
}

/** Las cuentas de la entidad con lo que el cotejo necesita del árbol. */
async function formaDelPlan(entityId: string) {
  const r = await query<{ code: string; parent_code: string | null; normal_balance: string }>(
    `SELECT a.code, p.code AS parent_code, a.normal_balance
       FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
      WHERE a.entity_id = $1`,
    [entityId]
  );
  return shapesFromRows(r.rows);
}

beforeAll(async () => {
  f = await crearInquilino('O1 balanza de apertura');
  enterTenant(f.tenantId);
  hermana = await crearEntidadHermana(f, 'O1 la que carga el agregado');
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

// ============================================================
// 1 · LA CAPA 1 DEJA EL CATÁLOGO PUESTO
// ============================================================

describe('el catálogo del despacho entra con SUS códigos', () => {
  it('las diecisiete cuentas se crean con su jerarquía y su naturaleza', async () => {
    const r = await importSatChart(ctxDe(f), {
      entityId: f.entityId,
      xml: XML_CATALOGO,
      userId: f.userId,
      reason: 'migración O1',
    });
    expect(r.escrito).toBe(true);
    expect(r.creadas).toHaveLength(CATALOGO.length);

    // El código entra TAL CUAL: el guion de «102-001» es del cliente.
    const cuentas = await query<{ code: string; account_type: string; normal_balance: string; nivel: number }>(
      `SELECT code, account_type, normal_balance, account_level AS nivel
         FROM accounts WHERE entity_id = $1 AND code LIKE '1%-001'
        ORDER BY code`,
      [f.entityId]
    );
    expect(cuentas.rows.map((c) => c.code)).toEqual(['102-001', '105-001', '153-001']);
    // 171 con Natur="A" bajo un rubro de activo es una CONTRACUENTA, y el
    // esquema tiene la casilla exacta.
    const dep = await query<{ account_type: string; account_level: number }>(
      `SELECT account_type, account_level FROM accounts WHERE entity_id = $1 AND code = '171'`,
      [f.entityId]
    );
    expect(dep.rows[0]).toEqual({ account_type: 'contra_asset', account_level: 2 });
  });
});

// ============================================================
// 2 · LA NEGATIVA A CARGAR CxC AGREGADA, Y EL DAÑO QUE EVITA
// ============================================================

describe('CxC y CxP: documento a documento, jamás agregados', () => {
  it('sin el auxiliar NO SE ESCRIBE NADA, y se nombran las dos cuentas', async () => {
    const r = await importOpeningBalance(ctxDe(f), {
      entityId: f.entityId,
      xml: balanzaDeOrigen(),
      userId: f.userId,
    });
    expect(r.escrito).toBe(false);
    const reglas = r.findings.map((x) => x.regla);
    expect(reglas).toContain('APE-CXC-AGREGADA');
    expect(reglas).toContain('APE-CXP-AGREGADA');
    expect(r.findings.find((x) => x.regla === 'APE-CXC-AGREGADA')?.numCta).toBe('105-001');

    // Y NADA quedó en el mayor: todo o nada no es una intención, es el estado.
    const asientos = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1`,
      [f.entityId]
    );
    expect(asientos.rows[0].n).toBe('0');
  });

  it('EL DAÑO, MEDIDO: el agregado deja «ar reconcile» descuadrado por su importe', async () => {
    // Se hace en una entidad HERMANA para no ensuciar la migración de arriba.
    // Es el asiento que esta capa se niega a escribir: un solo renglón de
    // 12 000 contra la cuenta de control, sin un documento detrás.
    await importSatChart(ctxDe(hermana), {
      entityId: hermana.entityId,
      xml: XML_CATALOGO,
      userId: hermana.userId,
    });
    const ids = Object.fromEntries(
      (
        await query<{ code: string; id: string }>(
          `SELECT code, id FROM accounts WHERE entity_id = $1 AND code IN ('105-001', '304')`,
          [hermana.entityId]
        )
      ).rows.map((x) => [x.code, x.id])
    );
    await setAccountRole(hermana.entityId, hermana.tenantId, 'cxc', ids['105-001'], {
      userId: hermana.userId,
      notes: 'la cuenta de clientes del catálogo importado',
    });

    await createJournalEntry(
      hermana.entityId,
      new Date('2026-01-01T00:00:00'),
      JournalEntryType.ADJUSTING,
      'Apertura AGREGADA — lo que este tramo se niega a escribir',
      [
        { account_id: ids['105-001'], debit_amount: '12000.0000', credit_amount: null, description: 'Clientes (total)' },
        { account_id: ids['304'], debit_amount: null, credit_amount: '12000.0000', description: 'Contrapartida' },
      ],
      hermana.userId,
      { autoPost: true }
    );

    const conciliacion = await arReconcile(hermana.entityId);
    expect(conciliacion.control_account?.code).toBe('105-001');
    expect(conciliacion.control_balance).toBe('12000.00');
    // El auxiliar está VACÍO: no hay ni una factura que cobrar.
    expect(conciliacion.subledger_net).toBe('0.00');
    expect(conciliacion.balanced).toBe(false);
    expect(conciliacion.delta).toBe('12000.00');
    // Y sale listado como asiento manual sobre el control, que es «la causa
    // número uno de un descuadre que nadie encuentra».
    expect(conciliacion.manual_entries).toHaveLength(1);
    expect(conciliacion.manual_entries[0].amount).toBe('12000.00');
  });
});

// ============================================================
// 3 · LA CARGA, CON EL AUXILIAR
// ============================================================

describe('la apertura se carga al primer día del ejercicio', () => {
  it('un asiento de AJUSTE, al 1 de enero, con su source_type y cuadrado', async () => {
    await pointControlRolesAtMigratedAccounts(f);
    const r = await importOpeningBalance(ctxDe(f), {
      entityId: f.entityId,
      xml: balanzaDeOrigen(),
      userId: f.userId,
      documentos: AUXILIAR,
      reason: 'migración desde el sistema anterior',
    });
    expect(r.findings.filter((x) => x.severidad === 'bloquea')).toEqual([]);
    expect(r.escrito).toBe(true);
    expect(r.fecha).toBe('2026-01-01');
    expect(r.totalDebe).toBe(r.totalHaber);

    const asiento = await query<{
      entry_type: string; source_type: string; status: string;
      entry_date: string; total_debits: string; total_credits: string; reference: string;
    }>(
      `SELECT entry_type, source_type, status, entry_date::text AS entry_date,
              total_debits::text AS total_debits, total_credits::text AS total_credits, reference
         FROM journal_entries WHERE entity_id = $1`,
      [f.entityId]
    );
    expect(asiento.rows).toHaveLength(1);
    expect(asiento.rows[0]).toMatchObject({
      entry_type: 'adjusting',
      source_type: 'opening_balance',
      status: 'posted',
      entry_date: '2026-01-01',
      reference: `${RFC}202512B`,
    });
    expect(asiento.rows[0].total_debits).toBe(asiento.rows[0].total_credits);
    expect(asiento.rows[0].total_debits).toBe('262000.0000');
  });

  it('CxC y CxP quedan DOCUMENTO A DOCUMENTO en el mayor, con folio y contraparte', async () => {
    const renglones = await query<{ code: string; debit: string | null; credit: string | null; description: string }>(
      `SELECT a.code, jel.debit_amount::text AS debit, jel.credit_amount::text AS credit, jel.description
         FROM journal_entry_lines jel
         JOIN accounts a ON a.id = jel.account_id
         JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.entity_id = $1 AND a.code IN ('105-001', '201-001')
        ORDER BY jel.line_number`,
      [f.entityId]
    );
    expect(renglones.rows.map((x) => [x.code, x.debit ?? x.credit])).toEqual([
      ['105-001', '4000.0000'],
      ['105-001', '8000.0000'],
      ['201-001', '9000.0000'],
      ['201-001', '5000.0000'],
    ]);
    expect(renglones.rows[0].description).toContain('A-123');
    expect(renglones.rows[0].description).toContain('Aceros del Norte SA');
    expect(renglones.rows[0].description).toContain('vence 2025-12-02');
    expect(renglones.rows[3].description).toContain('F-88');
  });

  it('las cuentas de mayor NO reciben renglón: el dinero no se cuenta dos veces', async () => {
    const cuentasConRenglon = await query<{ code: string }>(
      `SELECT DISTINCT a.code
         FROM journal_entry_lines jel
         JOIN accounts a ON a.id = jel.account_id
         JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.entity_id = $1 ORDER BY a.code`,
      [f.entityId]
    );
    // Ni 100, ni 102, ni 105, ni 153, ni 200, ni 201, ni 300, ni 400.
    expect(cuentasConRenglon.rows.map((x) => x.code)).toEqual([
      '102-001', '105-001', '153-001', '171', '201-001', '213', '301', '304',
    ]);
  });

  it('deja rastro de la carga, con el archivo de origen y el número de documentos', async () => {
    const rastro = await query<{ entity_type: string; new_values: Record<string, unknown>; reason: string }>(
      `SELECT entity_type, new_values, reason FROM audit_log
        WHERE tenant_id = $1 AND entity_type = 'opening_balance'`,
      [f.tenantId]
    );
    expect(rastro.rows).toHaveLength(1);
    expect(rastro.rows[0].new_values).toMatchObject({
      fiscal_year: 2026,
      entry_date: '2026-01-01',
      origen: 'xml-sat:BalanzaComprobacion:2025-12',
      documentos_de_auxiliar: 4,
    });
    expect(rastro.rows[0].reason).toBe('migración desde el sistema anterior');
  });

  it('correrla otra vez NO duplica los saldos', async () => {
    const r = await importOpeningBalance(ctxDe(f), {
      entityId: f.entityId,
      xml: balanzaDeOrigen(),
      userId: f.userId,
      documentos: AUXILIAR,
    });
    expect(r.escrito).toBe(false);
    expect(r.findings.map((x) => x.regla)).toContain('APE-YA-CARGADA');
    const asientos = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1`,
      [f.entityId]
    );
    expect(asientos.rows[0].n).toBe('1');
  });

  it('la balanza de JUNIO no abre nada: no hay ejercicio que empiece el 1 de julio', async () => {
    const juniera = balanzaDeOrigen().replace('Mes="12"', 'Mes="06"');
    await expect(
      importOpeningBalance(ctxDe(f), { entityId: f.entityId, xml: juniera, userId: f.userId })
    ).rejects.toThrow(/2025-07-01/);
  });

  it('la balanza de OTRA entidad del mismo inquilino no cruza la frontera', async () => {
    // La hermana ya tiene su propia apertura agregada; lo que se comprueba es
    // que el id de entidad manda y que el inquilino acota dentro del SQL.
    await expect(
      importOpeningBalance(
        { tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', entityId: f.entityId },
        { entityId: f.entityId, xml: balanzaDeOrigen(), userId: f.userId }
      )
    ).rejects.toThrow(/no existe en este inquilino/);
  });
});

// ============================================================
// 4 · LA PRUEBA QUE CIERRA EL TRAMO: IGUALES AL PESO
// ============================================================

// ============================================================
// LA CARRERA · DOS CARGAS A LA VEZ (WIT-01 de #217)
// ============================================================

describe('dos aperturas concurrentes de la misma entidad', () => {
  it('sólo UNA escribe: la otra recibe informe, no excepción, y los saldos no se duplican', async () => {
    // La comprobación previa de `importOpeningBalance` vive FUERA de la
    // transacción que postea, así que entre ella y el INSERT cabe otra corrida
    // entera: las dos verían cero filas, las dos postearían, y los saldos de
    // apertura quedarían DUPLICADOS de una sola vez. Una apertura mueve el
    // balance entero; no puede depender de una ventana TOCTOU.
    //
    // Una entidad PROPIA, para no arrastrar lo que cargaron las pruebas de
    // arriba y poder afirmar sobre el libro entero.
    const solo = await crearEntidadHermana(f, 'O1 la carrera de la apertura');
    await importSatChart(ctxDe(solo), {
      entityId: solo.entityId,
      xml: XML_CATALOGO,
      userId: solo.userId,
      reason: 'migración O1 · carrera',
    });
    await pointControlRolesAtMigratedAccounts(solo);

    const cargar = (): Promise<OpeningBalanceReport> =>
      importOpeningBalance(ctxDe(solo), {
        entityId: solo.entityId,
        xml: balanzaDeOrigen(),
        userId: solo.userId,
        documentos: AUXILIAR,
      });

    // A LA VEZ, no una detrás de otra: en serie la comprobación previa basta y
    // la prueba pasaría con el defecto puesto.
    const [a, b] = await Promise.allSettled([cargar(), cargar()]);

    // NINGUNA revienta con una excepción de Postgres: la que pierde la carrera
    // recibe un informe que dice qué pasó.
    for (const r of [a, b]) {
      expect(
        r.status,
        `una de las dos cargas lanzó en vez de informar: ${
          r.status === 'rejected' ? String((r.reason as Error).message) : ''
        }`
      ).toBe('fulfilled');
    }
    const informes = [a, b]
      .filter((r): r is PromiseFulfilledResult<OpeningBalanceReport> => r.status === 'fulfilled')
      .map((r) => r.value);

    // Exactamente una escribió.
    const escritas = informes.filter((i) => i.escrito);
    expect(escritas.length, 'las dos cargas escribieron, o ninguna lo hizo').toBe(1);

    // Y la que no, lo NOMBRA: un `escrito: false` mudo no le dice al operador
    // si su apertura entró o se perdió.
    const perdedora = informes.find((i) => !i.escrito);
    expect(
      perdedora?.findings.map((h) => h.regla),
      'la carga que perdió la carrera no nombró por qué no escribió'
    ).toContain('APE-YA-CARGADA');

    // EL LIBRO: un solo asiento de apertura, y ni una línea de más.
    const asientos = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entries
        WHERE entity_id = $1 AND source_type = 'opening_balance' AND status <> 'void'`,
      [solo.entityId]
    );
    expect(asientos.rows[0].n, 'la apertura se posteó dos veces').toBe('1');

    // Y LOS SALDOS NO SE DUPLICARON: el activo vale lo que el archivo decía.
    const activo = await query<{ s: string }>(
      `SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)::text AS s
         FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN accounts a ON a.id = l.account_id
        WHERE e.entity_id = $1 AND e.source_type = 'opening_balance'
          AND e.status <> 'void' AND a.code = '102-001'`,
      [solo.entityId]
    );
    expect(
      activo.rows[0].s,
      'el banco quedó con el doble: los dos asientos entraron aunque el conteo dijera uno'
    ).toBe('50000.0000');
    // Nota para quien toque esta consulta: los `COALESCE` van DENTRO de la
    // resta. Con `debit - credit` a secas, una línea de sólo abono da NULL, la
    // suma entera da NULL y el `COALESCE` de fuera la vuelve 0 — la aserción
    // pasaría por la razón equivocada el día que el saldo esperado fuera cero.
  });
});

// ============================================================
// MNE-001-018 · A REVERSED OPENING CAN BE LOADED AGAIN (087), AND THE CHECK
// ============================================================

describe('a reversed opening can be loaded again', () => {
  it('087 narrows the 081 index to the openings that are still standing', async () => {
    const idx = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_je_apertura_por_entidad_y_fecha'`
    );
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0].indexdef).toMatch(/reversed_by_entry_id IS NULL/);
  });

  it('void, reload, and `opening-balance check` is equal to the peso — with no doubled balance', async () => {
    const own = await crearEntidadHermana(f, 'MNE-001-018 reload');
    await importSatChart(ctxDe(own), { entityId: own.entityId, xml: XML_CATALOGO, userId: own.userId });
    await pointControlRolesAtMigratedAccounts(own);
    const load = () =>
      importOpeningBalance(ctxDe(own), {
        entityId: own.entityId,
        xml: balanzaDeOrigen(),
        userId: own.userId,
        documentos: AUXILIAR,
      });
    const first = await load();
    expect(first.escrito).toBe(true);
    const check = async () =>
      checkOpeningBalance(ctxDe(own), { entityId: own.entityId, xml: balanzaDeOrigen() });
    expect((await check()).comparison.iguales).toBe(true);

    // Before 087 this was the dead end: the reversed opening stays 'posted',
    // so the index still counted it and the advice «void it and run again»
    // could not be followed.
    await voidJournalEntry(first.asiento?.id ?? '', own.userId, 'wrong source file');
    const second = await load();
    expect(second.findings.map((x) => x.regla)).not.toContain('APE-YA-CARGADA');
    expect(second.escrito).toBe(true);
    // The invoices of the reversed opening are taken over, not duplicated.
    const invoices = await query<{ n: string; je: string }>(
      `SELECT COUNT(*)::text AS n, MIN(journal_entry_id::text) AS je FROM invoices WHERE entity_id = $1`,
      [own.entityId]
    );
    expect(invoices.rows[0]).toEqual({ n: '2', je: second.asiento?.id });

    const c = (await check()).comparison;
    expect(renderBalanceComparison(c)).toContain('IGUALES AL PESO');
    expect(c.comparadas).toBe(CATALOGO.length);

    // And a THIRD live one is still refused: the guard narrowed, it did not go.
    const third = await load();
    expect(third.escrito).toBe(false);
    expect(third.findings.map((x) => x.regla)).toContain('APE-YA-CARGADA');
  });

  it('the check names the account when the ledger differs from the source', async () => {
    const c = (
      await checkOpeningBalance(ctxDe(f), {
        entityId: f.entityId,
        xml: balanzaDeOrigen({ '102-001': '50001.00', '102': '50001.00', '100': '232001.00' }),
      })
    ).comparison;
    expect(c.iguales).toBe(false);
    expect(c.diferencias.map((d) => d.numCta)).toContain('102-001');
  });
});

describe('la balanza del sistema viejo y la nuestra', () => {
  it('SaldoFin del primer periodo, CUENTA POR CUENTA, iguales al peso', async () => {
    const origen = readBalanzaComprobacion(balanzaDeOrigen());
    const nuestra = await generarBalanza(f.entityId, { periodo: f.periodos[1] });
    const leida = readBalanzaComprobacion(nuestra.xml);

    const c = compareToSource(origen.rows, leida.rows, await formaDelPlan(f.entityId), 'SaldoFin');
    // El mensaje del `expect` es el informe entero: si algún día falla, la
    // primera línea de la salida ya dice qué cuenta y en cuánto.
    expect(renderBalanceComparison(c)).toContain('IGUALES AL PESO');
    expect(c.iguales).toBe(true);
    expect(c.comparadas).toBe(CATALOGO.length);
  });

  it('y nuestra balanza ya declara el mayor AGREGADO, como el origen (#323)', async () => {
    // Until #323 «100 Activo» went out at zero with a `mayor-sin-agregar`
    // warning. Now it carries its subtree, netted: 50 000 + 12 000 + 200 000
    // − 30 000 of depreciation, the same 232 000 the source file declares.
    const nuestra = await generarBalanza(f.entityId, { periodo: f.periodos[1] });
    expect(nuestra.hallazgos.map((h) => h.check as string)).not.toContain('mayor-sin-agregar');
    const leida = readBalanzaComprobacion(nuestra.xml);
    expect(leida.rows.find((r) => r.numCta === '100')?.saldoFin).toBe(
      readBalanzaComprobacion(balanzaDeOrigen()).rows.find((r) => r.numCta === '100')?.saldoFin
    );
    expect(leida.rows.find((r) => r.numCta === '102-001')?.saldoFin).toBe('50000.00');
  });

  it('la depreciación acumulada NETEA contra su padre, no se le suma', async () => {
    // 153-001 200 000 D y 171 30 000 A cuelgan del mismo «100 Activo». Sumar
    // las cifras declaradas daría 292 000 donde el activo vale 232 000.
    const origen = readBalanzaComprobacion(balanzaDeOrigen());
    const nuestra = readBalanzaComprobacion(
      (await generarBalanza(f.entityId, { periodo: f.periodos[1] })).xml
    );
    const c = compareToSource(origen.rows, nuestra.rows, await formaDelPlan(f.entityId), 'SaldoFin');
    expect(c.diferencias).toEqual([]);
    expect(origen.rows.find((r) => r.numCta === '100')?.saldoFin).toBe('232000.00');
  });

  it('a partir del SEGUNDO periodo también cuadra el SaldoIni, que es la columna del arrastre', async () => {
    const origen = readBalanzaComprobacion(balanzaDeOrigen());
    const nuestra = readBalanzaComprobacion(
      (await generarBalanza(f.entityId, { periodo: f.periodos[2] })).xml
    );
    const shapes = await formaDelPlan(f.entityId);
    // El SaldoFin del origen contra el SaldoIni de febrero: es el arrastre.
    const c = compareToSource(origen.rows, nuestra.rows, shapes, 'SaldoIni');
    expect(c.iguales).toBe(true);
  });

  it('LAYER 3 CLOSED (MNE-001-022): the opening also wrote the invoices, and ar reconcile ties at 0', async () => {
    // Until MNE-001-022 this test pinned the gap: the ledger carried the two
    // documents but no `invoices` row stood behind them, so `ar reconcile`
    // reported the whole 12 000 as a delta. The same load now writes them.
    const cxc = await query<{ id: string }>(
      `SELECT id FROM accounts WHERE entity_id = $1 AND code = '105-001'`,
      [f.entityId]
    );
    const reconciliation = await arReconcile(f.entityId);
    expect(reconciliation.control_balance).toBe('12000.00');
    expect(reconciliation.subledger_net).toBe('12000.00');
    expect(reconciliation.delta).toBe('0.00');
    expect(reconciliation.balanced).toBe(true);

    const invoices = await query<{ invoice_number: string; amount_due: string; status: string; due_date: string; company_name: string }>(
      `SELECT i.invoice_number, i.amount_due::text AS amount_due, i.status, i.due_date::text AS due_date, c.company_name
         FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.entity_id = i.entity_id
        WHERE i.entity_id = $1 ORDER BY i.invoice_number`,
      [f.entityId]
    );
    expect(invoices.rows).toEqual([
      { invoice_number: 'A-123', amount_due: '4000.0000', status: 'sent', due_date: '2025-12-02', company_name: 'Aceros del Norte SA' },
      { invoice_number: 'A-456', amount_due: '8000.0000', status: 'sent', due_date: '2026-01-19', company_name: 'Bravo Servicios SC' },
    ]);
    // And the ledger still knows each folio, line by line.
    const ledgerLines = await query<{ description: string }>(
      `SELECT jel.description
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.entity_id = $1 AND jel.account_id = $2
        ORDER BY jel.line_number`,
      [f.entityId, cxc.rows[0].id]
    );
    expect(ledgerLines.rows.map((d) => d.description.includes('A-123') || d.description.includes('A-456'))).toEqual([
      true,
      true,
    ]);
  });

  it('LA PRUEBA SABE FALLAR: un peso de más se nombra con su cuenta y su importe', async () => {
    // Va la última a propósito: mueve el mayor. Un peso entre el banco y los
    // impuestos por pagar — el asiento cuadra, así que sólo el cotejo cuenta
    // por cuenta puede verlo.
    const ids = Object.fromEntries(
      (
        await query<{ code: string; id: string }>(
          `SELECT code, id FROM accounts WHERE entity_id = $1 AND code IN ('102-001', '213')`,
          [f.entityId]
        )
      ).rows.map((x) => [x.code, x.id])
    );
    await createJournalEntry(
      f.entityId,
      new Date('2026-01-15T00:00:00'),
      JournalEntryType.STANDARD,
      'Un peso que el sistema viejo no tenía',
      [
        { account_id: ids['102-001'], debit_amount: '1.0000', credit_amount: null, description: 'sobra' },
        { account_id: ids['213'], debit_amount: null, credit_amount: '1.0000', description: 'sobra' },
      ],
      f.userId,
      { autoPost: true }
    );

    const origen = readBalanzaComprobacion(balanzaDeOrigen());
    const nuestra = readBalanzaComprobacion(
      (await generarBalanza(f.entityId, { periodo: f.periodos[1] })).xml
    );
    const c = compareToSource(origen.rows, nuestra.rows, await formaDelPlan(f.entityId), 'SaldoFin');

    expect(c.iguales).toBe(false);
    // El peso se ve en la cuenta que lo recibió Y en sus antepasados: cuatro
    // renglones para un solo peso, que es exactamente lo que hay que enseñar.
    const nombradas = c.diferencias.map((d) => d.numCta).sort();
    expect(nombradas).toEqual(['100', '102', '102-001', '200', '213']);
    expect(c.diferencias.find((d) => d.numCta === '102-001')).toEqual({
      numCta: '102-001',
      esperado: '50000.0000',
      obtenido: '50001.0000',
      diferencia: '1.0000',
    });
    expect(renderBalanceComparison(c)).toContain('el origen dice 50000.0000 y aquí hay 50001.0000');
  });
});

// ============================================================
// MNE-001-022 · THE OPEN RECEIVABLES OF THE MIGRATION (#310)
// ============================================================

describe('MNE-001-022: open receivables come in as invoices with the opening', () => {
  /** A sibling entity with the migrated chart and the roles a collection reads. */
  async function migrated(
    name: string,
    roles: Record<string, string> = { cxc: '105-001', cxp: '201-001', banco: '102-001' }
  ) {
    const own = await crearEntidadHermana(f, name);
    await importSatChart(ctxDe(own), { entityId: own.entityId, xml: XML_CATALOGO, userId: own.userId });
    const ids = Object.fromEntries(
      (
        await query<{ code: string; id: string }>(`SELECT code, id FROM accounts WHERE entity_id = $1`, [own.entityId])
      ).rows.map((x) => [x.code, x.id])
    );
    for (const [role, code] of Object.entries(roles)) {
      await setAccountRole(own.entityId, own.tenantId, role, ids[code], { userId: own.userId });
    }
    return { own, ids };
  }
  const count = async (sql: string, entityId: string) =>
    (await query<{ n: string }>(sql, [entityId])).rows[0].n;
  const load = (own: Fixture, documentos: OpeningDocument[] = AUXILIAR) =>
    importOpeningBalance(ctxDe(own), { entityId: own.entityId, xml: balanzaDeOrigen(), userId: own.userId, documentos });

  it('documents that do not tie stop the load, name the account and the difference, and post no adjustment', async () => {
    const { own } = await migrated('MNE-001-022 no tie');
    const r = await load(own, AUXILIAR.map((d) => (d.documento === 'A-456' ? { ...d, importe: '8001.00' } : d)));
    expect(r.escrito).toBe(false);
    const finding = r.findings.find((x) => x.regla === 'APE-DETALLE-NO-CUADRA');
    expect(finding?.numCta).toBe('105-001');
    expect(finding?.mensaje).toContain('sobran 1.00');
    expect(r.control.find((c) => c.code === '105-001')).toMatchObject({
      residual: '12000.0000',
      detalle: '12001.0000',
      cubierto: false,
    });
    expect(await count(`SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1`, own.entityId)).toBe('0');
    expect(await count(`SELECT COUNT(*)::text AS n FROM invoices WHERE entity_id = $1`, own.entityId)).toBe('0');
    expect(await count(`SELECT COUNT(*)::text AS n FROM customers WHERE entity_id = $1`, own.entityId)).toBe('0');
    expect((await arReconcile(own.entityId)).delta).toBe('0.00');
  });

  it('a cxc role that points at another account stops the load: collections would credit the wrong one', async () => {
    const { own } = await migrated('MNE-001-022 role elsewhere', { cxc: '102-001', cxp: '201-001' });
    const r = await load(own);
    expect(r.escrito).toBe(false);
    expect(r.findings.find((x) => x.regla === 'APE-CXC-OTRA-CUENTA')?.numCta).toBe('105-001');
    expect(await count(`SELECT COUNT(*)::text AS n FROM invoices WHERE entity_id = $1`, own.entityId)).toBe('0');
  });

  it('collecting a migrated invoice works like collecting a native one, and ar reconcile stays at 0', async () => {
    const { own, ids } = await migrated('MNE-001-022 collect');
    const uuid = 'A1B2C3D4-0000-4000-8000-000000000123';
    const r = await load(own, AUXILIAR.map((d) => (d.documento === 'A-123' ? { ...d, rfc: 'ano010101aaa', uuid } : d)));
    expect(r.escrito).toBe(true);
    expect(r.arInvoices).toBe(2);
    expect((await arReconcile(own.entityId)).delta).toBe('0.00');

    const inv = (
      await query<{ id: string; customer_id: string; cfdi_uuid: string | null; tax_id: string | null }>(
        `SELECT i.id, i.customer_id, i.cfdi_uuid, c.tax_id
           FROM invoices i JOIN customers c ON c.id = i.customer_id
          WHERE i.entity_id = $1 AND i.invoice_number = 'A-123'`,
        [own.entityId]
      )
    ).rows[0];
    expect(inv.cfdi_uuid).toBe(uuid);
    expect(inv.tax_id).toBe('ANO010101AAA');

    const payment = await recordCustomerPayment(
      {
        entityId: own.entityId,
        counterpartyId: inv.customer_id,
        paymentAmount: '1500.00',
        paymentDate: '2026-01-15',
        paymentMethod: 'spei',
        applications: [{ documentId: inv.id, amountApplied: '1500.00' }],
      },
      own.userId
    );
    expect(payment.documentos).toEqual([
      expect.objectContaining({ numero: 'A-123', saldoAnterior: '4000.00', saldoNuevo: '2500.00', estado: 'partially_paid' }),
    ]);
    // DR bank · CR the migrated control account: the entry a native invoice gets.
    const lines = await query<{ account_id: string; debit_amount: string | null; credit_amount: string | null }>(
      `SELECT account_id, debit_amount::text AS debit_amount, credit_amount::text AS credit_amount
         FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number`,
      [payment.journalEntry?.id]
    );
    expect(lines.rows).toEqual([
      { account_id: ids['102-001'], debit_amount: '1500.0000', credit_amount: null },
      { account_id: ids['105-001'], debit_amount: null, credit_amount: '1500.0000' },
    ]);
    const reconciliation = await arReconcile(own.entityId);
    expect(reconciliation.control_balance).toBe('10500.00');
    expect(reconciliation.delta).toBe('0.00');
  });

  it('voiding a migrated invoice is refused: it would reverse the whole opening', async () => {
    const { own } = await migrated('MNE-001-022 void');
    const r = await load(own);
    const inv = await query<{ id: string }>(
      `SELECT id FROM invoices WHERE entity_id = $1 AND invoice_number = 'A-456'`,
      [own.entityId]
    );
    await expect(voidInvoice(inv.rows[0].id, own.userId, { entityId: own.entityId })).rejects.toThrow(/credit note/);
    const opening = await query<{ reversed_by_entry_id: string | null }>(
      `SELECT reversed_by_entry_id FROM journal_entries WHERE id = $1`,
      [r.asiento?.id]
    );
    expect(opening.rows[0].reversed_by_entry_id).toBeNull();
    expect((await arReconcile(own.entityId)).delta).toBe('0.00');
  });
});

// ============================================================
// MNE-001-023 · THE OPEN PAYABLES OF THE MIGRATION (#310)
// ============================================================

describe('MNE-001-023: open payables come in as bills with the opening', () => {
  async function migrated(
    name: string,
    roles: Record<string, string> = { cxc: '105-001', cxp: '201-001', banco: '102-001' },
    chart: CuentaDelCliente[] = CATALOGO
  ) {
    const own = await crearEntidadHermana(f, name);
    await importSatChart(ctxDe(own), { entityId: own.entityId, xml: catalogXml(chart), userId: own.userId });
    const ids = Object.fromEntries(
      (
        await query<{ code: string; id: string }>(`SELECT code, id FROM accounts WHERE entity_id = $1`, [own.entityId])
      ).rows.map((x) => [x.code, x.id])
    );
    for (const [role, code] of Object.entries(roles)) {
      await setAccountRole(own.entityId, own.tenantId, role, ids[code], { userId: own.userId });
    }
    return { own, ids };
  }
  const count = async (table: string, entityId: string) =>
    (await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table} WHERE entity_id = $1`, [entityId])).rows[0].n;
  const load = (own: Fixture, documentos: OpeningDocument[] = AUXILIAR, chart: CuentaDelCliente[] = CATALOGO) =>
    importOpeningBalance(ctxDe(own), {
      entityId: own.entityId, xml: balanzaDeOrigen({}, chart), userId: own.userId, documentos,
    });

  it('the load writes one approved bill per vendor document, and ap reconcile ties at 0 with nothing to explain', async () => {
    const { own } = await migrated('MNE-001-023 tie');
    const r = await load(own);
    expect(r.escrito).toBe(true);
    expect(r.apBills).toBe(2);

    const bills = await query<{ vendor_invoice_number: string; amount_due: string; status: string; company_name: string; je: string }>(
      `SELECT b.vendor_invoice_number, b.amount_due::text AS amount_due, b.status, v.company_name,
              b.journal_entry_id::text AS je
         FROM bills b JOIN vendors v ON v.id = b.vendor_id AND v.entity_id = b.entity_id
        WHERE b.entity_id = $1 ORDER BY b.vendor_invoice_number`,
      [own.entityId]
    );
    expect(bills.rows).toEqual([
      { vendor_invoice_number: 'F-77', amount_due: '9000.0000', status: 'approved', company_name: 'Papelera del Centro', je: r.asiento?.id },
      { vendor_invoice_number: 'F-88', amount_due: '5000.0000', status: 'approved', company_name: 'Tornillos Industriales', je: r.asiento?.id },
    ]);

    const ap = await apReconcile(own.entityId);
    expect(ap.cuentaControl.code).toBe('201-001');
    expect(ap.mayor).toBe('14000.00');
    expect(ap.subdiario).toBe('14000.00');
    expect(ap.diferencia).toBe('0.00');
    expect(ap.cuadra).toBe(true);
    // The opening has documents behind it now: not a manual entry, no residue.
    expect(ap.partidas).toEqual([]);
    expect(ap.sinExplicar).toBe('0.00');
    expect((await arReconcile(own.entityId)).delta).toBe('0.00');
  });

  it('payable documents that do not tie stop the load, say what is missing on the account, and post nothing', async () => {
    const { own } = await migrated('MNE-001-023 no tie');
    const r = await load(own, AUXILIAR.map((d) => (d.documento === 'F-88' ? { ...d, importe: '4000.00' } : d)));
    expect(r.escrito).toBe(false);
    const finding = r.findings.find((x) => x.regla === 'APE-DETALLE-NO-CUADRA');
    expect(finding?.numCta).toBe('201-001');
    expect(finding?.mensaje).toContain('suman 13000.00 y la balanza declara 14000.00 para esa cuenta: faltan 1000.00');
    expect(r.control.find((c) => c.code === '201-001')).toMatchObject({ residual: '14000.0000', detalle: '13000.0000', cubierto: false });
    for (const table of ['journal_entries', 'bills', 'vendors', 'invoices']) {
      expect(await count(table, own.entityId)).toBe('0');
    }
  });

  it('a cxp role that points at another account leaves the documents as opening lines, and says so', async () => {
    // The seeded `cxp` role still points at the seeded chart, not at 201-001.
    const { own } = await migrated('MNE-001-023 role elsewhere', { cxc: '105-001' });
    const r = await load(own);
    expect(r.escrito).toBe(true);
    expect(r.findings.find((x) => x.regla === 'APE-CXP-FUERA-DEL-ROL')?.numCta).toBe('201-001');
    expect(await count('bills', own.entityId)).toBe('0');
  });

  it('paying a migrated bill works like paying a native one, and ap reconcile stays at 0', async () => {
    const { own, ids } = await migrated('MNE-001-023 pay');
    const r = await load(own, AUXILIAR.map((d) => (d.documento === 'F-77' ? { ...d, rfc: 'pce010101aaa' } : d)));
    expect(r.escrito).toBe(true);
    const bill = (
      await query<{ id: string; vendor_id: string; tax_id: string | null }>(
        `SELECT b.id, b.vendor_id, v.tax_id FROM bills b JOIN vendors v ON v.id = b.vendor_id
          WHERE b.entity_id = $1 AND b.vendor_invoice_number = 'F-77'`,
        [own.entityId]
      )
    ).rows[0];
    expect(bill.tax_id).toBe('PCE010101AAA');

    const payment = await recordVendorPayment(
      {
        entityId: own.entityId,
        counterpartyId: bill.vendor_id,
        paymentAmount: '4000.00',
        paymentDate: '2026-01-15',
        paymentMethod: 'spei',
        applications: [{ documentId: bill.id, amountApplied: '4000.00' }],
      },
      own.userId
    );
    expect(payment.documentos).toEqual([
      expect.objectContaining({ saldoAnterior: '9000.00', saldoNuevo: '5000.00', estado: 'partially_paid' }),
    ]);
    // DR the migrated control account · CR bank: the entry a native bill gets.
    const lines = await query<{ account_id: string; debit_amount: string | null; credit_amount: string | null }>(
      `SELECT account_id, debit_amount::text AS debit_amount, credit_amount::text AS credit_amount
         FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number`,
      [payment.journalEntry?.id]
    );
    expect(lines.rows).toEqual([
      { account_id: ids['201-001'], debit_amount: '4000.0000', credit_amount: null },
      { account_id: ids['102-001'], debit_amount: null, credit_amount: '4000.0000' },
    ]);
    const ap = await apReconcile(own.entityId);
    expect(ap.mayor).toBe('10000.00');
    expect(ap.diferencia).toBe('0.00');
    expect(ap.partidas).toEqual([]);
  });

  it('a vendor invoice already registered as a bill is refused against the database: the liability would count twice', async () => {
    const { own } = await migrated('MNE-001-023 twice');
    const r = await load(own);
    expect(r.escrito).toBe(true);
    // The same documents, planned again against what is now in the tables.
    const again = await prepareOpeningBills(own.entityId, r);
    expect(again.drafts).toEqual([]);
    expect(again.findings.map((x) => x.regla)).toEqual(['APE-CXP-FOLIO-TOMADO', 'APE-CXP-FOLIO-TOMADO']);
  });

  // ── Review fixes: the same books with the IVA still pending on the open
  // payables (119-001) and a second payable account, 205-001 Acreedores
  // diversos, next to 201-001 Proveedores. 233 241.38 = 19 000 + 214 241.38.
  const WIDE_CHART: CuentaDelCliente[] = [
    ...CATALOGO.map((c) => {
      const balance = { '100': '233241.38', '200': '19000.00', '300': '214241.38', '304': '114241.38' }[c.num];
      return balance === undefined ? c : { ...c, saldo: balance };
    }),
    { num: '119', desc: 'IVA pendiente de acreditar', padre: '100', agrup: '119', nivel: 2, natur: 'D', saldo: '1241.38' },
    { num: '119-001', desc: 'IVA pendiente de pago', padre: '119', agrup: '119.01', nivel: 3, natur: 'D', saldo: '1241.38' },
    { num: '205', desc: 'Acreedores diversos', padre: '200', agrup: '205', nivel: 2, natur: 'A', saldo: '2000.00' },
    { num: '205-001', desc: 'Acreedores diversos', padre: '205', agrup: '205.06', nivel: 3, natur: 'A', saldo: '2000.00' },
  ];
  const CREDITOR_DOC: OpeningDocument = {
    cuenta: '205-001', documento: 'AD-1', contraparte: 'Socio Uno', fecha: '2025-12-15', vencimiento: '2026-02-15', importe: '2000.00',
  };
  /** F-77 carries 16 % IVA: 9 000 = 7 758.62 + 1 241.38, parked on 119-001. */
  const WIDE_SUBLEDGER: OpeningDocument[] = [
    ...AUXILIAR.map((d) => (d.documento === 'F-77' ? { ...d, ivaRate: '0.16', rfc: 'PCE010101AAA' } : d)),
    CREDITOR_DOC,
  ];
  const WIDE_ROLES = { cxc: '105-001', cxp: '201-001', banco: '102-001', iva_pendiente_acreditar: '119-001' };

  it('a second payable account (205 next to 201) loads: its documents stay opening lines, and ap reconcile ties', async () => {
    const { own } = await migrated('MNE-001-023 two payable accounts', WIDE_ROLES, WIDE_CHART);
    const r = await load(own, WIDE_SUBLEDGER, WIDE_CHART);
    expect(r.findings.filter((x) => x.severidad === 'bloquea')).toEqual([]);
    expect(r.escrito).toBe(true);
    expect(r.findings.find((x) => x.regla === 'APE-CXP-FUERA-DEL-ROL')?.numCta).toBe('205-001');
    expect(r.apBills).toBe(2);
    const lines = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id
        WHERE jel.journal_entry_id = $1 AND a.code = '205-001'`,
      [r.asiento?.id]
    );
    expect(lines.rows[0].n).toBe('1');
    const ap = await apReconcile(own.entityId);
    expect([ap.mayor, ap.subdiario, ap.diferencia]).toEqual(['14000.00', '14000.00', '0.00']);
  });

  it('paying a migrated bill releases its pending IVA, and the DIOT of that month declares it by rate without blocking', async () => {
    const { own, ids } = await migrated('MNE-001-023 diot', WIDE_ROLES, WIDE_CHART);
    const r = await load(own, WIDE_SUBLEDGER, WIDE_CHART);
    expect(r.escrito).toBe(true);
    const bill = (
      await query<{ id: string; vendor_id: string; subtotal: string; tax_amount: string; lines: string }>(
        `SELECT b.id, b.vendor_id, b.subtotal::text AS subtotal, b.tax_amount::text AS tax_amount,
                (SELECT string_agg(bl.tax_rate::text || '/' || bl.valor_actos::text, ',') FROM bill_lines bl WHERE bl.bill_id = b.id) AS lines
           FROM bills b WHERE b.entity_id = $1 AND b.vendor_invoice_number = 'F-77'`,
        [own.entityId]
      )
    ).rows[0];
    expect(bill).toMatchObject({ subtotal: '7758.6200', tax_amount: '1241.3800', lines: '16.00/7758.6200' });

    await recordVendorPayment(
      {
        entityId: own.entityId,
        counterpartyId: bill.vendor_id,
        paymentAmount: '9000.00',
        paymentDate: '2026-01-15',
        paymentMethod: 'spei',
        applications: [{ documentId: bill.id, amountApplied: '9000.00' }],
      },
      own.userId
    );
    // 119-001 gave up exactly the IVA the opening parked for F-77.
    const pending = await query<{ balance: string }>(
      `SELECT COALESCE(SUM(COALESCE(jel.debit_amount,0) - COALESCE(jel.credit_amount,0)), 0)::numeric(19,2)::text AS balance
         FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.entity_id = $1 AND je.status = 'posted' AND jel.account_id = $2`,
      [own.entityId, ids['119-001']]
    );
    expect(pending.rows[0].balance).toBe('0.00');

    const diot = await construirDiot({ tenantId: own.tenantId, entityId: own.entityId, anio: 2026, mes: 1 });
    expect(diot.hallazgos.filter((h) => h.documentId === bill.id && h.severidad === 'bloqueante')).toEqual([]);
    expect(diot.hallazgos.map((h) => h.codigo)).not.toContain('DIOT-SIN-RENGLONES');
    const row = diot.renglones.find((x) => x.documentos.some((d) => d.billId === bill.id));
    expect(row?.desglose.tasa16).toEqual({ base: '7758.6200', iva: '1241.3800' });
    expect((await apReconcile(own.entityId)).diferencia).toBe('0.00');
  });

  it('two foreign vendors under the generic RFC XEXX010101000 are two vendors, each with its own bill', async () => {
    const { own } = await migrated('MNE-001-023 generic rfc');
    // Before the fix both bills hung from the first vendor found by that RFC.
    const foreign = AUXILIAR.map((d) => {
      if (d.documento === 'F-77') return { ...d, contraparte: 'Acme Inc', rfc: 'XEXX010101000' };
      if (d.documento === 'F-88') return { ...d, contraparte: 'Globex GmbH', rfc: 'XEXX010101000' };
      return d;
    });
    const r = await load(own, foreign);
    expect(r.findings.filter((x) => x.severidad === 'bloquea')).toEqual([]);
    expect(r.escrito).toBe(true);
    const bills = await query<{ company_name: string; tax_id: string; amount_due: string }>(
      `SELECT v.company_name, v.tax_id, b.amount_due::text AS amount_due
         FROM bills b JOIN vendors v ON v.id = b.vendor_id AND v.entity_id = b.entity_id
        WHERE b.entity_id = $1 ORDER BY v.company_name`,
      [own.entityId]
    );
    expect(bills.rows).toEqual([
      { company_name: 'Acme Inc', tax_id: 'XEXX010101000', amount_due: '9000.0000' },
      { company_name: 'Globex GmbH', tax_id: 'XEXX010101000', amount_due: '5000.0000' },
    ]);
  });

  it('a reload with a corrected vendor name voids the old bill of the reversed opening: one F-88, and ap reconcile at 0', async () => {
    const { own } = await migrated('MNE-001-023 reload renamed');
    const first = await load(own);
    expect(first.escrito).toBe(true);
    await voidJournalEntry(first.asiento?.id ?? '', own.userId, 'wrong vendor name');
    const renamed = AUXILIAR.map((d) =>
      d.documento === 'F-88' ? { ...d, contraparte: 'Tornillos Industriales SA de CV' } : d
    );
    const second = await load(own, renamed);
    expect(second.escrito).toBe(true);
    expect(second.findings.find((x) => x.regla === 'APE-CXP-ANULA-HUERFANAS')?.mensaje).toContain('F-88 de Tornillos Industriales');

    const bills = await query<{ vendor_invoice_number: string; status: string; company_name: string; je: string }>(
      `SELECT b.vendor_invoice_number, b.status, v.company_name, b.journal_entry_id::text AS je
         FROM bills b JOIN vendors v ON v.id = b.vendor_id AND v.entity_id = b.entity_id
        WHERE b.entity_id = $1 ORDER BY b.vendor_invoice_number, b.status`,
      [own.entityId]
    );
    expect(bills.rows).toEqual([
      { vendor_invoice_number: 'F-77', status: 'approved', company_name: 'Papelera del Centro', je: second.asiento?.id },
      { vendor_invoice_number: 'F-88', status: 'approved', company_name: 'Tornillos Industriales SA de CV', je: second.asiento?.id },
      { vendor_invoice_number: 'F-88', status: 'void', company_name: 'Tornillos Industriales', je: first.asiento?.id },
    ]);
    const ap = await apReconcile(own.entityId);
    expect([ap.mayor, ap.subdiario, ap.diferencia]).toEqual(['14000.00', '14000.00', '0.00']);
  });
});
