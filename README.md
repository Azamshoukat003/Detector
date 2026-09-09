# repo-guard

A small, stateless security dashboard for GitHub repositories. It does three
things:

1. **Signs you in with GitHub** (OAuth, `read:user repo`).
2. **Scans a repo on demand** — pulls the default branch's file tree, runs a
   fixed set of regex rules over the source and build-config files, and reports
   the default branch's protection status.
3. **Alerts you in real time on a force-push** — a signed webhook endpoint that
   fires a Discord/Slack message the instant a push arrives with
   `forced: true`, or when a push touches `.gitignore` / build config.

The threat model it is built around: a collaborator's machine or GitHub account
is compromised by malware that amends commits and force-pushes obfuscated
JavaScript into shared repos, and edits `.gitignore`, `postcss.config.js` and
the ESLint config to hide the dropped files and re-execute them on every build.

---

## ⚠️ Read this before you sign in

**This app requests the `repo` OAuth scope, which grants read access to the
contents of your private repositories.**

There is no narrower option: GitHub's classic OAuth scopes do not offer
"read-only private repo contents" — `repo` is the only scope that can read a
private repo's files at all, and it also carries write access to code, issues,
PRs, wikis, deployments and repo settings. It additionally covers private repos
of any organisation that has approved this OAuth app.

Practical consequences:

- Only sign in with an account you are comfortable granting that to. If the
  account you are worried about is the *compromised* one, do not sign in with
  it — sign in with your own account and scan the shared repos from there.
- The token is held only in the encrypted NextAuth session cookie in your
  browser and used server-side for the duration of a request. It is never
  written to a database (there isn't one) and never sent anywhere except
  `api.github.com`.
- **repo-guard writes to your repos in exactly one place**: the cleanup PR
  (below), and only when you click the button. It creates a new branch and a
  pull request; it never commits to your default branch, never force-pushes,
  and never deletes anything. Everything else in the app is read-only.
- If you deploy this publicly, anyone who signs in gets a dashboard over *their
  own* repos, not yours — but it is still your OAuth app, and your OAuth app's
  client secret. Treat the deployment as a private tool: keep the URL to
  yourself, or put Vercel password protection / an allowlist in front of it.
- Revoke at any time: **GitHub → Settings → Applications → Authorized OAuth
  Apps → repo-guard → Revoke**.

---

## 1. Register a GitHub OAuth App

1. Go to <https://github.com/settings/developers> → **OAuth Apps** → **New OAuth
   App**. (For an org-owned app: *Organisation settings → Developer settings →
   OAuth Apps*.)
2. Fill in:
   - **Application name**: `repo-guard`
   - **Homepage URL**: `http://localhost:3000` (local) or your Vercel URL
   - **Authorization callback URL**:
     `http://localhost:3000/api/auth/callback/github`
3. Create the app, then **Generate a new client secret**. Copy the **Client ID**
   and the **Client secret** — the secret is shown once.

GitHub's current OAuth App form accepts **multiple** callback URLs (use **Add
more**), so one app can cover both environments. Register both:

| Environment | Authorization callback URL                                |
| ----------- | --------------------------------------------------------- |
| Local       | `http://localhost:3000/api/auth/callback/github`           |
| Vercel      | `https://<your-app>.vercel.app/api/auth/callback/github`   |

Leave **Enable Device Flow** off. Leave **Expire user access tokens** off too:
with it on GitHub issues 8-hour tokens plus a refresh token, and `src/lib/auth.ts`
stores the access token once without rotating it — scans would start failing with
a 401 until you signed out and back in.

> Use an **OAuth App**, not a GitHub App. NextAuth's `github` provider is built
> for the OAuth App flow, and the scope model above assumes it.

---

## 2. Environment variables

Copy `.env.example` to `.env.local` and fill it in.

| Variable                | Required            | What it is                                                                 |
| ----------------------- | ------------------- | -------------------------------------------------------------------------- |
| `NEXTAUTH_URL`          | local yes           | Base URL of the app, e.g. `http://localhost:3000`. Vercel infers it.        |
| `NEXTAUTH_SECRET`       | yes                 | Signs the session JWT. `openssl rand -base64 32`.                          |
| `GITHUB_ID`             | yes                 | OAuth App **Client ID**.                                                    |
| `GITHUB_SECRET`         | yes                 | OAuth App **Client secret**.                                                |
| `GITHUB_WEBHOOK_SECRET` | for the webhook     | The **Secret** you set on the GitHub webhook. Without it `/api/webhook` returns 500 and accepts nothing — it fails closed on purpose. |
| `ALERT_WEBHOOK_URL`     | for alerts          | Discord or Slack **incoming webhook** URL that receives the alerts.         |
| `ALERT_WEBHOOK_KIND`    | no (default `discord`) | `discord` → posts `{"content": "..."}`; `slack` → posts `{"text": "..."}`. |
| `ENABLE_LOCAL_SCAN`     | no                  | `1` forces the local filesystem check on, `0` forces it off. Default: on for a local dev server, off in production, always off on Vercel. |

If `ALERT_WEBHOOK_URL` is unset, alerts are logged server-side and the webhook
response reports `deliveryErrors` rather than pretending they were sent.

---

## 3. Run it locally

```bash
npm install
cp .env.example .env.local   # then fill it in
npm run dev                  # http://localhost:3000
```

Other scripts: `npm run build`, `npm start`, `npm run typecheck`.

### Testing the webhook locally

GitHub can't reach `localhost`, so either tunnel (`ngrok http 3000`, then point
the webhook at `https://<id>.ngrok.app/api/webhook`), or POST a signed payload
by hand:

```bash
SECRET=testsecret
BODY='{"ref":"refs/heads/main","forced":true,"repository":{"full_name":"acme/site"},"pusher":{"name":"collab-bot"},"commits":[]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"

curl -sS -X POST http://localhost:3000/api/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-Hub-Signature-256: $SIG" \
  --data "$BODY"
```

You should get back `{"ok":true,...,"forced":true,"alertsRaised":1,...}` and see
the message land in Discord/Slack.

---

## 4. Deploy to Vercel

1. Push this directory to a GitHub repo, then **Vercel → Add New → Project →
   Import**. Framework preset: Next.js. No build-setting changes needed.
2. Add the environment variables from §2 under **Settings → Environment
   Variables** (Production, and Preview if you want it there too). `NEXTAUTH_URL`
   can be omitted on Vercel; set it explicitly if you use a custom domain.
3. Deploy, then go back to your **production** OAuth App and set the callback
   URL to `https://<your-app>.vercel.app/api/auth/callback/github`.
4. Redeploy after changing env vars — Vercel bakes them in at build time.

### Wiring the webhook

Per repository you want watched: **Repo → Settings → Webhooks → Add webhook**

- **Payload URL**: `https://<your-app>.vercel.app/api/webhook`
- **Content type**: `application/json` (required — the signature is computed
  over the raw JSON body)
- **Secret**: the same value as `GITHUB_WEBHOOK_SECRET`
- **Events**: *Just the push event*

If you have many repos, add the webhook at the **organisation** level instead
and it covers all of them at once. GitHub shows each delivery and its response
under **Recent Deliveries**, with a **Redeliver** button — that is the fastest
way to debug.

> Serverless timing note: `/api/scan` declares `maxDuration = 60`, which is the
> Vercel Hobby ceiling. The 200-file cap and the 8-way concurrency pool are
> sized to fit inside it. The webhook route is a few milliseconds.

---

## Troubleshooting sign-in

Three failure modes hit during setup, all with unhelpful error text:

**`?error=OAuthSignin` with `[NO_SECRET]` and `"ikm" must be at least one byte
in length` in the server log.** `NEXTAUTH_SECRET` is empty. That string is
`hkdf` being handed a zero-length key. Set it, then **restart the dev server** —
Next reads `.env` only at boot, so pasting a value into a running server changes
nothing.

**`Cannot find module './vendor-chunks/next-auth.js'` (or `jose.js`) on the
callback.** Next's dev static-paths worker loads the catch-all auth route
outside the compilation that emitted its dependencies. The route declares
`export const dynamic = "force-dynamic"` to prevent this — an OAuth handler
reads cookies and query params on every call and can never be static. If it
recurs, `npm run clean` and restart.

**`?error=OAuthCallback` with `issuer must be configured on the issuer`.**
GitHub now returns an `iss` parameter on the callback. next-auth delegates to
`openid-client`, which refuses to validate `iss` unless the issuer is
configured, and next-auth's own GitHub provider leaves it undefined. Fixed by
setting `issuer: "https://github.com/login/oauth"` in `src/lib/auth.ts` — it
must match the `iss` GitHub sends verbatim.

Two harmless 404s you may also see in the log: `/firebase-messaging-sw.js` (a
service worker some other project registered on `localhost:3000` in your
browser) and `/.well-known/appspecific/com.chrome.devtools.json` (Chrome
DevTools probing). Neither is this app.

---

## What the scanner actually does

**File selection** (`src/lib/scan-policy.ts`)

- Walks the recursive git tree for the repo's default branch.
- Skips anything under `node_modules/`, `dist/`, `build/`, `.next/`.
- Skips blobs larger than **500 KB**.
- Scans files with extensions `.js .ts .jsx .tsx .mjs .cjs .bat .cmd .ps1 .sh`.
- **Always** scans, whatever the extension: `.gitignore`, `.npmrc`,
  `postcss.config.{js,cjs,mjs}`, `tailwind.config.{js,cjs,mjs,ts}`, `.eslintrc`
  (and `.js/.cjs/.mjs/.json/.yml/.yaml` variants), `eslint.config.{js,mjs,cjs}`,
  `webpack.config.js`, `babel.config.js`, `vite.config.js`, `next.config.js` —
  these are the files the observed malware rewrites to hide payloads and re-run
  them on build.
- Caps at **200 files per run**. If files are dropped by the cap, or GitHub
  truncated the tree response, the result panel says so explicitly rather than
  implying full coverage.

**Rules** (`src/lib/rules.ts`)

| Rule | Severity | Matches |
| --- | --- | --- |
| `obfuscator-string-array-rotator` | ERROR | `while(!![]){try{` — the javascript-obfuscator string-array rotation idiom |
| `hex-identifier-obfuscation-density` | WARNING | 10+ consecutive `_0x`-prefixed hex identifiers |
| `spawn-interpreter-inline-code` | ERROR | `spawn(..., ['-e' \| '-c' \| '/c', ...])` |
| `eval-of-dynamic-string` | ERROR | `eval()` on a concatenated or templated string |
| `blockchain-rpc-plus-exec` | ERROR | `eth_blockNumber` / `eth_getBlockByNumber` / `eth_getTransactionByHash` / `eth_getTransactionCount` |
| `forced-git-push` | WARNING | `git push ... --force` inside a script |
| `pipe-download-to-shell` | ERROR | `curl ... \| bash\|sh\|node\|python` |
| `gitignore-hides-dropped-payload` | ERROR | a `.gitignore` line naming `branch_structure.json`, `temp_auto_push.bat` or `temp_interactive_push.bat` — **only inside a `.gitignore`** |
| `known-dropper-file-present` | ERROR | one of those three files tracked anywhere in the repo (a tree check, not a content match) |

Each finding reports the rule id, severity, message, `path:line`, and the
matching source line. At most 5 matches per rule per file, so one obfuscated
blob can't flood the report.

One deliberate addition: `blockchain-rpc-plus-exec` matches on the RPC method
names alone (as specified), but its message claims a *combination* with
`child_process`. So the finding also carries a corroboration note saying whether
`child_process` / a spawn API is actually present in the same file. A legitimate
web3 client will say "no `child_process` reference found" — that's the line that
tells you whether to care.

**Known dropper artifacts**

This dropper writes three files into a repo and then adds them to `.gitignore`
so they stop appearing in `git status`:

```
branch_structure.json
temp_auto_push.bat
temp_interactive_push.bat
```

Both halves of that are detected:

- **The file existing.** Checked across the *entire* tree, deliberately outside
  the extension filter, the 500 KB limit and the 200-file cap — none of those
  should be able to hide one. `branch_structure.json` would never be picked up
  by the extension list on its own.
- **The `.gitignore` entry.** Matched as a whole line, allowing the usual `/`,
  `**/`, `!` and trailing-`/` spellings. This rule is **scoped to `.gitignore`
  files only** (`Rule.appliesTo`), so a README or a source file that merely
  mentions the names does not trip it — including repo-guard's own source.

Both also raise a push alert if a commit adds or modifies them.

In the cleanup PR the two get different treatment: the dropper files are
**deleted whole** (there is no legitimate content to preserve), while the
`.gitignore` keeps every real entry and loses only the lines naming a dropper.
Deletion is restricted to those exact filenames, so the PR can never be talked
into removing anything else.

**Suppressing false positives**

These rules match on pattern text, so a file that legitimately *contains* the
patterns — your own malware scanner, a test fixture, a security write-up — will
be flagged. Two ways to silence it, both stateless:

A `.repoguardignore` file at the repo root, gitignore-style:

```
# repo-guard's rules match the patterns this scanner looks for
scripts/malware-scan.js
security/**/fixtures/*.js
*.test.js
/vendor/
```

Supports `*`, `**`, `?`, a leading `/` to anchor at the repo root, and a
trailing `/` for a whole directory. `#` starts a comment. Negation (`!pattern`)
is **not** supported.

Or an in-file marker:

```js
// repo-guard:ignore-file        — skip this entire file
// repo-guard:ignore-next-line   — skip findings on the following line
```

Two deliberate properties, because a suppression mechanism in a security tool is
itself an attack surface:

- **Suppression is counted, never hidden.** The scan report shows how many files
  and findings were suppressed and by which mechanism. A repo that suddenly
  suppresses 40 files is telling you something.
- **`.repoguardignore` is a sensitive push path.** Changing it raises a webhook
  alert exactly like `.gitignore` or `postcss.config.js` does, because anyone who
  can edit the ignore list can hide a payload from the scanner.

**Branch protection** — `/repos/{owner}/{repo}/branches/{branch}/protection`,
reported as three checks: protection rule present, PR reviews required (with
the required approval count), force-push blocked. Reading branch protection
requires **admin** on the repo; when you don't have it the row shows `?` and
says so, rather than reporting "unprotected".

## Remediation: the cleanup PR

When a scan flags a file, the expanded result has a **Remediation** panel. Tick
the files you want cleaned and it opens a pull request.

What it does:

- Re-reads each selected file from the branch server-side and **re-runs the
  rules there**. Line numbers that decide what gets deleted from your repo are
  never taken from the browser.
- Deletes **only** the lines a rule matched. Your real config survives — your
  actual Tailwind theme, ESLint rules, gitignore entries.
- Commits to a new `repo-guard/cleanup-<timestamp>` branch and opens a PR
  against the default branch. Nothing lands on your default branch without your
  review, and it works fine when branch protection blocks direct pushes.
- Pre-selects config files (`postcss.config.js`, `tailwind.config.*`, ESLint
  config, `.gitignore`, ...) and leaves ordinary source files unticked —
  deleting lines from application code is a much bigger claim than deleting them
  from a config.

When it refuses, and says so per file:

| Guard | Refuses when |
| --- | --- |
| minified | fewer than 3 lines — a single-line payload needs deleting, not editing |
| rewrite | stripping would remove more than 50% of the lines |
| empty | stripping would leave the file blank |
| stale | no rule matches the file any more |
| unbalanced | the edit would leave brackets unbalanced in a `.js/.jsx/.ts/.tsx/.mjs/.cjs/.json` file |

### Appended payloads and the `};` problem

This dropper appends its payload to the **end of an existing line**, usually
straight after the `};` that closes a config object:

```js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};global.i="A10-*870";const _0x499797=_0x1574;(function(...){while(!![]){try{...
```

Deleting that whole line would take the closing `};` with it and leave a file
that no longer parses. So a matched line is not simply deleted: if it has a
complete, fully-closed prefix before the match — every bracket balanced, ending
in `;` or `}` — the line is **cut at that boundary** instead, keeping the `};`
and dropping the payload. The scanner behind this (`src/lib/source-balance.ts`)
tracks strings, template literals and comments so a brace inside a string cannot
fool it.

It is not a JavaScript parser and does not pretend to be, which is why the
**unbalanced** guard above exists: if a file's brackets balanced before the edit
and do not after, the cleanup refuses rather than opening a PR that breaks your
build. A mis-read makes the tool decline; it cannot make it corrupt a file.

Capped at 25 files per PR. CRLF line endings and the presence or absence of a
trailing newline are preserved.

### What it explicitly does not do

- **It does not prove a file is clean.** It removes what the rules caught.
  Anything they missed is still in the file.
- **It only cleans the `.gitignore` entries it knows by name.** Lines naming the
  three dropper artifacts are stripped. Any *other* malicious `.gitignore` entry
  — hiding a file this list does not name — produces no finding and so no line
  to strip. A change to `.gitignore` always raises a push alert; read the diff
  yourself.
- **It is not remediation.** If the account that pushed the payload still has
  access and the machine is still infected, the files get re-infected on the
  next push. The order that actually works is: revoke the collaborator's access
  → have them rotate credentials and clean the machine → enable branch
  protection with force-pushes blocked → then clean the files. repo-guard shows
  you which repos still have force-push unblocked.

---

## Branch sweep

The repo scan only looks at the default branch. That is not where this payload
survives: it survives on **stale feature branches**, and comes back the moment
one of them is merged. Cleaning the default branch alone never sticks.

The **branches** button on each repo row sweeps them. For every branch it asks
GitHub to compare the branch against the default branch and scans only the
files that merging it would actually bring in — dropper artifacts and build
config first, then other in-scope changed files, capped at 20 per branch. That
is one compare request plus a handful of blobs per branch instead of a full
tree walk, so a repo with dozens of branches finishes inside the serverless
budget.

Each branch comes back as **infected** (with the offending file list and
error/warning counts), **clean**, **error** (usually no common history with the
default branch), or **skipped** (the sweep hit its 45-second budget — re-run to
finish). The default branch is listed but not swept, because it has nothing to
compare against; use Scan for that one.

### Deleting branches

Infected branches can be deleted from the panel — individually, or all at once.
Both are two-step: the first click arms the action, the second performs it, and
bulk deletion runs sequentially rather than firing off a burst of irreversible
requests.

Three things it will not do:

- **Never the default branch.** Refused in the API before any GitHub call is
  made, not just hidden in the UI.
- **Never a protected branch.** Protection is re-checked server-side at delete
  time rather than trusting the sweep result the browser is holding, which may
  be minutes stale.
- **Never rewrite history.** Deleting a branch removes the ref. If the payload
  already reached the default branch through a merge, the branch deletion does
  not undo that — scan the default branch and open a cleanup PR as well.

Branch deletion is permanent. GitHub keeps the commits reachable for a while
and support can sometimes restore a ref, but treat it as one-way.

---

## The local check

The repo scan only sees what is **committed**. The dropper also leaves files on
disk that a `.gitignore` is keeping untracked — invisible to any GitHub API.
The **local check** button in the toolbar covers that gap.

Give it an absolute folder path (it defaults to the server's working directory)
and it walks the tree, reporting:

- files named `branch_structure.json`, `temp_auto_push.bat` or
  `temp_interactive_push.bat`, with size and last-modified time
- every `.gitignore` line naming one of them, with line numbers

It skips `node_modules`, `.git`, `.next`, `dist`, `build`, `out`, `.cache`,
`.turbo`, `vendor`, `venv`, `__pycache__`, and does not follow symlinks. Limits:
depth 12, 60,000 entries, 25 seconds — and it says so explicitly when a limit
truncated the walk rather than implying full coverage. The only file contents it
ever reads are `.gitignore` files, capped at 256 KB.

Point it at the folder holding your checkouts (e.g. `C:\Users\you\projects`)
rather than at a whole drive.

### Why this endpoint is gated

It reads the filesystem of whatever machine the server runs on. That is right
for a local dev server and completely wrong for a deployment other people can
sign into, so:

- **hard-off when `VERCEL` is set**, whatever else is configured
- off when `NODE_ENV=production`
- on otherwise, and `ENABLE_LOCAL_SCAN=1` / `0` overrides either way

It also requires a signed-in session. A refused request returns 403 with no
filesystem data in the body.

---

## What the webhook does

`POST /api/webhook`:

1. Reads the **raw** body and verifies `X-Hub-Signature-256` as
   `sha256=HMAC-SHA256(body, GITHUB_WEBHOOK_SECRET)`, compared with
   `crypto.timingSafeEqual` (length checked first, since `timingSafeEqual`
   throws on unequal lengths and a digest's length isn't secret).
2. `ping` → `{ok, pong}`. Any event other than `push` → acknowledged and
   ignored.
3. `payload.forced === true` → **FORCE-PUSH DETECTED** alert with repo, ref,
   pusher, before/after SHAs and the compare URL.
4. Any commit in the push that added or modified `.gitignore`,
   `postcss.config.js`, `tailwind.config.{js,ts}`, `eslint.config.js`,
   `.eslintrc.js`, `.npmrc`, `.repoguardignore`, `branch_structure.json`,
   `temp_auto_push.bat` or `temp_interactive_push.bat` →
   **SENSITIVE CONFIG FILE CHANGED** alert, whether or not it was a force-push.

Both alerts can fire on the same push, and both go to the same
`ALERT_WEBHOOK_URL`.

---

## Design notes

Six color tokens, defined in `src/app/globals.css`:

```
--ink   #0a0d13   ground
--panel #10141c   raised surface
--text  #dde3ef   foreground
--err   #ef5f6b   ERROR / flagged
--warn  #e0a63c   WARNING / scanning
--ok    #4fb07a   clean / satisfied check
```

`--ink`, `--panel` and `--text` are three steps of one blue-slate hue; every
border and muted label is derived from them with `color-mix`, so the entire
neutral surface is a single hue and nothing in it competes for attention.
`--err`/`--warn`/`--ok` are the only saturated colors in the product and are
reserved exclusively for severity and scan state. There is no brand accent on
purpose: in a security tool, "this element is colored" has to mean "this element
has a status", or the encoding is worthless — so interactive affordance is
carried by `[ brackets ]`, hairline borders and brightness, the way a terminal
does it. The triad sits ~20% off full saturation so a screen full of ERROR rows
reads as dense rather than as vibrating neon.

Layout: repos are a vertical **commit ledger** — a 1px spine with one dot per
repo (grey unscanned, amber scanning, green clean, red flagged), not a grid of
stat cards. Findings render as **diff lines**: a 3px left border in the severity
color, a `-` gutter for errors and `!` for warnings, `path:line` in JetBrains
Mono, and the matched source line in a boxed excerpt. Inter carries labels and
prose; everything that is data — repo names, paths, SHAs, rule ids — is
monospace.

---

## Out of scope for v1 — stated honestly

These are real gaps, not oversights:

- **No persistent scan history.** There is no database, so nothing is stored
  between page loads. You cannot diff today's scan against last week's, see when
  a finding first appeared, or chart trend over time. Reloading the page clears
  every result. Adding history means adding a database (Postgres/KV) plus a
  per-user scan-results table — the single biggest change v2 would need.
- **No alert history either.** The webhook fires and forgets. If Discord/Slack
  is down, that alert is gone; there is no queue, no retry and no dead-letter.
  The only record is GitHub's own "Recent Deliveries" list and your Vercel logs.
- **No automatic scanning.** Scans run only when you click. There is no cron, no
  scan-on-push, no scan-all-repos button.
- **Regex rules are shallow and evadable.** No parsing, no AST, no data-flow, no
  entropy analysis. They catch the specific idioms described above; an attacker
  who reads this README can trivially write around all seven. Expect false
  positives too (`eval-of-dynamic-string` and the `_0x` density rule will both
  fire on some legitimate minified bundles). Treat findings as leads, not
  verdicts.
- **Default branch only.** Other branches, tags, PR refs and the reflog are not
  scanned — so a payload force-pushed to a feature branch is invisible to the
  scanner. It is *not* invisible to the webhook, which alerts on a force-push to
  any ref.
- **200 files, 500 KB, one branch.** Large repos are scanned partially. The UI
  says when the cap or a truncated tree limited coverage, but a partial scan
  returning "clean" means "clean in what it looked at".
- **No revert or rollback.** The cleanup PR is one-way; undoing it means
  closing the PR or reverting the merge on GitHub yourself.
- **No commit-signature or authorship verification.** repo-guard tells you a
  force-push happened; it does not verify who really made it. Requiring signed
  commits and enabling branch protection are the controls that actually *stop*
  this attack — repo-guard just reports whether you have them on.
- **No org/audit-log monitoring**, no dependency or lockfile-tampering checks,
  no secret scanning, no per-repo webhook management UI (webhooks are added by
  hand in GitHub settings).
- **Single-user UX.** Anyone who signs in sees their own repos; there are no
  teams, roles, or shared views.
- **No tests in the repo.** The rules, the webhook signature path and the alert
  payload shapes were exercised during development, but that harness isn't
  checked in.

If exactly one thing gets added in v2, it should be persistence — nearly every
gap above (history, dedup, retry, trend) is downstream of having a database.
#   D e t e c t o r  
 