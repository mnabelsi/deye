'use strict';

// The latest snapshot of every station (readings, today's energy, power-flow settings, inverter
// settings) in the shape the Overview page works with. Automations use the same snapshot and the
// same power-flow rules (public/js/flow.js), so "grid on" or "battery at 30 %" means the same thing
// on the Overview and in an automation.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const settings = require('./settings');
const catalog = require('./metrics-catalog');

function toMetric(r) {
  return {
    id: r.id,
    sourceType: r.source_type,
    sourceId: r.source_id,
    key: r.mkey,
    label: catalog.label(r.mkey, r.name, r.source_type),
    unit: r.unit || '',
    kind: r.value_kind,
    category: catalog.categorize(r.mkey, r.unit, r.source_type),
    quantity: catalog.quantity(r.unit),
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    lastValue: r.value_kind === 'number' ? r.last_value_num : r.last_value_text,
  };
}

async function liveStations() {
  const stations = await db.query('SELECT * FROM stations WHERE enabled = 1 ORDER BY name');
  const metrics = await db.query(
    "SELECT * FROM metrics WHERE source_type = 'station' OR (source_type = 'device' AND source_id IN (SELECT sn FROM devices WHERE enabled = 1))"
  );
  const devices = await db.query('SELECT sn, station_id, device_type, connect_status, last_ts FROM devices WHERE enabled = 1');
  const today = await db.query(
    `SELECT station_id, mkey, value, day FROM daily_energy
      WHERE day = (SELECT MAX(day) FROM daily_energy d2 WHERE d2.station_id = daily_energy.station_id)`
  );
  const all = await settings.loadAll();
  const out = stations.map((s) => {
    const id = String(s.id);
    let flowMap = {};
    try {
      flowMap = JSON.parse(all[`flow_map:${id}`] || '{}');
    } catch {
      flowMap = {};
    }
    const values = {};
    const metricIds = {};
    const stationMetrics = [];
    for (const m of metrics) {
      if (m.source_type === 'station' && m.source_id === id) {
        values[m.mkey] = m.value_kind === 'number' ? m.last_value_num : m.last_value_text;
        metricIds[m.mkey] = m.id;
        stationMetrics.push(toMetric(m));
      }
    }
    const energy = {};
    let energyDay = null;
    for (const e of today) {
      if (String(e.station_id) === id) {
        energy[e.mkey] = e.value;
        energyDay = e.day;
      }
    }
    const devs = devices
      .filter((d) => String(d.station_id) === id)
      .map((d) => {
        const dm = metrics.filter((m) => m.source_type === 'device' && m.source_id === d.sn);
        // The merged inverter settings; raw answers stay on the Inverter page.
        let config = null;
        try {
          const c = JSON.parse(all[`device_config:${d.sn}`] || 'null');
          config = c && { at: c.at, battery: c.battery, system: c.system, tou: c.tou };
        } catch {
          config = null;
        }
        return {
          sn: d.sn,
          type: d.device_type,
          connectStatus: d.connect_status,
          lastTs: d.last_ts,
          metrics: dm.map(toMetric),
          config,
        };
      });
    return {
      id,
      name: s.name || `Station ${id}`,
      timezone: s.timezone,
      lat: s.lat,
      lng: s.lng,
      installedCapacity: s.installed_capacity,
      lastTs: s.last_ts,
      values,
      metricIds,
      metrics: stationMetrics,
      energy,
      energyDay,
      flowMap,
      devices: devs,
    };
  });
  return { stations: out, serverTime: Math.floor(Date.now() / 1000) };
}

// public/js/flow.js is a browser module with no imports; loading it from a data: URL lets the
// server run the very same code without a build step.
let flowModule = null;
async function flow() {
  if (!flowModule) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'flow.js'), 'utf8');
    flowModule = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  }
  return flowModule;
}

module.exports = { liveStations, toMetric, flow };
