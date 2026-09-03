import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe } from './helpers/servidor.js';
import journalEntriesRouter from '../../src/api/rest/routes/journal-entries.js';
import { resolvers } from '../../src/api/graphql/resolvers/index.js';
import {
  createJournalEntry,
  postJournalEntry,
  reverseJournalEntry,
  drainAttestations,
} from '../../src/services/accounting/posting.js';
import { softClosePeriod, hardClosePeriod } from '../../src/services/accounting/period-close.js';
import { seedPolicies, resolvePolicy, reopenPolicy } from '../../src/services/policy/policy-service.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// G3 · EL CANDADO QUE UNA DE LAS DOS PUERTAS NO ATRAVESABA.
//
// `segregacion_de_funciones` vivía DENTRO de `postJournalEntry`, así que sólo
// mordía a quien entrara por ahí. Al mayor se llega por DOS sitios más, y los
// dos postean en el mismo acto de crear:
//
//   · REST    · POST /v1/journal-entries {"auto_post": true}
//   · GraphQL · mutation createJournalEntry(input: { autoPost: true })
//
// Ninguno de los dos consultaba la política. El control existía, se vendía, y
// se eludía con una bandera JSON — mientras `src/cli/entry-command.ts` declara
// por escrito que ese mismo `auto_post` «is deliberately not exposed»
// precisamente porque saltarse el control de cuatro ojos es lo que NO debe
// poder hacerse.
//
// Lo que estas pruebas fijan es CONDUCTA, no estructura: que ante la misma
// política las tres puertas contesten lo mismo, incluido el caso en que la
// política lo PERMITE. Contra Postgres real, porque lo que se afirma es que
// no queda asiento ni saldo movido, y eso sólo lo prueba la base.
// ============================================================

let f: Fixture;
let segundoUsuario: string;

const ctxDe = (fx: Fixture) => ({ tenantId: fx.tenantId, entityId: fx.entityId });

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * `resolvePolicy` CONSUME la decisión pendiente: sólo se resuelve una vez.
 * Estas pruebas mueven la misma clave entre 'off', 'alertar' y 'exigir', así
 * que cada cambio reabre primero — el mismo par que usa f05d.
 */
async function politica(fx: Fixture, valor: string): Promise<void> {
  await reopenPolicy(ctxDe(fx), 'segregacion_de_funciones').catch(() => undefined);
  await resolvePolicy(ctxDe(fx), 'segregacion_de_funciones', valor, 'victor@test');
}

/** El cuerpo que las tres puertas reciben: la MISMA póliza manual. */
function cuerpo(f: Fixture, descripcion: string, monto = '500.00') {
  return {
    entity_id: f.entityId,
    entry_date: iso(fechaEnPeriodo()),
    entry_type: 'standard',
    description: descripcion,
    lines: [
      { account_id: f.roles.banco, debit_amount: monto, description: 'cargo' },
      { account_id: f.roles.cxc, credit_amount: monto, description: 'abono' },
    ],
  };
}

async function contarAsientos(entityId: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1',
    [entityId]
  );
  return Number(rows[0].n);
}

beforeAll(async () => {
  f = await crearInquilino('G3 candado de una sola puerta');
  enterTenant(f.tenantId);
  segundoUsuario = uuidv4();
  await query(
    `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name,
      roles, permissions, accessible_entities, is_active)
     VALUES ($1, $2, $3, 'x', 'Segundo', 'Par de ojos',
      '["revisor"]'::jsonb, '["journal_entries:post"]'::jsonb, $4::jsonb, true)`,
    [segundoUsuario, f.tenantId, `revisor-${segundoUsuario.slice(0, 8)}@example.test`,
     JSON.stringify([f.entityId])]
  );
  await seedPolicies(ctxDe(f));
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe("la puerta REST bajo 'exigir'", () => {
  it('auto_post:true rebota con el MISMO código que entry post, y no deja rastro en el mayor', async () => {
    await politica(f, 'exigir');

    const antes = await contarAsientos(f.entityId);
    const saldoAntes = await query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM account_balances WHERE entity_id = $1',
      [f.entityId]
    );

    const s = await levantar([['/v1/journal-entries', journalEntriesRouter]], sesionDe(f));
    try {
      const r = await pedir(s, 'POST', '/v1/journal-entries', {
        ...cuerpo(f, 'REST auto_post bajo exigir'),
        auto_post: true,
      });

      // 422 y el código de dominio, no un 500 ni un 201.
      expect(r.status).toBe(422);
      const errores = r.body.errors as Array<{ code: string; message: string }>;
      expect(errores[0].code).toBe('SOD_QUIEN_CREA_NO_POSTEA');
      expect(errores[0].message).toMatch(/segregación de funciones/);
    } finally {
      await s.cerrar();
    }

    // LO QUE MÁS IMPORTA: la transacción entera se deshizo. Ni asiento
    // huérfano, ni número de póliza consumido a medias, ni saldo movido.
    expect(await contarAsientos(f.entityId)).toBe(antes);
    const saldoDespues = await query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM account_balances WHERE entity_id = $1',
      [f.entityId]
    );
    expect(saldoDespues.rows[0].n).toBe(saldoAntes.rows[0].n);
    const { rows: rastro } = await query(
      `SELECT id FROM journal_entries
        WHERE entity_id = $1 AND description = 'REST auto_post bajo exigir'`,
      [f.entityId]
    );
    expect(rastro).toHaveLength(0);
  });

  it('el motor que usa el CLI contesta EXACTAMENTE lo mismo ante el mismo cuerpo', async () => {
    await politica(f, 'exigir');

    // El camino del CLI: `entry create` deja borrador, `entry post` postea.
    const borrador = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'CLI bajo exigir',
      [
        { account_id: f.roles.banco, debit_amount: '500.00', credit_amount: null, description: 'cargo' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '500.00', description: 'abono' },
      ],
      f.userId
    );

    await expect(postJournalEntry(borrador.id, f.userId)).rejects.toMatchObject({
      code: 'SOD_QUIEN_CREA_NO_POSTEA',
    });

    // Y el segundo par de ojos SÍ postea: la política separa, no congela.
    const posteada = await postJournalEntry(borrador.id, segundoUsuario);
    expect(posteada.status).toBe('posted');
    expect(posteada.posted_by).toBe(segundoUsuario);
  });

  it('auto_post:false sigue creando el borrador que otro usuario postea', async () => {
    await politica(f, 'exigir');

    const s = await levantar([['/v1/journal-entries', journalEntriesRouter]], sesionDe(f));
    let id: string;
    try {
      const r = await pedir(s, 'POST', '/v1/journal-entries', {
        ...cuerpo(f, 'REST borrador bajo exigir'),
        auto_post: false,
      });
      expect(r.status).toBe(201);
      const data = r.body.data as { id: string; status: string };
      expect(data.status).toBe('draft');
      id = data.id;
    } finally {
      await s.cerrar();
    }

    const posteada = await postJournalEntry(id, segundoUsuario);
    expect(posteada.status).toBe('posted');
  });
});

describe('la puerta REST cuando la política lo permite', () => {
  it("con 'off', auto_post:true postea y mueve saldos, como siempre", async () => {
    await politica(f, 'off');

    const s = await levantar([['/v1/journal-entries', journalEntriesRouter]], sesionDe(f));
    try {
      const r = await pedir(s, 'POST', '/v1/journal-entries', {
        ...cuerpo(f, 'REST auto_post con politica off', '700.00'),
        auto_post: true,
      });
      expect(r.status).toBe(201);
      const data = r.body.data as { id: string; status: string; posted_by: string };
      expect(data.status).toBe('posted');
      expect(data.posted_by).toBe(f.userId);

      const { rows } = await query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM account_balances
          WHERE entity_id = $1 AND account_id = $2`,
        [f.entityId, f.roles.banco]
      );
      expect(Number(rows[0].n)).toBeGreaterThan(0);
    } finally {
      await s.cerrar();
    }
  });

  it("con 'alertar', postea y la fila de auditoría LLEVA la coincidencia anotada", async () => {
    await politica(f, 'alertar');

    const s = await levantar([['/v1/journal-entries', journalEntriesRouter]], sesionDe(f));
    let id: string;
    try {
      const r = await pedir(s, 'POST', '/v1/journal-entries', {
        ...cuerpo(f, 'REST auto_post con politica alertar', '300.00'),
        auto_post: true,
      });
      expect(r.status).toBe(201);
      const data = r.body.data as { id: string; status: string };
      expect(data.status).toBe('posted');
      id = data.id;
    } finally {
      await s.cerrar();
    }

    // Sin esta nota, la bitácora certifica un control que nadie consultó.
    const { rows } = await query<{ reason: string | null }>(
      `SELECT reason FROM audit_log
        WHERE entity_type = 'journal_entries' AND entity_id = $1 AND action = 'post'`,
      [id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(/SoD/);
  });
});

describe('la tercera puerta: GraphQL', () => {
  it('la mutación createJournalEntry(autoPost:true) atraviesa el MISMO candado', async () => {
    await politica(f, 'exigir');

    const ctx = {
      user: { user_id: f.userId, entities: [f.entityId], permissions: ['*'] },
      tenantId: f.tenantId,
      entityId: f.entityId,
    };
    const input = {
      entityId: f.entityId,
      entryDate: iso(fechaEnPeriodo()),
      entryType: 'standard',
      description: 'GraphQL autoPost bajo exigir',
      autoPost: true,
      lines: [
        { accountId: f.roles.banco, debitAmount: '500.00', description: 'cargo' },
        { accountId: f.roles.cxc, creditAmount: '500.00', description: 'abono' },
      ],
    };

    const antes = await contarAsientos(f.entityId);
    const mutaciones = resolvers.Mutation as unknown as Record<
      string,
      (p: unknown, a: unknown, c: unknown) => Promise<unknown>
    >;
    await expect(mutaciones.createJournalEntry(null, { input }, ctx)).rejects.toMatchObject({
      code: 'SOD_QUIEN_CREA_NO_POSTEA',
    });
    expect(await contarAsientos(f.entityId)).toBe(antes);
  });
});

describe('lo que el candado NO debe morder', () => {
  it("con 'exigir', la póliza CON ORIGEN de sistema se auto-postea igual", async () => {
    await politica(f, 'exigir');

    // Nómina, facturas, borradores de IA, conciliación: el maker real queda
    // trazado por source_type/source_id, y ahí creador=posteador es intencional.
    const asiento = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'origen de sistema bajo exigir',
      [
        { account_id: f.roles.banco, debit_amount: '90.00', credit_amount: null, description: 'cargo' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '90.00', description: 'abono' },
      ],
      f.userId,
      { autoPost: true, sourceType: 'invoice', sourceId: uuidv4() }
    );
    expect(asiento.status).toBe('posted');
  });

  it("con 'exigir', la REVERSA de un asiento posteado sigue siendo posible", async () => {
    await politica(f, 'off');
    const original = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'a revertir bajo exigir',
      [
        { account_id: f.roles.banco, debit_amount: '120.00', credit_amount: null, description: 'cargo' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '120.00', description: 'abono' },
      ],
      f.userId,
      { autoPost: true }
    );

    // La reversa es DERIVADA: su contenido no lo elige nadie, así que exigirle
    // un segundo par de ojos sólo produciría falsos positivos. La marca es
    // `is_reversal`, que pone el motor y no el cuerpo de una petición.
    await politica(f, 'exigir');
    const espejo = await reverseJournalEntry(original.id, f.userId, undefined);
    expect(espejo.status).toBe('posted');
    expect(espejo.is_reversal).toBe(true);
  });
});

describe('el daño colateral que el candado NO puede causar', () => {
  it("con 'exigir', el cierre de ejercicio sigue barriendo, y sus asientos declaran su origen", async () => {
    const c = await crearInquilino('G3 cierre bajo exigir');
    enterTenant(c.tenantId);
    await seedPolicies(ctxDe(c));

    // Se puebla el ejercicio ANTES de encender la política: estos sí son
    // pólizas manuales y bajo 'exigir' deben rebotar — que es el punto.
    for (const [desc, cargo, abono] of [
      ['Ventas', c.roles.banco, c.cuentas['4100']],
      ['Costo de ventas', c.cuentas['5100'], c.roles.banco],
    ] as const) {
      await createJournalEntry(
        c.entityId, fechaEnPeriodo(12, 10), JournalEntryType.STANDARD, desc,
        [
          { account_id: cargo, debit_amount: '4000.0000', credit_amount: null, description: desc },
          { account_id: abono, debit_amount: null, credit_amount: '4000.0000', description: desc },
        ],
        c.userId, { autoPost: true }
      );
    }

    await politica(c, 'exigir');

    // Los asientos de cierre nacían con source_type NULO, que en este libro
    // significa «alguien la redactó a mano». No lo son: los calcula el barrido.
    // Sin marcarles el origen, encender la política congelaba el cierre anual.
    await softClosePeriod(c.periodos[12], c.entityId, c.userId);
    await hardClosePeriod(c.periodos[12], c.entityId, c.userId, 'cierre bajo exigir');

    const { rows } = await query<{ source_type: string | null; n: string }>(
      `SELECT source_type, COUNT(*)::text AS n FROM journal_entries
        WHERE entity_id = $1 AND entry_type = 'closing' AND status = 'posted'
        GROUP BY source_type`,
      [c.entityId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source_type).toBe('period_close');
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  });
});
