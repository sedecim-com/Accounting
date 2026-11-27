# 07 · Backlog and release mechanics (slug `07-backlog-release`)

Read-only review, 27 Nov 2026. Tree: the repository at develop `e9a327d0` (#1061 merged). Sources: `docs/backlog/PRD-001.json` (853 entries: 795 tasks, 58 decisions, all decisions done), `docs/MVP.md`, `docs/SCOPE.md`, `docs/PROCESS.md`, `docs/RUNBOOK.md`, `docs/ROUTING.md`, `docs/prd/*`, `docs/adr/0008`, `package.json`, `.github/workflows/ci.yml`, git refs, and issues #952, #603, #333, #338 (read), the open-issue list (labels only).

Measured today:
- `npm run plan:status`: **14 of 16 packages green, 261 criteria, 12 ▶ all green**. Red: E4.2 (3 copies of the balance SQL outside report-service) and E5.1 (agent tools not derived from the risk registry; `--continue` does not rehydrate).
- `npm run catalogo:estado`: 298 commands in 81 families; 282 of 1,651 catalogue rows invocable. (The command rewrote its block byte-identically; `git status` clean.)
- Backlog: wave 3 open 37 in the JSON (774, 775, 857, 855 already merged and not yet marked; 800 part 1 merged, its part 2 is 859 in PR #1064; 856 in PR #1062; history PR #1065 open) → **33 really open, 2 of them in PR**. Wave 4 open **312** (16 Must, 143 Should, 153 Could; 74,125 est. lines). 85 of those acceptances say «ola 4» in their text.
- Merge rate on develop (first-parent): 26 Nov UTC 36 merges (30 task PRs); 25 Nov 43 (37); 24 Nov 64 (53); none on Sat–Sun 21–22 Nov. Last 30 merges: median gap 51 min. So one merge per CI cycle is ~28 a day if the queue never empties; the planning figure given (12–15 a day) is about half the measured ceiling. Mean diff of the last 60 merges: 467 changed lines, 39 of 60 over 400 (the 400 cap is on hand-written lines, and backlog sizes run low: yesterday's review found 801 at 2×, 733 at 3×, 478 at 7×).

## 1. The exact set «v1.0»

### 1.0 Counts (312 open wave-4 tasks)

| Class | Tasks | Est. lines | Must / Should / Could | Lanes |
|---|---|---|---|---|
| **V1** marked v1.0, on the 7 issues of MVP.md §3 | 29 | 7,870 | 10 / 9 / 10 | A2 B5 E6 F3 G3 H1 P4 X5 |
| **V2** on a v1.0 issue, unmarked (765, 308) | 2 | 270 | 0 / 1 / 1 | X1 F1 |
| **V3** open dependency of V1 (500, 501 of #696) | 2 | 350 | 0 / 2 / 0 | C2 |
| **V-RS** #952 remote surface (RS-1: «first deliverable of v1.0») | 28 | 7,870 | 0 / 25 / 3 | S15 U13 |
| **P-us** United States only (D-03) | 22 | 6,640 | 0 / 1 / 21 | B C D E F G H S |
| **P-rename** internal renaming I12–I26 (D-05) | 53 | 17,310 | 0 / 1 / 52 | 0 22, L23, A E F G U |
| **P-platform** Sedecim platform (D-08) | 7 | 1,600 | 0 / 4 / 3 | P7 |
| **SEC** sensitive issues (numbers only) | 13 | 2,460 | 3 / 9 / 1 | S10 B2 F1 |
| **O** other wave-4 work, no v1.0 mark | 156 | 29,755 | 3 / 91 / 62 | all |
| Total | 312 | 74,125 | 16 / 143 / 153 | |

Facts the coordinator needs before using the word «v1.0»:
1. **The brief's «31» is 29 + 2.** 29 acceptances carry the exact phrase on the seven issues of MVP.md §3; the other two are 691 and 692 of **#952**, whose RS-1 answer (26 Nov, comment 7194459710) makes the remote surface «the first deliverable of v1.0». `docs/MVP.md` §3 does not list #952, and only 2 of its 28 tasks carry the mark. «Todo lo de la versión 1.0» is therefore either 33 tasks (V1+V2+V3, ~8,500 lines) or 61 tasks (with #952, ~16,400 lines). **Owner decision.**
2. **Six of the 16 wave-4 Must tasks are not v1.0 by any text:** 637, 638 (#953, the 2027 payroll parameters, date-gated), 643 (#593), 640 (#590), 653, 654 (#598). The other ten are #111 (300, 854) and #123 (324–331).
3. **V1 is not self-contained:** 296 depends on 501 → 500 (#696, unmarked), and 171 depends on 467 (wave 3, not started, needs a migration).
4. **#123's Must tasks 327 and 329 are United States content** (US legal parameters, US fiscal chart). The owner raised all of #123 to Must on 18 Nov and the same day answered «Aparcado» for what is only United States (D-03). The backlog keeps both as Must v1.0. Flagged, not resolved.
5. **#158:** only 171, 172, 173 are marked (the Concepto in Spanish). 174, 175, 176 are the rest of tranche I16 and are classed here as P-rename, with 388 (#327), which depends on 176.
6. **The v1.0 of MVP.md is not PRD-003.** PRD-003 §8 lists RF-01, RF-04–08, RF-13–15, RF-17, RF-18, RF-22, RF-23, RF-25, RF-27–30, RF-32–37, RF-39, RF-40, RF-42, RF-45–51 as «sin tarea todavía». A release made of set V delivers the 18 Nov list, not «el producto completo».

### 1.1 Set V, task by task

**V1 · marked «alcance de la v1.0» and hanging on an issue docs/MVP.md §3 names** — 29 tasks, 7,870 est. lines

| id | issue | lane | prio | size | depends_on (* = open) | what it needs |
|---|---|---|---|---|---|---|
| 296 | #105 | B | Should | 350 | 295, 501* | waits 501 (#696); reads the CSD through withCredential; official cadena-original XSLT; ~2 PRs |
| 297 | #105 | B | Could | 300 | 296* | after 296; adjusts to 534's plan (Sovos cancel = signed Cancelacion XML + tracking id) |
| 310 | #105 | X | Could | 350 | 309 | OWNER: SW Sapien sandbox credentials, or a recording; after 534's contract |
| 311 | #105 | X | Could | 300 | 309 | recorded responses (source = provider sandbox → owner); after 534 |
| 312 | #105 | X | Could | 300 | 309 | recorded responses; after 534 |
| 313 | #105 | X | Could | 250 | 309 | Finkok demo account (owner); after 534 |
| 534 | #105 | X | Should | 400 | — | PLAN FIRST. OWNER: which Sovos product, test+production keys by the secure form, RFC emisor registered with the PAC, a test CSD; credential store touches vault/ or fiscal-credentials/ (critical path: owner approves plan and merges); splits into ~6 PRs with new ids |
| 767 | #105 | F | Could | 200 | 297*, 736 | after 297 |
| 300 | #111 | E | Must | 300 | 059 | root; no migration (owner chose option (b), 26 Nov) |
| 849 | #111 | E | Should | 200 | 298 | root |
| 850 | #111 | E | Should | 400 | — | MIG (new table for the reconciling items); its plan splits it (~3 PRs) |
| 852 | #111 | E | Should | 200 | 299 | root |
| 854 | #111 | E | Must | 60 | 298 | data MIG + seed; must open the DOF text of the Sexta Resolución first (network), else stop |
| 307 | #113 | F | Should | 350 | — | root; payroll/mx (sensitive zone); TipoDeduccion 007 |
| 324 | #123 | G | Must | 350 | — | root |
| 325 | #123 | G | Must | 300 | 324* | after 324 |
| 326 | #123 | B | Must | 200 | — | root; legal_parameters rows (data MIG + seed); values verified at source |
| 327 | #123 | F | Must | 350 | — | root; US official sources (network); data MIG; US-only content (tension with D-03 «aparcado»); ~2 PRs |
| 328 | #123 | G | Must | 280 | — | root; catalogue rows |
| 329 | #123 | A | Must | 350 | — | root; US-only content (tension with D-03) |
| 330 | #123 | E | Must | 250 | — | root |
| 331 | #123 | A | Must | 120 | — | root |
| 171 | #158 | B | Should | 340 | 467* | MIG (description_key/params on journal_entries+lines, nullable); waits 467 (wave 3) |
| 172 | #158 | B | Should | 400 | 171* | after 171; one spec per writer → ~3 PRs |
| 173 | #158 | H | Should | 250 | 171* | after 171; SAT deliverable (pólizas XML), byte-identical es/en |
| 380 | #251 | P | Could | 150 | — | MIG (drops 4 columns) — or the owner prefers to implement the delay instead |
| 381 | #251 | P | Could | 120 | — | root |
| 268 | #374 | P | Could | 250 | — | EXTERNAL: needs the by-hash endpoint in sedecim-com/hash-stamper (other repo); simulator only in CI; gateway API key is the owner's |
| 269 | #374 | P | Could | 200 | 268* | MIG (constancia + date next to the seal) |

**V2 · on a v1.0 issue, acceptance does not say v1.0** — 2 tasks, 270 est. lines

| id | issue | lane | prio | size | depends_on (* = open) | what it needs |
|---|---|---|---|---|---|---|
| 765 | #105 | X | Should | 120 | — | root; lands with or before 534 (the second to merge keeps the limit) |
| 308 | #113 | F | Could | 150 | — | root; coverage floor of gl-posting-service.ts + nacha-generator.ts (NACHA is US): recommend leaving out |

**V3 · not v1.0 by text, but an open dependency of V1 (296 → 501 → 500)** — 2 tasks, 350 est. lines

| id | issue | lane | prio | size | depends_on (* = open) | what it needs |
|---|---|---|---|---|---|---|
| 500 | #696 | C | Should | 15 | — | MIG, DDL only (acceptance says owner merge; MNE-001-546 of 18 Nov delegates new migrations) |
| 501 | #696 | C | Should | 335 | 500* | after 500; mexico-cfdi.md + receivables.md re-sealed; ~2 PRs |

**V-RS · #952, the remote surface** — 28 tasks, 7,870 est. lines (owner's RS-1 of 26 Nov: «the first deliverable of v1.0»; docs/MVP.md §3 does not list it)

| id | lane | prio | size | depends_on (* = open) | title (short) |
|---|---|---|---|---|---|
| 691 | S | S | 250 | — | La superficie remota: su PRD en docs/prd/, con las ocho decisiones del dueño |
| 692 | S | S | 350 | 691* | La superficie remota: su diseño de sistema (docs/design/), después del PRD y de las decisiones  |
| 694 | U | S | 250 | 693 | declareRisk declara dónde corre cada comando: servidor o sólo local, sus archivos de entrada y  |
| 695 | U | S | 300 | 694* | Localidad declarada, grupo 1 de 3: el mayor, el cierre, los informes y la nómina |
| 696 | U | S | 300 | 694* | Localidad declarada, grupo 2 de 3: cuentas por cobrar, cuentas por pagar y banco |
| 697 | U | S | 300 | 694* | Localidad declarada, grupo 3 de 3: lo fiscal de México, el panel, el agente y la plataforma, co |
| 699 | U | S | 250 | — | --format y --json en las hojas de lectura que no los tienen, 1/3: las hojas raíz de mnemosine.t |
| 700 | U | S | 350 | — | --format y --json en las hojas de lectura que no los tienen, 2/3: sat cred status, sat cred aud |
| 701 | U | S | 300 | — | --format y --json en las hojas de lectura que no los tienen, 3/3: jobs list, jobs history, skil |
| 702 | U | S | 120 | — | La tabla de códigos de salida ↔ estados HTTP sale del núcleo con su inversa y una prueba de ida |
| 703 | S | S | 350 | 692*, 693, 697* | El generador de rutas monta POST /v1/cli/<ruta del comando> por cada comando declarado de servi |
| 704 | S | S | 300 | 692*, 703* | Permiso por comando 1/2: la declaración lleva el permiso y la ruta generada lo exige, con negac |
| 705 | S | S | 300 | 692*, 703*, 704* | Permiso por comando 2/2: el mapa de los 293 comandos y los permisos nuevos de src/auth/roles.ts |
| 706 | S | S | 350 | 692*, 702*, 703* | El ejecutor corre cada comando como un proceso hijo, aislado |
| 707 | S | S | 150 | 692*, 706* | El paso de identidad: el comando verifica otra vez el token de la petición que le entrega el ej |
| 708 | S | S | 350 | 692*, 706* | Archivos de entrada y de salida por la pasarela: viaja el contenido, nunca una ruta del servido |
| 709 | S | S | 200 | 692*, 706* | Idempotencia en las rutas de la pasarela: una sola regla para el encabezado y el --idempotency- |
| 710 | S | S | 200 | 692*, 703* | OpenAPI y contrato: las rutas generadas entran a docs/openapi.json con su sobre, y catalog-info |
| 711 | U | S | 250 | 692* | El perfil remoto de la terminal: --remote, MNEMOSINE_REMOTE y su clave de configuración |
| 712 | U | S | 350 | 706*, 711* | El reenviador: en modo remoto, la acción de un comando de servidor viaja a la pasarela y la ter |
| 713 | U | S | 350 | 708*, 712* | Archivos y confirmación del lado del cliente en modo remoto |
| 714 | U | S | 300 | 712* | doctor, whoami y status en modo remoto, y login descubre el emisor desde el servidor |
| 715 | S | C | 300 | 706* | Corridas largas 1/2: la pasarela acepta con 202 y un id de corrida, y guarda su estado |
| 716 | S | C | 300 | 706*, 715* | Corridas largas 2/2: GET /v1/cli/runs/:id y la cancelación |
| 717 | S | C | 300 | 712* | Streaming de ask y chat por la pasarela, sólo si la decisión RS-5 pone el modelo en el servidor |
| 718 | S | S | 300 | 712* | Suite de conformidad: cada comando de lectura corre en local y por la pasarela contra la misma  |
| 719 | S | S | 300 | 712* | Censo de paridad de RF-35 con su línea base: los comandos sin alcance remoto sólo pueden bajar |
| 787 | U | S | 150 | 698 | Con --json, un error del analizador de argumentos (opción desconocida, argumento que falta, com |

**P-us · United States only (D-03)** — 22 tasks, 6,640 est. lines: #91: 275, 276; #124: 333, 334, 335, 336, 337, 338, 339, 340, 341, 342, 343; #127: 354; #131: 355, 356, 357, 358, 359, 360; #132: 364; #662: 514

**P-rename · internal renaming I12–I26 (D-05)** — 53 tasks, 17,310 est. lines: #154: 158, 159, 160; #155: 161, 162; #156: 163, 164, 165, 166; #157: 167, 168, 169; #158: 174, 175, 176; #159: 178, 179; #160: 180, 181, 182, 183; #161: 184, 185, 186; #162: 188, 189; #164: 190, 193, 194, 481; #166: 195, 196, 197, 198, 199, 200, 201, 485; #167: 202, 203, 204, 205, 206, 207; #168: 208, 210, 211, 212; #169: 213, 214, 215, 216; #327: 388

**P-platform · Sedecim platform lane (D-08)** — 7 tasks, 1,600 est. lines: #371: 264, 265, 266; #372: 107; #379: 271, 272, 273

**SEC · sensitive issues — numbers only** — 13 tasks, 2,460 est. lines: #96: 280, 281, 282, 283; #589: 639; #590: 640(M); #591: 641; #598: 653(M), 654(M); #599: 655, 656; #674: 526; #675: 527

### 1.2 Set O, by issue (156 tasks, 58 issues)

Need column: **R** = a release for real use needs it (my reading; the six norm reviews may move rows); **R-pac** = needed only if real stamping ships; **S** = should; **C** = can wait; **repair** = census or correction of rows booked before a fix, which matters only if a database with real data already exists (owner to say whether the pilot database counts).

| Issue | Tasks (prio) | Lines | What it is | Need |
|---|---|---|---|---|
| #101 | 624, 819, 820, 625 (C) | 740 | The E4.2 closers: the last three copies of the balance SQL move to report-service and the detector widens; 625 puts E4.2 into `--exigir` (touches `ci.yml`: owner merges) | **R** — a release with a red board package contradicts «ask the code» |
| #101 | 816, 817 (C) | 120 | Cash tie-out suspects: sign of a double count, stable order | C |
| #378 | 391 (S), 392 (C) | 700 | The E5.1 closers: agent tools derived from the risk registry; `--continue` rehydrates | **R** for 16/16, or the owner repeats the RNF-01 amendment of 30 Sep for the release |
| #150 | 842 (S) | 180 | I8b 11b: payables, bank and assets leaves by key | **R** — 810 (wave 3) cannot reach 0 without it; undeclared dependency |
| #150 | 812 (S), 782, 814 (C) | 430 | Help notes by key; closing explain rows; an English plural | S / C |
| #593 | 643 (**Must**) | 200 | A ledger control over REST; D4, confirmed by the owner 26 Nov | **R** (Must, PRD-003 RF-03) |
| #953 | 637, 638 (**Must**) | 240 | 2027 minimum wages (in force 1 Jan 2027) and UMA (1 Feb 2027), each after its DOF publication, each with a migration | **R**, date-gated: cannot start before the DOF publishes |
| #953 | 789, 793 (C) | 110 | A comment; the missing-parameter notice also looks at contribution days | C |
| #333 | 251 (S), 252 (C) | 200 | A workflow rejects PRs to release not from develop, and to main not from release; month-close freeze window | 251 **R** (release mechanics; workflow = owner's path); 252 C |
| #338 | 258 (S), 259 (C) | 200 | SBOM on each `v*` tag; generated CHANGELOG at each release cut | **R** (decided 18 Nov, option b); 258 is a workflow |
| #311 | 786 (S), 785 (S), 853 (C) | 240 | A deployment declares its collation and doctor warns; the plan's throwaway database is born with CI's collation; catalogue block order | 786 **R** (install guide depends on it); 785 S; 853 C |
| #316 | 387 (S) | 250 | Migrations with DROP FUNCTION applied by a role that does not own the function | **R** — a clean install with the provisioned roles must migrate |
| #606 | 663 (S) | 60 | Three production dependencies nothing imports (soap, bullmq, kysely) | **R** (small; the SBOM and `npm audit --omit=dev` read them) |
| #601 | 764 (S) | 100 | A pooled connection has an error listener, so a dropped connection fails the operation, not the Node process | **R** (operability) |
| #601 | 722, 737, 773, 740, 766, 784, 721 (S), 660 (C) | 1,380 | Payroll run: duplicate employee refusal, one deposit batch per run, unique live ordinary run per period (migration, census first), census of periods that contributed IMSS twice (owner decides the correction), late PAC folio registration, RLISR 174 option, per-run reads, dry-run | S; 740/773 partly repair; 766 R-pac |
| #92 | 768, 770 (S) | 180 | Payroll CFDI: `Fecha` in local time of the place of issue; `Folio` ≤ 40 chars without `|` | **R-pac** (768 waits 278 and 769) |
| #696 | 788 (S) | 200 | A cancelled invoice is re-stamped with CfdiRelacionados naming the cancelled folio | **R-pac** (after 297) |
| #120 | 323 (C) | 380 | The payment CFDI (REP) issued is built from a receipt | **R-pac** — a system that stamps PPD invoices and cannot issue the REP is half a stamping feature (norm reviewers to confirm) |
| #218 | 378 (C) | 90 | Sovos and cfdi-status read through the shared XML module | R-pac |
| #120 | 322 (S), 319, 320, 321 (C) | 1,050 | Document retention CFF art. 30; CLI naming and pagination debts | 322 S; rest C |
| #133 | 738, 743, 757, 769, 783, 790 (S), 424 (C) | 850 | Corpus texts with their source (payroll CFDI date, NIF B-3 presentation, LIVA 5-III/7, Anexo 20 Fecha, RLISR 174, LFT 570) | S; 769 R-pac (768 depends on it) |
| #151 | 17 tasks: 796, 831–840, 844–848, 821 | 4,595 | I9 by folder, parts 3c–3g (SAT/Anexo 24), 4b–4f (IVA/ISR workpapers, INPC), 8b–8d (assets): service messages by key | S if en-US becomes the default in the release (471): otherwise an English-default install prints Spanish prose from these services. Their acceptance says «el dueño puede pasarla a la ola 3» |
| #153 | 813 (S) | 400 | doctor and init print each check by key | S (same reason) |
| #308 | 630, 631, 748, 749 (S) | 1,170 | Filed-returns register: refund or offset of a favourable balance; complementaria that voids an obligation; IVA paper bases since Jan 2024 | S (a manual path exists: `--prior-balance` with its reason) |
| #596 | 649, 650, 758 (S) | 670 | AP aging at a date; subledger reconciled to control with both sides read at the same date | S |
| #787 | 744, 745, 747, 780 (S) | 520 | Vendor payment: show with applications, reversal day by entity time zone, DIOT cheque notices by application day | S |
| #692 | 791 (S), 762 (S), 777, 792 (C) | 600 | DIOT batch file declares a received credit note in the §3.2 fields; VAT gates for an entity without Mexican books (panel key) | 791 S (SAT file content: norm reviewer); rest C |
| #694 | 494–497 (S) | 1,030 | Received IEPS follows `tratamiento_ieps` (migration; census and correction of earlier bills) | S for entities with IEPS; 497 repair |
| #673 | 525 (S) | 400 | Customer advance applied by procedure B of Apéndice 6, corpus first | S |
| #683 | 486 (S) | 260 | CFDI auto-post does not post unread a draft whose description has no letters or is not Spanish on Mexican books | S (touches the human-review invariant; decided 17 Nov) |
| #592, #594, #602 | 772, 750, 781 (S), 771 (C) | 470 | batch reverse respects segregation of duties; year create leaves its audit row; re-sealing period 13 sweeps late entries | S |
| #607, #664, #698, #855, #618, #780 | 665, 531, 503, 755, 668, 676 (S) | 770 | customer tax set; two-party refusals; REP node warnings kept; reversed vendor payment keeps its cause; help says what the system does; five commands print their text for a person | S (668 and 676 are small and user-facing) |
| #769, #779, #854, #778 | 669, 670, 674, 675, 681, 673 (S) | 1,310 | Censuses and audited corrections of rows booked before a fix (VAT credited twice on cheques, subsidy over ISR, PUE booked to 1130, role accounts at the root) | **repair** → C for a first release without earlier real data |
| #97 | 286 (S) | 250 | REST `POST /reconciliations` delegates to the CLI's engine or is retired | S (the owner put bank reconciliation in the MVP on 27 Nov; two engines behind two doors) |
| #112 | 301, 305 (S), 302, 303, 304, 306 (C) | 1,360 | e-accounting catalog diff/match/apply/status; INPC import/list/check; the catalogue stops promising `file` and `acuse` | 305 S; rest C |
| #125 | 346–352 (C) | 1,670 | Mexico gaps: IEPS kept in xml_documents, legal reserve LGSM 20, irregular first year CFF 11, 69-B scrutiny, SPEI key, ImpuestosLocales complement, issuer seal verification | C by priority; norm reviewers decide (347, 348, 352 are the candidates) |
| #132 | 361, 362 (S), 363 (C) | 800 | Agent tool `get_legal_parameter`; fiscal-mx.md citing legal_parameters keys | S |
| #104, #103, #644, #597, #612, #853, #771, #395, #178 | 292 (S), 293, 294, 288, 289, 291, 751, 795, 797, 634, 635, 776, 672, 394, 369, 370 | 2,010 | Eval penalises unexpected lines; calibration; webhook reader; audit request id; SDK citations; capital label in the agent tool; payer trace over REST; an index measured; stable order of reconciling items; a message; entry totals once per statement | C (292 S: RF-44) |
| #116 | 314–318 (S/C) | 1,280 | Messaging channels (WhatsApp Cloud API, outbox with a human) | No — after the MVP until the owner schedules it (MVP.md §1) |
| #331, #332, #336, #339, #409 | 246, 248–250, 253–256, 261, 262, 274 | 2,110 | Agent framework: agent-authored label, status state machine, golden set, complexity and coverage thresholds, TypeScript 7 (blocked) | No |
| #185 | 372 (S) | 180 | Named by #952 as part of its gate before a remote release | With SEC |

O totals by my reading: **R 23 tasks, 3,800 lines** (842; 624, 819, 820, 625, 391, 392; 643; 637, 638; 251, 258, 259, 786, 387, 663, 764; R-pac 768, 770, 769, 788, 323, 378). All their open dependencies are inside the set or in wave 3 (768 → 278). SEC adds 13 tasks (3 Must) that the owner must rule in or out one by one: #96, #589, #590, #591, #598, #599, #674, #675; #952 names #593, #674, #589, #590, #599, #96 and #185 as prerequisites of any remote release.

(V1 and V-RS both sum to 7,870 estimated lines; a coincidence, each checked.)

## 2. Dependency picture: set V plus the wave-3 remainder

### 2.1 Chains

| # | Chain (→ = must merge first; ∥ = parallel) | PRs (est.) | Gate |
|---|---|---|---|
| C1 | **PAC.** 534 plan → 534 parts (contract and router kept, Sovos adapter rebuilt: stamp, cancel, status, accept/reject, recovery, polling; admin credential commands) → 310 ∥ 311 ∥ 312 ∥ 313. In parallel: 500 → 501 → 296 → 297 → 767. 765 beside 534. With real stamping come 788 (after 297), 323, 378, and 769 → 768 (after 278), 770 | 6 + 4 + 1 + 2 + 2 + 1 + 1 + 1 = 18, plus 7 R-pac | Owner (see 2.3 rows 1–2). Depth 5 on 767 |
| C2 | **Concepto in Spanish.** 467a (migration) → 467b → 171 (migration) → 172 (×3, one writer group per PR) ∥ 173 | 2 + 1 + 3 + 1 = 7 | 467 is wave 3 and not started |
| C3 | **Jurisdiction (#123).** 324 → 325; 326 ∥ 327 ∥ 328 ∥ 329 ∥ 330 ∥ 331 | 9 | None; all roots. 326, 327 load legal_parameters rows from official sources |
| C4 | **Accrual (#111).** 300 ∥ 849 ∥ 852 ∥ 854 ∥ 850 (plan splits it, migration) | 7 | 854 must open the DOF text; 850 needs a plan |
| C5 | **Public figures and NOM-151.** 380 ∥ 381; 268 → 269 | 4 | 268 needs an endpoint in another repository (`sedecim-com/hash-stamper`) |
| C6 | **Alimony (#113).** 307 (308 optional) | 1–2 | None |
| W-L | **Wave 3, lane L.** 859 (PR #1064) → 801a → 801b → 842 → 810a → 810b. 467a → 467b → 468 → 471 (also after 151a/b). 478: helper → ~9 family PRs. 811, 628 free | 22 | 842 must change wave; 471's grep clause must be rewritten |
| W-S | **Wave 3, lane S.** 856 (PR #1062); 858, 827, 732, 826a → 826b, 828 → 829a → 829b, 733 (×3–4) free; 151a → 151b after 467 | 14 | The two `fiscal-credentials/` strings of 733 go in a part of their own (critical path) |
| W-rest | E: 595, 667. F: 279 → 278 → new payroll-XSD task. C: 664. 0: 841, 752 (×3). X: 429 → 430. G: 155 + 156 after 468 | 4 + 3 + 1 + 4 + 2 + 2 = 14 | 429 waits the owner's approval of the consent text in #441 |
| W-gated | G: 425 (start ≥ 11 Jan 2027, merge before 6 Apr 2027), 450 (an eval run with a user's own key, before 1 Apr 2027), 451 (the owner's own eval run), 611 (two lines of `ci.yml`: owner) | 4 | Dates and owner |

Critical path of the whole release, if #952 stays out: **C1**, because every step before code is the owner's (credentials, product, RFC registration, plan approval on a critical path). Second: **W-L** (22 serial-ish PRs in one lane). With #952 in: its chain is depth 6 (691 → 692 → 694 → 697 → 703 → 704 → 705/706 → 707/708/709 → 711 → 712 → 713/714/718/719), all in lanes S and U, where lane S already carries W-S and SEC.

Migration numbering: 347 is the last applied file. Yesterday's plan names «348» for both 595 and 467a; the first to merge takes it and the other renumbers. Set V adds 171, 269, 380, 500, 850, 854 and the data rows of 326 and 327; O-R adds 637 and 638. About ten new migrations before a 1.0 tag.

### 2.2 Roots that can start today (no open dependency, no owner input)

- Set V: 300, 849, 852, 854 (if the DOF text opens), 324, 326, 327, 328, 329, 330, 331, 307, 381, 765, 500, 850 (plan first), 380 (default path: retire), 268 (against the simulator only).
- Wave 3: 801a (after #1064), 811, 628, 858, 827, 732, 826a, 828, 733a, 595, 667, 279, 664, 841, 752, 467a.
- O-R: 624, 819, 820, 643, 387, 663, 764, 786, 259, 391, 392.

### 2.3 What only the owner can give

| # | Item | Blocks |
|---|---|---|
| 1 | **Scope.** Does «todo lo de la versión 1.0» include #952 (RS-1)? Do the US-content Must tasks 327 and 329 stay in? Which SEC issues gate the release? Do E4.2 and E5.1 have to be green for it? | The size of the release: 33 or 61 tasks of V; ±13 SEC; ±6 closers |
| 2 | **PAC (#105, task 534).** Which Sovos product the contract covers; test and production keys through the secure form, never in chat; the issuing RFC registered with the PAC; a test CSD; approval of the plan where it touches `src/services/vault/` or `fiscal-credentials/`, and the merge of those PRs. For 310 and 313: sandbox or demo accounts with SW Sapien and Finkok, or the decision to ship Sovos alone and leave providers 2–5 for later. No agent calls a real PAC: any live sandbox evidence is produced by the owner or with what they enter in the form | C1 (18 PRs) |
| 3 | **PRD-003 v0.2 approval (#603).** Asked on 24 Nov; no answer recorded. Its §8 also asks that someone with accounting judgement review the norm numbers of §4.4 and §4.5; no record. **It does not block set V**: those tasks already have issues with a Definition of Ready under PRD-001's backlog and go by `docs/PROCESS.md` (docs/prd/README.md, second paragraph). It does block any requirement «sin tarea todavía»: `docs/prd/README.md` §4–§5 and PRD-003 §9 say SD-003 and the PRD-003 backlog are written after approval. New engine work proposed by the norm reviews falls here unless it is filed as a defect of something that exists | New NIF/NIIF/jurisdiction engines |
| 4 | **PRD-001 is «aprobado · Versión: 1.0» and its §6 puts PAC out of scope**; every v1.0 task hangs on RF-14 «Lo que sigue al MVP · Could». Moving them into the MVP amends an approved PRD: the owner approves the amendment (new requirements or a v1.1) | The re-waving PR |
| 5 | **#952:** approve PRD-004 (691) and SD-004 (692); `/confirmar` on the D4 tasks 704–707; approve the permission map (RS-3); review the identity pass-through PR (RS-8) | 26 of the 28 tasks |
| 6 | **Critical paths the delegation does not reach** (review and merge are the owner's): `.github/workflows/` — 611, 251, 258, the `--exigir` edits when 625 and 391/392 close their packages, and E3.2, which is green 10/10 and is not in `--exigir` today (`ci.yml:271`); `vault/` and `fiscal-credentials/` — 534's credential store, 429, one part of 733, the production vault of D-06; `rls-policies.sql`; `docs/ROUTING.md` | Each named PR |
| 7 | **Migrations.** Delegated since 18 Nov (MNE-001-546: the coordinator merges a new migration with its SQL in the PR body); the owner can object. 500's acceptance still says «su revisión y su fusión son del dueño» | ~10 migrations |
| 8 | **Eval runs with a real key:** 451 (the owner's key), 450 (any user's key). The CI eval job is skipped without a secret, so RF-44 is unmeasured; a release run of the classifier eval is the owner's | 450, 451; the release evidence |
| 9 | **Dates.** 637: after CONASAMI's DOF publication of December 2026 (in force 1 Jan 2027). 638: after INEGI's UMA publication of January 2027 (in force 1 Feb 2027). 425: starts on or after 11 Jan 2027; the freshness test turns red on 6 Apr 2027 (`verified_at` 2026-09-06, N = 6). 450: before 1 Apr 2027 | Four tasks that cannot be finished in December |
| 10 | **Release acts** (section 4): the release cut, the merge to main, the tag, the GitHub release; secret-scanning push protection (#338); `lifecycle` in `catalog-info.yaml`; who is release manager and at what cadence (#333's question, never answered); the hotfix rule ADR-0008 left open; #370; the legal question of #337 | The release itself |
| 11 | **Smaller answers:** 380 retire or implement the publication delay; the consent text of #441 for 429; #311's closing rule; whether a database with real data exists (the «repair» rows of 1.2); the endpoint in `hash-stamper` for 268 | 380, 429, #311, 6 repair tasks, 268 |

## 3. Proposed re-waving

### 3.1 Mechanism

`scripts/backlog.ts` accepts any whole-number wave that has a stage, and refuses a task that depends on a later wave. Three ways to «integrate v1.0 into the MVP»:

| Option | Change | Consequence |
|---|---|---|
| A. Move the release set into wave 3 | ~60 `wave` edits; stage 3 renamed | Literal reading of the instruction. But the «MVP de pruebas» (Must of waves 0–3, declared met on 27 Nov) reopens: 10 to 16 Must tasks enter wave 3 (the ten of #111 and #123, plus 643, 637, 638 and the three SEC Must if they join). MVP.md §1 must then say the test MVP was met on its date and the final MVP is the release |
| **B. New stage: wave 4 = «Liberación 1.0», wave 5 = «Después de la 1.0»** (recommended) | The release set stays in wave 4; the 225 to 255 parked or deferred tasks move to wave 5 (225 if #952 stays in wave 4); `schedule.stages` gains "5" and renames "4" | The final MVP (wave 3) keeps its meaning and its date; the release is the next cut and has a computed date of its own. Verified: no task of the proposed wave 4 depends on a task that would be in wave 5 |
| C. Keep waves, mark by text | None | What exists today; the script cannot compute a release date for it |

Either way: 842 moves to wave 3 (810 needs it) and 810 gains 842, 855, 859 in `depends_on`; 425, 450, 451 leave wave 3 for the dated follow-up (yesterday's D1, D2); 800's remainder is 859.

### 3.2 What joins, by lane and order

Release set R1 = wave-3 remainder (33) + V1+V2+V3 (33) + O-R (23) + the three SEC Must (640, 653, 654) + new release-mechanics tasks (section 4, ~12) + the new payroll-XSD task. Order inside each lane: wave 3 first, then Must, then the chain order of 2.1.

| Lane | Order |
|---|---|
| L | 859 → 801a → 801b → 842 → 810a → 810b ∥ 467a → 467b → 468 → 471; 478 helper → families; 811; 628 |
| S | 856; 858 → 827 → 732 → 826a → 826b → 828 → 829a → 829b → 733a–d → 151a → 151b; then 643, 640, 653 → 654, 764 |
| E | 667, 595; then 854 → 300 → 330 → 849 → 852 → 850a–c; then 819 → 624 → 820 → 625 |
| G | 324 → 325; 328; 391 → 392; 155 + 156 after 468; 769 |
| B | 326; 500 (C) → 501 (C) → 296 → 297 → 788; 171 → 172a–c; 323 |
| F | 279 → 278 → payroll XSD (new) → 770 → 768; 307; 327; 637 (when published); 767 after 297 |
| A | 331 → 329 |
| X | 765; 534 plan → 534a–f → 310 → 311 → 312 → 313; 378; 429 → 430 |
| H | 173 after 171 |
| P | 381, 380; 268 → 269 |
| C | 664; 500 → 501 |
| 0 | 841; 663; 387; 786; 752a–c; 259; then the owner's workflow PRs 251, 258 and the release tasks of section 4 |

### 3.3 PR counts

| Block | Tasks | PRs (est.) | How the PR count was reached |
|---|---|---|---|
| (a) Wave-3 remainder | 33 (2 in PR) | 50 + 3 in flight; 4 gated apart (425, 450, 451, 611) | Yesterday's measured splits: 478 ≈ 10, 733 ≈ 4, 801, 810, 826, 829, 151, 467 = 2 each, 752 ≈ 3; plus 842 and the payroll-XSD task |
| (b) Set V strict (V1+V2+V3) | 33 | 45 (range 40–52) | 534 = 6, 850 = 3, 172 = 3, 296, 327, 501 = 2 each; the rest 1 |
| (b′) #952 | 28 | 32 | Sizes ≤ 350; two documents; four D4 |
| (c) O-R | 23 | 26 | 391, 323, 625 may need 2 |
| (c′) SEC | 13 (3 Must) | 14 | — |
| (d) Release mechanics, new | ~12 | 12 | Section 4 |
| History and backlog PRs | — | +15 % | Measured: about one per 7 task merges |

### 3.4 Calendar

Assumptions: 2 open PRs per lane; one merge per develop CI cycle; **12–15 merges a day** as the planning rate (measured ceiling ~28; 30 task merges on 26 Nov); five-day weeks (no merges on 21–22 Nov); sizes as in 3.3; the new tasks the six norm reviews propose are **not** counted; owner inputs of 2.3 arrive in the first week.

| Scope | Merges (PRs × 1.15) | Days of merge capacity | Code complete | Notes |
|---|---|---|---|---|
| (a) Wave-3 remainder alone | 61 | 4–5 | **8–13 Dec 2026** | Same as yesterday's plan; lane L (22 PRs) is the long lane. Without 425, 450, 451 |
| (a)+(b) strict V | 113 | 8–9.5 | **10–15 Dec**, except C1 | C1 (PAC, 18 PRs) ends 8–10 working days after the owner delivers credentials and approves the plan |
| **R1** = (a)+(b)+(c)+3 SEC Must+(d) | ~160 | 11–13.5 | **14–18 Dec** | Then hardening, 2–3 days: release candidate, clean install, acceptance run, security pass, owner's trial → **release 18–23 Dec 2026** if C1's inputs arrive by ~3 Dec. If they do not: ship with the stamping door closed as today, or slip to January |
| R2 = R1 + #952 + the other 10 SEC | ~210 | 14–17.5 | **mid-January 2027** | Bound by lane S (≈ 40 PRs) and by two owner approvals (PRD-004, SD-004) before the gateway code |
| After any December release | — | — | Jan–Mar 2027 | 638 (UMA, from 1 Feb), 425 (≥ 11 Jan, < 6 Apr), 450 (< 1 Apr), 637 if the DOF publishes after the cut → a 1.0.x each |

At the measured rate the merge queue would clear R1 in 6–7 working days; the binding constraints are the owner-gated chain C1, the serial lane L, and review of ~10 migrations, not merge capacity. The backlog script's own date is not usable for this: it schedules 2 tasks per lane per 14-day sprint and puts the last wave-4 task on 2027-11-21 (`schedule.capacity_per_lane`, `sprint_days`; its own text says «se recalibra con la velocidad medida al cerrar S2»).

## 4. Release mechanics that no task covers

State of the refs: `origin/main` = `origin/release` = `711ad88f` (#511, 29 Sep 2026). `origin/develop` = `e9a327d0`, **430 commits ahead, 0 behind**. `git tag`: none. GitHub releases: none. No `CHANGELOG`. Open PRs: #1062, #1064, #1065, all against develop.

| # | What a first release needs | Today | Task |
|---|---|---|---|
| 1 | Branch model `feature → develop → release → main`, a tag on each merge to main | **Exists** as a decision (ADR-0008, `docs/PROCESS.md` «El ciclo», SCOPE «Operación»). CI runs on the three branches. Never executed: no cut since the branches were created | — |
| 2 | **Promotion: `release` ← `develop`, then `main` ← `release`** (merge commits, not squash, so the tag sits on develop's history) | **Missing.** SCOPE: «no es una decisión abierta, es una acción del owner». 430 commits in one promotion | **New R-1** (0, ~0 lines of code): the release checklist as an issue; the two PRs are opened by the coordinator and merged by the owner |
| 3 | A check that refuses a PR to release not from develop, and to main not from release | **Missing.** Task **251** exists (wave 4, Should, 80 lines; a workflow: owner's path). Hotfix branches: ADR-0008 «no se decidió» | 251 → release set. **New R-2**: the hotfix rule as an ADR-0008 amendment (owner decision) |
| 4 | `historial-estado` counts PRs on `main --first-parent`; after a release merge it sees one commit | **Missing** (ADR-0008, Consecuencias: «tienen que revisarse con el primer corte») | **New R-3** (0, ~120): the history count reads develop, or the release merge, with its spec; before the first cut |
| 5 | **Version number** | `package.json` says `"version": "1.0.0"` and `mnemosine --version` prints it (`src/cli/mnemosine.ts:243`, `:1074`) although nothing was ever released. Name `accounting-core`; no `license`, `private`, `files` or `repository` field. SemVer was decided on 18 Nov (MNE-001-257, option b) | **New R-4** (0, ~60): the version policy written down (what the release candidates and 1.0.0 are called; where the number changes), `license: Apache-2.0`, `private: true` unless the owner wants npm, and a spec that the tag equals `package.json` |
| 6 | **Tag and GitHub release** | **Missing**; owner's act | Part of R-1 |
| 7 | SBOM on each `v*` tag | **Missing.** Task **258** (Should, 50 lines; workflow: owner's path) | 258 → release set |
| 8 | **CHANGELOG generated** from the PRs between release tags | **Missing.** Task **259** (Could, 150). The first release has no earlier tag: the base must be named (`711ad88f` or the root) | 259 → release set, with the base in its acceptance |
| 9 | **Release notes** for a despacho: what it does, what it does not (README «What is not yet what it seems»), known limits, the open Must | **Missing** | **New R-5** (U, ~150, documents only) |
| 10 | **Install guide for the firm's own machine** | **Partial.** README «Quick start» and `docs/wiki/Puesta-en-marcha.md` describe a developer checkout: `git clone`, `npm ci`, `scripts/setup.sh` (a development `.env`), and «the binary is not installed as a global command: it is invoked through npm» (tsx on the source). `bin` points at `dist/cli/mnemosine.js`, which only `npm run build` produces. Nothing says how to install a tagged version under `NODE_ENV=production`, with the two database roles, the keys set before the first write, the backup and `jobs run-due` on a schedule | **New R-6** (U, ~250): the production install page, English source and Spanish twin, checked by the rehearsal of row 12 |
| 11 | **The production vault on the firm's machine (D-06, MNE-001-539, decided 17 Nov: option a)** | **Missing, and no task.** With `NODE_ENV=production` and no backend set, `src/services/vault/index.ts:49-53` refuses and names only AWS Secrets Manager («the local vault is not valid in production»). A firm's install in production mode cannot hold an e.firma, a CSD, a PAC key or a Contalink key without AWS. RNF-04 of PRD-003 names it; `vault/` is a critical path (owner's plan and merge) | **New R-7** (S, ~300, critical path, D4): the local production vault of D-06, key outside the data directory; plan to the owner first. **Blocks any release that uses credentials** |
| 12 | **Clean-install test** on a fresh database | **Partial.** CI migrates an empty Postgres 15 through file 347 in five jobs (plan, restore drill, integration, isolation, eval) and the isolation job runs with the provisioned role. Not covered: the built artefact. **No CI job runs `npm run build`**, the `dist` binary or `docker/Dockerfile` (which uses `npm install`, not `npm ci`); 387 (#316) covers migrations applied by a non-owner role | **New R-8** (0, ~150 + a workflow step: owner's path): build, `node dist/cli/mnemosine.js --version`, `doctor` and one read command against the CI database. 387 → release set |
| 13 | **Upgrade path** | Migrations are forward-only, numbered, under an advisory lock (#373), never edited once applied (`docs/migraciones.md`). No release exists, so there is nothing to upgrade from, unless an installation of `main` at `711ad88f` holds data (owner to say). No upgrade page; no test that migrates a database dumped at the previous tag | **New R-9** (U, ~120): the upgrade page (backup → tag → `npm ci` → build → migrate → doctor → backup verify). **New R-10** (0, ~200, after the first tag): CI restores a dump taken at the previous tag and migrates it |
| 14 | **Backup and restore drill** | **Exists:** `backup create|verify --restore|restore`; CI job «Ensayo de restauración» on every run; RUNBOOK. #598 has two Must tasks in wave 4 | #598's tasks → release set (owner's call); the drill re-run on the release candidate is part of R-1 |
| 15 | **The acceptance run of #311** | **Exists** as E6.1, a ▶ criterion required on every PR (`--exigir` includes E6.1). It runs the source under tsx against synthetic data without a model. #311 is open (`status:in-review`); its closing rule ties it to 785, 786, 853 | **New R-11** (T, ~80): the release candidate's evidence in one place — the month spec, `plan:status`, the restore drill and the isolation job on the tagged commit, recorded in the release issue. The owner's own trial of a real month is theirs (row 21) |
| 16 | **Board state at the tag** | 14/16. E4.2 and E5.1 red; E3.2 green and outside `--exigir` | 624, 819, 820, 625, 391, 392 → release set, or the owner states the release ships with them red. **New R-12**: E3.2 into `--exigir` (one line of `ci.yml`: owner) |
| 17 | **License** | **Exists:** `LICENSE` (Apache 2.0), `NOTICE`, README «License». Missing only the `license` field (R-4) and a third-party licence listing (the SBOM of 258 gives it) | R-4, 258 |
| 18 | **Security review status** | `SECURITY.md` (private advisories, 72 h); CodeQL and Dependabot named in CODEOWNERS and #338; `permissions: contents: read` in CI. Push protection of secret scanning: decided 18 Nov, a repository setting only the owner can confirm. No `npm audit` step in CI or `verify.sh`. Open sensitive issues, numbers only: **#96, #589, #590, #591, #598, #599, #674, #675** (13 open tasks, 3 Must), **#370** (its tasks are done; it waits an operational step of the owner; label `status:blocked`). #588 has no open task and is not in the open list. #952 adds #593 and #185 to its gate | **New R-13** (0/S, ~0 code): a security pass over the release candidate (the 430-commit range), and the owner's written ruling on each sensitive issue: in the release or accepted with its reason. `npm audit --omit=dev` at the candidate (RNF-04) |
| 19 | **Lifecycle declaration** | `catalog-info.yaml:17` `lifecycle: experimental`; RUNBOOK opens with «no hay un despliegue de producción declarado»; SCOPE «Operación» the same. **Side effect:** MNE-001-545 lets a D4 go without a second person only «mientras catalog-info.yaml declare lifecycle: experimental» | Owner decision at the release: the new value, and who the second person is from then on. Documents in section 5 |
| 20 | **Dated maintenance already known** | 637 and 638 (2027 payroll parameters), 425 (corpus renewal; CI turns red on 2027-04-06), 450 (a model profile whose API is retired on 2027-04-01 by the task's text) | A «1.0.x» follow-up list in the release notes; 637 and 638 in the release set as dated |
| 21 | **Owner's operational steps** | — | In R-1's checklist: Sovos items (2.3 row 2); the eval run with their key; push protection; branch ruleset review (administrators can bypass it today, SCOPE «Operación»); #370; the legal question `docs/MVP.md` §4 still lists under #337 («pregunta abierta al 2026-10-09»); a trial month on their own data; naming the release manager and the cadence (#333) |
| 22 | Unused production dependencies; collation of a deployment; pool error listener | Tasks 663, 786, 764 exist in wave 4 | → release set |
| 23 | Operations for a shared deployment (alerts, on-call, canary, freeze window) | RUNBOOK «Pendiente»; 252; #372 (107) | Not needed for an install on the firm's machine; stays parked with the platform lane |
| 24 | Manuals and README true at the tag | Manuals delivered (#325); README says PAC «cannot be used in production» and «no figures here on purpose» | Updated by the PR that changes the fact (PAC), and by R-5 |

New tasks proposed here: R-1 to R-13 (13; R-2 and R-12 are owner decisions or one-line owner edits; R-7 is the only large one and is on a critical path). Hang them on a new issue «[REL] La primera liberación» (lane 0, stage «Liberación»), with #333 and #338 as its parents.

## 5. Documents to update when the scope changes

| Document | Section | What changes |
|---|---|---|
| `docs/MVP.md` | Header note | The pointer to #329 stays; add the date of the 27 Nov decision |
| | §1, paragraph «El MVP sale en dos cortes» and the two bullets | Say that the test MVP was met on the backlog on 27 Nov, that the final MVP is wave 3, and name the third cut (the release) with what it carries |
| | §1, sentence «La v1.0 es el hito que sigue al MVP» | Rewritten with the owner's words of 27 Nov («integra todo lo de la versión 1.0 al MVP») and the earlier one («El MVP se puede aplazar pero incluyamos la conciliación bancaria») |
| | §1, «Fuera del MVP, declarado», first bullet (PAC, #105) | Moves out of the list; United States, GUI and channels, platform and renaming stay |
| | §1 table of the nine steps | A row or a note for stamping and cancelling, if C1 ships |
| | §3, table «Ola / Etapa / Entrega», and the paragraph «La entrega de la Ola 3 se llamaba v1.0…» | Row 4 becomes the release; row 5 «Después de la 1.0» (option B) |
| | §3, «### Ola 3», last bullet («lo deseable: … #100, #101 …») | #101's closers are wave 4 today; say where they go |
| | §3, «### Después del MVP: la v1.0» | Retitled; its list gains #952 (if the owner confirms), #696's 500 and 501, #953, the O-R rows and the release tasks; the last paragraph («Lo demás de la ola 4 … aparcado») names wave 5 |
| | §4, table «Pendientes» | The owner items of 2.3 that are still open |
| `docs/backlog/PRD-001.json` | `schedule.stages` | "4": name and release of the release cut; new "5" for what stays after; `_stages_why` gains the 27 Nov decision with its comment id |
| | A new `decision` entry (next free id after 859) | The owner's instruction of 27 Nov, as 547 and 548 record those of 18 Nov; the bank-reconciliation answer is already cited in 858 |
| | `wave` of each task | Per 3.1; 842 → 3 |
| | Acceptance text | 29 tasks say «alcance de la v1.0, el hito que sigue al MVP»; 85 open wave-4 tasks say «va en la ola 4» (some with the reason «para no retrasar las tareas Must»); 810's `depends_on`; 500's «fusión del dueño» against MNE-001-546; the corrections of yesterday's plan §2.1 |
| | `schedule.capacity_per_lane`, `sprint_days` | Recalibrate with the measured rate, or say in `_capacity_why` that the computed dates are not a forecast |
| `docs/backlog/PRD-001.md` | Whole file | Regenerated: `npx tsx scripts/backlog.ts`; `tests/scripts/backlog.spec.ts` checks it |
| `docs/prd/PRD-001-mvp.md` | Line 3 («aprobado · Versión: 1.0»), §4 (RF-14 «Lo que sigue al MVP · Could»), §6 «Fuera» (first bullet, PAC), §9 | New requirements for what enters, or a version 1.1 approved by the owner; the moved tasks change their `requirement` from RF-14 |
| `docs/prd/PRD-003-producto-completo.md` | Line 3 (state and version); §8 paragraph under the table («la v1.0 es el hito que sigue al MVP (MNE-001-548)»); §8 «Acciones que sólo puede hacer el dueño», first bullet (it still says `release` does not exist and `develop` is not the default: stale since 16 Nov); §8 «Trazabilidad con el backlog de PRD-001» (waves and priorities); §9 | On approval, or in the same PR as the re-waving |
| `docs/prd/README.md` | §5 «Backlog» («El segundo está en revisión … Todavía no tiene backlog») | When PRD-003 is approved; PRD-004 (#952) added when 691 lands |
| `docs/SCOPE.md` (signed, #337) | «El MVP» list «Queda fuera del MVP» (first bullet); «El objetivo»; «Operación» → «Despliegue» and «Ramas» («todavía no hay un primer corte»); «Preguntas abiertas»; «Historial de revisión» | The owner signs the change |
| `README.md` and `README.es.md` | «What is not yet what it seems», second bullet (PAC); «Quick start» | With the PR that makes each true |
| `docs/RUNBOOK.md` | The opening «Estado honesto»; «Rollback» («hasta el primer corte no hay tag anterior»); «Pendiente para un despliegue compartido»; new «Instalación» and «Actualización» | R-6, R-9, and at the first tag |
| `catalog-info.yaml` | Line 17 `lifecycle` and its comment | Owner decision (section 4, row 19) |
| `docs/adr/0008-develop-release-branches.md` | «Consecuencias», last bullet («Este ADR se revisa en el primer corte de release»); the hotfix sentence of «Decisión» | At the first cut |
| `docs/HISTORY.md` | A dated row | The decision and the re-waving |
| `docs/pac-proveedores.md`, `docs/wiki/Conectores-PAC.md`, `docs/wiki/Hoja-de-ruta.md` | PAC status; the roadmap | With C1 |
| Issue #329 (body) | «Qué es el MVP» («Fuera del MVP: el timbrado con PAC…»); the Ola 3 list; «Fuera del MVP (etiqueta post-mvp)» (move #105/#115, #111, #113, #123, #158, #251, #374); ~60 boxes done and unticked; 13 issues with wave-3 work missing (#92, #150, #151, #268, #441, #607, #608, #612, #644, #651, #655, #656, #657) | One edit |
| Issue #311 | Its closing rule | Yesterday's D7 |
| Issue #603 (body) | The ten D-boxes, all answered and unticked; «Acciones … Ramas» stale | With the PRD-003 approval |
| Labels | There is no `v1.0` and no `ola-4` label. #105, #111, #113, #123, #158, #251, #374 carry `post-mvp`; #952 carries neither `mvp` nor `post-mvp` and is still `status:needs-clarification` with its eight answers recorded; #953, #855, #853, #787, #692, #664, #601, #602, #596, #597, #594, #592, #308, #327, #371 carry `mvp` + `ola-3` and have only wave-4 tasks left | Create one label for the release cut (and a GitHub milestone with its date), apply it to the issues of the release set, and fix the 17 of yesterday's review |

## 6. Top findings

1. **«v1.0» has two sizes.** 33 tasks (~8,500 lines, ~45 PRs) by `docs/MVP.md` §3 plus its two unmarked dependencies; 61 tasks (~16,400 lines, ~77 PRs) if #952 counts, as the owner's RS-1 answer of 26 Nov says. The documents disagree; the owner decides.
2. **A firm's install in production mode has no vault it can use.** D-06 chose the local vault on 17 Nov; the code still accepts only AWS Secrets Manager under `NODE_ENV=production`, and no task implements the decision. Every credentialed feature of the release (e.firma download, sealing, PAC keys) depends on it. Critical path.
3. **Nothing has ever been released.** main and release sit 430 commits behind develop at a 29 Sep commit; no tag, no GitHub release, no CHANGELOG; `package.json` already says 1.0.0. The built binary (`dist/`, the `bin` of the package) is never built or run in CI.
4. **The PAC chain is owner-gated before its first line of code**: product, sandbox and production keys, RFC registration, test CSD, and a plan on a critical path. It is the release's critical path (18 PRs, depth 5).
5. **Six wave-4 Must tasks are outside the v1.0 text**: 637, 638 (dated: the 2027 payroll parameters), 643, 640, 653, 654. A release in real use on 1 Jan 2027 needs 637 on the day the DOF publishes.
6. **Set V is not closed under dependencies**: 296 → 501 → 500 (#696), 171 → 467 (wave 3, not started), 810 → 842 (wave 4, undeclared), 768 → 278.
7. **The board is 14/16 and its two closers' groups are wave 4** (624, 819, 820, 625; 391, 392). E3.2 is green and not enforced. Each closing PR edits `ci.yml`, which is the owner's.
8. **PRD-001 is approved with PAC out of scope and all v1.0 tasks under RF-14 «Could»; PRD-003 is unapproved and has no design or backlog.** Set V can proceed under PRD-001's backlog; anything the norm reviews add as a new engine cannot, by `docs/prd/README.md`, until PRD-003, SD-003 and its backlog exist — or the owner says otherwise.
9. **Merge capacity is not the constraint.** Measured: one merge per ~51 min, 30 task merges on 26 Nov. The constraints are the owner's inputs, lane L's serial chain, and four tasks whose dates fall in 2027.
10. **Changing `lifecycle` away from `experimental` brings back the second person on every D4** (MNE-001-545). 643, 640, 704–707 and the vault task are D4.

## 7. What I did not review

- The norm content of any task (the other six reviewers); the «need» column of 1.2 is a backlog reading, not a norm judgement.
- The body or comments of the sensitive issues; they appear by number only.
- Issue comments other than #952, #603, #333 and #338; #105's plan was read only through 534's acceptance.
- Whether the Sovos documentation claims in 534 are right; no PAC and no SAT service was called.
- The Docker image and `npm run build` were not run; the statement that CI never builds comes from reading `ci.yml`.
- GitHub settings (rulesets, push protection, milestones): not readable with the tools at hand.
- The backlog change itself: nothing was edited, and `scripts/backlog.ts` was not run against a modified file.
