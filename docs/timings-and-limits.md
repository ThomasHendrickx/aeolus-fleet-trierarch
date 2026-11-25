# Timings and limits

Every fixed timing and limit of the trierarch and the aeolus-fleet plugin, for debugging. This page holds no rules of its own: each line points to the constant that sets it and the decision, issue or doc that says why. When a value here and its source disagree, the source wins; fix this page. The limits every package shares, from `@aeolus-fleet/common`, are in aeolus-fleet's [timings and limits](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/timings-and-limits.md).

A default that configuration may change names its setting.

`AEOLUS_TRIERARCH_TEST_TIMING_DIVISOR`, a whole number above one, is a setting only the contract suite uses: it divides each timing below that names it, and the service's environment carries it from where `init` ran. Without it, or with any other value, every timing is its production value.

## Trierarch

| Value | What it guards | Set in | Behind |
| --- | --- | --- | --- |
| 1 minute | A session's launch window: a tool call within it, or it is stopped and given back (or counted as a failed start) | [`cli`](../go/internal/cli) `LAUNCH_WINDOW_MS` | [trierarch.md](trierarch.md#crewing-a-ship), ThomasHendrickx/aeolus-fleet#382, ThomasHendrickx/aeolus-fleet#397, ThomasHendrickx/aeolus-fleet#473 |
| 10 minutes (coming, not built yet) | The oldest delivery waiting while a session runs, before argo is told the session is waiting on chat | not built yet | ThomasHendrickx/aeolus-fleet#586 |
| 5 s, 30 s, 2 min, then 10 min | The wait before each restart of a session that died; the contract suite's `AEOLUS_TRIERARCH_TEST_TIMING_DIVISOR` divides the first | [`reconciler`](../go/internal/reconciler) `RestartDelays`, the first divided in [`timings`](../go/internal/timings) | [architecture.md](architecture.md), [0026](decisions/0026-trierarch.md) |
| 5 restarts within 60 minutes | The restart budget; past it the crew is crashed and argo told | [`reconciler`](../go/internal/reconciler) `RESTART_BUDGET`, `RESTART_WINDOW_MS` | [0026](decisions/0026-trierarch.md), ThomasHendrickx/aeolus-fleet#397, ThomasHendrickx/aeolus-fleet#469 |
| 5 s | A pass: restarts, wakes, releases and the launch window run at most this often; also the pause after a failure; the contract suite's `AEOLUS_TRIERARCH_TEST_TIMING_DIVISOR` divides it | [`timings`](../go/internal/timings) `PassInterval` | ThomasHendrickx/aeolus-fleet#250 |
| 10 s | `init` waits for the service to keep one process this long before it reports success; the contract suite's `AEOLUS_TRIERARCH_TEST_TIMING_DIVISOR` divides it | [`timings`](../go/internal/timings) `InitStability` | none recorded |
| 10 minutes | Each ship folder measured at most this often, outside the pass | [`workspace`](../go/internal/workspace) `SHIP_SIZE_INTERVAL_MS` | [disk design](design/disk-under-control.md), #351 |
| `shipSizeBytes` in the machine configuration, absent by default | A ship folder size in bytes above which its owner is told once per crossing | [`config`](../go/internal/config) `trierarchConfigurationSchema` | [disk design](design/disk-under-control.md), #351 |
| Off unless configured; `cacheSizeBytes` bytes | The host sessions' shared cache size; checked at most hourly, with units modified within the last hour kept | [`trash`](../go/internal/trash) `HOUR_MS`; [`config`](../go/internal/config) | [disk design](design/disk-under-control.md), #349 |
| 1 minute | The machine's load read at most this often | [`machineload`](../go/internal/machineload) `LOAD_READ_INTERVAL_MS` | [trierarch.md](trierarch.md#what-a-trierarch-reports), ThomasHendrickx/aeolus-fleet#400 |
| 5 points of use; half a load per core | How far memory, swap and disk, and the CPU load, move before the report goes again for them | [`machineload`](../go/internal/machineload) `USE_STEP_PERCENT`, `LOAD_PER_CORE_STEP` | [trierarch.md](trierarch.md#what-a-trierarch-reports), ThomasHendrickx/aeolus-fleet#400 |
| below 10 % memory available, 5 % disk free | The machine is low, and argo is told once per drop | [`machineload`](../go/internal/machineload) `LOW_MEMORY_PERCENT`, `LOW_DISK_PERCENT` | [trierarch.md](trierarch.md#what-a-trierarch-reports), ThomasHendrickx/aeolus-fleet#400 |
| 5 minutes | Each crewed ship's tokens read from its transcripts at most this often | [`usage`](../go/internal/usage) `TOKENS_READ_INTERVAL_MS` | [trierarch.md](trierarch.md#what-a-trierarch-reports), ThomasHendrickx/aeolus-fleet#353 |
| 30 minutes, and only after work since | A harness's subscription read again; Claude Code's is a print-mode turn | [`usage`](../go/internal/usage) `SUBSCRIPTION_READ_INTERVAL_MS` | [trierarch.md](trierarch.md#what-a-trierarch-reports), ThomasHendrickx/aeolus-fleet#353 |
| an hour, at the first pass after it turns | The usage sent to the trierarch plugin's ship: the hours changed since the last send that returned OK | [`usage`](../go/internal/usage) | [trierarch.md](trierarch.md#what-a-trierarch-reports), aeolus-fleet's usage design |
| 64 KB | A usage message at most; a send over it goes as several messages of whole hours | [`usage`](../go/internal/usage) `MESSAGE_MAX_BYTES` | aeolus-fleet's usage design |
| 60 s | Claude Code's subscription turn | [`claudecode`](../go/internal/claudecode), with `CLAUDE_CODE_PROBE_TIMEOUT_MS` | ThomasHendrickx/aeolus-fleet#353 |
| 10 newest session logs | Searched for Codex's subscription windows | [`codex`](../go/internal/codex) `NEWEST_LOGS_SEARCHED` | ThomasHendrickx/aeolus-fleet#353 |
| 10 | Deliveries per receive of the trierarch's own ship | [`fleet`](../go/internal/fleet) (inline `max: 10`) | [architecture.md](architecture.md) |
| 10 s | A hold waits for an interrupted turn's result (Claude Code) or its process's end (Codex) before the forced line is sent, and for the last Codex turn's process to end before a line's turn starts; a Codex process still running then is killed | [`hold`](../go/internal/hold) `INTERRUPT_WAIT_MS` | [trierarch.md](trierarch.md#crewing-a-ship), the headless design (H12), decision 0040 |
| 10 s | A started hold has to answer its first call | [`hold`](../go/internal/hold) `START_WAIT_MS` | the headless design (H8) |
| 5 s | A stopped hold has to end with its harness before it is killed | [`hold`](../go/internal/hold) `STOP_WAIT_MS` | the headless design (H8) |
| 2 s | A hold has to answer a call other than interrupt and send (`state`); interrupt and send have the 10 s wait above on top | [`hold`](../go/internal/hold) `CALL_TIMEOUT_MS` | the headless design (H9) |
| 60 s | Claude Code's model probe | [`detection`](../go/internal/detection) `CLAUDE_CODE_PROBE_TIMEOUT_MS` | none recorded |
| 10 s | Claude Code's `--version` and `--help` | [`detection`](../go/internal/detection) `QUICK_TIMEOUT_MS` | none recorded |
| 60 s | Codex's model probe | [`detection`](../go/internal/detection) `CODEX_PROBE_TIMEOUT_MS` | none recorded |
| 10 s | Codex's `--version` and `debug models` | [`detection`](../go/internal/detection) `QUICK_TIMEOUT_MS` | none recorded |
| 30 s | `codex app-server` answering during trust setup | [`codex`](../go/internal/codex) `ANSWER_TIMEOUT_MS` | ThomasHendrickx/aeolus-fleet#581 |
| 3 | Times Claude Code's fullscreen offer counts as seen | [`claudecode`](../go/internal/claudecode) `FULLSCREEN_OFFER_SHOWN_MAX` | [trierarch.md](trierarch.md#unattended), ThomasHendrickx/aeolus-fleet#403 |
| at most 30 s, checked each second | Waiting for a new process to write its version after restart, install, add or upgrade | [`service`](../go/internal/service) `TIMEOUT_MS`, `CHECK_MS` | [architecture.md](architecture.md), ThomasHendrickx/aeolus-fleet#376 |
| 30 checks a second apart | Waiting for the launchd agent to be gone on stop or install | [`service`](../go/internal/service) `STOP_CHECKS`, `STOP_CHECK_MS` | none recorded |
| 5 s | systemd restarting the trierarch service (`RestartSec`) | [`service`](../go/internal/service) (unit template) | none recorded |
| at least 60 s | A Codex plugin version folder is removed only when every running session started this long after the next version arrived | [`cli`](../go/internal/cli) `START_MARGIN_MS` | [trierarch.md](trierarch.md#a-machine-joins), ThomasHendrickx/aeolus-fleet#653 |
| 10 MB, one rotated file | A session hold's event log | [`hold`](../go/internal/hold/events.go) `eventLogLimit` | The headless design (H14), ThomasHendrickx/aeolus-fleet#1467 |
| 1 MiB, one rotated file | The macOS log (the journal caps it on Linux) | [`logfile`](../go/internal/logfile) `LOG_MAX_BYTES` | [trierarch.md](trierarch.md#a-machine-joins) |
| 60 s | A rotation lock older than this is stale | [`logfile`](../go/internal/logfile) `STALE_LOCK_MS` | none recorded |
| 50 lines; followed every 500 ms on macOS | `logs` | [`cli`](../go/internal/cli) `DEFAULT_LINES`, `FOLLOW_INTERVAL_MS` | none recorded |
| 5 lines | What a release discards that the report to argo names; the trierarch's log holds them all | [`selfreport`](../go/internal/selfreport) `DISCARDED_NAMED_MAX` | [trierarch.md](trierarch.md#lifecycles), ThomasHendrickx/aeolus-fleet#450, ThomasHendrickx/aeolus-fleet#849 |
| 200 lines | The last event lines read from a session | [`hold`](../go/internal/hold) `EVENT_LINES` | the headless design (H13) |
| 4 ships, 2 running (written by `init`, whole numbers of at least 1) | The machine's caps, set in its configuration | [`config`](../go/internal/config) `initialConfiguration`; [common trierarch/configuration.ts](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/packages/common/src/trierarch/configuration.ts) | [0026](decisions/0026-trierarch.md), [trierarch.md](trierarch.md#what-a-trierarch-reports) |
| per container, from the configuration's `runtime.memory` and `runtime.cpus` | A container session's memory and CPUs | [common trierarch/configuration.ts](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/packages/common/src/trierarch/configuration.ts); [`cli`](../go/internal/cli); [`container`](../go/internal/container) `ContainerRuntimeOptions` | [0039](decisions/0039-container-sessions.md) |
| 4096 processes and threads per container | A container session's processes, so a runaway fork cannot starve the machine | [`container`](../go/internal/container) `PIDS_LIMIT` | [0039](decisions/0039-container-sessions.md) |
| 0.23.0 | The first release with a plugin, for `upgrade` | [`cli`](../go/internal/cli) `FIRST_PLUGIN_TAG` | [trierarch.md](trierarch.md#a-machine-joins), ThomasHendrickx/aeolus-fleet#652 |

## The aeolus-fleet plugin

Each setting below is an environment variable the script reads, with the default shown.

| Value | What it guards | Set in | Behind |
| --- | --- | --- | --- |
| 60 s | Stream silence before reconnecting; every byte, including a keep-alive, resets it | [aeolus-wait.sh](../plugins/aeolus-fleet/scripts/aeolus-wait.sh) `AEOLUS_STREAM_SILENCE_SECONDS` | fleet wake stream |
| 300 s | Safety look without a wake | [aeolus-wait.sh](../plugins/aeolus-fleet/scripts/aeolus-wait.sh) `AEOLUS_SAFETY_SECONDS` | fleet wake stream |
| 5 s | Between inbox checks while deliveries wait and the turn is busy | [aeolus-wait.sh](../plugins/aeolus-fleet/scripts/aeolus-wait.sh) `AEOLUS_POLL_SECONDS` | [plugin README](../plugins/aeolus-fleet/README.md) |
| random 1 to 5 s, doubling, at most 60 s | The watcher calling again after a failed call or stream open; a successful answer resets the spread | [aeolus-wait.sh](../plugins/aeolus-fleet/scripts/aeolus-wait.sh) `AEOLUS_RETRY_SECONDS`, `AEOLUS_RETRY_MAX_SECONDS` | none recorded |
| 5 s, doubling, at most 300 s | The watcher, and the trierarch's hand-over through `aeolus-push.sh`, asking again after the fleet refused a push receive with KEY_UNAVAILABLE (its key cut off): the fleet's key cache lasts 5 minutes | [aeolus-wait.sh](../plugins/aeolus-fleet/scripts/aeolus-wait.sh), [aeolus-push.sh](../plugins/aeolus-fleet/scripts/aeolus-push.sh) `AEOLUS_KEY_WAIT_SECONDS`, `AEOLUS_KEY_WAIT_MAX_SECONDS` | decision 0068 |
| 5 s, doubling, at most 300 s | The trierarch's receive for its own ship, after KEY_UNAVAILABLE | [`cli`](../go/internal/cli) `KEY_WAIT_MAX_MS` | decision 0068 |
| 6900 s (1 h 55 min) | The watcher stops ("for almost 2 hours", exit 6); no limit under the Codex wake bridge | [aeolus-wait.sh](../plugins/aeolus-fleet/scripts/aeolus-wait.sh) `AEOLUS_MAX_SECONDS`; [aeolus-codex-wake.sh](../plugins/aeolus-fleet/scripts/aeolus-codex-wake.sh) | [plugin README](../plugins/aeolus-fleet/README.md) |
| 60 s | Each watcher inbox, pushReceive and handed call (`curl --max-time`) | [aeolus-wait.sh](../plugins/aeolus-fleet/scripts/aeolus-wait.sh) `AEOLUS_CALL_MAX_SECONDS` | fleet wake stream |
| 60 s | Every `aeolus-fleet.sh` call (`curl --max-time`) | [aeolus-fleet.sh](../plugins/aeolus-fleet/scripts/aeolus-fleet.sh) `AEOLUS_CALL_MAX_SECONDS` | none recorded |
| 3 s | Each ack a hook makes to confirm a handed message, so its busy retries end inside a hook's time | [aeolus-lib.sh](../plugins/aeolus-fleet/scripts/aeolus-lib.sh) `AEOLUS_CONFIRM_SECONDS` | ThomasHendrickx/aeolus-fleet#756 (3.9) |
| 10,000 bytes | The most a hook puts into a turn: Claude Code's cap on hook context. A longer message goes in as its first part and the path of a file that holds the payload | [aeolus-lib.sh](../plugins/aeolus-fleet/scripts/aeolus-lib.sh) `AEOLUS_TURN_TEXT_MAX_BYTES` | ThomasHendrickx/aeolus-fleet#756 (D2) |
| 8000 bytes | That first part of a longer payload | [aeolus-lib.sh](../plugins/aeolus-fleet/scripts/aeolus-lib.sh) `AEOLUS_FIRST_PART_BYTES` | ThomasHendrickx/aeolus-fleet#756 (D2) |
| 1, 2, 4, 8 s, each drawn between half and all of it | REST calls, including the watcher inbox, pushReceive and handed, retrying while the fleet answers busy, a copy of `FLEET_BUSY_WAITS_MS` | [aeolus-fleet.sh](../plugins/aeolus-fleet/scripts/aeolus-fleet.sh), [aeolus-wait.sh](../plugins/aeolus-fleet/scripts/aeolus-wait.sh) `AEOLUS_BUSY_WAITS`, `AEOLUS_BUSY_DRAW` | [aeolus-fleet's architecture.md](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/architecture.md), ThomasHendrickx/aeolus-fleet#734 |
| 15 s | The inbox script's call (`curl --max-time`) | [aeolus-inbox.sh](../plugins/aeolus-fleet/scripts/aeolus-inbox.sh) (inline) | none recorded |
| 1 MiB, one rotated file | The plugin's log | [aeolus-lib.sh](../plugins/aeolus-fleet/scripts/aeolus-lib.sh) `AEOLUS_LOG_MAX_BYTES` | [plugin README](../plugins/aeolus-fleet/README.md), [trierarch.md](trierarch.md#a-machine-joins) |
| 1 minute | A log rotation lock older than this is stale | [aeolus-lib.sh](../plugins/aeolus-fleet/scripts/aeolus-lib.sh) (inline `-mmin +1`) | none recorded |
| 6000 characters | A prefilled issue link's encoded body (GitHub refuses past about 8 KB) | [aeolus-issue.sh](../plugins/aeolus-fleet/scripts/aeolus-issue.sh) `LINK_BODY_MAX` | none recorded |
