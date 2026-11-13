import { describe, it, expect } from 'vitest';
import { xsdVerdictOf } from '../../src/services/sat/xsd-verdict.js';

// ============================================================
// The reader of xmllint's exit code, without xmllint.
//
// The validators' own specs run the installed xmllint, so they only ever see
// the exit codes of the libxml2 on this machine. The code for a document that
// cannot be parsed changed between releases (1 with 2.9.14, 4 with 2.15.2),
// and CI turned red the day its runner image changed. These cases pin both
// spellings, whatever is installed here.
// ============================================================

// What xmllint prints for `<BCE:Balanza` on stdin; the same text under both
// releases, only the exit code differs.
const NOT_WELL_FORMED = [
  '-:1: namespace error : Namespace prefix BCE on Balanza is not defined',
  '<BCE:Balanza',
  '            ^',
  "-:1: parser error : Couldn't find end of Start Tag Balanza line 1",
  '<BCE:Balanza',
  '            ^',
  '',
].join('\n');

describe('xsdVerdictOf', () => {
  it('0 is a valid document', () => {
    expect(xsdVerdictOf({ status: 0, stderr: '- validates\n' })).toEqual({ valid: true, errors: [] });
  });

  it('3 is a document that does not validate, with the lines xmllint named', () => {
    const stderr =
      "-:7: element Ctas: Schemas validity error : Element 'Ctas', attribute 'Inventado': " +
      "The attribute 'Inventado' is not allowed.\n- fails to validate\n";
    const verdict = xsdVerdictOf({ status: 3, stderr });
    expect(verdict.valid).toBe(false);
    expect(verdict.errors).toEqual([
      "line 7: element Ctas: Schemas validity error : Element 'Ctas', attribute 'Inventado': " +
        "The attribute 'Inventado' is not allowed.",
    ]);
  });

  it.each([
    [1, 'libxml2 2.9.14'],
    [4, 'libxml2 2.15.2'],
  ])('a document that is not well-formed is a verdict under exit code %i (%s)', (status) => {
    const verdict = xsdVerdictOf({ status, stderr: NOT_WELL_FORMED });
    expect(verdict.valid).toBe(false);
    expect(verdict.errors).toEqual([
      'line 1: namespace error : Namespace prefix BCE on Balanza is not defined',
      "line 1: parser error : Couldn't find end of Start Tag Balanza line 1",
    ]);
  });

  it.each([1, 4])('exit code %i that names no line of the document judged nothing, and throws', (status) => {
    expect(() => xsdVerdictOf({ status, stderr: 'warning: failed to load external entity "-"\n' })).toThrow(
      /setup problem/
    );
  });

  it('5, a schema that failed to compile, is a broken setup and throws with what xmllint said', () => {
    const stderr = 'WXS schema CatalogoCuentas_1_3.xsd failed to compile\n';
    expect(() => xsdVerdictOf({ status: 5, stderr })).toThrow(/exited with 5; this is a setup problem:\nWXS schema/);
  });

  it('a run killed by a signal has no exit code, and throws', () => {
    expect(() => xsdVerdictOf({ status: null, stderr: '' })).toThrow(/exited with null/);
  });
});
