import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { program } from '../../../src/cli/mnemosine.js';
import { riskOf, declareRisk, gateMutation } from '../../../src/cli/kernel/risk.js';
import { hojasDe, RIESGOS_RETROFIT, declararPendientes } from '../../../src/cli/kernel/riesgos-retrofit.js';

/**
 * TODA HOJA QUE MUTA DECLARA SU RIESGO.
 *
 * 49 de las 106 hojas del binario no declaraban nada, y entre ellas estaban
 * las que postean al mayor (`review`, `ingest --auto-post`, `onboard --post`),
 * la que ejecuta contra el sistema contable del cliente con su credencial
 * (`outbox`) y la que registra la e.firma. A lo que no se declara no se le
 * aplica ninguna compuerta.
 *
 * Y la regla R11 del auditor —riesgo y compuerta `--live`, la única
 * sustantiva— producía CERO violaciones. No porque el CLI estuviera bien:
 * porque `riskOf` devolvía `undefined` y la regla no tenía sobre qué correr.
 * Un verde por no tener nada que mirar.
 */
describe('cobertura de declaraciones', () => {
  const hojas = hojasDe(program);

  it('el árbol se lee: si no, esta prueba no prueba nada', () => {
    expect(hojas.length).toBeGreaterThan(80);
    expect(hojas.map((h) => h.ruta)).toContain('entry post');
  });

  it('NINGUNA hoja del binario queda sin declarar', () => {
    const sin = hojas.filter((h) => !riskOf(h.cmd)).map((h) => h.ruta);
    expect(
      sin,
      'un comando sin declaración no tiene confirmación, ni marcha seca, ni rastro de ' +
        'auditoría, y el auditor no puede decir nada de él. Declara con `declareRisk` ' +
        'junto a su registro.'
    ).toEqual([]);
  });

  it('las que postean al mayor o salen del sistema NO son invocables por el agente', () => {
    // La garantía sobre la que descansa todo el diseño del asistente: propone,
    // y un humano dispone. `declareRisk` ya lo impone al declarar; esto lo
    // afirma sobre el programa embarcado, que es donde importa.
    for (const h of hojas) {
      const r = riskOf(h.cmd)!;
      if (r.risk === 'irreversible' || r.risk === 'externo') {
        expect(r.agentAllowed, `${h.ruta} es ${r.risk} y el agente puede invocarlo`).toBe(false);
      }
      if (r.risk === 'escritura' && r.agentAllowed) {
        expect(r.draftOnly, `${h.ruta} deja escribir al agente fuera de una cola de revisión`).toBe(true);
      }
    }
  });

  it('las que más pueden hacer están declaradas por su camino más grave', () => {
    // `outbox run` ejecuta contra un tercero con la credencial del cliente;
    // `review` postea al mayor; `close --hard` no se deshace re-ejecutando.
    // S0.6: los modos de bandera que eran clases distintas se partieron donde
    // el catálogo lo comete (outbox/question); `close`, `review`, `ingest` y
    // `onboard` siguen siendo una hoja por dictamen del REGISTRY (§5 #6) y
    // declaran al máximo que alcanza cualquiera de sus caminos.
    const de = (ruta: string) => riskOf(hojas.find((h) => h.ruta === ruta)!.cmd)!;
    expect(de('outbox run').risk).toBe('externo');
    expect(de('jobs run-due').risk).toBe('externo');
    expect(de('sat cred add').risk).toBe('externo');
    expect(de('review').risk).toBe('irreversible');
    expect(de('close').risk).toBe('irreversible');
    expect(de('ingest').risk).toBe('irreversible');
    expect(de('onboard').risk).toBe('irreversible');
    expect(de('sat cred revoke').risk).toBe('irreversible');
  });

  it('la partición dejó la lectura como lectura, invocable por el agente', () => {
    // La mitad del punto de partir outbox/questions: listar no debe cargar
    // las banderas ni la compuerta del camino grave.
    const de = (ruta: string) => riskOf(hojas.find((h) => h.ruta === ruta)!.cmd)!;
    expect(de('outbox list').risk).toBe('lectura');
    expect(de('outbox list').agentAllowed).toBe(true);
    expect(de('question list').risk).toBe('lectura');
    expect(de('question answer').risk).toBe('escritura');
    expect(de('question answer').agentAllowed).toBe(false);
  });

  it('la tabla de retrofit ya no declara ningún grave', () => {
    // S0.6: los ocho graves declaran junto a su registro y honran sus
    // banderas. Una fila irreversible/externo nueva aquí sería un retroceso:
    // volvería a existir un camino grave cuyo manejador nadie cableó.
    const graves = Object.entries(RIESGOS_RETROFIT)
      .filter(([, d]) => d.risk === 'irreversible' || d.risk === 'externo')
      .map(([ruta]) => ruta);
    expect(graves, 'un grave declarado por tabla no tiene manejador cableado a la compuerta').toEqual([]);
  });

  it('las de riesgo alto llevan las banderas de seguridad que su clase exige', () => {
    for (const h of hojas) {
      const r = riskOf(h.cmd)!;
      const largas = h.cmd.options.map((o) => o.long);
      if (r.requiresDryRun) {
        expect(largas, `${h.ruta} es ${r.risk} y no tiene --dry-run`).toContain('--dry-run');
        expect(largas, `${h.ruta} es ${r.risk} y no tiene --yes`).toContain('--yes');
      }
      if (r.requiresLiveGate) {
        expect(largas, `${h.ruta} es externo y no tiene --live`).toContain('--live');
      }
    }
  });

  it('la tabla de retrofit no acumula entradas sombreadas', () => {
    // Una fila de la tabla cuya ruta ya declara junto a su registro —el
    // destino deseado de cada comando— es letra muerta: no describe nada y
    // con el tiempo la tabla dejaría de ser el inventario que es. Migrar un
    // comando obliga a borrar su fila, igual que la línea base del auditor
    // obliga a borrar la violación arreglada. (Llamar de nuevo es inocuo:
    // todas las hojas ya declaran, así que sólo censa.)
    const { sombreadas, aplicadas } = declararPendientes(program);
    expect(aplicadas, 'el programa ya estaba declarado').toBe(0);
    expect(
      sombreadas,
      'estas rutas ya declaran junto a su registro (o ya no existen): borra su fila de RIESGOS_RETROFIT'
    ).toEqual([]);
  });

  it('la tabla de retrofit no acumula entradas muertas', () => {
    // Una entrada para una ruta que ya no existe es una declaración sobre un
    // comando imaginario, y con el tiempo la tabla dejaría de describir el
    // binario.
    const rutas = new Set(hojas.map((h) => h.ruta));
    const sobran = Object.keys(RIESGOS_RETROFIT).filter((r) => !rutas.has(r));
    expect(sobran, 'rutas declaradas que el binario no tiene').toEqual([]);
  });
});

/**
 * LA COMPUERTA FALLA CERRADO.
 *
 * Su única comprobación iba guardada por `if (resolved && …)`, así que una
 * hoja sin declaración la atravesaba entera. Y como `resetDeclarations()` —la
 * costura de pruebas— vacía el registro, dentro de una suite el binario
 * ENTERO quedaba sin compuerta y las pruebas pasaban en ese estado.
 */
describe('gateMutation ante un comando sin declarar', () => {
  it('rompe en vez de dejar pasar', () => {
    const suelto = new Command('borrar');
    expect(() => gateMutation(suelto, { force: true, reason: 'porque sí' })).toThrow(
      /sin haber declarado su riesgo/i
    );
  });

  it('declarado, deja pasar y devuelve el modo', () => {
    const cmd = new Command('crear');
    declareRisk(cmd, { risk: 'escritura', agent: false, writes: 'algo' });
    const r = gateMutation(cmd, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.live).toBe(false);
  });

  it('un verbo que deshace sigue exigiendo su razón', () => {
    const cmd = new Command('void');
    declareRisk(cmd, { risk: 'irreversible', agent: false, writes: 'journal_entries' });
    expect(() => gateMutation(cmd, {})).toThrow(/reason/i);
    expect(() => gateMutation(cmd, { reason: 'error de captura' })).not.toThrow();
  });
});
