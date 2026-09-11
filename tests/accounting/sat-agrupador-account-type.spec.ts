import { describe, it, expect } from 'vitest';

import {
  readAgrupador,
  accountTypeFrom,
  baseDesdeNaturaleza,
  baseOfAccountType,
  naturalezaDelTipo,
  rubrosOficiales,
} from '../../src/services/accounting/sat-agrupador-account-type.js';
import { C_CODAGRUP } from '../../src/services/accounting/sat-agrupadores-catalogo.js';
import { ACCOUNT_TYPES } from '../../src/services/accounting/account-service.js';

// ============================================================
// O1 · EL TIPO DE CUENTA QUE EL XML NO TRAE
// ============================================================

describe('readAgrupador · lo que el rubro dice', () => {
  it.each([
    ['101', 'asset', 'Caja'],
    ['171', 'asset', 'Depreciación acumulada de activos fijos'],
    ['201', 'liability', 'Proveedores'],
    ['301', 'equity', 'Capital social'],
    ['401', 'revenue', 'Ingresos'],
    ['501', 'expense', 'Costo de venta y/o servicio'],
    ['601', 'expense', 'Gastos generales'],
  ])('el rubro %s es %s', (codigo, base, nombre) => {
    const r = readAgrupador(codigo);
    expect(r.verdict).toBe('oficial');
    expect(r.base).toBe(base);
    expect(r.rubroNombre).toBe(nombre);
  });

  it('el 7xx NO es todo gasto, y esto es lo que el rango escondía', () => {
    // El encargo describía «5xx-7xx costos y gastos». La lista oficial que
    // vive en el árbol dice otra cosa en dos de sus cinco rubros.
    expect(readAgrupador('701').base).toBe('expense'); // Gastos financieros
    expect(readAgrupador('703').base).toBe('expense'); // Otros gastos
    expect(readAgrupador('702').base).toBe('revenue'); // Productos financieros
    expect(readAgrupador('704').base).toBe('revenue'); // Otros productos
  });

  it('el rubro 700 admite los dos signos y lo declara en vez de elegir', () => {
    const r = readAgrupador('700');
    expect(r.verdict).toBe('oficial_ambiguo');
    expect(r.base).toBeNull();
    expect(r.rubroNombre).toBe('Resultado integral de financiamiento');
  });

  it('las cuentas de orden se declaran sin casilla, no se empujan a una', () => {
    for (const codigo of ['800', '801.01', '808', '811']) {
      const r = readAgrupador(codigo);
      expect(r.verdict).toBe('cuentas_de_orden');
      expect(r.base).toBeNull();
    }
  });

  it('la subcuenta que la lista oficial no enumera hereda el rubro que sí está', () => {
    // `105.99` no existe en el c_CodAgrup; `105` (Clientes) sí. Un catálogo
    // ajeno viene lleno de subcuentas propias y rechazarlas por eso sería
    // rechazar la migración entera.
    const r = readAgrupador('105.99');
    expect(r.verdict).toBe('oficial');
    expect(r.base).toBe('asset');
    expect(r.rubro).toBe('105');
  });

  it('un rubro que no está en el catálogo se declara fuera, no se estira al rango', () => {
    for (const codigo of ['999', '150', 'ABC', '199.01']) {
      expect(readAgrupador(codigo).verdict).toBe('fuera_de_catalogo');
    }
  });

  it('el agrupador vacío o de sólo espacios es ausencia, no un código raro', () => {
    expect(readAgrupador('').verdict).toBe('ausente');
    expect(readAgrupador('   ').verdict).toBe('ausente');
    expect(readAgrupador('   ').rubro).toBeNull();
  });
});

describe('el trinquete: ningún rubro oficial se queda sin regla', () => {
  it('los 141 rubros del c_CodAgrup del árbol tienen todos veredicto', () => {
    const rubros = rubrosOficiales();
    expect(rubros.length).toBe(C_CODAGRUP.filter((a) => a.nivel === 1).length);

    const sinRegla = rubros.filter((r) => readAgrupador(r).verdict === 'sin_regla');
    // Si esto se pone en rojo, alguien cargó un Anexo 24 con un rango nuevo y
    // este módulo tiene que aprenderlo A PROPÓSITO. Es el punto: el sistema
    // dice «no sé» en vez de caer en el último `else` de nadie.
    expect(sinRegla).toEqual([]);
  });

  it('y toda subcuenta oficial resuelve por su rubro', () => {
    const huerfanas = C_CODAGRUP.filter((a) => a.nivel === 2).filter((a) => {
      const v = readAgrupador(a.codigo).verdict;
      return v === 'fuera_de_catalogo' || v === 'sin_regla';
    });
    expect(huerfanas).toEqual([]);
  });
});

describe('accountTypeFrom · la naturaleza y la contracuenta', () => {
  it('un rubro de activo con naturaleza acreedora es una CONTRACUENTA de activo', () => {
    // 108 «Estimación de cuentas incobrables» y 171 «Depreciación acumulada»
    // viven en el 1xx y son acreedoras: el esquema tiene la casilla exacta.
    expect(accountTypeFrom('asset', 'A')).toBe('contra_asset');
    expect(accountTypeFrom('asset', 'D')).toBe('asset');
  });

  it('lo mismo en pasivo y capital, que también tienen contracuenta', () => {
    expect(accountTypeFrom('liability', 'D')).toBe('contra_liability');
    expect(accountTypeFrom('liability', 'A')).toBe('liability');
    expect(accountTypeFrom('equity', 'D')).toBe('contra_equity');
    expect(accountTypeFrom('equity', 'A')).toBe('equity');
  });

  it('ingreso y gasto NO tienen contracuenta en este esquema: se respeta el tipo', () => {
    // 402 «Devoluciones sobre ingresos» es 4xx y deudora. No hay
    // `contra_revenue`; la naturaleza del archivo manda sobre el saldo y la
    // divergencia la nombra el informe.
    expect(accountTypeFrom('revenue', 'D')).toBe('revenue');
    expect(accountTypeFrom('revenue', 'A')).toBe('revenue');
    expect(accountTypeFrom('expense', 'A')).toBe('expense');
    expect(accountTypeFrom('expense', 'D')).toBe('expense');
  });

  it('todo lo que produce es un account_type que la base admite', () => {
    const bases = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
    for (const b of bases) {
      for (const n of ['D', 'A'] as const) {
        expect(ACCOUNT_TYPES).toContain(accountTypeFrom(b, n));
      }
    }
  });

  it('el desempate del 700 sale de la naturaleza y de nada más', () => {
    expect(baseDesdeNaturaleza('D')).toBe('expense');
    expect(baseDesdeNaturaleza('A')).toBe('revenue');
  });
});

describe('la vuelta: de account_type a base y a naturaleza', () => {
  it('la contracuenta vuelve a su familia para que sus hijos hereden bien', () => {
    expect(baseOfAccountType('contra_asset')).toBe('asset');
    expect(baseOfAccountType('contra_liability')).toBe('liability');
    expect(baseOfAccountType('contra_equity')).toBe('equity');
    expect(baseOfAccountType('asset')).toBe('asset');
    expect(baseOfAccountType('liability')).toBe('liability');
    expect(baseOfAccountType('equity')).toBe('equity');
    expect(baseOfAccountType('revenue')).toBe('revenue');
    expect(baseOfAccountType('expense')).toBe('expense');
  });

  it('un tipo que este módulo no conoce devuelve null en vez de una suposición', () => {
    expect(baseOfAccountType('memorandum')).toBeNull();
  });

  it('naturalezaDelTipo es la misma tabla que usa el generador al salir', () => {
    // Espejo de `naturalezaSegunTipo` en catalogo-cuentas.ts. Si las dos se
    // separan, un catálogo importado saldría con avisos que no merece.
    expect(naturalezaDelTipo('asset')).toBe('D');
    expect(naturalezaDelTipo('expense')).toBe('D');
    expect(naturalezaDelTipo('contra_liability')).toBe('D');
    expect(naturalezaDelTipo('contra_equity')).toBe('D');
    expect(naturalezaDelTipo('liability')).toBe('A');
    expect(naturalezaDelTipo('equity')).toBe('A');
    expect(naturalezaDelTipo('revenue')).toBe('A');
    expect(naturalezaDelTipo('contra_asset')).toBe('A');
  });

  it('el círculo se cierra: tipo deducido y naturaleza del archivo no se contradicen en balance', () => {
    // La prueba de que reconocer la contracuenta sirve: para activo, pasivo y
    // capital, el tipo que sale de (base, natur) implica exactamente esa
    // naturaleza, así que el generador no emitirá CAT-NATUR-CONTRA-TIPO.
    for (const base of ['asset', 'liability', 'equity'] as const) {
      for (const natur of ['D', 'A'] as const) {
        expect(naturalezaDelTipo(accountTypeFrom(base, natur))).toBe(natur);
      }
    }
  });
});
