import { describe, it, expect, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { checkSelloDeGarantias } from '../../src/ai/doctor-service.js';

// ============================================================
// S3·sello · EL LIBRO QUE NO SE PUEDE APAGAR EN SILENCIO
//
// Las garantías de este esquema son disparadores, y un disparador tiene
// interruptor. La 058 los pasa a ENABLE ALWAYS, que cierra la vía silenciosa
// —`SET session_replication_role = 'replica'` apaga de golpe todos los
// ordinarios sin tocar el esquema—, y deja una sola puerta: `DISABLE
// TRIGGER`, que es del dueño y es legítima como break-glass. Lo que no puede
// ser es que no se note.
//
// Por eso estas pruebas no comprueban que el chequeo EXISTA: rompen el sello
// de verdad y comprueban que lo CAZA. Un vigilante que no se prueba apagando
// lo que vigila es una afirmación, no un vigilante.
// ============================================================

afterAll(async () => {
  await closeDatabase();
});

describe('el sello de las garantías', () => {
  it('con todo sellado, doctor lo dice y cuenta cuántas son', async () => {
    const r = await checkSelloDeGarantias();
    expect(r.level, r.detail).toBe('ok');
    expect(r.detail).toMatch(/\d+ garantías en ENABLE ALWAYS/);
  });

  // El número NO se relaja cuando crece: se sube diciendo qué entró. La
  // décima la trae la 067 (nómina) — un disparador que impide dos vigencias
  // solapadas del mismo estado, porque con ellas el ISN del mes sería
  // ambiguo. Contar es la mitad de la prueba; la otra mitad es que cada una
  // esté en ALWAYS, y eso vale igual para la que acaba de llegar.
  it('las diez garantías del esquema están marcadas y en ALWAYS', async () => {
    const r = await query<{ relname: string; tgname: string; tgenabled: string }>(
      `SELECT c.relname, t.tgname, t.tgenabled
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_description d ON d.objoid = t.oid AND d.classoid = 'pg_trigger'::regclass
        WHERE d.description LIKE 'garantia-sellada:%' AND NOT t.tgisinternal`
    );
    // El mayor (4), la bitácora (2), las credenciales fiscales (2) y el hash
    // del extracto (1). Si alguien añade una garantía y la sella, este número
    // sube y esta prueba se actualiza a conciencia: es un censo, no un tope.
    expect(r.rows).toHaveLength(10);
    expect(r.rows.every((t) => t.tgenabled === 'A')).toBe(true);
  });

  it('APAGAR una garantía lo caza doctor, con su nombre y su estado', async () => {
    // El break-glass real: el dueño apaga el disparador del mayor.
    await query('ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_posteado_inmutable');
    try {
      const r = await checkSelloDeGarantias();
      expect(r.level).toBe('fail');
      expect(r.detail).toMatch(/journal_entries\.journal_entries_posteado_inmutable=D/);
      expect(r.detail).toMatch(/APAGADAS/);
      expect(r.fix).toMatch(/ENABLE ALWAYS TRIGGER/);
    } finally {
      await query(
        'ALTER TABLE journal_entries ENABLE ALWAYS TRIGGER journal_entries_posteado_inmutable'
      );
    }
    // Y queda como estaba: la prueba no deja el esquema peor de lo que lo
    // encontró — la lección del LIMIT 1 sin ORDER BY, que ensució la base
    // para las suites vecinas.
    expect((await checkSelloDeGarantias()).level).toBe('ok');
  });

  it('DEGRADAR el sello a disparador ordinario también lo caza: es la vía silenciosa', async () => {
    // No lo apaga: lo devuelve a 'O'. El disparador sigue ahí, sigue
    // disparando en operaciones normales, y `ledger check` no nota nada —
    // pero una sesión con session_replication_role='replica' lo saltaría, y
    // ése es exactamente el agujero que la 058 vino a cerrar.
    await query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only');
    try {
      const r = await checkSelloDeGarantias();
      expect(r.level).toBe('fail');
      expect(r.detail).toMatch(/audit_log\.audit_log_append_only=O/);
      // No está apagada, así que no debe acusarla de apagada.
      expect(r.detail).not.toMatch(/APAGADAS/);
    } finally {
      await query('ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_append_only');
    }
    expect((await checkSelloDeGarantias()).level).toBe('ok');
  });

  it('el sello aguanta lo que el disparador ordinario no: session_replication_role', async () => {
    // La prueba que da sentido a todo el tramo. Con el disparador en 'O' esta
    // sesión podría editar un asiento posteado sin que nada la detuviera;
    // en 'A' el disparador salta igual.
    const ent = await query<{ id: string }>(
      `SELECT id FROM journal_entries WHERE status = 'posted' LIMIT 1`
    );
    if (ent.rows.length === 0) return; // sin asientos posteados no hay nada que probar

    await query("SET session_replication_role = 'replica'");
    try {
      await expect(
        query(`UPDATE journal_entries SET description = 'editado a escondidas' WHERE id = $1`, [
          ent.rows[0].id,
        ])
      ).rejects.toThrow();
    } finally {
      await query("SET session_replication_role = 'origin'");
    }
  });
});
