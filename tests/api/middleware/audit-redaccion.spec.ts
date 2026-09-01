import { describe, it, expect } from 'vitest';
import { redactarSensibles } from '../../../src/api/rest/middleware/audit.js';

/**
 * LA BITÁCORA NO GUARDA EN CLARO LO QUE LAS TABLAS CIFRAN (S1).
 *
 * El middleware escribía JSON.stringify(req.body) entero en
 * audit_log.new_values — ssn y CLABE en claro en la única tabla que la 033
 * volvió inmutable hasta para el dueño del esquema. Esto fija el contrato de
 * la redacción; el criterio de E0.3 vigila que el middleware la use.
 */
describe('redactarSensibles', () => {
  it('sustituye los campos sensibles a cualquier profundidad', () => {
    const cuerpo = {
      name: 'Ana',
      ssn: '123-45-6789',
      bank: { clabe: '032180000118359719', bank_account_number: '0118359719' },
      history: [{ password: 'hunter2', note: 'ok' }],
    };
    const r = redactarSensibles(cuerpo) as Record<string, unknown>;
    expect(r.name).toBe('Ana');
    expect(r.ssn).toBe('[REDACTADO]');
    expect((r.bank as Record<string, unknown>).clabe).toBe('[REDACTADO]');
    expect((r.bank as Record<string, unknown>).bank_account_number).toBe('[REDACTADO]');
    expect((r.history as Array<Record<string, unknown>>)[0].password).toBe('[REDACTADO]');
    expect((r.history as Array<Record<string, unknown>>)[0].note).toBe('ok');
  });

  it('la clave se compara sin mayúsculas: SSN y Clabe no se escapan por grafía', () => {
    const r = redactarSensibles({ SSN: 'x', Clabe: 'y', CURP: 'z' }) as Record<string, unknown>;
    expect(r.SSN).toBe('[REDACTADO]');
    expect(r.Clabe).toBe('[REDACTADO]');
    expect(r.CURP).toBe('[REDACTADO]');
  });

  it('no toca escalares, null ni el cuerpo entero cuando nada es sensible', () => {
    expect(redactarSensibles(null)).toBeNull();
    expect(redactarSensibles('texto')).toBe('texto');
    expect(redactarSensibles({ amount: '100.00', vendor: 'ACME' })).toEqual({
      amount: '100.00',
      vendor: 'ACME',
    });
  });

  it('no muta el original: la respuesta al cliente no debe salir redactada', () => {
    const cuerpo = { ssn: 'real', nested: { key: 'k' } };
    redactarSensibles(cuerpo);
    expect(cuerpo.ssn).toBe('real');
    expect(cuerpo.nested.key).toBe('k');
  });
});
