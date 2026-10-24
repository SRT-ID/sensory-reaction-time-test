// Bump this value on every deployment that changes the application shell.
// It prevents an offline device from continuing to run an old app.js after a
// new version has been published to GitHub Pages/Firebase Hosting.
const CACHE_NAME = 'srt-offline-v11';
const APP_SHELL = [
    './',
    './index.html',
    './styles.css',
    './app.js?v=20261024-11',
    './audio.js?v=20261024-11',
    './assets/audio/dog.wav',
    './assets/audio/cat.wav',
    './assets/audio/cow.wav',
    './assets/audio/donkey.wav',
    './assets/audio/goat.wav'
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    const cacheableDestinations = new Set(['document', 'script', 'style', 'font', 'image', 'audio']);
    if (!cacheableDestinations.has(event.request.destination)) return;
    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (response && (response.ok || response.type === 'opaque')) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).catch(() => {});
                }
                return response;
            })
            .catch(async () => {
                const cached = await caches.match(event.request);
                if (cached) return cached;
                if (event.request.mode === 'navigate') return caches.match('./index.html');
                throw new Error('offline-resource-unavailable');
            })
    );
});
