Issue: #1080

## Goal

Cut release 1.0 as ADR-0008 decided: `release` from `develop`, `main` from `release`, a tag and a GitHub release. A firm can install the tagged version on its own machine in production mode, upgrade it later, and see what was checked on the tagged commit.

## Tranche and context

New tranche: release mechanics. No task covers what follows. Measured on develop `e9a327d0`, 27 Nov 2026.

- **Nothing has ever been released.** `origin/main` and `origin/release` point at `711ad88f` (#511, 29 Sep 2026), 430 commits behind `develop` and 0 ahead. No tag, no GitHub release, no CHANGELOG.
- **The version number has no tag behind it.** `package.json:3` says `1.0.0` and `mnemosine --version` prints it (`src/cli/mnemosine.ts:243`, `:1074`). The package declares no `license`.
- **The built binary is never built.** None of the nine jobs of `.github/workflows/ci.yml` runs `npm run build`. `dist/cli/mnemosine.js` (the `bin`, `package.json:6`) is first executed on a firm's machine. `docker/Dockerfile` installs with `npm install` (`:7`, `:27`).
- **The install page is a developer checkout.** README «Quick start» (`README.md:129`) writes a development `.env` and runs the source through npm (`:150`).
- **A firm's install in production mode has no vault it can use.** D-06 (MNE-001-539, 17 Nov) chose a vault on the firm's machine. With `NODE_ENV=production`, `src/services/vault/index.ts:49-53` accepts only AWS Secrets Manager, and the local backend refuses (`local-dev.ts:36`). No task builds the decision.
- **No upgrade page and no upgrade test.** CI always migrates an empty database. `711ad88f` had 105 migration files (last: 145); develop has 141 (last: 347).
- **The history check looks at one branch.** `scripts/historial-estado.ts:178` walks `--first-parent` from HEAD. After a release merge commit it sees none of the PRs the release carries (ADR-0008, «Consecuencias»).
- **E3.2 is green (10/10) and is not in `--exigir`** (`ci.yml:271`).
- **Hotfixes:** ADR-0008 left the rule undecided.

Existing tasks of the same cut keep their ids: MNE-001-251, 258, 259, 387, 663, 764, 786.

## Tasks

| Temp id | Title | Size | Depends on | Class |
|---|---|---|---|---|
| MNE-001-963 | The first release is cut as ADR-0008 says, with its tag and its checklist | 80 | R6, R7, R8, R13 | R |
| MNE-001-964 | Decision: how an urgent repair reaches `main` after the first release | — | — | owner |
| MNE-001-965 | The history counts the PRs that entered `develop`, and a release merge does not blind it | 120 | — | S |
| MNE-001-966 | One rule for the version: SemVer in `package.json`, equal to the tag; the package declares its licence | 60 | — | S |
| MNE-001-967 | The 1.0 release notes: what it does, what it does not, what dated upkeep awaits | 150 | — | S |
| MNE-001-968 | A firm installs a tagged version in production mode from one page | 250 | R7, R8 | R |
| MNE-001-969 | The production vault lives on the firm's machine (D-06) | 300 | — | R |
| MNE-001-970 | The built binary starts before a release: build, version, doctor, one read | 150 | — | R |
| MNE-001-971 | Upgrading an installation has its page | 120 | R6 | S |
| MNE-001-972 | A database migrated to the previous cut, with data, reaches the tip intact | 200 | — | S |
| MNE-001-973 | The release candidate leaves its evidence in one place | 80 | R8 | S |
| MNE-001-974 | E3.2 enters `--exigir` | 5 | — | S |
| MNE-001-975 | A security pass over the candidate and the owner's ruling on each reserved issue | 60 | — | R |

MNE-001-861 (a task id admits four digits) hangs on #329 and is being built apart.

## Acceptance criteria

- [ ] (R1) Given a frozen commit of `develop` with CI green, when the two promotion PRs are merged with merge commits, then `main` carries tag `v1.0.0` equal to `package.json`, and a GitHub release exists with its notes.
- [ ] (R3) Given a PR merged to `develop` and promoted, without a row in `docs/HISTORY.md` and past the grace period, when `historial-estado --check` runs on `main`, then it exits 1.
- [ ] (R4) Given a `v*` tag on HEAD, when the spec runs, then the tag equals the version in `package.json`, and `mnemosine --version` prints it.
- [ ] (R5) Given the release, when a firm reads `docs/releases/1.0.0.md`, then every task and issue it names exists in the backlog.
- [ ] (R6) Given a clean machine, when a person follows the install page, then `doctor` is green under `NODE_ENV=production`.
- [ ] (R7) Given `NODE_ENV=production` and no AWS account, when `sat cred add` runs, then the secret is stored encrypted on the machine with its key outside the data directory. The owner approved the plan first.
- [ ] (R8) Given a clean checkout, when `scripts/smoke-dist.sh` runs, then the build succeeds, the binary prints its version, and `doctor` and `account list` run against a freshly migrated database.
- [ ] (R9) Given an installed version, when a person follows the upgrade page, then the backup is verified before the migration.
- [ ] (R10) Given a database built only from the migrations of the previous cut, with one posted entry, when today's runner applies the rest, then no migration fails, the entry is intact and the ledger checks pass.
- [ ] (R11) Given a commit, when `scripts/release-evidence.ts` runs, then it prints each check with its link.
- [ ] (R12) Given a mutant that breaks an E3.2 criterion, when CI runs, then the job «Estado del plan» is red.
- [ ] (R13) Given the frozen candidate, when the security pass ends, then each reserved issue has the owner's written ruling, and `npm audit --omit=dev` is zero or each exception is written down.

## Owner's checklist (only the owner can do these)

- [ ] Sovos: which product the contract covers; test and production keys through the secure form, never in chat; the issuing RFC registered with the PAC; a test CSD (MNE-001-534).
- [ ] Approve the plan of MNE-001-969 and merge its PR.
- [ ] Merge the PRs that touch `.github/workflows/`: MNE-001-611, 251, 258, MNE-001-970's step, MNE-001-974, and each `--exigir` edit.
- [ ] Run the classifier eval with their own key (MNE-001-451; MNE-001-450 with any user's key).
- [ ] Confirm secret-scanning push protection (#338) and review the branch ruleset.
- [ ] Rule on each reserved issue: #96, #589, #590, #591, #598, #599, #674, #675, #593, #185, and the operational step of #370.
- [ ] Decide `lifecycle` in `catalog-info.yaml`. Leaving `experimental` behind brings back the second person on every D4 (MNE-001-545).
- [ ] Name the release manager and the cadence (#333's question) and answer MNE-001-964.
- [ ] Say whether a database with real data already exists.
- [ ] Run a trial month on their own data.
- [ ] Merge the two promotion PRs and push the tag.

## Impact

- **API:** none.
- **SAT / IMSS deliverables:** none.
- **Schema:** no migration.
- **CLI:** `doctor` names the vault backend (R7).
- **Configuration:** a new `VAULT_BACKEND` value (R7); `package.json` gains `license`, `repository`, `private` (R4).
- **CI:** two owner-merged edits of `ci.yml` (R8, R12).

## Out of scope / later

- Deployment on the Sedecim platform (MNE-001-107), alerts, on-call and canary.
- Publishing to npm or a container registry.
- Migrations that run backwards; upgrades that skip a version.
- Moving secrets between vault backends.

## How to test

`scripts/verify.sh` with its new `build` gate; `npm run test:integration` for R7 and R10; `historial-estado --check` on a synthetic three-branch repository for R3; the checklist itself on the candidate for R1, R11 and R13.

## Classification

D2 overall; R7 is D4 on a critical path (entered as D3). A3 for R1, R7, R8, R12, R13; A2 or A1 for the rest. Each part is under 400 hand-written lines.

## Constraints

- `src/services/vault/` and `.github/workflows/` are critical paths: the owner approves the plan and merges.
- Promotion PRs are merged with merge commits, never squash or rebase.
- Security findings go through the private channel of `SECURITY.md`, never a public issue.
- No agent tags or merges into `release` or `main`.

## Depends on

Part of #333 and #338. R1 is the last task of the release: it waits for every Must task of wave 3.

**Para el dueño:** el sistema nunca se ha liberado: `main` lleva dos meses detenido, no hay etiqueta de versión, y lo que instalaría un despacho (el programa ya construido) nunca se ha probado. Además, un despacho que lo instale en modo de producción no tiene dónde guardar su e.firma sin una cuenta de AWS, aunque tú decidiste el 17 de noviembre que se guardara en su propio equipo. Esta issue reúne lo que falta para cortar la 1.0: la lista del corte, las páginas de instalación y de actualización, la bóveda local, las notas de la versión y la evidencia de lo comprobado. Lo tuyo está en «Owner's checklist»; lo primero es aprobar el plan de la bóveda y entregar los datos de Sovos.

---
_Generated by [Claude Code](https://claude.ai/code)_
