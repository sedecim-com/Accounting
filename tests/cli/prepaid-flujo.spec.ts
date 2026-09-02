import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ============================================================
// D1a · LAS CUATRO HOJAS EJECUTADAS DE VERDAD.
//
// La otra suite (`prepaid-command.spec.ts`) mira la FORMA del comando y la
// aritmética pura. Ésta empuja la puerta: arma el programa, le pasa un argv y
// comprueba lo que sale por stdout y por stderr, con el motor y la base
// sustituidos por dobles.
//
// Lo que sólo se puede comprobar así:
//   · que `--dry-run` no llame al motor NI UNA vez (en la corrida es la
//     diferencia entre mirar y postear en un mayor que no admite deshacer);
//   · que la confirmación se pida y que un «no» aborte con el código 10;
//   · que las comprobaciones de uso ocurran ANTES de gastar una conexión;
//   · que el hueco heredado se avise aunque la tabla salga vacía.
//
// La base NO se sustituye por un doble amable: `query` está mockeada para
// REVENTAR. Si algún día una de estas hojas se escribe una consulta propia en
// vez de pasar por un servicio —y con ella su propio alcance por entidad—,
// estas pruebas se caen.
// ============================================================

// `vi.hoisted` porque las fábricas de `vi.mock` se izan por encima de todo lo
// demás del archivo: una constante declarada arriba no existe todavía cuando
// la fábrica corre.
const { revienta, POLIZA } = vi.hoisted(() => {
  const revienta = (nombre: string) => () => {
    throw new Error(`${nombre} no debía llamarse en esta prueba`);
  };
  const POLIZA = {
    id: 'p1',
    entity_id: 'e1',
    description: 'Póliza de seguro 2026',
    vendor_name: 'Aseguradora SA',
    reference: 'POL-778',
    total_amount: '12000.0000',
    coverage_start_date: new Date(2026, 0, 1),
    coverage_end_date: new Date(2026, 11, 31),
    prepaid_account_id: 'c-1160',
    expense_account_id: 'c-6100',
    amortization_convention: 'proporcional_dias',
    origin: 'cfdi' as const,
    source_journal_entry_id: 'je-1',
    cfdi_uuid: null,
    amortized_to_date: '0.0000',
    remaining_amount: '12000.0000',
    last_amortization_date: null,
    status: 'active' as const,
    notes: null,
  };
  return { revienta, POLIZA };
});

vi.mock('../../src/database/connection.js', () => ({
  query: revienta('query'),
  withTransaction: revienta('withTransaction'),
  currentTenant: () => 't1',
  getPool: revienta('getPool'),
}));

vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn() }));
vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: vi.fn(async () => ({ userId: 'u1', email: 'contador@despacho.mx' })),
}));

vi.mock('../../src/cli/kernel/entity-context.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveActiveEntity: vi.fn(async () => ({ ctx: { tenantId: 't1', entityId: 'e1' } })),
  requireExplicitEntity: vi.fn(async () => ({ tenantId: 't1', entityId: 'e1' })),
}));

vi.mock('../../src/services/accounting/fiscal-calendar-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolvePeriod: vi.fn(async () => ({ id: 'fp-2026-01', period_name: 'Enero 2026' })),
}));

vi.mock('../../src/services/accounting/account-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveAccount: vi.fn(async (_entityId: string, ref: string) =>
    ref === 'c-6100' || ref === '6100'
      ? { id: 'c-6100', code: '6100', name: 'Gastos Generales' }
      : { id: 'c-1160', code: '1160', name: 'Pagos Anticipados' }
  ),
}));

vi.mock('../../src/services/accruals/prepaid-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  criteriosDeAnticipo: vi.fn(async () => ({
    convencion: 'proporcional_dias',
    convencionDefinida: true,
    umbral: '5000.0000',
    umbralDefinido: true,
  })),
  registrarPagoAnticipado: vi.fn(async () => ({
    anticipo: { ...POLIZA },
    calendario: [{ amortization_amount: '1019.1781' }],
    criterios: { convencion: 'proporcional_dias', convencionDefinida: true, umbral: '5000.0000', umbralDefinido: true },
    avisos: [],
  })),
  anticiposActivos: vi.fn(async () => [POLIZA]),
  huecoDeAnticipados: vi.fn(async () => ({
    prepaidAccountId: 'c-1160',
    saldoPosteado: '52000.0000',
    yaAdoptado: '12000.0000',
    hueco: '40000.0000',
    hayHueco: true,
    asientos: [
      {
        journal_entry_id: 'je-9',
        entry_number: 'JE-2025-00311',
        entry_date: new Date(2025, 10, 3),
        description: 'Seguro de flotilla 2026',
        cargo: '40000.0000',
      },
    ],
  })),
  revisionDeAmortizacionAlCierre: vi.fn(async () => ({
    periodo: 'Enero 2026',
    reaccion: 'avisar',
    reaccionDefinida: false,
    pendientes: [{ id: 'p1', description: 'Póliza de seguro 2026', remaining_amount: '12000.0000' }],
    bloquea: false,
    mensaje: null,
  })),
}));

vi.mock('../../src/services/accruals/amortization-run.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  periodoDeLaCorrida: vi.fn(async () => ({
    id: 'fp-2026-01',
    inicio: new Date(2026, 0, 1),
    fin: new Date(2026, 0, 31),
    nombre: 'Enero 2026',
  })),
  runMonthlyAmortization: vi.fn(async () => ({
    processed: 1,
    total: '1019.1781',
    skipped: 0,
    errors: [],
  })),
}));

import { registerPrepaidCommand } from '../../src/cli/prepaid-command.js';
import { ExitCode } from '../../src/cli/kernel/exit.js';
import { registrarPagoAnticipado } from '../../src/services/accruals/prepaid-service.js';
import { runMonthlyAmortization } from '../../src/services/accruals/amortization-run.js';
const plano = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

interface Corrida {
  code: number;
  out: string;
  err: string;
  error: unknown;
}

async function correr(argv: string[], confirm?: (q: string) => Promise<boolean>): Promise<Corrida> {
  let out = '';
  let err = '';
  const salidaOut = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const salidaErr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
  let code = -1;
  let error: unknown = null;
  const program = new Command('mnemosine').exitOverride();
  registerPrepaidCommand(program, {
    palette: plano,
    shutdown: (c: number) => {
      code = c;
    },
    reportError: (e: unknown) => {
      error = e;
    },
    ...(confirm ? { confirm } : {}),
  });
  try {
    await program.parseAsync(['node', 'mnemosine', ...argv]);
  } finally {
    salidaOut.mockRestore();
    salidaErr.mockRestore();
  }
  return { code, out, err, error };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ══════════════════════════════════════════════════════════════
describe('prepaid run', () => {
  it('el ensayo enseña los dos renglones del asiento y NO llama al motor', async () => {
    const r = await correr(['prepaid', 'run', '--period', '2026-01', '--dry-run', '-e', 'e1']);
    expect(r.error).toBeNull();
    expect(r.code).toBe(ExitCode.OK);
    expect(r.out).toMatch(/Accrued expense - Póliza de seguro 2026/);
    expect(r.out).toMatch(/Prepaid expenses - Póliza de seguro 2026/);
    expect(r.out).toMatch(/6100 Gastos Generales/);
    expect(r.out).toMatch(/1160 Pagos Anticipados/);
    expect(r.out).toMatch(/1019\.1781/);
    expect(r.err).toMatch(/Ensayo: el mayor no se tocó/);
    expect(runMonthlyAmortization).not.toHaveBeenCalled();
  });

  it('el ensayo fecha el asiento el último día del periodo, no el primero', async () => {
    const r = await correr(['prepaid', 'run', '--period', '2026-01', '--dry-run']);
    expect(r.err).toMatch(/asientos con fecha 2026-01-31/);
    expect(r.out).toMatch(/2026-01-31/);
  });

  it('sin --period se detiene antes de tocar nada, con el código de uso', async () => {
    const r = await correr(['prepaid', 'run', '--dry-run']);
    expect(r.code).toBe(ExitCode.USAGE);
    expect((r.error as Error).message).toMatch(/Falta --period/);
  });

  it('pregunta antes de postear, y un «no» aborta sin tocar el mayor', async () => {
    const preguntas: string[] = [];
    const r = await correr(['prepaid', 'run', '--period', '2026-01'], async (q) => {
      preguntas.push(q);
      return false;
    });
    expect(preguntas[0]).toMatch(/¿Devengar 1019\.18 MXN en 1 asiento\(s\) de Enero 2026\?/);
    expect(preguntas[0]).toMatch(/El mayor no admite deshacer/);
    expect(r.code).toBe(ExitCode.ABORTED);
    expect(runMonthlyAmortization).not.toHaveBeenCalled();
  });

  it('con -y postea sin preguntar y dice qué quedó contabilizado', async () => {
    const r = await correr(['prepaid', 'run', '--period', '2026-01', '-y']);
    expect(r.code).toBe(ExitCode.OK);
    expect(runMonthlyAmortization).toHaveBeenCalledWith('e1', 'fp-2026-01', 'u1');
    expect(r.err).toMatch(/✔ 1 asiento\(s\) de devengo contabilizados en Enero 2026 por 1019\.1781/);
  });

  it('cuenta los calendarios que ya tienen renglón de este mes en vez de esconderlos', async () => {
    const r = await correr(['prepaid', 'run', '--period', '2026-01', '--dry-run']);
    expect(r.err).toMatch(/1 calendario\(s\) entran, 0 se omiten, 0 ya tienen renglón de este mes/);
  });

  it('avisa de que son N asientos y N reversas, no uno', async () => {
    const r = await correr(['prepaid', 'run', '--period', '2026-01', '--dry-run']);
    expect(r.err).toMatch(/1 asiento\(s\) de ajuste de dos líneas, uno por calendario/);
    expect(r.err).toMatch(/son 1 reversas/);
  });
});

// ══════════════════════════════════════════════════════════════
describe('prepaid create', () => {
  const BASE = [
    'prepaid', 'create', 'Póliza de seguro 2026',
    '--amount', '12000', '--start', '2026-01-01', '--end', '2026-12-31',
  ];

  it('el ensayo imprime los doce renglones y no escribe la cabecera', async () => {
    const r = await correr([...BASE, '--origin', 'manual', '--dry-run']);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.out).toMatch(/1019\.1781/);
    expect(r.out.trim().split('\n')).toHaveLength(14); // cabecera + separador + 12
    expect(r.err).toMatch(/Ensayo: no se escribió ninguna fila/);
    // Y confiesa lo que el ensayo NO puede comprobar, en vez de fingirlo.
    expect(r.err).toMatch(/El ensayo NO comprueba el respaldo en la cuenta/);
    expect(registrarPagoAnticipado).not.toHaveBeenCalled();
  });

  it('el ensayo avisa cuando el importe cae por debajo del umbral del panel', async () => {
    const r = await correr([
      'prepaid', 'create', 'Suscripción anual', '--amount', '900',
      '--start', '2026-01-01', '--end', '2026-12-31', '--origin', 'manual', '--dry-run',
    ]);
    expect(r.err).toMatch(/queda por debajo del umbral de 5000\.00 MXN/);
    expect(r.err).toMatch(/umbral_anticipado_mxn/);
  });

  it('nombra las cuatro banderas que faltan de una vez, no de una en una', async () => {
    const r = await correr(['prepaid', 'create', 'Algo']);
    expect(r.code).toBe(ExitCode.USAGE);
    expect((r.error as Error).message).toMatch(/Faltan --amount, --start, --end, --origin/);
  });

  it('`--origin cfdi` sin --source-entry se rechaza: el vínculo se pierde para siempre', async () => {
    const r = await correr([...BASE, '--origin', 'cfdi']);
    expect(r.code).toBe(ExitCode.USAGE);
    expect((r.error as Error).message).toMatch(/exige `--source-entry/);
    expect(registrarPagoAnticipado).not.toHaveBeenCalled();
  });

  it('--force sin --reason no pasa la compuerta del núcleo', async () => {
    const r = await correr([...BASE, '--origin', 'manual', '--force']);
    expect(r.code).toBe(ExitCode.USAGE);
    expect((r.error as Error).message).toMatch(/--force overrides a safety rule/);
  });

  it('el motivo del --force viaja a las NOTAS de la fila, no sólo a la bitácora', async () => {
    await correr([...BASE, '--origin', 'manual', '--force', '--reason', 'contrato plurianual firmado']);
    expect(registrarPagoAnticipado).toHaveBeenCalledWith(
      expect.objectContaining({
        forzarBajoUmbral: true,
        notas: '--force: contrato plurianual firmado',
        importe: '12000.0000',
        origen: 'manual',
        createdBy: 'u1',
        entityId: 'e1',
      })
    );
  });

  it('dice que el mayor no se tocó y nombra el paso siguiente', async () => {
    const r = await correr([...BASE, '--origin', 'manual']);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.err).toMatch(/El mayor no se tocó: el cargo ya estaba/);
    expect(r.err).toMatch(/prepaid run --period/);
  });

  it('una convención que contradice al panel se rechaza en vez de obedecerse', async () => {
    const r = await correr([...BASE, '--origin', 'manual', '--convention', 'meses_completos']);
    expect(r.code).toBe(ExitCode.VALIDATION);
    expect((r.error as Error).message).toMatch(/contradice al panel/);
    expect(registrarPagoAnticipado).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
describe('prepaid list', () => {
  it('lista el calendario vivo con lo que queda y los periodos por delante', async () => {
    const r = await correr(['prepaid', 'list', '--as-of', '2026-02-15']);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.out).toMatch(/Póliza de seguro 2026/);
    // La tabla es para leerla: el dinero sale con separador de millares. Los
    // cuatro decimales de almacenamiento sólo son contrato en los formatos de
    // máquina, y eso lo comprueba la prueba siguiente.
    expect(r.out).toMatch(/12,000\.00/);
    expect(r.out).toMatch(/2026-01-01/);
    expect(r.out).toMatch(/\b11\b/);
  });

  it('en --json el dinero conserva los cuatro decimales de la columna', async () => {
    const r = await correr(['prepaid', 'list', '--as-of', '2026-02-15', '--json']);
    const filas = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const fila = (Array.isArray(filas) ? filas[0] : filas.rows[0]);
    expect(fila.total_amount).toBe('12000.0000');
    expect(fila.remaining_amount).toBe('12000.0000');
    expect(fila.periodos_restantes).toBe(11);
    expect(fila.coverage_start).toBe('2026-01-01');
  });

  it('grita la deuda heredada y enumera los asientos que la componen', async () => {
    // El hueco no es una fila de la tabla: es dinero que NINGUNA fila reclama.
    const r = await correr(['prepaid', 'list']);
    expect(r.err).toMatch(/40000\.00 MXN posteados en la cuenta de pagos anticipados/);
    expect(r.err).toMatch(/JE-2025-00311/);
    expect(r.err).toMatch(/--origin saldo_preexistente --source-entry/);
  });

  it('avisa del hueco también en --json, donde stdout es sólo datos', async () => {
    const r = await correr(['prepaid', 'list', '--json']);
    expect(JSON.parse(r.out.split('\n')[0] ? r.out : '{}')).toBeTruthy();
    expect(r.out).not.toMatch(/40000\.00 MXN posteados/);
    expect(r.err).toMatch(/40000\.00 MXN posteados/);
  });

  it('rechaza una fecha imposible antes de abrir conexión', async () => {
    const r = await correr(['prepaid', 'list', '--as-of', '2026-02-31']);
    expect(r.code).toBe(ExitCode.USAGE);
    expect((r.error as Error).message).toMatch(/fecha real/);
  });
});

// ══════════════════════════════════════════════════════════════
describe('prepaid show', () => {
  it('enseña la tabla periodo a periodo y dice que no es lo posteado', async () => {
    const r = await correr(['prepaid', 'show', 'seguro']);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.out).toMatch(/1019\.1781/);
    expect(r.err).toMatch(/devengado 0\.00, queda 12000\.00/);
    expect(r.err).toMatch(/no lo ya posteado/);
  });

  it('no encuentra lo que no existe, con el código 3', async () => {
    const r = await correr(['prepaid', 'show', 'licencia de software']);
    expect(r.code).toBe(ExitCode.NOT_FOUND);
  });
});
