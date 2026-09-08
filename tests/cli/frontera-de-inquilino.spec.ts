import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { withContext } from '../../src/cli/kernel/flags.js';
import { program, inquilinoPedido, fijarInquilinoDeLaOrden } from '../../src/cli/mnemosine.js';
import { olvidarInquilinoDeLaSesion } from '../../src/ai/context.js';
import { ExitCode, type CliError } from '../../src/cli/kernel/index.js';

// ============================================================
// LA FRONTERA POR LA QUE SE TECLEA TODO LO DEMÁS
//
// Medido sobre el binario embarcado (b31e62a), con tres entidades en el
// inquilino del .env y cuatro inquilinos en la base:
//
//   mnemosine account list --entity <Demo Corp> --tenant <AP scratch>
//       → 50 cuentas … del OTRO despacho, código 0, sin un aviso
//   mnemosine entity list --tenant 00000000-…      → 3 filas del .env
//   mnemosine -T 00000000-… entity list            → 3 filas del .env
//   mnemosine entity list -t 00000000-…            → 0 filas   ← la corta sí
//
// EL MECANISMO, y por qué la forma corta se salvaba: la raíz declara
// `-T, --tenant` y su `parseOptions` recorre la línea ENTERA antes de
// despachar, así que `_findOption('--tenant')` acierta en la raíz y se queda
// el valor esté donde esté escrito. `-t` no lo reconoce (el corto de la raíz
// es `-T`, y la comparación distingue mayúsculas), así que viaja como
// desconocido y lo reclama la hoja.
//
// Estas pruebas clavan las dos mitades: dónde deja commander cada grafía, y
// que el programa las recoja LAS DOS. Leer sólo `thisCommand.opts()` —lo que
// hacía el gancho— pierde la corta; leer sólo `opts.tenant` en la hoja —lo
// que hacen las 81 llamadas a bootstrapTenant— pierde la larga.
// ============================================================

/** Un programa con la MISMA forma que el real: raíz `-T`, hoja `withContext`. */
function programaComoElReal(): { raiz: Command; hoja: Command } {
  const raiz = new Command();
  raiz.name('mnemosine').option('-T, --tenant <uuid>', 'tenant');
  const familia = raiz.command('entity');
  const hoja = familia.command('list');
  withContext(hoja);
  hoja.action(() => undefined);
  return { raiz, hoja };
}

describe('dónde deja commander cada grafía de --tenant', () => {
  it('la forma LARGA se la queda la raíz, aunque se teclee tras la hoja', () => {
    const { raiz, hoja } = programaComoElReal();
    raiz.parse(['node', 'mnemosine', 'entity', 'list', '--tenant', 'LARGA']);
    expect(hoja.opts().tenant).toBeUndefined();
    expect(raiz.opts().tenant).toBe('LARGA');
  });

  it('la forma CORTA se la queda la hoja', () => {
    const { raiz, hoja } = programaComoElReal();
    raiz.parse(['node', 'mnemosine', 'entity', 'list', '-t', 'CORTA']);
    expect(hoja.opts().tenant).toBe('CORTA');
    expect(raiz.opts().tenant).toBeUndefined();
  });

  it('la `-T` de la raíz también, por supuesto', () => {
    const { raiz, hoja } = programaComoElReal();
    raiz.parse(['node', 'mnemosine', '-T', 'RAIZ', 'entity', 'list']);
    expect(hoja.opts().tenant).toBeUndefined();
    expect(raiz.opts().tenant).toBe('RAIZ');
  });
});

describe('el programa recoge las tres grafías', () => {
  const casos: [string, string[], string][] = [
    ['--tenant tras la hoja', ['node', 'mnemosine', 'entity', 'list', '--tenant', 'X'], 'X'],
    ['-t tras la hoja', ['node', 'mnemosine', 'entity', 'list', '-t', 'X'], 'X'],
    ['-T en la raíz', ['node', 'mnemosine', '-T', 'X', 'entity', 'list'], 'X'],
    ['--tenant en la raíz', ['node', 'mnemosine', '--tenant', 'X', 'entity', 'list'], 'X'],
  ];
  for (const [nombre, argv, esperado] of casos) {
    it(nombre, () => {
      const { raiz, hoja } = programaComoElReal();
      raiz.parse(argv);
      expect(inquilinoPedido(hoja)).toBe(esperado);
    });
  }

  it('sin bandera no inventa un inquilino', () => {
    const { raiz, hoja } = programaComoElReal();
    raiz.parse(['node', 'mnemosine', 'entity', 'list']);
    expect(inquilinoPedido(hoja)).toBeUndefined();
  });
});

describe('el binario real tiene esa forma, que es lo que hace aplicable lo de arriba', () => {
  const opcionesDe = (cmd: Command): { long?: string; short?: string }[] =>
    cmd.options as unknown as { long?: string; short?: string }[];

  const buscar = (ruta: string): Command => {
    let nodo: Command = program;
    for (const token of ruta.split(' ')) {
      const hijo = (nodo.commands as Command[]).find((c) => c.name() === token);
      if (!hijo) throw new Error(`no existe la hoja ${ruta}`);
      nodo = hijo;
    }
    return nodo;
  };

  it('la raíz declara --tenant con la corta -T', () => {
    const t = opcionesDe(program).find((o) => o.long === '--tenant');
    expect(t).toBeDefined();
    expect(t?.short).toBe('-T');
  });

  it('las hojas declaran --tenant con la corta -t, y son casi todas', () => {
    const hojas: Command[] = [];
    const andar = (cmd: Command): void => {
      const hijos = cmd.commands as Command[];
      if (hijos.length === 0) { hojas.push(cmd); return; }
      for (const h of hijos) andar(h);
    };
    for (const h of program.commands as Command[]) andar(h);

    const conTenant = hojas.filter((h) => opcionesDe(h).some((o) => o.long === '--tenant'));
    // El número exacto envejece con el árbol; lo que no puede envejecer es que
    // la mayoría de la superficie declare la bandera y que TODAS usen `-t`.
    expect(conTenant.length).toBeGreaterThanOrEqual(199);
    for (const h of conTenant) {
      expect(opcionesDe(h).find((o) => o.long === '--tenant')?.short).toBe('-t');
    }
  });

  it('`entity list` es una de ellas: es la hoja con la que se midió el defecto', () => {
    expect(opcionesDe(buscar('entity list')).some((o) => o.long === '--tenant')).toBe(true);
  });
});


// ============================================================
// LA PRECEDENCIA PUBLICADA, EJERCIDA POR EL CAMINO REAL
// docs/cli-command-catalog.md §3.1: bandera > MNEMOSINE_TENANT > config.
// Hasta este tramo estaba INVERTIDA justo en la bandera que gobierna el RLS.
// ============================================================
describe('fijarInquilinoDeLaOrden: la precedencia y el silencio', () => {
  const UNO = '11111111-1111-4111-8111-111111111111';
  const DOS = '22222222-2222-4222-8222-222222222222';
  let entornoPrevio: string | undefined;

  const ordenar = (argv: string[]): Command => {
    const { raiz, hoja } = programaComoElReal();
    raiz.parse(argv);
    return hoja;
  };

  beforeEach(() => {
    entornoPrevio = process.env.MNEMOSINE_TENANT;
    olvidarInquilinoDeLaSesion();
  });
  afterEach(() => {
    if (entornoPrevio === undefined) delete process.env.MNEMOSINE_TENANT;
    else process.env.MNEMOSINE_TENANT = entornoPrevio;
    olvidarInquilinoDeLaSesion();
  });

  it('la bandera larga gana al entorno (el defecto medido, al revés)', () => {
    process.env.MNEMOSINE_TENANT = DOS;
    const r = fijarInquilinoDeLaOrden(ordenar(['node', 'mnemosine', 'entity', 'list', '--tenant', UNO]));
    expect(r).toMatchObject({ tenantId: UNO, origen: 'bandera', entornoIgnorado: DOS });
  });

  it('la bandera corta también', () => {
    process.env.MNEMOSINE_TENANT = DOS;
    const r = fijarInquilinoDeLaOrden(ordenar(['node', 'mnemosine', 'entity', 'list', '-t', UNO]));
    expect(r).toMatchObject({ tenantId: UNO, origen: 'bandera' });
  });

  it('la de la raíz también', () => {
    process.env.MNEMOSINE_TENANT = DOS;
    const r = fijarInquilinoDeLaOrden(ordenar(['node', 'mnemosine', '-T', UNO, 'entity', 'list']));
    expect(r).toMatchObject({ tenantId: UNO, origen: 'bandera' });
  });

  it('sin bandera manda el entorno, y se dice que es el entorno', () => {
    process.env.MNEMOSINE_TENANT = DOS;
    const r = fijarInquilinoDeLaOrden(ordenar(['node', 'mnemosine', 'entity', 'list']));
    expect(r).toMatchObject({ tenantId: DOS, origen: 'entorno' });
    expect(r.entornoIgnorado).toBeUndefined();
  });

  it('un inquilino que no es un UUID se rechaza con USAGE, no con un informe vacío', () => {
    process.env.MNEMOSINE_TENANT = DOS;
    let error: CliError | undefined;
    try {
      fijarInquilinoDeLaOrden(ordenar(['node', 'mnemosine', 'entity', 'list', '--tenant', 'basura']));
    } catch (err) {
      error = err as CliError;
    }
    expect(error?.exitCode).toBe(ExitCode.USAGE);
    expect(error?.message).toMatch(/--tenant carries "basura"/);
  });
});
