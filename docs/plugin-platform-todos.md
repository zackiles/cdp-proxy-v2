# Plugin platform — follow-ups

Numbered sections refer to `plugin-platform.md`.

Two halves. **Closed this pass** is a decision log: what was open, what was
done, and the judgement call behind it — written to be argued with. **Still
open** is what remains, each with the reason it is not worth doing yet.

## Closed this pass

### `screen` became a surface, and the broker took the display (§13.1, §7.2)

`screen` was a `protocol` plugin rewriting Playwright's own
`Emulation.setDeviceMetricsOverride` as it went past, because a surface can only
send commands of its own and one sent from `emulate` was overwritten moments
later by the client's.

The fix was to give the broker the domain rather than to give surfaces a hook
over client traffic. A surface now returns a `display` claim — screen size,
scale, and the chrome height — and the broker merges it into whatever the client
sends, exactly as it already did for headers and interception patterns.
`plugins/surface/display/screen.ts` is nine lines and sends nothing.

Two judgement calls inside it, both learned the hard way:

- **The claim is pushed lazily, on the first document commit, and only if the
  client has not set a viewport.** Pushing at attach was the obvious shape and
  it is wrong: `Emulation.setDeviceMetricsOverride` with `width: 0, height: 0`
  (the "screen only, leave the viewport alone" form) made Chrome drop
  `innerHeight` from 720 to 581 on a page the client had sized. Deferring means
  a client that sets a viewport never sees a broker override at all.
- **`Browser.setWindowBounds` is adjusted rather than owned.** The client asks
  for a window height; the broker adds the tab strip and toolbar the profile
  claims. Owning it outright would mean deciding where the client's window goes,
  which is not an identity question.

This also closed "`screen` sometimes never matches": there is no `match` glob to
miss any more.

### Worker injection failures are reported (§7.1)

`Runtime.evaluate` on a paused worker cannot be awaited — the reply does not
come until the worker resumes, and the resume is the client's own
`Target.attachedToTarget` — so the send was fire-and-forget and a bundle that
threw inside a worker said nothing at all.

Rather than await it, the transport's swallow set became a swallow **map**: the
reply still never reaches the client, but a callback reads it on the way past
and writes a `debug.conflict` if it carries an exception. Same non-blocking
send, and the failure is now in `Proxy.debug`. Covered by a fake-harness test
that scripts the exception, so it does not need a real worker to stay honest.

### A service worker that was already running says so (§4.4)

Not fixed — **reported**, and that is the judgement call. A service worker
activated before the session connected keeps its unpatched globals, and the only
real repairs are unregistering somebody else's worker or restarting it. Both are
destructive side effects the platform should not take on a page's behalf. So
when a `service_worker` or `shared_worker` attaches with
`waitingForDebugger === false`, the session records a conflict saying the bundle
applied late. The automator can decide; the runtime cannot.

### `remote` got a credential and a retry (§2.3)

`token` is sent as `Authorization: Bearer`. Retries are **two attempts, 5xx and
transport errors only** — a 4xx is this request being wrong, and sending it
again is only wrong twice. Found and fixed a real leak while testing it: an
error response was thrown away without reading its body, which holds the
connection open for the life of the process. Every path now consumes the body.

### A corpus burn survives a restart (§2.7)

`corpus({ burns: 'path.jsonl' })` appends `{id, reason, at}` per burn and folds
the file back into the in-memory set on the next draw. Judgement calls:

- **Opt-in, not automatic.** A loader that writes to a file nobody asked for is
  a surprise in someone's container.
- **Appended, never rewritten.** Two processes sharing a burn file cannot lose
  each other's withdrawals to a read-modify-write.
- **Tolerant on read.** A process killed mid-write leaves half a line; that
  costs the one burn it was writing rather than every burn before it.

The corpus file itself is still never edited — it is an input, and a run that
edits its own input cannot be re-run.

### An actor that is not running says so (§6.3)

The old state: a setup that threw wrote a conflict line, and an actor whose
globs never matched wrote nothing. Both look identical from the client to an
actor that ran and decided to do nothing.

`Proxy.debug` now carries an `actors` array: every configured actor with a state
of `idle`, `watching` or `failed`, the URL it took, and the reason it did not.
Registered up front at install, so absence is not ambiguous. An actor that stays
`idle` while declaring `urls` also gets the same end-of-session warning a
`protocol` plugin gets for a `match` that never fired.

### `deno task dev` opens a real origin

It served `about:blank`, which is not a secure context: `getBattery`,
`navigator.mediaDevices`, service workers and blob workers are all absent or
refused there, so a surface iterated on it looks like it stood down when it
works. It now starts a loopback server and opens that; `--url` still overrides.

### `harness()` resolves the `launch` partition (§9.8)

`it.launch` is a `LaunchSpec` in both modes. Fake mode runs the merge without a
process, which is the whole of what a `launch` plugin decides. Real mode asks
the session over `Proxy.debug` rather than resolving a second time — a merge run
twice can only ever disagree with the one the browser actually started from.

That required `Proxy.debug`'s `launch` to become the whole spec (flags, env,
data dir, conflicts) instead of just the flag array. **This is a breaking change
to the debug snapshot**: `debug().launch` is now `debug().launch.flags`.

### `onStart` feeds reconciliation (§3.2)

`LaunchHooks.onStart` may now return a `Correction` — a partial profile — and
what it returns is folded into the identity before it seals. `id`, `seed` and
`source` are not correctable: they say which identity this is, and a process
cannot have an opinion about that.

Core `flags` is the first user, and the case is real rather than hypothetical:
the merge is last-wins by flag name, so an authored plugin passing its own
`--window-size` beats core's — correctly — and until now every surface went on
claiming a viewport `window.outerWidth` disagreed with. `onStart` reads the size
back off the command line the process actually started with and corrects
`viewport` where they differ.

### A session hands back what was reserved for it

The original note ("a promoted session pays for its own pool slot too") was
**stale**: promotion only happens when placement was not attempted or did not
succeed, so there is no idle slot to release. Verified in `register()` rather
than taken on trust.

There was a real leak next to it, though. Registering can start a browser
process before the client's first message — deliberately (§3.3) — and a token
that expired without ever connecting was dropped from the session registry with
nobody telling the pool. That Chrome stayed up for the life of the proxy.
`SessionManager` now takes an `onRelease`, and both paths (last connection
closed, token expired) go through it. Expiry is still only swept lazily, on the
next `register` or `resolve`; a timer would be a timer in every embedding
process, and an idle proxy has nothing to reclaim the process for.

### `userDataDir` pairing across restarts (§2.7)

Also stale: `pair()` writes a `.cdp-profile` marker into the directory and
refuses to open it under a different id. Nothing persists in the pool because
nothing needs to — the marker travels with the thing it describes and outlives
every process that opens it. Given a test rather than a change.

### Teardown noise from `contexts`

`debug.summary` now takes whether the session ended because somebody asked it
to. A command in flight when a client disconnects is the ordinary shape of a
disconnect and is written as a trace line; the same list when the upstream died
is still a warning, because that is when it is the most useful line in the log.

### `generate`'s weights were re-derived (§2.5)

Checked against June 2026 figures in July 2026; the working is in the module doc
so the next person can re-check it rather than trust it. What moved:

- **OS: 74/20/6 → 73/21/6.** StatCounter's June 2026 desktop table had 21% of
  traffic unclassified, which it later corrected. Renormalizing over the
  classified rows lands within a point of where the table already was — so this
  is a confirmation, not a change.
- **Windows version: a bug, not a re-weighting.** The table said `11` and `10`.
  `Sec-CH-UA-Platform-Version` on Windows is the `UniversalApiContract` version:
  Windows 10 is 1–10, Windows 11 is 13 and up. `11` is a value no Chrome has
  ever sent, and it fails the `major >= 13` test every site uses for Windows 11.
  Now `19.0.0` / `15.0.0` / `10.0.0`, weighted 69.92/28.1 Win11/Win10.
- **macOS version: 15.5/14.7/13.7 → 26.5.0/15.7.0/14.7.0.** Tahoe has been out
  since September 2025 and is ~64% of Macs; the table was claiming a Mac
  population that no longer exists.
- **Cores: one table → one per platform.** Steam counts physical cores and
  `navigator.hardwareConcurrency` reports logical processors, so Steam's
  histogram cannot be copied across at all. Keyed by platform because Apple
  silicon has no SMT: a Mac reporting 12 has twelve cores, a Windows laptop
  reporting 12 has six. The old table's 6 and 10 were physical-core values that
  a Windows machine would rarely report.
- **Memory: 8 GB plurality → 16 GB, and per-OS.** Steam is 16 GB 41.6 / 32 GB
  36.8 / 8 GB 7.8; the 32 GB share is a gaming artefact and 8 GB is weighted
  back up, but 16 GB is the plurality now. No Mac has shipped with 4 GB in a
  decade, which is what the per-OS split is for.
- **Resolution: kept.** StatCounter's June 2026 rows reproduce the 46/16/13
  shape the table already had, once the bot buckets (800×600, 1280×1200) are
  dropped.
- **GPU: the top two Windows NVIDIA rows swapped.** June 2026 was the first
  month the RTX 4060 Laptop GPU (3.81%) passed the desktop RTX 3060 (3.73%).

## Still open

### Wants data nobody has yet

- **Trained-model tables (§2.5).** The ceiling on `generate` is that
  hand-written tables encode only the correlations somebody thought to write
  down. The upgrade is a model fitted to captured rows, which needs captured
  rows. The re-derivation above raises the ceiling; it does not remove it.
- **No corpus ships with the repo.** A captured fingerprint describes somebody's
  actual machine, and a corpus in the repo is a corpus every deployment shares —
  `MASKED_PROPERTIES` again with more steps (§13.3). `deno task capture` writes
  one from hardware you own.
- **No `host` loader (§2.3), and it was tried.** A loader claiming the machine
  the proxy runs on can answer `os`, `arch`, `hardware`, `timezone` and `locale`
  from the runtime, and cannot answer `gpu`, `screen` or `fonts` at all: those
  need a browser, and a loader runs before one exists. Zeros are exactly the
  defaulted, incoherent field §2.9 forbids. `deno task capture` is the honest
  version of the same idea.

### Deliberate limits, revisit when something needs them

- **`plugins/mod.ts` barrel (§10.2).** `src/mod.ts` already re-exports every
  authored plugin; a second barrel with no distinct audience is a file to keep
  in sync rather than a convenience.
- **`--use-gl` is a constant, not profile-derived (§14).** Picking a real
  backend per profile means having a backend to pick, and SwiftShader on a
  machine claiming an RTX 3060 is a worse contradiction than the ANGLE string.
  Revisit with the provisioning work in Phase 10 (§14.1).
- **The reserved and warn lists live in `src/launch.ts`, not `constants.ts`.**
  §14's file table says otherwise. They sit next to the merge that enforces them
  because a list whose only reader is one function two modules away is a list
  that drifts from it. `constants.ts` points at both.
- **`GLOBALS` in `tools/lint.ts` is hand-maintained.** A page function using a
  browser global that is not on the list is rejected until someone adds it. The
  alternative is an allowance broad enough to admit the captured module constant
  the rule exists to catch (§4.1).
- **The broker arbitrates five domains, not a mechanism.** `BROKERED` is a
  literal list, and adding a whole-state domain means writing its merge by hand.
  That is the right shape for five and the wrong one for twelve.
- **Conflicts are reported, not negotiated.** Two plugins wanting different
  values for one header keeps the earlier and logs the other (§9.5). The loser
  gets no callback and cannot adapt.
- **`Runtime.enable` still passes through on workers.** §7.1 says so —
  suppressing it there strands Playwright without contexts — but a worker realm
  is one domain more visible than a page realm.
- **`page.eval` has no isolated-world option.** A world per actor is a context
  per actor, and the contexts are what core `contexts` spends its effort hiding.
- **`captcha` needs a solver and ships without one.** Solving is a paid
  third-party service with no common API. It refuses at setup rather than at the
  challenge, which is the right time to find out.
- **`codecs` only adds support, never removes it.** A Chrome that cannot play
  WebM does not exist. A profile describing a genuinely restricted build would
  need the subtractive direction.
- **`webrtc` costs NAT traversal.** Dropping `srflx` and `relay` candidates is
  what stops the page learning the address the proxy replaced, and it also stops
  a real peer-to-peer call across NAT connecting. `srflx: true` opts out.
  Rewriting the candidates to the proxy's own address would keep both, and needs
  the proxy to know what that address is.
- **`battery`, `permissions` and `webrtc` read no profile field.** They are
  consistency repairs and a wire defence rather than claims about a machine, so
  they turn no line of the uncovered report green.
- **`navigator.deviceMemory` is capped at 8 by the spec.** A profile drawn with
  32 GB reports 8, so `hardware.memory` reads as covered while only the capped
  value reaches the page.
- **The audio perturbation cannot be made subtle.** `Float32Array`'s relative
  epsilon is ~1.2e-7, so a smaller multiplier rounds back to the original sample
  and the surface silently does nothing. 1e-4 is a floor imposed by the type.
- **`deno task plugins` builds every plugin to read it.** That is what makes the
  `reads` column true rather than a second guess at the coverage report, and it
  means a plugin with a side effect in `setup` performs it during a listing. No
  bundled plugin does; a third-party one might.
- **The `surface/media/audio/` folder in §10.2's tree is three files here.** The
  RFC's tree shows the folder form as what a surface becomes once it outgrows a
  file, and none of these has.
