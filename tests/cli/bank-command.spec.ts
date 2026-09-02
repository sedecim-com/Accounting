import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import { registerBankCommand, type BankCommandDeps } from '../../src/cli/bank-command.js';
import { riskOf, declareRisk } from '../../src/cli/kernel/risk.js';
import { VERBS } from '../../src/cli/kernel/vocabulary.js';
// `condicionDeAlcance` deduce la columna de frontera UNA vez por proceso y la
// cachea; con dobles, esa caché se llena de lo que contestó el primer
// responder que la vio. Se olvida antes de los casos que la usan para que cada
// uno la reconstruya con el suyo.
import { olvidarAlcances } from '../../src/database/scope.js';
// F05d · la llave de idempotencia se comprueba con la MISMA función que la
// escribe: una carga calculada a mano en la prueba probaría otra cosa.
import { hashDeCarga } from '../../src/services/idempotency/idempotency-store.js';

// ============================================================
// La familia `bank` contra el rulebook y contra sus tres promesas caras:
// la frontera de entidad DENTRO del SQL, que ningún identificador salga
// entero, y que `bank statement check` salga 4 cuando encuentra algo.
//
// Construir el programa ya es una prueba: `declareRisk` lanza en tiempo de
// REGISTRO, así que un import declarado `escritura` + agente sin `draftOnly`
// rompería este archivo en `beforeAll` y no en producción.
// ============================================================

// ---- mocks --------------------------------------------------------
const sql: Array<{ text: string; params: unknown[] }> = [];
let responder: (text: string, params: unknown[]) => { rows: unknown[]; rowCount: number };

const registrar = (text: string, params: unknown[] = []) => {
  sql.push({ text, params });
  return Promise.resolve(responder(text, params));
};

vi.mock('../../src/database/connection.js', () => ({
  query: (text: string, params: unknown[] = []) => registrar(text, params),
  // El doble corre el cuerpo con un cliente falso y sin transacción real: lo
  // que estas pruebas vigilan es QUÉ sentencias salen y con qué parámetros.
  withTransaction: (fn: (c: { query: typeof registrar }) => unknown) =>
    Promise.resolve(fn({ query: registrar })),
  currentTenant: () => 'T1',
}));

vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: () => undefined,
  resolveEntity: () => Promise.resolve({ tenantId: 'T1', entityId: 'E1', entityName: 'Acme SA' }),
  listEntities: () => Promise.resolve([{ id: 'E1', name: 'Acme SA' }]),
}));

// F05d · EL MOTOR DEL MAYOR, CON DOBLE.
//
// Es lo único de la capa contable que se dobla, y a propósito: lo que estas
// pruebas vigilan es qué RENGLONES se componen y qué se imprime antes de
// preguntar, no cómo `posting.ts` los escribe —eso lo prueban las suyas—. El
// doble devuelve un número de póliza porque la vista previa lo enseña, y guarda
// cada asiento para poder afirmar que NO se creó ninguno cuando no debía.
const motor = vi.hoisted(() => ({
  asientos: [] as Array<{ description: string; lines: unknown[]; sourceType?: string }>,
}));

vi.mock('../../src/services/accounting/posting.js', () => ({
  createJournalEntry: (
    _entityId: string,
    _fecha: Date,
    _tipo: string,
    description: string,
    lines: unknown[],
    _userId: string,
    opts?: { sourceType?: string }
  ) => {
    motor.asientos.push({ description, lines, sourceType: opts?.sourceType });
    return Promise.resolve({
      id: `JE${motor.asientos.length}`,
      entry_number: `P-${motor.asientos.length}`,
    });
  },
  attestEntryAsync: () => undefined,
}));

vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: () => Promise.resolve({ userId: 'U1', email: 'a@b.c' }),
  // F05c: `bank adjustment create` materializa el ajuste como BORRADOR, y el
  // borrador lo escribe este servicio por el pool. El doble devuelve el id
  // porque lo que estas pruebas vigilan es que la fila del ajuste se ate a él
  // y que NADIE escriba una póliza.
  createDraft: () => Promise.resolve({ id: DRAFT }),
}));

const ACC = '11111111-1111-1111-1111-111111111111';
const ST = '22222222-2222-2222-2222-222222222222';
// F05c · la sesión, su partida, su ajuste y el borrador que lo materializa.
const SES = '33333333-3333-3333-3333-333333333333';
const PART = '44444444-4444-4444-4444-444444444444';
const DRAFT = '55555555-5555-5555-5555-555555555555';
const AJU = '66666666-6666-6666-6666-666666666666';
// F05d · el pago con cheque y el cargo del banco que lo cobró.
const PAGO = '77777777-7777-7777-7777-777777777777';
const MOV = '88888888-8888-8888-8888-888888888888';

// ---- programa y auditoría (estructura) -----------------------------

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
 * El riesgo se fotografía en tiempo de registro a propósito: el registro es un
 * mapa de módulo que cualquier suite puede vaciar con `resetDeclarations()`, y
 * lo honesto es afirmar sobre lo que ESTE programa declaró al construirse.
 */
const risks = new Map<string, ReturnType<typeof riskOf>>();

const LEAVES = [
  'bank account create', 'bank account list', 'bank account show',
  'bank account edit', 'bank account set',
  'bank statement import', 'bank statement list', 'bank statement show',
  'bank statement check',
  // F05b · los dos lados y el cotejo.
  'bank transaction list', 'bank transaction show',
  'bank book-item list',
  'bank match preview', 'bank match run', 'bank match apply',
  'bank match create', 'bank match unapply',
  // F05c · la sesión que cuadra.
  'bank reconciliation run', 'bank reconciliation open', 'bank reconciliation list',
  'bank reconciliation status', 'bank reconciling-item list',
  'bank reconciling-item assign', 'bank reconciling-item correct', 'bank adjustment create',
  'bank reconciliation close', 'bank reconciliation generate',
  // F05d · la firma y el sello. Las cinco que tocan el mayor.
  'bank reconciliation approve', 'bank reconciliation post',
  'bank fee post', 'bank interest post', 'bank check reconcile',
];

/** Las ocho de F05b, para no repetir la lista en cada aserción. */
const F05B = [
  'bank transaction list', 'bank transaction show', 'bank book-item list',
  'bank match preview', 'bank match run', 'bank match apply',
  'bank match create', 'bank match unapply',
];

/** Las ocho de F05c, en el orden en que las escribe el catálogo. */
const F05C = [
  'bank reconciliation run', 'bank reconciliation open', 'bank reconciliation list',
  'bank reconciliation status', 'bank reconciling-item list',
  'bank reconciling-item assign', 'bank reconciling-item correct', 'bank adjustment create',
  'bank reconciliation close', 'bank reconciliation generate',
];

/**
 * Las cinco de F05d, que son las ÚNICAS de esta familia que tocan el mayor.
 *
 * Se nombran juntas porque casi todo lo que hay que afirmar sobre ellas se
 * afirma sobre las cinco a la vez: irreversible, IA ✗, las tres banderas del
 * núcleo. Una lista suelta por caso dejaría fuera a la sexta que alguien añada.
 */
const F05D = [
  'bank reconciliation approve', 'bank reconciliation post',
  'bank fee post', 'bank interest post', 'bank check reconcile',
];

beforeAll(() => {
  program = new Command('mnemosine');
  registerBankCommand(program, deps);
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
    expect(program.commands.map((c) => c.name())).toEqual(['bank']);
  });

  it('passes the consistency audit with no violations', () => {
    expect(violations).toEqual([]);
  });

  it('ships exactly the thirty-two leaves, each ending in a verb from the closed list', () => {
    const leaves: string[] = [];
    const walk = (cmd: Command, prefix: string[]) => {
      const path = [...prefix, cmd.name()];
      if (cmd.commands.length === 0) leaves.push(path.join(' '));
      for (const child of cmd.commands) walk(child, path);
    };
    for (const child of program.commands) walk(child, []);
    expect(leaves.sort()).toEqual([...LEAVES].sort());
    for (const leaf of leaves) {
      expect(Object.keys(VERBS), leaf).toContain(leaf.split(' ').pop());
    }
  });
});

describe('the bilingual surface', () => {
  const ALIASES: Record<string, string> = {
    bank: 'banco',
    'bank account': 'cuenta',
    'bank account create': 'crear',
    'bank account list': 'listar',
    'bank account show': 'ver',
    'bank account edit': 'editar',
    'bank account set': 'fijar',
    'bank statement': 'estado-cuenta',
    'bank statement import': 'importar',
    'bank statement list': 'listar',
    'bank statement show': 'ver',
    'bank statement check': 'verificar',
    // Los tres sustantivos nuevos y sus ocho hojas. `match`·`cotejar` y
    // `reconcile`·`conciliar` son disjuntos por decreto del registro (§5 #25):
    // el sustantivo de esta familia es `cotejo`, nunca `conciliacion`.
    'bank transaction': 'movimiento',
    'bank transaction list': 'listar',
    'bank transaction show': 'ver',
    'bank book-item': 'partida-libros',
    'bank book-item list': 'listar',
    'bank match': 'cotejo',
    'bank match preview': 'previsualizar',
    'bank match run': 'ejecutar',
    'bank match apply': 'aplicar',
    'bank match create': 'crear',
    'bank match unapply': 'desaplicar',
    // Los tres sustantivos de F05c. `conciliacion` es de la SESIÓN y `cotejo`
    // del emparejamiento de dos renglones: el registro los declara disjuntos y
    // aquí se ve que no comparten alias ni verbo.
    'bank reconciliation': 'conciliacion',
    'bank reconciliation run': 'ejecutar',
    'bank reconciliation open': 'abrir',
    'bank reconciliation list': 'listar',
    'bank reconciliation status': 'estado',
    'bank reconciliation close': 'cerrar',
    'bank reconciliation generate': 'generar',
    'bank reconciling-item': 'partida-conciliatoria',
    'bank reconciling-item list': 'listar',
    'bank reconciling-item assign': 'asignar',
    'bank reconciling-item correct': 'corregir',
    'bank adjustment': 'ajuste',
    'bank adjustment create': 'crear',
    // F05d · las dos hojas que cierran la sesión y los tres sustantivos de
    // tesorería. `cheque` es el alias de un SUSTANTIVO aunque `check` sea
    // también un verbo de la lista cerrada (`bank statement check`·`verificar`):
    // por eso vive a profundidad 3 y no en la raíz.
    'bank reconciliation approve': 'aprobar',
    'bank reconciliation post': 'contabilizar',
    'bank fee': 'comision',
    'bank fee post': 'contabilizar',
    'bank interest': 'interes',
    'bank interest post': 'contabilizar',
    'bank check': 'cheque',
    'bank check reconcile': 'conciliar',
  };

  it('gives every command exactly one Spanish alias', () => {
    for (const [path, alias] of Object.entries(ALIASES)) {
      expect(find(path).aliases(), path).toEqual([alias]);
    }
  });

  it('uses the vocabulary’s Spanish verb for every verb command', () => {
    for (const [path, alias] of Object.entries(ALIASES)) {
      // Sólo las HOJAS ocupan la posición de verbo. Un nodo con hijos es un
      // sustantivo, aunque su palabra también exista como verbo.
      if (find(path).commands.length > 0) continue;
      const verb = path.split(' ').pop() as string;
      if (VERBS[verb]) expect(alias, path).toBe(VERBS[verb]);
    }
  });

  it('`conciliacion` y `cotejo` no se mezclan, que es el decreto del registro', () => {
    // `match`·`cotejar` y `reconcile`·`conciliar` son disjuntos por decreto
    // (§5 #25): cotejar es emparejar dos renglones, conciliar es cerrar un
    // periodo contra un extracto. Los dos sustantivos conviven en la misma
    // familia y ninguno usa el alias del otro.
    expect(find('bank match').aliases()).toEqual(['cotejo']);
    expect(find('bank reconciliation').aliases()).toEqual(['conciliacion']);
    expect(VERBS.reconcile, 'el verbo conciliar sigue libre para F05d').toBe('conciliar');
    // Y ninguna hoja de F05c se llama `reconcile`: el sustantivo ocupa la
    // posición de objeto, y el verbo de cada hoja sale de la lista cerrada.
    for (const hoja of F05C) {
      expect(Object.keys(VERBS), hoja).toContain(hoja.split(' ').pop());
    }
  });

  it('`match` es SUSTANTIVO aquí, y por eso su alias es cotejo y no cotejar', () => {
    // `match`·`cotejar` y `reconcile`·`conciliar` son disjuntos por decreto del
    // registro (§5 #25): cotejar es emparejar dos renglones, conciliar es
    // cerrar un periodo contra un extracto. En `bank match preview` la palabra
    // ocupa la posición de OBJETO —el cotejo—, no la de acto; el verbo
    // `cotejar` sigue libre para `bank transaction match <id>` (fila 1207),
    // que es otra cosa: guardar el precedente de una contraparte.
    expect(find('bank match').commands.length).toBeGreaterThan(0);
    expect(find('bank match').aliases()).toEqual(['cotejo']);
    expect(VERBS.match, 'el verbo no se toca').toBe('cotejar');
  });
});

describe('safety declarations', () => {
  it('lets the agent read everything and write only into staging', () => {
    for (const path of [
      'bank account list', 'bank account show',
      'bank statement list', 'bank statement show', 'bank statement check',
    ]) {
      expect(risks.get(path)?.risk, path).toBe('lectura');
      expect(risks.get(path)?.agentAllowed, path).toBe(true);
    }
    for (const path of ['bank account create', 'bank account edit', 'bank account set']) {
      expect(risks.get(path)?.agentAllowed, path).toBe(false);
    }
  });

  it('splits the matching engine into a ✓ half and a ✗ half, never one flag', () => {
    // La propiedad que sostiene el diseño del agente: el permiso NO puede
    // depender del valor de una bandera. `preview` y `run` hacen la misma
    // pregunta al mismo motor; por eso son dos hojas con dos declaraciones y
    // no `run --dry-run`.
    expect(risks.get('bank match preview')?.risk).toBe('lectura');
    expect(risks.get('bank match preview')?.agentAllowed).toBe(true);
    for (const path of ['bank match run', 'bank match apply', 'bank match create', 'bank match unapply']) {
      expect(risks.get(path)?.risk, path).toBe('escritura');
      expect(risks.get(path)?.agentAllowed, path).toBe(false);
    }
  });

  it('las cuatro escrituras de cotejo dicen que sellan la póliza y que no la escriben', () => {
    // El sello es la ÚNICA mutación que la 041 admite sobre una línea
    // contabilizada. Declararlo es lo que hace que un auditor pueda leer del
    // binario qué toca cada hoja sin abrir el servicio.
    for (const path of ['bank match run', 'bank match apply', 'bank match create']) {
      expect(risks.get(path)?.writes, path).toMatch(/journal_entry_lines/);
      expect(risks.get(path)?.writes, path).toMatch(/NUNCA una póliza/);
    }
    expect(risks.get('bank match unapply')?.writes).toMatch(/CLAUSURA/);
  });

  it('las tres lecturas nuevas son ✓ y ninguna declara escritura', () => {
    for (const path of ['bank transaction list', 'bank transaction show', 'bank book-item list']) {
      expect(risks.get(path)?.risk, path).toBe('lectura');
      expect(risks.get(path)?.agentAllowed, path).toBe(true);
      expect(risks.get(path)?.writes, path).toBeUndefined();
    }
  });

  it('grants the agent `statement import` ONLY paired with draftOnly', () => {
    const r = risks.get('bank statement import');
    expect(r?.risk).toBe('escritura');
    expect(r?.agentAllowed).toBe(true);
    // Es el par lo que lo hace legal: el catálogo promete que el import no
    // toca el mayor, y `draftOnly` es donde esa promesa se compromete.
    expect(r?.draftOnly).toBe(true);
    expect(r?.writes).toMatch(/NUNCA journal_entries/);
  });

  it('would REFUSE to ship the same grant without draftOnly', () => {
    expect(() =>
      declareRisk(new Command('bank statement import'), { risk: 'escritura', agent: true })
    ).toThrow(/draftOnly/);
  });

  it('las cuatro lecturas de F05c son ✓ y ninguna declara escritura', () => {
    for (const path of [
      'bank reconciliation list', 'bank reconciliation status',
      'bank reconciling-item list', 'bank reconciliation generate',
    ]) {
      expect(risks.get(path)?.risk, path).toBe('lectura');
      expect(risks.get(path)?.agentAllowed, path).toBe(true);
      expect(risks.get(path)?.writes, path).toBeUndefined();
    }
  });

  it('las dos escrituras con IA ✓ de F05c van con draftOnly, y dicen por qué es cierto', () => {
    // `open` escribe un CONTENEDOR DE TRABAJO: la sesión nace con
    // `arithmetic_computed_at` NULL y el CHECK de la 053 impide que llegue a
    // 'balanced' por esa puerta, que es lo único que `period-close` lee.
    const abrir = risks.get('bank reconciliation open');
    expect(abrir?.risk).toBe('escritura');
    expect(abrir?.agentAllowed).toBe(true);
    expect(abrir?.draftOnly).toBe(true);
    expect(abrir?.writes).toMatch(/arithmetic_computed_at NULL/);
    expect(abrir?.writes).toMatch(/NUNCA journal_entries/);

    // `adjustment create` escribe un BORRADOR: la fila nace con
    // `journal_entry_id` NULL y lo rellena F05d detrás de una firma.
    const ajuste = risks.get('bank adjustment create');
    expect(ajuste?.risk).toBe('escritura');
    expect(ajuste?.agentAllowed).toBe(true);
    expect(ajuste?.draftOnly).toBe(true);
    expect(ajuste?.writes).toMatch(/ai_drafts/);
    expect(ajuste?.writes).toMatch(/journal_entry_id NULL/);
    expect(ajuste?.writes).toMatch(/NUNCA journal_entries/);
  });

  it('`run` y `close` son ✗: encadenan sellos y firman la aseveración que lee el cierre', () => {
    for (const path of ['bank reconciliation run', 'bank reconciliation close']) {
      expect(risks.get(path)?.risk, path).toBe('escritura');
      expect(risks.get(path)?.agentAllowed, path).toBe(false);
    }
    // La hoja que hace verdadero el tramo declara las dos columnas que la 053
    // exige juntas, y que no escribe póliza.
    expect(risks.get('bank reconciliation close')?.writes).toMatch(/status=balanced/);
    expect(risks.get('bank reconciliation close')?.writes).toMatch(/arithmetic_computed_at/);
    expect(risks.get('bank reconciliation close')?.writes).toMatch(/NUNCA una póliza/);
    expect(risks.get('bank reconciliation run')?.writes).toMatch(/NUNCA approve ni post/);
  });

  it('would REFUSE to ship `open` or `adjustment create` without draftOnly', () => {
    // Es el par lo que las hace legales. Sin `draftOnly`, `declareRisk` lanza
    // en tiempo de REGISTRO y el binario no arranca.
    for (const nombre of ['open', 'create']) {
      expect(() =>
        declareRisk(new Command(nombre), { risk: 'escritura', agent: true })
      ).toThrow(/draftOnly/);
    }
  });

  it('las CINCO de F05d son irreversible + IA ✗, y el par no depende de una bandera', () => {
    // Es la propiedad de seguridad que el catálogo declara como invariante:
    // toda fila irreversible es IA prohibida. `declareRisk` la hace cumplir al
    // REGISTRAR —una `irreversible` con `agent: true` rompe el arranque—, así
    // que construir este programa ya la prueba; esto la fija fila a fila para
    // que la sexta que alguien añada no se cuele con `agent: true`.
    for (const path of F05D) {
      expect(risks.get(path)?.risk, path).toBe('irreversible');
      expect(risks.get(path)?.agentAllowed, path).toBe(false);
      expect(risks.get(path)?.draftOnly, path).toBeFalsy();
    }
  });

  it('would REFUSE to ship any of the five with agent access', () => {
    // Ninguna bandera lo arregla: ni `draftOnly`, que es lo que hace legal a
    // `statement import`. Un `irreversible` con agente no arranca.
    expect(() =>
      declareRisk(new Command('post'), { risk: 'irreversible', agent: true, draftOnly: true })
    ).toThrow(/never post to the ledger|permission must never depend/);
  });

  it('las cinco llevan las tres banderas que el núcleo exige de una irreversible', () => {
    for (const path of F05D) {
      const largas = find(path).options.map((o) => o.long);
      expect(largas, path).toEqual(
        expect.arrayContaining(['--dry-run', '--yes', '--idempotency-key'])
      );
    }
  });

  it('las dos hojas de la sesión declaran lo que escriben, y `post` nombra el SELLO', () => {
    // `approve` no toca el mayor y su declaración lo dice: mueve el estado y
    // congela la instantánea, y nada más.
    const firma = risks.get('bank reconciliation approve');
    expect(firma?.writes).toMatch(/approval_snapshot/);
    expect(firma?.writes).toMatch(/approval_hash/);
    expect(firma?.writes).toMatch(/NUNCA journal_entries/);

    // `post` sí, y declara las cuatro cosas que caen juntas.
    const sello = risks.get('bank reconciliation post');
    expect(sello?.writes).toMatch(/journal_entries/);
    expect(sello?.writes).toMatch(/is_reconciled/);
    expect(sello?.writes).toMatch(/reconciliation_matches/);
    expect(sello?.writes).toMatch(/status=posted/);
  });

  it('las tres de tesorería declaran su `source_type`, que es lo que las hace idempotentes', () => {
    expect(risks.get('bank fee post')?.writes).toMatch(/source_type=bank_fee/);
    expect(risks.get('bank interest post')?.writes).toMatch(/source_type=bank_interest/);
    expect(risks.get('bank check reconcile')?.writes).toMatch(/source_type=bank_check_clearing/);
    // Y el cheque declara las DOS columnas de la 055, que su CHECK exige juntas.
    expect(risks.get('bank check reconcile')?.writes).toMatch(/check_cleared_date/);
    expect(risks.get('bank check reconcile')?.writes).toMatch(/check_cleared_tx_id/);
  });

  it('el tratamiento fiscal es OBLIGATORIO, y las dos tasas no comparten grafía', () => {
    // Un valor por omisión aquí sería una decisión fiscal invisible aplicada a
    // todos los cargos del periodo a la vez.
    const iva = find('bank fee post').options.find((o) => o.long === '--iva-rate');
    expect(iva?.required, '--iva-rate obligatoria').toBe(true);
    const rate = find('bank interest post').options.find((o) => o.long === '--rate');
    expect(rate?.required, '--rate obligatoria').toBe(true);
    // Y no son la misma palabra: una es el IVA que el cargo trae dentro y la
    // otra la retención de ISR. Una sola grafía para las dos sería la deriva
    // de `--bank` en F05b, con un asiento cuadrado y mal como precio.
    expect(find('bank fee post').options.map((o) => o.long)).not.toContain('--rate');
    expect(find('bank interest post').options.map((o) => o.long)).not.toContain('--iva-rate');
    expect(rate?.description, 'dice que NO es la tasa de interés').toMatch(/NOT the interest rate/);
  });

  it('never offers a flag that would print a full identifier', () => {
    // La CLABE se guarda cifrada (051) y sólo salen sus últimos 4. Una bandera
    // tipo `--reveal` sería la puerta trasera; `--redacted` va en la dirección
    // contraria y es la única que existe.
    for (const path of LEAVES) {
      const longs = find(path).options.map((o) => o.long ?? '');
      expect(longs.filter((l) => /reveal|unmask|plain|decrypt/i.test(l)), path).toEqual([]);
    }
    expect(find('bank account show').options.map((o) => o.long)).toContain('--redacted');
  });
});

describe('list commands can be paged and formatted', () => {
  it('carries the full read group, not just --json', () => {
    for (const path of [
      'bank account list', 'bank statement list',
      'bank transaction list', 'bank book-item list',
      'bank reconciliation list', 'bank reconciling-item list',
    ]) {
      const longs = find(path).options.map((o) => o.long);
      expect(longs, path).toEqual(
        expect.arrayContaining(['--limit', '--format', '--json', '--fields', '--offset', '--all'])
      );
    }
  });

  it('las dos hojas `show` y `preview` también salen en máquina y por campos', () => {
    // Una hoja de lectura que sólo sabe imprimir para humanos no sirve al
    // agente ni a un guion, y `--fields` es además el descubrimiento de
    // esquema gratis que el contrato de salida promete.
    for (const path of [
      'bank transaction show', 'bank match preview',
      // Las dos hojas de F05c que publican la aritmética: `status` es la que
      // más importa y `generate` es la del expediente.
      'bank reconciliation status', 'bank reconciliation generate',
    ]) {
      const longs = find(path).options.map((o) => o.long);
      expect(longs, path).toEqual(
        expect.arrayContaining(['--format', '--json', '--fields', '--quiet', '--output'])
      );
    }
  });

  it('el ajuste nombra la cuenta de MAYOR y no reintroduce --account con dos sentidos', () => {
    // `--account` significa la cuenta BANCARIA en cinco hojas de esta familia.
    // El catálogo escribe `--account` en la fila del ajuste para la
    // contrapartida del asiento; usarla aquí sería la misma deriva que `--bank`
    // en F05b, así que se usa la grafía que ya nombra una cuenta de mayor.
    const largas = find('bank adjustment create').options.map((o) => o.long ?? '');
    expect(largas).not.toContain('--account');
    expect(largas).toEqual(expect.arrayContaining(['--type', '--amount', '--gl-account', '--item']));
  });

  it('`run` habla las mismas palabras de compuerta que `match preview` y `match run`', () => {
    // El pase guiado corre el MISMO motor: si sus compuertas se deletrearan
    // distinto, previsualizar dejaría de predecir lo que hace el pase.
    for (const compuerta of ['--min-confidence', '--max-amount']) {
      expect(find('bank reconciliation run').options.map((o) => o.long), compuerta)
        .toContain(compuerta);
    }
  });

  it('preview y run hacen la misma pregunta con las mismas palabras', () => {
    // Si las compuertas se deletrearan distinto en las dos hojas, la mitad de
    // lectura dejaría de predecir lo que hace la de escritura, que es lo único
    // que la hace valer para algo.
    const compuertas = ['--min-confidence', '--max-amount', '--rules-only', '--top', '--account'];
    for (const path of ['bank match preview', 'bank match run']) {
      expect(find(path).options.map((o) => o.long), path).toEqual(
        expect.arrayContaining(compuertas)
      );
    }
  });

  it('ninguna hoja de F05b inventa una grafía fuera del diccionario', () => {
    // El auditor ya lo comprueba sobre el programa entero; esto lo fija sobre
    // las ocho, que es donde entraron quince banderas nuevas de un golpe.
    for (const path of F05B) {
      const largas = find(path).options.map((o) => o.long ?? '');
      // `--bank` significa la INSTITUCIÓN en esta familia. Que reaparezca en
      // `match create` con otro significado es la deriva que el diccionario
      // existe para impedir, y por eso los dos lados del grupo se llaman por
      // el sustantivo de su hoja.
      expect(largas, path).not.toContain('--bank');
      expect(largas, path).not.toContain('--book');
    }
    expect(find('bank match create').options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--transaction', '--book-item'])
    );
  });

  it('reads the FILE format on import, and says so, because --format is taken', () => {
    const fmt = find('bank statement import').options.find((o) => o.long === '--format');
    expect(fmt?.description).toMatch(/format of the FILE/);
    // Y la salida de máquina sigue existiendo por la otra puerta.
    expect(find('bank statement import').options.map((o) => o.long)).toContain('--json');
  });
});

// ---- conducta ------------------------------------------------------

let exitCode: number | undefined;
let errs: unknown[] = [];
let salida: string[] = [];

const behaviorDeps = {
  ...deps,
  shutdown: (c: number) => { exitCode = c; },
  reportError: (e: unknown) => { errs.push(e); },
  confirm: () => Promise.resolve(true),
};

async function run(
  argv: string[],
  resp: typeof responder,
  extra: Partial<BankCommandDeps> = {}
) {
  sql.length = 0;
  errs = [];
  salida = [];
  exitCode = undefined;
  responder = resp;
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => {
    salida.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  try {
    const p = new Command('mnemosine').exitOverride();
    registerBankCommand(p, { ...behaviorDeps, ...extra });
    await p.parseAsync(['node', 'mnemosine', ...argv]);
  } finally {
    process.stdout.write = original;
  }
  return { exitCode, errs, sql: [...sql], out: salida.join('') };
}

const filas = (rows: unknown[]) => ({ rows, rowCount: rows.length });

function cuentaMaestra(over: Record<string, unknown> = {}) {
  return {
    id: ACC, entity_id: 'E1', account_name: 'BBVA MXN', bank_name: 'BBVA',
    bank_branch: 'Polanco', account_type: 'checking', currency_code: 'MXN',
    sat_bank_code: '012', swift_code: null, iban: null,
    clabe_last4: '4321', account_number_last4: null, routing_en_archivo: false,
    is_active: true, saldo_banco: '1000.0000',
    last_synced_at: null, created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-02'),
    gl_id: 'GL1', gl_code: '1110', gl_name: 'Bancos', gl_tipo: 'asset', gl_moneda: 'MXN',
    saldo_libro: '1234.5600', ultima_conciliacion: '2026-01-31',
    ...over,
  };
}

function estadoFila(over: Record<string, unknown> = {}) {
  return {
    id: ST, bank_account_id: ACC, entity_id: 'E1', account_name: 'BBVA MXN',
    currency_code: 'MXN', statement_number: '2026-07',
    period_start: '2026-07-01', period_end: '2026-07-31',
    opening_balance: '0.0000', closing_balance: '750.0000',
    line_count: 2, source_format: 'csv', profile: 'generico',
    file_name: 'e.csv', file_sha256: 'ab'.repeat(32),
    imported_at: '2026-08-01 10:00:00', imported_by: 'U1',
    lineas_en_base: '2', suma_lineas: '750.0000',
    ...over,
  };
}

const LINEAS = [
  {
    id: 'L1', transaction_date: '2026-07-01', posted_date: null, amount: '1000.0000',
    transaction_type: 'credit', description: 'Deposito inicial', bank_transaction_id: null,
    content_hash: 'aa'.repeat(32), is_matched: false,
  },
  {
    id: 'L2', transaction_date: '2026-07-15', posted_date: null, amount: '-250.0000',
    transaction_type: 'debit', description: 'Pago de servicio', bank_transaction_id: null,
    content_hash: 'bb'.repeat(32), is_matched: false,
  },
];

/** El responder de las lecturas de la familia. */
const lector =
  (over: { estado?: Record<string, unknown>; cuenta?: Record<string, unknown> } = {}) =>
  (text: string) => {
    if (/FROM bank_accounts b\b/.test(text)) return filas([cuentaMaestra(over.cuenta)]);
    if (/clabe_encrypted, clabe_last4/.test(text)) {
      return filas([{
        id: ACC, account_name: 'BBVA MXN', currency_code: 'MXN', account_type: 'checking',
        is_active: true, clabe_encrypted: null, clabe_last4: '4321',
        account_number_encrypted: null, account_number_last4: null, iban: null,
      }]);
    }
    // El orden importa: la proyección de `list`/`show` EMPIEZA por
    // `SELECT s.id, s.bank_account_id, …`, así que el patrón de la consulta de
    // objetivos de `check` tiene que exigir su FROM o se queda con las dos.
    if (/COALESCE\(l\.n, 0\)/.test(text)) return filas([estadoFila(over.estado)]);
    if (/SELECT s\.id, s\.bank_account_id\s+FROM bank_statements/.test(text)) {
      return filas([{ id: ST, bank_account_id: ACC }]);
    }
    if (/SELECT id, statement_number/.test(text)) return filas([]); // vecinos
    if (/bt\.content_hash/.test(text)) return filas(LINEAS);
    if (/SELECT id, account_name FROM bank_accounts/.test(text)) {
      return filas([{ id: ACC, account_name: 'BBVA MXN' }]);
    }
    return filas([]);
  };

beforeEach(() => {
  process.env.MNEMOSINE_ENTITY = 'E1';
});

describe('la frontera de entidad va DENTRO del SQL', () => {
  it('account list: entity_id es el primer predicado y el parámetro es la entidad', async () => {
    const r = await run(['bank', 'account', 'list'], lector());
    const sel = r.sql.filter((s) => /FROM bank_accounts b\b/.test(s.text));
    expect(sel.length).toBeGreaterThan(0);
    for (const s of sel) {
      expect(s.text.replace(/\s+/g, ' ')).toMatch(/WHERE b\.entity_id = \$1/);
      expect(s.params[0]).toBe('E1');
    }
    expect(r.exitCode).toBe(0);
  });

  it('account list --all-entities sigue acotando dentro del SQL, por inquilino', async () => {
    const r = await run(['bank', 'account', 'list', '--all-entities'], lector());
    const sel = r.sql.find((s) => /FROM bank_accounts b\b/.test(s.text));
    const texto = sel!.text.replace(/\s+/g, ' ');
    // Ni un `WHERE true` ni un filtro en JS: la lista de entidades del
    // inquilino se resuelve en la propia consulta.
    expect(texto).toMatch(
      /b\.entity_id IN \(SELECT id FROM legal_entities WHERE tenant_id = \$1\)/
    );
    expect(sel!.params[0]).toBe('T1');
    expect(r.exitCode).toBe(0);
  });

  it('statement show: las líneas se acotan por JOIN, porque la tabla no tiene entity_id', async () => {
    const r = await run(['bank', 'statement', 'show', ST, '--lines'], lector());
    // `bt.content_hash` sólo aparece en la consulta de LÍNEAS: la proyección
    // del estado también dice `FROM bank_transactions bt`, dentro de su lateral.
    const lineas = r.sql.find((s) => /bt\.content_hash/.test(s.text));
    const texto = lineas!.text.replace(/\s+/g, ' ');
    expect(texto).toMatch(/JOIN bank_accounts ba ON ba\.id = bt\.bank_account_id/);
    expect(texto).toMatch(/WHERE bt\.statement_id = \$1 AND ba\.entity_id = \$2/);
    expect(lineas!.params).toEqual([ST, 'E1', 500]);
    expect(r.exitCode).toBe(0);
  });
});

describe('ningún identificador sale entero', () => {
  it('show enmascara la CLABE a sus últimos 4', async () => {
    const r = await run(['bank', 'account', 'show', 'BBVA MXN'], lector());
    expect(r.out).toContain('••••4321');
    expect(r.out).not.toMatch(/\d{10,}/);
    expect(r.exitCode).toBe(0);
  });

  it('--redacted quita incluso esos cuatro dígitos', async () => {
    const r = await run(['bank', 'account', 'show', 'BBVA MXN', '--redacted'], lector());
    expect(r.out, 'ni el enmascarado').not.toContain('4321');
    expect(r.out).toContain('(redacted)');
    // Y lo que identifica al BANCO se queda: sin eso la ficha compartida no
    // sirve para lo único que se usa compartida.
    expect(r.out, 'la clave de banco del SAT sigue ahí').toContain('012');
  });

  it('en json, redactado y ausente son valores DISTINTOS', async () => {
    const r = await run(['bank', 'account', 'show', 'BBVA MXN', '--redacted', '--json'], lector());
    const payload = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    // La cuenta del caso tiene CLABE (…4321) y no tiene número de cuenta.
    // Colapsar los dos en '' haría que una cuenta SIN identificador —que es un
    // defecto que `show` debería denunciar— pasara por una cuenta discreta.
    expect(payload.rows[0].clabe).toBe('(redacted)');
    expect(payload.rows[0].account_number).toBe('');
    expect(payload.rows[0].sat_bank_code).toBe('012');
  });
});

describe('las banderas declaradas se leen', () => {
  it('--fields manda también en la salida por omisión, no sólo en json', async () => {
    const r = await run(['bank', 'account', 'list', '--fields', 'account,currency'], lector());
    const cabecera = r.out.split('\n')[0];
    expect(cabecera).toMatch(/^account\s+currency$/);
    expect(cabecera, 'y las columnas por omisión desaparecen').not.toContain('book_balance');
  });

  it('--fields a secas enumera los nombres disponibles', async () => {
    const r = await run(['bank', 'account', 'list', '--fields'], lector());
    expect(r.out.trim().split('\n')).toContain('gl_code');
  });

  it('--quiet escupe el uuid COMPLETO, que es lo que `show` acepta', async () => {
    const r = await run(['bank', 'account', 'list', '--quiet'], lector());
    expect(r.out.trim().split('\n')).toEqual([ACC]);
  });

  it('--offset se rechaza en voz alta en vez de ignorarse', async () => {
    const r = await run(['bank', 'account', 'list', '--offset', '10'], lector());
    expect(r.exitCode, 'error de uso, no fallo de ejecución').toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/--offset no está implementado/);
  });

  it('-s/--status no aplica a un estado de cuenta y se dice', async () => {
    const r = await run(['bank', 'statement', 'list', '-s', 'open'], lector());
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/no tiene estado de ciclo de vida/);
  });

  it('account list -s traduce los dos estados que sí existen', async () => {
    const r = await run(['bank', 'account', 'list', '-s', 'archived'], lector());
    const sel = r.sql.find((s) => /FROM bank_accounts b\b/.test(s.text));
    expect(sel!.text.replace(/\s+/g, ' ')).toMatch(/b\.is_active = \$\d/);
    expect(sel!.params).toContain(false);
    expect(r.exitCode).toBe(0);
  });

  it('statement show emite UN solo documento json, con las líneas anidadas', async () => {
    const r = await run(['bank', 'statement', 'show', ST, '--lines', '--json'], lector());
    // Dos `render` seguidos darían dos sobres pegados, y eso no es JSON.
    const payload = JSON.parse(r.out) as { count: number; rows: Array<Record<string, unknown>> };
    expect(payload.count).toBe(1);
    expect((payload.rows[0].lines as unknown[]).length).toBe(2);
    expect(payload.rows[0].sha256).toBe('ab'.repeat(32));
  });
});

describe('bank statement check sale 4 cuando ENCUENTRA algo', () => {
  it('sólo advertencias → 0, y con --strict → 4', async () => {
    const limpio = await run(['bank', 'statement', 'check', ST], lector());
    expect(limpio.exitCode, 'una advertencia no rompe un cierre').toBe(0);
    // La advertencia existe y es la de identidad: bank_statements no guarda la
    // cuenta que declaró el archivo, así que la prueba lo dice en vez de callar.
    expect(limpio.out).toMatch(/identidad/);

    const estricto = await run(['bank', 'statement', 'check', ST, '--strict'], lector());
    expect(estricto.exitCode).toBe(4);
  });

  it('una cadena de saldos rota → 4, y nombra la prueba que rompió', async () => {
    const r = await run(
      ['bank', 'statement', 'check', ST],
      lector({ estado: { closing_balance: '999.0000', suma_lineas: '750.0000' } })
    );
    expect(r.exitCode, '4 es «encontré algo», no «fallé»').toBe(4);
    expect(r.out).toMatch(/cadena-de-saldos/);
    expect(r.out, 'con la diferencia dentro').toMatch(/249\.00/);
  });

  it('--check a secas enumera la batería sin tocar la base', async () => {
    const r = await run(['bank', 'statement', 'check', '--check'], lector());
    expect(r.sql, 'la pregunta «qué se puede verificar» no cuesta una conexión').toEqual([]);
    expect(r.out).toContain('huecos-y-traslapes');
    expect(r.exitCode).toBe(0);
  });

  it('un nombre de prueba inventado se rechaza nombrando las siete', async () => {
    const r = await run(['bank', 'statement', 'check', ST, '--check', 'inventada'], lector());
    expect(r.exitCode).toBe(4);
    expect((r.errs[0] as Error).message).toMatch(/Disponibles: cadena-de-saldos/);
  });
});

describe('las escrituras piden lo que el catálogo promete', () => {
  it('edit de un identificador sin --reason es error de USO y no llega a la base', async () => {
    const r = await run(
      ['bank', 'account', 'edit', 'BBVA MXN', '--clabe', '012180012345678901'],
      lector()
    );
    expect(r.exitCode, 'falta una bandera: 2, no una validación fallida (4)').toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/--clabe/);
    expect(r.sql.filter((s) => /UPDATE bank_accounts/.test(s.text))).toEqual([]);
  });

  it('un edit sin ninguna bandera de campo se niega en vez de escribir nada', async () => {
    const r = await run(['bank', 'account', 'edit', 'BBVA MXN'], lector());
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/Nada que cambiar/);
  });

  it('create con un --type inventado no llega a la base', async () => {
    const r = await run(
      ['bank', 'account', 'create', 'Nueva', '--bank', 'BBVA', '--gl-account', '1110',
        '--currency', 'MXN', '--type', 'chequera'],
      lector()
    );
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/petty-cash/);
    expect(r.sql.filter((s) => /INSERT INTO bank_accounts/.test(s.text))).toEqual([]);
  });

  it('create sin --gl-account no se deja registrar una cuenta sin mapeo', async () => {
    // El mapeo 1:1 con el mayor es lo que hace que la conciliación signifique
    // algo; una cuenta bancaria sin él nace inservible. Es `requiredOption`
    // justo por eso, y esta prueba fija que lo siga siendo.
    responder = lector();
    const p = new Command('mnemosine').exitOverride();
    registerBankCommand(p, behaviorDeps);
    await expect(
      p.parseAsync(['node', 'mnemosine', 'bank', 'account', 'create', 'Nueva',
        '--bank', 'BBVA', '--currency', 'MXN'])
    ).rejects.toThrow(/--gl-account/);
  });

  it('set --force sin --reason lo para la compuerta del núcleo', async () => {
    const r = await run(
      ['bank', 'account', 'set', 'BBVA MXN', '--gl-account', '1110', '--force'],
      lector()
    );
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/--force overrides a safety rule/);
  });
});

// ---- import: el cableado completo, con un CSV de verdad -------------

describe('bank statement import', () => {
  let dir: string;
  let archivo: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mnemosine-bank-'));
    archivo = join(dir, 'julio.csv');
    writeFileSync(
      archivo,
      [
        'fecha,descripcion,importe,saldo',
        '2026-07-01,Deposito inicial,1000.00,1000.00',
        '2026-07-15,Pago de servicio,-250.00,750.00',
      ].join('\n') + '\n',
      'utf8'
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const respImport = (text: string, params: unknown[]) => {
    if (/SELECT id, account_name FROM bank_accounts/.test(text)) {
      return filas([{ id: ACC, account_name: 'BBVA MXN' }]);
    }
    if (/clabe_encrypted, clabe_last4/.test(text)) {
      return filas([{
        id: ACC, account_name: 'BBVA MXN', currency_code: 'MXN', account_type: 'checking',
        is_active: true, clabe_encrypted: null, clabe_last4: '4321',
        account_number_encrypted: null, account_number_last4: null, iban: null,
      }]);
    }
    if (/INSERT INTO bank_transactions/.test(text)) {
      return { rows: [], rowCount: params.length / 11 };
    }
    if (/FROM legal_entities WHERE id = \$1/.test(text)) return filas([{ tenant_id: 'T1' }]);
    return filas([]);
  };

  it('lee el CSV de verdad, escribe el estado y sus líneas, y nada más', async () => {
    const r = await run(
      ['bank', 'statement', 'import', archivo, '--account', ACC],
      respImport
    );
    expect(r.errs, 'sin errores').toEqual([]);
    expect(r.exitCode).toBe(0);

    const estado = r.sql.filter((s) => /INSERT INTO bank_statements/.test(s.text));
    expect(estado.length, 'un estado por archivo').toBe(1);
    // El parser derivó los saldos del saldo corrido: 1000 − 1000 = 0 de
    // apertura, 750 de cierre. Y el periodo son las fechas EXTREMAS de las
    // líneas —un CSV no publica periodo—, así que cierra el 15 y no el 31: es
    // el dato que `--closing-balance` y el estado en papel están para corregir.
    expect(estado[0].params).toEqual(
      expect.arrayContaining([
        'E1', ACC, '2026-07-01', '2026-07-15', '0.0000', '750.0000', 'MXN',
        'csv', 'generico', 'julio.csv', 'U1',
      ])
    );
    // Los saldos salen con la precisión de la columna (DECIMAL(19,4)) porque
    // el importe no se reformatea aquí: redondear dinero en la superficie es
    // exactamente donde se pierde el centavo que nadie encuentra después.
    expect(r.out).toMatch(/0\.0000 → 750\.0000 MXN/);

    const lineas = r.sql.filter((s) => /INSERT INTO bank_transactions/.test(s.text));
    expect(lineas.length).toBe(1);
    expect(lineas[0].params.length / 11, 'las dos líneas del archivo').toBe(2);
  });

  it('NUNCA manda content_hash: lo calcula el disparador de la 051', async () => {
    const r = await run(
      ['bank', 'statement', 'import', archivo, '--account', ACC],
      respImport
    );
    const insert = r.sql.find((s) => /INSERT INTO bank_transactions/.test(s.text));
    // Un hash que el llamador provee es un hash que el llamador puede falsear,
    // y entonces uq_bank_tx_contenido deja de significar «esta línea ya está».
    expect(insert!.text).not.toMatch(/content_hash/);
  });

  it('el mismo archivo nombrado dos veces entra UNA vez', async () => {
    const r = await run(
      ['bank', 'statement', 'import', archivo, '--dir', dir, '--account', ACC],
      respImport
    );
    // Sin la deduplicación por ruta absoluta, la segunda pasada moriría contra
    // UNIQUE(bank_account_id, file_sha256): un conflicto inventado por la línea
    // de órdenes.
    expect(r.sql.filter((s) => /INSERT INTO bank_statements/.test(s.text)).length).toBe(1);
    expect(r.exitCode).toBe(0);
  });

  it('--dry-run parsea, verifica y no deja nada escrito', async () => {
    const r = await run(
      ['bank', 'statement', 'import', archivo, '--account', ACC, '--dry-run'],
      respImport
    );
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/julio\.csv/);
    // El INSERT sí corre —es lo que prueba que el índice único lo aceptaría—
    // pero la transacción se deshace; lo que esta prueba fija es que el
    // resultado se reporta como ENSAYO y no como un import consumado.
    expect(r.out).not.toMatch(/^✔/m);
  });

  it('--format json se rechaza: en `import` --format es el formato del ARCHIVO', async () => {
    const r = await run(
      ['bank', 'statement', 'import', archivo, '--account', ACC, '--format', 'json'],
      respImport
    );
    expect(r.exitCode).toBe(4);
    expect((r.errs[0] as Error).message).toMatch(/no es un formato de estado de cuenta/);
  });

  it('un formato del catálogo sin lector dice «espera», no «corrige»', async () => {
    const r = await run(
      ['bank', 'statement', 'import', archivo, '--account', ACC, '--format', 'ofx'],
      respImport
    );
    expect((r.errs[0] as Error).message).toMatch(/está en el catálogo pero todavía no tiene lector/);
  });

  it('sin archivos, error de uso', async () => {
    const r = await run(
      ['bank', 'statement', 'import', join(dir, 'no-existe.csv'), '--account', ACC],
      respImport
    );
    expect(r.exitCode, 'ENOENT del lector de archivo, no un 0 silencioso').not.toBe(0);
  });
});

// ============================================================
// F05b · LOS DOS LADOS Y EL COTEJO
//
// Las tres promesas caras de este tramo, y una prueba por cada una:
//   · la frontera va por JOIN, porque ni `bank_transactions` ni
//     `reconciliation_matches` tienen entity_id;
//   · una previsualización enseña la DESCOMPOSICIÓN, no sólo el número;
//   · desaplicar CLAUSURA y no borra.
// ============================================================

const TX = '33333333-3333-3333-3333-333333333333';
const JEL = '44444444-4444-4444-4444-444444444444';
const MATCH = '55555555-5555-5555-5555-555555555555';
const GRUPO = '66666666-6666-6666-6666-666666666666';
const SESION = '77777777-7777-7777-7777-777777777777';
/** La cuenta de mayor 1:1 de la cuenta bancaria (051): la que hace de frontera
 *  del lado de libros. */
const GL = '88888888-8888-8888-8888-888888888888';

/** La fila que devuelve el lector de `bank transaction list`. */
function movimientoFila(over: Record<string, unknown> = {}) {
  return {
    id: TX, bank_account_id: ACC, account_name: 'BBVA MXN', currency_code: 'MXN',
    fecha: '2026-07-15', fecha_valor: null, importe: '-250.0000', tipo: 'debit',
    description: 'PAGO CFE 0424', merchant_name: 'CFE', category: null,
    referencia: null, statement_id: ST, is_matched: false, confianza: null,
    importado_el: '2026-08-01 10:00:00',
    ...over,
  };
}

const lectorMovimientos =
  (rows: Array<Record<string, unknown>> = [movimientoFila()]) =>
  (text: string) => {
    if (/LEFT JOIN bank_statements s/.test(text)) {
      return filas([{
        ...movimientoFila(), entity_id: 'E1', content_hash: 'cc'.repeat(32),
        matched_at: null, matched_by: null, import_batch_id: null,
        raw_data: /bt\.raw_data/.test(text) ? { clabe: '012180012345678901' } : null,
        statement_number: '2026-07', period_start: '2026-07-01', period_end: '2026-07-31',
      }]);
    }
    if (/ORDER BY bt\.transaction_date DESC/.test(text)) return filas(rows);
    if (/FROM reconciliation_matches rm/.test(text)) return filas([]);
    if (/SELECT id, account_name FROM bank_accounts/.test(text)) {
      return filas([{ id: ACC, account_name: 'BBVA MXN' }]);
    }
    return filas([]);
  };

describe('bank transaction list · la consulta posicional', () => {
  it('la frontera va por JOIN, porque la tabla no tiene entity_id', async () => {
    const r = await run(['bank', 'transaction', 'list'], lectorMovimientos());
    const sel = r.sql.find((s) => /ORDER BY bt\.transaction_date DESC/.test(s.text));
    const texto = sel!.text.replace(/\s+/g, ' ');
    expect(texto).toMatch(/JOIN bank_accounts ba ON ba\.id = bt\.bank_account_id/);
    expect(texto).toMatch(/WHERE ba\.entity_id = \$1/);
    expect(sel!.params[0]).toBe('E1');
    expect(r.exitCode).toBe(0);
  });

  it('`desc:` busca en descripción Y en contraparte, con un solo parámetro', async () => {
    const r = await run(['bank', 'transaction', 'list', 'desc:CFE'], lectorMovimientos());
    const sel = r.sql.find((s) => /ORDER BY bt\.transaction_date DESC/.test(s.text));
    // Los bancos reparten el mismo dato entre las dos columnas según el
    // formato: buscar sólo en una hace que «no aparece» dependa del importador.
    expect(sel!.text.replace(/\s+/g, ' ')).toMatch(
      /\(bt\.description ILIKE \$2 OR bt\.merchant_name ILIKE \$2\)/
    );
    expect(sel!.params).toContain('%CFE%');
  });

  it('`amt:` sin signo compara la MAGNITUD; con signo, el importe tal cual', async () => {
    const magnitud = await run(['bank', 'transaction', 'list', 'amt:250'], lectorMovimientos());
    const a = magnitud.sql.find((s) => /ORDER BY bt\.transaction_date DESC/.test(s.text));
    expect(a!.text.replace(/\s+/g, ' ')).toMatch(/ABS\(bt\.amount\) = \$2::numeric/);
    // Dinero como CADENA de punta a punta: nunca un Number en el camino.
    expect(a!.params[1]).toBe('250');

    const firmado = await run(['bank', 'transaction', 'list', 'amt:-250'], lectorMovimientos());
    const b = firmado.sql.find((s) => /ORDER BY bt\.transaction_date DESC/.test(s.text));
    expect(b!.text.replace(/\s+/g, ' ')).toMatch(/bt\.amount = \$2::numeric/);
    expect(b!.params[1]).toBe('-250');
  });

  it('`amt:>1000` traduce el comparador, y `amt:mil` se rechaza como uso', async () => {
    const ok = await run(['bank', 'transaction', 'list', 'amt:>1000'], lectorMovimientos());
    const sel = ok.sql.find((s) => /ORDER BY bt\.transaction_date DESC/.test(s.text));
    expect(sel!.text.replace(/\s+/g, ' ')).toMatch(/ABS\(bt\.amount\) > \$2::numeric/);

    const malo = await run(['bank', 'transaction', 'list', 'amt:mil'], lectorMovimientos());
    expect(malo.exitCode, 'un typo es error de USO, no una validación fallida').toBe(2);
    expect((malo.errs[0] as Error).message).toMatch(/no es un importe/);
    expect(malo.sql, 'y no cuesta una conexión').toEqual([]);
  });

  it('un término desconocido se rechaza nombrando los que existen', async () => {
    const r = await run(['bank', 'transaction', 'list', 'payee:CFE'], lectorMovimientos());
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/desc:, amt:/);
  });

  it('una palabra suelta significa desc:, que es lo que cualquiera teclea', async () => {
    const r = await run(['bank', 'transaction', 'list', 'CFE'], lectorMovimientos());
    const sel = r.sql.find((s) => /ORDER BY bt\.transaction_date DESC/.test(s.text));
    expect(sel!.params).toContain('%CFE%');
    expect(r.exitCode).toBe(0);
  });

  it('las comillas mantienen unido un texto con espacios', async () => {
    const r = await run(
      ['bank', 'transaction', 'list', 'desc:"PAGO CFE" amt:>100'],
      lectorMovimientos()
    );
    const sel = r.sql.find((s) => /ORDER BY bt\.transaction_date DESC/.test(s.text));
    expect(sel!.params, 'un solo término de texto, no dos').toContain('%PAGO CFE%');
    expect(sel!.params).toContain('100');
  });

  it('--unmatched es el atajo de -s unmatched, y contradecirlo se dice', async () => {
    const corto = await run(['bank', 'transaction', 'list', '--unmatched'], lectorMovimientos());
    const sel = corto.sql.find((s) => /ORDER BY bt\.transaction_date DESC/.test(s.text));
    expect(sel!.text.replace(/\s+/g, ' ')).toMatch(/bt\.is_matched = \$2/);
    expect(sel!.params).toContain(false);

    const choque = await run(
      ['bank', 'transaction', 'list', '--unmatched', '-s', 'matched'],
      lectorMovimientos()
    );
    expect(choque.exitCode).toBe(2);
    expect((choque.errs[0] as Error).message).toMatch(/piden lo contrario/);
  });

  it('--direction es el SIGNO del importe y no transaction_type', async () => {
    const r = await run(['bank', 'transaction', 'list', '--direction', 'out'], lectorMovimientos());
    const sel = r.sql.find((s) => /ORDER BY bt\.transaction_date DESC/.test(s.text));
    // `transaction_type` dice de qué CLASE es el movimiento (comisión,
    // interés); confundirlo con el sentido del dinero es toda una clase de
    // respuestas equivocadas.
    expect(sel!.text.replace(/\s+/g, ' ')).toMatch(/bt\.amount < 0/);
    expect(sel!.text).not.toMatch(/transaction_type = /);
  });

  it('--offset SÍ se honra aquí, a diferencia del resto de la familia', async () => {
    // Las otras dos listas lo rechazan porque sus servicios no paginan; esta
    // consulta la escribe este tramo y ordena con desempate estable, así que
    // el desplazamiento significa algo.
    const r = await run(['bank', 'transaction', 'list', '--offset', '10'], lectorMovimientos());
    const sel = r.sql.find((s) => /ORDER BY bt\.transaction_date DESC/.test(s.text));
    expect(sel!.text.replace(/\s+/g, ' ')).toMatch(/ORDER BY bt\.transaction_date DESC, bt\.id LIMIT/);
    expect(sel!.params.slice(-2)).toEqual([50, 10]);
    expect(r.exitCode).toBe(0);
  });

  it('--fields manda también en la salida por omisión', async () => {
    const r = await run(
      ['bank', 'transaction', 'list', '--fields', 'date,amount'],
      lectorMovimientos()
    );
    const cabecera = r.out.split('\n')[0];
    expect(cabecera).toMatch(/^date\s+amount$/);
    expect(cabecera).not.toContain('description');
  });

  it('el importe sale con los CUATRO decimales de la columna', async () => {
    const r = await run(['bank', 'transaction', 'list', '--json'], lectorMovimientos());
    const payload = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    // Recortar a dos aquí es el defecto que F05a cazó tres veces: convierte un
    // descuadre de medio centavo en un cuadre perfecto.
    expect(payload.rows[0].amount).toBe('-250.0000');
    expect(typeof payload.rows[0].amount, 'y nunca un número JSON').toBe('string');
  });
});

describe('bank transaction show', () => {
  it('sin --raw la consulta ni siquiera pide raw_data', async () => {
    const r = await run(['bank', 'transaction', 'show', TX], lectorMovimientos());
    const sel = r.sql.find((s) => /LEFT JOIN bank_statements s/.test(s.text));
    // `raw_data` trae el nombre y la cuenta de la contraparte en claro. Que la
    // ficha lo imprima por omisión convierte cada `show` en una fuga por
    // pantalla compartida.
    expect(sel!.text).toMatch(/NULL::jsonb AS raw_data/);
    expect(r.out).not.toContain('012180012345678901');
    expect(r.exitCode).toBe(0);
  });

  it('con --raw lo trae y lo enseña, porque es una decisión de quien mira', async () => {
    const r = await run(['bank', 'transaction', 'show', TX, '--raw'], lectorMovimientos());
    const sel = r.sql.find((s) => /LEFT JOIN bank_statements s/.test(s.text));
    expect(sel!.text).toMatch(/bt\.raw_data/);
    expect(r.out).toContain('012180012345678901');
  });

  it('sólo cuenta como explicación un cotejo VIVO', async () => {
    const r = await run(['bank', 'transaction', 'show', TX], lectorMovimientos());
    const cotejos = r.sql.find((s) => /FROM reconciliation_matches rm/.test(s.text));
    const texto = cotejos!.text.replace(/\s+/g, ' ');
    // La 052 clausura en vez de borrar: sin este predicado la ficha mostraría
    // como explicación un cotejo que alguien deshizo.
    expect(texto).toMatch(/rm\.unapplied_at IS NULL/);
    expect(texto).toMatch(/JOIN bank_accounts ba ON ba\.id = bt\.bank_account_id/);
    expect(cotejos!.params).toEqual([TX, 'E1']);
  });

  it('un id que no es uuid es 404 y no llega a la base', async () => {
    const r = await run(['bank', 'transaction', 'show', 'no-soy-un-uuid'], lectorMovimientos());
    expect(r.exitCode, 'y no un 22P02 disfrazado de fallo genérico').toBe(3);
    expect(r.sql).toEqual([]);
  });

  it('--fields desarma la ficha escrita a mano, y no sólo en json', async () => {
    const r = await run(
      ['bank', 'transaction', 'show', TX, '--fields', 'date,amount'],
      lectorMovimientos()
    );
    // Una bandera declarada que sólo se lee en json es una promesa incumplida,
    // y ya cazaron esa exacta mentira en `ap reconcile`. La ficha en prosa es
    // la comodidad por omisión, no un formato que gane a lo que se pidió.
    expect(r.out.split('\n')[0]).toMatch(/^date\s+amount$/);
    expect(r.out, 'la prosa cede el paso entera').not.toContain('Bank reference');
  });

  it('emite UN solo documento json, con los cotejos anidados', async () => {
    const r = await run(['bank', 'transaction', 'show', TX, '--json'], lectorMovimientos());
    const payload = JSON.parse(r.out) as { count: number; rows: Array<Record<string, unknown>> };
    expect(payload.count).toBe(1);
    expect(payload.rows[0].matches).toEqual([]);
    // Los cuatro campos que el catálogo promete normalizados y que nadie
    // extrae todavía se NOMBRAN, en vez de salir como columnas vacías que se
    // leerían como «este movimiento no los trae».
    expect(payload.rows[0].unextracted_fields).toContain('clave-de-rastreo');
  });
});

describe('bank book-item list · el otro lado', () => {
  const PARTIDAS = [
    {
      line_id: JEL, entry_id: 'JE1', entry_number: 'P-0042', fecha: '2026-04-02',
      importe: '-8000.0000', descripcion: 'Cheque 1201 a proveedor',
      antiguedad_dias: 120, sellada: false,
    },
    {
      line_id: 'L9', entry_id: 'JE2', entry_number: 'P-0100', fecha: '2026-07-01',
      importe: '1500.0000', descripcion: 'Deposito en transito',
      antiguedad_dias: 30, sellada: false,
    },
  ];

  const lectorPartidas = (text: string) => {
    if (/AS line_id/.test(text)) return filas(PARTIDAS);
    if (/SELECT id, account_name FROM bank_accounts/.test(text)) {
      return filas([{ id: ACC, account_name: 'BBVA MXN' }]);
    }
    return filas([]);
  };

  it('la entidad acota los DOS extremos del JOIN, no uno', async () => {
    const r = await run(['bank', 'book-item', 'list', ACC], lectorPartidas);
    const sel = r.sql.find((s) => /AS line_id/.test(s.text));
    const texto = sel!.text.replace(/\s+/g, ' ');
    // El vínculo entre cuenta bancaria y póliza es `gl_account_id`. Una cuenta
    // de mayor mal capturada —apuntando al plan de otra entidad del despacho—
    // convertiría este lector en una ventana a los libros ajenos.
    expect(texto).toMatch(/WHERE je\.entity_id = \$1 AND ba\.entity_id = \$1 AND ba\.id = \$2/);
    expect(texto).toMatch(/jel\.is_reconciled = false/);
    expect(sel!.params).toEqual(['E1', ACC]);
    expect(r.exitCode).toBe(0);
  });

  it('--over-days pregunta por la antigüedad, que es el hallazgo', async () => {
    const r = await run(['bank', 'book-item', 'list', ACC, '--over-days', '90'], lectorPartidas);
    const sel = r.sql.find((s) => /AS line_id/.test(s.text));
    expect(sel!.text.replace(/\s+/g, ' ')).toMatch(/\(CURRENT_DATE - je\.entry_date\) > \$3::int/);
    expect(sel!.params).toEqual(['E1', ACC, 90]);
  });

  it('--over-days 0 es legítimo y no un typo', async () => {
    const r = await run(['bank', 'book-item', 'list', ACC, '--over-days', '0'], lectorPartidas);
    expect(r.exitCode).toBe(0);
    const sel = r.sql.find((s) => /AS line_id/.test(s.text));
    expect(sel!.params).toEqual(['E1', ACC, 0]);
  });

  it('el tope recorta en JS pero DICE el total, que es lo que lo hace honesto', async () => {
    const r = await run(['bank', 'book-item', 'list', ACC, '-n', '1', '--json'], lectorPartidas);
    const payload = JSON.parse(r.out) as { count: number; total: number; truncated: boolean };
    expect(payload.count).toBe(1);
    expect(payload.total, 'un --limit que esconde filas produce un estado incompleto').toBe(2);
    expect(payload.truncated).toBe(true);
  });

  it('el signo del importe se conserva: un cheque en circulación no es un depósito', async () => {
    const r = await run(['bank', 'book-item', 'list', ACC, '--json'], lectorPartidas);
    const payload = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    expect(payload.rows[0].amount).toBe('-8000.0000');
    expect(payload.rows[1].amount).toBe('1500.0000');
  });
});

// ---- el motor, cableado de punta a punta ---------------------------

/**
 * El mundo mínimo en el que el motor propone y aplica: un cargo de 250 el 15
 * de julio y una línea de póliza que lo abona el mismo día. Con eso dispara la
 * regla 1 (importe idéntico + misma fecha, candidato único), que es la única
 * que `run` puede aplicar sin humano.
 */
const bancoTx = {
  id: TX, bank_account_id: ACC, entity_id: 'E1',
  transaction_date: '2026-07-15', amount: '-250.0000',
  description: 'PAGO CFE 0424', merchant_name: 'CFE', is_matched: false,
};

const lectorCotejo =
  (over: {
    periodo?: string;
    /** El importe del candidato, en las DOS lecturas que lo tocan. */
    candidato?: string;
    ocupado?: boolean;
  } = {}) =>
  (text: string) => {
    const importeCandidato = over.candidato ?? '250.0000';
    if (/FROM information_schema\.columns/.test(text)) {
      return filas([
        { table_name: 'bank_accounts', column_name: 'entity_id' },
        { table_name: 'accounts', column_name: 'entity_id' },
      ]);
    }
    if (/SELECT id, account_name FROM bank_accounts/.test(text)) {
      return filas([{ id: ACC, account_name: 'BBVA MXN' }]);
    }
    // El motor pide TAMBIÉN la cuenta de mayor: una partida de libros sólo es
    // candidata si es de la cuenta de mayor de ESTA cuenta bancaria.
    if (/SELECT entity_id, gl_account_id FROM bank_accounts/.test(text)) {
      return filas([{ entity_id: 'E1', gl_account_id: GL }]);
    }
    if (/SELECT entity_id FROM bank_accounts/.test(text)) return filas([{ entity_id: 'E1' }]);
    if (/SELECT bt\.\*, ba\.entity_id/.test(text)) return filas([bancoTx]);
    if (/SELECT bt\.\*\s+FROM bank_transactions/.test(text)) return filas([bancoTx]);
    if (/FOR UPDATE OF bt/.test(text)) return filas([bancoTx]);
    if (/FROM invoices/.test(text) || /FROM bills/.test(text)) return filas([]);
    if (/'journal_entry_line' as type/.test(text)) {
      return filas([{
        id: JEL, type: 'journal_entry_line', amount: importeCandidato,
        date: '2026-07-15', description: 'PAGO CFE 0424',
      }]);
    }
    if (/jel\.debit_amount, jel\.credit_amount, je\.entry_date AS fecha/.test(text)) {
      // El MISMO importe que vio el motor. Un doble que enseñe una cifra al
      // proponer y otra al releer probaría un mundo que no existe.
      return filas([{
        debit_amount: null, credit_amount: importeCandidato, fecha: '2026-07-15',
        descripcion: 'PAGO CFE 0424', referencia: 'P-0042', estado: 'posted',
      }]);
    }
    if (/FROM fiscal_periods/.test(text)) {
      return filas([{ id: 'P1', status: over.periodo ?? 'open', period_name: '2026-07' }]);
    }
    if (/FROM reconciliation_matches rm/.test(text)) {
      return over.ocupado ? filas([{ id: MATCH }]) : filas([]);
    }
    if (/FOR UPDATE OF jel/.test(text)) {
      return filas([{ id: JEL, reconciliation_id: null }]);
    }
    if (/UPDATE journal_entry_lines/.test(text)) return filas([{ id: JEL }]);
    return filas([]);
  };

describe('bank match preview · la mitad de lectura', () => {
  it('NO escribe nada: ni un INSERT, ni un UPDATE, ni un candado', async () => {
    const r = await run(['bank', 'match', 'preview', TX], lectorCotejo());
    // La propiedad tiene que ser evidente en lo que sale a la base, no en el
    // nombre del comando: es lo único que hace legítimo que un agente lo llame.
    expect(r.sql.filter((s) => /INSERT|UPDATE|DELETE|FOR UPDATE/.test(s.text))).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  it('imprime la DESCOMPOSICIÓN y la regla, no sólo el número', async () => {
    const r = await run(['bank', 'match', 'preview', TX], lectorCotejo());
    expect(r.out, 'qué aportó el importe').toMatch(/importe.*-250\.0000 vs -250\.0000/);
    expect(r.out, 'la diferencia, a cuatro decimales').toMatch(/diferencia 0\.0000/);
    expect(r.out, 'qué aportó la fecha').toMatch(/fecha\s+0 día\(s\)/);
    expect(r.out, 'y qué la descripción').toMatch(/descripción.*similitud 1\.00/);
    // La regla que disparó es la mitad del porqué: sin ella «confianza 1.00»
    // es un número que nadie puede revisar.
    expect(r.out).toMatch(/regla exact_amount_date/);
    expect(r.out).toMatch(/`run` lo aplicaría/);
  });

  it('cuando una compuerta cierra, dice CUÁL con su código', async () => {
    const r = await run(
      ['bank', 'match', 'preview', TX],
      lectorCotejo({ periodo: 'hard_close' })
    );
    expect(r.out).toMatch(/no se aplica — periodo-cerrado/);
    expect(r.out).toMatch(/2026-07 \(hard_close\)/);
  });

  it('sin importe exacto propone pero NO aplica: el texto no sostiene un cotejo', async () => {
    const r = await run(['bank', 'match', 'preview', TX], lectorCotejo({ candidato: '245.0000' }));
    // El candidato entra por la banda del 5 % de la regla difusa. Es una
    // propuesta razonable y una aseveración inadmisible.
    expect(r.out).toMatch(/no se aplica/);
    expect(r.exitCode).toBe(0);
  });

  it('en json la descomposición es columnas, no prosa', async () => {
    const r = await run(['bank', 'match', 'preview', TX, '--json'], lectorCotejo());
    const payload = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    const fila = payload.rows[0];
    expect(fila.rule).toBe('exact_amount_date');
    expect(fila.amount_diff).toBe('0.0000');
    expect(fila.days_apart).toBe(0);
    expect(fila.exact_amount).toBe(true);
    expect(fila.applicable).toBe(true);
  });

  it('sin id y sin --account no adivina sobre qué', async () => {
    const r = await run(['bank', 'match', 'preview'], lectorCotejo());
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/--account/);
    expect(r.sql).toEqual([]);
  });

  it('con -q escupe el id del MOVIMIENTO, que es lo que `apply --stdin` come', async () => {
    const r = await run(['bank', 'match', 'preview', TX, '-q'], lectorCotejo());
    // La mitad de lectura sólo predice a la de escritura si las dos hablan del
    // mismo identificador. `-q` imprime el del movimiento —no el del candidato,
    // que es lo que la fila de la tabla enseña primero—, porque es el que
    // `bank match apply` acepta: si aquí saliera el `journal_entry_line`, la
    // tubería que el catálogo promete moriría con un 404 por cada línea.
    expect(r.out).toBe(`${TX}\n`);
    expect(r.exitCode).toBe(0);
  });
});

describe('bank match run · la mitad de escritura', () => {
  it('escribe grupo, cotejo, marca el movimiento y SELLA la partida', async () => {
    const r = await run(['bank', 'match', 'run', '--account', ACC], lectorCotejo());
    expect(r.errs).toEqual([]);
    expect(r.exitCode).toBe(0);

    const grupo = r.sql.find((s) => /INSERT INTO reconciliation_match_groups/.test(s.text));
    // Cada aplicación crea SU grupo aunque sea 1:1: `reconciliation_id` de la
    // línea apunta al grupo, así que un cotejo sin grupo dejaría el sello
    // apuntando a nada. Y el grupo guarda las tres sumas, con lo que la
    // igualdad queda comprobada también en el camino automático.
    expect(grupo, 'un cotejo sin grupo deja el sello apuntando a nada').toBeDefined();
    expect(grupo!.params).toEqual(
      expect.arrayContaining(['E1', ACC, '-250.0000', '-250.0000', '0.0000', '0.0000', 'keep', 'motor'])
    );

    const cotejo = r.sql.find((s) => /INSERT INTO reconciliation_matches/.test(s.text));
    expect(cotejo!.params).toEqual(expect.arrayContaining(['automatic', 'journal_entry_line', JEL, '250.0000']));

    const marca = r.sql.find((s) => /UPDATE bank_transactions/.test(s.text));
    expect(marca!.text.replace(/\s+/g, ' '), 'atado a la cuenta, no sólo al id')
      .toMatch(/WHERE id = ANY\(\$3::uuid\[\]\) AND bank_account_id = \$4/);

    const sello = r.sql.find((s) => /UPDATE journal_entry_lines/.test(s.text));
    // Las tres columnas JUNTAS: el CHECK `jel_sello_coherente` de la 052 no
    // admite término medio.
    expect(sello!.text.replace(/\s+/g, ' ')).toMatch(
      /SET is_reconciled = true, reconciled_at = NOW\(\), reconciliation_id = \$1/
    );
    expect(r.out).toMatch(/1 aplicado\(s\)/);
  });

  it('un periodo que no está `open` omite en vez de escribir', async () => {
    const r = await run(
      ['bank', 'match', 'run', '--account', ACC],
      lectorCotejo({ periodo: 'soft_close' })
    );
    // El camino automático exige `open` y nada más: un periodo en cierre suave
    // está justo en el momento en que nadie quiere que una máquina le añada
    // aseveraciones sola.
    expect(r.sql.filter((s) => /INSERT INTO reconciliation_match/.test(s.text))).toEqual([]);
    expect(r.out).toMatch(/0 aplicado\(s\)/);
    expect(r.exitCode).toBe(0);
  });

  it('--dry-run recorre el camino real y lo deshace', async () => {
    const r = await run(['bank', 'match', 'run', '--account', ACC, '--dry-run'], lectorCotejo());
    // El INSERT sí corre —es lo que prueba que la base lo aceptaría—; lo que
    // esta prueba fija es que el resultado se reporta como ENSAYO.
    expect(r.sql.some((s) => /INSERT INTO reconciliation_match_groups/.test(s.text))).toBe(true);
    expect(r.out).toMatch(/^◑/m);
    expect(r.out).not.toMatch(/^✔/m);
  });

  it('sin --account no corre: una escritura no barre «lo que haya»', async () => {
    responder = lectorCotejo();
    const p = new Command('mnemosine').exitOverride();
    registerBankCommand(p, behaviorDeps);
    await expect(
      p.parseAsync(['node', 'mnemosine', 'bank', 'match', 'run'])
    ).rejects.toThrow(/--account/);
  });

  it('--session que no es uuid se para antes de abrir transacción', async () => {
    const r = await run(
      ['bank', 'match', 'run', '--account', ACC, '--session', 'la-de-julio'],
      lectorCotejo()
    );
    expect(r.exitCode).toBe(2);
    expect(r.sql.filter((s) => /INSERT/.test(s.text))).toEqual([]);
  });
});

describe('bank match apply', () => {
  it('toma los ids de la tubería con --stdin', async () => {
    const r = await run(
      ['bank', 'match', 'apply', '--stdin', '-y'],
      lectorCotejo(),
      { readStdin: () => Promise.resolve(`${TX}\n`) }
    );
    // Es lo que hace existir `bank match preview -q | mnemosine bank match apply --stdin`.
    expect(r.errs).toEqual([]);
    expect(r.sql.some((s) => /INSERT INTO reconciliation_matches/.test(s.text))).toBe(true);
    expect(r.out).toMatch(/1 aplicado\(s\)/);
  });

  it('los dos orígenes se SUMAN: la tubería más la corrección tecleada', async () => {
    let pregunta = '';
    await run(
      ['bank', 'match', 'apply', TX, '--stdin'],
      lectorCotejo(),
      {
        readStdin: () => Promise.resolve(`${JEL}\n`),
        confirm: (q: string) => {
          pregunta = q;
          return Promise.resolve(false);
        },
      }
    );
    // Excluirlos entre sí prohibiría `preview -q | apply --stdin <uno-más>`,
    // que es una corrección normal, y no protegería de nada: los repetidos los
    // rehúsa el servicio nombrando cuál.
    expect(pregunta).toMatch(/2 movimiento\(s\)/);
  });

  it('sin ids y sin --stdin no adivina', async () => {
    const r = await run(['bank', 'match', 'apply'], lectorCotejo());
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/--stdin/);
    expect(r.sql).toEqual([]);
  });

  it('sin confirmación no escribe, y nombra -y en vez de decir «abortado»', async () => {
    const r = await run(
      ['bank', 'match', 'apply', TX],
      lectorCotejo(),
      { confirm: () => Promise.resolve(false) }
    );
    // La ausencia de humano no es el permiso de escribir: sin TTY `ask` dice
    // que no, y ahí es donde `--stdin` necesita `-y` explícito.
    expect(r.sql.filter((s) => /INSERT/.test(s.text))).toEqual([]);
    expect(r.exitCode).not.toBe(0);
  });

  it('lo ya cotejado se informa con el id del cotejo vivo, no como fallo', async () => {
    const r = await run(
      ['bank', 'match', 'apply', TX, '-y', '--json'],
      lectorCotejo({ ocupado: true })
    );
    const payload = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    // Un reintento automático necesita saber que no hizo falta, y contra qué.
    expect(payload.rows[0].outcome).toBe('already-applied');
    expect(payload.rows[0].match).toBe(MATCH);
  });

  it('pedir diez y aplicar cero no sale 0 en silencio', async () => {
    const r = await run(
      ['bank', 'match', 'apply', TX, '-y'],
      lectorCotejo({ periodo: 'locked' })
    );
    expect(r.exitCode, '4 es «hay algo que mirar», como en statement check').toBe(4);
  });
});

describe('bank match create · el grupo explícito', () => {
  it('cuadra Σbanco = Σlibros + Σajustes ANTES de escribir', async () => {
    const r = await run(
      ['bank', 'match', 'create', '--account', ACC, '--transaction', TX, '--book-item', JEL],
      lectorCotejo()
    );
    expect(r.errs).toEqual([]);
    const grupo = r.sql.find((s) => /INSERT INTO reconciliation_match_groups/.test(s.text));
    expect(grupo!.params).toEqual(
      expect.arrayContaining(['-250.0000', '-250.0000', '0.0000', '0.0000', 'keep', 'manual'])
    );
    expect(r.out).toMatch(/banco -250\.0000 = libros -250\.0000/);
  });

  it('un descuadre sin declarar se rehúsa NOMBRANDO los tres números', async () => {
    const r = await run(
      [
        'bank', 'match', 'create', '--account', ACC, '--transaction', TX,
        '--book-item', JEL, '--adjust', 'comision=-35.00',
      ],
      lectorCotejo()
    );
    expect(r.exitCode, 'es una validación del dominio, no un typo').toBe(4);
    const mensaje = (r.errs[0] as Error).message;
    expect(mensaje).toMatch(/-250\.0000/);
    expect(mensaje).toMatch(/-35\.0000/);
    expect(mensaje, 'con la diferencia dentro, para no rehacer la resta a mano').toMatch(/35\.0000/);
    expect(r.sql.filter((s) => /INSERT INTO reconciliation_match_groups/.test(s.text))).toEqual([]);
  });

  it('--adjust mal escrito es error de USO y no llega a la base', async () => {
    responder = lectorCotejo();
    const p = new Command('mnemosine').exitOverride();
    registerBankCommand(p, behaviorDeps);
    await expect(
      p.parseAsync([
        'node', 'mnemosine', 'bank', 'match', 'create', '--account', ACC,
        '--transaction', TX, '--book-item', JEL, '--adjust', 'comision',
      ])
    ).rejects.toThrow(/<concept>=<amount>/);
  });

  it('--book-item admite <tipo>:<id> y rechaza un tipo inventado', async () => {
    const r = await run(
      [
        'bank', 'match', 'create', '--account', ACC, '--transaction', TX,
        '--book-item', `contrato:${JEL}`,
      ],
      lectorCotejo()
    );
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/journal_entry_line/);
  });

  it('un id de banco repetido se rehúsa: contaría doble y el grupo cuadraría de más', async () => {
    const r = await run(
      ['bank', 'match', 'create', '--account', ACC, '--transaction', `${TX},${TX}`, '--book-item', JEL],
      lectorCotejo()
    );
    expect(r.exitCode).toBe(4);
    expect((r.errs[0] as Error).message).toMatch(/dos veces/);
  });
});

describe('bank match unapply · clausura, no borra', () => {
  const lectorDesaplicar = (over: { sesion?: string } = {}) => (text: string) => {
    if (/rm\.id, rm\.group_id, rm\.reconciliation_session_id/.test(text)) {
      return filas([{
        id: MATCH, group_id: GRUPO, reconciliation_session_id: over.sesion ? SESION : null,
        bank_transaction_id: TX, bank_account_id: ACC, entity_id: 'E1', unapplied_at: null,
      }]);
    }
    if (/FROM reconciliation_sessions/.test(text)) {
      return filas([{ status: over.sesion ?? 'in_progress' }]);
    }
    if (/SELECT reconciliation_session_id FROM reconciliation_match_groups/.test(text)) {
      return filas([{ reconciliation_session_id: over.sesion ? SESION : null }]);
    }
    if (/WHERE rm\.group_id = \$1/.test(text)) {
      return filas([{ id: MATCH, bank_transaction_id: TX }]);
    }
    if (/UPDATE journal_entry_lines/.test(text)) return filas([{ id: JEL }]);
    if (/UPDATE bank_transactions bt/.test(text)) return filas([{ id: TX }]);
    return filas([]);
  };

  it('marca la fila con motivo y NO la borra', async () => {
    const r = await run(
      ['bank', 'match', 'unapply', MATCH, '--reason', 'cotejo-erroneo', '-y'],
      lectorDesaplicar()
    );
    expect(r.errs).toEqual([]);
    expect(r.sql.filter((s) => /DELETE/.test(s.text)), 'el auditor pregunta por qué se deshizo').toEqual([]);
    const clausura = r.sql.find((s) => /SET unapplied_at = NOW\(\)/.test(s.text));
    expect(clausura!.params).toEqual(expect.arrayContaining(['U1', 'cotejo-erroneo']));
    // El sello del lado de libros se libera con las tres columnas juntas.
    const libera = r.sql.find((s) => /UPDATE journal_entry_lines/.test(s.text));
    expect(libera!.text.replace(/\s+/g, ' ')).toMatch(
      /SET is_reconciled = false, reconciled_at = NULL, reconciliation_id = NULL/
    );
    expect(r.out).toMatch(/1 cotejo\(s\) clausurado\(s\)/);
  });

  it('sin --reason no corre, y el motivo es un CÓDIGO y no prosa', async () => {
    const falta = await run(['bank', 'match', 'unapply', MATCH, '-y'], lectorDesaplicar());
    expect(falta.exitCode).toBe(2);
    expect((falta.errs[0] as Error).message).toMatch(/documento-cancelado/);
    expect(falta.sql, 'ni siquiera abre conexión').toEqual([]);

    const prosa = await run(
      ['bank', 'match', 'unapply', MATCH, '--reason', 'me equivoqué', '-y'],
      lectorDesaplicar()
    );
    // Una taxonomía cerrada es lo que permite CONTAR las causas; un campo
    // libre contesta «¿cuántos por documento cancelado?» con un grep.
    expect(prosa.exitCode).toBe(2);
    expect(prosa.sql).toEqual([]);
  });

  it('arrastra al grupo entero: la igualdad no sobrevive a que le quiten una pata', async () => {
    const r = await run(
      ['bank', 'match', 'unapply', MATCH, '--reason', 'duplicado', '-y'],
      lectorDesaplicar()
    );
    const alcanzados = r.sql.find((s) => /WHERE rm\.group_id = \$1/.test(s.text));
    expect(alcanzados, 'se buscan los hermanos vivos del grupo').toBeDefined();
    expect(alcanzados!.text.replace(/\s+/g, ' ')).toMatch(/rm\.unapplied_at IS NULL AND ba\.entity_id = \$2/);
  });

  it('se rehúsa si la sesión ya está firmada', async () => {
    const r = await run(
      ['bank', 'match', 'unapply', MATCH, '--reason', 'duplicado', '-y'],
      lectorDesaplicar({ sesion: 'approved' })
    );
    expect(r.exitCode, 'conflicto: reescribiría una aseveración ya firmada').toBe(6);
    expect(r.sql.filter((s) => /SET unapplied_at/.test(s.text))).toEqual([]);
  });

  it('sin confirmar no toca nada', async () => {
    const r = await run(
      ['bank', 'match', 'unapply', MATCH, '--reason', 'duplicado'],
      lectorDesaplicar(),
      { confirm: () => Promise.resolve(false) }
    );
    expect(r.sql.filter((s) => /SET unapplied_at/.test(s.text))).toEqual([]);
    expect(r.exitCode).not.toBe(0);
  });
});

// ============================================================
// F05c · LA SESIÓN QUE CUADRA
//
// Lo que estas pruebas vigilan es UNA cosa, y es la tesis del tramo: que
// ninguna superficie vuelva a presentar un cero por omisión como un cuadre.
// Por eso hay tres casos sobre el mismo número —«sin observar» en texto, `null`
// en json, y el hueco en la lista— y ninguno es redundante: son las tres
// puertas por las que el defecto histórico volvería a salir.
// ============================================================

function sesionFila(over: Record<string, unknown> = {}) {
  return {
    id: SES, bank_account_id: ACC, entity_id: 'E1',
    start_date: '2026-07-01', end_date: '2026-07-31',
    beginning_balance: '0.0000', ending_balance_per_bank: '750.0000',
    // Las seis columnas escalares de la 003, en su DEFAULT 0 — que es
    // exactamente como está toda sesión que nadie ha calculado.
    ending_balance_per_books: '0.0000', outstanding_checks: '0.0000',
    deposits_in_transit: '0.0000', bank_charges: '0.0000', bank_interest: '0.0000',
    other_adjustments: '0.0000', variance: '0.0000',
    status: 'in_progress', statement_id: ST,
    arithmetic_computed_at: null, closed_at: null, closed_by: null, approved_by: null,
    notes: null, created_at: '2026-08-01 10:00:00',
    account_name: 'BBVA MXN', account_type: 'checking', currency_code: 'MXN',
    ...over,
  };
}

function cuentaDeSesion(over: Record<string, unknown> = {}) {
  return {
    id: ACC, account_name: 'BBVA MXN', account_type: 'checking', currency_code: 'MXN',
    gl_account_id: 'GL1', is_active: true, gl_de_la_entidad: 'GL1',
    ...over,
  };
}

function extractoDeSesion(over: Record<string, unknown> = {}) {
  return {
    id: ST, period_start: '2026-07-01', period_end: '2026-07-31',
    opening_balance: '0.0000', closing_balance: '750.0000',
    currency_code: 'MXN', statement_number: '2026-07',
    ...over,
  };
}

function partidaFila(over: Record<string, unknown> = {}) {
  return {
    id: PART, tipo: 'cheque-en-circulacion', importe: '-100.0000', fecha: '2026-07-20',
    antiguedad_dias: 42, responsable: null, fecha_esperada: null, escalamiento: 'ninguno',
    bank_transaction_id: null, journal_entry_line_id: 'JL1', notas: null,
    resuelta_at: null, hoy: '2026-08-31',
    ...over,
  };
}

function ajusteFila(over: Record<string, unknown> = {}) {
  return {
    id: AJU, tipo: 'comision', importe: '-35.0000', reconciling_item_id: null,
    draft_id: DRAFT, estado_del_borrador: 'pending_review', journal_entry_id: null,
    creado_el: '2026-08-31T10:00:00-06', created_by: 'U1',
    ...over,
  };
}

interface MundoDeSesion {
  sesion?: Record<string, unknown>;
  cuenta?: Record<string, unknown>;
  extractos?: unknown[];
  partidas?: unknown[];
  ajustes?: unknown[];
  saldoLibros?: string;
  sinExplicar?: { cuantos: string; importe: string };
  anterior?: unknown[];
  traslape?: unknown[];
}

/**
 * El mundo de una sesión, consulta por consulta.
 *
 * El orden de los patrones IMPORTA: la consulta de movimientos sin explicar
 * lleva dentro un `NOT EXISTS (… FROM reconciling_items ri …)`, así que se
 * reconoce antes que el listado de partidas o se quedaría con las dos.
 */
const mundo =
  (over: MundoDeSesion = {}) =>
  (text: string) => {
    if (/information_schema\.columns/.test(text)) {
      return filas([
        { table_name: 'reconciliation_sessions', column_name: 'entity_id' },
        { table_name: 'bank_accounts', column_name: 'entity_id' },
      ]);
    }
    // Sin filas, las dos políticas caen a su valor por omisión del catálogo:
    // `cero_exacto` y `partida_conciliatoria`.
    if (/FROM policy_decisions/.test(text)) return filas([]);
    if (/SELECT id, account_name FROM bank_accounts/.test(text)) {
      return filas([{ id: ACC, account_name: 'BBVA MXN' }]);
    }
    if (/cuenta_de_banco/.test(text)) {
      return filas([{
        id: SES, bank_account_id: ACC, end_date: '2026-07-31', status: 'in_progress',
        closed_at: null, cuenta_de_banco: '1110', nombre_de_cuenta: 'BBVA MXN',
      }]);
    }
    if (/partidas_abiertas/.test(text)) {
      return filas([{ ...sesionFila(over.sesion), partidas_abiertas: '3' }]);
    }
    if (/SELECT s\.id, s\.bank_account_id, s\.entity_id/.test(text)) {
      return filas([sesionFila(over.sesion)]);
    }
    if (/gl_de_la_entidad/.test(text)) return filas([cuentaDeSesion(over.cuenta)]);
    if (/FROM bank_statements s/.test(text)) {
      return filas(over.extractos ?? [extractoDeSesion()]);
    }
    if (/FROM journal_entry_lines l/.test(text)) {
      return filas([{ saldo: over.saldoLibros ?? '750.0000' }]);
    }
    if (/COALESCE\(SUM\(bt\.amount\), 0\)/.test(text)) {
      return filas([over.sinExplicar ?? { cuantos: '0', importe: '0.0000' }]);
    }
    if (/SELECT ri\.id,/.test(text)) return filas(over.partidas ?? []);
    if (/FROM reconciliation_adjustments ra/.test(text)) return filas(over.ajustes ?? []);
    if (/UPDATE reconciliation_sessions/.test(text)) {
      return { rows: [{ arithmetic_computed_at: '2026-09-01 12:00:00+00' }], rowCount: 1 };
    }
    if (/FROM legal_entities WHERE id = \$1/.test(text)) return filas([{ tenant_id: 'T1' }]);
    if (/AND start_date <= \$4::date/.test(text)) return filas(over.traslape ?? []);
    if (/ORDER BY end_date DESC/.test(text)) return filas(over.anterior ?? []);
    return filas([]);
  };

describe('bank reconciliation status · el desglose de los dos lados', () => {
  it('imprime saldo, partidas UNA POR UNA y ajustado de cada lado, y la variación', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'status', SES],
      mundo({ partidas: [partidaFila()], saldoLibros: '720.0000' })
    );
    expect(r.errs).toEqual([]);
    expect(r.exitCode).toBe(0);
    // El lado del banco: 750 del extracto, menos el cheque en circulación.
    expect(r.out).toMatch(/saldo del extracto\s+750\.00/);
    expect(r.out).toMatch(/cheque-en-circulacion\s+-100\.00/);
    expect(r.out).toMatch(/= ajustado\s+650\.00/);
    // El de libros, sin partidas que lo corrijan.
    expect(r.out).toMatch(/saldo de libros\s+720\.00/);
    // Y la resta, que es lo que el endpoint retirado nunca hizo.
    expect(r.out).toMatch(/VARIACIÓN\s+-70\.00/);
  });

  it('un lado que nadie observó dice «sin observar», y la variación NO es cero', async () => {
    // Sin `statement_id` no hay de dónde sacar el saldo del banco: es el caso
    // de las sesiones que abrió la ruta REST, con `beginning_balance` fijo en 0.
    const r = await run(
      ['bank', 'reconciliation', 'status', SES],
      mundo({ sesion: { statement_id: null } })
    );
    expect(r.out).toMatch(/saldo del extracto\s+sin observar/);
    expect(r.out).toMatch(/VARIACIÓN\s+NO CALCULADA/);
    expect(r.out, 'un cero aquí sería exactamente el defecto histórico').not.toMatch(
      /VARIACIÓN\s+0\.00/
    );
    expect(r.out).toMatch(/nadie restó nada/);
  });

  it('NUNCA lee `variance` de la columna como la respuesta', async () => {
    // La fila guarda 0.0000 y nadie la calculó; la aritmética viva dice 50.
    const r = await run(
      ['bank', 'reconciliation', 'status', SES],
      mundo({ saldoLibros: '700.0000' })
    );
    expect(r.out).toMatch(/VARIACIÓN\s+50\.00/);
    // El cero de la columna sale sólo bajo su etiqueta, y nombrado.
    expect(r.out).toMatch(/RESUMEN CONGELADO/);
    expect(r.out).toMatch(/nadie ha hecho la aritmética de esta sesión/);
  });

  it('contrasta lo congelado con lo vivo cuando la sesión ya se cerró', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'status', SES],
      mundo({
        sesion: {
          status: 'balanced', variance: '0.0000',
          arithmetic_computed_at: '2026-08-01 10:00:00+00',
        },
        saldoLibros: '700.0000',
      })
    );
    // Firmó un cuadre y hoy la resta da 50: la sesión de julio dejó de decir
    // la verdad sin que nadie tocara su fila.
    expect(r.out).toMatch(/la aritmética viva dice 50\.00 y la sesión afirmó 0\.00/);
  });

  it('en json, la variación sin observar es null y NUNCA 0', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'status', SES, '--json'],
      mundo({ sesion: { statement_id: null } })
    );
    const doc = (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(doc.variance, 'null es «nadie restó», 0 sería «cuadra»').toBeNull();
    expect((doc.bank as Record<string, unknown>).balance).toBeNull();
    expect(doc.balances).toBe(false);
    // Y la columna congelada sigue publicándose aparte, con su etiqueta.
    expect((doc.frozen as Record<string, unknown>).variance).toBe('0.00');
    expect((doc.frozen as Record<string, unknown>).computed_at).toBeNull();
  });

  it('enseña los ajustes con el estado del borrador y la póliza VACÍA', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'status', SES],
      mundo({ ajustes: [ajusteFila()] })
    );
    // La promesa de que nada se contabiliza solo se COMPRUEBA en la salida.
    expect(r.out).toMatch(/AJUSTES/);
    expect(r.out).toMatch(/pending_review/);
    const cabecera = r.out.split('\n').find((l) => /journal_entry/.test(l));
    expect(cabecera, 'la columna existe para poder verla vacía').toBeDefined();
  });

  it('sin sesión y sin --account no adivina, y no gasta una conexión', async () => {
    const r = await run(['bank', 'reconciliation', 'status'], mundo());
    expect(r.exitCode).toBe(2);
    expect(r.sql).toEqual([]);
  });

  it('con las dos formas a la vez tampoco adivina', async () => {
    // Obedecer a una en silencio enseñaría la aritmética de una sesión que no
    // es la que se pidió.
    const r = await run(
      ['bank', 'reconciliation', 'status', SES, '--account', 'BBVA MXN'],
      mundo()
    );
    expect(r.exitCode).toBe(2);
    expect(r.sql).toEqual([]);
  });

  it('--fields desarma el desglose escrito a mano, y no sólo en json', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'status', SES, '--fields', 'variance,tolerance'],
      mundo({ saldoLibros: '700.0000' })
    );
    const cabecera = r.out.split('\n')[0];
    expect(cabecera).toMatch(/^variance\s+tolerance$/);
    expect(r.out).not.toMatch(/BANCO/);
  });
});

describe('bank reconciliation list · el hueco es el dato', () => {
  const CAMPOS = ['--fields', 'variance,computed_at,open_items'];

  beforeEach(() => {
    olvidarAlcances();
  });

  it('deja la variación EN BLANCO mientras nadie haya hecho la aritmética', async () => {
    const r = await run(['bank', 'reconciliation', 'list', '--json', ...CAMPOS], mundo());
    expect(r.errs).toEqual([]);
    const fila = (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows[0];
    // La columna de la fila vale 0.0000 y NO se proyecta: en una lista, donde
    // no cabe un párrafo de contexto, ese cero se leería como un cuadre.
    expect(fila.variance).toBe('');
    expect(fila.computed_at).toBe('');
    expect(fila.open_items).toBe(3);
  });

  it('la publica en cuanto la sesión sí tiene aritmética', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'list', '--json', ...CAMPOS],
      mundo({ sesion: { arithmetic_computed_at: '2026-08-01 10:00:00+00', variance: '0.0000' } })
    );
    const fila = (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(fila.variance).toBe('0.00');
  });

  it('la frontera va dentro del SQL, y --all-entities sigue acotando por inquilino', async () => {
    const propia = await run(['bank', 'reconciliation', 'list'], mundo());
    const sel = propia.sql.find((s) => /partidas_abiertas/.test(s.text));
    expect(sel!.text.replace(/\s+/g, ' ')).toMatch(/s\.entity_id = \$1/);
    expect(sel!.params[0]).toBe('E1');

    const despacho = await run(['bank', 'reconciliation', 'list', '--all-entities'], mundo());
    const todas = despacho.sql.find((s) => /partidas_abiertas/.test(s.text));
    expect(todas!.text.replace(/\s+/g, ' ')).toMatch(
      /s\.entity_id IN \(SELECT id FROM legal_entities WHERE tenant_id = \$1\)/
    );
    expect(todas!.params[0]).toBe('T1');
  });

  it('-s admite un estado del CHECK y rechaza lo demás, incluidos dos a la vez', async () => {
    const ok = await run(['bank', 'reconciliation', 'list', '-s', 'balanced'], mundo());
    const sel = ok.sql.find((s) => /partidas_abiertas/.test(s.text));
    expect(sel!.params).toContain('balanced');

    const inventado = await run(['bank', 'reconciliation', 'list', '-s', 'cuadrada'], mundo());
    expect(inventado.exitCode).toBe(2);
    expect((inventado.errs[0] as Error).message).toMatch(/in_progress, balanced, approved, posted/);

    const dos = await run(
      ['bank', 'reconciliation', 'list', '-s', 'balanced', '-s', 'posted'],
      mundo()
    );
    expect(dos.exitCode, 'quedarse con el primero devolvería otro listado en silencio').toBe(2);
  });
});

describe('bank reconciling-item list · lo que se persigue', () => {
  it('por omisión sólo las abiertas; --all incluye las resueltas', async () => {
    const abiertas = await run(
      ['bank', 'reconciling-item', 'list', SES],
      mundo({ partidas: [partidaFila()] })
    );
    const sel = abiertas.sql.find((s) => /SELECT ri\.id,/.test(s.text));
    expect(sel!.text).toMatch(/AND ri\.resuelta_at IS NULL/);

    const todas = await run(
      ['bank', 'reconciling-item', 'list', SES, '--all'],
      mundo({ partidas: [partidaFila()] })
    );
    const sel2 = todas.sql.find((s) => /SELECT ri\.id,/.test(s.text));
    expect(sel2!.text).not.toMatch(/AND ri\.resuelta_at IS NULL/);
  });

  it('acota por las DOS entidades, la de la partida y la de su sesión', async () => {
    const r = await run(
      ['bank', 'reconciling-item', 'list', SES],
      mundo({ partidas: [partidaFila()] })
    );
    const sel = r.sql.find((s) => /SELECT ri\.id,/.test(s.text));
    const texto = sel!.text.replace(/\s+/g, ' ');
    // Exigir sólo la de la partida dejaría pasar una partida bien sellada
    // colgada de una sesión ajena — y la sesión es la que se cierra.
    expect(texto).toMatch(/WHERE ri\.entity_id = \$1 AND s\.entity_id = \$1 AND s\.id = \$2/);
    expect(sel!.params).toEqual(['E1', SES]);
  });

  it('--over-days entra al SQL y --type inventado se rechaza nombrando los seis', async () => {
    const r = await run(
      ['bank', 'reconciling-item', 'list', SES, '--over-days', '30'],
      mundo({ partidas: [partidaFila()] })
    );
    const sel = r.sql.find((s) => /SELECT ri\.id,/.test(s.text));
    expect(sel!.text).toMatch(/CURRENT_DATE - ri\.fecha\) > \$\d+::int/);
    expect(sel!.params).toContain(30);

    const malo = await run(
      ['bank', 'reconciling-item', 'list', SES, '--type', 'cheque-viejo'],
      mundo()
    );
    expect(malo.exitCode).toBe(2);
    expect((malo.errs[0] as Error).message).toMatch(/deposito-en-transito/);
    expect(malo.sql, 'no llega a la base').toEqual([]);
  });

  it('un id de sesión que no es uuid no llega a la base', async () => {
    // Sin la guarda, el usuario vería el error crudo de Postgres: este
    // servicio no comprueba la forma del identificador.
    const r = await run(['bank', 'reconciling-item', 'list', 'la-de-julio'], mundo());
    expect(r.exitCode).toBe(2);
    expect(r.sql).toEqual([]);
  });

  it('el importe NO se recorta a dos decimales', async () => {
    const r = await run(
      ['bank', 'reconciling-item', 'list', SES, '--json'],
      mundo({ partidas: [partidaFila({ importe: '-19.7520' })] })
    );
    const fila = (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows[0];
    // La columna es DECIMAL(19,4): recortar a la salida lo que después se suma
    // es el defecto que F05a cazó tres veces.
    expect(fila.amount).toBe('-19.7520');
  });

  it('el escalamiento VIVO viaja junto al guardado', async () => {
    const r = await run(
      ['bank', 'reconciling-item', 'list', SES, '--json', '--fields', 'escalation,escalation_on_file'],
      mundo({
        partidas: [partidaFila({ fecha_esperada: '2026-08-01', escalamiento: 'avisado' })],
      })
    );
    const fila = (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows[0];
    // La fecha esperada ya pasó (hoy = 2026-08-31), así que el derivado manda:
    // un 'avisado' guardado sobre una fecha vencida es dato que envejece.
    expect(fila.escalation).toBe('vencido');
    expect(fila.escalation_on_file).toBe('avisado');
  });
});

describe('bank adjustment create · nace borrador y espera a una persona', () => {
  const ARGS = ['bank', 'adjustment', 'create', SES, '--type', 'comision', '--amount', '-35.00'];

  it('escribe la fila y su borrador, NUNCA una póliza, y sale 11', async () => {
    const r = await run([...ARGS, '--gl-account', '6150'], mundo());
    expect(r.errs).toEqual([]);
    // 11 es «no falló: espera a una persona», que es lo que deja un borrador.
    expect(r.exitCode).toBe(11);

    const ins = r.sql.find((s) => /INSERT INTO reconciliation_adjustments/.test(s.text));
    expect(ins, 'la fila ata el ajuste a la sesión').toBeDefined();
    // `journal_entry_id` NO SE PASA: ni siquiera aparece en la sentencia.
    expect(ins!.text).not.toMatch(/journal_entry_id/);
    expect(ins!.params).toEqual(expect.arrayContaining([SES, 'comision', '-35.00', DRAFT]));
    expect(r.sql.filter((s) => /INSERT INTO journal_entries/.test(s.text))).toEqual([]);
    // Y el asiento propuesto se enseña: gasto contra banco.
    expect(r.out).toMatch(/6150/);
    expect(r.out).toMatch(/1110/);
  });

  it('un signo que contradice al tipo se RECHAZA, no se voltea', async () => {
    const r = await run(
      ['bank', 'adjustment', 'create', SES, '--type', 'comision', '--amount', '35.00',
        '--gl-account', '6150'],
      mundo()
    );
    expect(r.exitCode).toBe(4);
    expect((r.errs[0] as Error).message).toMatch(/tiene que ser negativo/);
    expect(r.sql.filter((s) => /INSERT INTO reconciliation_adjustments/.test(s.text))).toEqual([]);
  });

  it('sin cuenta y sin rol sembrado, nombra el rol que falta en vez de elegir una vecina', async () => {
    const r = await run(ARGS, mundo());
    expect(r.exitCode).toBe(4);
    expect((r.errs[0] as Error).message).toMatch(/comision_bancaria/);
    expect(r.sql.filter((s) => /INSERT INTO reconciliation_adjustments/.test(s.text))).toEqual([]);
  });

  it('un --type fuera de los cinco no llega a la base', async () => {
    const r = await run(
      ['bank', 'adjustment', 'create', SES, '--type', 'penalizacion', '--amount', '-1.00'],
      mundo()
    );
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/isr-retenido/);
    expect(r.sql).toEqual([]);
  });
});

describe('bank reconciliation close · donde `balanced` empieza a significar algo', () => {
  it('no cierra si no cuadra: sale 4, dice la variación y lo que falta, y no escribe', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'close', SES, '-y'],
      mundo({ partidas: [partidaFila()] })
    );
    expect(r.exitCode, '4 es «encontré algo que mirar»').toBe(4);
    expect(r.out).toMatch(/-100\.00/);
    expect(r.out).toMatch(/0 partida\(s\) sin clasificar y 1 sin fechar/);
    expect(r.out).toMatch(/\[variacion-fuera-de-tolerancia\]/);
    expect(r.out).toMatch(/\[partida-sin-fechar\]/);
    expect(
      r.sql.filter((s) => /UPDATE reconciliation_sessions/.test(s.text)),
      'marcarla balanced le diría al cierre que el efectivo se verificó'
    ).toEqual([]);
  });

  it('cuando cuadra, escribe el estado y la marca de aritmética en la MISMA sentencia', async () => {
    const r = await run(['bank', 'reconciliation', 'close', SES, '-y'], mundo());
    expect(r.errs).toEqual([]);
    expect(r.exitCode).toBe(0);
    const upd = r.sql.find((s) => /UPDATE reconciliation_sessions/.test(s.text));
    // El CHECK `sesion_balanceada_con_aritmetica` de la 053 no admite lo uno
    // sin lo otro: separarlos abriría una ventana con la fila en 'balanced' y
    // sin aritmética.
    expect(upd!.text.replace(/\s+/g, ' ')).toMatch(
      /SET status = 'balanced', arithmetic_computed_at = NOW\(\)/
    );
    expect(upd!.text.replace(/\s+/g, ' ')).toMatch(/WHERE id = \$1 AND entity_id = \$11 AND status = 'in_progress'/);
    expect(r.out).toMatch(/variación 0\.00/);
  });

  it('sin confirmar no firma nada', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'close', SES],
      mundo(),
      { confirm: () => Promise.resolve(false) }
    );
    expect(r.exitCode, 'abortada por quien iba a firmar').toBe(10);
    expect(r.sql.filter((s) => /UPDATE reconciliation_sessions/.test(s.text))).toEqual([]);
  });

  it('sobre una sesión ya firmada no pregunta nada: la rechaza', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'close', SES],
      mundo({ sesion: { status: 'balanced', arithmetic_computed_at: '2026-08-01 10:00:00+00' } }),
      // Si llegara a preguntar, este doble diría que sí; la prueba es que no
      // hay pregunta que hacer sobre una aseveración ya hecha.
      { confirm: () => Promise.resolve(true) }
    );
    expect(r.exitCode, 'conflicto: reescribiría un resumen sobre una firma').toBe(6);
    expect(r.sql.filter((s) => /UPDATE reconciliation_sessions/.test(s.text))).toEqual([]);
  });

  it('--tolerance no afloja un criterio que el despacho fijó en cero exacto', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'close', SES, '--tolerance', '5.00', '-y'],
      mundo()
    );
    expect(r.exitCode).toBe(4);
    expect((r.errs[0] as Error).message).toMatch(/conciliacion_tolerancia/);
    expect(r.sql.filter((s) => /UPDATE reconciliation_sessions/.test(s.text))).toEqual([]);
  });
});

describe('bank reconciliation open · el contenedor, no la aseveración', () => {
  it('ata la sesión al extracto y toma de él los dos saldos', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'open', 'BBVA MXN', '--period', '2026-07'],
      mundo()
    );
    expect(r.errs).toEqual([]);
    const ins = r.sql.find((s) => /INSERT INTO reconciliation_sessions/.test(s.text));
    expect(ins, 'la sesión nace atada a su documento').toBeDefined();
    // `beginning_balance` sale del extracto y no fijo en cero, que es lo que
    // hacía la ruta REST; `arithmetic_computed_at` ni siquiera se menciona.
    expect(ins!.params).toEqual(expect.arrayContaining(['E1', ACC, '2026-07-01', '2026-07-31', '0.00', '750.00', ST]));
    expect(ins!.text).not.toMatch(/arithmetic_computed_at/);
    expect(ins!.text).toMatch(/'in_progress'/);
  });

  it('sin extracto importado no abre: la sesión saldría con el saldo en cero', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'open', 'BBVA MXN', '--period', '2026-07'],
      mundo({ extractos: [] })
    );
    expect(r.exitCode).toBe(4);
    expect((r.errs[0] as Error).message).toMatch(/bank statement import/);
    expect(r.sql.filter((s) => /INSERT INTO reconciliation_sessions/.test(s.text))).toEqual([]);
  });

  it('un cierre anterior distinto del inicio de este extracto para la apertura', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'open', 'BBVA MXN', '--period', '2026-07'],
      mundo({
        anterior: [{
          id: SES, end_date: '2026-06-30', ending_balance_per_bank: '10.0000', status: 'balanced',
        }],
      })
    );
    // El extracto abre en 0 y la sesión anterior cerró afirmando 10: uno de
    // los dos números es falso, y cuál no lo decide el programa.
    expect(r.exitCode).toBe(6);
    expect(r.sql.filter((s) => /INSERT INTO reconciliation_sessions/.test(s.text))).toEqual([]);
  });
});

describe('bank reconciliation generate · el expediente', () => {
  it('no finge un pdf ni un xlsx, y decirlo no cuesta una conexión', async () => {
    for (const formato of ['pdf', 'xlsx']) {
      const r = await run(
        ['bank', 'reconciliation', 'generate', SES, '--format', formato],
        mundo()
      );
      expect(r.exitCode, formato).toBe(2);
      expect((r.errs[0] as Error).message).toMatch(/no tiene dependencia de PDF ni de XLSX/);
      expect(r.sql, formato).toEqual([]);
    }
  });

  it('en un formato de tabla emite el estado en renglones, en el orden en que se suma', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'generate', SES, '--format', 'csv'],
      mundo({ partidas: [partidaFila()], saldoLibros: '720.0000' })
    );
    const lineas = r.out.trim().split('\n');
    expect(lineas[0]).toBe('section,concept,amount,note,line');
    expect(lineas[1]).toMatch(/^bank,ending-balance-per-bank,750\.00/);
    expect(r.out).toMatch(/bank,cheque-en-circulacion,-100\.00/);
    expect(r.out).toMatch(/bank,adjusted,650\.00/);
    expect(r.out).toMatch(/books,adjusted,720\.00/);
    expect(r.out).toMatch(/variance,bank-adjusted-minus-books-adjusted,-70\.00/);
  });

  it('el texto lleva encabezado y pie, y no inventa una firma', async () => {
    const r = await run(['bank', 'reconciliation', 'generate', SES], mundo());
    expect(r.out).toMatch(/ESTADO DE CONCILIACIÓN BANCARIA/);
    expect(r.out).toMatch(/2026-07-01 → 2026-07-31/);
    // Una sesión sin `approved_by` sale como no aprobada: es justo lo que un
    // auditor viene a buscar aquí.
    expect(r.out).toMatch(/sin aprobar/);
  });
});

describe('bank reconciliation run · el pase que se detiene a tiempo', () => {
  it('--format sin --file no describe nada, y se dice antes de tocar la base', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'run', 'BBVA MXN', '--period', '2026-07', '--format', 'csv'],
      mundo()
    );
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/--format y --profile describen el archivo/);
    expect(r.sql).toEqual([]);
  });

  it('un --stop-at inventado nombra los cinco pasos y no llega a la base', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'run', 'BBVA MXN', '--period', '2026-07', '--stop-at', 'aprobar'],
      mundo()
    );
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/extracto → cotejo → sesion → partidas → estado/);
  });

  it('sin extracto del periodo se detiene, dice qué falta y sale 4', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'run', 'BBVA MXN', '--period', '2026-07', '--stop-at', 'extracto'],
      mundo({ extractos: [] })
    );
    expect(r.exitCode, 'un paso que no se pudo hacer es un hallazgo, no un fallo').toBe(4);
    expect(r.out).toMatch(/LO QUE FALTA/);
    expect(r.out).toMatch(/Importar el estado de cuenta del periodo/);
    // Y la corrida dice SIEMPRE que no aprobó ni contabilizó, aunque se haya
    // detenido en el primer paso.
    expect(r.out).toMatch(/`run` no hace ninguna de las dos/);
  });
});

// ============================================================
// F05d · LA FIRMA Y EL SELLO
//
// Lo que estas pruebas vigilan es lo que separa a estas cinco hojas de las
// veintisiete anteriores: que MUEVEN EL MAYOR. De ahí las tres propiedades que
// se afirman una y otra vez —que nada se escribe sin que se haya enseñado
// antes, que lo que se enseña sale del MISMO recorrido que después escribe, y
// que una hoja irreversible nunca es invocable por el agente— y de ahí que
// varias afirmen sobre `motor.asientos`: la única forma de comprobar que un
// camino NO posteó es mirar el motor y encontrarlo vacío.
// ============================================================

interface MundoF05d extends MundoDeSesion {
  cotejos?: unknown[];
  aPostear?: unknown[];
  resueltas?: number;
  politicas?: Record<string, string>;
  llave?: { payload_hash: string; resultado: unknown };
  movimientos?: unknown[];
  periodo?: { id: string; period_name: string; status: string } | null;
  roles?: Array<{ role: string; account_id: string }>;
  pago?: Record<string, unknown>;
  movimientoDeCobro?: Record<string, unknown> | null;
  mexicana?: boolean;
}

/**
 * El mundo de F05d, consulta por consulta, encima del de F05c.
 *
 * El ORDEN vuelve a importar: la lectura de ajustes de `post` y la de `status`
 * salen de la misma tabla y sólo la primera pide el `payload` del borrador, así
 * que se reconoce por ahí y antes que la otra.
 */
const mundoDeFirma =
  (over: MundoF05d = {}) =>
  (text: string, params: unknown[]) => {
    if (/FROM idempotency_keys/.test(text)) return filas(over.llave ? [over.llave] : []);
    if (/FROM policy_decisions/.test(text)) {
      const valor = over.politicas?.[String(params[1])];
      return valor === undefined
        ? filas([])
        : filas([
            {
              key: params[1], status: 'resolved', resolved_value: valor,
              question: 'q', resolution_notes: null, default_value: null,
            },
          ]);
    }
    if (/SELECT rm\.id, rm\.group_id/.test(text)) return filas(over.cotejos ?? []);
    if (/draft_payload/.test(text)) return filas(over.aPostear ?? []);
    if (/UPDATE reconciling_items ri/.test(text)) {
      return { rows: [], rowCount: over.resueltas ?? 0 };
    }
    if (/UPDATE reconciliation_sessions/.test(text)) {
      return {
        rows: [
          {
            approved_at: '2026-09-01 12:00:00+00',
            posted_at: '2026-09-01 12:00:00+00',
            arithmetic_computed_at: '2026-09-01 12:00:00+00',
          },
        ],
        rowCount: 1,
      };
    }
    if (/SELECT posted_at::text/.test(text)) {
      return filas([{ posted_at: '2026-09-01 12:00:00+00' }]);
    }
    // ── tesorería ──
    if (/transaction_type = 'fee'/.test(text) || /transaction_type = 'interest'/.test(text)) {
      return filas(over.movimientos ?? []);
    }
    if (/FROM fiscal_periods/.test(text)) {
      return filas(
        over.periodo === null
          ? []
          : [over.periodo ?? { id: 'FP1', period_name: '2026-08', status: 'open' }]
      );
    }
    if (/FROM account_roles/.test(text)) {
      return filas(
        over.roles ?? [
          { role: 'comision_bancaria', account_id: 'A6310' },
          { role: 'iva_pendiente_acreditar', account_id: 'A1135' },
          { role: 'producto_financiero', account_id: 'A4310' },
          { role: 'isr_retenido_a_favor', account_id: 'A1145' },
        ]
      );
    }
    if (/incorporation_country/.test(text)) {
      return filas([
        { incorporation_country: over.mexicana === false ? 'US' : 'MX', accounting_standard: 'mx_nif' },
      ]);
    }
    if (/FROM vendor_payments/.test(text) && /FOR UPDATE/.test(text)) {
      return filas([pagoConCheque(over.pago)]);
    }
    if (/ya_usado_por/.test(text)) {
      return filas(
        over.movimientoDeCobro === null ? [] : [movimientoDeCobro(over.movimientoDeCobro)]
      );
    }
    return mundo(over)(text);
  };

/** Una sesión CUADRADA y cerrada por otro: el punto de partida de `approve`. */
function sesionBalanceada(over: Record<string, unknown> = {}) {
  return {
    status: 'balanced',
    closed_at: '2026-08-31 18:00:00',
    // Cerrada por OTRO usuario: `resolveReviewer` contesta U1 en estas pruebas,
    // así que con esto la segregación de funciones no se dispara sola.
    closed_by: 'U2',
    arithmetic_computed_at: '2026-08-31 18:00:00',
    variance: '0.0000',
    ...over,
  };
}

function pagoConCheque(over: Record<string, unknown> = {}) {
  return {
    id: PAGO, payment_number: 'PAY-0007', check_number: '10042',
    payment_method: 'check', payment_amount: '1160.0000', payment_date: '2026-08-01',
    currency_code: 'MXN', status: 'completed', bank_account_id: ACC,
    check_cleared_date: null, check_cleared_tx_id: null,
    ...over,
  };
}

function movimientoDeCobro(over: Record<string, unknown> = {}) {
  return {
    id: MOV, fecha: '2026-08-14', importe: '-1160.0000',
    descripcion: 'CHEQUE 10042', bank_account_id: ACC, moneda: 'MXN', ya_usado_por: null,
    ...over,
  };
}

describe('bank reconciliation approve · la firma que se enseña antes de darla', () => {
  beforeEach(() => {
    motor.asientos.length = 0;
  });

  it('enseña QUÉ se firma —variación, miembros y el hash— ANTES de preguntar', async () => {
    let pregunta = '';
    const r = await run(
      ['bank', 'reconciliation', 'approve', SES],
      mundoDeFirma({ sesion: sesionBalanceada() }),
      {
        confirm: (q: string) => {
          pregunta = q;
          return Promise.resolve(true);
        },
      }
    );
    expect(r.errs).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/LO QUE SE VA A FIRMAR/);
    // La variación VIVA junto a la CONGELADA: aprobar exige que la segunda
    // reproduzca la primera, y sin las dos en pantalla nadie ve que se comparó.
    // `monto` publica dos decimales cuando el valor no trae más: es la misma
    // escala que enseña `bank reconciliation status`, y no se cambia aquí.
    expect(r.out).toMatch(/variación\s+0\.00 \(congelada al cerrar: 0\.00\)/);
    expect(r.out).toMatch(/miembros\s+0 partida\(s\) · 0 cotejo\(s\) · 0 ajuste\(s\)/);

    const hash = /hash\s+([0-9a-f]{64})/.exec(r.out);
    expect(hash, 'el hash sale ENTERO: un hash recortado no se puede reproducir').not.toBeNull();
    expect(pregunta, 'y la pregunta lo lleva: firmar a ciegas es lo que esto impide')
      .toContain((hash as RegExpExecArray)[1].slice(0, 12));
  });

  it('el hash que se ENSEÑA es exactamente el que se ESCRIBE', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'approve', SES],
      mundoDeFirma({ sesion: sesionBalanceada() })
    );
    const hash = /hash\s+([0-9a-f]{64})/.exec(r.out) as RegExpExecArray;
    const firmas = r.sql.filter((q) => /approval_hash = \$5/.test(q.text));
    // DOS recorridos del mismo camino: el ENSAYO que compone la vista previa y
    // la escritura de verdad. Es el precio de que la pantalla no pueda contar
    // una cosa y el libro otra.
    expect(firmas.length, 'el ensayo y la escritura').toBe(2);
    expect(firmas[1].params[4], 'lo escrito es lo enseñado').toBe(hash[1]);
  });

  it('las cinco columnas de la firma van en UNA sentencia, que es lo que la 055 exige', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'approve', SES, '-y'],
      mundoDeFirma({ sesion: sesionBalanceada() })
    );
    const firma = r.sql.find((q) => /approval_hash = \$5/.test(q.text));
    const texto = (firma as { text: string }).text.replace(/\s+/g, ' ');
    // `sesion_firma_coherente` no admite media firma y `sesion_aprobada_con_firma`
    // no admite el estado sin el hash: separarlas abriría la ventana que los
    // dos CHECK existen para cerrar.
    expect(texto).toMatch(/SET status = 'approved'/);
    expect(texto).toMatch(/approved_by = \$2/);
    expect(texto).toMatch(/approved_at = NOW\(\)/);
    expect(texto).toMatch(/approval_snapshot = \$4::jsonb/);
    // Y el candado optimista: la segunda firma concurrente actualiza cero filas.
    expect(texto).toMatch(/WHERE id = \$1 AND entity_id = \$6 AND status = 'balanced'/);
    expect(r.exitCode).toBe(0);
  });

  it('sin confirmar NO firma: sólo queda el ensayo, que la transacción deshace', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'approve', SES],
      mundoDeFirma({ sesion: sesionBalanceada() }),
      { confirm: () => Promise.resolve(false) }
    );
    expect(r.exitCode, '10 es «abortado por el usuario», no un fallo').toBe(10);
    expect(
      r.sql.filter((q) => /approval_hash = \$5/.test(q.text)).length,
      'sólo el ensayo'
    ).toBe(1);
  });

  it('una sesión EN CURSO no se firma, y se dice dónde se hace la aritmética', async () => {
    const r = await run(['bank', 'reconciliation', 'approve', SES], mundoDeFirma());
    expect(r.exitCode, 'conflicto de estado, no validación').toBe(6);
    expect((r.errs[0] as Error).message).toMatch(/no se firma lo que todavía no cuadra/);
    expect((r.errs[0] as Error).message).toMatch(/bank reconciliation close/);
    // La proyección de la sesión también menciona `approval_hash`; lo que no
    // puede existir es la ESCRITURA, que es la que lo asigna.
    expect(r.sql.filter((q) => /approval_hash = \$5/.test(q.text)), 'ni el ensayo escribe')
      .toEqual([]);
  });

  it('con la política en «exigir», quien cerró la sesión no la firma', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'approve', SES, '-y'],
      mundoDeFirma({
        // U1 es quien contesta `resolveReviewer` en estas pruebas.
        sesion: sesionBalanceada({ closed_by: 'U1' }),
        politicas: { segregacion_de_funciones: 'exigir' },
      })
    );
    expect(r.exitCode, '7 es permiso, y esto es un control de cuatro ojos').toBe(7);
    expect((r.errs[0] as Error).message).toMatch(/quien hace la conciliación no la firma/);
    expect(r.sql.filter((q) => /approval_hash = \$5/.test(q.text))).toEqual([]);
  });

  it('un id que no es uuid no llega a la base', async () => {
    const r = await run(['bank', 'reconciliation', 'approve', 'la-de-agosto'], mundoDeFirma());
    expect(r.exitCode, 'un typo es uso (2), no una sesión que no cuadra (4)').toBe(2);
    expect(r.sql).toEqual([]);
  });

  it('en json, el hash viaja CON la instantánea que resume', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'approve', SES, '-y', '--json'],
      mundoDeFirma({ sesion: sesionBalanceada() })
    );
    const payload = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    const fila = payload.rows[0];
    expect(String(fila.hash)).toMatch(/^[0-9a-f]{64}$/);
    // Un hash sin su documento no lo puede verificar nadie: quien recibe el
    // json podría repetir el sha256 pero no tendría sobre qué.
    const instantanea = fila.snapshot as { version: number; saldos: { variacion: string | null } };
    expect(instantanea.version).toBe(1);
    expect(instantanea.saldos.variacion).toBe('0.00');
    expect(fila.status).toBe('approved');
  });

  it('--dry-run enseña la firma entera y deja la sesión sin firmar', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'approve', SES, '--dry-run', '--json'],
      mundoDeFirma({ sesion: sesionBalanceada() })
    );
    const fila = (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(fila.dry_run).toBe(true);
    expect(String(fila.hash), 'el hash que QUEDARÍA, entero').toMatch(/^[0-9a-f]{64}$/);
    // UN solo recorrido: en ensayo no hay vista previa que componer aparte.
    expect(r.sql.filter((q) => /approval_hash = \$5/.test(q.text)).length).toBe(1);
    expect(r.exitCode).toBe(0);
  });

  it('firmar NO postea: el motor del mayor no se toca', async () => {
    await run(
      ['bank', 'reconciliation', 'approve', SES, '-y'],
      mundoDeFirma({ sesion: sesionBalanceada() })
    );
    expect(motor.asientos, 'la firma congela; el mayor lo mueve `post`').toEqual([]);
  });
});

describe('bank reconciliation post · la hoja que mueve el mayor', () => {
  beforeEach(() => {
    motor.asientos.length = 0;
  });

  const ajustePosteado = {
    id: AJU, tipo: 'comision', importe: '-35.0000',
    draft_id: DRAFT, journal_entry_id: 'JE-VIEJA',
    draft_status: 'approved', draft_payload: null, draft_journal_entry_id: 'JE-VIEJA',
    entry_number: 'P-0009', movimiento_del_banco: null,
  };

  it('una sesión CUADRADA pero sin firmar no se contabiliza, y se dice por qué', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'post', SES, '-y'],
      mundoDeFirma({ sesion: { status: 'balanced' } })
    );
    expect(r.exitCode).toBe(6);
    expect((r.errs[0] as Error).message).toMatch(/está cuadrada pero SIN FIRMAR/);
    expect((r.errs[0] as Error).message).toMatch(/bank reconciliation approve/);
    expect(motor.asientos, 'nada llegó al mayor').toEqual([]);
  });

  it('imprime los asientos UNO POR UNO con su importe y su póliza, antes de preguntar', async () => {
    let pregunta = '';
    const r = await run(
      ['bank', 'reconciliation', 'post', SES],
      mundoDeFirma({ sesion: { status: 'approved' }, aPostear: [ajustePosteado], resueltas: 2 }),
      {
        confirm: (q: string) => {
          pregunta = q;
          return Promise.resolve(true);
        },
      }
    );
    expect(r.errs).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/ASIENTOS QUE SE VAN A CREAR/);
    expect(r.out).toMatch(/comision\s+-35\.00\s+adoptado · póliza P-0009/);
    // ADOPTAR NO ES POSTEAR, y la pregunta lo dice: el asiento ya existía
    // porque alguien aprobó el borrador en `mnemosine review`.
    expect(pregunta).toMatch(/CONTABILIZAR 0 asiento\(s\) nuevo\(s\)/);
    expect(motor.asientos, 'no se postea un segundo asiento por el mismo hecho').toEqual([]);
  });

  it('enseña lo que SELLA, que es la mitad del acto que nadie ve', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'post', SES, '--dry-run'],
      mundoDeFirma({ sesion: { status: 'approved' }, resueltas: 3 })
    );
    expect(r.out).toMatch(/Y LO QUE SE SELLA/);
    expect(r.out).toMatch(/línea\(s\) de libros contra la cuenta de mayor del banco/);
    expect(r.out).toMatch(/cotejo\(s\) contra el movimiento del extracto/);
    // Sin resolver la partida, la propia sesión firmada pasaría a mostrar una
    // variación igual a los ajustes contabilizados, todos los meses.
    expect(r.out).toMatch(/3 partida\(s\) conciliatoria\(s\) que el ajuste deja sin objeto/);
    expect(r.exitCode).toBe(0);
  });

  it('sin confirmar sólo corre el ensayo: la sesión no llega a `posted`', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'post', SES],
      mundoDeFirma({ sesion: { status: 'approved' } }),
      { confirm: () => Promise.resolve(false) }
    );
    expect(r.exitCode).toBe(10);
    expect(
      r.sql.filter((q) => /SET status = 'posted'/.test(q.text)).length,
      'sólo el ensayo, que la transacción deshace'
    ).toBe(1);
  });

  it('--idempotency-key repetida devuelve lo GRABADO y no vuelve a escribir', async () => {
    const grabado = {
      v: {
        sesionId: SES, estado: 'posted', yaContabilizada: true, asientos: [],
        posteados: 0, adoptados: 0, partidasSelladas: 0, cotejosEscritos: 0,
        grupoDelSello: null, partidasResueltas: 0,
        contabilizadaEl: '2026-09-01 12:00:00+00', ensayo: false,
      },
    };
    const r = await run(
      ['bank', 'reconciliation', 'post', SES, '-y', '--idempotency-key', 'cierre-agosto'],
      mundoDeFirma({
        sesion: { status: 'approved' },
        // La carga se calcula con la MISMA función que la escribe.
        llave: { payload_hash: hashDeCarga(SES, ''), resultado: grabado },
      })
    );
    expect(r.exitCode).toBe(0);
    expect(
      r.sql.filter((q) => /SET status = 'posted'/.test(q.text)),
      'nada se ejecutó otra vez'
    ).toEqual([]);
    expect(r.out).toMatch(/posted · 0 posteado\(s\)/);
  });

  it('la MISMA llave con otra carga acusa reuso en vez de contestar con el informe viejo', async () => {
    const r = await run(
      ['bank', 'reconciliation', 'post', SES, '-y', '--idempotency-key', 'cierre-agosto',
        '--note', 'otra cosa'],
      mundoDeFirma({
        sesion: { status: 'approved' },
        llave: { payload_hash: hashDeCarga(SES, ''), resultado: { v: {} } },
      })
    );
    expect(r.exitCode, '6: la llave existe con otra carga').toBe(6);
    expect((r.errs[0] as Error).message).toMatch(/ya se usó en "bank reconciliation post"/);
    expect(r.sql.filter((q) => /SET status = 'posted'/.test(q.text))).toEqual([]);
  });
});

describe('bank fee post · la comisión y su IVA que NO se acredita todavía', () => {
  beforeEach(() => {
    motor.asientos.length = 0;
  });

  const cargo = (over: Record<string, unknown> = {}) => ({
    id: 'BT-FEE', fecha: '2026-08-05', importe: '-35.0000',
    descripcion: 'COMISION MANEJO DE CUENTA', contraparte: null,
    ...over,
  });

  const mundoDeComisiones = (over: MundoF05d = {}) =>
    mundoDeFirma({ cuenta: { moneda_funcional: 'MXN' }, ...over });

  it('enseña el ASIENTO COMPLETO: base, IVA aparcado y el abono a la cuenta', async () => {
    const r = await run(
      ['bank', 'fee', 'post', ACC, '--period', '2026-08', '--iva-rate', '0.16', '-y'],
      mundoDeComisiones({ movimientos: [cargo()] })
    );
    expect(r.errs).toEqual([]);
    expect(r.exitCode).toBe(0);
    // El IVA se DESPEJA del total, no se calcula sobre él: 35 / 1.16 = 30.1724.
    expect(r.out).toMatch(/comision_bancaria\s+30\.1724/);
    expect(r.out).toMatch(/iva_pendiente_acreditar\s+4\.8276/);
    expect(r.out).toMatch(/BBVA MXN\s+35\.0000/);
    // Los CUATRO decimales de la columna, nunca dos.
    expect(r.out).not.toMatch(/30\.17\b(?!\d)/);
    expect(motor.asientos.map((a) => a.sourceType)).toEqual(['bank_fee']);
  });

  it('--iva-rate 0 deja el cargo entero como gasto, sin renglón de 1135', async () => {
    const r = await run(
      ['bank', 'fee', 'post', ACC, '--period', '2026-08', '--iva-rate', '0', '-y'],
      mundoDeComisiones({ movimientos: [cargo()] })
    );
    expect(r.out).toMatch(/comision_bancaria\s+35\.0000/);
    expect(r.out, 'una comisión exenta no aparca impuesto ninguno')
      .not.toMatch(/iva_pendiente_acreditar/);
    expect(r.exitCode).toBe(0);
  });

  it('--iva-rate en PORCENTAJE se rechaza como uso y no gasta una conexión', async () => {
    const r = await run(
      ['bank', 'fee', 'post', ACC, '--period', '2026-08', '--iva-rate', '16'],
      mundoDeComisiones()
    );
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/va entre 0 y 1, no en porcentaje/);
    expect(r.sql).toEqual([]);
  });

  it('un cargo con el signo al revés se OMITE con su motivo y sale 4', async () => {
    const r = await run(
      ['bank', 'fee', 'post', ACC, '--period', '2026-08', '--iva-rate', '0.16', '-y'],
      mundoDeComisiones({ movimientos: [cargo({ importe: '120.0000' })] })
    );
    // Una devolución de comisión METE dinero: contabilizarla como gasto la
    // sumaría al costo en vez de restarla, y cuadraría perfectamente así.
    expect(r.out).toMatch(/\[signo-contrario\]/);
    expect(motor.asientos, 'no se voltea un signo en silencio').toEqual([]);
    expect(r.exitCode, '4 es «hay algo que mirar», como en `statement check`').toBe(4);
  });

  it('volver a correr el mes y encontrarlo hecho NO es un hallazgo: sale 0', async () => {
    const r = await run(
      ['bank', 'fee', 'post', ACC, '--period', '2026-08', '--iva-rate', '0.16', '-y'],
      (text: string, params: unknown[]) =>
        /FROM journal_entries/.test(text) && /source_type = \$2/.test(text)
          ? filas([{ id: 'JE-VIEJA', entry_number: 'P-0001' }])
          : mundoDeComisiones({ movimientos: [cargo()] })(text, params)
    );
    expect(r.out).toMatch(/\[ya-contabilizada\]/);
    expect(motor.asientos).toEqual([]);
    expect(r.exitCode, 'un acto idempotente que no hizo nada no es un problema').toBe(0);
  });

  it('--dry-run enseña el asiento completo y devuelve los ids en null', async () => {
    const r = await run(
      ['bank', 'fee', 'post', ACC, '--period', '2026-08', '--iva-rate', '0.16', '--dry-run'],
      mundoDeComisiones({ movimientos: [cargo()] })
    );
    // El asiento se ve entero aunque no vaya a quedarse.
    expect(r.out).toMatch(/comision_bancaria\s+30\.1724/);
    expect(r.out).toMatch(/póliza \(ensayo\)/);
    // Y se creó de verdad, una sola vez: el ensayo ES el camino real, deshecho.
    expect(motor.asientos.length, 'sin vista previa aparte: en ensayo hay un solo recorrido')
      .toBe(1);
    expect(r.exitCode).toBe(0);
  });

  it('la frontera de entidad va por JOIN, porque bank_transactions no la tiene', async () => {
    const r = await run(
      ['bank', 'fee', 'post', ACC, '--period', '2026-08', '--iva-rate', '0.16', '-y'],
      mundoDeComisiones()
    );
    const consulta = r.sql.find((q) => /transaction_type = 'fee'/.test(q.text));
    const texto = (consulta as { text: string }).text.replace(/\s+/g, ' ');
    expect(texto).toMatch(/JOIN bank_accounts ba ON ba\.id = bt\.bank_account_id/);
    expect(texto).toMatch(/ba\.entity_id = \$2/);
    expect((consulta as { params: unknown[] }).params[1]).toBe('E1');
  });
});

describe('bank interest post · el interés BRUTO y la retención a favor', () => {
  beforeEach(() => {
    motor.asientos.length = 0;
  });

  const abono = (over: Record<string, unknown> = {}) => ({
    id: 'BT-INT', fecha: '2026-08-31', importe: '98.7500',
    descripcion: 'RENDIMIENTO', contraparte: null,
    ...over,
  });

  it('reconoce el ingreso por el BRUTO y la retención como pago a favor, nunca como gasto', async () => {
    const r = await run(
      ['bank', 'interest', 'post', ACC, '--period', '2026-08', '--rate', '0.0125', '-y'],
      mundoDeFirma({ cuenta: { moneda_funcional: 'MXN' }, movimientos: [abono()] })
    );
    expect(r.errs).toEqual([]);
    expect(r.exitCode).toBe(0);
    // 98.75 / (1 − 0.0125) = 100.0000, y la retención sale RESTANDO para que
    // neto + retención dé el bruto exacto.
    expect(r.out).toMatch(/BBVA MXN\s+98\.7500/);
    expect(r.out).toMatch(/isr_retenido_a_favor\s+1\.2500/);
    expect(r.out).toMatch(/producto_financiero\s+100\.0000/);
    expect(motor.asientos.map((a) => a.sourceType)).toEqual(['bank_interest']);
  });

  it('`--rate` es la RETENCIÓN y no la tasa de interés, y la ayuda lo dice', async () => {
    const r = await run(
      ['bank', 'interest', 'post', ACC, '--period', '2026-08', '--rate', '12', '-y'],
      mundoDeFirma({ cuenta: { moneda_funcional: 'MXN' } })
    );
    // Teclear la tasa anual del pagaré donde va la retención es el error que
    // de verdad se comete, y sale como uso antes de tocar la base.
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/--rate va entre 0 y 1/);
    expect(r.sql).toEqual([]);
  });

  it('un movimiento de interés que SACA dinero no se contabiliza al revés', async () => {
    const r = await run(
      ['bank', 'interest', 'post', ACC, '--period', '2026-08', '--rate', '0', '-y'],
      mundoDeFirma({ cuenta: { moneda_funcional: 'MXN' }, movimientos: [abono({ importe: '-40.0000' })] })
    );
    expect(r.out).toMatch(/\[signo-contrario\]/);
    expect(motor.asientos, 'un interés PAGADO no es un producto financiero').toEqual([]);
    expect(r.exitCode).toBe(4);
  });
});

describe('bank check reconcile · el mes en que cae el asiento', () => {
  beforeEach(() => {
    motor.asientos.length = 0;
  });

  it('dice EN QUÉ MES cae el asiento y POR QUÉ, antes de escribir nada', async () => {
    let pregunta = '';
    const r = await run(
      ['bank', 'check', 'reconcile', PAGO, '--transaction', MOV],
      mundoDeFirma({ mexicana: false }),
      {
        confirm: (q: string) => {
          pregunta = q;
          return Promise.resolve(true);
        },
      }
    );
    expect(r.errs).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/EL MES EN QUE CAE EL ASIENTO/);
    expect(r.out).toMatch(/cobrado el\s+2026-08-14/);
    expect(r.out).toMatch(/periodo\s+2026-08 \(open\)/);
    // La razón, no sólo el mes: el cheque se firmó el 1 de agosto y lo que
    // decide el periodo es el día en que el banco lo pagó.
    expect(r.out).toMatch(/el día del COBRO y no el de la firma/);
    expect(pregunta).toMatch(/el 2026-08-14/);
  });

  it('escribe las DOS columnas del cobro en la misma sentencia', async () => {
    const r = await run(
      ['bank', 'check', 'reconcile', PAGO, '--transaction', MOV, '-y'],
      mundoDeFirma({ mexicana: false })
    );
    const escritura = r.sql.find((q) => /UPDATE vendor_payments/.test(q.text));
    const texto = (escritura as { text: string }).text.replace(/\s+/g, ' ');
    // `pago_cheque_cobro_coherente` de la 055: la fecha sin el movimiento es
    // una afirmación sin prueba, y el movimiento sin la fecha, una prueba que
    // no dice de cuándo.
    expect(texto).toMatch(/SET check_cleared_date = \$1::date, check_cleared_tx_id = \$2/);
    expect(texto, 'la entidad otra vez en el WHERE, aunque el SELECT ya la exigió')
      .toMatch(/WHERE id = \$3 AND entity_id = \$4/);
    expect(r.exitCode).toBe(0);
  });

  it('cero reclasificado es un resultado legítimo, y se dice por qué', async () => {
    const r = await run(
      ['bank', 'check', 'reconcile', PAGO, '--transaction', MOV, '-y'],
      mundoDeFirma({ mexicana: false })
    );
    expect(r.out).toMatch(/IVA reclasificado 0\.0000/);
    expect(r.out).toMatch(/ninguno: no hay IVA que reclasificar/);
    expect(motor.asientos, 'sin IVA que mover no se inventa un asiento').toEqual([]);
  });

  it('--as-of que discrepa del banco se rechaza NOMBRANDO las dos fechas', async () => {
    const r = await run(
      ['bank', 'check', 'reconcile', PAGO, '--transaction', MOV, '--as-of', '2026-08-20', '-y'],
      mundoDeFirma({ mexicana: false })
    );
    expect(r.exitCode).toBe(4);
    const mensaje = (r.errs[0] as Error).message;
    expect(mensaje).toContain('2026-08-20');
    expect(mensaje).toContain('2026-08-14');
    expect(r.sql.filter((q) => /UPDATE vendor_payments/.test(q.text)), 'no se escribió el cobro')
      .toEqual([]);
  });

  it('un cheque ya cobrado no se cobra dos veces, y se dice cuándo y contra qué', async () => {
    const r = await run(
      ['bank', 'check', 'reconcile', PAGO, '-y'],
      mundoDeFirma({
        mexicana: false,
        pago: { check_cleared_date: '2026-08-14', check_cleared_tx_id: MOV },
      })
    );
    expect(r.exitCode).toBe(4);
    expect((r.errs[0] as Error).message).toMatch(/ya consta cobrado el 2026-08-14/);
    expect(r.sql.filter((q) => /UPDATE vendor_payments/.test(q.text))).toEqual([]);
  });

  it('un pago que no se hizo con cheque no tiene cobro que conciliar', async () => {
    const r = await run(
      ['bank', 'check', 'reconcile', PAGO, '-y'],
      mundoDeFirma({ mexicana: false, pago: { payment_method: 'transfer' } })
    );
    expect(r.exitCode).toBe(4);
    expect((r.errs[0] as Error).message).toMatch(/no con cheque/);
  });

  it('--dry-run dice el mes y no escribe el cobro dos veces', async () => {
    const r = await run(
      ['bank', 'check', 'reconcile', PAGO, '--transaction', MOV, '--dry-run', '--json'],
      mundoDeFirma({ mexicana: false })
    );
    const fila = (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(fila.dry_run).toBe(true);
    expect(fila.cleared_on, 'el mes lo decide el banco, y sale como DATO').toBe('2026-08-14');
    expect(fila.period).toBe('2026-08');
    expect(
      r.sql.filter((q) => /UPDATE vendor_payments/.test(q.text)).length,
      'un solo recorrido, el que la transacción deshace'
    ).toBe(1);
  });

  it('un id que no es uuid no llega a la base', async () => {
    const r = await run(['bank', 'check', 'reconcile', 'el-de-la-renta'], mundoDeFirma());
    expect(r.exitCode).toBe(2);
    expect(r.sql).toEqual([]);
  });
});
