import { describe, it, expect, vi } from 'vitest';

// ============================================================
// TODO PAC ENRUTABLE ESTÁ REGISTRADO, Y VICEVERSA.
//
// El defecto que esto fija: `pac-router.ts` tenía DOS listas escritas a mano —
// el diccionario `PAC_ADAPTERS`, de donde salen el enrutado y el failover, y
// tres llamadas sueltas a `integrationRegistry.register()`. Divergieron.
// `sovos_reachcore` —el único adaptador del árbol que no fabrica el folio,
// `simulado = false`, con `configure()` completo— estaba en el diccionario y
// NO en el registry.
//
// La consecuencia no era teórica: las cuatro rutas de administración resuelven
// el proveedor con `integrationRegistry.get(:provider)`, que lanza
// PROVIDER_NOT_FOUND para lo que no esté registrado. Así que
// `PUT /v1/admin/integrations/sovos_reachcore` moría, y el único PAC capaz de
// timbrar de verdad era el único que no se podía dar de alta por la API —
// mientras `GET /v1/admin/integrations` enseñaba tres PACs, los tres
// simuladores, sin decir que lo eran.
//
// Nada podía ver la divergencia porque nada comparaba las dos listas. Esto las
// compara.
// ============================================================

// Postgres se simula: registrarse es meter un adaptador en un Map en memoria y
// no toca la base. Lo que se mide aquí es el cableado, no una consulta.
vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
}));

import { integrationRegistry } from '../../src/services/integrations/base/registry.js';
import { PAC_ADAPTERS } from '../../src/services/integrations/mexico/pac/pac-router.js';

describe('el enrutador de PAC y el registry no pueden divergir', () => {
  it('todo PAC enrutable está registrado', () => {
    const enrutables = Object.keys(PAC_ADAPTERS).sort();
    const registrados = integrationRegistry
      .getByCategory('pac')
      .map((a) => a.providerId)
      .sort();
    expect(registrados).toEqual(enrutables);
  });

  it('sovos_reachcore se resuelve por el mismo camino que usan las rutas de administración', () => {
    // `registry.get` es literalmente lo que llaman PUT/GET/POST/DELETE
    // /v1/admin/integrations/:provider. Antes lanzaba PROVIDER_NOT_FOUND aquí.
    const adapter = integrationRegistry.get('sovos_reachcore');
    expect(adapter.providerId).toBe('sovos_reachcore');
    expect(adapter.category).toBe('pac');
  });

  it('el único no simulado sigue siendo el único no simulado', () => {
    // Si mañana alguien pone `simulado = false` en un adaptador que fabrica el
    // UUID con crypto.randomBytes, el cerrojo de simulacion.ts lo deja timbrar
    // y el folio inventado se guarda como emitido por el SAT. Esta línea es
    // barata y ese fallo no lo es.
    const porId = Object.fromEntries(
      integrationRegistry.getByCategory('pac').map((a) => [
        a.providerId,
        (a as unknown as { simulado: boolean }).simulado,
      ])
    );
    expect(porId).toEqual({
      sovos_reachcore: false,
      finkok: true,
      sw_sapien: true,
      edicom: true,
    });
  });
});
