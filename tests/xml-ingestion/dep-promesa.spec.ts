import { describe, it, expect } from 'vitest';
import { DECISIONS } from '../../src/services/xml-ingestion/cfdi-decisions.js';

/**
 * NO SE PROMETE UN ACTO QUE NO SE REALIZA.
 *
 * La pantalla donde el usuario clasifica un desembolso ofrecía «Fixed asset
 * (capitalized and depreciated)». El sistema capitaliza y NO deprecia:
 * `runMonthlyDepreciation` no tiene un solo llamador y no existe un
 * `INSERT INTO fixed_assets` en todo `src`, así que ni siquiera hay activo
 * que depreciar.
 *
 * Es la peor variante del defecto que retiró CLI-5, porque la promesa está en
 * el momento de decidir: el usuario elige capitalizar contando con una
 * deducción mensual que nadie va a calcular, y el activo queda sobrevaluado
 * creciendo cada mes hasta que alguien lo note al cierre del ejercicio.
 *
 * Esta prueba no pide que la depreciación exista — ese es otro paquete, y es
 * XL. Pide que la interfaz no la dé por hecha.
 */
describe('la opción de activo fijo dice lo que de verdad ocurre', () => {
  const d = DECISIONS.find((x) => x.id === 'gasto_vs_activo')!;
  const opcion = d.options.find((o) => o.value === 'activo_fijo')!;

  it('existe la decisión y su opción: si se renombran, esto deja de vigilar', () => {
    expect(d).toBeDefined();
    expect(opcion).toBeDefined();
    expect(opcion.role).toBe('activo_fijo');
  });

  it('la etiqueta NO afirma que se deprecie', () => {
    expect(
      opcion.label,
      'el sistema no deprecia: prometerlo donde el usuario decide le hace elegir contando ' +
        'con una deducción que nadie calculará'
    ).not.toMatch(/\band depreciated\b/i);
  });

  it('y dice explícitamente que la depreciación no se calcula', () => {
    expect(opcion.label.toLowerCase()).toMatch(/not computed|no computa|sin depreciaci/);
  });

  it('el contexto que se muestra al decidir lo repite, no sólo la etiqueta', () => {
    // La etiqueta se lee de pasada en una lista; el contexto es lo que se lee
    // cuando alguien duda. La advertencia tiene que estar en los dos.
    const ctx = d.context({
      emisorNombre: 'X', subtotal: 100000, moneda: 'MXN',
      conceptosDescripcion: 'Servidor', clavesProdServ: [],
    } as never);
    expect(ctx).toMatch(/does not yet register the asset|depreciation/i);
  });

  it('el fundamento nombra por qué, para quien vaya a arreglarlo', () => {
    expect(d.basis).toMatch(/no caller|has no caller/i);
  });
});
