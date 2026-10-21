import { h, icon } from '../dom.js';
import * as data from '../data.js';
import * as store from '../store.js';
import * as cloud from '../cloud.js';
import { applyAppearance } from '../appearance.js';
import { segmented, switchRow, row, toast, confirmSheet } from '../ui.js';
import { checkForUpdates, clearOfflineCache, getBuildInfo, isStandalone, offlineReady } from '../pwa.js';
import { accountCard } from './account.js';

const dataNote = (s) => {
  if (!store.persistent) return 'Storage is unavailable (private browsing?), so progress will not be kept after you close the app.';
  if (!s.user) return 'Progress is stored only on this device. Back it up before changing phones, and note that Safari can clear data for sites that are not installed to the Home Screen.';
  return s.sync.state === 'needs-approval'
    ? 'Progress is kept on this device. Nothing is uploaded to your account until you choose above.'
    : 'Progress is kept on this device and synced to your account. A backup file is still a good idea before changing phones.';
};
const footNote = (s) => (s.configured
  ? 'Progress stays on this device unless you sign in. No tracking, no ads.'
  : 'CertStudy keeps everything on your device. No accounts, no tracking.');

async function exportBackup() {
  const json = JSON.stringify(store.exportAll(), null, 1);
  const name = `certstudy-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([json], name, { type: 'application/json' });
  // The share sheet ("Save to Files") is the right UX on a phone; desktop browsers should simply download the file.
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'CertStudy backup' });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('Backup downloaded.');
}

function importBackup() {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      let backup;
      try { backup = JSON.parse(await file.text()); } catch { throw new Error('That file is not a CertStudy backup.'); }
      store.parseBackup(backup); // rejects unusable files before the learner is asked anything
      const ok = await confirmSheet({
        title: 'Restore this backup?',
        message: `Backup from ${backup.exportedAt?.slice(0, 10) ?? 'an unknown date'}. It replaces the progress currently on this device${cloud.getState().user ? ' and, through sync, in your account' : ''}.`,
        confirmLabel: 'Restore', danger: true,
      });
      if (!ok) return;
      store.importAll(backup, { replace: true });
      applyAppearance(data.getSettings());
      toast('Backup restored.');
      location.hash = '#/';
      location.reload();
    } catch (err) {
      toast(err.message || 'Could not read that file.');
    }
  });
  input.click();
}

export async function settingsView() {
  let settings = data.getSettings();
  const update = (key, value) => { settings = data.setSetting(key, value); applyAppearance(settings); };

  const build = h('span', { class: 'row-sub' }, 'Checking…');
  getBuildInfo().then((info) => { build.textContent = info ? `Build ${info.id}` : 'Build information unavailable'; });

  const group = (title, ...rows) => h('section', { class: 'card group' }, h('h3', null, title), ...rows);
  const field = (label, control) => h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), control);
  const account = accountCard();
  const note = h('p', { class: 'muted small' }, dataNote(cloud.getState()));
  const footnote = h('p', { class: 'muted small center footnote' }, footNote(cloud.getState()));
  const offState = cloud.subscribe((s) => { note.textContent = dataNote(s); footnote.textContent = footNote(s); });

  const el = h('div', { class: 'page' },
    group('Appearance',
      field('Theme', segmented({ label: 'Theme', options: [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], value: settings.theme, onChange: (v) => update('theme', v) })),
      field('Text size', segmented({ label: 'Text size', options: [{ value: 0.9, label: 'Small' }, { value: 1, label: 'Default' }, { value: 1.15, label: 'Large' }, { value: 1.3, label: 'Larger' }], value: settings.fontScale, onChange: (v) => update('fontScale', v) })),
      h('p', { class: 'muted small' }, 'Applies to the guide, questions and explanations.')),
    group('Practice defaults',
      switchRow({ title: 'Shuffle answer options', description: 'Different order each attempt. Off keeps the order used in the PDF.', checked: settings.shuffleOptions, onChange: (v) => update('shuffleOptions', v) }),
      switchRow({ title: 'Instant feedback in study mode', description: 'Reveal correct or incorrect as soon as an answer is complete.', checked: settings.autoCheck, onChange: (v) => update('autoCheck', v) })),
    account.el,
    group('Your data',
      note,
      row({ title: 'Back up progress', sub: 'Save a file you can restore later', leading: icon('upload', 22), onClick: exportBackup }),
      row({ title: 'Restore from backup', sub: 'Replaces progress on this device', leading: icon('download', 22), onClick: importBackup }),
      row({
        title: 'Reset all progress', sub: 'Clears history, ratings and reading position', leading: icon('trash', 22), chevron: false,
        onClick: async () => {
          if (await confirmSheet({
            title: 'Reset all progress?',
            message: cloud.getState().user ? 'This cannot be undone. It clears your progress on this device and, through sync, in your account and on your other devices. Settings are kept.' : 'This cannot be undone. Settings are kept.',
            confirmLabel: 'Reset', danger: true,
          })) {
            const keep = data.getSettings();
            store.clearAll();
            data.setSetting('theme', keep.theme);
            toast('Progress cleared.');
            location.hash = '#/';
          }
        },
      })),
    group('App',
      h('div', { class: 'row static' }, h('span', { class: 'row-lead' }, icon('info', 22)), h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, 'CertStudy'), build)),
      h('div', { class: 'row static' }, h('span', { class: 'row-lead' }, icon('check-circle', 22)), h('span', { class: 'row-main' },
        h('span', { class: 'row-title' }, offlineReady() ? 'Offline ready' : 'Not yet cached for offline use'),
        h('span', { class: 'row-sub' }, isStandalone() ? 'Running from the Home Screen' : 'Tip: use Share, then Add to Home Screen'))),
      row({
        title: 'Check for updates', leading: icon('refresh', 22), chevron: false,
        onClick: async () => {
          const r = await checkForUpdates();
          if (r === 'up-to-date') toast('You have the latest version.');
          else if (r === 'offline') toast('Could not check. Are you offline?');
          else if (r === 'unsupported') toast('Updates are checked automatically when the app opens.');
          else if (r === 'downloading') toast('Still downloading the update. You will be prompted when it is ready.');
          else if (r === 'failed') toast('The update could not be downloaded. Try again later.');
        },
      }),
      row({
        title: 'Clear offline cache and reload', sub: 'Troubleshooting only. Needs a connection afterwards.', leading: icon('trash', 22), chevron: false,
        onClick: async () => {
          if (await confirmSheet({ title: 'Clear the offline cache?', message: 'Your progress is kept. The app downloads its files again on the next load.', confirmLabel: 'Clear and reload' })) clearOfflineCache();
        },
      })),
    footnote);
  return { el, title: 'Settings', back: '#/', onLeave: () => { account.destroy(); offState(); } };
}
