/**
 * El colector de avisos, con tope.
 *
 * Un extracto de cinco mil líneas mal codificado produce cinco mil avisos
 * idénticos, y una lista así no la lee nadie: el aviso deja de ser información
 * y pasa a ser el motivo por el que se ignoran los avisos. El tope corta la
 * enumeración pero NO la cuenta —el resumen final dice cuántos quedaron
 * fuera—, así que el llamador nunca cree que hubo menos problemas de los que
 * hubo.
 */
export interface ColectorAvisos {
  agregar(mensaje: string): void;
  /**
   * Agrega el mensaje UNA sola vez por clave. Para lo que se repite por
   * naturaleza: una etiqueta MT940 desconocida aparece en cada línea del
   * archivo y decirlo trescientas veces no añade nada a decirlo una.
   */
  agregarUnaVez(clave: string, mensaje: string): void;
  listar(): string[];
  total(): number;
}

export function crearAvisos(max = 200): ColectorAvisos {
  const mensajes: string[] = [];
  const vistas = new Set<string>();
  let total = 0;

  return {
    agregar(mensaje: string): void {
      total++;
      if (mensajes.length < max) mensajes.push(mensaje);
    },
    agregarUnaVez(clave: string, mensaje: string): void {
      if (vistas.has(clave)) return;
      vistas.add(clave);
      this.agregar(mensaje);
    },
    listar(): string[] {
      if (total <= mensajes.length) return [...mensajes];
      return [
        ...mensajes,
        `… y ${total - mensajes.length} avisos más, omitidos por el tope de ${max}.`,
      ];
    },
    total(): number {
      return total;
    },
  };
}

/**
 * Recorta el contenido de una fila para citarla en un aviso.
 *
 * La fila corrupta se cita ENTERA-hasta-un-límite y no se resume, porque el
 * aviso sólo sirve si quien lo lee puede abrir el archivo, ir a esa línea y
 * ver lo mismo. Un aviso que dice «fila inválida» sin la fila obliga a
 * reproducir el import para saber qué pasó.
 */
export function recortar(texto: string, max = 160): string {
  const limpio = texto.replace(/\r?\n/g, '⏎');
  return limpio.length <= max ? limpio : `${limpio.slice(0, max)}…`;
}
