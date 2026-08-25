-- ============================================================
-- Migration 009: Tax Tables 2026
-- Seeds tax brackets, caps, and parameters for 2026 tax year.
-- Values are best estimates for 2026 (SS wage base, UMA, etc.);
-- official IRS/SAT publications override these if they differ.
-- ============================================================

-- ============================================================
-- TAX PARAMETERS (single-row caps and rates per jurisdiction/year)
-- ============================================================

-- US Federal 2026
INSERT INTO tax_parameters (jurisdiction, tax_year, params) VALUES
('US-FEDERAL', 2026, '{
    "ss_wage_base": 168600,
    "ss_rate_employee": 0.062,
    "ss_rate_employer": 0.062,
    "medicare_rate_employee": 0.0145,
    "medicare_rate_employer": 0.0145,
    "additional_medicare_rate": 0.009,
    "additional_medicare_threshold_single": 200000,
    "additional_medicare_threshold_mfj": 250000,
    "futa_wage_base": 7000,
    "futa_rate_gross": 0.06,
    "futa_rate_net": 0.006,
    "401k_limit": 23500,
    "401k_catchup_age50": 7500,
    "hsa_limit_self": 4400,
    "hsa_limit_family": 8750,
    "fsa_medical_limit": 3300,
    "standard_deduction_single": 15000,
    "standard_deduction_mfj": 30000,
    "standard_deduction_hoh": 22500
}'::jsonb);

-- Mexico 2026 (estimated UMA + IMSS rates)
INSERT INTO tax_parameters (jurisdiction, tax_year, params) VALUES
('MX', 2026, '{
    "uma_daily": 113.14,
    "uma_monthly": 3439.46,
    "uma_annual": 41273.52,
    "salario_minimo_general_diario": 278.80,
    "salario_minimo_frontera_diario": 419.88,
    "imss_tope_sbc_multiplier": 25,
    "imss_employee": {
        "enfermedades_maternidad": 0.00625,
        "prestaciones_dinero": 0.0025,
        "gastos_medicos_pensionados": 0.00375,
        "invalidez_vida": 0.00625,
        "cesantia_vejez": 0.01125
    },
    "imss_employer": {
        "enfermedades_maternidad_fija": 0.204,
        "enfermedades_maternidad_excedente": 0.011,
        "prestaciones_dinero": 0.007,
        "gastos_medicos_pensionados": 0.01050,
        "invalidez_vida": 0.0175,
        "guarderias": 0.01,
        "riesgo_trabajo_clase_1": 0.0054355,
        "riesgo_trabajo_clase_2": 0.0113065,
        "riesgo_trabajo_clase_3": 0.025984,
        "riesgo_trabajo_clase_4": 0.046325,
        "riesgo_trabajo_clase_5": 0.0758875,
        "cesantia_vejez": 0.03150,
        "retiro": 0.02
    },
    "infonavit_employer_rate": 0.05
}'::jsonb);

-- State: California 2026
INSERT INTO tax_parameters (jurisdiction, tax_year, params) VALUES
('US-CA', 2026, '{
    "sdi_rate": 0.011,
    "sdi_wage_base": null,
    "suta_default_rate": 0.034,
    "ett_rate": 0.001,
    "ett_wage_base": 7000,
    "suta_wage_base": 7000,
    "pit_low_income_exempt": 17249
}'::jsonb);

-- State: New York 2026
INSERT INTO tax_parameters (jurisdiction, tax_year, params) VALUES
('US-NY', 2026, '{
    "sdi_rate_employee": 0.005,
    "sdi_weekly_max": 0.60,
    "suta_default_rate": 0.041,
    "suta_wage_base": 12800,
    "pfl_rate": 0.00455,
    "pfl_annual_cap": 399.43
}'::jsonb);

-- State: Texas, Florida (no state income tax, but SUTA)
INSERT INTO tax_parameters (jurisdiction, tax_year, params) VALUES
('US-TX', 2026, '{"suta_default_rate": 0.027, "suta_wage_base": 9000}'::jsonb),
('US-FL', 2026, '{"suta_default_rate": 0.027, "suta_wage_base": 7000}'::jsonb);

-- State: Illinois 2026 (flat 4.95%)
INSERT INTO tax_parameters (jurisdiction, tax_year, params) VALUES
('US-IL', 2026, '{
    "flat_rate": 0.0495,
    "personal_exemption": 2775,
    "suta_default_rate": 0.035,
    "suta_wage_base": 13590
}'::jsonb);

-- ============================================================
-- US FEDERAL FIT TAX TABLES — Percentage Method, Pub 15-T 2026 est.
-- Standard withholding (W-4 2020+, box 2c NOT checked)
-- Annual wage brackets — divide/multiply by periods-per-year for sub-annual
-- ============================================================

-- Single / Married filing separately (standard)
INSERT INTO tax_tables (jurisdiction, tax_type, tax_year, filing_status, pay_frequency, bracket_order, bracket_low, bracket_high, rate, base_tax, effective_from) VALUES
('US-FEDERAL', 'fit', 2026, 'single',          'annual', 1,      0,   6300, 0.00, 0,       '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'single',          'annual', 2,   6300,  17400, 0.10, 0,       '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'single',          'annual', 3,  17400,  52350, 0.12, 1110,    '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'single',          'annual', 4,  52350, 103350, 0.22, 5304,    '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'single',          'annual', 5, 103350, 197300, 0.24, 16524,   '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'single',          'annual', 6, 197300, 250700, 0.32, 39072,   '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'single',          'annual', 7, 250700, 626350, 0.35, 56160,   '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'single',          'annual', 8, 626350,   NULL, 0.37, 187637,  '2026-01-01');

-- Married filing jointly (standard)
INSERT INTO tax_tables (jurisdiction, tax_type, tax_year, filing_status, pay_frequency, bracket_order, bracket_low, bracket_high, rate, base_tax, effective_from) VALUES
('US-FEDERAL', 'fit', 2026, 'married_jointly', 'annual', 1,      0,  16300, 0.00, 0,       '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'married_jointly', 'annual', 2,  16300,  38500, 0.10, 0,       '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'married_jointly', 'annual', 3,  38500,  94400, 0.12, 2220,    '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'married_jointly', 'annual', 4,  94400, 196400, 0.22, 8928,    '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'married_jointly', 'annual', 5, 196400, 384300, 0.24, 31368,   '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'married_jointly', 'annual', 6, 384300, 491100, 0.32, 76464,   '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'married_jointly', 'annual', 7, 491100, 742600, 0.35, 110640,  '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'married_jointly', 'annual', 8, 742600,   NULL, 0.37, 198665,  '2026-01-01');

-- Head of household
INSERT INTO tax_tables (jurisdiction, tax_type, tax_year, filing_status, pay_frequency, bracket_order, bracket_low, bracket_high, rate, base_tax, effective_from) VALUES
('US-FEDERAL', 'fit', 2026, 'head_of_household', 'annual', 1,      0,  13850, 0.00, 0,      '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'head_of_household', 'annual', 2,  13850,  30750, 0.10, 0,      '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'head_of_household', 'annual', 3,  30750,  78350, 0.12, 1690,   '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'head_of_household', 'annual', 4,  78350, 129350, 0.22, 7402,   '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'head_of_household', 'annual', 5, 129350, 223300, 0.24, 18622,  '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'head_of_household', 'annual', 6, 223300, 276700, 0.32, 41170,  '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'head_of_household', 'annual', 7, 276700, 652350, 0.35, 58258,  '2026-01-01'),
('US-FEDERAL', 'fit', 2026, 'head_of_household', 'annual', 8, 652350,   NULL, 0.37, 189735, '2026-01-01');

-- ============================================================
-- MEXICO ISR — Art. 96 LISR (mensual) 2026 estimado
-- ============================================================

INSERT INTO tax_tables (jurisdiction, tax_type, tax_year, filing_status, pay_frequency, bracket_order, bracket_low, bracket_high, rate, base_tax, effective_from) VALUES
('MX', 'isr', 2026, NULL, 'monthly', 1,       0.01,    746.04, 0.0192,  0.00,         '2026-01-01'),
('MX', 'isr', 2026, NULL, 'monthly', 2,     746.05,   6332.05, 0.0640,  14.32,        '2026-01-01'),
('MX', 'isr', 2026, NULL, 'monthly', 3,    6332.06,  11128.01, 0.1088,  371.83,       '2026-01-01'),
('MX', 'isr', 2026, NULL, 'monthly', 4,   11128.02,  12935.82, 0.1600,  893.63,       '2026-01-01'),
('MX', 'isr', 2026, NULL, 'monthly', 5,   12935.83,  15487.71, 0.1792,  1182.88,      '2026-01-01'),
('MX', 'isr', 2026, NULL, 'monthly', 6,   15487.72,  31236.49, 0.2136,  1640.18,      '2026-01-01'),
('MX', 'isr', 2026, NULL, 'monthly', 7,   31236.50,  49233.00, 0.2352,  5004.12,      '2026-01-01'),
('MX', 'isr', 2026, NULL, 'monthly', 8,   49233.01,  93993.90, 0.3000,  9236.89,      '2026-01-01'),
('MX', 'isr', 2026, NULL, 'monthly', 9,   93993.91, 125325.20, 0.3200,  22665.17,     '2026-01-01'),
('MX', 'isr', 2026, NULL, 'monthly', 10, 125325.21, 375975.61, 0.3400,  32691.18,     '2026-01-01'),
('MX', 'isr', 2026, NULL, 'monthly', 11, 375975.62,       NULL, 0.3500, 117912.32,    '2026-01-01');

-- ISR Quincenal (same structure, divided by 2)
INSERT INTO tax_tables (jurisdiction, tax_type, tax_year, filing_status, pay_frequency, bracket_order, bracket_low, bracket_high, rate, base_tax, effective_from) VALUES
('MX', 'isr', 2026, NULL, 'quincenal', 1,      0.01,    373.02, 0.0192,  0.00,       '2026-01-01'),
('MX', 'isr', 2026, NULL, 'quincenal', 2,    373.03,   3166.02, 0.0640,  7.16,       '2026-01-01'),
('MX', 'isr', 2026, NULL, 'quincenal', 3,   3166.03,   5564.00, 0.1088,  185.92,     '2026-01-01'),
('MX', 'isr', 2026, NULL, 'quincenal', 4,   5564.01,   6467.91, 0.1600,  446.82,     '2026-01-01'),
('MX', 'isr', 2026, NULL, 'quincenal', 5,   6467.92,   7743.85, 0.1792,  591.44,     '2026-01-01'),
('MX', 'isr', 2026, NULL, 'quincenal', 6,   7743.86,  15618.24, 0.2136,  820.09,     '2026-01-01'),
('MX', 'isr', 2026, NULL, 'quincenal', 7,  15618.25,  24616.50, 0.2352,  2502.06,    '2026-01-01'),
('MX', 'isr', 2026, NULL, 'quincenal', 8,  24616.51,  46996.95, 0.3000,  4618.44,    '2026-01-01'),
('MX', 'isr', 2026, NULL, 'quincenal', 9,  46996.96,  62662.60, 0.3200, 11332.58,    '2026-01-01'),
('MX', 'isr', 2026, NULL, 'quincenal', 10, 62662.61, 187987.80, 0.3400, 16345.59,    '2026-01-01'),
('MX', 'isr', 2026, NULL, 'quincenal', 11, 187987.81,      NULL, 0.3500, 58956.16,   '2026-01-01');

-- ============================================================
-- MEXICO — Subsidio al Empleo (monthly 2026 est.)
-- Only applies up to ~$10,171.00 monthly
-- ============================================================

INSERT INTO tax_tables (jurisdiction, tax_type, tax_year, filing_status, pay_frequency, bracket_order, bracket_low, bracket_high, rate, base_tax, effective_from) VALUES
('MX', 'subsidio_empleo', 2026, NULL, 'monthly', 1,       0.01,   1768.96, 0, 407.02, '2026-01-01'),
('MX', 'subsidio_empleo', 2026, NULL, 'monthly', 2,    1768.97,   2653.38, 0, 406.83, '2026-01-01'),
('MX', 'subsidio_empleo', 2026, NULL, 'monthly', 3,    2653.39,   3472.84, 0, 406.62, '2026-01-01'),
('MX', 'subsidio_empleo', 2026, NULL, 'monthly', 4,    3472.85,   3537.87, 0, 392.77, '2026-01-01'),
('MX', 'subsidio_empleo', 2026, NULL, 'monthly', 5,    3537.88,   4446.15, 0, 382.46, '2026-01-01'),
('MX', 'subsidio_empleo', 2026, NULL, 'monthly', 6,    4446.16,   4717.18, 0, 354.23, '2026-01-01'),
('MX', 'subsidio_empleo', 2026, NULL, 'monthly', 7,    4717.19,   5335.42, 0, 324.87, '2026-01-01'),
('MX', 'subsidio_empleo', 2026, NULL, 'monthly', 8,    5335.43,   6224.67, 0, 294.63, '2026-01-01'),
('MX', 'subsidio_empleo', 2026, NULL, 'monthly', 9,    6224.68,   7113.90, 0, 253.54, '2026-01-01'),
('MX', 'subsidio_empleo', 2026, NULL, 'monthly', 10,   7113.91,   7382.33, 0, 217.61, '2026-01-01'),
('MX', 'subsidio_empleo', 2026, NULL, 'monthly', 11,   7382.34,  10171.00, 0, 0.00,   '2026-01-01'),
('MX', 'subsidio_empleo', 2026, NULL, 'monthly', 12,  10171.01,       NULL, 0, 0.00,   '2026-01-01');

-- ============================================================
-- STATE: California PIT 2026 (progressive — single)
-- ============================================================

INSERT INTO tax_tables (jurisdiction, tax_type, tax_year, filing_status, pay_frequency, bracket_order, bracket_low, bracket_high, rate, base_tax, effective_from) VALUES
('US-CA', 'sit', 2026, 'single', 'annual', 1,      0,  10756, 0.011, 0,       '2026-01-01'),
('US-CA', 'sit', 2026, 'single', 'annual', 2,  10756,  25499, 0.022, 118.32,  '2026-01-01'),
('US-CA', 'sit', 2026, 'single', 'annual', 3,  25499,  40245, 0.044, 442.67,  '2026-01-01'),
('US-CA', 'sit', 2026, 'single', 'annual', 4,  40245,  55866, 0.066, 1091.50, '2026-01-01'),
('US-CA', 'sit', 2026, 'single', 'annual', 5,  55866,  70606, 0.088, 2122.49, '2026-01-01'),
('US-CA', 'sit', 2026, 'single', 'annual', 6,  70606, 360659, 0.0930, 3419.60, '2026-01-01'),
('US-CA', 'sit', 2026, 'single', 'annual', 7, 360659, 432787, 0.1030, 30394.53, '2026-01-01'),
('US-CA', 'sit', 2026, 'single', 'annual', 8, 432787, 721314, 0.1130, 37824.72, '2026-01-01'),
('US-CA', 'sit', 2026, 'single', 'annual', 9, 721314,   NULL, 0.1230, 70428.27, '2026-01-01');

-- ============================================================
-- STATE: New York PIT 2026 (progressive — single, abbreviated)
-- ============================================================

INSERT INTO tax_tables (jurisdiction, tax_type, tax_year, filing_status, pay_frequency, bracket_order, bracket_low, bracket_high, rate, base_tax, effective_from) VALUES
('US-NY', 'sit', 2026, 'single', 'annual', 1,      0,   8500, 0.040, 0,       '2026-01-01'),
('US-NY', 'sit', 2026, 'single', 'annual', 2,   8500,  11700, 0.045, 340,     '2026-01-01'),
('US-NY', 'sit', 2026, 'single', 'annual', 3,  11700,  13900, 0.0525, 484,    '2026-01-01'),
('US-NY', 'sit', 2026, 'single', 'annual', 4,  13900,  80650, 0.055, 599.50,  '2026-01-01'),
('US-NY', 'sit', 2026, 'single', 'annual', 5,  80650, 215400, 0.060, 4270.63, '2026-01-01'),
('US-NY', 'sit', 2026, 'single', 'annual', 6, 215400, 1077550, 0.0685, 12355.63, '2026-01-01'),
('US-NY', 'sit', 2026, 'single', 'annual', 7, 1077550, 5000000, 0.0965, 71413.91, '2026-01-01'),
('US-NY', 'sit', 2026, 'single', 'annual', 8, 5000000, 25000000, 0.103, 449966.41, '2026-01-01'),
('US-NY', 'sit', 2026, 'single', 'annual', 9, 25000000,   NULL, 0.109, 2509966.41, '2026-01-01');
