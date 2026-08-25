// ============================================================
// PALETTE
// Hand-rolled ANSI colors, extracted from the inline helper in
// mnemosine.ts so every CLI surface shares one gate:
//   - color only on a real terminal (stream.isTTY === true);
//   - honor NO_COLOR (https://no-color.org);
//   - piped/redirected output stays byte-clean.
// When the gate is closed every function is the identity, so
// callers can apply colors unconditionally and let degradation
// happen here. Pure module: no I/O, no state.
// ============================================================

export interface Palette {
  dim(s: string): string;
  bold(s: string): string;
  cyan(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
}

export function palette(stream: NodeJS.WriteStream): Palette {
  const on = stream.isTTY === true && !process.env.NO_COLOR;
  const wrap = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    dim: wrap('2'),
    bold: wrap('1'),
    cyan: wrap('36'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
  };
}
