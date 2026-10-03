#!/usr/bin/env bash
# How to connect this session to the fleet's MCP server, for when it has none
# of the fleet's tools. A claude.ai cloud session (CLAUDE_CODE_REMOTE=true)
# gets its MCP servers from claude.ai connectors, so claude mcp add does not
# reach it there.
#
#   aeolus-mcp-hint.sh <fleetUrl>
set -euo pipefail

[ "$#" -eq 1 ] || { echo "usage: aeolus-mcp-hint.sh <fleetUrl>" >&2; exit 2; }
mcp_url="${1%/}/mcp"

if [ "${AEOLUS_HARNESS:-}" = "codex" ]; then
  echo "Add the fleet MCP server once, then start a new Codex task in this folder and paste the Codex crew line again:"
  echo "codex mcp add aeolus --url ${mcp_url}"
elif [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  echo "This is a claude.ai cloud session: its MCP servers come from claude.ai connectors, not from claude mcp add."
  echo "Add a custom connector in claude.ai (Settings, Connectors) with the URL ${mcp_url},"
  echo "then start a new cloud session and paste the crew line again."
else
  echo "Add the fleet MCP server once, then start a new session in this folder and paste the crew line again:"
  echo "claude mcp add --transport http --scope user aeolus ${mcp_url}"
fi
