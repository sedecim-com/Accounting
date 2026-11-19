/**
 * How a repository instrument ends without cutting its own output short (#659).
 *
 * On a pipe Node's stdout drains asynchronously, so exiting with
 * `process.exit` right after `main` dropped whatever the pipe had not taken
 * yet. Setting `process.exitCode`
 * instead lets Node exit on its own once stdout has drained (the pattern of
 * #408 in `scripts/openapi.ts`).
 *
 * Draining has one new failure: a reader that stops early (`| head -1`) closes
 * the pipe, and the writes still queued fail with EPIPE, which Node raises as
 * an unhandled `'error'` event. Nobody is left to read, so the script leaves
 * quietly with the code its `main` returned. Any other stdout error is
 * rethrown, as Node would have done without the listener.
 *
 * `code` is a number, not a promise: every caller's `main` is synchronous, and
 * the type keeps an async one from setting its exit code before it finishes.
 */
export function exitWhenDrained(code: number): void {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
    process.exit(code);
  });
  process.exitCode = code;
}
