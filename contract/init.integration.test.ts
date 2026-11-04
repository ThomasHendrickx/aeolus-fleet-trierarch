import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// init and add, run as a program on a machine with Claude Code signed in, against a fleet in process (docs/trierarch.md, "A machine joins").

let fleet: Fleet;
let machine: Machine;

beforeEach(async () => {
  fleet = await aFleet();
  machine = await aMachine();
});

afterEach(async () => {
  await machine.remove();
  await fleet.close();
});

/** The setup line the trierarch plugin gives, with --yes: it asks nothing. */
function setupLine(): string[] {
  return ['init', '--fleet-url', fleet.url, '--ship-id', fleet.trierarchShip.shipId, '--secret', fleet.trierarchShip.secret, '--yes'];
}

const OWNER_ONLY = 0o600;
const PERMISSION_BITS = 0o777;

function jsonAt(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('init', () => {
  it("registers the trierarch's ship: its lease is held", async () => {
    const init = await machine.trierarch(setupLine());

    expect(init.status, init.stdout + init.stderr).toBe(0);
    await expect(fleet.leasesOf(fleet.trierarchShip.shipId)).resolves.toBe(1);
  });

  it('keeps the crew token readable by the user only, and the secret nowhere', async () => {
    await machine.trierarch(setupLine());

    const crewToken = join(machine.trierarchHome, 'crew-token');
    expect(statSync(crewToken).mode & PERMISSION_BITS).toBe(OWNER_ONLY);
    expect(readFileSync(crewToken, 'utf8')).not.toContain(fleet.trierarchShip.secret);
  });

  it('writes the configuration and its JSON Schema', async () => {
    await machine.trierarch(setupLine());

    expect(jsonAt(join(machine.trierarchHome, 'config.json'))).toMatchObject({ $schema: './config.schema.json', harnesses: { 'claude-code': {} } });
    expect(jsonAt(join(machine.trierarchHome, 'config.schema.json'))).toMatchObject({ type: 'object' });
  });

  it('installs the service and starts it: the trierarch runs and says its version', async () => {
    await machine.trierarch(setupLine());
    const version = z.object({ version: z.string() }).parse(JSON.parse((await machine.trierarch(['--version', '--json'])).stdout)).version;

    const status = await machine.trierarch(['status', '--json']);

    expect(status.status, status.stdout + status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ version, service: { isInstalled: true, isRunning: true, pid: machine.servicePid() } });
  });

  it('refuses before it registers anything when Claude Code is installed but not signed in', async () => {
    machine.toggle('claude-signed-out', true);

    const init = await machine.trierarch(setupLine());

    expect(init.status).toBe(1);
    expect(init.stdout).toContain('not signed in');
    await expect(fleet.leasesOf(fleet.trierarchShip.shipId)).resolves.toBe(0);
    expect(existsSync(join(machine.trierarchHome, 'crew-token'))).toBe(false);
  });

  it('run again with the same setup line, registers nothing again and goes on with the setup', async () => {
    await machine.trierarch(setupLine());

    const again = await machine.trierarch(setupLine());

    expect(again.status, again.stdout + again.stderr).toBe(0);
    await expect(fleet.database.lease.count({ where: { shipId: fleet.trierarchShip.shipId } })).resolves.toBe(1);
  });
});

describe('add', () => {
  it('adds a repository to the configuration and Claude Code trusts it', async () => {
    await machine.trierarch(setupLine());

    const add = await machine.trierarch(['add', 'repository', 'aeolus-fleet', machine.repository]);

    expect(add.status, add.stdout + add.stderr).toBe(0);
    expect(jsonAt(join(machine.trierarchHome, 'config.json'))).toMatchObject({ repositories: { 'aeolus-fleet': { path: machine.repository } } });
    expect(jsonAt(join(machine.home, '.claude.json'))).toMatchObject({ projects: { [machine.repository]: { hasTrustDialogAccepted: true } } });
  });
});
