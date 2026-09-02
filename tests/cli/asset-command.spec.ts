import { describe, it, expect, beforeAll } from 'vitest';
import { Command } from 'commander';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import {
  registerAssetCommand,
  exigirContabilizacion,
  exigirFecha,
  exigirImporte,
  exigirMetodo,
} from '../../src/cli/asset-command.js';
import {
  registerDepreciationCommand,
  exigirDimension,
  filasAgrupadas,
  filasDelAsiento,
  filasPorActivo,
} from '../../src/cli/depreciation-command.js';
import { riskOf, declareRisk } from '../../src/cli/kernel/risk.js';
import { VERBS } from '../../src/cli/kernel/vocabulary.js';
import { FLAG_DICTIONARY } from '../../src/cli/kernel/flags.js';
import {
  diferenciasContraPlan,
  leerPlanAprobado,
  type PlanDeDepreciacion,
} from '../../src/services/assets/depreciation-plan.js';
import { exigirLibroDelPanel } from '../../src/services/assets/asset-lookup.js';

// ============================================================
// F06a · las tres hojas contra el reglamento, antes de que el
// integrador las enchufe en mnemosine.ts. Construir el programa
// basta: `declareRisk` revienta en tiempo de REGISTRO, y
// `auditProgram` recorre el árbol igual que se recorre el binario
// embarcado.
//
// Lo que estas pruebas defienden y no es cosmético: que `post` sea
// irreversible (postea al mayor de la 041, que no admite UPDATE ni
// DELETE), que por serlo el agente no pueda llamarla NUNCA, y que
// `run` no lleve una sola bandera que sugiera que escribe.
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
 * El riesgo se fotografía al registrar a propósito: el registro es un mapa de
 * módulo que cualquier suite puede vaciar con `resetDeclarations()`, así que lo
 * honesto es afirmar sobre lo que ESTE programa declaró al construirse.
 */
const risks = new Map<string, ReturnType<typeof riskOf>>();

const LEAVES = ['asset create', 'depreciation run', 'depreciation post'];

beforeAll(() => {
  program = new Command('mnemosine');
  registerAssetCommand(program, deps);
  registerDepreciationCommand(program, deps);
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

function longs(path: string): (string | undefined)[] {
  return find(path).options.map((o) => o.long);
}

describe('the rulebook', () => {
  it('registers without declareRisk refusing anything', () => {
    expect(program.commands.map((c) => c.name()).sort()).toEqual(['asset', 'depreciation']);
  });

  it('passes the consistency audit with no violations', () => {
    expect(violations).toEqual([]);
  });

  it('ships exactly the three phase-1 leaves and no invented surface', () => {
    const hojas: string[] = [];
    const walk = (cmd: Command, prefix: string[]) => {
      const path = [...prefix, cmd.name()];
      if (cmd.commands.length === 0) hojas.push(path.join(' '));
      for (const child of cmd.commands) walk(child, path);
    };
    for (const child of program.commands) walk(child, []);
    expect(hojas.sort()).toEqual([...LEAVES].sort());
  });

  it('ends every leaf in a verb from the closed list', () => {
    for (const leaf of LEAVES) {
      expect(Object.keys(VERBS), leaf).toContain(leaf.split(' ').pop());
    }
  });

  it('keeps every leaf within the three-token depth limit', () => {
    for (const leaf of LEAVES) expect(leaf.split(' ').length, leaf).toBeLessThanOrEqual(3);
  });
});

describe('the bilingual surface', () => {
  const ALIASES: Record<string, string> = {
    asset: 'activo',
    'asset create': 'crear',
    depreciation: 'depreciacion',
    'depreciation run': 'ejecutar',
    'depreciation post': 'contabilizar',
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

  it('never claims a plural alias: the nouns are singular in both languages', () => {
    expect(find('asset').aliases()).not.toContain('activos');
    expect(find('depreciation').aliases()).not.toContain('depreciaciones');
  });
});

describe('safety declarations', () => {
  it('declares post irreversible: it posts to the immutable ledger', () => {
    expect(risks.get('depreciation post')?.risk).toBe('irreversible');
  });

  it('forbids the agent from posting, and never lets a flag decide that', () => {
    expect(risks.get('depreciation post')?.agentAllowed).toBe(false);
    // La propiedad que el catálogo declara de seguridad: toda fila
    // irreversible es IA ✗ SIN EXCEPCIÓN. Si alguien intentara conceder el
    // acceso, el binario no arrancaría.
    expect(() =>
      declareRisk(new Command('depreciation post'), { risk: 'irreversible', agent: true })
    ).toThrow(/permission must never depend on the value of a flag/);
  });

  it('lets the agent compute the run, because computing it writes nothing', () => {
    expect(risks.get('depreciation run')?.risk).toBe('lectura');
    expect(risks.get('depreciation run')?.agentAllowed).toBe(true);
  });

  it('keeps the agent out of the asset register: a master-data write is not a review queue', () => {
    // El catálogo marca `asset create` IA ✓, pero `fixed_assets` no es una
    // cola de revisión y el núcleo sólo admite escritura + agente con
    // `draftOnly`. Misma resolución que `customer create` e `invoice create`.
    expect(risks.get('asset create')?.risk).toBe('escritura');
    expect(risks.get('asset create')?.agentAllowed).toBe(false);
    expect(risks.get('asset create')?.draftOnly).toBe(false);
  });

  it('refuses to ship an agent-invocable asset create without draftOnly', () => {
    expect(() =>
      declareRisk(new Command('asset create'), { risk: 'escritura', agent: true })
    ).toThrow(/draftOnly/);
  });

  it('carries the three safety flags the irreversible class requires', () => {
    expect(longs('depreciation post')).toEqual(
      expect.arrayContaining(['--dry-run', '--yes', '--idempotency-key'])
    );
  });

  it('gives the read-only run none of them: nothing suggests it writes', () => {
    // `--dry-run` en una hoja que no escribe es una promesa vacía Y una
    // insinuación falsa: invita a creer que sin la bandera sí escribe.
    for (const bandera of ['--dry-run', '--yes', '--idempotency-key', '--force']) {
      expect(longs('depreciation run'), bandera).not.toContain(bandera);
    }
  });

  it('says what each mutating leaf writes, for the audit trail', () => {
    expect(risks.get('asset create')?.writes).toMatch(/fixed_assets/);
    expect(risks.get('asset create')?.writes).toMatch(/ninguna póliza/);
    expect(risks.get('depreciation post')?.writes).toMatch(/journal_entries/);
  });
});

describe('the flags the catalog names', () => {
  it('gives `asset create` the six the catalog lists', () => {
    expect(longs('asset create')).toEqual(
      expect.arrayContaining([
        '--category', '--cost', '--acquired', '--in-service', '--book', '--dry-run',
      ])
    );
  });

  it('gives `depreciation run` --period, --book, --by, --output and --format', () => {
    expect(longs('depreciation run')).toEqual(
      expect.arrayContaining(['--period', '--book', '--by', '--output', '--format'])
    );
  });

  it('gives `depreciation post` --period, --book and --file', () => {
    expect(longs('depreciation post')).toEqual(
      expect.arrayContaining(['--period', '--book', '--file'])
    );
  });

  it('reads --fields on every leaf, so the default table honours it too', () => {
    for (const leaf of LEAVES) expect(longs(leaf), leaf).toContain('--fields');
  });

  it('registers every new spelling in the single dictionary', () => {
    for (const flag of [
      '--book', '--by', '--method', '--tax-method', '--category', '--acquired',
      '--in-service', '--cost', '--salvage', '--life-years', '--life-months',
      '--asset-account', '--accum-account', '--expense-account', '--capitalized',
      '--source-entry', '--number', '--serial', '--location', '--description',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(FLAG_DICTIONARY, flag), flag).toBe(true);
      expect(FLAG_DICTIONARY[flag], flag).toBeNull();
    }
  });

  it('never claims -m for the asset model: that letter is the AI model', () => {
    // Por eso `--model` y `--manufacturer` no están en esta familia. Una
    // grafía con dos significados es lo que el diccionario existe para impedir.
    expect(longs('asset create')).not.toContain('--model');
    expect(FLAG_DICTIONARY['--model']).toBe('-m');
  });

  it('defaults --by to the per-asset detail', () => {
    expect(find('depreciation run').opts().by).toBe('asset');
  });

  it('offers --strict on the run so a warning can be tightened into a block', () => {
    expect(longs('depreciation run')).toContain('--strict');
  });
});

// ============================================================
// `--book` DECLARA, NO ELIGE
// ============================================================

describe('exigirLibroDelPanel', () => {
  const vigente = { libro: 'book' as const, base: 'vida_util_nif', definida: true };

  it('devuelve el libro del panel cuando la bandera no viene', () => {
    expect(exigirLibroDelPanel(undefined, vigente)).toBe('book');
  });

  it('acepta la bandera que coincide con el panel', () => {
    expect(exigirLibroDelPanel('book', vigente)).toBe('book');
  });

  it('rechaza la bandera que contradice al panel, en vez de obedecerla', () => {
    expect(() => exigirLibroDelPanel('tax', vigente)).toThrow(/contradice al panel/);
  });

  it('nombra la política que sí decide, para que la contradicción tenga salida', () => {
    expect(() => exigirLibroDelPanel('tax', vigente)).toThrow(/base_depreciacion/);
  });

  it('avisa cuando el libro vigente viene del defecto y no del despacho', () => {
    expect(() =>
      exigirLibroDelPanel('book', { libro: 'tax', base: 'tasa_lisr', definida: false })
    ).toThrow(/defecto declarado/);
  });

  it('rechaza un valor que no es ninguno de los dos libros', () => {
    expect(() => exigirLibroDelPanel('nif', vigente)).toThrow(/no existe/);
  });
});

// ============================================================
// EL PLAN APROBADO, DE VUELTA (`depreciation post --file`)
// ============================================================

const RENGLON = {
  asset_id: 'a1',
  asset_number: 'AF-2026-00001',
  asset_name: 'Servidor',
  categoria: 'Equipo de Cómputo',
  metodo: 'straight_line',
  indice: 0,
  periodos: 48,
  base_inicial: '100000.0000',
  depreciacion: '2083.3333',
  acumulada: '2083.3333',
  valor_en_libros: '97916.6667',
  cuenta_gasto: '6140',
  cuenta_gasto_id: 'c1',
  cuenta_acumulada: '1290',
  cuenta_acumulada_id: 'c2',
};

function planFalso(renglones: (typeof RENGLON)[]): PlanDeDepreciacion {
  return {
    entity_id: 'e1',
    fiscal_period_id: 'p1',
    periodo: 'Enero 2026',
    inicio: '2026-01-01',
    fin: '2026-01-31',
    fecha_del_asiento: '2026-01-31',
    base: 'vida_util_nif',
    base_definida: true,
    convencion: 'mes_completo',
    convencion_definida: true,
    tipo_calendario: 'book',
    renglones,
    omitidos: [],
    total: '2083.3333',
    pendientes: 0,
    faltante_al_cierre: { politica: 'avisar', definida: false },
    huella: 'abc',
  } as unknown as PlanDeDepreciacion;
}

describe('leerPlanAprobado', () => {
  it('lee el sobre versionado que escribe `run --format json`', () => {
    const archivo = JSON.stringify({ schema: 1, count: 1, rows: [RENGLON] });
    expect(leerPlanAprobado(archivo, 'plan.json')).toEqual([
      { asset_id: 'a1', asset_number: 'AF-2026-00001', depreciacion: '2083.3333' },
    ]);
  });

  it('lee también un arreglo pelado', () => {
    expect(leerPlanAprobado(JSON.stringify([RENGLON]), 'plan.json')).toHaveLength(1);
  });

  it('lee ndjson, un objeto por línea', () => {
    const ndjson = `${JSON.stringify(RENGLON)}\n${JSON.stringify({ ...RENGLON, asset_id: 'a2' })}\n`;
    expect(leerPlanAprobado(ndjson, 'plan.ndjson')).toHaveLength(2);
  });

  it('descarta los omitidos: no aprueban nada porque no postean', () => {
    const conOmitido = [RENGLON, { ...RENGLON, asset_id: 'a9', estado: 'omitido', depreciacion: '' }];
    const leidos = leerPlanAprobado(JSON.stringify(conOmitido), 'plan.json');
    expect(leidos.map((r) => r.asset_id)).toEqual(['a1']);
  });

  it('rechaza un archivo vacío en vez de aprobar la nada', () => {
    expect(() => leerPlanAprobado('   ', 'plan.json')).toThrow(/está vacío/);
  });

  it('rechaza un csv nombrando por qué, en vez de leer importes a ojo', () => {
    expect(() => leerPlanAprobado('asset_id,depreciacion\na1,2083.3333\n', 'plan.csv')).toThrow(
      /csv o tsv/
    );
  });

  it('rechaza un JSON que no trae un solo renglón con activo e importe', () => {
    expect(() => leerPlanAprobado(JSON.stringify({ rows: [{ hola: 1 }] }), 'plan.json')).toThrow(
      /no trae un solo renglón/
    );
  });
});

describe('diferenciasContraPlan', () => {
  it('no encuentra diferencias cuando el plan sigue igual', () => {
    const aprobado = [{ asset_id: 'a1', asset_number: 'AF-2026-00001', depreciacion: '2083.3333' }];
    expect(diferenciasContraPlan(aprobado, planFalso([RENGLON]))).toEqual([]);
  });

  it('compara el dinero con Decimal: 2083.3333 y 2083.33330 son el mismo importe', () => {
    // Comparar cadenas rechazaría planes idénticos releídos de disco, y el
    // operador acabaría pasando --file sólo cuando sabe que va a colar.
    const aprobado = [{ asset_id: 'a1', asset_number: 'AF-2026-00001', depreciacion: '2083.33330' }];
    expect(diferenciasContraPlan(aprobado, planFalso([RENGLON]))).toEqual([]);
  });

  it('acusa el importe que se movió, y dice de cuánto a cuánto', () => {
    const aprobado = [{ asset_id: 'a1', asset_number: 'AF-2026-00001', depreciacion: '2000.0000' }];
    const d = diferenciasContraPlan(aprobado, planFalso([RENGLON]));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatch(/el plan decía 2000.0000 y ahora sale 2083.3333/);
  });

  it('acusa el activo que estaba aprobado y ya no entra', () => {
    const aprobado = [
      { asset_id: 'a1', asset_number: 'AF-2026-00001', depreciacion: '2083.3333' },
      { asset_id: 'a2', asset_number: 'AF-2026-00002', depreciacion: '500.0000' },
    ];
    expect(diferenciasContraPlan(aprobado, planFalso([RENGLON]))).toEqual([
      'AF-2026-00002 estaba en el plan aprobado y ya no entra en la corrida',
    ]);
  });

  it('acusa el activo que apareció después de la aprobación', () => {
    const aprobado = [{ asset_id: 'a1', asset_number: 'AF-2026-00001', depreciacion: '2083.3333' }];
    const plan = planFalso([RENGLON, { ...RENGLON, asset_id: 'a3', asset_number: 'AF-2026-00003' }]);
    expect(diferenciasContraPlan(aprobado, plan)).toEqual([
      'AF-2026-00003 (2083.3333) no estaba en el plan aprobado',
    ]);
  });
});

// ============================================================
// LO QUE LA ORDEN ACEPTA ANTES DE GASTAR UNA CONEXIÓN
// ============================================================

describe('exigirFecha', () => {
  it('acepta una fecha real', () => {
    expect(exigirFecha('--acquired', '2026-03-20')).toBe('2026-03-20');
  });

  it('rechaza el 31 de febrero, que JavaScript acepta corriéndolo a marzo', () => {
    expect(() => exigirFecha('--acquired', '2026-02-31')).toThrow(/fecha real/);
  });

  it('rechaza otro formato en vez de adivinar el orden de día y mes', () => {
    expect(() => exigirFecha('--acquired', '20/03/2026')).toThrow(/YYYY-MM-DD/);
  });

  it('nombra la bandera que venía mal, no «la fecha»', () => {
    expect(() => exigirFecha('--in-service', 'ayer')).toThrow(/--in-service/);
  });
});

describe('exigirImporte', () => {
  it('devuelve el dinero como CADENA con los cuatro decimales de la columna', () => {
    expect(exigirImporte('--cost', '100000')).toBe('100000.0000');
  });

  it('conserva los cuatro decimales que DECIMAL(19,4) guarda', () => {
    expect(exigirImporte('--cost', '2083.3333')).toBe('2083.3333');
  });

  it('no pierde precisión en un importe que un flotante redondearía', () => {
    // 19 dígitos significativos: `Number` los estropea y la columna no.
    expect(exigirImporte('--cost', '123456789012.3456')).toBe('123456789012.3456');
  });

  it('ignora las comas de miles, que es como se teclea un MOI', () => {
    expect(exigirImporte('--cost', '1,250,000.50')).toBe('1250000.5000');
  });

  it('rechaza un importe negativo: el CHECK del esquema exige costo mayor que cero', () => {
    expect(() => exigirImporte('--cost', '-100')).toThrow(/importe decimal sin signo/);
  });

  it('rechaza lo que no es un número, en vez de dejarlo llegar a Postgres', () => {
    expect(() => exigirImporte('--cost', 'cien mil')).toThrow(/--cost/);
  });
});

describe('exigirMetodo', () => {
  it('acepta los seis del CHECK que la 056 fijó', () => {
    for (const m of [
      'straight_line', 'declining_balance_150', 'declining_balance_200',
      'sum_of_years_digits', 'units_of_production', 'macrs',
    ]) {
      expect(exigirMetodo('--method', m)).toBe(m);
    }
  });

  it('rechaza un método inventado nombrando los seis que existen', () => {
    expect(() => exigirMetodo('--method', 'lineal')).toThrow(/straight_line/);
  });
});

describe('exigirContabilizacion', () => {
  it('lee «yes» como que el costo YA está cargado a la cuenta de activo', () => {
    expect(exigirContabilizacion('yes')).toBe('ya_contabilizado');
  });

  it('lee «no» como que el asiento está pendiente', () => {
    expect(exigirContabilizacion('no')).toBe('sin_contabilizar');
  });

  it('acepta el sí en español, que es el idioma en que se teclea', () => {
    expect(exigirContabilizacion('sí')).toBe('ya_contabilizado');
  });

  it('rechaza cualquier otra cosa: suponerlo duplica el activo o lo deja fuera del mayor', () => {
    expect(() => exigirContabilizacion('quizá')).toThrow(/No tiene valor por omisión/);
  });
});

describe('exigirDimension', () => {
  it('acepta las cuatro dimensiones del resumen', () => {
    for (const d of ['asset', 'class', 'account', 'method']) {
      expect(exigirDimension(d)).toBe(d);
    }
  });

  it('rechaza una dimensión que no existe nombrando las que sí', () => {
    expect(() => exigirDimension('cost-center')).toThrow(/asset, class, account, method/);
  });
});

// ============================================================
// LA SALIDA: QUÉ ENTRÓ, CON QUÉ CRITERIO, Y QUÉ SE SALTÓ Y POR QUÉ
// ============================================================

const OMITIDO = {
  asset_id: 'a9',
  asset_number: 'AF-2026-00009',
  asset_name: 'Torno',
  categoria: 'Maquinaria y Equipo',
  motivo: 'unidades_de_produccion' as const,
  detalle: 'se deprecia por unidades y la corrida mensual no tiene producción',
  pendiente: true,
};

describe('filasPorActivo', () => {
  it('trae una fila por activo, entre o no', () => {
    const plan = { ...planFalso([RENGLON]), omitidos: [OMITIDO] } as PlanDeDepreciacion;
    expect(filasPorActivo(plan)).toHaveLength(2);
  });

  it('marca cada fila con su estado, para que ningún formato pierda los omitidos', () => {
    // Mandarlos sólo a stderr los borraría de `--json`, y «qué se saltó y por
    // qué» es la mitad del valor de una corrida.
    const plan = { ...planFalso([RENGLON]), omitidos: [OMITIDO] } as PlanDeDepreciacion;
    expect(filasPorActivo(plan).map((f) => f.estado)).toEqual(['entra', 'omitido']);
  });

  it('dice POR QUÉ se saltó cada uno, con su motivo del vocabulario cerrado', () => {
    const plan = { ...planFalso([RENGLON]), omitidos: [OMITIDO] } as PlanDeDepreciacion;
    expect(filasPorActivo(plan)[1].motivo).toBe('unidades_de_produccion');
  });

  it('deja el dinero de un omitido en blanco en vez de fingir un cero', () => {
    // Un cero es un importe calculado; el omitido no tiene ninguno.
    const plan = { ...planFalso([RENGLON]), omitidos: [OMITIDO] } as PlanDeDepreciacion;
    expect(filasPorActivo(plan)[1].depreciacion).toBe('');
  });

  it('lleva asset_id, que es lo que `post --file` vuelve a leer', () => {
    expect(filasPorActivo(planFalso([RENGLON]))[0].asset_id).toBe('a1');
  });

  it('mantiene el dinero como cadena, nunca como número', () => {
    const fila = filasPorActivo(planFalso([RENGLON]))[0];
    expect(typeof fila.depreciacion).toBe('string');
    expect(fila.depreciacion).toBe('2083.3333');
  });
});

describe('filasAgrupadas', () => {
  const dos = [RENGLON, { ...RENGLON, asset_id: 'a2', asset_number: 'AF-2026-00002' }];

  it('suma por clase con Decimal, sin pasar por un flotante', () => {
    const filas = filasAgrupadas(planFalso(dos), 'class');
    expect(filas).toEqual([
      { grupo: 'Equipo de Cómputo', activos: 2, depreciacion: '4166.6666', omitidos: 0 },
    ]);
  });

  it('agrupa por cuenta de destino, que es el «resumen por destino» del catálogo', () => {
    expect(filasAgrupadas(planFalso(dos), 'account')[0].grupo).toBe('6140');
  });

  it('agrupa por método', () => {
    expect(filasAgrupadas(planFalso(dos), 'method')[0].grupo).toBe('straight_line');
  });

  it('cuenta los omitidos dentro de su clase, con su grupo aunque no aporte importe', () => {
    const plan = { ...planFalso([RENGLON]), omitidos: [OMITIDO] } as PlanDeDepreciacion;
    const filas = filasAgrupadas(plan, 'class');
    expect(filas).toContainEqual({
      grupo: 'Maquinaria y Equipo', activos: 0, depreciacion: '0.0000', omitidos: 1,
    });
  });

  it('no inventa un grupo para los omitidos cuando se agrupa por cuenta o método', () => {
    // Un omitido no tiene método elegido ni cuenta resuelta: meterlo bajo un
    // guion lo mezclaría en un grupo que no existe.
    const plan = { ...planFalso([RENGLON]), omitidos: [OMITIDO] } as PlanDeDepreciacion;
    expect(filasAgrupadas(plan, 'account')).toHaveLength(1);
  });
});

describe('filasDelAsiento', () => {
  const dos = [RENGLON, { ...RENGLON, asset_id: 'a2', asset_number: 'AF-2026-00002' }];

  it('enseña dos líneas por activo: cargo al gasto y abono a la acumulada', () => {
    expect(filasDelAsiento(planFalso(dos))).toHaveLength(4);
  });

  it('numera N pólizas y no una, porque el motor crea una por activo', () => {
    // La diferencia importa el día que alguien quiera reversar la corrida:
    // son N reversas, no una.
    expect(filasDelAsiento(planFalso(dos)).map((f) => f.asiento)).toEqual([
      '1/2', '1/2', '2/2', '2/2',
    ]);
  });

  it('carga el gasto y abona la acumulada por el mismo importe', () => {
    const [cargo, abono] = filasDelAsiento(planFalso([RENGLON]));
    expect(cargo).toMatchObject({ cuenta: '6140', debe: '2083.3333', haber: '' });
    expect(abono).toMatchObject({ cuenta: '1290', debe: '', haber: '2083.3333' });
  });

  it('fecha el asiento el último día del periodo que se corre, no el del calendario', () => {
    // Era el defecto B: `createJournalEntry` deduce el periodo fiscal DE LA
    // FECHA, así que una fecha del mes anterior colgaba el asiento de otro
    // periodo que el de la fila.
    for (const f of filasDelAsiento(planFalso([RENGLON]))) expect(f.fecha).toBe('2026-01-31');
  });

  it('no produce ninguna línea cuando no hay nada que postear', () => {
    expect(filasDelAsiento(planFalso([]))).toEqual([]);
  });
});
