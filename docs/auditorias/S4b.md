# Auditoría de S4b «El corpus que nadie leyó»

**Objeto:** el commit del tramo S4b, segunda mitad de S4.
**Fecha:** 2026-09-03.
**Método:** siete agentes revisores, uno por manual, cada uno contrastando su
manual **afirmación por afirmación** contra las fuentes que declara y, donde se
podía, ejecutando el binario. Un verificador comprobó **83 correcciones** —al
menos tres por manual y TODAS las de dinero, permisos o irreversibilidad—
contra el código.

## El alcance cambió, y merece decirse

De las tres piezas que el plan pedía para S4b, **dos ya estaban hechas**, y una
mejor de lo pedido:

- El instrumento de coste **ya publica una BANDA en vez de un número**, con un
  argumento que el plan no tenía: la versión anterior clasificaba por regex
  sobre el asunto del commit y publicaba 0,7 %, **subestimando entre 17× y
  74×** — de dieciocho commits correctivos casaba uno. Publicar una sola cifra
  habría cerrado la pregunta con el número equivocado.
- El corpus **ya tenía su compuerta de caducidad**, con criterio propio.

Lo que seguía vivo era lo que el trinquete señalaba desde el día que se creó:
`SIN_REVISAR_MAXIMO = 8`, y ocho manuales sin revisar. Clavado en su techo.

**«Sin revisar» no significa desactualizado**: significa que nadie los había
contrastado NUNCA contra el código, mientras el agente los lee como su mundo.
Una afirmación falsa ahí no es una errata — es el agente diciéndole a un
contador, con toda confianza, que el sistema hace algo que no hace.

## Lo que se encontró: ~220 afirmaciones revisadas, 56 mentían

**`mnemosine.md` — el manual del agente mentía sobre el agente.** Decía «your
22 tools» y son **25**: faltaban tres herramientas enteras (`skills_list`,
`skill_view`, `session_search`), las tres construidas incondicionalmente. El
manual que el agente lee para saber qué puede hacer no conocía tres de sus
propias manos.

**`identity-access.md` describía el mundo anterior a G3, y mandaba al agente
proponer justo lo que ahora se rechaza.** Decía que `review` pide `--user
<email>` para nombrar a quien aprueba. Desde G3, con sesión abierta, nombrar a
un tercero lanza `SuplantacionError`. El manual habría hecho que el agente
propusiera una invocación imposible, con confianza.

**`reports.md` — y aquí el manual destapó un defecto de CÓDIGO.** Decía que en
el balance «total_liabilities_and_equity must ≈ assets.total», y **para la
herramienta del agente es falso**. Medido ejecutando contra una entidad real:

```
AGENT get_balance_sheet    assets.total  -1011.12    L+E  16008.00   GAP -17019.12
AGENT get_income_statement net_income    -17019.12   ← el hueco, exacto
mnemosine report balance-sheet            cuadra
```

El CLI añade a capital el renglón «Result Of The Period»; la herramienta del
agente **sólo suma `asset/liability/equity`** y no lo incluye. El verificador
lo confirmó algebraicamente: con la balanza cuadrada, `assets − (L+E)` es
exactamente el resultado del ejercicio. El manual mandaba tratar ese hueco como
un hallazgo contable, o sea: mandaba al agente denunciar un descuadre que
fabrica la propia herramienta.

**`system.md` prometía una capacidad entera que no existe**: eventos
`invoice.*`, `bill.*`, `payment.*`, `paycheck.issued`, `cfdi_nomina.stamped`,
`tax_form.filed`. `dispatchEvent` tiene **cuatro** llamadas en todo el árbol, y
tres son de nómina.

**`receivables.md`** documentaba estados de factura que nadie escribe —
`viewed` («el cliente la abrió») no tiene transporte que lo escriba; son
valores legales del CHECK sin un solo escritor.

**`connectivity.md`**: `DATABASE_PROVIDER` prometía presets que rellenan los
valores de TLS y que `doctor` comprueba contra ellos. Los campos existen y
**nadie los lee** fuera del archivo que los declara.

## Lo mejor del turno no fue una corrección

Al revisor de `connectivity.md` le di una pista equivocada —le dije que
buscara Sovos, el barrido de webhooks y el contrato OpenAPI—. Respondió que esa
materia **no vive en ese manual y no debería**, que en este repo
«connectivity» significa conectividad a Postgres, y que **no iba a inventar
hallazgos para encajar con la pista**. Tenía razón: esa materia está en
`system.md` y `external-integrations.md`.

Un agente que corrige al orquestador con argumento es exactamente lo que este
proyecto pide de sus revisores, y lo contrario de lo que un revisor con prisa
habría hecho.

## La verificación

83 correcciones comprobadas contra el código: **82 ciertas, una incompleta de
forma engañosa** (corregida). **Ninguna corrección falsa** — que era el riesgo
real del tramo, porque una corrección equivocada se sella y queda certificada
como revisada.

## Lo reportado y NO hecho, con domicilio

- **El balance de la herramienta del agente sigue descuadrando.** El manual ya
  lo dice, que es lo honesto, pero el defecto es de `report-tools.ts` y su
  arreglo es de la familia de reportes del agente, no de una revisión de
  corpus.
- **`payroll.md` queda sin revisar**, y el tope baja a 1 y no a 0 por eso: otra
  sesión lo está tocando ahora mismo, y revisar un blanco móvil es sellar algo
  que cambiará en la siguiente hora.
- La antigüedad de saldos «envejece la fecha de vencimiento pero lee el saldo
  de HOY» — el propio código ya lo decía en un comentario («fine for a
  collections call, wrong for an auditor»); ahora lo dice también el manual.

## Veredicto

S4b **cierra, y con él S4**. El trinquete del corpus baja de 8 a 1 por primera
vez desde que existe. Y la lección que deja es la del tramo entero: el
instrumento llevaba años señalando estos ocho manuales, en cada corrida, y
nadie los había abierto — un instrumento que avisa sin que nadie actúe se
vuelve parte del paisaje.
