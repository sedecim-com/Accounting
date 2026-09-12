import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { reverseJournalEntry } from '../../src/services/accounting/posting.js';
import { runMonthlyProvisions } from '../../src/services/accruals/provisions-run.js';

/**
 * D1 · EL DEVENGO DE PRESTACIONES, COMPROBADO CONTRA EL MAYOR (NIF D-3).
 *
 * El catálogo llevaba las cuentas 2202/2203/2204 sembradas desde la 073 y el
 * panel llevaba tres políticas contestables, y NADA las movía: la 073 dijo por
 * escrito «el motor va aparte». Un despacho en ese estado paga el aguinaldo en
 * diciembre sin haberlo provisionado, publica once meses de utilidad inflada y
 * un diciembre catastrófico, y ninguno de los doce estados es firmable.
 *
 * Lo que estas pruebas tienen que demostrar no es que la función exista —eso lo
 * dice el typecheck— sino las siete cosas que sólo se ven con el mayor detrás:
 *
 *   1. Que el saldo de CADA provisión sea el que sale de la aritmética hecha a
 *      mano, con dos antigüedades distintas y un aniversario a mitad de mes.
 *   2. Que el mismo mes corrido dos veces NO duplique el pasivo.
 *   3. Que la corrida produzca UN asiento, cuadrado, con las cuentas resueltas
 *      POR ROL.
 *   4. Que sin trabajadores no se postee nada — un asiento en cero es ruido.
 *   5. Que la PTU no se toque, y que la ausencia esté DECLARADA en el resultado
 *      tanto con el panel apagado como encendido.
 *   6. Que la corrida no cruce entidades, ni por el periodo ni por la plantilla.
 *   7. Que una reversa devuelva el mes al estado de poder volver a correrse.
 *
 * LA ARITMÉTICA VA ESCRITA EN LA PROPIA PRUEBA, no importada del módulo que se
 * está probando. Una prueba que recompone la cuenta con las funciones del
 * módulo pasa en verde aunque la cuenta esté mal —es el defecto que G1a
 * documentó en report-service—, así que aquí los importes son literales y el
 * comentario de encima dice de dónde sale cada uno.
 */

let A: Fixture;
let B: Fixture;
let VACIA: Fixture;
let PTU: Fixture;
let AJUSTE: Fixture;
let SINROL: Fixture;
let VOCAB: Fixture;
let BAJA: Fixture;

// ── LA PLANTILLA, Y LA ARITMÉTICA QUE SE ESPERA DE ELLA ─────────────────
//
// Dos trabajadores con antigüedades distintas a propósito, y el mes elegido es
// MARZO porque en él cae el aniversario de la veterana: el mes se parte en dos
// tramos con escalones distintos del art. 76, que es donde un motor mediocre
// paga de más o de menos.
//
// El salario diario sale de `annual_salary / 365`, que es el divisor que usa
// `calculateFiniquito` desde D1a y que ahora los dos comparten
// (`salarioDiarioDesdeSueldoAnual`). Los sueldos están elegidos para que el
// diario sea redondo y la cuenta se pueda seguir a mano:
//   Ana  365 000 / 365 = 1 000.0000
//   Beto 182 500 / 365 =   500.0000
const ANA = { hire: '2021-03-10', annual: '365000.00', diario: 1000 };
const BETO = { hire: '2026-02-15', annual: '182500.00', diario: 500 };

// ── ANA · marzo de 2026, alta del 10 de marzo de 2021 ───────────────────
//
// El 10 de marzo de 2026 cumple CINCO años, así que el mes tiene dos tramos:
//   · del 1 al 9 corre su AÑO DE SERVICIO 5 → art. 76: 20 días
//   · del 10 al 31 corre su AÑO DE SERVICIO 6 → art. 76: 22 días
// Aplicar 22 a todo el mes le regalaría días que no prestó; aplicar 20 le
// pagaría de menos justo el año en que sube de escalón.
//
// AGUINALDO (LFT 87, 15 días, prorrateados sobre el ejercicio de 365 días).
// Todo importe es la DIFERENCIA DE DOS ACUMULADOS redondeados, que es lo que
// hace que doce meses sumen el anual exacto:
//   tramo 1: 1000×15×68/365 − 1000×15×59/365 = 2794.5205 − 2424.6575 =  369.8630
//   tramo 2: 1000×15×90/365 − 1000×15×68/365 = 3698.6301 − 2794.5205 =  904.1096
//                                                                     ─────────
//                                                                      1273.9726
const ANA_AGUINALDO = '1273.9726';
// VACACIONES (LFT 76). El periodo es el AÑO DE SERVICIO, de aniversario a
// aniversario, no el año calendario:
//   tramo 1 (año 2025-03-10 → 2026-03-09, 365 días, 20 días de vacaciones):
//       1000×20×365/365 − 1000×20×356/365 = 20000.0000 − 19506.8493 =  493.1507
//   tramo 2 (año 2026-03-10 → 2027-03-09, 365 días, 22 días):
//       1000×22×22/365 − 0                =  1326.0274 − 0          = 1326.0274
//                                                                     ─────────
//                                                                      1819.1781
const ANA_VACACIONES = '1819.1781';
// PRIMA VACACIONAL (LFT 80, 25 % de los días de vacaciones):
//   tramo 1 (5 días):   1000×5×365/365 − 1000×5×356/365   = 5000.0000 − 4876.7123 = 123.2877
//   tramo 2 (5.5 días): 1000×5.5×22/365 − 0               =  331.5068             = 331.5068
//                                                                                  ─────────
//                                                                                   454.7945
const ANA_PRIMA = '454.7945';

// ── BETO · marzo de 2026, alta del 15 de febrero de 2026 ────────────────
//
// Su primer año de servicio: art. 76 → 12 días. Marzo entero, sin aniversario.
// El aguinaldo se prorratea sobre el ejercicio pero SU ejercicio arranca el día
// del alta (LFT 87: «en proporción al tiempo que hubiere trabajado»), así que
// del 15 de febrero al 31 de marzo son 45 días y a la víspera del mes, 14:
//   aguinaldo:  500×15×45/365 − 500×15×14/365 = 924.6575 − 287.6712 = 636.9863
//   vacaciones: 500×12×45/365 − 500×12×14/365 = 739.7260 − 230.1370 = 509.5890
//   prima:      500× 3×45/365 − 500× 3×14/365 = 184.9315 −  57.5342 = 127.3973
const BETO_AGUINALDO = '636.9863';
const BETO_VACACIONES = '509.5890';
const BETO_PRIMA = '127.3973';

// La corrida entera de marzo: la suma de los dos, concepto a concepto.
const MARZO_AGUINALDO = '1910.9589'; // 1273.9726 + 636.9863
const MARZO_VACACIONES = '2328.7671'; // 1819.1781 + 509.5890
const MARZO_PRIMA = '582.1918'; //  454.7945 + 127.3973
const MARZO_TOTAL = '4821.9178'; // 1910.9589 + 2328.7671 + 582.1918

/** Un trabajador mexicano mínimo, con el sueldo anual capturado. */
async function altaEmpleado(
  f: Fixture,
  datos: { hire: string; annual?: string | null; sbc?: string | null; numero?: string }
): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, country_code, rfc, sbc, annual_salary, salary_type, currency_code, status)
     VALUES ($1, $2, $3, $4, 'Prueba', 'Provisión', $5, 'MX', 'XAXX010101000', $6, $7,
       'salary', 'MXN', 'active')`,
    [
      id,
      f.tenantId,
      f.entityId,
      datos.numero ?? `E-${id.slice(0, 8)}`,
      datos.hire,
      datos.sbc ?? null,
      datos.annual ?? null,
    ]
  );
  return id;
}

/**
 * Saldo POSTEADO de una cuenta en el mayor de una entidad, en la convención de
 * la cuenta: para un pasivo de naturaleza acreedora se devuelve haber − debe,
 * de modo que una provisión abonada salga POSITIVA.
 *
 * SE SUMAN TODOS LOS ASIENTOS APLICADOS, incluidos los revertidos Y SUS
 * ESPEJOS. Es el saldo de verdad: el mayor es inmutable (041), así que una
 * reversa no borra el asiento sino que añade el contrario, y los dos juntos
 * valen cero. Excluir el original sin excluir su espejo restaría el importe dos
 * veces, que es la manera fácil de escribir una prueba que pasa por el motivo
 * equivocado.
 */
async function saldoAcreedor(entityId: string, accountId: string): Promise<string> {
  const r = await query<{ saldo: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.credit_amount,0) - COALESCE(jel.debit_amount,0)), 0)::text AS saldo
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = $2 AND je.entity_id = $1 AND je.status = 'posted'`,
    [entityId, accountId]
  );
  return new Decimal(r.rows[0].saldo).toFixed(4);
}

async function saldoDeudor(entityId: string, accountId: string): Promise<string> {
  return new Decimal(await saldoAcreedor(entityId, accountId)).negated().toFixed(4);
}

beforeAll(async () => {
  A = await crearInquilino('D1 provisiones');
  B = await crearEntidadHermana(A, 'D1 provisiones · hermana');
  VACIA = await crearEntidadHermana(A, 'D1 provisiones · sin nómina');
  PTU = await crearEntidadHermana(A, 'D1 provisiones · PTU encendida');
  AJUSTE = await crearEntidadHermana(A, 'D1 provisiones · periodo 13');
  SINROL = await crearEntidadHermana(A, 'D1 provisiones · sin rol');
  VOCAB = await crearEntidadHermana(A, 'D1 provisiones · panel roto');
  BAJA = await crearEntidadHermana(A, 'D1 provisiones · baja sin fecha');
  for (const f of [A, B, VACIA, PTU, AJUSTE, SINROL, VOCAB, BAJA]) {
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  }
}, 300_000);

afterAll(async () => {
  await closeDatabase();
});

// ── 1 · EL SALDO DE CADA PROVISIÓN, CONTRA LA CUENTA HECHA A MANO ───────
describe('marzo de 2026 con dos antigüedades y un aniversario a mitad de mes', () => {
  it('abona a cada provisión exactamente lo que dice la aritmética, y cuadra el asiento', async () => {
    enterTenant(A.tenantId);
    const ana = await altaEmpleado(A, { ...ANA, numero: 'A-ANA' });
    const beto = await altaEmpleado(A, { ...BETO, numero: 'A-BETO' });

    const r = await runMonthlyProvisions(A.entityId, A.periodos[3], A.userId);
    expect(r.errors).toEqual([]);
    expect(r.processed).toBe(2);
    expect(r.skipped).toBe(0);

    // El resultado, concepto a concepto.
    expect(r.aguinaldo).toBe(MARZO_AGUINALDO);
    expect(r.vacaciones).toBe(MARZO_VACACIONES);
    expect(r.prima_vacacional).toBe(MARZO_PRIMA);
    expect(r.total).toBe(MARZO_TOTAL);

    // EL MAYOR ES EL JUEZ. Las cuentas se piden POR ROL, igual que el motor:
    // preguntar por el código '2202' en la prueba dejaría pasar un motor que
    // cablea el código, que es justo lo que no se quiere.
    expect(await saldoAcreedor(A.entityId, A.roles.provision_aguinaldo)).toBe(MARZO_AGUINALDO);
    expect(await saldoAcreedor(A.entityId, A.roles.provision_vacaciones)).toBe(MARZO_VACACIONES);
    expect(await saldoAcreedor(A.entityId, A.roles.provision_prima_vacacional)).toBe(MARZO_PRIMA);
    // Y el cargo, entero, en la cuenta de gasto de la provisión: NO en la 6110
    // de sueldos, que es la que se concilia contra los CFDI de nómina timbrados.
    expect(await saldoDeudor(A.entityId, A.roles.provision_prestaciones_gasto)).toBe(MARZO_TOTAL);
    expect(await saldoDeudor(A.entityId, A.roles.sueldos_gasto)).toBe('0.0000');

    // UN SOLO ASIENTO POR CORRIDA, cuadrado y de ajuste.
    expect(r.journalEntryId).not.toBeNull();
    const asientos = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries
        WHERE entity_id = $1 AND source_type = 'benefit_provision'`,
      [A.entityId]
    );
    expect(asientos.rows[0].n).toBe('1');
    const asiento = await query<{
      entry_type: string;
      status: string;
      entry_date: Date;
      total_debit: string;
      total_credit: string;
      source_id: string;
      lineas: string;
    }>(
      `SELECT je.entry_type, je.status, je.entry_date, je.total_debits::text AS total_debit, je.total_credits::text AS total_credit,
              je.source_id, count(jel.id)::text AS lineas
         FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        WHERE je.id = $1
        GROUP BY je.id`,
      [r.journalEntryId]
    );
    const a = asiento.rows[0];
    expect(a.entry_type).toBe('adjusting');
    expect(a.status).toBe('posted');
    expect(new Decimal(a.total_debit).toFixed(4)).toBe(MARZO_TOTAL);
    expect(new Decimal(a.total_credit).toFixed(4)).toBe(MARZO_TOTAL);
    // Un cargo y tres abonos: los tres pasivos se extinguen con hechos
    // distintos, así que ninguno se funde con otro.
    expect(a.lineas).toBe('4');
    // La fecha es la del PERIODO QUE SE CORRE, el último día: el devengo es de
    // mes cerrado, y `createJournalEntry` deduce el periodo fiscal DE LA FECHA.
    expect(a.entry_date.toISOString().slice(0, 10)).toBe('2026-03-31');
    expect(a.source_id).toBe(A.periodos[3]);

    // ── LA CÉDULA: DE QUIÉN ES CADA PESO ──
    //
    // El asiento dice cuánto; sin la cédula nadie puede decir de quién. Es lo
    // que hará falta el día que uno de los dos se vaya y el finiquito tenga que
    // amarrarse contra lo provisionado.
    const cedula = await query<{
      employee_id: string;
      days_accrued: number;
      aguinaldo_amount: string;
      vacaciones_amount: string;
      prima_vacacional_amount: string;
      total_amount: string;
      is_posted: boolean;
      journal_entry_id: string;
      calculation_metadata: Record<string, unknown>;
    }>(
      `SELECT employee_id, days_accrued, aguinaldo_amount::text, vacaciones_amount::text,
              prima_vacacional_amount::text, total_amount::text, is_posted, journal_entry_id,
              calculation_metadata
         FROM benefit_provision_schedules
        WHERE entity_id = $1 AND fiscal_period_id = $2
        ORDER BY employee_id`,
      [A.entityId, A.periodos[3]]
    );
    expect(cedula.rows).toHaveLength(2);
    const porEmpleado = new Map(cedula.rows.map((f) => [f.employee_id, f]));

    const filaAna = porEmpleado.get(ana)!;
    expect(new Decimal(filaAna.aguinaldo_amount).toFixed(4)).toBe(ANA_AGUINALDO);
    expect(new Decimal(filaAna.vacaciones_amount).toFixed(4)).toBe(ANA_VACACIONES);
    expect(new Decimal(filaAna.prima_vacacional_amount).toFixed(4)).toBe(ANA_PRIMA);
    // El total es GENERADO por el esquema: no hay dos números que discrepen.
    expect(new Decimal(filaAna.total_amount).toFixed(4)).toBe('3547.9452');
    expect(filaAna.days_accrued).toBe(31);
    // Las dos filas del mes comparten asiento — un asiento por corrida.
    expect(filaAna.journal_entry_id).toBe(r.journalEntryId);
    expect(filaAna.is_posted).toBe(true);

    const filaBeto = porEmpleado.get(beto)!;
    expect(new Decimal(filaBeto.aguinaldo_amount).toFixed(4)).toBe(BETO_AGUINALDO);
    expect(new Decimal(filaBeto.vacaciones_amount).toFixed(4)).toBe(BETO_VACACIONES);
    expect(new Decimal(filaBeto.prima_vacacional_amount).toFixed(4)).toBe(BETO_PRIMA);
    expect(filaBeto.days_accrued).toBe(31);
    expect(filaBeto.journal_entry_id).toBe(r.journalEntryId);

    // EL MES PARTIDO EN DOS, ESCRITO EN LA CÉDULA. Es lo que permite a un
    // auditor reconstruir el renglón sin volver a correr el motor: sin los
    // tramos, «1273.9726» es un número sin defensa.
    const meta = filaAna.calculation_metadata as {
      tramos: Array<{ dias: number; anio_de_servicio: number; dias_vacaciones_del_anio: number }>;
      base_salarial: string;
      convencion_vacaciones: string;
      salario_diario_contratado: string;
    };
    expect(meta.salario_diario_contratado).toBe('1000.0000');
    expect(meta.base_salarial).toBe('nominal');
    expect(meta.convencion_vacaciones).toBe('proporcional');
    expect(meta.tramos).toHaveLength(2);
    expect(meta.tramos[0]).toMatchObject({
      dias: 9,
      anio_de_servicio: 5,
      dias_vacaciones_del_anio: 20,
    });
    expect(meta.tramos[1]).toMatchObject({
      dias: 22,
      anio_de_servicio: 6,
      dias_vacaciones_del_anio: 22,
    });
    // Beto no cumple años en marzo: un solo tramo, y su primer año son 12 días.
    const metaBeto = filaBeto.calculation_metadata as {
      tramos: Array<{ dias: number; dias_vacaciones_del_anio: number }>;
    };
    expect(metaBeto.tramos).toHaveLength(1);
    expect(metaBeto.tramos[0]).toMatchObject({ dias: 31, dias_vacaciones_del_anio: 12 });
  });

  // ── 2 · LA DOBLE CORRIDA ──────────────────────────────────────────────
  it('correr el mismo mes otra vez no duplica el pasivo ni postea un segundo asiento', async () => {
    enterTenant(A.tenantId);
    const segunda = await runMonthlyProvisions(A.entityId, A.periodos[3], A.userId);

    expect(segunda.errors).toEqual([]);
    expect(segunda.processed).toBe(0);
    expect(segunda.skipped).toBe(2);
    expect(segunda.total).toBe('0.0000');
    // NADA QUE POSTEAR, NINGÚN ASIENTO. Un asiento en cero sería ruido, y uno
    // repetido sería el pasivo duplicado que este freno existe para impedir.
    expect(segunda.journalEntryId).toBeNull();

    const asientos = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries
        WHERE entity_id = $1 AND source_type = 'benefit_provision'`,
      [A.entityId]
    );
    expect(asientos.rows[0].n).toBe('1');

    // Y el saldo de las tres provisiones, INTACTO.
    expect(await saldoAcreedor(A.entityId, A.roles.provision_aguinaldo)).toBe(MARZO_AGUINALDO);
    expect(await saldoAcreedor(A.entityId, A.roles.provision_vacaciones)).toBe(MARZO_VACACIONES);
    expect(await saldoAcreedor(A.entityId, A.roles.provision_prima_vacacional)).toBe(MARZO_PRIMA);
    expect(await saldoDeudor(A.entityId, A.roles.provision_prestaciones_gasto)).toBe(MARZO_TOTAL);
  });

  // ── 3 · EL MES SIGUIENTE SUMA, NO REEMPLAZA ───────────────────────────
  it('abril devenga sobre el mismo pasivo y lo deja creciendo mes a mes', async () => {
    enterTenant(A.tenantId);
    const abril = await runMonthlyProvisions(A.entityId, A.periodos[4], A.userId);
    expect(abril.errors).toEqual([]);
    expect(abril.processed).toBe(2);

    // ABRIL, 30 DÍAS, sin aniversarios: un tramo por cabeza.
    //   Ana  (año de servicio 6, 22 días de vacaciones; año 2026-03-10→2027-03-09):
    //     aguinaldo:  1000×15×120/365 − 1000×15×90/365 = 4931.5068 − 3698.6301 = 1232.8767
    //     vacaciones: 1000×22×52/365  − 1000×22×22/365 = 3134.2466 − 1326.0274 = 1808.2192
    //     prima:      1000×5.5×52/365 − 1000×5.5×22/365 =  783.5616 −  331.5068 =  452.0548
    //   Beto (año 1, 12 días; año 2026-02-15→2027-02-14):
    //     aguinaldo:  500×15×75/365 − 500×15×45/365 = 1541.0959 −  924.6575 = 616.4384
    //     vacaciones: 500×12×75/365 − 500×12×45/365 = 1232.8767 −  739.7260 = 493.1507
    //     prima:      500× 3×75/365 − 500× 3×45/365 =  308.2192 −  184.9315 = 123.2877
    expect(abril.aguinaldo).toBe('1849.3151'); // 1232.8767 + 616.4384
    expect(abril.vacaciones).toBe('2301.3699'); // 1808.2192 + 493.1507
    expect(abril.prima_vacacional).toBe('575.3425'); //  452.0548 + 123.2877
    expect(abril.total).toBe('4726.0275');

    // El pasivo acumulado son los dos meses, y el mayor lo dice sin ayuda.
    expect(await saldoAcreedor(A.entityId, A.roles.provision_aguinaldo)).toBe('3760.2740');
    expect(await saldoAcreedor(A.entityId, A.roles.provision_vacaciones)).toBe('4630.1370');
    expect(await saldoAcreedor(A.entityId, A.roles.provision_prima_vacacional)).toBe('1157.5343');
    expect(await saldoDeudor(A.entityId, A.roles.provision_prestaciones_gasto)).toBe('9547.9453');
  });
});

// ── 4 · LA PTU: AUSENCIA DECLARADA, NO CERO SILENCIOSO ──────────────────
describe('la PTU no se provisiona, y la corrida lo dice', () => {
  it('con el panel apagado —la omisión— la cuenta de PTU no se toca y el resultado lo declara', async () => {
    enterTenant(A.tenantId);
    const r = await runMonthlyProvisions(A.entityId, A.periodos[5], A.userId);
    expect(r.errors).toEqual([]);
    expect(r.processed).toBe(2);

    expect(r.ptu.panel).toBe('no');
    expect(r.ptu.encendida).toBe(false);
    expect(r.ptu.provisionada).toBe(false);
    expect(r.ptu.cuenta_tocada).toBe(false);
    expect(r.ptu.nota).toMatch(/al cierre del ejercicio/);

    // La 2205 existe en el catálogo y NADIE la ha movido. Se busca por código
    // porque, deliberadamente, no tiene rol: un rol sin motor es una cuenta que
    // alguien acaba cableando a mano.
    const ptu = A.cuentas['2205'];
    expect(ptu).toBeDefined();
    expect(await saldoAcreedor(A.entityId, ptu)).toBe('0.0000');
  });

  it('con el panel ENCENDIDO tampoco la provisiona, y la nota dice por qué', async () => {
    // ENTIDAD APARTE, Y NO ES COMODIDAD: una política se contesta UNA vez —la
    // fila deja de estar pendiente—, así que encenderla y apagarla dentro de la
    // entidad A dejaría a las demás pruebas corriendo sobre un panel distinto
    // del que declaran. La bifurcación se prueba donde vive: en una entidad que
    // la eligió.
    enterTenant(A.tenantId);
    await altaEmpleado(PTU, { ...ANA, numero: 'P-ANA' });
    await resolvePolicy(
      { tenantId: PTU.tenantId, entityId: PTU.entityId },
      'provision_ptu_mensual',
      'si',
      PTU.userId,
      'el despacho decide provisionar PTU mensualmente'
    );

    const r = await runMonthlyProvisions(PTU.entityId, PTU.periodos[3], PTU.userId);
    expect(r.errors).toEqual([]);
    expect(r.processed).toBe(1);

    // ENCENDIDA Y NO PROVISIONADA: es exactamente el caso en que callarse sería
    // peor. La PTU es el 10 % de la renta gravable DE LA ENTIDAD (LFT 120), no
    // una proporción del salario de una persona, así que no hay prorrateo por
    // trabajador que este motor pueda hacer sin inventárselo.
    expect(r.ptu.panel).toBe('si');
    expect(r.ptu.encendida).toBe(true);
    expect(r.ptu.provisionada).toBe(false);
    expect(r.ptu.cuenta_tocada).toBe(false);
    expect(r.ptu.nota).toMatch(/ENCENDIDA/);
    expect(r.ptu.nota).toMatch(/LFT art\. 120/);

    expect(await saldoAcreedor(PTU.entityId, PTU.cuentas['2205'])).toBe('0.0000');
    // Y el asiento que sí se posteó tiene las tres provisiones de siempre y
    // ninguna línea contra la 2205.
    const lineas = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entry_lines
        WHERE journal_entry_id = $1 AND account_id = $2`,
      [r.journalEntryId, PTU.cuentas['2205']]
    );
    expect(lineas.rows[0].n).toBe('0');
  });
});

// ── 5 · SIN NÓMINA NO SE POSTEA NADA ────────────────────────────────────
describe('la entidad sin trabajadores', () => {
  it('no postea asiento, no escribe cédula, y no falla', async () => {
    enterTenant(VACIA.tenantId);
    const r = await runMonthlyProvisions(VACIA.entityId, VACIA.periodos[3], VACIA.userId);

    expect(r.errors).toEqual([]);
    expect(r.processed).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.total).toBe('0.0000');
    expect(r.journalEntryId).toBeNull();

    const asientos = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries
        WHERE entity_id = $1 AND source_type = 'benefit_provision'`,
      [VACIA.entityId]
    );
    expect(asientos.rows[0].n).toBe('0');
    // Y la ausencia se declara igual: la PTU sigue teniendo su renglón.
    expect(r.ptu.provisionada).toBe(false);
  });

  it('un trabajador con la ficha sin sueldo se nombra en errors en vez de provisionar cero', async () => {
    enterTenant(VACIA.tenantId);
    await altaEmpleado(VACIA, { hire: '2025-01-01', annual: null, sbc: null, numero: 'V-MUDO' });

    const r = await runMonthlyProvisions(VACIA.entityId, VACIA.periodos[4], VACIA.userId);
    expect(r.processed).toBe(0);
    expect(r.journalEntryId).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/V-MUDO/);
    expect(r.errors[0]).toMatch(/sueldo anual ni salario base de cotización/);
  });
});

// ── 6 · LA FRONTERA DE ENTIDAD ──────────────────────────────────────────
describe('la corrida no cruza entidades', () => {
  it('rechaza el periodo fiscal de la entidad hermana, y lo dice con su propio nombre', async () => {
    enterTenant(A.tenantId);
    await expect(
      runMonthlyProvisions(A.entityId, B.periodos[3], A.userId)
    ).rejects.toThrow(/provisiones de prestaciones no cruza entidades/);
  });

  it('no devenga a los trabajadores de la hermana', async () => {
    enterTenant(A.tenantId);
    // La hermana tiene su propio trabajador; la entidad A ya corrió marzo.
    await altaEmpleado(B, { hire: '2024-01-01', annual: '365000.00', numero: 'B-OTRO' });

    const r = await runMonthlyProvisions(B.entityId, B.periodos[3], B.userId);
    expect(r.errors).toEqual([]);
    // UNO, no tres: los dos de A no entran aunque compartan inquilino. Es el
    // eje que RLS no defiende —su predicado es el inquilino—, así que la
    // frontera tiene que estar en el SQL de la consulta.
    expect(r.processed).toBe(1);

    const cedula = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM benefit_provision_schedules WHERE entity_id = $1`,
      [B.entityId]
    );
    expect(cedula.rows[0].n).toBe('1');
  });
});

// ── 7 · LA REVERSA NO ES UNA CONDENA ────────────────────────────────────
describe('el mes revertido se puede volver a correr', () => {
  it('repone el pasivo en vez de dejar el mes bloqueado para siempre', async () => {
    enterTenant(A.tenantId);
    const antes = await saldoAcreedor(A.entityId, A.roles.provision_aguinaldo);

    // Julio, limpio: se corre, se revierte y se vuelve a correr.
    const primera = await runMonthlyProvisions(A.entityId, A.periodos[7], A.userId);
    expect(primera.errors).toEqual([]);
    expect(primera.processed).toBe(2);
    const conJulio = await saldoAcreedor(A.entityId, A.roles.provision_aguinaldo);
    expect(new Decimal(conJulio).greaterThan(new Decimal(antes))).toBe(true);

    await reverseJournalEntry(primera.journalEntryId as string, A.userId, {
      reason: 'la prueba revierte el devengo de julio',
    });

    // El espejo deja el saldo donde estaba: el asiento no se borra, se
    // contrapone.
    expect(await saldoAcreedor(A.entityId, A.roles.provision_aguinaldo)).toBe(antes);

    // Y LA CORRIDA VUELVE A HACERLO. Sin retirar la fila anulada, revertir un
    // mes lo bloquearía para siempre —la fila seguiría ahí, el freno seguiría
    // mordiendo, y el gasto que la reversa sacó del resultado no volvería
    // nunca—. Una reversa es una corrección, no una condena.
    const segunda = await runMonthlyProvisions(A.entityId, A.periodos[7], A.userId);
    expect(segunda.errors).toEqual([]);
    expect(segunda.processed).toBe(2);
    expect(segunda.skipped).toBe(0);
    expect(await saldoAcreedor(A.entityId, A.roles.provision_aguinaldo)).toBe(conJulio);

    // Un mes es UNA fila por trabajador, aunque se haya corrido dos veces.
    const filas = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM benefit_provision_schedules
        WHERE entity_id = $1 AND fiscal_period_id = $2`,
      [A.entityId, A.periodos[7]]
    );
    expect(filas.rows[0].n).toBe('2');
  });
});

// ── 8 · LO QUE LA CORRIDA SE NIEGA A HACER ──────────────────────────────
//
// Cuatro negativas, y ninguna es celo: cada una es un pasivo mal escrito que se
// descubriría meses después, cuando el mayor ya es inmutable (041) y corregirlo
// son reversas.
describe('la corrida se detiene antes de escribir un pasivo que no puede defender', () => {
  it('el periodo 13 de ajustes no es un mes de operación, y se rechaza', async () => {
    enterTenant(A.tenantId);
    // El calendario admite un periodo 13 (CHECK de la 001) y el SAT lo usa para
    // los ajustes del ejercicio. Sus fechas se solapan con diciembre: devengar
    // ahí volvería a contar días que el periodo 12 ya provisionó, y el pasivo
    // saldría duplicado sin que el balance dejara de cuadrar.
    const trece = uuidv4();
    await query(
      `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name,
         start_date, end_date, period_type, status)
       VALUES ($1, $2, $3, 13, 'Ajustes 2026', '2026-12-31', '2026-12-31', 'closing', 'open')`,
      [trece, AJUSTE.fiscalYearId, AJUSTE.entityId]
    );
    await altaEmpleado(AJUSTE, { ...ANA, numero: 'AJ-ANA' });

    await expect(runMonthlyProvisions(AJUSTE.entityId, trece, AJUSTE.userId)).rejects.toThrow(
      /no un mes de operación/
    );
    // Y diciembre, que sí lo es, corre sin problema sobre la misma entidad.
    const dic = await runMonthlyProvisions(AJUSTE.entityId, AJUSTE.periodos[12], AJUSTE.userId);
    expect(dic.processed).toBe(1);
  });

  it('sin la cuenta de un concepto se detiene y NOMBRA el rol que falta', async () => {
    enterTenant(A.tenantId);
    // Se retira el rol de vacaciones: bajo la convención `aniversario` ese
    // concepto vale cero once meses de cada doce, así que un motor que sólo
    // pidiera las cuentas de los importes distintos de cero correría en verde
    // todo el año y reventaría en el mes doce — el peor momento para enterarse.
    await query(`DELETE FROM account_roles WHERE entity_id = $1 AND role = 'provision_vacaciones'`, [
      SINROL.entityId,
    ]);
    await altaEmpleado(SINROL, { ...BETO, numero: 'SR-BETO' });

    await expect(
      runMonthlyProvisions(SINROL.entityId, SINROL.periodos[3], SINROL.userId)
    ).rejects.toThrow(/provision_vacaciones/);

    // Y no dejó nada a medias: ni asiento ni cédula.
    const rastro = await query<{ asientos: string; filas: string }>(
      `SELECT (SELECT count(*) FROM journal_entries WHERE entity_id = $1
                AND source_type = 'benefit_provision')::text AS asientos,
              (SELECT count(*) FROM benefit_provision_schedules WHERE entity_id = $1)::text AS filas`,
      [SINROL.entityId]
    );
    expect(rastro.rows[0]).toEqual({ asientos: '0', filas: '0' });
  });

  it('un valor fuera del vocabulario del panel detiene la corrida entera', async () => {
    enterTenant(A.tenantId);
    // El panel acepta valor libre (los catálogos no lo cubren todo) y lo anota.
    // El motor NO puede: entre `nominal` e `integrado` hay un 20 % de diferencia
    // en el importe de cada mes, y elegir uno en silencio es lo que hace que un
    // pasivo equivocado se descubra un año después.
    await resolvePolicy(
      { tenantId: VOCAB.tenantId, entityId: VOCAB.entityId },
      'provision_base_salarial',
      'integrado_pero_a_medias',
      VOCAB.userId,
      'la prueba escribe un valor que el catálogo no ofrece'
    );
    await altaEmpleado(VOCAB, { ...BETO, numero: 'VO-BETO' });

    await expect(
      runMonthlyProvisions(VOCAB.entityId, VOCAB.periodos[3], VOCAB.userId)
    ).rejects.toThrow(/provision_base_salarial vale "integrado_pero_a_medias"/);
  });

  it('un «terminated» sin fecha de baja se nombra y se salta, sin frenar a los demás', async () => {
    enterTenant(A.tenantId);
    const sano = await altaEmpleado(BAJA, { ...BETO, numero: 'BJ-SANO' });
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, country_code, rfc, annual_salary, salary_type, currency_code, status)
       VALUES ($1, $2, $3, 'BJ-ROTO', 'Prueba', 'Provisión', '2024-01-01', 'MX',
         'XAXX010101000', '365000.00', 'salary', 'MXN', 'terminated')`,
      [uuidv4(), BAJA.tenantId, BAJA.entityId]
    );

    const r = await runMonthlyProvisions(BAJA.entityId, BAJA.periodos[3], BAJA.userId);
    // UNO SIGUE Y EL OTRO SE NOMBRA. Devengarle el mes entero al de la ficha
    // rota le cargaría al patrón un pasivo por alguien que ya no está; abortar
    // la corrida entera dejaría sin cierre a los ciento noventa y nueve sanos.
    expect(r.processed).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/BJ-ROTO/);
    expect(r.errors[0]).toMatch(/no tiene fecha de baja/);

    const filas = await query<{ employee_id: string }>(
      `SELECT employee_id FROM benefit_provision_schedules WHERE entity_id = $1`,
      [BAJA.entityId]
    );
    expect(filas.rows.map((f) => f.employee_id)).toEqual([sano]);
  });
});
