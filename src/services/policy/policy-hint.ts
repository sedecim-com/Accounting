// ============================================================
// HOW A MESSAGE TELLS THE ACCOUNTANT TO CHANGE A PANEL DECISION (#300)
//
// Fourteen messages used to send the accountant to `mnemosine pending
// resolve <key>`, a verb the binary never had. The real path depends on the
// state of the row, which the message cannot see: `pending define` only
// accepts a key that is still PENDING (it answers NOT_FOUND otherwise), and
// `pending reopen` refuses one that already is. So the hint names both, in
// the order they run. One function, so the fourteen sites cannot drift apart
// again; the `messages-cite-live-commands` criterion checks the verbs.
// ============================================================

/** The two commands that change the decision `key`, whatever its state. */
export function changePolicyHint(key: string): string {
  return `\`mnemosine pending reopen ${key}\` (si ya estaba definida) y luego \`mnemosine pending define ${key}\``;
}
