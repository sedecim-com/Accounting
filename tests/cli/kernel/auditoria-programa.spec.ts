import { describe, it, expect } from 'vitest';
import { program } from '../../../src/cli/mnemosine.js';
import {
  auditProgram,
  auditarContraLineaBase,
  claveDeViolacion,
  LINEA_BASE,
} from '../../../src/cli/kernel/audit.js';
import { checkConsistenciaCli } from '../../../src/ai/doctor-service.js';

/**
 * EL AUDITOR AUDITA LO QUE SE EMBARCA.
 *
 * `auditProgram` existía desde el principio y el binario real nunca pasó por
 * ella: vivía en un `.spec.ts` y cada prueba se construía un árbol de juguete.
 * La primera vez que se corrió contra el `program` de verdad dio 40
 * violaciones que no había visto nadie.
 *
 * Están congeladas. Lo que este archivo vigila es lo único que importa a
 * partir de ahora: que no aparezcan nuevas, y que la lista ENCOJA — una
 * entrada que ya no se viola tiene que borrarse, o la línea base dejaría de
 * describir la deuda y se volvería un permiso permanente.
 */
describe('la línea base sólo puede encoger', () => {
  it('el programa se lee entero: si no, esto no prueba nada', () => {
    expect(auditProgram(program).length).toBeGreaterThanOrEqual(0);
    expect(program.commands.length).toBeGreaterThan(20);
  });

  it('no hay violaciones NUEVAS', () => {
    const { nuevas } = auditarContraLineaBase(program);
    expect(
      nuevas.map((v) => `${v.command}: ${v.rule} — ${v.detail}`),
      'La superficie se mantiene coherente porque cada verbo sale de una lista cerrada y cada ' +
        'bandera del diccionario único. Corrige el comando, o amplía el vocabulario si el cambio ' +
        'es deliberado. La línea base NO se amplía: así se llegó a las 40.'
    ).toEqual([]);
  });

  it('la línea base no conserva entradas muertas', () => {
    const { obsoletas } = auditarContraLineaBase(program);
    expect(
      obsoletas,
      'Estas ya no se violan: bórralas de LINEA_BASE en src/cli/kernel/audit.ts. Una línea base ' +
        'que no encoge deja de ser deuda registrada y se convierte en un permiso permanente.'
    ).toEqual([]);
  });

  it('la clave de una violación no cambia porque crezca el vocabulario', () => {
    // Varios detalles citan cuentas —«uno de los 77 verbos canónicos»— y una
    // línea base que se invalida al añadir un verbo obligaría a regenerarla
    // por una razón que no es la suya.
    const a = claveDeViolacion({ command: 'x list', rule: 'R3', detail: 'not one of the 77 verbs' });
    const b = claveDeViolacion({ command: 'x list', rule: 'R3', detail: 'not one of the 91 verbs' });
    expect(a).toBe(b);
  });

  it('está congelada de verdad: 40 entradas, ni una más sin escribirla a mano', () => {
    expect(LINEA_BASE.length).toBeLessThanOrEqual(40);
  });
});

/**
 * Y `doctor` la corre. Antes no podía: la función vivía en un fichero de
 * pruebas, que producción no puede importar.
 */
describe('doctor consume la auditoría', () => {
  it('la reporta, y no como error mientras no haya nuevas', () => {
    const r = checkConsistenciaCli();
    expect(r.name).toBe('CLI consistency');
    expect(r.level, 'con deuda congelada avisa; sólo falla ante algo nuevo').not.toBe('fail');
    expect(r.detail).toMatch(/heredadas|cumple/);
  });

  it('falla si aparece una violación que no está en la línea base', () => {
    // Se añade un comando con un verbo inventado al programa real, se audita,
    // y se retira. Es la única forma de comprobar la puerta sin esperar a que
    // alguien degrade la superficie de verdad.
    const antes = auditarContraLineaBase(program).nuevas.length;
    program.command('desmadejar').description('un verbo que no existe');
    try {
      const r = checkConsistenciaCli();
      expect(auditarContraLineaBase(program).nuevas.length).toBeGreaterThan(antes);
      expect(r.level, 'una violación nueva tiene que romper').toBe('fail');
      expect(r.detail).toMatch(/nuevas/);
    } finally {
      const i = program.commands.findIndex((c) => c.name() === 'desmadejar');
      if (i >= 0) program.commands.splice(i, 1);
    }
  });
});
