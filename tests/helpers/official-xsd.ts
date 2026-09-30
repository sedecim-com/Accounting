// The validator moved to src/ with EFIRMA-4 (#442): the seal runs it before it
// hands a document over. The tests keep importing it from here.
export * from '../../src/services/sat/anexo24/official-xsd.js';
