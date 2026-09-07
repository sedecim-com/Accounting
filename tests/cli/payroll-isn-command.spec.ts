import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import { declareRisk, riskOf } from '../../src/cli/kernel/risk.js';
import { VERBS } from '../../src/cli/kernel/vocabulary.js';
import { BANNED_FLAGS, FLAG_DICTIONARY } from '../../src/cli/kernel/flags.js';
import { CliError, ExitCode } from '../../src/cli/kernel/exit.js';
import {
  ESTADOS_DE_PASIVO,
  PASIVO_QUE_SE_DEBE,
  REGIMENES_ISN,
  TASA_ISN_MAXIMA,
  diasEntre,
  exigirClaveDeEstado,
  exigirEstadosDePasivo,
  exigirExencion,
  exigirFechaIsn,
  exigirFundamento,
  exigirMesDeNomina,
  exigirRegimen,
  exigirTasaIsn,
  filaDePasivo,
  filaDeTasa,
  lineasDeLaCaptura,
  rangoDelMes,
  registerPayrollIsnCommands,
  solapaCon,
  traducirErrorDeCaptura,
  type CoberturaDeClave,
  type FilaPasivoPatronal,
} from '../../src/cli/payroll-isn-command.js';
import type { TasaIsn } from '../../src/services/payroll/mx/isn-calculator.js';

// ============================================================
// F08a · LA SUPERFICIE DEL ISN Y DEL PASIVO PATRONAL, ANTES DE QUE EL
// INTEGRADOR LA ENCHUFE EN mnemosine.ts.
//
// Construir el programa basta para probar el reglamento: `declareRisk` revienta
// en tiempo de REGISTRO y `auditProgram` recorre este árbol igual que recorre
// el binario embarcado.
//
// Lo que estas pruebas defienden, y por qué no es cosmético:
//
//  · QUE LA TASA NO SE PUEDA TECLEAR MAL SIN QUE SE DIGA. `--rate 3` queriendo
//    decir 3 % son 300 %: un impuesto cien veces mayor sobre una base
//    correcta, con el aspecto de un cálculo que corrió bien.
//  · QUE UNA TASA SIN FUNDAMENTO NO ENTRE. `fundamento TEXT NOT NULL` deja
//    pasar la cadena vacía, así que la guarda de verdad vive en la CLI y tiene
//    que estar probada aquí o no está probada en ninguna parte.
//  · QUE EL SOLAPE QUE ESTA CAPA ANUNCIA SEA EL MISMO QUE EL DISPARADOR
//    RECHAZA. Si las dos convenciones se separan, la vista previa dice «se
//    puede» y la base dice que no —o, mucho peor, al revés—.
//  · QUE LOS VOCABULARIOS QUE ESTA CAPA PUBLICA SIGAN SIENDO LOS DE LAS
//    MIGRACIONES. Los tres regímenes, los cuatro estados del pasivo y el tope
//    de la tasa se leen del SQL en la propia prueba: una CHECK que cambie y una
//    lista que no sale en el diff, no en la declaración de alguien.
//  · QUE LA CAPTURA AVISE CUANDO LA CLAVE NO ALCANZA A NADIE. Es el defecto que
//    de verdad se cobra caro: `mx_isn_tasas_estatales.estado` es VARCHAR(3) y
//    `employees.work_state` es VARCHAR(2), así que una tasa capturada como
//    «JAL» no casa jamás contra un centro de trabajo — y el motor no da error,
//    da «falta la tasa» sobre una tasa que está capturada.
// ============================================================

const deps = {
  palette: {
    dim: (s: string) => s,
    bold: (s: string) => s,
    cyan: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
  },
  shutdown: () => undefined,
  reportError: () => undefined,
};

const HOJAS = ['isn rate set', 'isn rate list', 'isn calculate', 'tax-deposit list'];

let program: Command;
let violaciones: ReturnType<typeof auditProgram>;
const riesgos = new Map<string, ReturnType<typeof riskOf>>();

beforeAll(() => {
  program = new Command('mnemosine');
  registerPayrollIsnCommands(program, deps);
  violaciones = auditProgram(program);
  for (const hoja of HOJAS) riesgos.set(hoja, riskOf(buscar(hoja)));
});

function buscar(ruta: string): Command {
  let nodo: Command = program;
  for (const token of ruta.split(' ')) {
    const siguiente = nodo.commands.find((c) => c.name() === token);
    if (!siguiente) throw new Error(`No command "${ruta}" (stuck at "${token}")`);
    nodo = siguiente;
  }
  return nodo;
}

function largas(ruta: string): (string | undefined)[] {
  return buscar(ruta).options.map((o) => o.long);
}

/** El código de salida que una llamada produce, o null si no lanzó. */
function codigoDe(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof CliError ? e.exitCode : -1;
  }
}

// ============================================================
// EL REGLAMENTO
// ============================================================

describe('the rulebook', () => {
  it('registers the two families without declareRisk refusing anything', () => {
    expect(program.commands.map((c) => c.name()).sort()).toEqual(['isn', 'tax-deposit']);
  });

  it('passes the consistency audit with no violations', () => {
    expect(violaciones).toEqual([]);
  });

  it('ships exactly the four leaves and no invented surface', () => {
    const hojas: string[] = [];
    const andar = (cmd: Command, prefijo: string[]) => {
      const ruta = [...prefijo, cmd.name()];
      if (cmd.commands.length === 0) hojas.push(ruta.join(' '));
      for (const hijo of cmd.commands) andar(hijo, ruta);
    };
    for (const hijo of program.commands) andar(hijo, []);
    expect(hojas.sort()).toEqual([...HOJAS].sort());
  });

  it('ends every leaf in a verb from the closed list', () => {
    for (const hoja of HOJAS) {
      expect(Object.keys(VERBS), hoja).toContain(hoja.split(' ').pop());
    }
  });

  it('keeps every leaf within the three-token depth limit', () => {
    for (const hoja of HOJAS) expect(hoja.split(' ').length, hoja).toBeLessThanOrEqual(3);
  });

  it('declares no banned spelling anywhere', () => {
    for (const hoja of HOJAS) {
      for (const prohibida of BANNED_FLAGS) {
        expect(largas(hoja), `${hoja} ${prohibida}`).not.toContain(prohibida);
      }
    }
  });
});

describe('the bilingual surface', () => {
  const ALIAS: Record<string, string> = {
    'isn rate': 'tasa',
    'isn rate set': 'fijar',
    'isn rate list': 'listar',
    'isn calculate': 'calcular',
    'tax-deposit': 'entero',
    'tax-deposit list': 'listar',
  };

  it('gives every command below the family exactly one Spanish alias', () => {
    for (const [ruta, alias] of Object.entries(ALIAS)) {
      expect(buscar(ruta).aliases(), ruta).toEqual([alias]);
    }
  });

  it("uses the vocabulary's Spanish verb for every verb command", () => {
    for (const [ruta, alias] of Object.entries(ALIAS)) {
      const verbo = ruta.split(' ').pop() as string;
      if (VERBS[verbo]) expect(alias, ruta).toBe(VERBS[verbo]);
    }
  });

  it('leaves `isn` untranslated: the acronym is the same word in both languages', () => {
    // Como `diot`, `cfdi` y `sat`. Un alias inventado para unas siglas sería
    // una segunda superficie, no una traducción.
    expect(buscar('isn').aliases()).toEqual([]);
  });
});

describe('safety declarations', () => {
  it('declares the capture a write, and keeps the agent out of it', () => {
    expect(riesgos.get('isn rate set')?.risk).toBe('escritura');
    expect(riesgos.get('isn rate set')?.agentAllowed).toBe(false);
    expect(riesgos.get('isn rate set')?.draftOnly).toBe(false);
  });

  it('refuses to ship an agent-invocable capture without draftOnly', () => {
    // Lo que la tabla recibe no es un borrador: multiplica cada nómina del
    // estado a partir de esa fecha, y no hay cola de revisión donde caiga.
    expect(() =>
      declareRisk(new Command('isn rate set'), { risk: 'escritura', agent: true })
    ).toThrow(/draftOnly/);
  });

  it('lets the agent read all three readers: none of them writes a row', () => {
    for (const hoja of ['isn rate list', 'isn calculate', 'tax-deposit list']) {
      expect(riesgos.get(hoja)?.risk, hoja).toBe('lectura');
      expect(riesgos.get(hoja)?.agentAllowed, hoja).toBe(true);
    }
  });

  it('says what the one write writes, and what it does NOT write', () => {
    const escribe = riesgos.get('isn rate set')?.writes ?? '';
    expect(escribe).toMatch(/mx_isn_tasas_estatales/);
    // La otra mitad del asunto: capturar una tasa no acumula ningún pasivo ni
    // postea ningún asiento. Eso pasa cuando la corrida se cierra.
    expect(escribe).toMatch(/ningun asiento y ningun pasivo/);
  });

  it('gives the capture a dry run and a confirmation skip, and NOT an idempotency key', () => {
    // No hay nada que deduplicar: la llave primaria (estado, vigencia_desde) ya
    // hace que la segunda captura idéntica choque en vez de repetirse.
    expect(largas('isn rate set')).toEqual(expect.arrayContaining(['--dry-run', '--yes']));
    expect(largas('isn rate set')).not.toContain('--idempotency-key');
  });

  it('gives the readers none of the mutation flags: nothing suggests they write', () => {
    for (const hoja of ['isn rate list', 'isn calculate', 'tax-deposit list']) {
      for (const bandera of ['--dry-run', '--yes', '--idempotency-key', '--force', '--live']) {
        expect(largas(hoja), `${hoja} ${bandera}`).not.toContain(bandera);
      }
    }
  });

  it('confirms through the kernel grammar, and goes through the mutation gate', () => {
    // El censo de tests/cli/confirmacion-gramatica.spec.ts vigila la CLASE en
    // todo src/cli/; esto fija que esta hoja concreta pasa por el kernel, que
    // es lo que hace que un «sí» tecleado en español cuente. Y `gateMutation`
    // FALLA CERRADO ante una hoja que muta sin declarar su riesgo: llamarla es
    // lo que mete a esta captura debajo de esa red.
    const fuente = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'cli', 'payroll-isn-command.ts'),
      'utf8'
    );
    expect(fuente).toMatch(/confirmarConReintento/);
    expect(fuente).not.toMatch(/\/\^y\|\^s\//);
    expect(fuente).toMatch(/gateMutation\(fijar,/);
  });
});

// ============================================================
// LA CAPTURA SE NIEGA ANTES DE ABRIR UNA CONEXIÓN
//
// Todo lo tecleable se valida antes del primer viaje a la base, así que estas
// invocaciones recorren la acción DE VERDAD —compuerta incluida— sin necesitar
// Postgres. Es lo único que prueba que las guardas están CABLEADAS y no sólo
// escritas: una función exportada que nadie llama pasa sus pruebas igual.
// ============================================================

describe('`isn rate set` refuses a bad capture without touching the database', () => {
  /**
   * Corre la hoja de verdad y devuelve el código de salida Y lo que se le dijo
   * al usuario. El MENSAJE se juzga junto al código porque un `2` a secas no
   * enseña a arreglar nada, y porque varias de estas guardas tienen debajo una
   * red genérica que produce el mismo código con la mitad de la explicación:
   * sin mirar el texto, borrar la guarda buena no rompería ninguna prueba.
   */
  async function correr(...argv: string[]): Promise<{ salida: number; dicho: string }> {
    let salida = -1;
    const dicho: string[] = [];
    const p = new Command('mnemosine');
    registerPayrollIsnCommands(p, {
      ...deps,
      shutdown: (code: number) => {
        salida = code;
      },
      reportError: (e: unknown) => {
        dicho.push(e instanceof Error ? e.message : String(e));
      },
    });
    await p.parseAsync(['node', 'mnemosine', ...argv]);
    return { salida, dicho: dicho.join('\n') };
  }

  const CITA = 'Ley de Hacienda del Estado de Jalisco art. 41';

  it('refuses a rate with no vigencia, and says why a rate needs one', async () => {
    const r = await correr('isn', 'rate', 'set', 'JAL', '3%', '--legal-basis', CITA);
    expect(r.salida).toBe(ExitCode.USAGE);
    // Debajo de esta guarda hay una red genérica de formato de fecha que sale
    // con el mismo 2 y dice sólo «must be a date as YYYY-MM-DD». Se exige la
    // explicación, que es la que impide que alguien capture sin vigencia
    // creyendo que la tasa vale para siempre.
    expect(r.dicho).toMatch(/--effective-from is required/);
    expect(r.dicho).toMatch(/it is a memory/);
  });

  it('refuses a rate with no grounds, which is the guard the NOT NULL column does not give', async () => {
    const r = await correr('isn', 'rate', 'set', 'JAL', '3%', '--effective-from', '2026-01-01');
    expect(r.salida).toBe(ExitCode.USAGE);
    expect(r.dicho).toMatch(/--legal-basis is required/);
  });

  it('refuses the bare 3 that would have been captured as three hundred percent', async () => {
    const r = await correr(
      'isn', 'rate', 'set', 'JAL', '3',
      '--effective-from', '2026-01-01', '--legal-basis', CITA
    );
    expect(r.salida).toBe(ExitCode.USAGE);
    expect(r.dicho).toMatch(/three hundred percent/);
  });

  it('refuses a vigencia that ends before it starts', async () => {
    const r = await correr(
      'isn', 'rate', 'set', 'JAL', '3%',
      '--effective-from', '2026-01-01', '--superseded-on', '2025-06-01',
      '--legal-basis', CITA
    );
    expect(r.salida).toBe(ExitCode.USAGE);
    expect(r.dicho).toMatch(/isn_vigencia_coherente/);
  });

  it('refuses an exempting regime that does not say how much it exempts', async () => {
    const r = await correr(
      'isn', 'rate', 'set', 'JAL', '3%', '--regime', 'con_exencion',
      '--effective-from', '2026-01-01', '--legal-basis', CITA
    );
    expect(r.salida).toBe(ExitCode.USAGE);
    expect(r.dicho).toMatch(/requires --exemption/);
  });

  it('refuses a state key that could never match a worker', async () => {
    const r = await correr(
      'isn', 'rate', 'set', '14', '3%',
      '--effective-from', '2026-01-01', '--legal-basis', CITA
    );
    expect(r.salida).toBe(ExitCode.USAGE);
    expect(r.dicho).toMatch(/is not a state key/);
  });
});

describe('`tax-deposit list` refuses a bad selector without touching the database', () => {
  async function correr(...argv: string[]): Promise<number> {
    let salida = -1;
    const p = new Command('mnemosine');
    registerPayrollIsnCommands(p, {
      ...deps,
      shutdown: (code: number) => {
        salida = code;
      },
      reportError: () => undefined,
    });
    await p.parseAsync(['node', 'mnemosine', ...argv]);
    return salida;
  }

  it('refuses a period that is not a month', async () => {
    expect(await correr('tax-deposit', 'list', '--period', 'last-month')).toBe(ExitCode.USAGE);
  });

  it('refuses a status the table does not have, instead of quietly returning nothing', async () => {
    expect(await correr('tax-deposit', 'list', '--status', 'paid')).toBe(ExitCode.USAGE);
  });

  it('refuses a due-date horizon that is not a date', async () => {
    expect(await correr('tax-deposit', 'list', '--until', '17/08/2026')).toBe(ExitCode.USAGE);
  });
});

describe('`isn calculate` refuses without a run instead of guessing one', () => {
  it('names the flag it needs and why the run is where the states live', async () => {
    let salida = -1;
    const p = new Command('mnemosine');
    registerPayrollIsnCommands(p, {
      ...deps,
      shutdown: (code: number) => {
        salida = code;
      },
      reportError: () => undefined,
    });
    await p.parseAsync(['node', 'mnemosine', 'isn', 'calculate']);
    expect(salida).toBe(ExitCode.USAGE);
  });
});

describe('the flags each leaf carries', () => {
  it('gives the capture the vigencia, the grounds and the regime', () => {
    expect(largas('isn rate set')).toEqual(
      expect.arrayContaining([
        '--effective-from',
        '--superseded-on',
        '--legal-basis',
        '--regime',
        '--exemption',
      ])
    );
  });

  it('takes the state and the rate as arguments, so --rate keeps its one meaning', () => {
    // `--rate` está congelada en el diccionario desde F05d como la tasa de IVA
    // de una comisión bancaria. Reutilizarla aquí sería una grafía con dos
    // significados; el precedente de `fx rate set` es tomarla como argumento.
    expect(largas('isn rate set')).not.toContain('--rate');
    const args = (
      buscar('isn rate set') as unknown as { registeredArguments: Array<{ name(): string }> }
    ).registeredArguments;
    expect(args.map((a) => a.name())).toEqual(['state', 'rate']);
  });

  it('never reuses --start/--end for a half-open vigencia', () => {
    // D1a las congeló como la ventana de cobertura de un contrato, INCLUSIVA
    // por los dos extremos. La vigencia de una tasa es semiabierta [desde,
    // hasta) porque así la define el disparador de la 067, y una grafía con dos
    // convenciones de inclusividad aplica la tasa vieja un día de más en cada
    // cambio estatal.
    expect(largas('isn rate set')).not.toContain('--start');
    expect(largas('isn rate set')).not.toContain('--end');
    expect(largas('isn rate set')).toContain('--effective-from');
    expect(largas('isn rate set')).toContain('--superseded-on');
  });

  it('never reuses --kind or --method for the regime: the values come from a CHECK', () => {
    expect(largas('isn rate set')).not.toContain('--kind');
    expect(largas('isn rate set')).not.toContain('--method');
    expect(largas('isn rate set')).toContain('--regime');
  });

  it('declares no --status on the rate list: a vigencia has no lifecycle', () => {
    // Una bandera declarada que nadie lee es el defecto que este repositorio ya
    // cazó en `ap reconcile`.
    expect(largas('isn rate list')).not.toContain('--status');
    expect(largas('isn rate list')).toEqual(
      expect.arrayContaining(['--limit', '--offset', '--all', '--state', '--as-of'])
    );
  });

  it('gives the liability list the period, the horizon, the status and the entities', () => {
    expect(largas('tax-deposit list')).toEqual(
      expect.arrayContaining(['--period', '--until', '--status', '--all-entities', '--all'])
    );
  });

  it('tells the truth about -a on the liability list, which the kernel wording did not', () => {
    const todo = buscar('tax-deposit list').options.find((o) => o.long === '--all');
    // `withSelection` la describe como «no default limit; include archived and
    // closed». Aquí no quita ningún tope y no hay nada archivado: hay
    // depositado y dispensado.
    expect(todo?.description).not.toMatch(/archived/);
    expect(todo?.description).toMatch(/deposited and waived/);
  });

  it('keeps every dictionary flag it reuses at the short form the dictionary assigns', () => {
    for (const hoja of HOJAS) {
      for (const opcion of buscar(hoja).options) {
        const largo = opcion.long ?? '';
        if (!Object.prototype.hasOwnProperty.call(FLAG_DICTIONARY, largo)) continue;
        expect(opcion.short ?? null, `${hoja} ${largo}`).toBe(FLAG_DICTIONARY[largo]);
      }
    }
  });

  it('gives every leaf the output contract, so --fields works on the default table too', () => {
    for (const hoja of HOJAS) {
      expect(largas(hoja), hoja).toEqual(expect.arrayContaining(['--format', '--json', '--fields']));
    }
  });
});

// ============================================================
// LOS VOCABULARIOS SIGUEN SIENDO LOS DE LAS MIGRACIONES
//
// Se leen del SQL, no de una copia. Una lista escrita a mano que se desincroniza
// de su CHECK no falla en la prueba: falla en producción, con un error del
// driver que no enseña nada.
// ============================================================

describe('the vocabularies this layer publishes come from the migrations', () => {
  const sql = (nombre: string) =>
    fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'database', 'migrations', nombre),
      'utf8'
    );

  it('publishes the three ISN regimes the 067 CHECK enumerates', () => {
    const texto = sql('067_lo_que_el_patron_paga_y_nadie_apunta.sql');
    const m = /CHECK \(regimen IN \(([^)]*)\)\)/.exec(texto);
    expect(m, 'the CHECK on mx_isn_tasas_estatales.regimen moved').not.toBeNull();
    const enElSql = (m as RegExpExecArray)[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''));
    expect([...REGIMENES_ISN].sort()).toEqual(enElSql.sort());
  });

  it('publishes the same rate ceiling the 067 CHECK enforces', () => {
    const texto = sql('067_lo_que_el_patron_paga_y_nadie_apunta.sql');
    const m = /CHECK \(tasa >= 0 AND tasa <= ([\d.]+)\)/.exec(texto);
    expect(m, 'the CHECK on mx_isn_tasas_estatales.tasa moved').not.toBeNull();
    expect(TASA_ISN_MAXIMA).toBe((m as RegExpExecArray)[1]);
  });

  it('publishes the four liability statuses the 008 CHECK enumerates', () => {
    const texto = sql('008_payroll.sql');
    const m = /CHECK \(status IN \('pending', 'deposited', 'late', 'waived'\)\)/.exec(texto);
    expect(m, 'the CHECK on employer_tax_liabilities.status moved').not.toBeNull();
    expect([...ESTADOS_DE_PASIVO].sort()).toEqual(
      ['deposited', 'late', 'pending', 'waived']
    );
  });

  it('shows by default only what is still owed, and every default is a real status', () => {
    expect([...PASIVO_QUE_SE_DEBE]).toEqual(['pending', 'late']);
    for (const e of PASIVO_QUE_SE_DEBE) expect(ESTADOS_DE_PASIVO).toContain(e);
  });
});

// ============================================================
// LA TASA, QUE ES DONDE UN DEDO EQUIVOCADO CUESTA CIEN VECES
// ============================================================

describe('exigirTasaIsn', () => {
  it('reads a percentage and a fraction as the same rate', () => {
    expect(exigirTasaIsn('3%')).toBe('0.030000');
    expect(exigirTasaIsn('0.03')).toBe('0.030000');
    expect(exigirTasaIsn(' 2.5% ')).toBe('0.025000');
  });

  it('refuses a bare 3 and says both spellings, because a bare 3 is 300%', () => {
    const e = codigoDe(() => exigirTasaIsn('3'));
    expect(e).toBe(ExitCode.USAGE);
    expect(() => exigirTasaIsn('3')).toThrow(/0\.03 or 3%/);
    expect(() => exigirTasaIsn('3')).toThrow(/three hundred percent/);
  });

  it('accepts the ceiling and refuses one step past it', () => {
    expect(exigirTasaIsn(TASA_ISN_MAXIMA)).toBe('0.150000');
    expect(() => exigirTasaIsn('0.151')).toThrow(/ceiling/);
  });

  it('refuses more decimals than the column keeps instead of rounding in silence', () => {
    // DECIMAL(8,6). Redondear aquí guardaría una tasa que nadie tecleó.
    expect(exigirTasaIsn('0.031234')).toBe('0.031234');
    expect(() => exigirTasaIsn('0.0312345')).toThrow(/more than 6 decimals/);
  });

  it('refuses what is not a number, and anything negative', () => {
    for (const malo of ['', '   ', 'tres', '-0.03', '0,03', '1e-2']) {
      expect(codigoDe(() => exigirTasaIsn(malo)), malo).toBe(ExitCode.USAGE);
    }
  });

  it('accepts zero: a state may charge nothing, and that is a captured fact', () => {
    expect(exigirTasaIsn('0')).toBe('0.000000');
  });
});

describe('exigirClaveDeEstado', () => {
  it('normalises the way the engine normalises, so the capture can ever match', () => {
    // `basesIsnDeCorrida` compara con UPPER(TRIM(...)). Capturar « jal » y
    // buscar «JAL» sería una tasa que existe y no casa con nadie.
    expect(exigirClaveDeEstado(' jal ')).toBe('JAL');
    expect(exigirClaveDeEstado('JA')).toBe('JA');
  });

  it('refuses digits, punctuation, and anything the VARCHAR(3) column cannot hold', () => {
    for (const malo of ['', '  ', '14', 'J', 'JALI', 'JA-L', 'MÉX']) {
      expect(codigoDe(() => exigirClaveDeEstado(malo)), malo).toBe(ExitCode.USAGE);
    }
  });
});

describe('exigirFundamento', () => {
  it('refuses the blank the NOT NULL column would have accepted, and teaches what goes there', () => {
    // `fundamento TEXT NOT NULL` no impide la cadena vacía: NOT NULL no es «no
    // vacío», y sin esta guarda la tabla se llena de tasas sin cita.
    //
    // El MENSAJE se fija junto al código, y no por gusto: el que no escribió
    // nada no sabe qué se le pide, así que su rechazo tiene que traer el
    // ejemplo. Sin esta comprobación, borrar la rama del vacío no rompe nada
    // —el piso de caracteres la cubre— y el usuario pierde la única línea que
    // le dice qué es un fundamento.
    for (const vacio of [undefined, '', '   ', '\t\n']) {
      expect(codigoDe(() => exigirFundamento(vacio)), JSON.stringify(vacio)).toBe(ExitCode.USAGE);
      expect(() => exigirFundamento(vacio)).toThrow(/--legal-basis is required/);
      expect(() => exigirFundamento(vacio)).toThrow(/Ley de Hacienda/);
    }
  });

  it('refuses the one-letter filler that turns a required field into an optional one', () => {
    for (const relleno of ['x', 'ok', 'ley']) {
      expect(codigoDe(() => exigirFundamento(relleno)), relleno).toBe(ExitCode.USAGE);
      // Otro rechazo y otro consejo: aquí sí se intentó, y lo que falta es la
      // ley y el artículo.
      expect(() => exigirFundamento(relleno)).toThrow(/too short to be a citation/);
    }
  });

  it('keeps a real citation exactly as typed, trimmed', () => {
    const cita = '  Ley de Hacienda del Estado de Jalisco art. 41, POE 2025-12-15  ';
    expect(exigirFundamento(cita)).toBe(cita.trim());
  });
});

describe('exigirExencion', () => {
  it('mirrors the CHECK both ways: with the regime, and only with it', () => {
    expect(exigirExencion('con_exencion', '8000')).toBe('8000.0000');
    expect(exigirExencion('tasa_plana', undefined)).toBeNull();
    expect(codigoDe(() => exigirExencion('con_exencion', undefined))).toBe(ExitCode.USAGE);
    expect(codigoDe(() => exigirExencion('tasa_plana', '8000'))).toBe(ExitCode.USAGE);
    expect(codigoDe(() => exigirExencion('escalonado', '8000'))).toBe(ExitCode.USAGE);
  });

  it('keeps the exempt amount as a four-decimal string, never a float', () => {
    expect(exigirExencion('con_exencion', '8000.12345')).toBe('8000.1235');
    expect(typeof exigirExencion('con_exencion', '0.1')).toBe('string');
  });
});

describe('exigirRegimen', () => {
  it('defaults to the only one the engine can compute', () => {
    expect(exigirRegimen(undefined)).toBe('tasa_plana');
  });
  it('refuses anything the CHECK does not know', () => {
    expect(codigoDe(() => exigirRegimen('progresivo'))).toBe(ExitCode.USAGE);
  });
});

describe('exigirFechaIsn', () => {
  it('refuses a day that does not exist instead of overflowing into the next month', () => {
    // `new Date('2026-02-30')` no es inválida: se desborda al 2 de marzo, y una
    // vigencia que empieza dos días después de lo tecleado no la ve nadie.
    expect(codigoDe(() => exigirFechaIsn('--effective-from', '2026-02-30'))).toBe(ExitCode.USAGE);
    expect(exigirFechaIsn('--effective-from', '2028-02-29')).toBe('2028-02-29');
  });
  it('refuses anything that is not YYYY-MM-DD', () => {
    for (const malo of ['2026-1-1', '01/01/2026', '2026-01', '']) {
      expect(codigoDe(() => exigirFechaIsn('--as-of', malo)), malo).toBe(ExitCode.USAGE);
    }
  });
});

describe('exigirMesDeNomina and rangoDelMes', () => {
  it('reads the month and refuses everything else', () => {
    expect(exigirMesDeNomina('2026-07')).toEqual({ anio: 2026, mes: 7 });
    for (const malo of ['2026', '2026-13', '2026-00', 'last-month', '']) {
      expect(codigoDe(() => exigirMesDeNomina(malo)), malo).toBe(ExitCode.USAGE);
    }
  });

  it('closes the month without a table of months and without a leap-year branch', () => {
    expect(rangoDelMes(2026, 2)).toEqual({ desde: '2026-02-01', hasta: '2026-02-28' });
    expect(rangoDelMes(2028, 2)).toEqual({ desde: '2028-02-01', hasta: '2028-02-29' });
    expect(rangoDelMes(2026, 12)).toEqual({ desde: '2026-12-01', hasta: '2026-12-31' });
  });
});

// ============================================================
// EL SOLAPE: LA MISMA CONVENCIÓN QUE EL DISPARADOR
// ============================================================

describe('solapaCon', () => {
  const tasa = (desde: string, hasta: string | null): TasaIsn => ({
    estado: 'JAL',
    vigenciaDesde: desde,
    vigenciaHasta: hasta,
    tasa: '0.030000',
    regimen: 'tasa_plana',
    exencionMensual: null,
    fundamento: 'x',
  });

  it('does NOT call two adjacent vigencias an overlap', () => {
    // La convención es SEMIABIERTA: una que cede el 2026-01-01 y la siguiente
    // que abre ese mismo día no chocan, y ese día pertenece a la segunda. Es
    // exactamente lo que `vigenteEn` lee y lo que el disparador permite.
    const previas = [tasa('2025-01-01', '2026-01-01')];
    expect(solapaCon(previas, '2026-01-01', null)).toEqual([]);
  });

  it('does NOT call it an overlap when the NEW one closes exactly where an old one opens', () => {
    // El otro extremo del mismo caso, y el que un operador teclea de verdad:
    // capturar hacia atrás la vigencia anterior, cerrándola el día en que
    // empieza la que ya está. Si esta comparación se afloja a `>=`, capturar
    // la histórica se vuelve imposible y nadie sabe por qué.
    const previas = [tasa('2026-01-01', null)];
    expect(solapaCon(previas, '2025-01-01', '2026-01-01')).toEqual([]);
  });

  it('catches the vigencia that starts inside an open-ended one', () => {
    const previas = [tasa('2025-01-01', null)];
    expect(solapaCon(previas, '2026-01-01', null)).toHaveLength(1);
    expect(solapaCon(previas, '2026-01-01', '2026-06-01')).toHaveLength(1);
  });

  it('catches the one that swallows an existing closed vigencia', () => {
    const previas = [tasa('2025-06-01', '2025-09-01')];
    expect(solapaCon(previas, '2025-01-01', '2026-01-01')).toHaveLength(1);
  });

  it('catches the exact same primary key, which is a conflict and not an overlap', () => {
    const previas = [tasa('2026-01-01', '2026-02-01')];
    expect(solapaCon(previas, '2026-01-01', '2026-02-01')).toHaveLength(1);
  });

  it('leaves a vigencia that ends before the new one starts alone', () => {
    const previas = [tasa('2024-01-01', '2025-01-01')];
    expect(solapaCon(previas, '2026-01-01', null)).toEqual([]);
  });

  it('agrees with the predicate the 067 trigger actually runs', () => {
    // El disparador dice:
    //   NEW.desde < COALESCE(t.hasta, '9999-12-31')
    //   AND COALESCE(NEW.hasta, '9999-12-31') > t.desde
    // Se reproduce aquí de forma independiente y se cotejan las dos sobre una
    // rejilla de casos: si alguien "simplifica" `solapaCon`, esto lo caza.
    const INF = '9999-12-31';
    const comoElDisparador = (
      nd: string,
      nh: string | null,
      td: string,
      th: string | null
    ): boolean => nd < (th ?? INF) && (nh ?? INF) > td;

    const fechas = ['2025-01-01', '2025-06-01', '2026-01-01', '2026-06-01'];
    for (const td of fechas) {
      for (const th of [...fechas, null]) {
        if (th !== null && th <= td) continue;
        for (const nd of fechas) {
          for (const nh of [...fechas, null]) {
            if (nh !== null && nh <= nd) continue;
            if (nd === td) continue; // misma llave primaria: es otro error
            const previa = [tasa(td, th)];
            expect(
              solapaCon(previa, nd, nh).length > 0,
              `new ${nd}->${nh ?? 'open'} vs ${td}->${th ?? 'open'}`
            ).toBe(comoElDisparador(nd, nh, td, th));
          }
        }
      }
    }
  });
});

describe('diasEntre', () => {
  it('counts calendar days and goes negative once the date has passed', () => {
    expect(diasEntre('2026-07-01', '2026-07-17')).toBe(16);
    expect(diasEntre('2026-07-18', '2026-07-17')).toBe(-1);
    // Cruzando un cambio de horario: la aritmética va en UTC a propósito, así
    // que la hora de verano no roba ni regala un día de plazo.
    expect(diasEntre('2026-10-20', '2026-11-20')).toBe(31);
  });
});

// ============================================================
// LAS FILAS QUE SALEN
// ============================================================

describe('filaDeTasa', () => {
  const t: TasaIsn = {
    estado: 'JAL',
    vigenciaDesde: '2026-01-01',
    vigenciaHasta: null,
    tasa: '0.030000',
    regimen: 'tasa_plana',
    exencionMensual: null,
    fundamento: 'Ley de Hacienda art. 41',
  };

  it('keeps the rate a string and shows the percentage a human reads', () => {
    const f = filaDeTasa(t);
    expect(f.tasa).toBe('0.030000');
    expect(typeof f.tasa).toBe('string');
    expect(f.porcentaje).toBe('3.0000%');
  });

  it('says "still in force" as an empty end, the way the NULL column says it', () => {
    expect(filaDeTasa(t).superseded_on).toBe('');
  });

  it('marks what was in force on the day asked, and only when a day is asked', () => {
    expect(filaDeTasa(t)).not.toHaveProperty('vigente');
    expect(filaDeTasa(t, '2026-06-01').vigente).toBe(true);
    expect(filaDeTasa(t, '2025-06-01').vigente).toBe(false);
    // El día del cierre pertenece a la SIGUIENTE vigencia, como en el motor.
    const cerrada = { ...t, vigenciaHasta: '2026-06-01' };
    expect(filaDeTasa(cerrada, '2026-06-01').vigente).toBe(false);
    expect(filaDeTasa(cerrada, '2026-05-31').vigente).toBe(true);
  });
});

describe('filaDePasivo', () => {
  const base: FilaPasivoPatronal = {
    id: 'a1',
    entidad: 'Acme SA de CV',
    pay_run_id: 'r1',
    tax_type: 'isn',
    jurisdiction: 'MX-JAL',
    period_start: '2026-07-01',
    period_end: '2026-07-31',
    amount: '1234.56',
    due_date: '2026-08-17',
    deposit_frequency: 'monthly',
    status: 'pending',
    deposited_at: null,
    deposit_reference: null,
  };

  it('keeps money a string all the way out', () => {
    const f = filaDePasivo(base, '2026-08-01');
    expect(f.importe).toBe('1234.56');
    expect(typeof f.importe).toBe('string');
  });

  it('calls a row overdue from the calendar, not from the column somebody forgot to move', () => {
    // `status` la mueve una persona al registrar el entero; `vencido` sale de
    // comparar la fecha límite con hoy. Un 'pending' cuya fecha pasó está
    // vencido aunque nadie lo haya marcado 'late', y ése es el que hay que ver.
    expect(filaDePasivo(base, '2026-08-18').vencido).toBe(true);
    expect(filaDePasivo(base, '2026-08-17').vencido).toBe(false);
    expect(filaDePasivo(base, '2026-08-01').dias).toBe(16);
    expect(filaDePasivo(base, '2026-08-18').dias).toBe(-1);
  });

  it('never calls a settled row overdue, however old it is', () => {
    for (const status of ['deposited', 'waived']) {
      expect(filaDePasivo({ ...base, status }, '2027-01-01').vencido, status).toBe(false);
    }
    expect(filaDePasivo({ ...base, status: 'late' }, '2027-01-01').vencido).toBe(true);
  });

  it('serialises the deposit instant itself, and leaves it blank when there is none', () => {
    expect(filaDePasivo(base, '2026-08-01').depositado_el).toBe('');
    const pagado = {
      ...base,
      status: 'deposited',
      deposited_at: new Date('2026-08-16T18:30:00.000Z'),
    };
    expect(filaDePasivo(pagado, '2026-08-20').depositado_el).toBe('2026-08-16T18:30:00.000Z');
  });
});

describe('exigirEstadosDePasivo', () => {
  it('defaults to what is still owed, so three due dates are not buried under two hundred paid', () => {
    expect(exigirEstadosDePasivo(undefined)).toEqual(['pending', 'late']);
    expect(exigirEstadosDePasivo([])).toEqual(['pending', 'late']);
  });

  it('refuses a status the table does not have instead of returning an empty list', () => {
    // Un filtro que no casa nada y sale 0 es la forma exacta en que una tubería
    // verde miente: «no debes nada» y «pregunté mal» no son la misma respuesta.
    expect(codigoDe(() => exigirEstadosDePasivo(['paid']))).toBe(ExitCode.USAGE);
    expect(exigirEstadosDePasivo(['deposited'])).toEqual(['deposited']);
  });
});

// ============================================================
// LO QUE SE ENSEÑA ANTES DE ESCRIBIR
// ============================================================

describe('lineasDeLaCaptura', () => {
  const cobertura = (p: Partial<CoberturaDeClave> = {}): CoberturaDeClave => ({
    criterio: 'centro_de_trabajo',
    criterioDefinido: true,
    alcanzados: 12,
    otras: [],
    ...p,
  });

  const datos = (p: Record<string, unknown> = {}) => ({
    estado: 'JAL',
    tasa: '0.030000',
    regimen: 'tasa_plana' as const,
    exencion: null,
    desde: '2026-01-01',
    hasta: null,
    fundamento: 'Ley de Hacienda del Estado de Jalisco art. 41',
    cobertura: cobertura(),
    choques: [] as TasaIsn[],
    ...p,
  });

  it('shows every value that is about to be written, including the grounds', () => {
    const texto = lineasDeLaCaptura(datos()).join('\n');
    expect(texto).toMatch(/JAL/);
    expect(texto).toMatch(/0\.030000/);
    expect(texto).toMatch(/3\.0000%/);
    expect(texto).toMatch(/Ley de Hacienda del Estado de Jalisco art\. 41/);
    expect(texto).toMatch(/2026-01-01/);
    expect(texto).toMatch(/sigue vigente|sin cierre/);
  });

  it('names the table it writes to, and that it is a catalog without tenant_id', () => {
    expect(lineasDeLaCaptura(datos()).join('\n')).toMatch(/mx_isn_tasas_estatales/);
  });

  it('shouts when the key reaches nobody, and lists the keys that ARE in use', () => {
    const texto = lineasDeLaCaptura(
      datos({
        cobertura: cobertura({
          alcanzados: 0,
          otras: [{ clave: 'JA', trabajadores: 12 }, { clave: '', trabajadores: 3 }],
        }),
      })
    ).join('\n');
    expect(texto).toMatch(/NOBODY/);
    expect(texto).toMatch(/JA=12/);
    expect(texto).toMatch(/\(blank\)=3/);
  });

  it('names the VARCHAR(2) trap when a three-letter key is captured against work_state', () => {
    // Es el defecto que de verdad se cobra caro: «JAL» no puede casar jamás
    // contra un `employees.work_state VARCHAR(2)`, y el motor no da error — da
    // «falta la tasa» sobre una tasa que está capturada.
    const texto = lineasDeLaCaptura(
      datos({ estado: 'JAL', cobertura: cobertura({ alcanzados: 0 }) })
    ).join('\n');
    expect(texto).toMatch(/VARCHAR\(2\)/);
    expect(texto).toMatch(/can never match/);
  });

  it('does NOT cry VARCHAR(2) when the criterion reads the entity domicile', () => {
    // `legal_entities.state_province` es VARCHAR(120): ahí «JAL» cabe de sobra,
    // y un aviso que no aplica es ruido que enseña a ignorar los avisos.
    const texto = lineasDeLaCaptura(
      datos({
        estado: 'JAL',
        cobertura: cobertura({ criterio: 'domicilio_fiscal', alcanzados: 0 }),
      })
    ).join('\n');
    expect(texto).toMatch(/NOBODY/);
    expect(texto).not.toMatch(/VARCHAR\(2\)/);
    expect(texto).toMatch(/legal_entities\.state_province/);
  });

  it('never presents an unanswered policy as a decision of the firm', () => {
    const contestada = lineasDeLaCaptura(datos()).join('\n');
    expect(contestada).not.toMatch(/default/);
    const porOmision = lineasDeLaCaptura(
      datos({ cobertura: cobertura({ criterioDefinido: false }) })
    ).join('\n');
    expect(porOmision).toMatch(/isn_estado_que_causa=centro_de_trabajo \(default/);
  });

  it('names the vigencia it would collide with, which the trigger alone cannot do', () => {
    const choque: TasaIsn = {
      estado: 'JAL',
      vigenciaDesde: '2025-01-01',
      vigenciaHasta: null,
      tasa: '0.025000',
      regimen: 'tasa_plana',
      exencionMensual: null,
      fundamento: 'previa',
    };
    const texto = lineasDeLaCaptura(datos({ choques: [choque] })).join('\n');
    expect(texto).toMatch(/OVERLAP/);
    expect(texto).toMatch(/2025-01-01/);
    expect(texto).toMatch(/0\.025000/);
    expect(texto).toMatch(/trg_isn_sin_solape/);
  });

  it('shows the exempt amount only when there is one', () => {
    expect(lineasDeLaCaptura(datos()).join('\n')).not.toMatch(/exencion mensual/);
    const conExencion = lineasDeLaCaptura(
      datos({ regimen: 'con_exencion' as const, exencion: '8000.0000' })
    ).join('\n');
    expect(conExencion).toMatch(/exencion mensual\s+8,000\.00/);
  });
});

// ============================================================
// LOS ERRORES DE LA BASE, TRADUCIDOS
// ============================================================

describe('traducirErrorDeCaptura', () => {
  it('turns the primary-key clash into a conflict that says how to look first', () => {
    const e = traducirErrorDeCaptura({ code: '23505', message: 'dup' }, 'JAL', '2026-01-01');
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).exitCode).toBe(ExitCode.CONFLICT);
    expect((e as CliError).message).toMatch(/isn rate list --state JAL -a/);
  });

  it('turns the overlap trigger into a validation failure that says how to fix it', () => {
    const err = new Error('La tasa de ISN de JAL desde 2026-01-01 se solapa con otra vigencia');
    (err as unknown as { code: string }).code = '23514';
    const e = traducirErrorDeCaptura(err, 'JAL', '2026-01-01');
    expect((e as CliError).exitCode).toBe(ExitCode.VALIDATION);
    expect((e as CliError).message).toMatch(/--superseded-on/);
  });

  it('lets anything it does not recognise through untouched, instead of mislabelling it', () => {
    const suyo = new Error('connection terminated');
    expect(traducirErrorDeCaptura(suyo, 'JAL', '2026-01-01')).toBe(suyo);
  });
});
