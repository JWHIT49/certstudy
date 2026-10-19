// Service worker registration, update prompts and offline-cache helpers.
import { toast } from './ui.js';

export const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

let registration = null;
let hadController = false;

const announced = new WeakSet();

function announce(worker) {
  if (announced.has(worker)) return;
  announced.add(worker);
  toast('A new version is ready.', { sticky: true, action: { label: 'Update', onClick: () => worker.postMessage({ type: 'SKIP_WAITING' }) } });
}

function whenSettled(worker, timeoutMs = 20000) {
  return new Promise((resolve) => {
    if (worker.state !== 'installing') { resolve(worker.state); return; }
    const finish = (result) => { clearTimeout(timer); worker.removeEventListener('statechange', onChange); resolve(result); };
    const onChange = () => { if (worker.state !== 'installing') finish(worker.state); };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    worker.addEventListener('statechange', onChange);
  });
}

export async function clearOfflineCache({ reload = true } = {}) {
  if ('serviceWorker' in navigator) {
    for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
  }
  if (globalThis.caches) {
    for (const key of await caches.keys()) if (key.startsWith('certstudy-')) await caches.delete(key);
  }
  if (reload) location.reload();
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (new URLSearchParams(location.search).has('nosw')) { await clearOfflineCache({ reload: false }); return; }
  hadController = Boolean(navigator.serviceWorker.controller);
  try {
    // updateViaCache 'none': update checks bypass the HTTP cache for sw.js and precache.js. GitHub Pages sends max-age=600, which would
    // otherwise delay the "new version" prompt by up to ten minutes after a deploy.
    registration = await navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' });
  } catch (err) {
    console.warn('Service worker registration failed', err);
    return;
  }
  if (registration.waiting && hadController) announce(registration.waiting);
  if (registration.active && !navigator.serviceWorker.controller) registration.active.postMessage({ type: 'CLAIM' });
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) announce(worker);
      if (worker.state === 'activated' && !hadController) toast('Ready to use offline.');
    });
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first install claims the page: nothing to reload. Later changes happen only after the user taps "Update".
    if (!hadController) { hadController = true; return; }
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') registration.update().catch(() => {});
  });
}

/** Resolves to 'update-ready' | 'downloading' | 'failed' | 'up-to-date' | 'unsupported' | 'offline'. */
export async function checkForUpdates() {
  if (!registration) return 'unsupported';
  try {
    await registration.update();
  } catch {
    return 'offline';
  }
  // update() resolves once the check is done, but a newer worker may still be downloading its files.
  const worker = registration.installing ?? registration.waiting;
  if (!worker || !navigator.serviceWorker.controller) return 'up-to-date';
  const state = await whenSettled(worker);
  if (state === 'installed' || state === 'activated') { announce(worker); return 'update-ready'; }
  return state === 'timeout' ? 'downloading' : 'failed';
}

export async function getBuildInfo() {
  try {
    const res = await fetch(new URL('build.json', document.baseURI));
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export const offlineReady = () => Boolean(navigator.serviceWorker?.controller);
