// data/pricedb.js
const PriceDB = (() => {
  let db;

  function isCordova() {
    return typeof window !== 'undefined' && window.cordova && window.sqlitePlugin;
  }

  function open() {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);

      if (isCordova()) {
        db = window.sqlitePlugin.openDatabase(
          { name: 'pricedb.db', location: 'default' },
          () => resolve(db),
          reject
        );
      } else if (window.sqlitePlugin && window.sqlitePlugin.openDatabase) {
        // Some desktop runtimes expose the same API
        db = window.sqlitePlugin.openDatabase(
          { name: 'pricedb.db', location: 'default' },
          () => resolve(db),
          reject
        );
      } else if (window.openDatabase) {
        // Browser fallback (WebSQL) for local dev only
        db = window.openDatabase('pricedb.db', '1.0', 'Price DB', 2 * 1024 * 1024);
        resolve(db);
      } else {
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
        database.transaction(
          tx => {
            sqlArray.forEach(sql => tx.executeSql(sql));
          },
          reject,
          resolve
        );
      }
    });
  }

  function txWrap(fn) {
    return new Promise(async (resolve, reject) => {
      const database = await open();
      database.transaction(tx => fn(tx, resolve, reject), reject);
    });
  }

  // --- INIT -------------------------------------------------------------------

  async function init() {
    const database = await open();

    // Create the price table
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

    // Seed initial data if empty
    await seedIfEmpty();
  }

  async function seedIfEmpty() {
    return txWrap((tx, resolve, reject) => {
      tx.executeSql(
        'SELECT COUNT(*) AS n FROM price_table',
        [],
        (_, rs) => {
          const n = rs.rows.item(0).n;
          if (n > 0) {
            // Already seeded
            resolve(true);
            return;
          }

          const rows = [
            // tickets_start,tickets_end,discount,1 zone,2 zones,3 zones,4 zones,5 zones
            ['1',   '4',  0, 44.00, 72.00, 101.00, 129.00, 157.00],
            ['5',   '9',  5, 41.80, 68.40,  95.95, 122.55, 149.15],
            ['10', '14', 10, 39.60, 64.80,  90.90, 116.10, 141.30],
            ['15', '19', 15, 37.40, 61.20,  85.85, 109.65, 133.45],
            ['20', '24', 20, 35.20, 57.60,  80.80, 103.20, 125.60],
            ['25', '29', 25, 33.00, 54.00,  75.75,  96.75, 117.75],
            ['30', '34', 30, 30.80, 50.40,  70.70,  90.30, 109.90],
            ['35', '39', 35, 28.60, 46.80,  65.65,  83.85, 102.05],
            ['40', '99', 40, 26.40, 43.20,  60.60,  77.40,  94.20]
          ];

          const sql = `INSERT INTO price_table
            (tickets_start, tickets_end, discount_percent, zone1, zone2, zone3, zone4, zone5)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

          rows.forEach(row => {
            tx.executeSql(sql, row);
          });

          resolve(true);
        },
        (_, e) => reject(e)
      );
    });
  }

  // --- API --------------------------------------------------------------------

  async function getAllPrices() {
    await init();
    return txWrap((tx, resolve, reject) => {
      tx.executeSql(
        'SELECT * FROM price_table ORDER BY id ASC',
        [],
        (_, rs) => {
          const out = [];
          for (let i = 0; i < rs.rows.length; i++) {
            out.push(rs.rows.item(i));
          }
          resolve(out);
        },
        (_, e) => reject(e)
      );
    });
  }

  // Helper: given a ticket count, find the matching range row
  async function getPricesForTicketCount(count) {
    await init();
    const n = Number(count);

    return txWrap((tx, resolve, reject) => {
      tx.executeSql(
        'SELECT * FROM price_table WHERE ? BETWEEN tickets_start AND tickets_end ORDER BY tickets_start ASC LIMIT 1',
        [n],
        (_, rs) => {
          if (rs.rows.length > 0) {
            resolve(rs.rows.item(0));
          } else {
            resolve(null);
          }
        },
        (_, e) => reject(e)
      );
    });
  }

  return {
    init,
    getAllPrices,
    getPricesForTicketCount
  };
})();

export default PriceDB;
