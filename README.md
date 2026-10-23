# Deye Solar Monitor

A self-hosted web dashboard for **Deye inverters**. It reads your system through the official
[DeyeCloud OpenAPI](https://developer.deyecloud.com/api), stores **every measure point** the API
exposes in your own **MySQL** database, and lets you explore the full history with interactive charts.

Built with plain **Node.js + Express** (no build step) so it deploys as-is on **Hostinger** Node.js hosting.

![Overview](docs/screenshots/overview-dark.png)

## Features

- **Live overview** – PV, home load, grid import/export, generator input, battery charge/discharge and SOC,
  an animated power-flow diagram, today's energy totals and a zoomable day chart (browse any past day).
  Readings are matched automatically; admins can pick the exact reading behind each node with **Customize**.
- **Charts explorer** – pick any of the readings your inverter reports (voltages, currents, temperatures,
  per-MPPT power, BMS data, counters…), grouped and searchable by Solar / Battery / Grid / Load / Inverter / Temperature / Status.
  - Time ranges (6 h → 1 year, or custom), resolution (raw, 5 min … 1 day) and aggregation (avg / min / max).
  - Mouse-wheel / pinch zoom, drag to pan, box zoom, range slider; zooming in automatically loads finer data.
  - Click a series pill to hide/show it; readings with different units are drawn as stacked, synchronised panels.
  - Line / area / step / bar styles, table view, CSV export, shareable links, and saved views per user.
- **Energy** – daily / monthly / yearly totals of what you care about: solar, grid, generator and consumption,
  each source's share of supply, and self-sufficiency (battery charge/discharge and export can be switched on).
  Generator energy is worked out from its stored power readings, since DeyeCloud's daily statistics have none.
- **Battery insights** – from your stored hourly history (e.g. the last 12 months), the battery size you would need to be
  fully self-sufficient on solar, to never need the generator (solar + grid), or to never need the grid (solar +
  generator). Shows how much each size covers, how your current battery (estimated from the data) does, night use,
  hours each source had power, and solar lost because the battery was full. See [How battery sizing works](#how-battery-sizing-works).
- **Your names for each source** – call the grid and generator what you call them (e.g. *Kadisha* and *Eshtirak*) in
  Overview → **Customize**; every page uses those names.
- **Devices & readings** – every station and device (inverter, logger, meter, battery…) with all current
  values, and a log of state changes (running mode, battery status, faults…).
- **Complete history** – polls DeyeCloud every few minutes, **imports past history** from DeyeCloud
  day by day, and **fills gaps automatically** if the app was asleep.
- **Accounts** – login with default **`admin` / `123456`** (change it on first login), extra users (admin or viewer).
- Light & dark themes, works on phones.

## Quick start (local)

Requirements: Node.js 18+ and a MySQL or MariaDB database.

```bash
npm install
cp .env.example .env        # then fill in DB_HOST, DB_NAME, DB_USER, DB_PASSWORD
npm start                   # http://localhost:3000  → sign in with admin / 123456
```

Tables are created automatically on first start. Open **Settings → DeyeCloud connection**, enter your
credentials, press **Test connection**, then **Save connection**.

### Try it without an inverter

A mock DeyeCloud server simulating a hybrid system is included:

```bash
npm run mock    # starts http://localhost:4100/v1.0
```

In Settings choose **Data center → Custom URL…** `http://localhost:4100/v1.0`, App ID `demo`,
App Secret `demo`, email `demo@example.com`, password `demo`. Then import some history (a year for Battery insights).
The mock models a 6.6 kWp zero-export system with a 10.24 kWh battery, a grid with daily outages and a 10 A
generator on the GEN port, so the battery-sizing results can be checked against known values.

## Deploying on Hostinger

These steps use Hostinger's **Node.js Web App** hosting (available on Business and Cloud plans).

### 1. Create the MySQL database

hPanel → **Websites → Dashboard → Databases → Management**. Enter a database name, user and password,
then click **Create**. Write down the full names. Hostinger prefixes them, e.g. `u123456789_deye`.

### 2. Create the Node.js app

1. hPanel → **Websites → Add Website → Node.js web app**.
2. Choose **Import Git repository** and select this repository and branch, or **Upload your files**
   with a `.zip` of this folder. Leave out `node_modules` and `.env`.
3. Build settings:
   | Setting | Value |
   |---|---|
   | Framework preset | **Express** (or **Other**) |
   | Node.js version | **20** or **22** |
   | Build command | *(leave empty)* |
   | Entry file | **`server.js`** |
4. **Environment variables**: add the following (or use **Import .env** with a filled-in copy of `.env.example`):
   ```
   DB_HOST=localhost
   DB_PORT=3306
   DB_NAME=u123456789_deye
   DB_USER=u123456789_deye
   DB_PASSWORD=your-database-password
   ```
5. Click **Deploy**. When it shows **Running**, open your domain.

### 3. First login and DeyeCloud setup

1. Sign in with **`admin` / `123456`** and change the password (Settings → *Change your password*).
2. Create an application in the [DeyeCloud developer portal](https://developer.deyecloud.com/app) to get
   an **App ID** and **App Secret**.
3. Settings → **DeyeCloud connection**:
   - **Data center**: *eu1* (Europe/Asia/Africa) or *us1* (Americas). Use the one your
     deyecloud.com account is registered on.
   - App ID, App Secret, and the email (or username or mobile) and password you use on deyecloud.com.
   - *Company ID* only for business (installer) accounts. Leave it empty for a personal account.
   - **Test connection**, then **Save connection**. Stations and devices are discovered immediately.
4. Settings → **Import history**: pick a start date (e.g. the day your system was installed) and press
   **Import**. History is downloaded in the background and resumes after restarts.

### 4. Add a cron job (recommended)

Shared hosting can idle Node.js apps that get no visitors, which pauses the built-in scheduler. Missed periods
are re-imported automatically when it wakes up, but a cron job keeps collection continuous:

hPanel → **Advanced → Cron Jobs** → *Custom*, every 5 minutes (`*/5 * * * *`), with the command shown on the
Settings page, for example:

```
wget -q -O /dev/null "https://your-domain.com/api/cron/collect?key=YOUR_KEY"
```

The cron call and the built-in scheduler share a database lock, so they never run twice at once.

### Updating

Push to the connected branch (or upload a new zip) and redeploy from hPanel. Your data and settings live in
MySQL and are not affected. To restart manually, use the **Running** badge, or over SSH run `touch tmp/restart.txt`
in the app folder.

## Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)). Only the database
settings are required; everything else is managed on the Settings page.

| Variable | Default | Purpose |
|---|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | – | MySQL connection (or `DATABASE_URL=mysql://user:pass@host:3306/db`) |
| `PORT` | `3000` | HTTP port (set by Hostinger) |
| `SESSION_SECRET` | auto | Cookie signing key; generated and stored in MySQL if empty |
| `CRON_KEY` | auto | Key for `/api/cron/collect`; generated if empty |
| `DISABLE_SCHEDULER` | `0` | `1` = collect only via cron / CLI |
| `DEYE_*` | – | Optional DeyeCloud defaults (`DEYE_BASE_URL`, `DEYE_APP_ID`, `DEYE_APP_SECRET`, `DEYE_EMAIL`, `DEYE_PASSWORD`, …) |

Command-line helpers (e.g. over SSH):

```bash
npm run collect                              # one collection now (add -- --force to ignore the interval)
node scripts/backfill.js 2025-01-01 2025-06-30   # import a date range and wait until it is finished
```

## How it works

```
DeyeCloud OpenAPI ──► collector (every N min + history queue) ──► MySQL ──► REST API ──► dashboard (ECharts)
```

DeyeCloud endpoints used: `/account/token`, `/station/list`, `/station/device`, `/station/latest`,
`/station/history` (frames and daily totals), `/device/latest`, `/device/measurePoints`, `/device/history`.

The app only **reads** data. It never sends control commands to your inverter.

### Database tables

| Table | Contents |
|---|---|
| `stations`, `devices` | Discovered plants and devices (raw API data kept as JSON) |
| `metrics` | One row per measure point per station/device, with its unit and latest value |
| `readings` | Numeric time series `(metric_id, ts, value)`. The primary key de-duplicates samples |
| `text_readings` | Text values (modes, states, faults), stored only when they change |
| `daily_energy` | Daily kWh totals per station |
| `backfill_queue` | Resumable history-import jobs |
| `collector_runs` | Collector log (kept 30 days) |
| `users`, `settings` | Accounts, preferences and configuration |

**Storage estimate:** a hybrid inverter reports roughly 60–150 numeric readings. At 5-minute polling that is
about 20–45k rows a day, roughly 1–2 MB/day or 0.4–0.7 GB/year per inverter. Set *Keep readings for* in
Settings if your hosting plan has a database size limit.

## How battery sizing works

The **Battery insights** page replays every stored hour of the chosen period with a battery of a given size:

1. Solar feeds the home first; the battery covers any shortfall; while an allowed source (grid or generator) has
   power it runs the home and recharges the battery, at up to the charging limit set under *Assumptions*. Whatever is
   still missing would have needed the source you want to drop. The smallest battery that leaves nothing missing is
   the answer (found by bisection). The period is replayed twice so the battery does not start with free charge.
2. **Throttled solar.** With zero export the inverter throttles the panels once the battery is full, so measured
   solar understates what a bigger battery could store. In those hours the possible output is estimated from the
   sun's position at the station's location (from DeyeCloud), this array's output in unthrottled hours and that
   day's weather.
3. **When each source had power** comes from its voltage reading (picked automatically; override in Overview →
   Customize). Without one, on-hours are taken from when the source delivered power, which undercounts them.
4. **Your current battery** is estimated from how far the state of charge drops per kWh discharged; you can enter
   the real size instead.

Results are sizes to buy (rated kWh), using a usable share (90% for LiFePO4), 90% round-trip efficiency and 0.5C
charging by default. The analysis uses hourly averages, so check separately that the inverter and battery can deliver
your peak power. It needs hourly history: import the period first (Settings → Import history, or the button on the
page). The model is plain JavaScript in `public/js/insights-model.js` and runs in the browser.

## Security notes

- Change the default `admin` / `123456` password straight away. The dashboard reminds you until you do.
- Passwords are hashed with bcrypt. Sessions are HMAC-signed, HTTP-only, SameSite cookies, and changing
  a password signs out its old sessions. Login attempts are rate-limited.
- The DeyeCloud password is stored only as the SHA-256 hash the API requires. App Secret and password are never
  returned to the browser.
- Serve the site over HTTPS (Hostinger provides free SSL).

## Troubleshooting

- **"Cannot initialise database" in Runtime Logs**: check the `DB_*` variables, and use `localhost` as host.
- **DeyeCloud sign-in failed**: check the data center (eu1 vs us1), App ID/Secret, and that the account
  has been granted to your developer app. Business accounts may need the Company ID.
- **No new data**: see Settings → *Collector activity* for errors, and make sure the cron job is set.
- **Gaps in charts**: the logger was offline or the app was asleep. Auto gap-fill re-imports missed
  days, or use *Import history* for a range.

DeyeCloud API support: cloudservice@deye.com.cn
