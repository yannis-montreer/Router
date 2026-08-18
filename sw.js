// sw.js — Cache-first service worker for Router PWA
// Bump CACHE_VERSION when deploying changes (forces old cache to be replaced)
const CACHE_VERSION = 'router-v5';

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './ticketsView.js',
  './env.js',
  './cordova.js',
  './data/tickets.js',
  './data/pricedb.js',
  // Icons
  './icons/accessibility.svg',
  './icons/bell.svg',
  './icons/bookmark.svg',
  './icons/bus.svg',
  './icons/bus2.svg',
  './icons/icon-180.png',
  './icons/bus_IOS.svg',
  './icons/Layers_IOS.svg',
  './icons/target_IOS.svg',
  './icons/chevron-IOS.svg',
  './icons/ticket_IOS.svg',
  './icons/profile_IOS.svg',
  './icons/buyticket.svg',
  './icons/buyticket_reis.svg',
  './icons/calendar.svg',
  './icons/call.svg',
  './icons/card.svg',
  './icons/chat.svg',
  './icons/chevron-right-expired.svg',
  './icons/chevron-right.svg',
  './icons/clock.svg',
  './icons/contact_us.svg',
  './icons/dashed_box.svg',
  './icons/document.svg',
  './icons/download.svg',
  './icons/empty.svg',
  './icons/envelope.svg',
  './icons/for_others.svg',
  './icons/gear.svg',
  './icons/happy.svg',
  './icons/happy2.svg',
  './icons/hourglass.svg',
  './icons/info.svg',
  './icons/link.svg',
  './icons/link2.svg',
  './icons/lock.svg',
  './icons/mastercard.svg',
  './icons/my_location.svg',
  './icons/overflow.svg',
  './icons/pick_up_houses.svg',
  './icons/plus2.svg',
  './icons/profile.svg',
  './icons/profile2.svg',
  './icons/receipt.svg',
  './icons/receipt2.svg',
  './icons/reispick.svg',
  './icons/ruter_logo_red.svg',
  './icons/scooter.svg',
  './icons/share_ios.svg',
  './icons/star.svg',
  './icons/ticket.svg',
  './icons/ticket2.svg',
  './icons/ticket3.svg',
  './icons/toggle.svg',
  './icons/visa.svg',
  './icons/walk.svg',
  './icons/zone.svg',
];

// Install: cache all app shell files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      // Use individual adds so one missing file doesn't abort the whole cache
      return Promise.allSettled(
        APP_SHELL.map(url => cache.add(url).catch(err => {
          console.warn('[SW] Failed to cache:', url, err);
        }))
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate: delete old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for app shell, network-first for Mapbox
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always go network-first for Mapbox (tiles, styles, API)
  if (url.hostname.includes('mapbox.com') || url.hostname.includes('mapbox.net')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for everything else (app shell)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache valid responses for future offline use
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
