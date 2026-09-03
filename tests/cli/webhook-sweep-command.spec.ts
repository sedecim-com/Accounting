import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { MockInstance } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTenant: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(() => undefined),
}));

vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn() }));

vi.mock('../../src/services/webhooks/barrido-entregas.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/services/webhooks/barrido-entregas.js')
  >();
  return { ...actual, barrerEntregasVencidas: vi.fn() };
});

import { registerWebhookSweepCommand } from '../../src/cli/webhook-sweep-command.js';
import { barrerEntregasVencidas } from '../../src/services/webhooks/barrido-entregas.js';
import { currentTenant } from '../../src/database/connection.js';

const mockBarrido = barrerEntregasVencidas as unknown as Mock;
const mockTenant = currentTenant as unknown as Mock;

const id = (s: string): string => s;
const palette = { dim: id, bold: id, yellow: id };

let logs: string[];
let logSpy: MockInstance<typeof console.log>;
let codigos: number[];
let errores: unknown[];

function makePrograma(): Command {
  const program = new Command();
  program.exitOverride();
  const subscription = program.command('subscription').alias('suscripcion');
  registerWebhookSweepCommand(subscription, {
    palette,
    shutdown: vi.fn(async (code: number) => {
      codigos.push(code);
      return undefined as never;
    }),
    reportError: vi.fn((e: unknown) => {
      errores.push(e);
    }),
  });
  return program;
}

const resultadoVacio = {
  inquilinosRevisados: 1,
  vencidas: 0,
  entregadas: 0,
  reintentables: 0,
  muertas: 0,
  congeladas: 0,
  detalle: [],
};

beforeEach(() => {
  logs = [];
  codigos = [];
  errores = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
  mockBarrido.mockReset();
  mockBarrido.mockResolvedValue(resultadoVacio);
  mockTenant.mockReturnValue('tenant-a');
});

afterEach(() => {
  logSpy.mockRestore();
});

describe('la hoja se cuelga de la familia de SALIDA, no de la de entrada', () => {
  it('es `subscription delivery sweep`, con alias `entrega barrer`', () => {
    const p = makePrograma();
    const sub = p.commands.find((c) => c.name() === 'subscription')!;
    const delivery = sub.commands.find((c) => c.name() === 'delivery')!;
    expect(delivery.aliases()).toContain('entrega');
    const sweep = delivery.commands.find((c) => c.name() === 'sweep')!;
    expect(sweep).toBeDefined();
    expect(sweep.aliases()).toContain('barrer');
  });

  it('reutiliza un `delivery` ya existente en vez de duplicarlo', () => {
    const program = new Command();
    program.exitOverride();
    const subscription = program.command('subscription');
    subscription.command('delivery').alias('entrega').command('list');
    registerWebhookSweepCommand(subscription, {
      palette,
      shutdown: vi.fn(async () => undefined as never),
      reportError: vi.fn(),
    });
    const deliveries = subscription.commands.filter((c) => c.name() === 'delivery');
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].commands.map((c) => c.name()).sort()).toEqual(['list', 'sweep']);
  });

  it('declara riesgo externo, y el núcleo le inyecta sus compuertas', () => {
    const p = makePrograma();
    const sweep = p.commands
      .find((c) => c.name() === 'subscription')!
      .commands.find((c) => c.name() === 'delivery')!
      .commands.find((c) => c.name() === 'sweep')!;
    const largos = sweep.options.map((o) => o.long);
    // externo ⇒ marcha seca, confirmación, llave de idempotencia y --live.
    expect(largos).toEqual(expect.arrayContaining(['--dry-run', '--yes', '--idempotency-key', '--live']));
  });
});

describe('la compuerta de efecto externo', () => {
  it('sin --live NO entrega: degrada a censo y lo dice', async () => {
    const p = makePrograma();
    await p.parseAsync(['subscription', 'delivery', 'sweep', '-t', 'tenant-a'], { from: 'user' });

    expect(mockBarrido).toHaveBeenCalledWith(expect.objectContaining({ marchaSeca: true }));
    expect(logs.join('\n')).toContain('sandbox: nothing was sent');
    expect(codigos).toEqual([0]);
  });

  it('con --live entrega de verdad', async () => {
    const p = makePrograma();
    await p.parseAsync(['subscription', 'delivery', 'sweep', '-t', 'tenant-a', '--live'], { from: 'user' });
    expect(mockBarrido).toHaveBeenCalledWith(expect.objectContaining({ marchaSeca: false }));
  });

  it('--dry-run manda aunque venga --live', async () => {
    const p = makePrograma();
    await p.parseAsync(
      ['subscription', 'delivery', 'sweep', '-t', 'tenant-a', '--live', '--dry-run'],
      { from: 'user' }
    );
    expect(mockBarrido).toHaveBeenCalledWith(expect.objectContaining({ marchaSeca: true }));
  });
});

describe('el alcance es una decisión, no un defecto', () => {
  it('sin inquilino y sin --all-tenants falla en vez de barrerlo todo', async () => {
    mockTenant.mockReturnValue(undefined);
    const p = makePrograma();
    await p.parseAsync(['subscription', 'delivery', 'sweep'], { from: 'user' });

    expect(mockBarrido).not.toHaveBeenCalled();
    expect(codigos).toEqual([1]);
    expect((errores[0] as Error).message).toContain('--all-tenants');
  });

  it('--all-tenants pasa alcance abierto: sin tenantId', async () => {
    mockTenant.mockReturnValue(undefined);
    const p = makePrograma();
    await p.parseAsync(['subscription', 'delivery', 'sweep', '--all-tenants', '--live'], { from: 'user' });
    expect(mockBarrido).toHaveBeenCalledWith(expect.objectContaining({ tenantId: undefined }));
    expect(codigos).toEqual([0]);
  });

  it('un --limit ilegible es error de uso, no un tope inventado', async () => {
    const p = makePrograma();
    await p.parseAsync(['subscription', 'delivery', 'sweep', '-t', 'tenant-a', '-n', 'muchas'], { from: 'user' });
    expect(mockBarrido).not.toHaveBeenCalled();
    expect((errores[0] as Error).message).toContain('Invalid --limit');
    expect(codigos).toEqual([1]);
  });
});

describe('lo que el barrido cuenta, el comando lo dice', () => {
  it('las muertas se anuncian con el modo de inspeccionarlas', async () => {
    mockBarrido.mockResolvedValue({
      ...resultadoVacio,
      vencidas: 3,
      entregadas: 1,
      muertas: 2,
      detalle: [],
    });
    const p = makePrograma();
    await p.parseAsync(['subscription', 'delivery', 'sweep', '-t', 'tenant-a', '--live'], { from: 'user' });

    const salida = logs.join('\n');
    expect(salida).toContain('dead 2');
    expect(salida).toContain('are now DEAD');
    expect(salida).toContain('subscription delivery list');
  });

  it('las congeladas se dicen aunque nadie las haya tocado', async () => {
    mockBarrido.mockResolvedValue({ ...resultadoVacio, congeladas: 4 });
    const p = makePrograma();
    await p.parseAsync(['subscription', 'delivery', 'sweep', '-t', 'tenant-a', '--live'], { from: 'user' });
    expect(logs.join('\n')).toContain('DISABLED subscriptions and were left untouched');
  });

  it('--json emite el resultado entero, sin traza que lo ensucie', async () => {
    mockBarrido.mockResolvedValue({ ...resultadoVacio, vencidas: 2, entregadas: 2 });
    const p = makePrograma();
    await p.parseAsync(['subscription', 'delivery', 'sweep', '-t', 'tenant-a', '--live', '--json'], { from: 'user' });

    expect(mockBarrido).toHaveBeenCalledWith(expect.objectContaining({ traza: undefined }));
    const json = JSON.parse(logs.join('\n')) as { vencidas: number; entregadas: number };
    expect(json.vencidas).toBe(2);
    expect(json.entregadas).toBe(2);
  });

  it('una entrega muerta NO es fallo del barrido: sale 0', async () => {
    mockBarrido.mockResolvedValue({ ...resultadoVacio, vencidas: 1, muertas: 1 });
    const p = makePrograma();
    await p.parseAsync(['subscription', 'delivery', 'sweep', '-t', 'tenant-a', '--live'], { from: 'user' });
    expect(codigos).toEqual([0]);
  });
});
