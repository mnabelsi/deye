'use strict';

// Inverter settings page: everyone signed in can see them; only admins can read them from the
// inverter on demand or change them.
const express = require('express');
const auth = require('../auth');
const settings = require('../settings');
const inverter = require('../inverter');
const { DeyeClient } = require('../deye/client');

const router = express.Router();

async function client() {
  const cfg = await settings.getDeyeConfig();
  if (!settings.isDeyeConfigured(cfg)) {
    const err = new Error('DeyeCloud credentials are not configured');
    err.status = 400;
    throw err;
  }
  return new DeyeClient(cfg);
}

// Sends queued changes in the background (one loop per process; a database lock covers the
// others). The page polls GET / for progress; the collector also carries on with them.
let sending = false;
async function kick() {
  if (sending) return;
  sending = true;
  try {
    await inverter.processCommands(await client(), 120000);
  } catch (err) {
    console.error('[inverter] sending changes failed:', err.message);
  } finally {
    sending = false;
  }
}

function toCommand(r) {
  const parse = (v) => {
    try {
      return v === null ? null : JSON.parse(v);
    } catch {
      return v;
    }
  };
  return {
    id: r.id,
    field: r.field,
    label: (inverter.FIELDS[r.field] || {}).label || r.field,
    oldValue: parse(r.old_value),
    newValue: parse(r.new_value),
    status: r.status,
    orderId: r.order_id,
    message: r.message,
    user: r.username,
    createdTs: r.created_ts,
    sentTs: r.sent_ts,
    doneTs: r.done_ts,
  };
}

const isOpen = (c) => c.status === 'pending' || c.status === 'sent';

router.get('/', async (req, res) => {
  const list = [];
  for (const d of await inverter.inverters()) {
    list.push({
      sn: d.sn,
      stationId: d.station_id,
      stationName: d.station_name,
      timezone: d.timezone,
      productId: d.product_id,
      type: d.device_type,
      connectStatus: d.connect_status,
      settings: await inverter.load(d.sn),
      commands: (await inverter.commands(d.sn)).map(toCommand),
    });
  }
  if (list.some((x) => x.commands.some(isOpen))) kick();
  res.json({ inverters: list, fields: inverter.fieldInfo(), canEdit: Boolean(req.user.is_admin) });
});

router.use(auth.requireAdmin);

// Reads the settings now: DeyeCloud's stored copy and a live read from the inverter.
router.post('/:sn/read', async (req, res) => {
  const sn = String(req.params.sn);
  if (!(await inverter.inverters()).some((d) => d.sn === sn)) return res.status(404).json({ error: 'Inverter not found' });
  res.json({ settings: await inverter.readSettings(await client(), sn, { waitMs: 15000 }) });
});

// Queues changes; they are sent one at a time and followed until the inverter confirms them.
router.post('/:sn/changes', async (req, res) => {
  const sn = String(req.params.sn);
  await client(); // fail early when DeyeCloud isn't configured
  const queued = await inverter.queueChanges(sn, req.body && req.body.changes, req.user);
  if (queued) kick();
  res.json({ queued, commands: (await inverter.commands(sn)).map(toCommand) });
});

module.exports = router;
