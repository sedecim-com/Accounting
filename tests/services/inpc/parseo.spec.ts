import { describe, it, expect } from 'vitest';
import { parsearSerieInpc } from '../../../src/services/fiscal/inpc/parseo.js';
import { formatearPeriodo } from '../../../src/services/fiscal/inpc/periodo.js';
import { ValidationError } from '../../../src/utils/errors.js';

/**
 * El archivo del INPC lo arma una persona a partir de lo que publica el DOF o
 * el INEGI, y por eso todo lo que aquí se rechaza se rechaza NOMBRANDO LA
 * LÍNEA: un «archivo inválido» sobre trescientas filas obliga a adivinar, y
 * quien adivina borra filas hasta que pasa.
 */

const B2018 = '2018-Jul2=100';

function atrapar(fn: () => unknown): ValidationError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return err as ValidationError;
  }
  throw new Error('se esperaba que lanzara y no lanzó');
}

describe('parsearSerieInpc — formas que acepta', () => {
  it('lee el orden fijo anio,mes,valor con la base de la invocación', () => {
    const filas = parsearSerieInpc('2024,1,132.373\n2024,2,133.681\n', { base: B2018 });
    expect(filas).toHaveLength(2);
    expect(formatearPeriodo(filas[0].periodo)).toBe('2024-01');
    expect(filas[0].valor).toBe('132.373');
    expect(filas[0].base).toBe(B2018);
    expect(filas[0].linea).toBe(1);
    expect(filas[1].linea).toBe(2);
  });

  it('lee encabezado por nombre, con acentos y en cualquier orden', () => {
    const filas = parsearSerieInpc(
      'Base;Índice;Año;Mes\n2010=100;98.795;2018;1\n',
      {}
    );
    expect(filas[0]).toMatchObject({ valor: '98.795', base: '2010=100' });
    expect(formatearPeriodo(filas[0].periodo)).toBe('2018-01');
  });

  it('lee una columna «periodo» en vez de año y mes', () => {
    const filas = parsearSerieInpc('periodo\tvalor\n2024-07\t133.555\n', { base: B2018 });
    expect(formatearPeriodo(filas[0].periodo)).toBe('2024-07');
  });

  it('acepta la fecha de publicación y deja null cuando no viene', () => {
    const filas = parsearSerieInpc(
      'anio,mes,valor,base,publicado_el\n2024,7,133.555,2018-Jul2=100,2024-08-09\n2024,8,133.782,2018-Jul2=100,\n',
      {}
    );
    expect(filas[0].publicadoEl).toBe('2024-08-09');
    expect(filas[1].publicadoEl).toBeNull();
  });

  it('ignora líneas en blanco, comentarios y comillas de exportador', () => {
    const filas = parsearSerieInpc(
      '# INPC publicado en el DOF\n\n"2024","1","132.373"\n\n', { base: B2018 }
    );
    expect(filas).toHaveLength(1);
    expect(filas[0].valor).toBe('132.373');
    // La línea reportada es la del ARCHIVO, no la del arreglo filtrado.
    expect(filas[0].linea).toBe(3);
  });

  it('conserva el orden del archivo, aunque venga desordenado', () => {
    const filas = parsearSerieInpc('2024,3,x\n'.replace('x', '133.555') + '2024,1,132.373\n', {
      base: B2018,
    });
    expect(filas.map((f) => formatearPeriodo(f.periodo))).toEqual(['2024-03', '2024-01']);
  });
});

describe('parsearSerieInpc — LA BASE NO SE ADIVINA', () => {
  it('rechaza la fila sin base cuando la invocación tampoco la trae', () => {
    const err = atrapar(() => parsearSerieInpc('2024,1,132.373\n'));
    expect(err.message).toContain('Línea 1');
    expect(err.message).toContain('--base');
  });

  it('la base de la fila gana sobre la de la invocación', () => {
    const filas = parsearSerieInpc('2018,1,128.832,2010=100\n2024,1,132.373\n', { base: B2018 });
    expect(filas[0].base).toBe('2010=100');
    expect(filas[1].base).toBe(B2018);
  });

  it('rechaza una base en blanco pasada a mano', () => {
    expect(() => parsearSerieInpc('2024,1,132.373\n', { base: '  ' })).toThrow(ValidationError);
  });
});

describe('parsearSerieInpc — lo que rechaza nombrando la línea', () => {
  it('el mes 13', () => {
    const err = atrapar(() => parsearSerieInpc('2024,1,132.373\n2024,13,133.0\n', { base: B2018 }));
    expect(err.message).toContain('Línea 2');
  });

  it('un índice que no es número', () => {
    const err = atrapar(() => parsearSerieInpc('2024,1,n/d\n', { base: B2018 }));
    expect(err.message).toContain('Línea 1');
    expect(err.message).toContain('no es un número');
  });

  it('un índice negativo o cero', () => {
    expect(() => parsearSerieInpc('2024,1,0\n', { base: B2018 })).toThrow(ValidationError);
    expect(() => parsearSerieInpc('2024,1,-1.5\n', { base: B2018 })).toThrow(ValidationError);
  });

  it('más de seis decimales, que Postgres redondearía en silencio', () => {
    const err = atrapar(() => parsearSerieInpc('2024,1,132.3731234\n', { base: B2018 }));
    expect(err.message).toContain('DECIMAL(12,6)');
  });

  it('una fecha de publicación que no es AAAA-MM-DD', () => {
    const err = atrapar(() =>
      parsearSerieInpc('anio,mes,valor,base,publicado_el\n2024,7,133.555,x,09/08/2024\n', {})
    );
    expect(err.message).toContain('AAAA-MM-DD');
  });

  it('el mismo mes y base dos veces, aunque los valores coincidan', () => {
    const err = atrapar(() =>
      parsearSerieInpc('2024,1,132.373\n2024,1,132.373\n', { base: B2018 })
    );
    expect(err.message).toContain('línea 1');
    expect(err.message).toContain('Línea 2');
  });

  it('acepta el mismo mes en DOS bases: son dos series, no un duplicado', () => {
    const filas = parsearSerieInpc('2018,1,128.832,2010=100\n2018,1,98.795,2018-Jul2=100\n', {});
    expect(filas).toHaveLength(2);
  });

  it('un archivo vacío o sólo con comentarios', () => {
    expect(() => parsearSerieInpc('', { base: B2018 })).toThrow(ValidationError);
    expect(() => parsearSerieInpc('# nada\n\n', { base: B2018 })).toThrow(ValidationError);
  });

  it('un encabezado que no dice cuál columna es el índice', () => {
    const err = atrapar(() => parsearSerieInpc('anio,mes,comentario\n2024,1,hola\n', { base: B2018 }));
    expect(err.message).toContain('encabezado');
  });

  it('un archivo con encabezado y ninguna fila', () => {
    expect(() => parsearSerieInpc('anio,mes,valor\n', { base: B2018 })).toThrow(ValidationError);
  });
});
