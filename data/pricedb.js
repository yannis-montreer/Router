// data/pricedb.js
const PriceDB = (() => {
  let db;
  let idbDb;
  let backend; // 'sqlite' | 'websql' | 'idb'

  const SEED_ROWS = [
    // [tickets_start, tickets_end, discount_percent, zone1..zone5]
    [1,   4,  0,  44.00, 72.00, 101.00, 129.00, 157.00],
    [5,   9,  5,  41.80, 68.40,  95.95, 122.55, 149.15],
    [10, 14, 10,  39.60, 64.80,  90.90, 116.10, 141.30],
    [15, 19, 15,  37.40, 61.20,  85.85, 109.65, 133.45],
    [20, 24, 20,  35.20, 57.60,  80.80, 103.20, 125.60],
    [25, 29, 25,  33.00, 54.00,  75.75,  96.75, 117.75],
    [30, 34, 30,  30.80, 50.40,  70.70,  90.30, 109.90],
    [35, 39, 35,  28.60, 46.80,  65.65,  83.85, 102.05],
    [40, 99, 40,  26.40, 43.20,  60.60,  77.40,  94.20],
  ];

  function isCordova() {
    return typeof window !== 'undefined' && window.cordova && window.sqlitePlugin;
  }

  // ─── IndexedDB backend ───────────────────────────────────────────────────────

  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (idbDb) return resolve(idbDb);
      const req = indexedDB.open('pricedb', 1);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('price_table')) {
          d.createObjectStore('price_table', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = e => { idbDb = e.target.result; resolve(idbDb); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function idbSeedIfEmpty() {
    const d = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('price_table', 'readwrite');
      const store = tx.objectStore('price_table');
      const countReq = store.count();
      countReq.onsuccess = () => {
        if (countReq.result > 0) return resolve();
        SEED_ROWS.forEach((r, i) => {
          store.add({
            id: i + 1,
            tickets_start: r[0], tickets_end: r[1], discount_percent: r[2],
            zone1: r[3], zone2: r[4], zone3: r[5], zone4: r[6], zone5: r[7]
          });
        });
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
      };
      countReq.onerror = () => reject(countReq.error);
    });
  }

  async function idbGetAll() {
    const d = await idbOpen();
    return new Promise((resolve, reject) => {
      const req = d.transaction('price_table', 'readonly').objectStore('price_table').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async function idbGetForCount(count) {
    const rows = await idbGetAll();
    const n = Number(count);
    return rows.find(r => n >= r.tickets_start && n <= r.tickets_end) || null;
  }

  // ─── WebSQL / SQLite helpers ─────────────────────────────────────────────────

  function open() {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);
      if (isCordova()) {
        db = window.sqlitePlugin.openDatabase({ name: 'pricedb.db', location: 'default' }, () => resolve(db), reject);
      } else if (window.sqlitePlugin && window.sqlitePlugin.openDatabase) {
        db = window.sqlitePlugin.openDatabase({ name: 'pricedb.db', location: 'default' }, () => resolve(db), reject);
      } else if (window.openDatabase) {
        db = window.openDatabase('pricedb.db', '1.0', 'Price DB', 2 * 1024 * 1024);
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
        database.transaction(tx => { sqlArray.forEach(sql => tx.executeSql(sql)); }, reject, resolve);
      }
    });
  }

  function txWrap(fn) {
    return new Promise(async (resolve, reject) => {
      const database = await open();
      database.transaction(tx => fn(tx, resolve, reject), reject);
    });
  }

  // ─── Backend selection ───────────────────────────────────────────────────────

  async function resolveBackend() {
    if (backend) return backend;
    try {
      await open();
      backend = isCordova() ? 'sqlite' : 'websql';
    } catch(e) {
      backend = 'idb';
    }
    return backend;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async function init() {
    const b = await resolveBackend();
    if (b === 'idb') {
      await idbOpen();
      await idbSeedIfEmpty();
      return;
    }
    const database = await open();
    await execBatch(database, [
      `CREATE TABLE IF NOT EXISTS price_table (
        id INTEGER PRIMARY KEY,
        tickets_start INTEGER NOT NULL,
        tickets_end   INTEGER NOT NULL,
        discount_percent REAL NOT NULL,
        zone1 REAL NOT NULL,
        zone2 REAL NOT NULL,
        zone3 REAL NOT NULL,
        zone4 REAL NOT NULL,
        zone5 REAL NOT NULL
      );`
    ]);
    // seed if empty
    await txWrap((tx, resolve, reject) => {
      tx.executeSql('SELECT COUNT(*) AS n FROM price_table', [], (_, rs) => {
        if (rs.rows.item(0).n > 0) return resolve(true);
        const sql = `INSERT INTO price_table (tickets_start,tickets_end,discount_percent,zone1,zone2,zone3,zone4,zone5) VALUES (?,?,?,?,?,?,?,?)`;
        SEED_ROWS.forEach(r => tx.executeSql(sql, r));
        resolve(true);
      }, (_, e) => reject(e));
    });
  }

  async function getAllPrices() {
    await init();
    if (backend === 'idb') return idbGetAll();
    return txWrap((tx, resolve, reject) => {
      tx.executeSql('SELECT * FROM price_table ORDER BY id ASC', [],
        (_, rs) => { const out = []; for (let i = 0; i < rs.rows.length; i++) out.push(rs.rows.item(i)); resolve(out); },
        (_, e) => reject(e));
    });
  }

  async function getPricesForTicketCount(count) {
    await init();
    if (backend === 'idb') return idbGetForCount(count);
    const n = Number(count);
    return txWrap((tx, resolve, reject) => {
      tx.executeSql(
        'SELECT * FROM price_table WHERE ? BETWEEN tickets_start AND tickets_end ORDER BY tickets_start ASC LIMIT 1',
        [n],
        (_, rs) => resolve(rs.rows.length ? rs.rows.item(0) : null),
        (_, e) => reject(e)
      );
    });
  }

  return { init, getAllPrices, getPricesForTicketCount };
})();

export default PriceDB;
