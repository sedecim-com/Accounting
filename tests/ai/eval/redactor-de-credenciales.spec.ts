import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { profileForMeasuring, recordarSecreto, sinSecretos } from '../../../scripts/eval-clasificador.js';
import { MissingProviderCredentialError, resolveProfile } from '../../../src/ai/providers/config.js';
import { CredentialHelperError } from '../../../src/ai/providers/credential-helper.js';
import { createOpenAiClient } from '../../../src/ai/providers/openai-client.js';
import { ExitCode } from '../../../src/cli/kernel/exit.js';

// ============================================================
// EL REDACTOR DEL ARNÉS, PROBADO POR CONDUCTA.
//
// CodeQL marcó el catch de la entrada por registro en claro (alerta #24). No
// puede ver `sinSecretos` como saneador, pero tuvo razón DOS veces:
//
//  · el registro de la credencial iba después de la llamada que la lee del
//    entorno, así que un fallo en esa llamada la imprimía sin tachar;
//  · y la clase de caracteres del redactor era `[A-Za-z0-9._-]`, que PARTE una
//    llave con `+`, `/` o `=`. La huella de un trozo no casa la del valor
//    entero, de modo que una credencial base64 con relleno salía íntegra.
//
// Esto último no se ve leyendo el regex: se ve ejerciéndolo. Por eso el
// redactor se exporta y se prueba aquí con llaves de las formas que los
// proveedores emiten de verdad.
// ============================================================

const FORMAS: Array<[string, string]> = [
  ['estilo OpenAI', 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
  ['estilo Google', 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'],
  ['base64 con relleno', 'aB3+xY9/kL2mN4pQ7rS1tU6vW8zA0bC5dE7fG9h='],
  ['base64url', 'aB3-xY9_kL2mN4pQ7rS1tU6vW8zA0bC5dE7fG9h'],
  ['hexadecimal largo', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4'],
];

describe('el redactor tacha la credencial, sea cual sea su forma', () => {
  it.each(FORMAS)('%s: no sobrevive al mensaje de un error', (_forma, llave) => {
    recordarSecreto(llave);
    const salida = sinSecretos(`eval-clasificador: request failed with key ${llave} against the provider`);
    expect(salida, 'la credencial salió entera al registro').not.toContain(llave);
    // Y el resto del mensaje sigue sirviendo: un redactor que borra el
    // diagnóstico entero se acaba desactivando, que es peor.
    expect(salida).toContain('request failed');
    expect(salida).toContain('against the provider');
  });

  it('lo que NO es la credencial se queda: tachar de más mata el diagnóstico', () => {
    recordarSecreto('AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6');
    const salida = sinSecretos('no se pudo abrir /Users/victor/projects/Accounting/scripts/eval-clasificador.ts');
    expect(salida).toContain('eval-clasificador.ts');
    expect(salida).toContain('projects/Accounting');
  });

  it('una cadena corta no se registra: no vale la pena y llenaría de falsos el tachado', () => {
    recordarSecreto('corta');
    expect(sinSecretos('el valor corta aparece aquí')).toContain('corta');
  });
});

// ============================================================
// MNE-001-446 (#644): el token que un helper RENUEVA a media corrida también
// se tacha, y se registra ANTES de viajar. Helper sintético y HOME temporal.
// ============================================================

describe('el redactor conoce cada token del helper, renovados incluidos', () => {
  let home: string;
  let folder: string;
  let perRequest: Array<{ token: string; redacted: boolean }>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'redactor-home-'));
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'redactor-folder-'));
    perRequest = [];
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('MNEMOSINE_PROVIDER', '');
    vi.stubEnv('OPENAI_BASE_URL', '');
    const counter = path.join(home, 'corridas');
    fs.mkdirSync(path.join(home, '.mnemosine'));
    fs.writeFileSync(
      path.join(home, '.mnemosine', 'config.json'),
      JSON.stringify({
        providers: {
          boveda: {
            type: 'openai-compatible', model: 'm', base_url: 'https://v.example.test/v1',
            api_key_cmd: `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'; printf 'aB3+xY9/kL2mN4pQ7rS1-%s=' "$n"`,
          },
        },
      })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        // EN EL MOMENTO de la petición: el token ya tiene que estar registrado.
        const token = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '');
        perRequest.push({ token, redacted: !sinSecretos(`fallo con ${token}`).includes(token) });
        return new Response(
          JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('el primero y el renovado salen redacteds, y ninguno viaja antes de registrarse', async () => {
    const profile = resolveProfile('boveda', undefined, folder);
    recordarSecreto(profile.apiKey);
    const client = createOpenAiClient(profile, { onCredential: recordarSecreto });
    const send = () => client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'hola' }] });
    await send();
    profile.keyRenewal!.markStale();
    await send();
    expect(perRequest.map((p) => p.token)).toEqual(['aB3+xY9/kL2mN4pQ7rS1-1=', 'aB3+xY9/kL2mN4pQ7rS1-2=']);
    expect(perRequest.every((p) => p.redacted), 'un token viajó sin que el redactor lo conociera').toBe(true);
  });

  it('el arnés le pasa su redactor a la sesión', () => {
    const source = fs.readFileSync(path.resolve('scripts/eval-clasificador.ts'), 'utf-8');
    expect(source).toMatch(/onCredential: recordarSecreto,/);
  });
});

describe('sin credencial el arnés dice «no pude medir» (8) y la variable que falta', () => {
  it('una llave ausente o un helper roto son NoPudeMedir; otro error sigue siendo un fallo', () => {
    const catchError = (fn: () => unknown): Error => {
      try {
        fn();
      } catch (err) {
        return err as Error;
      }
      throw new Error('no lanzó');
    };
    const missingKey = catchError(() =>
      profileForMeasuring(() => {
        throw new MissingProviderCredentialError('Provider "openai" requires the environment variable OPENAI_API_KEY');
      })
    );
    expect(missingKey.name).toBe('NoPudeMedir');
    expect(missingKey.message).toMatch(/OPENAI_API_KEY/);
    const brokenHelper = catchError(() =>
      profileForMeasuring(() => {
        throw new CredentialHelperError('boveda', { kind: 'exit', code: 2 });
      })
    );
    expect(brokenHelper.name).toBe('NoPudeMedir');
    expect(catchError(() => profileForMeasuring(() => {
      throw new Error('Provider "x" does not exist');
    })).name).toBe('Error');
    // Y el catch de la entrada saca NoPudeMedir por 8 (EXTERNAL_FAILED), no por 1.
    const source = fs.readFileSync(path.resolve('scripts/eval-clasificador.ts'), 'utf-8');
    expect(source).toContain('process.exit(err instanceof NoPudeMedir ? ExitCode.EXTERNAL_FAILED : ExitCode.FAILURE);');
    expect(ExitCode.EXTERNAL_FAILED).toBe(8);
  });
});
