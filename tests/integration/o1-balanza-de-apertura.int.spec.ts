import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { setAccountRole } from '../../src/services/accounting/account-roles-service.js';
import { arReconcile } from '../../src/services/ar/ar-controls.js';
import { importSatChart } from '../../src/services/accounting/sat-chart-import.js';
import {
  importOpeningBalance,
  type OpeningDocument,
} from '../../src/services/accounting/opening-balance.js';
import {
  compareToSource,
  renderBalanceComparison,
  shapesFromRows,
} from '../../src/services/accounting/opening-balance-check.js';
import { readBalanzaComprobacion } from '../../src/services/sat/anexo24/balance-reader.js';
import { generarBalanza } from '../../src/services/sat/anexo24/balanza-service.js';

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

const XML_CATALOGO =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<catalogocuentas:Catalogo xmlns:catalogocuentas="${NS_CAT}" Version="1.3" RFC="${RFC}" Mes="12" Anio="2025">` +
  CATALOGO.map(
    (c) =>
      `<catalogocuentas:Ctas CodAgrup="${c.agrup}" NumCta="${c.num}" Desc="${c.desc}"` +
      `${c.padre === undefined ? '' : ` SubCtaDe="${c.padre}"`} Nivel="${c.nivel}" Natur="${c.natur}"/>`
  ).join('') +
  `</catalogocuentas:Catalogo>`;

/**
 * La balanza del sistema viejo al 31 de diciembre. SaldoIni = SaldoFin y sin
 * movimiento: lo que la apertura consume es el SaldoFin, y así el recálculo
 * del lector cuadra sin inventar un ejercicio entero de asientos.
 */
function balanzaDeOrigen(saldos: Record<string, string> = {}): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<BCE:Balanza xmlns:BCE="${NS_BAL}" Version="1.3" RFC="${RFC}" Mes="12" Anio="2025" TipoEnvio="N">` +
    CATALOGO.map((c) => {
      const s = saldos[c.num] ?? c.saldo;
      return `<BCE:Ctas NumCta="${c.num}" SaldoIni="${s}" Debe="0.00" Haber="0.00" SaldoFin="${s}"/>`;
    }).join('') +
    `</BCE:Balanza>`
  );
}

const AUXILIAR: OpeningDocument[] = [
  { cuenta: '105-001', documento: 'A-123', contraparte: 'Aceros del Norte SA', fecha: '2025-11-02', vencimiento: '2025-12-02', importe: '4000.00' },
  { cuenta: '105-001', documento: 'A-456', contraparte: 'Bravo Servicios SC', fecha: '2025-11-20', vencimiento: '2026-01-19', importe: '8000.00' },
  { cuenta: '201-001', documento: 'F-77', contraparte: 'Papelera del Centro', fecha: '2025-12-01', vencimiento: '2026-01-15', importe: '9000.00' },
  { cuenta: '201-001', documento: 'F-88', contraparte: 'Tornillos Industriales', fecha: '2025-12-10', vencimiento: '2026-01-24', importe: '5000.00' },
];

const ctxDe = (fx: Fixture) => ({ tenantId: fx.tenantId, entityId: fx.entityId });

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

  it('y la comprobación tiene que AGREGAR, porque este generador no agrega', async () => {
    // No es un detalle del cotejo: es una propiedad declarada de F07b. La
    // balanza que este sistema emite declara el saldo PROPIO de cada cuenta,
    // así que «100 Activo» sale en ceros y su advertencia sale con ella.
    const nuestra = await generarBalanza(f.entityId, { periodo: f.periodos[1] });
    expect(nuestra.hallazgos.map((h) => h.check)).toContain('mayor-sin-agregar');
    const leida = readBalanzaComprobacion(nuestra.xml);
    expect(leida.rows.find((r) => r.numCta === '100')?.saldoFin).toBe('0.00');
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

  it('LA FRONTERA CON LA CAPA 3, MEDIDA: el mayor ya trae el detalle, el auxiliar todavía no', async () => {
    // Esta capa deja los cuatro documentos ESCRITOS EN EL MAYOR, que es lo que
    // lee el auxiliar de cuenta y subcuenta del Anexo 24 y lo que un contador
    // ve al abrir la cuenta. Lo que NO crea son las filas de `invoices` y
    // `bills`: una factura necesita un CLIENTE, y el padrón de clientes no se
    // ha migrado todavía —inventarlo sería peor que no tenerlo—. Eso es la
    // capa 3 («auxiliares abiertos»).
    //
    // Consecuencia, medida aquí para que la capa 3 no pueda pasarla por alto:
    // mientras el auxiliar no exista, `ar reconcile` sigue acusando el delta.
    // La diferencia con el agregado del bloque 2 es que aquí el descuadre SE
    // PUEDE CERRAR documento a documento, porque los documentos están escritos.
    const cxc = await query<{ id: string }>(
      `SELECT id FROM accounts WHERE entity_id = $1 AND code = '105-001'`,
      [f.entityId]
    );
    await setAccountRole(f.entityId, f.tenantId, 'cxc', cxc.rows[0].id, {
      userId: f.userId,
      notes: 'la cuenta de clientes del catálogo migrado',
    });
    const conciliacion = await arReconcile(f.entityId);
    expect(conciliacion.control_balance).toBe('12000.00');
    expect(conciliacion.subledger_net).toBe('0.00');
    expect(conciliacion.delta).toBe('12000.00');
    // Y el mayor SÍ sabe de qué se compone ese saldo, folio por folio.
    const detalle = await query<{ description: string }>(
      `SELECT jel.description
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.entity_id = $1 AND jel.account_id = $2
        ORDER BY jel.line_number`,
      [f.entityId, cxc.rows[0].id]
    );
    expect(detalle.rows.map((d) => d.description.includes('A-123') || d.description.includes('A-456'))).toEqual([
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
