// db.js — wa-sqlite + IDBBatchAtomicVFS (GitHub Pages kompatibilno)
// API identičan tracker-pwa verziji — app.js se ne mijenja

import SQLiteESMFactory from 'https://cdn.jsdelivr.net/npm/wa-sqlite@1.0.0/dist/wa-sqlite-async.mjs';
import * as SQLite from 'https://cdn.jsdelivr.net/npm/wa-sqlite@1.0.0/src/sqlite-api.js';
import { IDBBatchAtomicVFS } from 'https://cdn.jsdelivr.net/npm/wa-sqlite@1.0.0/src/examples/IDBBatchAtomicVFS.js';

const DB_FILE = 'tracker_v2.db';
let _db  = null;
let _sql = null;

async function getDb() {
  if (_db) return { db: _db, sql: _sql };

  const module = await SQLiteESMFactory();
  _sql = SQLite.Factory(module);

  const vfs = new IDBBatchAtomicVFS('tracker-idb');
  _sql.vfs_register(vfs, true);

  _db = await _sql.open_v2(
    DB_FILE,
    SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE,
    'idb-batch-atomic'
  );

  await exec(`
    CREATE TABLE IF NOT EXISTS daily_values (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      button_id TEXT NOT NULL,
      date      TEXT NOT NULL,
      value     INTEGER NOT NULL DEFAULT 0,
      UNIQUE(button_id, date)
    );
    CREATE TABLE IF NOT EXISTS log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp  TEXT NOT NULL,
      type       TEXT NOT NULL,
      button_id  TEXT,
      delta      INTEGER,
      text_value TEXT,
      deleted    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_log_ts      ON log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_log_deleted ON log(deleted);
    CREATE INDEX IF NOT EXISTS idx_dv_btn_date ON daily_values(button_id, date);
  `);

  return { db: _db, sql: _sql };
}

async function exec(sql, params = []) {
  const { db, sql: s } = await getDb();
  const rows = [];
  for await (const stmt of s.statements(db, sql)) {
    if (params.length) s.bind(stmt, params);
    while (await s.step(stmt) === SQLite.SQLITE_ROW) {
      const row = {};
      const cols = s.column_names(stmt);
      cols.forEach((c, i) => row[c] = s.column(stmt, i));
      rows.push(row);
    }
  }
  return rows;
}

// ─── HELPERS ─────────────────────────────────────────────────

export function dateKey(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─── DAILY VALUES ────────────────────────────────────────────

export async function getValue(buttonId, date) {
  const key  = dateKey(date);
  const rows = await exec('SELECT value FROM daily_values WHERE button_id=? AND date=?', [buttonId, key]);
  return rows.length ? rows[0].value : 0;
}

export async function getValuesForDate(date) {
  const key  = dateKey(date);
  const rows = await exec('SELECT button_id, value FROM daily_values WHERE date=?', [key]);
  const res  = {};
  rows.forEach(r => res[r.button_id] = r.value);
  return res;
}

export async function changeValue(buttonId, date, delta) {
  const key     = dateKey(date);
  const current = await getValue(buttonId, date);
  const newVal  = Math.max(0, Math.min(999, current + delta));
  await exec(
    `INSERT INTO daily_values(button_id, date, value) VALUES(?,?,?)
     ON CONFLICT(button_id, date) DO UPDATE SET value=excluded.value`,
    [buttonId, key, newVal]
  );
  return newVal;
}

export async function getCumulativeValues(from, to) {
  const fromKey = dateKey(from);
  const toKey   = dateKey(to);
  const rows = await exec(
    'SELECT button_id, SUM(value) as total FROM daily_values WHERE date>=? AND date<=? GROUP BY button_id',
    [fromKey, toKey]
  );
  const res = {};
  rows.forEach(r => res[r.button_id] = r.total);
  return res;
}

// ─── LOG ─────────────────────────────────────────────────────

export async function addLog({ type, buttonId = null, delta = null, textValue = null, timestamp }) {
  const ts = timestamp instanceof Date
    ? timestamp.toISOString()
    : (timestamp || new Date().toISOString());
  await exec(
    `INSERT INTO log(timestamp, type, button_id, delta, text_value, deleted) VALUES(?,?,?,?,?,0)`,
    [ts, type, buttonId, delta, textValue]
  );
  const rows = await exec('SELECT last_insert_rowid() as id');
  return { id: rows[0].id, timestamp: ts, type, button_id: buttonId,
           delta, text_value: textValue, deleted: 0 };
}

export async function getLogForRange(from, to, includeDeleted = false) {
  const fromTs = from.toISOString();
  const toTs   = to.toISOString();
  const sql = includeDeleted
    ? 'SELECT * FROM log WHERE timestamp>=? AND timestamp<=? ORDER BY timestamp DESC'
    : 'SELECT * FROM log WHERE timestamp>=? AND timestamp<=? AND deleted=0 ORDER BY timestamp DESC';
  return exec(sql, [fromTs, toTs]);
}

export async function getAllLog(includeDeleted = false) {
  return exec(
    includeDeleted ? 'SELECT * FROM log ORDER BY timestamp DESC'
                   : 'SELECT * FROM log WHERE deleted=0 ORDER BY timestamp DESC'
  );
}

export async function getTextValue(buttonId, date) {
  const key  = dateKey(date);
  const rows = await exec(
    `SELECT text_value FROM log WHERE button_id=? AND type='text' AND timestamp LIKE ? AND deleted=0 ORDER BY timestamp DESC LIMIT 1`,
    [buttonId, key + '%']
  );
  return rows.length ? rows[0].text_value : null;
}

export async function getTextValuesForDate(date) {
  const key  = dateKey(date);
  const rows = await exec(
    `SELECT button_id, text_value FROM log WHERE type='text' AND timestamp LIKE ? AND deleted=0 ORDER BY timestamp DESC`,
    [key + '%']
  );
  const res = {};
  rows.forEach(r => { if (!(r.button_id in res)) res[r.button_id] = r.text_value; });
  return res;
}

export async function saveTextValue(buttonId, date, text, timestamp) {
  const key = dateKey(date);
  await exec(
    `UPDATE log SET deleted=1 WHERE button_id=? AND type='text' AND timestamp LIKE ?`,
    [buttonId, key + '%']
  );
  const ts = timestamp instanceof Date ? timestamp : date;
  await addLog({ type: 'text', buttonId, textValue: text, timestamp: ts });
}

export async function resetDayToZero({ date, counterIds, textIds, currentValues }) {
  const key = dateKey(date);
  const now = new Date();
  const ts  = new Date(date.getFullYear(), date.getMonth(), date.getDate(),
    now.getHours(), now.getMinutes(), now.getSeconds());

  for (const id of counterIds) {
    const current = currentValues[id] || 0;
    if (current <= 0) continue;
    await exec(
      `INSERT INTO daily_values(button_id, date, value) VALUES(?,?,0)
       ON CONFLICT(button_id, date) DO UPDATE SET value=0`,
      [id, key]
    );
    await exec(
      `INSERT INTO log(timestamp, type, button_id, delta, text_value, deleted) VALUES(?,?,?,?,null,0)`,
      [ts.toISOString(), 'counter', id, -current]
    );
  }

  for (const id of textIds) {
    await exec(
      `UPDATE log SET deleted=1 WHERE button_id=? AND type='text' AND timestamp LIKE ?`,
      [id, key + '%']
    );
    await exec(
      `INSERT INTO log(timestamp, type, button_id, delta, text_value, deleted) VALUES(?,?,?,null,'',0)`,
      [ts.toISOString(), 'text', id]
    );
  }
}

export async function getDbStats() {
  const total  = (await exec('SELECT COUNT(*) as n FROM log'))[0].n;
  const active = (await exec('SELECT COUNT(*) as n FROM log WHERE deleted=0'))[0].n;
  const daily  = (await exec('SELECT COUNT(*) as n FROM daily_values'))[0].n;
  return { total_log: total, active_log: active, deleted_log: total - active, total_daily: daily };
}
