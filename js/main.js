import { getSettings } from './data.js';
import { applyAppearance } from './appearance.js';
import { registerRoutes } from './routes.js';
import * as router from './router.js';
import { mount, scroller } from './shell.js';
import { registerServiceWorker } from './pwa.js';
import { onWriteFailure } from './store.js';
import { toast } from './ui.js';
import * as cloud from './cloud.js';

applyAppearance(getSettings());
registerRoutes(router.on);
router.start(mount);
registerServiceWorker();

// Pages that only display progress are rebuilt when the cloud changed it. Pages in the middle of a task are left alone.
const REFRESHABLE = [/^\/$/, /^\/settings$/, /^\/c\/[^/]+$/, /^\/c\/[^/]+\/(practice|skills|guide)$/, /^\/c\/[^/]+\/guide\/[^/]+$/];
cloud.setDataChangedHandler(() => {
  applyAppearance(getSettings());
  const busy = document.querySelector('.sheet') || document.activeElement?.tagName === 'INPUT';
  if (busy || !REFRESHABLE.some((re) => re.test(router.parse().path))) return;
  const top = scroller().scrollTop;
  router.refresh().then(() => { scroller().scrollTop = top; });
});
cloud.initCloud().catch((err) => console.warn('Cloud sync is unavailable', err));

// Once per launch: progress is being kept in memory only, so tell the learner before they lose it.
let warned = false;
onWriteFailure(() => {
  if (warned) return;
  warned = true;
  toast('Your device would not save progress (storage is full or blocked). Use Settings, Back up progress, then free some space.', { duration: 9000 });
});
