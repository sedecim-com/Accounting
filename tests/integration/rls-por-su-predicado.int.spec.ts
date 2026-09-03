import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import {
  SQL_POLITICAS_DIRECTAS,
  SQL_POLITICAS_HIJAS,
  discrimina,
  hijaAnclada,
  type PoliticaDirecta,
  type PoliticaHija,
} from './helpers/rls-censo.js';

/**
 * LA RLS SE PRUEBA POR SU PREDICADO, NO POR SU EXISTENCIA.
 *
 * tenant-isolation.int.spec.ts ya recorre `pg_policy` — pero para comprobar
 * que la política EXISTE. Eso cuenta como puesta una política que no filtra,
 * y una política que existe y no filtra es peor que ninguna: el censo la da
 * por buena.
 *
 * Medido, no supuesto (2026-09-02): cambiando el predicado de
 * `journal_entry_lines`, `invoice_lines` y `bill_lines` a
 * `USING (true OR EXISTS (...))` —es decir, con TODO inquilino leyendo y
 * escribiendo los renglones del mayor, de las facturas y de las cuentas por
 * pagar de TODOS los demás— la suite de integración entera pasaba:
 * 75 archivos, 984 pruebas, exit 0. Ninguna prueba miraba el predicado, y las
 * que miran la conducta sólo tocaban cuatro tablas.
 *
 * Este archivo juzga lo que la política DICE y lo que la política HACE:
 *
 *  1. FORMA · «el predicado discrimina». Cada política directa se evalúa
 *     sobre una fila sintética que lleva los datos de A: bajo A tiene que ser
 *     CIERTA (si no, la política no deja trabajar al dueño) y bajo B y bajo un
 *     inquilino inexistente tiene que ser FALSA. No se buscan formas
 *     prohibidas —una lista escrita a mano se queda corta a la tercera—: se
 *     busca la PROPIEDAD de distinguir al dueño del extraño, ejecutando el
 *     predicado. Da igual cómo esté escrito.
 *
 *  2. FORMA · «la cadena del hijo cuelga de un padre aislado». La política de
 *     hijos no menciona al inquilino a propósito: lo alcanza por el padre. Esa
 *     delegación tiene tres condiciones que el catálogo puede afirmar, y que
 *     se comprueban aquí.
 *
 *  3. CONDUCTA · con dos inquilinos sembrados, lo que A ve y lo que B ve son
 *     conjuntos DISJUNTOS, tabla por tabla, con la lista de tablas derivada
 *     del catálogo de Postgres y no escrita al lado.
 *
 *  4. Las tablas que quedan FUERA del aislamiento son una lista explícita y
 *     justificada. Una tabla nueva sin política no puede colarse como olvido.
 */

// UN ROL POR CORRIDA, no uno fijo. Un rol de Postgres es de nivel CLÚSTER: con
// el nombre fijo, dos corridas de la suite a la vez —dos sesiones sobre el
// mismo servidor, que es cómo se trabaja aquí— compartían el rol y la primera
// que terminaba se lo borraba a la otra con `DROP OWNED BY` en medio de sus
// aserciones. El sufijo aleatorio lo hace privado de esta corrida.
const SONDA = `mnemosine_pred_probe_${randomBytes(4).toString('hex')}`;

/** Un inquilino que no existe y no posee una sola fila en ninguna tabla. */
const FANTASMA = '00000000-0000-4000-8000-00000000f00d';

let admin: pg.Client;
let a: Fixture;
let b: Fixture;
/** Por inquilino: tabla padre -> id de una fila suya. Alimenta el sondeo hijo. */
const padresDe = new Map<string, Map<string, string>>();

/**
 * Tablas FUERA del aislamiento por inquilino, cada una con su razón. El
 * conjunto se compara por igualdad EXACTA contra el catálogo: una tabla nueva
 * sin política falla aquí, y quitarle la política a una de éstas también.
 */
const GLOBALES: Record<string, string> = {
  users: 'el camino de autenticación las lee ANTES de saber de qué inquilino es quien llama',
  sessions: 'ídem: la sesión se resuelve antes de que exista contexto de inquilino',
  identities: 'ídem: identidad federada, se resuelve antes del contexto',
  tenants: 'es la raíz de la jerarquía; filtrarla por sí misma no significa nada',
  migrations: 'el registro del esquema no tiene alcance de inquilino',
  exchange_rates: 'tipos de cambio: dato de mercado, el mismo para todos los inquilinos',
  tax_parameters: 'parámetros fiscales publicados por la autoridad, iguales para todos',
  tax_tables: 'tarifas del ISR publicadas por la autoridad, iguales para todos',
  mx_isn_tasas_estatales:
    'tasas del Impuesto Sobre Nóminas por estado: las publica cada entidad federativa, ' +
    'no el despacho. La declara F07/nómina y entra aquí por la misma razón que tax_tables — ' +
    'un hecho del mundo, no un dato del inquilino.',
  inpc_serie: 'el INPC lo publica el INEGI: es una serie nacional, no del inquilino',
  sat_bancos: 'catálogo de bancos publicado por el SAT, idéntico para todos',
  sat_codigos_agrupadores: 'catálogo de códigos agrupadores del SAT, idéntico para todos',
};

/**
 * Las tablas donde este archivo siembra filas de LOS DOS inquilinos. Es el
 * trinquete contra la vacuidad: la disyunción de dos conjuntos vacíos también
 * es vacía, así que la prueba de conducta sólo dice algo sobre las tablas que
 * de verdad tienen filas de ambos. Si alguien quita la siembra, esto falla.
 */
const NUCLEO_SEMBRADO = [
  'organizations', 'legal_entities', 'fiscal_years', 'fiscal_periods', 'accounts',
  'journal_entries', 'journal_entry_lines',
  'bank_accounts', 'bank_transactions', 'reconciliation_matches',
  'customers', 'invoices', 'invoice_lines',
  'vendors', 'bills', 'bill_lines',
  'inventory_items', 'inventory_layers',
  'ai_sessions', 'ai_messages',
  'xml_documents', 'xml_document_lines',
  'webhook_subscriptions', 'webhook_deliveries',
];

let directas: PoliticaDirecta[] = [];
let hijas: PoliticaHija[] = [];
let aisladas: Array<{ tabla: string; tenantAnulable: boolean }> = [];

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** Ejecuta `sql` con el contexto de inquilino dado, opcionalmente como la sonda. */
async function conContexto<T extends pg.QueryResultRow>(
  tenant: string | null,
  sql: string,
  params: unknown[],
  rol: 'dueno' | 'sonda'
): Promise<T[]> {
  await admin.query('BEGIN');
  try {
    if (tenant !== null) {
      await admin.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenant]);
    }
    if (rol === 'sonda') await admin.query(`SET LOCAL ROLE ${SONDA}`);
    const r = await admin.query<T>(sql, params);
    return r.rows;
  } finally {
    await admin.query('ROLLBACK');
  }
}

/**
 * Evalúa el predicado ALMACENADO sobre una fila SINTÉTICA que lleva `valor` en
 * la columna que la política mira. El truco es una CTE con el nombre de la
 * tabla: el predicado la referencia sin calificar (`tenant_id = ...`) o
 * calificada con el nombre de la tabla (`hijo.fk`, en las de hijos), y en los
 * dos casos la CTE la resuelve. Así no hace falta que la tabla tenga filas:
 * la prueba no puede pasar por vacuidad.
 */
async function evaluar(
  tabla: string, columna: string, predicado: string,
  valor: string | null, tenant: string | null, rol: 'dueno' | 'sonda'
): Promise<boolean | null> {
  const sql =
    `WITH ${ident(tabla)}(${ident(columna)}) AS (VALUES ($1::uuid)) ` +
    `SELECT (${predicado}) AS v FROM ${ident(tabla)}`;
  const filas = await conContexto<{ v: boolean | null }>(tenant, sql, [valor], rol);
  return filas[0]?.v ?? null;
}

/** Identidad de fila que no depende de que la tabla tenga clave primaria simple. */
async function visiblesEn(tabla: string, tenant: string, filtroNoGlobal: boolean): Promise<Set<string>> {
  const donde = filtroNoGlobal ? ' WHERE t.tenant_id IS NOT NULL' : '';
  const filas = await conContexto<{ h: string }>(
    tenant, `SELECT md5(to_jsonb(t)::text) AS h FROM ${ident(tabla)} t${donde}`, [], 'sonda'
  );
  return new Set(filas.map((f) => f.h));
}

/** Siembra una cadena padre->hijo por cada familia, para el inquilino dado. */
async function sembrar(f: Fixture): Promise<void> {
  const padres = new Map<string, string>();
  const cuenta = Object.values(f.cuentas)[0];
  const periodo = f.periodos[8];
  const uno = async (sql: string, params: unknown[]): Promise<string> =>
    (await admin.query<{ id: string }>(sql, params)).rows[0].id;

  const asiento = await uno(
    `INSERT INTO journal_entries (entry_number, entry_type, entity_id, fiscal_period_id, entry_date, created_by)
     VALUES ($1, 'standard', $2, $3, '2026-08-15', $4) RETURNING id`,
    [`PRED-${f.tenantId.slice(0, 8)}`, f.entityId, periodo, f.userId]
  );
  padres.set('journal_entries', asiento);
  await admin.query(
    `INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_amount)
     VALUES ($1, 1, $2, 100.00)`, [asiento, cuenta]
  );

  const banco = await uno(
    `INSERT INTO bank_accounts (entity_id, account_name, bank_name, gl_account_id, currency_code)
     VALUES ($1, 'Operativa predicado', 'Banco', $2, 'MXN') RETURNING id`, [f.entityId, cuenta]
  );
  padres.set('bank_accounts', banco);
  const movimiento = await uno(
    `INSERT INTO bank_transactions (bank_account_id, transaction_date, amount, transaction_type, description)
     VALUES ($1, '2026-08-15', 1160.00, 'credit', 'Depósito predicado') RETURNING id`, [banco]
  );
  padres.set('bank_transactions', movimiento);
  await admin.query(
    `INSERT INTO reconciliation_matches
       (bank_transaction_id, match_type, matched_entity_type, matched_entity_id, matched_amount)
     VALUES ($1, 'manual', 'invoice', gen_random_uuid(), 1160.00)`, [movimiento]
  );

  const cliente = await uno(
    `INSERT INTO customers (entity_id, customer_number, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [f.entityId, `CLI-${f.tenantId.slice(0, 8)}`, f.userId]
  );
  padres.set('customers', cliente);
  const factura = await uno(
    `INSERT INTO invoices (entity_id, invoice_number, customer_id, invoice_date, due_date, amount_due, created_by)
     VALUES ($1, $2, $3, '2026-08-15', '2026-09-15', 1160.00, $4) RETURNING id`,
    [f.entityId, `FAC-${f.tenantId.slice(0, 8)}`, cliente, f.userId]
  );
  padres.set('invoices', factura);
  await admin.query(
    `INSERT INTO invoice_lines (invoice_id, line_number, unit_price, revenue_account_id, line_amount, total_amount)
     VALUES ($1, 1, 1000.00, $2, 1000.00, 1160.00)`, [factura, cuenta]
  );

  const proveedor = await uno(
    `INSERT INTO vendors (entity_id, vendor_number, company_name, created_by) VALUES ($1, $2, 'Proveedor', $3) RETURNING id`,
    [f.entityId, `PRO-${f.tenantId.slice(0, 8)}`, f.userId]
  );
  padres.set('vendors', proveedor);
  const cuentaPorPagar = await uno(
    `INSERT INTO bills (entity_id, bill_number, vendor_id, bill_date, due_date, amount_due, created_by)
     VALUES ($1, $2, $3, '2026-08-15', '2026-09-15', 580.00, $4) RETURNING id`,
    [f.entityId, `CXP-${f.tenantId.slice(0, 8)}`, proveedor, f.userId]
  );
  padres.set('bills', cuentaPorPagar);
  await admin.query(
    `INSERT INTO bill_lines (bill_id, line_number, account_id, unit_price, line_amount, total_amount)
     VALUES ($1, 1, $2, 500.00, 500.00, 580.00)`, [cuentaPorPagar, cuenta]
  );

  const articulo = await uno(
    `INSERT INTO inventory_items
       (entity_id, item_code, item_name, costing_method, inventory_account_id, cogs_account_id, revenue_account_id)
     VALUES ($1, $2, 'Artículo', 'fifo', $3, $3, $3) RETURNING id`,
    [f.entityId, `ART-${f.tenantId.slice(0, 8)}`, cuenta]
  );
  padres.set('inventory_items', articulo);
  await admin.query(
    `INSERT INTO inventory_layers (item_id, acquired_date, quantity, remaining_quantity, unit_cost, total_cost)
     VALUES ($1, '2026-08-15', 10, 10, 25.00, 250.00)`, [articulo]
  );

  const sesionIa = await uno(
    `INSERT INTO ai_sessions (tenant_id, entity_id, provider, model)
     VALUES ($1, $2, 'anthropic', 'claude') RETURNING id`, [f.tenantId, f.entityId]
  );
  padres.set('ai_sessions', sesionIa);
  await admin.query(
    `INSERT INTO ai_messages (session_id, seq, role, content) VALUES ($1, 1, 'user', 'hola')`, [sesionIa]
  );

  const xml = await uno(
    `INSERT INTO xml_documents
       (entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha, emisor_rfc, receptor_rfc,
        subtotal, total, xml_content, xml_hash, import_source)
     VALUES ($1, 'cfdi_ingreso', $2, '4.0', '2026-08-15T12:00:00Z', 'AAA010101AAA', 'BBB010101BBB',
             1000.00, 1160.00, '<x/>', $3, 'manual_upload') RETURNING id`,
    [f.entityId, `UUID-${f.tenantId.slice(0, 18)}`, f.tenantId.replace(/-/g, '').repeat(2)]
  );
  padres.set('xml_documents', xml);
  await admin.query(
    `INSERT INTO xml_document_lines
       (xml_document_id, line_number, clave_prod_serv, clave_unidad, descripcion, cantidad, valor_unitario, importe)
     VALUES ($1, 1, '01010101', 'H87', 'Concepto', 1, 1000.00, 1000.00)`, [xml]
  );

  const suscripcion = await uno(
    `INSERT INTO webhook_subscriptions (tenant_id, url, events, secret)
     VALUES ($1, 'https://ejemplo.test/hook', ARRAY['invoice.posted'], 'secreto') RETURNING id`, [f.tenantId]
  );
  padres.set('webhook_subscriptions', suscripcion);
  await admin.query(
    `INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1, 'invoice.posted', '{}'::jsonb)`,
    [suscripcion]
  );

  padresDe.set(f.tenantId, padres);
}

beforeAll(async () => {
  a = await crearInquilino('Predicado A');
  b = await crearInquilino('Predicado B');

  admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SONDA}') THEN
      CREATE ROLE ${SONDA} NOLOGIN NOBYPASSRLS;
    END IF;
  END $$;`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${SONDA}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${SONDA}`);
  await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${SONDA}`);

  await sembrar(a);
  await sembrar(b);

  // Todo lo que sigue sale del catálogo: ninguna lista de tablas escrita al lado.
  directas = (await admin.query<PoliticaDirecta>(SQL_POLITICAS_DIRECTAS)).rows;

  hijas = (await admin.query<PoliticaHija>(SQL_POLITICAS_HIJAS)).rows;

  aisladas = (await admin.query<{ tabla: string; tenantAnulable: boolean }>(`
    SELECT c.relname AS tabla,
           EXISTS (SELECT 1 FROM pg_attribute a2 WHERE a2.attrelid = c.oid
                     AND a2.attname = 'tenant_id' AND a2.attnum > 0
                     AND NOT a2.attisdropped AND NOT a2.attnotnull) AS "tenantAnulable"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                    AND p.polname LIKE 'tenant_isolation%')
    ORDER BY 1`)).rows;
}, 120_000);

afterAll(async () => {
  if (admin) {
    // El rol es de nivel clúster y sobrevive a la base efímera.
    await admin.query(`DROP OWNED BY ${SONDA}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${SONDA}`).catch(() => undefined);
    await admin.end();
  }
  await closeDatabase();
});

describe('forma · el predicado discrimina entre el dueño y el extraño', () => {
  it('el montaje trae políticas que juzgar', () => {
    expect(directas.length, 'sin políticas directas no hay nada que probar').toBeGreaterThan(50);
    expect(hijas.length, 'sin políticas de hijos no hay nada que probar').toBeGreaterThan(10);
  });

  it('cada política directa deja pasar al dueño y rechaza a los demás', async () => {
    const rotas: string[] = [];
    for (const p of directas) {
      // SIN COLUMNA NO HAY DISCRIMINACIÓN, y no hace falta ejecutar nada para
      // saberlo: un predicado que no lee ninguna columna de su tabla da el
      // mismo valor para todas sus filas. `USING (true)` y `USING (1 = 1)` son
      // exactamente eso, y hasta la auditoría de S4a ni siquiera aparecían en
      // el censo — el JOIN interno por la columna las borraba de la lista.
      if (!discrimina(p)) {
        rotas.push(
          `${p.tabla}: la política no depende de NINGUNA columna de la tabla, así que no puede ` +
          `distinguir al dueño del extraño\n      ${p.predicado}`
        );
        continue;
      }
      const mio = p.columna === 'tenant_id' ? a.tenantId : a.entityId;
      // Bajo el dueño tiene que ser CIERTA: una política que no deja trabajar
      // al dueño también está rota, y se descubre en producción, no aquí.
      const propio = await evaluar(p.tabla, p.columna, p.predicado, mio, a.tenantId, 'dueno');
      // Bajo OTRO inquilino real y bajo uno inexistente tiene que ser FALSA.
      const ajeno = await evaluar(p.tabla, p.columna, p.predicado, mio, b.tenantId, 'dueno');
      const fantasma = await evaluar(p.tabla, p.columna, p.predicado, mio, FANTASMA, 'dueno');
      const sinContexto = await evaluar(p.tabla, p.columna, p.predicado, mio, null, 'dueno');
      // Postgres admite la fila SÓLO si el USING da TRUE: NULL y FALSE bloquean
      // por igual. Sin contexto, `tenant_id = app_current_tenant()` da NULL
      // —comparar con NULL no da falso—, y eso es correcto. Por eso el criterio
      // del extraño es «no sea CIERTO», no «sea falso».
      if (propio !== true || ajeno === true || fantasma === true || sinContexto === true) {
        rotas.push(
          `${p.tabla}(${p.columna}): dueño=${propio} ajeno=${ajeno} ` +
          `inexistente=${fantasma} sin-contexto=${sinContexto}\n      ${p.predicado}`
        );
      }
    }
    expect(
      rotas,
      'Políticas cuyo predicado NO distingue al dueño del extraño ' +
      '(o que no dejan pasar al dueño):\n  ' + rotas.join('\n  ')
    ).toEqual([]);
  });

  it('la sonda caza las formas inofensivas: un predicado que no filtra no pasa', async () => {
    // LA PRUEBA DE QUE LA PRUEBA PRUEBA.
    //
    // No se comprueba contra una lista de formas PROHIBIDAS —esa lista se
    // queda corta a la tercera—, sino que se comprueba que el criterio
    // «distingue al dueño del extraño» rechaza quince maneras distintas de
    // escribir una política inofensiva. Si alguien inventa la decimosexta, el
    // criterio la caza igual, porque mira la propiedad y no el texto.
    //
    // POR QUÉ CADA FORMA VIAJA POR EL CENSO (corregido en la auditoría de S4a).
    // Antes se creaban sobre una tabla TEMPORAL y su predicado se leía con
    // pg_get_expr y se le pasaba al juez a mano — es decir, por un camino que
    // las políticas de verdad NO recorren. Y el censo era donde estaba la
    // fuga: con un JOIN interno por la columna de la que la política depende,
    // `USING (true)` y `USING (1 = 1)` —que no dependen de ninguna— no
    // aparecían en la lista y no se juzgaban nunca. La prueba de la prueba
    // pasaba mientras la prueba tenía un agujero. Ahora la tabla es real, la
    // política se llama como las de verdad, y se recupera con el MISMO SQL.
    const formas = [
      'true',
      'true OR (tenant_id = public.app_current_tenant())',
      '(tenant_id = public.app_current_tenant()) OR true',
      '1 = 1',
      'tenant_id IS NOT NULL',
      'tenant_id = tenant_id',
      'NOT (tenant_id <> public.app_current_tenant()) OR true',
      '(SELECT true)',
      'tenant_id = ANY (SELECT id FROM public.tenants)',
      'tenant_id IN (SELECT id FROM public.tenants WHERE is_active)',
      'CASE WHEN tenant_id IS NULL THEN false ELSE true END',
      "coalesce(tenant_id = public.app_current_tenant(), true) OR tenant_id IS NOT NULL",
      "tenant_id::text <> ''",
      'length(tenant_id::text) = 36',
      "tenant_id IS NOT NULL AND tenant_id::text ~ '^[0-9a-f]'",
    ];

    /** Crea la política como REAL y devuelve lo que el censo dice de ella. */
    const censar = async (using: string): Promise<PoliticaDirecta | undefined> => {
      await admin.query('DROP POLICY IF EXISTS tenant_isolation ON juguete');
      await admin.query(`CREATE POLICY tenant_isolation ON juguete FOR ALL USING (${using})`);
      const filas = (await admin.query<PoliticaDirecta>(SQL_POLITICAS_DIRECTAS)).rows;
      return filas.find((f) => f.tabla === 'juguete');
    };

    await admin.query('DROP TABLE IF EXISTS juguete');
    await admin.query('CREATE TABLE juguete (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL)');
    await admin.query('ALTER TABLE juguete ENABLE ROW LEVEL SECURITY');
    const escapadas: string[] = [];
    try {
      for (const forma of formas) {
        const vista = await censar(forma);
        if (vista === undefined) {
          escapadas.push(`${forma}   ← el censo no la trajo siquiera`);
          continue;
        }
        if (!discrimina(vista)) continue;   // cazada por forma, sin ejecutar nada
        const propio = await evaluar('juguete', vista.columna, vista.predicado, a.tenantId, a.tenantId, 'dueno');
        const ajeno = await evaluar('juguete', vista.columna, vista.predicado, a.tenantId, b.tenantId, 'dueno');
        if (propio === true && ajeno !== true) escapadas.push(forma);
      }
      // Y el control: la forma CORRECTA tiene que pasar, o el criterio estaría
      // rechazándolo todo y no probaría nada.
      const buena = await censar('tenant_id = public.app_current_tenant()');
      expect(buena?.columna, 'el censo perdió la política legítima').toBe('tenant_id');
      expect(await evaluar('juguete', 'tenant_id', buena!.predicado, a.tenantId, a.tenantId, 'dueno')).toBe(true);
      expect(await evaluar('juguete', 'tenant_id', buena!.predicado, a.tenantId, b.tenantId, 'dueno')).not.toBe(true);
    } finally {
      await admin.query('DROP TABLE IF EXISTS juguete');
    }
    expect(
      escapadas,
      'Formas de política inofensiva que la sonda NO cazó:\n  ' + escapadas.join('\n  ')
    ).toEqual([]);
  }, 60_000);
});

describe('forma · la cadena del hijo cuelga de un padre aislado', () => {
  it('el padre de cada política de hijos está aislado y forzado', () => {
    // La política de hijos NO menciona al inquilino a propósito: lo alcanza a
    // través del padre, y el padre filtra la subconsulta para el rol que
    // pregunta. Si el padre pierde RLS, o la pierde FORZADA (el dueño de la
    // tabla la ignoraría), o se queda sin política, el hijo deja de aislar sin
    // que su propio predicado cambie ni una letra.
    const sueltas = hijas
      .filter((h) => !hijaAnclada(h) || !h.padreRls || !h.padreForce || !h.padreAislado)
      .map((h) =>
        !hijaAnclada(h)
          // Misma fuga que en las directas: sin dependencia de columna ni de
          // tabla padre, el predicado no cuelga de nada y no aísla nada.
          ? `${h.hijo}: la política no depende de ninguna columna ni de ninguna tabla padre — ` +
            `no delega el aislamiento en nadie: ${h.predicado}`
          : `${h.hijo} -> ${h.padre} (rls=${h.padreRls} force=${h.padreForce} aislado=${h.padreAislado})`
      );
    expect(
      sueltas,
      'Políticas de hijos ancladas a un padre que no aísla:\n  ' + sueltas.join('\n  ')
    ).toEqual([]);
  });

  it('la llave ajena de la que cuelga el hijo es NOT NULL', () => {
    // ESTA es la trampa que costó `reconciliation_matches`: colgaba de
    // `reconciliation_session_id`, columna ANULABLE que sus dos escritores
    // insertaban siempre en NULL. Con `FOR ALL USING` sin `WITH CHECK`, el
    // USING hace también de comprobación del INSERT: con la llave nula el
    // EXISTS es falso y NINGUNA fila se podía insertar bajo un rol sujeto a
    // RLS. Una llave anulable convierte la política en un candado a la puerta
    // de salida. El catálogo lo sabe; nadie se lo había preguntado.
    const anulables = hijas
      .filter((h) => hijaAnclada(h) && !h.fkNotNull)
      .map((h) => `${h.hijo}.${h.fk} -> ${h.padre}`);
    expect(
      anulables,
      'Políticas de hijos colgadas de una llave ANULABLE (bloquean el INSERT legítimo):\n  ' +
      anulables.join('\n  ')
    ).toEqual([]);
  });

  it('el predicado del hijo es falso para una llave que no existe', async () => {
    // Bajo cualquier contexto, un hijo que apunta a un padre inexistente no
    // puede ser visible. Un `true OR ...` lo haría visible igual.
    const rotas: string[] = [];
    for (const h of hijas) {
      if (!hijaAnclada(h)) continue;   // ya acusada arriba; no tiene fk que sondear
      const v = await evaluar(h.hijo, h.fk, h.predicado, FANTASMA, a.tenantId, 'sonda');
      if (v === true) rotas.push(`${h.hijo}.${h.fk}: llave inexistente -> ${v}\n      ${h.predicado}`);
    }
    expect(
      rotas,
      'Políticas de hijos que admiten una fila colgada de la nada:\n  ' + rotas.join('\n  ')
    ).toEqual([]);
  });

  it('el predicado del hijo distingue el padre propio del ajeno', async () => {
    // La mitad que la comprobación anterior no cubre: con la llave apuntando a
    // un padre REAL de A, cierto bajo A y falso bajo B. Se corre como la
    // SONDA, no como dueño: es la política del PADRE la que filtra la
    // subconsulta, y un superusuario la haría inerte — que es exactamente por
    // lo que la suite entera no vio nunca este agujero.
    const rotas: string[] = [];
    let cubiertas = 0;
    for (const h of hijas) {
      if (!hijaAnclada(h)) continue;   // ya acusada arriba; no tiene fk que sondear
      const padreA = padresDe.get(a.tenantId)?.get(h.padre);
      if (padreA === undefined) continue;   // familia no sembrada: no se afirma nada
      cubiertas += 1;
      const propio = await evaluar(h.hijo, h.fk, h.predicado, padreA, a.tenantId, 'sonda');
      const ajeno = await evaluar(h.hijo, h.fk, h.predicado, padreA, b.tenantId, 'sonda');
      const sinContexto = await evaluar(h.hijo, h.fk, h.predicado, padreA, null, 'sonda');
      if (propio !== true || ajeno === true || sinContexto === true) {
        rotas.push(
          `${h.hijo}.${h.fk} -> ${h.padre}: dueño=${propio} ajeno=${ajeno} sin-contexto=${sinContexto}`
        );
      }
    }
    expect(
      rotas,
      'Políticas de hijos que no distinguen el padre propio del ajeno:\n  ' + rotas.join('\n  ')
    ).toEqual([]);
    // Trinquete: si la siembra se cae, esta prueba pasaría por vacuidad.
    expect(cubiertas, 'la siembra tiene que cubrir la mayoría de las familias de hijos')
      .toBeGreaterThanOrEqual(10);
  });
});

describe('conducta · lo que ve A y lo que ve B son conjuntos disjuntos', () => {
  it('ninguna tabla aislada enseña a A una sola fila de B', async () => {
    const fugas: string[] = [];
    for (const t of aisladas) {
      // Las filas con tenant_id NULL son globales a propósito (anclas de
      // bitcoin): las ven los dos y no son una fuga. Se excluyen del cotejo y
      // se afirman aparte, más abajo.
      const vistoPorA = await visiblesEn(t.tabla, a.tenantId, t.tenantAnulable);
      const vistoPorB = await visiblesEn(t.tabla, b.tenantId, t.tenantAnulable);
      const comunes = [...vistoPorA].filter((h) => vistoPorB.has(h));
      if (comunes.length > 0) fugas.push(`${t.tabla}: ${comunes.length} fila(s) visibles para los dos`);
    }
    expect(
      fugas,
      'Tablas donde dos inquilinos ven la MISMA fila:\n  ' + fugas.join('\n  ')
    ).toEqual([]);
  });

  it('ningún inquilino inexistente ve una sola fila en ninguna tabla', async () => {
    const fugas: string[] = [];
    for (const t of aisladas) {
      const visto = await visiblesEn(t.tabla, FANTASMA, t.tenantAnulable);
      if (visto.size > 0) fugas.push(`${t.tabla}: ${visto.size} fila(s)`);
    }
    expect(
      fugas,
      'Tablas que enseñan filas a un inquilino que no posee nada:\n  ' + fugas.join('\n  ')
    ).toEqual([]);
  });

  it('el núcleo sembrado tiene filas de LOS DOS: la disyunción no pasa por vacía', async () => {
    // Sin esto, borrar la siembra dejaría verde la prueba de arriba: dos
    // conjuntos vacíos también son disjuntos. Es el mismo modo de fallo que el
    // criterio E0.1 y que el trinquete de cobertura en cero.
    const vacias: string[] = [];
    for (const tabla of NUCLEO_SEMBRADO) {
      const nA = (await visiblesEn(tabla, a.tenantId, false)).size;
      const nB = (await visiblesEn(tabla, b.tenantId, false)).size;
      if (nA === 0 || nB === 0) vacias.push(`${tabla}: A=${nA} B=${nB}`);
    }
    expect(
      vacias,
      'Tablas del núcleo sin filas de los dos inquilinos (la prueba de disyunción sería vacua):\n  ' +
      vacias.join('\n  ')
    ).toEqual([]);
  });
});

describe('las excepciones al aislamiento son explícitas', () => {
  it('la lista de tablas fuera del aislamiento es exactamente la declarada', async () => {
    // Una tabla nueva sin política no puede colarse como olvido: para salir de
    // aquí en verde hay que ESCRIBIR la razón en GLOBALES, arriba.
    const fuera = (await admin.query<{ tabla: string }>(`
      SELECT c.relname AS tabla
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
        AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                          AND p.polname LIKE 'tenant_isolation%')
      ORDER BY 1`)).rows.map((r) => r.tabla);
    expect(fuera.sort()).toEqual(Object.keys(GLOBALES).sort());
  });

  it('cada excepción global lleva su razón escrita', () => {
    const mudas = Object.entries(GLOBALES).filter(([, razon]) => razon.trim().length < 20);
    expect(mudas.map(([t]) => t), 'excepciones sin justificar').toEqual([]);
  });

  it('la ventana sin-contexto de ai_webhook_tokens no se abre con contexto puesto', async () => {
    // `webhook_token_auth` es la única política PERMISIVA que no menciona al
    // inquilino, y es deliberada: el receptor de webhooks verifica el token
    // ANTES de saber de qué inquilino es. La migración 028 la escribió como
    // `USING (true)` y la 030 la estrechó, porque una permisiva se suma con OR
    // a tenant_isolation y le abría a cualquier inquilino los tokens de todos.
    // Esto ancla el estrechamiento: con contexto puesto, la ventana está
    // cerrada y sólo queda tenant_isolation.
    const q = (await admin.query<{ q: string }>(`
      SELECT pg_get_expr(polqual, polrelid) AS q FROM pg_policy
      WHERE polrelid = 'ai_webhook_tokens'::regclass AND polname = 'webhook_token_auth'`)).rows[0];
    expect(q, 'la política pre-autenticación de webhooks desapareció').toBeDefined();
    const conContextoPuesto = await conContexto<{ v: boolean | null }>(
      a.tenantId, `SELECT (${q.q}) AS v`, [], 'dueno'
    );
    expect(conContextoPuesto[0].v, 'con inquilino puesto la ventana pre-auth tiene que estar cerrada').toBe(false);
    const sinContexto = await conContexto<{ v: boolean | null }>(
      null, `SELECT (${q.q}) AS v`, [], 'dueno'
    );
    expect(sinContexto[0].v, 'sin contexto la ventana pre-auth tiene que abrirse').toBe(true);
  });
});
