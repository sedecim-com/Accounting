import { describe, it, expect } from 'vitest';
import { checkSoDViolations } from '../../../src/api/rest/middleware/auth.js';
import { PERMISSIONS, ROLES, COMODIN, permissionsOf } from '../../../src/auth/roles.js';

// ============================================================
// UNA REGLA DE SEGREGACIÓN QUE NO PUEDE DISPARARSE ES PEOR QUE NO TENERLA:
// ocupa el sitio donde iría una que sí, y el informe sale limpio.
//
// `SOD_RULES` tenía DOS defectos que juntos garantizaban que la severidad
// ALTA no se encendiera jamás:
//
//   1. nombraba `vendors:create` y `vendors:update`, y en el catálogo no hay
//      ni ha habido un permiso `vendors:*` — el alta de proveedor la guarda
//      `bills:create` (routes/vendors.ts:93);
//   2. el detector hacía `permissions.includes(p)`, y el ÚNICO rol que puede
//      hacerlo todo, `owner`, es `['*']`: el comodín no casa con ningún
//      literal, así que salía sin una sola violación.
//
// Estas pruebas no miran la tabla de reglas: la ejercitan. La primera es la
// que importa — si una regla nombra un permiso inexistente, ni siquiera el
// universo completo de permisos la enciende, y se cae aquí.
// ============================================================

const nombresDeRegla = (permisos: string[]) => checkSoDViolations(permisos).map((v) => v.rule);

describe('SOD_RULES puede dispararse', () => {
  it('con TODO el catálogo concedido, se encienden las tres reglas', () => {
    // El detector de antes daba dos: la alta se quedaba fuera porque pedía
    // permisos que el catálogo no define.
    const violaciones = checkSoDViolations([...PERMISSIONS]);
    expect(violaciones).toHaveLength(3);
    expect(violaciones.map((v) => v.severity).sort()).toEqual(['high', 'low', 'medium']);
  });

  it('ninguna regla nombra un permiso que el catálogo no defina', () => {
    // Formulada por conducta: si un grupo de una regla sólo contuviera
    // permisos inexistentes, la conjunción sería falsa para el universo
    // entero y la prueba de arriba no llegaría a tres. Aquí se fija además el
    // recíproco: quitar un permiso real del catálogo apaga su regla.
    const sinAprobar = [...PERMISSIONS].filter((p) => p !== 'bills:approve');
    expect(nombresDeRegla(sinAprobar)).not.toContain('Vendor Setup vs Payment Approval');
  });
});

describe('el comodín acumula', () => {
  it("owner —['*']— acumula las tres, porque puede hacerlo todo", () => {
    expect(ROLES.owner.permissions).toEqual([COMODIN]);
    // Antes: cero violaciones. El rol más peligroso del sistema salía limpio.
    expect(checkSoDViolations([COMODIN])).toHaveLength(3);
  });

  it('el comodín no inventa violaciones donde no hay regla', () => {
    // La lista no crece sola: es la MISMA que da el universo de permisos.
    expect(nombresDeRegla([COMODIN]).sort()).toEqual(nombresDeRegla([...PERMISSIONS]).sort());
  });
});

describe('las reglas discriminan entre los siete roles reales', () => {
  it('contador acumula alta de proveedor y aprobación de su factura', () => {
    // `bills:create` da de alta al proveedor y su CLABE; `bills:approve`
    // aprueba lo que se le paga. Juntas bastan para desviar dinero sin cómplice.
    const perms = [...permissionsOf('contador')];
    expect(perms).toContain('bills:create');
    expect(perms).toContain('bills:approve');
    expect(nombresDeRegla(perms)).toContain('Vendor Setup vs Payment Approval');
  });

  it('revisor aprueba facturas pero no da de alta proveedores: sale limpio', () => {
    const perms = [...permissionsOf('revisor')];
    expect(perms).toContain('bills:approve');
    expect(perms).not.toContain('bills:create');
    expect(nombresDeRegla(perms)).not.toContain('Vendor Setup vs Payment Approval');
  });

  it('los tres roles de sólo lectura no acumulan nada', () => {
    for (const rol of ['auditor', 'viewer', 'revisor'] as const) {
      expect(checkSoDViolations([...permissionsOf(rol)]), rol).toHaveLength(0);
    }
  });

  it('controller separa compras pero acumula cerrar y reabrir periodos', () => {
    const nombres = nombresDeRegla([...permissionsOf('controller')]);
    expect(nombres).toContain('Period Close vs Reopen');
    expect(nombres).not.toContain('Vendor Setup vs Payment Approval');
  });
});
