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

  it('y dice el paso que falta: capitalizar no da de alta la ficha', () => {
    // Esta prueba fijó la etiqueta DEGRADADA («depreciation NOT computed»)
    // cuando el sistema capitalizaba sin depreciar. F06a entregó el alta y la
    // corrida, y la etiqueta subió — pero sólo hasta donde es verdad: la
    // deducción sigue sin aparecer sola, porque capitalizar no registra la
    // ficha. Lo que se fija ahora es que la etiqueta NOMBRE el paso que falta
    // en vez de volver a prometer «capitalized and depreciated» a secas, que
    // fue la mentira original.
    expect(opcion.label.toLowerCase()).toMatch(/asset create/);
    expect(opcion.label.toLowerCase()).not.toMatch(/^fixed asset \(capitalized and depreciated\)$/);
  });

  it('el contexto que se muestra al decidir lo repite, no sólo la etiqueta', () => {
    // La etiqueta se lee de pasada en una lista; el contexto es lo que se lee
    // cuando alguien duda. La advertencia tiene que estar en los dos.
    const ctx = d.context({
      emisorNombre: 'X', subtotal: 100000, moneda: 'MXN',
      conceptosDescripcion: 'Servidor', clavesProdServ: [],
    } as never);
    // El contexto también subió con F06a: ya no advierte que nada deprecia,
    // sino que nombra el alta de la ficha como el paso sin el cual la
    // deducción no aparece.
    expect(ctx).toMatch(/asset create/);
    expect(ctx).toMatch(/does not appear without the card/i);
  });

  it('el fundamento nombra por qué, para quien vaya a arreglarlo', () => {
    expect(d.basis).toMatch(/no caller|has no caller/i);
  });
});
