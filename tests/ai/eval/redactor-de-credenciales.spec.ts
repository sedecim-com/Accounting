import { describe, it, expect } from 'vitest';
import { recordarSecreto, sinSecretos } from '../../../scripts/eval-clasificador.js';

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
