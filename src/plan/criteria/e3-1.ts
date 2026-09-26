import { codigoDe, type Criterio, existe, falla, ok } from './shared.js';

// ============================================================
// THE E3.1 CRITERIA
//
// Moved verbatim from `src/plan/criterios.ts` (#294), in the board's order.
// The index concatenates the packages back into `CRITERIOS`.
// ============================================================
export const E3_1: Criterio[] = [

  // ---- E3.1 · Timbrado real ----
  {
    paquete: 'E3.1',
    id: 'pac-anti-simulation-guard',
    enunciado: 'Un adaptador simulado no puede producir un timbre ni un acuse',
    evaluar: () => {
      const p = 'src/services/integrations/mexico/pac/pac-router.ts';
      if (!existe(p)) return falla('no existe el router de PAC');
      const s = codigoDe(p);
      const guardas = (s.match(/assertPuedeTimbrar/g) ?? []).length;
      // Dos: timbrar y cancelar. Cancelar es irreversible ante el SAT, así que
      // un acuse fabricado es peor que un timbre fabricado.
      return guardas >= 3
        ? ok('timbrado y cancelación con cerrojo')
        : falla(`sólo ${guardas - 1} de las 2 vías con cerrojo: la que falta puede fabricar un folio`);
    },
  },
  {
    paquete: 'E3.1',
    id: 'cfdi-cancellation-requires-pac',
    enunciado: 'Cancelar un CFDI no marca la factura como cancelada sin llamar al PAC',
    evaluar: () => {
      const s = codigoDe('src/api/rest/routes/invoices.ts');
      return /cfdi_status\s*=\s*'cancelled'/.test(s)
        ? falla('la ruta marca cancelado sin acuse: el mayor cree cancelado un CFDI vigente ante el SAT')
        : ok('la ruta no finge cancelar');
    },
  },
  {
    paquete: 'E3.1',
    id: 'no-simulated-email-delivery',
    enunciado: 'Lo que no envía no existe: el adaptador de correo simulado está retirado',
    mutantes: [
      {
        archivo: 'src/api/rest/routes/invoices.ts',
        de: 'transmitted: false',
        a: 'transmitted: true',
        porque: 'la ruta vuelve a mentir que transmite: el «sent:true sin envío» que CLI-5 purgó',
      },
    ],
    evaluar: () => {
      // F03: el plan preguntaba «¿cablear invoice send al adaptador SendGrid
      // o retirar la promesa?» y el reconocimiento volteó la premisa: el
      // adaptador era simulación doble — send() fabricaba el messageId con
      // crypto.randomBytes sin llamar a la API, healthCheck() devolvía sano
      // fijo, y los adjuntos se descartaban. Cablearlo habría recreado el
      // «sent:true sin envío» que CLI-5 purgó y que el cerrojo
      // antisimulación del timbrado existe para impedir. Se retiró entero;
      // la ruta REST conserva su contrato honesto: marca, no transmite.
      if (existe('src/services/integrations/email/sendgrid-adapter.ts')) {
        return falla('el adaptador simulado volvió: un send() que fabrica messageId sin llamar a la API es la mentira que este criterio veta');
      }
      if (/sendGrid/i.test(codigoDe('src/services/integrations/index.ts'))) {
        return falla('el registro de integraciones volvió a anunciar un correo que no existe: el panel aceptaría credenciales para nada');
      }
      const rutas = codigoDe('src/api/rest/routes/invoices.ts');
      // El contrato honesto de /send, con sus dos mitades: marca Y confiesa.
      if (!/transmitted: false/.test(rutas)) {
        return falla('POST /:id/send dejó de confesar que no transmite: volvería el «sent» que no envió nada');
      }
      return /marked_sent: true/.test(rutas)
        ? ok('adaptador retirado, registro limpio y la ruta de envío marca confesando que no transmite')
        : falla('la ruta de envío perdió su mitad honesta: marcar sin decir qué significó');
    },
  },
];
