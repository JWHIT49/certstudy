// The "Account & sync" card on the Settings page. It stays hidden unless the app was set up for cloud sync (see cloud.json).
import { h, icon, append, fmtDateTime, plural } from '../dom.js';
import * as cloud from '../cloud.js';
import * as data from '../data.js';
import * as store from '../store.js';
import { isSyncedKey } from '../merge.js';
import { summarize, describeSummary, isEmpty } from '../summary.js';
import { applyAppearance } from '../appearance.js';
import { row, switchRow, confirmSheet, toast } from '../ui.js';

const METHOD_LABEL = { microsoft: 'Microsoft', google: 'Google', github: 'GitHub' };
const PROVIDER_LABEL = { azure: 'Microsoft', microsoft: 'Microsoft', google: 'Google', github: 'GitHub', email: 'an emailed code' };

function statusOf(s) {
  const { state, error, lastSyncAt } = s.sync;
  const when = lastSyncAt ? `Last synced ${fmtDateTime(lastSyncAt)}` : null;
  switch (state) {
    case 'needs-approval': return { tone: 'warn', icon: 'info', title: 'Waiting for your decision', sub: 'Nothing has been uploaded yet.' };
    case 'syncing': return { tone: '', icon: 'refresh', title: 'Syncing…', sub: when };
    case 'offline': return { tone: '', icon: 'info', title: 'Offline', sub: 'Your progress is safe on this device and will sync when you are back online.' };
    case 'error': return { tone: 'bad', icon: 'info', title: 'Sync problem', sub: error || 'Something went wrong. It will be retried.' };
    case 'idle': return error
      ? { tone: 'warn', icon: 'info', title: 'Some changes are not synced yet', sub: error }
      : { tone: 'good', icon: 'check-circle', title: lastSyncAt ? 'Up to date' : 'Ready to sync', sub: when };
    default: return { tone: '', icon: 'info', title: 'Not signed in', sub: null };
  }
}

export function accountCard() {
  const el = h('section', { class: 'card group account', 'aria-label': 'Account and sync' });
  let state = cloud.getState();
  let emailValue = '';
  let codeValue = '';
  let codeSent = false;
  let preview = 'idle'; // idle | loading | done: looking at what the account already holds, while the learner decides
  let previewToken = 0;
  let accountSummary = null;

  const privacy = h('p', { class: 'muted small' },
    'What is stored: your practice results, question statistics, skill ratings, reading progress and settings. Only you can read them, and nothing is shared with other people. Your name and email come from the account you sign in with.');

  // Removing the progress from this device is only safe once the account has it: upload first, and ask if anything is left behind.
  async function confirmNothingIsLost() {
    const dismiss = toast('Saving your progress to your account first…', { sticky: true });
    try { await cloud.syncNow(); } finally { dismiss(); }
    const left = cloud.unsyncedCount();
    if (left === 0) return true;
    return confirmSheet({
      title: 'Some progress is not in your account yet', danger: true, confirmLabel: 'Remove anyway',
      message: `${plural(left, 'item')} on this device ${left === 1 ? 'has' : 'have'} not been uploaded to your account. Removing the progress from this device will lose ${left === 1 ? 'it' : 'them'}.`,
    });
  }

  async function askSignOut() {
    let clear = false;
    const ok = await confirmSheet({
      title: 'Sign out of this device?', message: 'Your progress stays in your account. This device keeps its copy unless you choose to remove it below.', confirmLabel: 'Sign out',
      extra: switchRow({ title: 'Also remove progress from this device', description: 'Choose this on a shared phone or computer.', checked: false, onChange: (v) => { clear = v; } }),
    });
    if (!ok || (clear && !(await confirmNothingIsLost())) || !(await cloud.signOut({ clearDevice: clear }))) return;
    if (clear) {
      applyAppearance(data.getSettings());
      location.hash = '#/';
      location.reload();
    } else toast('Signed out.');
  }

  async function askDeleteData() {
    const ok = await confirmSheet({
      title: 'Delete your cloud data?', danger: true, confirmLabel: 'Delete cloud data',
      message: 'This permanently deletes the progress stored in your account and signs this device out. The progress on this device is kept. Other devices signed in to this account may upload theirs again, so sign out there too.',
    });
    if (ok && await cloud.deleteCloudData()) toast('Cloud data deleted. You are signed out.');
  }

  async function askDeleteAccount() {
    const ok = await confirmSheet({
      title: 'Delete your account?', danger: true, confirmLabel: 'Delete account',
      message: 'This permanently deletes your account and everything stored with it. It cannot be undone. The progress on this device is kept.',
    });
    if (ok && await cloud.deleteAccount()) toast('Account deleted.');
  }

  const deviceProgress = () => summarize(store.keys().filter((k) => /^(qstats|skills|guide)\./.test(k) && isSyncedKey(k)).map((k) => [k, store.get(k)]));

  async function askUseAccountOnly() {
    const mine = deviceProgress();
    const what = isEmpty(mine) ? 'the progress on this device' : `the progress on this device (${describeSummary(mine)})`;
    const ok = await confirmSheet({
      title: 'Replace the progress on this device?', danger: true, confirmLabel: 'Replace',
      message: `This removes ${what} and replaces it with what your account holds. This cannot be undone.`,
    });
    if (ok && await cloud.approveFirstSync({ replaceLocal: true })) toast('This device now matches your account.');
  }

  // While the learner decides, look (read-only) at what the account already holds, so both sides can be compared.
  function wantPreview(needed) {
    if (!needed) { preview = 'idle'; accountSummary = null; previewToken += 1; return; }
    if (preview !== 'idle') return;
    preview = 'loading';
    const token = (previewToken += 1);
    cloud.previewAccount().then((entries) => {
      if (token !== previewToken) return; // signed out, or another account, in the meantime
      accountSummary = entries ? summarize(entries) : null;
      preview = 'done';
      render();
    });
  }

  function approvalPanel() {
    const mine = deviceProgress();
    const accountEmpty = preview === 'done' && accountSummary !== null && isEmpty(accountSummary);
    const theirs = preview === 'loading' ? 'checking\u2026' : accountSummary ? describeSummary(accountSummary) : 'could not be checked right now';
    return h('div', { class: 'notice warn', role: 'region', 'aria-label': 'Progress on this device' },
      h('strong', null, 'This device already has study progress.'),
      h('p', null, accountEmpty
        ? 'Your account has no progress yet. Add what is on this device to it.'
        : 'Your account and this device each keep their own progress. Choose what happens to the progress on this device.'),
      h('p', { class: 'small' }, h('strong', null, 'On this device: '), describeSummary(mine)),
      h('p', { class: 'small' }, h('strong', null, 'In your account: '), theirs),
      h('button', { type: 'button', class: 'btn primary block', disabled: state.busy, onclick: () => cloud.approveFirstSync() }, accountEmpty ? 'Add to my account' : 'Keep both'),
      accountEmpty ? null : h('p', { class: 'muted small' }, 'Combines the two. Nothing is deleted, and question counts from both are added together.'),
      accountEmpty ? null : h('button', { type: 'button', class: 'btn block', disabled: state.busy, onclick: askUseAccountOnly }, 'Use my account\u2019s progress'),
      accountEmpty ? null : h('p', { class: 'muted small' }, 'Replaces the progress on this device with your account\u2019s. Choose this if this device only has a copy of the same progress, or if someone else has used it.'));
  }

  async function syncNow() {
    const status = await cloud.syncNow();
    if (status?.state === 'idle' && !status.error) toast('Everything is up to date.');
    else if (status?.state === 'offline') toast('You are offline. It will sync later.');
    else if (status?.state === 'error') toast(status.error || 'Sync failed.');
  }

  const providerButtons = (again) => h('div', { class: 'stack-sm' },
    ...state.methods.filter((m) => METHOD_LABEL[m]).map((m) => h('button', {
      type: 'button', class: 'btn block', disabled: state.busy, onclick: () => cloud.signIn(m),
    }, icon('user', 20), `${again ? 'Sign in again with' : 'Continue with'} ${METHOD_LABEL[m]}`)));

  function emailForm() {
    if (!state.methods.includes('email')) return null;
    const emailInput = h('input', {
      class: 'input', type: 'email', inputmode: 'email', autocomplete: 'email', autocapitalize: 'none', spellcheck: 'false',
      placeholder: 'you@example.com', 'aria-label': 'Email address', value: emailValue, dataset: { field: 'email' },
      oninput: (e) => { emailValue = e.target.value; },
    });
    const sendCode = async () => {
      if (!/^\S+@\S+\.\S+$/.test(emailValue.trim())) { toast('Enter a valid email address.'); return; }
      if (await cloud.sendEmailCode(emailValue)) { codeSent = true; codeValue = ''; render(); }
    };
    const verify = async () => {
      if (codeValue.trim().length < 6) { toast('Enter the code from the email.'); return; }
      if (await cloud.verifyEmailCode(emailValue, codeValue)) { codeSent = false; codeValue = ''; }
    };
    return h('div', { class: 'stack-sm email-form' },
      h('span', { class: 'field-label' }, 'Or use an emailed code'),
      emailInput,
      codeSent ? h('input', {
        class: 'input', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '10', placeholder: 'Code from the email',
        'aria-label': 'Code from the email', value: codeValue, dataset: { field: 'code' }, oninput: (e) => { codeValue = e.target.value; },
      }) : null,
      codeSent
        ? h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn primary grow', disabled: state.busy, onclick: verify }, 'Sign in'),
          h('button', { type: 'button', class: 'btn ghost', disabled: state.busy, onclick: sendCode }, 'Send again'))
        : h('button', { type: 'button', class: 'btn block', disabled: state.busy, onclick: sendCode }, 'Email me a code'));
  }

  function noticeEl() {
    const text = state.notice;
    const warning = state.sync.warning;
    return [
      text ? h('div', { class: 'notice bad', role: 'alert' }, h('span', null, text), h('button', { type: 'button', class: 'link-btn', onclick: cloud.clearNotice }, 'Dismiss')) : null,
      warning ? h('div', { class: 'notice warn', role: 'status' }, warning) : null,
    ];
  }

  function signedOutBody() {
    return [
      h('p', { class: 'muted small' }, 'Optional. Sign in to keep your progress in the cloud and pick it up on another device. Without an account, everything stays on this device.'),
      ...noticeEl(),
      state.mock ? h('p', { class: 'muted small' }, 'Development mode: sign-in is simulated.') : null,
      providerButtons(false),
      emailForm(),
      privacy,
    ];
  }

  function signedInBody() {
    const u = state.user;
    const status = statusOf(state);
    const approval = state.sync.state === 'needs-approval';
    return [
      h('div', { class: 'row static' },
        h('span', { class: 'row-lead' }, icon('user', 22)),
        h('span', { class: 'row-main' },
          h('span', { class: 'row-title' }, u.name || u.email || 'Signed in'),
          h('span', { class: 'row-sub' }, [u.name && u.email ? u.email : null, PROVIDER_LABEL[u.provider] ? `Signed in with ${PROVIDER_LABEL[u.provider]}` : null].filter(Boolean).join(' · ') || 'Signed in'))),
      h('div', { class: ['row', 'static', 'sync-status', status.tone], role: 'status', 'aria-live': 'polite' },
        h('span', { class: 'row-lead' }, icon(status.icon, 22)),
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, status.title), status.sub ? h('span', { class: 'row-sub' }, status.sub) : null)),
      ...noticeEl(),
      approval ? approvalPanel() : null,
      state.sync.needsSignIn ? providerButtons(true) : null,
      approval ? null : h('div', { class: 'btn-row sync-actions' },
        h('button', { type: 'button', class: 'btn grow', disabled: state.busy || state.sync.state === 'syncing', onclick: syncNow }, icon('refresh', 20), 'Sync now')),
      row({ title: 'Sign out', sub: 'This device only', leading: icon('log-out', 22), onClick: askSignOut, chevron: false }),
      row({ title: 'Delete my cloud data', sub: 'Removes your progress from the cloud', leading: icon('trash', 22), onClick: askDeleteData, chevron: false }),
      row({ title: 'Delete my account', sub: 'Removes the account and everything in it', leading: icon('trash', 22), onClick: askDeleteAccount, chevron: false }),
      privacy,
    ];
  }

  function render() {
    state = cloud.getState();
    el.hidden = !state.configured;
    if (!state.configured) { el.replaceChildren(); return; }
    wantPreview(Boolean(state.user) && state.sync.state === 'needs-approval');
    const focused = el.contains(document.activeElement) ? document.activeElement.dataset?.field : null;
    el.replaceChildren();
    append(el, [h('h3', null, icon('cloud', 20), 'Account & sync'), state.user ? signedInBody() : signedOutBody()]);
    if (focused) el.querySelector(`[data-field="${focused}"]`)?.focus({ preventScroll: true });
  }

  const off = cloud.subscribe(render);
  cloud.initCloud().then(render);
  render();
  return { el, destroy: off };
}
