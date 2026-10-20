'use strict';

const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const config = require('./config');
const schema = require('./schema');

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...config.db,
      waitForConnections: true,
      queueLimit: 0,
      charset: 'utf8mb4',
      timezone: 'Z',
      dateStrings: true,
      supportBigNumbers: true,
      enableKeepAlive: true,
    });
    // Keep DATETIME columns in UTC regardless of the server's local time zone.
    pool.pool.on('connection', (conn) => {
      conn.query("SET time_zone = '+00:00'");
    });
  }
  return pool;
}

async function query(sql, params) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

async function one(sql, params) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

// Runs fn while holding a MySQL named lock, so that only one process (web worker,
// cron call or CLI) runs a given job at a time. Returns { locked: false } if busy.
async function withLock(name, fn) {
  const conn = await getPool().getConnection();
  try {
    const [rows] = await conn.query('SELECT GET_LOCK(?, 0) AS got', [name]);
    if (!rows[0] || rows[0].got !== 1) return { locked: false };
    try {
      return { locked: true, result: await fn() };
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [name]).catch(() => {});
    }
  } finally {
    conn.release();
  }
}

async function migrate() {
  for (const stmt of schema) {
    await query(stmt);
  }
  const count = await one('SELECT COUNT(*) AS n FROM users');
  if (count.n === 0) {
    const { username, password } = config.defaultAdmin;
    await query(
      'INSERT INTO users (username, password_hash, is_admin, must_change_password) VALUES (?, ?, 1, 1)',
      [username, bcrypt.hashSync(password, 10)]
    );
    console.log(`[db] Created default user "${username}" with password "${password}". Change it after first login.`);
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, one, withLock, migrate, close };
