# Routines

A routine is a standing instruction: something a Bot carries out on a schedule instead of waiting to
be asked. "Every weekday at nine, summarize what changed in this channel overnight" is a routine, not
a message — it fires on its own, for as long as it stays switched on, and its reply lands in a channel
the same way any other message from that Bot does.

## Creating one

There is no form for this. Ask a Bot, in a channel: "every weekday at 9, post the standup notes
here." Turning a sentence into a five-field cron expression and a channel is conversational work, and
that is what the conversation is for. The same Bot can list what is standing, change one, or delete
one, all by being asked.

**The prerequisite:** a Bot can only do this once an administrator has granted it to. Routines is a
catalogue entry like any other — `create_routine`, `update_routine` and `delete_routine` are its write
tools — and enabling the entry does not hand any Bot access to it. Each tool is granted per Bot at
`/admin/plugins/routines`, exactly as a Google Drive or Notion tool would be. An administrator decides
which Bots may schedule future work at all, before deciding what that work is; a Bot with none of the
three tools can still be asked and will say it cannot.

The routine belongs to whoever asked for it and runs as them. See
[Who a routine runs as](#who-a-routine-runs-as).

## The 15-minute floor and the 20-enabled cap

A routine may fire at most every 15 minutes. The floor exists because a model can be talked into
anything a sentence can describe, including "every minute", and the floor is what a sentence cannot
talk its way past.

A person may have at most 20 routines switched on at once. The cap exists for the same reason as the
floor: a conversation is an easy place to accumulate standing work without noticing, and 20 is where a
person's own list stops being something they can hold in their head. Switching one off frees a slot;
deleting one is not required.

## The fatigue rule

A routine that fails posts exactly one message about it — the first failure after a success, not
every failure. Ten consecutive failures switch the routine off and post a second, final message
saying so; nothing further fires until a person turns it back on.

This is deliberately not a retry policy. A retry policy answers "did this one attempt make it through
a dispatch that failed for a moment" — a busy queue, a server that hiccuped — and that question is
already answered by the shared work queue's own attempt count, quietly, before a routine's turn ever
runs. The fatigue rule answers a different question: is this routine worth firing at all. A Notion
token that expired in March fails cleanly, once, every single night, and no number of retries of any
one night's attempt will fix that — only switching it off, and saying so, does.

## Missed windows are skipped, not replayed

A routine's next run is a stamp, not a queue. If nothing was watching the clock — a worker that was
never started, or one that was down for a month — a routine's stamp falls behind, and the deployment
does not owe it every occurrence it missed: catching up is a silent drain, not a burst. A deployment
whose worker comes back after a quiet month drains that backlog by advancing the stamp forward without
firing anything for it, occurrence by occurrence, until it is current again — not by firing thirty
stale summaries of thirty different mornings.

A firing that is still recent enough to be worth having does still happen. A server pod that restarts
loses at most the one occurrence that was in flight when it stopped; the next one fires on schedule,
because the clock had already moved on before that firing was attempted. A server that stays down
loses more than that: every occurrence whose stamp ages past the grace window while nothing can
carry it out is skipped, not just the one that was in flight.

## Overlap policy

Every routine defaults to **skip**: if its previous run is still active, the new occurrence is
recorded as skipped and no second turn starts. The edit dialog and the conversational tools can
change this to **queue one**. In that mode the first overlapping occurrence is retained durably;
later overlaps collapse into it, and the worker offers that one retained firing after the active run
ends. Pausing the routine cancels the retained firing, and a manual **Run now** remains a 409-style
refusal while either an active or retained run exists.

Scheduled work items and run rows carry the same firing identity. A retry can therefore recognize a
run it already opened and finish without dispatching the turn twice. The retained slot lives on the
routine row, is updated under the existing per-routine advisory lock, and contains only an internal
work key and scheduled timestamp — never the instruction or credentials.

The storage enum reserves **allow overlap**, but the current API and tools refuse selecting it and
the visual editor shows it as unavailable. A routine writes one durable conversation thread, whose
platform lock is exclusive; pretending to overlap would only create a second run that fails that lock.
True overlap requires an explicit product decision about separate thread identity, not a weakened
lock in the scheduler.

## The worker requirement

Nothing above happens without a second process. The API server answers `/internal/routines/run` when
it is handed a run, but nothing hands it one on its own — that is a separate worker's whole job, and a
deployment that never started one schedules nothing.

The Routines page shows the worker's durable heartbeat above the list. A recent successful sweep is
**operational**; the latest failed sweep or a heartbeat timestamp that cannot be trusted is
**unavailable**; a successful heartbeat older than twelve minutes is **stale**. No row is also
unavailable, so a deployment that never enabled the worker cannot look healthy merely because the API
server and routine list are available.

The worker writes that pulse only after the scheduling and dispatch phases finish. Both the pulse and
the time used to judge its age come from PostgreSQL, avoiding disagreement between a worker pod's
clock and an API pod's clock. The row contains no routine instructions, errors, credentials or host
names — only the last pass outcome and database timestamp.

Two settings carry this:

- **`WORKER_SHARED_SECRET`** — the credential the worker presents to `/internal/routines/run`. The API
  server refuses every handoff without it configured on both sides, and the worker refuses to start
  without it at all, rather than firing routines nobody could ever prove came from it.
- **`SERVER_INTERNAL_URL`** — where the worker reaches this deployment's own API server. It is a fact
  about where the worker process runs rather than a fact about the deployment, so it is read from the
  environment directly rather than from the rest of the deployment's configuration.

On Kubernetes, `routines.enabled` turns on a CronJob running `fire-routines.ts` on `routines.schedule`,
the same way the computer culler is a CronJob rather than a timer inside the API — a timer fires in
every replica, and a CronJob's single run does the whole sweep once. On a laptop, `scripts/start.sh`
starts a worker process that runs that same sweep in a loop instead of once and exiting, so the two
shapes are the same code doing the same thing on two different clocks, not two implementations to keep
in sync.

## Who a routine runs as

A routine runs as the person who created it, not as the Bot and not as an administrator. Its turn is
built with that person's own grants, so it can do in the middle of the night exactly what they could
do by typing the same instruction in chat themselves, and nothing more — a routine cannot reach a
connector its creator never connected, or post into a channel they are not in. Its reply is posted
into the channel as an ordinary message from that Bot: it lights the recipients' unread dot the same
way any other Bot message does, and it appears in the conversation transcript rather than anywhere
separate, because as far as the channel is concerned, that is exactly what it is.

## Scope

This ships the core: creating, listing, changing and deleting routines from chat; the schedule, the
cap and the fatigue rule; the worker that fires them. Four follow-ups are tracked in
[#193](https://github.com/CopilotKit/OpenBot/issues/193) and deliberately not in this pass: audit rows
are not yet marked as unattended, so telling a routine's action apart from the same person's own is a
manual correlation against `routine_runs` timestamps rather than a flag; there is no admin view of
other people's routines, only the owner-scoped page each person sees for their own; there is no
per-deployment or per-Bot cap on how many routines may be running at once beyond the sweep's own claim
limit; and a tenant package cannot yet ship routines the way it ships agents, channels or skills.

## See also

- [Architecture](architecture.md) — where the routines sweep sits beside the computer culler on the
  shared work queue.
- [Coworkers](coworkers.md) — durable Bot profiles and channels, which a routine posts into.
- [Configuration](configuration.md) — `WORKER_SHARED_SECRET`, `SERVER_INTERNAL_URL`.
