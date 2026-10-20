'use strict';

// Mock DeyeCloud OpenAPI for local testing and demos. It simulates one hybrid inverter
// with PV, battery and grid, consistently across latest and history endpoints.
//
//   node scripts/mock-deye.js            (listens on http://localhost:4100/v1.0)
//
// Then in Settings use the custom base URL http://localhost:4100/v1.0,
// App ID "demo", App Secret "demo", email "demo@example.com", password "demo".
const crypto = require('crypto');
const express = require('express');

const PORT = parseInt(process.env.MOCK_PORT, 10) || 4100;
const TZ_OFFSET_H = 3; // Asia/Beirut in summer
const STATION_ID = 61234567;
const INVERTER_SN = '2306178452';
const LOGGER_SN = '3109876543';
const TOKEN = `mock-${crypto.randomBytes(8).toString('hex')}`;
const PASSWORD_SHA = crypto.createHash('sha256').update('demo').digest('hex');

const ok = (extra) => ({ code: '1000000', msg: 'success', success: true, requestId: crypto.randomBytes(8).toString('hex'), ...extra });
const fail = (code, msg) => ({ code, msg, success: false, requestId: crypto.randomBytes(8).toString('hex') });

// Deterministic pseudo-noise so history queries are repeatable.
function noise(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function simulate(ts) {
  const local = ts + TZ_OFFSET_H * 3600;
  const hour = (local % 86400) / 3600;
  const dayIdx = Math.floor(local / 86400);
  const cloud = 0.65 + 0.35 * noise(dayIdx) - 0.25 * noise(Math.floor(ts / 900)) * (noise(dayIdx + 7) > 0.6 ? 1 : 0.2);
  const sun = hour > 6 && hour < 19 ? Math.sin(((hour - 6) / 13) * Math.PI) : 0;
  const pv = Math.max(0, Math.round(8200 * 0.85 * sun * cloud));
  const base = 450 + 250 * noise(Math.floor(ts / 600));
  const evening = hour > 18 && hour < 23 ? 1400 : 0;
  const morning = hour > 6.5 && hour < 8.5 ? 900 : 0;
  const spike = noise(Math.floor(ts / 300) + 3) > 0.93 ? 2200 : 0;
  const load = Math.round(base + evening + morning + spike);
  // Battery state of charge follows a smooth daily pattern.
  const soc = Math.round(Math.max(15, Math.min(100, 45 + 45 * Math.sin(((hour - 9) / 24) * 2 * Math.PI) + 5 * noise(dayIdx))));
  let battery = 0; // + discharge / - charge
  const surplus = pv - load;
  if (surplus > 0 && soc < 100) battery = -Math.min(surplus, 5000);
  else if (surplus < 0 && soc > 20) battery = Math.min(-surplus, 5000);
  const grid = load - pv - battery; // + import / - export
  const pv1 = Math.round(pv * 0.55);
  const pv2 = pv - pv1;
  return { ts, pv, pv1, pv2, load, battery: Math.round(battery), grid: Math.round(grid), soc, hour, dayIdx };
}

function dayStart(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000 - TZ_OFFSET_H * 3600;
}

function dailyTotals(dateStr) {
  const start = dayStart(dateStr);
  const t = { gen: 0, load: 0, buy: 0, sell: 0, charge: 0, discharge: 0 };
  for (let ts = start; ts < start + 86400; ts += 300) {
    const s = simulate(ts);
    const h = 300 / 3600 / 1000;
    t.gen += s.pv * h;
    t.load += s.load * h;
    if (s.grid > 0) t.buy += s.grid * h;
    else t.sell += -s.grid * h;
    if (s.battery < 0) t.charge += -s.battery * h;
    else t.discharge += s.battery * h;
  }
  const r = (v) => Math.round(v * 10) / 10;
  return { gen: r(t.gen), load: r(t.load), buy: r(t.buy), sell: r(t.sell), charge: r(t.charge), discharge: r(t.discharge) };
}

function inverterPoints(ts) {
  const s = simulate(ts);
  const today = new Date((ts + TZ_OFFSET_H * 3600) * 1000).toISOString().slice(0, 10);
  const d = dailyTotals(today);
  const frac = Math.min(1, s.hour / 24);
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
    ['DCVoltagePV1', v(s.pv1 > 0 ? 380 + n(4, 15) : 0), 'V'],
    ['DCVoltagePV2', v(s.pv2 > 0 ? 365 + n(5, 15) : 0), 'V'],
    ['DCCurrentPV1', v(s.pv1 > 0 ? s.pv1 / 380 : 0), 'A'],
    ['DCCurrentPV2', v(s.pv2 > 0 ? s.pv2 / 365 : 0), 'A'],
    ['DCPowerPV1', s.pv1, 'W'],
    ['DCPowerPV2', s.pv2, 'W'],
    ['TotalSolarPower', s.pv, 'W'],
    ['ACVoltageRUA', v(230 + n(6, 4)), 'V'],
    ['ACVoltageSVB', v(231 + n(7, 4)), 'V'],
    ['ACVoltageTWC', v(229 + n(8, 4)), 'V'],
    ['ACCurrentRUA', v(Math.abs(s.load) / 690), 'A'],
    ['ACCurrentSVB', v(Math.abs(s.load) / 700), 'A'],
    ['ACCurrentTWC', v(Math.abs(s.load) / 710), 'A'],
    ['ACOutputFrequencyR', (50 + n(9, 0.06)).toFixed(2), 'Hz'],
    ['TotalGridPower', s.grid, 'W'],
    ['GridFrequency', (50 + n(10, 0.06)).toFixed(2), 'Hz'],
    ['GridVoltageL1', v(231 + n(11, 4)), 'V'],
    ['GridVoltageL2', v(230 + n(12, 4)), 'V'],
    ['GridVoltageL3', v(232 + n(13, 4)), 'V'],
    ['ExternalCTPowerL1', Math.round(s.grid / 3), 'W'],
    ['ExternalCTPowerL2', Math.round(s.grid / 3), 'W'],
    ['ExternalCTPowerL3', s.grid - 2 * Math.round(s.grid / 3), 'W'],
    ['TotalConsumptionPower', s.load, 'W'],
    ['LoadPowerL1', Math.round(s.load * 0.4), 'W'],
    ['LoadPowerL2', Math.round(s.load * 0.35), 'W'],
    ['LoadPowerL3', s.load - Math.round(s.load * 0.4) - Math.round(s.load * 0.35), 'W'],
    ['LoadVoltageL1', v(230 + n(14, 3)), 'V'],
    ['DailyActiveProduction', v(d.gen * frac), 'kWh'],
    ['TotalActiveProduction', v(18250 + s.dayIdx * 0.01 + d.gen * frac), 'kWh'],
    ['DailyEnergyBuy', v(d.buy * frac), 'kWh'],
    ['DailyEnergySell', v(d.sell * frac), 'kWh'],
    ['TotalEnergyBuy', v(5120 + d.buy * frac), 'kWh'],
    ['TotalEnergySell', v(7340 + d.sell * frac), 'kWh'],
    ['DailyConsumption', v(d.load * frac), 'kWh'],
    ['DailyChargingEnergy', v(d.charge * frac), 'kWh'],
    ['DailyDischargingEnergy', v(d.discharge * frac), 'kWh'],
    ['ACTemperature', v(38 + s.pv / 800 + n(15, 1)), '℃'],
    ['DCTemperature', v(35 + s.pv / 900 + n(16, 1)), '℃'],
    ['RunningStatus', 'Normal', ''],
    ['GridStatus', 'Grid-connected', ''],
    ['WorkMode', 'Zero export to CT', ''],
    ['RatedPower', '8000', 'W'],
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
          installedCapacity: 8.2,
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

api.post('/station/latest', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const ts = now - (now % 300);
  const s = simulate(ts);
  res.json(
    ok({
      generationPower: s.pv,
      consumptionPower: s.load,
      gridPower: s.grid,
      purchasePower: Math.max(0, s.grid),
      wirePower: Math.max(0, -s.grid),
      chargePower: Math.max(0, -s.battery),
      dischargePower: Math.max(0, s.battery),
      batteryPower: s.battery,
      batterySOC: s.soc,
      irradiateIntensity: null,
      lastUpdateTime: ts,
    })
  );
});

api.post('/station/history', (req, res) => {
  const { granularity, startAt, endAt } = req.body || {};
  if (granularity === 1) {
    const start = dayStart(startAt);
    const now = Math.floor(Date.now() / 1000);
    const items = [];
    for (let ts = start; ts < Math.min(start + 86400, now); ts += 300) {
      const s = simulate(ts);
      items.push({
        generationPower: s.pv,
        consumptionPower: s.load,
        gridPower: s.grid,
        purchasePower: Math.max(0, s.grid),
        wirePower: Math.max(0, -s.grid),
        chargePower: Math.max(0, -s.battery),
        dischargePower: Math.max(0, s.battery),
        batteryPower: s.battery,
        batterySOC: s.soc,
        irradiateIntensity: null,
        timeStamp: ts,
      });
    }
    return res.json(ok({ total: items.length, stationDataItems: items }));
  }
  if (granularity === 2) {
    const items = [];
    const today = new Date(Date.now() + TZ_OFFSET_H * 3600000).toISOString().slice(0, 10);
    for (let d = startAt; d < endAt && items.length < 31 && d <= today; ) {
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
        fullPowerHours: Math.round((t.gen / 8.2) * 100) / 100,
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
app.listen(PORT, () => console.log(`[mock] DeyeCloud mock on http://localhost:${PORT}/v1.0  (appId/appSecret: demo, password: demo)`));
