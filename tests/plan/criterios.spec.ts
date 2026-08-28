import { describe, it, expect } from 'vitest';
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

  it('todo resultado trae un detalle con el que se puede actuar', async () => {
    for (const c of CRITERIOS) {
      const r = await c.evaluar();
      expect(r.detalle, c.enunciado).toBeTruthy();
      expect(r.detalle.length, c.enunciado).toBeGreaterThan(10);
    }
  });
});
