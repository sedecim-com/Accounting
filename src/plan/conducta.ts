import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Decimal from 'decimal.js';
import type { Mutante, Resultado } from './criterios.js';

// ============================================================
// S4a · LOS CRITERIOS QUE EJECUTAN
//
// EL DEFECTO QUE ESTE ARCHIVO EXISTE PARA CERRAR
//
// Los ~118 criterios del tablero son, sin excepción, expresiones regulares
// sobre el fuente. Esta semana esa forma costó tres veces:
//
//   · E0.1 «el maker-checker vive en UN candado» estaba EN VERDE mientras dos
//     puertas posteaban al mayor sin control de cuatro ojos: anclaba el
//     candado escrito dentro de UNA puerta y no sabía de las otras.
//   · Invertir el signo de la resta del saldo sobrevivía a 3 500 pruebas,
//     porque la única prueba del módulo FABRICA el saldo recomponiendo la
//     misma resta que la consulta declara.
//   · El trinquete de cobertura CUENTA LLAVES —`(c.match(/'src\/…\.ts':/g)).length >= 3`—
//     así que poner los tres umbrales en CERO lo deja verde.
//
// Un criterio que mide su propio texto informa de su propio texto. Aquí un
// criterio SIEMBRA un escenario, corre el camino REAL y juzga la CIFRA.
//
// ------------------------------------------------------------
// POR QUÉ UN PROCESO HIJO, Y NO UNA BASE MÁS EN ESTE PROCESO
//
// La decisión incómoda del tramo, y conviene defenderla entera porque la
// alternativa parece más simple y no lo es.
//
// `src/config/index.ts` congela `config.database.url` EN EL MOMENTO DE
// IMPORTARSE. Y ya está importado cuando se evalúan estos criterios: el
// criterio del sello de periodo (E0.1) usa `query` de la app, lo que arrastra
// `config`, que a su vez corre `dotenv.config()` y publica la URL de
// DESARROLLO en `process.env`. Es decir: cuando el primer criterio de conducta
// pide una base, el pool de la aplicación YA está apuntando a la base del
// despacho que corre el comando.
//
// Cambiar `process.env.DATABASE_URL` a esas alturas no mueve el pool: mueve
// sólo lo que lea el entorno DESPUÉS. El resultado sería un criterio que cree
// escribir en una base desechable y escribe en el mayor de alguien. Un
// instrumento que puede escribir en lo que mide no es un instrumento.
//
// El proceso hijo hace imposible esa confusión POR CONSTRUCCIÓN, no por
// disciplina: arranca con la URL efímera puesta antes de que exista un
// `config`, y muere con su base. El padre nunca abre una conexión a ella y el
// hijo nunca ve la del plan. Se paga un `spawn` (~4 s con la migración
// incluida) UNA vez para todas las pruebas de conducta, y se compra que este
// archivo no pueda tocar datos reales ni por error ni por orden de evaluación.
//
// ------------------------------------------------------------
// QUÉ PASA EN UNA MÁQUINA SIN POSTGRES
//
// Se dice. `necesita: 'base-efimera'` viaja en el criterio, el runner lo honra
// (status.ts · bloqueadoPorEntorno) y la salida imprime el motivo exacto —«no
// hay URL de administración», «el rol no puede CREATE DATABASE», «la migración
// falló»—. Un criterio de conducta que no pudo correr sale `no-evaluable`,
// NUNCA `ok`: el paquete deja de estar cerrado y la línea de cierre del
// tablero dice cuántos se quedaron sin ejecutar. Un verde que se salta en
// silencio es la clase de mentira que este tramo vino a retirar.
//
// La otra mitad de esa regla, y es la que cuesta: si el escenario SÍ pudo
// montarse y el camino real revienta, eso es `falla`, no `no-evaluable`. Un
// mutante suele matar por excepción antes que por cifra —un asiento que ya no
// cuadra, un predicado que ya no liga su parámetro— y clasificar esa
// excepción como «aquí no había instrumento» la excusaría de `--exigir`, que
// es precisamente el agujero por el que se escapa un mutante vivo.
// ============================================================

/** Los módulos reales de la aplicación, ya apuntando a la base efímera. */
export interface App {
  conexion: typeof import('../database/connection.js');
  posting: typeof import('../services/accounting/posting.js');
  cierre: typeof import('../services/accounting/period-close.js');
  informes: typeof import('../services/reporting/report-service.js');
  contabilidad: typeof import('../services/accounting/entity-accounting.js');
  alcance: typeof import('../database/scope.js');
  tipos: typeof import('../types/index.js');
}

/**
 * Una prueba de conducta: el escenario, el camino y la cifra.
 *
 * `id` es lo que viaja entre padre e hijo, así que es estable y corto; el
 * `enunciado` es lo que lee quien mira el tablero.
 */
export interface PruebaDeConducta {
  id: string;
  paquete: string;
  enunciado: string;
  correr: (app: App) => Promise<Resultado>;
  /**
   * Espejos aplicados SOBRE EL ARCHIVO REAL, no sobre el seam de lectura.
   *
   * Un criterio de conducta no puede mutarse en memoria: lo que corre no es lo
   * que el criterio lee. `conFuenteMutada` sustituye el texto que un regex
   * inspecciona; aquí hay que cambiar el código que Postgres acaba ejecutando.
   * Por eso estos mutantes se escriben en disco y se re-corren en un hijo
   * nuevo —módulos frescos—, y se restauran en un `finally`. Vive en
   * tests/integration/plan-conducta-mutacion.int.spec.ts, que corre en serie.
   */
  mutantes: Mutante[];
}

const ok = (detalle: string): Resultado => ({ estado: 'ok', detalle });
const falla = (detalle: string): Resultado => ({ estado: 'falla', detalle });

const RAIZ = path.resolve(__dirname, '..', '..');

// ------------------------------------------------------------
// EL ESCENARIO: UN INQUILINO DESECHABLE
//
// Es un gemelo reducido de tests/integration/helpers/tenant-fixture.ts, y la
// duplicación es deliberada: `tsconfig.json` excluye tests/, así que un
// archivo de src que importara de allí rompería `npm run typecheck`. Se copia
// lo mínimo —alta, ejercicio, catálogo— y no se copia nada de lo que el
// fixture ofrece para OTRAS pruebas.
// ------------------------------------------------------------

export interface Inquilino {
  tenantId: string;
  entityId: string;
  userId: string;
  fiscalYearId: string;
  /** Periodos por número de mes (1..12). */
  periodos: Record<number, string>;
  /** id de cuenta por código del catálogo. */
  cuentas: Record<string, string>;
  /** id de cuenta por rol semántico (banco, cxc…). */
  roles: Record<string, string>;
}

const ANIO = 2026;

/** Fecha dentro de un periodo abierto del ejercicio sembrado. */
export const fechaEnPeriodo = (mes: number, dia = 10): Date =>
  new Date(Date.UTC(ANIO, mes - 1, dia));

export async function crearInquilino(app: App, nombre: string): Promise<Inquilino> {
  const { query, withTransaction, enterTenant } = app.conexion;
  const tenantId = crypto.randomUUID();
  const entityId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const fiscalYearId = crypto.randomUUID();
  const sufijo = tenantId.replace(/-/g, '').slice(0, 12);

  // El alta corre ANTES de fijar el contexto: crea al propio inquilino.
  await query(
    `INSERT INTO tenants (id, name, subdomain, schema_name, plan, is_active)
     VALUES ($1, $2, $3, $4, 'enterprise', true)`,
    [tenantId, nombre, `plan-${sufijo}`, `plan_${sufijo}`]
  );
  await query(
    `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name,
       roles, permissions, accessible_entities, is_active)
     VALUES ($1, $2, $3, 'x', 'Plan', 'Conducta',
       '["owner"]'::jsonb, '["*"]'::jsonb, $4::jsonb, true)`,
    [userId, tenantId, `plan-${userId.slice(0, 8)}@example.test`, JSON.stringify([entityId])]
  );
  await query(
    `INSERT INTO organizations (id, tenant_id, name, type) VALUES ($1, $2, $3, 'holding')`,
    [orgId, tenantId, nombre]
  );
  await query(
    `INSERT INTO legal_entities (id, tenant_id, organization_id, name, entity_type, tax_id,
       tax_id_type, incorporation_country, functional_currency, accounting_standard,
       fiscal_year_start_month, is_active)
     VALUES ($1, $2, $3, $4, 'corporation', 'XAXX010101000', 'rfc', 'MX', 'MXN', 'mx_nif', 1, true)`,
    [entityId, tenantId, orgId, nombre]
  );

  enterTenant(tenantId);

  await query(
    `INSERT INTO fiscal_years (id, entity_id, year_number, start_date, end_date,
       is_calendar_year, status)
     VALUES ($1, $2, $3, $4, $5, true, 'open')`,
    [fiscalYearId, entityId, ANIO, `${ANIO}-01-01`, `${ANIO}-12-31`]
  );

  const periodos: Record<number, string> = {};
  for (let m = 1; m <= 12; m++) {
    const id = crypto.randomUUID();
    const fin = new Date(Date.UTC(ANIO, m, 0)).toISOString().slice(0, 10);
    await query(
      `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name,
         start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')`,
      [id, fiscalYearId, entityId, m, `Periodo ${m}/${ANIO}`,
        `${ANIO}-${String(m).padStart(2, '0')}-01`, fin]
    );
    periodos[m] = id;
  }

  await withTransaction((client) =>
    app.contabilidad.ensureEntityAccounting(entityId, tenantId, userId, { client })
  );

  const cuentas = Object.fromEntries(
    (await query<{ code: string; id: string }>(
      'SELECT code, id FROM accounts WHERE entity_id = $1',
      [entityId]
    )).rows.map((r) => [r.code, r.id])
  );
  const roles = Object.fromEntries(
    (await query<{ role: string; account_id: string }>(
      'SELECT role, account_id FROM account_roles WHERE entity_id = $1 AND qualifier IS NULL',
      [entityId]
    )).rows.map((r) => [r.role, r.account_id])
  );

  return { tenantId, entityId, userId, fiscalYearId, periodos, cuentas, roles };
}

/** Un asiento de dos líneas, posteado por el camino real. */
async function asiento(
  app: App,
  inq: Inquilino,
  mes: number,
  descripcion: string,
  cargo: string,
  abono: string,
  monto: string
): Promise<void> {
  await app.posting.createJournalEntry(
    inq.entityId,
    fechaEnPeriodo(mes),
    app.tipos.JournalEntryType.STANDARD,
    descripcion,
    [
      { account_id: cargo, debit_amount: monto, credit_amount: null, description: descripcion },
      { account_id: abono, debit_amount: null, credit_amount: monto, description: descripcion },
    ],
    inq.userId,
    { autoPost: true }
  );
}

/** Saldo de una cuenta acumulado sobre TODO el ejercicio, deudor positivo. */
async function saldoDelEjercicio(app: App, inq: Inquilino, cuentaId: string): Promise<Decimal> {
  const { rows } = await app.conexion.query<{ s: string }>(
    `SELECT COALESCE(SUM(ab.debit_total - ab.credit_total), 0)::text AS s
       FROM account_balances ab
       JOIN fiscal_periods fp ON fp.id = ab.fiscal_period_id
      WHERE ab.account_id = $1 AND ab.entity_id = $2 AND fp.fiscal_year_id = $3`,
    [cuentaId, inq.entityId, inq.fiscalYearId]
  );
  return new Decimal(rows[0]?.s ?? 0);
}

// ============================================================
// LAS TRES PRUEBAS SEMBRADAS
//
// No son ejemplos: cada una es un defecto que YA OCURRIÓ en este repositorio y
// que la forma anterior del tablero no podía ver.
// ============================================================

export const PRUEBAS_DE_CONDUCTA: PruebaDeConducta[] = [
  // ----------------------------------------------------------
  // 1 · EL SIGNO DEL SALDO
  //
  // Invertir la resta de `ending_balance` en report-service sobrevivía a las
  // 3 500 unitarias: el banco de pruebas del módulo mockea `query` y una de
  // sus filas RECOMPONE la resta que la consulta declara, así que el mock
  // devolvía el número invertido y la aserción lo confirmaba. Aquí no hay
  // mock: se postea y se le pregunta a la balanza qué número publica.
  // ----------------------------------------------------------
  {
    id: 'saldo-con-signo',
    paquete: 'E0.1',
    enunciado: 'La balanza publica el saldo con el signo del mayor, posteando y preguntando',
    mutantes: [
      {
        archivo: 'src/services/reporting/report-service.ts',
        de: 'COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) AS ending_balance',
        a: 'COALESCE(SUM(COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)), 0) AS ending_balance',
        porque:
          'la resta invertida: el mismo número con el signo cambiado. Una prueba que recompone ' +
          'la resta sobre un mock no lo ve; la balanza de un ejercicio real, sí',
      },
    ],
    correr: async (app) => {
      const inq = await crearInquilino(app, 'S4a · signo del saldo');
      const banco = inq.roles.banco;
      const ventas = inq.cuentas['4100'];
      const costo = inq.cuentas['5100'];
      if (!banco || !ventas || !costo) {
        return falla('el catálogo base no trajo banco / 4100 / 5100: el escenario no se pudo sembrar');
      }

      await asiento(app, inq, 8, 'Venta', banco, ventas, '10000.0000');
      await asiento(app, inq, 8, 'Costo de ventas', costo, banco, '4000.0000');
      await app.posting.drainAttestations(3000);

      // EL CAMINO REAL, el mismo que publican REST, la terminal y el agente.
      const balanza = await app.informes.getTrialBalance(inq.entityId);
      const porId = new Map(balanza.rows.map((r) => [r.account_id, r]));
      const saldo = (id: string): Decimal => new Decimal(porId.get(id)?.ending_balance ?? 'NaN');

      // Convención del mayor: DEUDOR POSITIVO. El ingreso es acreedor, o sea
      // negativo; el gasto y el banco, deudores. Un signo al revés aquí es
      // una utilidad publicada como pérdida.
      const esperado: [string, string, string][] = [
        ['banco', banco, '6000.0000'],
        ['4100 ingresos', ventas, '-10000.0000'],
        ['5100 gastos', costo, '4000.0000'],
      ];
      const desviados = esperado.filter(([, id, v]) => !saldo(id).equals(new Decimal(v)));
      if (desviados.length > 0) {
        return falla(
          'la balanza publica el saldo con otro signo o cifra que el mayor: ' +
            desviados
              .map(([n, id, v]) => `${n} da ${porId.get(id)?.ending_balance ?? '(ausente)'} y debe dar ${v}`)
              .join('; ') +
            '. Deudor POSITIVO es la convención de las tres superficies que publican esta cifra.'
        );
      }

      // Y la balanza tiene que cuadrar por sus dos columnas, no sólo por el neto.
      if (!balanza.totals.is_balanced ||
          !new Decimal(balanza.totals.total_debits).equals(new Decimal('14000.0000'))) {
        return falla(
          `la balanza no cuadra o no suma lo posteado: debe ${balanza.totals.total_debits}, ` +
            `haber ${balanza.totals.total_credits}, esperado 14000.0000 en ambas`
        );
      }
      return ok(
        'posteados 14 000 de movimiento, la balanza publica 4100 en -10000.0000 (acreedor), ' +
          '5100 en 4000.0000 y banco en 6000.0000, y cuadra por las dos columnas'
      );
    },
  },

  // ----------------------------------------------------------
  // 2 · EL BARRIDO DEL CIERRE
  //
  // Con abs() las dos contra-naturales quedaban al DOBLE en vez de en cero y
  // una utilidad de 3 000 se publicaba como pérdida de 2 000. El asiento
  // cuadraba —la línea puente cancelaba el exceso—, así que ninguna
  // verificación de cuadre lo veía. Sólo lo ve el residuo del ejercicio.
  // ----------------------------------------------------------
  {
    id: 'barrido-del-cierre',
    paquete: 'E0.1',
    enunciado: 'Un ejercicio con contra-naturales queda EXACTAMENTE en cero tras cerrar, cerrándolo',
    mutantes: [
      {
        archivo: 'src/services/accounting/period-close.ts',
        de: 'const saldoResumen = new Decimal(barridoIngresos.total).plus(barridoGastos.total);',
        a: 'const saldoResumen = new Decimal(barridoIngresos.total).minus(barridoGastos.total);',
        porque:
          'el neto del ejercicio con el signo del gasto invertido. Es el mutante SILENCIOSO: ' +
          'ingresos y gastos igual quedan en cero, el asiento cuadra, y lo que cambia es la ' +
          'utilidad publicada y el residuo que queda en la 3900 — que verificarQueElEjercicioBarrio ' +
          'no mira porque sólo revisa revenue/expense',
      },
    ],
    correr: async (app) => {
      const inq = await crearInquilino(app, 'S4a · barrido del cierre');
      const necesarias = ['4100', '4400', '5100', '5200', '3900', '3300'];
      const faltan = necesarias.filter((c) => !inq.cuentas[c]);
      if (faltan.length > 0) {
        return falla(`el catálogo base no trae ${faltan.join(', ')}: sin contra-naturales no hay nada que medir`);
      }
      const banco = inq.roles.banco;
      if (!banco) return falla('el catálogo base no trajo la cuenta de banco');

      // Ventas 10 000, devolución sobre ventas 2 000 (4400: revenue de saldo
      // DEUDOR), costo 6 000, devolución sobre compras 1 000 (5200: expense de
      // saldo ACREEDOR). Utilidad real: (10 000 − 2 000) − (6 000 − 1 000) = 3 000.
      await asiento(app, inq, 12, 'Ventas', banco, inq.cuentas['4100'], '10000.0000');
      await asiento(app, inq, 12, 'Devolución sobre ventas', inq.cuentas['4400'], banco, '2000.0000');
      await asiento(app, inq, 12, 'Costo de ventas', inq.cuentas['5100'], banco, '6000.0000');
      await asiento(app, inq, 12, 'Devolución sobre compras', banco, inq.cuentas['5200'], '1000.0000');
      await app.posting.drainAttestations(3000);

      const diciembre = inq.periodos[12];
      try {
        await app.cierre.softClosePeriod(diciembre, inq.entityId, inq.userId);
        await app.cierre.hardClosePeriod(diciembre, inq.entityId, inq.userId, 'cierre del ejercicio');
      } catch (e) {
        // Un cierre que se NIEGA es rojo, no «no se pudo medir»: el escenario
        // se montó, el camino corrió y no dejó el ejercicio cerrado.
        return falla(`el cierre duro se negó o reventó: ${(e as Error).message.slice(0, 220)}`);
      }
      await app.posting.drainAttestations(3000);

      const residuos: string[] = [];
      for (const codigo of ['4100', '4400', '5100', '5200', '3900']) {
        const s = await saldoDelEjercicio(app, inq, inq.cuentas[codigo]);
        if (!s.isZero()) residuos.push(`${codigo} conserva ${s.toFixed(4)}`);
      }
      if (residuos.length > 0) {
        return falla(
          `el barrido no dejó el ejercicio en cero: ${residuos.join('; ')}. ` +
            'Con abs() las contra-naturales quedaban AL DOBLE, que es este mismo síntoma.'
        );
      }

      // La cifra, no sólo el cero: 3 000 de utilidad es saldo ACREEDOR.
      const resultado = await saldoDelEjercicio(app, inq, inq.cuentas['3300']);
      if (!resultado.equals(new Decimal('-3000.0000'))) {
        return falla(
          `las cuentas de resultados barrieron pero la 3300 publica ${resultado.toFixed(4)} ` +
            'y el ejercicio ganó 3 000 (saldo acreedor: -3000.0000). Éste es el defecto que ' +
            'publicaba una utilidad de 3 000 como pérdida de 2 000.'
        );
      }
      return ok(
        'con dos contra-naturales (4400 deudora y 5200 acreedora) el cierre deja 4100/4400/5100/5200/3900 ' +
          'en cero exacto y la 3300 en -3000.0000, la utilidad real del ejercicio'
      );
    },
  },

  // ----------------------------------------------------------
  // 3 · LA FRONTERA DEL INQUILINO
  //
  // Corre como SUPERUSUARIO, con RLS inerte a propósito: lo que se demuestra
  // es la frontera del CÓDIGO. Si aguanta aquí, aguanta también con RLS
  // activa; al revés no. Es la misma decisión que tomó
  // tests/integration/frontera-entidad.int.spec.ts, y por la misma razón: RLS
  // acota por inquilino y sólo si el rol no la ignora, así que apoyarse en
  // ella deja sin probar el único filtro que siempre está.
  //
  // Se tocan LOS TRES brazos de predicadoDe —tabla por tenant_id, tabla por
  // entity_id bajo alcance de entidad, y la misma bajo alcance de inquilino—
  // porque un criterio que sólo ejercita uno bendice al mutante que abre los
  // otros dos. Es la lección del conteo, aplicada a una frontera.
  // ----------------------------------------------------------
  {
    id: 'frontera-de-inquilino',
    paquete: 'E0.1',
    enunciado: 'Una consulta acotada al inquilino A no devuelve ni una fila de B, con dos inquilinos vivos',
    mutantes: [
      {
        archivo: 'src/database/scope.ts',
        de: "return { predicado: 'tenant_id = $2', valor: scope.tenantId };",
        a: "return { predicado: '$2::text IS NOT NULL', valor: scope.tenantId };",
        porque: 'el brazo por tenant_id: el filtro que liga el parámetro y no acota nada',
      },
      {
        archivo: 'src/database/scope.ts',
        de: "return { predicado: 'entity_id = $2', valor: scope.entityId };",
        a: "return { predicado: '$2::text IS NOT NULL', valor: scope.entityId };",
        porque: 'el brazo por entity_id bajo alcance de entidad, el que ya dejó anular una factura ajena',
      },
      {
        archivo: 'src/database/scope.ts',
        de: "predicado: 'entity_id IN (SELECT id FROM legal_entities WHERE tenant_id = $2)',",
        a: "predicado: 'entity_id IN (SELECT id FROM legal_entities WHERE $2::text IS NOT NULL)',",
        porque: 'el brazo de inquilino sobre tabla por entidad: la subconsulta que devuelve TODAS las entidades',
      },
    ],
    correr: async (app) => {
      const { findByIdInScope, entityScope, tenantScope, olvidarAlcances } = app.alcance;
      olvidarAlcances();
      const a = await crearInquilino(app, 'S4a · frontera A');
      const b = await crearInquilino(app, 'S4a · frontera B');

      const bancoB = b.roles.banco;
      const ventasB = b.cuentas['4100'];
      if (!bancoB || !ventasB) return falla('el catálogo base de B no se sembró');
      await asiento(app, b, 8, 'Venta de B', bancoB, ventasB, '7777.0000');
      await app.posting.drainAttestations(3000);

      const { rows: asientosDeB } = await app.conexion.query<{ id: string }>(
        'SELECT id FROM journal_entries WHERE entity_id = $1 ORDER BY created_at LIMIT 1',
        [b.entityId]
      );
      const asientoDeB = asientosDeB[0]?.id;
      if (!asientoDeB) return falla('B no dejó asiento que intentar alcanzar desde A');

      // Desde aquí, TODO se pregunta bajo el contexto de A.
      app.conexion.enterTenant(a.tenantId);

      const fugas: string[] = [];
      // Brazo 1: tabla acotada por tenant_id (users), alcance de inquilino.
      if (await findByIdInScope('users', b.userId, tenantScope(a.tenantId))) {
        fugas.push('users: A alcanza al usuario de B por alcance de inquilino');
      }
      // Brazo 2: tabla por entity_id, alcance de ENTIDAD.
      if (await findByIdInScope('journal_entries', asientoDeB, entityScope(a.tenantId, a.entityId))) {
        fugas.push('journal_entries: A alcanza el asiento de B por alcance de entidad');
      }
      // Brazo 3: la misma tabla, alcance de INQUILINO (subconsulta a legal_entities).
      if (await findByIdInScope('journal_entries', asientoDeB, tenantScope(a.tenantId))) {
        fugas.push('journal_entries: A alcanza el asiento de B por alcance de inquilino');
      }
      // Y el informe: la balanza de A no puede traer una cuenta de B.
      const balanzaDeA = await app.informes.getTrialBalance(a.entityId);
      const cuentasDeB = new Set(Object.values(b.cuentas));
      const intrusas = balanzaDeA.rows.filter((r) => cuentasDeB.has(r.account_id));
      if (intrusas.length > 0) {
        fugas.push(`la balanza de A trae ${intrusas.length} cuenta(s) de B`);
      }
      const movimiento = balanzaDeA.rows.some(
        (r) => !new Decimal(r.debit_total).isZero() || !new Decimal(r.credit_total).isZero()
      );
      if (movimiento) fugas.push('la balanza de A trae movimiento, y A no posteó nada');

      if (fugas.length > 0) {
        return falla(
          `${fugas.length} fuga(s) de inquilino: ${fugas.join('; ')}. ` +
            'Corre como superusuario, con RLS inerte: lo que falla aquí es el filtro del CÓDIGO, ' +
            'que es el único que está siempre.'
        );
      }
      return ok(
        'con dos inquilinos vivos y 7 777.00 posteados sólo en B, los tres brazos de alcance ' +
          '(tenant_id, entity_id por entidad y por inquilino) y la balanza de A devuelven cero filas de B'
      );
    },
  },
];

// ============================================================
// EL PADRE: PEDIRLE AL HIJO
// ============================================================

/** Lo que el hijo deja escrito. */
interface Veredicto {
  resultados?: Record<string, Resultado>;
  motivo?: string;
}

let corrida: Veredicto | null = null;

/**
 * Corre TODAS las pruebas de conducta en un hijo, una sola vez por proceso, y
 * devuelve el resultado de la pedida.
 *
 * Una sola corrida para las tres: el escenario cuesta una creación de base y
 * una migración (~4 s), y pagarlo tres veces sería pagar por nada — cada
 * prueba trabaja sobre su propio inquilino dentro de la misma base efímera,
 * que es lo mismo que hace la suite de integración.
 */
export function correrConducta(id: string): Resultado {
  // NO SE MONTA UNA BASE DESDE DENTRO DE UN RUNNER QUE PROMETIÓ NO TOCAR
  // NINGUNA.
  //
  // tests/plan/criterios.spec.ts ejecuta `evaluar()` de LOS CIENTO VEINTIDÓS
  // criterios para comprobar que su detalle sirve para actuar, y corre en el
  // proyecto unitario, cuyo encabezado dice «rápido, sin base de datos». Sin
  // esta puerta, `npm test` crearía una base y correría sesenta y cinco
  // migraciones de paso. En CI no se vería —el job unitario no tiene Postgres
  // a propósito, así que el hijo fallaría y el criterio saldría no evaluable—
  // y en la máquina de quien desarrolla sí pasaría, en silencio. Es
  // exactamente el defecto que migrate.ts documenta en su propio cerrojo de
  // `require.main`, y se cierra en el MISMO sitio que él: en el lado que
  // arranca el trabajo, no en cada llamador que deba acordarse.
  //
  // La puerta tiene picaporte: con MNEMOSINE_CONDUCTA_EN_PRUEBAS=1 una prueba
  // que SÍ quiera el escenario completo lo pide por su nombre. El arnés de
  // espejos no lo necesita —lanza el hijo él mismo— y la conducta de verdad se
  // mide donde se tiene que medir: en `plan:status`.
  if (process.env.VITEST && !process.env.MNEMOSINE_CONDUCTA_EN_PRUEBAS) {
    return {
      estado: 'no-evaluable',
      detalle:
        'dentro de vitest no se monta la base efímera: el proyecto unitario declara ser rápido y ' +
        'sin base, y montarla aquí haría que `npm test` migrara una base sin decírselo. La ' +
        'conducta se mide en `npm run plan:status` y sus espejos en ' +
        'tests/integration/plan-conducta-mutacion.int.spec.ts; para forzarla, MNEMOSINE_CONDUCTA_EN_PRUEBAS=1.',
    };
  }
  if (!corrida) corrida = invocarHijo();
  if (corrida.motivo !== undefined) {
    return { estado: 'no-evaluable', detalle: corrida.motivo };
  }
  const r = corrida.resultados?.[id];
  if (!r) {
    // El hijo corrió y no trajo esta prueba: es un desajuste del arnés, no una
    // ausencia de entorno. Rojo, para que se arregle en vez de heredarse.
    return {
      estado: 'falla',
      detalle: `el escenario corrió y no devolvió veredicto para «${id}»: el arnés de conducta está desalineado`,
    };
  }
  return r;
}

function invocarHijo(): Veredicto {
  const salida = path.join(os.tmpdir(), `mnemosine-conducta-${crypto.randomBytes(6).toString('hex')}.json`);
  const guion = path.join(RAIZ, 'src', 'plan', 'conducta.ts');
  if (!fs.existsSync(guion)) {
    return { motivo: `no existe ${path.relative(RAIZ, guion)}: el escenario no se puede lanzar` };
  }
  const r = spawnSync('npx', ['tsx', guion, `--salida=${salida}`], {
    cwd: RAIZ,
    encoding: 'utf-8',
    timeout: 240_000,
    // El entorno se hereda ENTERO, DATABASE_URL incluida, y conviene decir por
    // qué no se borra: en una instalación con una sola URL configurada, ésa es
    // también la única candidata a rol administrador, y vaciarla dejaría al
    // hijo sin poder crear su base por un exceso de celo. Lo que impide que el
    // pool acabe apuntando ahí no es esconder la variable —el hijo la
    // sobrescribe con la efímera antes de que exista un `config`— sino el
    // guarda que compara las dos y se niega a medir si no coinciden.
    env: { ...process.env },
  });
  try {
    if (fs.existsSync(salida)) {
      const leido = JSON.parse(fs.readFileSync(salida, 'utf-8')) as Veredicto;
      fs.unlinkSync(salida);
      return leido;
    }
  } catch (e) {
    return { motivo: `el escenario dejó un veredicto ilegible: ${(e as Error).message}` };
  }
  const cola = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' · ').slice(0, 300);
  return {
    motivo:
      `el escenario no llegó a dejar veredicto (código ${r.status ?? 'sin código'}` +
      `${r.error ? `, ${r.error.message}` : ''}): ${cola || 'sin salida'}`,
  };
}

// ============================================================
// EL HIJO: MONTAR, CORRER, DESMONTAR
// ============================================================

function urlConBase(url: string, base: string): string {
  const u = new URL(url);
  u.pathname = `/${base}`;
  return u.toString();
}

/** Prefijo de las bases desechables: sirve para reconocer y barrer huérfanas. */
const PREFIJO = 'mnemosine_plan_ej_';

/**
 * Cuánto tiene que llevar muerta una base para considerarla huérfana.
 *
 * POR QUÉ NO BASTA «SIN CONEXIONES» (auditoría adversarial de S4a). El barrido
 * miraba `pg_stat_activity` y borraba toda base del prefijo que no tuviera
 * conexiones abiertas. Entre que un hijo hace `CREATE DATABASE` y que su
 * migración —que arranca en OTRO proceso, `npx tsx`, con casi un segundo de
 * encendido— se conecta por primera vez, esa base NO TIENE CONEXIONES: es
 * indistinguible de una huérfana. Un segundo hijo que arranque en esa ventana
 * la borra bajo los pies del primero, y el primero muere con «la migración de
 * la base efímera falló … InitPostgres». Comprobado a mano contra este
 * Postgres: recién creada y sin conectar, la consulta del barrido la lista.
 *
 * Se ve con dos sesiones a la vez sobre el mismo clúster, que es exactamente
 * cómo se trabaja en este repositorio. El remedio es que el nombre lleve su
 * hora de nacimiento y que sólo se barra lo que es viejo de verdad: dejar una
 * base muerta sale infinitamente más barato que arrancarle la suya a una
 * corrida viva.
 */
const EDAD_PARA_BARRER_MS = 30 * 60 * 1000;

/** El nombre lleva su hora de nacimiento en base36, y el barrido la lee. */
const nombreEfimero = (): string =>
  `${PREFIJO}${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

/** Milisegundos desde que nació la base, o null si el nombre no lo dice. */
function nacimientoDe(datname: string): number | null {
  const marca = /^mnemosine_plan_ej_([0-9a-z]+)_[0-9a-f]+$/.exec(datname)?.[1];
  if (marca === undefined) return null;
  const ms = parseInt(marca, 36);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

async function main(salida: string): Promise<void> {
  const escribir = (v: Veredicto): void => fs.writeFileSync(salida, JSON.stringify(v), 'utf-8');

  // dotenv aquí y no en config: hay que decidir la URL de ADMINISTRACIÓN antes
  // de que exista un `config`, y config sólo se puede importar cuando
  // DATABASE_URL ya apunta a la base efímera.
  const { default: dotenv } = await import('dotenv');
  dotenv.config();

  const admin =
    process.env.TEST_ADMIN_DATABASE_URL ||
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!admin) {
    escribir({
      motivo:
        'no hay TEST_ADMIN_DATABASE_URL ni MIGRATION_DATABASE_URL ni DATABASE_URL: el escenario ' +
        'necesita un rol que pueda CREATE DATABASE para montar su base desechable',
    });
    return;
  }

  const { default: pg } = await import('pg');
  const nombre = nombreEfimero();
  const raizAdmin = urlConBase(admin, 'postgres');
  let cliente: InstanceType<typeof pg.Client> | null = null;
  try {
    cliente = new pg.Client({ connectionString: raizAdmin, connectionTimeoutMillis: 5000 });
    await cliente.connect();
  } catch (e) {
    escribir({ motivo: `no se pudo conectar al servidor para crear la base efímera: ${(e as Error).message}` });
    return;
  }

  try {
    // Higiene: una corrida que murió a mitad deja su base. Se barren las
    // huérfanas SIN conexiones abiertas Y con media hora cumplida — ver
    // EDAD_PARA_BARRER_MS: «sin conexiones» a secas incluye a la base que otro
    // hijo acaba de crear y todavía no ha conectado. Una base cuyo nombre no
    // declare su hora de nacimiento se deja estar: sólo puede venir de una
    // versión anterior de este archivo, y quedarse corta en la limpieza es un
    // error mucho más barato que borrar la base de una corrida viva.
    const ahora = Date.now();
    const huerfanas = await cliente.query<{ datname: string }>(
      `SELECT d.datname FROM pg_database d
        WHERE d.datname LIKE $1
          AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
      [`${PREFIJO}%`]
    );
    for (const h of huerfanas.rows) {
      const nacio = nacimientoDe(h.datname);
      if (nacio === null || ahora - nacio < EDAD_PARA_BARRER_MS) continue;
      await cliente.query(`DROP DATABASE IF EXISTS ${h.datname}`).catch(() => undefined);
    }
    await cliente.query(`CREATE DATABASE ${nombre}`);
  } catch (e) {
    escribir({
      motivo:
        `el rol de ${raizAdmin.replace(/:[^:@]*@/, ':***@')} no pudo crear la base efímera: ` +
        `${(e as Error).message}. Sin CREATE DATABASE no hay escenario que sembrar.`,
    });
    await cliente.end().catch(() => undefined);
    return;
  }

  const urlEfimera = urlConBase(admin, nombre);
  // La conexión de administración, ya sin nulos: `limpiar` se llama desde
  // cuatro salidas distintas y ninguna debe cargar con un `!`.
  const raiz = cliente;
  const limpiar = async (): Promise<void> => {
    await raiz.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [nombre]
    ).catch(() => undefined);
    await raiz.query(`DROP DATABASE IF EXISTS ${nombre}`).catch(() => undefined);
    await raiz.end().catch(() => undefined);
  };

  // La migración va en su propio proceso, como en el global-setup de
  // integración: migrate.ts corre al importarse cuando es el módulo principal
  // y tiene su propio pool, así que compartirlo con el nuestro sería atarlos.
  const mig = spawnSync('npx', ['tsx', path.join(RAIZ, 'src', 'database', 'migrate.ts')], {
    cwd: RAIZ,
    encoding: 'utf-8',
    timeout: 180_000,
    env: { ...process.env, DATABASE_URL: urlEfimera, MIGRATION_DATABASE_URL: urlEfimera },
  });
  if (mig.status !== 0) {
    const cola = (mig.stderr || mig.stdout || '').trim().split('\n').slice(-3).join(' · ').slice(0, 300);
    escribir({ motivo: `la migración de la base efímera falló: ${cola || 'sin salida'}` });
    await limpiar();
    return;
  }

  // ------------------------------------------------------------
  // EL ESCENARIO YA ESTÁ MONTADO: A PARTIR DE AQUÍ, MORIR ES ROJO.
  //
  // Lo escribe la auditoría adversarial de S4a, y corrige una fuga del propio
  // contrato de este archivo. La cabecera dice —y `criterioDeConducta` lo
  // repite— que un escenario que NO SE PUDO MONTAR es `no-evaluable` y uno
  // MONTADO cuyo camino revienta es `falla`. La implementación sólo cumplía la
  // segunda mitad para las excepciones lanzadas DENTRO de `prueba.correr`: si
  // el hijo moría antes —al importar un módulo de la aplicación, que es lo que
  // pasa cuando `config` estrena una variable obligatoria, cuando un literal
  // queda mal formado o cuando un export deja de existir— no dejaba veredicto,
  // el padre lo leía como «no llegó a montarse» y `bloqueadoPorEntorno` lo
  // excusaba de `--exigir`. Resultado medido: con el motor de cierre roto al
  // importarse, `plan:status --exigir=E0.1` salía con CÓDIGO 0.
  //
  // El remedio no es adivinar la causa desde el padre: es que el hijo declare
  // el rojo EN CUANTO su base existe y está migrada. Cualquier muerte
  // posterior —importación, OOM, SIGKILL, el timeout de spawnSync— deja este
  // veredicto en pie, y el final lo sobrescribe con las cifras de verdad.
  // ------------------------------------------------------------
  escribir({
    resultados: Object.fromEntries(
      PRUEBAS_DE_CONDUCTA.map((p) => [
        p.id,
        {
          estado: 'falla' as const,
          detalle:
            'la base efímera se creó y migró, y el escenario murió antes de dar veredicto: casi ' +
            'siempre un módulo de la aplicación que revienta AL IMPORTARSE. El escenario SÍ se ' +
            'pudo montar, así que esto es rojo y no «aquí no había instrumento»; corre ' +
            '`npx tsx src/plan/conducta.ts --salida=/tmp/v.json` para ver la excepción entera.',
        },
      ])
    ),
  });

  // AHORA, y sólo ahora, se deja que exista un `config`.
  process.env.DATABASE_URL = urlEfimera;
  process.env.MIGRATION_DATABASE_URL = urlEfimera;

  const app: App = {
    conexion: await import('../database/connection.js'),
    posting: await import('../services/accounting/posting.js'),
    cierre: await import('../services/accounting/period-close.js'),
    informes: await import('../services/reporting/report-service.js'),
    contabilidad: await import('../services/accounting/entity-accounting.js'),
    alcance: await import('../database/scope.js'),
    tipos: await import('../types/index.js'),
  };

  const { config } = await import('../config/index.js');
  if (config.database.url !== urlEfimera) {
    // El cinturón del cinturón. Si algún import adelantara a `config`, el pool
    // apuntaría a la base de quien corre el comando y este archivo escribiría
    // en un mayor de verdad. Antes que eso, no se mide.
    // ROJO, y no `no-evaluable`: el propio comentario dice que es un fallo del
    // arnés, y un fallo del arnés no puede cobrar la excusa que `--exigir`
    // reserva para las máquinas sin base. El veredicto provisional de arriba ya
    // dice `falla`; aquí sólo se cambia el detalle por el motivo exacto.
    escribir({
      resultados: Object.fromEntries(
        PRUEBAS_DE_CONDUCTA.map((p) => [
          p.id,
          {
            estado: 'falla' as const,
            detalle:
              'el pool de la aplicación no quedó apuntando a la base efímera: el escenario se ' +
              'cancela para no escribir en la base del despacho. Es un fallo del arnés, no del ' +
              'entorno, y por eso es rojo.',
          },
        ])
      ),
    });
    await limpiar();
    return;
  }

  const resultados: Record<string, Resultado> = {};
  for (const prueba of PRUEBAS_DE_CONDUCTA) {
    try {
      resultados[prueba.id] = await prueba.correr(app);
    } catch (e) {
      // Ver la nota de cabecera: con escenario montado, una excepción del
      // camino real es ROJO. Excusarla como «no evaluable» la sacaría de
      // --exigir, que es justo por donde se escapa un mutante vivo.
      resultados[prueba.id] = {
        estado: 'falla',
        detalle: `el camino real reventó dentro del escenario: ${(e as Error).message.slice(0, 260)}`,
      };
    }
  }
  escribir({ resultados });

  await app.posting.drainAttestations(2000).catch(() => undefined);
  await app.conexion.closeDatabase().catch(() => undefined);
  await limpiar();
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const arg = process.argv.find((a) => a.startsWith('--salida='));
  if (!arg) {
    process.stderr.write('conducta.ts necesita --salida=<archivo.json>\n');
    process.exit(2);
  }
  main(arg.slice('--salida='.length))
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`el escenario de conducta reventó: ${(err as Error).stack}\n`);
      process.exit(1);
    });
}
