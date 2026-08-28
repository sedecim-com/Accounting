import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, sesionDe, type Servidor } from './helpers/servidor.js';
import { olvidarAlcances } from '../../src/database/scope.js';
import xmlIngestionRouter from '../../src/api/rest/routes/xml-ingestion.js';
import payrollRouter from '../../src/api/rest/routes/payroll.js';
import bankReconciliationRouter from '../../src/api/rest/routes/bank-reconciliation.js';
import publicVerificationRouter from '../../src/api/rest/routes/public-verification.js';

/**
 * EL MANEJADOR ASÍNCRONO QUE SE DEFENDÍA MATANDO AL PROCESO.
 *
 * Express 4 no captura la promesa rechazada de un manejador `async`. Un
 * manejador sin envolver que lanza —NotFoundError sobre un id que no existe,
 * ValidationError sobre un parámetro con mala forma— produce tres efectos, y
 * los tres son malos:
 *
 *   1. El error NUNCA llega a errorHandler, así que no hay respuesta.
 *   2. La petición queda COLGADA hasta que el cliente se rinde.
 *   3. Node emite unhandledRejection que, desde la v15, ABORTA por omisión.
 *
 * O sea: pedir en bucle un id inexistente era una negación de servicio de UNA
 * línea, y la disparaba el propio control de seguridad de la ruta. TEN-3 cerró
 * dos manejadores; éste cierra los 61 que quedaban.
 *
 * QUE ESTAS PRUEBAS RESPONDAN —en vez de agotar el tiempo— ES LO QUE
 * DEMUESTRAN. Con el manejador sin envolver no fallan por `expect`: fallan
 * porque nadie contesta nunca.
 */

let f: Fixture;
let s: Servidor;

beforeAll(async () => {
  olvidarAlcances();
  f = await crearInquilino('Manejadores async');

  // Los prefijos concretos ANTES del genérico '/v1', que es como los monta
  // src/index.ts; si '/v1' fuera primero taparía a sus hermanos.
  s = await levantar(
    [
      ['/public/v1', publicVerificationRouter],
      ['/v1/payroll', payrollRouter],
      ['/v1/bank-accounts', bankReconciliationRouter],
      ['/v1', xmlIngestionRouter],
    ],
    sesionDe(f)
  );
});

afterAll(async () => {
  await s.cerrar();
  await closeDatabase();
});

/**
 * `pedir` del arnés no acota el tiempo, y aquí el fallo que se persigue es
 * PRECISAMENTE que nadie contesta. Sin límite propio cada caso colgado se
 * comería los 30 s de `testTimeout`, y el unhandledRejection podría tumbar el
 * fork único antes de que se viera nada. Con límite, el defecto se manifiesta
 * en dos segundos y con un mensaje que lo NOMBRA.
 */
async function pedirConLimite(
  metodo: string,
  ruta: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const r = await fetch(`${s.url}${ruta}`, {
      method: metodo,
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(2000),
    });
    const texto = await r.text();
    return { status: r.status, body: texto ? JSON.parse(texto) : {} };
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error(
        `La petición ${metodo} ${ruta} quedó COLGADA: el manejador lanzó y su ` +
          'promesa rechazada no llegó al errorHandler. Le falta asyncHandler.'
      );
    }
    throw e;
  }
}

const INEXISTENTE = uuidv4();

/**
 * Uno por fichero y por tipo de error. Todos lanzan sobre un id que no existe
 * o sobre un parámetro con mala forma, así que son alcanzables HOY, sin
 * provocar un fallo de base.
 */
const CASOS = [
  { nombre: 'xml-ingestion  GET /xml-documents/:id',               metodo: 'GET', ruta: `/v1/xml-documents/${INEXISTENTE}`,                          esperado: 404 },
  { nombre: 'xml-ingestion  GET /processing-batches/:id/progress', metodo: 'GET', ruta: `/v1/processing-batches/${INEXISTENTE}/progress`,            esperado: 404 },
  { nombre: 'payroll        GET /paychecks/:id',                   metodo: 'GET', ruta: `/v1/payroll/paychecks/${INEXISTENTE}`,                      esperado: 404 },
  { nombre: 'bank-reconc.   GET /reconciliations/:id',             metodo: 'GET', ruta: `/v1/bank-accounts/reconciliations/${INEXISTENTE}`,          esperado: 404 },
  { nombre: 'bank-reconc.   GET /transactions/:id/suggestions',    metodo: 'GET', ruta: `/v1/bank-accounts/transactions/${INEXISTENTE}/suggestions`, esperado: 404 },
  { nombre: 'public-verif.  GET /entities/:entityId',              metodo: 'GET', ruta: `/public/v1/entities/${INEXISTENTE}`,                        esperado: 404 },
  // 422 y no 400: ValidationError nace con ese código en utils/errors.ts.
  { nombre: 'public-verif.  GET /verify/:entryHash (mala forma)',  metodo: 'GET', ruta: '/public/v1/verify/no-es-un-hash',                           esperado: 422 },
];

describe('el manejador async lanza y el error llega al errorHandler', () => {
  it.each(CASOS)('$nombre responde $esperado y no se cuelga', async ({ metodo, ruta, esperado }) => {
    const r = await pedirConLimite(metodo, ruta);
    expect(r.status).toBe(esperado);
  });

  it('el proceso sigue atendiendo después de todas ellas', async () => {
    // La otra mitad de lo que demuestra la prueba: que el unhandledRejection
    // no se llevó por delante al servidor. Si el fork hubiera abortado, aquí
    // no habría nadie contestando.
    const r = await pedirConLimite('GET', `/v1/xml-documents/${uuidv4()}`);
    expect(r.status).toBe(404);
  });

  it('y el camino feliz sigue devolviendo 200', async () => {
    // Sin esto la prueba pasaría con un asyncHandler que lanzara SIEMPRE:
    // envolver tiene que llevar el error al pipeline sin comerse el éxito.
    const r = await pedirConLimite('GET', '/v1/pre-registrations');
    expect(r.status).toBe(200);
  });
});
