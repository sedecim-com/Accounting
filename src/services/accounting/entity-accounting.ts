import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { ensureBaseChart } from './chart-seed.js';
import { seedAccountRoles, type SeedResult } from '../xml-ingestion/account-roles-seed.js';
import { esContabilidadMexicana } from './pais-contable.js';
import { getPolicy } from '../policy/policy-service.js';
import {
  seedPayrollAccountMapping,
  type PayrollSeedResult,
} from '../payroll/common/payroll-account-mapping-seed.js';

/**
 * Deja una entidad lista para contabilizar: catálogo de cuentas base y la
 * capa semántica de account_roles que traduce «cxc» o «iva_acreditable» a un
 * código concreto.
 *
 * Existe porque `mnemosine init` creaba la entidad sin catálogo y sin roles,
 * de modo que postInvoiceEntry/postBillEntry/postCustomerPaymentEntry/
 * postVendorPaymentEntry fallaban con MISSING_ROLE_ACCOUNT en la primera
 * factura, sin más salida que insertar filas a mano.
 *
 * Estrategia del catálogo (decisión configurable, ver `estrategia`):
 * - 'auto' (por defecto): crea el catálogo base SOLO si la entidad no tiene
 *   ninguna cuenta. Una entidad nacida en mnemosine recibe el plan completo;
 *   una que llegó por onboarding desde otro sistema conserva el suyo y solo
 *   se le mapean los roles que puedan resolverse.
 * - 'siempre': crea las cuentas base que falten aunque ya haya catálogo.
 * - 'nunca': no toca el catálogo; solo mapea roles.
 *
 * Idempotente en las tres variantes. No abre transacción propia si recibe
 * `client`: el alta de entidad siembra todo en un solo acto.
 */
export type EstrategiaCatalogo = 'auto' | 'siempre' | 'nunca';

export interface ResultadoContabilidad extends SeedResult {
  /** Códigos del catálogo base creados en esta pasada. */
  cuentasBaseCreadas: string[];
  estrategiaAplicada: EstrategiaCatalogo;
  /** true si la entidad ya tenía cuentas antes de esta pasada. */
  teniaCatalogo: boolean;
  /** Cuentas y buckets de nómina sembrados en el mismo acto. */
  nomina: PayrollSeedResult;
}

export async function ensureEntityAccounting(
  entityId: string,
  tenantId: string,
  createdBy: string,
  options: { client?: pg.PoolClient; estrategia?: EstrategiaCatalogo } = {}
): Promise<ResultadoContabilidad> {
  const estrategia = options.estrategia ?? 'auto';

  const run = async (client: pg.PoolClient): Promise<ResultadoContabilidad> => {
    const { rows } = await client.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM accounts WHERE entity_id = $1',
      [entityId]
    );
    const teniaCatalogo = Number(rows[0]?.n ?? '0') > 0;

    // El PAÍS se lee ANTES de sembrar nada, no al final para la nómina.
    //
    // Se leía aquí abajo y sólo para escoger el catálogo de nómina, de modo
    // que el catálogo base y los roles del CFDI ya habían pasado: una entidad
    // estadounidense recibía el plan de cuentas mexicano completo —IVA
    // Acreditable, IVA Trasladado, ISR por Pagar, un banco en pesos— y los
    // diecisiete renglones de la taxonomía del CFDI, que no puede usar.
    const { rows: datos } = await client.query<{
      incorporation_country: string | null;
      accounting_standard: string | null;
    }>(
      'SELECT incorporation_country, accounting_standard FROM legal_entities WHERE id = $1',
      [entityId]
    );
    const pais = datos[0]?.incorporation_country ?? 'MX';
    const esMexicana = esContabilidadMexicana(pais, datos[0]?.accounting_standard);

    // QUÉ recibe una entidad no mexicana es criterio del despacho, no del
    // código: puede querer el catálogo de la casa para que postee desde el
    // primer día, o dejarla vacía porque va a importar el suyo. La política lo
    // decide; el default siembra, porque una entidad que no puede postear es
    // peor que una con cuatro renglones que no usa.
    const catalogoExtranjero = esMexicana
      ? 'base_neutro'
      : (await getPolicy({ tenantId, entityId }, 'catalogo_entidad_no_mexicana', client)).value;

    // EL INTERRUPTOR LLEGA AL CATÁLOGO BASE Y A NADA MÁS, A PROPÓSITO.
    //
    // Con 'ninguno' la entidad NO nace vacía: nace con dieciséis cuentas
    // —siete de los roles y nueve de la nómina estadounidense— porque las dos
    // semillas de abajo corren igual. Extenderles el interruptor sonaría más
    // fiel a la palabra «ninguno» y dejaría payroll_account_mapping sin una
    // sola fila: esa tabla no tiene otro escritor en tiempo de ejecución —sólo
    // esta semilla y la migración 049 que la sembró de golpe—, así que la
    // primera corrida moriría con «Missing payroll_account_mapping for bucket:
    // wages_expense» en vez de con el bucket que sí falta. Porque falta uno:
    // bajo 'ninguno', `cash_payroll` —obligatorio junto a wages_expense y
    // payroll_tax_expense, ver gl-posting-service— apunta a 1111/1115, que las
    // crea el catálogo base y sólo él. La primera nómina falla igual; lo que
    // cambia es que falla nombrando UN bucket en vez de todos, y `entity
    // create` ya lo avisa por su nombre al sembrar.
    //
    // account_roles sí tiene otro escritor —account-roles-service, detrás de
    // `account map`—, así que ahí el argumento no es que nadie más escriba,
    // sino que sin la semilla la primera factura muere con MISSING_ROLE_ACCOUNT
    // antes de que nadie llegue a mapear a mano.
    //
    // Lo que se corrigió es el TEXTO de la opción, que prometía «no chart» y
    // «I seed nothing»: quien la escoge ha de saber que importará el catálogo
    // sobre una entidad que ya trae esas dieciséis. Ver pending-catalog.ts.
    const crearBase =
      catalogoExtranjero !== 'ninguno' &&
      (estrategia === 'siempre' || (estrategia === 'auto' && !teniaCatalogo));

    const cuentasBaseCreadas = crearBase
      ? await ensureBaseChart(client, entityId, createdBy, esMexicana)
      : [];

    // Los roles se siembran SIEMPRE: es lo que traduce semántica a códigos, y
    // sobre un catálogo ajeno al menos mapea lo que sí exista y reporta el resto.
    // Lo que ramifica por país es CUÁLES, no si se siembran: catorce de los
    // treinta y un roles apuntan a códigos del catálogo base y ar-ap-posting
    // los exige en toda factura, así que quitárselos a una entidad extranjera
    // la dejaría sin postear.
    const roles = await seedAccountRoles(entityId, tenantId, createdBy, { client, esMexicana });

    // El mapeo de nómina se siembra en el mismo acto y por la misma razón: la
    // tabla tenía lector y ningún escritor, así que la primera corrida de
    // nómina de cualquier entidad moría con «Missing payroll_account_mapping».
    // Va aquí, no en el asistente, para que TODA ruta de alta lo obtenga.
    const nomina = await seedPayrollAccountMapping(
      entityId,
      tenantId,
      pais,
      createdBy,
      { client }
    );

    return {
      ...roles,
      cuentasBaseCreadas,
      estrategiaAplicada: estrategia,
      teniaCatalogo,
      nomina,
    };
  };

  return options.client ? run(options.client) : withTransaction(run);
}

/**
 * Diagnóstico: roles que ningún código del catálogo puede satisfacer. Es lo
 * que `mnemosine doctor` reporta y lo que distingue «la entidad no está
 * sembrada» de «el catálogo del cliente no tiene esa cuenta».
 */
export async function rolesSinMapear(
  entityId: string
): Promise<Array<{ role: string; code: string }>> {
  const { rolesPara } = await import('../xml-ingestion/account-roles-seed.js');
  const { query } = await import('../../database/connection.js');

  // El diagnóstico tiene que preguntar por los roles que a ESTA entidad le
  // tocan. Con ROLE_MAP a secas, una entidad estadounidense aparecía con doce
  // roles «sin mapear» —IEPS, retenciones, IMSS— que no debe tener: un
  // reporte que exige lo que no aplica enseña a ignorar el reporte.
  const { rows: datos } = await query<{
    incorporation_country: string | null;
    accounting_standard: string | null;
  }>(
    'SELECT incorporation_country, accounting_standard FROM legal_entities WHERE id = $1',
    [entityId]
  );
  const esMexicana = esContabilidadMexicana(
    datos[0]?.incorporation_country,
    datos[0]?.accounting_standard
  );

  const mapeados = await query<{ role: string }>(
    'SELECT role FROM account_roles WHERE entity_id = $1 AND qualifier IS NULL',
    [entityId]
  );
  const yaEstan = new Set(mapeados.rows.map((r) => r.role));
  return Object.entries(rolesPara(esMexicana))
    .filter(([role]) => !yaEstan.has(role))
    .map(([role, code]) => ({ role, code: String(code) }));
}
