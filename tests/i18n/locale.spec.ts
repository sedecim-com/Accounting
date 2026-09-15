import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_ENV_VAR,
  LOCALE_ENV_VAR_ALIAS,
  describeLocale,
  languageOfLocale,
  normalizeLocale,
  resolveLocale,
} from '../../src/i18n/locale.js';

// ============================================================
// EL RESOLUTOR DE LOCALE (I6 · issue #148)
//
// TODA prueba de aquí pasa `argv`, `env`, `cwd` y `home` explícitos. No es
// ceremonia: `vitest.config.ts` exporta MNEMOSINE_LOCALE=en-US a la suite
// entera, y el `process.env` del que corre las pruebas puede traer un
// MNEMOSINE_LANG de su perfil. Una prueba de precedencia que dejara caer un
// escalón al entorno real mediría la máquina, no el resolutor — y el modo de
// fallo feo no es el rojo, es el verde en la máquina equivocada.
// ============================================================

let home: string;
let cwd: string;
let warnings: string[];

const NO_ARGV: readonly string[] = ['/usr/bin/node', '/opt/mnemosine/cli.js'];

function base() {
  return {
    argv: NO_ARGV,
    env: {} as NodeJS.ProcessEnv,
    cwd,
    home,
    onWarning: (message: string) => warnings.push(message),
  };
}

function writeUserConfig(config: unknown): void {
  fs.mkdirSync(path.join(home, '.mnemosine'), { recursive: true });
  fs.writeFileSync(path.join(home, '.mnemosine', 'config.json'), JSON.stringify(config));
}

function writeProjectConfig(config: unknown): void {
  fs.writeFileSync(path.join(cwd, 'mnemosine.config.json'), JSON.stringify(config));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-cwd-'));
  warnings = [];
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('normalizeLocale — el único juez de una etiqueta de locale', () => {
  it('canonicalizes the two languages and their bare aliases', () => {
    expect(normalizeLocale('es')).toBe('es-MX');
    expect(normalizeLocale('en')).toBe('en-US');
    expect(normalizeLocale('es-MX')).toBe('es-MX');
    expect(normalizeLocale('en-US')).toBe('en-US');
  });

  it('is insensitive to case and surrounding blanks', () => {
    // `MNEMOSINE_LANG=EN ` en un perfil de shell es un caso real: la conducta
    // previa a I6 hacía trim().toLowerCase() y no se pierde al mudarse aquí.
    expect(normalizeLocale(' ES-mx ')).toBe('es-MX');
    expect(normalizeLocale('EN')).toBe('en-US');
  });

  it('rejects a locale of the same language but another region instead of guessing', () => {
    // `es-ES` NO cae a `es-MX`: quien la escribe espera además formato español
    // (punto de miles, euro) y aquí el formato lo fija la jurisdicción. Decirle
    // que sí sería confirmarle una expectativa que el formateador no cumple.
    expect(normalizeLocale('es-ES')).toBeNull();
    expect(normalizeLocale('pt-BR')).toBeNull();
  });

  it('treats nothing, blanks and non-strings as absent', () => {
    expect(normalizeLocale('')).toBeNull();
    expect(normalizeLocale('   ')).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
  });
});

describe('languageOfLocale', () => {
  it('projects every supported locale onto a catalog language', () => {
    expect(languageOfLocale('es-MX')).toBe('es');
    expect(languageOfLocale('en-US')).toBe('en');
    // Un locale nuevo sin idioma sería un catálogo fantasma: la lista y el
    // mapeo se mueven juntos o esto se pone rojo.
    expect(LOCALES.map(languageOfLocale)).toEqual(['es', 'en']);
  });
});

describe('resolveLocale — la precedencia, escalón por escalón', () => {
  it('falls back to es-MX when nobody said anything', () => {
    const decision = describeLocale(base());
    expect(decision.locale).toBe(DEFAULT_LOCALE);
    expect(decision.locale).toBe('es-MX');
    expect(decision.kind).toBe('default');
    expect(decision.label).toBeNull();
  });

  it('--locale beats the environment variable', () => {
    const decision = describeLocale({
      ...base(),
      argv: [...NO_ARGV, 'balance', '--locale', 'en-US'],
      env: { [LOCALE_ENV_VAR]: 'es-MX' },
    });
    expect(decision.locale).toBe('en-US');
    expect(decision.kind).toBe('flag');
  });

  it('accepts --locale=<tag> as well as --locale <tag>', () => {
    expect(
      resolveLocale({ ...base(), argv: [...NO_ARGV, '--locale=en-US'] })
    ).toBe('en-US');
  });

  it('does not steal a --locale that comes after the end-of-options marker', () => {
    // `mnemosine chat -- --locale en-US` pasa esas palabras como ARGUMENTO.
    // Leerlas como bandera cambiaría el idioma por citar un texto.
    expect(
      resolveLocale({ ...base(), argv: [...NO_ARGV, 'chat', '--', '--locale', 'en-US'] })
    ).toBe('es-MX');
  });

  it('ignores a --locale with no value instead of eating the next flag', () => {
    const decision = describeLocale({
      ...base(),
      argv: [...NO_ARGV, '--locale', '--json'],
    });
    expect(decision.kind).toBe('default');
    expect(warnings).toEqual([]);
  });

  it('MNEMOSINE_LOCALE wins over its permanent alias MNEMOSINE_LANG', () => {
    const decision = describeLocale({
      ...base(),
      env: { [LOCALE_ENV_VAR]: 'en-US', [LOCALE_ENV_VAR_ALIAS]: 'es-MX' },
    });
    expect(decision.locale).toBe('en-US');
    expect(decision.label).toBe(LOCALE_ENV_VAR);
  });

  it('honours MNEMOSINE_LANG on its own — a permanent alias, not a deprecation', () => {
    // D10: está escrito en perfiles de shell y en imágenes que hoy funcionan.
    const decision = describeLocale({ ...base(), env: { [LOCALE_ENV_VAR_ALIAS]: 'en' } });
    expect(decision.locale).toBe('en-US');
    expect(decision.kind).toBe('env');
    expect(decision.raw).toBe('en');
  });

  it('treats an empty environment variable as unset, not as a locale named ""', () => {
    writeUserConfig({ locale: 'en-US' });
    expect(resolveLocale({ ...base(), env: { [LOCALE_ENV_VAR]: '' } })).toBe('en-US');
    expect(warnings).toEqual([]);
  });

  it('the environment beats both configuration files', () => {
    writeUserConfig({ locale: 'es-MX' });
    writeProjectConfig({ locale: 'es-MX' });
    expect(resolveLocale({ ...base(), env: { [LOCALE_ENV_VAR]: 'en-US' } })).toBe('en-US');
  });

  it('the USER config beats the PROJECT config — the opposite of every other key', () => {
    // El inquilino y el proveedor son del repositorio; el idioma es del humano.
    // Un mnemosine.config.json comiteado por el despacho no puede obligar a leer
    // en español al contador que se configuró el suyo en inglés (regla 5).
    writeUserConfig({ locale: 'en-US' });
    writeProjectConfig({ locale: 'es-MX' });
    const decision = describeLocale(base());
    expect(decision.locale).toBe('en-US');
    expect(decision.kind).toBe('user-config');
  });

  it('reads the project config when the user has none', () => {
    writeProjectConfig({ locale: 'en-US' });
    const decision = describeLocale(base());
    expect(decision.locale).toBe('en-US');
    expect(decision.kind).toBe('project-config');
  });

  it('the tenant setting is the last word before the default, and only if handed in', () => {
    expect(resolveLocale({ ...base(), tenantLocale: 'en-US' })).toBe('en-US');
    // Y pierde contra cualquier archivo: es el escalón más bajo.
    writeProjectConfig({ locale: 'es-MX' });
    expect(resolveLocale({ ...base(), tenantLocale: 'en-US' })).toBe('es-MX');
  });

  it('is synchronous and needs no database to answer', () => {
    // La firma es la prueba: si un día devuelve una promesa, esto no compila y
    // cada punto de impresión pasaría a poder fallar por la red.
    const answer: 'es-MX' | 'en-US' = resolveLocale(base());
    expect(LOCALES).toContain(answer);
  });
});

describe('resolveLocale — la clave vieja `language` conserva su orden viejo', () => {
  it('reads `language` when no `locale` key exists anywhere', () => {
    writeProjectConfig({ language: 'en' });
    const decision = describeLocale(base());
    expect(decision.locale).toBe('en-US');
    expect(decision.kind).toBe('legacy-config');
  });

  it('keeps PROJECT over USER for `language`, unlike the new key', () => {
    // `loadConfigFile` devuelve el PRIMER archivo que existe (proyecto antes que
    // usuario) y esa clave ya tiene lectores: darle aquí la precedencia nueva
    // habría cambiado en silencio el idioma de quien tiene los dos archivos.
    writeUserConfig({ language: 'es' });
    writeProjectConfig({ language: 'en' });
    expect(resolveLocale(base())).toBe('en-US');
  });

  it('an existing project config shadows the user file whole, key or no key', () => {
    // Conducta exacta de `loadConfigFile`: el primer archivo que EXISTE manda
    // entero. Con un proyecto sin `language`, el `language` del usuario nunca
    // se llegaba a leer, y eso no cambia en I6.
    writeUserConfig({ language: 'en' });
    writeProjectConfig({ default_provider: 'ollama' });
    expect(resolveLocale(base())).toBe('es-MX');
  });

  it('the new `locale` key beats the old `language` key in the same file', () => {
    writeProjectConfig({ locale: 'en-US', language: 'es' });
    expect(resolveLocale(base())).toBe('en-US');
  });
});

describe('resolveLocale — lo inservible avisa y cae al escalón siguiente', () => {
  it('warns about an unsupported environment value and keeps going down', () => {
    writeProjectConfig({ language: 'en' });
    const decision = describeLocale({ ...base(), env: { [LOCALE_ENV_VAR_ALIAS]: 'xx' } });
    expect(decision.locale).toBe('en-US');
    expect(decision.kind).toBe('legacy-config');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${LOCALE_ENV_VAR_ALIAS}="xx" is not supported`);
  });

  it('warns about an unsupported --locale instead of dying, and falls through', () => {
    const decision = describeLocale({ ...base(), argv: [...NO_ARGV, '--locale', 'pt-BR'] });
    expect(decision.locale).toBe('es-MX');
    expect(warnings[0]).toContain('--locale="pt-BR" is not supported');
  });

  it('skips a broken configuration file with a warning instead of throwing', () => {
    // Morir al imprimir un número porque el JSON del usuario tiene una coma de
    // más sería un modo de fallo nuevo peor que el defecto. La validación
    // estricta, con cuarentena, sigue estando en loadConfigFile.
    fs.mkdirSync(path.join(home, '.mnemosine'), { recursive: true });
    fs.writeFileSync(path.join(home, '.mnemosine', 'config.json'), '{ "locale": ');
    writeProjectConfig({ locale: 'en-US' });

    const decision = describeLocale(base());

    expect(decision.locale).toBe('en-US');
    expect(warnings.some((w) => w.includes('is not valid JSON'))).toBe(true);
  });

  it('ignores a `locale` key that is not a string', () => {
    writeProjectConfig({ locale: 42 });
    expect(resolveLocale(base())).toBe('es-MX');
    expect(warnings.some((w) => w.includes('is not a string'))).toBe(true);
  });
});
