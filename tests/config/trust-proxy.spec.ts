import { describe, it, expect } from 'vitest';
import { resolverTrustProxy } from '../../src/api/rest/trust-proxy.js';

// ============================================================
// `trust proxy` decide de dónde sale `req.ip`, y `req.ip` es la única identidad
// que tiene el limitador antes de autenticar — el único freno de /public/v1 y
// de los webhooks de IA, que sirven sin JWT.
//
// Lo que se prueba aquí es sobre todo lo que NO debe pasar: que la ausencia de
// configuración no se convierta sola en «confía en quien llama». Un defecto que
// falla hacia el cubo compartido es ruidoso y se arregla; uno que falla hacia
// la cabecera falsificable apaga el limitador sin que nadie lo note.
// ============================================================

describe('resolverTrustProxy — el defecto no se puede eludir', () => {
  it('sin variable, no confía en nadie', () => {
    expect(resolverTrustProxy(undefined).valor).toBe(false);
  });

  it('la cadena vacía es lo mismo que no ponerla', () => {
    expect(resolverTrustProxy('   ').valor).toBe(false);
  });

  it('en desarrollo, la ausencia no genera aviso: no suele haber proxy delante', () => {
    expect(resolverTrustProxy(undefined, 'development').aviso).toBeUndefined();
  });

  it('en producción, la ausencia SÍ avisa — es donde hay balanceador', () => {
    const { valor, aviso } = resolverTrustProxy(undefined, 'production');
    expect(valor).toBe(false);
    expect(aviso).toMatch(/un solo cubo/);
  });
});

describe('resolverTrustProxy — apagado explícito', () => {
  it.each(['false', 'FALSE', '0', 'off', 'no', 'none'])('%s apaga sin avisar', (crudo) => {
    const { valor, aviso } = resolverTrustProxy(crudo, 'production');
    expect(valor).toBe(false);
    // Apagarlo A PROPÓSITO en producción es una respuesta válida —la app puede
    // estar expuesta directamente— y no merece el aviso de la ausencia.
    expect(aviso).toBeUndefined();
  });

  it("'false' no se interpreta como una IP llamada «false»", () => {
    // Sin la lista de apagado, esto caería en la rama de lista y produciría
    // ['false'], que Express rechaza al arrancar. El fallo sería en el
    // despliegue, no aquí.
    expect(resolverTrustProxy('false').valor).not.toEqual(['false']);
  });
});

describe('resolverTrustProxy — true se acepta y se señala', () => {
  it('produce true, porque Express lo admite y alguien puede quererlo', () => {
    expect(resolverTrustProxy('true').valor).toBe(true);
  });

  it('pero avisa de que la cabecera la escribe quien llama', () => {
    expect(resolverTrustProxy('true').aviso).toMatch(/X-Forwarded-For/);
  });

  it('avisa también en desarrollo: el riesgo no depende del entorno', () => {
    expect(resolverTrustProxy('true', 'development').aviso).toBeDefined();
  });
});

describe('resolverTrustProxy — saltos y redes', () => {
  it('un entero es el número de proxies delante', () => {
    expect(resolverTrustProxy('1').valor).toBe(1);
    expect(resolverTrustProxy('2').valor).toBe(2);
  });

  it('cero es válido y equivale a no confiar en ningún salto', () => {
    expect(resolverTrustProxy('0').valor).toBe(false);
  });

  it('una red CIDR viaja como lista', () => {
    expect(resolverTrustProxy('10.0.0.0/8').valor).toEqual(['10.0.0.0/8']);
  });

  it('varias redes, separadas por comas y sin espacios de más', () => {
    expect(resolverTrustProxy(' 10.0.0.0/8 , 172.16.0.0/12 ').valor).toEqual([
      '10.0.0.0/8',
      '172.16.0.0/12',
    ]);
  });

  it('acepta los nombres que entiende proxy-addr', () => {
    expect(resolverTrustProxy('loopback,uniquelocal').valor).toEqual(['loopback', 'uniquelocal']);
  });

  it('una lista de comas vacías no produce una lista vacía, que Express aceptaría como «nadie»', () => {
    expect(resolverTrustProxy(',,,').valor).toBe(false);
  });

  it('un valor con saltos no cae nunca en true por accidente', () => {
    // El riesgo real de un parser laxo: cualquier cosa rara acabando en
    // «confía en todos». Ninguna entrada salvo el literal 'true' lo produce.
    for (const crudo of ['1', 'loopback', '10.0.0.0/8', 'basura', '-1', '1.5']) {
      expect(resolverTrustProxy(crudo).valor).not.toBe(true);
    }
  });
});
