# Design: MCP servers a ship is crewed with (#120)

Status: questions open for Thomas. Nothing below is decided until he answers; the purpose comes first (M1).

## Purpose

What a ship brings to its work (its tools, its knowledge) is set when it is crewed, versioned and reusable: every session of a template starts with the same read-only knowledge MCP servers from its first turn, on any machine whose trierarch crews it. The first is the company graph (aeolus-fleet-infra#142): Thomas wants it "both an mcp directly embedded in the sessions managed by trierarch AND a ship through gateway". The gateway route is live; this design is the embedded route.

Done when a template names the company graph and every member a trierarch crews has its tools at its first turn, with no credential in the crew request, the template or the fleet, and a machine that cannot give it does not crew it.

## Lessons to check against

### How a session gets its MCP servers today

The trierarch adds none. A session has what its harness reads by itself:

| Source | Claude Code | Codex | Copilot |
| --- | --- | --- | --- |
| The user's own servers | `mcpServers` in `~/.claude.json` (user scope): every session of that user on the host; in a container, the ship's own home, which the trierarch prepares and adds no server to | `[mcp_servers.<name>]` in `~/.codex/config.toml` | `~/.copilot/mcp-config.json` |
| The folder | `.mcp.json` in the repository (project scope), and the local scope keyed by the folder's path in `~/.claude.json`. Whether a headless `claude -p` uses an unapproved project server: unverified | `.codex/config.toml` in a trusted project: unverified | unverified |
| A plugin | a plugin's `.mcp.json`; the aeolus-fleet plugin ships none (it reaches the fleet over REST through its scripts) | the same for Codex plugins | the same |
| The command line | `--mcp-config <file or JSON>`, with `--strict-mcp-config` to use only those | `-c mcp_servers.<name>.<key>=<value>` | `--additional-mcp-config` |
| The account | claude.ai connectors of the signed-in account: this very session, started by a trierarch on the host on the subscription, has the account's connectors. Every session of that account gets every connector, per account, not per template. On an API key or in a container on the setup token: unverified | none | none |

- **The machine's flags already reach `--mcp-config`.** The local configuration gives each harness its flags and named options, each option value a list of flags (`config.schema.json`, `harnesses.<harness>.options.<name>.values`). An operator can define today an option `knowledge` whose value `company-graph` is `["--mcp-config", "<a file on that machine>"]`, and a template can set `options.knowledge: company-graph`. No code changes, but: each machine defines it by hand and may define it differently; one option is one value, so two servers need one combined value; an option a machine does not declare is ignored (decision 0027), so a machine without it crews the session without the server, silently; in a container the file must be inside what the container mounts; and the subscription check reads `--settings`, not `--mcp-config`.
- **A session's environment is built from nothing** (`HOME`, `PATH`, `USER`, `LOGNAME`, `AEOLUS_LAUNCH`, trierarch.md "Session runtime"): a server that needs a credential from the environment gets none.
- **A container sees** its workspace, its own home, its socket folder, the model login and its repository's key (trierarch.md, "In a container"), with the network of `slirp4netns`. A server reachable from the host only by a private address may not be reachable from the container: unverified.
- **No hook adds a server mid-session**: the SessionStart hook writes context, not configuration. A server has to be there at the harness's start, which the trierarch owns.

### What the crew request and its settings carry

- **A fixed core, no paths, no flags** (decision 0027): harness, workspace, squadron, first prompt, options, machine labels. Options pick named settings of the machine. The schema lives in `common`; the server refuses settings that are not crew settings.
- **Placement checks options against each machine's reported schema**; a trierarch checks again before it crews. A declared option with a value the harness does not offer does not fit (#366); an undeclared one is ignored, so a template can carry `effort` to Codex without blocking placement.
- **A workspace names a repository or folder the machine configures, or one on the trierarch plugin's trusted repositories**: one list in the trierarch plugin's configuration, sent whole to every trierarch, taken only from the trierarch plugin's ship, kept in `~/.aeolus/trierarch/trusted-repositories.json`. That is the one place today where something is defined once for every machine.
- **Templates are versioned** (squadrons.md): a template's `crew` block carries the settings' fields (`harness`, `model`, `workspace`, `firstPrompt`, `options`, `machineLabels`), each version a git tag, snapshotted at forming. Role settings replace the template's field whole, except `options`, which merge per key. The console's Edit writes a new settings version of any crew request too.
- **Read-only checkouts** (#1182) are the nearest precedent for "knowledge every session of a repository gets": named in the machine's configuration only, never in a request, so placement never reads them.

### What core's docs/compatibility.md allows

- The trierarch calls `ship/*` and `fleet/ship`, `getStartingPrompt`, `assignedCrewRequests`, `giveBackCrewRequest`, `reportCrewStatus`, `confirmCrewRelease`, `clearRequests`, `confirmWorktreeCleared`, `release`. The trierarch plugin calls, among others, `assignCrew`, `explainCrewRequest`, `send`.
- Every package builds against `common`, whose schemas are the shapes of crew settings (decision 0027). A new field in the settings is a core change: `common`, decision 0027, the console's crew form, and each package raises its minimum core version. Anything carried as an option, or as a message between the trierarch plugin and its trierarchs (as trusted repositories are), needs no new core call.
- Payloads and statements up to 256 KB need the core release with aeolus-fleet#1418.

### Credentials today

- **Never in the fleet**: no credential travels in a request or the fleet (trusted repositories, cloned "with the machine's own access only"). The API key is never in `config.json`, a crew request, the report, a log line, a session's environment, a container or the fleet (trierarch.md, "API keys"). Fleet messages are stored by core, so a secret in a message is a secret in the fleet.
- **On the machine**: the API key in `~/.aeolus/trierarch/keys/<harness>`, the model token in `~/.aeolus/trierarch/model-token`, both mode 600, read from stdin, never a flag. A repository's key is configured per repository and mounted only into that repository's containers.
- **The session never sees the key**: the model proxy takes a per-session token and sends the key instead. That is the pattern a credential for an MCP server could follow.
- **The company graph needs none today**: the research (aeolus-fleet-infra#142) puts `mcp-neo4j-cypher` on aeolus-company's private address with no login of its own, the gateway adding it as an outside party with credential `none`. Its direct route needs agent-host-1 and the Mac mini on aeolus-company's network first (the tailnet and an ACL to the MCP port only), Thomas's step. Neo4j Community has no read-only role; `NEO4J_READ_ONLY=true` on the server removes its write tool.
- **Thomas's note** on this issue: the trierarch plugin as a key-value store for secrets.

## Questions for Thomas

Each with options and my pick. M1 first: the others wait on it.

### M1. Is the purpose right?

1. **As written**: crew-time MCP servers, named when a ship is crewed, the same on every machine, starting with the company graph. *(my pick: it is what the issue and aeolus-fleet-infra#142 say, and the gateway route stays for Thomas's own access)*
2. **Gateway only for now**: ships use the company graph through the gateway's proxy ship, as aeolus-fleet-infra#142 recommends (its option c); this design waits until a ship needs the graph without the gateway's wait.
3. **Per machine only**: document the option route that works today (`--mcp-config` in an option value, per machine), build nothing.

### M2. Where is a server defined (its URL, transport, the tools it offers)?

1. **In the trierarch plugin's configuration, one list for every machine**, sent to every trierarch as the trusted repositories are; a request names a server by name. *(my pick: defined once and true on every machine, the shape the trusted repositories already proved, and no URL in a request or a template)*
2. **In each machine's configuration**, as repositories and read-only checkouts are; a request names it by name. Each machine defines it by hand.
3. **In the crew settings themselves**, the full definition in the template. Versioned with the template, but a definition in a request and in the fleet, and a template that knows URLs.

### M3. How does a crew request name its servers?

1. **A new field of the crew settings' fixed core**, a list of server names (`mcpServers: ["company-graph"]`), in `common`, decision 0027 amended, in templates' and roles' `crew` blocks and in the console's crew form. *(my pick: the issue asks for a crew setting, a list holds several servers, and placement can refuse what a machine cannot give)*
2. **An option**, one per server (`options.company-graph: on`) or one option for a set. No core change, but an option a machine does not declare is ignored, so a session can start without its server silently.
3. **Not in the request**: every session a machine starts gets every server the list names, as every session of an account gets every connector.

### M4. What when a machine cannot give a named server?

A machine cannot when its harness has no way to add it, the server is not on its list, its credential is missing, or the trierarch cannot reach it.

1. **It does not fit**: placement leaves the machine out, and a trierarch that finds out before the crew is final gives the request back with the server as the field at fault, as with a workspace it does not offer. *(my pick: "from its first turn" is the purpose; a session without its knowledge works on a guess)*
2. **It crews without it** and tells the ship's owner once per settings version.

### M5. Where do the credentials of a crew-time server live?

1. **In the trierarch plugin, a key-value store of secrets** (Thomas's note), set by the operator through an installation procedure and sent to each trierarch sealed to a key that trierarch made at init, so core stores only what it cannot read; each trierarch keeps them mode 600 as it keeps the API key. *(my pick: one place for every machine, as the server list is, and nothing readable in the fleet)*
2. **On each machine**, `aeolus-trierarch secret set <name>` from stdin, mode 600, as `login --api-key` keeps a key; the operator sets it on every machine.
3. **None for now**: the first servers have no credential (the company graph on a private network guarded by the tailnet ACL); credentials get their own design when a server needs one.

### M6. Does the session see a server's credential?

1. **No: the trierarch proxies each crew-time server**, as the model proxy does: the session's MCP configuration points at the trierarch's proxy with a per-session token, and the proxy adds the credential and forwards only to that server's URL. *(my pick: the API key lesson; the session can read its own configuration, so a credential written there is a credential the model holds)*
2. **Yes: the credential is written into the session's MCP configuration** (a header or an environment variable of the server), readable by the session.

### M7. How is "read-only" held?

1. **By the definition**: each server on the list names the tools a session may call, and the trierarch's proxy (M6, option 1) lists and forwards only those. *(my pick: the trierarch can hold it whatever the server offers, and the company graph's write tool stays out)*
2. **By the server**: the operator runs it read-only (`NEO4J_READ_ONLY=true`), the trierarch adds it as it is.
3. **Not required**: a crew-time server may be any server.

### M8. Which harnesses and transports first?

1. **Claude Code, on the host and in a container, remote servers over Streamable HTTP only**; Codex and Copilot do not fit a request that names a server until each follows. *(my pick: the company graph is remote HTTP, and Claude Code is what crews today's templates; a stdio server needs a command installed on every machine and in the image)*
2. **Every harness at once**, remote HTTP only.
3. **Claude Code, remote HTTP and stdio** commands installed on the machine.

## Size

With my picks. Repositories that change:

| Repository | What |
| --- | --- |
| aeolus-fleet (core) | `mcpServers` in the crew settings' schema in `common`, decision 0027 amended, the console's crew form and crew request card, trierarch.md's crew request |
| aeolus-fleet-trierarch-plugin | The server list and the secret store in its configuration, sent to every trierarch; placement leaves out a machine that does not offer a named server |
| aeolus-fleet-trierarch (this) | Keep the list and the sealed secrets, report which servers each harness offers, check before crewing, the MCP proxy, start Claude Code with the named servers on the host and in a container |
| aeolus-fleet-squadrons | `crew.mcpServers` in templates and roles, merged as the other fields |
| aeolus-fleet-infra | Not this design's build, Thomas's steps: aeolus-company on the tailnet with an ACL to the graph's MCP port, the graph's MCP server deployed |

The aeolus-fleet plugin changes nothing, unless the start context should name the crew-time servers (a one-line addition to the SessionStart hook, if wanted).

Slices, each one PR:

1. **core**: `mcpServers` in the crew settings, decision 0027 amended, the console shows and edits it. Release.
2. **trierarch plugin**: the server list in its configuration (name, URL, the tools a session may call), sent to every trierarch as the trusted repositories are, asked for at a trierarch's first pass.
3. **trierarch**: keeps the list, reports per harness which servers it offers, checks before it crews and gives back what it cannot give; raises `MINIMUM_CORE_VERSION`.
4. **trierarch plugin**: placement leaves out a machine whose report does not offer every named server, with the reason in needs-crew.
5. **trierarch**: the MCP proxy on the host, Claude Code started with `--mcp-config` pointing at it per session, only the listed tools, no credential yet. The company graph works end to end here once Thomas's network step is done.
6. **trierarch**: the same in a container (the proxy at Podman's host address, as the model proxy is reached).
7. **trierarch plugin and trierarch**: the secret store and sealed delivery (the trierarch's key pair at init and in its report, the operator's installation procedure, the proxy adding the credential). Likely two slices, one per repository.
8. **squadrons**: `crew.mcpServers` in templates and roles.

About 9 slices across 4 repositories, plus Thomas's infra step. Without credentials (M5, option 3) it is 7, and the company graph is usable after slice 5; with the option route (M3, option 2) slices 1 and 8 go and slice 4 shrinks, at the cost of the silent miss M3 names.
