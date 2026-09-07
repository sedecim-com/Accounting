import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * QUIÉN FIRMA — LAS PRUEBAS DE LA REGLA (G3).
 *
 * El defecto que cierra este módulo: `--user beto@despacho.mx` posteaba y la
 * bitácora —append-only desde la 033— certificaba a Beto sin que nadie lo
 * hubiera autenticado. El OIDC completo ya existía y no lo consumía ningún
 * comando contable.
 *
 * Se prueban las dos mitades por separado a propósito:
 *
 *  · `decidirSujeto` es la REGLA, y es pura. Se ejercita entera sin llavero,
 *    sin red y sin base: es lo único que garantiza que las siete
 *    combinaciones estén cubiertas y no sólo la feliz.
 *  · `sujetoAutenticado` es la MÁQUINA (llavero + proveedor). Se ejercita con
 *    el almacén y el verificador sustituidos, porque lo que se afirma aquí es
 *    en qué casos se NIEGA a devolver un sujeto.
 */

const { configFalso } = vi.hoisted(() => {
  const falso = {
    auth: {
      issuer: '',
      clientId: 'cli',
      audience: '',
      provider: 'oidc',
      tenantId: '',
      get enabled(): boolean {
        return Boolean(falso.auth.issuer && falso.auth.audience);
      },
    },
  };
  return { configFalso: falso };
});

vi.mock('../../src/config/index.js', () => ({ config: configFalso }));
vi.mock('../../src/auth/token-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/auth/token-store.js')>();
  return { ...real, loadToken: vi.fn() };
});
vi.mock('../../src/auth/oidc.js', () => ({ verifyIdpToken: vi.fn() }));

import {
  decidirSujeto,
  sujetoAutenticado,
  autenticacionExigida,
  reiniciarSujetoActivo,
  avisarIdentidadDeclarada,
  reiniciarAvisoDeIdentidad,
  mismoCorreo,
  SuplantacionError,
  SesionNoVerificableError,
  type SujetoAutenticado,
} from '../../src/auth/sujeto-activo.js';
import { loadToken } from '../../src/auth/token-store.js';
import { verifyIdpToken } from '../../src/auth/oidc.js';

const mockLoad = vi.mocked(loadToken);
const mockVerify = vi.mocked(verifyIdpToken);

const ANA: SujetoAutenticado = {
  subject: 'sub-ana-0001',
  email: 'ana@despacho.mx',
  issuer: 'https://idp.example.com',
};

const CON_IDP = { exigeAutenticacion: true };
const SIN_IDP = { exigeAutenticacion: false };

describe('decidirSujeto · la bandera restringe, nunca sustituye', () => {
  it('sin bandera, la identidad es la de la sesión', () => {
    expect(decidirSujeto(ANA, undefined, CON_IDP)).toEqual({
      email: 'ana@despacho.mx',
      subject: 'sub-ana-0001',
      autenticado: true,
    });
  });

  it('nombrarte a ti mismo se admite: es un no-op, no una afirmación', () => {
    expect(decidirSujeto(ANA, 'ANA@Despacho.MX', CON_IDP).email).toBe('ana@despacho.mx');
    expect(decidirSujeto(ANA, '  ana@despacho.mx  ', CON_IDP).autenticado).toBe(true);
  });

  it('nombrar a OTRO con sesión abierta se rechaza, y el error dice a quién y por qué', () => {
    let capturado: unknown;
    try {
      decidirSujeto(ANA, 'beto@despacho.mx', CON_IDP);
    } catch (err) {
      capturado = err;
    }
    expect(capturado).toBeInstanceOf(SuplantacionError);
    const mensaje = (capturado as Error).message;
    // Los dos sujetos, la razón (la bitácora no se corrige) y la salida.
    expect(mensaje).toContain('ana@despacho.mx');
    expect(mensaje).toContain('beto@despacho.mx');
    expect(mensaje).toMatch(/append-only/);
    expect(mensaje).toMatch(/entra como beto@despacho\.mx/);
  });

  it('la sustitución se niega TAMBIÉN cuando el despliegue no exige autenticar', () => {
    // Si hay sesión, hay con qué comprobar: que el despliegue no obligue a
    // tenerla no convierte a la bandera en válida para firmar por un tercero.
    expect(() => decidirSujeto(ANA, 'beto@despacho.mx', SIN_IDP)).toThrow(SuplantacionError);
  });

  it('con proveedor configurado y sin sesión, se niega en vez de degradar', () => {
    let capturado: unknown;
    try {
      decidirSujeto(null, 'beto@despacho.mx', CON_IDP);
    } catch (err) {
      capturado = err;
    }
    expect(capturado).toBeInstanceOf(SesionNoVerificableError);
    expect((capturado as Error).message).toMatch(/mnemosine login/);
  });

  it('sin proveedor, la bandera sigue mandando pero deja de ser autenticada', () => {
    expect(decidirSujeto(null, 'beto@despacho.mx', SIN_IDP)).toEqual({
      email: 'beto@despacho.mx',
      autenticado: false,
    });
  });

  it('sin proveedor y sin bandera, no inventa un correo: lo deduce el inquilino', () => {
    expect(decidirSujeto(null, undefined, SIN_IDP)).toEqual({
      email: undefined,
      autenticado: false,
    });
  });
});

describe('mismoCorreo', () => {
  it('ignora caja y espacios, y no confunde a dos personas distintas', () => {
    expect(mismoCorreo(' Ana@Despacho.MX ', 'ana@despacho.mx')).toBe(true);
    expect(mismoCorreo('ana@despacho.mx', 'ana+iva@despacho.mx')).toBe(false);
  });
});

describe('sujetoAutenticado · la máquina', () => {
  beforeEach(() => {
    reiniciarSujetoActivo();
    mockLoad.mockReset();
    mockVerify.mockReset();
    configFalso.auth.issuer = 'https://idp.example.com';
    configFalso.auth.audience = 'https://api.mnemosine.mx';
  });

  it('sin proveedor configurado no mira siquiera el llavero', async () => {
    configFalso.auth.issuer = '';
    configFalso.auth.audience = '';
    expect(autenticacionExigida()).toBe(false);

    await expect(sujetoAutenticado()).resolves.toBeNull();
    // Una credencial que no podemos comprobar no es una sesión; leerla
    // sería volver a creerle a un archivo.
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('sin credencial guardada devuelve null, que no es lo mismo que fallar', async () => {
    mockLoad.mockResolvedValue(null);
    await expect(sujetoAutenticado()).resolves.toBeNull();
  });

  it('una credencial de OTRO emisor no se usa, se explica', async () => {
    mockLoad.mockResolvedValue({
      accessToken: 't',
      expiresAt: Date.now() + 3_600_000,
      issuer: 'https://otro-idp.example.com',
    });
    await expect(sujetoAutenticado()).rejects.toThrow(SesionNoVerificableError);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('una sesión caducada no degrada a la bandera en silencio', async () => {
    mockLoad.mockResolvedValue({
      accessToken: 't',
      expiresAt: Date.now() - 1_000,
      issuer: 'https://idp.example.com',
    });
    await expect(sujetoAutenticado()).rejects.toThrow(/caducó/);
  });

  it('la FIRMA se verifica: un token que el proveedor no acepta no identifica a nadie', async () => {
    mockLoad.mockResolvedValue({
      accessToken: 'token-fabricado',
      expiresAt: Date.now() + 3_600_000,
      issuer: 'https://idp.example.com',
    });
    mockVerify.mockRejectedValue(new Error('signature verification failed'));

    await expect(sujetoAutenticado()).rejects.toThrow(/signature verification failed/);
    expect(mockVerify).toHaveBeenCalledWith('token-fabricado', {
      issuer: 'https://idp.example.com',
      audience: 'https://api.mnemosine.mx',
    });
  });

  it('un correo que el proveedor no da por verificado no elige usuario local', async () => {
    mockLoad.mockResolvedValue({
      accessToken: 't',
      expiresAt: Date.now() + 3_600_000,
      issuer: 'https://idp.example.com',
    });
    mockVerify.mockResolvedValue({
      issuer: 'https://idp.example.com',
      subject: 'sub-x',
      email: 'beto@despacho.mx',
      emailVerified: false,
      groups: [],
      expiresAt: Date.now() + 3_600_000,
    });

    await expect(sujetoAutenticado()).rejects.toThrow(/no da por verificado el correo/);
  });

  it('verifica una sola vez por proceso aunque el comando resuelva varias escrituras', async () => {
    mockLoad.mockResolvedValue({
      accessToken: 't',
      expiresAt: Date.now() + 3_600_000,
      issuer: 'https://idp.example.com',
    });
    mockVerify.mockResolvedValue({
      issuer: 'https://idp.example.com',
      subject: 'sub-ana-0001',
      email: 'ana@despacho.mx',
      emailVerified: true,
      groups: [],
      expiresAt: Date.now() + 3_600_000,
    });

    expect(await sujetoAutenticado()).toEqual(ANA);
    expect(await sujetoAutenticado()).toEqual(ANA);
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });
});

describe('avisarIdentidadDeclarada', () => {
  beforeEach(() => reiniciarAvisoDeIdentidad());

  it('sale por stderr una sola vez, para que no se convierta en ruido', () => {
    const escrito: string[] = [];
    const espia = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        escrito.push(String(chunk));
        return true;
      });
    try {
      avisarIdentidadDeclarada('beto@despacho.mx');
      avisarIdentidadDeclarada('beto@despacho.mx');
    } finally {
      espia.mockRestore();
    }
    expect(escrito).toHaveLength(1);
    expect(escrito[0]).toMatch(/beto@despacho\.mx/);
    expect(escrito[0]).toMatch(/DECLARADO, no autenticado/);
  });
});
