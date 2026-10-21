// Conti — service worker: tiene i file dell'app sul telefono, così si apre anche senza rete.
// I dati non passano di qui: vanno sempre a Supabase.
// Quando aggiorni i file su GitHub, cambia VERSION per far scaricare la nuova versione.
const VERSION = 'conti-v10';
const SHELL = [
  './', 'index.html', 'store.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isLib = url.hostname === 'cdn.jsdelivr.net';
  if (!sameOrigin && !isLib) return; // Supabase e tutto il resto: sempre dalla rete

  if (isLib) { // libreria con versione fissa: prima la cache
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res;
    })));
    return;
  }
  // file dell'app: prima la rete (così vedi subito gli aggiornamenti), poi la cache se sei offline
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then(hit => hit || caches.match('index.html'))));
});