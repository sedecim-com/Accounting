import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import {
  registerClosingCommand,
  conteoParaSalida,
  renderCasillas,
  type ClosingCommandDeps,
} from '../../src/cli/closing-command.js';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import { checkExitCode, riskOf, ExitCode } from '../../src/cli/kernel/index.js';
import {
  CLOSE_CHECK_CODES,
  type PeriodCloseChecklistItem,
} from '../../src/services/accounting/period-close.js';
import type { CloseReadiness, ClosablePeriod } from '../../src/ai/close-service.js';

// ============================================================
// F06b · `closing` contra el rulebook y contra su contrato de salida (§4):
// limpio 0, bloqueante 4, aviso 0 salvo --strict, código desconocido 2.
//
// El patrón es el de ap-command.spec: el programa se construye con dobles de
// los servicios (aquí NO se prueba el motor — eso lo hace
// close-checklist.spec y la integración), se le habla por parseAsync y se
// afirma sobre stdout/stderr y el código con que pidió apagarse.
// ============================================================

// ---- dobles --------------------------------------------------------

const mundo = vi.hoisted(() => ({
  periodos: [] as unknown[],
  readiness: undefined as unknown,
  explicacion: undefined as unknown,
  /** Cuántas veces se consultó el servicio de cierre: la promesa de que
   * `--check` a secas no toca la base se afirma con este contador. */
  consultas: 0,
}));

vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: () => undefined,
  resolveEntity: () => Promise.resolve({ tenantId: 'T1', entityId: 'E1', entityName: 'Acme SA' }),
}));

vi.mock('../../src/ai/close-service.js', () => ({
  listClosablePeriods: () => {
    mundo.consultas += 1;
    return Promise.resolve(mundo.periodos);
  },
  nextPeriodToClose: () => Promise.resolve(mundo.periodos[0]),
  getCloseReadiness: () => {
    mundo.consultas += 1;
    return Promise.resolve(mundo.readiness);
  },
}));

vi.mock('../../src/services/accounting/close-explain.js', () => ({
  explainCloseCheck: () => {
    mundo.consultas += 1;
    return Promise.resolve(mundo.explicacion);
  },
}));

// Identity palette: assert on text, not ANSI codes.
const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

const CASILLAS: PeriodCloseChecklistItem[] = [
  { codigo: 'entries-posted', item: 'All journal entries posted', is_complete: true, severity: 'blocking' },
  {
    codigo: 'bank-lines-unexplained', item: 'Bank statement lines explained',
    is_complete: false, severity: 'blocking', details: '2 movimiento(s) por 350.0000',
  },
  {
    codigo: 'bank-items-overdue', item: 'Reconciling items within their expected dates',
    is_complete: false, severity: 'warning', details: '1 partida(s) vencida(s)',
  },
];

const PERIODO: ClosablePeriod = {
  id: 'P-2026-08', period_name: '2026-08', period_number: 8,
  start_date: '2026-08-01', end_date: '2026-08-31',
  status: 'open', year_number: 2026, overdue: true,
};

function readiness(over: Partial<CloseReadiness> = {}): CloseReadiness {
  return {
    period: PERIODO,
    canClose: false,
    blockingIssues: ['2 movimiento(s) del extracto sin explicar al cierre'],
    warnings: ['1 partida(s) conciliatoria(s) pasaron su fecha esperada'],
    checklist: CASILLAS,
    ai: { pendingDrafts: 0, pendingQuestions: 0, pendingExternalOps: 0 },
    ...over,
  };
}

describe('conteoParaSalida', () => {
  it('cuenta sólo lo incompleto, separado por severidad', () => {
    expect(conteoParaSalida(CASILLAS)).toEqual({ blocking: 1, warning: 1 });
  });

  it('todo completo cuenta cero de cero: la salida es 0', () => {
    const limpio = CASILLAS.map((c) => ({ ...c, is_complete: true }));
    expect(conteoParaSalida(limpio)).toEqual({ blocking: 0, warning: 0 });
    expect(checkExitCode(conteoParaSalida(limpio))).toBe(ExitCode.OK);
  });

  it('el contrato §4 completo: bloqueante 4; sólo avisos 0, y 4 con --strict', () => {
    expect(checkExitCode(conteoParaSalida(CASILLAS))).toBe(ExitCode.VALIDATION);
    const soloAvisos = CASILLAS.filter((c) => c.severity !== 'blocking' || c.is_complete);
    expect(checkExitCode(conteoParaSalida(soloAvisos))).toBe(ExitCode.OK);
    expect(checkExitCode(conteoParaSalida(soloAvisos), { strict: true })).toBe(ExitCode.VALIDATION);
  });
});

describe('renderCasillas', () => {
  it('marca, código y prosa por casilla; el peso sólo cuando está incompleta', () => {
    const out = renderCasillas(CASILLAS, plain).join('\n');
    expect(out).toMatch(/✔ entries-posted.*All journal entries posted/);
    expect(out).not.toMatch(/entries-posted.*\[blocking\]/);
    expect(out).toMatch(/✘ bank-lines-unexplained.*\[blocking\]/);
    expect(out).toMatch(/✘ bank-items-overdue.*\[warning\]/);
  });

  it('muestra el detalle cuando lo hay', () => {
    const out = renderCasillas(CASILLAS, plain).join('\n');
    expect(out).toMatch(/2 movimiento\(s\) por 350\.0000/);
  });

  it('una selección vacía se dice, no se calla', () => {
    expect(renderCasillas([], plain).join('\n')).toMatch(/no checks selected/);
  });
});

describe('registro del comando closing', () => {
  const program = new Command();
  registerClosingCommand(program, {
    palette: plain,
    shutdown: () => undefined,
    reportError: () => undefined,
  });
  const closing = program.commands.find((c) => c.name() === 'closing');
  const hoja = (nombre: string) => closing?.commands.find((c) => c.name() === nombre);

  it('closing · cierre-proceso con sus tres hojas de lectura y alias', () => {
    expect(closing).toBeDefined();
    expect(closing?.aliases()).toContain('cierre-proceso');
    const hojas = Object.fromEntries(
      (closing?.commands ?? []).map((c) => [c.name(), c.aliases()])
    );
    expect(hojas.preview).toContain('previsualizar');
    expect(hojas.check).toContain('verificar');
    expect(hojas.explain).toContain('explicar');
    // Las otras siete filas de closing son F06d: aquí NO existen.
    expect(Object.keys(hojas).sort()).toEqual(['check', 'explain', 'preview']);
  });

  it('las tres son lectura y el agente puede invocarlas (✓ del catálogo)', () => {
    for (const h of closing?.commands ?? []) {
      const risk = riskOf(h);
      expect(risk?.risk, h.name()).toBe('lectura');
      expect(risk?.agentAllowed, h.name()).toBe(true);
    }
  });

  it('pasa la auditoría de consistencia sin violaciones', () => {
    expect(auditProgram(program)).toEqual([]);
  });

  it('las tres llevan el grupo de salida COMPLETO, no --json suelto', () => {
    for (const nombre of ['preview', 'check', 'explain']) {
      const longs = hoja(nombre)?.options.map((o) => o.long);
      expect(longs, nombre).toEqual(
        expect.arrayContaining(['--format', '--json', '--fields', '--output', '--quiet'])
      );
    }
  });

  it('preview y check llevan --strict; explain lleva -n/--limit y --period', () => {
    expect(hoja('preview')?.options.map((o) => o.long)).toContain('--strict');
    expect(hoja('check')?.options.map((o) => o.long)).toContain('--strict');
    const explain = hoja('explain');
    expect(explain?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--limit', '--period'])
    );
    expect(explain?.options.find((o) => o.long === '--limit')?.short).toBe('-n');
  });
});

// ---- conducta ------------------------------------------------------

async function correr(argv: string[], extra: Partial<ClosingCommandDeps> = {}) {
  let exitCode: number | undefined;
  const errs: unknown[] = [];
  const out: string[] = [];
  const err: string[] = [];
  mundo.consultas = 0;
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
    const p = new Command('mnemosine').exitOverride();
    registerClosingCommand(p, {
      palette: plain,
      shutdown: (c: number) => { exitCode = c; },
      reportError: (e: unknown) => { errs.push(e); },
      ...extra,
    });
    await p.parseAsync(['node', 'mnemosine', ...argv]);
  } finally {
    process.stdout.write = stdoutOriginal;
    process.stderr.write = stderrOriginal;
  }
  return { exitCode, errs, out: out.join(''), err: err.join('') };
}

describe('closing check · el contrato de salida', () => {
  it('--check a secas imprime el registro entero SIN tocar la base, y sale 0', async () => {
    const r = await correr(['closing', 'check', '--check']);
    for (const codigo of CLOSE_CHECK_CODES) expect(r.out).toContain(codigo);
    expect(mundo.consultas, 'preguntar qué se puede verificar no cuesta una conexión').toBe(0);
    expect(r.exitCode).toBe(ExitCode.OK);
  });

  it('un código desconocido es error de USO (2) que lista los disponibles', async () => {
    const r = await correr(['closing', 'check', '--check', 'no-existe']);
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(String(r.errs[0])).toMatch(/no-existe/);
    expect(String(r.errs[0])).toMatch(/previous-period-closed/);
    expect(mundo.consultas, 'el typo se rechaza ANTES de tocar la base').toBe(0);
  });

  it('completo, un bloqueante del motor manda exit 4', async () => {
    mundo.periodos = [PERIODO];
    mundo.readiness = readiness();
    const r = await correr(['closing', 'check']);
    expect(r.out).toMatch(/✘ bank-lines-unexplained.*\[blocking\]/);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
  });

  it('filtrado a una casilla de aviso: 0 a secas, 4 con --strict', async () => {
    mundo.periodos = [PERIODO];
    mundo.readiness = readiness();
    const suave = await correr(['closing', 'check', '--check', 'bank-items-overdue']);
    expect(suave.exitCode, 'el veredicto filtrado es SÓLO de lo pedido').toBe(ExitCode.OK);
    const duro = await correr(['closing', 'check', '--check', 'bank-items-overdue', '--strict']);
    expect(duro.exitCode).toBe(ExitCode.VALIDATION);
  });

  it('completo y sin casilla roja, un borrador de IA pendiente sigue mandando 4 — y se dice por stderr', async () => {
    mundo.periodos = [PERIODO];
    mundo.readiness = readiness({
      checklist: CASILLAS.map((c) => ({ ...c, is_complete: true, details: undefined })),
      blockingIssues: ['1 AI draft(s) dated inside this period are still pending review'],
      warnings: [],
      ai: { pendingDrafts: 1, pendingQuestions: 0, pendingExternalOps: 0 },
    });
    const r = await correr(['closing', 'check']);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
    expect(r.err, 'un exit 4 con todas las casillas en ✔ sería un misterio').toMatch(/AI draft/);
  });

  it('--fields se lee TAMBIÉN en la salida por omisión', async () => {
    mundo.periodos = [PERIODO];
    mundo.readiness = readiness();
    const r = await correr(['closing', 'check', '--fields', 'codigo']);
    expect(r.out).toContain('bank-lines-unexplained');
    // La columna de prosa NO se pidió: una bandera aceptada y no leída es
    // una promesa incumplida (la lección de ap reconcile).
    expect(r.out).not.toContain('All journal entries posted');
  });

  it('--json entrega el sobre versionado con las casillas como filas', async () => {
    mundo.periodos = [PERIODO];
    mundo.readiness = readiness();
    const r = await correr(['closing', 'check', '--json']);
    const sobre = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    expect(sobre.rows.map((f) => f.codigo)).toEqual(CASILLAS.map((c) => c.codigo));
    expect(sobre.rows[1].severity).toBe('blocking');
  });

  it('un periodo que no existe es NOT_FOUND (3), con los disponibles en el mensaje', async () => {
    mundo.periodos = [PERIODO];
    mundo.readiness = readiness();
    const r = await correr(['closing', 'check', '--period', '2026-99']);
    expect(r.exitCode).toBe(ExitCode.NOT_FOUND);
    expect(String(r.errs[0])).toMatch(/2026-08/);
  });
});

describe('closing preview · la listeza como veredicto', () => {
  it('bloqueado: enseña las casillas, los bloqueos y sale 4', async () => {
    mundo.periodos = [PERIODO];
    mundo.readiness = readiness();
    const r = await correr(['closing', 'preview']);
    expect(r.out).toMatch(/2026-08/);
    expect(r.out).toMatch(/Blocking:/);
    expect(r.out).toMatch(/cannot enter close/);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
  });

  it('limpio: lo dice y sale 0; con avisos, --strict endurece a 4', async () => {
    mundo.periodos = [PERIODO];
    mundo.readiness = readiness({ canClose: true, blockingIssues: [], warnings: [] });
    const limpio = await correr(['closing', 'preview']);
    expect(limpio.out).toMatch(/can enter close/);
    expect(limpio.exitCode).toBe(ExitCode.OK);

    mundo.readiness = readiness({ canClose: true, blockingIssues: [] });
    expect((await correr(['closing', 'preview'])).exitCode).toBe(ExitCode.OK);
    expect((await correr(['closing', 'preview', '--strict'])).exitCode).toBe(ExitCode.VALIDATION);
  });

  it('sin periodos abiertos no hay nada que previsualizar: 3, no un 0 vacío', async () => {
    mundo.periodos = [];
    const r = await correr(['closing', 'preview']);
    expect(r.exitCode).toBe(ExitCode.NOT_FOUND);
  });

  it('--json entrega el documento entero: veredicto, bloqueos y casillas', async () => {
    mundo.periodos = [PERIODO];
    mundo.readiness = readiness();
    const r = await correr(['closing', 'preview', '--json']);
    const sobre = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    expect(sobre.rows).toHaveLength(1);
    expect(sobre.rows[0].canClose).toBe(false);
    expect(sobre.rows[0].checklist).toHaveLength(CASILLAS.length);
  });
});

describe('closing explain · la lente, no el veredicto', () => {
  const EXPLICACION = {
    codigo: 'bank-items-overdue',
    item: 'Reconciling items within their expected dates',
    remedio: 'mnemosine bank reconciling-item assign <session> <item> --expected <YYYY-MM-DD>',
    total: 3,
    renglones: [
      { id: 'RI-1', importe: '120.0000', fecha: '2026-08-02' },
      { id: 'RI-2', importe: '-30.5000', fecha: '2026-08-15' },
    ],
  };

  it('enseña los renglones y el remedio, y sale 0 AUNQUE haya ofensores', async () => {
    mundo.periodos = [PERIODO];
    mundo.explicacion = EXPLICACION;
    const r = await correr(['closing', 'explain', 'bank-items-overdue']);
    expect(r.out).toMatch(/RI-1/);
    expect(r.out).toMatch(/120\.0000/);
    expect(r.out).toMatch(/fix with: mnemosine bank reconciling-item assign/);
    expect(r.exitCode, 'el código del hallazgo lo da `closing check`; mirar sale 0').toBe(ExitCode.OK);
  });

  it('limpio, lo dice en prosa en vez de una tabla vacía', async () => {
    mundo.periodos = [PERIODO];
    mundo.explicacion = { ...EXPLICACION, total: 0, renglones: [] };
    const r = await correr(['closing', 'explain', 'bank-items-overdue']);
    expect(r.out).toMatch(/nothing to explain/);
    expect(r.exitCode).toBe(ExitCode.OK);
  });

  it('--json: los renglones como filas y el TOTAL real en el sobre — el recorte de --limit nunca calla', async () => {
    mundo.periodos = [PERIODO];
    mundo.explicacion = EXPLICACION;
    const r = await correr(['closing', 'explain', 'bank-items-overdue', '--json']);
    const sobre = JSON.parse(r.out) as { total: number; truncated: boolean; rows: unknown[] };
    expect(sobre.rows).toHaveLength(2);
    expect(sobre.total).toBe(3);
    expect(sobre.truncated).toBe(true);
    expect(r.err, 'el remedio es nota: viaja por stderr, no ensucia el pipe').toMatch(/fix with:/);
  });
});
