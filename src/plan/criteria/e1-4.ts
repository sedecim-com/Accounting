import { codigoDe, consumidoresDe, type Criterio, dondeAparece, falla, ok } from './shared.js';

// ============================================================
// THE E1.4 CRITERIA
//
// Moved verbatim from `src/plan/criterios.ts` (#294), in the board's order.
// The index concatenates the packages back into `CRITERIOS`.
// ============================================================
export const E1_4: Criterio[] = [

  // ---- E1.4 · Módulos sin puerta ----
  {
    paquete: 'E1.4',
    id: 'monthly-depreciation-command-reachable',
    enunciado: 'La depreciación mensual tiene por dónde invocarse, y la puerta llega al binario',
    mutantes: [
      {
        archivo: 'src/cli/mnemosine.ts',
        de: 'registerDepreciationCommand(program, { palette: c, shutdown, reportError });',
        a: '// registerDepreciationCommand fuera del binario',
        porque: 'la familia entera vuelve a estar verificada y no entregada: 76 pruebas verdes sobre un programa que sólo construye el spec, y una puerta que nadie puede empujar',
      },
      {
        archivo: 'src/services/assets/depreciation-math.ts',
        de: 'export function indiceDeCalendario(',
        a: 'export function indiceDeCalendario_(',
        porque: 'el índice de calendario desaparece del módulo puro: el motor volvería a indexar por su cuenta, que es como marzo repetía la fila de febrero',
      },
    ],
    evaluar: () => {
      // LA HISTORIA DE ESTE CRITERIO ES LA DE SU PROPIA DEBILIDAD. Su primera
      // versión sólo pedía «un llamador», y F06a lo demostró en vivo: el
      // llamador existió en depreciation-command.ts, E1.4 se puso VERDE, y el
      // binario no cargaba ese archivo — una puerta que nadie podía empujar,
      // exactamente el «verde no es entregado» que F05a ya había enseñado.
      // consumidoresDe hace grep sobre src/ y no distingue código alcanzable
      // de código muerto, ni motor correcto de motor roto.
      const cons = consumidoresDe('runMonthlyDepreciation', 'depreciation.ts');
      if (cons.length === 0) {
        return falla('runMonthlyDepreciation no tiene llamador: el motor existe y no hay puerta');
      }
      // 1 · ALCANZABLE: la puerta está registrada en el binario de verdad.
      if (!/registerDepreciationCommand\(program/.test(codigoDe('src/cli/mnemosine.ts'))) {
        return falla('registerDepreciationCommand no está en el binario: el llamador vive en un archivo que mnemosine.ts no carga');
      }
      // 2 · EL ÍNDICE ES CALENDARIO, NO PROMEDIO. Dividir por 30,44 días
      // —la longitud MEDIA de un mes— hacía que marzo repitiera la fila de
      // febrero y que la última no se consumiera nunca: once filas en doce
      // meses, y la suma posteada jamás daba costo menos salvamento.
      const math = codigoDe('src/services/assets/depreciation-math.ts');
      if (!/export function indiceDeCalendario\(/.test(math) || /30\.44/.test(math)) {
        return falla('la aritmética volvió a medir meses con un promedio (30,44 d): marzo repite febrero y la última fila no se consume nunca');
      }
      // 3 · Y EL MOTOR LA USA. Que la función correcta exista no basta si
      // runMonthlyDepreciation sigue indexando por su cuenta.
      if (!/indiceDeCalendario\(/.test(codigoDe('src/services/assets/depreciation.ts'))) {
        return falla('runMonthlyDepreciation dejó de indexar por calendario: el motor no consume la aritmética que sí está bien');
      }
      return ok(`invocable desde ${cons.join(', ')}, registrado en el binario, e indexando por calendario`);
    },
  },
  {
    paquete: 'E1.4',
    id: 'no-faked-external-act-success',
    enunciado: 'Ninguna función reporta éxito de un acto externo que no realiza',
    evaluar: () => {
      // «email service» no estaba en la lista y por eso el TODO de
      // POST /invoices/:id/send —que respondía sent:true sin transmitir
      // nada— pasó este criterio durante meses. La lección es la de siempre:
      // un detector de clases enumeradas sólo ve las clases que enumeró.
      const sospechosos = dondeAparece(
        /TODO:[^\n]*(PAC|SAT|IRS|SSA|IMSS|enviar|send|email|correo|transmit|integrate)/i
      );
      return sospechosos.length === 0
        ? ok('sin TODO sobre un acto externo en el camino de escritura')
        : falla(`${sospechosos.join(', ')} — un TODO junto a un UPDATE de estado es un acto que se reporta y no ocurre`);
    },
  },
];
