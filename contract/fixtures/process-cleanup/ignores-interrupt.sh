#!/bin/bash
if [ "$1" = follow ]; then
  exec node -e 'process.on("SIGINT", () => {}); process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.env.HOME + "/command.pid", String(process.pid)); setInterval(() => {}, 1000);'
fi
exit 0
