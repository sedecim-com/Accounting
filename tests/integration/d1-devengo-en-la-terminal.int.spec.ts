import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { registerPayrollCommand } from '../../src/cli/payroll-command.js';
import { ExitCode } from '../../src/cli/kernel/index.js';

// ============================================================
// D1 · `payroll accrue`: LA PUERTA DEL DEVENGO, MEDIDA EN EL MAYOR
//
// El motor (`runMonthlyProvisions`) ya tiene su batería contra Postgres en
// d1-provisiones.int.spec.ts, y ahí se demuestra la aritmética, la
// idempotencia y la frontera de entidad LLAMANDO A LA FUNCIÓN. Lo que esa
// batería no puede demostrar —y lo que la revisión independiente del PR #180
// marcó como el defecto crítico— es que exista un camino por el que un
// operador llegue hasta ella: el motor estaba construido, probado e
// INALCANZABLE.
//
// Por eso estas pruebas NO miran lo que devuelve la función. Miran lo que el
// MAYOR tiene después de teclear el comando, que es la única forma de que un
// mutante que rompa la hoja —una bandera mal leída, un periodo que no viaja,
// un `--dry-run` que se ignora— salga en rojo. Medir sobre el resultado que
// devuelve la función sería medir al motor otra vez.
//
// LAS DOS AFIRMACIONES:
//
//   1. El mismo mes tecleado DOS VECES deja UN asiento y UNA cédula. La
//      idempotencia es del motor y aquí no se reimplementa: lo que se prueba
//      es que la hoja no la esquive —posteando por su cuenta, pasando otro
//      periodo, o llamando dos veces—.
//   2. `--dry-run` NO ESCRIBE. Un ensayo que escribe es la peor clase de
//      mentira en una herramienta contable: el operador cree estar mirando y
//      está posteando a un mayor que no admite deshacer (041). Se cuenta el
//      libro ANTES y DESPUÉS, y la diferencia tiene que ser exactamente cero.
//
// Corre como superusuario y con la RLS inerte, como el resto de la suite: lo
// que se comprueba es la frontera del CÓDIGO.
// ============================================================

let f: Fixture;
let correo: string;

// ── LA PLANTILLA Y SU ARITMÉTICA ────────────────────────────────────────
//
// Son los mismos dos trabajadores de d1-provisiones.int.spec.ts, y los
// importes van LITERALES —no importados del módulo que se prueba, ni
// recompuestos con sus funciones—: la derivación completa, tramo a tramo del
// art. 76, está escrita allí. Marzo de 2026 se elige porque en él cae el
// aniversario de la veterana, que es donde un motor mediocre paga de más o de
// menos; aquí lo que ese mes aporta es un importe que no se puede acertar por
// casualidad.
//   Ana  365 000 / 365 = 1 000.0000 diarios, alta 2021-03-10
//   Beto 182 500 / 365 =   500.0000 diarios, alta 2026-02-15
const ANA = { hire: '2021-03-10', annual: '365000.00', numero: 'A-ANA' };
const BETO = { hire: '2026-02-15', annual: '182500.00', numero: 'A-BETO' };

const MARZO_AGUINALDO = '1910.9589';
const MARZO_VACACIONES = '2328.7671';
const MARZO_PRIMA = '582.1918';
const MARZO_TOTAL = '4821.9178';

/** El mes que se teclea, tal como lo escribiría un contador. */
const PERIODO = '2026-03';

async function altaEmpleado(datos: {
  hire: string;
  annual: string;
  numero: string;
}): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, country_code, rfc, annual_salary, salary_type, currency_code, status)
     VALUES ($1, $2, $3, $4, 'Prueba', 'Devengo', $5, 'MX', 'XAXX010101000', $6,
       'salary', 'MXN', 'active')`,
    [id, f.tenantId, f.entityId, datos.numero, datos.hire, datos.annual]
  );
  return id;
}

// ── LO QUE SE LE PREGUNTA AL MAYOR, Y NO A LA FUNCIÓN ───────────────────

/** Asientos de devengo POSTEADOS que cuelgan de este periodo. */
async function asientosDelDevengo(): Promise<Array<{ id: string; description: string; entry_date: Date }>> {
  const r = await query<{ id: string; description: string; entry_date: Date }>(
    `SELECT id, description, entry_date
       FROM journal_entries
      WHERE entity_id = $1 AND source_type = 'benefit_provision' AND source_id = $2
        AND status = 'posted'
      ORDER BY created_at`,
    [f.entityId, f.periodos[3]]
  );
  return r.rows;
}

/** Renglones de cédula VIGENTES del mes, que es lo que la corrida escribe. */
async function renglonesDeCedula(): Promise<
  Array<{ employee_id: string; aguinaldo_amount: string; vacaciones_amount: string; prima_vacacional_amount: string }>
> {
  const r = await query<{
    employee_id: string;
    aguinaldo_amount: string;
    vacaciones_amount: string;
    prima_vacacional_amount: string;
  }>(
    `SELECT employee_id, aguinaldo_amount::text, vacaciones_amount::text,
            prima_vacacional_amount::text
       FROM benefit_provision_schedules
      WHERE entity_id = $1 AND fiscal_period_id = $2
      ORDER BY employee_id`,
    [f.entityId, f.periodos[3]]
  );
  return r.rows;
}

/** TODO el libro de la entidad, no sólo el devengo: un ensayo no escribe NADA. */
async function tamanoDelLibro(): Promise<{ asientos: number; lineas: number; cedula: number }> {
  const r = await query<{ asientos: string; lineas: string; cedula: string }>(
    `SELECT
       (SELECT COUNT(*) FROM journal_entries WHERE entity_id = $1)::text AS asientos,
       (SELECT COUNT(*) FROM journal_entry_lines jel
          JOIN journal_entries je ON je.id = jel.journal_entry_id
         WHERE je.entity_id = $1)::text AS lineas,
       (SELECT COUNT(*) FROM benefit_provision_schedules WHERE entity_id = $1)::text AS cedula`,
    [f.entityId]
  );
  const fila = r.rows[0];
  return {
    asientos: Number(fila.asientos),
    lineas: Number(fila.lineas),
    cedula: Number(fila.cedula),
  };
}

/**
 * Saldo acreedor POSTEADO de una cuenta: haber − debe, de modo que una
 * provisión abonada salga positiva. Se suman TODOS los asientos aplicados,
 * porque el mayor es inmutable y una reversa suma su contrario en vez de
 * borrar nada.
 */
async function saldoAcreedor(accountId: string): Promise<string> {
  const r = await query<{ saldo: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.credit_amount,0) - COALESCE(jel.debit_amount,0)), 0)::text AS saldo
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = $2 AND je.entity_id = $1 AND je.status = 'posted'`,
    [f.entityId, accountId]
  );
  return new Decimal(r.rows[0].saldo).toFixed(4);
}

const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

/**
 * Habla con la terminal de verdad y devuelve lo que escribió y con qué código.
 *
 * Se registra la familia sobre un `Command` nuevo en cada llamada —igual que
 * f07c-diot-en-la-terminal— para que cada invocación sea la de un proceso
 * recién arrancado: un estado colgado entre dos corridas escondería justo la
 * clase de defecto que la segunda corrida vigila.
 */
async function correr(argv: string[]): Promise<{
  exitCode: number | undefined;
  errs: unknown[];
  out: string;
  err: string;
}> {
  let exitCode: number | undefined;
  const errs: unknown[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const stdoutOriginal = process.stdout.write.bind(process.stdout);
  const stderrOriginal = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    err.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    const p = new Command('mnemosine');
    registerPayrollCommand(p, {
      palette: plain,
      shutdown: (c: number) => {
        exitCode = c;
      },
      reportError: (e: unknown) => {
        errs.push(e);
      },
      // Sin costura de confirmación no habría forma de probar el camino que
      // NO lleva `-y`: en una prueba no hay TTY y `ask` contestaría que no.
      confirm: async () => true,
    });
    await p.parseAsync([
      'node', 'mnemosine', ...argv, '-e', f.entityId, '-t', f.tenantId, '-u', correo,
    ]);
  } finally {
    process.stdout.write = stdoutOriginal;
    process.stderr.write = stderrOriginal;
  }
  return { exitCode, errs, out: out.join(''), err: err.join('') };
}

beforeAll(async () => {
  f = await crearInquilino('D1 devengo en la terminal');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  enterTenant(f.tenantId);
  await altaEmpleado(ANA);
  await altaEmpleado(BETO);
  const u = await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [f.userId]);
  correo = u.rows[0].email;
}, 300_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

// ── 1 · EL ENSAYO NO ESCRIBE ────────────────────────────────────────────
describe('payroll accrue --dry-run', () => {
  it('enseña la cédula completa —quién, cuántos días, cuánto por concepto— y no escribe NADA', async () => {
    const antes = await tamanoDelLibro();

    const r = await correr(['payroll', 'accrue', '--period', PERIODO, '--dry-run']);
    expect(r.exitCode, `${r.out}${r.err}`).toBe(ExitCode.OK);

    // LA CÉDULA, que es lo que el operador tiene que poder leer ANTES. Sin
    // esto, revisar el devengo obliga a postearlo y reversarlo, y el mayor no
    // admite deshacer.
    expect(r.out).toContain('A-ANA');
    expect(r.out).toContain('A-BETO');
    expect(r.out).toContain(MARZO_AGUINALDO);
    expect(r.out).toContain(MARZO_VACACIONES);
    expect(r.out).toContain(MARZO_PRIMA);
    // Y EL ASIENTO que se postearía, con sus cuentas por código: un asiento
    // que se enseña con UUIDs no se puede revisar.
    expect(r.out).toMatch(/Benefit provisions - 2 employee\(s\)/);
    expect(r.out).toMatch(/Aguinaldo accrual \(LFT art\. 87\)/);
    expect(r.err).toContain('Ensayo');
    // LA PTU, DECLARADA MIENTRAS TODAVÍA SE PUEDE PREGUNTAR. Un cero silencioso
    // y una ausencia declarada no son lo mismo, y leerla después de postear es
    // leerla tarde.
    // Con el panel APAGADO (el valor por omisión) la nota dice que se reconoce
    // al cierre, no que se haya provisionado en cero.
    expect(r.err).toMatch(/PTU: .*reconoce al cierre del ejercicio/);

    // LA AFIRMACIÓN QUE IMPORTA. No «no hay asientos de devengo»: el libro
    // ENTERO, hasta la última línea, tiene exactamente el mismo tamaño.
    expect(await tamanoDelLibro()).toEqual(antes);
  });

  it('el ensayo se puede repetir sin límite: sigue sin escribir a la tercera', async () => {
    const antes = await tamanoDelLibro();
    await correr(['payroll', 'accrue', '--period', PERIODO, '--dry-run']);
    await correr(['payroll', 'accrue', '--period', PERIODO, '--dry-run', '--json']);
    expect(await tamanoDelLibro()).toEqual(antes);
  });

  it('en modo máquina sale UN sobre parseable, con la cédula y el asiento anidados', async () => {
    // Dos `render` seguidos escribirían dos sobres pegados y `JSON.parse`
    // reventaría: quien lea esta hoja con --json o la mande a un archivo
    // recibiría un documento roto sin que nada lo dijera.
    const r = await correr(['payroll', 'accrue', '--period', PERIODO, '--dry-run', '--json']);
    expect(r.exitCode, `${r.out}${r.err}`).toBe(ExitCode.OK);
    const sobre = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    const fila = sobre.rows[0];
    expect(fila.dry_run).toBe(true);
    expect(fila.devengan).toBe(2);
    // El dinero viaja como CADENA de punta a punta: un `JSON.parse` sobre un
    // número es cómo una balanza deja de cuadrar por un centavo que nadie
    // encuentra.
    expect(fila.aguinaldo).toBe(MARZO_AGUINALDO);
    expect(fila.total).toBe(MARZO_TOTAL);
    expect(fila.cedula).toHaveLength(2);
    expect(fila.asiento).toHaveLength(4);
    // Y el panel que gobernó el importe, con su «¿la contestó alguien?».
    expect(fila.criterios).toMatchObject({
      provision_base_salarial: { valor: 'nominal' },
      devengo_vacaciones: { valor: 'proporcional' },
    });
    // La 2205 no se toca, y el documento lo DICE en vez de callarlo.
    expect(fila.ptu).toMatchObject({ encendida: false, provisionada: false, cuenta_tocada: false });
  });
});

// ── 2 · DOS CORRIDAS, UN ASIENTO Y UNA CÉDULA ───────────────────────────
describe('payroll accrue · el mismo mes tecleado dos veces', () => {
  it('la primera corrida postea UN asiento y escribe la cédula de los dos trabajadores', async () => {
    const r = await correr(['payroll', 'accrue', '--period', PERIODO, '--yes']);
    expect(r.exitCode, `${r.out}${r.err}`).toBe(ExitCode.OK);
    expect(r.err).toContain('2 trabajador(es) devengados');

    const asientos = await asientosDelDevengo();
    expect(asientos).toHaveLength(1);
    // UN asiento por CORRIDA y no uno por trabajador: doscientas personas
    // producirían doscientos asientos idénticos y el mayor sería ilegible.
    expect(asientos[0].description).toBe('Benefit provisions Periodo 3/2026');

    const cedula = await renglonesDeCedula();
    expect(cedula).toHaveLength(2);

    // Los saldos, contra la aritmética escrita a mano y leídos del LIBRO.
    expect(await saldoAcreedor(f.roles.provision_aguinaldo)).toBe(MARZO_AGUINALDO);
    expect(await saldoAcreedor(f.roles.provision_vacaciones)).toBe(MARZO_VACACIONES);
    expect(await saldoAcreedor(f.roles.provision_prima_vacacional)).toBe(MARZO_PRIMA);
  });

  it('la SEGUNDA corrida del mismo mes no duplica el pasivo: sigue habiendo UN asiento y UNA cédula', async () => {
    const r = await correr(['payroll', 'accrue', '--period', PERIODO, '--yes']);
    // No es un error: el mes ya estaba devengado y la hoja lo dice sin postear.
    expect(r.exitCode, `${r.out}${r.err}`).toBe(ExitCode.OK);
    expect(r.err).toContain('Nada que devengar');
    expect(r.out).toContain('ya tiene renglon vigente de este mes');

    expect(await asientosDelDevengo()).toHaveLength(1);
    expect(await renglonesDeCedula()).toHaveLength(2);

    // Y el pasivo vale lo mismo que después de la primera: si la hoja hubiera
    // esquivado el freno del motor, aquí saldría el doble.
    expect(await saldoAcreedor(f.roles.provision_aguinaldo)).toBe(MARZO_AGUINALDO);
    expect(await saldoAcreedor(f.roles.provision_vacaciones)).toBe(MARZO_VACACIONES);
    expect(await saldoAcreedor(f.roles.provision_prima_vacacional)).toBe(MARZO_PRIMA);
    expect(await saldoAcreedor(f.roles.provision_prestaciones_gasto)).toBe(
      new Decimal(MARZO_TOTAL).negated().toFixed(4)
    );
  });
});

// ── 3 · LA LLAVE QUE LA HOJA DECLARA HONRAR ─────────────────────────────
describe('payroll accrue --idempotency-key', () => {
  it('un reintento con la misma llave DEVUELVE EL RESULTADO GRABADO, con su mismo asiento', async () => {
    // Abril, que todavía no se ha corrido: la llave se consuma con él.
    const primera = await correr([
      'payroll', 'accrue', '--period', '2026-04', '--yes', '--idempotency-key', 'devengo-abril',
    ]);
    expect(primera.exitCode, `${primera.out}${primera.err}`).toBe(ExitCode.OK);
    const asientosAbril = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entries
        WHERE entity_id = $1 AND source_type = 'benefit_provision' AND source_id = $2`,
      [f.entityId, f.periodos[4]]
    );
    expect(asientosAbril.rows[0].n).toBe('1');

    const antes = await tamanoDelLibro();
    const segunda = await correr([
      'payroll', 'accrue', '--period', '2026-04', '--yes', '--idempotency-key', 'devengo-abril',
    ]);
    // WIT-180-02. Antes, la hoja salía por la puerta de `previstos === 0` ANTES
    // de consumar la llave: un reintento contestaba «Nada que devengar» y total
    // 0.0000 —una ejecución DISTINTA— en vez del resultado grabado que la ayuda
    // promete. Con `mirarLlave` delante, el reintento devuelve lo grabado, con
    // su mismo id de asiento, y el mayor sigue con UNA sola corrida.
    expect(segunda.exitCode, `${segunda.out}${segunda.err}`).toBe(ExitCode.OK);
    expect(await tamanoDelLibro()).toEqual(antes);

    // EL MISMO RESULTADO LÓGICO, no uno nuevo que diga «nada». El id del
    // asiento es el de la primera corrida, y es lo que un guion registra.
    const asientoDeAbril = await query<{ id: string }>(
      `SELECT id FROM journal_entries
        WHERE entity_id = $1 AND source_type = 'benefit_provision' AND source_id = $2`,
      [f.entityId, f.periodos[4]]
    );
    const salida = `${segunda.out}${segunda.err}`;
    expect(salida, 'el reintento no devolvió el asiento grabado').toContain(
      asientoDeAbril.rows[0].id
    );
    expect(salida, 'el reintento contestó «nada que devengar» en vez de lo grabado').toContain(
      'ya consumada'
    );
  });

  it('la misma llave con OTRA carga sigue saliendo en conflicto', async () => {
    // La otra mitad del contrato: mirar antes no puede relajar la acusación de
    // reuso. Mayo es otro periodo, así que la carga difiere de la de abril.
    const r = await correr([
      'payroll', 'accrue', '--period', '2026-05', '--yes', '--idempotency-key', 'devengo-abril',
    ]);
    expect(r.exitCode, `${r.out}${r.err}`).not.toBe(ExitCode.OK);
    // El mensaje del conflicto viaja por `reportError`, no por stderr.
    const dicho = r.errs.map((e) => (e as Error).message).join(' | ');
    expect(dicho.toLowerCase(), 'no acusó el reuso de la llave').toMatch(/idempotenc|llave|conflict/);
  });

  it('un resultado grabado cuyo asiento se REVERSÓ no se reproduce: se acusa', async () => {
    // Devolverlo diría «✔ devengados» con el id de un asiento anulado, y el mes
    // seguiría sin devengar. El motor está hecho para que una reversa permita
    // volver a correr, así que la llave no puede contestar por él.
    const asientoDeAbril = await query<{ id: string }>(
      `SELECT id FROM journal_entries
        WHERE entity_id = $1 AND source_type = 'benefit_provision' AND source_id = $2`,
      [f.entityId, f.periodos[4]]
    );
    const original = asientoDeAbril.rows[0].id;
    await query(
      `UPDATE journal_entries SET reversed_by_entry_id = $1 WHERE id = $1`,
      [original]
    );
    try {
      const r = await correr([
        'payroll', 'accrue', '--period', '2026-04', '--yes', '--idempotency-key', 'devengo-abril',
      ]);
      expect(r.exitCode, `${r.out}${r.err}`).not.toBe(ExitCode.OK);
      const dicho = r.errs.map((e) => (e as Error).message).join(' | ');
      expect(dicho, 'no dijo que el asiento grabado se había reversado').toMatch(/revers/i);
    } finally {
      await query(`UPDATE journal_entries SET reversed_by_entry_id = NULL WHERE id = $1`, [original]);
    }
  });
});

// ── 4 · EL CÓDIGO DE SALIDA DEL ENSAYO ES EL DE LA CORRIDA ──────────────
describe('payroll accrue --dry-run · una ficha rota', () => {
  it('el ensayo sale con el MISMO código que la corrida, no con un 0 tranquilizador', async () => {
    // Un 'terminated' SIN fecha de baja es la ficha que el motor se niega a
    // devengar y NOMBRA en `errors`: no hay manera de saber hasta qué día
    // trabajó. Los otros dos devengan igual, así que la corrida postea Y sale 4.
    //
    // LO QUE ESTA PRUEBA VIGILA es que el ensayo diga lo mismo. Un guion que
    // mira antes de postear —`if mnemosine payroll accrue --dry-run; then …`—
    // lee el CÓDIGO, no el stderr donde va la advertencia; con un 0 aquí, el
    // guion daba el mes por limpio y la corrida salía 4 medio segundo después.
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, country_code, rfc, annual_salary, salary_type, currency_code, status)
       VALUES ($1, $2, $3, 'A-ROTO', 'Ficha', 'Rota', '2020-01-01', 'MX', 'XAXX010101000',
         '365000.00', 'salary', 'MXN', 'terminated')`,
      [uuidv4(), f.tenantId, f.entityId]
    );
    try {
      // Julio: un mes que ninguna otra prueba de este archivo ha tocado.
      const ensayo = await correr(['payroll', 'accrue', '--period', '2026-07', '--dry-run']);
      const real = await correr(['payroll', 'accrue', '--period', '2026-07', '--yes']);
      expect(real.exitCode, `${real.out}${real.err}`).toBe(ExitCode.VALIDATION);
      expect(ensayo.exitCode, `${ensayo.out}${ensayo.err}`).toBe(real.exitCode);
      // Y el ensayo NOMBRA al trabajador que no pudo devengar, no sólo lo cuenta.
      expect(ensayo.err).toContain('A-ROTO');
    } finally {
      await query(`DELETE FROM employees WHERE entity_id = $1 AND employee_number = 'A-ROTO'`, [
        f.entityId,
      ]);
    }
  });

  it('un mes CERRADO se niega en el ensayo igual que en la corrida, y no por accidente', async () => {
    // LA MISMA DIVERGENCIA, POR OTRA PUERTA. El rechazo del mes cerrado vive en
    // `validateJournalEntry` (regla `periodStatus`), que sólo corre dentro de
    // `createJournalEntry`: en la corrida. El ensayo no postea, así que nunca
    // llegaba a la regla y salía 0 de un mes en el que la corrida sale 4.
    //
    // Agosto, que ninguna otra prueba de este archivo toca.
    const { rows } = await query<{ id: string; status: string }>(
      `SELECT fp.id, fp.status FROM fiscal_periods fp
        WHERE fp.entity_id = $1 AND fp.period_number = 8 AND fp.period_type = 'regular'`,
      [f.entityId]
    );
    const agosto = rows[0];
    expect(agosto, 'el escenario no sembró un agosto regular').toBeDefined();
    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1`, [agosto.id]);
    try {
      const antes = await tamanoDelLibro();
      const ensayo = await correr(['payroll', 'accrue', '--period', '2026-08', '--dry-run']);
      const real = await correr(['payroll', 'accrue', '--period', '2026-08', '--yes']);
      expect(real.exitCode, `${real.out}${real.err}`).toBe(ExitCode.VALIDATION);
      expect(ensayo.exitCode, `${ensayo.out}${ensayo.err}`).toBe(real.exitCode);
      // Y NOMBRA el estado, para que quien lo lea sepa qué reabrir. El mensaje
      // del motor viaja por `reportError`, no por stderr.
      const dicho = ensayo.errs.map((e) => (e as Error).message).join(' | ');
      expect(dicho).toContain('hard_close');
      // Las dos dicen LO MISMO: es la prueba de que sale de una sola guarda.
      expect(real.errs.map((e) => (e as Error).message).join(' | ')).toBe(dicho);
      // Ninguna de las dos escribió: el mes cerrado sigue cerrado y vacío.
      expect(await tamanoDelLibro()).toEqual(antes);
    } finally {
      await query(`UPDATE fiscal_periods SET status = $2 WHERE id = $1`, [agosto.id, agosto.status]);
    }
  });
});
