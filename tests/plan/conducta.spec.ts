import { describe, it, expect } from 'vitest';
import { CRITERIOS, claseDe, crudoDe, tieneEspejo } from '../../src/plan/criterios.js';
import { PRUEBAS_DE_CONDUCTA } from '../../src/plan/conducta.js';
import { censoDeClases, type Paquete, type Evaluacion } from '../../src/plan/status.js';

// ============================================================
// EL CONTRATO DEL CRITERIO QUE EJECUTA (S4a), sin tocar Postgres.
//
// Lo que se puede afirmar sin base es la FORMA del contrato, y no es poco:
// las tres maneras de que un criterio de conducta se vuelva decorativo son de
// forma, y las tres se cierran aquí.
//
//   · Que no declare su precondición: sin `necesita`, un escenario que no se
//     pudo montar cuenta como regresión del código y pone la CI en rojo en
//     cualquier máquina sin Postgres. Eso ya pasó una vez y costó BORRAR un
//     criterio bueno (ver la nota de bloqueadoPorEntorno en status.ts).
//   · Que declare sus espejos en el campo del arnés equivocado: los de
//     `mutantes` se aplican en memoria, y a un criterio de conducta la
//     memoria no le cambia lo que corre. Se darían por muertos sin matarlos.
//   · Que su espejo ancle en un texto que ya no existe: entonces no muta
//     nada, y el mutante «muere» porque el archivo quedó igual.
// ============================================================

const deConducta = CRITERIOS.filter((c) => claseDe(c) === 'conducta');

describe('el contrato del criterio de conducta', () => {
  it('hay al menos uno, y el tablero lo distingue del que lee', () => {
    // Si esto llega a cero, el tramo se deshizo: el tablero volvió a hablar
    // sólo de su propio texto.
    expect(deConducta.length).toBeGreaterThanOrEqual(3);
    expect(deConducta.length).toBe(PRUEBAS_DE_CONDUCTA.length);
  });

  it('cada uno declara la precondición que lo excusa de --exigir donde no hay base', () => {
    for (const c of deConducta) {
      expect(c.necesita, `${c.paquete} «${c.enunciado}» sin necesita`).toBe('base-efimera');
    }
  });

  it('ninguno declara espejos del arnés en memoria, que no podrían morderlo', () => {
    for (const c of deConducta) {
      expect(
        c.mutantes,
        `${c.paquete} «${c.enunciado}» declara mutantes en memoria: a un criterio que ` +
          'EJECUTA hay que mutarle el archivo real, o el espejo se da por muerto sin haber matado'
      ).toBeUndefined();
      expect(tieneEspejo(c), `${c.paquete} «${c.enunciado}» nace sin espejo`).toBe(true);
    }
  });

  it('todo espejo de conducta ancla en texto que EXISTE hoy', () => {
    // Misma disciplina que el arnés en memoria, y por la misma razón: un `de`
    // que ya no aparece no muta nada, y el mutante sobrevive como adorno.
    for (const p of PRUEBAS_DE_CONDUCTA) {
      expect(p.mutantes.length, `la prueba «${p.id}» no trae espejo`).toBeGreaterThan(0);
      for (const m of p.mutantes) {
        expect(
          crudoDe(m.archivo).includes(m.de),
          `«${p.id}»: el espejo ancla en «${m.de}» y ese texto ya no está en ${m.archivo}. ` +
            'El código cambió y el espejo no: reescríbelo.'
        ).toBe(true);
      }
    }
  });

  it('el id que viaja al hijo es único: si dos coinciden, uno se queda sin veredicto', () => {
    const ids = PRUEBAS_DE_CONDUCTA.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ------------------------------------------------------------
// EL CENSO. Es la cifra que mide el tramo, así que se prueba como cifra.
// ------------------------------------------------------------

const evaluacion = (clase: 'lectura' | 'conducta', estado: 'ok' | 'falla' | 'no-evaluable'): Evaluacion => ({
  criterio: { paquete: 'E0.1', enunciado: `${clase} ${estado}`, clase, evaluar: () => ({ estado, detalle: 'x' }) },
  resultado: { estado, detalle: estado === 'no-evaluable' ? 'no hay rol que cree bases' : 'x' },
});

const paquete = (evaluaciones: Evaluacion[]): Paquete[] => [
  { id: 'E0.1', estado: 'parcial', evaluaciones },
];

describe('el censo por clase', () => {
  it('cuenta las dos poblaciones por separado', () => {
    const linea = censoDeClases(
      paquete([evaluacion('lectura', 'ok'), evaluacion('lectura', 'ok'), evaluacion('conducta', 'ok')])
    );
    expect(linea).toContain('3 criterios');
    expect(linea).toContain('2 leen el fuente');
    expect(linea).toContain('1 ▶ ejecutan');
    expect(linea).toContain('1 en verde');
  });

  it('cuando NINGUNO pudo ejecutar, lo dice y dice por qué', () => {
    // Es la regla que da nombre al tramo: un criterio que se salta en silencio
    // es un verde falso. La última línea de la salida tiene que confesarlo,
    // porque es la que se lee.
    const linea = censoDeClases(paquete([evaluacion('lectura', 'ok'), evaluacion('conducta', 'no-evaluable')]));
    expect(linea).toContain('no corrió NINGUNO');
    expect(linea).toContain('no hay rol que cree bases');
    expect(linea).toContain('nadie midió una cifra');
  });

  it('cuando corrieron unos sí y otros no, nombra el motivo del que no', () => {
    const linea = censoDeClases(
      paquete([evaluacion('conducta', 'ok'), evaluacion('conducta', 'no-evaluable')])
    );
    expect(linea).toContain('1 corrieron aquí (1 en verde) y 1 no');
    expect(linea).toContain('no hay rol que cree bases');
  });

  it('un tablero sin criterios de conducta lo confiesa en vez de callarlo', () => {
    const linea = censoDeClases(paquete([evaluacion('lectura', 'ok')]));
    expect(linea).toContain('ninguno ejecuta el camino real todavía');
  });
});
