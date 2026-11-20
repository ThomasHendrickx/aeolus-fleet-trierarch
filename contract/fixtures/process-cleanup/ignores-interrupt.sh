#!/bin/bash
if [ "$1" = follow ]; then
  exec node -e 'process.on("SIGINT", () => { if (process.argv[1] === "exit") process.exit(0); }); process.on("SIGTERM", () => {}); const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(process.env.HOME + "/command.pid", JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000);' "$2"
fi
exit 0
