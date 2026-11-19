-- ============================================================
-- 330 · THE EMPLOYER OLD-AGE QUOTA IS A TABLE BY SBC BAND AND YEAR
--       (#661, MNE-001-512)
--
-- Since 1 January 2023 the employer quota for cesantía en edad avanzada y
-- vejez is no longer one rate. LSS art. 168 fr. II a), as reformed by the
-- decree of DOF 16-12-2020, sets it by the band the worker's SBC falls in,
-- and the decree's transitorio Segundo phases each band in year by year until
-- 2030. The only employer rate this database holds is the flat 0.03150 that
-- migration 009 seeded in `tax_parameters`: the rate of 2022. The calculator
-- multiplies every SBC by it, so the employer is charged too little.
--
-- This migration loads the law: 8 bands × the years 2023 to 2030, 64 rows of
-- `legal_parameters`. NOTHING READS THEM YET. The calculator changes in
-- MNE-001-513; until then no payslip, entry or SUA amount moves, and the flat
-- rate of 009 and 073 stays where it is.
--
-- WHY `legal_parameters`: a row is read by the date of the act (the greatest
-- effective_from on or before it), so the 2030 column needs no end date and a
-- day of 2031 still finds it; a date before 2023 answers «not yet in force»
-- instead of a wrong rate; and the source is mandatory per row.
--
-- KEYS: one per band, named by its UPPER edge: `sm_1_00` is «1.00 SM»,
-- `uma_1_50` is «1.01 SM a 1.50 UMA», … `uma_above_4_00` is «4.01 UMA en
-- adelante». The edges are not rows: they do not change by year.
--
-- VALUE: a fraction with five decimals, unit `rate`, as every other `rate`
-- row is a fraction its reader multiplies by. The law prints 3.676 %; it is
-- stored as 0.03676. Four decimals would round it to 0.0368.
--
-- WHERE EACH FIGURE WAS READ. The columns 2023 to 2029, and 2030 with them,
-- were typed from the image of the table of the transitorio Segundo in the
-- decree as the DOF serves it (dof.gob.mx, nota 5607729, 16-12-2020), and
-- checked against the same image on p. 153 of the LSS of the Cámara de
-- Diputados (text in force, última reforma DOF 15-01-2026). The 2030 column
-- was also compared with the table of art. 168 fr. II a) itself, which both
-- documents carry as text (LSS p. 52). The table is NOT a straight line from
-- 3.150 %: 14 cells differ by 0.001 from the rounded line, so no cell here is
-- computed. tests/integration/migration-330-old-age-quota-table.int.spec.ts
-- types the 64 cells a second time, as percentages, and compares.
--
-- Idempotent by the 080 unique key (jurisdiction, key, effective_from). DO
-- NOTHING would keep a wrong row left by an earlier manual load in silence,
-- so the migration ends with a guard that counts the rows and checks the sum
-- of each year's column against a figure typed on its own.
-- ============================================================

INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
SELECT 'MX',
       'imss.old_age.employer_rate.' || band.suffix,
       make_date(cell.year, 1, 1),
       cell.rate,
       'rate',
       'https://dof.gob.mx/nota_detalle.php?codigo=5607729&fecha=16/12/2020',
       'LSS art. 168 fr. II a), employer quota for cesantía en edad avanzada y vejez, band «'
         || band.as_printed || '», from 1 January ' || cell.year || ': '
         || to_char(cell.rate::numeric * 100, 'FM990.000') || ' % of the SBC. '
         || CASE WHEN cell.year = 2030
              THEN 'It is the figure of the table of art. 168 itself (decree of DOF 16-12-2020), where the gradual table of the decree''s transitorio Segundo ends; the law states no figure for a later year.'
              ELSE 'Gradual table of the transitorio Segundo of the decree of DOF 16-12-2020, column ' || cell.year || '.'
            END
  FROM (VALUES
    --                                         2023       2024       2025       2026       2027       2028       2029       2030
    ('sm_1_00',        '1.00 SM',             '0.03150', '0.03150', '0.03150', '0.03150', '0.03150', '0.03150', '0.03150', '0.03150'),
    ('uma_1_50',       '1.01 SM a 1.50 UMA',  '0.03281', '0.03413', '0.03544', '0.03676', '0.03807', '0.03939', '0.04070', '0.04202'),
    ('uma_2_00',       '1.51 a 2.00 UMA',     '0.03575', '0.04000', '0.04426', '0.04851', '0.05276', '0.05701', '0.06126', '0.06552'),
    ('uma_2_50',       '2.01 a 2.50 UMA',     '0.03751', '0.04353', '0.04954', '0.05556', '0.06157', '0.06759', '0.07360', '0.07962'),
    ('uma_3_00',       '2.51 a 3.00 UMA',     '0.03869', '0.04588', '0.05307', '0.06026', '0.06745', '0.07464', '0.08183', '0.08902'),
    ('uma_3_50',       '3.01 a 3.50 UMA',     '0.03953', '0.04756', '0.05559', '0.06361', '0.07164', '0.07967', '0.08770', '0.09573'),
    ('uma_4_00',       '3.51 a 4.00 UMA',     '0.04016', '0.04882', '0.05747', '0.06613', '0.07479', '0.08345', '0.09211', '0.10077'),
    ('uma_above_4_00', '4.01 UMA en adelante', '0.04241', '0.05331', '0.06422', '0.07513', '0.08603', '0.09694', '0.10784', '0.11875')
  ) AS band (suffix, as_printed, y2023, y2024, y2025, y2026, y2027, y2028, y2029, y2030)
  CROSS JOIN LATERAL (VALUES
    (2023, band.y2023), (2024, band.y2024), (2025, band.y2025), (2026, band.y2026),
    (2027, band.y2027), (2028, band.y2028), (2029, band.y2029), (2030, band.y2030)
  ) AS cell (year, rate)
ON CONFLICT (jurisdiction, key, effective_from) DO NOTHING;

-- THE GUARD. The sums are the eight cells of each column of the image added
-- by hand, in percent; they are not derived from the VALUES above.
DO $$
DECLARE
  loaded integer;
  off_column record;
BEGIN
  SELECT count(*) INTO loaded
    FROM legal_parameters
   WHERE jurisdiction = 'MX' AND key LIKE 'imss.old\_age.employer\_rate.%';
  IF loaded <> 64 THEN
    RAISE EXCEPTION 'migration 330: % row(s) under imss.old_age.employer_rate. where the law has 64 (8 bands by 8 years)', loaded;
  END IF;

  FOR off_column IN
    SELECT s.year, s.printed_sum, sum(p.value::numeric) * 100 AS loaded_sum
      FROM (VALUES (2023, 29.836), (2024, 34.473), (2025, 39.109), (2026, 43.746),
                   (2027, 48.381), (2028, 53.019), (2029, 57.654), (2030, 62.293)) AS s (year, printed_sum)
      JOIN legal_parameters p
        ON p.jurisdiction = 'MX'
       AND p.key LIKE 'imss.old\_age.employer\_rate.%'
       AND p.effective_from = make_date(s.year, 1, 1)
     GROUP BY s.year, s.printed_sum
    HAVING count(*) <> 8 OR sum(p.value::numeric) * 100 <> s.printed_sum
     ORDER BY s.year
  LOOP
    RAISE EXCEPTION 'migration 330: the employer old-age rates in force from 1 January % add up to % %%, and the column of the law adds up to % %%. A row loaded before this migration holds another figure; correct it against DOF 16-12-2020 and run again',
      off_column.year, off_column.loaded_sum, off_column.printed_sum;
  END LOOP;
END $$;
