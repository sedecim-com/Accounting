import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spanishJurisdictionPaths } from '../../src/plan/criterios.js';

// ============================================================
// LA CARPETA SE MIRA POR SU NOMBRE, NO POR LO QUE TENGA DENTRO
//
// WIT-198-01, de la revisión de #198. El criterio de I5 promete que la carpeta
// `jurisdiccion` está en cero bajo `src/`, y lo comprobaba con `fuentes('src')`,
// que enumera SÓLO archivos `.ts`. Una carpeta que volviera con un `.sql`, un
// `.json` o un `.md` dentro —y las migraciones y los catálogos sembrados son
// exactamente eso— no la veía nadie: el criterio seguía verde afirmando lo
// contrario de lo que pasaba.
//
// POR QUÉ ESTO ES UNA PRUEBA Y NO UN MUTANTE: el arnés de mutación sustituye o
// borra el contenido de un archivo que YA existe; no puede CREAR
// `src/services/jurisdiccion/esquema.sql`. La guarda sólo se puede ejercitar
// sobre un árbol de mentira, y por eso el recorrido se exporta.
// ============================================================

const withTree = (files: string[], run: (root: string) => void): void => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jur-'));
  try {
    for (const f of files) {
      const full = path.join(root, f);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '');
    }
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

describe('el recorrido de la carpeta española', () => {
  it('UN ARCHIVO QUE NO ES .ts NO LA ESCONDE', () => {
    // El caso exacto que el revisor nombró: sin esto, verde.
    withTree(['src/services/jurisdiccion/esquema.sql'], (root) => {
      expect(spanishJurisdictionPaths(root)).toEqual(['src/services/jurisdiccion']);
    });
  });

  it('una carpeta VACÍA cuenta igual: lo que se mira es el nombre', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jur-'));
    try {
      fs.mkdirSync(path.join(root, 'src', 'jurisdiccion'), { recursive: true });
      expect(spanishJurisdictionPaths(root)).toEqual(['src/jurisdiccion']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('la acentuada también, y sin importar mayúsculas', () => {
    // `jurisdicción` con tilde es el nombre que un renombrado a medias deja.
    withTree(['src/Jurisdicción/x.md'], (root) => {
      expect(spanishJurisdictionPaths(root)).toEqual(['src/Jurisdicción']);
    });
  });

  it('la carpeta INGLESA no se acusa: es el estado bueno', () => {
    withTree(['src/services/jurisdiction/jurisdiction.ts'], (root) => {
      expect(spanishJurisdictionPaths(root)).toEqual([]);
    });
  });

  it('no confunde un archivo llamado como la carpeta', () => {
    // `jurisdiccion.ts` es un ARCHIVO, y el criterio ya vigila los nombres
    // españoles por otro camino (el carril de nombres de archivo del metro).
    // Aquí se mira la carpeta, así que un archivo con ese nombre no cuenta dos
    // veces — pero SÍ cuenta el directorio que lo contenga.
    withTree(['src/services/accounting/jurisdiccion.ts'], (root) => {
      expect(spanishJurisdictionPaths(root)).toEqual([]);
    });
  });

  it('no se mete en node_modules ni en dist', () => {
    withTree(['node_modules/x/src/jurisdiccion/a.ts', 'dist/src/jurisdiccion/a.js'], (root) => {
      expect(spanishJurisdictionPaths(root)).toEqual([]);
    });
  });
});
