# CertStudy

An offline-first study app for certification exams. It runs in the browser, installs to the iPhone Home Screen like a native app, and keeps working without a connection. Everything it shows comes from plain JSON "content packs", so adding another certification means adding a folder, not changing code.

Packs so far: **AB-400** (Extending Microsoft Power Platform Solutions with Code and AI: a 46-section study guide, an 88-skill confidence tracker and a 60-question practice exam with a case study) and **AB-410** (Building Intelligent Applications: a 36-section guide with a PL-200 to AB-410 comparison, a 48-skill tracker and a 60-question practice exam with a case study). The library groups packs by their `family` (for example "Power Platform").

## What it does

- **Study guide**: readable on a phone (tables scroll sideways, code blocks scroll, callouts), with "mark as studied", progress, an "On this page" jump list and a "Continue reading" shortcut.
- **Practice exams** with all five question styles: single choice, multiple choice (with "choose exactly N"), yes/no per statement, tap-to-order and fill-in-the-blank code.
  - **Study mode**: pick your answer, then tap **Check answer** when you want to see whether it is right and read the explanation. Optional **Instant feedback** reveals it as soon as an answer is complete. **Show answer** and **Try this question again** are always available.
  - **Exam mode**: timed, no feedback until you finish, flags, a question grid, automatic scoring when time runs out.
  - **Quick drill**: 10/20/30 questions filtered by domain, and by All / Missed / Unseen.
  - Results with a score ring, per-domain breakdown, "study next" guide links, review of every answer, and "retake missed".
- **Skills tracker**: rate every skill measured from 1 to 5 and see what still needs work.
- **Search** across the guide and every question.
- **Backup and restore** of all progress as a JSON file, plus light/dark/system theme and four text sizes.
- **Private**: no accounts, no analytics, no network calls after the first load. Progress lives on the device.

## Run it on your computer

Needs [Node.js](https://nodejs.org) 20 or newer. There is nothing to install.

```powershell
npm run build   # validates the content and regenerates the offline file list
npm start       # http://localhost:8080  (add  -- --lan  to reach it from a phone on your Wi-Fi)
npm test        # grading, content validation, storage/backup and progress tests
```

Open `http://localhost:8080/?nosw` if you want to bypass the service worker while developing (it also clears any cached copy).

## Put it on your iPhone

The app is published with GitHub Pages from the `JWHIT49/certstudy` repository. (Browsers only allow service workers and offline mode on secure HTTPS origins, which is why it is hosted rather than opened from a file.)

- Repository: <https://github.com/JWHIT49/certstudy>
- **App: <https://jwhit49.github.io/certstudy/>**

**On the iPhone**

1. Open <https://jwhit49.github.io/certstudy/> in **Safari**. (Text or e-mail the link to yourself, then tap it.)
2. Tap **Share, then Add to Home Screen, then Add**. If iOS shows an **Open as Web App** switch, leave it on.
3. Open **CertStudy from the new Home Screen icon**. The first launch needs a connection and downloads everything; once it says "Ready to use offline" the app works in airplane mode.

**One-time GitHub setup** (already done if the link above opens the app)

1. Create an empty repository named `certstudy` under the `JWHIT49` account: no README, no `.gitignore`, no license.
2. In that repository open **Settings, Pages** and set **Source** to **GitHub Actions**.
3. Push this folder to the `main` branch. The workflow in `.github/workflows/pages.yml` runs the tests, rebuilds and publishes (watch the **Actions** tab; it takes about a minute).
4. To update later, change the code or content, run `npm test` and `npm run build`, then commit and push to `main`.

**Quick look from a phone on your home Wi-Fi** (no GitHub needed): run `npm start -- --lan`, then open `http://<this-PC's-IP>:8080` on the phone. Safari only enables offline mode and Home Screen features over HTTPS, so this is for a quick look, not daily use. The dev server has no password, so only do this on a network you trust.

Things worth knowing:

- **Study inside the installed app.** iOS keeps Safari-tab storage and Home Screen app storage separate, so progress made in a Safari tab does not carry over. Install first, then study. Use **Settings, Back up progress** before changing phones or if you ever delete the app.
- **Updates**: publish a new build and the app shows **"A new version is ready. Update"** the next time you open it. It never reloads on its own in the middle of an exam, and an in-progress session survives the update.
- **The site is public**: see "Where this lives" below for what that means and how to keep the app private instead.
- The app targets current iOS Safari (iOS 16.4 or later recommended). It has not been run on a physical iPhone in the environment that produced it, so please report anything that looks off on a real device.

### Publishing to the App Store instead

A PWA does not need App Review and updates instantly, which is why this project is one. If you still want a store listing with your Apple Developer account, the same files can be wrapped with [Capacitor](https://capacitorjs.com):

1. On a Mac with Xcode: `npm i @capacitor/core @capacitor/cli @capacitor/ios`, then `npx cap init CertStudy com.yourname.certstudy --web-dir=_site`.
2. Stage the site (the workflow's "Stage site" step shows which files), `npx cap add ios`, `npx cap sync`, open the project in Xcode, set your Team and bundle identifier, then archive and upload to TestFlight.
3. Expect App Review to look closely at wrapped websites (guideline 4.2, minimum functionality). The offline content and practice tooling help, but acceptance is not guaranteed. Without a Mac, a macOS CI runner or a cloud build service can do the Xcode steps.

## Where this lives

CertStudy is published from one place: the GitHub account **JWHIT49**.

- The only git remote is `origin`, which points to `https://github.com/JWHIT49/certstudy`. Commits are authored as `JWHIT49` with GitHub's no-reply address, so no work or personal e-mail address is stored in the history.
- The deploy workflow runs only when the repository owner is `JWHIT49` (`if: github.repository_owner == 'JWHIT49'`). A fork or copy under another account builds and publishes nothing.
- `package.json` is marked `"private": true`, so it cannot be published to npm by accident.
- The app loads nothing from other websites and sends nothing anywhere (the Content-Security-Policy allows only its own origin). Your answers and progress stay on the device; they are never in the repository.
- The repository is **public**, which is what free GitHub Pages hosting requires. Anyone can read or fork the code, and anyone who has the address can open the site. It holds no personal data. A private repository can also host a Pages site on a paid GitHub plan, but the site itself would still be reachable by anyone with its address.
- To keep the app itself private, serve the same static files from somewhere with access control instead: a private network with HTTPS (for example Tailscale), Cloudflare Pages with Cloudflare Access, or Azure Static Web Apps with sign-in.

## Add another certification

1. Copy `content/ab-400` to `content/<new-id>` and edit `pack.json` (set a unique `id` that matches the folder, an `order`, and a `family` to group it with related certifications), `guide.json`, `skills.json` and the exam file(s).
2. Run `npm run build`. It validates everything and prints exact, path-qualified errors (for example `[exam practice-1] exam.questions[7] (q008).answer: invalid index`), then registers the pack in `content/catalog.json`.
3. Run `npm start` to try it, then publish as above. The library screen lists every pack automatically.

The full schema, question types, allowed HTML and the rules that keep saved progress intact are in [docs/CONTENT_FORMAT.md](docs/CONTENT_FORMAT.md).

## Project layout

```
index.html, manifest.webmanifest, sw.js   app shell and service worker
css/app.css                               all styling (light, dark, text sizes)
js/                                       ES modules, no framework and no build step
  router.js shell.js ui.js dom.js         hash router, app frame, shared components
  grade.js validate.js                    pure, unit-tested logic
  sanitize.js                             allowlist HTML sanitizer for content
  store.js data.js session.js             local storage, progress, sessions
  views/                                  library, cert home, guide, practice, runner, results, skills, search, settings
content/<pack>/                           pack.json, guide.json, skills.json, exams/*.json
tools/build.mjs                           validate packs, write catalog, offline list and build id
tools/serve.mjs                           zero-dependency static server for local use
tests/                                    node --test suites
```

Security notes: the page ships a strict Content-Security-Policy (no inline scripts or styles, no third-party origins). Content HTML never reaches the page directly; `sanitize.js` rebuilds it from an allowlist of tags, classes and link schemes.

## Content and licensing

The packs are original study material and original practice questions written from public Microsoft documentation. They are **not** Microsoft exam content, are not affiliated with or endorsed by Microsoft, and the real exam may differ. Verify details against the official study guide linked in each pack.
