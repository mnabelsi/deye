'use strict';

// Deye exposes hundreds of measure points whose names vary by inverter model, so
// categories are derived from key/unit patterns instead of a fixed list.

const STATION_LABELS = {
  generationPower: 'PV Generation Power',
  consumptionPower: 'Consumption Power',
  gridPower: 'Grid Power',
  purchasePower: 'Grid Purchase Power',
  wirePower: 'Grid Feed-in Power',
  chargePower: 'Battery Charge Power',
  dischargePower: 'Battery Discharge Power',
  batteryPower: 'Battery Power',
  batterySOC: 'Battery SOC',
  irradiateIntensity: 'Irradiance',
  generationValue: 'Generation (day)',
  consumptionValue: 'Consumption (day)',
  gridValue: 'Feed-in (day)',
  purchaseValue: 'Purchase (day)',
  chargeValue: 'Battery Charge (day)',
  dischargeValue: 'Battery Discharge (day)',
};

const STATION_UNITS = {
  generationPower: 'W',
  consumptionPower: 'W',
  gridPower: 'W',
  purchasePower: 'W',
  wirePower: 'W',
  chargePower: 'W',
  dischargePower: 'W',
  batteryPower: 'W',
  batterySOC: '%',
  irradiateIntensity: 'W/m²',
};

// Generator readings: "Gen"/"Generator" at a CamelCase word start, but not "Generation" (PV)
// and not words that merely contain "gen" such as "ChargingEnergy".
const GEN = /Generator|generator|Gen(?!erat)|^gen(?!erat)|GEN(?!ERAT)/;

// Order matters: the first matching rule wins.
const CATEGORY_RULES = [
  ['Temperature', /temp|℃|°c/i],
  ['Generator', GEN],
  ['Battery', /batt|bms|soc\b|^soc|charg|discharg/i],
  ['Solar', /pv\d*|solar|mppt|dcvoltage|dccurrent|dcpower|generation|production|irradia|^dc/i],
  ['Grid', /grid|^ct|ctpower|ctcurrent|buy|sell|purchase|feed|wire|meter|import|export|^external|^internal/i],
  ['Load', /load|consum|ups|backup|smartload/i],
  ['Inverter', /^ac|inverter|output|freq|rated|phase|power ?factor|inv/i],
  ['Status', /status|state|mode|fault|alarm|warn|error|code|version|protocol|sn$/i],
];

function categorize(key, unit, sourceType) {
  if (sourceType === 'station') {
    if (GEN.test(key)) return 'Generator';
    if (/generation|irradia/i.test(key)) return 'Solar';
    if (/batt|charge|soc/i.test(key)) return 'Battery';
    if (/grid|purchase|wire/i.test(key)) return 'Grid';
    if (/consumption/i.test(key)) return 'Load';
    return 'Station';
  }
  const hay = `${key} ${unit || ''}`;
  for (const [cat, re] of CATEGORY_RULES) {
    if (re.test(hay)) return cat;
  }
  return 'Other';
}

function humanize(key) {
  return String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function label(key, name, sourceType) {
  if (sourceType === 'station' && STATION_LABELS[key]) return STATION_LABELS[key];
  if (name && name !== key) return name;
  return humanize(key);
}

// Power-like keys that are integrated over time make sense as energy; used by the UI
// to choose sensible defaults.
function quantity(unit) {
  const u = String(unit || '').toLowerCase();
  if (u === 'w' || u === 'kw' || u === 'va' || u === 'var') return 'power';
  if (u === 'kwh' || u === 'wh' || u === 'mwh') return 'energy';
  if (u === 'v') return 'voltage';
  if (u === 'a') return 'current';
  if (u === 'hz') return 'frequency';
  if (u === '%') return 'percent';
  if (u.includes('℃') || u.includes('°')) return 'temperature';
  return 'other';
}

module.exports = { categorize, label, humanize, quantity, STATION_LABELS, STATION_UNITS };
