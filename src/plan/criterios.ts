import { PRUEBAS_DE_CONDUCTA, correrConducta, type PruebaDeConducta } from './conducta.js';
import { type Criterio } from './criteria/shared.js';
import { E0_0 } from './criteria/e0-0.js';
import { E0_1 } from './criteria/e0-1.js';
import { E0_2 } from './criteria/e0-2.js';
import { E0_3 } from './criteria/e0-3.js';
import { E1_1 } from './criteria/e1-1.js';
import { E1_2 } from './criteria/e1-2.js';
import { E1_3 } from './criteria/e1-3.js';
import { E1_4 } from './criteria/e1-4.js';
import { E2_1 } from './criteria/e2-1.js';
import { E2_2 } from './criteria/e2-2.js';
import { E3_1 } from './criteria/e3-1.js';
import { E3_2 } from './criteria/e3-2.js';
import { E4_1 } from './criteria/e4-1.js';
import { E4_2 } from './criteria/e4-2.js';
import { E5_1 } from './criteria/e5-1.js';


// ============================================================
// CRITERIOS DE CIERRE, EJECUTABLES
//
// El plan de cierre lleva sus criterios en prosa y NADIE los ha corrido nunca
// como conjunto. El resultado fue predecible: su tabla de estado marcaba
// resueltos paquetes que no lo estaban, y marcaba pendientes otros que sí,
// porque era un espejo escrito a mano del repositorio.
//
// Aquí los criterios son CÓDIGO. El documento los cita; esta lista los decide.
//
// DOS REGLAS QUE VIENEN DE UN ERROR CONCRETO
//
// 1. Un criterio afirma COMPORTAMIENTO, no identificadores. El cerrojo
//    antisimulación del timbrado se construyó bien, quedó mejor documentado
//    que su especificación, y falla el 100% de sus criterios escritos porque
//    su autor eligió nombres en español. Un criterio puede nombrar un archivo
//    sólo cuando el plan está PRESCRIBIENDO dónde va el código.
//
// 2. Un criterio que no se puede evaluar se declara «no evaluable» y dice por
//    qué. Nunca se aproxima: un ✅ inventado es peor que un hueco confesado,
//    porque hace que un comando imposible parezca trabajo de una hora.
// ============================================================
//
// THE INDEX. The types and helpers live in `./criteria/shared.ts` (#294) and
// are re-exported from here, so every importer of this file keeps working.
export * from './criteria/shared.js';

export const CRITERIOS: Criterio[] = [
  ...E0_0,
  ...E0_1,
  ...E0_2,
  ...E0_3,
  ...E1_1,
  ...E1_2,
  ...E1_3,
  ...E1_4,
  ...E2_1,
  ...E2_2,
  ...E3_1,
  ...E3_2,
  ...E4_1,
  ...E4_2,
  ...E5_1,

  // ============================================================
  // LOS CRITERIOS QUE EJECUTAN (S4a)
  //
  // Van en E0.1 —«red de seguridad»— y no en el paquete del tema que juzgan, y
  // conviene decir por qué en las dos direcciones.
  //
  // A FAVOR: E0.1 es el paquete de la demostración, no el de los informes ni
  // el del cierre. Lo que estos tres criterios añaden no es una afirmación
  // nueva sobre el dinero —el cierre ya tiene sus pruebas de integración— sino
  // que el TABLERO deje de creerle al texto. Ése es el objeto de E0.1.
  //
  // EN CONTRA, y queda anotado: el sitio temático del criterio del saldo sería
  // E4.2 (informes) y el del barrido, E1.1. Los dos están ABIERTOS, y un
  // criterio verde en paquete abierto tiene que entrar en
  // docs/criterios-minimos.json en el mismo commit —el piso de S2— que este
  // tramo no puede escribir: los suelos son del orquestador. Si se prefiere el
  // sitio temático, mover cada criterio y añadir su renglón al piso es un
  // cambio de dos líneas; no se hizo aquí porque habría dejado la CI en rojo
  // desde un archivo que no me toca tocar.
  // ============================================================
  ...PRUEBAS_DE_CONDUCTA.map(criterioDeConducta),
];

/**
 * Convierte una prueba de conducta en un criterio del tablero.
 *
 * El único trabajo real que hace es CLASIFICAR EL SILENCIO. `correrConducta`
 * devuelve `no-evaluable` cuando el escenario no se pudo montar (no hay rol
 * que cree bases, la migración no corrió) y `falla` cuando sí se montó y la
 * cifra salió mal o el camino reventó. Esa frontera es todo el contrato:
 * `bloqueadoPorEntorno` excusa de `--exigir` lo primero y no lo segundo, así
 * que ponerla en el sitio equivocado convertiría cada mutante vivo en un
 * «aquí no había instrumento».
 */
function criterioDeConducta(p: PruebaDeConducta): Criterio {
  return {
    paquete: p.paquete,
    // La prueba de conducta ya tenía id —`correrConducta` la busca por él—, así
    // que la identidad del criterio es la misma y no se inventa otra.
    id: p.id,
    enunciado: p.enunciado,
    clase: 'conducta',
    necesita: 'base-efimera',
    mutantesEnDisco: p.mutantes,
    evaluar: () => correrConducta(p.id),
  };
}
