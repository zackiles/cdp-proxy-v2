# RFC: The plugin platform

> Status: proposal for review; all fourteen of its decisions are settled (§16).
> Supersedes §7 of `v2-final-implementation-plan.md` and generalizes it. Nothing
> here changes what the automator writes: they still `import { chromium }`,
> still pass `plugins: [...]`, and still get back a stock Playwright `Browser` —
> with one exception, now settled: `plugins: []` means core-only rather than
> pass-through, and `plugins: 'none'` is the pass-through (§8.6).
>
> Reviewing as a plugin author rather than an architect? §9 is the practical
> guide — which kind to write, what the context gives you, how conflicts
> resolve, and how to test. Everything before it is the reasoning that produced
> it.

---

## 0. Why this RFC

### 0.1 What exists today

A plugin is exactly one thing: a per-connection CDP message interceptor.
`definePlugin` gives you `onRequest`/`onResponse`/`onEvent`, three lifecycle
hooks, and a `ctx` with `send`, `emit`, `inject`, and `state`. It is a good
substrate — `plugins/stealth.ts` defeats the `Runtime.enable` tell entirely
within it, with no privileged access — and it should not be replaced.

But it is the _only_ thing. Everything an author wants to do has to be expressed
as message interception, and most of what they want to do is a poor fit:

| What the author wants                       | What they must write today                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Present one coherent machine to the page    | Nothing. Every plugin invents its own values and nothing checks they agree.                                      |
| Add `--proxy-server=…` or load an extension | Nothing. There is no hook. Flags are frozen in `constants.ts`.                                                   |
| Spoof the WebGL vendor string               | `onTargetAttached` → `ctx.inject` a hand-escaped JS string, and hope no iframe or worker asks the same question. |
| Solve a captcha                             | `onDocument` + fire-and-forget async, hand-rolled per-page state, careful not to block the message queue.        |
| Suppress a CDP command                      | `onRequest`. This one fits.                                                                                      |

The gap is not a missing hook. It is that one abstraction is being asked to
cover five different attachment points.

### 0.2 What the evidence says

`../corsac` is the previous attempt at the same product. It got the ambition
right — 14 evasions across navigator, canvas, WebGL, fonts, `window.chrome`,
performance, workers, randomness, dates, error stacks, WebSocket, iframes — and
it is worth reading for the specific patches. Five things it got wrong are
directly instructive, and this RFC is shaped by them. §13.2 gives the per-file
verdict on all fourteen.

1. **Nothing enforced coherence.** Each evasion invented its own values. A
   session could claim macOS in the User-Agent and `Google Inc. (NVIDIA)` in
   WebGL. Disagreement between surfaces is a louder signal than any single
   surface being wrong, and no per-plugin API can prevent it. This is the
   failure that §2 exists to make structurally impossible.

2. **Injection was a per-project invention that nothing consumed.** Evasions
   were plain functions serialized with `Function.prototype.toString()` and
   concatenated into one IIFE by `createStealthScript()` — a reasonable
   mechanism, built beside the runtime rather than inside it. The bundle was
   then never wired to the CDP injection path at all: `src/bridge/` injects its
   own agent and nothing else. Injection has to be a _runtime service_ the
   pipeline owns, not an artifact the plugin layer produces and hopes someone
   delivers.

3. **A category tree that is load-bearing does not survive contact.** Evasions
   were filed under ten folders (`language/`, `runtime/`, `document/`,
   `network/`, `drawing/`, `styling/`, `media/`, `security/`, `storage/`,
   `hardware/`), and the category was not just a folder — `API_CATEGORIES` was
   an enum the config and the loader both read, so a plugin's category was part
   of its identity. The tree immediately produced `language/math.ts` _and_
   `runtime/math.ts` — the same patch, in two places, because `Math` is
   plausibly either. `navigator` landed in `document/` while `window` landed in
   `runtime/`, which is a coin flip. §10 keeps the folders and removes what made
   them dangerous: here a path is inert, the plugin's identity is its `name`,
   and a duplicated subject is a startup error rather than two files nobody
   reconciles.

4. **Three config schemas disagreed.** `config.jsonc` was flat, `config.ts` was
   category-shaped, and the loader read a third shape, so `loadEvasions()`
   likely loaded nothing. Config has to be typed against the thing that consumes
   it, which this codebase already does correctly via `definePlugin<Options>`.

5. **Spoofed values were not stable.** `performance.now()` returned real time
   plus a fresh `Math.random() * 0.01` on every call, and the canvas noise seed
   was derived from the current hour. A value that changes between two reads on
   one machine is a stronger signal than the value it was hiding, and it is a
   mistake that only looks like caution. §2.10 makes the stable path the easy
   one.

Corsac's `docs/globalthis-vs-window.md` also identifies, and never solves, the
problem that a patch applied to `window` is trivially bypassed by asking the
same question from a worker or an iframe. §7.1 solves it once for everyone.

### 0.3 The thesis

**Five kinds of plugin, one runtime.** An author picks the kind that matches
where their work attaches. Two of the kinds run before the browser process
exists; the other three compile down to the CDP pipeline that already works. The
automator never learns the kinds — they pass one flat array and the runtime
sorts it out.

Three of those kinds have a member that is not optional — the `Runtime.enable`
defeat, the baseline launch flags, and the terminal profile loader. Those form a
**core tier** (§8) that is always installed, owned by the platform, and not
something an author writes or edits.

And one rule that everything else serves:

> **No plugin owns a value.** A plugin owns a _mechanism_ — how a claim is made,
> to the page or to the process. The claim itself always comes from the profile
> (§2). This is what makes changing the persona a one-line change instead of an
> audit of twenty plugins.

---

## 1. The kinds

### 1.1 How the kinds were chosen

The axis is not "what does it do" — that is unbounded and produces corsac's
category tree. The axis is **when does it attach, and what does it hold**,
because that is what determines the API it can be given.

| Kind       | Attaches                   | Holds                     | Lifetime        | Sees CDP          |
| ---------- | -------------------------- | ------------------------- | --------------- | ----------------- |
| `profile`  | before anything            | the machine's identity    | the browser run | no — none exists  |
| `launch`   | before the browser process | the process configuration | the process     | no — none exists  |
| `protocol` | at client connect          | the wire                  | the connection  | all of it         |
| `surface`  | at every document          | one browser API           | the document    | via the runtime   |
| `actor`    | at every page              | page behaviour            | the page        | via a page handle |

Three of those boundaries are forced and two are chosen:

- **`profile` is forced.** Half of what a machine's identity consists of is
  decided by launch flags (§2.1), so the identity has to be resolved before the
  flags are computed, which is before anything else in the system exists.
- **`launch` is forced.** Before the process exists there is no socket, no
  session, no target. A flag cannot be a CDP hook.
- **`protocol` is forced.** Suppressing `Runtime.enable` before it reaches
  Chrome can only be done on the wire. Nothing above the wire can express it.
- **`surface` and `actor` are chosen.** Both are expressible as `protocol`
  plugins. They exist as separate kinds because when everyone writes `protocol`
  plugins you get corsac: fourteen patches with no delivery mechanism between
  them, no agreement on values, and nothing that works in a worker. Neither is a
  walled garden: both keep a scoped route back down to raw CDP for the cases the
  kind does not cover (§4.2, §6.4).

**On the name `actor`.** It is the thing that acts on a page, as against a
`surface`, which is a thing the page reads. `agent` was the earlier name and was
dropped for two collisions: the browser's own _user agent_ — a `profile` group
in §2.1 and the single most important field in the system — and the now
unavoidable reading of "agent" as an LLM. `page` was rejected because every kind
from `protocol` down attaches to pages; it names the location rather than the
job.

### 1.2 Two phases, one runtime

```
pre-socket                          on-wire
──────────                          ───────
profile  ──▶ draw the identity
                   │
launch   ──▶ flags, env, extensions
                   │
             browser starts
                   │
             reconcile + seal the profile (§2.6)
                   │
                   ▼
protocol ──▶ Pipeline hooks                       (unchanged)
surface  ──▶ Pipeline hooks + realm injection + Emulation.*
actor    ──▶ onTargetAttached + an off-queue scheduler
```

A kind belongs on this list if it either runs before the socket exists or
compiles to the pipeline. `profile` and `launch` are the first case; the other
three are the second. Anything that fits neither is not a kind.

The compilation property matters for maintenance more than for elegance. One
pipeline means one ordering model, one error-isolation story, one `CDP_DEBUG`
trace format, and one place where a bug in dispatch can live. A `surface` plugin
that misbehaves shows up in `Proxy.debug` next to `stealth`, described in the
same terms.

### 1.3 Kinds are an authoring concern

The automator writes one array of mixed kinds and never says which is which:

```ts
const browser = await chromium.launch({
  profile: { os: 'Windows', locale: 'en-US' }, // a constraint, not a value
  plugins: [
    corpus({ path: './fingerprints.jsonl' }), // profile
    stealth(), // a preset — expands to many
    proxy({ url: 'http://user:pw@host:8080' }), // launch
    webgl(), // surface
    captcha({ solver: '2captcha', key: KEY }), // actor
  ],
})
```

The runtime partitions by kind, resolves each partition in phase order, and
installs. Because kind is a property of the plugin and not of the call site,
adding a sixth kind later would not change a single automator's line.

---

## 2. `profile` — the machine's identity

The first kind to run and the one every other kind reads from. This is the
answer to corsac's §0.2.1 failure, and it is the piece that makes a change of
persona cost one line instead of an audit.

### 2.1 What a profile is

A profile is **a claim about one machine**: resolved once per browser run,
immutable for the life of that run, and readable by all five kinds. It is not a
bag of independent values. It is one coherent row.

| Group    | Fields                                                   | Read by                                       |
| -------- | -------------------------------------------------------- | --------------------------------------------- |
| identity | `id`, `seed`, `schema`, `source`                         | runtime                                       |
| platform | `os`, `osVersion`, `arch`, `chrome`                      | `launch`, `surface/navigator`, headers        |
| agent    | `userAgent`, `brands`                                    | `surface/navigator`, headers                  |
| locale   | `languages`, `locale`, `timezone`, `geo?`                | `launch` (`--lang`, `TZ`), `surface/timezone` |
| display  | `screen`, `viewport`, `chromeHeight`                     | `launch` (`--window-size`), `surface/screen`  |
| hardware | `hardware.cores`, `hardware.memory`, `hardware.touch`    | `surface/hardware`                            |
| gpu      | `gpu.vendor`, `gpu.renderer`, `gpu.angle`, `gpu.params?` | `launch` (`--use-gl`), `surface/webgl`        |
| fonts    | `fonts?`                                                 | `surface/fonts`                               |
| media    | `media?`                                                 | `surface/media`, `surface/audio`              |

The important structural fact is in the third column: **several fields are read
by `launch`, not by a surface.** Window size determines the real `outerWidth`;
`TZ` sets the process's real timezone; `--use-gl` and the ANGLE backend
determine the _actual_ renderer string and the real values `getParameter`
returns.

That is the whole reason `profile` has to be its own kind rather than a service
the pipeline provides: the best fingerprint fields are the ones you never have
to lie about in JavaScript, and claiming them requires having decided the
persona before the process starts. §9.1 works one field all the way through.

**Profile is a kind, and that is settled (§16.1).** The alternative considered
was a runtime service with a pluggable strategy — a `ProfileSource` interface
registered separately from `plugins`. It was rejected on three grounds. Profile
resolution has a distinct attachment point on the same axis as every other kind,
which is the axis §1.1 uses; loaders compose by `priority` and first-non-answer
exactly as other kinds compose, so a service would reimplement an ordering model
that already exists; and it would mean a second registration mechanism, a second
place to look in the trace, and a second set of failure semantics for the one
thing every other kind reads from. The cost of the decision is one more kind for
an author to learn, which §15 addresses by making all five uniform rather than
by making one of them special.

### 2.2 Why loaders, and why loaders are plugins

Where a profile comes from is exactly the kind of thing that differs per
deployment and not per codebase:

- Local development wants **one pinned profile**, so a run is reproducible and a
  failing page can be re-opened tomorrow with the same identity.
- CI wants the same, for the same reason.
- Production wants to **draw from a corpus** of captured real fingerprints,
  weighted to the geography it is targeting.
- A large fleet wants to **ask a service**, which can track which identities
  have been burned on which sites and stop handing them out.
- Headful local debugging often wants **the real host machine**, which is the
  only perfectly coherent profile that exists.

Same interface, different policy, chosen at the call site. That is a plugin.

```ts
export const corpus: PluginFactory<CorpusOptions> = definePlugin<CorpusOptions>(
  {
    kind: 'profile',
    name: 'corpus',
    priority: 50,
    async setup(cfg, ctx) {
      const rows = await read(cfg.path)
      return {
        draw(constraint) {
          const candidates = rows.filter((row) => satisfies(row, constraint))
          if (candidates.length === 0) return undefined
          // Weighted by observed prevalence, never uniformly — see §2.5.
          return sample(candidates, ctx.random)
        },
      }
    },
  },
)
```

`draw` returns a profile or `undefined`, and `undefined` means "I cannot satisfy
this constraint". The runtime walks loaders in priority order until one answers,
which makes composition fall out for free:

```ts
plugins: ;
;[
  pin({ id: Deno.env.get('CDP_PROFILE') }), // 100 — answers only when set
  corpus({ path: './fingerprints.jsonl' }), // 50  — answers when it has a match
]
```

The chain always ends in `generate`, which can satisfy any constraint. It is not
written above because nobody writes it: it is a core plugin (§8.3), pinned last,
so a loader chain can never fail to answer no matter what an automator passes.

### 2.3 The loaders that ship

| Loader     | Draws from                                 | Use                                                                        |
| ---------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| `generate` | Weighted joint distributions in code       | The default and the terminal loader. Tables from public aggregates (§2.5). |
| `corpus`   | A JSONL file of captured real fingerprints | The opt-in upgrade. The highest-fidelity source (§2.5).                    |
| `pin`      | One fixed profile, by id                   | Debugging, tests, and reproducing a failure.                               |
| `host`     | The actual host machine                    | Headful local. Coherent by construction — nothing is a lie.                |
| `remote`   | An HTTP service                            | Fleets that need burn tracking across processes.                           |

**`host` is never a default, including for headful local runs (§16.1).** It is
tempting: it is the only perfectly coherent profile that exists, because nothing
about it is a claim. It is rejected as a default for one reason, and the reason
outweighs the fidelity — it makes local behaviour differ from production in the
one dimension the whole platform is about. A surface that stands down locally
because the host happens to have the field, or a coherence bug that only appears
when the profile is drawn rather than read, is a bug that reaches production
having passed every local run. Local and CI therefore draw the same way
production does.

> IMPORTANT: `host` is worth reaching for deliberately, and the case is narrow.
> When a page behaves differently under the platform than in your own Chrome and
> you need to know whether the profile is the cause, `plugins: [host()]` removes
> every claim in one step. If the behaviour persists, the profile was not the
> problem. This belongs in the debugging guide, not in any default.

### 2.4 Constraints, not patches

This is the rule that makes coherence structural rather than aspirational.

```ts
chromium.launch({ profile: { os: 'Windows', minChrome: 140 } })
```

That is **a query against the loaders**, not an override of a drawn profile. The
loader returns a whole coherent row satisfying it, or the next loader tries.

> DANGER: a `Profile` is deeply frozen the moment it is sealed. There is no way
> to change one field of a drawn profile, and this is deliberate. Patching `os`
> to `'Windows'` on a row drawn from macOS is exactly how corsac ended up
> claiming an Apple GPU on a Windows User-Agent. If you want a variant, draw
> again with a tighter constraint.

The corollary is the answer to "a UA change impacts many plugins": it does not,
because no plugin holds a UA. Changing the persona is a change to the constraint
or the loader, and every surface follows because every surface reads.

### 2.5 Coherence and rarity are different requirements

Both are required and they are routinely confused.

**Coherence** means the fields describe one machine. Sampling each axis
independently produces machines that do not exist — `Chrome/147` on `Windows`
reporting `ANGLE (Apple, Apple M2, OpenGL 4.1)`. Only whole-row sampling
guarantees coherence, which is why `corpus` is the higher-fidelity loader.
`generate` must therefore sample **conditionally**, not independently: draw an
OS, then a GPU family conditioned on that OS, then a renderer string conditioned
on that family, then a font list conditioned on the OS version.

**Rarity** means the machine is not interesting. A perfectly coherent but
globally unique configuration has an anonymity set of one and is trivially
trackable across sessions without any cookie at all. Draws must therefore be
weighted by real-world prevalence, never uniform. `generate` ships weighted
tables rather than ranges for this reason, and a `corpus` row carries a
`weight`.

**Where those weights come from is settled (§16.1), and it sets the ceiling on
how good `generate` can be.** The tables are built from public aggregate data:
the Steam Hardware Survey for GPU model, display resolution and core counts,
StatCounter for OS and browser-version share, and the Chromium release schedule
for which versions are plausibly alive on a given date. ANGLE renderer strings
are then mechanical —
`ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0
ps_5_0, D3D11)` is a
template with a slot for a model name.

> DANGER: Steam's population is gamers. Its GPU shares over-represent discrete
> NVIDIA cards by a wide margin against a web population that is mostly
> integrated Intel and AMD laptop graphics. Copying Steam shares unadjusted
> yields a fleet where every row is individually plausible and the fleet as a
> whole matches no real population — a rarity failure at the aggregate level,
> which is the harder one to notice. Re-weight before use, and record the
> re-weighting next to the tables so the next person can check it.

The known ceiling on this approach is that hand-written tables encode only the
correlations someone thought to write down. The upgrade is to train a model on
captured data and ship the trained model rather than the rows — real-data
fidelity, no machine redistributed, no mandatory data file — and §16.1 records
why that is the destination rather than the starting point.

> IMPORTANT: a common machine is a better disguise than an interesting one. The
> instinct to maximize variety across sessions is wrong past the point where the
> variety itself becomes the signal.

### 2.6 Resolve, launch, reconcile, seal

```
draw(constraint)            → a candidate profile
  ↓
launch plugins read it      → flags, env, window size, TZ, --use-gl
  ↓
browser starts
  ↓
reconcile                   → correct the candidate against what actually exists
  ↓
seal                        → deep freeze, publish to every kind
```

Reconciliation exists because some fields can only be known after the binary is
running, and getting them wrong is directly detectable.

The clearest case is the Chrome version. A page can feature-detect: if the
profile claims Chrome 148 and the binary is 147, an API that shipped in 148 is
missing and the claim is caught in one line. **The profile's Chrome version must
be the binary's Chrome version**, which no loader can know. `plugins/stealth.ts`
already does a miniature version of this today — `resolveUa()` calls
`Browser.getVersion` and rewrites `HeadlessChrome` — and reconciliation
generalizes it.

The same applies to any launch flag the process did not honour: a window size
clamped by the display, an ANGLE backend that fell back, or `--lang`, which
Chrome honours on Linux and largely ignores on macOS in favour of the system
locale. Reconciliation is what turns that platform difference from a silent
incoherence into a corrected field.

> IMPORTANT: reconciliation only ever moves the profile _toward_ what the
> process actually is. It never moves the process toward the profile. A profile
> that disagrees with its own browser is worse than no profile, because every
> surface will then confidently assert the disagreement.

After sealing, the profile is immutable and its `id` is stable for the run.

### 2.7 Rotation, reuse, and the pool

Because half a profile is launch flags (§2.1), **a profile is bound to a browser
process**. That is settled (§16.1), and the binding is not a convenience: the
alternative is a session claiming a window size and a locale the process it is
running on was not launched with, which is precisely the disagreement between
two independently correct components that the profile exists to prevent. It has
three consequences, and they are the practical shape of "a handful of unique
fingerprints per browser run".

**The pool is keyed by profile.** `BrowserPool` slots each carry the profile
their process was launched with. Pool configuration grows one field:

```ts
new Proxy({ poolSize: 8, profiles: 4 })
```

Four identities, eight processes, sessions round-robined onto a process whose
profile satisfies their constraint. A session whose constraint no slot satisfies
gets a process of its own, exactly as `isolation: 'browser'` already does.

> **`profiles` defaults to `poolSize`** — one identity per slot (§16.1). The
> default therefore never correlates two sessions that did not ask to be
> correlated, which is the right way round for a failure that is silent: a fleet
> with more identities than it needed costs nothing, and a fleet with fewer has
> been quietly linking sessions since the day it was configured. Setting
> `profiles` below `poolSize` is a deliberate choice to run a narrower anonymity
> set, which is occasionally what a deployment wants — a small number of
> plausible personas can be less interesting than a large number of unique ones
> (§2.5) — and the trace names the slot and profile each session landed on so
> the sharing is visible rather than assumed.

**Sessions sharing a process share an identity.** Two sessions on the same slot
present the same machine to the page — including the same canvas hash, since
`noise` is profile-seeded (§2.10). That is correct if they are meant to be one
person and wrong if they are meant to be two. The existing
`isolation: 'browser'` flag is already the way to say "must not be correlated",
so the rule is: **`profiles` sets how many identities the fleet has;
`isolation: 'browser'` guarantees one to yourself.** Both are documented on the
automator surface, because getting it backwards is a silent correlation bug.

**A persona is a profile plus its storage.** Reusing a `userDataDir` from a
previous run under a _newly drawn_ profile is worse than either mistake alone:
the site sees returning cookies from a machine that has changed its GPU. The
runtime therefore pairs them — a `launch` plugin that pins `userDataDir` must
pin the profile `id` too, the pool records which profile a data dir was created
under, and a mismatch is refused at registration.

**Burn.** A profile that got blocked should stop being handed out.
`ProfileHooks.burn(id, reason)` tells a stateful loader; `remote` persists it,
`corpus` drops the row for the process lifetime, `generate` ignores it.

### 2.8 Coverage — the fields nobody owns

Each kind receives its own view of the sealed profile, and that view records
reads. At session start the runtime reports what it saw:

```
trace: [0c349e67] profile 8f2c source=corpus Windows 11 / Chrome 147 / en-US / America/New_York
trace: [0c349e67]   navigator  reads userAgent brands os osVersion
trace: [0c349e67]   screen     reads screen viewport chromeHeight
trace: [0c349e67]   webgl      reads gpu
trace: [0c349e67]   proxy      reads geo timezone
trace: [0c349e67]   uncovered  fonts hardware.memory media
```

**The `uncovered` line is the point.** A profile field that nothing read is a
field where the real browser's value reaches the page unmodified, contradicting
everything the profile does claim. Today, discovering you forgot a fonts surface
requires a detector to tell you. This turns it into a line in the trace and an
assertion in a test.

The asymmetry is worth stating plainly: **unread is definitely uncovered; read
is only probably covered.** A surface that reads `gpu` and then installs a
broken patch still reports as covering it. Coverage catches the omissions, which
are the common failure, and does not catch the mistakes.

Exposed as `Proxy.profile` so tests can assert on it rather than scraping logs.

### 2.9 A missing field stands down

The profile schema grows as surfaces are added. A corpus row captured six months
ago has no `media` field because there was no media surface when it was written.

> IMPORTANT: a missing field is **absent, not defaulted**. `profile.media` is
> `undefined`, and `surface/media.ts` sees that and installs nothing, leaving
> the real values in place. A defaulted field is an incoherent field, and an
> incoherent field is worse than an unmodified one.

This is why the optional fields in the `Profile` type (§11) are optional: the
`?` _is_ the mechanism. A surface guards on its field, and the runtime reports
the stand-down alongside coverage:

```
trace: [0c349e67]   media      stood down: profile has no media (schema 3 < 5)
```

### 2.10 `noise`

Canvas, audio, and WebGL readback evasions add per-pixel or per-sample jitter,
and the reflex is to randomize per call. That is worse than not spoofing at all:
a real browser returns a _stable_ hash, so a page that reads the canvas twice
and gets two answers has caught you with one line of JavaScript.

`noise(key)` returns a deterministic value in `[0, 1)` derived from
`profile.seed`. It is stable for the life of the profile, which means stable
across reloads, stable across pages, and — when the profile is pinned — stable
across runs. It is available to page functions without importing it (§4.1).

---

## 3. `launch` — the browser process

Runs second, after the profile is drawn and before the process starts.
Contributes to how the process starts and can observe the process it produced.

```ts
export const proxy: PluginFactory<ProxyOptions> = definePlugin<ProxyOptions>({
  kind: 'launch',
  name: 'proxy',
  setup(cfg, ctx) {
    const { host, username, password } = new URL(cfg.url)
    return {
      flags: [
        `--proxy-server=${host}`,
        // The profile decided the persona; this plugin only carries it through.
        `--lang=${ctx.profile.locale}`,
      ],
      // Credentials never belong on a command line; the pair is handed to the
      // Fetch broker (§7.2), which answers Fetch.authRequired.
      auth: username ? { username, password } : undefined,
    }
  },
})
```

### 3.1 Contributions

| Field         | Type                     | Merge policy                                                       |
| ------------- | ------------------------ | ------------------------------------------------------------------ |
| `flags`       | `string[]`               | By flag name. Later plugin wins, with a warning naming both.       |
| `env`         | `Record<string, string>` | By key. Later wins, with a warning.                                |
| `extensions`  | `string[]`               | Concatenated. Directories become one `--load-extension=a,b`.       |
| `userDataDir` | `string`                 | **Exclusive.** Two plugins claiming it is an error, not last-wins. |
| `auth`        | `{ username, password }` | **Exclusive.** Handed to the Fetch broker.                         |

`constants.ts` already documents a three-tier flag model — default, reserved,
user-configurable — but only the first tier exists in code. This makes the other
two real:

- **Reserved** flags are the ones the proxy and `chrome-launcher` need to keep
  control of the process: `--remote-debugging-port`,
  `--remote-debugging-address`, `--user-data-dir`, `--headless`. These stay with
  the runtime, and a `launch` plugin that returns one **throws at
  registration**, not at launch, so the automator finds out before the browser
  starts rather than by debugging a browser that never connects.
- **Default** flags become the core `flags` plugin (§8.3), pinned first, so an
  authored plugin overrides a baseline flag by the same last-wins rule as any
  other conflict rather than by a second mechanism.

> DANGER: `--enable-automation` and `--disable-gpu` are deliberately absent from
> the defaults, for reasons documented in `constants.ts`. A `launch` plugin can
> add them and would silently defeat stealth. Both are on a **warn list**: not
> refused, but logged loudly with the reason.

### 3.2 Observing the process

```ts
onStart(browser) // { pid, host, port, userDataDir, flags, executablePath }
onStop(browser)
```

`onStart` runs before reconciliation (§2.6) and is where a plugin verifies its
own contribution took effect — reading back `Browser.getBrowserCommandLine`,
checking an extension actually loaded, confirming the window size was not
clamped. What it reports feeds the reconciliation pass.

### 3.3 The isolation consequence

**A session that includes any `launch` plugin, or that constrains its profile in
a way no pool slot satisfies, gets a browser process of its own.**

Flags are per-process; plugin sets and constraints are per-session; a pooled
browser is shared. There is no honest way to give session A `--proxy-server=X`
on a process session B is also using. Rather than silently applying one
session's flags to another's traffic, the runtime promotes the session to
`isolation: 'browser'` and logs the promotion with the cause.

The pool already supports this: `BrowserPool.reserve(token)` launches a
dedicated process at registration time. It grows two parameters — the resolved
launch contribution and the profile — and nothing else. Shared pool slots launch
from a **baseline** launch set and the `profiles: N` draw (§2.7), which is how a
standalone server applies a fleet-wide proxy without a process per session.

The cost is real and belongs in the automator docs: a `launch` plugin costs you
a browser process per session.

---

## 4. `surface` — one browser API

The declarative kind, and the one most authors will write. A surface plugin owns
exactly one browser-visible API and says what that API should report — using
values it reads from the profile, never values of its own.

```ts
export const webgl: PluginFactory<WebglOptions> = definePlugin<WebglOptions>({
  kind: 'surface',
  name: 'webgl',
  setup(_cfg, ctx) {
    // Stand down rather than invent: §2.9.
    if (!ctx.profile.gpu) return {}
    return {
      config: ctx.profile.gpu,
      page({ vendor, renderer }) {
        const get = WebGLRenderingContext.prototype.getParameter
        const patch = function (this: WebGLRenderingContext, p: number) {
          if (p === 0x9245) return vendor // UNMASKED_VENDOR_WEBGL
          if (p === 0x9246) return renderer // UNMASKED_RENDERER_WEBGL
          return get.call(this, p)
        }
        WebGLRenderingContext.prototype.getParameter = patch
        WebGL2RenderingContext.prototype.getParameter = patch
        native(patch, 'getParameter')
      },
    }
  },
})
```

Note what the options are _not_ used for. `WebglOptions` exists for mechanism
knobs — whether to patch WebGL2, how to handle `getExtension` — and not for the
vendor string. The vendor string is a claim about the machine, so it comes from
the profile. §9.3 gives the general rule.

### 4.1 The page function is a function

Not a string. It is typechecked, formatted, linted, and refactorable like any
other code, and the editor knows `WebGLRenderingContext`. The runtime serializes
it with `Function.prototype.toString()` and calls it with `config` as JSON.

**`toString()` rather than a bundler, and that is settled (§16.1).** The reason
is §4.5: whatever reaches the page runs in the main world, and a bundler emits
its own scaffolding — interop helpers, `__esModule` markers, occasionally a
source-map comment — all of which would be running there too. Serialization
means the injected payload contains only what an author wrote, which a reviewer
can read in full.

That buys the audit and costs one rule, and it is the kind of rule that costs an
afternoon the first time it is broken:

> DANGER: the page function is serialized, so it cannot close over anything.
> Module imports, `cfg`, `ctx`, and any outer variable are all `undefined` at
> run time — with no error, because the reference simply does not resolve in the
> page. Everything the function needs comes in through its single `config`
> argument, which must be JSON-serializable. The compiler cannot catch this;
> `deno task lint` will, via a rule that rejects free identifiers in a `page`
> function that are not globals, helpers, or its parameter.

The lint rule is not a nicety attached to the decision — it is the half that
makes the decision survivable, because the failure it catches is silent. A
captured reference does not throw; the patch simply does half its job and the
surface reports success. The rule walks each `page` function's AST in CI and
rejects any identifier that is not a browser global, a prepended helper, or the
function's own `config` parameter, and §9.8 serializes every bundled surface's
page function in a test so the constraint is enforced from two directions.

A small set of helpers is available inside the function without importing them —
`native(fn, name)` to make a patched function's `toString()` lie correctly,
`define(obj, key, value)` for a non-enumerable descriptor matching the original,
and `noise(key)` for profile-stable jitter (§2.10). The runtime prepends them to
the bundle once, not once per plugin.

**This set is the answer to "but surfaces need to share code", and it is a
position rather than a concession.** Shared page-side logic grows the helper
set, deliberately and under review, instead of arriving through arbitrary
imports. A helper good enough for two surfaces is good enough to be platform
API, and one that is not worth reviewing is not worth injecting into every
document.

The known limit is a surface that needs a third-party library in the page — a
WASM decoder behind an audio surface is the plausible case — which no amount of
helper curation covers. That is the case that would force a bundler, and §16.1
records what auditing its output would then require.

Reading a value back out of the page is `ctx.send('Runtime.evaluate', …)` from
`emulate`, in the same world. There is no callback channel out of a page
function, for the reason `plugin-developer.md` documents at length: a
`Runtime.addBinding` channel either announces the session or is quietly broken.

### 4.2 Prefer `emulate` to `page`

A patch written in JavaScript is, by construction, visible to JavaScript. Where
Chrome can make the change below the JS layer, that is strictly better, and the
runtime asks for it first:

```ts
emulate(realm) {
  return realm.send('Emulation.setTimezoneOverride', {
    timezoneId: ctx.profile.timezone,
  })
}
```

`Emulation.setUserAgentOverride`, `setTimezoneOverride`, `setLocaleOverride`,
`setGeolocationOverride`, `setHardwareConcurrencyOverride`, and
`setDeviceMetricsOverride` between them cover a large fraction of what authors
reach for a page patch to do, and none of them leave a patched function on a
prototype. **A surface plugin should reach for `page` only for what
`Emulation.*` cannot express.** The bundled surfaces model this: `timezone` and
`languages` are pure `emulate` and headers, and inject nothing at all.

The ordering with `launch` matters too, and it generalizes into the rule that
organizes the whole platform:

> **A launch flag beats an `Emulation.*` override, which beats a page patch.**
> Each rung down is more visible to the page than the one above it. Take the
> highest rung the field can be claimed on. §9.1 works an example through all
> three.

### 4.3 Headers

```ts
headers: { 'Accept-Language': ctx.profile.languages.join(',') }
```

Applied through the Fetch broker (§7.2) rather than by the plugin calling
`Fetch.enable` itself, so two surfaces contributing headers compose instead of
clobbering each other.

### 4.4 Realms

By default a surface applies to **every realm**: the main frame, every subframe,
dedicated workers, and service workers. This is the point of the kind. Authors
write `globalThis`, not `window`, and the runtime handles delivery (§7.1).

Opt out when the surface is meaningless elsewhere:

```ts
realms: ;
;['page', 'iframe'] // DOM-only; a worker has no document
```

### 4.5 Main world, and why

`ctx.inject` defaults to an isolated world and `plugin-developer.md` tells
authors to keep it that way. Surface plugins are the exception: you cannot patch
`WebGLRenderingContext.prototype` from a world the page cannot see, because it
is not the page's prototype. Surface page functions therefore run in the **main
world**, first, before any page script.

That is a real exposure and the RFC should not pretend otherwise. It is
mitigated, not eliminated: `native()` fixes the `toString()` tell, descriptors
are installed to match the originals, and the injected bundle defines no globals
of its own. A determined detector comparing prototype identity across realms can
still find evidence. This is the strongest argument for §4.2's ladder — every
field moved up a rung is a field with less JavaScript exposure.

---

## 5. `protocol` — the wire

Unchanged from what exists today, except that the definition now names its kind.
The hooks, `RequestOutcome` semantics, `match`, `priority`, `optional`, and the
whole of `PluginContext` are exactly as documented in `plugin-developer.md`,
plus `ctx.profile`. An existing plugin becomes a `protocol` plugin by adding one
line:

```ts
export const recorder: PluginFactory<RecorderOptions> = definePlugin<
  RecorderOptions
>({
  kind: 'protocol',
  name: 'recorder',
  setup(cfg, ctx) {
    return {
      onRequest(msg) {
        ctx.log(msg.method)
      },
    }
  },
})
```

`kind: 'protocol'` is the only edit. There is no `defineProtocol`, because
`definePlugin` constructs every kind and `kind` selects which one (§16.1) — the
word "plugin" stays the general term and `protocol` stays one value of a field.

The kind's flagship, `contexts`, is a core plugin rather than an authored one
(§8.3) — but it is written against exactly this API, with no privileged access,
which is the standing proof that the kind is expressive enough.

Reach for it when the work is genuinely about the protocol:

- Suppressing, answering, or rewriting a CDP command.
- Observing traffic (`recorder`).
- Synthesizing events the browser never sent.
- Anything requiring the client's view of the wire to differ from the browser's.

Everything else should be a higher kind. A `protocol` plugin that only injects a
script is a `surface` plugin someone wrote in the wrong place, and it will be
missing worker coverage, profile coherence, and coverage reporting as a result.

---

## 6. `actor` — behaviour on a page

The imperative kind: watch a page, decide, act. Captchas, cookie banners, login
flows, human-plausible scrolling.

```ts
export const captcha: PluginFactory<CaptchaOptions> = definePlugin<
  CaptchaOptions
>({
  kind: 'actor',
  name: 'captcha',
  urls: ['https://*'],
  async setup(cfg, page) {
    page.on('document', async () => {
      if (!await page.has('iframe[src*="recaptcha"]')) return
      page.log('challenge detected')
      const token = await solve(cfg, await page.eval(() => location.href))
      await page.eval((t) => {
        grecaptcha.callback(t)
      }, token)
    })
  },
})
```

### 6.1 What makes it a distinct kind

`actor` is a kind rather than a library over `protocol`, and that is settled
(§16.1). The distinction is not stylistic: all three properties below are
_runtime_ properties, and a library cannot provide any of them because they are
decisions about instantiation and scheduling that only the thing doing the
instantiating and scheduling can make.

**Its lifetime is one page.** `setup` runs per page target and its closure is
that page's state; the runtime drops it on detach. No `ctx.state`, no map keyed
by session id, no pruning.

**It is off the message queue.** Every `protocol` hook runs inside the message
path, which is why `plugin-developer.md` has to warn that a slow hook is latency
and an await on another event is a deadlock. An actor's callbacks are scheduled
on their own task per page. It can await freely, call an external solver over
HTTP for ten seconds, and the page's CDP traffic keeps flowing.

**It gets a page handle, not a session id.** `page.click('#submit')` instead of
`ctx.send('Input.dispatchMouseEvent', { … }, sessionId)` three times with
coordinates it had to compute.

A library over `protocol` could offer the third of those as helper functions. It
could not offer the first two, because a `protocol` plugin is instantiated once
per connection and its hooks run on the message path by definition. Anything
claiming otherwise would be reimplementing per-page instantiation and a
scheduler inside a plugin — which is the runtime's job, done once, badly.

### 6.2 The handle is deliberately small

`PageContext` is `url`, `target`, `profile`, `signal`, `eval`, `has`, `wait`,
`click`, `fill`, `goto`, `on`, `log`, plus the two escape-hatch members `send`
and `cdp` (§6.4). It is not a second Playwright and will not grow into one.

`click` and `fill` go through the `Input` domain, which produces events the page
cannot distinguish from a user's. A JS `element.click()` produces an event with
`isTrusted: false` and is a well-known tell — the handle never does that. Timing
between synthetic events is drawn from `profile.noise`, so an actor's cadence is
consistent with the identity rather than uniformly random.

### 6.3 Scope

`scope: 'session'` instantiates once per connection instead of per page, for an
actor coordinating across pages (a login that must happen once before other
pages proceed). Per-page is the default because it is what nearly every actor
wants.

`urls` filters which pages get an instance, by URL glob. It is deliberately
named `urls` rather than `match` because `protocol`'s `match` filters CDP method
globs, and two fields with the same name and different meanings is a trap.

### 6.4 The escape hatch

Keeping the handle small is only defensible if there is a way out of it. An
actor doing real work on a real site will eventually need something
`PageContext` does not have — a download intercepted, a JavaScript dialog
answered, a specific response body read — and the alternative to a route back to
CDP is that the author abandons the kind and writes a `protocol` plugin, losing
per-page lifetime and off-queue scheduling to get one command.

Two members, and they are the whole hatch:

```ts
// Send any typed CDP command, bound to this page's session.
await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath })

// Observe any typed CDP event on this page's session. Returns an unsubscribe.
const off = page.cdp('Page.javascriptDialogOpening', ({ message }) => {
  page.log(`dialog: ${message}`)
  void page.send('Page.handleJavaScriptDialog', { accept: true })
})
```

`send` is `ctx.send` with the session id already filled in. `cdp` is the part
that did not exist before: without it an actor could talk but not listen, which
is the gap that would have pushed authors back down to `protocol`.

This is deliberately a hatch and not a second API, and it comes with real
limits. All of them belong in the author guide, because every one of them is a
bug that looks like a platform failure when you hit it:

> DANGER: the escape hatch is **observe-only, unarbitrated, and invisible to the
> platform's reporting.** Specifically:
>
> 1. **`cdp` cannot change anything.** It is a copy of the event, delivered
>    after the pipeline has already decided what happens to it. An actor cannot
>    suppress, rewrite, or answer a CDP message — that is what `protocol` is
>    for, and needing it is the signal that you are writing the wrong kind.
> 2. **Handlers run late.** They are scheduled off the message queue like every
>    other actor callback, so the page may have navigated by the time yours
>    runs. Treat what you observed as a fact about the past, not the present,
>    and re-check before acting on it.
> 3. **Enabling a domain is not free.** A domain the client had not already
>    enabled changes what the session looks like from the browser's side.
>    `Runtime.enable` is refused outright — it is the exact tell core `contexts`
>    (§8.3) exists to suppress, and one actor calling it would undo every
>    surface's work in the session. Other `*.enable` commands are allowed and
>    logged once, with the domain named.
> 4. **Brokered domains are refused,** and the error names the declarative
>    alternative. `Fetch.enable`, `Network.setExtraHTTPHeaders`,
>    `Target.setAutoAttach`, and `Emulation.setDeviceMetricsOverride` have one
>    owner per session (§7.2); an actor calling them directly clobbers whatever
>    the broker had arranged for everyone else.
> 5. **You may not disable what you did not enable.** `*.disable` for a domain
>    the actor did not turn on is refused, because the plugin that _was_ using
>    it has no way to find out it stopped working.
> 6. **Nothing here is covered or arbitrated.** Coverage (§2.8) and the conflict
>    report (§9.5) work by reading declarations, and a raw command declares
>    nothing. Two actors doing the same thing through `send` will not be
>    reported as conflicting, and a profile field read only to build a raw
>    command still counts as read. The hatch buys capability by giving up the
>    guarantees the kinds exist to provide, which is the trade it should be
>    understood as making.

The refused list is the same shape as §3.1's reserved launch flags and enforced
the same way: the throw happens at the call, names the plugin and the command,
and points at the supported route. Reaching the hatch three times in one plugin
is a strong hint that the work belongs in `protocol` after all, and §9.2's
tiebreakers should be re-read rather than worked around.

---

## 7. Runtime services

The five kinds are the authoring surface. These are the remaining problems no
per-plugin API can solve. Profile resolution is the third and largest, and it
got its own section (§2) because it is a kind rather than a service.

### 7.1 `realms` — deliver page code everywhere

Corsac's unsolved problem. A `WebGLRenderingContext` patch on `window` is
bypassed by `OffscreenCanvas` in a worker; a `navigator.hardwareConcurrency`
patch is bypassed by asking a same-origin iframe.

The runtime delivers every surface bundle to every realm:

| Realm          | Mechanism                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| page, iframe   | `Page.addScriptToEvaluateOnNewDocument` — already covers the whole frame tree.                                                  |
| worker         | `Target.setAutoAttach({ waitForDebuggerOnStart: true })`, `Runtime.evaluate` on attach, then `Runtime.runIfWaitingForDebugger`. |
| service worker | The same, on the service-worker target.                                                                                         |

The worker path is the hard part, for two reasons that must be handled together.
There is no `Page` domain on a worker, so there is no
`addScriptToEvaluateOnNewDocument` and the pause-evaluate-resume dance is the
only way to get in before the worker's own code. And `Target.setAutoAttach` is a
browser-wide, single-owner setting that Playwright also uses, which is precisely
why it belongs to the runtime (§7.2) rather than to whichever plugin asks first.

> DANGER: `stealth` suppresses `Runtime.enable` for `page` and `iframe` targets
> only, and deliberately lets it through on workers — suppressing it there would
> strand Playwright without contexts. Worker realm injection uses
> `Runtime.evaluate` directly and must not change that.

### 7.2 Brokered domains

Some CDP domains have exactly one owner per session, and today the last plugin
to call wins, silently:

| Domain                               | Why it needs a broker                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `Fetch.enable`                       | `patterns` **replace** on each call. Two plugins intercepting requests, and one loses. |
| `Network.setExtraHTTPHeaders`        | Replaces the whole header map. Two surfaces contributing headers, and one loses.       |
| `Target.setAutoAttach`               | Browser-wide and shared with Playwright's own use.                                     |
| `Emulation.setDeviceMetricsOverride` | Whole-struct; `stealth` already rewrites the client's call in flight.                  |

The runtime owns each of these. Plugins declare intent — a URL pattern, a
header, a realm subscription — and the runtime unions the declarations, makes
one call, and dispatches what comes back to whoever matched. Overlapping intents
are resolved by `priority` and **reported at session start** (§9.4), so two
plugins fighting over a request is a line in the trace rather than a mystery.

This also gives `Fetch.authRequired` an owner, which is what makes §3.1's proxy
credentials work without a plugin enabling `Fetch` behind everyone's back.

### 7.3 `rpc` — declared, not string-matched

Today a plugin answers a custom method by string-matching in `onRequest` and
returning `{ respond }`. It works, but the method is invisible to tooling, a
`match` glob silently breaks it, and two plugins can claim the same name.

```ts
rpc: {
  'Proxy.history': (params) => ({ entries: [...entries] }),
}
```

Declared methods are registered at install, so a collision is an error at
session start; they bypass `match`; they appear in `Proxy.hello`; and the SDK's
`rpc()` helper can be typed from the declaration. `{ respond }` in `onRequest`
stays supported and is still the right tool for intercepting a _real_ CDP
method.

The runtime declares two of its own: `Proxy.profile` returns the sealed profile
and its coverage report (§2.8), and `Proxy.debug` is unchanged.

---

## 8. Core, defaults, and presets

Not everything in the system is a plugin an author writes, and not everything an
author can write is optional. Three tiers, distinguished by who owns them and
whether they can be removed.

### 8.1 Three tiers

| Tier         | Lives in    | Removable            | Owned by     | Example                                    |
| ------------ | ----------- | -------------------- | ------------ | ------------------------------------------ |
| **runtime**  | `src/`      | no — not a plugin    | the platform | realm delivery, brokers, rpc, id remapping |
| **core**     | `src/core/` | no                   | the platform | the `Runtime.enable` defeat                |
| **authored** | `plugins/`  | yes — opt in and out | anyone       | `webgl`, `captcha`, `corpus`               |

The runtime tier is §7 and is not made of plugins at all. The authored tier is
everything §2–§6 describes. This section is about the one in the middle.

### 8.2 What makes a plugin core

Core plugins are plugins by construction rather than by nature. They exist as
plugins so that the platform's own behaviour composes through the same mechanism
as everyone else's — one priority model, one trace format, one conflict report —
instead of living in a parallel code path that nothing else can see or order
against.

The test for membership is narrow, and it is deliberately not "is it important":

> **Core is what the runtime would have to do anyway if plugins did not exist.**

That is a different question from "would a session be worse without it". A
session without `webgl` is more detectable, but the runtime would never spoof a
GPU on its own — that is a policy choice about what machine to be, which is
exactly what an authored plugin is for. Whereas the runtime must launch a
process, so it must decide on flags; it must resolve an identity before it can
compute those flags; and it exists in the first place because forwarding
`Runtime.enable` announces the client.

### 8.3 The core set

Three plugins, one per pre-existing platform obligation.

| Core plugin         | Kind       | The obligation it discharges                                                                                                              |
| ------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/generate` | `profile`  | Every session has a sealed identity. As the terminal loader, it can satisfy any constraint, so the loader chain can never fail to answer. |
| `src/core/flags`    | `launch`   | The process starts, stays controllable, and does not defeat itself. This is `BROWSER_LAUNCH_FLAGS` from `constants.ts`, moved.            |
| `src/core/contexts` | `protocol` | The client is not announced on the wire. The `Runtime.enable` defeat, moved out of `plugins/stealth.ts`.                                  |

`contexts` is the clearest case and the reason this tier exists. It is not "more
stealth" layered on top of the others — it is the precondition that makes the
others worth doing. A session presenting a beautifully coherent Windows
fingerprint while forwarding `Runtime.enable` has already announced itself, and
every surface's work is spent. It is also, precisely, the thing this project was
created to do: patching Playwright at the network layer instead of at the source
is the founding thesis in §0 of `v2-final-implementation-plan.md`, and without
`contexts` the proxy has no reason to be in the path at all.

Moving `flags` out of `constants.ts` removes a second mechanism rather than
adding one. §3.1 previously had baseline flags in a constant _and_ contributed
flags from plugins, arbitrated by two different rules. Now there is one list,
one merge policy, and one place the trace reports overrides.

Core plugins take **no author-facing options**. They read `Config` and
`ctx.profile` and nothing else, which is what makes "you do not edit these" a
statement about the API and not just a convention. Everything `stealth` used to
expose as options — `userAgent`, `acceptLanguage`, `screen` — is a claim about
the machine and now lives in the profile (§9.3).

**The set is three, and that is settled (§16.1).** The User-Agent belongs to
`surface/platform/navigator.ts` in the authored tier — all of it, including the
`HeadlessChrome` token. Core does not touch the UA, and `--user-agent=` in core
`flags` was considered and rejected: it would have let core remove the harness's
own signature without choosing a persona, but it puts core in the business of
composing a UA string, which is the first half of choosing an identity and the
exact scope creep §8.2's test exists to refuse.

> DANGER: the consequence is direct and must not be discovered in production. A
> headless session running **core-only** — `plugins: []` (§8.6) — reports
> `HeadlessChrome` in its User-Agent, because the surface that removes it is not
> installed. Core keeps such a session controllable and unannounced _on the
> wire_; it does not make it look like a person.
>
> This is survivable only because core-only is not the default. `stealth()` is
> (§8.5), and it carries `navigator`, so a caller reaches this state by passing
> `plugins: []` explicitly — which is to say by opting out of the surfaces on
> purpose. `plugins: []` logs the fact for one release (§8.6), the "core-only is
> not stock" test asserts core ran rather than asserting the session is clean,
> and the README's browserscan grade for core-only is published as measured
> rather than as hoped.

### 8.4 Core is presence, not precedence

The guarantee core provides is that it is **always installed and cannot be
displaced**, not that it runs first. Each core plugin is pinned to whichever end
of its kind's order its job requires, and no authored plugin can take that
position by choosing a larger number:

| Core plugin | Pinned | Because                                                                                                            |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `contexts`  | first  | It must decide about `Runtime.enable` before anything else sees the message.                                       |
| `flags`     | first  | Later flags win by name (§3.1), so being first is what lets an authored `launch` plugin override a baseline flag.  |
| `generate`  | last   | It is the fallback. Every authored loader gets first refusal, and `generate` answers only what nothing else would. |

> IMPORTANT: `contexts` answers `Runtime.enable` with `{ respond }`, which
> short-circuits. A lower-priority `protocol` plugin therefore never sees that
> command, and no `priority` will change it. This is the intended consequence of
> pinning, and `plugins: 'none'` (§8.6) is the escape for anyone who needs to
> observe the unmodified wire.

### 8.5 Defaults and presets

A preset is a named list of configured plugins — the mechanism for defaults, and
how `stealth()` survives being broken up (§13.1). With `contexts` and `generate`
now core, the preset is purely the surface set:

```ts
export const stealth = definePreset<StealthOptions>({
  name: 'stealth',
  plugins: () => [
    navigator(),
    chrome(),
    screen(),
    languages(),
    timezone(),
    webgl(),
    canvas(),
    fonts(),
    audio(),
  ],
})
```

`stealth()` remains the **default**: a session that does not name a plugin set
gets it, exactly as `sdk.ts` does today. Default and core differ in one respect
that matters — a default is what you get when you say nothing, and core is what
you get when you say anything.

`plugins: [stealth()]` keeps working unchanged — a preset returns an array, and
the SDK flattens presets before registering, so the element type widens to
`ConfiguredPlugin | ConfiguredPlugin[]` (§8.6 gives the whole option). From the
automator's side nothing has happened. From the author's side, `stealth` is now
something you can take apart, replace a piece of, and test in isolation:

```ts
plugins: ;
;[
  corpus({ path: './fingerprints.jsonl' }), // outranks core's generate()
  stealth({ without: ['fonts'] }),
  fonts({/* mine */}),
]
```

Note how the profile loader composes without anyone coordinating: `corpus` is
authored so it gets first refusal, and core `generate` answers whatever `corpus`
declines. Neither knows the other exists.

### 8.6 What `plugins: []` means now

Three configurations, one option, and the option is the one that already exists:

```ts
plugins?: (ConfiguredPlugin | ConfiguredPlugin[])[] | 'none'
```

The element union is presets (§8.5), which return an array and are flattened
before registering; the `'none'` arm is the pass-through below.

```ts
chromium.launch() // the stealth preset, plus core — unchanged
chromium.launch({ plugins: [] }) // core only
chromium.launch({ plugins: 'none' }) // nothing at all — a transparent relay
```

`plugins: []` means **core only**: no surfaces, no actors, no authored loaders.
That is a coherent and genuinely useful configuration — the session is not
announced on the wire and presents the real machine, honestly, with no
fingerprint spoofing to get wrong. For a target that does not fingerprint
deeply, it is often the better trade.

This is a change in meaning, and it is settled (§16.1). Today `plugins: []` is
documented as a plain pass-through proxy, and it hands back a browser that
announces itself from a product whose entire premise is that it does not.
Treating that as a bug rather than a feature is the point of the core tier.

The reading is also more consistent than it first appears. Core is defined by
presence rather than by opt-in (§8.4), so `plugins` never controlled it: it
controls the _authored_ set, and an empty authored set is exactly what `[]`
says. The alternative — `[]` alone disabling core — puts a cliff in the middle
of an ordinary edit, because `plugins: [recorder()]` would install core and
deleting that one entry would silently remove it.

**Pass-through is a third value of `plugins`, not a second option.** An earlier
draft made it a sibling boolean, `raw: true`, which was dropped for a reason
worth recording: two axes for one question make a contradiction expressible.
`{ raw: true, plugins: [stealth()] }` has no defined meaning and every
implementation has to invent one. As a value of the field it modifies, the
contradiction cannot be written, there is one thing to grep for, and `harness()`
inherits the behaviour without needing a flag of its own (§9.8).

`'none'` exists for exactly two jobs: comparing behaviour against unmodified
Playwright when diagnosing whether the platform caused something, and observing
the unmodified wire. It is not a supported production mode and the SDK logs that
it was used.

> DANGER: `plugins: []` is load-bearing in this repo's own tests, and the
> migration is not a find-and-replace. `test/smoke.test.ts` uses it at seven
> launch sites for **two different reasons**, and they move in opposite
> directions. The `'passthrough proxies Playwright unchanged'` step is asserting
> that the _transport_ is transparent — a property of `ProxyConnection`, not of
> core — so it needs a genuinely empty session and moves to `plugins: 'none'`.
> The concurrent-leak regression, which asserts that a neighbouring `stealth`
> session does not rewrite this session's User-Agent, wants a realistic minimal
> session and should stay on `plugins: []`. A third test is needed that did not
> exist before: **core-only is not stock**, asserting core actually ran, because
> nothing else now proves it.
>
> `README.md`'s claim that the smoke test grades the same browser `Robot` with
> no plugins and `Normal` with `stealth()` must be **re-measured across all
> three configurations** before it is rewritten. Core-only will not necessarily
> grade `Robot`, and the contrast the README draws is the project's headline
> evidence.

For one release, `plugins: []` also logs a warning naming the change and
pointing at `plugins: 'none'`. It costs nothing and it is the difference between
a silent behaviour change on upgrade and a visible one — anyone running the
proxy as a transparent debugging relay today gets a different browser after this
lands, and should find that out from a log line rather than from a detector.

---

## 9. Authoring

Everything above defines the platform. This section is what a plugin author
actually needs, in the order they need it.

### 9.1 One field, three rungs — a worked example

Take the timezone. It is the clearest illustration of §4.2's ladder, because it
can be claimed on all three rungs and the right answer uses all of them.

**The profile draws it, coherently with everything it implies.** A loader that
returns `America/New_York` also returns `en-US`, a plausible `geo`, and
languages that agree. Nothing downstream chooses any of this.

**`launch` takes the top rung.** Chrome inherits `TZ` from its environment on
Linux and macOS, so the process's _real_ timezone can simply be correct:

```ts
export const clock = definePlugin({
  kind: 'launch',
  name: 'clock',
  setup(_cfg, ctx) {
    return { env: { TZ: ctx.profile.timezone } }
  },
})
```

`Date`, `Intl`, and every timezone-derived value are now right at the C++ level.
There is nothing in JavaScript to detect because there is nothing to detect.

**`surface` takes the next rung, for what the flag cannot reach.** A browser
context created after launch can be overridden individually, which `TZ` cannot
do, so the surface covers the per-context case and injects nothing:

```ts
export const timezone = definePlugin({
  kind: 'surface',
  name: 'timezone',
  setup(_cfg, ctx) {
    return {
      emulate(realm) {
        return realm.send('Emulation.setTimezoneOverride', {
          timezoneId: ctx.profile.timezone,
        })
      },
    }
  },
})
```

**No rung three.** No page function is written, so no patched function exists on
any prototype, so this surface contributes nothing for a detector to find.

The contrast is `webgl`. There is no launch flag for a renderer string and no
`Emulation.*` for it either, so it falls to the bottom rung and must patch
`getParameter` in the page (§4). That is the difference between a field that is
free and a field that costs you exposure — and knowing which is which is most of
the skill in writing surfaces.

Finally, **coverage closes the loop.** `Proxy.profile` reports `timezone` as
read by `clock` and `timezone`, so a future refactor that deletes the surface
shows up as an uncovered field in CI rather than as a detection three months
later.

### 9.2 Which kind should I write?

Every plugin is written with `definePlugin`, so the only question is what to put
in `kind`:

| If your plugin…                                                    | `kind`     |
| ------------------------------------------------------------------ | ---------- |
| decides what machine the session claims to be                      | `profile`  |
| needs a command-line flag, an env var, an extension, or a data dir | `launch`   |
| makes one browser API report something other than the truth        | `surface`  |
| watches a page and acts on it                                      | `actor`    |
| must change what the client and the browser see of each other      | `protocol` |

When two look plausible, these tiebreakers decide:

- **Could a launch flag or an `Emulation.*` call do it?** Then it is a
  `surface`, even if you were about to write a page patch. §4.2.
- **Does it need to see a CDP message the client sent?** Only `protocol` can. An
  `actor` can _observe_ events on its own page (§6.4) but cannot change them, so
  "see" here means "decide what happens to it".
- **Does it need to wait on something slow?** `actor`, not `protocol` — a
  `protocol` hook blocks its target's message stream and an `actor` does not.
- **Is the value it produces something another plugin would also need to agree
  with?** Then the value belongs in the profile and your plugin is whatever kind
  _carries_ it, not the kind that decides it.

Core is not a sixth answer to this question. It is a tier (§8), not a kind, and
its three members are already written — if what you are building looks like one
of them, you are almost certainly meant to extend it through the profile rather
than replace it.

### 9.3 Options or profile?

The single most common authoring mistake, and it has a one-line test:

> **Options configure the mechanism. The profile supplies the claim.** If two
> plugins read this value and disagreed, would the page notice? If yes, it is a
> profile field.

| Value                           | Where   | Why                                                        |
| ------------------------------- | ------- | ---------------------------------------------------------- |
| WebGL vendor and renderer       | profile | `navigator` and `webgl` must agree                         |
| Whether to patch WebGL2 as well | options | mechanism; invisible to a coherence check                  |
| `Accept-Language`               | profile | the header, `navigator.languages`, and `--lang` all use it |
| Screen size                     | profile | `--window-size`, `screen.*`, and `outerHeight` all use it  |
| Corpus file path                | options | not a claim about the machine                              |
| Captcha solver API key          | options | never reaches the page                                     |
| Recorder buffer limit           | options | never reaches the page                                     |

An option that overrides a profile field is how corsac's incoherence happened,
so it is not the supported path. To force a value, constrain the draw (§2.4) —
the loader then returns a whole row consistent with what you asked for.

### 9.4 The context

All five kinds get a context built on one base, so `log`, `signal`, and
`profile` mean the same thing everywhere — `profile` being the single exception,
absent on the kind that produces it. Each kind adds only what its attachment
point can support.

| Member     | `profile`       | `launch` | `protocol` | `surface`       | `actor`     |
| ---------- | --------------- | -------- | ---------- | --------------- | ----------- |
| `log`      | ✓               | ✓        | ✓          | ✓               | ✓           |
| `signal`   | ✓               | ✓        | ✓          | ✓               | ✓           |
| `profile`  | — (it makes it) | ✓        | ✓          | ✓               | ✓           |
| `send`     | —               | —        | ✓          | in `emulate`    | ✓ (bound)   |
| `cdp`      | —               | —        | — (hooks)  | —               | ✓ (observe) |
| `emit`     | —               | —        | ✓          | —               | —           |
| `inject`   | —               | —        | ✓          | — (declarative) | —           |
| `state`    | —               | —        | ✓          | —               | — (closure) |
| `targets`  | —               | —        | ✓          | —               | —           |
| `random`   | ✓               | —        | —          | —               | —           |
| `platform` | —               | ✓        | —          | —               | —           |

`signal` aborts at the end of whatever the kind's lifetime is: the browser run
for `profile` and `launch`, the connection for `protocol` and `surface`, and the
page for `actor`. The existing advice holds in all five cases — check
`signal.aborted` before reporting a failure, because a normal teardown rejects
everything in flight.

### 9.5 Ordering and conflicts

Everything resolves by `priority` (higher first) except where a shared resource
makes that impossible, and **every one of these is reported at session start**
so a conflict is a line in the trace rather than a mystery.

| Two plugins…                                        | Resolution                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| one of them is core                                 | core keeps its pinned end of the order (§8.4); `priority` cannot displace it         |
| both handle the same CDP message                    | `priority`; each is handed what the previous returned                                |
| can both satisfy a profile constraint               | `priority`; the first non-`undefined` `draw` wins                                    |
| set the same launch flag name                       | later wins, warning names both                                                       |
| claim `userDataDir` or `auth`                       | **error at registration** — these are exclusive                                      |
| patch the same page global                          | `priority` orders the bundle; the last one to write wins in the page                 |
| contribute the same header                          | `priority`; the broker names the loser                                               |
| want `Fetch.enable`                                 | the broker unions patterns and dispatches by `priority`                              |
| declare the same `rpc` method                       | **error at session start**                                                           |
| touch `Emulation.setDeviceMetricsOverride`          | the broker owns the domain; a `protocol` rewrite of the client's own call still runs |
| both reach the §6.4 escape hatch for the same thing | **not detected** — raw commands declare nothing for the runtime to compare           |

The pipeline report is the first thing to read when plugins fight:

```
trace: [0c349e67] pipeline profile:  pin(100) → corpus(50) → generate*
trace: [0c349e67] pipeline launch:   flags* proxy(0) clock(0)
trace: [0c349e67] pipeline surface:  navigator(10) screen(10) webgl(0) canvas(0)
trace: [0c349e67] pipeline protocol: contexts* → recorder(0)
trace: [0c349e67] pipeline actor:    captcha(0) banner(0)
trace: [0c349e67] conflict  --lang set by core flags, overridden by proxy
trace: [0c349e67] conflict  Accept-Language contributed by languages and navigator
```

`*` marks a core plugin, shown at its pinned end rather than with a priority,
because it does not have one to compare against.

### 9.6 When things fail

| Failure                                           | What happens                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| a **core** plugin fails at all                    | session fails; core is never `optional` and there is no degraded mode              |
| `setup` throws                                    | session fails, naming the plugin — unless `optional`, then it is skipped           |
| a message hook throws                             | logged with plugin, hook, and method; the message continues as if it passed        |
| every authored profile loader returns `undefined` | core `generate` answers; the trace names the loaders that declined                 |
| a `launch` plugin returns a reserved flag         | **registration error**, before the browser starts                                  |
| a launch flag is not honoured by the process      | reconciliation corrects the profile and logs it (§2.6)                             |
| a surface's profile field is absent               | the surface stands down and is reported (§2.9)                                     |
| a `page` function throws in the page              | its own surface is skipped; later surfaces still apply                             |
| an `actor` callback throws                        | logged for that page; other pages and the message stream are unaffected            |
| an `actor` calls a refused CDP command            | throws at the call, naming the plugin, the command, and the supported route (§6.4) |
| `ctx.send` after teardown                         | rejects — check `signal.aborted` before treating it as an error                    |

The page-function case deserves a note, because a throw inside an injected
script is otherwise invisible with the Runtime domain suppressed. Each surface's
page function is wrapped so a throw cannot break the surfaces after it, and the
failure is recorded in a closure the bundle keeps. When tracing is on, the
runtime reads it back with one `Runtime.evaluate` at document end and reports
it. When tracing is off nothing is read back and nothing is left in the page,
because a diagnostic channel a detector can query is worse than no diagnostics.

### 9.7 The development loop

**One import, and one constructor.** Every type and helper comes from
`src/mod.ts`, and every plugin of every kind is built with `definePlugin`. There
is no separate plugin SDK entry point to learn and no per-kind constructor to
remember — the kind is a field, so the only thing that changes between kinds is
what you write inside the definition.

```ts
import { definePlugin, harness } from '../../src/mod.ts'
```

**Scaffold rather than copy.** `deno task new surface graphics/webgl` writes
`plugins/surface/graphics/webgl.ts` and
`test/plugins/surface/graphics/webgl.test.ts` from the template for that kind,
already wired to the harness and with `kind: 'surface'` filled in. The category
segment is optional — `deno task new surface webgl` puts the file at the kind
root — and the task suggests one from the profile fields the template reads
(§10.2) rather than making you remember the table. Copying the nearest existing
plugin is how a kind's conventions drift.

**Find out what already exists.** `deno task plugins` lists every plugin with
its tier, kind, path, options, and the profile fields it reads. This is the
answer to "is there already a fonts surface?" without grepping, and it is
deliberately the primary discovery tool rather than the directory tree — because
a path is inert (§10.1), a listing that shows what each plugin _reads_ is more
useful than one that shows where somebody filed it.

```
core      protocol  contexts   src/core/contexts.ts            pinned first
core      launch    flags      src/core/flags.ts               pinned first
core      profile   generate   src/core/generate.ts            pinned last
authored  surface   webgl      surface/graphics/webgl.ts       reads gpu    realms page,iframe,worker
authored  surface   screen     surface/display/screen.ts       reads screen viewport chromeHeight
authored  profile   corpus     profile/corpus/mod.ts           opts path    priority 50
authored  actor     captcha    actor/challenge/captcha.ts      opts solver key   urls https://*
```

**Iterate headful.** `deno task dev --plugin webgl` reloads the plugin on save
and reopens a headful page against a pinned profile, so a change is one save
away from a visible result. It takes the plugin's `name`, not its path, for the
same reason nothing else does.

**Then look at what it did.** `CDP_DEBUG=webgl` for per-message decisions, and
`Proxy.profile` for what it read and what nothing read.

### 9.8 Testing

The harness is **public platform API, exported from `src/mod.ts`, and it ships
in Phase 1** (§16.1). Keeping it test-only was the alternative, and it fails for
the reason the phase ordering already implies: every phase after the first is
defined by what it can assert, so a test API that arrives late is a test API
that nine phases of plugins were written without. With five kinds, leaving
authors to assemble a fake CDP stream by hand is also how test quality diverges
— the difference between an author writing assertions and an author writing
infrastructure is the difference between a tested plugin and an untested one.
The cost of making it public is that its shape is now a compatibility surface,
which §11's "every hook is optional" promise covers.

```ts
import { assertEquals } from '@std/assert'
import { harness, pin, webgl } from '../../src/mod.ts'

Deno.test('webgl reports the profile GPU', async () => {
  await using it = await harness({
    plugins: [pin({ id: 'fixture-1' }), webgl()],
  })

  assertEquals(
    await it.page.eval(() => {
      const gl = document.createElement('canvas').getContext('webgl')!
      return gl.getParameter(0x9245)
    }),
    it.profile.gpu!.vendor,
  )
  assertEquals(it.coverage.uncovered, [])
})
```

`harness()` returns the sealed profile, a `PageContext` on a real page, the
coverage report, and the trace, and `await using` tears it all down. Core is
installed, as it is everywhere else, so a plugin is tested in the configuration
it will actually run in; `harness({ plugins: 'none' })` drops it for the rare
test that needs the unmodified wire. `harness({ fake: true })` swaps the real
browser for a scripted CDP stream — the existing `test/proxy-connection.test.ts`
machinery, promoted to public API — for tests that only need to assert what went
out.

`it.eachRealm(fn)` runs one assertion in the page, an iframe, and a worker,
which is how a surface proves the `realms` it claims.

Beyond mechanics, these are the assertions this platform makes possible and the
previous one did not:

- **Coherence.** Apply every surface, read the UA, platform, GPU, timezone,
  locale, fonts, and hardware back from one page, and assert they describe one
  machine. This is corsac's failure (§0.2.1) and the class of bug that appears
  only when two independently correct plugins meet.
- **Coverage as an assertion.** `assertEquals(it.coverage.uncovered, [])` on the
  stealth preset, so adding a profile field with no surface to carry it fails CI
  instead of shipping.
- **Reproducibility.** Same seed and constraint produce the same profile byte
  for byte across processes. Without it, a failing session cannot be re-opened.
- **Reconciliation.** Draw a profile claiming a Chrome version the binary is
  not, launch, and assert the sealed profile carries the binary's.
- **Stability.** Read a canvas hash twice and assert it is identical; reload and
  assert it still is; draw a second profile and assert it differs. §2.10's
  footgun, guarded from both sides.
- **Serialization.** Every bundled surface's `page` function is serialized and
  checked for free identifiers, catching §4.1 in CI rather than in a page where
  it fails silently.

`plugin-developer.md`'s existing advice applies with force: when asserting that
something is absent, confirm the assertion can still fail.

---

## 10. Files and folders

### 10.1 What corsac's tree actually got wrong

It is worth being precise about this, because the surface reading of §0.2.3 is
"category folders failed, so do not have them" and that is the wrong lesson.

Corsac filed plugins by browser-API category — ten folders, `snake_case` files,
one per Web API — and two things went wrong. The visible one is that `Math`
landed in two categories at once and `navigator` and `window` landed in
different ones for no defensible reason. The load-bearing one is that
`API_CATEGORIES` was an enum that config and the loader both read, so the
category a file sat in was **part of the plugin's identity**. Guessing wrong was
not a navigation annoyance; it was a resolution failure, and §0.2.4 records that
the three config schemas disagreed about the shape badly enough that
`loadEvasions()` likely loaded nothing.

Separate those and the diagnosis changes. Contested categories are survivable.
Contested categories that decide whether your plugin loads are not. This RFC
keeps the folders and removes the second property:

- **A path is inert.** Autoload recurses and registers whatever it finds.
  Nothing reads the directory name, no enum lists the legal categories, and no
  config is shaped like the tree. `surface/graphics/webgl.ts` and
  `surface/webgl.ts` produce the identical plugin.
- **Identity is `name`, and it is unique within a kind.** Two files both
  declaring `name: 'math'` collide at startup with an error naming both paths,
  wherever they sit. That is the actual defence against corsac's duplicate, and
  it works whether the tree exists or not.

So the cost of filing a plugin in the "wrong" folder is that somebody looks in
the wrong place for a few seconds, and `deno task plugins` (§9.7) answers the
discovery question regardless of layout. That is a small enough cost to let
authors organize as they see fit.

This is also why the rest of the RFC writes `surface/webgl` and `actor/captcha`.
Read those as _kind plus name_, which is what identifies a plugin, not as paths
— §10.2's tree is the only place that shows where the files actually sit.

### 10.2 The layout

Top-level folders are **kinds**, because kind determines the API you write
against, the tests you write, and what a reviewer checks. That level is fixed.
Inside a kind, **category folders are available and preferred, and flat files
remain legal** — the tree is an organizational convenience, not a contract.

```
src/core/               # the core tier (§8): platform-owned, never autoloaded
  mod.ts                #   the core set and where each is pinned
  generate.ts           #   profile — the terminal loader
  flags.ts              #   launch  — the baseline flags
  contexts.ts           #   protocol — the Runtime.enable defeat

plugins/                # the authored tier: kind folders, categories inside
  mod.ts                #   barrel: every preset and plugin
  stealth.ts            #   preset
  profile/              #   flat: too few loaders to categorize
    pin.ts
    host.ts
    remote.ts
    corpus/             #   a folder: it carries data as well as code
      mod.ts
      chrome-147.jsonl
  launch/               #   flat
    proxy.ts
    clock.ts
    extension.ts
  protocol/             #   flat
    recorder.ts
  surface/
    permissions.ts      #   legal: reads no profile field, so it sits at the root
    platform/
      navigator.ts
      chrome.ts
      fonts.ts
      math.ts
    locale/
      languages.ts
      timezone.ts
    display/
      screen.ts
    hardware/
      .gitkeep
    graphics/
      webgl.ts
      canvas.ts
    media/
      audio/            #   a folder once it outgrows a file
        mod.ts
        page.ts
        fixture.json
    network/
      webrtc.ts
  actor/
    challenge/
      captcha.ts
    consent/
      banner.ts
    session/
      .gitkeep
    behaviour/
      .gitkeep
```

**The preseeded categories ship empty rather than being invented per author.**
`surface/` and `actor/` get theirs on day one, each empty one holding a
`.gitkeep`, because a category an author has to invent is a category the next
author will not guess. The other three kinds are seeded flat: `profile`,
`launch`, and `protocol` have a handful of members between them and a tree over
four files is worse than no tree.

**`surface/`'s categories mirror the profile's field groups (§2.1), which is
what makes them uncontested.** A surface exists to carry a claim, the claim
comes from a profile field, and each field is in exactly one group — so "which
folder?" has a mechanical answer instead of a taste-based one:

| Category    | Profile group it carries                               | Example          |
| ----------- | ------------------------------------------------------ | ---------------- |
| `platform/` | `os`, `arch`, `chrome`, `userAgent`, `brands`, `fonts` | `navigator.ts`   |
| `locale/`   | `languages`, `locale`, `timezone`, `geo`               | `timezone.ts`    |
| `display/`  | `screen`, `viewport`, `chromeHeight`                   | `screen.ts`      |
| `hardware/` | `hardware.*`                                           | `concurrency.ts` |
| `graphics/` | `gpu`                                                  | `webgl.ts`       |
| `media/`    | `media`                                                | `audio/`         |
| `network/`  | claims made on the wire rather than in a field         | `webrtc.ts`      |

This is the rule that would have saved corsac's `math.ts`. `Math` results differ
because the platform's libm differs, so it reads `os` and `arch` and belongs in
`platform/` — not because somebody adjudicated between "language" and "runtime",
but because the field it depends on says so. It appears in the tree above as the
illustration and not as a commitment: §13.2 rejects corsac's implementation, and
the vector is Phase 10's if it is taken up at all. `fonts.ts` lands in the same
folder for the same reason, the installed font set following the OS.

When a surface reads no profile field at all it has no group, and the honest
answer is to leave it at the kind root. `permissions.ts` above is that case — it
exists to stop `Notification.permission` disagreeing with
`navigator.permissions.query`, which is a consistency repair rather than a claim
about a machine, so no folder is a better fit than none.

**Core lives in `src/`, not in `plugins/`,** and the split is the whole point:
`plugins/` is what an author browses and edits, `src/` is the platform. Putting
core under `plugins/core/` would also have broken the one rule that makes the
tree readable — that a top-level folder is a kind — since the core set spans
three of them. Core is compiled in rather than discovered, so autoload never
walks `src/core/`, and its three files are named for what they do rather than
for their kind.

### 10.3 Rules

1. **The root of `plugins/` holds presets and `mod.ts`. Nothing else.** What a
   user imports lives at the top; the parts live in the kind folders.
2. **The kind folder is required. Everything below it is the author's choice.**
   A category folder is preferred where one fits, and a file at the kind root is
   legal and needs no justification beyond no category fitting.
3. **A path is inert; `name` is the identity.** Nothing at runtime reads the
   directory a plugin was found in, so moving a file between categories is a
   no-op. `name` must be unique within its kind, and a duplicate is an error at
   startup naming both paths.
4. **A plugin is a file until it needs to be a folder.** Promote to
   `<name>/mod.ts` when it grows a page script large enough to want its own
   module, a fixture, or a data file. `surface/media/audio` and `profile/corpus`
   are the two shapes this covers: a page function past a hundred lines belongs
   in `page.ts`, and a fingerprint corpus belongs next to the loader that reads
   it.
5. **The filename is the subject, and the subject is what a reader would search
   for.** `webgl.ts`, not `web_gl_renderer.ts`. The category is context, never a
   substitute for a specific filename — `graphics/webgl.ts`, never
   `graphics/mod.ts` holding four surfaces.
6. **kebab-case**, matching every other file in this repo. Corsac's `snake_case`
   is not carried over; neither is `.cursor/rules/javascript.mdc`, which claims
   snake_case and does not describe this codebase.
7. **One subject per file.** If `navigator.ts` starts spoofing the screen, that
   is `screen.ts`. Files named after a subject are self-policing about scope in
   a way that files named after a category are not.
8. **Corpus data is versioned with the schema it was captured against**, in the
   filename: `chrome-147.jsonl`. A row's `schema` field decides which surfaces
   stand down (§2.9), and a filename that names the browser generation makes a
   stale corpus visible in a directory listing.
9. **Tests mirror the plugin path**:
   `test/plugins/surface/graphics/webgl.test.ts`, which is what `deno task new`
   generates.
10. **`.disabled.` still parks a plugin.** Autoload recurses to any depth under
    a kind folder and skips dotfiles, so a `.gitkeep` in an empty category is
    not a load candidate.

### 10.4 When to revisit

Two triggers, both about the categories rather than the file count.

**A category that stays empty for a release is deleted.** A `.gitkeep` is a
hypothesis about where plugins will accumulate, and an empty folder that
survives a release cycle is a hypothesis that was wrong. Deleting it costs
nothing, because no path is load-bearing (§10.1).

**A category that two authors read differently gets split or renamed.** The
symptom to watch for is corsac's: the same subject filed twice, or a reviewer
unable to say where something should live. Because `name` is unique within a
kind, the duplicate case surfaces as a startup error rather than as two files
drifting apart, which is the difference that makes the tree safe to have at all.

The reverse trigger is worth naming too. If `profile/`, `launch/`, or
`protocol/` grows past roughly a dozen files, seed categories for it the same
way — from the clusters the filenames actually formed, not by copying
`surface/`'s groups into a kind whose members have nothing to do with profile
fields.

---

## 11. The type surface

The whole authoring API, in one place. Additions to `src/types.ts`; nothing
existing is removed.

```ts
export type Kind = 'profile' | 'launch' | 'protocol' | 'surface' | 'actor'
export type Realm = 'page' | 'iframe' | 'worker' | 'service_worker'

/** Common to every configured plugin, whatever its kind. */
export interface Plugin {
  readonly kind: Kind
  readonly name: string
  readonly priority: number
  readonly options: Record<string, unknown>
  readonly optional?: boolean
  /**
   * Set by the runtime for the core tier (§8). Pinned to one end of its kind's
   * order, never `optional`, and not settable by an authored plugin.
   */
  readonly pinned?: 'first' | 'last'
}

/**
 * The base every kind that *reads* the identity shares (§9.4). `ProfileContext`
 * is the one exception, because it is what produces the identity.
 */
export interface Context {
  readonly profile: Profile
  /** Aborts at the end of the kind's lifetime; check it before logging failures. */
  readonly signal: AbortSignal
  log(...args: unknown[]): void
}

// ─── profile ──────────────────────────────────────────────────────────────────

/**
 * One machine, claimed coherently. Deeply frozen once sealed (§2.6). Optional
 * fields are absent rather than defaulted, and a surface whose field is absent
 * stands down rather than inventing one (§2.9).
 */
export interface Profile {
  readonly id: string
  readonly seed: string
  /** Which loader drew it, for the trace. */
  readonly source: string
  /** Bumped when a field is added; a surface compares before standing down. */
  readonly schema: number

  readonly os: 'macOS' | 'Windows' | 'Linux'
  readonly osVersion: string
  readonly arch: 'x86' | 'arm'
  /** The binary's major version, corrected by reconciliation. Never guessed. */
  readonly chrome: number

  readonly userAgent: string
  readonly brands: readonly { brand: string; version: string }[]

  readonly languages: readonly string[]
  readonly locale: string
  readonly timezone: string
  readonly geo?: { latitude: number; longitude: number; accuracy: number }

  readonly screen: {
    width: number
    height: number
    scale: number
    depth: number
  }
  readonly viewport: { width: number; height: number }
  /** Tab strip plus toolbar: the gap between outerHeight and innerHeight. */
  readonly chromeHeight: number

  readonly hardware: { cores: number; memory: number; touch: boolean }
  readonly gpu?: {
    vendor: string
    renderer: string
    angle: string
    params?: Readonly<Record<number, number | string>>
  }
  readonly fonts?: readonly string[]
  readonly media?: {
    codecs: readonly string[]
    devices: readonly { kind: string; label: string }[]
  }

  /** Deterministic per-profile jitter in [0, 1) for a stable key (§2.10). */
  noise(key: string): number
}

/** A query against the loaders, never a patch to a drawn profile (§2.4). */
export interface Constraint {
  os?: Profile['os'][]
  locale?: string[]
  timezone?: string[]
  minChrome?: number
  /** Ask for a specific identity back, e.g. to pair with a userDataDir. */
  id?: string
  [key: string]: unknown
}

export interface ProfileHooks {
  /** Return `undefined` to pass to the next loader by priority. */
  draw(constraint: Constraint): MaybePromise<Profile | undefined>
  /** A stateful loader is told when an identity is retired (§2.7). */
  burn?(id: string, reason: string): MaybePromise<void>
}

export interface ProfileContext extends Omit<Context, 'profile'> {
  /** Seeded from the run, so a draw is reproducible given the same seed. */
  random(): number
}

// ─── launch ───────────────────────────────────────────────────────────────────

export interface LaunchHooks {
  flags?: string[]
  env?: Record<string, string>
  extensions?: string[]
  userDataDir?: string
  auth?: { username: string; password: string }
  onStart?(browser: BrowserInfo): MaybePromise<void>
  onStop?(browser: BrowserInfo): MaybePromise<void>
}

export interface BrowserInfo {
  pid: number
  host: string
  port: number
  userDataDir?: string
  flags: readonly string[]
  executablePath: string
}

export interface LaunchContext extends Context {
  readonly platform: 'darwin' | 'linux' | 'windows'
}

// ─── surface ──────────────────────────────────────────────────────────────────

export interface SurfaceHooks<Config = undefined> {
  /**
   * Runs in the main world of every realm, before any page script.
   *
   * DANGER: serialized with `Function.prototype.toString()`, so it cannot close
   * over anything — not imports, not `cfg`, not `ctx`. Everything it needs comes
   * through `config`, which must be JSON-serializable. A captured reference is
   * `undefined` at run time with no error.
   */
  page?: (config: Config) => void
  config?: Config
  /** Defaults to every realm. */
  realms?: Realm[]
  /** Native CDP overrides. Preferred over `page` wherever CDP can do the job. */
  emulate?(realm: RealmContext): MaybePromise<void>
  /** Merged across surfaces by the Fetch broker (§7.2). */
  headers?: Record<string, string>
}

export interface RealmContext {
  readonly realm: Realm
  readonly sessionId: SessionId
  readonly frameId?: string
  send: PluginContext['send']
}

/** Reads are recorded; unread fields are reported as uncovered (§2.8). */
export type SurfaceContext = Context

// ─── actor ────────────────────────────────────────────────────────────────────

export interface PageContext extends Context {
  readonly target: CDPTarget
  readonly url: string
  eval<T, A = undefined>(fn: (arg: A) => T, arg?: A): Promise<T>
  has(selector: string): Promise<boolean>
  wait(selector: string, timeout?: number): Promise<boolean>
  /** Input-domain events; the page sees `isTrusted: true`. */
  click(selector: string): Promise<void>
  fill(selector: string, text: string): Promise<void>
  goto(url: string): Promise<void>
  on(event: 'document' | 'close', fn: () => MaybePromise<void>): void
  /**
   * Escape hatch (§6.4): typed CDP, bound to this target.
   *
   * DANGER: refuses `Runtime.enable`, the brokered domains, and `*.disable` for
   * a domain this actor did not enable. Other `*.enable` calls are allowed and
   * logged, because a newly enabled domain changes what the session looks like.
   */
  send: PluginContext['send']
  /**
   * Escape hatch (§6.4): observe a typed CDP event on this page's session.
   * Returns an unsubscribe. Observe-only and delivered off the message queue
   * *after* the pipeline has decided, so it cannot change the message and the
   * page may have moved on by the time it runs.
   */
  cdp<M extends keyof Events>(
    method: M,
    fn: (
      params: Events[M] extends [infer P] ? P : Record<string, never>,
    ) => void,
  ): () => void
}

// ─── presets ──────────────────────────────────────────────────────────────────

export interface PresetDefinition<Options> {
  name: string
  defaults?: Options
  plugins(cfg: Options & { without?: string[] }): ConfiguredPlugin[]
}

export interface PresetFactory<Options> {
  (options?: Partial<Options>): ConfiguredPlugin[]
  presetName: string
}

// ─── testing ──────────────────────────────────────────────────────────────────

export interface HarnessOptions {
  /** Mirrors `LaunchOptions.plugins`, including `'none'` (§8.6). Core is installed. */
  plugins?: (ConfiguredPlugin | ConfiguredPlugin[])[] | 'none'
  profile?: Constraint
  /** Swap the browser for a scripted CDP stream; for assertions on what went out. */
  fake?: boolean
  headless?: boolean
}

export interface Harness extends AsyncDisposable {
  readonly profile: Profile
  readonly page: PageContext
  readonly coverage: { read: Record<string, string[]>; uncovered: string[] }
  readonly trace: readonly string[]
  /** Run one assertion in the page, an iframe, and a worker. */
  eachRealm<T>(fn: (realm: RealmContext) => Promise<T>): Promise<T[]>
}

// ─── one constructor, plus presets ────────────────────────────────────────────

/** Shared by every kind. `kind` selects which definition the rest must satisfy. */
export interface Definition<Options> {
  name: string
  defaults?: Options
  priority?: number
  optional?: boolean
}

export interface ProfileDefinition<O> extends Definition<O> {
  kind: 'profile'
  setup(cfg: O, ctx: ProfileContext): MaybePromise<ProfileHooks>
}

export interface LaunchDefinition<O> extends Definition<O> {
  kind: 'launch'
  setup(cfg: O, ctx: LaunchContext): MaybePromise<LaunchHooks>
}

export interface ProtocolDefinition<O> extends Definition<O> {
  kind: 'protocol'
  /** CDP-method globs. Absent means every method. */
  match?: string[]
  setup(cfg: O, ctx: PluginContext): MaybePromise<PluginHooks>
}

export interface SurfaceDefinition<O, C = undefined> extends Definition<O> {
  kind: 'surface'
  setup(cfg: O, ctx: SurfaceContext): MaybePromise<SurfaceHooks<C>>
}

export interface ActorDefinition<O> extends Definition<O> {
  kind: 'actor'
  /** URL globs; the actor is instantiated only on pages that match. */
  urls?: string[]
  setup(cfg: O, page: PageContext): MaybePromise<void>
}

export type PluginDefinition<O, C = undefined> =
  | ProfileDefinition<O>
  | LaunchDefinition<O>
  | ProtocolDefinition<O>
  | SurfaceDefinition<O, C>
  | ActorDefinition<O>

export function definePlugin<O, C = undefined>(
  def: PluginDefinition<O, C>,
): PluginFactory<O>
export function definePreset<O>(def: PresetDefinition<O>): PresetFactory<O>
export function harness(opts?: HarnessOptions): Promise<Harness>
```

**`definePlugin` constructs every kind, and that is settled (§16.1).** `kind` is
a literal discriminant, so narrowing it fixes the type of `setup`'s context and
the type of the hooks it must return, and the fields that only make sense for
one kind — `match` on `protocol`, `urls` on `actor` — are unavailable on the
others. Writing `kind: 'surface'` and then returning `onRequest` is a compile
error naming the hook, not a plugin that silently never runs.

`priority`, `optional`, `defaults`, and `name` mean the same thing in all five
definitions, which is why they live on a shared `Definition` rather than being
restated per kind. `optional`'s semantics are unchanged: a plugin that fails to
install fails the session unless it only observes. `PluginContext` gains a
`profile` so `protocol` plugins read from the same identity as everything else.

`definePreset` stays separate, and the asymmetry is deliberate rather than an
oversight: a preset is not a plugin with a sixth kind, it is a function that
expands to a list of configured plugins (§8.5). Giving it a `kind` would put
something in the `Kind` union that the runtime never installs.

Every hook on every kind is optional, so a later release adding one cannot break
an existing plugin. That is the whole compatibility promise, and it is why the
kinds are defined by hooks rather than by classes to extend.

---

## 12. What changes in `src/`

| File                      | Change                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/mod.ts`         | **New.** The core set (§8.3) and where each member is pinned. Installed by the runtime, never autoloaded.                                                                                                                             |
| `src/core/contexts.ts`    | **New.** The `Runtime.enable` defeat, moved verbatim from `plugins/stealth.ts` (§13.1).                                                                                                                                               |
| `src/core/flags.ts`       | **New.** `BROWSER_LAUNCH_FLAGS`, moved from `constants.ts` and expressed as a `launch` plugin.                                                                                                                                        |
| `src/core/generate.ts`    | **New.** The terminal profile loader.                                                                                                                                                                                                 |
| `src/plugin.ts`           | `definePlugin` gains the `kind` discriminant and dispatches on it; the four non-protocol definition types and `definePreset` are added beside it. `Pipeline` gains core pinning (§8.4).                                               |
| `src/profile.ts`          | **New.** The `Profile` type, the loader chain, `draw`, reconciliation, sealing, `noise`, and the recording view behind coverage.                                                                                                      |
| `src/coverage.ts`         | **New.** Read recording per plugin, the uncovered and stood-down report, `Proxy.profile`.                                                                                                                                             |
| `src/surface.ts`          | **New.** Compiles surface plugins: serializes `page` functions into one bundle, orders by priority, runs `emulate`.                                                                                                                   |
| `src/launch.ts`           | **New.** Collects and arbitrates launch contributions; enforces the reserved and warn flag lists.                                                                                                                                     |
| `src/actor.ts`            | **New.** Per-page instantiation, the `PageContext` handle, off-queue scheduling, and the §6.4 escape hatch with its refused-command list.                                                                                             |
| `src/realms.ts`           | **New.** Bundle delivery to page, iframe, worker, and service-worker realms.                                                                                                                                                          |
| `src/broker.ts`           | **New.** `Fetch`/`Network`/`Target` arbitration and dispatch.                                                                                                                                                                         |
| `src/harness.ts`          | **New.** The testing API (§9.8), real and fake browser modes. Exported from `mod.ts`.                                                                                                                                                 |
| `src/browser-manager.ts`  | `start()` takes a resolved launch contribution instead of reading `constants.ts` directly; reports `BrowserInfo` for reconciliation.                                                                                                  |
| `src/browser-pool.ts`     | Slots carry a profile; `profiles: N` draws the fleet's identities at start; `reserve(token, launch, profile)`; data-dir/profile pairing.                                                                                              |
| `src/session-manager.ts`  | Store the kind-partitioned plugin set, the constraint, and the sealed profile.                                                                                                                                                        |
| `src/proxy.ts`            | Partition by kind at `register`; resolve the profile before reserving; promote to browser isolation for `launch` plugins and unsatisfiable constraints; recursive autoload.                                                           |
| `src/proxy-connection.ts` | Install compiled plugins; host the broker, realm delivery, and the rpc registry.                                                                                                                                                      |
| `src/sdk.ts`              | Flatten presets; the `profile` constraint option; `plugins` widens to `(ConfiguredPlugin \| ConfiguredPlugin[])[] \| 'none'` (§8.6). `plugins: []` now means core-only rather than pass-through, and logs the change for one release. |
| `src/config.ts`           | `CDP_PROFILE` (pin an id), `CDP_PROFILES` (fleet size), `CDP_CORPUS` (path).                                                                                                                                                          |
| `src/constants.ts`        | `BROWSER_LAUNCH_FLAGS` moves to `src/core/flags.ts`; the reserved and warn lists stay and become enforced rather than documented.                                                                                                     |
| `src/debug.ts`            | Trace kind alongside name; report the drawn profile, coverage, stand-downs, conflicts (§9.5), and launch-flag overrides.                                                                                                              |
| `src/types.ts`            | §11. Today's `PluginDefinition` becomes `ProtocolDefinition` and the name `PluginDefinition` is reused for the five-way union, so a plugin that imported the type by name needs the same one-word edit its definition does.           |
| `deno.jsonc`              | Tasks: `new` (scaffold), `plugins` (list), `dev --plugin` (watch one plugin headful).                                                                                                                                                 |

Nothing in `proxy-connection.ts`'s three invariants — id remapping,
short-circuit semantics, target ownership — is touched. Every on-wire kind
arrives at the wire through the same `Pipeline` that `stealth` uses today.

---

## 13. Migration

Two bodies of existing code feed this platform: the working `stealth` plugin in
this repo, and corsac's fourteen evasions. They migrate very differently — one
is a move, the other is a salvage.

### 13.1 `plugins/stealth.ts`

`plugins/stealth.ts` is currently one 460-line plugin doing five unrelated jobs.
It splits along the kind boundaries, which is a good test of whether the
boundaries are real:

| Today                                                                                                       | Becomes                                                                  |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `Runtime.enable` suppression, synthetic contexts, isolated-world bookkeeping, the `setContent` console echo | **core** `src/core/contexts.ts` — unchanged logic (§8.3)                 |
| `resolveUa()` / `brandsFor()` reading `Browser.getVersion`                                                  | profile **reconciliation** (§2.6), for every loader at once              |
| `Emulation.setUserAgentOverride`                                                                            | `surface/navigator.ts` — pure `emulate`, values from `profile`           |
| `Emulation.setDeviceMetricsOverride` rewriting and the `BROWSER_CHROME` window-bounds bump                  | `surface/screen.ts`, reading `profile.screen` and `profile.chromeHeight` |
| `acceptLanguage`                                                                                            | `surface/languages.ts`, reading `profile.languages`                      |
| the `SCREEN` constant and the `147` UA fallback                                                             | deleted — both are guesses the profile replaces                          |
| the `stealth()` factory                                                                                     | `stealth.ts`, a preset over the surfaces (§8.5)                          |

`plugins/recorder.ts` moves to `plugins/protocol/recorder.ts` with a one-line
change: `kind: 'protocol'` is added to its definition. Its import, its
constructor, and every hook it returns are untouched, which is the practical
payoff of settling decision 10 the way it was settled — the migration for an
existing `protocol` plugin is additive, so no third-party plugin breaks on this
change and no deprecation window is needed for it.

Note where the pieces land relative to each other. The part of `stealth` that
was load-bearing becomes core and stops being optional; the part that was a
policy choice about what machine to be becomes a removable preset over the
profile. That the file splits cleanly along that line is the best evidence the
tier boundary is real and not just tidiness.

The two deletions in that table are the point of the exercise. `SCREEN` is
`1920×1080` for every session in the process, which means every session claims
the same monitor, and the `'147'` fallback in `brandsFor` is a hard-coded
browser version that will be wrong the day the pinned Chromium moves. Both are
values a plugin owns, which §0.3 says a plugin never should. Under the profile
they become a drawn field and a reconciled field respectively.

The `contexts` split is the one to be careful with: `docs/stealth.md` records
measurements behind nearly every line of it, and the migration must be a move,
not a rewrite. Its tests move with it unchanged.

### 13.2 Porting from corsac: the verdicts

Corsac's fourteen evasions are the closest thing to a specification of what
surfaces this platform needs, and they are also a catalogue of what goes wrong
when values, injection, and coherence are each a plugin's own problem. **Six of
the fourteen files become five surfaces; the other eight are not worth
porting.** Nothing is copied verbatim; in every case the _idea_ ports and the
implementation is rewritten against the profile.

| corsac                                    | Verdict    | Becomes                         | What changes                                                                                                                                                               |
| ----------------------------------------- | ---------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `document/navigator.ts`                   | **port**   | `surface/platform/navigator.ts` | Values from `profile`, not `MASKED_PROPERTIES`. Stop making `navigator` non-configurable. Move `hardwareConcurrency` to `Emulation.setHardwareConcurrencyOverride` (§4.2). |
| `document/html_canvas_element.ts`         | **port**   | `surface/graphics/canvas.ts`    | Seed from `profile.noise`, not the clock. Drop the `console.debug` leak. Patch context prototypes, not `getContext`.                                                       |
| `drawing/web_gl.ts`                       | **port**   | `surface/graphics/webgl.ts`     | `gpu.vendor`/`gpu.renderer` from `profile`, not a hard-coded RTX 3080. Drop the `console.debug` leak. Patch context prototypes, not `getContext`.                          |
| `styling/fonts.ts`                        | **port**   | `surface/platform/fonts.ts`     | Font list from `profile.fonts`. Fix `measureText` mutating `this.font`. Stop blocking legitimate `@font-face` queries.                                                     |
| `runtime/chrome.ts` + `runtime/window.ts` | **port**   | `surface/platform/chrome.ts`    | Merge the two — `window.ts` exists only to install what `chrome.ts` builds. Remove the per-call randomness in `csi()`.                                                     |
| `document/mutation_observer.ts`           | **reject** | —                               | Superseded by realm delivery (§7.1).                                                                                                                                       |
| `runtime/worker.ts`                       | **reject** | —                               | Superseded by realm delivery (§7.1).                                                                                                                                       |
| `runtime/performance.ts`                  | **reject** | —                               | Unstable reads and broken timers (§13.4).                                                                                                                                  |
| `language/date.ts`                        | **reject** | —                               | Breaks real time; the timezone belongs on a higher rung (§9.1).                                                                                                            |
| `language/math.ts`, `runtime/math.ts`     | **reject** | —                               | Dead code, duplicated, and dangerous if revived.                                                                                                                           |
| `language/error.ts`                       | **reject** | —                               | Louder than what it hides, and it hides nothing here.                                                                                                                      |
| `network/web_socket.ts`                   | **reject** | —                               | Logging, not evasion. `protocol/recorder.ts` already does this.                                                                                                            |

Three things the table does not say, worth stating outright.

**`getContext` is where corsac's canvas and WebGL evasions collide.** Both wrap
`HTMLCanvasElement.prototype.getContext` to patch the object it returns, so
whichever loads second wins and the other silently does nothing. Neither ported
surface should wrap `getContext` at all: patch
`CanvasRenderingContext2D.prototype.getImageData` and
`HTMLCanvasElement.prototype.toDataURL`/`toBlob` for canvas, and
`WebGLRenderingContext.prototype.getParameter` plus its WebGL2 counterpart for
WebGL, as §4's example does. The overlap disappears, and had it not, §9.5 would
have printed it at session start rather than leaving it to be discovered.

**The canvas noise seed is the interesting bug.** Corsac derives it from
`Date.now() / 3600000`, which is stable per position and per hour — so a page
that reads the canvas at 10:59 and again at 11:01 gets two different hashes from
one machine. The algorithm is otherwise sound and should be kept; only the seed
changes, to `profile.noise('canvas')`, which is stable for the life of the
identity (§2.10).

**Corsac has no audio, WebRTC, permissions, battery, or media evasion at all,**
so those surfaces are new work rather than ports (Phase 9). `screen` and
`timezone` are also absent from corsac but already exist here inside `stealth`,
and arrive by the §13.1 split. The port is a starting point, not a target.

### 13.3 What corsac's shared infrastructure becomes

The more useful half of the salvage. Every one of these was a per-project
invention that becomes a platform guarantee.

| corsac                                    | Becomes                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MASKED_PROPERTIES`                       | The **profile** (§2). This constant _is_ a profile — a hard-coded singleton one, shared by every session in every deployment, with no way to vary it or check it agrees with the browser it describes. |
| `STEALTH_LAUNCH_FLAGS`                    | Split three ways (§13.4): core `flags`, authored `launch` plugins reading the profile, and rejected.                                                                                                   |
| `createStealthScript()` and the IIFE      | `src/surface.ts` bundling (§4.1).                                                                                                                                                                      |
| `wrapWithErrorHandling`                   | The runtime's per-surface guard (§9.6) — same job, no page-visible artifact.                                                                                                                           |
| `globalThis.__stealth`                    | **Nothing.** Deleted (§13.4).                                                                                                                                                                          |
| `config.jsonc` / `config.ts` / the loader | `definePlugin<Options>` for mechanism, the profile for claims (§9.3).                                                                                                                                  |
| `API_CATEGORIES` and the ten folders      | The enum is **deleted**; category folders survive as an inert organizational choice, reseeded from the profile's field groups (§10.1, §10.2).                                                          |

`MASKED_PROPERTIES` is the one to dwell on, because seeing it as a degenerate
profile explains most of corsac's failures at once. `hardwareConcurrency: 8` and
`deviceMemory: 8` are asserted against whatever CPU the container actually has;
`languages: ['en-US', 'en']` is asserted regardless of the exit IP; and none of
it is checked against the `'ANGLE (NVIDIA GeForce RTX 3080 Direct3D11…)'` string
hard-coded three directories away in the WebGL evasion. Every one of those is a
coherence bug that the profile makes unrepresentable rather than merely
discouraged.

Corsac's launch flags carry the same lesson at the process level. The list
contains `--disable-features=IsolateOrigins` _and_
`--disable-features=TranslateUI`; Chrome takes one of them, not the union, so
one of the two has never had any effect. That is precisely the class of bug
§3.1's merge policy exists to make visible.

### 13.4 Rejected, and why

The eight rejected files, in three groups. The reasons are worth recording
because each one is a rule this platform now enforces structurally.

Rejecting an evasion is not the same as denying the vector it was aimed at.
Several of these were reaching for something real and could only express it as a
JavaScript patch, because a JavaScript patch was the only thing corsac could
express. Those vectors are picked up in Phase 10 (§14.1), on the rungs they
actually live on — timing defence as a behavioural model in `src/actor.ts`
rather than as jitter on `performance.now()`, and the timezone as `TZ` at launch
rather than as an offset subtracted from `Date.now()`.

**Superseded by the platform.** `mutation_observer.ts` walks the DOM to catch
iframes and redefines `contentWindow.parent`; `worker.ts` proxies the `Worker`
constructor. Both are attempts to reach realms that
`Page.addScriptToEvaluateOnNewDocument` did not cover, and realm delivery (§7.1)
covers all of them natively. Corsac's versions also do real damage: lying about
`parent` breaks `postMessage` origin checks, and forcing
`sandbox="allow-same-origin allow-scripts…"` onto every iframe breaks embeds
that did not ask for it.

**Unstable or behaviour-changing.** These are the important ones, because they
look like stealth and are the opposite of it.

- `performance.ts` adds `Math.random() * 0.01` to **every** `performance.now()`
  call and `Math.random() * 10` milliseconds to **every** `setTimeout` and
  `setInterval` delay. Two consecutive `performance.now()` readings that
  disagree by a random amount is a fingerprint no real browser has, and the
  timer jitter breaks debouncing and animation in ordinary page code. This is
  §2.10's rule violated as loudly as it can be.
- `date.ts` subtracts a fixed random offset of up to a second from `Date.now()`,
  `getTime`, and `valueOf`. That breaks token expiry, cache TTLs, and any
  scheduling the page does, and it buys nothing: the clock is not a fingerprint,
  the _timezone_ is, and the timezone is claimed correctly on a higher rung
  (§9.1).
- `math.ts` — both copies — replaces `Math.random` and `crypto.getRandomValues`
  with a transform that is never initialized, so today they are elaborate
  no-ops. If the transform were ever set, it would make `crypto.getRandomValues`
  return predictable bytes to any page doing real cryptography.

**Louder than the problem.** `error.ts` replaces the global `Error` constructor
with a `Proxy` to strip `playwright` and `puppeteer` from stack traces. Checking
`Error` for proxy behaviour is easier than parsing stacks, so the fix is more
detectable than the leak. It is also unnecessary here: Playwright never runs in
the page under this architecture, so those strings are not in the stacks to
begin with. `web_socket.ts` is a logging wrapper with no fingerprint effect,
which is `protocol/recorder.ts`'s job.

Three artifacts are deleted outright rather than ported:

> DANGER: do not carry over `globalThis.__stealth`,
> `globalThis.__STEALTH_DEBUG__`, or the
> `console.debug('[Canvas Fingerprint]', …)` calls in the canvas and WebGL
> evasions. A named global is detectable with `'__stealth' in window`, which is
> cheaper than every check the evasions defend against put together, and a
> fingerprint-read logger announces the exact thing it was written to hide. Page
> diagnostics in this platform are read back only when tracing is on and leave
> nothing behind otherwise (§9.6).

Of corsac's 27 launch flags, roughly half are ordinary automation hygiene and
already present in `constants.ts`. Three are worth calling out before anyone
copies the list wholesale: `--disable-infobars` was removed from Chrome years
ago and does nothing; `--disable-features=IsolateOrigins` turns off site
isolation, which every real desktop Chrome has; and `--disable-permissions-api`
either does nothing or removes `navigator.permissions` entirely, and nobody
appears to have checked which. A flag that removes an API every real browser has
is a worse tell than the one it was added to hide, which is what §3.1's warn
list is for.

### 13.5 The porting procedure

For each of the five, in this order:

1. **`deno task new surface <category>/<name>`** — start from the template, not
   from the corsac file. The shape is different enough that copying and editing
   produces a surface that still thinks it owns its values.
2. **Identify the claims and add them to the profile** if they are not there.
   `fonts` needs `profile.fonts`; `chrome` needs nothing new. A claim the
   profile cannot express is a profile schema change (§2.9), not an option.
3. **Take the highest rung** (§4.2). For `navigator`, `hardwareConcurrency` has
   an `Emulation.*` override and should use it; `webdriver` may already be false
   because `constants.ts` deliberately omits `--enable-automation`, and that is
   worth measuring before writing a patch for it. Only what is left goes in
   `page`.
4. **Port the patch body**, dropping every `console.debug`, every `__stealth`
   reference, and every hard-coded value in favour of the `config` argument. Add
   `native()` to each patched function — corsac only did this in four of
   fourteen, which means most of its patched methods failed a `toString()`
   check.
5. **Declare `realms`.** Corsac's evasions are almost all `window`-scoped and
   would not have survived a worker. Decide honestly which realms the surface
   makes sense in and let §7.1 deliver it there.
6. **Write the test the corsac version did not have.** Only four of the fourteen
   had any test at all, and the WebGL, canvas, date, error, WebSocket, worker
   and frame evasions had none. Assert the value, assert it in every realm
   claimed, and assert it is stable across two reads.
7. **Check coverage.** The field should move out of `Proxy.profile`'s uncovered
   list (§2.8). If it does not, the surface is reading something other than what
   it claims to own.

---

## 14. Roadmap

Each phase leaves `main` runnable, and the automator's code is unchanged
throughout.

- **Phase 1 — Kinds, tiers, and the harness.** The `kind` discriminant on
  `definePlugin`, kind partitioning in `register`, `definePreset` and preset
  flattening, the core tier with pinning (§8.4), `src/core/contexts.ts`
  extracted from `stealth`, `plugins: 'none'`, and `harness()` over the existing
  fake-browser machinery. The harness lands first deliberately: every phase
  after this one is defined by what it can assert, and retrofitting a test API
  to nine phases of plugins does not happen. Core lands first for the same
  reason — it changes what a session is, and doing it later means re-testing
  everything built on the old answer. This phase also carries the §8.6 test
  migration: the transparency step moves to `plugins: 'none'`, the leak
  regression stays on `plugins: []`, the new "core-only is not stock" assertion
  lands, and the README's browserscan grades are re-measured across all three
  configurations.
- **Phase 2 — profile resolution.** The type, `kind: 'profile'`, the loader
  chain, sealing, `noise`, `ctx.profile` on all kinds, core `generate`, authored
  `pin`, and the coverage report. Nothing consumes it yet, so the phase is
  provable on its own: every field is uncovered and the trace says so.
  `generate`'s distribution tables are built here from public aggregates and
  re-weighted off Steam's gamer skew per §2.5, with the re-weighting committed
  beside them; the third-party generators are evaluated and rejected or adopted
  before the tables are written rather than after (§16.1).
- **Phase 3 — `surface`, page and iframe only.** `kind: 'surface'`, function
  serialization, the bundle, the `native`/`define`/`noise` helpers, `emulate`.
  The free-identifier lint rule lands **with** serialization rather than after
  it (§4.1, §16.1): it is the only thing standing between an author and a silent
  half-applied patch, so shipping the mechanism without the check would mean
  every surface written in this phase is written unguarded. Split `stealth` per
  §13.1 so the first consumers of the profile are the surfaces that already
  work, then land the five corsac ports — `navigator`, `canvas`, `webgl`,
  `fonts`, `chrome` — per §13.5. `navigator` carries the whole User-Agent
  including the `HeadlessChrome` token, which decision 6 keeps out of core
  (§8.3). Coverage goes from zero to the fields `stealth` covered, and then to
  the fields the ports claim.
- **Phase 4 — `launch`.** Contribution merge, core `flags` extracted from
  `constants.ts`, reserved and warn flag enforcement, profile-to-flags (`TZ`,
  `--lang`, `--window-size`, `--use-gl`), reconciliation against `BrowserInfo`,
  isolation promotion, pool slots keyed by profile and the `profiles: N` draw.
  Land `proxy`, `clock`, and `extension`. Core `flags` arrives here with no
  User-Agent flag in it: decision 6 keeps the UA in
  `surface/platform/navigator.ts` (§8.3), so the `--user-agent=` route this
  phase was once going to measure is not taken.
- **Phase 5 — `corpus` and rotation.** The corpus format and loader, weighted
  sampling, `burn`, data-dir/profile pairing, `remote`, and the capture tool
  that records rows from real Chrome on hardware you own. This is where
  fingerprint _quality_ arrives; everything before it is fingerprint _plumbing_.
  Once a corpus exists here, training a model on it and shipping the model as
  `generate`'s tables becomes available, which is the settled destination for
  `generate` and the hedge if Phase 10 scores it below corpus rows (§16.1).
- **Phase 6 — realms.** Worker and service-worker delivery. The riskiest phase
  (§15), deliberately after `surface` has proven itself on documents.
- **Phase 7 — brokers.** `Fetch`, `Network`, `Target` arbitration; surface
  `headers`; proxy authentication.
- **Phase 8 — `actor`.** `PageContext`, per-page lifetime, off-queue scheduling,
  and the §6.4 escape hatch — `cdp` subscription, the refused-command list, and
  the author-guide section covering its six limits. Land `captcha` and `banner`.
- **Phase 9 — DX and coverage.** Declared `rpc`, the `new`/`plugins`/`dev`
  tasks, the author guide, and the surfaces corsac never had (`audio`, `webrtc`,
  `permissions`, `battery`, `media`), each one turning a line of the uncovered
  report green.
- **Phase 10 — Advanced evasion.** The vectors that are not questions. §14.1.

Phases 1–4 are the ones that pay for the RFC; everything after is additive and
independently droppable. The coverage report from Phase 2 is what makes the
later phases measurable rather than a matter of opinion.

**Realms before brokers is confirmed (§16.1).** The two orderings trade the same
thing against each other: taking realms first completes `surface` — the kind
most authors write and the one every corsac port lands in — a phase earlier, at
the cost of implementing `Target.setAutoAttach` ownership twice, once narrowly
in Phase 6 and again properly in the broker in Phase 7. Taking brokers first
would avoid the rework and leave the platform's headline kind incomplete for
longer. The rework is bounded and known, so it is the one accepted: Phase 6
ships `setAutoAttach` behind a per-surface opt-in with the explicit expectation
that Phase 7 replaces it, and the realm test suite written in Phase 6 is what
proves the replacement did not regress anything.

### 14.1 Phase 10 — the vectors that are not questions

Everything through Phase 9 answers a _question the page asks_: it calls
`getParameter`, reads `navigator.languages`, queries a permission. A surface
works because there is a function to patch.

The vectors left over are the ones where the page asks nothing and **measures
something the browser does**. There is no function to patch, so there is no
surface to write, and this is exactly where corsac ran aground: it could only
express a defence as a JavaScript patch, so it wrote JavaScript patches for
problems that are not in JavaScript, and got `performance.now()` jitter and a
skewed `Date.now()` for its trouble (§13.4). The concerns behind those
rejections were real. The layer was wrong.

Phase 10 is therefore mostly _not_ more surfaces. It is four groups of work on
three other rungs.

**(a) Make the claim true rather than asserted.** Each of these is a field the
profile can claim and a surface can spoof, where the spoof is contradicted by
something the machine actually does.

- **Font metrics.** `surface/fonts` claims a font list, but `measureText`
  returns real glyph advances from the real font stack. A profile claiming
  Windows fonts on a Linux container disagrees with itself on the first
  measurement, and no patch fixes it without breaking text layout — which is
  precisely the trap corsac's `fonts.ts` fell into when it rewrote `ctx.font` in
  place. The fix is **provisioning**: install the font set the profile claims,
  as a container concern with a `launch`-time check, and have `fonts` stand down
  (§2.9) when the host cannot back the claim.
- **GPU rasterization.** Same shape, higher stakes. `surface/webgl` claims an
  ANGLE renderer string, but the pixels a canvas readback returns come from
  whichever backend `--use-gl` actually selected. `constants.ts` already carries
  `--use-gl=angle` and `--enable-unsafe-swiftshader` with a warning attached.
  Claiming a discrete NVIDIA renderer while rasterizing in SwiftShader is a
  mismatch between two things the same page can read. Reconciliation (§2.6) must
  correct `gpu` toward the real backend, and the draw must be constrained by
  what the host can actually do.
- **Speech synthesis voices.** `speechSynthesis.getVoices()` returns an
  OS-and-install-specific list that must agree with `profile.os`. Cheap to
  spoof, and another claim with nothing behind it.

The general rule this group establishes is worth stating on its own, because it
extends §4.2's ladder by one rung below the bottom: **a field the host cannot
actually back should be constrained out of the draw, not spoofed.** Standing
down is a supported outcome; asserting something the machine contradicts is not.

**(b) The wire.** Things the browser sends that no page function touches, and
that therefore belong to the broker (§7.2) rather than to any surface.

- **Header order.** Real Chrome emits request headers in a characteristic order.
  `Network.setExtraHTTPHeaders` appends, and appended headers can land in a
  sequence real Chrome never produces — a tell created by the act of spoofing.
  The broker is the only component that sees the whole header set, so
  order-aware merging belongs there.
- **Client Hints.** `Sec-CH-UA`, `-Platform`, `-Platform-Version`, `-Arch`,
  `-Bitness`, `-Model`, `-Full-Version-List`, and their
  `navigator.userAgentData.getHighEntropyValues()` counterparts. These must
  agree with the User-Agent string _and_ with `profile.os`, `osVersion`, and
  `arch`. `Emulation.setUserAgentOverride` accepts a `userAgentMetadata` struct
  that covers most of it, which puts this on rung two rather than rung three.
  The profile carries `brands` today and needs the high-entropy set added — a
  §2.9 schema bump, and the clearest example of why that mechanism exists.
- **TLS and HTTP/2 fingerprints.** JA3, JA4, and the Akamai HTTP/2 fingerprint
  are **free under this architecture and must be kept that way.** The handshake
  is real Chrome's, so the job is not to fix these but to avoid breaking them: a
  `launch` plugin that routes through an intercepting proxy replaces Chrome's
  ClientHello with the proxy's, which no surface can repair and no coverage
  report will catch. This belongs on §3.1's warn list, and it is the strongest
  single argument for the whole "real browser behind a proxy" thesis.

**(c) Behaviour.** The legitimate concern behind corsac's `performance.ts`:
automation really is distinguishable by timing. The answer is to make the real
behaviour plausible, not to lie about the clock. §6.2 already draws inter-event
timing from `profile.noise`; Phase 10 makes it a model — non-linear mouse paths,
dwell before click, scroll with acceleration and overshoot, typing cadence with
realistic digraph timing and the occasional correction. It lands in
`src/actor.ts` so every actor gets it without asking, for the same reason realm
delivery is a service rather than a plugin.

**(d) Measurement, which is what makes this phase finishable.** "More advanced
evasions" is unbounded without a score. Phase 10 ships a scored detector suite
in CI — CreepJS, Sannysoft, browserscan, fingerprint.js — alongside the
coherence oracle from §9.8, and a regression in the score fails the build the
way an uncovered profile field does.

This is the deepest lesson from the previous codebase, and it is not about any
individual evasion. Corsac shipped fourteen of them behind a loader whose config
schema did not match its own directory layout, so plausibly **none of them ever
ran**, and nothing in the project could have told anyone. A platform that cannot
measure itself will confidently ship zero working evasions.

Phase 10 has no defined end, and that is deliberate: it is the phase that stays
open, prioritised by what the detector suite says is failing rather than by what
seems interesting. Nothing in it is a prerequisite for anything else.

---

## 15. Risks

**A corpus goes stale, and a stale corpus is worse than generation.** Captured
fingerprints name a Chrome version, a GPU driver, and an OS build that were
current when they were captured. Six months later the corpus claims a browser
generation that has largely left the population, which is a rarity failure
(§2.5) dressed as a coherence success. Mitigation: the corpus filename carries
the browser generation (§10.3), reconciliation refuses to claim a Chrome version
the binary does not have, and a corpus whose rows are all more than one Chrome
major behind the running binary logs a warning at startup.

**Uniform sampling feels right and is wrong.** The instinct to maximize variety
across sessions produces a fleet of unusual machines, each individually
trackable. Mitigation: `generate` ships weighted tables rather than ranges,
`corpus` rows carry weights, and the sampler has no uniform mode.

**Sessions sharing a pooled process share an identity.** §2.7. Two sessions that
must not be correlated and land on the same slot present the same canvas hash to
the same site. Mitigation: `isolation: 'browser'` is the documented guarantee,
the trace names the slot and profile each session landed on, and the pool avoids
placing two sessions constrained to the same site on one slot.

**Worker realm injection (Phase 6) is the hard one.** It needs
`Target.setAutoAttach` with `waitForDebuggerOnStart`, which Playwright also
uses, on a browser-wide setting, in a session where `stealth` is already
suppressing `Runtime.enable` for documents but not workers. Getting it wrong
hangs workers. Mitigation: the broker owns `setAutoAttach` from Phase 7, Phase 6
ships behind a per-surface opt-in, and the realm test suite lands with it.

**Main-world injection is itself detectable.** §4.5. `native()` and matching
descriptors raise the bar; they do not clear it. Mitigation: the §4.2 ladder —
launch flag over `emulate`, `emulate` over `page` — and measuring against the
detector suite the way `docs/stealth.md` measures.

**Five kinds is more surface area to learn.** The mitigation is deliberate
uniformity rather than fewer kinds: one import, one context base (§9.4), one
priority model, one conflict report (§9.5), one failure table (§9.6), one
harness (§9.8), and one scaffold command. An author who has written one kind can
read any of the others. If a proposed sixth kind cannot share those, it is not a
kind. The core tier also shrinks what an author has to know exists at all — the
three hardest things in the system are the three they never assemble.

**The `actor` escape hatch is a hole in the platform's guarantees, by design.**
§6.4 exists so authors are not forced out of the kind by one missing capability,
but everything reached through it is outside coverage, outside conflict
reporting, and outside the ladder — and an author who finds `PageContext` a
little too small will reach for it habitually rather than once. The failure mode
is a codebase of actors that are `protocol` plugins wearing a page handle, which
is corsac's "everyone writes the low-level kind" failure arriving by a different
road. Mitigation: the refused list makes the genuinely dangerous calls
impossible rather than merely discouraged; `*.enable` is logged with the domain
named, so habitual use is visible in the trace; and gaps that several plugins
reach the hatch for are the evidence for growing `PageContext`, which is how the
handle is meant to grow — from demonstrated need, not from anticipation.

**The core tier is a magnet for scope.** Every plugin someone considers
important will be proposed for promotion, and each promotion is irreversible in
practice because sessions come to depend on it. Mitigation: the §8.2 test is
about what the runtime _would have to do anyway_, not about importance; core
takes no options, so a plugin needing configuration is disqualified on its face;
and the set is three, with decision 6 (§16.1) as the standing precedent — it
refused the narrowest imaginable promotion, a flag that would have removed the
harness's own signature without choosing a persona, which sets the bar for
everything proposed after it.

**`launch` costs a browser process per session.** §3.3. Stated, not hidden; the
shared-pool baseline and the `profiles: N` draw exist so the common fleet-wide
case does not pay it.

**Plugins are unsandboxed.** A third-party plugin runs with the proxy's full
Deno permissions and can read the filesystem and the network. A `profile` loader
is the most sensitive of the five, since `remote` is a plugin that ships
identity data off the machine by design. This RFC does not change the permission
model and should not be read as making it safer; if plugins are ever distributed
rather than vendored, scoping needs its own RFC.

**Scope creep — the v1 regression.** `v2-final-implementation-plan.md` §14 names
it as the failure that produced v1's rewrite, and this RFC is larger than that
plan. Phase 1 is deliberately one discriminant, one tier, and a test API — no
new kind is implemented in it. Phase 2 lands a profile nothing yet consumes, and
each later phase is droppable without stranding the ones before it.

---

## 16. Decisions

A decision keeps its number for the life of the RFC, including after it settles,
so "decision 6" means the same thing in a review comment written against any
revision.

### 16.1 Settled

All fourteen are closed. Each one is now stated as fact in the section that
depends on it; this table is the index, not the argument.

| #  | Decision                                                                   | Settled as                                                                                                      | Where it lives |
| -- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------- |
| 1  | Is `profile` a kind, or a runtime service with a pluggable strategy?       | **A kind.** Five kinds.                                                                                         | §2.1           |
| 2  | Is `actor` a kind, or a library over `protocol`?                           | **A kind**, with a scoped escape hatch back to raw CDP.                                                         | §6.1, §6.4     |
| 3  | Does the project ship real fingerprints, or generate them?                 | **Generate**, from public aggregates re-weighted to the web; `corpus` is the opt-in upgrade.                    | §2.3, §2.5     |
| 4  | Is the profile bound to the process, forcing pool slots to be keyed by it? | **Yes.**                                                                                                        | §2.7           |
| 5  | Default `profiles: N` for the shared pool.                                 | **One identity per slot** (`profiles === poolSize`); a smaller N is opt-in.                                     | §2.7           |
| 6  | Is the core tier three plugins, or more?                                   | **Three** — `generate`, `flags`, `contexts`. The User-Agent stays authored, in `surface/platform/navigator.ts`. | §8.3           |
| 7  | Does `plugins: []` change meaning to core-only?                            | **Yes**, with `plugins: 'none'` for the old pass-through.                                                       | §8.6           |
| 8  | Is `harness()` public API or test-only?                                    | **Public**, exported from `mod.ts`, shipped in Phase 1.                                                         | §9.8, §14      |
| 9  | Should `host` be the default loader for headful local runs?                | **No.** Documented as a debugging tool.                                                                         | §2.3           |
| 10 | Rename `definePlugin` to `defineProtocol`?                                 | **No.** One `definePlugin` for all five kinds, selected by a `kind` discriminant.                               | §5, §11        |
| 11 | Flat namespace within a kind, or a category tree?                          | **A tree, optional and inert.** Categories preseeded from the profile's field groups; flat files stay legal.    | §10.1–10.4     |
| 12 | Serialize page functions with `toString()`, or bundle them?                | **`toString()`**, with the free-identifier lint rule and the curated helper set as the other two thirds.        | §4.1           |
| 13 | Phase 6 (realms) before or after Phase 7 (brokers)?                        | **Realms first**, accepting that `setAutoAttach` ownership is implemented twice.                                | §14            |
| 14 | Port five of corsac's fourteen evasions, or more?                          | **Five**, with the vectors behind the rejections picked up in Phase 10 on the rungs they belong on.             | §13.2, §14.1   |

Seven of these have consequences worth restating outside the section that owns
them, because they change something a reader may already have assumed. They are
in decision order, not in order of importance.

**Decision 2 added an API that did not exist in the previous revision.**
Settling `actor` as a kind is only defensible alongside a way out of it, so
`PageContext` gains `cdp` — a scoped, observe-only CDP event subscription — next
to the `send` it already had. §6.4 specifies both, and its six limits are the
part that must reach the author guide: the hatch cannot change a message, its
handlers run late, `Runtime.enable` and the brokered domains are refused, a
domain you did not enable is not yours to disable, and nothing done through it
appears in coverage or the conflict report.

**Decision 3 settles the shape, and the shape has a precedent.** Camoufox — the
most credible open-source stealth browser currently shipping — does exactly
this: it synthesizes fingerprints by default through BrowserForge, and
separately bundles a few hundred real ones scraped from live traffic behind an
opt-in flag, described by its author as the option for "better evasion against
complex consistency checks". Generate-by-default with real data as the upgrade
is therefore not a compromise reached for lack of a corpus; it is what the
reference implementation in this space concluded independently. The commercial
antidetect vendors sit at the other end and sell real-device databases
exclusively, which is the right call when the database is the product and the
wrong one for a library that has to work on a fresh clone.

What decision 3 does _not_ settle is how good `generate` is, because that is set
by where its weights come from — a question that is not the same as the
generate-or-corpus one and has its own answer. Phase 2 writes conditional tables
from public aggregates — Steam Hardware Survey for GPU, resolution and core
counts, StatCounter for OS and browser-version share — with the caveat that
Steam's population is gamers and its shares must be re-weighted toward
integrated Intel and AMD graphics before use, or the fleet comes out plausible
row by row and collectively unlike the web. Phase 5 revisits this against a
score. The destination is to train a model on captured data and ship the _model_
rather than the rows, the way Apify's `fingerprint-suite` serialises a Bayesian
network whose sampler draws each attribute conditioned on its parents and
backtracks when a constraint makes a downstream node unsatisfiable — which is
already the `draw(constraint)` contract in §2.4. That path keeps real-data
fidelity without redistributing anyone's machine and without a mandatory data
file, so it is the hedge if Phase 10 scores generated profiles materially below
corpus rows.

One shortcut stays on the table and should be evaluated before Phase 2 rather
than after: `fingerprint-generator` and `browserforge` are installable today
with pre-trained networks, which would skip the table-writing entirely. It is
not recommended, for a reason specific to this project rather than to the
packages — they generate a whole fingerprint including fields the platform draws
itself, so adopting one means either surrendering profile ownership or
reconciling two sources of truth, which is the coherence failure §2.4 exists to
prevent. The secondary cost is a shared anonymity set with every Crawlee user,
which helps until a detector models the generator's own output distribution.

**Decision 6 leaves a sharp edge, and it is deliberate.** Holding core at three
means the User-Agent is entirely `surface/platform/navigator.ts`'s job, so a
headless **core-only** session — `plugins: []` — reports `HeadlessChrome`. A
platform whose premise is not announcing itself shipping a configuration that
announces itself is uncomfortable, and it was the strongest argument for
promoting `navigator` or for putting `--user-agent=` in core `flags`.

Both were rejected on §8.2's test: core is what the runtime _would have to do
anyway_, and composing a User-Agent string is the first half of choosing an
identity even when the string is derived from the real binary. The narrow
version of that flag was genuinely tempting — it would have removed the
harness's signature without picking a persona — and refusing it is what makes
the tier's boundary credible for everything proposed later. §15 now cites this
as the precedent rather than as an open question.

What makes the edge survivable is that core-only is not the default. `stealth()`
is (§8.5) and it carries `navigator`, so reaching this state takes an explicit
`plugins: []`, which is an explicit opt-out of the surfaces. Three things have
to hold for that to stay true, and all three are Phase 1 work: `plugins: []`
logs the change for one release, the "core-only is not stock" test asserts that
core ran rather than that the session is clean, and the README publishes
core-only's browserscan grade as measured rather than as hoped (§8.6). If the
grade is embarrassing, that is information, not a reason to quietly promote a
plugin.

**Decision 7 is a breaking change, and it costs more than a release note.**
`plugins: []` is documented as a pass-through in `README.md`, `src/sdk.ts`, and
`src/mod.ts`, and it is the **negative control** in this repo's own test suite —
`test/smoke.test.ts` calls it at seven launch sites, and "with no plugins the
proxy is transparent" is listed there as one of the three properties the project
exists for. Settling this decision therefore retires a control group, and §8.6
specifies how it is replaced: the transparency step moves to `plugins: 'none'`,
the concurrent-leak regression stays on `plugins: []`, a new assertion proves
core-only is not stock, and the README's browserscan grades are re-measured
rather than reworded. The work lands in Phase 1 alongside the option itself.

The escape was originally specified as a sibling boolean, `raw: true`. It is now
a third value of the field it modifies, `plugins: 'none'`, so that a
contradictory configuration cannot be expressed and `harness()` needs no flag of
its own. §8.6 records the reasoning.

**Decision 10 reverses the recommendation earlier revisions of this RFC carried,
and the reversal is the interesting part.** The question was whether to rename
`definePlugin` to `defineProtocol` so that "plugin" could stay the general term.
That framing had a false premise: it assumed each kind needs its own
constructor, so the only way to free the word "plugin" was to give it away. The
premise does not hold. `kind` can be a field, and once it is, `definePlugin`
constructs all five kinds and the word is free without anyone renaming anything.

The authoring difference is one line:

```ts
definePlugin({ kind: 'surface', name: 'webgl',  setup(cfg, ctx) { … } })
definePlugin({ kind: 'launch',  name: 'proxy',  setup(cfg, ctx) { … } })
definePlugin({ kind: 'actor',   name: 'captcha', setup(cfg, page) { … } })
```

against five separately imported constructors that differ only in the word after
`define`. Both express the kind exactly once and neither loses type safety — a
literal discriminant narrows `setup` and its hooks just as precisely as a
separate function signature does, and it narrows the kind-specific fields too,
so `match` is unavailable on a surface and `urls` is unavailable on a protocol
plugin. What the discriminant buys over the constructors is that the API stops
growing with the taxonomy: a sixth kind is a new value and a new definition
type, not a sixth top-level export, and every phase of §14 that would have
introduced a constructor now introduces a `kind` value instead.

Three smaller consequences follow. The migration for existing plugins becomes
additive rather than a rename, so `recorder` needs `kind: 'protocol'` added and
nothing else (§13.1), no deprecation alias is needed, and the decision no longer
blocks Phase 1 on being taken early to avoid a second rename.
`deno task new
surface webgl` still scaffolds per kind (§9.7) — the scaffold
writes the `kind` field, so discoverability comes from the generator and from
autocomplete on a literal union rather than from five names in an import
statement. And `definePreset` deliberately stays a separate function, because a
preset expands to plugins rather than being one, and giving it a `kind` would
put a value in the `Kind` union that the runtime never installs.

_This would be wrong if_ the kinds' definitions diverged so far that the union
stopped being readable as one type — but they share `name`, `defaults`,
`priority` and `optional` and differ only in `setup` and hooks, which is exactly
the shape a discriminated union is for.

**Decision 11 reverses an earlier recommendation too, and it required re-reading
the evidence rather than overriding it.** §0.2 lists corsac's category tree as
one of five instructive failures, and earlier revisions of this RFC took that as
settling the matter: corsac had folders, corsac failed, therefore no folders.
Looking again, corsac's tree had two independent defects and only one of them is
about folders. The category was an enum that config and the loader both read, so
it was part of a plugin's identity and guessing wrong was a resolution failure —
that is the defect that mattered, and it is not inherent to having directories.
The other, `Math` filed in two places at once, is a duplicate-name problem that
a unique-`name` constraint catches wherever the files sit.

Remove the first and the calculus inverts. A path here is inert: autoload
recurses and registers what it finds, nothing reads the directory name, and
`surface/graphics/webgl.ts` and `surface/webgl.ts` produce the identical plugin
(§10.1). So the cost of filing in the "wrong" folder drops from "your plugin
does not load" to "somebody looks in the wrong place briefly", and at that price
the grouping is worth having.

Three things make this concrete rather than a licence to invent trees.
`surface/`'s categories are **derived from the profile's field groups** (§2.1)
instead of from the Web platform, which gives filing a mechanical answer — the
surface carries a claim, the claim comes from a field, the field is in one
group. That is the rule that resolves corsac's `math.ts`: it depends on the
platform's libm, so it reads `os` and `arch` and lands in `platform/`, with
nobody adjudicating between "language" and "runtime". Categories are **preseeded
with `.gitkeep`** for `surface/` and `actor/` so authors choose from a set
rather than inventing one, while `profile/`, `launch/` and `protocol/` stay flat
because a tree over four files is worse than none. And **flat stays legal**: a
surface that reads no profile field has no group, and `permissions.ts` at the
kind root is the documented shape for it rather than an exception.

The reverse trigger is new and belongs in §10.4 rather than here, but it is the
part most likely to be skipped: an empty category that survives a release is a
wrong guess and gets deleted. Preseeding is only safe if it is also reversible.

**Decision 14 settles the count but not the ambition.** Five ports is the answer
to "which corsac files become surfaces", and it would be the wrong answer to
"which detection vectors matter". The eight rejections in §13.4 include several
aimed at real vectors that corsac could only express as JavaScript patches
because that was the only thing it could express. Settling the port list at five
therefore comes with Phase 10 (§14.1), which picks those vectors up on the rungs
they belong on: timing defence as a behavioural model rather than clock jitter,
font and GPU claims backed by provisioning rather than asserted over a host that
contradicts them, header order and Client Hints in the broker, and a scored
detector suite so the phase is driven by measurement rather than by intuition.

### 16.2 What to revisit first

Nothing is open. Two decisions were nonetheless closed on argument where a
measurement would have been better, and these are the ones to reopen first if
the plan meets resistance:

- **Decision 3** — whether `generate` or `corpus` is the production default —
  should be re-examined against the Phase 10 detector suite rather than left
  settled by default. §16.1 records the hedge if it goes the other way.
- **Decision 6** — the size of the core tier — was settled by refusing a
  promotion whose cost was never measured. Phase 1 measures it: the core-only
  browserscan grade goes in the README as observed (§8.6). If that grade is bad
  enough that nobody would ship `plugins: []`, the configuration is not the
  useful middle ground §8.6 claims it is, and the tier is worth reopening once —
  though the fix may be to drop the configuration rather than to grow core.

Everything else was closed on reasoning that does not depend on a number.
