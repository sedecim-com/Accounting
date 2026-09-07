# Normas fiscales de Estados Unidos para una PyME con nómina — lo que el motor debe implementar y lo que debe ser tabla

Rama `investigacion/normas-y-motores` · 2026-09-06 · sin ediciones al repositorio.
Alcance: reglas federales (IRC, IRS, SSA, DOL, eCFR/Cornell) y estatales que un sistema contable con nómina para PyME estadounidense debe implementar o parametrizar; cotejo contra `src/`, `docs/` y `src/ai/docs/`. Los informes de motores que este documento presupone son [`../motores/nomina-us.md`](../motores/nomina-us.md) (inventario), [`../verificacion/nomina-us.md`](../verificacion/nomina-us.md) (escéptico) y `docs/investigacion/2026-09-06-normas-y-motores/motores-inventario.md` §4 y §6 (fiscal US fuera de nómina; nómina US). Cuando aquí se dice «el repo tiene» o «falta», la afirmación lleva `archivo:línea` y se comprobó por lectura o `grep` en esta sesión.

## 0. Método y vocabulario

- **Fuentes.** Cada liga de la tabla §1 se abrió en esta sesión. `verificada = true` sólo si el servidor respondió con contenido; `false` si devolvió 403/404 o redirigió a un bloqueo. Cuando la fuente primaria no respondió (SSA, NACHA, ACF, tres agencias estatales), se dice y se usa la fuente secundaria o la norma que la reproduce (la Pub 15 del IRS reproduce el tope de la SSA). Cinco PDF (Pub 15-T, Pub 1494, Rev. Proc. 2025-19, Schedule A del 940, *Significant Provisions* del DOL, W-4 2026, NYS-50-T-NYC) se leyeron con `pdftotext` sobre el archivo descargado; las cifras que salen de ellos se marcan **[pdf]**.
- **Dato, no instrucción.** Ninguna página pidió ejecutar nada; no hubo nada que ignorar.
- **MOTOR / PUERTA / PARÁMETRO.** Motor: aritmética o regla implementada. Puerta: superficie CLI/REST/agente que lo invoca. Parámetro: tasa, tope, umbral, tabla o calendario que la ley fija y cambia por fecha o por estado, y que debe vivir en `tax_parameters`/`tax_tables` (hoy) o en `parametros_legales` con vigencia (diseño de `docs/jurisdicciones.md` §3.4 en el repositorio, `/Users/victor/projects/Accounting/docs/jurisdicciones.md`), nunca quemado en código.
- **Ley vs. criterio.** Lo que la ley fija no se pregunta al contador: va a tabla con fuente y vigencia. Lo que el despacho decide (qué estados tienen nexo de *sales tax*, si se elige §179 o *bonus*, método de inventario) va al panel de políticas con su lector, siguiendo la regla de la casa.
- **Año.** Las cifras son del ejercicio 2026 salvo que se diga otra cosa; la reducción de crédito FUTA es la de 2025 (se paga con la 940 que se presenta en enero de 2026) porque la de 2026 no se conoce hasta el 10 de noviembre.

## 1. Tabla de fuentes

| # | Título | URL | Emisor | Qué cubre | Aplica a | Verificada |
|---|---|---|---|---|---|---|
| F1 | Topic 751, Social Security and Medicare withholding rates | https://www.irs.gov/taxtopics/tc751 | IRS | SS 6.2 % cada parte; tope 184 500 (2026); Medicare 1.45 %; Additional Medicare 0.9 % desde 200 000 | US federal | true |
| F2 | Publication 15 (Circular E), 2026 | https://www.irs.gov/publications/p15 | IRS | Tope SS 184 500; suplementarios 22 %/37 %; *lookback*, 50 000, 100 000, 2 500; FUTA 6.0 %/7 000/500; 944 ≤ 1 000; *What's New* 2026 (propinas y horas extra) | US federal | true |
| F3 | Publication 15-T (2026), HTML | https://www.irs.gov/publications/p15t | IRS | Worksheet 1A; tabla anual STANDARD *single* 2026; 4 300 por *allowance* pre-2020 | US federal | true |
| F4 | Publication 15-T (2026), PDF | https://www.irs.gov/pub/irs-pdf/p15t.pdf | IRS | Las seis tablas anuales (STANDARD y Step 2 Checkbox × MFJ/Single-MFS/HoH); línea 1g (12 900 / 8 600); nota HoH pre-2020 **[pdf]** | US federal | true |
| F5 | Questions and answers for the Additional Medicare Tax | https://www.irs.gov/businesses/small-businesses-self-employed/questions-and-answers-for-the-additional-medicare-tax | IRS | 0.9 %; umbrales 250 000 MFJ / 125 000 MFS / 200 000 resto; el patrón retiene sobre 200 000 sin importar el estatus | US federal | true |
| F6 | Topic 759, Form 940 – FUTA | https://www.irs.gov/taxtopics/tc759 | IRS | 6.0 % sobre 7 000; crédito 5.4 %; neto 0.6 %; depósito si > 500; 940 vence 31-ene (10-feb si depositó); prueba 1 500/20 semanas | US federal | true |
| F7 | FUTA credit reduction | https://www.irs.gov/businesses/small-businesses-self-employed/futa-credit-reduction | IRS | Mecanismo: 0.3 % el primer año, +0.3 % cada año; DOL anuncia tras el 10-nov | US federal | true |
| F8 | FUTA Credit Reductions | https://oui.doleta.gov/unemploy/futa_credit.asp | DOL/ETA | Página índice; las tablas históricas y «Potential 2026» son XLSX enlazados (no leídos) | US federal | true |
| F9 | Schedule A (Form 940) 2025 | https://www.irs.gov/pub/irs-pdf/f940sa.pdf | IRS | Estados con reducción de crédito 2025: California 1.2 %, Islas Vírgenes 4.5 % **[pdf]** | US federal | true |
| F10 | Instructions for Form 940 (2025) | https://www.irs.gov/instructions/i940 | IRS | 6.0 %/5.4 %/7 000; depósito > 500; vence 2-feb-2026 (10-feb si depositó); quién presenta | US federal | true |
| F11 | Instructions for Form 941 (2026) | https://www.irs.gov/instructions/i941 | IRS | Tope 184 500; líneas 5a-5d (0.124/0.029/0.009); *lookback* y 50 000; 2 500; 100 000; Schedule B; vencimientos trimestrales; *What's New* 2026 | US federal | true |
| F12 | Employment tax due dates | https://www.irs.gov/businesses/small-businesses-self-employed/employment-tax-due-dates | IRS | 941 fin de mes siguiente; 940/W-2/1099-NEC/944/943 31-ene; 945 y 1099 en papel 28-feb, e-file 31-mar; depósitos mensual (día 15) y semisemanal (mié/vie); +10 días si depositó | US federal | true |
| F13 | 26 CFR 31.6302-1 | https://www.law.cornell.edu/cfr/text/26/31.6302-1 | eCFR vía Cornell | Definición de *lookback*; 50 000; miércoles/viernes; regla de 100 000 al día siguiente; *de minimis* 2 500; *safe harbor* 2 % / 100 | US federal | true |
| F14 | About Form 944 | https://www.irs.gov/forms-pubs/about-form-944 | IRS | Patrones con pasivo anual ≤ 1 000 presentan anual | US federal | true |
| F15 | General Instructions for Forms W-2 and W-3 (2026) | https://www.irs.gov/instructions/iw2w3 | IRS | Códigos nuevos caja 12: TP (propinas), TT (horas extra calificadas), TA; caja 14b código de ocupación; vence 1-feb-2027 (SSA y empleado); e-file desde 10 informativas; códigos D, W, DD, AA | US federal | true |
| F16 | About Form W-4 | https://www.irs.gov/forms-pubs/about-form-w-4 | IRS | Página índice de la forma 2026 | US federal | true |
| F17 | Form W-4 (2026), PDF | https://www.irs.gov/pub/irs-pdf/fw4.pdf | IRS | Pasos 1-5; 2(c) caja de empleos múltiples; 3: hijos < 17 y 500 por otro dependiente, límite 200 000/400 000; 4(a)/(b)/(c); exención anual **[pdf]** | US federal | true |
| F18 | Instructions for Forms 1099-MISC and 1099-NEC (rev. dic-2026) | https://www.irs.gov/instructions/i1099mec | IRS | Umbral 2 000 USD para NEC y MISC (rentas, premios, otros) en ejercicios posteriores a 2025; regalías 10; abogados 600; NEC vence 31-ene; MISC 28-feb papel / 31-mar e-file; corporaciones exentas salvo abogados y médicos | US federal | true |
| F19 | About Form 1096 | https://www.irs.gov/forms-pubs/about-form-1096 | IRS | Transmisión sólo en papel; en e-file no existe (Pub 1220) | US federal | true |
| F20 | Understanding your Form 1099-K | https://www.irs.gov/businesses/understanding-your-form-1099-k | IRS | Umbral TPSO: más de 20 000 USD **y** más de 200 transacciones | US federal | true |
| F21 | Final regulations on e-file (T.D. 9972) | https://www.irs.gov/newsroom/irs-and-treasury-issue-final-regulations-on-e-file-for-businesses | IRS | e-file obligatorio desde 10 informativas agregadas, desde 2024 | US federal | true |
| F22 | Backup withholding | https://www.irs.gov/businesses/small-businesses-self-employed/backup-withholding | IRS | 24 %; TIN faltante/incorrecto (BWH-B) o aviso IRS (BWH-C) | US federal | true |
| F23 | About Form W-9 | https://www.irs.gov/forms-pubs/about-form-w-9 | IRS | Solicitud de TIN y certificación al beneficiario; Pub 1281 | US federal | true |
| F24 | TIN Matching | https://www.irs.gov/tax-professionals/taxpayer-identification-number-tin-matching | IRS | Validación TIN+nombre antes de presentar 1099 | US federal | true |
| F25 | 401(k) limit increases to $24,500 for 2026 (Notice 2025-67) | https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 | IRS | §402(g) 24 500; *catch-up* 50+ 8 000; 60-63 11 250; IRA 7 500 (+1 100); SIMPLE 17 000 | US federal | true |
| F26 | Tax inflation adjustments for tax year 2026 (Rev. Proc. 2025-32) | https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2026-including-amendments-from-the-one-big-beautiful-bill | IRS | Deducción estándar 16 100 / 32 200 / 24 150; tramos 2026; FSA 3 400; exclusión sucesoria 15 M; FEIE 132 900 | US federal | true |
| F27 | Rev. Proc. 2025-19 (HSA 2026) | https://www.irs.gov/pub/irs-drop/rp-25-19.pdf | IRS | HSA 4 400 / 8 750; HDHP deducible mínimo 1 700 / 3 400; gasto máximo 8 500 / 17 000 **[pdf]** | US federal | true |
| F28 | Publication 15-B (2026) | https://www.irs.gov/publications/p15b | IRS | Transporte 340/mes; DCAP 7 500 (3 750 MFS); FSA 3 400; §125 excluye de FIT, SS y Medicare; GTL 50 000; adopción 17 670 | US federal | true |
| F29 | Working Families Tax Cuts: deductions for working Americans (OBBBA) | https://www.irs.gov/newsroom/one-big-beautiful-bill-act-tax-deductions-for-working-americans-and-seniors | IRS | «No tax on tips» 25 000 y «no tax on overtime» 12 500/25 000; *phase-out* 150 000/300 000; 2025-2028; el patrón informa propinas, ocupación y horas extra calificadas | US federal | true |
| F30 | Penalty relief for TY2025 on tips and overtime reporting (Notice 2025-62) | https://www.irs.gov/newsroom/treasury-irs-provide-penalty-relief-for-tax-year-2025-for-information-reporting-on-tips-and-overtime-under-the-one-big-beautiful-bill | IRS | 2025 es transición; W-2/1099 de 2025 no cambian; desde 2026 el reporte separado es obligatorio | US federal | true |
| F31 | Q&A: deduction for qualified overtime compensation | https://www.irs.gov/newsroom/questions-and-answers-about-the-new-deduction-for-qualified-overtime-compensation | IRS | Sólo la «mitad» del *time-and-a-half* es compensación calificada; reporte separado obligatorio en W-2/1099 desde 2026 | US federal | true |
| F32 | Fact Sheet #30, CCPA Title III | https://www.dol.gov/agencies/whd/fact-sheets/30-cppa | DOL/WHD | 25 % o exceso sobre 30×7.25 = 217.50/semana; 50/55/60/65 %; excepciones (quiebra, impuestos); ingreso disponible; prohibición de despido por un embargo | US federal | true (primer intento falló, segundo respondió) |
| F33 | 15 U.S.C. §1673 | https://www.law.cornell.edu/uscode/text/15/1673 | Congreso vía Cornell | Texto legal de los topes (a) y (b) | US federal | true |
| F34 | Minimum wage (FLSA) | https://www.dol.gov/agencies/whd/minimum-wage | DOL/WHD | 7.25 USD/h desde 24-jul-2009; los estados pueden fijar más | US federal | true |
| F35 | Overtime pay (FLSA) | https://www.dol.gov/agencies/whd/overtime | DOL/WHD | 1.5× la tasa regular sobre 40 h/semana; sin recargo por fin de semana o festivo | US federal | true |
| F36 | Publication 1494 (2026) | https://www.irs.gov/pub/irs-pdf/p1494.pdf | IRS | Importe exento de embargo fiscal 2026 por estatus, dependientes y periodicidad; adicional 65+/ciego **[pdf]** | US federal | true |
| F37 | 20 U.S.C. §1095a | https://www.law.cornell.edu/uscode/text/20/1095a | Congreso vía Cornell | AWG préstamos estudiantiles: máximo 15 % del ingreso disponible | US federal | true |
| F38 | 34 CFR 34.19 | https://www.law.cornell.edu/cfr/text/34/34.19 | eCFR vía Cornell | El patrón retiene lo menor entre la orden y el exceso sobre 30× salario mínimo | US federal | true |
| F39 | 42 U.S.C. §653a | https://www.law.cornell.edu/uscode/text/42/653a | Congreso vía Cornell | *New hire reporting*: nombre, domicilio, SSN, fecha de inicio, nombre/domicilio/EIN del patrón; ≤ 20 días (o dos envíos al mes en electrónico) | US federal + estados | true |
| F40 | Publication 509, Tax Calendars 2026 | https://www.irs.gov/publications/p509 | IRS | 941 fin de mes siguiente; 940 31-ene; W-2 2-feb-2026; 1120 día 15 del 4.º mes; 1120-S y 1065 día 15 del 3.º; 1040/Sch. C día 15 del 4.º; estimados corporativos 4/6/9/12; individuales 4/6/9 y 1.º del siguiente | US federal | true |
| F41 | Business structures | https://www.irs.gov/businesses/small-businesses-self-employed/business-structures | IRS | Enumeración: *sole proprietorship*, *partnership*, *corporation*, S corporation, LLC | US federal | true |
| F42 | Limited liability company (LLC) | https://www.irs.gov/businesses/small-businesses-self-employed/limited-liability-company-llc | IRS | LLC unimembre = entidad ignorada; multimembre = *partnership*; Form 8832 para elegir corporación | US federal | true |
| F43 | About Form 1120-S | https://www.irs.gov/forms-pubs/about-form-1120-s | IRS | Declaración de S corporation; K-1 a accionistas | US federal | true |
| F44 | About Schedule C (Form 1040) | https://www.irs.gov/forms-pubs/about-schedule-c-form-1040 | IRS | Ingreso o pérdida de negocio como *sole proprietor* | US federal | true |
| F45 | About Form 2553 / Instructions | https://www.irs.gov/forms-pubs/about-form-2553 · https://www.irs.gov/instructions/i2553 | IRS | Elección S bajo §1362(a); plazo: 2 meses y 15 días desde el inicio del ejercicio, o cualquier día del ejercicio anterior | US federal | true |
| F46 | 26 U.S.C. §11 | https://www.law.cornell.edu/uscode/text/26/11 | Congreso vía Cornell | Tasa corporativa 21 % | US federal | true |
| F47 | Publication 542, Corporations | https://www.irs.gov/publications/p542 | IRS | 21 %; estimados si ≥ 500, 15 del 4.º/6.º/9.º/12.º mes; 1120 día 15 del 4.º mes (30-jun: 3.º); AET 20 %; EFTPS obligatorio | US federal | true |
| F48 | Self-employment tax | https://www.irs.gov/businesses/small-businesses-self-employed/self-employment-tax-social-security-and-medicare-taxes | IRS | 15.3 % (12.4 + 2.9); umbral 400; mitad deducible (la página aún cita el tope 2024, 168 600) | US federal | true |
| F49 | Qualified business income deduction | https://www.irs.gov/newsroom/qualified-business-income-deduction | IRS | 20 % del QBI para *pass-through*; no C corp (la página no recoge la permanencia OBBBA) | US federal | true |
| F50 | Publication 946 (2025) | https://www.irs.gov/publications/p946 | IRS | §179: 2 500 000 / 4 000 000 (2025), 2 560 000 / 4 090 000 (2026); SUV 31 300 / 32 000; *bonus* 100 % adquirido tras 19-ene-2025 (40 % antes); convenciones HY/MQ 40 %/MM; clases 3-20 años, 27.5 y 39 | US federal | true |
| F51 | 26 U.S.C. §168 | https://www.law.cornell.edu/uscode/text/26/168 | Congreso vía Cornell | Convenciones §168(d) (el extracto no alcanzó a (k)) | US federal | true |
| F52 | 26 U.S.C. §179 | https://www.law.cornell.edu/uscode/text/26/179 | Congreso vía Cornell | 2 500 000 / 4 000 000 tras 2024; indexación desde 2025 redondeada a 10 000; SUV 25 000 base | US federal | true |
| F53 | Tangible property regulations | https://www.irs.gov/businesses/small-businesses-self-employed/tangible-property-final-regulations | IRS | *De minimis safe harbor* 5 000 con AFS / 2 500 sin AFS (desde 2016) | US federal | true |
| F54 | South Dakota v. Wayfair, Inc., 585 U.S. (2018) | https://www.supremecourt.gov/opinions/17pdf/17-494_j4el.pdf | Corte Suprema | *Quill* revocada; umbral de Dakota del Sur 100 000 USD o 200 transacciones **[pdf]** | US estados | true |
| F55 | Remote Seller State Guidance | https://www.streamlinedsalestax.org/for-businesses/remote-seller-faqs/remote-seller-state-guidance | Streamlined Sales Tax GB | Umbrales por estado y estados que quitaron el conteo de 200 (AK, IN, NC, ND, SD, UT, WI, WY) | US estados | true |
| F56 | Economic Nexus State Guide (act. 1-ago-2026) | https://www.salestaxinstitute.com/resources/economic-nexus-state-guide | Sales Tax Institute (secundaria) | Umbral y fecha por estado; NOMAD sin impuesto estatal | US estados | true |
| F57 | State-by-state guide to marketplace facilitator laws (act. 31-ene-2025) | https://www.avalara.com/us/en/learn/guides/state-by-state-guide-to-marketplace-facilitator-laws.html | Avalara (secundaria) | Casi todos los estados; Missouri 1-ene-2023 el más reciente; CA 500 000; NY 500 000 y 100 ventas; AL 250 000 | US estados | true |
| F58 | State individual income tax rates 2025 | https://taxfoundation.org/data/all/state/state-income-tax-rates/ | Tax Foundation (secundaria) | 8 estados sin impuesto; planos; NH derogó intereses/dividendos 2025; WA sólo ganancias de capital | US estados | true |
| F59 | State individual income tax rates 2026 | https://taxfoundation.org/data/all/state/state-income-tax-rates-2026/ | Tax Foundation (secundaria) | 2026: planos AZ 2.5, CO 4.4, IL 4.95, IN 2.95, LA 3.0, MI 4.25, MS 4.0, MO 2.0, NC 3.99, OH 2.75, PA 3.07, UT 4.5; cambios GA 5.19, KY 3.5, OK 4.5 | US estados | true |
| F60 | State Law Information | https://oui.doleta.gov/unemploy/statelaws.asp | DOL/ETA | Índice; enlaza *Significant Provisions* enero 2026 | US estados | true |
| F61 | Significant Provisions of State UI Laws, January 2026 | https://oui.doleta.gov/unemploy/content/sigpros/2020-2029/January2026.pdf | DOL/ETA | Base gravable SUTA y tasa de patrón nuevo por estado **[pdf]** | US estados | true |
| F62 | Rates and Withholding (2026) | https://edd.ca.gov/en/payroll_taxes/rates_and_withholding/ | CA EDD | UI 7 000 y 3.4 % nuevo patrón; ETT 0.1 %; SDI 1.3 % **sin tope** desde 2024 | US-CA | true |
| F63 | NY Paid Family Leave 2026 | https://paidfamilyleave.ny.gov/2026 | NY WCB | PFL 0.432 % con tope anual 411.91; NYSAWW 1 833.63 | US-NY | true |
| F64 | Unemployment Insurance Rate Information | https://dol.ny.gov/unemployment-insurance-rate-information | NY DOL | Patrón nuevo 3.4 % (2026); la base gravable no aparece en la página | US-NY | true |
| F65 | Rate Information (2026) | https://www.nj.gov/labor/ea/employer-services/rate-info/ | NJ DOL | Base UI/WF 44 800; base TDI/FLI trabajador 171 100; UI 0.3825 %, DI 0.19 %, WF 0.0425 %, FLI 0.23 %; patrón nuevo UI 2.6825 % | US-NJ | true |
| F66 | Paid Leave updates 2026 | https://paidleave.wa.gov/updates/ | WA ESD | Prima 1.13 %; trabajador 71.43 %, patrón (50+) 28.57 %; tope 184 500 | US-WA | true |
| F67 | Paid Leave Oregon, employers | https://paidleave.oregon.gov/employers/ | OR OED | 1 % hasta 184 500; 60 % trabajador / 40 % patrón (25+) | US-OR | true |
| F68 | Franchise Tax | https://comptroller.texas.gov/taxes/franchise/ | TX Comptroller | Umbral sin impuesto 2 650 000 (2026-2027); 0.75 % / 0.375 %; vence 15-may | US-TX | true |
| F69 | Wage Tax (employers) | https://www.phila.gov/services/payments-assistance-taxes/taxes/business-taxes/business-taxes-by-type/wage-tax-employers/ | Ciudad de Filadelfia | 3.735 % residente / 3.425 % no residente desde 1-jul-2026; periodicidad por monto retenido | US-PA-PHI | true |
| F70 | Local Income Tax Information (Act 32) | https://dced.pa.gov/local-government/local-income-tax-information/ | PA DCED | EIT y LST por sitio de trabajo; códigos PSD; registro oficial de tasas | US-PA | true |
| F71 | NYS-50-T-NYC (1/26) | https://www.tax.ny.gov/pdf/publications/withholding/nys50_t_nyc.pdf | NY DTF | Tablas de retención NYC vigentes 1-ene a 31-dic-2026 **[pdf]** | US-NY-NYC | true |
| F72 | Contribution and benefit base | https://www.ssa.gov/oact/cola/cbb.html | SSA | Tope SS por año | US federal | **false** (HTTP 403) |
| F73 | EFW2 (Pub 42-007) 2026 | https://www.ssa.gov/employer/efw2/efw2.htm · https://www.ssa.gov/employer/efw2/26efw2.pdf | SSA | Especificación de registros RA/RE/RW/RO/RS/RT/RU/RV/RF | US federal | **false** (HTTP 403 ambas) |
| F74 | New hire reporting | https://acf.gov/css/employers/new-hire-reporting | HHS/ACF-OCSS | Guía patronal; plazos estatales | US federal + estados | **false** (HTTP 403; se usa F39) |
| F75 | NACHA Operating Rules · rules changes | https://www.nacha.org/rules · https://www.nacha.org/content/ach-network-rules-changes | Nacha | Reglas ACH, Same Day ACH, cambios 2026 | US | **false** (HTTP 403 ambas) |
| F76 | PFML contribution rates | https://www.mass.gov/info-details/paid-family-and-medical-leave-pfml-contribution-rates | MA DFML | Tasa 2026 | US-MA | **false** (HTTP 403) |
| F77 | FAMLI employers | https://famli.colorado.gov/employers | CO FAMLI | Prima 2026 | US-CO | **false** (HTTP 403) |
| F78 | Premium rate and contributions | https://pl.mn.gov/resources/calculators/premium-rate-and-contributions | MN DEED | 0.88 % desde 1-ene-2026; ≤ 0.44 % al trabajador; pequeños 0.66 % (cifras del extracto de búsqueda, no de la página) | US-MN | **false** (HTTP 403) |
| F79 | Corporations | https://www.ftb.ca.gov/file/business/types/corporations/index.html | CA FTB | Impuesto mínimo de franquicia 800; 8.84 % / 1.5 % S | US-CA | **false** (HTTP 403) |
| F80 | 34 CFR Part 34 (eCFR) | https://www.ecfr.gov/current/title-34/subtitle-A/part-34 | eCFR | AWG | US federal | **false** (redirige a bloqueo; se usa F38) |

## 2. Nómina federal

### 2.1 Retención federal (FIT): W-4 2020+ y Pub 15-T

**Norma [F2, F3, F4, F17].** El W-4 vigente (2026) no tiene *allowances*: paso 1(c) estatus (*single/MFS*, MFJ, HoH); paso 2(c) caja de empleos múltiples; paso 3 créditos anuales (hijos < 17 × el importe impreso en 3(a), otros dependientes × 500, sólo si el ingreso ≤ 200 000 / 400 000 MFJ); paso 4(a) otro ingreso anual; 4(b) deducciones anuales; 4(c) retención extra **por periodo**; y una declaración de exención que hay que renovar cada año («I understand I will need to submit a new Form W-4 for 2027»). El método porcentual para nómina automatizada (Worksheet 1A) es:

1. Anualizar: salario del periodo × periodos al año (52/26/24/12).
2. Sumar 4(a); restar 4(b); **restar además la línea 1g: 0 si la caja del paso 2 está marcada, 12 900 si MFJ y 8 600 en cualquier otro caso** [F4, `p15t.txt` 621-622]. El resultado es el *Adjusted Annual Wage Amount*.
3. Buscar en la tabla anual STANDARD (caja no marcada, o W-4 de 2019 o anterior) o en la tabla **Step 2 Checkbox** (caja marcada), según estatus. Con W-4 de 2019 o anterior **no se usa la tabla HoH** [F4, 634] y se restan *allowances* × 4 300 [F3, F4 627-628].
4. Impuesto tentativo anual ÷ periodos; restar paso 3 ÷ periodos (no negativo); sumar 4(c).

**Tablas anuales 2026 [F4, pdf].** Formato: desde – hasta → base + % sobre el exceso.

| Estatus | STANDARD (caja 2 no marcada) | Step 2 Checkbox |
|---|---|---|
| MFJ | 0–19 300: 0 · 19 300–44 100: 10 % · 44 100–120 100: 2 480 + 12 % · 120 100–230 700: 11 600 + 22 % · 230 700–422 850: 35 932 + 24 % · 422 850–531 750: 82 048 + 32 % · 531 750–788 000: 116 896 + 35 % · > 788 000: 206 583.50 + 37 % | 0–16 100: 0 · 16 100–28 500: 10 % · 28 500–66 500: 1 240 + 12 % · 66 500–121 800: 5 800 + 22 % · 121 800–217 875: 17 966 + 24 % · 217 875–272 325: 41 024 + 32 % · 272 325–400 450: 58 448 + 35 % · > 400 450: 103 291.75 + 37 % |
| Single / MFS | 0–7 500: 0 · 7 500–19 900: 10 % · 19 900–57 900: 1 240 + 12 % · 57 900–113 200: 5 800 + 22 % · 113 200–209 275: 17 966 + 24 % · 209 275–263 725: 41 024 + 32 % · 263 725–648 100: 58 448 + 35 % · > 648 100: 192 979.25 + 37 % | 0–8 050: 0 · 8 050–14 250: 10 % · 14 250–33 250: 620 + 12 % · 33 250–60 900: 2 900 + 22 % · 60 900–108 938: 8 983 + 24 % · 108 938–136 163: 20 512 + 32 % · 136 163–328 350: 29 224 + 35 % · > 328 350: 96 489.63 + 37 % |
| HoH | 0–15 550: 0 · 15 550–33 250: 10 % · 33 250–83 000: 1 770 + 12 % · 83 000–121 250: 7 740 + 22 % · 121 250–217 300: 16 155 + 24 % · 217 300–271 750: 39 207 + 32 % · 271 750–656 150: 56 631 + 35 % · > 656 150: 191 171 + 37 % | 0–12 075: 0 · 12 075–20 925: 10 % · 20 925–45 800: 885 + 12 % · 45 800–64 925: 3 870 + 22 % · 64 925–112 950: 8 077.50 + 24 % · 112 950–140 175: 19 603.50 + 32 % · 140 175–332 375: 28 315.50 + 35 % · > 332 375: 95 585.50 + 37 % |

Comprobación de coherencia con Rev. Proc. 2025-32 [F26]: la banda 0 % STANDARD *single* (7 500) + la línea 1g (8 600) = 16 100 = deducción estándar 2026; el tramo del 10 % (19 900 − 7 500 = 12 400) es exactamente el primer tramo 2026. La tabla no es «estimación»: es derivable.

**Salarios suplementarios [F2].** Pagados por separado o identificados: 22 % plano; 37 % sobre el exceso cuando los suplementarios acumulados del año superan 1 000 000 USD. El acumulado que dispara el 37 % es el **de suplementarios**, no el salario total.

**El repo.** `UsFederalFitCalculator` (`src/services/payroll/usa/federal/fit-calculator.ts:9-67`) anualiza, suma 4(a) y resta 4(b) (`:41-45`) y aplica la tabla anual (`:48`), pero **no resta la línea 1g** (8 600/12 900), **ignora la caja del paso 2** («no adjustment», `:39`; `multiple_jobs_box` se declara en `tax-engine.interface.ts:23` y nadie lo lee), no tiene ruta para W-4 pre-2020 ni para «exempt» (`employees.is_exempt_fit`, `008_payroll.sql:48`, sin lector), y trae quemados 22 %/37 %/1 000 000 (`:22`) con el 37 % disparado por `ytd_wages` total, no por el acumulado suplementario. Las tablas sembradas (`009_tax_tables_2026.sql:114-144`) no son las de 2026: banda 0 % 6 300/16 300/13 850 frente a 7 500/19 300/15 550 [F4]; no hay `married_separately` ni tablas Checkbox. Las claves `standard_deduction_*` (`009:31-33`) están sembradas y sin lector. Consecuencia aritmética: un *single* con 60 000 anuales sale hoy con ~1 000 USD más de retención anual que la Pub 15-T (sin 8 600 y con tramos más bajos). El escéptico ya lo cuantificó (`../verificacion/nomina-us.md`, hallazgo sobre `009:115-116`).

### 2.2 FICA: Seguro Social, Medicare y Additional Medicare

**Norma [F1, F2, F5, F11].** SS 6.2 % trabajador + 6.2 % patrón sobre los primeros **184 500** USD de 2026 (2025: 176 100; 2024: 168 600). Medicare 1.45 % + 1.45 % sin tope. Additional Medicare 0.9 % sólo del trabajador; el patrón **debe** retenerlo desde el periodo en que el acumulado supera 200 000 **sin importar el estatus** (los 250 000 MFJ / 125 000 MFS son del 1040, no de la nómina). Base FICA = salarios brutos menos exclusiones §125 (salud, FSA, HSA vía cafetería); los diferimientos 401(k) **no** reducen FICA. La 941 calcula 5a × 0.124, 5c × 0.029, 5d × 0.009 [F11].

**El repo.** Motores completos (`fica-calculator.ts:11-128`); `cappedTaxableWages` y el YTD (`tax-engine/ytd-service.ts`) topan correctamente; el patrón usa 200 000 fijo (`:65`, correcto). **Los números son los equivocados**: `tax_parameters.ss_wage_base = 168 600` (`009:15`) y los *fallbacks* del motor repiten 168 600 (`fica-calculator.ts:18, :99`), el W-2 lleva otra tabla con 183 600 para 2026 (`w2-generator.ts:104`), y ninguna coincide con 184 500 [F1, F2, F11]. La prueba `tests/payroll/usa/fica.spec.ts:10` mockea 168 600, así que nada lo acusa. El *fallback* numérico convierte «no hay fila del año» en «tope de 2024 en silencio»: la regla de la casa (fallo cerrado, `docs/jurisdicciones.md` §3.4) pide lanzar. La base FICA en `paycheck-service.ts:123-126` excluye correctamente 401(k)/Roth de la reducción.

### 2.3 FUTA y la reducción de crédito

**Norma [F6, F7, F9, F10].** 6.0 % sobre los primeros 7 000 USD por trabajador; crédito hasta 5.4 % por contribuciones estatales pagadas a tiempo → 0.6 % neto. Presenta 940 quien pagó ≥ 1 500 en cualquier trimestre de este año o el anterior, o tuvo un empleado al menos parte de un día en 20 semanas distintas. Depósito trimestral (EFTPS) cuando el acumulado supera 500 USD; si no, arrastra. 940 vence el 31 de enero (2-feb-2026 para 2025 por fin de semana), 10 de febrero si depositó todo a tiempo. **Reducción de crédito** (IRC §3302(c)(2)): los estados con préstamo federal impago dos años seguidos pierden 0.3 % de crédito el primer año y 0.3 % más cada año; DOL lo anuncia tras el 10 de noviembre y va en Schedule A. **Para 2025: California 1.2 %, Islas Vírgenes 4.5 %** [F9, pdf, «Credit reduction states for 2025»]. El FUTA de un patrón con nómina en CA en 2025 fue 0.6 % + 1.2 % = 1.8 % sobre 7 000.

**El repo.** `UsFutaCalculator` (`futa-calculator.ts:12-35`) aplica siempre el neto 0.6 % (`:20-21`) y **no conoce la reducción de crédito**; `futa_rate_gross` (`009:24`) sembrado sin lector; la 940 no genera Schedule A ni línea 11 (`form-940-generator.ts:77-95`: `line_4_exempt_payments: 0` fijo en `:81`; sin *credit reduction*). Además la 940 y la 941 suman `employer_tax_liabilities` para la línea de depósitos (`form-940-generator.ts:51-53`; `form-941-generator.ts:63-66`), tabla que **nadie escribe** (`grep -rn "INSERT INTO employer_tax_liabilities" src/` vacío), así que las líneas 13/14 declaran cero depositado.

### 2.4 Depósitos, periodicidad y calendario federal de nómina

**Norma [F2, F11, F12, F13, F14, F15, F18].**

| Regla | Valor | Fuente |
|---|---|---|
| *Lookback period* (941) | 1-jul del segundo año anterior a 30-jun del anterior; (944): el segundo año anterior completo | F11, F13 |
| Mensual vs. semisemanal | ≤ 50 000 en el *lookback* → mensual (día 15 del mes siguiente); > 50 000 → semisemanal: pagos mié-jue-vie se depositan el miércoles siguiente; sáb-dom-lun-mar el viernes siguiente | F11, F12, F13 |
| Regla de 100 000 | Acumular ≥ 100 000 en un día del periodo → depositar al **día hábil siguiente** y pasar a semisemanal para el resto del año y el siguiente | F2, F11, F13 |
| *De minimis* trimestral | Pasivo del trimestre (o del anterior) < 2 500 → pagar con la 941 | F11, F13 |
| *Safe harbor* de depósito | Faltante ≤ max(100, 2 %) se subsana sin multa en la fecha de reposición | F13 |
| 941 | Último día del mes siguiente al trimestre: 30-abr, 31-jul, 31-oct, 31-ene; +10 días si depositó todo a tiempo; Schedule B si semisemanal | F11, F12 |
| 944 | Sustituye a la 941 si el pasivo anual ≤ 1 000 (el IRS lo asigna por escrito); vence 31-ene | F2, F14 |
| 940 | 31-ene (10-feb si depositó); depósito trimestral si > 500 | F6, F10 |
| W-2/W-3 a la SSA y W-2 al empleado | 31-ene; para TY2026: **1-feb-2027** | F15, F12 |
| 1099-NEC | 31-ene al IRS y al beneficiario; 1099-MISC 28-feb papel / 31-mar e-file; 1096 sólo en papel | F18, F19, F12 |
| e-file obligatorio | Desde **10** informativas agregadas (W-2 + 1099 + …) en el año, desde 2024 (T.D. 9972) | F15, F21 |
| Día inhábil | Vencimiento en sábado, domingo o festivo legal pasa al siguiente día hábil | F2 (regla general de la Pub 15) |
| 943 / 945 | Agrícola / no nómina (retención de respaldo y pensiones), 31-ene | F12 |

**El repo.** `employer_tax_liabilities` (`008_payroll.sql:329-352`) ya tiene `deposit_frequency` (`monthly, semi_weekly, next_day, quarterly, annual`, `:341`) y `due_date`, `deposited_at`, `status` — el **esquema** del calendario existe; falta el **escritor** que, al aprobar una corrida, calcule el pasivo por tipo/jurisdicción, el *lookback* y la fecha de vencimiento, y la **puerta** para registrar el depósito (EFTPS es acto humano; el sistema guarda `deposit_reference`). No existe motor de *lookback* ni la regla de 100 000 (`grep -rn "lookback\|100000\|100_000" src/services/payroll/` vacío). `tax_form_filings.form_type` (`008:486`) enumera `1099_nec` en el comentario y nadie lo escribe. No hay calendario de obligaciones en ningún módulo (`motores-inventario.md` §2: «Calendario de obligaciones — ausente»); el catálogo de comandos lo asigna a `obligation list --jurisdiction irs|ssa|suta-<estado>` (`docs/cli-command-catalog.md:1616`) sin implementación.

### 2.5 W-2 / W-3 / EFW2 y lo nuevo de 2026

**Norma [F15, F29, F30, F31].** Casillas: 1 salarios FIT (sin 401(k), con §125 excluido), 2 FIT retenido, 3 salarios SS (topado a 184 500), 4 SS retenido, 5 Medicare (sin tope), 6 Medicare + Additional retenido, 12 códigos (D 401(k), AA Roth 401(k), W aportaciones HSA del patrón **y** del trabajador vía cafetería, DD costo del seguro de salud patronal), 14 informativa (SDI, etc.), 15-20 estado y localidad. **Nuevo en TY2026**: código **TP** (propinas en efectivo reportadas), **TT** (compensación por horas extra calificada: sólo la «mitad» del *time-and-a-half* [F31]), **TA** (aportaciones patronales a *Trump accounts*), y **caja 14b** con el código de ocupación de propinas del Tesoro. En 2025 hubo alivio (Notice 2025-62); desde 2026 el reporte separado es **obligatorio**, lo que exige que el motor de nómina acumule por separado propinas en efectivo y la prima de horas extra FLSA desde el primer periodo de 2026. Vencimiento 1-feb-2027; e-file desde 10 formas. EFW2 (Pub 42-007) es la especificación de la SSA para el archivo; **no se pudo abrir (403)**.

**El repo.** `generateW2` (`w2-generator.ts:39-157`) llena 1-6, 12 (D, W, DD; `:108-111`), 14 (SDI) y 15-20; W-3 y EFW2 en `w3-generator.ts:31-179`. Faltan **TP/TT/TA y 14b**. `paycheck_earnings.earning_type` es texto libre cuyo comentario enumera `overtime`, `tips`, `bonus`, `commission` (`008:275`), pero nadie lo lee para la W-2: la W-3 fija las cajas 7 y 8 (propinas SS y asignadas) en `0` (`w3-generator.ts:87-88`) y la W-2 no tiene caja 7 ni código TP/TT; el único marcador que el motor consume es `is_supplemental` (`paycheck-service.ts:26`). No existe la «prima de horas extra» (0.5×) como concepto separado del pago de horas extra completo. El tope SS de la caja 3 está quemado en `ssCapByYear` (`w2-generator.ts:104`) con 183 600, no 184 500. El escéptico documentó que el registro RW del EFW2 está desalineado (importe en la posición 144 en vez de 188; `../verificacion/nomina-us.md`, reclamo 13), y sólo genera RA/RE/RW/RT/RF, sin RS (estatal) ni RO/RU/RV.

### 2.6 Beneficios pre-impuesto: §125, 401(k), HSA, FSA, DCAP

**Norma [F25, F26, F27, F28].**

| Concepto | Límite 2026 | Efecto en bases |
|---|---|---|
| 401(k)/403(b)/457 diferimiento §402(g) | 24 500; *catch-up* 50+ 8 000; 60-63 11 250 | Reduce FIT y SIT (salvo estados que no lo reconocen: PA); **no** reduce FICA/FUTA |
| Health FSA §125(i) | 3 400 | Reduce FIT, FICA, FUTA |
| DCAP §129 | **7 500** (3 750 MFS) — subió de 5 000 por OBBBA | Reduce FIT, FICA, FUTA |
| HSA §223 (vía cafetería) | 4 400 individual / 8 750 familiar; HDHP deducible ≥ 1 700 / 3 400; gasto máximo 8 500 / 17 000 | Reduce FIT, FICA, FUTA; W-2 código W |
| Transporte y estacionamiento §132(f) | 340/mes cada uno | Excluido |
| GTL §79 | Costo de cobertura > 50 000 es salario imputado (tabla I) | Grava FIT y FICA (no se retiene FIT, sí FICA) |
| Adopción §137 | 17 670 | Excluido de FIT, no de FICA |

**El repo.** `benefits-service.ts` modela planes y elecciones y aplica tope anual y *match* (`:79-153`), pero `calculateBenefitsForPaycheck` **no tiene llamador** y `validateContribution` (`:177-185`) lleva quemados 23 500 / 4 300 / 3 200 / 5 000 — tres de cuatro son de 2025 y el DCAP ignora los 7 500 de 2026. Los límites sembrados en `009:26-30` (23 500, 7 500, 4 400, 8 750, 3 300) tampoco tienen lector y discrepan entre sí y con [F25, F26]. No hay *catch-up* por edad (la columna `catchup_limit_annual` existe en `008:397` sin escritor) ni imputación de GTL. La base gravable del recibo (`paycheck-service.ts:112-128`) trata **toda** deducción pre-impuesto como excluida de FIT y, salvo 401(k)/Roth, de FICA — correcto para §125 y HSA; falta la excepción estatal (PA grava 401(k)) que es parámetro por estado.

### 2.7 Embargos: CCPA Título III, embargo fiscal y AWG

**Norma [F32, F33, F34, F36, F37, F38].** Ingreso disponible = bruto − deducciones **legalmente obligatorias** (FIT, FICA, SIT, SDI, contribuciones de pensión obligatorias); no restan las voluntarias (401(k), seguro). Tope ordinario semanal: lo menor entre 25 % del disponible y el exceso sobre 30 × 7.25 = **217.50**; por debajo de 217.50 no se embarga nada. Pensión alimenticia: 50 % (mantiene otra familia) / 60 % (no); +5 % con atrasos > 12 semanas (55/65). Excepciones: órdenes de quiebra (cap. 13) e impuestos federales/estatales (el embargo del IRS no está sujeto al 25 %: se retiene todo lo que exceda el **importe exento de la Pub 1494**). Préstamos estudiantiles federales (AWG): máximo **15 %** del disponible [F37] y nunca por debajo de 30× salario mínimo [F38]. La CCPA prohíbe despedir por un solo embargo. Muchos estados fijan topes menores (parámetro por estado, fuera de este censo).

**Pub 1494 (2026) [F36, pdf].** Exento semanal: *single*/MFS 309.62 sin dependientes (= 16 100 ÷ 52) + 101.92 por dependiente (= 5 300 ÷ 52); MFJ 619.23 (= 32 200 ÷ 52) + 101.92; HoH 464.42 + 101.92. Adicional por 65+ o ceguera: 39.42/semana (*single*/HoH), 31.73 (otros). Biweekly, semimonthly y monthly son múltiplos.

**El repo.** `garnishment-engine.ts` implementa 25 %/30×FMW (`:94-95`), 50-65 % (`:47-50`), AWG 15 % (`:134-137`) y exento del *levy* leído de `metadata` (`:122-125`), con 7.25 quemado (`:36`). Tres defectos que la verificación hermana confirmó: el motor lee `amount_type = 'percentage'` (`:71`) y el esquema documenta `percent_disposable/percent_gross` (`008:429`) → una orden porcentual retiene 0; la prelación real es `ORDER BY priority` (`:78`) y no la de la cabecera; no hay CRUD ni puerta para `garnishments`. Todos los topes son parámetro con vigencia (7.25 no ha cambiado desde 2009, pero el motor no debe saberlo) y la Pub 1494 es una **tabla anual** que hoy se captura a mano en `metadata.exempt_amount`.

### 2.8 FLSA: salario mínimo, horas extra y la prima que ahora se reporta

**Norma [F34, F35, F31].** 7.25 USD/h federal; el estado o ciudad más alto manda. Horas extra: 1.5 × la **tasa regular** (que incluye bonos no discrecionales y comisiones) por horas > 40 en la semana laboral; sin recargo por fin de semana o festivo como tal. Desde 2026 la **mitad** (0.5 × tasa regular × horas extra) es «compensación por horas extra calificada» y se reporta en W-2 código TT [F31].

**El repo.** No hay motor FLSA: `paycheck_earnings` recibe importes ya calculados (`paycheck-service.ts:365-372`) y `overtime` es sólo un valor sugerido de `earning_type` (`008:275`); no existe tasa regular, semana laboral ni cálculo de horas extra en `src/services/payroll/` (`grep -rn -i "overtime\|regular_rate"` devuelve cero en el código del motor; la palabra sólo aparece en ese comentario del esquema). Sin la prima 0.5× como concepto separado no se puede llenar TT.

### 2.9 *New hire reporting*

**Norma [F39].** Cada nuevo empleado se reporta al directorio estatal con nombre, domicilio, SSN, fecha de inicio y nombre/domicilio/EIN del patrón, a más tardar 20 días tras la contratación (o dos envíos mensuales separados 12-16 días si es electrónico); los estados pueden exigir menos días y más campos (parámetro por estado). **El repo**: nada (`grep -rn "new_hire\|newhire" src/` vacío). `employees.hire_date` (`008:18`) es el dato; falta la obligación en el calendario.

### 2.10 NACHA y depósito directo

**Norma.** Las Reglas Operativas de Nacha no se pudieron abrir (403, [F75]); lo que sigue es del oficio y **[sin verificar en esta sesión]**: archivo de 94 caracteres, registros 1/5/6/8/9, códigos de transacción 22/32 (crédito a cheques/ahorro), 27/37 débitos, clase PPD para nómina, prenotificación opcional, *Same Day ACH* con tope por pago de 1 000 000 USD. **El repo**: `nacha-generator.ts` produce el archivo PPD (`:45-205`) con constantes de formato correctas por definición (`'094'` en `:87`, `'PPD'` `:101`) y **parámetros de la entidad quemados**: `'BANK'` como nombre del destino (`:90`), código de servicio `'200'` (`:97`), descripción `'PAYROLL'` (`:102`). Estos tres son datos de la cuenta bancaria de la entidad, no de la casa. `direct_deposit_batches` sólo se inserta en `draft` y nunca cambia de estatus (verificación hermana).

## 3. Nómina estatal y local

### 3.1 Retención estatal (SIT): el mapa

**Norma [F58, F59].** Nueve estados **no retienen impuesto sobre salarios**: AK, FL, NV, NH (derogó el impuesto a intereses y dividendos en 2025), SD, TN, TX, WA (sólo ganancias de capital, no nómina) y WY. Doce estados con **tasa plana** en 2026: AZ 2.5, CO 4.4, IL 4.95, IN 2.95, LA 3.0, MI 4.25, MS 4.0, MO 2.0, NC 3.99, OH 2.75, PA 3.07, UT 4.5 (KY 3.5 y GA 5.19 también son planos en 2026; Tax Foundation los lista aparte por su transición). El resto y DC son progresivos (CA hasta 13.3, HI 11, NY 10.9). Reglas que el motor debe tener y hoy no tiene: (a) cada estado con impuesto define su **propio certificado** (DE 4 en CA, IT-2104 en NY, …) o acepta el W-4 federal — el `w4_data` no basta; (b) **reciprocidad** entre estados vecinos (residente de NJ que trabaja en PA paga a NJ) y regla de **residencia vs. sitio de trabajo** (PA e IN retienen por lugar de trabajo con crédito, NY por *convenience of the employer*); (c) exenciones y créditos por dependiente en tabla estatal; (d) tratamiento del 401(k) (PA no lo excluye). Todo esto es **tabla por estado con vigencia**, no código.

**El repo.** `UsStateSitCalculator` (`state-tax-calculator.ts:14-73`) cubre los tres patrones (cero, plano con exención, progresivo por `tax_tables`) y `NO_INCOME_TAX_STATES` (`:12`) coincide con [F58]. Pero la lista de nueve estados está **quemada** (debe ser fila por estado), sólo IL tiene `flat_rate` sembrado (`009:99-105`) y sólo CA y NY tienen tramos, ambos únicamente `single` (`009:200-224`; NY «abbreviated»). Los otros 46 estados registran un calculador (`register-all.ts:44-55`) que devuelve **cero en silencio** cuando no hay fila ni tramos (`state-tax-calculator.ts:56-58`). No hay reciprocidad ni certificado estatal (`residence_state` existe en `008:46` y sólo lo lee el motor local para residente/no residente, `local-tax-calculator.ts:33-34`).

### 3.2 SUTA: base gravable y tasa por estado

**Norma [F61, pdf; F62; F64; F65].** Impuesto **patronal** (salvo AK, NJ y PA, que también cobran al trabajador) sobre los primeros N USD por trabajador y año, a una **tasa de experiencia** asignada por el estado a cada patrón (parámetro por inquilino y año, no por jurisdicción); el patrón nuevo recibe una tasa fija 2-3 años. Bases gravables **2026** según el DOL [F61]:

| Estado | Base | Estado | Base | Estado | Base |
|---|---|---|---|---|---|
| AL 8 000 | AK 54 200 | AZ 8 000 | AR 7 000 | CA 7 000 | CO 30 600 |
| CT 27 000 | DE 14 500 | DC 9 000 | FL 7 000 | GA 9 500 | HI 64 500 |
| ID 58 300 | IL 14 250 | IN 9 500 | IA 20 400 | KS 15 100 | KY 12 000 |
| LA 7 000 | ME 12 000 | MD 8 500 | MA 15 000 | MI 9 000 (9 500 morosos) | MN 44 000 |
| MS 14 000 | MO 9 000 | MT 47 300 | NE 9 000 (24 000 grupo alto) | NV 43 700 | NH 14 000 |
| NJ 44 800 | NM 34 800 | **NY 17 600** | NC 34 200 | ND 46 600 | OH 9 000 |
| OK 25 000 | OR 56 700 | PA 10 000 | RI 30 800 (32 300 grupo alto) | SC 14 000 | SD 15 000 |
| TN 7 000 | TX 9 000 | UT 50 700 | VT 15 400 | VA 8 000 | WA 78 200 |
| WV 9 500 | WI 14 000 | WY 33 800 | PR 7 000 | VI 32 100 | |

Notas: NY pasó de 12 800 (2025) a 17 600 (2026) por la reforma que indexa la base al 18 % del salario promedio estatal (16 % desde 2027); patrón nuevo NY 3.4 % [F64]. CA: 7 000, patrón nuevo 3.4 %, más ETT 0.1 % sobre 7 000 [F62]. NJ: 44 800 para UI/WF/TDI del patrón, 171 100 para TDI/FLI del trabajador [F65]. Las bases se leyeron con `pdftotext` de un PDF con columnas; antes de sembrar, confírmese cada celda en la página del estado.

**El repo.** `UsStateSutaCalculator` (`state-tax-calculator.ts:80-107`) acepta `experience_rate` por inquilino (`tax-engine.interface.ts:42`) y lee `suta_wage_base`/`suta_default_rate` por estado, con *fallback* **7 000 / 2.7 %** (`:91-92`) para cualquier estado sin fila — es decir, hoy WA (78 200) o NJ (44 800) se topan en 7 000 en silencio. Filas sembradas: CA, NY (12 800, ya obsoleto: `009:88`), TX, FL, IL (`009:71-105`). El YTD por estado existe (`ytd-service.ts:147`, `getEmployeeSutaYtd`) y la prueba `suta-ytd.spec.ts` lo cubre. Falta la porción del **trabajador** en AK/NJ/PA y el ETT de CA (sembrado `ett_rate` `009:76` sin lector).

### 3.3 SDI/TDI y permisos pagados (PFML): qué estados y con qué aritmética

**Norma.** Dos familias distintas que el motor debe modelar por separado, cada una con su propia base, tope y reparto:

| Estado | Programa | 2026 | Fuente |
|---|---|---|---|
| CA | SDI (incluye PFL) | 1.3 % del trabajador, **sin tope salarial** desde 2024 | F62 |
| NY | DBL + PFL | DBL 0.5 % con máximo 0.60/semana (ley §209, no verificado aquí); PFL 0.432 % con tope anual 411.91 sobre NYSAWW 1 833.63 | F63 |
| NJ | TDI + FLI | Trabajador: DI 0.19 % y FLI 0.23 % sobre 171 100; patrón DI 0.5 % (nuevo) sobre 44 800 | F65 |
| RI, HI | TDI | Sólo trabajador (RI) / reparto (HI); cifras 2026 no verificadas en esta sesión | — |
| WA | PFML | 1.13 % total; 71.43 % trabajador / 28.57 % patrón (≥ 50 empleados); tope 184 500 (= SS) | F66 |
| OR | Paid Leave Oregon | 1 % hasta 184 500; 60 % trabajador / 40 % patrón (≥ 25) | F67 |
| MN | Paid Leave | 0.88 % desde 1-ene-2026; ≤ 0.44 % al trabajador; pequeños 0.66 % (página 403; cifra del extracto) | F78 |
| MA, CO, CT | PFML / FAMLI / CT Paid Leave | MA y CO devolvieron 403; CT (0.5 % trabajador hasta el tope SS) sin cifra en la portada | F76, F77 |
| DE, ME, MD | PFML nuevos (DE y ME cobran desde 2025; MD pospuesto) | No verificados | — |

Reglas comunes: la mayoría topa en el tope SS federal (184 500) — un parámetro federal que se **reutiliza** en tablas estatales; el reparto patrón/trabajador depende del tamaño del patrón (umbral 25 o 50 empleados = parámetro); CA no topa; NY topa en dinero anual, no en base.

**El repo.** `UsStateSdiCalculator` (`state-tax-calculator.ts:113-138`) aplica una sola tasa sin tope ni reparto; el comentario nombra CA, NY, NJ, RI, HI (`:110`). Sembrados: CA `sdi_rate 0.011` (obsoleto: 1.3 % en 2026 [F62]) y NY `sdi_rate_employee 0.005`, `sdi_weekly_max 0.60`, `pfl_rate 0.00455`, `pfl_annual_cap 399.43` (`009:73, :85-90`) — `sdi_weekly_max`, `pfl_*`, `sdi_wage_base` **no tienen lector**. No existe motor PFML (WA/OR/MN/MA/CO/CT) ni porción patronal. `paycheck-service.ts:215` invoca SDI sobre `taxableState`.

### 3.4 Impuestos locales sobre salarios

**Norma [F69, F70, F71].** Universo real: NYC (tablas NYS-50-T-NYC vigentes 1-ene a 31-dic-2026, residentes), Yonkers (residente y sobretasa a no residentes), Filadelfia (3.735 % residente / 3.425 % no residente desde 1-jul-2026 — cambia **a mitad de año**; periodicidad de entero por monto retenido: < 350/mes trimestral, 350-16 000 mensual, ≥ 16 000 semimensual o semanal), Pensilvania Act 32 (EIT de miles de municipios por **residencia y sitio de trabajo** con código PSD y registro oficial de tasas; LST), Ohio (municipios y JEDD), Indiana (condados), Maryland (condados, dentro de la retención estatal), Kentucky/Alabama (licencias ocupacionales), Michigan (ciudades), Missouri (KC y St. Louis 1 %), Oregon (impuesto de tránsito), Colorado (OPT). La regla general: **la localidad se determina por dirección del sitio de trabajo y del domicilio**, con vigencia por fecha, y el catálogo de localidades es tabla, no lista en código.

**El repo.** `UsLocalTaxCalculator` (`local-tax-calculator.ts:16-75`) es genérico (residente/no residente plano, o tramos) — buen diseño — pero `US_LOCALITIES` está quemada con cuatro entradas (`:78-83`), **ninguna localidad tiene fila** en `tax_parameters`/`tax_tables` (`grep "US-NY-NYC\|US-PA-PHI" src/database/` vacío), y el importe calculado **no se persiste** (`paycheck-service.ts:228-232`; no hay columna de local en `paychecks`), de modo que la caja 19 del W-2 es siempre 0 (`w2-generator.ts:93`) y un local > 0 descuadraría el asiento (verificación hermana). Vigencia a mitad de año (Filadelfia 1-jul) es imposible con `UNIQUE(jurisdiction, tax_year)` (`008:381`).

## 4. *Sales & use tax*: nexo económico y *marketplace facilitator*

**Norma [F54, F55, F56, F57].** Desde *Wayfair* (2018) un estado puede obligar a cobrar a un vendedor sin presencia física; el umbral que la Corte validó fue 100 000 USD de ventas **o** 200 transacciones anuales al estado [F54, pdf]. Hoy (STI, 1-ago-2026 [F56]): 45 estados + DC + PR con impuesto; **sin impuesto estatal**: AK (sólo local, umbral 100 000), DE, MT, NH, OR. Umbrales: 100 000 en la mayoría; **250 000** AL y MS; **500 000** CA y TX; NY 500 000 **y** 100 ventas; conservan la alternativa de 200 transacciones AR, CT (**y**), DC, GA, HI, MD, MI, MN, NE, NV, NJ, OH, PR, RI, VT, VA, WV; la quitaron AK, IN, NC, ND, SD, UT, WI, WY [F55] e IL desde 1-ene-2026 (búsqueda, secundaria). El periodo de medición (año natural anterior o corriente, o cuatro trimestres previos) y qué ventas cuentan (brutas, gravables, incluidas o no las de *marketplace*) **varían por estado**. *Marketplace facilitator*: casi todos los estados con impuesto obligan a la plataforma a cobrar y enterar por el vendedor (Missouri fue el último, 1-ene-2023 [F57]); el vendedor sigue reportando esas ventas (a menudo como exentas) y sigue siendo responsable de sus ventas directas. Tasas: estatal + local por **dirección de destino** (más de 13 000 jurisdicciones), con reglas de origen en unos pocos estados (p. ej. TX para intraestatal). *Use tax*: el comprador devenga el impuesto no cobrado por el vendedor sobre compras gravables.

**Qué es ley y qué es criterio.** Umbrales, tasas, periodos y estados con ley de *marketplace* son **ley** → tabla con vigencia. **Qué estados tiene la entidad registrados (nexo)** es decisión del despacho (registrarse voluntariamente, o no vender allí) → clave del panel `estados_con_nexo_sales_tax`, tal como propone `docs/jurisdicciones.md` §3.3; el motor sólo **avisa** cuando las ventas acumuladas por estado se acercan al umbral.

**El repo.** Sin motor: `grep -rn -i "sales.tax\|sales_tax\|nexus\|wayfair" src/` sólo encuentra un comentario del catálogo y el texto de una política (`chart-seed.ts:116`; `pending-catalog.ts:62, :85`); `motores-inventario.md` §4 lo censa como ausente; la puerta está prevista en `cli-command-catalog.md:1059` («la serie 1099 completa y el `use-tax` son de `fiscal-us.md`») y §5.14. Lo único que existe es la cuenta genérica 2135 «impuestos por pagar» del estrato neutro, que el comentario destina «al *sales tax* estadounidense y a cualquier otro impuesto trasladado» (`chart-seed.ts:116-123`): una sola cuenta sin desglose por estado ni por jurisdicción local, sin *use tax* devengado ni cuenta de impuesto cobrado por *marketplace*. `docs/jurisdicciones.md` §3.5 propone el `ESTRATO_FISCAL_US` con *Sales Tax Payable* propio. Las facturas no tienen dirección de destino fiscal ni código de jurisdicción; `invoices` no tiene columna de impuesto por línea con jurisdicción (fuera del alcance de esta lectura, pendiente para el informe de CxC).

## 5. Impuesto sobre la renta de la entidad y tipos de entidad

**Norma [F40, F41, F42, F43, F44, F45, F46, F47, F48, F49].**

| Tipo de entidad | Clasificación por defecto y elección | Forma | Cómo tributa | Vencimiento (año natural) |
|---|---|---|---|---|
| *Sole proprietorship* y **LLC unimembre** | Entidad ignorada (F42) | Schedule C con el 1040; Schedule SE | El dueño paga ISR y **SE tax 15.3 %** (12.4 % hasta 184 500 + 2.9 %, sobre el 92.35 % del neto); mitad deducible; QBI 20 % | 15-abr; estimados 15-abr/jun/sep/ene |
| *Partnership* y **LLC multimembre** | *Partnership* (F42); puede elegir corporación con 8832 | 1065 + K-1 por socio | *Pass-through*; los socios pagan ISR y SE sobre su parte; QBI 20 % | 15-mar (día 15 del 3.º mes) |
| **S corporation** (corp. o LLC con 2553) | Elección §1362 dentro de 2 meses y 15 días del inicio del ejercicio (F45) | 1120-S + K-1 | *Pass-through*; el accionista-empleado cobra **salario razonable por W-2** (sujeto a FICA) y el resto como distribución; QBI 20 % | 15-mar |
| **C corporation** | Por defecto para `corporation`; LLC con 8832 | 1120 | **21 %** (§11(b)); estimados si ≥ 500 el 15 del 4.º/6.º/9.º/12.º mes; EFTPS; AET 20 % sobre acumulaciones excesivas | 15-abr (día 15 del 4.º mes; 30-jun: 3.º); ejercicio no natural permitido (IRC §441) |

Estatal: cada estado tiene su impuesto corporativo o de franquicia con mínimos y umbrales propios — TX: umbral sin impuesto 2 650 000 (2026-2027), 0.75 % / 0.375 %, vence 15-may [F68]; CA: mínimo de franquicia 800 y 8.84 % / 1.5 % S [F79, **no verificado**, 403]. Son parámetros por estado y año.

**Consecuencias para un sistema contable.** (1) El tipo de entidad decide **qué formas y fechas** entran al calendario y si la entidad **provisiona ISR** (sólo C corp y estados con impuesto a *pass-through*; ASC 740) o no. (2) En S corp, la nómina del accionista es parte del cumplimiento. (3) Los K-1 exigen capital por socio (cuentas 3xxx por socio) que el catálogo neutro no tiene. (4) La conciliación libro-fiscal (Schedule M-1/M-3, línea de forma por cuenta) es la razón de ser de `us_gaap_code` y `--scheme us-tax-line`.

**El repo.** `legal_entities.entity_type` admite `corporation`, `llc`, `partnership` (`001_core_schema.sql:81-82`), pero **no distingue** LLC unimembre/multimembre ni la elección S o C — falta un campo de **clasificación fiscal federal** (`disregarded | partnership | s_corp | c_corp`) con fecha de elección. `COUNTRY_PROFILES.USA` siembra siempre `corporation` (`entity-service.ts:66-75`). `fiscal_year_start_month` (`001:88`) no tiene lector (§1.2 de `docs/jurisdicciones.md`). No hay provisión de ISR, ni 1120/1120-S/1065/Sch. C, ni estimados (`motores-inventario.md` §4: ausente). `account map set --scheme us-tax-line` ya escribe la línea de forma por cuenta (`account-service.ts:456`, según `docs/jurisdicciones.md` §3.5).

## 6. Depreciación fiscal: MACRS, §179, *bonus* y *de minimis*

**Norma [F50, F51, F52, F53].** Libro fiscal separado del contable (GAAP deprecia por vida útil y salvamento; MACRS ignora el salvamento). Clases: 3, 5 (equipo de cómputo, vehículos), 7 (mobiliario, maquinaria), 10, 15, 20 años; inmuebles 27.5 (residencial) y 39 (no residencial) por línea recta con **convención de medio mes**. Convenciones para bienes muebles: **medio año**, salvo que > 40 % de la base del año se ponga en servicio en el último trimestre → **medio trimestre** para todo el año. §179: gasto inmediato hasta **2 500 000** con reducción dólar a dólar sobre **4 000 000** puesto en servicio (ejercicios iniciados en 2025), indexado a **2 560 000 / 4 090 000** en 2026; SUV 31 300 (2025) / 32 000 (2026); limitado al ingreso del negocio. *Bonus* §168(k): **100 %** para bienes adquiridos y puestos en servicio después del 19-ene-2025 (OBBBA); 40 % (60 % para producción larga) si se adquirieron antes. *De minimis safe harbor*: gasto directo de partidas ≤ 2 500 por factura o artículo (5 000 con estados financieros auditados/AFS), elección anual — es exactamente la política `umbral_capitalizacion_mxn` en USD que `docs/jurisdicciones.md` §3.3 propone etiquetar por jurisdicción. La elección §179 vs. *bonus* vs. MACRS ordinario es **decisión del contribuyente** cada año → panel; los porcentajes y topes son **ley** → tabla por año de puesta en servicio.

**El repo.** `MACRS_TABLES` (`depreciation-math.ts:263-273`) trae las seis tablas de medio año (correctas frente a la Pub 946 tabla A-1) y `serieMACRS` deprecia el costo entero (`:284-287`, correcto), pero **sólo medio año** (`:290-291`), sin medio trimestre ni medio mes, sin 27.5/39 años, sin §179 ni *bonus* (`grep -rn -i "179\|bonus" src/services/assets/` vacío), sin libro fiscal separado (`motores-inventario.md` §7: «un solo libro»), y `macrs_class` (`003_banking_assets_inventory.sql:166`) nunca se escribe. Las tablas están en código, no en `parametros_legales`. El panel tiene `base_depreciacion` y `convencion_primer_mes` con etiquetas LISR (`pending-catalog.ts:104, :132`) y no ofrece `half_year`/`mid_quarter`.

## 7. Calendario consolidado de obligaciones (entidad con nómina, año natural)

| Cuándo | Qué | Norma |
|---|---|---|
| Cada pago | Depósito FIT+FICA según *lookback* (mensual día 15 / semisemanal mié-vie); 100 000 → día siguiente; SUTA/SIT según periodicidad estatal (p. ej. Filadelfia por monto) | F11, F13, F69 |
| ≤ 20 días de la contratación | *New hire report* estatal | F39 |
| 31-ene | 941 Q4; 940 (10-feb si depositó); W-2 a empleados y SSA (1-feb-2027 para 2026); 1099-NEC al IRS y al beneficiario; 944/943/945 | F12, F15, F18 |
| 28-feb / 31-mar | 1099-MISC y demás informativas en papel / e-file; 1096 sólo papel | F18, F19 |
| 15-mar | 1120-S y 1065 con K-1; plazo 2553 para el año en curso (2 meses y 15 días) | F40, F45 |
| 15-abr | 1120 (C corp año natural); 1040 + Sch. C + SE; 1.er estimado corporativo e individual | F40, F47 |
| 30-abr, 31-jul, 31-oct | 941 Q1-Q3 (+10 días si depositó); depósito FUTA si acumulado > 500 | F11, F6 |
| 15-jun, 15-sep, 15-dic | Estimados corporativos 2.º-4.º (individuales 15-jun, 15-sep, 15-ene) | F47, F40 |
| 15-may | Franquicia TX | F68 |
| Tras 10-nov | DOL publica estados con reducción de crédito FUTA del año | F7 |
| Por estado | Declaración trimestral SUTA (calendario estatal); *sales tax* mensual/trimestral/anual según volumen asignado por el estado | F61, F56 |

Los vencimientos que caen en sábado, domingo o festivo legal pasan al siguiente día hábil [F2]; el calendario necesita una tabla de festivos federales (parámetro por año).

## 8. Parámetros por jurisdicción y año (lo que debe ser tabla)

Clave propuesta con el vocabulario de `parametros_legales` (`docs/jurisdicciones.md` §3.4); «hoy» dice dónde vive el valor en el repo.

| Jurisdicción | Clave | Valor 2026 | Cambia | Fuente | Hoy |
|---|---|---|---|---|---|
| US | `ss.wage_base` | 184 500 | 1-ene, SSA | F1, F2, F11 | `009:15` = 168 600; `fica-calculator.ts:18,:99`; `w2-generator.ts:104` = 183 600 |
| US | `ss.rate` / `medicare.rate` / `medicare.additional_rate` / `medicare.additional_threshold_employer` | 0.062 / 0.0145 / 0.009 / 200 000 | Ley (estables) | F1, F5 | `009:16-21` + *fallbacks* |
| US | `fit.tablas_anuales` (6 tablas × 8 tramos) | §2.1 | 1-ene, Pub 15-T | F4 | `009:114-144` (3 tablas, cifras no oficiales) |
| US | `fit.linea_1g` | 12 900 MFJ / 8 600 otros | Pub 15-T | F4 | ausente |
| US | `fit.allowance_pre2020` | 4 300 | Pub 15-T | F3, F4 | ausente |
| US | `fit.suplementario` | 0.22 / 0.37 sobre 1 000 000 acumulado suplementario | Ley | F2 | quemado `fit-calculator.ts:22` |
| US | `futa.rate` / `futa.wage_base` / `futa.credit_max` / `futa.deposit_threshold` | 0.06 / 7 000 / 0.054 / 500 | Ley | F6 | `009:23-25`, quemado `futa-calculator.ts:19-21` |
| US | `futa.credit_reduction[estado]` | 2025: CA 0.012, VI 0.045 | Anual, tras 10-nov | F9 | ausente |
| US | `deposito.lookback_umbral` / `deposito.regla_un_dia` / `deposito.de_minimis` / `deposito.safe_harbor` | 50 000 / 100 000 / 2 500 / max(100, 2 %) | Ley | F13 | ausente |
| US | `form944.umbral` | 1 000 | Ley | F14 | ausente |
| US | `informativas.efile_umbral` | 10 | T.D. 9972 | F21 | ausente |
| US | `1099.umbral_nec_misc` / `1099.umbral_regalias` / `1099.umbral_abogados` | 2 000 / 10 / 600 | Ley (OBBBA; indexado desde 2027) | F18 | ausente (`vendors.is_1099_vendor` `002:17` es la única marca) |
| US | `1099k.umbral` | 20 000 y 200 | Ley (OBBBA) | F20 | ausente |
| US | `backup_withholding.rate` | 0.24 | Ley | F22 | ausente |
| US | `retiro.402g` / `retiro.catchup_50` / `retiro.catchup_60_63` | 24 500 / 8 000 / 11 250 | Notice anual | F25 | `009:26-27` (23 500/7 500) y `benefits-service.ts:179` |
| US | `hsa.self` / `hsa.family` / `hdhp.*` | 4 400 / 8 750 / 1 700-3 400 / 8 500-17 000 | Rev. Proc. anual | F27 | `009:28-29` ok sin lector; `benefits-service.ts:179` = 4 300 |
| US | `fsa.health` / `dcap` / `transporte.mensual` / `gtl.exclusion` / `adopcion` | 3 400 / 7 500 / 340 / 50 000 / 17 670 | Rev. Proc. anual | F26, F28 | `009:30` = 3 300; `benefits-service.ts:179` = 3 200 / 5 000 |
| US | `deduccion_estandar.*` | 16 100 / 32 200 / 24 150 | Rev. Proc. anual | F26 | `009:31-33` (2025) sin lector |
| US | `flsa.min_wage` / `ccpa.ordinario_pct` / `ccpa.multiplo_fmw` / `ccpa.manutencion` / `awg.pct` | 7.25 / 0.25 / 30 / 0.50-0.55-0.60-0.65 / 0.15 | Ley | F32-F38 | quemados `garnishment-engine.ts:36,47-50,94-95,136` |
| US | `levy.exento_tabla` (Pub 1494) | §2.7 | Anual | F36 | manual en `metadata.exempt_amount` |
| US | `new_hire.dias` | 20 (o menos por estado) | Ley | F39 | ausente |
| US | `corp.tasa` / `corp.estimado_umbral` / `aet.tasa` | 0.21 / 500 / 0.20 | Ley | F46, F47 | ausente |
| US | `se_tax.rate` / `se_tax.factor` / `qbi.pct` | 0.153 / 0.9235 / 0.20 | Ley | F48, F49 | ausente |
| US | `sec179.limite` / `sec179.umbral_reduccion` / `sec179.suv` | 2 560 000 / 4 090 000 / 32 000 (2025: 2 500 000 / 4 000 000 / 31 300) | Anual, por año de puesta en servicio | F50, F52 | ausente |
| US | `bonus.pct` | 1.00 adquirido > 19-ene-2025; 0.40 antes | Por fecha de adquisición | F50 | ausente |
| US | `macrs.tablas` (HY, MQ×4, MM, 27.5, 39) | Pub 946 apéndice A | Estable | F50 | sólo HY en `depreciation-math.ts:263-273` |
| US | `de_minimis.sin_afs` / `de_minimis.con_afs` | 2 500 / 5 000 | Reg. §1.263(a)-1(f) | F53 | panel `umbral_capitalizacion_mxn` (MXN, sin variante US) |
| US-<ST> | `sit.tipo` (`ninguno|plano|progresivo`), `sit.tasa`, `sit.tramos[estatus]`, `sit.exencion`, `sit.reciprocidad[]`, `sit.excluye_401k` | §3.1 | 1-ene y a mitad de año | F58, F59 + agencia estatal | 9 estados quemados `state-tax-calculator.ts:12`; IL/CA/NY parciales |
| US-<ST> | `suta.wage_base`, `suta.nuevo_patron`, `suta.trabajador_pct` (AK/NJ/PA) | §3.2 | 1-ene | F61, F62, F64, F65 | 5 estados en `009`; *fallback* 7 000/0.027 |
| inquilino×US-<ST> | `suta.tasa_experiencia` | asignada | Anual, aviso estatal | agencia estatal | `experience_rate` en la entrada, sin persistencia |
| US-<ST> | `sdi.tasa`, `sdi.base`, `sdi.tope_anual`, `pfml.tasa`, `pfml.reparto[tamaño]`, `pfml.base` | §3.3 | 1-ene | F62, F63, F65-F67 | CA 0.011 (obsoleto), NY parcial |
| US-<ST>-<LOC> | `local.tasa_residente`, `local.tasa_no_residente`, `local.tramos`, `local.periodicidad[monto]` | Filadelfia 0.03735 / 0.03425 desde 1-jul-2026; NYC tablas 1/26 | **A mitad de año** | F69, F71 | ninguna fila |
| US-<ST> | `sales_tax.umbral_usd`, `sales_tax.umbral_tx`, `sales_tax.periodo`, `sales_tax.marketplace_ley`, `sales_tax.tasa_estatal`, `sales_tax.tasas_locales[]` | §4 | Frecuente (locales trimestralmente) | F55, F56, F57 | ausente |
| US-<ST> | `franquicia.umbral`, `franquicia.tasa`, `franquicia.minimo` | TX 2 650 000 / 0.0075-0.00375; CA 800 (no verificado) | Bienal / anual | F68, F79 | ausente |
| US | `festivos_federales[año]` | 11 fechas | Anual | (OPM; no consultado) | ausente |

## 9. Reglas concretas para el motor

1. **Tope SS 2026 = 184 500** en un solo sitio con vigencia; borrar los tres valores (168 600, 168 600, 183 600) y el *fallback*: sin fila para la fecha de pago → error `PARAMETRO_LEGAL_SIN_VIGENCIA`, no 2024 [F1, F2, F11].
2. **FIT = Worksheet 1A completo**: restar 1g (12 900/8 600) salvo caja 2 marcada; tablas STANDARD y Checkbox × 3 estatus (6 tablas, §2.1); MFS usa la de *single*; W-4 pre-2020 con *allowances* × 4 300 y sin HoH; `is_exempt_fit` → 0; créditos del paso 3 ÷ periodos; 4(c) por periodo [F3, F4, F17].
3. **Suplementarios**: 22 % por separado; 37 % sobre el exceso cuando el acumulado **suplementario** del año supera 1 000 000 — exige un YTD de suplementarios, no el bruto [F2].
4. **Additional Medicare**: retener 0.9 % desde el periodo en que el acumulado del patrón supera 200 000, sin mirar el estatus [F5] (ya así en `fica-calculator.ts:65`).
5. **FUTA** = 6.0 % − crédito estatal (5.4 %) + reducción de crédito del estado de trabajo para ese año; Schedule A en la 940; depósito cuando el acumulado > 500; línea 4 de exentos (§125, GTL, …) no puede ser un 0 fijo [F6, F9, F10].
6. **Depósitos**: al aprobar una corrida, escribir `employer_tax_liabilities` por tipo (941, FUTA, SUTA-<ST>, SIT-<ST>, local) con `deposit_frequency` derivada del *lookback* (≤ 50 000 mensual, > 50 000 semisemanal), `due_date` (día 15 / mié-vie / día siguiente si ≥ 100 000 / con la 941 si < 2 500), y una puerta para registrar el depósito (referencia EFTPS) — el sistema **no** transmite [F11, F13]. Sin escritor, 941 línea 13 y 940 línea 13 seguirán en cero.
7. **941 líneas 5a-5d** con las tasas de tabla (0.124/0.029/0.009) y Schedule B cuando el depositante es semisemanal; 944 cuando el IRS lo asignó (parámetro por entidad) [F11, F14].
8. **Propinas y horas extra 2026**: nuevos `earning_type` «propina en efectivo» y «prima de horas extra FLSA» (sólo el 0.5×), acumulados por separado desde 1-ene-2026, con código de ocupación del trabajador; W-2 caja 12 TP/TT (y TA) y caja 14b; 1099-NEC/MISC con reporte separado [F15, F29, F30, F31].
9. **Bases**: FIT/SIT = bruto − §125 − 401(k)/403(b); FICA/FUTA = bruto − §125 (401(k) **no** reduce); SIT por estado puede no excluir el 401(k) (PA) → parámetro `sit.excluye_401k` [F28].
10. **Límites de beneficios 2026** por tabla: 402(g) 24 500 (+8 000 / +11 250 por edad), FSA 3 400, DCAP 7 500, HSA 4 400/8 750, transporte 340; `catchup_limit_annual` con lector por fecha de nacimiento; GTL > 50 000 imputado a FICA [F25-F28].
11. **Embargos**: ingreso disponible = bruto − deducciones obligatorias; ordinario = min(25 %, disponible − 30×FMW/semana convertido al periodo); manutención 50/55/60/65; embargo IRS = disponible − exento Pub 1494 (tabla anual por estatus, dependientes y periodicidad); AWG 15 %; prelación por tipo (manutención primero por regla federal, luego levy, luego resto) **antes** que por `priority`; `amount_type` alineado con el esquema (`percent_disposable`); topes estatales más bajos como parámetro [F32-F38].
12. **SIT**: fila por estado con `tipo` (`ninguno`/`plano`/`progresivo`), certificado estatal propio, reciprocidad (`residence_state` manda cuando hay acuerdo) y regla residencia/trabajo; un estado sin fila para la fecha → **error**, no cero [F58, F59].
13. **SUTA**: base y tasa de patrón nuevo por estado y año (tabla DOL §3.2), tasa de experiencia por inquilino y año, porción del trabajador en AK/NJ/PA, ETT de CA; sin *fallback* 7 000/2.7 % [F61, F62, F65].
14. **SDI/PFML**: motor con base, tope (por base o por importe anual, NY), reparto patrón/trabajador por tamaño del patrón y tope SS reutilizado (WA, OR, CT); CA sin tope [F62, F63, F65-F67].
15. **Locales**: catálogo de localidades en tabla con tasas residente/no residente o tramos, vigencia a mitad de año (Filadelfia 1-jul), periodicidad de entero por monto; persistir el importe en el recibo y proyectarlo a W-2 cajas 18-20 [F69-F71].
16. **Vigencia intra-anual**: `tax_parameters`/`tax_tables` deben buscarse por **fecha de pago**, no por `tax_year` (`tax-tables.ts:46`), y `UNIQUE(jurisdiction, tax_year)` (`008:381`) debe ceder a un rango de fechas; es la única forma de sembrar Filadelfia 1-jul o una reducción de crédito anunciada en noviembre. Las cachés (`tax-tables.ts:18-19`) deben invalidarse al sembrar.
17. **1099**: marcar proveedores por tipo de pago (NEC servicios, MISC rentas/premios/abogados, K por TPSO), W-9/TIN antes del primer pago, retención de respaldo 24 % si falta TIN, acumulado anual por proveedor contra el umbral del año (2 000 desde 2026; 10 regalías; 600 abogados), corporaciones exentas salvo abogados y médicos, 1099-NEC 31-ene, 1096 sólo en papel, e-file desde 10 formas [F18-F24].
18. **Entidad**: campo de clasificación fiscal federal (`disregarded | partnership | s_corp | c_corp`) con fecha de elección (8832/2553) que decide el calendario (Sch. C 15-abr; 1065/1120-S 15-mar; 1120 día 15 del 4.º mes), si hay provisión de ISR al 21 % con estimados (C corp) y si el accionista lleva W-2 (S corp); ejercicio no natural sólo fuera de MX (`fiscal_year_start_month` con lector) [F40-F47].
19. **Depreciación fiscal**: libro fiscal separado del contable; clase MACRS y convención (HY; MQ si > 40 % en Q4; MM para 27.5/39); §179 y *bonus* como elección anual del despacho (panel) con topes por año de puesta en servicio (tabla); *de minimis* 2 500/5 000 como variante USD de `umbral_capitalizacion_mxn` [F50-F53].
20. **Sales tax**: acumular ventas por estado de destino y periodo de medición; avisar al acercarse al umbral; estados con nexo = clave de panel; tasa por dirección de destino con jurisdicciones locales; ventas por *marketplace* reportadas como cobradas por el facilitador; devengo de *use tax* en compras sin impuesto; cuenta *Sales Tax Payable* en `ESTRATO_FISCAL_US` [F54-F57].
21. **Calendario de obligaciones** generado desde entidad (clasificación, estados con nómina y con nexo) y parámetros, con corrimiento a día hábil y festivos federales (tabla) [F2, F12, F40].
22. **New hire**: obligación a 20 días (o el plazo estatal) desde `hire_date`, con los seis datos de §653a [F39].
23. **NACHA**: `BANK`, `200` y `PAYROLL` salen del código y entran a la configuración de la cuenta bancaria de la entidad; la regla de formato (94 caracteres, PPD, 22/32) queda como constante de la casa hasta poder leer las reglas 2026 [F75, no verificada].

## 10. Lo que el repo ya tiene frente a lo que falta

| Área | Tiene (con evidencia) | Falta |
|---|---|---|
| Conmutador | `esContabilidadMexicana` (`pais-contable.ts:35-44`); `COUNTRY_PROFILES.USA` (`entity-service.ts:66-75`); `employees.country_code` MX/US (`008:25`) | Jurisdicción como valor (no booleano), estado de la entidad, clasificación fiscal federal, `fiscal_year_start_month` con lector |
| Panel | 39 claves, ninguna US (`pending-catalog.ts`; `docs/jurisdicciones.md` §1.4) | `estados_con_nexo_sales_tax`, elección §179/*bonus*, `depreciacion_convencion_fiscal_us`, provisión ISR, `metodo_costeo_inventario`, etiqueta USD del *de minimis* |
| Tablas legales | `tax_tables`/`tax_parameters` por año (`008:354-382`), sembradas en `009` con cifras 2024/2025 y sin fuente | Vigencia por fecha; fuente obligatoria; 46 estados; todas las localidades; §8 completo |
| FIT | Motor Pub 15-T parcial (`fit-calculator.ts`) | Línea 1g, Checkbox, MFS, pre-2020, exento, tablas 2026 reales, YTD suplementario |
| FICA | Motores completos (`fica-calculator.ts`), YTD topado (`ytd-service.ts`), pruebas (`fica.spec.ts`) | Tope 184 500; fallo cerrado |
| FUTA / 940 | Motor neto y forma (`futa-calculator.ts`, `form-940-generator.ts`) | Reducción de crédito y Schedule A; exentos línea 4; depósitos escritos |
| 941 | Forma con líneas 1-15 (`form-941-generator.ts`) | Escritor de `employer_tax_liabilities`; *lookback*; Schedule B; 944 |
| W-2/W-3/EFW2 | Generadores (`w2-generator.ts`, `w3-generator.ts`) | TP/TT/TA/14b; tope 184 500; RW alineado y RS; propinas y prima FLSA como conceptos |
| W-4 | `w4_data` JSONB (`008:44`) leído por FIT | Versionado con fecha efectiva; puerta `w4 record` (catálogo `:1642`, 🟡); certificados estatales |
| Beneficios | Planes, elecciones, *match* (`benefits-service.ts`), pruebas | Llamador del cálculo; límites 2026 en tabla; *catch-up*; DCAP 7 500; GTL imputado |
| Embargos | CCPA/levy/AWG (`garnishment-engine.ts`), pruebas | `amount_type` real; prelación federal; CRUD; Pub 1494 como tabla; topes estatales |
| SIT/SUTA/SDI | Calculadores 51 estados (`register-all.ts:44-55`) | Filas para 46 estados; reciprocidad; porción trabajador SUTA; PFML; SDI con tope y reparto; error en vez de cero |
| Locales | Calculador genérico (`local-tax-calculator.ts`) | Filas; persistencia en el recibo; W-2 18-20; catálogo en tabla; vigencia a mitad de año |
| Depósitos y calendario | Esquema `employer_tax_liabilities` con `deposit_frequency` (`008:329-352`) | Todo el motor (§2.4) y `obligation list` |
| NACHA | Archivo PPD (`nacha-generator.ts`) | Parámetros de la cuenta; estatus del lote |
| 1099 / W-9 | `vendors.is_1099_vendor` (`002:17`); `tax_form_filings` admite `1099_nec` (`008:486`) | Todo (§2.4 R17); `vendor tax-profile set` ❌ (`cli-command-catalog.md:859`) |
| Sales & use tax | Nada (`motores-inventario.md` §4) | Todo (§4) |
| ISR de la entidad | `entity_type` (`001:81-82`); `--scheme us-tax-line` (`account-service.ts:456`) | Clasificación fiscal; formas; estimados; provisión ASC 740; K-1/capital por socio; franquicia estatal |
| Depreciación fiscal | MACRS HY (`depreciation-math.ts:263-297`) | MQ/MM, 27.5/39, §179, *bonus*, libro fiscal, `macrs_class` escrito |
| Corpus del agente | `src/ai/docs/payroll.md:17-22` (US en cinco renglones) | Ningún documento fiscal US en `src/ai/docs/` (ls); `DOC_TOPICS` sin tema |
| Pruebas | 4 specs US (`tests/payroll/usa/`) con parámetros mockeados | Ninguna prueba compara una cifra sembrada con la publicación oficial; FIT/FUTA/SIT/941/940/W-2/NACHA sin spec |

## 11. Lo que no se pudo verificar y cómo cerrarlo

- **SSA** (tope SS, EFW2): 403 en tres URL. El tope está reproducido por el IRS en tres sitios (F1, F2, F11); la especificación EFW2 2026 sigue **sin cotejar** — el RW desalineado que documentó la verificación hermana es del oficio, y antes de corregir el generador hay que abrir la Pub 42-007 desde un navegador con sesión.
- **NACHA**: 403. Los cambios de reglas 2026 (monitoreo de fraude, descripción de entrada) quedan como pendiente de lectura.
- **ACF new hire**: 403; suplido por el texto legal (F39). Los plazos por estado (< 20 días en varios) faltan.
- **MA, CO, MN PFML y CA FTB**: 403; las cifras de MN vienen del extracto de búsqueda y las de MA/CO/CT no se afirman.
- **DOL, bases SUTA**: leídas por `pdftotext` de un PDF en columnas; NY 17 600 se contrastó con una segunda búsqueda; las demás celdas conviene confirmarlas estado por estado antes de sembrar.
- **Form W-4 2026, paso 3(a)**: el extracto cortó el importe por hijo (2 200 tras la OBBBA, del oficio); se afirma sólo el 500 por otro dependiente y el límite 200 000/400 000.
- **Reciprocidad estatal, topes estatales de embargo, festivos federales, tasas locales de Ohio/Indiana/Maryland**: no consultados; se nombran como parámetros que faltan, sin cifras.
