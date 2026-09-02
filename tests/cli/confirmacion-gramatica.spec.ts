import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  esAfirmativa,
  esNegativa,
  confirmarConReintento,
  noEntendi,
} from '../../src/cli/kernel/confirmacion.js';
import { confirmarCierre } from '../../src/cli/close-command.js';

// ============================================================
// La gramática del «sí» y su guardián.
//
// Hubo nueve predicados de confirmación distintos detrás del mismo
// prompt [y/N]; el peor (/^y|^s/i, en el cierre de periodo) tomaba
// «salir» —el alias en español de logout— como consentimiento para
// cerrar el periodo. Este spec fija tres cosas:
//   1. La tabla de verdad del kernel (qué es sí, qué es no).
//   2. La doble compuerta del cierre duro (sí + nombre del periodo).
//   3. El CENSO: ningún archivo de src/cli/ puede volver a escribir
//      su propio predicado de confirmación. Es el guardián de la
//      CLASE de bug, no del caso que ya se arregló.
// ============================================================

describe('esAfirmativa: la tabla de verdad', () => {
  const aceptan = ['y', 'Y', 'yes', 'YES', 'Yes', 's', 'S', 'si', 'Si', 'SI', 'sí', 'SÍ', '  si  '];
  for (const r of aceptan) {
    it(`acepta «${r}»`, () => {
      expect(esAfirmativa(r)).toBe(true);
    });
  }

  // «salir», «stop», «sale» y «seguro que no» son exactamente las
  // respuestas que el viejo /^y|^s/i del cierre tomaba como sí.
  const rechazan = ['n', 'no', 'NO', 'salir', 'stop', 'sale', 'seguro que no', 'yep', 'ses', '', '   '];
  for (const r of rechazan) {
    it(`rechaza «${r}»`, () => {
      expect(esAfirmativa(r)).toBe(false);
    });
  }

  it('rechaza EOF (null) y undefined: una stdin cerrada nunca consiente', () => {
    expect(esAfirmativa(null)).toBe(false);
    expect(esAfirmativa(undefined)).toBe(false);
  });
});

describe('esNegativa: el no explícito y el default del [y/N]', () => {
  for (const r of ['n', 'N', 'no', 'NO', '', '   ']) {
    it(`«${r}» es un no`, () => {
      expect(esNegativa(r)).toBe(true);
    });
  }
  it('EOF (null) es un no', () => {
    expect(esNegativa(null)).toBe(true);
  });
  it('«salir» no es un no reconocido (ni un sí): es incomprendida', () => {
    expect(esNegativa('salir')).toBe(false);
    expect(esAfirmativa('salir')).toBe(false);
  });
});

describe('confirmarConReintento: una repregunta que enseña las teclas', () => {
  const guion = (respuestas: Array<string | null>) => {
    const prompts: string[] = [];
    let i = 0;
    const preguntar = async (p: string): Promise<string | null> => {
      prompts.push(p);
      return respuestas[i++] ?? null;
    };
    return { prompts, preguntar };
  };

  it('un sí a la primera no repregunta', async () => {
    const g = guion(['sí']);
    expect(await confirmarConReintento(g.preguntar, 'Q [y/N] ')).toEqual({ si: true });
    expect(g.prompts).toHaveLength(1);
  });

  it('un no explícito (o vacío) no repregunta', async () => {
    const g1 = guion(['no']);
    expect((await confirmarConReintento(g1.preguntar, 'Q [y/N] ')).si).toBe(false);
    expect(g1.prompts).toHaveLength(1);
    const g2 = guion(['']);
    expect((await confirmarConReintento(g2.preguntar, 'Q [y/N] ')).si).toBe(false);
    expect(g2.prompts).toHaveLength(1);
  });

  it('«salir» repregunta UNA vez nombrando lo que no entendió', async () => {
    const g = guion(['salir', 's']);
    const v = await confirmarConReintento(g.preguntar, 'Q [y/N] ');
    expect(v.si).toBe(true);
    expect(g.prompts).toHaveLength(2);
    expect(g.prompts[1]).toContain(noEntendi('salir'));
    expect(g.prompts[1]).toContain('«salir»');
  });

  it('dos respuestas incomprendidas rinden un no que dice cuál fue la última', async () => {
    const g = guion(['salir', 'stop']);
    const v = await confirmarConReintento(g.preguntar, 'Q [y/N] ');
    expect(v).toEqual({ si: false, incomprendida: 'stop' });
    expect(g.prompts).toHaveLength(2);
  });

  it('tras la repregunta, un no explícito es un no limpio (sin incomprendida)', async () => {
    const g = guion(['sale', 'n']);
    const v = await confirmarConReintento(g.preguntar, 'Q [y/N] ');
    expect(v).toEqual({ si: false });
  });
});

describe('confirmarCierre: la doble compuerta del cierre', () => {
  const plain = {
    dim: (s: string) => s,
    bold: (s: string) => s,
    cyan: (s: string) => s,
    red: (s: string) => s,
  };
  const guion = (respuestas: Array<string | null>) => {
    const prompts: string[] = [];
    let i = 0;
    const preguntar = async (p: string): Promise<string | null> => {
      prompts.push(p);
      return respuestas[i++] ?? null;
    };
    return { prompts, preguntar };
  };

  it('«salir» ya NO cierra el periodo: cancela y explica qué no entendió', async () => {
    const g = guion(['salir', 'salir']);
    const v = await confirmarCierre(g.preguntar, plain, 'soft close (reversible)', {
      hard: false,
      periodName: 'July 2026',
    });
    expect(v.procede).toBe(false);
    expect(v.mensaje).toContain('«salir»');
    expect(v.mensaje).toContain('Cancelled.');
  });

  it('un sí en español basta para el cierre suave', async () => {
    const g = guion(['sí']);
    const v = await confirmarCierre(g.preguntar, plain, 'soft close (reversible)', {
      hard: false,
      periodName: 'July 2026',
    });
    expect(v).toEqual({ procede: true });
    expect(g.prompts).toHaveLength(1);
  });

  it('el cierre duro exige además teclear el nombre del periodo', async () => {
    const g = guion(['y', 'July 2026']);
    const v = await confirmarCierre(g.preguntar, plain, 'HARD close (irreversible)', {
      hard: true,
      periodName: 'July 2026',
    });
    expect(v).toEqual({ procede: true });
    expect(g.prompts).toHaveLength(2);
    expect(g.prompts[1]).toContain('July 2026');
  });

  it('el nombre equivocado cancela el cierre duro aunque hubo un sí', async () => {
    const g = guion(['y', 'August 2026']);
    const v = await confirmarCierre(g.preguntar, plain, 'HARD close (irreversible)', {
      hard: true,
      periodName: 'July 2026',
    });
    expect(v.procede).toBe(false);
    expect(v.mensaje).toContain('July 2026');
    expect(v.mensaje).toContain('nothing was closed');
  });

  it('EOF en el nombre cancela el cierre duro', async () => {
    const g = guion(['y', null]);
    const v = await confirmarCierre(g.preguntar, plain, 'HARD close (irreversible)', {
      hard: true,
      periodName: 'July 2026',
    });
    expect(v.procede).toBe(false);
  });

  it('el cierre suave no pide el nombre: una sola pregunta', async () => {
    const g = guion(['s']);
    await confirmarCierre(g.preguntar, plain, 'soft close (reversible)', {
      hard: false,
      periodName: 'July 2026',
    });
    expect(g.prompts).toHaveLength(1);
  });
});

describe('censo: ningún predicado de confirmación fuera del kernel', () => {
  const CLI_DIR = path.join(process.cwd(), 'src/cli');
  const KERNEL = path.join(CLI_DIR, 'kernel', 'confirmacion.ts');

  const listarTs = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listarTs(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  };

  // Las formas viejas, censadas antes de armonizar. Si una reaparece
  // en un comando nuevo, este censo la acusa aunque nadie la pruebe.
  const PATRONES: Array<{ nombre: string; regex: RegExp }> = [
    { nombre: 'alternancia sin anclar: /^y|…/ (la que cerraba con «salir»)', regex: /\/\^y\|/ },
    { nombre: 'anclada pero solo en inglés: /^y(es)?$/', regex: /\/\^y\(es\)\?\$/ },
    { nombre: "comparación directa answer === 'y'", regex: /answer\s*[!=]==\s*'y'/ },
    { nombre: "comparación directa answer === 'yes'", regex: /answer\s*[!=]==\s*'yes'/ },
    {
      nombre: 'gramática completa reescrita inline (debe llamar al kernel)',
      regex: /\^\(y\|yes\|s\|si\|sí?\)/,
    },
  ];

  /**
   * EL CENSO MIRA CÓDIGO, NO PROSA.
   *
   * Leía la línea cruda, así que un COMENTARIO que citara el predicado viejo
   * —para explicar qué se arregló y por qué— se acusaba a sí mismo. El efecto
   * perverso: documentar el defecto quedaba prohibido, y la salida honesta era
   * borrar la explicación. Se vio al migrar las compuertas de F06 al kernel.
   *
   * Es la misma lección que el arnés de mutación aprendió al revés: allí
   * `codigoDe` despoja los comentarios (src/plan/criterios.ts:167) porque un
   * mutante plantado en prosa no cambia la conducta. Aquí, un predicado
   * escrito en prosa tampoco confirma nada.
   *
   * Se salta la línea de comentario ENTERA en vez de despojar el archivo,
   * porque el reporte dice «archivo:línea» y despojar descuadraría la cuenta.
   * Una línea con código Y comentario al final NO se salta: su código sigue
   * censado, que es lo que importa.
   */
  const esLineaDeComentario = (linea: string): boolean => {
    const t = linea.trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
  };

  it('src/cli/**/*.ts sólo confirma a través del kernel', () => {
    const acusaciones: string[] = [];
    for (const file of listarTs(CLI_DIR)) {
      if (path.resolve(file) === path.resolve(KERNEL)) continue;
      const lineas = fs.readFileSync(file, 'utf8').split('\n');
      lineas.forEach((linea, i) => {
        if (esLineaDeComentario(linea)) return;
        for (const { nombre, regex } of PATRONES) {
          if (regex.test(linea)) {
            acusaciones.push(`${path.relative(CLI_DIR, file)}:${i + 1} — ${nombre}`);
          }
        }
      });
    }
    expect(acusaciones).toEqual([]);
  });

  it('despojar la prosa no ciega al censo: el mismo texto acusa en código y calla en comentario', () => {
    // La verificación en las DOS direcciones que la casa exige. Sin la primera
    // mitad, «saltar comentarios» podría convertirse en «saltarlo todo» y
    // nadie lo notaría hasta que un predicado real pasara de largo.
    const predicado = "      return /^y(es)?$/i.test((answer ?? '').trim());";
    expect(esLineaDeComentario(predicado)).toBe(false);
    expect(PATRONES.some(({ regex }) => regex.test(predicado))).toBe(true);

    for (const prosa of [
      '      // nació con /^y(es)?$/ —sólo inglés— en un producto mexicano',
      '   * el predicado era /^y|^s/i, una alternancia sin anclar',
    ]) {
      expect(esLineaDeComentario(prosa), `debería leerse como prosa: ${prosa}`).toBe(true);
    }
  });

  it('el censo se vigila a sí mismo: reconoce las formas viejas', () => {
    // Si alguien "arregla" los patrones hasta dejarlos ciegos, esta
    // muestra de código real de antes de la armonización lo delata.
    const muestras = [
      "if (!answer || !/^y|^s/i.test(answer.trim())) {",
      "return /^y(es)?$/i.test((answer ?? '').trim());",
      "if (answer !== 'y' && answer !== 'yes') throw abortedByUser();",
      "if (!raw || !/^(y|yes|s|si|sí)$/i.test(raw.trim())) {",
    ];
    for (const muestra of muestras) {
      expect(
        PATRONES.some(({ regex }) => regex.test(muestra)),
        `ningún patrón del censo reconoce: ${muestra}`
      ).toBe(true);
    }
  });
});
