'use strict';

// Every statement is idempotent so the schema can be applied on each boot.
// Timestamps for readings are stored as UNIX epoch seconds (UTC).
module.exports = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    username VARCHAR(64) NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    is_admin TINYINT(1) NOT NULL DEFAULT 1,
    must_change_password TINYINT(1) NOT NULL DEFAULT 0,
    prefs MEDIUMTEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_username (username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS settings (
    name VARCHAR(64) NOT NULL,
    value MEDIUMTEXT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS stations (
    id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(255) NULL,
    address VARCHAR(512) NULL,
    lat DOUBLE NULL,
    lng DOUBLE NULL,
    timezone VARCHAR(64) NULL,
    installed_capacity DOUBLE NULL,
    grid_type VARCHAR(64) NULL,
    connection_status VARCHAR(32) NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    last_ts INT UNSIGNED NULL,
    raw MEDIUMTEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS devices (
    sn VARCHAR(64) NOT NULL,
    station_id BIGINT UNSIGNED NULL,
    device_id BIGINT NULL,
    device_type VARCHAR(32) NULL,
    product_id VARCHAR(64) NULL,
    connect_status VARCHAR(32) NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    last_ts INT UNSIGNED NULL,
    raw MEDIUMTEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (sn),
    KEY idx_devices_station (station_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // One row per (source, measure point). "source" is a station or a device.
  `CREATE TABLE IF NOT EXISTS metrics (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    source_type VARCHAR(16) NOT NULL,
    source_id VARCHAR(64) NOT NULL,
    mkey VARCHAR(128) NOT NULL,
    name VARCHAR(191) NULL,
    unit VARCHAR(32) NULL,
    value_kind VARCHAR(8) NOT NULL DEFAULT 'number',
    first_ts INT UNSIGNED NULL,
    last_ts INT UNSIGNED NULL,
    last_value_num DOUBLE NULL,
    last_value_text VARCHAR(255) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_metrics_source_key (source_type, source_id, mkey)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Numeric time series. Primary key doubles as the query index and de-duplicates samples.
  `CREATE TABLE IF NOT EXISTS readings (
    metric_id INT UNSIGNED NOT NULL,
    ts INT UNSIGNED NOT NULL,
    value DOUBLE NOT NULL,
    PRIMARY KEY (metric_id, ts)
  ) ENGINE=InnoDB`,

  // Text values (states, modes, fault codes) are stored only when they change.
  `CREATE TABLE IF NOT EXISTS text_readings (
    metric_id INT UNSIGNED NOT NULL,
    ts INT UNSIGNED NOT NULL,
    value VARCHAR(255) NOT NULL,
    PRIMARY KEY (metric_id, ts)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Daily energy totals per station (kWh), from /station/history granularity=2.
  `CREATE TABLE IF NOT EXISTS daily_energy (
    station_id BIGINT UNSIGNED NOT NULL,
    day DATE NOT NULL,
    mkey VARCHAR(64) NOT NULL,
    value DOUBLE NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (station_id, day, mkey)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Resumable work queue for importing history from DeyeCloud (survives restarts).
  `CREATE TABLE IF NOT EXISTS backfill_queue (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    kind VARCHAR(24) NOT NULL,
    target VARCHAR(64) NOT NULL,
    day DATE NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'pending',
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    rows_added INT UNSIGNED NOT NULL DEFAULT 0,
    message VARCHAR(512) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_backfill (kind, target, day),
    KEY idx_backfill_status (status, day)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS collector_runs (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    kind VARCHAR(24) NOT NULL,
    trigger_source VARCHAR(24) NULL,
    started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    finished_at DATETIME(3) NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'running',
    readings_added INT UNSIGNED NOT NULL DEFAULT 0,
    message TEXT NULL,
    PRIMARY KEY (id),
    KEY idx_runs_started (started_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];
