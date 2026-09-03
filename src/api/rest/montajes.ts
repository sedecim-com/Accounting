import type { Router } from 'express';
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
