import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { program } from '../../../src/cli/mnemosine.js';
import { declareRisk, riskOf, ambitoDeLlave, gateMutation } from '../../../src/cli/kernel/risk.js';
import { auditProgram, DEUDA_DE_LLAVES, esDeudaDeLlave } from '../../../src/cli/kernel/audit.js';
import { hojasDe } from '../../../src/cli/kernel/riesgos-retrofit.js';
import { CliError } from '../../../src/cli/kernel/exit.js';

/**
 * R11, LA REGLA QUE NO PODÍA FALLAR.
 *
 * Comprobaba que un comando de riesgo llevara `--dry-run`, `--yes` e
 * `--idempotency-key`… y `declareRisk` se las INYECTA él mismo unas líneas
 * antes (risk.ts). La regla verificaba su propio efecto secundario: sobre el
 * binario embarcado daba CERO violaciones en 36 hojas graves. La misma
 * tautología estaba copiada en nueve pruebas más, que este tramo reescribe.
 *
 * Y mientras tanto la promesa que la bandera hace con estas palabras — «a
 * retry with the same key and payload returns the recorded result» — la
 * cumplían 15 de las 36. Medido contra Postgres el 2026-09-06, con la 069
 * aplicada: `receipt record INV-2026-00001 --amount 5000 --idempotency-key k`
 * repetido dejaba DOS customer_payments, DOS payment_allocations, DOS asientos
 * POSTEADOS y la factura en 1,600 en vez de 6,600, con `idempotency_keys`
 * VACÍA. Igual `payment create`.
 *
 * Lo que este archivo afirma es lo que la inyección NO puede fabricar:
 * que cada hoja diga qué hace con la llave, que el ámbito que dice sea el que
 * el manejador entrega al almacén —cruzado contra el código fuente, que
 * ninguna bandera inyecta— y que la deuda que queda esté nombrada y sólo
 * pueda encoger.
 */

const RAIZ_CLI = path.join(__dirname, '..', '..', '..', 'src', 'cli');

/** Todo el fuente del CLI, concatenado: donde viven las llamadas al almacén. */
function fuenteDelCli(): string {
  const trozos: string[] = [];
  const andar = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) andar(p);
      else if (e.name.endsWith('.ts')) trozos.push(fs.readFileSync(p, 'utf-8'));
    }
  };
  andar(RAIZ_CLI);
  return (
    trozos
      .join('\n')
      // SE BORRAN LOS COMENTARIOS Y LA PROPIA DECLARACIÓN antes de buscar, y
      // los dos por la misma razón: si no, `llave: { scope: 'X' }` se
      // encontraría a sí misma —y el ejemplo de la cabecera de risk.ts
      // encontraría a `receipt record`— y la prueba diría que el ámbito está
      // cableado por el mero hecho de haberlo ESCRITO. Sería la tautología
      // que este tramo persigue, un piso más abajo. Medido: sin quitar los
      // comentarios, renombrar el ámbito del manejador de `receipt record` y
      // dejar la declaración intacta pasaba en verde.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"\`])\/\/[^\n]*/g, '$1')
      .replace(/llave:\s*\{\s*scope:\s*'[^']*'\s*\}/g, '')
  );
}

const hojas = hojasDe(program);
const aceptanLaLlave = hojas.filter((h) => h.cmd.options.some((o) => o.long === '--idempotency-key'));

describe('la llave que promete deduplicar', () => {
  it('el árbol se lee y hay hojas que aceptan la llave: si no, esto no prueba nada', () => {
    expect(hojas.length).toBeGreaterThan(200);
    expect(aceptanLaLlave.length).toBeGreaterThanOrEqual(36);
    expect(aceptanLaLlave.map((h) => h.ruta)).toContain('receipt record');
  });

  it('toda hoja que la acepta DECLARA qué hace con ella', () => {
    // Sin declaración, la ayuda promete que un reintento devuelve el
    // resultado grabado y nadie ha dicho si es verdad. Las que faltan están
    // nombradas una a una en DEUDA_DE_LLAVES, que sólo puede encoger.
    const sinDecidir = aceptanLaLlave
      .filter((h) => !riskOf(h.cmd)?.llave)
      .map((h) => h.ruta)
      .filter((r) => !DEUDA_DE_LLAVES.includes(r));
    expect(
      sinDecidir,
      "declara `llave: { scope: '<ámbito>' }` si la hoja la honra, o " +
        "`llave: { sinLlave: '<motivo>' }` si todavía no"
    ).toEqual([]);
  });

  it('cada ámbito declarado se ENTREGA de verdad al almacén', () => {
    // ÉSTA ES LA QUE NO SE PUEDE SATISFACER POR ACCIDENTE. Una declaración
    // es una palabra escrita; que esa palabra viaje hasta `conLlave` es un
    // hecho del código fuente, y ninguna inyección de banderas lo produce.
    // Si alguien declara un ámbito y no cablea el manejador, aquí sale.
    const fuente = fuenteDelCli();
    const huerfanos = hojas
      .map((h) => ({ ruta: h.ruta, ambito: ambitoDeLlave(h.cmd) }))
      // El ámbito puede viajar como literal en la llamada o por una constante
      // del módulo —`receipt record` lo hace así porque lo usan DOS sitios, la
      // consulta temprana y el consumo, y dos literales que puedan divergir son
      // dos deduplicaciones distintas con el mismo nombre—. Lo que se defiende
      // es que la palabra declarada ESTÉ en el fuente del manejador, no su
      // forma sintáctica.
      .filter((x) => x.ambito !== undefined && !fuente.includes(`'${x.ambito}'`))
      .map((x) => `${x.ruta} → ${x.ambito}`);
    expect(
      huerfanos,
      'estas hojas declaran un ámbito de llave que ninguna llamada a conLlave usa: ' +
        'la declaración promete una deduplicación que el manejador no hace'
    ).toEqual([]);
  });

  it('las que dicen honrarla son las que el tramo cableó, y son de dinero', () => {
    const ambitos = new Map(hojas.map((h) => [h.ruta, ambitoDeLlave(h.cmd)]));
    expect(ambitos.get('receipt record')).toBe('receipt record');
    expect(ambitos.get('payment create')).toBe('payment create');
    expect(ambitos.get('entry post')).toBe('entry post');
  });

  it('ningún ámbito lo comparten dos hojas', () => {
    // La unicidad de `idempotency_keys` es por (tenant, scope, clave): dos
    // hojas bajo el mismo ámbito se deduplicarían ENTRE SÍ, y la segunda
    // devolvería el resultado grabado por la primera.
    const vistos = new Map<string, string>();
    const chocan: string[] = [];
    for (const h of hojas) {
      const a = ambitoDeLlave(h.cmd);
      if (a === undefined) continue;
      const previa = vistos.get(a);
      if (previa !== undefined) chocan.push(`${h.ruta} y ${previa} comparten "${a}"`);
      else vistos.set(a, h.ruta);
    }
    expect(chocan).toEqual([]);
  });

  it('R11 ACUSA sobre el binario embarcado: ya no puede pasar en el vacío', () => {
    // El síntoma exacto que este tramo persigue: la regla daba cero
    // violaciones en 36 hojas graves porque comprobaba lo que ella misma
    // inyectaba. Un cero aquí significaría que volvió a mirarse al espejo.
    const r11 = auditProgram(program).filter(esDeudaDeLlave);
    expect(r11.length).toBe(DEUDA_DE_LLAVES.length);
    expect(r11.map((v) => v.command).sort()).toEqual([...DEUDA_DE_LLAVES].sort());
  });

  it('la deuda sólo puede encoger: ninguna entrada muerta', () => {
    // Honrar una hoja obliga a borrar su renglón de DEUDA_DE_LLAVES, igual
    // que arreglar una violación obliga a borrar su línea de LINEA_BASE.
    const acusadas = new Set(auditProgram(program).filter(esDeudaDeLlave).map((v) => v.command));
    const muertas = DEUDA_DE_LLAVES.filter((r) => !acusadas.has(r));
    expect(
      muertas,
      'estas rutas ya no violan R11: bórralas de DEUDA_DE_LLAVES en src/cli/kernel/audit.ts'
    ).toEqual([]);
  });
});

/**
 * LOS MUTANTES. Cada uno es una forma concreta de romper la regla, sobre un
 * árbol de juguete construido aquí mismo: si R11 volviera a ser una
 * tautología, los cuatro pasarían en verde.
 */
describe('R11 muerde', () => {
  it('caza una hoja grave que acepta la llave sin declarar qué hace con ella', () => {
    const raiz = new Command('juguete');
    const hoja = raiz.command('cfdi').command('stamp').description('Stamp with the PAC');
    declareRisk(hoja, { risk: 'externo' });
    const v = auditProgram(raiz).filter((x) => x.rule === 'R11 llave sin declarar');
    expect(v.map((x) => x.command)).toEqual(['cfdi stamp']);
  });

  it('caza dos hojas bajo el mismo ámbito, que se deduplicarían entre sí', () => {
    const raiz = new Command('juguete');
    const familia = raiz.command('entry');
    const a = familia.command('post').description('Post');
    const b = familia.command('reverse').description('Reverse');
    declareRisk(a, { risk: 'irreversible', llave: { scope: 'el mismo' } });
    declareRisk(b, { risk: 'irreversible', llave: { scope: 'el mismo' } });
    const v = auditProgram(raiz).filter((x) => x.rule === 'R11 ámbito de llave duplicado');
    expect(v).toHaveLength(1);
    expect(v[0].command).toBe('entry reverse');
    expect(v[0].detail).toContain('entry post');
  });

  it('caza un ámbito declarado cuya bandera alguien retiró', () => {
    const raiz = new Command('juguete');
    const hoja = raiz.command('entry').command('post').description('Post');
    declareRisk(hoja, { risk: 'irreversible', llave: { scope: 'juguete post' } });
    const opciones = hoja.options as unknown as Array<{ long: string | undefined }>;
    const i = opciones.findIndex((o) => o.long === '--idempotency-key');
    expect(i, 'declareRisk tiene que haberla inyectado').toBeGreaterThanOrEqual(0);
    opciones.splice(i, 1);
    const v = auditProgram(raiz).filter((x) => x.rule === 'R11 ámbito sin bandera');
    expect(v.map((x) => x.command)).toEqual(['entry post']);
  });

  it('acusa a la que la acepta y no la honra, con el motivo escrito', () => {
    const raiz = new Command('juguete');
    const hoja = raiz.command('invoice').command('issue').description('Issue');
    declareRisk(hoja, { risk: 'irreversible', llave: { sinLlave: 'postearía el ingreso otra vez' } });
    const v = auditProgram(raiz).filter((x) => x.rule === 'R11 llave aceptada sin honrar');
    expect(v).toHaveLength(1);
    expect(v[0].detail).toContain('postearía el ingreso otra vez');
  });
});

/**
 * Y LA BANDERA QUE MIENTE SE NIEGA A FUNCIONAR.
 *
 * Mientras una hoja siga en la deuda, aceptar la llave y escribir dos veces
 * es peor que fallar: quien la pasaba creía estar protegido. El parser de
 * Commander corre ANTES de la acción, así que el rechazo ocurre antes de
 * cualquier escritura.
 */
describe('pasar la llave a una hoja que no la honra', () => {
  it('falla con el contrato de USAGE en vez de fingir', () => {
    // EL RECHAZO VIVE EN LA COMPUERTA, NO EN EL PARSER. Estuvo en el `parseArg`
    // de la opción, que corre mientras Commander aún no ha terminado de leer la
    // línea: allí no se sabe si además vino `--dry-run`, así que reventaba
    // también el ENSAYO. Un ensayo no escribe nada, de modo que negárselo al
    // operador cuyo guion ya trae la llave escrita es coste sin beneficio.
    // `gateMutation` ve las opciones ya resueltas y sigue corriendo antes de
    // cualquier escritura.
    const hoja = new Command('issue');
    declareRisk(hoja, { risk: 'irreversible', llave: { sinLlave: 'postearía el ingreso otra vez' } });
    const opcion = hoja.options.find((o) => o.long === '--idempotency-key');
    expect(opcion, 'la bandera se sigue aceptando: retirarla rompería guiones publicados').toBeDefined();

    expect(() => gateMutation(hoja, { idempotencyKey: 'k' })).toThrow(CliError);
    try {
      gateMutation(hoja, { idempotencyKey: 'k' });
    } catch (e) {
      expect((e as CliError).exitCode).toBe(2);
      expect((e as Error).message).toContain('TODAVÍA NO LA HONRA');
      expect((e as Error).message).toContain('postearía el ingreso otra vez');
    }
  });

  it('pero NO niega el ensayo: --dry-run no escribe, así que la llave no estorba', () => {
    // El operador de una hoja en deuda tiene que poder al menos MIRAR qué haría
    // el comando que su guion trae escrito con la llave.
    const hoja = new Command('issue');
    declareRisk(hoja, { risk: 'irreversible', llave: { sinLlave: 'postearía el ingreso otra vez' } });
    expect(() => gateMutation(hoja, { idempotencyKey: 'k', dryRun: true })).not.toThrow();
  });

  it('y el error nombra la RUTA de la hoja, no su nombre suelto', () => {
    // Decía «apply», y hay más de una hoja llamada `apply`: el error no decía
    // cuál se negó, justo cuando el operador ya está desconcertado.
    const raiz = new Command('mnemosine');
    const familia = raiz.command('receipt');
    const hoja = familia.command('apply');
    declareRisk(hoja, { risk: 'irreversible', llave: { sinLlave: 'volvería a repartir el saldo' } });
    try {
      gateMutation(hoja, { idempotencyKey: 'k' });
      throw new Error('debió lanzar');
    } catch (e) {
      expect((e as Error).message).toContain('mnemosine receipt apply');
    }
  });

  it('y su ayuda lo dice, en vez de prometer el resultado grabado', () => {
    const hoja = new Command('issue');
    declareRisk(hoja, { risk: 'irreversible', llave: { sinLlave: 'postearía el ingreso otra vez' } });
    const ayuda = hoja.options.find((o) => o.long === '--idempotency-key')!.description;
    expect(ayuda).toContain('NOT honored');
    expect(ayuda).not.toContain('returns the recorded result');
  });

  it('la que sí la honra conserva la promesa textual', () => {
    const hoja = new Command('post');
    declareRisk(hoja, { risk: 'irreversible', llave: { scope: 'juguete post' } });
    const opcion = hoja.options.find((o) => o.long === '--idempotency-key')!;
    expect(opcion.description).toContain('returns the recorded result');
    expect(opcion.parseArg).toBeUndefined();
  });
});
