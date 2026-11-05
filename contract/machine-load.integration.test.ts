import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { aCrewingMachine } from "./support/crewing.js";
import { aFleet, type Fleet } from "./support/fleet.js";
import { aMachine, type Machine } from "./support/machine.js";

// The machine's load (docs/trierarch.md, "What a trierarch reports"): argo is told once when memory or disk runs low, and what it was told is kept in the state. A test machine cannot be made short of memory or disk from outside, so what the suite holds is the part a healthy machine shows: the state of a machine that recovered is cleared, and argo is told nothing.

const SAVED_WITHIN_MS = 30_000;

let fleet: Fleet;
let machine: Machine;

beforeEach(async () => {
  fleet = await aFleet();
  machine = await aMachine();
  await aCrewingMachine({ fleet, machine });
});

afterEach(async ({ task }) => {
  if (task.result?.state === "fail") {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

const stateFile = (): string => join(machine.trierarchHome, "state.json");
const lowResourcesOf = (): unknown =>
  z
    .looseObject({ lowResources: z.array(z.string()).optional() })
    .parse(JSON.parse(readFileSync(stateFile(), "utf8"))).lowResources;

describe("a machine that is not low", () => {
  it("forgets what argo was told it was low on, and tells argo nothing", async () => {
    await machine.trierarch(["stop"]);
    const state: unknown = JSON.parse(readFileSync(stateFile(), "utf8"));
    writeFileSync(
      stateFile(),
      `${JSON.stringify({ ...z.looseObject({}).parse(state), lowResources: ["memory", "disk"] }, null, 2)}\n`,
    );
    await machine.trierarch(["start"]);

    await expect
      .poll(lowResourcesOf, { timeout: SAVED_WITHIN_MS })
      .toBeUndefined();
    expect(
      (await fleet.toldByTrierarch()).filter(({ text }) =>
        text.startsWith("Low on "),
      ),
    ).toEqual([]);
  });
});
