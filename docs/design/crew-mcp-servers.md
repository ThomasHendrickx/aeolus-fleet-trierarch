# Design: MCP servers a ship is crewed with (#120)

Status: approved by Thomas on 4 Nov (M1 to M7 each the first option, M8 the second).

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

## Decisions

Thomas answered M1 to M8 on 4 Nov. Each states what holds; the options he did not take follow it as rejected.

1. **M1, the purpose holds as written**: crew-time MCP servers, named when a ship is crewed, the same on every machine, the company graph first. The gateway route stays for Thomas's own access. Rejected: the gateway only for now; per machine only, through an option value.
2. **M2, a server is defined once, in the trierarch plugin's configuration**: one list for every machine (name, URL, transport, the tools a session may call), sent to every trierarch as the trusted repositories are. A request names a server by name. Rejected: each machine's configuration; the full definition in the crew settings.
3. **M3, a crew request names its servers in a new field of the crew settings' fixed core**, a list of names (`mcpServers: ["company-graph"]`), in `common`, decision 0027 amended, in templates' and roles' `crew` blocks and in the console's crew form. Rejected: an option per server (missed silently where undeclared); every listed server in every session.
4. **M4, a machine that cannot give a named server does not fit**: placement leaves it out, and a trierarch that finds out before the crew is final gives the request back with the server as the field at fault, as with a workspace it does not offer. A machine cannot when its harness has no way to add it, the server is not on its list, its credential is missing, or it cannot reach the server. Rejected: crewing without it and telling the owner.
5. **M5, credentials live in the trierarch plugin, a key-value store of secrets**, set by the operator through an installation procedure and sent to each trierarch sealed to a key that trierarch made at init, so core stores only what it cannot read. Each trierarch keeps them mode 600, as it keeps the API key. Rejected: a store on each machine; no credentials for now.
6. **M6, a session never sees a key or secret** (Thomas): the trierarch proxies each crew-time server, as the model proxy does. The session's MCP configuration points at the trierarch's proxy with a per-session token; the proxy adds the credential and forwards only to that server's URL. Rejected: the credential in the session's MCP configuration.
7. **M7, read-only is held by the definition**: each server on the list names the tools a session may call, and the trierarch's proxy lists and forwards only those, whatever the server offers. Rejected: trusting the server to run read-only; no read-only requirement.
8. **M8, every harness at once, remote servers over Streamable HTTP only**: Claude Code (`--mcp-config`), Codex (`-c mcp_servers.<name>...`) and Copilot (`--additional-mcp-config`), each pointed at the trierarch's proxy, on every runtime that offers the harness (Codex and Copilot run on the host only today). Whether Codex and Copilot take a remote HTTP server with a bearer header on the command line is unverified: the slice for each settles it, and a harness that cannot does not offer crew-time servers (M4). Rejected: Claude Code first; stdio commands.

## Size

Repositories that change:

| Repository | What |
| --- | --- |
| aeolus-fleet (core) | `mcpServers` in the crew settings' schema in `common`, decision 0027 amended, the console's crew form and crew request card, trierarch.md's crew request |
| aeolus-fleet-trierarch-plugin | The server list and the secret store in its configuration, sent to every trierarch; placement leaves out a machine that does not offer a named server |
| aeolus-fleet-trierarch (this) | Keep the list and the sealed secrets, report which servers each harness offers, check before crewing, the MCP proxy, start each harness with the named servers |
| aeolus-fleet-squadrons | `crew.mcpServers` in templates and roles, merged as the other fields |
| aeolus-fleet-infra | Not this design's build, Thomas's steps: aeolus-company on the tailnet with an ACL to the graph's MCP port, the graph's MCP server deployed |

The aeolus-fleet plugin changes nothing, unless the start context should name the crew-time servers (a one-line addition to the SessionStart hook, if wanted).

Slices, each one PR:

1. **core**: `mcpServers` in the crew settings, decision 0027 amended, the console shows and edits it. Release.
2. **trierarch plugin**: the server list in its configuration (name, URL, the tools a session may call), sent to every trierarch as the trusted repositories are, asked for at a trierarch's first pass.
3. **trierarch**: keeps the list, reports per harness which servers it offers, checks before it crews and gives back what it cannot give; raises `MINIMUM_CORE_VERSION`.
4. **trierarch plugin**: placement leaves out a machine whose report does not offer every named server, with the reason in needs-crew.
5. **trierarch**: the MCP proxy on the host, forwarding only the listed tools, no credential yet; Claude Code started with `--mcp-config` pointing at it per session. The company graph works end to end here once Thomas's network step is done.
6. **trierarch**: Claude Code in a container (the proxy at Podman's host address, as the model proxy is reached).
7. **trierarch**: Codex on the host, pointed at the proxy.
8. **trierarch**: Copilot on the host, pointed at the proxy.
9. **trierarch**: the trierarch's key pair at init, its public key in its report, sealed secrets received and kept, the proxy adding the credential.
10. **trierarch plugin**: the secret store, its installation procedure, sealing each secret to each trierarch's key and sending it.
11. **squadrons**: `crew.mcpServers` in templates and roles.

About 11 slices across 4 repositories, plus Thomas's infra step. The company graph is usable on Claude Code after slice 5; slices 7 to 11 can follow in any order once slice 5 is in.
