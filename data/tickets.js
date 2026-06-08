// data/tickets.js
const TicketsDB = (() => {
  let db;

  function isCordova() {
    return typeof window !== 'undefined' && window.cordova && window.sqlitePlugin;
  }

  function open() {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);

      if (isCordova()) {
        db = window.sqlitePlugin.openDatabase(
          { name: 'tickets.db', location: 'default' },
          () => resolve(db),
          reject
        );
      } else if (window.sqlitePlugin && window.sqlitePlugin.openDatabase) {
        // Some desktop runtimes expose the same API
        db = window.sqlitePlugin.openDatabase(
          { name: 'tickets.db', location: 'default' },
          () => resolve(db),
          reject
        );
      } else if (window.openDatabase) {
        // Browser fallback (WebSQL) for local dev only
        db = window.openDatabase('tickets.db', '1.0', 'Tickets DB', 2 * 1024 * 1024);
        resolve(db);
      } else {
        // Last resort: IndexedDB via sql.js is possible, but keep it simple
        reject(new Error('No SQLite/WebSQL available. Run inside Cordova or add cordova-sqlite-storage.'));
      }
    });
  }

  function execBatch(database, sqlArray) {
    return new Promise((resolve, reject) => {
      if (isCordova()) {
        database.sqlBatch(sqlArray, resolve, reject);
      } else {
        // WebSQL fallback
        database.transaction(tx => {
          sqlArray.forEach(sql => tx.executeSql(sql));
        }, reject, resolve);
      }
    });
  }

  function txWrap(fn) {
    return new Promise(async (resolve, reject) => {
      const database = await open();
      database.transaction(tx => fn(tx, resolve, reject), reject);
    });
  }

  // Helpers
  const toCents = (amountStr) => {
    // '39,60' -> 3960
    const norm = amountStr.replace(/\./g, '').replace(',', '.');
    return Math.round(parseFloat(norm) * 100);
  };

  const pad = (n, len) => String(n).padStart(len, '0');

  const randomDigits = (len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10);
    return s;
  };

  function toISO(dateStr, timeStr) {
    // date 'dd.mm.yyyy' and time 'hh:mm:ss' in local time -> ISO with timezone
    const [dd, mm, yyyy] = dateStr.split('.').map(Number);
    const [hh, mi, ss] = timeStr.split(':').map(Number);
    const dt = new Date(yyyy, mm - 1, dd, hh, mi, ss || 0);
    return dt.toISOString(); // stored in UTC ISO; still fine for DESC sorting
  }

  // --- INIT -------------------------------------------------------------------

  // data/tickets.js
    // ...
    async function init() {
    const database = await open();
    // Create tickets, index, and settings table in one batch
    await execBatch(database, [
        `CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY,
        zone TEXT NOT NULL,
        adults INTEGER NOT NULL,
        purchase_date TEXT NOT NULL,
        purchase_time TEXT NOT NULL,
        purchased_at_iso TEXT NOT NULL,
        ticket_number TEXT NOT NULL UNIQUE,
        order_ref TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        discount_percent REAL NOT NULL DEFAULT 0
        );`,
        `CREATE INDEX IF NOT EXISTS idx_tickets_date ON tickets(purchased_at_iso DESC);`,
        `CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
        );`
    ]);
    }


  // --- SETTINGS API -----------------------------------------------------------

  async function setSetting(key, value) {
    await init();
    return txWrap((tx, resolve, reject) => {
      const sql = `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`;
      const args = [key, String(value)];
      tx.executeSql(
        sql,
        args,
        () => resolve(true),
        (_, e) => reject(e)
      );
    });
  }

  async function getSetting(key, defaultValue = null) {
    await init();
    return txWrap((tx, resolve, reject) => {
      const sql = `SELECT value FROM settings WHERE key = ? LIMIT 1`;
      const args = [key];
      tx.executeSql(
        sql,
        args,
        (_, rs) => {
          if (!rs.rows.length) return resolve(defaultValue);
          resolve(rs.rows.item(0).value);
        },
        (_, e) => reject(e)
      );
    });
  }

  // --- TICKETS API ------------------------------------------------------------

  async function addTicket({
    zone,
    adults,
    purchase_date,
    purchase_time,
    ticket_number,
    order_ref,
    amount_display,
    discount_percent = 0
    }) {
    await init();
    const purchased_at_iso = toISO(purchase_date, purchase_time);
    const amount_cents = toCents(amount_display);

    return txWrap((tx, resolve, reject) => {
        const sql = `INSERT INTO tickets
        (zone, adults, purchase_date, purchase_time, purchased_at_iso, ticket_number, order_ref, amount_cents, discount_percent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const args = [
        zone,
        adults,
        purchase_date,
        purchase_time,
        purchased_at_iso,
        ticket_number,
        order_ref,
        amount_cents,
        discount_percent
        ];

        const cb = (_, res) => resolve({ id: res.insertId });
        const err = (_, e) => reject(e);

        tx.executeSql(sql, args, cb, err);
    });
    }


  async function listTickets({ limit = 50, offset = 0 } = {}) {
    await init();
    return txWrap((tx, resolve, reject) => {
      const sql = `SELECT * FROM tickets ORDER BY purchased_at_iso DESC LIMIT ? OFFSET ?`;
      const args = [limit, offset];
      const rows = [];
      const cb = (_, rs) => {
        for (let i = 0; i < rs.rows.length; i++) rows.push(rs.rows.item(i));
        resolve(rows);
      };
      const err = (_, e) => reject(e);
      tx.executeSql(sql, args, cb, err);
    });
  }

  async function countTicketsInLastDays(days) {
    await init();

    const now = Date.now();
    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

    return txWrap((tx, resolve, reject) => {
        const sql = `SELECT COUNT(*) AS n
                    FROM tickets
                    WHERE purchased_at_iso >= ?`;
        const args = [cutoff];

        tx.executeSql(
        sql,
        args,
        (_, rs) => resolve(rs.rows.item(0).n),
        (_, e) => reject(e)
        );
    });
    }


  async function updateTicketZoneAndPurchase(id, zoneStr, purchase_date, purchase_time, purchased_at_iso) {
    await init();
    return txWrap((tx, resolve, reject) => {
      tx.executeSql(
        'UPDATE tickets SET zone = ?, purchase_date = ?, purchase_time = ?, purchased_at_iso = ? WHERE id = ?',
        [zoneStr, purchase_date, purchase_time, purchased_at_iso, id],
        () => resolve(true),
        (_, e) => reject(e)
      );
    });
  }

  async function deleteTicketById(id) {
    await init();
    return txWrap((tx, resolve, reject) => {
      tx.executeSql(
        'DELETE FROM tickets WHERE id = ?',
        [id],
        () => resolve(true),
        (_, e) => reject(e)
      );
    });
  }

  async function getTicketById(id) {
    await init();
    return txWrap((tx, resolve, reject) => {
      const sql = `SELECT * FROM tickets WHERE id = ? LIMIT 1`;
      const args = [id];
      const cb = (_, rs) => resolve(rs.rows.length ? rs.rows.item(0) : null);
      const err = (_, e) => reject(e);
      tx.executeSql(sql, args, cb, err);
    });
  }

  // Utilities for generating ids in the required formats
  function makeTicketNumber() {
    return '416' + randomDigits(7);
  }

  function makeOrderRef() {
    return `${randomDigits(6)}-${randomDigits(6)}-${randomDigits(4)}`;
  }

  // Format back to UI string with comma
  function formatAmount(amount_cents) {
    const euros = Math.floor(amount_cents / 100);
    const cents = pad(amount_cents % 100, 2);
    return `${euros},${cents}`;
  }

  return {
    init,
    addTicket,
    listTickets,
    countTicketsInLastDays,
    makeTicketNumber,
    makeOrderRef,
    formatAmount,
    getTicketById,
    deleteTicketById,
    updateTicketZoneAndPurchase,
    setSetting,
    getSetting,
  };
})();

export default TicketsDB;
