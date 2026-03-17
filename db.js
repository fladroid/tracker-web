// db.js — OPFS + sqlite-wasm backend (zamjena za IndexedDB)
// API je identičan tracker-pwa verziji — app.js se ne mijenja

// ─── INIT ────────────────────────────────────────────────────

let _db = null;

async function getDb() {
  if (_db) return _db;

  // Učitaj sqlite-wasm iz CDN-a
  const sqlite3InitModule = (await import(
    'https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.46.1-build1/sqlite-wasm/jswasm/sqlite3-esm.mjs'
  )).default;

  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });

  // Koristi OPFS ako je dostupan, fallback na in-memory
  if (sqlite3.capi.sqlite3_vfs_find('opfs')) {
    _db = new sqlite3.oo1.OpfsDb('/tracker_v2.db');
  } else {
    console.warn('OPFS nije dostupan — koristim in-memory bazu');
    _db = new sqlite3.oo1.DB(':memory:');
  }

  _db.exec(`
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

  return _db;
}

// ─── HELPERS ─────────────────────────────────────────────────

export function dateKey(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function rowsToArray(db, sql, params = []) {
  const rows = [];
  db.exec({ sql, bind: params, rowMode: 'object', callback: r => rows.push({ ...r }) });
  return rows;
}

// ─── DAILY VALUES ────────────────────────────────────────────

export async function getValue(buttonId, date) {
  const db  = await getDb();
  const key = dateKey(date);
  const rows = rowsToArray(db,
    'SELECT value FROM daily_values WHERE button_id=? AND date=?',
    [buttonId, key]
  );
  return rows.length ? rows[0].value : 0;
}

export async function getValuesForDate(date) {
  const db  = await getDb();
  const key = dateKey(date);
  const rows = rowsToArray(db,
    'SELECT button_id, value FROM daily_values WHERE date=?',
    [key]
  );
  const res = {};
  rows.forEach(r => res[r.button_id] = r.value);
  return res;
}

export async function changeValue(buttonId, date, delta) {
  const db      = await getDb();
  const key     = dateKey(date);
  const current = await getValue(buttonId, date);
  const newVal  = Math.max(0, Math.min(999, current + delta));

  db.exec({
    sql: `INSERT INTO daily_values(button_id, date, value) VALUES(?,?,?)
          ON CONFLICT(button_id, date) DO UPDATE SET value=excluded.value`,
    bind: [buttonId, key, newVal]
  });
  return newVal;
}

export async function getCumulativeValues(from, to) {
  const db      = await getDb();
  const fromKey = dateKey(from);
  const toKey   = dateKey(to);
  const rows = rowsToArray(db,
    'SELECT button_id, SUM(value) as total FROM daily_values WHERE date>=? AND date<=? GROUP BY button_id',
    [fromKey, toKey]
  );
  const res = {};
  rows.forEach(r => res[r.button_id] = r.total);
  return res;
}

// ─── LOG ─────────────────────────────────────────────────────

export async function addLog({ type, buttonId = null, delta = null, textValue = null, timestamp }) {
  const db = await getDb();
  const ts = timestamp instanceof Date
    ? timestamp.toISOString()
    : (timestamp || new Date().toISOString());

  db.exec({
    sql: `INSERT INTO log(timestamp, type, button_id, delta, text_value, deleted)
          VALUES(?,?,?,?,?,0)`,
    bind: [ts, type, buttonId, delta, textValue]
  });

  const rows = rowsToArray(db, 'SELECT last_insert_rowid() as id');
  return { id: rows[0].id, timestamp: ts, type, button_id: buttonId,
           delta, text_value: textValue, deleted: 0 };
}

export async function getLogForRange(from, to, includeDeleted = false) {
  const db     = await getDb();
  const fromTs = from.toISOString();
  const toTs   = to.toISOString();
  const sql = includeDeleted
    ? 'SELECT * FROM log WHERE timestamp>=? AND timestamp<=? ORDER BY timestamp DESC'
    : 'SELECT * FROM log WHERE timestamp>=? AND timestamp<=? AND deleted=0 ORDER BY timestamp DESC';
  return rowsToArray(db, sql, [fromTs, toTs]);
}

export async function getAllLog(includeDeleted = false) {
  const db  = await getDb();
  const sql = includeDeleted
    ? 'SELECT * FROM log ORDER BY timestamp DESC'
    : 'SELECT * FROM log WHERE deleted=0 ORDER BY timestamp DESC';
  return rowsToArray(db, sql);
}

export async function getTextValue(buttonId, date) {
  const db  = await getDb();
  const key = dateKey(date);
  const rows = rowsToArray(db,
    `SELECT text_value FROM log
     WHERE button_id=? AND type='text' AND timestamp LIKE ? AND deleted=0
     ORDER BY timestamp DESC LIMIT 1`,
    [buttonId, key + '%']
  );
  return rows.length ? rows[0].text_value : null;
}

export async function getTextValuesForDate(date) {
  const db  = await getDb();
  const key = dateKey(date);
  const rows = rowsToArray(db,
    `SELECT button_id, text_value FROM log
     WHERE type='text' AND timestamp LIKE ? AND deleted=0
     ORDER BY timestamp DESC`,
    [key + '%']
  );
  const res = {};
  rows.forEach(r => { if (!(r.button_id in res)) res[r.button_id] = r.text_value; });
  return res;
}

export async function saveTextValue(buttonId, date, text, timestamp) {
  const db  = await getDb();
  const key = dateKey(date);

  // Soft-delete stari text unosi za taj dan
  db.exec({
    sql: `UPDATE log SET deleted=1
          WHERE button_id=? AND type='text' AND timestamp LIKE ?`,
    bind: [buttonId, key + '%']
  });

  const ts = timestamp instanceof Date ? timestamp : date;
  await addLog({ type: 'text', buttonId, textValue: text, timestamp: ts });
}

export async function resetDayToZero({ date, counterIds, textIds, currentValues }) {
  const db  = await getDb();
  const key = dateKey(date);
  const now = new Date();
  const ts  = new Date(date.getFullYear(), date.getMonth(), date.getDate(),
    now.getHours(), now.getMinutes(), now.getSeconds());

  for (const id of counterIds) {
    const current = currentValues[id] || 0;
    if (current <= 0) continue;
    db.exec({
      sql: `INSERT INTO daily_values(button_id, date, value) VALUES(?,?,0)
            ON CONFLICT(button_id, date) DO UPDATE SET value=0`,
      bind: [id, key]
    });
    db.exec({
      sql: `INSERT INTO log(timestamp, type, button_id, delta, text_value, deleted)
            VALUES(?,?,?,?,null,0)`,
      bind: [ts.toISOString(), 'counter', id, -current]
    });
  }

  for (const id of textIds) {
    db.exec({
      sql: `UPDATE log SET deleted=1
            WHERE button_id=? AND type='text' AND timestamp LIKE ?`,
      bind: [id, key + '%']
    });
    db.exec({
      sql: `INSERT INTO log(timestamp, type, button_id, delta, text_value, deleted)
            VALUES(?,?,?,null,'',0)`,
      bind: [ts.toISOString(), 'text', id]
    });
  }
}

export async function getDbStats() {
  const db = await getDb();
  const log   = rowsToArray(db, 'SELECT COUNT(*) as n FROM log')[0].n;
  const active = rowsToArray(db, 'SELECT COUNT(*) as n FROM log WHERE deleted=0')[0].n;
  const daily  = rowsToArray(db, 'SELECT COUNT(*) as n FROM daily_values')[0].n;
  return {
    total_log:   log,
    active_log:  active,
    deleted_log: log - active,
    total_daily: daily,
  };
}
