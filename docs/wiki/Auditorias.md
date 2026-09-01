# Auditorías

mnemosine se audita a sí mismo, en contra de sí mismo, cada cierto tramo. Los
informes viven en el repositorio, no en la cabeza de nadie:
[`docs/auditorias/`](https://github.com/sedecim-com/Accounting/tree/main/docs/auditorias).

Esta página explica la práctica —por qué existe, cómo se hace y cómo se lee un
informe— y resume qué encontró cada corrida y qué cambió por ella.

## Por qué se audita un árbol que está en verde

Las puertas automáticas de este proyecto son buenas y no bastan. La CI puede
estar entera en verde, `npm test` puede pasar sus miles de casos y
`npm run plan:status` puede declarar cerrado un paquete, y las tres cosas pueden
ser ciertas mientras el sistema está mal. Hay al menos tres formas de que ocurra,
y las tres se han dado aquí:

- **El criterio mide la prosa, no la conducta.** El paquete E3.2 estuvo cerrado
  porque una expresión regular encontraba dos cadenas de texto dentro de la
  pregunta de una política. La descarga masiva del SAT no existía —ni SOAP, ni
  ZIP, ni comando— y el tablero decía que sí. La auditoría de agosto lo destapó y
  E3.2 salió de la lista `--exigir` con su causa escrita en el propio
  [`ci.yml`](https://github.com/sedecim-com/Accounting/blob/main/.github/workflows/ci.yml).
- **La prueba existe y no toca lo que dice tocar.** Invertir el signo del saldo
  en la balanza de comprobación sobrevive las dos suites completas, porque la
  única prueba de ese archivo simula la consulta y recalcula la resta en su
  propio fixture.
- **La compuerta existe y está vacía.** `FLUJOS_CERRADOS`, en
  [`src/plan/criterios.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/plan/criterios.ts),
  se escribió para impedir que un flujo se declarara cerrado sin registro de
  auditoría. Su único renglón está comentado, así que el criterio itera un objeto
  vacío y siempre da verde.

Un instrumento que publica un falso verde es peor que no tener instrumento,
porque cierra la pregunta. La auditoría es el mecanismo que vuelve a abrirla.

## Por qué es adversarial

Un hallazgo que nadie intentó refutar no vale nada. Es una opinión con formato de
informe, y las opiniones sobreviven a los hechos con demasiada facilidad cuando
quien las escribe es también quien las revisa.

Así que la práctica tiene tres reglas:

1. **Cada afirmación lleva `archivo:línea`, verificado contra un commit
   nombrado.** No «el código no valida esto», sino la ruta y el renglón donde no
   lo valida.
2. **Cada hallazgo mayor pasa por un escéptico** cuyo encargo explícito es
   tumbarlo. En la auditoría II se sometieron nueve a ese trato y ninguno se
   cayó. Los que sí se caen no se publican como hallazgo: se publican como
   fortaleza, o como matiz. La auditoría II corrigió por esa vía tres
   afirmaciones propias, entre ellas una que decía «sin un solo registro en
   `docs/auditorias/`» cuando había nueve archivos ahí.
3. **El titular trae la receta para matarlo.** En la tercera auditoría eso se
   volvió formato: cada lente publica su titular y, debajo, el comando exacto que
   lo refutaría si fuera falso. No «revísalo», sino «corre este `EXPLAIN ANALYZE`
   sobre 400 000 líneas y, si la razón entre los dos roles es menor que 3×, mi
   titular es falso».

Cada lente audita también **a favor**: los informes abren con una sección de
fortalezas verificadas antes de la de brechas. Un informe que sólo encuentra
defectos no está midiendo, está acusando.

## La primera: 2026-08-31, siete lentes

[`docs/auditorias/2026-08-31-integral/`](https://github.com/sedecim-com/Accounting/tree/main/docs/auditorias/2026-08-31-integral)
— siete lentes en paralelo sobre el árbol completo, al cierre del tramo S0.

| Lente | Hallazgo mayor |
|---|---|
| Plan maestro contra código | Las cifras de su primera sección caducaron contra su propio commit; GraphQL y blockchain, unas 2 250 líneas, sin gobierno |
| Herencia del plan de cierre | E3.2 era un falso verde vivo: el criterio comía prosa |
| Herencia de «Doce sprints o sesenta» | El modelo de costes se midió una vez y no tenía instrumento |
| Prácticas del núcleo contable | El mayor era **físicamente reescribible**; `account_balances` sin verificación |
| Cumplimiento fiscal mexicano | El UUID de CFDI era global: dos clientes que se facturan entre sí no cabían |
| Prácticas agentic-AI | **Cero evals**: la confianza del agente no estaba calibrada contra nada |
| Seguridad multi-inquilino | La bitácora inmutable guardaba PII en claro; el arranque no era fail-closed ante un rol con BYPASSRLS |

**Qué cambió por ella.** Esta es la corrida con el rastro más limpio, porque los
tramos que siguieron citan sus hallazgos en el asunto del commit:

- `205e1e0` **S1** — trece ítems que no admitían espera. E3.2 sale de `--exigir`
  y el tablero **baja** a 8 paquetes en verde de 15: el descenso es el arreglo. La
  prueba de rango deja de persistir el valor en claro junto a la prueba, y una
  migración purga los blobs ya escritos. Producción deja de arrancar con un rol
  que ignora RLS.
- `d2eef08` **R1 · el mayor inviolable** — la migración 041 hace físicamente
  imposible reescribir un asiento posteado, con lista blanca de metadatos
  comparada por resta de JSONB para que una columna nueva nazca protegida.
  `mnemosine doctor` gana la comprobación «Ledger integrity», y esa sí es `fail`.
- `e282fe4` **R2 · el perímetro que faltaba**, y `2cd656e` **R3**, que saca el
  refresco de las vistas materializadas de la transacción de posteo.
- `5ec9750` **A1–A2** — el golden set y `mnemosine ai stats`: la respuesta
  directa a «cero evals».
- `a6932b1` **F01** y `a149e62` **F02**, los dos primeros flujos.

## La segunda: 2026-09-01, doce lentes

[`docs/auditorias/2026-09-01-integral-ii/`](https://github.com/sedecim-com/Accounting/tree/main/docs/auditorias/2026-09-01-integral-ii)
— doce lentes, nueve hallazgos mayores sometidos a un escéptico, **ninguno se
cayó**. El árbol se movió mientras los lentes medían, así que tres informes
suplementarios re-miden la capa de agente y el instrumento sobre la cabeza nueva.

Su aritmética: **70 brechas cerradas · 104 siguen abiertas · 110 nuevas**. Que
aparezcan 110 nuevas con 70 cerradas no es un retroceso; es lo que pasa cuando
doce lentes miran más hondo que siete.

Los cinco temas, en orden de consecuencia:

1. **El instrumento no se mide a sí mismo.** `FLUJOS_CERRADOS` vacío; el
   trinquete `--exigir` es de granularidad **paquete**, así que dieciséis
   criterios verdes viven dentro de paquetes rojos y ningún commit puede
   ponerlos en rojo —entre ellos «ninguna herramienta del agente alcanza el
   mayor», que es regla de la casa—; y 66 de 69 criterios son expresiones
   regulares sobre el fuente, no conducta.
2. **Tres puertas al auto-posteo, una custodiada.** El piso de evidencia de la
   sombra —siete días, diez decididos, acuerdo ≥ 0,90— gobierna una de las tres.
   La bandera `--auto-post` y el archivo del operador lo encienden sin tocarlo, y
   el caso grave está probado: panel en `shadow` más archivo en `true` postea de
   verdad sin registrar un solo veredicto de sombra.
3. **El DML de migración bajo RLS forzada rellena cero filas, en silencio.**
   Probado: mismo SQL, mismo rol, `UPDATE 0` sin contexto de inquilino contra
   `UPDATE 1` con él. Ya cobró una víctima real y alcanza a dos migraciones más
   que el repositorio cree aplicadas, una de ellas una purga de seguridad.
4. **Un sistema contable sin restauración no es un sistema contable.** Cero
   líneas de respaldo o restauración en todo el árbol, agravado por lo que el
   proyecto hizo bien: desde la 041 el mayor es inmutable y `audit_log` es de
   sólo agregar, así que un error de datos no se puede reparar a mano.
5. **Bloqueos más pequeños de lo que el plan creía.** El único adaptador de PAC
   no simulado del repositorio está escrito y completo, y es inalcanzable porque
   falta la línea que lo registra. `ledger check --check balance` es ciego a
   `ending_balance`: le inyectaron 99 999 de deriva y devolvió cero hallazgos.

**Qué cambió por ella, hasta hoy: los documentos, y nada más.** El commit
`b099a44` reescribió los tres documentos rectores para que dijeran lo que la
auditoría midió, y `29d0b35` los fusionó. La tercera auditoría volvió a mirar los
nueve titulares sobre `61379d0` y los encontró **los nueve vivos, cero cerrados**:
el árbol se movió 101 líneas en nueve archivos y ninguna toca uno solo de los
nueve puntos. Decirlo aquí es más útil que celebrar la corrida: el valor de una
auditoría no se cobra al publicarla.

## La tercera, en curso

[`docs/auditorias/2026-09-01-integral-iii/`](https://github.com/sedecim-com/Accounting/tree/main/docs/auditorias/2026-09-01-integral-iii)
tiene once lentes escritos y un
[`_titulares.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/auditorias/2026-09-01-integral-iii/_titulares.md)
con un renglón por lente: el titular y cómo tumbarlo. Todavía no tiene README, y
mientras no lo tenga la corrida no está cerrada: la aritmética consolidada y el
reparto de propiedad son parte del trabajo, no un apéndice.

Los lentes nuevos que la II no tenía dan idea de hacia dónde se movió el foco:
escala y rendimiento con volumen real, calidad de las pruebas —qué mata y qué no
mata una mutación—, aritmética del cierre y del ejercicio, control interno visto
por un auditor externo, NIF e IFRS más allá del fisco, ingeniería de contexto del
agente, operación y día malo, las superficies que no son el CLI, cadena de
suministro y build, y los tres documentos rectores contra el árbol.

Una muestra de lo que ya afirman, cada uno con su receta de refutación:

- La política RLS de las tablas hijas se evalúa una vez por línea de asiento y
  encarece la balanza 17× sobre 792 000 líneas.
- El estado de resultados de un ejercicio ya cerrado sale en ceros, porque ningún
  reporte excluye el asiento de cierre y ese asiento se fecha dentro del rango
  que el reporte consulta.
- La regla «el humano dispone» descansa sobre una identidad que nadie autentica:
  `--user <email>` se documenta como atribución **y permisos**, y ninguna ruta de
  la terminal llama jamás a `requirePermission`.
- Los sueldos brutos de toda nómina mexicana se cargan a una cuenta acreedora de
  costo de ventas, porque dos sembradores de catálogo chocan en cinco códigos y
  gana el que corre primero.

## Cómo se lee un informe

Cada lente tiene la misma forma: **fortalezas** verificadas, **brechas**
numeradas con severidad y con la marca de si son nuevas o vienen de la corrida
anterior, y **recomendaciones**. Desde la II, cada informe cierra además con un
dictamen sobre la auditoría previa —qué de aquello resistió— y con su propia
contabilidad: cuántas brechas nuevas, cuántas heredadas siguen vivas, cuántas
cerraron.

Las cuentas por lente no se suman entre sí: un mismo defecto lo ven varios lentes
desde ángulos distintos, y sumarlos lo contaría varias veces. El número honesto
de una corrida es el que publica su README, y por eso una corrida sin README no
tiene número.

## Lo que la práctica todavía no resuelve

Se dice aquí porque descubrirlo leyendo el código sería peor:

- **La compuerta que debía obligar a esto está vacía.** F01, F02 y el tramo A3–A4
  se declararon hechos sin registro, y ningún criterio pudo objetar. La versión
  vigente del plan maestro ya no presume mecanismo: dice que la compuerta existía
  y estaba vacía, y que hasta que se pueble, «hecha» significa lo que el commit
  demuestre. Eso es rojo honesto, no arreglo.
- **La auditoría es manual.** Nada en la CI la dispara ni la exige. Es disciplina
  sostenida por costumbre, y una costumbre no es una puerta.
- **Publicar un hallazgo no lo cierra.** Los nueve titulares de la II lo
  demuestran. Mientras un hallazgo no tenga tramo, criterio y rojo en el tablero,
  vive únicamente en un archivo Markdown que nadie está obligado a leer.

## Para seguir

- [[El-tablero-y-los-criterios]] — cómo se escribe un criterio que juzgue
  conducta y no prosa, y por qué cada uno llega con su espejo de mutación.
- [[Hoja-de-ruta]] — dónde entra cada hallazgo en la secuencia, y qué está
  comprometido.
- [[Pruebas-y-CI]] — las puertas automáticas que la auditoría complementa.
- [[Como-contribuir]] — la regla de reabrir un paquete a la vista, que es la
  mecánica con la que un hallazgo de auditoría se cobra.
