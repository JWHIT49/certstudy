import { getSettings } from './data.js';
import { applyAppearance } from './appearance.js';
import { registerRoutes } from './routes.js';
import * as router from './router.js';
import { mount } from './shell.js';
import { registerServiceWorker } from './pwa.js';
import { onWriteFailure } from './store.js';
import { toast } from './ui.js';

applyAppearance(getSettings());
registerRoutes(router.on);
router.start(mount);
registerServiceWorker();

// Once per launch: progress is being kept in memory only, so tell the learner before they lose it.
let warned = false;
onWriteFailure(() => {
  if (warned) return;
  warned = true;
  toast('Your device would not save progress (storage is full or blocked). Use Settings, Back up progress, then free some space.', { duration: 9000 });
});
