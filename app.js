import TicketsDB from './data/tickets.js';
import PriceDB from './data/pricedb.js';

// ── PWA: register service worker (skipped inside Cordova) ──────────────────
if (!window.cordova && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .then(reg => console.log('[SW] registered, scope:', reg.scope))
    .catch(err => console.warn('[SW] registration failed:', err));
}

// ── iOS detection: adds 'ios' class to <body> for iOS-specific styling ────────
(function() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) document.documentElement.classList.add('ios');
})();

// Turn on crash-revealing logs
window.addEventListener('error', e => console.error('window.onerror:', e.error || e.message));
window.addEventListener('unhandledrejection', e => console.error('unhandledrejection:', e.reason));

// --- Mapbox token setup (works in Cordova + manual env.js) ---
if (window.mapboxgl && window.APP_CONFIG && window.APP_CONFIG.MAPBOX_TOKEN) {
  mapboxgl.accessToken = window.APP_CONFIG.MAPBOX_TOKEN;
  console.log('Mapbox token loaded:', mapboxgl.accessToken.slice(0, 6) + '...');
} else {
  console.warn('Mapbox disabled: missing mapboxgl or MAPBOX_TOKEN. Check env.js and Mapbox script.');
}

// Quick self-test to verify token works
(async () => {
  if (!window.mapboxgl || !mapboxgl.accessToken) return;
  try {
    const url = `https://api.mapbox.com/styles/v1/mapbox/streets-v12?access_token=${mapboxgl.accessToken}`;
    const res = await fetch(url);
    console.log('Token test status:', res.status);
    if (res.status === 401) console.error('Invalid Mapbox token');
  } catch (err) {
    console.error('Token test failed:', err);
  }
})();

// ─── DATE / LABEL UTILITIES ───────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

/** 'dd.mm.yyyy'  — for DB storage */
function fmtDate(d)     { return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()}`; }

/** 'HH:MM:SS'   — for DB storage */
function fmtTime(d)     { return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

/** 'HH:MM'      — for expiry display */
function fmtHHMM(d)     { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

/** 'dd.mm.yy HH:MM:SS' — for ticket/receipt detail display */
function fmtDateTime(d) {
  return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${String(d.getFullYear()).slice(-2)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Ticket validity in milliseconds based on zone count.
 * 1 zone = 60 min, each additional zone adds 30 min.
 * @param {string} zoneStr  Stored zone value, e.g. '1' or '1,2V,3Ø'
 */
function ticketDurationMs(zoneStr) {
  const count = String(zoneStr).split(',').map(s => s.trim()).filter(Boolean).length || 1;
  return (60 + (count - 1) * 30) * 60 * 1000;
}

/** Format a stored zone string (single '1' or comma-sep '1,2Ø,3V') → human label */
function fmtZone(z) {
  const parts = String(z).split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return 'Zone 1';
  if (parts.length === 1) return `Zone ${parts[0]}`;
  const last = parts[parts.length - 1];
  const rest = parts.slice(0, -1);
  return `Zones ${rest.join(', ')} and ${last}`;
}

// First name — loaded from DB at startup; Profile edit will update it later
window.__profileFirstName = 'Yannis';

/** "Good morning/afternoon/evening, <name>" based on current hour */
function getGreeting() {
  const h = new Date().getHours();
  const period = (h >= 2 && h < 12) ? 'morning'
               : (h >= 12 && h < 17) ? 'afternoon'
               : 'evening';
  return `Good ${period}, ${window.__profileFirstName || 'Yannis'}`;
}

// ─── BACK-BUTTON HELPER ───────────────────────────────────────────────────────
/**
 * Injects a chevron + title into the topbar, wires both the header button
 * and the Android back button, and auto-cleans up on the next hashchange.
 *
 * @param {string}    title      Text shown next to the chevron
 * @param {Function}  goBack     Called on back press
 * @param {Function}  [onCleanup] Optional extra work at cleanup time
 */
function injectBackButton(title, goBack, onCleanup) {
  const topbar  = document.querySelector('.topbar');
  const titleEl = document.getElementById('title');
  if (!topbar || !titleEl) return;

  topbar.classList.add('mode-expired');
  titleEl.innerHTML = `
    <button class="back-btn" aria-label="Back">
      <img src="icons/chevron-right-expired.svg" alt="" class="icon-20 chevron-left">
    </button>
    ${title}
  `;

  const backBtn = titleEl.querySelector('.back-btn');
  if (backBtn) backBtn.onclick = goBack;
  setBack(goBack);

  // No hashchange listener here — render() owns topbar teardown. We just record
  // any page-specific cleanup so render() can run it on the next navigation.
  // (Registering a {once} hashchange listener here raced with render's async
  // continuation and wiped freshly-installed back buttons.)
  window.__topbarCleanup = (typeof onCleanup === 'function') ? onCleanup : null;
}

// ─────────────────────────────────────────────────────────────────────────────

async function createBackdatedTicketIfNeeded({ force = false } = {}) {
  // We want ticket EXPIRATION = now - 1 minutes
  // UI computes expiration as purchase + 60 min -> set PURCHASE = now - 61 minutes
  const now = new Date();

  // Read the last ticket once — used both for the age-check and zone inheritance
  const lastRows = await TicketsDB.listTickets({ limit: 1 });
  const lastTicket = (lastRows && lastRows.length) ? lastRows[0] : null;

  // Inherit zones from the previous ticket (comma-separated string → array)
  const inheritedZones = lastTicket
    ? lastTicket.zone.split(',').map(s => s.trim()).filter(Boolean)
    : null;

  // Only check previous ticket age when not forced (app open behavior)
  if (!force && lastTicket) {
    const lastPurchase = new Date(lastTicket.purchased_at_iso);
    const diffMs = now - lastPurchase;

    // If last ticket is newer than 70 minutes, do NOT create a new one
    if (diffMs < 70 * 60 * 1000) {
      return;
    }
  }

  // Expiry = now - expiredAgoMin. Purchase = now - (duration + expiredAgoMin).
  // Duration depends on zone count: 60 min for 1 zone, +30 min per extra zone.
  // expiredAgoMin comes from currentOffsetMinutes (set from DB at startup).
  const zonesForDuration = inheritedZones && inheritedZones.length ? inheritedZones : ['1'];
  const durationMin    = ticketDurationMs(zonesForDuration.join(',')) / 60000;
  const expiredAgoMin  = currentOffsetMinutes - 60;
  const purchase = new Date(now.getTime() - (durationMin + expiredAgoMin) * 60 * 1000);
  await insertDiscountedTicketForPurchase(purchase, {
    pruneTooRecentBeforeInsert: true,
    zones: inheritedZones,
  });
}

document.addEventListener('deviceready', async () => {
  console.log('Device ready — initializing database...');
  await TicketsDB.init();

  // Load saved offset (if any) and apply to counter + UI.
  // If the saved value is outside MIN–MAX it means it's a stale value from
  // before the range was changed — reset it to the mid-point default (61).
  try {
    const saved = await TicketsDB.getSetting('offsetMinutes', 61);
    const n = Number(saved);
    const target = (!Number.isNaN(n) && n >= MIN_OFFSET_MINUTES && n <= MAX_OFFSET_MINUTES) ? n : 61;
    setOffsetMinutes(target);
  } catch (err) {
    console.error('Could not load offsetMinutes from DB', err);
    setOffsetMinutes(61);
  }

  // Load first name from DB (Profile tab will write it via setSetting later)
  try {
    const savedName = await TicketsDB.getSetting('firstName', 'Yannis');
    if (savedName) window.__profileFirstName = savedName;
  } catch (e) { /* keep default */ }

  // On app open: create ticket only if last one is >= 70 min old (or none exists)
  await createBackdatedTicketIfNeeded({ force: false });
    // === EXPORT DATABASE FUNCTION (available globally) ===
    window.exportDb = function() {
      const dbName = 'tickets.db'; // change if your actual DB name differs

    if (!window.cordova || !cordova.file) {
      alert('Cordova File plugin not available.');
      return;
    }

    // ANDROID path: <applicationStorageDirectory>/databases/tickets.db
    // Example: file:///data/user/0/<your.app.id>/databases/tickets.db
    const sourcePath = cordova.file.applicationStorageDirectory + 'databases/' + dbName;

    // Destination: /Download/ folder on internal storage
    const destDir = cordova.file.externalRootDirectory + 'Download/';

    // Destination: /Download/ folder
    window.resolveLocalFileSystemURL(
      sourcePath,
      function(fileEntry) {
        window.resolveLocalFileSystemURL(
          cordova.file.externalRootDirectory + 'Download/',
          function(dirEntry) {
            fileEntry.copyTo(
              dirEntry,
              'tickets_export.db',
              function() {
                alert('Database exported to Download/tickets_export.db');
              },
              function(err){ console.error('copyTo error:', err); }
            );
          },
          function(err){ console.error('resolve Download error:', err); }
        );
      },
      function(err){ console.error('resolve DB error:', err); }
    );
  };
  // === END EXPORT FUNCTION ===

  // Init confirmed zones from the latest ticket in DB so the Tickets page
  // and future ticket creations reflect whatever was last saved
  try {
    const latestRows = await TicketsDB.listTickets({ limit: 1 });
    if (latestRows && latestRows.length) {
      const parts = latestRows[0].zone.split(',').map(s => s.trim()).filter(Boolean);
      window.__confirmedZones = new Set(parts.length ? parts : ['1']);
    } else {
      window.__confirmedZones = new Set(['1']);
    }
  } catch (err) {
    console.error('Could not load zones from DB', err);
    window.__confirmedZones = new Set(['1']);
  }

  onReady();
}, false);

// ── PWA fallback init (runs when not inside Cordova — deviceready never fires) ──
if (!window.cordova) {
  async function pwaInit() {
    try {
      try {
        await TicketsDB.init();
        const saved = await TicketsDB.getSetting('offsetMinutes', 61);
        const n = Number(saved);
        const target = (!Number.isNaN(n) && n >= MIN_OFFSET_MINUTES && n <= MAX_OFFSET_MINUTES) ? n : 61;
        setOffsetMinutes(target);
      } catch (e) { console.error('[PWA] DB init/offset failed:', e); setOffsetMinutes(61); }

      try {
        const savedName = await TicketsDB.getSetting('firstName', 'Yannis');
        if (savedName) window.__profileFirstName = savedName;
      } catch (e) { /* keep default */ }

      try {
        await createBackdatedTicketIfNeeded({ force: false });
      } catch (e) { console.error('[PWA] createBackdatedTicket failed:', e); }

      try {
        const latestRows = await TicketsDB.listTickets({ limit: 1 });
        if (latestRows && latestRows.length) {
          const parts = latestRows[0].zone.split(',').map(s => s.trim()).filter(Boolean);
          window.__confirmedZones = new Set(parts.length ? parts : ['1']);
        } else {
          window.__confirmedZones = new Set(['1']);
        }
      } catch (e) { window.__confirmedZones = new Set(['1']); }
    } finally {
      // Always launch the UI — even if DB is unavailable the app is usable
      onReady();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pwaInit);
  } else {
    pwaInit();
  }
}

// Returns the discount % that will apply on the next purchase
async function getNextDiscountPercent() {
  const countLast30 = await TicketsDB.countTicketsInLastDays(30);
  const priceRow = await PriceDB.getPricesForTicketCount(countLast30 + 1);
  return priceRow ? Number(priceRow.discount_percent) || 0 : 0;
}

async function insertDiscountedTicketForPurchase(purchaseDate, { pruneTooRecentBeforeInsert = false, zones = null } = {}) {
  // --- (A) Optionally delete the last ticket if it's too close to this purchase ---
  if (pruneTooRecentBeforeInsert) {
    const lastRows = await TicketsDB.listTickets({ limit: 1 }); // newest first
    if (lastRows && lastRows.length) {
      const last = lastRows[0];
      const lastPurchase = new Date(last.purchased_at_iso);
      const diffMs = Math.abs(purchaseDate - lastPurchase);

      // Your "duplicate" rule: within 62 minutes of each other
      if (diffMs <= 62 * 60 * 1000) {
        await TicketsDB.deleteTicketById(last.id);
      }
    }
  }

  // --- (B) Compute date/time strings for the *new* ticket ---
  const purchase_date = fmtDate(purchaseDate);
  const purchase_time = fmtTime(purchaseDate);

  // --- (C) Now count how many tickets in the last 30 days ---
  // (the “too recent” one is already gone if it needed to be)
  const countLast30 = await TicketsDB.countTicketsInLastDays(30);

  // Discount is based on total tickets including this one
  const totalForPricing = countLast30 + 1;

  // --- (D) Resolve zones first (needed for price column selection) ---
  const rawZones = (zones && zones.length > 0) ? zones
    : (window.__confirmedZones && window.__confirmedZones.size > 0) ? [...window.__confirmedZones]
    : ['1'];
  const zoneStr   = sortZones(rawZones).join(',');
  const zoneCount = rawZones.length || 1;
  // Price table has columns zone1…zone5; cap at 5 for 5+ zone selections
  const zoneCol   = 'zone' + Math.min(zoneCount, 5);

  // --- (E) Lookup price row ---
  const priceRow = await PriceDB.getPricesForTicketCount(totalForPricing);

  let discount_percent = 0;
  let amount_display = '39,60'; // fallback

  if (priceRow) {
    discount_percent = Number(priceRow.discount_percent) || 0;
    const cents = Math.round(Number(priceRow[zoneCol]) * 100);
    amount_display = TicketsDB.formatAmount(cents);
  }

  return TicketsDB.addTicket({
    zone: zoneStr,
    adults: 1,
    purchase_date,
    purchase_time,
    ticket_number: TicketsDB.makeTicketNumber(),
    order_ref: TicketsDB.makeOrderRef(),
    amount_display,
    discount_percent
  });
}


const MIN_OFFSET_MINUTES = 60;  // expiry = now (0 min ago)
const MAX_OFFSET_MINUTES = 65;  // expiry = now - 5 min
let currentOffsetMinutes = 61; // default counter value

async function createTicketAtCurrentOffset() {
  const now = new Date();
  const zones = (window.__confirmedZones && window.__confirmedZones.size > 0)
    ? [...window.__confirmedZones] : ['1'];

  // currentOffsetMinutes encodes "expired N minutes ago" relative to a 60-min ticket.
  // expiredAgoMin = currentOffsetMinutes - 60  (e.g. 61-60 = 1 min ago)
  // For multi-zone tickets the purchase shifts earlier so expiry stays the same.
  const durationMin   = ticketDurationMs(zones.join(',')) / 60000;
  const expiredAgoMin = currentOffsetMinutes - 60;
  const purchase = new Date(now.getTime() - (durationMin + expiredAgoMin) * 60 * 1000);

  await insertDiscountedTicketForPurchase(purchase, {
    pruneTooRecentBeforeInsert: true,
    zones,
  });
}



function setOffsetMinutes(newValue) {
  if (newValue < MIN_OFFSET_MINUTES) newValue = MIN_OFFSET_MINUTES;
  if (newValue > MAX_OFFSET_MINUTES) newValue = MAX_OFFSET_MINUTES;
  currentOffsetMinutes = newValue;

  const label = document.getElementById('offsetLabel');
  if (label) {
    label.textContent = `Offset: ${currentOffsetMinutes} min`;
  }

  // Persist to DB (fire and forget)
  TicketsDB.setSetting('offsetMinutes', currentOffsetMinutes)
    .catch(err => console.error('Failed to save offsetMinutes', err));
}


const routes = {
  '#travel': renderTravel,
  '#tickets': renderTicketsLike,
  '#profile': renderProfile,
  '#settings': renderSettings,
  '#claim': renderClaimTicket,
  '#payment': renderPayment,
  '#expired_ticket': renderExpiredTicket,
  '#contact': renderContactUs,
  '#profile_info': renderProfileInfo,
  '#purchase_history': renderPurchaseHistory,
  '#buy_ticket': renderBuyTicket,
  '#zone': renderSelectZone,
  '#ticket_detail': renderTicketDetail,
  '#receipt_detail': renderReceiptDetail,
  '#reis': renderReis,
  '#intro_reis': renderIntroReis,
  '#quick_purchase': renderQuickPurchase,
  '#zones': renderZones,
}

// Global setter: page code calls setBack(goBack) to define the back behavior
function setBack(action){
  window.__backAction = action || null;
}

function onReady(){
  bindTabs()
  if(!location.hash) location.hash = '#travel'
  render()
  window.addEventListener('hashchange', render)
  document.addEventListener('backbutton', (e) => {
    if (typeof window.__backAction === 'function') {
        e.preventDefault();
        window.__backAction();   // do exactly what the header back does
      }
    }, false);
  const bg = getComputedStyle(document.body)
    .getPropertyValue('--color-bg')
    .trim();
  if (window.StatusBar) {
    StatusBar.overlaysWebView(false);
    StatusBar.backgroundColorByHexString(bg);
  }
}

function bindTabs(){
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      location.hash = btn.dataset.route
    })
  })
}

function setActiveTab(hash){
  document.querySelectorAll('.tab').forEach(btn => {
    const isActive = btn.dataset.route === hash
    btn.classList.toggle('active', isActive)

    // --- optional selected icon swap ---
    const img = btn.querySelector('img')
    if (!img) return

    // remember the normal src once
    if (!img.dataset.normalSrc) img.dataset.normalSrc = img.getAttribute('src')

    // Allow either the button or the img to provide explicit icon paths
    const normalFromBtn   = btn.dataset.icon
    const selectedFromBtn = btn.dataset.iconSelected
    const normalFromImg   = img.dataset.icon
    const selectedFromImg = img.dataset.iconSelected

    // Fallback: derive Foo2.svg from Foo.svg
    const derivedSelected = img.dataset.normalSrc
      ? img.dataset.normalSrc.replace(/(\.svg)$/i, '2$1')
      : null

    const selectedSrc = selectedFromBtn || selectedFromImg || derivedSelected
    const normalSrc   = normalFromBtn || normalFromImg || img.dataset.normalSrc

    if (isActive && selectedSrc) {
      img.setAttribute('src', selectedSrc)
    } else if (normalSrc) {
      img.setAttribute('src', normalSrc)
    }
  })
}


function showOverflow(on){
  const btn = document.getElementById('overflow')
  btn.style.display = on ? 'block' : 'none'
}

async function render() {
  const hash = location.hash || '#travel'
  const view = document.getElementById('view')
  const title = document.getElementById('title')
  const titleCopy = document.querySelector('.title-copy')

  let res;
  try {
    const fn = routes[hash] || renderTicketsLike
    let r = fn()
    if (r && typeof r.then === 'function') r = await r
    res = r
  } catch(e) {
    console.error('[render] route failed:', e)
    res = {
      html: `<div style="padding:24px;color:#fffffe;font-size:15px;opacity:0.7">Failed to load page.<br><small>${e && e.message ? e.message : e}</small></div>`,
      title: '', tab: hash, disableOverscroll: false
    }
  }
  view.innerHTML = res.html

  // reset body classes
  document.body.classList.remove('page-profile','page-tickets','page-tickets-home','page-travel','page-claim', 'page-payment');

  if (res.tab === '#profile') {
    document.body.classList.add('page-profile');
  } else if (res.tab === '#tickets') {
    document.body.classList.add('page-tickets');
    // collapsed large-title header only on the main tickets list (not sub-pages
    // like Buy ticket / Reis that share tab '#tickets')
    if (hash === '#tickets') document.body.classList.add('page-tickets-home');
  } else if (res.tab === '#travel') {
    document.body.classList.add('page-travel');
  } else if (res.tab === '#claim') {
    document.body.classList.add('page-claim');
  } else if (res.tab === '#payment') {
    document.body.classList.add('page-payment');
  } else if (res.tab === '#contact') {
    document.body.classList.add('page-contact');
  } else if (res.tab === '#zone') {
    document.body.classList.add('page-zone');
  }

  // update only the second title line
  if (titleCopy) titleCopy.textContent = res.title

  setActiveTab(res.tab)
  view.classList.toggle('no-overscroll', res.disableOverscroll === true)

  // Hide the bottom tab bar on the Buy Ticket page
  const tabs = document.querySelector('.tabs'); // <nav class="tabs">…</nav>
  if (tabs) {
    const hide = (hash === '#buy_ticket');
    // 1) toggle the attribute (good default)
    tabs.toggleAttribute('hidden', hide);
    // 2) and hard-enforce with !important in case site CSS overrides it
    tabs.style.setProperty('display', hide ? 'none' : '', 'important');
  }

  // --- handle topbar visibility based on tab ---
  const topbar = document.querySelector('.topbar');
  if (topbar) {
    if (res.tab === '#travel') {
      topbar.style.setProperty('display','none','important');
    } else {
      topbar.style.removeProperty('display');
    }
  }

  // --- handle overflow icon visibility ---
  const overflowBtn = document.getElementById('overflow')
  const overflowIcon = overflowBtn ? overflowBtn.querySelector('img') : null
  if (overflowIcon) {
    // overflow only on the main tickets home, never on ticket sub-pages
    const onTickets = location.hash === '#tickets'
    overflowIcon.style.display = onTickets ? 'block' : 'none'
  }


  // Topbar back-button state is owned ENTIRELY here. render() runs on every
  // hashchange, so we deterministically (a) run any pending cleanup from the
  // previous page, (b) reset to the plain topbar, then (c) apply the back
  // button if this page declares one. There are NO per-page hashchange
  // listeners — those raced with render's own async continuation (a microtask
  // checkpoint runs between event listeners, so a stale cleanup listener fired
  // *after* render had already installed the new back button, wiping it).
  const topbarEl = document.querySelector('.topbar');
  const titleEl  = document.getElementById('title');
  if (topbarEl && titleEl) {
    // (a) pending cleanup from previous page (e.g. injectBackButton onCleanup)
    if (typeof window.__topbarCleanup === 'function') {
      try { window.__topbarCleanup(); } catch (_) {}
    }
    window.__topbarCleanup = null;

    // (b) reset to plain topbar
    topbarEl.classList.remove('mode-expired');
    titleEl.textContent = '';
    if (typeof setBack === 'function') setBack(null);

    // (c) apply declarative back button if the page asks for one
    if (res.backButton) {
      topbarEl.classList.add('mode-expired');
      titleEl.innerHTML = `
        <button class="back-btn" aria-label="Back">
          <img src="icons/chevron-right-expired.svg" alt="" class="icon-20 chevron-left">
        </button>
        ${res.backButton.label}
      `;
      const goBack = () => { location.hash = res.backButton.dest; };
      const backBtnEl = titleEl.querySelector('.back-btn');
      if (backBtnEl) backBtnEl.onclick = goBack;
      if (typeof setBack === 'function') setBack(goBack);
    }
  }

  // keep running afterRender hook if defined
  if (typeof res.afterRender === 'function') res.afterRender()
}

function renderTravel(){
  const html = `
    <section class="travel-root">
      <!-- Fullscreen interactive map -->
      <div id="travelMap" class="travel-map" aria-hidden="false" style="position:absolute; inset:0;"></div>

      <!-- Foreground draggable sheet -->
      <div id="travelSheet" class="sheet" aria-modal="true">
        <div class="sheet__grab"></div>

        <div class="sheet__content">
          <div class="sheet__greeting">${getGreeting()}</div>

          <div class="finder" id="finder">
            <div class="sheet-bkgd"></div>
            <div class="finder__tabs" role="tablist" aria-label="Travel options">
              <button class="finder__tab is-active" role="tab" aria-selected="true" data-tab="journey">Find journey</button>
              <button class="finder__tab" role="tab" aria-selected="false" data-tab="departures">See departures</button>
            </div>

            <!-- Panel: Find journey -->
            <div class="finder__panel is-active" role="tabpanel" data-panel="journey">
              <div class="finder-grid">
                <div class="finder-label">From</div>
                <input class="finder-input" id="fromInput" type="text" placeholder="Your location" autocomplete="off" inputmode="text">

                <div class="finder-sep"></div>

                <div class="finder-label">To</div>
                <input class="finder-input" id="toInput" type="text" placeholder="Destination" autocomplete="off" inputmode="text">
              </div>
            </div>

            <!-- Panel: See departures  -->
            <div class="finder__panel" role="tabpanel" aria-hidden="true" data-panel="departures">
              <div class="finder-grid">
                <div class="finder-label">From</div>
                <input class="finder-input" id="fromInput2" type="text" placeholder="Stop" autocomplete="off" inputmode="text">
              </div>
            </div>
          </div>


          <div class="section-h">Favorites</div>
          <button class="tile" id="tileAddFav">
            <img class="tile__icon-left" src="icons/pick_up_houses.svg" alt="" decoding="async">
            <div class="tile__main">
              <div class="tile__title">Add new favourite</div>
              <div class="tile__sub">A shortcut to your most frequently used stops, lines and addresses</div>
            </div>
            <img src="icons/plus2.svg" class="icon-24 plus" alt="">
          </button>

          <div class="section-h">Other services</div>
          <button class="tile" id="tileScooter">
            <img class="tile__icon-left" src="icons/scooter.svg" alt="" decoding="async">
            <div class="tile__main">
              <div class="tile__title">Are you in Akershus?</div>
              <div class="tile__sub">Enable e-scooters and ride directly in the app</div>
            </div>
            <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
          </button>


          <div style="height:24vh"></div>
        </div>
      </div>
    </section>
  `;

  return {
    html,
    title: 'Travel',
    tab: '#travel',
    overflow: false,
    disableOverscroll: true,
    afterRender(){

        // If mapboxgl is not available, do not try to create a map
        if (!window.mapboxgl) {
          console.error('Mapbox GL JS not available; skipping map init');
          return;
        }

        const map = new mapboxgl.Map({
          container: 'travelMap',
          style: 'mapbox://styles/yannorth/cmhw4pl95004901sf7wvcf9gl',
          center: [10.7397, 59.9036],
          zoom: 12,
          pitch: 0,
          attributionControl: false
        });

      // Optional Geolocation control
      const geo = new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showUserHeading: true,
        showUserLocation: true
      });
      map.addControl(geo, 'top-right');

      // Store map reference for padding updates, then set initial padding
      window.__travelMap = map;
      map.on('load', () => {
        // Initial sheet offset is 52vh — center map in the visible top portion
        updateMapPadding(52, false);
        try { geo.trigger(); } catch (e) { /* ignore if permissions not granted yet */ }
      });


      // --- Android touch-only bottom-sheet drag with safe click threshold ---
      const sheet = document.getElementById('travelSheet');

      const DRAG_START_PX = 8;                            // movement before we treat as drag
      const INTERACTIVE_SEL = 'input, textarea, select, button, a, [contenteditable], .finder__tab';

      let startY = 0;
      let startOffset = 0;                                // current --sheet-offset (vh) at touchstart
      let dragging = false;
      let primed = false;

      const getOffset = () =>
        parseFloat(getComputedStyle(sheet).getPropertyValue('--sheet-offset')) || 0;

      // call your existing function; if you named it differently, use that
      // Re-center the map inside the visible (unobscured) portion above the sheet
      const updateMapPadding = (offsetVh, animate = false) => {
        const m = window.__travelMap;
        if (!m) return;
        const mapH   = m.getContainer().clientHeight;
        const sheetTopPx = offsetVh / 100 * window.innerHeight; // translateY amount
        const bottomPad  = Math.max(0, mapH - sheetTopPx);
        m.easeTo({ padding: { bottom: bottomPad }, duration: animate ? 220 : 0 });
      };

      const setOffsetVH = (vh, animate = false) => {
        sheet.style.setProperty('--sheet-offset', vh + 'vh');
        sheet.classList.toggle('sheet--anim', !!animate);
        updateMapPadding(vh, animate);
      };

      // optional: your snap logic, or call your existing snapTo('half'|'expanded'|'collapsed')
      const snapToNearest = () => {
        // Example: snap to 20 / 52 / 86 (vh) — replace with your STOPS and logic if you have it
        const stops = [20, 52, 86];
        const cur = getOffset();
        let best = stops[0], d = Math.abs(cur - best);
        for (let i = 1; i < stops.length; i++) {
          const di = Math.abs(cur - stops[i]);
          if (di < d) { d = di; best = stops[i]; }
        }
        setOffsetVH(best, true);
      };

      sheet.addEventListener('touchstart', (e) => {
        // If touch starts on an interactive element, let it click/focus normally
        if (e.target.closest(INTERACTIVE_SEL)) { dragging = false; primed = false; return; }

        primed = true;            // maybe a drag (we haven't decided yet)
        dragging = false;

        startY = e.touches[0].clientY;
        startOffset = getOffset();
      }, { passive: true });

      sheet.addEventListener('touchmove', (e) => {
        if (!primed && !dragging) return;

        const y = e.touches[0].clientY;

        if (!dragging) {
          // don’t block taps until the finger has clearly moved
          if (Math.abs(y - startY) < DRAG_START_PX) return;
          dragging = true;
        }

        // From here on it's a drag: take control of the gesture
        e.preventDefault();

        const dyPx = y - startY;
        const dyVh = (dyPx / window.innerHeight) * 100;  // px → vh
        let next = startOffset + dyVh;

        // clamp (adjust to your bounds)
        const MIN = 20, MAX = 86; // example values; use your real bounds
        if (next < MIN) next = MIN;
        if (next > MAX) next = MAX;

        setOffsetVH(next, false);
      }, { passive: false });

      sheet.addEventListener('touchend', () => {
        if (!primed) return;

        // If we never crossed the threshold, treat it as a tap
        if (!dragging) { primed = false; return; }

        dragging = false;
        primed = false;
        snapToNearest();          // or your existing snapTo(...)
      }, { passive: true });

      // --- Finder tabs wiring ---
      const finder = document.getElementById('finder');
      if (finder) {
        const tabs   = finder.querySelectorAll('.finder__tab');
        const panels = finder.querySelectorAll('.finder__panel');

        const activate = (name) => {
          tabs.forEach(t => {
            const on = t.dataset.tab === name;
            t.classList.toggle('is-active', on);
            t.setAttribute('aria-selected', on ? 'true' : 'false');
          });
          panels.forEach(p => {
            const on = p.dataset.panel === name;
            p.classList.toggle('is-active', on);
            p.toggleAttribute('aria-hidden', !on);
          });
        };

        tabs.forEach(t => {
          t.addEventListener('click', () => activate(t.dataset.tab));
        });
      }




    }
  };
}

async function renderTicketsLike(){
  // Get the latest ticket (newest first)
  let rows = [];
  try { rows = await TicketsDB.listTickets({ limit: 1 }); } catch(e) { console.warn('[renderTicketsLike] DB unavailable:', e); }
  let expiredTime;

  if (rows && rows.length) {
    // Expiration = purchase + duration based on zone count
    const start = new Date(rows[0].purchased_at_iso);
    const exp = new Date(start.getTime() + ticketDurationMs(rows[0].zone));
    expiredTime = fmtHHMM(exp);
  } else {
    const now = new Date();
    now.setMinutes(now.getMinutes() - 3);
    expiredTime = fmtHHMM(now);
  }

  const html = `
    <h1 id="tickets-scroll-heading" class="tickets-scroll-heading">Tickets</h1>

    <section class="card dashed">
      <img src="icons/dashed_box.svg" alt="" class="frame" aria-hidden="true">

      <div class="dashed-content">
        <img src="icons/empty.svg" alt="" class="illus">
        <div class="dashed-text">You have no tickets</div>
      </div>
    </section>

    <section class="card info" id="expiredCard">
      <img src="icons/info.svg" class="icon-24" alt="">
      <div class="ticket-expired">
        <strong>Your single ticket expired at ${expiredTime}.</strong> If you boarded before this, you can stay on board until you reach your stop.
      </div>
      <img src="icons/chevron-right-expired.svg" class="icon-24 expired-arrow" alt="">
    </section>

    <button class="buy-ticket" id="buyTicket">Buy ticket</button>

    <div class="section-row">
      <h3 class="section-title profile">Quick purchase</h3>
      <button class="see-all-btn" id="seeAllBtn">See all</button>
    </div>

    <div class="qp-list">
      <div class="qp-tiles">
        <div class="row-main">
          <div class="qp-row-title">Single ticket</div>
          <div class="qp-row-sub" id="qpZoneLabel">1 Adult, Zone 1</div>
        </div>
        <button class="qp-buy-btn">Buy</button>
      </div>

      <div class="qp-tiles">
        <div class="row-main">
          <div class="qp-row-title">Single ticket</div>
          <div class="qp-row-sub">1 Adult, Zones 1 and 2V</div>
        </div>
        <button class="qp-buy-btn">Buy</button>
      </div>
    </div>

    <h3 class="section-title discount-title">Your discount</h3>
    <div class="discount-card card" id="discountCard">
      <img src="icons/buyticket_reis.svg" alt="" class="discount-illus">
      <div class="discount-info">
        <span class="discount-pct" id="discountPct"></span>
        <span class="discount-sub">Your next Reis discount</span>
      </div>
      <img src="icons/chevron-right.svg" alt="" class="chev discount-chev">
    </div>

    <!-- Offset controls -->
    <div class="offset-controls" style="margin-top:8px;">
      <div class="offset-buttons" style="display:flex;">
        <button
          id="offsetPlus"
          style="flex:1; height:220px; margin:0; border-radius:0; border:0px solid #000000ff; background:none; font-size:12px;">

        </button>
        <button
          id="offsetMinus"
          style="flex:1; height:220px; margin:0; border-radius:0; border:0px solid #000000ff; background:none; font-size:12px;">

        </button>
      </div>
    </div>
  `;

  return {
    html,
    title: 'Tickets',
    tab: '#tickets',
    overflow: false,
    disableOverscroll: true,
    afterRender(){
      // Scroll-aware topbar title: the big in-page heading scrolls with content;
      // once it slides up behind the topbar, a mini "Tickets" title fades in next
      // to the overflow icon (via the .is-scrolled band).
      const topbarEl2 = document.querySelector('.topbar');
      const miniTitle = document.getElementById('title');
      const scrollHeading = document.getElementById('tickets-scroll-heading');
      const viewEl = document.getElementById('view');
      if (topbarEl2 && miniTitle && scrollHeading && viewEl) {
        // set the text once; visibility is driven by CSS opacity so it fades
        miniTitle.textContent = 'Tickets';
        const apply = (scrolled) => {
          topbarEl2.classList.toggle('is-scrolled', scrolled);
        };
        apply(false);

        const obs = new IntersectionObserver(entries => {
          // mini title shows only once the big heading has scrolled fully out
          // the top of the scroll view
          apply(!entries[0].isIntersecting);
        }, {
          root: viewEl,
          rootMargin: '0px',
          threshold: 0
        });
        obs.observe(scrollHeading);

        // Cleanup: called by render() on next navigation
        window.__topbarCleanup = () => {
          obs.disconnect();
          topbarEl2.classList.remove('is-scrolled');
          miniTitle.textContent = '';
          miniTitle.style.opacity = '';
        };
      }

      const btn = document.getElementById('buyTicket');
      if (btn) {
        let pressTimer = null;
        let longPressed = false;

        const startPress = () => {
          longPressed = false;
          pressTimer = setTimeout(async () => {
          longPressed = true;
          try {
            await createTicketAtCurrentOffset();
            render(); // refresh expired time
          } catch (err) {
            console.error('Failed to create ticket on long press', err);
          }
        }, 800);

        };

        const cancelPress = () => {
          if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
          }
        };

        // Long press listeners
        btn.addEventListener('mousedown', startPress);
        btn.addEventListener('touchstart', startPress, { passive: true });
        ['mouseup','mouseleave','mouseout','touchend','touchcancel'].forEach(ev =>
          btn.addEventListener(ev, cancelPress)
        );

        // Normal short click: go to Buy ticket page
        btn.addEventListener('click', (e) => {
          if (longPressed) {
            // swallow the click that follows a long press
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          location.hash = '#buy_ticket';
        });
      }

      // --- Offset buttons below Quick purchase ---
      // Initialize label to current value
      setOffsetMinutes(currentOffsetMinutes);

      function makeDoubleTapHandler(callback, delay = 300) {
        let lastTapTime = 0;

        return async function (event) {
          const now = Date.now();

          if (now - lastTapTime < delay) {
            // This is the second tap of a double tap
            lastTapTime = 0; // reset so a new pair can be detected next time
            event.preventDefault();
            event.stopPropagation();
            await callback(event);
          } else {
            // First tap: just remember and wait to see if another tap comes soon
            lastTapTime = now;
          }
        };
      }

      

      const minusBtn = document.getElementById('offsetMinus');
      const plusBtn  = document.getElementById('offsetPlus');

      if (minusBtn) {
        minusBtn.addEventListener('click', makeDoubleTapHandler(async () => {
          setOffsetMinutes(currentOffsetMinutes - 1); // clamp happens inside
          await createTicketAtCurrentOffset();
          render();
        }));
      }

      if (plusBtn) {
        plusBtn.addEventListener('click', makeDoubleTapHandler(async () => {
          setOffsetMinutes(currentOffsetMinutes + 1); // clamp happens inside
          await createTicketAtCurrentOffset();
          render();
        }));
      }

      const expiredCard = document.getElementById('expiredCard');
      if (expiredCard) {
        expiredCard.addEventListener('click', () => {
          location.hash = '#expired_ticket';
        });
      }

      // Discount card → navigate to Reis page + load %
      const discountCard = document.getElementById('discountCard');
      if (discountCard) discountCard.onclick = () => { location.hash = '#reis'; };
      const pctEl = document.getElementById('discountPct');
      if (pctEl) getNextDiscountPercent().then(pct => { pctEl.textContent = pct + '%'; });

      // Quick purchase tiles and Buy buttons
      document.querySelectorAll('.qp-tiles, .qp-tiles .qp-buy-btn').forEach(el => {
        el.addEventListener('click', () => {
          location.hash = '#buy_ticket';
        });
      });

      // See all → Quick purchase (full list) page
      const seeAllBtn = document.getElementById('seeAllBtn');
      if (seeAllBtn) {
        seeAllBtn.addEventListener('click', () => {
          location.hash = '#quick_purchase';
        });
      }

      // Reflect confirmed zone selection in Quick purchase first tile
      const qpZoneLabel = document.getElementById('qpZoneLabel');
      if (qpZoneLabel && window.__confirmedZones && window.__confirmedZones.size > 0) {
        qpZoneLabel.textContent = `1 Adult, ${fmtConfirmedZones(window.__confirmedZones)}`;
      }
    }
  };
}

async function renderReis() {
  // Last 30 days stats from tickets DB + live discount %
  const [allTickets, nextDiscount] = await Promise.all([
    TicketsDB.listTickets({ limit: 200 }),
    getNextDiscountPercent()
  ]);
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const last30 = allTickets.filter(t => t.purchased_at_iso >= cutoff);
  const count30 = last30.length;
  const spent30cents = last30.reduce((sum, t) => sum + (t.amount_cents || 0), 0);
  const spentDisplay = TicketsDB.formatAmount(spent30cents);

  const html = `
    <div class="reis-discount-card card">
      <img src="icons/buyticket_reis.svg" alt="" class="reis-illus">
      <div class="reis-info">
        <span class="reis-pct">${nextDiscount}%</span>
        <span class="reis-sub">Your personal discount</span>
      </div>
    </div>

    <h3 class="section-title reis-period">The last 30 days</h3>

    <div class="reis-stats">
      <div class="reis-stat-card card">
        <div class="reis-stat-label">Spent</div>
        <div class="reis-stat-value">${spentDisplay} kr</div>
      </div>
      <div class="reis-stat-card card">
        <div class="reis-stat-label">Purchased</div>
        <div class="reis-stat-value">${count30} ticket${count30 !== 1 ? 's' : ''}</div>
      </div>
    </div>

    <h3 class="section-title reis-period">Read more</h3>

    <button class="reis-read-card card" id="introReisBtn">
      <img src="icons/reispick.svg" alt="" class="reis-read-illus">
      <div class="reis-read-text">Intro to Reis – single tickets with a discount</div>
      <img src="icons/chevron-right.svg" alt="" class="chev">
    </button>
  `;

  return {
    html,
    title: 'Reis',
    tab: '#tickets',
    overflow: false,
    disableOverscroll: false,
    backButton: { label: 'Reis', dest: '#tickets' },
    afterRender() {
      const introBtn = document.getElementById('introReisBtn');
      if (introBtn) introBtn.onclick = () => { location.hash = '#intro_reis'; };
    }
  };
}

async function renderIntroReis() {
  const html = `
    <div class="intro-reis-illus-wrap">
      <img src="icons/buyticket_reis.svg" alt="" class="intro-reis-illus">
    </div>

    <h2 class="intro-reis-title">Travel with a discount!</h2>

    <p class="intro-reis-bold">With Reis, you get a personal discount on single tickets based on how often you travel.</p>

    <p class="intro-reis-body">Reis is perfect if you travel occasionally or aren't sure how much you'll be travelling in the future.</p>

    <p class="intro-reis-body">Your discount is calculated based on how many single tickets you've bought for yourself in the last 30 days. The more you travel, the higher your discount.</p>

    <p class="intro-reis-body">You get your first discount on your fifth ticket. The discount then increases with every fifth ticket you buy.</p>

    <div class="intro-reis-link card">
      <span class="intro-reis-link-text">Read more about Reis</span>
      <div class="icon-circle icon-circle--blue">
        <img src="icons/link2.svg" alt="" class="icon-24">
      </div>
    </div>
  `;

  return {
    html,
    title: 'Intro to Reis',
    tab: '#tickets',
    overflow: false,
    disableOverscroll: false,
    backButton: { label: 'Intro to Reis', dest: '#reis' },
  };
}

async function renderExpiredTicket(){
  // Get the most recent ticket from the DB
  const rows = await TicketsDB.listTickets({ limit: 1 });

  let expiredTime;
  let zoneLabel = 'Zone 1';
  let adultsLabel = '1 adult';

  if (rows && rows.length) {
    const ticket = rows[0];

    zoneLabel   = fmtZone(ticket.zone);
    adultsLabel = `${ticket.adults} adult${ticket.adults > 1 ? 's' : ''}`;
    const exp   = new Date(new Date(ticket.purchased_at_iso).getTime() + ticketDurationMs(ticket.zone));
    expiredTime = fmtHHMM(exp);
  } else {
    const now = new Date();
    now.setMinutes(now.getMinutes() - 3);
    expiredTime = fmtHHMM(now);
  }

  const html = `
    <section class="ticket-hero card">
      <div class="ticket-eyebrow">Single ticket</div>
      <div class="ticket-title">Expired ticket</div>

      <div class="ticket-meta">
        <div class="meta-item">
          <img class="ticket-icon" src="icons/happy.svg" alt="">
          <span>${adultsLabel}</span>
        </div>
        <div class="meta-item">
          <img class="ticket-icon" src="icons/zone.svg" alt="">
          <span>${zoneLabel}</span>
        </div>
      </div>
    
      <section class="card info-expired info--inline">
        <img src="icons/info.svg" class="icon-24" alt="">
        <div class="ticket-expired">
          Your single ticket expired at ${expiredTime}. If you boarded before this, you can stay on board until you reach your stop.
        </div>
      </section>
    </section>
  `;

  return {
    // Expired ticket rendering
    html,
    title: 'Your ticket',
    tab: '#tickets',
    overflow: false,
    disableOverscroll: true,
    backButton: { label: 'Your ticket', dest: '#tickets' },
    afterRender(){
      const backBtn = document.getElementById('back');
      if (backBtn) {
        backBtn.classList.add('back--active');
        backBtn.onclick = () => { location.hash = '#tickets'; };
      }
    }
  };
}

async function renderProfile(){
  let profileName = 'Yannis Montreer';
  try { profileName = await TicketsDB.getSetting('profileName', 'Yannis Montreer') || profileName; } catch(e) { console.warn('[renderProfile] DB unavailable:', e); }

  const html = `
    <section class="profile-banner">
      <div class="left">
        <img src="icons/happy.svg" class="icon-happy" alt="">
        <div class="text">Turn on two-step verification for a more secure profile</div>
      </div>
      <div class="cta">Turn on</div>
    </section>

    <div class="profile-info" id="profileInfo">
      <img src="icons/Yan.svg" class="avatar-40" alt="">
      <div class="text-group">
        <div class="name">${profileName}</div>
        <div class="subtitle">Your information</div>
      </div>
      <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
    </div>

    <div class="list">
      <div class="list-row" id="settingsRow">
        <img src="icons/gear.svg" class="icon-24" alt="">
        <div class="row-title">Settings</div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
    </div>

    <h3 class="section-title profile">Tickets and payment</h3>
    <div class="list">
      <div class="list-row" id="purchaseHistory">
        <img src="icons/receipt.svg" class="icon-24" alt="">
        <div class="row-title">Purchase history</div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
      <div class="list-row" id="claimTicket">
        <img src="icons/download.svg" class="icon-24" alt="">
        <div class="row-title">Claim ticket</div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
      <div class="list-row" id="paymentMethod">
        <img src="icons/card.svg" class="icon-24" alt="">
        <div class="row-title">Payment methods</div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
    </div>

    <h3 class="section-title profile">Your journeys</h3>
    <div class="list">
      <div class="list-row">
        <img src="icons/accessibility.svg" class="icon-24" alt="">
        <div class="row-title">Accessibility</div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
      <div class="list-row">
        <img src="icons/star.svg" class="icon-24" alt="">
        <div class="row-title">Favourites</div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
      <div class="list-row">
        <img src="icons/bookmark.svg" class="icon-24" alt="">
        <div class="row-title">Saved journeys</div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
    </div>

    <h3 class="section-title profile">Explore</h3>
    <div class="list">
      <div class="list-row">
        <img src="icons/lock.svg" class="icon-24" alt="">
        <div class="row-title">New concepts</div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
    </div>

    <h3 class="section-title profile">Support</h3>
    <div class="list">
      <div class="list-row" id="contact">
        <img src="icons/chat.svg" class="icon-24" alt="">
        <div class="row-title">Contact us</div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
      <div class="list-row">
        <img src="icons/document.svg" class="icon-24" alt="">
        <div class="row-title">Terms and privacy</div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
      <div class="list-row">
          <img src="icons/link.svg" class="icon-24" alt="">
        <div class="row-title">Accessibility statement</div>
        <div class="right-affordance">
          <div class="icon-circle icon-circle--blue">
            <img src="icons/link2.svg" alt="">
          </div>
        </div>
      </div>

    <section class="card center" style="background:transparent;">
      <button class="log-out">Log out</button>
    </section>

    <div class="center subtle" style="padding:2.5vh 0">Version 7.92.2 (28667)</div>
  `;

  return {
    html,
    title:'Profile',
    tab:'#profile',
    overflow:false,
    disableOverscroll:false,
    afterRender(){
      const info = document.getElementById('profileInfo');
      const ph = document.getElementById('purchaseHistory');
      const settings = document.getElementById('settingsRow');
      const claim = document.getElementById('claimTicket');
      const payment = document.getElementById('paymentMethod');
      const contact = document.getElementById('contact');
      if(info) info.addEventListener('click', () => location.hash = '#profile_info');
      if(ph) ph.addEventListener('click', () => location.hash = '#purchase_history');
      if (settings) settings.addEventListener('click', () => { location.hash = '#settings'; });
      if (claim) claim.addEventListener('click', () => { location.hash = '#claim'; });
      if (payment) payment.addEventListener('click', () => { location.hash = '#payment'; });
      if (contact) contact.addEventListener('click', () => { location.hash = '#contact'; });
    }
  }
}

function renderSettings(){
  const html = `

    <h3 class="section-title settings">Tailor the app to your needs for a better travel experience</h3>
    <div class="list">
      <div class="list-row" id="purchaseHistory">
        <img src="icons/bell.svg" class="icon-24" alt="">
        <div class="row-title">Notifications</div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
    </div>

    <h3 class="section-title settings">Travel search</h3>
    <div class="list">
      <div class="list-row">
        <img src="icons/walk.svg" class="icon-24" alt="">
        <div class="row-title">Your tempo</div>
        <div class="row-title" style="color:#b4b4be;">Moderate</div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
      <div class="list-row">
        <img src="icons/clock.svg" class="icon-24" alt="">
        <div class="row-title"style="line-height: 1;">Extra time during transfer</div>
        <div class="row-title settings" style="color:#b4b4be;">0 min</div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
    </div>
  `;

  return {
    html,
    title: 'Settings',
    tab: '#profile',
    overflow: false,
    disableOverscroll: false,
    afterRender() {
      injectBackButton('Settings', () => { location.hash = '#profile'; });
    }
  };
}

function renderClaimTicket(){
  const html = `
    <div class="claim-page">
      <h3 class="section-title settings">Pickup code</h3>
      <input class="claim-input" id="fromInput" type="text" placeholder="AB-AB-ABC" autocomplete="off" inputmode="text">

      <button class="buy-ticket claim-bottom" style="font-weight:500;">Claim ticket</button>
    </div>
  `;

  return {
    html,
    title:'ClaimTicket',
    tab:'#claim',
    overflow:false,
    disableOverscroll:false,
    afterRender() {
      injectBackButton('Claim ticket', () => { location.hash = '#profile'; });
    }
  };
}

function renderPayment(){
  const html = `
    <div class="claim-page">
      <div class="list">
      <div class="list-row">
        <img src="icons/mastercard.svg" class="icon-24 payment" alt="">
        <div class="row-main">
          <div class="qp-row-title">Mastercard</div>
          <div class="qp-row-sub">⦁⦁⦁⦁ 7924</div>
        </div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
      <div class="list-row">
        <img src="icons/visa.svg" class="icon-24 payment" alt="">
        <div class="row-main">
          <div class="qp-row-title">Visa</div>
          <div class="qp-row-sub">⦁⦁⦁⦁ 5105</div>
        </div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
    </div>

      <button class="buy-ticket claim-bottom" style="font-weight:500;">Add</button>
    </div>
  `;

  return {
    html,
    title:'Payment',
    tab:'#payment',
    overflow:false,
    disableOverscroll:false,
    afterRender() {
      injectBackButton('Payment methods', () => { location.hash = '#profile'; });
    }
  };
}

/**
 * Show a modal edit popup.
 * @param {string}   label        Field label shown as title
 * @param {string}   currentValue Pre-filled value
 * @param {string}   inputType    'text' | 'tel' | 'email'
 * @param {Function} onSave       Async callback(newValue)
 */
function showEditPopup(label, currentValue, inputType, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'edit-popup-overlay';
  overlay.innerHTML = `
    <div class="edit-popup">
      <div class="edit-popup-title">${label}</div>
      <input class="edit-popup-input" type="${inputType}"
             value="${currentValue.replace(/"/g, '&quot;')}" autocomplete="off">
      <div class="edit-popup-buttons">
        <button class="edit-popup-btn edit-popup-cancel">Cancel</button>
        <button class="edit-popup-btn edit-popup-ok">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('.edit-popup-input');
  // Focus + select all after a tick so the keyboard opens properly
  setTimeout(() => { input.focus(); input.select(); }, 50);

  const close = () => overlay.remove();

  overlay.querySelector('.edit-popup-cancel').addEventListener('click', close);
  overlay.querySelector('.edit-popup-ok').addEventListener('click', async () => {
    const val = input.value.trim();
    if (val) await onSave(val);
    close();
  });
  // Tap on dim background also closes (cancels)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

async function renderProfileInfo(){
  // Load persisted values (fall back to defaults on first run)
  const [name, phone, email] = await Promise.all([
    TicketsDB.getSetting('profileName',  'Yannis Montreer'),
    TicketsDB.getSetting('profilePhone', '+4741234385'),
    TicketsDB.getSetting('profileEmail', 'jean.michel.katze@gmail.com'),
  ]);

  const html = `
    <div class="list yourinfo">
      <div class="list-row info-row" id="infoRowName">
        <div class="row-main">
          <div class="qp-row-title">Name</div>
          <div class="qp-row-sub" id="infoValName">${name}</div>
        </div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
      <div class="list-row info-row" id="infoRowPhone">
        <div class="row-main">
          <div class="qp-row-title">Phone number</div>
          <div class="qp-row-sub" id="infoValPhone">${phone}</div>
        </div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
      <div class="list-row info-row" id="infoRowEmail">
        <div class="row-main">
          <div class="qp-row-title">Email</div>
          <div class="qp-row-sub" id="infoValEmail">${email}</div>
        </div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
    </div>

    <div class="list">
      <div class="list-row">
        <div class="row-title">Two-step verification</div>
        <img src="icons/toggle.svg" class="icon-24 chev toggle" alt="">
      </div>
    </div>

    <h3 class="section-title yourinfo">Make your profile more secure by creating a password.</h3>

    <div class="list delete">
      <div class="list-row">
        <div class="row-title" style="color:#ee7e8b;">Delete profile</div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
    </div>
  `;

  return {
    html,
    title: 'Your information',
    tab: '#profile',
    overflow: false,
    disableOverscroll: false,
    afterRender(){
      injectBackButton('Your information', () => { location.hash = '#profile'; });

      // Field definitions: row id, value id, label, DB key, input type
      const fields = [
        { rowId: 'infoRowName',  valId: 'infoValName',  label: 'Name',         key: 'profileName',  type: 'text'  },
        { rowId: 'infoRowPhone', valId: 'infoValPhone', label: 'Phone number',  key: 'profilePhone', type: 'tel'   },
        { rowId: 'infoRowEmail', valId: 'infoValEmail', label: 'Email',         key: 'profileEmail', type: 'email' },
      ];

      fields.forEach(({ rowId, valId, label, key, type }) => {
        const row = document.getElementById(rowId);
        if (!row) return;

        let pressTimer = null;

        const startPress = () => {
          pressTimer = setTimeout(() => {
            pressTimer = null;
            const current = document.getElementById(valId)?.textContent.trim() || '';
            showEditPopup(label, current, type, async (newVal) => {
              // Persist
              await TicketsDB.setSetting(key, newVal);
              // Update displayed value
              const el = document.getElementById(valId);
              if (el) el.textContent = newVal;
              // Cascade name changes
              if (key === 'profileName') {
                const firstName = newVal.split(' ')[0];
                window.__profileFirstName = firstName;
                await TicketsDB.setSetting('firstName', firstName);
                // Update Profile page card if currently visible
                const profileNameEl = document.querySelector('.profile-info .name');
                if (profileNameEl) profileNameEl.textContent = newVal;
              }
            });
          }, 3000);
        };

        const cancelPress = () => {
          if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        };

        row.addEventListener('touchstart',  startPress,  { passive: true });
        row.addEventListener('touchend',    cancelPress, { passive: true });
        row.addEventListener('touchcancel', cancelPress, { passive: true });
        row.addEventListener('touchmove',   cancelPress, { passive: true });
      });
    }
  };
}

function renderContactUs(){
  const html = `
  <div class="claim-page">
    <img src="icons/contact_us.svg" alt="" class="icon-24 contact-us">

    <button class="buy-ticket" style="font-weight:600; font-size:clamp(14px, 4.5vw, 18px); margin-bottom: 2vh;">
      <img src="icons/call.svg" style="margin-right:2vw;" class="icon-24">
      Call customer support
    </button>

    <button class="buy-ticket" style="font-weight:600; color: #88b7fe; font-color:#88b7fe; font-size:clamp(14px, 4.5vw, 18px); background-color:#32364a;">
      <img src="icons/envelope.svg" style="margin-right:2vw;" class="icon-24">
      Open contact form
    </button>

    <h3 class="section-title openingh">Opening hours</h3>
    <ul>
      <li>Monday-Friday: 07:00-20:00</li>
      <li>Saturday: 09:00-18:00</li>
      <li>Sundays, public holidays, holidays and Easter Eve: 10:00-16:00</li>
    </ul>
  </div>
  `;

  return {
    html,
    title: 'Contact us',
    tab: '#contact',
    overflow: false,
    disableOverscroll: false,
    afterRender() {
      injectBackButton('Contact us', () => { location.hash = '#profile'; });
    }
  };
}

function renderBuyTicket(){
  const html = `
    <section class="card center" style="background:transparent; padding-top:8px">
      <img
        src="icon/buyticket.svg"
        class="buy-illus"
        alt=""
        onerror="this.onerror=null;this.src='icons/buyticket.svg'">
    </section>

    <div class="buy-list">
      <div class="list-row">
        <img src="icons/ticket3.svg" class="icon-24" alt="">
        <div class="row-title">Single ticket</div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>

      <div class="buy-sep"></div>
      
      <div class="list-row">
        <img src="icons/calendar.svg" class="icon-24" alt="">
        <div class="row-title">Period ticket</div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
    </div>

    <div class="buy-list">
      <div class="list-row" id="ticketForOthers">
        <img src="icons/for_others.svg" class="icon-24" alt="">
        <div class="row-title">
          <div class="row-title">Ticket for others</div>
          <div class="subtle" style="margin-top:2px">Send the ticket to a different phone</div>
        </div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
    </div>
  `;

  return {
    html,
    title: 'Select ticket',
    tab: '#tickets',
    overflow: false,
    disableOverscroll: true,
    afterRender(){
      injectBackButton('Select ticket', () => { location.hash = '#tickets'; });

      const othersRow = document.getElementById('ticketForOthers');
      if (othersRow) othersRow.addEventListener('click', () => { location.hash = '#zones'; });
    }
  };
}

// Canonical zone order — used when storing and displaying selected zones
const ZONE_ORDER = ['1', '2V', '3V', '4V', '2Ø', '3Ø', '4Ø', '2S', '3S'];

/** Sort a Set/Array of zone IDs into canonical order, return a plain array */
function sortZones(zones) {
  const arr = zones ? [...zones] : [];
  return arr.sort((a, b) => {
    const ia = ZONE_ORDER.indexOf(a);
    const ib = ZONE_ORDER.indexOf(b);
    // Unknown zones go to the end
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}

// Format a Set/Array of zone IDs into a human-readable label.
// Delegates to fmtZone which already handles comma-separated strings.
function fmtConfirmedZones(zones) {
  return fmtZone(sortZones(zones).join(','));
}

function renderZones(){
  // Zone label → [left%, top%] as percentage of image dimensions (561×672)
  const ZONES = [
    { id: '4N', left: 46, top: 16 },
    { id: '1',  left: 25, top: 50 },
    { id: '2Ø', left: 46, top: 62 },
    { id: '3Ø', left: 73, top: 64 },
    { id: '2S', left: 35, top: 73 },
    { id: '2V', left:  9, top: 53 },
    { id: '3V', left:  8, top: 75 },
    { id: '3S', left: 30, top: 95 },
    { id: '4V', left: 12, top: 90 },
  ];

  const buttons = ZONES.map(z => `
    <button class="zone-btn" data-zone="${z.id}"
      style="left:${z.left}%;top:${z.top}%">
      ${z.id}
    </button>
  `).join('');

  const html = `
    <div class="zones-wrap">
      <div class="zones-map-wrap">
        <img src="data/zones.png" class="zones-img" alt="Zone map">
        ${buttons}
      </div>
    </div>
  `;

  return {
    html,
    title: 'Zones',
    tab: '#tickets',
    overflow: false,
    disableOverscroll: true,
    afterRender(){
      // Working copy: start from confirmed state so Back discards unsaved changes
      window.__selectedZones = new Set(window.__confirmedZones || []);

      const goBack = () => { location.hash = '#tickets'; };
      const goOK = async () => {
        // Save working copy → confirmed, in canonical order
        const ordered = sortZones(window.__selectedZones);
        window.__confirmedZones = new Set(ordered);
        const zoneStr = ordered.join(',') || '1';

        // Update the latest ticket in DB: zone AND purchase time.
        // Recalculate purchase so expiry = now - expiredAgoMin stays correct,
        // regardless of how many zones are selected.
        try {
          const latestRows = await TicketsDB.listTickets({ limit: 1 });
          if (latestRows && latestRows.length) {
            const durationMin   = ticketDurationMs(zoneStr) / 60000;
            const expiredAgoMin = currentOffsetMinutes - 60; // e.g. 61-60 = 1
            const newPurchase   = new Date(Date.now() - (durationMin + expiredAgoMin) * 60 * 1000);
            await TicketsDB.updateTicketZoneAndPurchase(
              latestRows[0].id,
              zoneStr,
              fmtDate(newPurchase),
              fmtTime(newPurchase),
              newPurchase.toISOString()
            );
          }
        } catch (err) {
          console.error('Could not update ticket in DB', err);
        }

        location.hash = '#tickets';
      };

      // Cleanup removes the OK button from the topbar
      const cleanup = () => {
        document.querySelectorAll('.zones-ok-btn').forEach(el => el.remove());
      };

      injectBackButton('Zones', goBack, cleanup);

      // Inject OK button — remove any stale copy first
      cleanup();
      const topRow = document.querySelector('.topbar .top-row');
      if (topRow) {
        const ok = document.createElement('button');
        ok.textContent = 'OK';
        ok.className = 'zones-ok-btn';
        ok.addEventListener('click', goOK);
        topRow.appendChild(ok);
      }

      // Restore working selection on buttons
      document.querySelectorAll('.zone-btn').forEach(btn => {
        const id = btn.dataset.zone;
        if (window.__selectedZones.has(id)) btn.classList.add('zone-btn--selected');

        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (window.__selectedZones.has(id)) {
            window.__selectedZones.delete(id);
            btn.classList.remove('zone-btn--selected');
          } else {
            window.__selectedZones.add(id);
            btn.classList.add('zone-btn--selected');
          }
          console.log('Selected zones (working):', [...window.__selectedZones]);
        });
      });
    }
  };
}

function renderQuickPurchase(){
  // "See all" expansion of the Quick purchase list on the tickets page.
  const items = [
    { title: 'Single ticket',          sub: '1 adult, Zone 1 and 2V' },
    { title: 'Single ticket',          sub: '1 adult, Zone 1' },
    { title: 'Single ticket',          sub: '1 adult, Zone 4N, 3Ø and 1' },
    { title: 'Ticket for someone else', sub: 'Single ticket, 1 adult, Zone 4N, 3Ø, 2Ø and 1' },
    { title: 'Single ticket',          sub: '2 adults, Zone 1' },
    { title: 'Single ticket',          sub: '2 adults, Zone 1 and 2V' },
  ];

  const rows = items.map(it => `
    <div class="qp-tiles qp-all-row">
      <div class="row-main">
        <div class="qp-row-title">${it.title}</div>
        <div class="qp-row-sub">${it.sub}</div>
      </div>
      <button class="qp-buy-btn">Buy</button>
    </div>
  `).join('');

  const html = `
    <div class="qp-list qp-all-list">
      ${rows}
    </div>
  `;

  return {
    html,
    title: 'Quick purchase',
    tab: '#tickets',
    overflow: false,
    disableOverscroll: false,
    afterRender(){
      injectBackButton('Quick purchase', () => { location.hash = '#tickets'; });
      // Every row and Buy button → Buy ticket page
      document.querySelectorAll('.qp-all-row, .qp-all-row .qp-buy-btn').forEach(el => {
        el.addEventListener('click', () => { location.hash = '#buy_ticket'; });
      });
    }
  };
}

function renderSelectZone(){
  const html = `
    <div class="list yourinfo">
      <div class="list-row" id="fromZone">
        <div class="row-main">
          <div class="qp-row-title">From</div>
          <div class="qp-row-sub">Zone 1</div>
        </div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
      <div class="list-row" id="toZone">
        <div class="row-main">
          <div class="qp-row-title">To</div>
          <div class="qp-row-sub">Zone 1</div>
        </div>
        <img src="icons/chevron-right.svg" class="icon-24 chev" alt="">
      </div>
    </div>


  `;

  return {
    html,
    title: 'Select zone',
    tab: '#zone',
    overflow: false,
    disableOverscroll: true,
    afterRender(){
      injectBackButton('Select zone', () => { location.hash = '#buy_ticket'; });
    }
  };
}

async function renderPurchaseHistory() {
  // Ensure DB is initialized (cheap if already done)
  await TicketsDB.init();

  // Load latest tickets
  const rows = await TicketsDB.listTickets({ limit: 200 });

  const html = `
    <div class="ph-tabs" role="tablist" aria-label="Purchase history tabs">
      <button class="ph-tab" role="tab" aria-selected="true" data-tab="receipts">Receipts</button>
      <button class="ph-tab" role="tab" aria-selected="false" data-tab="tickets">Tickets</button>
    </div>

    <div class="ph-list" id="ph-list"></div>
  `;

  return {
    html,
    title: 'Purchase history',
    tab: '#profile',
    overflow: false,
    disableOverscroll: true,
    afterRender() {
      injectBackButton('Purchase history', () => { location.hash = '#profile'; });

      // --- tabs + default tab selection ---
      const tabs = document.querySelectorAll('.ph-tab');
      const setActive = (name) => {
        tabs.forEach(b => {
          const isActive = b.dataset.tab === name;
          b.classList.toggle('ph-tab--active', isActive);
          b.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
      };

      const desired = (window.__phDefaultTab === 'tickets') ? 'tickets' : 'receipts';
      if (desired === 'receipts' && window.renderReceiptsList) {
        window.renderReceiptsList(rows);
      } else if (window.renderPurchaseHistoryList) {
        window.renderPurchaseHistoryList(rows);
      }
      setActive(desired);
      window.__phDefaultTab = desired;

      // --- Single delegated listener for BOTH tabs (Tickets + Receipts) ---
      const listEl = document.getElementById('ph-list');
      if (listEl) {
        listEl.addEventListener('click', (e) => {
          // 1) Tickets tab: blue "Show ticket" button
          const ticketBtn = e.target.closest('.ph-link[data-ticket-id]');
          if (ticketBtn) {
            const id = ticketBtn.getAttribute('data-ticket-id');
            window.__selectedTicketId = id;
            window.__phDefaultTab = 'tickets'; // come back to Tickets
            location.hash = '#ticket_detail';
            return;
          }
          // 2) Receipts tab: tap anywhere on a receipt card -> open receipt detail
          const receiptCard = e.target.closest('.rcpt-card');
          if (receiptCard && receiptCard.hasAttribute('data-ticket-id')) {
            const id = receiptCard.getAttribute('data-ticket-id');
            window.__selectedTicketId = Number(id);
            window.__phDefaultTab = 'receipts'; // return to Receipts tab after back
            window.__receiptBack = { hash: '#purchase_history', tab: 'receipts' };
            location.hash = '#receipt_detail';
            return;
          }
        });
      }

      // --- wire tab switching ---
      tabs.forEach(btn => {
        btn.addEventListener('click', () => {
          const name = btn.dataset.tab;
          if (name === 'receipts' && window.renderReceiptsList) window.renderReceiptsList(rows);
          if (name === 'tickets'  && window.renderPurchaseHistoryList) window.renderPurchaseHistoryList(rows);
          setActive(name);
          window.__phDefaultTab = name;  // remember chosen tab
        });
      });
    }
  };
}

async function renderTicketDetail(){
  const id = window.__selectedTicketId ? Number(window.__selectedTicketId) : NaN;

  // Guard: if no id, bounce back
  if (!id) {
    return {
      html: `<section class="card"><div class="subtle">No ticket selected.</div></section>`,
      title: 'Ruter ticket',
      tab: '#profile',
      overflow: false,
      disableOverscroll: true,
    };
  }

  const row = await TicketsDB.getTicketById(id);
  if (!row) {
    return {
      html: `<section class="card"><div class="subtle">Ticket not found.</div></section>`,
      title: 'Ruter ticket',
      tab: '#profile',
      overflow: false,
      disableOverscroll: true,
    };
  }

  // Build view data
  const zoneLabel = fmtZone(row.zone);
  const paxLabel  = `${row.adults} adult${row.adults > 1 ? 's' : ''}`;

  const start = new Date(row.purchased_at_iso);
  const end   = new Date(start.getTime() + ticketDurationMs(row.zone));
  const html = `
    <div class="ph-item card">
      <div class="side-bar"></div>
      <section class="ticket-hero">
        <div class="exp-ticket-title">Expired reis ticket</div>

        <div class="ticket-meta">
          <div class="exp-meta-item">
            <img class="ticket-icon" src="icons/zone.svg" alt="">
            <span>${zoneLabel}</span>
          </div>
          <div class="exp-meta-item">
            <img class="ticket-icon" src="icons/happy2.svg" alt="">
            <span>${paxLabel}</span>
          </div>
        </div>

        <div style="height:8px"></div>

        <div class="exp-kv">
          <div class="kv-label">Started</div>
          <div class="kv-value">${fmtDateTime(start)}</div>

          <div class="kv-label">Expiration</div>
          <div class="kv-value">${fmtDateTime(end)}</div>
        </div>
        <div style="height:10px"></div>
        <div class="exp-kv">
          <div class="kv-label">Ticket number</div>
          <div class="kv-value">nuII</div>
        </div>

        <div class="receipt-cta">
          <a class="ph-link" id="showReceipt">
            Show receipt
            <div class="icon-circle icon-circle--blue">
              <img src="icons/receipt2.svg" alt="">
            </div>
          </a>
        </div>
      </section>
    </div>
  `;
  return {
    html,
    title: 'Ruter ticket',
    tab: '#profile',
    overflow: false,
    disableOverscroll: true,
    afterRender(){
      const goBack = () => {
        window.__phDefaultTab = 'tickets';
        location.hash = '#purchase_history';
      };
      injectBackButton('Ruter ticket', goBack);

      // "Show receipt" → go to Purchase history (Receipts tab)
      const showReceipt = document.getElementById('showReceipt');
      if (showReceipt){
        showReceipt.addEventListener('click', () => {
          window.__selectedTicketId = Number(window.__selectedTicketId || 0);
          window.__receiptBack = { hash: '#ticket_detail' };  // arrived from Ruter ticket
          location.hash = '#receipt_detail';
          // optional: remember the intended tab if you add logic to read it
          window.__phDefaultTab = 'receipts';
        });
      }
    }
  };
}

async function renderReceiptDetail(){
  const id = window.__selectedTicketId ? Number(window.__selectedTicketId) : NaN;
  if (!id) {
    return {
      html: `<section class="card"><div class="subtle">No receipt selected.</div></section>`,
      title: 'Receipt', tab: '#tickets', overflow: false, disableOverscroll: true
    };
  }

  const row = await TicketsDB.getTicketById(id);
  if (!row) {
    return {
      html: `<section class="card"><div class="subtle">Receipt not found.</div></section>`,
      title: 'Receipt', tab: '#tickets', overflow: false, disableOverscroll: true
    };
  }

  // Data
  const zoneLabel = fmtZone(row.zone);
  const paxLabel  = `${row.adults} Adult${row.adults > 1 ? 's' : ''}`;
  const titleLine = `Single ticket, ${paxLabel}, ${zoneLabel}`;
  const amountKr  = TicketsDB.formatAmount(row.amount_cents) + ' kr';

  // Purchased time (dd.mm.yy hh:mm:ss)
  const purchasedAt = fmtDateTime(new Date(row.purchased_at_iso));

  // VAT math (12% VAT included -> VAT = gross * 12/112)
  const vatPct = 12;
  const vatKr  = ((row.amount_cents/100) * (vatPct/(100+vatPct)))
    .toFixed(2)
    .replace('.', ',') + ' kr';

  // --- Discount display ---
  let discountRowHTML = '';

  const discountPct = Number(row.discount_percent) || 0;

  if (discountPct > 0) {
    // row.amount_cents is already the discounted price, so compute original price:
    const price = row.amount_cents / 100;                   // e.g. 39.60
    const gross = price / (1 - discountPct / 100);          // e.g. 44.00
    const diff  = gross - price;                            // e.g. 4.40
    const diffCents = Math.round(diff * 100);               // 440

    const diffDisplay = TicketsDB.formatAmount(diffCents) + ' kr';

    discountRowHTML = `
      <div class="rcptd-row">
        <span>Discount (Reis ${discountPct}%)</span>
        <span>${diffDisplay}</span>
      </div>
    `;
  }


  const html = `
    <section class="rcptd card">
      <div class="rcptd-head">
        <div class="rcptd-title">
          <img class="icon-24" src="icons/ticket3.svg" alt="">
          Ruter ticket
        </div>
        <div class="rcptd-amount">${amountKr}</div>
      </div>

      <div class="rcptd-sub">${titleLine}</div>

      <div class="rcptd-row"><span>Payment method</span><span>VISA</span></div>
      <div class="rcptd-row"><span>Purchased</span><span>${purchasedAt}</span></div>
      <div class="rcptd-row"><span>Order</span><span>${row.order_ref}</span></div>
      <div class="rcptd-row"><span>Ticket number</span><span>nuII</span></div>
      <div class="rcptd-row"><span>Mva. (VAT)</span><span>${vatKr}</span></div>
      <div class="rcptd-row"><span>Mva. (VAT) %</span><span>${vatPct}%</span></div>
      ${discountRowHTML}

      <div class="rcpt-sep"></div>

      <div class="rcptd-merchant">
        <div>Ruter As</div>
        <div>Dronningens gate 40</div>
        <div>P.O. Box 1030 Sentrum NO-0104 Oslo</div>
        <div>Business register NO 991 609 407 MVA</div>
      </div>
    </section>

    <div class="rcptd-cta">
      <button class="btn-share">
        <img src="icons/share_ios.svg" class="icon-24" alt="">
        <span>Share</span>
      </button>
      <button class="btn-primary" id="btnSendEmail">Send to email</button>
    </div>
  `;

  return {
    html,
    title: 'Receipt',
    tab: '#profile',
    overflow: false,
    disableOverscroll: true,
    afterRender(){
      const backPref = window.__receiptBack;
      const goBack = () => {
        if (backPref && backPref.hash === '#ticket_detail') {
          location.hash = '#ticket_detail';
        } else {
          window.__phDefaultTab = 'receipts';
          location.hash = '#purchase_history';
        }
      };
      injectBackButton('Receipt', goBack, () => { window.__receiptBack = null; });

      // --- Long-press to delete this ticket ---
      const sendBtn = document.getElementById('btnSendEmail');
      if (sendBtn) {
        let pressTimer = null;
        let longPressed = false;

        const start = () => {
          longPressed = false;
          // 400ms feels right: not too short, not too long
          pressTimer = setTimeout(async () => {
            longPressed = true;
            const id = Number(window.__selectedTicketId || 0);
            if (!id) return;

            // Confirm before deleting
            //const ok = confirm('Delete this ticket from the database?');
            //if (!ok) return;

            try {
              await TicketsDB.deleteTicketById(id);
              // Go back to Purchase history (Receipts tab) after deletion
              window.__phDefaultTab = 'receipts';
              location.hash = '#purchase_history';
            } catch (e) {
              alert('Could not delete the ticket.');
              console.error(e);
            }
          }, 400);
        };

        const cancel = (e) => {
          if (pressTimer) clearTimeout(pressTimer);
        };

        // Normal click (short tap) still does the original action
        sendBtn.addEventListener('click', (e) => {
          if (longPressed) {
            // Swallow the click that follows a long press (Android often sends one)
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        });

        // Pointer/Touch handlers for long-press
        sendBtn.addEventListener('mousedown', start);
        sendBtn.addEventListener('touchstart', start, { passive: true });
        ['mouseup','mouseleave','mouseout','touchend','touchcancel'].forEach(ev =>
          sendBtn.addEventListener(ev, cancel)
        );
      }
    }
  };
}





