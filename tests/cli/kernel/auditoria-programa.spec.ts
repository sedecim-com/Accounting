import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
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

  it('está congelada de verdad: subconjunto de la foto original, no un conteo', () => {
    // La primera versión afirmaba `length <= 40`, y eso permite CANJEAR:
    // borrar una entrada arreglada y colar una nueva mantiene el conteo. La
    // congelación es una propiedad de CONJUNTO — toda entrada viva tiene que
    // estar en la foto que se tomó el día que la puerta se encendió. Esta
    // copia no se edita: cuando una entrada se arregla, se borra de
    // LINEA_BASE y la foto simplemente la recuerda; añadir algo a LINEA_BASE
    // que no esté aquí es imposible sin tocar la prueba, que es el punto.
    const FOTO_ORIGINAL = new Set([
  'entities|R1 objectless allowlist|"entities" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'providers|R1 objectless allowlist|"providers" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'sessions|R1 objectless allowlist|"sessions" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'drafts|R1 objectless allowlist|"drafts" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'onboard|R6 banned spelling|--from is banned',
  'outbox|R1 objectless allowlist|"outbox" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'questions|R1 objectless allowlist|"questions" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'sat cred audit|R3 closed verb list|"audit" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'pending define|R3 closed verb list|"define" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'pending define|R6 short flag|--note should use no short form, found -n',
  'pending dismiss|R6 short flag|--note should use no short form, found -n',
  'memory|R6 short flag|--all should use -a, found none',
  'memory teach|R3 closed verb list|"teach" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'memory retire|R3 closed verb list|"retire" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'prompt-size|R1 objectless allowlist|"prompt-size" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'compact|R1 objectless allowlist|"compact" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'approvals list|R6 short flag|--all should use -a, found none',
  'approvals list|list contract|missing --limit',
  'approvals list|list contract|missing --format',
  'approvals grant|R6 short flag|--provider should use -p, found none',
  'account deactivate|R3 closed verb list|"deactivate" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'usage|R1 objectless allowlist|"usage" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'status|R6 short flag|--all should use -a, found none',
  'jobs list|list contract|missing --limit',
  'jobs list|list contract|missing --format',
  'jobs create|R6 short flag|--user should use -u, found none',
  'jobs run-due|R3 closed verb list|"run-due" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'jobs history|R6 short flag|--limit should use -n, found none',
  'skills list|list contract|missing --limit',
  'skills list|list contract|missing --format',
  'skills drafts|R3 closed verb list|"drafts" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'skills view|R3 closed verb list|"view" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'webhooks list|list contract|missing --limit',
  'webhooks list|list contract|missing --format',
  'webhooks deliveries|R3 closed verb list|"deliveries" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'init|R6 short flag|--status should use -s, found none',
  'init|R6 short flag|--entity should use -e, found none',
  'init|R6 short flag|--provider should use -p, found none',
  'init|R6 short flag|--model should use -m, found none',
  'close|R6 short flag|--period should use no short form, found -p',
    ]);
    const intrusas = LINEA_BASE.filter((k) => !FOTO_ORIGINAL.has(k));
    expect(
      intrusas,
      'LINEA_BASE sólo puede encoger: estas claves no estaban el día que se congeló'
    ).toEqual([]);
  });
});

/**
 * Y `doctor` la corre. Antes no podía: la función vivía en un fichero de
 * pruebas, que producción no puede importar.
 */
describe('doctor consume la auditoría', () => {
  it('la reporta, y no como error mientras no haya nuevas', async () => {
    const r = await checkConsistenciaCli();
    expect(r.name).toBe('CLI consistency');
    expect(r.level, 'con deuda congelada avisa; sólo falla ante algo nuevo').not.toBe('fail');
    expect(r.detail).toMatch(/heredadas|cumple/);
  });

  it('falla si aparece una violación que no está en la línea base', async () => {
    // Se añade un comando con un verbo inventado al programa real, se audita,
    // y se retira. Es la única forma de comprobar la puerta sin esperar a que
    // alguien degrade la superficie de verdad.
    const antes = auditarContraLineaBase(program).nuevas.length;
    program.command('desmadejar').description('un verbo que no existe');
    try {
      const r = await checkConsistenciaCli();
      expect(auditarContraLineaBase(program).nuevas.length).toBeGreaterThan(antes);
      expect(r.level, 'una violación nueva tiene que romper').toBe('fail');
      expect(r.detail).toMatch(/nuevas/);
    } finally {
      // commander tipa `commands` como readonly y no publica ningún «quitar
      // comando», pero el array de verdad sí es mutable. El molde es sobre el
      // TIPO, no sobre el hecho: sin esto la prueba deja el verbo inventado
      // dentro del programa compartido y contamina a las que vengan después.
      const cmds = program.commands as unknown as Command[];
      const i = cmds.findIndex((c) => c.name() === 'desmadejar');
      if (i >= 0) cmds.splice(i, 1);
    }
  });
});
