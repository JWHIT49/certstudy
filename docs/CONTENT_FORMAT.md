# Content pack format (schema 1)

A **pack** is one certification: its metadata, one or more study guides, an optional skills list and one or more practice exams. Packs live in `content/<pack-id>/` and are plain JSON. `npm run build` validates them, lists them in `content/catalog.json` and adds their files to the offline cache. The library screen shows every pack it finds, ordered by `order` then `code`.

```
content/
  catalog.json                  generated, do not edit
  ab-400/
    pack.json                   metadata + the list of files below
    guide.json                  one file per entry in pack.guides
    skills.json                 optional (pack.skills.file)
    exams/practice-1.json       one file per entry in pack.exams
```

To add a certification: copy `content/ab-400`, change the ids and content, run `npm run build`, fix any errors it prints, then `npm start`.

## Keep these stable

Saved progress is keyed by the ids you write. Changing them later detaches the progress from the content.

| What | Key used for saved progress |
| --- | --- |
| `pack.id` | everything for the pack |
| exam `id` + question `id` | per-question statistics (`practice-1/q001`), weak-area analysis |
| guide section `id` | "studied" marks, reading position |
| skill `n` | confidence ratings |

Add new questions and sections with new ids instead of renumbering. When content changes, bump `pack.version` (and `updated`); the build id changes by itself and installed apps offer an update.

## pack.json

| Field | Notes |
| --- | --- |
| `schema` | must be `1` |
| `id` | lowercase letters, digits, dashes (max 64). Used in URLs, so keep it short |
| `code`, `title`, `version` | required text. `code` is the badge, for example `AB-400` |
| `short`, `vendor`, `description`, `updated` | optional text (`updated` as `YYYY-MM-DD`) |
| `order` | library sort order, default 100 |
| `family` | optional group heading in the library (for example `Power Platform`); packs with the same family are listed together under it, in `order` |
| `accent` | `#rrggbb` colour for the pack's card and header |
| `disclaimer` | small print shown at the bottom of the pack home |
| `domains` | at least one: `{ "id": 1, "name": "...", "short": "...", "weight": "15-20%" }`. `id` is an integer that questions and skill groups refer to |
| `examInfo` | optional `[{ "label": "Passing score", "value": "700 / 1000" }]`, shown under "Exam at a glance" |
| `links` | optional `[{ "title": "...", "url": "https://..." }]` |
| `guides` | `[{ "id": "study-guide", "title": "Study Guide", "file": "guide.json" }]` (may be empty) |
| `skills` | optional `{ "file": "skills.json" }` |
| `exams` | `[{ "id": "practice-1", "title": "...", "file": "exams/practice-1.json", "minutes": 100, "description": "..." }]` (may be empty). `minutes` is the exam-mode time limit |

## guide.json

```json
{
  "schema": 1,
  "title": "AB-400 Study Guide",
  "parts": [
    {
      "id": "d3",
      "title": "Domain 3 · Extend Microsoft Power Platform",
      "subtitle": "35–40% of the exam",
      "sections": [
        {
          "id": "d3-plugins",
          "num": "3.1",
          "title": "3.1 Create a Dataverse plug-in",
          "readMinutes": 11,
          "badges": [{ "kind": "carry", "text": "Carried over" }],
          "html": "<p>...</p><h3>1. The event execution pipeline</h3>..."
        }
      ]
    }
  ]
}
```

- Parts are the collapsible groups in the table of contents; sections are the pages.
- `num` (optional, like `3.1`) lets other content link to the section by writing `§3.1` in running text. It becomes a link automatically.
- `badges[].kind` is one of `new`, `carry`, `ga`, `prev`, `removed`; it only changes the colour of the little label.
- Inside `html`, use `<h3>` for sub-headings (they feed the "On this page" list). The section `title` is already the page heading, so do not add an `<h1>` or `<h2>`.
- Order in the file is the reading order for **Previous / Next**.

## skills.json

```json
{
  "schema": 1,
  "groups": [
    {
      "id": "g1", "domain": 1, "title": "Design the technical architecture",
      "skills": [
        { "n": 1, "text": "Analyze the technical architecture ...", "refs": ["d1-arch"] },
        { "n": 2, "text": "Design authentication ...", "refs": ["d1-arch"], "isNew": true }
      ]
    }
  ]
}
```

`n` is a unique positive integer across the whole file. `refs` are guide section ids (they become the `§` chips). `domain` must exist in `pack.domains`. `isNew` shows a "New" label.

## exam files

```json
{
  "schema": 1,
  "id": "practice-1",
  "title": "Practice Exam 1",
  "minutes": 100,
  "bands": [
    { "min": 0.8, "label": "Strong", "text": "..." },
    { "min": 0.7, "label": "Close", "text": "..." },
    { "min": 0,   "label": "Not ready yet", "text": "..." }
  ],
  "caseStudies": [{ "id": "contoso", "title": "Contoso Field Services", "html": "<h3>Overview</h3><p>...</p>" }],
  "questions": [ ... ]
}
```

`bands` are optional: the band with the highest `min` that the score reaches is shown on the results screen. A question with `"caseStudy": "contoso"` gets a button that opens the scenario in a sheet.

### Questions

Fields common to every question:

| Field | Notes |
| --- | --- |
| `id` | unique within the exam, same format as other ids (`q001`) |
| `type` | `single`, `multi`, `yesno`, `order` or `dropdown` |
| `domain` | required; an id from `pack.domains` |
| `skill` | optional; a skill number `n` |
| `section` | optional; a guide section id. Shown as a "Study guide" link in the feedback and used for the "study next" list |
| `stem` | the question, as HTML |
| `explanation` | shown after the answer is checked, as HTML |
| `ref` | optional `https://` link (labelled "Microsoft Learn") |
| `caseStudy` | optional case study id |

Scoring is all-or-nothing per question. Saved answers are option positions, so once a question has been answered by anyone (including you), do not reorder its options or items; fix wording in place, or add a new question with a new id.

**single** and **multi**

```json
{ "type": "single", "options": ["A text", "B text", "C text", "D text"], "answer": [3] }
{ "type": "multi",  "options": ["...", "...", "...", "...", "..."], "answer": [0, 1], "select": 2 }
```

`single` needs at least 2 options and exactly one index in `answer`. `multi` needs at least 3 options, at least 2 answers, fewer answers than options, and `select` (optional) equal to the number of answers; the app then enforces "choose exactly N".

**yesno**: one Yes/No choice per statement; all statements must be right.

```json
{ "type": "yesno", "statements": [{ "text": "...", "answer": true }, { "text": "...", "answer": false }] }
```

**order**: write `items` in the **correct** order. The app always shows them shuffled and the learner taps them into sequence.

```json
{ "type": "order", "items": ["First step", "Second step", "Third step"] }
```

**dropdown** (fill in the blanks): each blank is shown as a numbered chip in the text with its own list of choices underneath.

```json
{
  "type": "dropdown",
  "format": "code",
  "template": "var notify = ({1})provider.GetService(typeof(IServiceEndpointNotificationService));\nnotify.{2}(endpoint, context);",
  "blanks": [
    { "options": ["IOrganizationService", "IServiceEndpointNotificationService"], "answer": 1 },
    { "options": ["Execute", "Send"], "answer": 0 }
  ]
}
```

`format` is `code` (the template is plain text shown in a code block) or `text` (the template is HTML). Each blank `{n}` must appear **exactly once** in the template and every placeholder needs a matching blank.

## Allowed HTML

All HTML fields (guide sections, case studies, stems, options, explanations, statements, templates in `text` format) pass through an allowlist sanitizer that rebuilds the markup. Anything else is removed, so content can never run code.

- **Tags**: `a b strong i em u s sub sup code pre kbd mark small span br hr p div ul ol li dl dt dd h2 h3 h4 h5 table thead tbody tfoot tr th td caption colgroup col blockquote details summary`.
- **Attributes**: `href` on links (`https://`, `http://`, `mailto:` or an in-app `#/` link only), `colspan`/`rowspan`, `col span`, `ol start`, `title`, `class` (from the list below) and `data-w`.
- **Not allowed**: scripts, handlers such as `onclick`, `style` attributes (the page's Content-Security-Policy blocks them and the validator rejects them), images, iframes, forms.
- **Tables** scroll sideways inside a rounded container; tables with four or more columns get a minimum width so cells stay readable on a phone.
- Escape code samples (`&lt;div&gt;`), or put them in `<pre><code>`.

Classes the stylesheet understands (other class names are dropped):

| Purpose | Classes |
| --- | --- |
| Callouts | `callout` with one of `tip` (green), `trap` (amber), `new` (purple), `warn` (red) or none (blue); `ct` for its title line, e.g. `<div class="callout trap"><span class="ct">Exam traps</span>...</div>` |
| Labels | `tag` with `new`, `ga`, `prev`, `carry` or `removed` |
| Text | `small`, `muted`, `src` (source line), `note`, `c` (centred cell), `tight` |
| Layout | `card`, `grid2`, `grid3`, `cols2` |
| Lists | `check` (checkbox bullets), `nobullet` |
| Domain weights | `dom` containing `w` (the weight box) and `b` (the description) |
| Bars | `bars` > `bar-row` > `bar-label`, `bar-track` > `bar-fill`, `bar-val`. Set the width with `data-w="39"` (a percentage), for example `<span class="bar-fill" data-w="39"></span>` |

## Validation

`npm run build` stops with a list of problems such as:

```
[exam practice-1] exam.questions[7] (q008).answer: must be unique valid option indexes
[exam practice-1] exam.questions[12] (q013).section: unknown guide section d9-nope
[guide study-guide] guide.parts[2].sections[1].html: contains script-like or inline-style content
[skills] skills.groups[0].skills[3].refs: unknown section d1-arc
```

It checks required fields and ids, duplicates, that every `domain`, `skill`, `section` and `caseStudy` reference exists, the per-type rules above, and that HTML has no scripts, event handlers or inline styles. `npm test` runs the same validator against the shipped AB-400 pack and checks that all 60 of its answers grade as correct.
