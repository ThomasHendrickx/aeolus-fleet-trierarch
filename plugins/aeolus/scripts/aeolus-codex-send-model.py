#!/usr/bin/env python3
"""Codex PreToolUse hook: state the active model on every Aeolus send."""

from __future__ import annotations

import json
import sys
from typing import Any


def main() -> None:
    payload: dict[str, Any] = json.load(sys.stdin)
    model = payload.get("model")
    tool_input = payload.get("tool_input")
    if not isinstance(model, str) or not model or not isinstance(tool_input, dict):
        raise SystemExit("aeolus: Codex send hook received no model or tool input")

    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "updatedInput": {**tool_input, "model": model},
                }
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
