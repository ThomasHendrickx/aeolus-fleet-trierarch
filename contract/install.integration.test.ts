import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// install and install --no-load, run as a program (docs/trierarch.md, "The service").

let fleet: Fleet;
let machine: Machine;

beforeEach(async () => {
  fleet = await aFleet();
  machine = await aMachine();
});

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

const unit = (): string => join(machine.home, '.config', 'systemd', 'user', 'aeolus-trierarch.service');

describe('install --no-load', () => {
  it("writes the service's file and the configuration's JSON Schema, and starts nothing", async () => {
    const install = await machine.trierarch(['install', '--no-load']);

    expect(install.status, install.stdout + install.stderr).toBe(0);
    expect(install.stdout).toContain(`Installed ${unit()}. Logs: ${join(machine.trierarchHome, 'logs')}`);
    expect(readFileSync(unit(), 'utf8')).toContain('run\n');
    expect(JSON.parse(readFileSync(join(machine.trierarchHome, 'config.schema.json'), 'utf8'))).toMatchObject({ type: 'object' });
    expect(machine.servicePid()).toBeUndefined();
  });

  it('answers the service as JSON: installed, not running', async () => {
    const install = await machine.trierarch(['install', '--no-load', '--json']);

    expect(install.status, install.stdout + install.stderr).toBe(0);
    expect(JSON.parse(install.stdout)).toEqual({ file: unit(), isInstalled: true, isRunning: false });
  });
});

describe('install', () => {
  it('loads the service and starts it: the new trierarch runs and the answer is its status', async () => {
    await machine.trierarch(['init', '--fleet-url', fleet.url, '--ship-id', fleet.trierarchShip.shipId, '--secret', fleet.trierarchShip.secret, '--yes']);
    const before = machine.servicePid();

    const install = await machine.trierarch(['install', '--json']);

    expect(install.status, install.stdout + install.stderr).toBe(0);
    expect(machine.servicePid()).not.toBe(before);
    expect(JSON.parse(install.stdout)).toMatchObject({ file: unit(), isInstalled: true, isRunning: true, pid: machine.servicePid() });
  });

  it('says where the file and the logs are', async () => {
    await machine.trierarch(['init', '--fleet-url', fleet.url, '--ship-id', fleet.trierarchShip.shipId, '--secret', fleet.trierarchShip.secret, '--yes']);

    const install = await machine.trierarch(['install']);

    expect(install.stdout).toContain(`Installed ${unit()}. Logs: ${join(machine.trierarchHome, 'logs')}`);
    expect(existsSync(unit())).toBe(true);
  });
});
