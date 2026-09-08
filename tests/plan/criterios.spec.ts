import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CRITERIOS,
  consumidoresDe,
  dondeAparece,
  fuentes,
  sinComentarios,
} from '../../src/plan/criterios.js';

// ============================================================
// EL INSTRUMENTO DE MEDIDA, MEDIDO.
//
// Cada prueba de este archivo nació de un error que el propio comando cometió
// contra este repositorio en su primera corrida. No son hipótesis.
// ============================================================

describe('sinComentarios — la prosa no es conducta', () => {
  it('quita el comentario de línea que cita una clave', () => {
    const codigo = sinComentarios("// la política 'umbral_capitalizacion_mxn' (ver pending)\nconst x = 1;");
    expect(codigo).not.toContain('umbral_capitalizacion_mxn');
    expect(codigo).toContain('const x = 1;');
  });

  it('quita el comentario de bloque que narra el código ya borrado', () => {
    const codigo = sinComentarios("/* antes esto era un UPDATE a status = 'balanced' */\nreturn refuse();");
    expect(codigo).not.toContain('balanced');
    expect(codigo).toContain('refuse()');
  });

  it('deja intacto lo que sí ejecuta', () => {
    expect(sinComentarios("const s = 'a'; // nota\nconst t = 'b';")).toContain("const t = 'b';");
  });
});

describe('fuentes — el instrumento no se mide a sí mismo', () => {
  it('excluye src/plan, que contiene los patrones que persigue', () => {
    const relativos = fuentes('src').map((f) => path.relative(process.cwd(), f));
    expect(relativos.some((f) => f.startsWith(path.join('src', 'plan')))).toBe(false);
  });

  it('sí recorre el resto de src', () => {
    expect(fuentes('src').length).toBeGreaterThan(100);
  });

  it('el patrón de TODO externo ya no encuentra su propia definición', () => {
    // Fue el estreno del comando: el criterio que busca «TODO junto a un acto
    // externo» halló el literal de su propia expresión regular.
    expect(dondeAparece(/TODO:[^\n]*(PAC|SAT|IRS|SSA|enviar|send)/i)).not.toContain(
      path.join('src', 'plan', 'criterios.ts')
    );
  });
});

describe('consumidoresDe — una mención en un comentario no es un llamador', () => {
  it('no cuenta como consumidor un archivo que sólo lo nombra en prosa', () => {
    // getPolicy aparece citado en comentarios de su propio módulo; ninguno
    // de esos archivos debe aparecer como consumidor externo.
    expect(consumidoresDe('getPolicy', 'policy-service.ts')).not.toContain(
      path.join('src', 'services', 'xml-ingestion', 'cfdi-decisions.ts')
    );
  });

  it('distingue getPolicy de getPolicySpec por límite de palabra', () => {
    // s4-policies.ts llama getPolicySpec, no getPolicy: contarlo daría un
    // verde falso sobre un catálogo que nadie lee.
    expect(consumidoresDe('getPolicy', 'policy-service.ts')).not.toContain(
      path.join('src', 'cli', 'init', 's4-policies.ts')
    );
  });
});

describe('la lista de criterios', () => {
  it('cada criterio declara paquete y enunciado', () => {
    for (const c of CRITERIOS) {
      expect(c.paquete, JSON.stringify(c.enunciado)).toMatch(/^E\d+\.\d+$/);
      expect(c.enunciado.length).toBeGreaterThan(10);
    }
  });

  it('ningún enunciado se limita a nombrar un archivo o un símbolo', () => {
    // La regla que abre criterios.ts: un criterio afirma COMPORTAMIENTO. El
    // cerrojo antisimulación pasó en sustancia y falló el 100% de sus
    // criterios escritos porque estaban redactados contra identificadores.
    for (const c of CRITERIOS) {
      expect(c.enunciado, c.enunciado).not.toMatch(/^(existe|hay un archivo|se define)\b/i);
      expect(c.enunciado.split(/\s+/).length).toBeGreaterThanOrEqual(5);
    }
  });

  // 30 s y no los 5 por omisión: esta prueba EJECUTA los criterios de los quince
  // paquetes, y hoy entre ellos hay uno que lanza `git check-ignore` como
  // subproceso y otro que abre un socket a Postgres. Con la suite entera en
  // paralelo eso pasa de cinco segundos y el fallo aparece como un timeout que
  // nadie reproduce a mano — se vio una vez, en verde las dos siguientes.
  it('todo resultado trae un detalle con el que se puede actuar', { timeout: 30_000 }, async () => {
    for (const c of CRITERIOS) {
      const r = await c.evaluar();
      expect(r.detalle, c.enunciado).toBeTruthy();
      expect(r.detalle.length, c.enunciado).toBeGreaterThan(10);
    }
  });
});

// ============================================================
// LA IDENTIDAD DE UN INSTRUMENTO (I0)
//
// El piso —docs/criterios-minimos.json— es un trinquete que sólo sube, y su
// llave es la identidad del criterio. Hasta I0 esa llave era el ENUNCIADO EN
// ESPAÑOL: reescribir la frase daba de baja un criterio y daba de alta otro
// sin que nadie hubiera tocado un instrumento, y traducirla —que es lo que el
// epic #141 va a hacer con todo el código— lo haría 136 veces de golpe.
//
// Con ids, la identidad deja de depender de la redacción. Estas tres pruebas
// son lo que hace que eso sea cierto y no una intención.
// ============================================================

describe('los criterios tienen identidad, y no es su prosa', () => {
  it('ningún id se repite: dos criterios con la misma llave son uno solo en el piso', () => {
    const conId = CRITERIOS.filter((c) => c.id !== undefined);
    const vistos = new Map<string, string>();
    const choques: string[] = [];
    for (const c of conId) {
      const previo = vistos.get(c.id!);
      // Un id duplicado no rompe nada visible: el piso protege UNA de las dos
      // y la otra viaja sin red, que es la peor forma de perder un criterio.
      if (previo !== undefined) choques.push(`${c.id}: «${previo}» y «${c.enunciado}»`);
      else vistos.set(c.id!, c.enunciado);
    }
    expect(choques, 'dos criterios comparten id').toEqual([]);
  });

  it('el id es un identificador de máquina: inglés, kebab-case, sin acentos', () => {
    const malos = CRITERIOS.filter((c) => c.id !== undefined).filter(
      (c) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id!)
    );
    expect(
      malos.map((c) => c.id),
      'un id con mayúsculas, acentos o espacios es prosa con otro nombre'
    ).toEqual([]);
  });

  it('el piso se apoya en ids vivos, no en frases', () => {
    // Lee el piso REAL, que es el que la CI comprueba.
    const piso = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'criterios-minimos.json'), 'utf8')
    ) as { verdes: string[] };
    const ids = new Set(CRITERIOS.map((c) => c.id).filter((x): x is string => x !== undefined));
    const noSonId = piso.verdes.filter((v) => !ids.has(v));
    expect(
      noSonId,
      'el piso todavía nombra criterios por su enunciado: una traducción los daría de baja'
    ).toEqual([]);
  });
});

// ============================================================
// NINGÚN VERDE DE PAQUETE ABIERTO SE QUEDA SIN PISO (WIT-01)
//
// `--exigir` protege PAQUETES enteros, así que un verde dentro de un paquete
// que todavía tiene rojos sólo está protegido si el piso lo nombra uno a uno.
// El tablero ya lo dice al final de su salida, pero eso NO SE VE IGUAL EN
// TODA MÁQUINA: los criterios de conducta necesitan una base efímera y, donde
// no la hay, quedan sin evaluar, su paquete se abre, y entonces sus vecinos
// verdes pasan a exigir protección. El hueco de WIT-01 vivió así — invisible
// en una máquina con base, rojo en la del revisor.
//
// Esta prueba mira el CASO PEOR a propósito: trata como no evaluable todo lo
// que necesita base, que es lo que ve una CI sin ella.
// ============================================================

describe('el piso cubre lo que --exigir no alcanza', () => {
  it('todo criterio verde de un paquete abierto está nombrado en el piso', async () => {
    const necesitaBase = (c: (typeof CRITERIOS)[number]): boolean =>
      c.necesita !== undefined || c.clase === 'conducta';

    const estado = new Map<(typeof CRITERIOS)[number], 'ok' | 'falla' | 'sin-evaluar'>();
    for (const c of CRITERIOS) {
      if (necesitaBase(c)) {
        estado.set(c, 'sin-evaluar');
        continue;
      }
      const r = await c.evaluar();
      estado.set(c, r.estado === 'ok' ? 'ok' : 'falla');
    }

    // Un paquete está ABIERTO si alguno de los suyos no está verde, y un
    // criterio que no se pudo evaluar cuenta como no verde: es exactamente la
    // lectura que hace la CI cuando no hay base.
    const abiertos = new Set(
      CRITERIOS.filter((c) => estado.get(c) !== 'ok').map((c) => c.paquete)
    );

    const piso = new Set(
      (
        JSON.parse(
          fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'criterios-minimos.json'), 'utf8')
        ) as { verdes: string[] }
      ).verdes
    );

    const desprotegidos = CRITERIOS.filter(
      (c) => estado.get(c) === 'ok' && abiertos.has(c.paquete) && !piso.has(c.id ?? '')
    ).map((c) => c.id ?? `${c.paquete} · ${c.enunciado}`);

    expect(
      desprotegidos,
      'verdes de paquete abierto sin entrada en docs/criterios-minimos.json: si retroceden, nada lo dice'
    ).toEqual([]);
  }, 60_000);
});
