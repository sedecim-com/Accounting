# Investigación normativa y de motores · 2026-09-06

Cincuenta agentes en dos fases, con la instrucción de refutar en cada eslabón, para responder dos preguntas: **qué motor contable existe para cada jurisdicción y cuál falta**, y **qué dice la norma —contable y fiscal, de México y de Estados Unidos— que el motor debe implementar o parametrizar**, con la fuente oficial abierta en la corrida. Ningún archivo del repositorio se afirmó sin `archivo:línea`; ninguna liga se citó sin abrirla; las que no respondieron se dicen.

## Lo que salió de aquí

| Documento | Qué es |
|---|---|
| [`../../jurisdicciones.md`](../../jurisdicciones.md) | **El documento rector**: la jurisdicción como dimensión. La regla «la ley no se decide y el criterio no se legisla», un solo conmutador, un paquete por país, el panel con jurisdicción, la tabla de parámetros legales con vigencia, y el tramo J0 con un criterio por paso. |
| [`motores-inventario.md`](motores-inventario.md) | **La matriz** motor × jurisdicción × estado × regla por definir × dónde vive el parámetro, para los diez subsistemas. |
| [`motores/`](motores/) | Los nueve inventarios verificados, uno por subsistema: motor-contable, informes-y-panel, fiscal-mx, activos-inventario, nomina-mx, nomina-us, integraciones-y-publico, banca, cxc-cxp. |
| [`normas/gaap-asc.md`](normas/gaap-asc.md) | US GAAP: la Codificación ASC, la SEC y a quién obliga, las bases contables de una PyME (GAAP, PCC, *tax basis*, *cash basis*, FRF for SMEs), tópico por tópico con su motor y su parámetro, la tabla de diferencias GAAP↔IFRS↔NIF que se parametriza **por libro**, y el corpus que hay que escribir. |
| [`normas/ifrs-nif-delta.md`](normas/ifrs-nif-delta.md) | El corpus NIIF/NIF que ya existe, verificado ficha por ficha contra ifrs.org y el CINIF: qué se corrigió en este mismo PR y qué queda (N3). |
| [`normas/fiscal-mx.md`](normas/fiscal-mx.md) | LISR, LIVA, CFF, RMF 2026 y anexos, LFT, LSS, INFONAVIT, UMA y salarios mínimos: regla por regla, y **qué número vive en qué sitio** hoy. |
| [`normas/fiscal-us.md`](normas/fiscal-us.md) | IRC, Pub 15/15-T, FICA/FUTA/SUTA/SIT por estado, 941/940/W-2/1099, CCPA, *sales & use tax*, tipos de entidad y 1120/1065, MACRS/§179/*bonus*, y el calendario: qué debe ser tabla por año y por estado. |
| [`practicas/arquitectura.md`](practicas/arquitectura.md) | Cómo modelan la jurisdicción Odoo, ERPNext, NetSuite, Xero/QuickBooks, hledger/beancount; tablas con vigencia; gobierno del agente que propone y no dispone frente a SOC 1/2, SOX 404, NOM-151 y CFF 30; fuentes automáticas por jurisdicción. |
| [`practicas/conectores.md`](practicas/conectores.md) | Refresco de las seis lentes del [2026-09-02](../2026-09-02-mejores-practicas/): PACs, proveedores de IA, onboarding, tablero, canales y experimental — qué cambió en cuatro días, en la web y en el repo. |

## Las ligas

| Informe | Fuentes | Verificadas por el investigador | Re-abiertas por un segundo agente | Muertas o cascarón |
|---|---:|---:|---:|---:|
| gaap-asc | 54 | 45 | 45 | 0 |
| ifrs-nif-delta | 49 | 47 | 43 | 4 |
| fiscal-mx | 46 | 37 | 37 | 0 |
| fiscal-us | 80 | 71 | 71 | 0 |
| practicas/conectores | 178 | 149 | 149 | 0 |
| practicas/arquitectura | 63 | 54 | 54 | 0 |
| **Total** | **470** | **403** | **399** | **4** |

Las «muertas» del delta NIIF/NIF no son 404: dos son páginas de iasplus que responden 200 con un cascarón genérico, y dos son páginas del CINIF (`normatividad_listadonormas.php`, `normatividad_plandetrabajo.php`) que redirigen a login. Los informes lo dicen en su propia tabla. Ninguna página abierta traía instrucciones dirigidas a un asistente; si las hubiera traído, se habrían ignorado y anotado.

## El método, y por qué tantos agentes

**Fase 1, el inventario.** Nueve lectores de código, uno por subsistema, con la consigna de censar cada motor con `archivo:línea`, su estado, sus reglas por definir para MX y US y sus parámetros quemados. Nueve escépticos independientes releyeron cada `archivo:línea`, corrieron grep por cada «ausente» buscando el motor bajo otro nombre, y contrastaron cada «quemado» con las 39 claves del panel y con `tax_tables`. Refutaron trece afirmaciones enteras (el pasivo por anticipo de cliente **sí** existe; los roles 2140 de retención **sí** tienen escritor en la ingesta; el conmutador de nómina ya normaliza US/USA; Sovos **sí** está en el registry…) y aportaron 92 hallazgos nuevos. Nueve redactores fundieron original y verificación en [`motores/`](motores/); nueve comprobadores reabrieron con `sed` las 644 citas de los nueve documentos y corrigieron dos.

**Fase 2, la norma.** Seis investigadores con web en vivo y la instrucción de preferir la fuente oficial (FASB, SEC, IFRS Foundation, CINIF, SAT, DOF, IRS, SSA, DOL, eCFR) y de marcar como no verificada toda liga que no respondiera. Seis verificadores de ligas volvieron a abrir cada URL marcada como verificada.

**Y dos auditores** contra las dos síntesis que escribió la sesión principal —el diseño y la matriz—: 185 afirmaciones revisadas, 38 discrepancias, cinco de fondo. Las cinco están corregidas y dichas en el commit que las corrige: la 3300 no es reserva legal sino la cuenta puente del cierre; el INFONAVIT sin fila del año no calcula cero sino un 5 % quemado sobre una UMA quemada; Sovos sí está en el registry; el SUA emite un formato «simplificado» que no es el del IMSS; y el posteo de la nómina mexicana revienta cuando el subsidio de un trabajador supera a su ISR.

## Tres hallazgos de repositorio que salieron de investigar hacia afuera

- **La semilla «2026» de nómina es de otros años.** Del lado mexicano, UMA 113.14 y salarios mínimos 278.80/419.88 son de 2025 (2026: 117.31 desde el 1 de febrero; 315.04/440.87 desde el 1 de enero), la tarifa quincenal es la mensual ÷ 2 y la tabla del subsidio es la derogada en mayo de 2024. Del lado estadounidense, el tope de Seguro Social es el de 2024 (168 600; real 184 500), y 401(k), deducción estándar, FSA y bandas FIT son de 2025. Nada de esto se ve desde adentro: se ve abriendo el DOF y el IRS. Es T4 (#91) y el motivo de que J0.4 exija fuente obligatoria por parámetro.
- **«NIF A-2» ya no significa lo que el motor cree.** Desde el 1 de enero de 2026 la NIF A-2 es *Incertidumbres sobre negocio en marcha*; el postulado de devengación que el motor cita como «A-2» en doce sitios de `src/` vive en la A-1 (2023). El corpus del agente tampoco lo sabía. Consecuencia de diseño: las citas normativas son un **parámetro por jurisdicción y vigencia**, no literales en el código (N3).
- **El repo se movió más rápido que su wiki.** Sovos entró al registry (`pac-router.ts:45-47`) y `trust proxy` existe con criterio, pero `Conectores-PAC` seguía diciendo «registrado a medias» y el tablero seguía pidiendo la R10. Y Anthropic cambió a `Authorization: Bearer` con `x-api-key` como *legacy* mientras el deep-link de `KEY_URLS` hace 301. Las seis páginas de «Hacia dónde va» ganan una sección de refresco fechada.

## Lo que este trabajo cambió en el repositorio

`docs/jurisdicciones.md` (nuevo, rector) · `docs/SCOPE.md` (visión internacional, no-goals reescritos) · `README.md` («Dos jurisdicciones, un motor») · `docs/HISTORY.md` («Lo que sigue») · wiki: `Jurisdicciones`, `Motores-contables`, `Normas-contables` (nuevas), y secciones nuevas en `Arquitectura`, `Hoja-de-ruta`, `Fiscal-mexicano`, `Home`, `_Sidebar` y las seis de «Hacia dónde va» · `src/ai/docs/ifrs-registry.json` y `niif-indice.md` (la parte cierta del delta, con la prueba de sincronía en verde) · Issues: el tramo **J0** ([#123](https://github.com/sedecim-com/Accounting/issues/123)) y los índices **J1** ([#124](https://github.com/sedecim-com/Accounting/issues/124)) / **J2** ([#125](https://github.com/sedecim-com/Accounting/issues/125)), los corpus **N1** ([#131](https://github.com/sedecim-com/Accounting/issues/131)) / **N2** ([#132](https://github.com/sedecim-com/Accounting/issues/132)) / **N3** ([#133](https://github.com/sedecim-com/Accounting/issues/133)), y los defectos **T19–T23** de la Vía A ([#126](https://github.com/sedecim-com/Accounting/issues/126)–[#130](https://github.com/sedecim-com/Accounting/issues/130)), más comentarios de evidencia en T4 (#91), D1 (#111), F07 (#112), F08 (#113) y A6 (#121). Etiqueta `jurisdiccion`.

Los informes de trabajo intermedios (inventarios originales y verificaciones sueltas) vivieron en `/tmp` y no se conservan: lo que vale es la versión fundida y comprobada de [`motores/`](motores/).
