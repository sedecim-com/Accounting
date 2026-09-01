#!/usr/bin/env tsx
import 'dotenv/config';
import { enterTenant, closeDatabase } from '../src/database/connection.js';
import {
  censarEntidadesSinRoles,
  rellenarRoles,
  actoresPorInquilino,
} from '../src/services/accounting/account-roles-backfill.js';

// ============================================================
// Envoltorio de línea de comandos sobre
// services/accounting/account-roles-backfill.
//
// Por omisión NO escribe: censa y lo imprime.
//
//   npx tsx scripts/rellenar-roles-de-cuenta.ts [--tenant <uuid>]
//   npx tsx scripts/rellenar-roles-de-cuenta.ts [--tenant <uuid>] --aplicar
// ============================================================

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const tenantId = arg('tenant');
  const aplicar = process.argv.includes('--aplicar');
  if (tenantId) enterTenant(tenantId);

  const entidades = await censarEntidadesSinRoles(tenantId);
  if (entidades.length === 0) {
    console.log('Todas las entidades activas tienen su capa semántica sembrada. Nada que rellenar.');
    return;
  }

  console.log(`\nEntidades sin roles de cuenta\n${'─'.repeat(64)}`);
  for (const e of entidades) {
    console.log(
      `  ${e.entity_name.padEnd(34)} ${String(e.cuentas_actuales).padStart(4)} cuentas · ` +
        `${e.roles_actuales} roles`
    );
  }
  console.log(`\n${entidades.length} entidades. Sin roles, la ingesta de CFDI y los pagos`);
  console.log('mueren con MISSING_ROLE_ACCOUNT en cuanto se use el sistema.');

  if (!aplicar) {
    console.log(`\n${'─'.repeat(64)}`);
    console.log('Censo, sin escribir nada. Para sembrarlas: --aplicar');
    return;
  }

  const actores = await actoresPorInquilino([...new Set(entidades.map((e) => e.tenant_id))]);
  const r = await rellenarRoles(entidades, actores);

  console.log(`\n${'─'.repeat(64)}`);
  console.log(
    `${r.sembradas} entidades sembradas · ${r.cuentasCreadas} cuentas creadas · ` +
      `${r.rolesMapeados} roles mapeados`
  );
  if (r.sinMapear.length > 0) {
    console.log(`\n${r.sinMapear.length} roles sin cuenta en el catálogo (revísalos con mnemosine doctor):`);
    for (const u of r.sinMapear.slice(0, 20)) {
      console.log(`  ${u.entidad}: ${u.role} → ${u.code}`);
    }
  }
  for (const f of r.fallos) console.log(`  ✗ ${f}`);
  if (r.fallos.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
