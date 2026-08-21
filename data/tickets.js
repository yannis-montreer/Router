// data/tickets.js
const TicketsDB = (() => {
  let db;       // WebSQL / sqlitePlugin handle
  let idbDb;    // IndexedDB handle
  let backend;  // 'sqlite' | 'websql' | 'idb'

  function isCordova() {
    return typeof window !== 'undefined' && window.cordova && window.sqlitePlugin;
  }

  // ─── IndexedDB backend ───────────────────────────────────────────────────────

  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (idbDb) return resolve(idbDb);
      const req = indexedDB.open('tickets_db', 1);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('tickets')) {
          const ts = d.createObjectStore('tickets', { keyPath: 'id', autoIncrement: true });
          ts.createIndex('purchased_at_iso', 'purchased_at_iso', { unique: false });
        }
        if (!d.objectStoreNames.contains('settings')) {
          d.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = e => { idbDb = e.target.result; resolve(idbDb); };
      req.onerror  = e => reject(e.target.error);
    });
  }

  function idbTx(storeName, mode, fn) {
    return idbOpen().then(d => new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, mode);
      tx.onerror = () => reject(tx.error);
      fn(tx.objectStore(storeName), resolve, reject);
    }));
  }

  const idb = {
    async init() {
      await idbOpen(); // creates stores via onupgradeneeded
    },
    setSetting(key, value) {
      return idbTx('settings', 'readwrite', (store, res, rej) => {
        const r = store.put({ key, value: String(value) });
        r.onsuccess = () => res(true);
        r.onerror   = () => rej(r.error);
      });
    },
    getSetting(key, defaultValue = null) {
      return idbTx('settings', 'readonly', (store, res, rej) => {
        const r = store.get(key);
        r.onsuccess = () => res(r.result ? r.result.value : defaultValue);
        r.onerror   = () => rej(r.error);
      });
    },
    addTicket({ zone, adults, purchase_date, purchase_time, ticket_number, order_ref, amount_display, discount_percent = 0 }) {
      const purchased_at_iso = toISO(purchase_date, purchase_time);
      const amount_cents = toCents(amount_display);
      return idbTx('tickets', 'readwrite', (store, res, rej) => {
        const r = store.add({ zone, adults, purchase_date, purchase_time, purchased_at_iso, ticket_number, order_ref, amount_cents, discount_percent });
        r.onsuccess = () => res({ id: r.result });
        r.onerror   = () => rej(r.error);
      });
    },
    listTickets({ limit = 50, offset = 0 } = {}) {
      return idbOpen().then(d => new Promise((resolve, reject) => {
        const tx = d.transaction('tickets', 'readonly');
        const store = tx.objectStore('tickets');
        const idx = store.index('purchased_at_iso');
        const rows = [];
        let skipped = 0;
        // Iterate in reverse (DESC) using 'prev' cursor direction
        const req = idx.openCursor(null, 'prev');
        req.onsuccess = e => {
          const cursor = e.target.result;
          if (!cursor || rows.length >= limit) return resolve(rows);
          if (skipped < offset) { skipped++; cursor.continue(); return; }
          rows.push(cursor.value);
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      }));
    },
    countTicketsInLastDays(days) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      return idbOpen().then(d => new Promise((resolve, reject) => {
        const tx = d.transaction('tickets', 'readonly');
        const store = tx.objectStore('tickets');
        const idx = store.index('purchased_at_iso');
        // IDBKeyRange.lowerBound(cutoff) counts rows with date >= cutoff
        const range = IDBKeyRange.lowerBound(cutoff);
        const req = idx.count(range);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      }));
    },
    getTicketById(id) {
      return idbTx('tickets', 'readonly', (store, res, rej) => {
        const r = store.get(Number(id));
        r.onsuccess = () => res(r.result || null);
        r.onerror   = () => rej(r.error);
      });
    },
    deleteTicketById(id) {
      return idbTx('tickets', 'readwrite', (store, res, rej) => {
        const r = store.delete(Number(id));
        r.onsuccess = () => res(true);
        r.onerror   = () => rej(r.error);
      });
    },
    updateTicketZoneAndPurchase(id, zoneStr, purchase_date, purchase_time, purchased_at_iso, amount_cents, discount_percent) {
      return idbOpen().then(d => new Promise((resolve, reject) => {
        const tx = d.transaction('tickets', 'readwrite');
        const store = tx.objectStore('tickets');
        const getReq = store.get(Number(id));
        getReq.onsuccess = () => {
          const row = getReq.result;
          if (!row) return reject(new Error('Ticket not found'));
          Object.assign(row, { zone: zoneStr, purchase_date, purchase_time, purchased_at_iso });
          if (amount_cents    != null) row.amount_cents    = amount_cents;
          if (discount_percent != null) row.discount_percent = discount_percent;
          const putReq = store.put(row);
          putReq.onsuccess = () => resolve(true);
          putReq.onerror   = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
      }));
    },
  };

  // ─── WebSQL / SQLite helpers ─────────────────────────────────────────────────

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
        db = window.sqlitePlugin.openDatabase(
          { name: 'tickets.db', location: 'default' },
          () => resolve(db),
          reject
        );
      } else if (window.openDatabase) {
        // Browser fallback (WebSQL) — Chrome desktop etc.
        db = window.openDatabase('tickets.db', '1.0', 'Tickets DB', 2 * 1024 * 1024);
        resolve(db);
      } else {
        reject(new Error('no-sql'));
      }
    });
  }

  function execBatch(database, sqlArray) {
    return new Promise((resolve, reject) => {
      if (isCordova()) {
        database.sqlBatch(sqlArray, resolve, reject);
      } else {
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

  // ─── Shared helpers ──────────────────────────────────────────────────────────

  const toCents = (amountStr) => {
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
    const [dd, mm, yyyy] = dateStr.split('.').map(Number);
    const [hh, mi, ss] = timeStr.split(':').map(Number);
    const dt = new Date(yyyy, mm - 1, dd, hh, mi, ss || 0);
    return dt.toISOString();
  }

  // ─── Backend selection ───────────────────────────────────────────────────────

  async function resolveBackend() {
    if (backend) return backend;
    try {
      await open();       // try SQLite / WebSQL
      backend = isCordova() ? 'sqlite' : 'websql';
    } catch(e) {
      // Fall back to IndexedDB (iOS Safari PWA, etc.)
      backend = 'idb';
    }
    return backend;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async function init() {
    const b = await resolveBackend();
    if (b === 'idb') return idb.init();
    // SQLite / WebSQL
    const database = await open();
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

  async function setSetting(key, value) {
    await init();
    if (backend === 'idb') return idb.setSetting(key, value);
    return txWrap((tx, resolve, reject) => {
      tx.executeSql(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
        [key, String(value)], () => resolve(true), (_, e) => reject(e));
    });
  }

  async function getSetting(key, defaultValue = null) {
    await init();
    if (backend === 'idb') return idb.getSetting(key, defaultValue);
    return txWrap((tx, resolve, reject) => {
      tx.executeSql(`SELECT value FROM settings WHERE key = ? LIMIT 1`, [key],
        (_, rs) => resolve(rs.rows.length ? rs.rows.item(0).value : defaultValue),
        (_, e) => reject(e));
    });
  }

  async function addTicket(opts) {
    await init();
    if (backend === 'idb') return idb.addTicket(opts);
    const { zone, adults, purchase_date, purchase_time, ticket_number, order_ref, amount_display, discount_percent = 0 } = opts;
    const purchased_at_iso = toISO(purchase_date, purchase_time);
    const amount_cents = toCents(amount_display);
    return txWrap((tx, resolve, reject) => {
      tx.executeSql(
        `INSERT INTO tickets (zone, adults, purchase_date, purchase_time, purchased_at_iso, ticket_number, order_ref, amount_cents, discount_percent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [zone, adults, purchase_date, purchase_time, purchased_at_iso, ticket_number, order_ref, amount_cents, discount_percent],
        (_, res) => resolve({ id: res.insertId }),
        (_, e) => reject(e)
      );
    });
  }

  async function listTickets({ limit = 50, offset = 0 } = {}) {
    await init();
    if (backend === 'idb') return idb.listTickets({ limit, offset });
    return txWrap((tx, resolve, reject) => {
      const rows = [];
      tx.executeSql(
        `SELECT * FROM tickets ORDER BY purchased_at_iso DESC LIMIT ? OFFSET ?`,
        [limit, offset],
        (_, rs) => { for (let i = 0; i < rs.rows.length; i++) rows.push(rs.rows.item(i)); resolve(rows); },
        (_, e) => reject(e)
      );
    });
  }

  async function countTicketsInLastDays(days) {
    await init();
    if (backend === 'idb') return idb.countTicketsInLastDays(days);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return txWrap((tx, resolve, reject) => {
      tx.executeSql(
        `SELECT COUNT(*) AS n FROM tickets WHERE purchased_at_iso >= ?`,
        [cutoff],
        (_, rs) => resolve(rs.rows.item(0).n),
        (_, e) => reject(e)
      );
    });
  }

  async function getTicketById(id) {
    await init();
    if (backend === 'idb') return idb.getTicketById(id);
    return txWrap((tx, resolve, reject) => {
      tx.executeSql(
        `SELECT * FROM tickets WHERE id = ? LIMIT 1`, [id],
        (_, rs) => resolve(rs.rows.length ? rs.rows.item(0) : null),
        (_, e) => reject(e)
      );
    });
  }

  async function deleteTicketById(id) {
    await init();
    if (backend === 'idb') return idb.deleteTicketById(id);
    return txWrap((tx, resolve, reject) => {
      tx.executeSql(
        `DELETE FROM tickets WHERE id = ?`, [id],
        () => resolve(true),
        (_, e) => reject(e)
      );
    });
  }

  async function updateTicketZoneAndPurchase(id, zoneStr, purchase_date, purchase_time, purchased_at_iso, amount_cents, discount_percent) {
    await init();
    if (backend === 'idb') return idb.updateTicketZoneAndPurchase(id, zoneStr, purchase_date, purchase_time, purchased_at_iso, amount_cents, discount_percent);
    // Build SQL dynamically — price fields are optional
    const hasCents    = amount_cents    != null;
    const hasDiscount = discount_percent != null;
    const extraCols   = (hasCents ? ', amount_cents = ?' : '') + (hasDiscount ? ', discount_percent = ?' : '');
    const extraVals   = [...(hasCents ? [amount_cents] : []), ...(hasDiscount ? [discount_percent] : [])];
    return txWrap((tx, resolve, reject) => {
      tx.executeSql(
        `UPDATE tickets SET zone = ?, purchase_date = ?, purchase_time = ?, purchased_at_iso = ?${extraCols} WHERE id = ?`,
        [zoneStr, purchase_date, purchase_time, purchased_at_iso, ...extraVals, id],
        () => resolve(true),
        (_, e) => reject(e)
      );
    });
  }

  function makeTicketNumber() { return '416' + randomDigits(7); }
  function makeOrderRef()     { return `${randomDigits(6)}-${randomDigits(6)}-${randomDigits(4)}`; }
  function formatAmount(amount_cents) {
    return `${Math.floor(amount_cents / 100)},${pad(amount_cents % 100, 2)}`;
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
