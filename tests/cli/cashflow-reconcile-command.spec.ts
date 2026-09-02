import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import { riskOf } from '../../src/cli/kernel/risk.js';
import { palette } from '../../src/cli/palette.js';
import {
  registerCashFlowReconcile,
  type ConstructorDeEstado,
} from '../../src/cli/cashflow-reconcile-command.js';

// ============================================================
// G1b · LA SUPERFICIE DE `cashflow reconcile`
//
// Lo que se comprueba aquí es la FORMA del comando, sin base de datos: que
// pase la auditoría de consistencia del núcleo (R1 profundidad, R2 sustantivo
// singular, R3 verbo de la lista cerrada, R6 diccionario de banderas, R11
// banderas de riesgo), que declare las tres del catálogo, y que se anuncie
// como lectura abierta al agente — medir nunca es peligroso; lo peligroso es
// no medir.
//
// La aritmética del amarre vive en tests/integration/g1b-amarre-efectivo:
// una conciliación contra dobles no demuestra nada sobre el mayor.
// ============================================================

function programaConCashflow(): Command {
  const program = new Command('mnemosine');
  const cashflow = program
    .command('cashflow')
    .alias('flujo')
    .description('Statement of cash flows');
  const construirEstado: ConstructorDeEstado = vi.fn(async () => ({
    method: 'indirecto',
    operating_activities: { total: '0.0000' },
    investing_activities: { total: '0.0000' },
    financing_activities: { total: '0.0000' },
  }));
  registerCashFlowReconcile(cashflow, {
    palette: palette(process.stdout),
    shutdown: vi.fn(),
    reportError: vi.fn(),
    construirEstado,
  });
  return program;
}

function hoja(program: Command): Command {
  const cashflow = program.commands.find((c) => c.name() === 'cashflow');
  const reconcile = cashflow?.commands.find((c) => c.name() === 'reconcile');
  if (!reconcile) throw new Error('no se registró `cashflow reconcile`');
  return reconcile;
}

describe('cashflow reconcile · la superficie', () => {
  it('pasa la auditoría de consistencia del núcleo', () => {
    expect(auditProgram(programaConCashflow())).toEqual([]);
  });

  it('lleva las tres banderas que el catálogo le nombra', () => {
    const largas = hoja(programaConCashflow()).options.map((o) => o.long);
    expect(largas).toContain('--period');
    expect(largas).toContain('--show-candidates');
    expect(largas).toContain('--strict');
  });

  it('responde al alias español del catálogo', () => {
    expect(hoja(programaConCashflow()).aliases()).toContain('conciliar');
  });

  it('se declara lectura y abierta al agente', () => {
    const r = riskOf(hoja(programaConCashflow()));
    expect(r?.risk).toBe('lectura');
    expect(r?.agent).toBe(true);
  });

  it('no declara ninguna bandera de mutación: conciliar no escribe nada', () => {
    const largas = hoja(programaConCashflow()).options.map((o) => o.long);
    for (const prohibida of ['--yes', '--force', '--dry-run', '--idempotency-key']) {
      expect(largas).not.toContain(prohibida);
    }
  });

  it('la descripción de commander va en inglés, como el resto del binario', () => {
    // La regla de la casa: comentarios y errores en español, la ayuda que el
    // usuario ve en inglés. Un acento aquí delataría la mezcla.
    expect(hoja(programaConCashflow()).description()).not.toMatch(/[áéíóúñ¿¡]/i);
  });
});
