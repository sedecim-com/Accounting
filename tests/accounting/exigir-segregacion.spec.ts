import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AccountingError } from '../../src/utils/errors.js';

// ============================================================
// G3 · EL CANDADO COMPARTIDO, PROBADO POR SU PROPIA PUERTA
//
// `exigirSegregacion` nació para que el lote importado y la póliza manual
// compartieran UN candado en vez de dos copias que dirían lo mismo hoy y otra
// cosa dentro de seis meses. El precio de compartirlo es que la función ya no
// se ejerce sola por ningún camino: `posting-sod.spec.ts` la recorre a través
// de `postJournalEntry`, y `batch-service.spec.ts` —el otro llamador— MOCKEA
// el módulo entero de posting, así que el cuerpo real nunca corre ahí.
//
// De ahí que el trinquete de cobertura de posting.ts cayera al 95,67 %
// señalando exactamente las líneas 130-146: el candado que G3 vino a cerrar
// era la única parte de este archivo sin una prueba que lo llame por su
// nombre. Esto la pone, y la pone en las cuatro direcciones que decide.
// ============================================================

const { politica } = vi.hoisted(() => ({
  politica: { valor: 'off' as string, defined: true },
}));

vi.mock('../../src/services/policy/policy-service.js', () => ({
  getPolicy: vi.fn(async (_ctx: unknown, key: string) => ({
    key,
    value: politica.valor,
    defined: politica.defined,
    question: '',
    rationale: '',
  })),
}));

import { exigirSegregacion } from '../../src/services/accounting/posting.js';
import { getPolicy } from '../../src/services/policy/policy-service.js';

const mockGetPolicy = getPolicy as unknown as Mock;

const ARGS = {
  tenantId: 'tenant-1',
  entityId: 'entidad-1',
  creador: 'ana',
  ejecutor: 'ana',
  referencia: 'LOTE-2026-0007',
};

describe('exigirSegregacion', () => {
  beforeEach(() => {
    mockGetPolicy.mockClear();
    politica.valor = 'off';
    politica.defined = true;
  });

  it('con dos personas distintas no consulta el panel siquiera', async () => {
    const nota = await exigirSegregacion({ ...ARGS, ejecutor: 'beto' });

    expect(nota).toBeNull();
    // La compuerta sólo tiene sentido cuando hay coincidencia. Consultar el
    // panel antes de comprobarla sería una lectura por cada asiento posteado
    // del despacho, y el orden de estas dos líneas es lo único que lo impide.
    expect(mockGetPolicy).not.toHaveBeenCalled();
  });

  it('con la política en «exigir» bloquea a quien lo preparó', async () => {
    politica.valor = 'exigir';

    await expect(exigirSegregacion(ARGS)).rejects.toThrow(AccountingError);
    await expect(exigirSegregacion(ARGS)).rejects.toMatchObject({
      code: 'SOD_QUIEN_CREA_NO_POSTEA',
      statusCode: 422,
    });
  });

  it('el mensaje del bloqueo nombra la referencia y la salida', async () => {
    politica.valor = 'exigir';

    // Un 422 sin la referencia obliga a adivinar CUÁL de los asientos del lote
    // se rechazó, y sin el nombre de la clave obliga a buscar en la wiki qué
    // política aflojarlo. Las dos cosas viajan en el mismo mensaje o el
    // remedio no está a mano de quien lo lee.
    await expect(exigirSegregacion(ARGS)).rejects.toThrow(/LOTE-2026-0007/);
    await expect(exigirSegregacion(ARGS)).rejects.toThrow(/segregacion_de_funciones/);
    await expect(exigirSegregacion(ARGS)).rejects.toThrow(/mnemosine pending/);
  });

  it('con la política en «alertar» deja pasar y devuelve la nota', async () => {
    politica.valor = 'alertar';

    const nota = await exigirSegregacion(ARGS);

    expect(nota).toBe('SoD: quien aplica es quien lo preparó (política en alertar)');
  });

  it('consulta la política acotada a la entidad, no sólo al inquilino', async () => {
    politica.valor = 'alertar';

    await exigirSegregacion(ARGS);

    // El alcance por entidad se acota dentro de `getPolicy`, pero sólo puede
    // hacerlo si quien pregunta le pasa la entidad: con dos razones sociales
    // del mismo despacho, perder este argumento le aplica a una el criterio
    // que se respondió para la otra.
    expect(mockGetPolicy).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', entityId: 'entidad-1' },
      'segregacion_de_funciones'
    );
  });

  it.each(['off', 'permitir', 'valor_que_nadie_ha_escrito'])(
    'con la política en «%s» no bloquea ni anota',
    async (valor) => {
      politica.valor = valor;

      // Defensivo a propósito, y el mismo criterio que `severidadDeLineaSinPartida`:
      // SÓLO el literal 'exigir' bloquea. Un valor desconocido del panel no puede
      // congelar el posteo de un despacho por una errata en una clave.
      await expect(exigirSegregacion(ARGS)).resolves.toBeNull();
    }
  );
});
