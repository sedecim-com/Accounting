import type { Express, Router } from 'express';
import accountsRouter from './routes/accounts.js';
import journalEntriesRouter from './routes/journal-entries.js';
import invoicesRouter from './routes/invoices.js';
import billsRouter from './routes/bills.js';
import reportsRouter from './routes/reports.js';
import bankReconciliationRouter from './routes/bank-reconciliation.js';
import webhooksRouter from './routes/webhooks.js';
import vendorsRouter from './routes/vendors.js';
import customersRouter from './routes/customers.js';
import fiscalPeriodsRouter from './routes/fiscal-periods.js';
import xmlIngestionRouter from './routes/xml-ingestion.js';
import blockchainRouter from './routes/blockchain.js';
import integrationsRouter from './routes/integrations.js';
import payrollRouter from './routes/payroll.js';
import aiRouter from './routes/ai.js';
import publicVerificationRouter from './routes/public-verification.js';
import aiWebhooksRouter from './routes/ai-webhooks.js';

// ============================================================
// LA TABLA DE MONTAJE DEL PREFIJO AUTENTICADO.
//
// Vive aparte de src/index.ts por una razón concreta: el censo de riesgo
// (risk.ts) sólo ve las rutas que están MONTADAS, así que la prueba que
// demuestra que ninguna ruta de escritura queda sin declarar tiene que
// montar exactamente lo que monta el servidor. Con la tabla dentro de
// bootstrap(), la prueba habría tenido que repetirla a mano — y una lista
// escrita al lado del código es justo el defecto que este censo existe
// para cerrar. Se comparte, entonces, en vez de copiarse.
//
// EL ORDEN IMPORTA y por eso es un arreglo y no un objeto: xml-ingestion
// y blockchain se montan DOS VECES cada uno, primero bajo su prefijo
// propio y luego bajo uno más corto, y Express resuelve por orden de
// registro. Cambiar el orden cambia qué ruta atiende una petición.
//
// Fuera de esta tabla quedan, a propósito, los tres montajes que NO van
// detrás de `authenticate` y que src/index.ts monta uno por uno con su
// condición a la vista: /public/v1 (apagado por omisión), los webhooks de
// IA (autenticados por su propio token) y /graphql. El censo los alcanza
// igual, porque recorre la app entera y no esta tabla.
// ============================================================
export const MONTAJES_V1: ReadonlyArray<readonly [string, Router]> = [
  ['/accounts', accountsRouter],
  ['/journal-entries', journalEntriesRouter],
  ['/invoices', invoicesRouter],
  ['/bills', billsRouter],
  ['/reports', reportsRouter],
  ['/bank-accounts', bankReconciliationRouter],
  ['/webhooks', webhooksRouter],
  ['/vendors', vendorsRouter],
  ['/customers', customersRouter],
  ['/fiscal-periods', fiscalPeriodsRouter],
  ['/xml', xmlIngestionRouter],
  ['', xmlIngestionRouter],
  ['/admin/blockchain', blockchainRouter],
  ['/admin', blockchainRouter],
  ['/admin/integrations', integrationsRouter],
  ['/payroll', payrollRouter],
  ['/ai', aiRouter],
];

/**
 * Los montajes que NO van detrás de `authenticate`, con la dirección
 * exacta con la que src/index.ts los cuelga.
 *
 * Están fuera de MONTAJES_V1 porque index.ts los monta uno por uno con su
 * condición a la vista —/public/v1 sólo si PUBLIC_VERIFICATION_ENABLED, los
 * webhooks de IA con su propio limitador— y meterlos en la tabla escondería
 * esa diferencia. Pero un instrumento que censa la SUPERFICIE los necesita
 * igual, y hasta hoy los copiaba a mano: `montarSuperficieCensable` existe
 * para que dejen de copiarse.
 */
export const MONTAJES_FUERA_DE_V1: ReadonlyArray<readonly [string, Router]> = [
  ['/public/v1', publicVerificationRouter],
  ['/v1/ai/webhooks', aiWebhooksRouter],
];

/**
 * Monta TODA la superficie de rutas REST sobre una app vacía, sin un solo
 * middleware: ni autenticación, ni límites, ni contexto de inquilino.
 *
 * Es lo que necesitan los instrumentos que PREGUNTAN por las rutas en vez de
 * servirlas —el censo de riesgo (risk.ts) y el contrato de la API
 * (openapi.ts)—, y la razón de que exista es la de siempre en este archivo:
 * la alternativa era que cada uno repitiera la lista de montajes, y una lista
 * repetida es una lista que se desincroniza.
 *
 * DOS COSAS QUE ESTA APP NO ES:
 *
 *   · No es la app que sirve. `bootstrap()` intercala `authenticate`,
 *     `tenantContext` y los dos frenos entre el prefijo y los routers; aquí no
 *     hay nada de eso, a propósito, porque montar autenticación exigiría
 *     configuración y ninguno de los dos instrumentos la necesita para mirar.
 *
 *   · No dice qué está ENCENDIDO. /public/v1 sólo se sirve con
 *     PUBLIC_VERIFICATION_ENABLED=true; aquí se monta siempre, porque la
 *     bandera decide si esas rutas se atienden, no si existen escritas. Quien
 *     publique este censo tiene que decirlo así.
 */
export function montarSuperficieCensable(app: Express): Express {
  for (const [sufijo, router] of MONTAJES_V1) app.use(`/v1${sufijo}`, router);
  for (const [ruta, router] of MONTAJES_FUERA_DE_V1) app.use(ruta, router);
  return app;
}
