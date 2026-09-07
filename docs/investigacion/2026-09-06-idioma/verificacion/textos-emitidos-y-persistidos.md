# Verificación escéptica · «Textos emitidos y persistidos»

Objeto: `/tmp/investigacion-idioma/inventario/textos-emitidos-y-persistidos.md`.
Árbol: `/Users/victor/projects/Accounting`, `HEAD = b31e62a` (coincide con el informe). **Aviso**: el árbol está sucio y la rama activa es `j0-1-la-jurisdiccion-deja-de-ser-un-booleano`, no `instrumentos-que-mienten-segun-la-maquina` (`git status --short`: 7 modificados, 4 sin seguimiento; `git branch --contains b31e62a`). Todo lo que cito del árbol lo cité también de HEAD cuando el archivo está modificado (`doctor-service.ts`, `iva-ppd-reclass.ts`, `vitest.config.ts`). No edité ningún archivo del repo; ningún archivo leído contenía instrucciones dirigidas a mí.

Método: relancé cada comando C1–C15 tal cual (o uno más preciso), comprobé 92 citas archivo:línea con un script (`tep-work/muestra.txt`: `sed -n Lp F | grep -F aguja`) y busqué las clases de texto que el informe no visitó. Cada cifra lleva el comando.

---

## 1. Conteos: se sostienen / se caen

| # | Cifra del informe | Veredicto | Comando de comprobación → resultado |
|---|---|---|---|
| C1 | 106 `description:` en 11 escritores | **Se sostiene** | mismo bucle `grep -c -E "description: (\`\|'\|\")"` → 1+0+31+2+8+2+2+3+2+1+54 = **106** (`verificacion/c1.txt`). HEAD de `iva-ppd-reclass.ts` también 2. |
| C2 | 18 archivos llaman `createJournalEntry(` | **Se sostiene el número, no la lectura** | mismo comando → 18 archivos, **33 llamadas**; pero `src/plan/criterios.ts` (3), `src/plan/conducta.ts` (1) y `src/api/graphql/schemas/schema.ts` (1) no escriben pólizas: son greps del plan y un esquema. Escritores reales: **15 archivos**. |
| C3 | 22 cabeceras | **No reproducible** | el informe dice «+ lectura manual». Aproximación por comando: llamadas en escritores de sistema (ar-ap 9, treasury 3, posting 2, period-close 2, pre-reg 1, gl-posting 1, depreciation 1, amortization 1, iva-ppd 1) = 21 (`verificacion/c2.txt`). Plausible; no verificable sin leer. |
| C4 | 10 `creditIfPresent('` | **Se sostiene** | `grep -c "creditIfPresent('" …gl-posting-service.ts` → 10. Corrección de rango: van de **:149 a :200**, no «:149-193» (`grep -n`). |
| C5 | 32/6/3 = 41 | **Se sostiene** | mismo awk → `32 6 3`; `grep -c "code: '" chart-seed.ts` → 41. |
| C6 | 6 MX / 9 US | **Se sostiene** | mismo awk → `6 9`; total `code: '` en el archivo 15. |
| C7 | 24 | **Se sostiene** | `grep -c -E "^\s*code: '" account-roles-seed.ts` → 24. |
| C8 | 54 claves, 54 `question`, 134 opciones | **Se cae por uno en las tres** | `grep -c -E "^\s*key:" pending-catalog.ts` → 54 **incluye la interfaz** (`:15 key: string;`); `grep -c -E "^\s*key: '"` → **53**. Ídem `question:` (`:17 question: string;`) → **53** preguntas. `label:` 134 incluye `:11 label: string;` → **133 opciones** (`grep -o "value: '" \| wc -l` → 133). Las cifras «6 campos × 54 + 134 labels» del §6.6 heredan el error. |
| C9 | 0 preguntas con `¿`, 0 campos con acentos | **Se sostiene** | mismos comandos → 0 y 0. `grep -c -E "[áéíóúñ¿¡]"` sobre todo el archivo → 35 líneas, todas comentarios (`grep -n` muestra `//`). |
| C10 | 16 líneas `reason:` literal, 6 prosa | **16 sí; «6 prosa» engaña** | mismo comando → 16 (`verificacion/c10.txt`). De las 6 de prosa sólo **3 aterrizan en `audit_log`** (treasury:1568, reconciliation-service:1413, asset-service:740); las otras 3 son rótulos de prompt de CLI (`mnemosine.ts:1738,2450`) y una respuesta REST (`blockchain.ts:347`). |
| C11 | 50 `registrarAuditoria(` + 5 INSERT directos | **Se sostiene; matiz** | 50 ✓; `grep -rn "INSERT INTO audit_log" src \| grep -v /plan/` → 5, pero uno es la propia implementación (`src/services/audit/audit-log.ts:71`). Directos ajenos: **4** (rest/middleware/audit.ts:54, fiscal-calendar-service.ts:397, vendor-service.ts:564,638). |
| C12 | 53 líneas `name:`, 19 únicos, 43 `detail`, 5 con castellano | **Se sostiene; incompleto** | HEAD: 53 / 19 / 43 / 5 (líneas 410, 826, 907, 977, 1144) ✓. Lo que no contó: **3 `label:`** (`HEAD:278 'Payroll GL mapping'`, `:287 'SAT product-code mapping'`, `'Employer tax liabilities (USA)'`), nombres de capacidad que también salen por pantalla y que la prueba fija (`grep -o "name === '[^']*'" tests/ai/doctor-service.spec.ts` → `'Payroll GL mapping'` ×4, `'SAT product-code mapping'`, `'Encryption key'`, `'Migrations'`; `find(r,'Database')` ×3). |
| C13 | 8 formatos de locale (7 en-US, 1 es-MX) | **Se sostiene** | mismo comando → 8; ampliado a `toLocale[A-Za-z]*\(\|Intl\.` → también 8. |
| C14 | pruebas que fijan textos | **Parcial** | ver §3: cinco literales fijados por pruebas que el informe no lista. |
| C15 | 0 implementaciones de correo | **La conclusión sí, la cifra no** | `grep -rn -i -E "nodemailer\|sendgrid\|smtp\|sendMail\|sendEmail" src --include='*.ts' \| grep -v /plan/` → **2**, no 0: `src/api/graphql/permisos.ts:144` y `src/api/rest/routes/invoices.ts:76`, dos comentarios que citan un `sendgrid-adapter.ts` que **no existe** (`find src -iname "*sendgrid*"` → nada). `IEmailAdapter` fuera de la interfaz → 0 ✓. `package.json` sin dependencia de correo ✓. |

Cifras de §2 que no son C1–C15:

| Afirmación | Veredicto | Comprobación |
|---|---|---|
| `053:118-135` siembra **4** cuentas «es+en» | **Se cae** | `grep -c -E "^\s*\('MX'," 053_…sql` → **10**; `('USA',` → **9**. Son 19 filas (`:100-122`), no 4. Además `053:91` casa cuentas **por nombre** (`AND a.name = CASE WHEN e.pais = 'USA' THEN 'Employer Payroll Taxes' ELSE 'Cuotas Patronales IMSS e INFONAVIT' END`): la frase «los roles se resuelven por code, nunca por nombre» tiene al menos esa excepción, en una migración ya aplicada. |
| `vitest.config.ts:82,88,95` (posting, ar-ap, report-service) y `:41` (period-close sin umbral) | **Se cae** | HEAD: `git show HEAD:vitest.config.ts \| grep -n` → **75 / 81 / 88 / 34**. Árbol: **92 / 98 / 105 / 51**. Ninguna de las cuatro líneas citadas existe en ninguno de los dos estados. Además el árbol tiene 6 umbrales por archivo (posting, validation, ar-ap-posting, sequence, report-service, criterio-cierre) y un `include` nuevo `src/services/jurisdiccion/**` (:37) que HEAD no tiene. |
| `src/ai/docs/cli-reference.md` «hasheado en manifiesto.json» | **Se cae** | `grep -c "cli-reference" src/ai/docs/manifiesto.json` → **0**. El manifiesto cubre 13 manuales (`accounting, mexico-cfdi, receivables, payables, banking, payroll, reports, mnemosine, playbooks, system, identity-access, connectivity, external-integrations`); la dependencia real es `scripts/corpus-manifiesto.ts` + `criterios.ts:3718-3721`. |
| «Ninguna ruta de esta superficie en `LINEA_BASE`» | **Se sostiene, pero vacío** | `awk 'NR>=197&&NR<=400' src/cli/kernel/audit.ts \| grep -c -E "services/(accounting\|…)"` → 0. `LINEA_BASE` (:197-256) no guarda rutas de archivo sino hallazgos de la auditoría de CLI (`'entities\|R1 objectless allowlist\|…'`): la afirmación es cierta por construcción y no dice nada de esta superficie. |
| «`criterios.ts` no fija ninguna de estas plantillas» | **Cierto para pólizas, falso para semillas** | `grep -n -E "Reversal\|Voided\|Year-end\|Close Income\|Bank fee\|…" src/plan/criterios.ts` → 0 ✓. Pero `grep -n -E "^\s*(de\|a): " criterios.ts \| grep -E "[áéíóúñ]\|'[A-Za-z]+ [A-Za-z ]+'"` → **tres mutantes** sustituyen nombres de cuenta literalmente: `:1974-1975` (`account-roles-seed.ts`, `name: 'IVA Pendiente de Acreditar'`), `:2021-2022` (`payroll-account-mapping-seed.ts`, `'Sueldos y Salarios'`), `:2029-2030` (`chart-seed.ts`, `'Sueldos y Salarios'` → `'Nomina'`). Y el criterio E1.1 «Un código de cuenta significa UNA cuenta» (`:2058`) parsea `code:\s*'…'\s*,\s*name:\s*'…'` en **todo `src`** y devuelve `noEvaluable` si no encuentra pares (`:2072-2073`). El §6.3 del informe (`{code, nameKey}`) deja E1.1 sin evaluar y tres mutantes sin diana. |
| «No hay `createHash` en `src/services/reporting`» | **Se sostiene; pero el Anexo 24 sí se hashea y se persiste** | `grep -rn createHash src/services/reporting \| wc -l` → 0 ✓. En cambio `src/services/sat/anexo24/artefactos.ts:60` (`createHash('sha256')` del XML) y `:83` (`INSERT … xml, hash_sha256, …`) guardan **el XML entero y su hash** en `sat_anexo24_artefactos` (`062_el_xml_que_se_entrega.sql:58`, `UNIQUE (…, hash_sha256)` `:80`); `balanza-service.ts:551` reconstruye el catálogo **desde el XML guardado**. El informe dice que el `Concepto` inglés «viaja al SAT»; además **queda persistido con hash** dentro de la base. |
| Doctor: «el nombre es contrato» sólo por pruebas | **Incompleto** | `src/cli/doctor-command.ts:45,50` (`--json` → `JSON.stringify(report)`): el `name` es también contrato de scripts. |

---

## 2. Muestra de citas archivo:línea

Script: `verificacion/tep-work/muestra.txt` (92 citas, tomadas de todas las secciones) → **78 exactas a la primera**, 14 «fallos» que eran citas de rango donde la aguja estaba en otra línea del mismo rango; recomprobadas dentro del rango, **90 de 92 exactas**. Las 2 restantes son correctas en sustancia, no en literal:

- `period-close.ts:1300-1312` «valores comparados por el código»: lo que hay es `accionDeRecierre(polRecierre.value)` (`:1308`), que compara en `:1154-1161` (`'reversar_y_reemitir'`, `'prohibir'`, `'incremental'`). Cierto, línea distinta.
- `cfdi-nomina-generator.ts:120-121` para `Descripcion="Pago de nómina"`: está en `:134` (el informe cita `:108,120-121,134,154` en bloque; `:108` `Concepto="Subsidio para el empleo…"`, `:154` `Concepto="ISR"` exactos).

Las citas de HEAD para los dos archivos modificados (`doctor-service.ts` 826/907/977/1144, `iva-ppd-reclass.ts` 232/238/244) son exactas en HEAD.

Citas del informe que **no** se sostienen (fuera de la muestra, verificadas aparte): `vitest.config.ts:82,88,95,41`; «`cli-reference.md` hasheado»; `053:118-135` = «4 filas»; `tests/ai/doctor-service.spec.ts:86-136` busca `'Tenant isolation'` → en ese rango sólo `find(r, 'Migrations')` (`sed -n 86,136p \| grep -o "find(r, '[^']*')"`); `'Tenant isolation'` sí aparece 4 veces en `tests/` (`grep -rn "Tenant isolation" tests \| wc -l`), en otros archivos.

---

## 3. Lo que el informe no vio

### 3.1 Textos persistidos por el sistema que faltan en el inventario

1. **`paycheck_taxes.calculation_notes TEXT`** (`008_payroll.sql:319`; escrito en `paycheck-service.ts:630-637`). Lo alimentan **17 literales `notes:`** de las calculadoras (`grep -rn -E "notes: (\`\|')" src/services/payroll --include='*.ts' \| grep -v gl-posting \| wc -l` → 17; en inglés: `fit-calculator.ts:29,64`, `fica-calculator.ts:30,86`, `futa-calculator.ts:32`, `state-tax-calculator.ts:49,70,104`, `local-tax-calculator.ts:54,72`, `isr-calculator.ts:22,42,85`, `imss-calculator.ts:90,145`, `infonavit-calculator.ts:44,83`) y **4 plantillas `notas:` en castellano** en `paycheck-service.ts:395,410-411,428,475-476` (`grep -c -E "^\s*notas:"` → 4), más `subsidio-entregado.ts:135-143` (`notaDelSubsidioEntregado`, castellano, que cita el valor del panel `cuenta_por_cobrar_fisco`). Resultado: la misma fila mezcla `Art. 96 LISR quincenal · retenido tras acreditar el subsidio: …`. Nadie lee la columna fuera del escritor (`grep -rn calculation_notes src \| grep -v paycheck-service` → 0), pero es texto de sistema persistido, exactamente la clase del informe.
2. **`ai_drafts.ai_reasoning` redactado por el sistema, no por el LLM**: `src/ai/onboarding-service.ts:229-230` (`Deterministic balance import from ${provider} …`, en) y `src/services/banking/reconciliation-adjustments.ts:487-490` (`Ajuste de conciliación bancaria (${tipo}) detectado en la sesión …`, es). El informe trata `ai_reasoning` como prosa del LLM (§2.9).
3. **Plantillas de póliza que el informe atribuye al usuario**: `reconciliation-adjustments.ts:461-463` pone `Conciliación bancaria ${end_date} · ${nombre_de_cuenta} · ${tipo}` (es) cuando el usuario no da descripción, y la copia a las dos líneas (`:294-299`); pasa por `createDraft` (`:484`) a `journal_entries.description`. Y `onboarding-service.ts:215` (`Opening balancing (${provider})`, línea) y `:222` (`Opening balance from onboarding via ${provider} as of ${cutoffDate}`, cabecera) — el informe sólo cita `:204` como **nombre de cuenta**. Son 4 plantillas de sistema (2 es, 2 en) fuera del «~120».
4. **Cuarta semilla de cuentas**: `src/database/seed.ts:75-116` siembra **38** cuentas en castellano (`grep -c "code: '" src/database/seed.ts` → 38; `npm run seed` en `package.json:15`). El informe cita `seed.ts` sólo por los meses (`:54,68`). El propio E1.1 (`criterios.ts:2039-2040`) la cuenta como la cuarta.

### 3.2 Dependencias que se rompen y no están en §4/§5

- `src/plan/criterios.ts:1974-1975, 2021-2022, 2029-2030` (mutantes por texto de semilla) y `:2058-2073` (E1.1 parsea `code:/name:`). Con `npm run plan:status --piso` esto no es cosmética: mutantes que dejan de aplicar rompen el trinquete.
- `sat_anexo24_artefactos` (`062:58,80`; `artefactos.ts:60,83,105`; `balanza-service.ts:551`): XML y hash persistidos, `UNIQUE` por hash. Cualquier cambio en cómo se renderiza `Concepto`/`DesCta` produce artefactos nuevos con hash distinto para el mismo mes y deja los viejos como dato. El §6.2 («renderizar siempre en es-MX al emitir») necesita decir qué pasa con los artefactos ya guardados y con la prueba `tests/integration/f07b-balanza-que-se-entrega.int.spec.ts:170` / `f07d-polizas-y-su-rastro.int.spec.ts:430-435` que comparan el hash guardado.
- `053_…sql:91` resuelve por nombre (ver §1).
- Pruebas que fijan literales y no están en C14: `'todas las compuertas'` → `tests/ai/ingest-service.spec.ts`; `'human-taught'` → `tests/ai/memory-service.spec.ts`; `'Caja y Bancos'` → `tests/integration/g1b-amarre-efectivo.int.spec.ts`, `tests/cli/cashflow-command.spec.ts`, `tests/services/reporting/cash-flow-service.spec.ts`; `'Subsidio al empleo'` → `tests/services/payroll/paycheck-service.spec.ts`; `'Cuenta Bancaria Operativa'` → `tests/integration/catalogo-por-pais.int.spec.ts` (`grep -rl --include='*.ts' -F "<literal>" tests`).
- `src/cli/doctor-command.ts:50` (`--json`): `name` como contrato de scripts.
- Existe una auditoría previa sobre idioma que el informe no cita: `docs/auditorias/2026-09-01-usabilidad/ux-idioma.md` (y `SINTESIS-brechas.md` en la misma carpeta), con hallazgos sobre el catálogo sembrado (`seed.ts:75-116`).

### 3.3 Lo que comprobé y sí está bien (para no refutar de más)

- Sin snapshots en `tests/` (`find tests -name "*.snap" \| wc -l` → 0); `tests/golden` sólo tiene `cfdi/`; el único test que fija un `Concepto=` del Anexo 24 lo hace con texto de usuario (`f07d:527 'Ajuste de fin de mes'`). No hay «golden» del Anexo 24 con plantillas de sistema.
- `ai_shadow_verdicts.motivo`: 6 en + 1 es (`ingest-service.ts:410-461`) ✓; escritor `shadow-verdicts.ts:26` ✓.
- `policy-service.ts:47-58` inserta `question, impact, options, default_value, default_rationale` con `ON CONFLICT DO NOTHING` ✓. `gl-posting-service.ts:185-188` y `posting.ts:173,180-182` comparan valores del panel ✓.
- `041_el_mayor_inviolable.sql:45-48` `permitidas = reversed_by_entry_id, notes, entry_hash, blockchain_attestation_id, commitment` ✓ (`description` congelada).
- `chart-seed.ts:32-35` «con los nombres en español porque el producto se usa en español» ✓.
- Ninguna de las 106 líneas de C1 lleva acento (`grep -E "[áéíóúñ¿¡]"` → 0); las 5 castellanas del informe (`iva-ppd` ×3 sin acento en dos, `gl-posting:187-188` fuera de la clave `description:`) son las que hay. El «5 es + 1 mixta» se sostiene **dentro** del universo del informe; con §3.1 el universo crece en 4 plantillas de póliza (2 es, 2 en) y 22 de nómina.
- Generadores a terceros: `find src/services -iname "*generator*" -o -iname "*export*" -o -iname "*serializ*"` → 15 archivos; los que faltaban en §2.11 (`form-940`, `form-941`, `w3-generator`, `exportacion-inquilino`) no tienen prosa libre (`grep -n -E "'[A-Za-z]+ [A-Za-z ,]{8,}'"` → sólo un `BEGIN TRANSACTION…`).
- Webhooks sin literales de prosa (`grep -n -E "(message\|title\|summary\|text\|body): (\`\|')" webhook-service.ts` → 0) ✓.

---

## 4. Resumen corregido

El inventario acierta en el grueso: los 106 `description:`, las 41+24+15 cuentas sembradas, los 8 formatos de locale, la inmutabilidad del mayor (`041`), la congelación del panel por tenant y el reparto «mayor en inglés / rastro en castellano» se reproducen comando por comando, y 90 de 92 citas son exactas. Se caen: el panel tiene **53** políticas, **53** preguntas y **133** opciones (no 54/54/134: contó la interfaz); `053` siembra **19** cuentas (no 4) y resuelve **por nombre** en `:91`; las líneas de `vitest.config.ts` no existen ni en HEAD ni en el árbol; `cli-reference.md` **no** está en el manifiesto; C15 da 2 comentarios, no 0. Lo que no vio pesa más que lo que erró: (a) `paycheck_taxes.calculation_notes` recibe 21 plantillas de sistema en dos idiomas mezclados en la misma fila; (b) `reconciliation-adjustments.ts:463` y `onboarding-service.ts:215,222` son plantillas de sistema que el informe atribuye al usuario/LLM, y ambas escriben además `ai_reasoning` de sistema; (c) el Anexo 24 **no sólo sale**: se guarda entero con su SHA-256 en `sat_anexo24_artefactos` con `UNIQUE` por hash, y hay pruebas que comparan ese hash; (d) tres mutantes y el criterio E1.1 de `criterios.ts` dependen del texto literal `code: 'X', name: 'Y'` de las semillas, así que el §6.3 (`{code, nameKey}`) rompe el trinquete `--piso` si no se reescriben en el mismo PR; (e) `seed.ts` es una cuarta semilla de 38 cuentas; (f) hay una auditoría previa de idioma en `docs/auditorias/2026-09-01-usabilidad/` sin citar. El orden de riesgo de §6 sigue siendo razonable, pero «panel sin datos que rehacer» debe leerse con 53/133 y «semillas» debe incluir criterios.ts y seed.ts.
