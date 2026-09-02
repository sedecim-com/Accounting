import { describe, it, expect } from 'vitest';
import { CRITERIOS, conFuenteMutada, crudoDe, type Criterio } from '../../src/plan/criterios.js';

// ============================================================
// LOS ESPEJOS, POR FIN EJECUTABLES (S2).
//
// El Plan Maestro §7 prometía desde el principio que «cada criterio llega con
// su espejo que neutraliza la conducta medida y afirma el rojo». Era verdad a
// medias: los espejos existían como PASE MANUAL —un script de mutación que se
// corría a mano cada fase y cuyo resultado vivía en el mensaje del commit— y
// nada impedía que un criterio nuevo naciera sin ninguno, ni que uno viejo
// dejara de morder cuando su ancla se ablandaba.
//
// Aquí el espejo es una PRUEBA. Cada `mutante` declarado en un criterio se
// aplica sobre el seam de lectura (conFuenteMutada: overlay en memoria, el
// árbol real JAMÁS se toca) y se exige que el criterio pase a `falla`. Un
// mutante que sobrevive es un criterio que mide prosa.
//
// La disciplina que esto codifica, aprendida en seis escapes reales:
//   · el regex que casa el import y no la llamada (AUD-6);
//   · el vecino de firma —`nombre(` casa la declaración además del uso—;
//   · la presencia donde hacía falta CONTEO (la nota del auto-post vive en
//     tres brazos del CASE: mutar uno deja los otros dos);
//   · el mutante-sufijo: `tax_regimen` CONTIENE `tax_regime`, y sólo `\b` lo
//     mata;
//   · la alternativa `|` compartida entre varias guardas, que bendice al
//     mutante que borra una sola.
// ============================================================

const conMutantes = CRITERIOS.filter((c) => (c.mutantes?.length ?? 0) > 0);

/**
 * LÍNEA BASE DE CRITERIOS SIN ESPEJO. Sólo encoge.
 *
 * No se exige un mutante por criterio de golpe: setenta y tres criterios
 * escritos a lo largo de quince paquetes no se retro-equipan en una tarde, y
 * un número inventado sería la clase de compuerta decorativa que S2 existe
 * para retirar. Se congela el número de hoy y la prueba falla si sube: cada
 * criterio NUEVO nace con su espejo, y los viejos se van pagando.
 */
// 62 → 61: la colisión de códigos de semilla y las cuatro cuentas de IVA
// llegan con espejo, y el criterio de colisión pasó a leer por el seam para que
// su mutante pueda morderlo. Uno de los dos criterios es NUEVO en este commit,
// así que su espejo es requisito, no pago: el otro es la deuda que se salda.
const SIN_ESPEJO_MAXIMO = 61;

describe('el arnés de mutación — un criterio sin mordida es prosa', () => {
  it('la línea base de criterios sin espejo sólo encoge', () => {
    const sinEspejo = CRITERIOS.filter((c) => (c.mutantes?.length ?? 0) === 0);
    expect(
      sinEspejo.length,
      `criterios sin mutante declarado: ${sinEspejo.length}. Si BAJÓ, actualiza ` +
        `SIN_ESPEJO_MAXIMO a ${sinEspejo.length} en el mismo commit que lo paga — ` +
        'la línea base sólo encoge, como la de huérfanos.'
    ).toBeLessThanOrEqual(SIN_ESPEJO_MAXIMO);
  });

  it('todo mutante declarado ancla en texto que EXISTE hoy', () => {
    // Un `de` que ya no aparece no muta nada: el espejo pasaría a ser un
    // adorno que siempre da rojo por la razón equivocada (o verde, si el
    // criterio no dependía de esa línea). Se acusa aquí, con nombre.
    for (const c of conMutantes) {
      for (const m of c.mutantes!) {
        const fuente = crudoDe(m.archivo);
        expect(
          fuente.includes(m.de),
          `${c.paquete} «${c.enunciado}»: el mutante ancla en «${m.de}» y ese texto ya ` +
            `no está en ${m.archivo}. El código cambió y el espejo no: reescríbelo.`
        ).toBe(true);
      }
    }
  });

  const casos = conMutantes.flatMap((c) =>
    (c.mutantes ?? []).map((m) => ({
      etiqueta: `${c.paquete} · ${m.archivo}: ${m.porque}`,
      criterio: c,
      mutante: m,
    }))
  );

  it.each(casos)(
    'el mutante lo pone en rojo — $etiqueta',
    async ({ criterio, mutante }: { criterio: Criterio; mutante: (typeof casos)[number]['mutante'] }) => {
      const original = crudoDe(mutante.archivo);
      // `a: null` finge que el archivo desapareció; si no, se sustituye el texto.
      let overlay: Record<string, string | null>;
      if (mutante.a === null) {
        overlay = { [mutante.archivo]: null };
      } else {
        const mutado = original.replace(mutante.de, mutante.a);
        expect(mutado, `la mutación no cambió ${mutante.archivo}`).not.toBe(original);
        overlay = { [mutante.archivo]: mutado };
      }

      const resultado = await conFuenteMutada(overlay, () => criterio.evaluar());

      expect(
        resultado.estado,
        `MUTANTE VIVO en ${criterio.paquete} «${criterio.enunciado}»\n` +
          `  ${mutante.archivo}: «${mutante.de}» → «${mutante.a}»\n` +
          `  porque: ${mutante.porque}\n` +
          `  el criterio dijo: ${resultado.detalle}\n` +
          '  El criterio mide texto que el mutante no toca: endurece su ancla.'
      ).toBe('falla');
    },
    30_000
  );

  it('el árbol real queda intacto tras mutar (el overlay es sólo memoria)', () => {
    // La prueba de que el seam es un seam: si conFuenteMutada escribiera,
    // este archivo llevaría la última mutación aplicada.
    for (const c of conMutantes) {
      for (const m of c.mutantes!) {
        expect(crudoDe(m.archivo).includes(m.de), `${m.archivo} quedó mutado en disco`).toBe(true);
      }
    }
  });
});
