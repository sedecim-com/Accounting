#!/usr/bin/env tsx
import 'dotenv/config';
import { query, enterTenant, closeDatabase } from '../src/database/connection.js';
import {
  censarIvaPpd,
  reclasificarIvaPpd,
  type HallazgoIvaPpd,
} from '../src/services/accounting/iva-ppd-reclass.js';
import { drainAttestations } from '../src/services/accounting/posting.js';

// ============================================================
// Envoltorio de línea de comandos sobre services/accounting/iva-ppd-reclass.
// La lógica vive allí para que la cubran pruebas de integración; aquí sólo
// hay lectura de argumentos y presentación.
//
// Por omisión NO escribe nada: hace el censo y lo imprime.
//
//   npx tsx scripts/reclasificar-iva-ppd.ts --tenant <uuid>
//   npx tsx scripts/reclasificar-iva-ppd.ts --tenant <uuid> --aplicar
//   npx tsx scripts/reclasificar-iva-ppd.ts --tenant <uuid> --aplicar --reabrir
// ============================================================

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const tiene = (n: string): boolean => process.argv.includes(`--${n}`);

const dinero = (n: string | number): string =>
  Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

function imprimirCenso(hallazgos: HallazgoIvaPpd[]): void {
  const total = hallazgos.reduce((s, h) => s + Number(h.importe), 0);
  const porPeriodo = new Map<string, { nombre: string; estado: string; n: number; monto: number }>();
  for (const h of hallazgos) {
    const p = porPeriodo.get(h.period_id) ?? {
      nombre: h.period_name, estado: h.period_status, n: 0, monto: 0,
    };
    p.n += 1;
    p.monto += Number(h.importe);
    porPeriodo.set(h.period_id, p);
  }

  console.log(`\nIVA de CFDI PPD acreditado antes de tiempo\n${'─'.repeat(64)}`);
  console.log(`${hallazgos.length} asientos · ${dinero(total)} en total\n`);
  for (const [, p] of porPeriodo) {
    const marca = p.estado === 'open' ? '' : `  ← ${p.estado}`;
    console.log(
      `  ${p.nombre.padEnd(24)} ${String(p.n).padStart(4)} asientos ${dinero(p.monto).padStart(16)}${marca}`
    );
  }

  const sinCuenta = hallazgos.filter((h) => !h.cuenta_pendiente_id);
  if (sinCuenta.length > 0) {
    const entidades = [...new Set(sinCuenta.map((h) => h.entity_name))];
    console.log(
      `\n⚠ ${sinCuenta.length} asientos de ${entidades.join(', ')} no tienen cuenta ` +
        '«IVA Pendiente de Acreditar» (1135). Siémbrala con: mnemosine init --section identity'
    );
  }
}

async function main(): Promise<void> {
  const tenantId = arg('tenant');
  const entityId = arg('entity') ?? null;
  const aplicar = tiene('aplicar');
  const reabrir = tiene('reabrir');

  if (!tenantId) {
    console.error('Falta --tenant <uuid>. Sin inquilino no hay nada que acotar.');
    process.exit(2);
  }
  enterTenant(tenantId);

  const actor = arg('usuario') ?? (await primerUsuario(tenantId));
  if (!actor) {
    console.error('No se encontró un usuario activo del inquilino para firmar los asientos. Pasa --usuario <uuid>.');
    process.exit(2);
  }

  const hallazgos = await censarIvaPpd(tenantId, entityId);
  if (hallazgos.length === 0) {
    console.log('No hay IVA de CFDI PPD acreditado por adelantado. Nada que reclasificar.');
    return;
  }

  imprimirCenso(hallazgos);
  const cerrados = hallazgos.filter((h) => h.period_status !== 'open');

  if (!aplicar) {
    console.log(`\n${'─'.repeat(64)}`);
    console.log('Censo, sin escribir nada. Para aplicar:');
    console.log('  --aplicar            reclasifica lo que está en periodos abiertos');
    if (cerrados.length > 0) {
      console.log(`  --aplicar --reabrir  incluye ${cerrados.length} asientos en periodos cerrados`);
    }
    return;
  }

  const r = await reclasificarIvaPpd(hallazgos, actor, { reabrirCerrados: reabrir });

  console.log(`\n${'─'.repeat(64)}`);
  console.log(
    `${r.reclasificados} reclasificados (${dinero(r.montoReclasificado)}) · ` +
      `${r.omitidos.length} omitidos · ${r.fallos.length} con fallo`
  );
  const motivos = new Map<string, number>();
  for (const h of r.omitidos) {
    const m = r.motivosOmision.get(h.entry_id) ?? 'sin motivo';
    motivos.set(m, (motivos.get(m) ?? 0) + 1);
  }
  for (const [m, n] of motivos) console.log(`  · ${n} — ${m}`);
  for (const f of r.fallos) console.log(`  ✗ ${f}`);
  if (r.fallos.length > 0) process.exitCode = 1;
}

async function primerUsuario(tenantId: string): Promise<string | null> {
  const r = await query<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = $1 AND is_active = true ORDER BY created_at LIMIT 1`,
    [tenantId]
  );
  return r.rows[0]?.id ?? null;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  // Las atestaciones de los asientos de reclasificación son dispara-y-olvida:
  // sin drenarlas, `closeDatabase()` las mata y cada corrida deja asientos
  // posteados sin hash — y con ellos, periodos que ya no se pueden sellar.
  .finally(async () => {
    await drainAttestations(5000).catch(() => undefined);
    await closeDatabase();
  });
