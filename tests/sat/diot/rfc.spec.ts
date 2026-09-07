import { describe, it, expect } from 'vitest';
import {
  clasificarRfc,
  normalizarRfc,
  rfcIdentificaAlTercero,
  RFC_GENERICO_NACIONAL,
  RFC_GENERICO_EXTRANJERO,
} from '../../../src/services/sat/diot/rfc.js';
import { normalizeTaxId } from '../../../src/services/ap/vendor-service.js';

// ============================================================
// F07c · LOS TRES CASOS DEL RFC, Y EL COTEJO CONTRA EL ALTA
//
// Lo que había era la detección del vacío. Aquí se prueban los tres, y en
// particular el genérico, que es el único que pasa cualquier patrón y aun así
// convierte a un proveedor real en anónimo dentro de la declaración.
//
// El último bloque no prueba este archivo: prueba que este archivo y el alta
// de proveedores no se separen. Son dos implementaciones de la misma regla de
// forma —aquí clasifica, allí lanza— y sin este cotejo la divergencia se
// descubriría el día que un proveedor pase el alta y bloquee la DIOT.
// ============================================================

describe('clasificarRfc', () => {
  it('acepta una persona moral (12) y una física (13)', () => {
    expect(clasificarRfc('ABC010101AA1').estado).toBe('valido');
    expect(clasificarRfc('CACX7605101P8').estado).toBe('valido');
  });

  it('normaliza espacios y minúsculas antes de juzgar', () => {
    expect(normalizarRfc('  abc010101aa1 ')).toBe('ABC010101AA1');
    expect(clasificarRfc('  abc 010101 aa1 ')).toMatchObject({
      estado: 'valido',
      rfc: 'ABC010101AA1',
    });
  });

  it('detecta el VACÍO, que es el único que el sistema ya veía', () => {
    for (const v of [null, undefined, '', '   ']) {
      expect(clasificarRfc(v).estado).toBe('vacio');
    }
  });

  it('detecta el MALFORMADO, que el vacío no ve porque no está vacío', () => {
    expect(clasificarRfc('ABC01').estado).toBe('malformado');
    expect(clasificarRfc('ABCDE010101AA1').estado).toBe('malformado');
    expect(clasificarRfc('123010101AA1').estado).toBe('malformado');
  });

  it('detecta la fecha imposible, que el patrón deja pasar', () => {
    const d = clasificarRfc('ABC011301AA1');
    expect(d.estado).toBe('malformado');
    expect(d.motivo).toContain('no existe');
  });

  it('detecta los DOS genéricos y los distingue entre sí', () => {
    expect(clasificarRfc(RFC_GENERICO_NACIONAL).estado).toBe('generico_nacional');
    expect(clasificarRfc(RFC_GENERICO_EXTRANJERO).estado).toBe('generico_extranjero');
  });

  it('el genérico nacional tiene forma de RFC y aun así no identifica a nadie', () => {
    // Es la razón entera de que exista este clasificador: XAXX010101000 pasa
    // el patrón —tres letras, AAMMDD válida, homoclave— y por tanto el alta
    // de proveedores lo acepta sin decir nada.
    expect(() => normalizeTaxId(RFC_GENERICO_NACIONAL, 'rfc')).not.toThrow();
    expect(rfcIdentificaAlTercero(clasificarRfc(RFC_GENERICO_NACIONAL))).toBe(false);
  });

  it('nombra al culpable en el motivo, que es lo que la política promete', () => {
    expect(clasificarRfc('XXXX').motivo).toContain('XXXX');
    expect(clasificarRfc(RFC_GENERICO_NACIONAL).motivo).toContain('público en general');
  });
});

describe('la misma regla de forma que el alta de proveedores', () => {
  const conForma = ['ABC010101AA1', 'CACX7605101P8', 'AAA800101XX0', RFC_GENERICO_NACIONAL];
  const sinForma = ['ABC01', 'ABCDE010101AA1', '123010101AA1', 'ABC011301AA1', 'ABC010132AA1'];

  it.each(conForma)('%s: los dos lo aceptan', (rfc) => {
    expect(() => normalizeTaxId(rfc, 'rfc')).not.toThrow();
    expect(clasificarRfc(rfc).estado).not.toBe('malformado');
  });

  it.each(sinForma)('%s: los dos lo rechazan', (rfc) => {
    expect(() => normalizeTaxId(rfc, 'rfc')).toThrow();
    expect(clasificarRfc(rfc).estado).toBe('malformado');
  });
});
