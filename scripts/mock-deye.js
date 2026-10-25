'use strict';

// Mock DeyeCloud OpenAPI for local testing and demos. It simulates one hybrid inverter in
// Lebanon, consistently across latest and history endpoints: PV with zero export (panels are
// throttled when the battery is full), a 10 kWh battery, a grid with daily outages ("Kadisha")
// and a 10 A neighbourhood generator on the GEN port ("Eshtirak") that runs during them.
//
//   node scripts/mock-deye.js            (listens on http://localhost:4100/v1.0)
//
// Then in Settings use the custom base URL http://localhost:4100/v1.0,
// App ID "demo", App Secret "demo", email "demo@example.com", password "demo".
const crypto = require('crypto');
const express = require('express');

const PORT = parseInt(process.env.MOCK_PORT, 10) || 4100;
const TZ_OFFSET_H = 3; // Asia/Beirut in summer (the mock ignores DST)
const STATION_ID = 61234567;
const INVERTER_SN = '2306178452';
const LOGGER_SN = '3109876543';
const TOKEN = `mock-${crypto.randomBytes(8).toString('hex')}`;
const PASSWORD_SHA = crypto.createHash('sha256').update('demo').digest('hex');

const LAT = 33.8938;
const LNG = 35.5018;
const PV_KWP = 6.6;
const TILT = 25; // degrees, facing south
const INVERTER_W = 8000;
const BATTERY_KWH = 10.24;
const MIN_SOC = 15;
const CHARGE_MAX_W = 5000;
const DISCHARGE_MAX_W = 6000;
const RESERVE_SOC = 30; // the battery runs the home down to this, then the grid or generator takes over
const GRID_CHARGE_W = 3000;
const GEN_MAX_W = 2200; // a 10 A generator subscription
const ETA = 0.95; // one-way battery efficiency
const STEP = 300;
// The simulation is stateful (battery charge carries over), so it always starts from the same instant.
const ORIGIN = Date.UTC(2024, 0, 1) / 1000 - TZ_OFFSET_H * 3600;

const ok = (extra) => ({ code: '1000000', msg: 'success', success: true, requestId: crypto.randomBytes(8).toString('hex'), ...extra });
const fail = (code, msg) => ({ code, msg, success: false, requestId: crypto.randomBytes(8).toString('hex') });

// Deterministic pseudo-noise so history queries are repeatable.
function noise(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

const rad = Math.PI / 180;

// Sun elevation and incidence on the tilted panels (low-precision NOAA formulas).
function sun(ts) {
  const n = (ts - 946728000) / 86400; // days since J2000.0
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = ((280.46 + 0.9856474 * n) % 360 + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const ha = (gmst * 15 + LNG) * rad - ra;
  const lat = LAT * rad;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
  const cosInc = Math.sin(dec) * Math.sin(lat - TILT * rad) + Math.cos(dec) * Math.cos(lat - TILT * rad) * Math.cos(ha);
  return { sinEl, cosInc };
}

// 1 in mid-January, 0 in mid-July.
const winterness = (dayIdx) => 0.5 + 0.5 * Math.cos(((dayIdx - 14) / 365.25) * 2 * Math.PI);

function weather(dayIdx, ts) {
  const winter = winterness(dayIdx);
  const slot = Math.floor(ts / 900);
  if (noise(dayIdx * 1.37 + 5) > 0.06 + 0.42 * winter) {
    return 0.93 + 0.07 * noise(dayIdx + 0.5) - (noise(slot * 0.7) > 0.95 ? 0.35 : 0);
  }
  const depth = 0.12 + 0.45 * noise(dayIdx * 2.1 + 9);
  return Math.max(0.04, depth * (0.6 + 0.8 * noise(slot * 1.3 + dayIdx)));
}

function panelPower(ts, dayIdx) {
  const { sinEl, cosInc } = sun(ts);
  if (sinEl <= 0.01) return 0;
  const ghi = 1098 * sinEl * Math.exp(-0.057 / sinEl);
  const poa = ghi * (0.8 * Math.min(4, Math.max(0, cosInc) / sinEl) + 0.2 * ((1 + Math.cos(TILT * rad)) / 2));
  return Math.min(INVERTER_W, PV_KWP * poa * 0.8 * weather(dayIdx, ts));
}

function demand(ts, hour, dayIdx) {
  const winter = winterness(dayIdx);
  const summer = 1 - winter;
  let w = 240 + 120 * noise(Math.floor(ts / 600));
  if (hour >= 6.5 && hour < 8.5) w += 450;
  if (hour >= 12 && hour < 14) w += 250;
  if (hour >= 18 && hour < 23) w += 750;
  if (hour >= 17 && hour < 23 && winter > 0.6) w += 700 * (winter - 0.6) / 0.4; // heaters
  if (hour >= 11 && hour < 21 && summer > 0.55) w += 800 * (summer - 0.55) / 0.45; // air conditioning
  if (noise(Math.floor(ts / 300) + 3) > 0.95) w += 1800; // kettle, iron, water pump
  return w;
}

// Grid supply ("Kadisha"): alternating on/off blocks of a few hours, longer cuts in winter.
const gridDays = new Map();
function gridSlots(dayIdx) {
  if (gridDays.has(dayIdx)) return gridDays.get(dayIdx);
  const slots = new Uint8Array(96);
  let on = noise(dayIdx * 3.1) > 0.5;
  let i = Math.floor(noise(dayIdx * 4.7) * 8);
  if (on) slots.fill(1, 0, i);
  for (let k = 0; i < 96; k++) {
    const len = on ? 12 + Math.floor(noise(dayIdx * 5.3 + k) * 12) : 8 + Math.floor(noise(dayIdx * 6.1 + k) * (10 + 10 * winterness(dayIdx)));
    if (on) slots.fill(1, i, Math.min(96, i + len));
    i += len;
    on = !on;
  }
  gridDays.set(dayIdx, slots);
  return slots;
}

// ---------- stateful 5-minute simulation, computed once and cached ----------

const FIELDS = ['pv', 'pvPotential', 'gen', 'load', 'grid', 'battery', 'soc', 'gridOn', 'genOn'];
const CUMS = ['cPv', 'cGen', 'cLoad', 'cBuy', 'cCharge', 'cDischarge'];
const sim = { n: 0, cap: 0, energy: BATTERY_KWH * 0.5, totals: { pv: 0, buy: 0 } };

function grow(need) {
  if (need <= sim.cap) return;
  const cap = Math.max(need, Math.ceil(sim.cap * 1.5), 300000);
  for (const f of [...FIELDS, ...CUMS, 'tPv', 'tBuy']) {
    const arr = new Float64Array(cap);
    if (sim[f]) arr.set(sim[f]);
    sim[f] = arr;
  }
  sim.cap = cap;
}

function stepOnce(i) {
  const ts = ORIGIN + i * STEP;
  const local = ts + TZ_OFFSET_H * 3600;
  const hour = (local % 86400) / 3600;
  const dayIdx = Math.floor(local / 86400);
  const h = STEP / 3600;
  const potential = panelPower(ts + STEP / 2, dayIdx);
  const load = demand(ts, hour, dayIdx);
  const gridOn = gridSlots(dayIdx)[Math.floor(hour * 4)] === 1;
  const genOn = !gridOn && (hour >= 7 || hour < 1) && !(hour >= 15 && hour < 16 && noise(dayIdx + 77) > 0.5);

  let e = sim.energy;
  const socPct = (e / BATTERY_KWH) * 100;
  const roomW = Math.max(0, ((BATTERY_KWH - e) / h) * 1000) / ETA;
  const availW = Math.max(0, ((e - (BATTERY_KWH * MIN_SOC) / 100) / h) * 1000) * ETA;

  // Solar feeds the home first, then the battery; the rest is throttled (zero export).
  const pvToLoad = Math.min(potential, load);
  let deficit = load - pvToLoad;
  let charge = Math.min(potential - pvToLoad, CHARGE_MAX_W, roomW);
  const pv = pvToLoad + charge;
  // Battery first down to a reserve; below it the grid, else the generator, takes over.
  const reserveW = Math.max(0, ((e - (BATTERY_KWH * RESERVE_SOC) / 100) / h) * 1000) * ETA;
  let discharge = Math.min(deficit, reserveW, DISCHARGE_MAX_W);
  deficit -= discharge;
  let grid = 0;
  let gen = 0;
  if (gridOn) {
    grid = deficit;
    deficit = 0;
    if (socPct < RESERVE_SOC + 5) {
      const extra = Math.max(0, Math.min(GRID_CHARGE_W, CHARGE_MAX_W - charge, roomW - charge));
      charge += extra;
      grid += extra;
    }
  } else if (genOn) {
    gen = Math.min(deficit, GEN_MAX_W);
    deficit -= gen;
    if (socPct < RESERVE_SOC + 5) {
      const extra = Math.max(0, Math.min(GEN_MAX_W - gen, CHARGE_MAX_W - charge, roomW - charge));
      charge += extra;
      gen += extra;
    }
  }
  if (deficit > 0) {
    const more = Math.min(deficit, Math.max(0, availW - discharge), DISCHARGE_MAX_W - discharge);
    discharge += more;
    deficit -= more;
  }
  if (charge > 0 && discharge > 0) {
    const both = Math.min(charge, discharge);
    charge -= both;
    discharge -= both;
  }
  const served = load - deficit; // anything left over is a blackout
  e += ((charge * ETA - discharge / ETA) * h) / 1000;
  sim.energy = Math.min(BATTERY_KWH, Math.max(0, e));

  const newDay = i === 0 || Math.floor((local - STEP) / 86400) !== dayIdx;
  const prev = (f) => (i === 0 || newDay ? 0 : sim[f][i - 1]);
  const kwh = (w) => (w * h) / 1000;
  sim.pv[i] = pv;
  sim.pvPotential[i] = potential;
  sim.gen[i] = gen;
  sim.load[i] = served;
  sim.grid[i] = grid;
  sim.battery[i] = discharge - charge;
  sim.soc[i] = (sim.energy / BATTERY_KWH) * 100;
  sim.gridOn[i] = gridOn ? 1 : 0;
  sim.genOn[i] = genOn ? 1 : 0;
  sim.cPv[i] = prev('cPv') + kwh(pv);
  sim.cGen[i] = prev('cGen') + kwh(gen);
  sim.cLoad[i] = prev('cLoad') + kwh(served);
  sim.cBuy[i] = prev('cBuy') + kwh(grid);
  sim.cCharge[i] = prev('cCharge') + kwh(charge);
  sim.cDischarge[i] = prev('cDischarge') + kwh(discharge);
  sim.tPv[i] = (i ? sim.tPv[i - 1] : 0) + kwh(pv);
  sim.tBuy[i] = (i ? sim.tBuy[i - 1] : 0) + kwh(grid);
}

function stepIndex(ts) {
  return Math.max(0, Math.floor((ts - ORIGIN) / STEP));
}

function simulate(ts) {
  const i = stepIndex(ts);
  if (i >= sim.n) {
    grow(i + 1);
    for (let k = sim.n; k <= i; k++) stepOnce(k);
    sim.n = i + 1;
  }
  const local = ORIGIN + i * STEP + TZ_OFFSET_H * 3600;
  const r = { ts: ORIGIN + i * STEP, i, hour: (local % 86400) / 3600, dayIdx: Math.floor(local / 86400) };
  for (const f of [...FIELDS, ...CUMS, 'tPv', 'tBuy']) r[f] = sim[f][i];
  for (const f of ['pv', 'gen', 'load', 'grid', 'battery', 'soc']) r[f] = Math.round(r[f]);
  return r;
}

function dayStart(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000 - TZ_OFFSET_H * 3600;
}

// Daily kWh totals, up to now for today.
function dailyTotals(dateStr) {
  const last = Math.min(dayStart(dateStr) + 86400 - STEP, Math.floor(Date.now() / 1000));
  const s = simulate(last);
  const r = (v) => Math.round(v * 10) / 10;
  return { gen: r(s.cPv), generator: r(s.cGen), load: r(s.cLoad), buy: r(s.cBuy), sell: 0, charge: r(s.cCharge), discharge: r(s.cDischarge) };
}

function inverterPoints(ts) {
  const s = simulate(ts);
  const n = (seed, amp) => (noise(ts / 60 + seed) - 0.5) * amp;
  const vbat = 51.2 + (s.soc - 50) * 0.04 + n(1, 0.2);
  const v = (x) => (Math.round(x * 10) / 10).toString();
  return [
    ['SOC', s.soc, '%'],
    ['BatteryVoltage', v(vbat), 'V'],
    ['BatteryCurrent', v(s.battery / vbat), 'A'],
    ['BatteryPower', s.battery, 'W'],
    ['BatteryTemperature', v(24 + n(2, 2) + Math.abs(s.battery) / 1500), '℃'],
    ['BatteryStatus', s.battery < -30 ? 'Charging' : s.battery > 30 ? 'Discharging' : 'Static', ''],
    ['BMSVoltage', v(vbat + 0.1), 'V'],
    ['BMSCurrent', v(s.battery / vbat), 'A'],
    ['BMSTemperature', v(23 + n(3, 1)), '℃'],
    ['BMSSOC', s.soc, '%'],
    ['BMSChargeVoltage', '56.0', 'V'],
    ['BMSChargingCurrentLimit', '100', 'A'],
    ['BMSDischargeCurrentLimit', '100', 'A'],
    ['DCVoltagePV1', v(s.pv > 0 ? 380 + n(4, 15) : 0), 'V'],
    ['DCVoltagePV2', v(s.pv > 0 ? 365 + n(5, 15) : 0), 'V'],
    ['DCCurrentPV1', v((s.pv * 0.55) / 380), 'A'],
    ['DCCurrentPV2', v((s.pv * 0.45) / 365), 'A'],
    ['DCPowerPV1', Math.round(s.pv * 0.55), 'W'],
    ['DCPowerPV2', s.pv - Math.round(s.pv * 0.55), 'W'],
    ['TotalSolarPower', s.pv, 'W'],
    ['ACVoltageRUA', v(230 + n(6, 4)), 'V'],
    ['ACVoltageSVB', v(231 + n(7, 4)), 'V'],
    ['ACVoltageTWC', v(229 + n(8, 4)), 'V'],
    ['ACCurrentRUA', v(Math.abs(s.load) / 690), 'A'],
    ['ACCurrentSVB', v(Math.abs(s.load) / 700), 'A'],
    ['ACCurrentTWC', v(Math.abs(s.load) / 710), 'A'],
    ['ACOutputFrequencyR', (50 + n(9, 0.06)).toFixed(2), 'Hz'],
    ['TotalGridPower', s.grid, 'W'],
    ['GridFrequency', s.gridOn ? (50 + n(10, 0.06)).toFixed(2) : '0.00', 'Hz'],
    ['GridVoltageL1', v(s.gridOn ? 231 + n(11, 4) : 0), 'V'],
    ['GridVoltageL2', v(s.gridOn ? 230 + n(12, 4) : 0), 'V'],
    ['GridVoltageL3', v(s.gridOn ? 232 + n(13, 4) : 0), 'V'],
    ['ExternalCTPowerL1', Math.round(s.grid / 3), 'W'],
    ['ExternalCTPowerL2', Math.round(s.grid / 3), 'W'],
    ['ExternalCTPowerL3', s.grid - 2 * Math.round(s.grid / 3), 'W'],
    ['GenPower', s.gen, 'W'],
    ['GenVoltage', v(s.genOn ? 229 + n(17, 4) : 0), 'V'],
    ['DailyGenProduction', v(s.cGen), 'kWh'],
    ['TotalConsumptionPower', s.load, 'W'],
    ['LoadPowerL1', Math.round(s.load * 0.4), 'W'],
    ['LoadPowerL2', Math.round(s.load * 0.35), 'W'],
    ['LoadPowerL3', s.load - Math.round(s.load * 0.4) - Math.round(s.load * 0.35), 'W'],
    ['LoadVoltageL1', v(230 + n(14, 3)), 'V'],
    ['DailyActiveProduction', v(s.cPv), 'kWh'],
    ['TotalActiveProduction', v(18250 + s.tPv), 'kWh'],
    ['DailyEnergyBuy', v(s.cBuy), 'kWh'],
    ['DailyEnergySell', '0', 'kWh'],
    ['TotalEnergyBuy', v(5120 + s.tBuy), 'kWh'],
    ['TotalEnergySell', '7340', 'kWh'],
    ['DailyConsumption', v(s.cLoad), 'kWh'],
    ['DailyChargingEnergy', v(s.cCharge), 'kWh'],
    ['DailyDischargingEnergy', v(s.cDischarge), 'kWh'],
    ['ACTemperature', v(38 + s.pv / 800 + n(15, 1)), '℃'],
    ['DCTemperature', v(35 + s.pv / 900 + n(16, 1)), '℃'],
    ['RunningStatus', 'Normal', ''],
    ['GridStatus', s.gridOn ? 'Grid-connected' : 'Off-grid', ''],
    ['WorkMode', 'Zero export to CT', ''],
    ['RatedPower', String(INVERTER_W), 'W'],
  ];
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[mock] ${req.method} ${req.path}`);
  next();
});

const api = express.Router();
api.post('/account/token', (req, res) => {
  const b = req.body || {};
  if (req.query.appId !== 'demo' || b.appSecret !== 'demo') return res.json(fail('2101001', 'appId or appSecret is invalid'));
  if (b.password !== PASSWORD_SHA) return res.json(fail('2101019', 'Incorrect account or password'));
  res.json(ok({ accessToken: TOKEN, tokenType: 'bearer', expiresIn: '5183999', refreshToken: 'mock-refresh', scope: 'all', uid: 1 }));
});

api.use((req, res, next) => {
  if (req.get('Authorization') !== `bearer ${TOKEN}`) return res.status(401).json(fail('2101006', 'token is invalid or expired'));
  next();
});

api.post('/account/info', (req, res) => res.json(ok({ orgInfoList: [] })));

api.post('/station/list', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const s = simulate(now);
  res.json(
    ok({
      total: 1,
      stationList: [
        {
          id: STATION_ID,
          name: 'Home Solar (demo)',
          locationLat: 33.8938,
          locationLng: 35.5018,
          locationAddress: 'Beirut, Lebanon',
          regionNationId: 121,
          regionTimezone: 'Asia/Beirut',
          gridInterconnectionType: 'BATTERY_BACKUP',
          installedCapacity: PV_KWP,
          startOperatingTime: 1690000000,
          createdDate: 1690000000,
          batterySOC: s.soc,
          connectionStatus: 'NORMAL',
          generationPower: s.pv,
          lastUpdateTime: now - (now % 300),
          contactPhone: null,
          ownerName: 'Demo',
        },
      ],
    })
  );
});

api.post('/station/device', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  res.json(
    ok({
      total: 2,
      deviceListItems: [
        { deviceSn: INVERTER_SN, deviceId: 990001, stationId: STATION_ID, deviceType: 'INVERTER', productId: 'SUN-8K-SG04LP3-EU', connectStatus: 1, collectionTime: now - (now % 300) },
        { deviceSn: LOGGER_SN, deviceId: 990002, stationId: STATION_ID, deviceType: 'COLLECTOR', productId: 'LSW3', connectStatus: 1, collectionTime: now - (now % 300) },
      ],
    })
  );
});

// Station power fields as DeyeCloud reports them: generationPower is "Production", which counts the
// generator on the GEN port as well as PV; wirePower is the net grid power (+ buying / − exporting),
// purchasePower and gridPower are its buying and exporting sides, batteryPower is + discharging /
// − charging, and a field that is zero is left blank (null).
function stationPower(s) {
  const blank = (w) => (Math.abs(w) < 0.5 ? null : Math.round(w));
  return {
    generationPower: blank(s.pv + s.gen),
    consumptionPower: blank(s.load),
    wirePower: blank(s.grid),
    purchasePower: blank(Math.max(0, s.grid)),
    gridPower: blank(Math.max(0, -s.grid)),
    chargePower: blank(Math.max(0, -s.battery)),
    dischargePower: blank(Math.max(0, s.battery)),
    batteryPower: blank(s.battery),
    batterySOC: s.soc,
    irradiateIntensity: null,
  };
}

api.post('/station/latest', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const ts = now - (now % 300);
  const s = simulate(ts);
  res.json(
    ok({
      ...stationPower(s),
      lastUpdateTime: ts,
    })
  );
});

api.post('/station/history', (req, res) => {
  const { granularity, startAt, endAt } = req.body || {};
  // Same validation as the real API: frames need endAt, day ranges are limited to 30 days.
  if (!startAt || !endAt) return res.json(fail('1000002', 'invalid param'));
  if (granularity === 1) {
    const start = dayStart(startAt);
    const now = Math.floor(Date.now() / 1000);
    const items = [];
    for (let ts = start; ts < Math.min(start + 86400, now); ts += 300) {
      const s = simulate(ts);
      items.push({
        ...stationPower(s),
        timeStamp: ts,
      });
    }
    return res.json(ok({ total: items.length, stationDataItems: items }));
  }
  if (granularity === 2) {
    if ((dayStart(endAt) - dayStart(startAt)) / 86400 > 30) return res.json(fail('2101012', 'should be within 31 days'));
    const items = [];
    const today = new Date(Date.now() + TZ_OFFSET_H * 3600000).toISOString().slice(0, 10);
    // Ranges ending in a month that has not started yet come back empty.
    if (endAt.slice(0, 7) > today.slice(0, 7)) return res.json(ok({ total: 0, stationDataItems: [] }));
    for (let d = startAt; d < endAt && d <= today; ) {
      const t = dailyTotals(d);
      const [y, m, day] = d.split('-').map(Number);
      items.push({
        year: y,
        month: m,
        day,
        generationValue: t.gen,
        consumptionValue: t.load,
        gridValue: t.sell,
        purchaseValue: t.buy,
        chargeValue: t.charge,
        dischargeValue: t.discharge,
        fullPowerHours: Math.round((t.gen / PV_KWP) * 100) / 100,
      });
      const next = new Date(Date.UTC(y, m - 1, day + 1));
      d = next.toISOString().slice(0, 10);
    }
    return res.json(ok({ total: items.length, stationDataItems: items }));
  }
  res.json(fail('1000002', 'granularity not supported by mock'));
});

api.post('/device/latest', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const ts = now - (now % 300);
  const list = (req.body.deviceList || []).map((sn) => {
    if (sn === INVERTER_SN) {
      return {
        deviceSn: sn,
        deviceId: 990001,
        deviceType: 'INVERTER',
        deviceState: 1,
        collectionTime: ts,
        dataList: inverterPoints(ts).map(([key, value, unit]) => ({ key, value: String(value), unit })),
      };
    }
    return {
      deviceSn: sn,
      deviceId: 990002,
      deviceType: 'COLLECTOR',
      deviceState: 1,
      collectionTime: ts,
      dataList: [
        { key: 'SignalStrength', value: String(Math.round(70 + noise(ts) * 20)), unit: '%' },
        { key: 'FirmwareVersion', value: 'LSW3_15_FFFF_1.0.91R', unit: '' },
      ],
    };
  });
  res.json(ok({ deviceDataList: list }));
});

api.post('/device/measurePoints', (req, res) => {
  const sn = req.body.deviceSn;
  const keys = sn === INVERTER_SN ? inverterPoints(Math.floor(Date.now() / 1000)).map((p) => p[0]) : ['SignalStrength'];
  res.json(ok({ deviceSn: sn, deviceType: sn === INVERTER_SN ? 'INVERTER' : 'COLLECTOR', measurePoints: keys }));
});

api.post('/device/history', (req, res) => {
  const { deviceSn, granularity, startAt, measurePoints } = req.body || {};
  if (granularity !== 1) return res.json(fail('1000002', 'granularity not supported by mock'));
  if (!measurePoints || measurePoints.length > 5) return res.json(fail('1000002', 'list too long'));
  if (deviceSn !== INVERTER_SN) return res.json(ok({ deviceSn, deviceType: 'COLLECTOR', dataList: [] }));
  const wanted = new Set(measurePoints || []);
  const start = dayStart(startAt);
  const now = Math.floor(Date.now() / 1000);
  const dataList = [];
  for (let ts = start; ts < Math.min(start + 86400, now); ts += 300) {
    dataList.push({
      time: String(ts),
      itemList: inverterPoints(ts)
        .filter(([k]) => wanted.has(k))
        .map(([key, value, unit]) => ({ key, value: String(value), unit })),
    });
  }
  res.json(ok({ deviceSn, deviceType: 'INVERTER', dataList }));
});

app.use('/v1.0', api);
if (require.main === module) {
  app.listen(PORT, () => console.log(`[mock] DeyeCloud mock on http://localhost:${PORT}/v1.0  (appId/appSecret: demo, password: demo)`));
}
module.exports = { simulate, dailyTotals };
