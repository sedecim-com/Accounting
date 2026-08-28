import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  PERMISSIONS, ROLES, RESERVADOS, COMODIN,
  permissionsOf, hasPermission,
} from '../../src/auth/roles.js';

/**
 * EL CENSO «EXIGIDOS VS CONCEDIDOS», EN CERO Y QUE SE MANTENGA SOLO.
 *
 * Había DOS catálogos de roles con nombres distintos: el del middleware REST
 * y el del asistente de alta. Un usuario creado por la terminal recibía
 * permisos que la API no reconocía, y los roles `admin` y `controller` eran
 * inalcanzables desde el único sitio donde se crean usuarios.
 *
 * Estas pruebas no comprueban que el catálogo «esté bien» —eso es una
 * opinión— sino dos cosas falsables: que todo lo que el código EXIGE existe
 * en él, y que todo lo que CONCEDE lo exige alguien o está declarado como
 * reservado con la razón. Un catálogo que se separa del código vuelve a ser
 * dos catálogos.
 */

const RAIZ = path.join(__dirname, '..', '..', 'src');

/** Los permisos que el código pide con requirePermission('...'). */
function permisosExigidos(): Map<string, string[]> {
  const encontrados = new Map<string, string[]>();
  const caminar = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist') continue;
        caminar(full);
      } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
        const texto = fs.readFileSync(full, 'utf-8');
        for (const m of texto.matchAll(/requirePermission\(\s*'([a-z_]+:[a-z_*]+)'/g)) {
          const rel = path.relative(RAIZ, full);
          encontrados.set(m[1], [...(encontrados.get(m[1]) ?? []), rel]);
        }
      }
    }
  };
  caminar(RAIZ);
  return encontrados;
}

describe('el catálogo cubre lo que el código exige', () => {
  const exigidos = permisosExigidos();

  it('el escáner encuentra permisos: si no, la prueba no prueba nada', () => {
    expect(exigidos.size).toBeGreaterThan(15);
  });

  it('ninguna ruta exige un permiso que el catálogo no tiene', () => {
    const conjunto = new Set<string>(PERMISSIONS);
    const huerfanos = [...exigidos.entries()]
      .filter(([p]) => p !== COMODIN && !conjunto.has(p))
      .map(([p, rutas]) => `${p} (${rutas[0]})`);
    expect(
      huerfanos,
      `Estas rutas exigen permisos inexistentes: nadie puede satisfacerlos, así que responden 403 siempre`
    ).toEqual([]);
  });

  it('ningún permiso del catálogo sobra sin declararse reservado', () => {
    const sobrantes = PERMISSIONS.filter(
      (p) => !exigidos.has(p) && !(p in RESERVADOS)
    );
    expect(
      sobrantes,
      'Se conceden y nadie los exige. O falta la ruta, o sobran del catálogo: decláralos en RESERVADOS con la razón'
    ).toEqual([]);
  });

  it('cada reservado dice qué le falta para dejar de serlo', () => {
    for (const [permiso, razon] of Object.entries(RESERVADOS)) {
      expect(PERMISSIONS as readonly string[]).toContain(permiso);
      expect(razon.length, `${permiso} no explica por qué está reservado`).toBeGreaterThan(30);
    }
  });
});

describe('los roles', () => {
  it('sólo conceden permisos del conjunto cerrado', () => {
    const conjunto = new Set<string>([...PERMISSIONS, COMODIN]);
    for (const [nombre, spec] of Object.entries(ROLES)) {
      const fuera = spec.permissions.filter((p) => !conjunto.has(p));
      expect(fuera, `${nombre} concede permisos que no existen`).toEqual([]);
    }
  });

  it('sólo owner lleva el comodín', () => {
    const conComodin = Object.entries(ROLES)
      .filter(([, s]) => (s.permissions as readonly string[]).includes(COMODIN))
      .map(([n]) => n);
    expect(conComodin).toEqual(['owner']);
  });

  it('los siete roles de los dos catálogos anteriores siguen existiendo', () => {
    // Los usuarios ya creados llevan estos nombres en users.roles: quitarlos
    // los dejaría sin permisos de golpe.
    expect(Object.keys(ROLES).sort()).toEqual(
      ['admin', 'auditor', 'contador', 'controller', 'owner', 'revisor', 'viewer']
    );
  });

  it('cada alias español es único: no hay dos roles compitiendo por la misma palabra', () => {
    const alias = Object.values(ROLES).map((r) => r.alias);
    expect(new Set(alias).size).toBe(alias.length);
  });

  it('un rol de sólo lectura no puede escribir en el mayor', () => {
    for (const rol of ['viewer', 'auditor'] as const) {
      const p = permissionsOf(rol);
      expect(p).not.toContain('journal_entries:post');
      expect(p).not.toContain('journal_entries:create');
      expect(p).not.toContain('journal_entries:void');
    }
  });

  it('cerrar un periodo no lo puede hacer cualquiera', () => {
    const pueden = Object.entries(ROLES)
      .filter(([, s]) => (s.permissions as readonly string[]).includes('periods:close'))
      .map(([n]) => n);
    expect(pueden.sort()).toEqual(['contador', 'controller']);
  });
});

describe('hasPermission', () => {
  it('el comodín autoriza cualquier verbo', () => {
    expect(hasPermission([COMODIN], 'journal_entries:post')).toBe(true);
  });

  it('sin el permiso concreto ni comodín, no', () => {
    expect(hasPermission(['accounts:read'], 'journal_entries:post')).toBe(false);
  });

  it('un rol desconocido no concede nada', () => {
    expect(permissionsOf('inventado')).toEqual([]);
  });
});
