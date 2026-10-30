// Service worker: only for push notifications (no offline caching, the app always loads fresh from the server)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
    const options = {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        data: { url: data.url || '/' }
    };
    if (data.tag) options.tag = data.tag;
    event.waitUntil(self.registration.showNotification(data.title || 'Ferienwohnung', options));
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
    event.waitUntil((async () => {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of all) {
            if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
                await client.focus();
                if ('navigate' in client) return client.navigate(url);
                return;
            }
        }
        return self.clients.openWindow(url);
    })());
});

// Browser replaced the subscription (e.g. key rotation) -> re-register it with the server
self.addEventListener('pushsubscriptionchange', event => {
    event.waitUntil((async () => {
        const res = await fetch('/api/push/key', { credentials: 'same-origin' });
        if (!res.ok) return;
        const { publicKey } = await res.json();
        const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - publicKey.length % 4) % 4));
        const key = Uint8Array.from(raw, c => c.charCodeAt(0));
        const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        await fetch('/api/push/subscribe', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub.toJSON() })
        });
    })());
});
