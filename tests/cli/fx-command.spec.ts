import { describe, it, expect, beforeAll } from 'vitest';
import { Command } from 'commander';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import { registerFxCommand } from '../../src/cli/fx-command.js';
import { riskOf, declareRisk } from '../../src/cli/kernel/risk.js';
import { VERBS } from '../../src/cli/kernel/vocabulary.js';
import { FLAG_DICTIONARY } from '../../src/cli/kernel/flags.js';

// ============================================================
// La familia `fx`·`cambio` contra el reglamento, antes de que el
// integrador la cablee en mnemosine.ts. Construir el programa basta:
// declareRisk lanza al REGISTRAR, y auditProgram recorre el árbol
// igual que se recorre el binario embarcado.
//
// R4, fase 1 del subgrupo Multimoneda: cuatro hojas y ninguna más.
// La revaluación, el import y el correct son fases 2 y 3, y una
// hoja que apareciera aquí antes de tiempo es exactamente lo que
// la lista cerrada de LEAVES existe para cazar.
// ============================================================

const deps = {
  palette: {
    dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
    red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
  },
  shutdown: () => undefined,
  reportError: () => undefined,
};

let program: Command;
let violations: ReturnType<typeof auditProgram>;
/**
 * El riesgo se retrata al registrar, a propósito: el registro es un mapa de
 * módulo que cualquier suite puede vaciar, así que lo honesto es afirmar
 * sobre lo que ESTE programa declaró al construirse.
 */
const risks = new Map<string, ReturnType<typeof riskOf>>();

const LEAVES = ['fx rate list', 'fx rate show', 'fx rate set', 'fx rate download'];

beforeAll(() => {
  program = new Command('mnemosine');
  registerFxCommand(program, deps);
  violations = auditProgram(program);
  for (const path of LEAVES) risks.set(path, riskOf(find(path)));
});

function find(path: string): Command {
  let node: Command = program;
  for (const token of path.split(' ')) {
    const next = node.commands.find((c) => c.name() === token);
    if (!next) throw new Error(`No command "${path}" (stuck at "${token}")`);
    node = next;
  }
  return node;
}

describe('the rulebook', () => {
  it('registers without declareRisk refusing anything', () => {
    expect(program.commands.map((c) => c.name())).toEqual(['fx']);
  });

  it('passes the consistency audit with no violations', () => {
    expect(violations).toEqual([]);
  });

  it('ends every leaf command in a verb from the closed list, and ships exactly the four phase-1 leaves', () => {
    const leaves: string[] = [];
    const walk = (cmd: Command, prefix: string[]) => {
      const path = [...prefix, cmd.name()];
      if (cmd.commands.length === 0) leaves.push(path.join(' '));
      for (const child of cmd.commands) walk(child, path);
    };
    for (const child of program.commands) walk(child, []);
    for (const leaf of leaves) {
      const last = leaf.split(' ').pop()!;
      expect(Object.keys(VERBS), leaf).toContain(last);
    }
    expect(leaves.sort()).toEqual([...LEAVES].sort());
  });

  it('freezes the family vocabulary in the flag dictionary', () => {
    // Las tres grafías que esta familia estrena, congeladas sin forma corta:
    // sin la entrada, la próxima sesión reinventa --rate-type como --type (la
    // naturaleza de una cuenta, F05a) o el par como --from/--to (prohibidas).
    for (const flag of ['--pair', '--rate-type', '--source']) {
      expect(FLAG_DICTIONARY, flag).toHaveProperty(flag, null);
    }
  });
});

describe('the bilingual surface', () => {
  const ALIASES: Record<string, string> = {
    fx: 'cambio',
    'fx rate': 'tipo',
    'fx rate list': 'listar',
    'fx rate show': 'ver',
    'fx rate set': 'fijar',
    'fx rate download': 'descargar',
  };

  it('gives every command exactly one Spanish alias', () => {
    for (const [path, alias] of Object.entries(ALIASES)) {
      expect(find(path).aliases(), path).toEqual([alias]);
    }
  });

  it('uses the vocabulary’s Spanish verb for every verb command', () => {
    for (const [path, alias] of Object.entries(ALIASES)) {
      const verb = path.split(' ').pop()!;
      if (VERBS[verb]) expect(alias, path).toBe(VERBS[verb]);
    }
  });
});

describe('safety declarations', () => {
  it('lets the agent read and nothing else: exchange_rates is a GLOBAL table', () => {
    // La tabla no tiene tenant_id ni entity_id y vive fuera de RLS: leerla es
    // leer un hecho del mundo, escribirla es escribir para TODOS los
    // inquilinos a la vez. Por eso las dos mitades de lectura son IA ✓ y las
    // dos que escriben son IA ✗, tal cual las celdas 547-550 del catálogo.
    for (const path of ['fx rate list', 'fx rate show']) {
      expect(risks.get(path)?.risk, path).toBe('lectura');
      expect(risks.get(path)?.agentAllowed, path).toBe(true);
    }
    for (const path of ['fx rate set', 'fx rate download']) {
      expect(risks.get(path)?.agentAllowed, path).toBe(false);
    }
  });

  it('declares set as a write and download as external, matching the catalog rows', () => {
    expect(risks.get('fx rate set')?.risk).toBe('escritura');
    expect(risks.get('fx rate download')?.risk).toBe('externo');
  });

  it('says the truth about what download writes today: nothing, it fails closed', () => {
    // El registro de auditoría no promete la aspiración (la descarga) sino el
    // hecho: sin conector, ejecutar falla cerrado. La clase de riesgo sigue
    // siendo `externo` porque ESA es la clase de efecto de la hoja — bajarla
    // haría que el conector de fase 2 cambiara el permiso del agente.
    expect(risks.get('fx rate download')?.writes).toMatch(/falla cerrado/);
  });

  it('carries the safety flags the external class requires', () => {
    const longs = find('fx rate download').options.map((o) => o.long);
    expect(longs).toEqual(
      expect.arrayContaining(['--dry-run', '--yes', '--idempotency-key', '--live'])
    );
  });

  it('gives set its --dry-run and the catalog flags, without the external gates', () => {
    const longs = find('fx rate set').options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(['--dry-run', '--source', '--rate-type', '--until']));
    // `set` es escritura local: la compuerta --live es de efectos externos y
    // aquí sería una promesa falsa de sandbox.
    expect(longs).not.toContain('--live');
  });

  it('would REFUSE to ship if someone let the agent download rates', () => {
    expect(() =>
      declareRisk(new Command('fx rate download'), { risk: 'externo', agent: true })
    ).toThrow(/permission must never depend on the value of a flag/);
  });

  it('would REFUSE to ship if someone let the agent set a rate without a review queue', () => {
    // Escritura + agente exige draftOnly, y fijar un tipo escribe directo en
    // la tabla compartida: no hay borrador posible, así que agente ✗ es la
    // única declaración que registra.
    expect(() =>
      declareRisk(new Command('fx rate set'), { risk: 'escritura', agent: true })
    ).toThrow(/draftOnly/);
  });
});

describe('list commands can be paged and formatted', () => {
  it('carries --limit and --format, so nothing truncates silently', () => {
    const longs = find('fx rate list').options.map((o) => o.long);
    expect(longs).toEqual(
      expect.arrayContaining(['--limit', '--offset', '--all', '--format', '--json', '--fields', '--output'])
    );
  });

  it('carries the catalog filters, source included: DOF and FIX coexist per day since the 057', () => {
    const longs = find('fx rate list').options.map((o) => o.long);
    expect(longs).toEqual(
      expect.arrayContaining(['--pair', '--since', '--until', '--rate-type', '--source'])
    );
  });
});

describe('show resolves spot by default', () => {
  it('applies the default to the PARSED value, not only to the help text', () => {
    // Commander copia el valor por omisión al registrar la opción; afirmar
    // sobre defaultValue a secas dejaría pasar un default que sólo vive en
    // --help (la mentira que cazaron en `bill list --date-basis`).
    expect(find('fx rate show').opts().rateType).toBe('spot');
  });
});
