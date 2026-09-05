# Chat switching and visual polish — 2026-09-05

Scope: chat presentation, regression coverage, isolated browser fixture. Profile: `openbot`.
Base: `e51d3a59506088dd2bc0714cee7b42270c1ccbd3`. No deployment in this iteration.

## What changed

- The SDK's `connectAgent` sets `isRunning` during **idle history replay** as well as live work. The chat previously mounted an Orb with the terminal label “Ответ готов” until that replay ended.
- `isChannelTurnBusy` distinguishes this initial join from a local logical turn and a tracked background run. An untracked remote run is recognized through the existing server execution endpoint, independently of history. This read does not gate history paint or sending; it is skipped for tracked active runs, aborted on join completion/unmount, and bounded by a five-second timeout.
- The footer reuses `activitySnapshotFor` instead of independently translating a terminal protocol status. Real sends, reconnects and browser-tool handoffs keep their indicator. ThinkingOrb remains `state="listening" size={64}`; tools use the activity summary instead.
- More usable mobile message width, consistent spacing, unbroken-text wrapping, and a keyboard-accessible activity disclosure with a real 44px touch target. Light/dark themes use the existing design tokens.
- Removed an ineffective memo around an already-fresh bounded projection. No identity-only message caching was added: mutable earlier/nested message corrections must still appear.

Send, queue, stop, authentication, provider configuration, persistence and production data are unchanged.

## Verification

- RED: the new regressions failed on the original presentation (8 failures); after the fix, the focused transcript/turn/switch tests passed.
- Independent Sol review: original untracked-remote-run P2 resolved; final review reported no P1/P2 findings and 58 focused tests passing.
- First canonical `make verify`: 3349 Bun tests passed, 23 skipped, 0 failed; 21 Node service tests passed; format/lint/types/build passed. Tests used a freshly migrated disposable pgvector database, not a deployment database.
- Final canonical `make verify`: **3351 Bun tests passed, 23 skipped, 0 failed; 21 Node tests passed; format/lint/types/build passed**, including the cancellation regression. Existing bundle-size warnings remain; no rules or thresholds were weakened.
- Browser QA: 6 A/B switch visits per desktop/mobile profile, MutationObserver detects even transient mounts; **zero idle status/Orb mounts**, stable answer position, retained Orb through handoff, active reconnect and untracked remote execution visible, no Orb beside tool activity.
- Layout/keyboard QA: 320, 390, 768 and 1440px; light and dark; actual 44px summary target, Enter toggles disclosure, long unbroken URLs do not overflow. Existing streaming identity/scroll/reduced-motion checks remain enabled.

The fixture originally scanned only its own root for Tailwind classes. Its dedicated stylesheet now explicitly scans the real application source. Before/after performance runs both use this corrected scan; the earlier incomplete-style benchmark is not used for comparison.

## Performance

Production-mode Vite bundle, real local Chromium, 30 measured samples plus 4 warmups per scenario. Desktop 1440×900; mobile 390×844 with 4× CPU slowdown. Both revisions render a bounded maximum of 60 rows, including the 10,000-message dataset. Timings end after React commit and two animation frames.

Both corrected runs passed all 16 existing budgets. Selected p95 measurements:

| Scenario | Before | After | Budget |
| --- | ---: | ---: | ---: |
| Desktop warm switch | 65.4ms | 76.6ms | 100ms |
| Throttled mobile warm switch | 285.2ms | 320.4ms | 400ms |
| Desktop first delta | 47.2ms | 57.0ms | 500ms |
| Throttled mobile first delta | 228.2ms | 206.7ms | 2000ms |

This does **not** demonstrate a general latency improvement: warm-switch timings increased within budget, while mobile first-delta paint improved. No budget was relaxed. The measurable reliability/performance win in this slice is avoiding all transient idle Orb mounts and cancelling unnecessary outstanding join probes.

These are synthetic UI timings on a shared host, not production request latency. They exclude authentication, provider work, network latency and the optional execution-authority read. Eliminating idle Orb mounts is deterministic; timing variation alone is not evidence of a general speedup.

Reproduce:

```sh
bun scripts/runtime-performance.ts --json /tmp/chat-performance.json
CHAT_POLISH_SCREENSHOT_DIR=/tmp/chat-screenshots bun scripts/runtime-performance.ts --reliability-only
TEST_DATABASE_URL=<migrated-disposable-database> make verify
```

## Ownership and review

Separate worktree and guarded scopes; original `.serena/`, `tasks/`, dependency installs and previous worktree diagnostics preserved. No upstream `origin` push: integration targets `team-bot/main` only.

Methods: planning, UI engineering, TDD, performance measurement and isolated browser testing; delivery uses Git workflow and CI checks. The screen-layout skill was inspected but not applied because it explicitly excludes chat surfaces. No code graph was available; the Luna scout and targeted source reads established the affected chain.
