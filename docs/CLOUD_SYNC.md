# Cloud sync (optional)

CertStudy works fully without an account: progress lives on the device. This feature adds an **optional** sign-in so progress is kept in the cloud, follows you between your phone and your computer, and survives a lost phone. People you share the app with get their own private account and see only their own progress.

It is switched off until you fill in the small settings file `cloud.json` as described below. Until then the app behaves exactly as before: no accounts, and no requests beyond loading its own files.

## What you get

- **Sign in with Microsoft, Google or GitHub.** The app never sees a password. (An emailed one-time code is built in too; see [Email codes](#email-codes-optional).)
- **Local-first.** The app always reads and writes the device first, so it is fast and works offline. When you are signed in and online it quietly syncs in the background (when it opens, when you come back to it, when you go back online, after you change something, and every few minutes while it is open).
- **Nothing is lost when two devices disagree.** Changes from both devices are merged: ratings and reading marks per item, practice history by attempt, and question statistics by adding up the attempts made on each device. Deleting something on one device never destroys a newer change made on another.
- **Private per person.** Every account can read and change only its own rows. There are no groups, leaderboards or shared data.
- **You stay in control.** Sign out of one device, remove progress from a shared device, delete your cloud data, or delete your account, all from Settings > Account & sync.

What is stored: settings (theme and text size, shuffle and instant-feedback switches), reading progress, skill ratings, per-question statistics, practice history and the saved answers for each attempt. Not stored: anything about an exam in progress (that stays on the device), the study content itself, or anything else. Your name and email come from the account you sign in with and are held by the sign-in service, not by CertStudy.

## How it is built

```
phone / computer (the app)
  localStorage  <-- the app reads and writes here, exactly as before
  js/sync.js    merges local data with the cloud copy (js/merge.js holds the merge rules)
        |
        |  HTTPS: sign-in (Supabase Auth) and six small database functions (cs_*)
        v
Supabase project (yours)
  Auth      Microsoft / Google / GitHub (/ email code)
  Postgres  one table, cs_docs: one private row per person per document, protected by row level security
```

- The browser talks to your Supabase project directly. There is no server of ours in between.
- The only thing in this repository about your project is `cloud.json`: the project address and the **publishable** key. Both are public by design (every website using Supabase ships them). What protects the data is row level security in the database, not secrecy of those two values.
- The OAuth *client secrets* (for Microsoft, Google and GitHub) are entered only in the Supabase dashboard. They never belong in this repository, and the build refuses a secret or service-role key if one is pasted into `cloud.json` by mistake.

## One-time setup (about 20 minutes)

You need accounts with Supabase and with each sign-in provider you want to offer. All of them have free tiers.

### 1. Create the Supabase project

1. Go to <https://supabase.com/dashboard>, sign in, choose **New project**, name it (for example `certstudy`), pick the region nearest you and set a database password (store it in a password manager; the app never uses it).
2. Wait for the project to finish provisioning. Note the **project reference** (the part before `.supabase.co` in the project URL). The examples below call it `<ref>`.

### 2. Create the table and functions

1. In the dashboard open **SQL Editor > New query**.
2. Paste the whole of [supabase/migrations/20261021000000_cloud_sync.sql](../supabase/migrations/20261021000000_cloud_sync.sql) and choose **Run**. It is safe to run again.
3. Optional check: **Table Editor** should now show `cs_docs` with **RLS enabled**.

### 3. Tell Supabase where the app lives

Open **Authentication > URL Configuration** and set:

- **Site URL**: `https://jwhit49.github.io/certstudy/`
- **Redirect URLs**: add `https://jwhit49.github.io/certstudy/` (the exact address; Supabase recommends exact paths over wildcards).

If you publish the app somewhere else, use that address instead; it must be the same value the app uses to come back after sign-in.

### 4. Turn on the sign-in providers

For each provider, **Authentication > Sign In / Providers** has a switch plus a Client ID and Client Secret. Copy the **Callback URL** shown there; it is `https://<ref>.supabase.co/auth/v1/callback`. You need only the providers listed in `cloud.json` (step 5).

**GitHub**
1. GitHub > Settings > Developer settings > OAuth Apps > **New OAuth App**.
2. Homepage URL: `https://jwhit49.github.io/certstudy/`. Authorization callback URL: the Supabase callback URL.
3. Create the app, then **Generate a new client secret**. Paste the Client ID and the secret into Supabase and enable the provider.

**Google**
1. Google Cloud Console (<https://console.cloud.google.com>): create or choose a project. It is free and needs no billing for sign-in.
2. Open the **Google Auth Platform** (<https://console.cloud.google.com/auth/overview>) and choose **Get started**: app name `CertStudy`, your email as the support email, audience **External**, your email as the contact.
3. **Data Access**: add the scopes `openid` (it has to be added by hand), `.../auth/userinfo.email` and `.../auth/userinfo.profile`, then save. These are Google's basic scopes.
4. **Clients > Create client**: type **Web application**. **Authorized JavaScript origins**: `https://jwhit49.github.io` (the address without the `/certstudy/` part). **Authorized redirect URIs**: the Supabase callback URL. Create it, then copy the Client ID and the client secret straight away (Google shows the secret only when it is created).
5. Paste both into Supabase (Google provider), enable it and save.
6. **Audience**: while the app is in **Testing**, only the test users you list can sign in, so add your own Google account there. To let anyone you share the app with sign in, choose **Publish app** (status **In production**). The app asks only for the basic profile and email, which does not need Google's app verification. The consent screen shows your Supabase project address unless you set up branding or a custom domain.

**Microsoft** (covers Outlook.com, Hotmail and Live addresses as well as work and school accounts)
1. Microsoft Entra admin center (<https://entra.microsoft.com>, or Azure portal > Microsoft Entra ID) > **App registrations** > **New registration**. A work tenant may stop you from registering apps that allow personal accounts; if so, sign in with a personal Microsoft account instead. This is free and needs no Azure subscription.
2. **Supported account types**: *Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)*. This is what lets Outlook.com accounts and work or school accounts all sign in.
3. **Redirect URI**: platform **Web**, value the Supabase callback URL. Register.
4. Copy the **Application (client) ID**. Under **Certificates & secrets** create a **New client secret** and copy its **Value** (not the Secret ID). Note its expiry date: sign-in with Microsoft stops when it expires, so create a new one before then.
5. In Supabase enable **Azure** and paste the Client ID and secret. Leave the tenant URL empty (it defaults to `common`).
6. Optional hardening (Supabase recommends it, although a new multitenant app is not normally affected): in the app registration open **Manifest**, back it up, and set `optionalClaims` to include `xms_edov` and `email` for the ID token (and `xms_edov` for the access token), then save. This lets Supabase know for certain whether Microsoft's email address is verified. See <https://supabase.com/docs/guides/auth/social-login/auth-azure>.

Signing in with different providers: Supabase links sign-ins that share the same email address into one account, so the same person using GitHub and Google with the same email sees the same progress. A provider that uses a different email creates a separate account with its own, separate progress.

### 5. Switch the app on

1. In Supabase open **Project Settings > API Keys** and copy the **Project URL** and the **publishable** key (`sb_publishable_...`; on an older project, the `anon` key).
2. Edit [cloud.json](../cloud.json) (next to `index.html`; it ships switched off) and fill it in:

   ```json
   {
     "enabled": true,
     "url": "https://<ref>.supabase.co",
     "publishableKey": "sb_publishable_...",
     "methods": ["microsoft", "google", "github"]
   }
   ```

   `methods` lists the sign-in buttons to show (`microsoft`, `google`, `github`, `email`). Never paste a **secret** or **service_role** key here.
3. Run `npm run build` (it validates the file and allows your project address in the page's Content-Security-Policy), then commit and push. GitHub Pages publishes it within a minute or two.
4. Open the site, then **Settings > Account & sync** and sign in.

To turn the feature off again, set `"enabled": false` and rebuild.

### 6. Keep the free project awake

Free Supabase projects are paused after about a week without activity. [.github/workflows/keepalive.yml](../.github/workflows/keepalive.yml) calls a public function, `cs_ping()`, twice a week so this does not happen, and does nothing unless `cloud.json` is enabled. GitHub stops scheduled workflows in a repository with no activity for 60 days; if that happens, re-enable the workflow on the Actions tab. If a project does get paused, restore it from the Supabase dashboard (your data is kept).

## Using it

- **Signing in on a device that already has study progress.** The app is local-first, so a phone or laptop you have already studied on holds progress that your account has never seen. The app asks before it uploads anything, and shows what is on each side (for example "10 questions answered · 2 skills rated · 2 sections read" on the device and "5 questions answered · 3 skills rated · 1 section read" in the account):
  - **Keep both** (shown as **Add to my account** when the account is still empty) combines the two. Nothing is deleted: practice history and reading marks from both are kept, question counts from both devices are *added together*, and if the same skill was rated differently, this device's rating is kept. Choose this when the progress on this device is separate from the account's (for example you studied here before signing in). It is the safe choice when in doubt.
  - **Use my account's progress** replaces this device's progress with the account's (the confirmation says exactly what will be removed). Choose it when the device only holds a *copy* of what the account already has (for example a restored backup, or after deleting your cloud data and signing in again), so the same attempts are not counted twice, and on a shared device that someone else has used. It is not offered when the account is empty, because there would be nothing to replace it with.
- **A new phone.** Install the app, sign in, and your progress downloads.
- **Offline.** Everything works. Changes are kept and sync when you are back online. Settings > Account & sync shows the current state.
- **Sign out.** Signs this device out. The progress stays on the device unless you also choose *Also remove progress from this device* (use that on a shared phone or computer). Before removing anything the app first tries to upload, and if something could not be uploaded it tells you and asks again, so a signed-out device never silently loses progress that was not saved.
- **Reset all progress** on a signed-in device also clears the account's copy and your other devices (the confirmation says so). **Restore from backup** likewise replaces progress everywhere.
- **Delete my cloud data** removes everything stored for your account and signs this device out. Other devices still signed in may upload their progress again, so sign out there too if you want a clean slate.
- **Delete my account** removes the account and all its data permanently.

## iPhone Home Screen and sign-in

Sign-in happens on the provider's page, then returns to the app. On an iPhone, an app installed to the Home Screen keeps its storage separate from Safari. If a provider's page opens in Safari instead of staying in the app, the sign-in may not complete inside the installed app. This is the one part that cannot be confirmed without testing on your own phone. If it happens:

1. Use the emailed one-time code instead ([below](#email-codes-optional)). The whole flow stays inside the app, so it does not depend on redirects.
2. Or sign in from the website in Safari and use the Home Screen app without an account, backing up with **Back up progress**.

Please report what you see (which provider, what the app shows afterwards) and the flow can be adjusted.

## Email codes (optional)

Add `"email"` to `methods` in `cloud.json` to show an *Email me a code* box. Supabase's built-in email sender is meant for testing: it only emails members of your Supabase organization (that is, you) and allows very few emails per hour. That is enough for you to use it as a fallback. To let other people sign in with a code, configure custom SMTP in **Project Settings > Authentication > SMTP** (any email service works). Check that **Authentication > Emails** is set to send a **code** (the `{{ .Token }}` placeholder) in the magic-link template, otherwise people receive only a link.

## Sharing with other people

Send them the site address. They sign in with their own account and have their own private progress. Practical limits on the free plans (check the providers' current pricing pages, these change):

- Supabase free: a large monthly allowance of active users (tens of thousands), a 500 MB database, and two active projects per account. Each person is limited here to 1000 documents (not counting deletion markers) and 25 MB, far more than the app needs (roughly 100 KB to a few MB of progress per person).
- Google consent screen: must be *In production* for people outside your test-user list.
- Microsoft: the client secret expires (see above).

You (the project owner) can see accounts and rows in the Supabase dashboard, as with any hosted service. Tell the people you share it with what is stored (the list at the top of this page). Their sign-in details are held by Supabase and the provider they choose.

## Security notes

- **Row level security** on `cs_docs` restricts every operation to the signed-in person's own rows. Signed-out visitors can call only `cs_ping()`, which returns the time. The database tests in `tools/test-sql.mjs` attack this from a second account (read, update, delete, insert-as-someone-else, change owner or key) and check the limits.
- The functions run with the caller's permissions (no elevated rights) except `cs_delete_my_account()`, which can delete only the caller's own account.
- Limits: 256 KB per document, 1000 documents and 25 MB per person, and at most 100 documents per request. Markers left by deleted documents do not count towards the 1000; they are trimmed automatically (kept for at most 90 days, and at most the newest 1000) and the table as a whole is capped at 3000 rows per person. Writes from one person are applied one at a time, so two devices cannot slip past a limit together.
- Every write gets a revision number that was never used before, even when a row is deleted and created again, so another device that remembers an old revision can never mistake a stale copy for the current one.
- Every request is made for one account. If the browser's sign-in changes in the middle of a sync (for example you sign out and into a different account in another tab), the sync stops without applying or sending anything, so one account's documents can never reach another's.
- Deleting your cloud data or your account waits for any sync in progress (in every open tab) before it runs, so nothing is uploaded after the deletion.
- The page's Content-Security-Policy stays strict (no inline scripts, no third-party scripts). With sync on, `connect-src` additionally allows exactly your Supabase project address. The sign-in library is bundled into `js/vendor/auth-js.js` (pinned version, MIT license inside the file), so no script is loaded from a CDN.
- Data from the cloud is validated with the same strict rules as a restored backup before it is applied, and a cloud document the app does not understand (for example written by a newer version) is left alone rather than overwritten.
- Never commit secrets. The only values in the repository are the public project address and publishable key.

## Known limitations

- **Device clocks.** Which attempt counts as the latest, and where you last read in the guide, is decided by each device's clock. A device with a badly wrong clock can make an older position look newer. Counters are not affected (they are added up, not compared).
- **After "Delete my cloud data".** Other devices that stay signed in keep their progress and upload again only the documents they change afterwards. Sign out of them too for a clean start.
- **Deleting while other tabs are open.** Deleting your cloud data or account is kept from racing a sync in another open tab by the browser's Web Locks feature, which every current browser has (iOS since 15.4). On a browser without it, close other tabs of the app before deleting.
- **Only recent attempts are kept.** As before, each certification keeps its 40 most recent practice attempts (with answers); the per-question statistics cover everything.
- **Two tabs finishing a practice session in the same instant** can lose one of the two on the device itself, before sync is involved. This was already true before cloud sync existed and needs two tabs of the app open at once.
- **Free-tier limits and pausing** are the provider's; see [Keep the free project awake](#6-keep-the-free-project-awake).

## Troubleshooting

| What you see | Likely cause and fix |
| --- | --- |
| No *Account & sync* card in Settings | `cloud.json` has `"enabled": false` or failed validation. Run `npm run build`; it prints the problem. |
| "Sign-in did not complete" or a provider error page | The redirect URL is not on the allow-list (step 3), the callback URL in the provider's settings is wrong (step 4), or the client secret is wrong or expired. |
| `redirect_uri_mismatch` (Google) / `AADSTS50011` (Microsoft) | The provider's redirect URI must be exactly `https://<ref>.supabase.co/auth/v1/callback`. |
| "The cloud database is not set up yet (missing function)" | Run the SQL in step 2. |
| "Could not reach the cloud" for a long time | No connection, or the free project was paused. Open the Supabase dashboard and restore it. |
| "Your sign-in expired" | Tap *Sign in again*. Your progress on the device is untouched. |
| Signed in, but nothing syncs | The first sign-in on a device with progress waits for your choice; look for the *This device already has study progress* box in Settings. |
| "One item could not be saved to the cloud (...)" | The cloud refused that item, for example because it is too large or a limit was reached. It stays on the device and is retried every few minutes. The rest of your progress is synced normally. |
| Works in Safari but not from the Home Screen | See [iPhone Home Screen and sign-in](#iphone-home-screen-and-sign-in). |

## For developers

- `npm test` runs the merge, sync-engine, backend and vendored-library tests (no network, no dependencies).
- `npm run test:sql` runs the database tests against a real Postgres engine (PGlite) set up like a Supabase project. It installs PGlite into a temporary folder and needs a network connection.
- `npm start`, then open `http://localhost:8080/?cloud=mock&mockuser=alice` to try the whole sign-in and sync flow against a simulated cloud with no Supabase project. Open the same URL on `http://127.0.0.1:8080/` as a second "device". `POST /__mock/control` with `{"fail":"offline"|"auth"|"server"|null}` simulates outages. The mock works only on `localhost`/`127.0.0.1` and never on the published site.
- `npm run vendor` rebuilds `js/vendor/auth-js.js` from the pinned versions listed in `tools/vendor.mjs`.
- Merge rules (per document type) are in [js/merge.js](../js/merge.js); the sync engine, with its write-conflict handling and first-sign-in approval, is [js/sync.js](../js/sync.js); the database is [the migration](../supabase/migrations/20261021000000_cloud_sync.sql).
