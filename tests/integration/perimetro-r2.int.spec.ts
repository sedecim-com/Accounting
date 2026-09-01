import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { entityScope, tenantScope } from '../../src/database/scope.js';
import { getCustomerById, updateCustomer } from '../../src/services/ar/customer-service.js';
import { createWebhook, deleteWebhook, listWebhooks } from '../../src/services/webhooks/webhook-service.js';
import { consultaPublica } from '../../src/database/consulta-publica.js';
import { ValidationError } from '../../src/utils/errors.js';

/**
 * EL PERÍMETRO QUE FALTABA (R2).
 *
 * Tres bordes del mismo commit: las contrapartes por id llevan la frontera
 * dentro del SQL (conocer un UUID no basta), el ciclo de webhooks está
 * acotado por inquilino y su URL vigilada, y la verificación pública corre
 * por el rol verificador — nunca empujando al despliegue con BYPASSRLS.
 */

let a: Fixture;
let b: Fixture;
let clienteDeA: string;

beforeAll(async () => {
  a = await crearInquilino('Perímetro A');
  b = await crearInquilino('Perímetro B');
  clienteDeA = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, email, is_active, created_by)
     VALUES ($1, $2, 'CUST-R2-1', 'Cliente de A', 'a@x.mx', true, $3)`,
    [clienteDeA, a.entityId, a.userId]
  );
});

afterAll(async () => {
  await closeDatabase();
});

describe('contrapartes por id: la frontera vive en el SQL', () => {
  it('el dueño la lee; la entidad ajena recibe null, indistinguible de inexistente', async () => {
    const propia = await getCustomerById(clienteDeA, entityScope(a.tenantId, a.entityId));
    expect(propia?.company_name).toBe('Cliente de A');
    expect(await getCustomerById(clienteDeA, entityScope(b.tenantId, b.entityId))).toBeNull();
    expect(await getCustomerById(clienteDeA, tenantScope(b.tenantId))).toBeNull();
  });

  it('el UPDATE ajeno no toca la fila: cero filas = NotFound, sin ventana', async () => {
    await expect(
      updateCustomer(clienteDeA, entityScope(b.tenantId, b.entityId), { phone: '555' })
    ).rejects.toThrow(/not found/i);
    const intacta = await query<{ phone: string | null }>(
      'SELECT phone FROM customers WHERE id = $1',
      [clienteDeA]
    );
    expect(intacta.rows[0].phone).toBeNull();
  });
});

describe('webhooks: acotados por inquilino y con la URL vigilada', () => {
  it('conocer el UUID de un webhook ajeno no lo borra', async () => {
    const wh = await createWebhook(a.tenantId, 'https://hooks.example.com/r2', ['invoice.paid']);
    expect(wh.secret).toBeTruthy(); // el 201 es la única vez que viaja
    expect(await deleteWebhook(wh.id, b.tenantId)).toBe(false);
    expect(await deleteWebhook(wh.id, a.tenantId)).toBe(true);
  });

  it('una URL que apunta adentro se rechaza al crear', async () => {
    await expect(
      createWebhook(a.tenantId, 'http://169.254.169.254/latest/meta-data/', ['invoice.paid'])
    ).rejects.toThrow(ValidationError);
  });

  it('el listado no trae el secreto', async () => {
    const wh = await createWebhook(a.tenantId, 'https://hooks.example.com/r2-lista', ['invoice.paid']);
    const listado = await listWebhooks(a.tenantId);
    const fila = listado.find((w) => w.id === wh.id)!;
    expect(fila).toBeTruthy();
    expect((fila as Record<string, unknown>).secret).toBeUndefined();
  });
});

describe('la verificación pública corre por el rol verificador', () => {
  it('ve entidades ACTIVAS de cualquier inquilino, y las inactivas no existen para él', async () => {
    await query(`UPDATE legal_entities SET is_active = false WHERE id = $1`, [b.entityId]);
    const r = await consultaPublica<{ id: string }>(
      'SELECT id FROM legal_entities WHERE id = ANY($1::uuid[])',
      [[a.entityId, b.entityId]]
    );
    expect(r.rows.map((x) => x.id)).toEqual([a.entityId]);
    await query(`UPDATE legal_entities SET is_active = true WHERE id = $1`, [b.entityId]);
  });

  it('las columnas no enumeradas truenan en vez de exponerse', async () => {
    await expect(
      consultaPublica('SELECT tax_id FROM legal_entities LIMIT 1')
    ).rejects.toThrow(/permission denied/);
  });
});
