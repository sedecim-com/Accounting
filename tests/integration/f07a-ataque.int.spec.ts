import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Command } from 'commander';
import Decimal from 'decimal.js';
import {
  crearInquilino,
  crearEntidadHermana,
  type Fixture,
} from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import reportsRouter from '../../src/api/rest/routes/reports.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import {
  getTrialBalance,
  queryAccumulatedBalances,
  type TrialBalanceReport,
  type TrialBalanceReportRow,
} from '../../src/services/reporting/report-service.js';
import {
  createAccount,
  setAccountMapping,
  checkMappingCoverageDetallada,
} from '../../src/services/accounting/account-service.js';
import {
  sembrarCatalogoAgrupadores,
  hayCatalogoVigente,
  validarCodigoAgrupador,
  prepararValidacionAgrupador,
} from '../../src/services/accounting/sat-agrupadores.js';
import { registerReportCommand } from '../../src/cli/report-command.js';
import { resolveEntity } from '../../src/ai/context.js';
import { buildReportTools } from '../../src/ai/tools/report-tools.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { ValidationError } from '../../src/utils/errors.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// F07a · EL ATAQUE.
//
// Esto no vuelve a demostrar lo que f07a-balanza y f07a-casilla ya demuestran.
// Ataca lo que ninguna de las dos mira, que es donde un instrumento contable
// miente sin chillar:
//
//   · La cuenta que se movió ANTES del periodo y no dentro: en la balanza del
//     Anexo 24 tiene que salir con SaldoIni y sin movimiento. Si desaparece,
//     el archivo que se sella con la e.firma declara menos cuentas de las que
//     el contribuyente tiene, y el SAT lo cruza contra las pólizas.
//   · La cuenta nacida a MITAD del periodo, que sí tiene que salir en cero.
//   · El periodo anterior ABIERTO: la cifra es calculable y NO es firme, y son
//     dos afirmaciones distintas.
//   · El invariante roto A PROPÓSITO desde `account_balances`: si la balanza no
//     sabe acusar, la comprobación no existe.
//   · LAS TRES SUPERFICIES. Una cuarta columna que el servicio calcula y que
//     ninguna superficie publica es una columna que no existe.
//   · La compuerta en LAS DOS DIRECCIONES, con las cuentas exactas que el
//     defecto viejo confundía: 1120 es de nivel 3 (movida, se escapaba) y
//     1000/1100 son de nivel 1 y 2 (nunca movidas, se acusaban).
//   · La VIGENCIA del agrupador: el mismo código, bueno en un ejercicio y malo
//     en otro.
//   · La frontera de entidad en la compuerta, y quién puede escribir en el
//     catálogo GLOBAL del SAT.
//
// Contra Postgres. Corre como superusuario a propósito: RLS queda inerte y lo
// que se juzga es la aritmética y los WHERE del CÓDIGO (ver frontera-entidad-ten).
//
// EL EJERCICIO (cifras asimétricas: con números simétricos, sumar donde había
// que restar pasa en verde):
//
//   ENE-1  2026-01-10   1120 D 6 400   ·  4100 C 6 400
//   ENE-2  2026-01-20   5100 D 1 700   ·  1120 C 1 700
//   FEB-1  2026-02-10   1120 D   900   ·  4100 C   900
//   FEB-2  2026-02-20   1195 D   320   ·  4100 C   320    (1195 nace 2026-02-14)
//
//   Balanza de FEBRERO, las cuatro columnas:
//     1120   ini  4 700   debe  900   haber     0   fin  5 600
//     4100   ini −6 400   debe    0   haber 1 220   fin −7 620
//     5100   ini  1 700   debe    0   haber     0   fin  1 700   ← sólo movió en enero
//     1195   ini      0   debe  320   haber     0   fin    320   ← nació a mitad del mes
//
// ENERO SE QUEDA ABIERTO. Es el caso que ninguna otra prueba cubre: ni suave
// ni duro, el estado en que un despacho consulta la balanza de febrero el día 3.
// ============================================================

let f: Fixture;
let hermana: Fixture;
let cuenta1195: string;
/** Cuántas filas tenía el catálogo del SAT antes de que este archivo lo tocara. */
let catalogoAlLlegar = 0;

const LEDGER = 4;

async function asiento(
  fx: Fixture,
  fecha: string,
  descripcion: string,
  cargo: string,
  abono: string,
  monto: string
): Promise<void> {
  await createJournalEntry(
    fx.entityId,
    new Date(`${fecha}T00:00:00Z`),
    JournalEntryType.STANDARD,
    descripcion,
    [
      { account_id: cargo, debit_amount: monto, credit_amount: null, description: descripcion },
      { account_id: abono, debit_amount: null, credit_amount: monto, description: descripcion },
    ],
    fx.userId,
    { autoPost: true }
  );
}

function fila(tb: TrialBalanceReport, codigo: string): TrialBalanceReportRow {
  const r = tb.rows.find((x) => x.account_code === codigo);
  expect(r, `la balanza no trae la cuenta ${codigo}`).toBeDefined();
  return r!;
}

function cuatro(tb: TrialBalanceReport, codigo: string) {
  const r = fila(tb, codigo);
  return {
    ini: new Decimal(r.beginning_balance ?? 'NaN').toFixed(LEDGER),
    debe: new Decimal(r.debit_total).toFixed(LEDGER),
    haber: new Decimal(r.credit_total).toFixed(LEDGER),
    fin: new Decimal(r.final_balance ?? 'NaN').toFixed(LEDGER),
  };
}

beforeAll(async () => {
  // `sat_codigos_agrupadores` es GLOBAL: la comparte toda la corrida. Este
  // archivo la siembra para poder probar la validación, así que apunta cómo la
  // encontró para devolverla igual — un archivo de pruebas que deja sembrada
  // una tabla compartida hace fallar al siguiente por un motivo que no es suyo.
  catalogoAlLlegar = Number(
    (await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM sat_codigos_agrupadores')).rows[0].n
  );

  f = await crearInquilino('F07a · ataque');
  enterTenant(f.tenantId);

  await asiento(f, '2026-01-10', 'Venta de enero', f.cuentas['1120'], f.cuentas['4100'], '6400.0000');
  await asiento(f, '2026-01-20', 'Costo de enero', f.cuentas['5100'], f.cuentas['1120'], '1700.0000');
  await asiento(f, '2026-02-10', 'Venta de febrero', f.cuentas['1120'], f.cuentas['4100'], '900.0000');

  // NACE A MITAD DEL PERIODO. Su SaldoIni tiene que ser cero por no existir
  // antes, no por no encontrarse: son dos ceros distintos y sólo uno es cierto.
  const nueva = await createAccount({
    code: '1195',
    name: 'Deudores diversos de febrero',
    account_type: 'asset',
    account_subtype: 'current_asset',
    fs_category: 'current_assets',
    parent_id: f.cuentas['1100'],
    entity_id: f.entityId,
    normal_balance: 'debit',
    created_by: f.userId,
  });
  cuenta1195 = nueva.id;
  await asiento(f, '2026-02-20', 'Deudor de febrero', cuenta1195, f.cuentas['4100'], '320.0000');

  hermana = await crearEntidadHermana(f, 'Hermana del ataque F07a');
});

afterAll(async () => {
  await drainAttestations(3000);

  if (catalogoAlLlegar === 0) {
    await query('DELETE FROM sat_codigos_agrupadores');
  }

  // Y los usuarios de este fixture se DAN DE BAJA. `doctor` tiene comprobaciones
  // de INSTALACIÓN que leen `users` sin acotar por inquilino y sí por
  // `is_active` —el informe de permisos en conflicto es una—, así que cada
  // inquilino desechable que un archivo deja vivo engorda un informe que otro
  // archivo mide. Baja lógica y no DELETE: `audit_log` es de sólo agregar y
  // media base referencia al autor.
  await query('UPDATE users SET is_active = false WHERE id = ANY($1::uuid[])', [
    [f.userId, hermana.userId],
  ]);

  await closeDatabase();
});

// ============================================================
// A · LA BALANZA: LAS CUENTAS QUE EL ANEXO 24 NO PUEDE PERDER
// ============================================================

describe('A1 · la cuenta que se movió ANTES del periodo y no dentro', () => {
  it('sale en la balanza con SaldoIni y sin movimiento, no desaparece', async () => {
    // 5100 movió 1 700 en enero y NADA en febrero. En la balanza de febrero
    // tiene que aparecer igual: el SAT recalcula SaldoIni + Debe − Haber sobre
    // el nodo Ctas, y una cuenta ausente no es una cuenta en cero — es una
    // cuenta que el archivo sellado niega tener.
    const tb = await getTrialBalance(f.entityId, { fiscalPeriodId: f.periodos[2] });
    expect(cuatro(tb, '5100')).toEqual({
      ini: '1700.0000', debe: '0.0000', haber: '0.0000', fin: '1700.0000',
    });
  });

  it('y sobrevive a --exclude-zero, que es donde se perdía', async () => {
    // El filtro miraba `ending_balance`, que para un RANGO es el movimiento
    // neto del rango: en 5100 vale cero en febrero. Recortar por ahí borra del
    // Anexo 24 justo la cuenta con saldo arrastrado y sin actividad, que es la
    // más común en un balance.
    const tb = await getTrialBalance(f.entityId, {
      fiscalPeriodId: f.periodos[2],
      excludeZero: true,
    });
    expect(new Decimal(fila(tb, '5100').ending_balance).toFixed(LEDGER)).toBe('0.0000');
    expect(cuatro(tb, '5100').ini).toBe('1700.0000');
  });
});

describe('A2 · la cuenta nacida A MITAD del periodo', () => {
  it('sale con inicial cero de verdad, y el invariante se cumple', async () => {
    const tb = await getTrialBalance(f.entityId, { fiscalPeriodId: f.periodos[2] });
    expect(cuatro(tb, '1195')).toEqual({
      ini: '0.0000', debe: '320.0000', haber: '0.0000', fin: '320.0000',
    });
    expect(fila(tb, '1195').cuadra).toBe(true);
  });

  it('las cuatro columnas de las otras tres cuentas siguen siendo las del ejercicio', async () => {
    const tb = await getTrialBalance(f.entityId, { fiscalPeriodId: f.periodos[2] });
    expect(cuatro(tb, '1120')).toEqual({
      ini: '4700.0000', debe: '900.0000', haber: '0.0000', fin: '5600.0000',
    });
    // El ingreso es ACREEDOR: negativo en la convención deudor-positiva.
    expect(cuatro(tb, '4100')).toEqual({
      ini: '-6400.0000', debe: '0.0000', haber: '1220.0000', fin: '-7620.0000',
    });
    expect(tb.inicial!.descuadres).toEqual([]);
  });
});

describe('A3 · el periodo ANTERIOR está ABIERTO', () => {
  it('la cifra es CALCULABLE y NO es firme, y el informe dice las dos cosas', async () => {
    // Ni suave ni duro: enero sigue admitiendo posteos. El inicial de febrero
    // es correcto HOY y puede ser otro mañana, y eso no se firma como si fuera
    // definitivo. Es la distinción que un cero por ausencia de arrastre no
    // podía ni plantear.
    const tb = await getTrialBalance(f.entityId, { fiscalPeriodId: f.periodos[2] });
    expect(tb.inicial!.firme).toBe(false);
    expect(tb.inicial!.periodo_anterior).toEqual({
      period_name: 'Periodo 1/2026',
      status: 'open',
    });
    expect(tb.inicial!.note).toMatch(/Computable but NOT firm: Periodo 1\/2026 is 'open'/);
  });

  it('ENERO no tiene un ANTES dentro del ejercicio: se dice, no se inventa un cero', async () => {
    const tb = await getTrialBalance(f.entityId, { fiscalPeriodId: f.periodos[1] });
    expect(tb.inicial!.periodo_anterior).toBeNull();
    expect(tb.inicial!.firme).toBe(false);
    expect(tb.inicial!.note).toMatch(/No earlier fiscal period/);
    expect(cuatro(tb, '1120')).toEqual({
      ini: '0.0000', debe: '6400.0000', haber: '1700.0000', fin: '4700.0000',
    });
  });
});

describe('A4 · un rango por FECHAS, no por periodo fiscal', () => {
  it('también trae las cuatro columnas y también cuadra', async () => {
    // La CLI usa --since/--until y el REST no lo expone: si el saldo inicial
    // sólo saliera por `fiscalPeriodId`, media superficie se quedaría en tres
    // columnas sin que nada lo dijera.
    const tb = await getTrialBalance(f.entityId, {
      sinceDate: '2026-02-01',
      untilDate: '2026-02-28',
    });
    expect(tb.inicial).toBeDefined();
    expect(tb.inicial!.desde).toBe('2026-02-01');
    expect(cuatro(tb, '1120')).toEqual({
      ini: '4700.0000', debe: '900.0000', haber: '0.0000', fin: '5600.0000',
    });
    for (const r of tb.rows) expect(r.cuadra, `descuadre en ${r.account_code}`).toBe(true);
  });

  it('un rango que EMPIEZA a mitad de mes parte el mes por la fecha, no por el periodo', async () => {
    // Desde el 15 de febrero, la venta del 10 pasa a ser INICIAL y el deudor
    // del 20 sigue siendo movimiento. Si el inicial se calculara con el primer
    // día del periodo fiscal en vez de con el de la consulta, 1120 saldría con
    // 4 700 y 900 al debe.
    const tb = await getTrialBalance(f.entityId, {
      sinceDate: '2026-02-15',
      untilDate: '2026-02-28',
    });
    expect(cuatro(tb, '1120')).toEqual({
      ini: '5600.0000', debe: '0.0000', haber: '0.0000', fin: '5600.0000',
    });
    expect(cuatro(tb, '1195')).toEqual({
      ini: '0.0000', debe: '320.0000', haber: '0.0000', fin: '320.0000',
    });
  });
});

describe('A5 · la frontera de entidad en el acumulado', () => {
  beforeAll(async () => {
    // La hermana mueve SUS cuentas, con importes que no se parecen a los de A.
    await asiento(hermana, '2026-01-12', 'Venta de la hermana',
      hermana.cuentas['1120'], hermana.cuentas['4100'], '5150.0000');
    await asiento(hermana, '2026-02-12', 'Venta de la hermana',
      hermana.cuentas['1120'], hermana.cuentas['4100'], '2050.0000');
  });

  it('el acumulado de A no contiene una sola cuenta de B', async () => {
    // Mismo inquilino, otra entidad legal: el eje que RLS NO defiende, porque
    // su predicado es el inquilino. Sin el `WHERE a.entity_id` dentro del SQL
    // el saldo inicial de A llevaría el mayor de B encima.
    const acum = await queryAccumulatedBalances(f.entityId, { date: '2026-02-01', inclusive: false });
    const deB = new Set(Object.values(hermana.cuentas));
    expect(acum.filter((r) => deB.has(r.account_id))).toEqual([]);
    expect(
      new Decimal(acum.find((r) => r.account_id === f.cuentas['1120'])!.balance).toFixed(LEDGER)
    ).toBe('4700.0000');
  });

  it('y la balanza de B tiene su propio inicial, no el de A', async () => {
    const tb = await getTrialBalance(hermana.entityId, { fiscalPeriodId: hermana.periodos[2] });
    expect(cuatro(tb, '1120')).toEqual({
      ini: '5150.0000', debe: '2050.0000', haber: '0.0000', fin: '7200.0000',
    });
  });
});

// ============================================================
// A6 · LAS TRES SUPERFICIES
//
// El servicio calcula las cuatro columnas. La pregunta que decide si F07a
// sirve para algo es OTRA: ¿sale la cuarta por algún sitio? Una columna que
// nadie publica no existe para el despacho que tiene que entregar el archivo,
// y peor: `descuadres` es la comprobación que el SAT va a rehacer, y si se
// calcula y se tira, la balanza se imprime con cara de correcta.
// ============================================================

/** El programa real de la CLI, hablándole por argv y capturando sus dos salidas. */
async function cli(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  let out = '';
  let err = '';
  let code = -1;
  const plano = {
    dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
    red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
  };
  const program = new Command();
  program.exitOverride();
  registerReportCommand(program, {
    palette: plano,
    shutdown: (c: number) => { code = c; },
    reportError: (e: unknown) => { err += `${(e as Error).message}\n`; },
  });
  const spyOut = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += String(s); return true; });
  const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += String(s); return true; });
  try {
    await program.parseAsync(['node', 'mnemosine', 'report', ...argv]);
  } finally {
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
  return { out, err, code };
}

describe('A6 · la cuarta columna en las tres superficies', () => {
  let s: Servidor;

  beforeAll(async () => {
    s = await levantar([['/', reportsRouter]], sesionDe(f));
  });

  afterAll(async () => {
    await s.cerrar();
  });

  it('CLI · `report trial-balance show --period 2026-02` publica SaldoIni y SaldoFin', async () => {
    const r = await cli(
      'trial-balance', 'show',
      '--entity', f.entityId, '--tenant', f.tenantId,
      '--period', '2026-02', '--json'
    );
    expect(r.code, `la CLI falló: ${r.err}`).toBe(0);
    const sobre = JSON.parse(r.out) as { rows: Array<Record<string, string>> };
    const c1120 = sobre.rows.find((x) => x.account_code === '1120');
    expect(c1120, 'la CLI no trae la 1120').toBeDefined();
    expect(new Decimal(c1120!.beginning_balance).toFixed(LEDGER)).toBe('4700.0000');
    expect(new Decimal(c1120!.final_balance).toFixed(LEDGER)).toBe('5600.0000');
  });

  it('CLI · y dice de dónde salió el inicial y si es firme, como ya hace con el cierre', async () => {
    const r = await cli(
      'trial-balance', 'show',
      '--entity', f.entityId, '--tenant', f.tenantId,
      '--period', '2026-02', '--json'
    );
    expect(r.err).toMatch(/Opening balance derived from the ledger/);
    expect(r.err).toMatch(/NOT firm/);
  });

  it('REST/JSON · las filas llevan las dos columnas nuevas', async () => {
    const r = await pedir(s, 'GET',
      `/trial-balance?entity_id=${f.entityId}&fiscal_period_id=${f.periodos[2]}`);
    expect(r.status).toBe(200);
    const cuentas = (r.body as { data: { accounts: Array<Record<string, string>> } }).data.accounts;
    const c1120 = cuentas.find((x) => x.account_code === '1120');
    expect(new Decimal(c1120!.beginning_balance).toFixed(LEDGER)).toBe('4700.0000');
    expect(new Decimal(c1120!.final_balance).toFixed(LEDGER)).toBe('5600.0000');
  });

  it('REST/JSON · y el sobre trae la procedencia del inicial y sus descuadres', async () => {
    // `closing` ya viaja en el sobre por esta misma razón: la cifra sin su
    // nota no se puede atar contra nada. El inicial tiene además la lista de
    // cuentas que NO pasan el recálculo del SAT, que es el dato por el que se
    // rechaza una entrega.
    const r = await pedir(s, 'GET',
      `/trial-balance?entity_id=${f.entityId}&fiscal_period_id=${f.periodos[2]}`);
    const data = (r.body as { data: Record<string, unknown> }).data;
    expect(data.opening_balance, 'el sobre no publica el aviso del saldo inicial').toBeDefined();
    expect((data.opening_balance as { origen: string }).origen).toBe('mayor');
    expect((data.opening_balance as { firme: boolean }).firme).toBe(false);
    expect((data.opening_balance as { descuadres: unknown[] }).descuadres).toEqual([]);
  });

  it('REST/CSV · las columnas fijas incluyen las dos nuevas', async () => {
    // El CSV es el formato con el que un despacho arma el papel de trabajo del
    // Anexo 24. Sus columnas son una tupla literal: una columna que el
    // servicio calcula y la tupla no nombra se cae en silencio.
    const resp = await fetch(
      `${s.url}/trial-balance?entity_id=${f.entityId}&fiscal_period_id=${f.periodos[2]}&format=csv`
    );
    expect(resp.status).toBe(200);
    const csv = await resp.text();
    const cabecera = csv.split('\n')[0];
    expect(cabecera).toContain('beginning_balance');
    expect(cabecera).toContain('final_balance');
    // La primera columna es `account_id`, un uuid: la cuenta se busca por su
    // celda de codigo, no por el principio de la linea.
    const linea1120 = csv.split('\r\n').find((l) => l.split(',')[1] === '1120');
    expect(linea1120, 'el CSV no trae la 1120').toBeDefined();
    expect(linea1120).toContain('4700.0000');
    expect(linea1120).toContain('5600.0000');
  });
});

describe('A7 · el AGENTE y la CLI no pueden discrepar sobre la misma pregunta', () => {
  it('la balanza acumulada del agente da las mismas cifras que el servicio', async () => {
    // `get_trial_balance` NO pasa por getTrialBalance: llama a
    // queryTrialBalanceRows por su cuenta. Mientras sólo sepa preguntar por un
    // corte acumulado —donde no hay un ANTES y por tanto no hay cuarta
    // columna— las dos lecturas tienen que coincidir cifra por cifra, o el
    // sistema contesta distinto según quién lo corra.
    // El contexto se RESUELVE contra la base, no se fabrica: es el mismo que
    // arma la sesión del agente, y un doble aquí daría por bueno justo el
    // borde que se está midiendo.
    const herramientas = buildReportTools(await resolveEntity(f.entityId));
    const tool = herramientas.find((t) => t.name === 'get_trial_balance');
    expect(tool, 'el agente perdió get_trial_balance').toBeDefined();

    const crudo = await (tool as unknown as {
      run: (i: Record<string, unknown>) => Promise<string>;
    }).run({ as_of_date: '2026-02-28' });
    const visto = JSON.parse(crudo) as { accounts: Array<Record<string, string>> };
    const delAgente = visto.accounts.find((a) => a.account_code === '1120');

    const tb = await getTrialBalance(f.entityId, { asOfDate: '2026-02-28' });
    expect(new Decimal(delAgente!.ending_balance).toFixed(LEDGER)).toBe(
      new Decimal(fila(tb, '1120').ending_balance).toFixed(LEDGER)
    );
    expect(new Decimal(delAgente!.ending_balance).toFixed(LEDGER)).toBe('5600.0000');
    // Y la acumulada NO tiene cuarta columna en ninguna de las dos: es la
    // única forma honesta de que coincidan.
    expect(tb.inicial).toBeUndefined();
    expect(delAgente).not.toHaveProperty('beginning_balance');
  });
});

describe('A8 · el invariante del SAT roto A PROPÓSITO desde account_balances', () => {
  beforeAll(async () => {
    await seedPolicies({ tenantId: f.tenantId });
    await resolvePolicy(
      { tenantId: f.tenantId },
      'anexo24_balanza_saldo_inicial',
      'exigir_cierre_duro',
      f.userId,
      'ataque F07a: forzar el origen que sí se puede corromper'
    );
    // La aguja. `beginning_balance` es la ÚNICA fuente que un tercero puede
    // escribir sin pasar por el mayor —la siembra el cierre duro, y aquí se
    // simula un arrastre corrompido—: si la balanza no sabe acusar esto, la
    // comprobación que el SAT rehace no existe de este lado.
    await query(
      `UPDATE account_balances SET beginning_balance = $3
        WHERE entity_id = $1 AND fiscal_period_id = $2 AND account_id = $4`,
      [f.entityId, f.periodos[2], '9999.0000', f.cuentas['1120']]
    );
  });

  afterAll(async () => {
    await query(
      `UPDATE account_balances SET beginning_balance = 0
        WHERE entity_id = $1 AND fiscal_period_id = $2 AND account_id = $3`,
      [f.entityId, f.periodos[2], f.cuentas['1120']]
    );
    // Se devuelve a PENDIENTE por SQL y no con resolvePolicy: una decisión
    // sólo se resuelve una vez, que es justo la regla que A7 del panel
    // defiende. Aquí no se prueba el panel, se desarma el escenario.
    await query(
      `UPDATE policy_decisions SET status = 'pending', resolved_value = NULL
        WHERE tenant_id = $1 AND entity_id IS NULL AND key = $2`,
      [f.tenantId, 'anexo24_balanza_saldo_inicial']
    );
  });

  it('la cuenta se SEÑALA con su diferencia en vez de absorberse', async () => {
    const tb = await getTrialBalance(f.entityId, { fiscalPeriodId: f.periodos[2] });
    expect(tb.inicial!.origen).toBe('arrastre_del_cierre');
    expect(fila(tb, '1120').cuadra).toBe(false);

    // 9 999 + 900 − 0 = 10 899 declarado contra 5 600 en el mayor.
    const d = tb.inicial!.descuadres.find((x) => x.account_code === '1120');
    expect(d, 'la cuenta con el arrastre corrompido no aparece señalada').toBeDefined();
    expect(d).toMatchObject({
      esperado: '10899.0000',
      obtenido: '5600.0000',
      diferencia: '5299.0000',
    });
  });

  it('y la señal llega hasta el CSV y hasta el sobre del REST, no muere en el servicio', async () => {
    const s = await levantar([['/', reportsRouter]], sesionDe(f));
    try {
      const r = await pedir(s, 'GET',
        `/trial-balance?entity_id=${f.entityId}&fiscal_period_id=${f.periodos[2]}`);
      const data = (r.body as { data: { opening_balance: { descuadres: Array<{ account_code: string }> } } }).data;
      expect(data.opening_balance.descuadres.map((x) => x.account_code)).toContain('1120');

      const resp = await fetch(
        `${s.url}/trial-balance?entity_id=${f.entityId}&fiscal_period_id=${f.periodos[2]}&format=csv`
      );
      const linea = (await resp.text()).split('\r\n').find((l) => l.split(',')[1] === '1120');
      // El CSV publica las CUATRO cifras tal como están: es el papel de
      // trabajo, y ahí el descuadre tiene que poder verse restando a mano.
      expect(linea).toContain('9999.0000');
      expect(linea).toContain('5600.0000');
    } finally {
      await s.cerrar();
    }
  });

  it('la CLI nombra la cuenta descuadrada, no sólo la cuenta cuántas hay', async () => {
    const r = await cli(
      'trial-balance', 'show',
      '--entity', f.entityId, '--tenant', f.tenantId,
      '--period', '2026-02', '--json'
    );
    expect(r.code, `la CLI falló: ${r.err}`).toBe(0);
    expect(r.err).toMatch(/does not give SaldoFin/);
    expect(r.err).toContain('1120 (5299.0000)');
  });
});

// ============================================================
// B · EL AGRUPADOR
//
// El orden de los bloques NO es cosmético: la compuerta se mide ANTES de
// mapear nada, porque mapear una cuenta cambia la población que la compuerta
// reporta y una prueba que corriera después mediría el escenario de la
// anterior.
// ============================================================

/** El agrupador que hay hoy en las dos casillas de una cuenta. */
async function casillasDe(accountId: string): Promise<{
  agrupador: string | null;
  nif: string | null;
  ifrs: string | null;
}> {
  const r = await query<{ codigo_agrupador_sat: string | null; mx_nif_code: string | null; ifrs_code: string | null }>(
    'SELECT codigo_agrupador_sat, mx_nif_code, ifrs_code FROM accounts WHERE id = $1',
    [accountId]
  );
  return {
    agrupador: r.rows[0].codigo_agrupador_sat,
    nif: r.rows[0].mx_nif_code,
    ifrs: r.rows[0].ifrs_code,
  };
}

describe('B1 · la compuerta falla hoy en las DOS direcciones, o no falla', () => {
  it('reporta las cuentas CON movimiento sin agrupador, y sólo ésas', async () => {
    const c = await checkMappingCoverageDetallada(f.entityId, 'sat-agrupador', {
      tenantId: f.tenantId,
    });
    expect(c.alcance).toBe('cuentas_con_movimientos');
    // Cuatro cuentas movidas y ninguna mapeada todavía.
    expect(c.poblacion).toBe(4);
    expect(c.huecos.map((h) => h.code).sort()).toEqual(['1120', '1195', '4100', '5100']);
    for (const h of c.huecos) expect(h.lineas_posteadas).toBeGreaterThan(0);
  });

  it('DIRECCIÓN 1 · la 1120 vive en el nivel 3, y el filtro viejo la dejaba fuera', async () => {
    // El defecto exacto: `account_level <= 2` silenciaba la única cuenta que
    // sí se había movido sin agrupador. Que su nivel sea > 2 es lo que hace
    // que esta prueba pruebe algo.
    const c = await checkMappingCoverageDetallada(f.entityId, 'sat-agrupador', {
      tenantId: f.tenantId,
    });
    const h1120 = c.huecos.find((h) => h.code === '1120');
    expect(h1120, 'la cuenta movida sin agrupador no se reporta').toBeDefined();
    expect(h1120!.account_level).toBeGreaterThan(2);
  });

  it('DIRECCIÓN 2 · 1000 y 1100 no se han movido nunca, y ya no se acusan', async () => {
    // Son de nivel 1 y 2, activas y sin agrupador: el filtro viejo las metía
    // en la lista, y eran 42 de los 43 huecos que la sonda encontró. Ruido
    // donde no hay riesgo: el SAT no lee una cuenta que nadie usó.
    const niveles = await query<{ code: string; account_level: number }>(
      `SELECT code, account_level FROM accounts
        WHERE entity_id = $1 AND code IN ('1000','1100') ORDER BY code`,
      [f.entityId]
    );
    expect(niveles.rows.map((r) => r.account_level)).toEqual([1, 2]);

    const c = await checkMappingCoverageDetallada(f.entityId, 'sat-agrupador', {
      tenantId: f.tenantId,
    });
    expect(c.huecos.map((h) => h.code)).not.toContain('1000');
    expect(c.huecos.map((h) => h.code)).not.toContain('1100');
  });

  it('y con el alcance "todas" SÍ salen: es la población, no un olvido', async () => {
    // La contra-demostración. Si 1000 y 1100 no salieran tampoco aquí, lo que
    // se habría arreglado es la mitad ruidosa rompiendo la otra.
    const c = await checkMappingCoverageDetallada(f.entityId, 'sat-agrupador', {
      tenantId: f.tenantId,
      alcance: 'todas',
    });
    expect(c.poblacion).toBeGreaterThan(4);
    expect(c.huecos.map((h) => h.code)).toContain('1000');
    expect(c.huecos.map((h) => h.code)).toContain('1100');
    // Y las de nivel 1 y 2 salen con CERO líneas posteadas: la lista dice por
    // sí sola cuáles urgen.
    expect(c.huecos.find((h) => h.code === '1000')!.lineas_posteadas).toBe(0);
  });
});

describe('B2 · FRONTERA DE ENTIDAD en la compuerta (serie TEN)', () => {
  it('la compuerta de A no ve una sola cuenta ni un solo movimiento de B', async () => {
    // Mismo inquilino, dos entidades legales: RLS no acota nada aquí porque su
    // predicado es el inquilino. La entidad tiene que ir DENTRO del SQL en las
    // DOS tablas —la cuenta y el asiento—, y B tiene cuentas con los mismos
    // códigos que A.
    const a = await checkMappingCoverageDetallada(f.entityId, 'sat-agrupador', {
      tenantId: f.tenantId,
    });
    const b = await checkMappingCoverageDetallada(hermana.entityId, 'sat-agrupador', {
      tenantId: hermana.tenantId,
    });
    const idsDeB = new Set(Object.values(hermana.cuentas));
    expect(a.huecos.filter((h) => idsDeB.has(h.account_id))).toEqual([]);
    // B movió sólo 1120 y 4100: su población es 2, no las 4 de A.
    expect(b.poblacion).toBe(2);
    expect(b.huecos.map((h) => h.code).sort()).toEqual(['1120', '4100']);
  });

  it('mapear en B no descuenta un hueco de A', async () => {
    await setAccountMapping(hermana.cuentas['1120'], 'sat-agrupador', '105.01', hermana.userId);
    const a = await checkMappingCoverageDetallada(f.entityId, 'sat-agrupador', {
      tenantId: f.tenantId,
    });
    expect(a.huecos.map((h) => h.code)).toContain('1120');
    expect(a.poblacion).toBe(4);
    const b = await checkMappingCoverageDetallada(hermana.entityId, 'sat-agrupador', {
      tenantId: hermana.tenantId,
    });
    expect(b.huecos.map((h) => h.code)).toEqual(['4100']);
  });
});

// ------------------------------------------------------------
// B3..B7 · EL CATÁLOGO OFICIAL
//
// La tabla es GLOBAL y la siembra es idempotente por (codigo, vigente_desde),
// así que este bloque la siembra él mismo: correr este archivo solo tiene que
// demostrar lo mismo que correrlo dentro de la suite.
// ------------------------------------------------------------

/** Un agrupador RETIRADO: existió y dejó de existir. La vigencia es el dato. */
const RETIRADO = '199.99';

describe('B3 · el código que NO está en el catálogo', () => {
  beforeAll(async () => {
    const r = await sembrarCatalogoAgrupadores();
    expect(r.ofrecidos).toBeGreaterThan(1000);
    // El agrupador retirado, con su ventana cerrada. No se inventa un dato
    // del SAT: se fabrica un caso de VIGENCIA, que es lo que se prueba.
    await query(
      `INSERT INTO sat_codigos_agrupadores
         (codigo, nombre, nivel, codigo_padre, naturaleza, vigente_desde, vigente_hasta)
       VALUES ($1, 'Agrupador retirado en 2019', 2, '199', NULL, '2015-01-01', '2019-12-31')
       ON CONFLICT DO NOTHING`,
      [RETIRADO]
    );
  });

  afterAll(async () => {
    await query('DELETE FROM sat_codigos_agrupadores WHERE codigo = $1', [RETIRADO]);
  });

  it('hay catálogo para 2026, así que la comprobación puede contestar que no', async () => {
    expect(await hayCatalogoVigente('2026-06-30')).toBe(true);
  });

  it('un código inventado se RECHAZA nombrándolo, y no se escribe nada', async () => {
    const antes = await casillasDe(f.cuentas['1120']);
    await expect(
      setAccountMapping(f.cuentas['1120'], 'sat-agrupador', '999.99', f.userId, {
        fecha: '2026-06-30',
      })
    ).rejects.toThrow(ValidationError);
    await expect(
      setAccountMapping(f.cuentas['1120'], 'sat-agrupador', '999.99', f.userId, {
        fecha: '2026-06-30',
      })
    ).rejects.toThrow(/"999\.99"/);
    // El rechazo tiene que ser ANTES del UPDATE, no un rollback contado.
    expect(await casillasDe(f.cuentas['1120'])).toEqual(antes);
  });

  it('un código real del c_CodAgrup se acepta y aterriza en SU casilla', async () => {
    await setAccountMapping(f.cuentas['1120'], 'sat-agrupador', '105.01', f.userId, {
      fecha: '2026-06-30',
    });
    const c = await casillasDe(f.cuentas['1120']);
    expect(c.agrupador).toBe('105.01');
    // LA MUDANZA DE LA 063: la casilla de PRESENTACIÓN no se toca. Era el
    // cisma —el agrupador FISCAL viviendo en la casilla de la norma contable—
    // y el día que una entidad necesitara las dos, una pisaba a la otra.
    expect(c.nif).toBeNull();
  });

  it('y el esquema de la NORMA CONTABLE no toca el agrupador FISCAL', async () => {
    await setAccountMapping(f.cuentas['1120'], 'ifrs', 'IAS-1.54(h)', f.userId);
    const c = await casillasDe(f.cuentas['1120']);
    expect(c.ifrs).toBe('IAS-1.54(h)');
    expect(c.agrupador).toBe('105.01');
    expect(c.nif).toBeNull();
  });
});

describe('B4 · LA VIGENCIA: el mismo código, bueno en un ejercicio y malo en otro', () => {
  beforeAll(async () => {
    await sembrarCatalogoAgrupadores();
    await query(
      `INSERT INTO sat_codigos_agrupadores
         (codigo, nombre, nivel, codigo_padre, naturaleza, vigente_desde, vigente_hasta)
       VALUES ($1, 'Agrupador retirado en 2019', 2, '199', NULL, '2015-01-01', '2019-12-31')
       ON CONFLICT DO NOTHING`,
      [RETIRADO]
    );
  });

  afterAll(async () => {
    await query('DELETE FROM sat_codigos_agrupadores WHERE codigo = $1', [RETIRADO]);
  });

  it('en 2018 el catálogo lo tiene: se acepta', async () => {
    const ctxVal = await prepararValidacionAgrupador(
      { tenantId: f.tenantId, entityId: f.entityId },
      '2018-06-30'
    );
    const v = await validarCodigoAgrupador(ctxVal, RETIRADO);
    expect(v.veredicto).toBe('valido');
    expect(v.accion).toBe('aceptar');
    expect(v.nombre).toBe('Agrupador retirado en 2019');
  });

  it('en 2026 su ventana ya cerró: se RECHAZA, aunque el código exista en la tabla', async () => {
    // El fallo que esto caza: buscar el código sin mirar la vigencia. La fila
    // está ahí; lo que no cubre la fecha del ejercicio es su ventana, y una
    // balanza se valida contra el catálogo VIGENTE en su ejercicio.
    const ctxVal = await prepararValidacionAgrupador(
      { tenantId: f.tenantId, entityId: f.entityId },
      '2026-06-30'
    );
    const v = await validarCodigoAgrupador(ctxVal, RETIRADO);
    expect(v.veredicto).toBe('fuera_de_catalogo');
    expect(v.accion).toBe('rechazar');
    expect(v.aviso).toContain(RETIRADO);
    expect(v.aviso).toContain('2026-06-30');
  });

  it('y el rechazo por vigencia llega hasta la escritura, no se queda en el veredicto', async () => {
    const antes = await casillasDe(f.cuentas['5100']);
    await expect(
      setAccountMapping(f.cuentas['5100'], 'sat-agrupador', RETIRADO, f.userId, {
        fecha: '2026-06-30',
      })
    ).rejects.toThrow(ValidationError);
    expect(await casillasDe(f.cuentas['5100'])).toEqual(antes);

    // Y el MISMO código, con el MISMO comando, contra el ejercicio en que sí
    // estaba vigente: entra.
    await setAccountMapping(f.cuentas['5100'], 'sat-agrupador', RETIRADO, f.userId, {
      fecha: '2018-06-30',
    });
    expect((await casillasDe(f.cuentas['5100'])).agrupador).toBe(RETIRADO);
  });
});

describe('B5 · el catálogo VACÍO para ese ejercicio', () => {
  beforeAll(async () => {
    await sembrarCatalogoAgrupadores();
  });

  it('ni acepta en silencio ni rechaza todo: lo dice, y nombra la causa real', async () => {
    // 2012 es anterior a cualquier vigencia sembrada. No hay catálogo que
    // rechace nada, así que rechazar sería contestar por un catálogo que no
    // existe —y con el mensaje equivocado: «ese código no existe» cuando el
    // que no existe es el catálogo—.
    expect(await hayCatalogoVigente('2012-06-30')).toBe(false);
    const ctxVal = await prepararValidacionAgrupador(
      { tenantId: f.tenantId, entityId: f.entityId },
      '2012-06-30'
    );
    const v = await validarCodigoAgrupador(ctxVal, '999.99');
    expect(v.veredicto).toBe('sin_catalogo');
    expect(v.accion).toBe('aceptar_con_aviso');
    expect(v.aviso).toMatch(/SIN VALIDAR/);
    expect(v.aviso).toContain('2012-06-30');
  });

  it('el aviso LLEGA al llamador y el valor se guarda: avisar no es tragar', async () => {
    const avisos: string[] = [];
    await setAccountMapping(f.cuentas['4100'], 'sat-agrupador', 'XX.99', f.userId, {
      fecha: '2012-06-30',
      onAviso: (r) => avisos.push(r.aviso ?? ''),
    });
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/no está sembrado para 2012-06-30/);
    expect((await casillasDe(f.cuentas['4100'])).agrupador).toBe('XX.99');
  });

  it('CON LA TABLA ENTERA VACÍA hace exactamente lo mismo, y se restaura', async () => {
    // El caso literal del enunciado. Se hace al final del bloque y con
    // finally: la tabla es GLOBAL y vaciarla es visible para todo el proceso.
    await query('DELETE FROM sat_codigos_agrupadores');
    try {
      expect(await hayCatalogoVigente('2026-06-30')).toBe(false);
      const ctxVal = await prepararValidacionAgrupador(
        { tenantId: f.tenantId, entityId: f.entityId },
        '2026-06-30'
      );
      const v = await validarCodigoAgrupador(ctxVal, '105.01');
      // Ni 'valido' (aceptar en silencio algo que nadie miró) ni
      // 'fuera_de_catalogo' (rechazar contra la nada).
      expect(v.veredicto).toBe('sin_catalogo');
      expect(v.accion).toBe('aceptar_con_aviso');
      expect(v.aviso).toMatch(/Siembra el c_CodAgrup/);
    } finally {
      const r = await sembrarCatalogoAgrupadores();
      expect(r.insertados).toBe(r.ofrecidos);
    }
  });
});

describe('B6 · el catálogo GLOBAL: quién lo lee y quién lo puede engordar', () => {
  it('no lleva inquilino ni entidad, y las dos entidades leen las MISMAS filas', async () => {
    // Global a propósito (lo dice el COMMENT de la 063): el c_CodAgrup es un
    // hecho publicado por la autoridad, no un dato del inquilino. Que no tenga
    // las columnas de alcance es lo que sostiene que su lector no las filtre.
    const cols = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'sat_codigos_agrupadores'`
    );
    const nombres = cols.rows.map((c) => c.column_name);
    expect(nombres).not.toContain('tenant_id');
    expect(nombres).not.toContain('entity_id');

    const enA = await prepararValidacionAgrupador(
      { tenantId: f.tenantId, entityId: f.entityId }, '2026-06-30');
    const enB = await prepararValidacionAgrupador(
      { tenantId: hermana.tenantId, entityId: hermana.entityId }, '2026-06-30');
    expect(enA.hayCatalogo).toBe(true);
    expect(enB.hayCatalogo).toBe(true);
    expect((await validarCodigoAgrupador(enA, '105.01')).nombre)
      .toBe((await validarCodigoAgrupador(enB, '105.01')).nombre);
  });

  it('la escritura de un inquilino NO puede engordar el catálogo de todos', async () => {
    // La comprobación que importa del lado del código: el único camino por el
    // que un usuario toca el agrupador es `setAccountMapping`, y un código que
    // el catálogo no conoce se RECHAZA — no se da de alta sobre la marcha.
    // Un validador que aprendiera del dato que valida no valida nada.
    const antes = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM sat_codigos_agrupadores');
    await expect(
      setAccountMapping(cuenta1195, 'sat-agrupador', '777.77', f.userId, {
        fecha: '2026-06-30',
      })
    ).rejects.toThrow(ValidationError);
    const despues = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM sat_codigos_agrupadores');
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
  });
});

describe('B7 · la mudanza de la 063, replicada sobre datos', () => {
  it('mueve el agrupador de la casilla vieja a la suya sin perderlo', async () => {
    // La 063 ya corrió sobre esta base, así que lo que se replica es su
    // sentencia sobre una fila nueva: es la única forma de probar que la
    // condición hace lo que promete y no lo contrario.
    const previa = await createAccount({
      code: '1196', name: 'Cuenta con agrupador de antes de la 063',
      account_type: 'asset', account_subtype: 'current_asset',
      fs_category: 'current_assets', parent_id: f.cuentas['1100'],
      entity_id: f.entityId, normal_balance: 'debit', created_by: f.userId,
    });
    await query('UPDATE accounts SET mx_nif_code = $2 WHERE id = $1', [previa.id, '105.01']);

    await query(
      `UPDATE accounts SET codigo_agrupador_sat = mx_nif_code
        WHERE id = $1 AND mx_nif_code IS NOT NULL AND codigo_agrupador_sat IS NULL`,
      [previa.id]
    );
    expect((await casillasDe(previa.id)).agrupador).toBe('105.01');
  });

  it('y NO pisa el que ya estuviera en su sitio: la verdad más reciente gana', async () => {
    const ambas = await createAccount({
      code: '1197', name: 'Cuenta con las dos casillas escritas',
      account_type: 'asset', account_subtype: 'current_asset',
      fs_category: 'current_assets', parent_id: f.cuentas['1100'],
      entity_id: f.entityId, normal_balance: 'debit', created_by: f.userId,
    });
    await query(
      'UPDATE accounts SET mx_nif_code = $2, codigo_agrupador_sat = $3 WHERE id = $1',
      [ambas.id, '105.01', '102.01']
    );
    await query(
      `UPDATE accounts SET codigo_agrupador_sat = mx_nif_code
        WHERE id = $1 AND mx_nif_code IS NOT NULL AND codigo_agrupador_sat IS NULL`,
      [ambas.id]
    );
    expect((await casillasDe(ambas.id)).agrupador).toBe('102.01');
  });
});

// ============================================================
// C · EL AGRUPADOR DESDE LA TERMINAL, CONTRA LA BASE DE VERDAD
//
// `account map set --year` y `account map check` son la superficie por la que
// un despacho hace este trabajo. Las pruebas de tests/cli/ los ejercitan con
// dobles del servicio: prueban que la CLI llama bien, no que el conjunto
// conteste bien. Aquí no hay dobles.
// ============================================================

/** El programa real de `account`, hablándole por argv. */
async function cliCuenta(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const { registerAccountCommand } = await import('../../src/cli/account-command.js');
  let out = '';
  let err = '';
  let code = -1;
  const plano = {
    dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
    red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
  };
  const program = new Command();
  program.exitOverride();
  registerAccountCommand(program, {
    palette: plano,
    shutdown: (c: number) => { code = c; },
    reportError: (e: unknown) => { err += `${(e as Error).message}\n`; },
  });
  const spyOut = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += String(s); return true; });
  const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += String(s); return true; });
  try {
    await program.parseAsync(['node', 'mnemosine', 'account', ...argv]);
  } finally {
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
  return { out, err, code };
}

describe('C · `account map` contra Postgres', () => {
  let correo: string;

  beforeAll(async () => {
    await sembrarCatalogoAgrupadores();
    await query(
      `INSERT INTO sat_codigos_agrupadores
         (codigo, nombre, nivel, codigo_padre, naturaleza, vigente_desde, vigente_hasta)
       VALUES ($1, 'Agrupador retirado en 2019', 2, '199', NULL, '2015-01-01', '2019-12-31')
       ON CONFLICT DO NOTHING`,
      [RETIRADO]
    );
    // El inquilino tiene dos usuarios (la entidad y su hermana), así que el
    // autor se declara: sin --user, resolveReviewer no puede elegir por
    // nosotros, y eso está bien.
    const u = await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [f.userId]);
    correo = u.rows[0].email;
  });

  afterAll(async () => {
    await query('DELETE FROM sat_codigos_agrupadores WHERE codigo = $1', [RETIRADO]);
  });

  it('--year 2026 sobre un agrupador retirado: el ENSAYO ya rechaza', async () => {
    // «validate and report, without writing» tiene que correr la MISMA
    // comprobación que la escritura. Un dry-run que aprueba lo que la corrida
    // real va a rechazar es el peor de los dos mundos.
    const r = await cliCuenta(
      'map', 'set', '1195', '--scheme', 'sat-agrupador', '--value', RETIRADO,
      '--year', '2026', '--dry-run',
      '--entity', f.entityId, '--tenant', f.tenantId, '--user', correo
    );
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(RETIRADO);
    expect(r.err).toContain('2026-12-31');
    expect((await casillasDe(cuenta1195)).agrupador).toBeNull();
  });

  it('--year 2018, el MISMO código: el ensayo pasa y confirma el nombre oficial', async () => {
    const r = await cliCuenta(
      'map', 'set', '1195', '--scheme', 'sat-agrupador', '--value', RETIRADO,
      '--year', '2018', '--dry-run',
      '--entity', f.entityId, '--tenant', f.tenantId, '--user', correo
    );
    expect(r.code, `la CLI falló: ${r.err}`).toBe(0);
    expect(r.out).toContain('Agrupador retirado en 2019');
    // Ensayo es ensayo: sigue sin escribirse.
    expect((await casillasDe(cuenta1195)).agrupador).toBeNull();
  });

  it('`map check` mide la población movida y dice de dónde salió el alcance', async () => {
    const r = await cliCuenta(
      'map', 'check', '--check', 'coverage', '--json',
      '--entity', f.entityId, '--tenant', f.tenantId
    );
    const sobre = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    // De las cuatro movidas sólo 1195 sigue sin agrupador.
    expect(sobre.rows.map((h) => h.code)).toEqual(['1195']);
    expect(r.err).toContain('1 de 4 cuenta(s) sin sat-agrupador');
    expect(r.err).toContain('alcance "cuentas_con_movimientos", por omisión');
  });

  it('--level se RECHAZA en vez de aceptarse y no aplicarse', async () => {
    // Era el filtro que causaba el defecto en las dos direcciones. Aceptar la
    // bandera e ignorarla dejaría al usuario creyendo que acotó algo.
    const r = await cliCuenta(
      'map', 'check', '--check', 'coverage', '--level', '2',
      '--entity', f.entityId, '--tenant', f.tenantId
    );
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--level ya no aplica/);
  });
});
