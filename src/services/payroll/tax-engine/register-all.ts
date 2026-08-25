import { taxRegistry } from './tax-registry.js';
import { MexicoIsrCalculator, MexicoSubsidioEmpleoCalculator } from '../mx/isr-calculator.js';
import { MexicoImssEmployeeCalculator, MexicoImssEmployerCalculator } from '../mx/imss-calculator.js';
import { MexicoInfonavitEmployerCalculator, MexicoInfonavitCreditCalculator } from '../mx/infonavit-calculator.js';
import { UsFederalFitCalculator } from '../usa/federal/fit-calculator.js';
import {
  UsFicaSocialSecurityCalculator,
  UsFicaMedicareCalculator,
  UsAdditionalMedicareCalculator,
  UsFicaSocialSecurityEmployerCalculator,
  UsFicaMedicareEmployerCalculator,
} from '../usa/federal/fica-calculator.js';
import { UsFutaCalculator } from '../usa/federal/futa-calculator.js';
import {
  UsStateSitCalculator,
  UsStateSutaCalculator,
  UsStateSdiCalculator,
} from '../usa/state/state-tax-calculator.js';
import { UsLocalTaxCalculator, US_LOCALITIES } from '../usa/local/local-tax-calculator.js';

// ============================================================
// Register all tax calculators
// Called once on module load.
// ============================================================

// Mexico
taxRegistry.register(new MexicoIsrCalculator());
taxRegistry.register(new MexicoSubsidioEmpleoCalculator());
taxRegistry.register(new MexicoImssEmployeeCalculator());
taxRegistry.register(new MexicoImssEmployerCalculator());
taxRegistry.register(new MexicoInfonavitEmployerCalculator());
taxRegistry.register(new MexicoInfonavitCreditCalculator());

// US Federal
taxRegistry.register(new UsFederalFitCalculator());
taxRegistry.register(new UsFicaSocialSecurityCalculator());
taxRegistry.register(new UsFicaMedicareCalculator());
taxRegistry.register(new UsAdditionalMedicareCalculator());
taxRegistry.register(new UsFicaSocialSecurityEmployerCalculator());
taxRegistry.register(new UsFicaMedicareEmployerCalculator());
taxRegistry.register(new UsFutaCalculator());

// All 50 states + DC
const STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA',
  'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY',
  'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX',
  'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];
for (const st of STATES) {
  taxRegistry.register(new UsStateSitCalculator(st));
  taxRegistry.register(new UsStateSutaCalculator(st));
  taxRegistry.register(new UsStateSdiCalculator(st));
}

// Local (city) taxes
for (const loc of US_LOCALITIES) {
  taxRegistry.register(new UsLocalTaxCalculator(loc.code, { residentOnly: loc.residentOnly }));
}

export { taxRegistry };
