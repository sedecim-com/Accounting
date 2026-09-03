-- ============================================================
-- 068 · El estado del trabajador no cabe en dos letras
--
-- F08a, defecto denunciado por dos agentes a la vez y que ninguno podía
-- arreglar: `employees.work_state` es VARCHAR(2) porque nació para los estados
-- de Estados Unidos (008_payroll.sql), y las claves de entidad federativa del
-- SAT —c_Estado— son de TRES letras: AGU, BCN, CMX, JAL, NLE, ZAC.
--
-- Con el criterio por omisión del ISN (`isn_estado_que_causa` =
-- centro_de_trabajo) el motor busca la tasa por esa columna. Una tasa
-- capturada como 'CMX' NO PUEDE casar jamás con un trabajador cuyo estado
-- cabe en 'CM', y el síntoma no es un error: es un hallazgo de «falta la tasa»
-- sobre una tasa que está capturada. El sistema diría que le falta un dato que
-- tiene.
--
-- Tres caracteres alcanzan para las dos convenciones: 'CA' sigue siendo 'CA'.
-- ============================================================

ALTER TABLE employees ALTER COLUMN work_state TYPE VARCHAR(3);
ALTER TABLE employees ALTER COLUMN residence_state TYPE VARCHAR(3);

COMMENT ON COLUMN employees.work_state IS
    'Estado donde se presta el trabajo. Dos letras para EE. UU., tres para las claves '
    'c_Estado del SAT (AGU, CMX, JAL…), que son las que el ISN busca en mx_isn_tasas_estatales.';
