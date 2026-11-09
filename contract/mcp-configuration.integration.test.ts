import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';
import { isTodaysTrierarch } from './support/trierarch-under-test.js';

// The fleet's MCP configuration from the trierarch plugin's ship: asked for, applied, confirmed and offered (docs/trierarch.md, "Crew-time MCP servers").

const CONFIGURATION_TYPE = 'application/vnd.aeolus.trierarch.mcp-configuration+json';
const REQUEST_TYPE = 'application/vnd.aeolus.trierarch.mcp-configuration-request+json';
const APPLIED_TYPE = 'application/vnd.aeolus.trierarch.mcp-configuration-applied+json';

/** A pass runs every 5 seconds. */
const ANSWERED_WITHIN_MS = 30_000;

/** A server that needs no credential, so the configuration carries no sealed secret. */
const GRAPH = { name: 'company-graph', url: 'https://graph.example.test/mcp', transport: 'streamable-http', tools: ['read_neo4j_cypher'] };

let fleet: Fleet;
let machine: Machine;
let plugin: ShipId;

beforeEach(async () => {
  fleet = await aFleet();
  machine = await aMachine();
  plugin = await fleet.commission('trierarch-plugin');
  await aCrewingMachine({ fleet, machine, pluginShip: plugin });
});

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

const reportSchema = z.object({ sealingKey: z.object({ publicKey: z.string() }), harnesses: z.array(z.object({ harness: z.string(), mcpServers: z.array(z.string()).optional() })) });

/** The key the trierarch reports, which a configuration is sealed to. */
async function reportedKey(): Promise<string> {
  await expect.poll(async () => reportSchema.safeParse((await fleet.reportOfTrierarch())?.details).success, { timeout: ANSWERED_WITHIN_MS }).toBe(true);
  return reportSchema.parse((await fleet.reportOfTrierarch())?.details).sealingKey.publicKey;
}

/** The MCP servers the trierarch reports Claude Code offers. */
async function offeredByClaudeCode(): Promise<readonly string[]> {
  const report = reportSchema.safeParse((await fleet.reportOfTrierarch())?.details);
  return report.success ? (report.data.harnesses.find(({ harness }) => harness === 'claude-code')?.mcpServers ?? []) : [];
}

/** The payloads the trierarch sent the plugin ship, of the content type, oldest first. */
async function sentToPlugin(contentType: string): Promise<readonly unknown[]> {
  const messages = await fleet.database.message.findMany({ where: { senderShipId: fleet.trierarchShip.shipId, selectorShipId: plugin, contentType }, orderBy: { createdAt: 'asc' }, select: { payload: true } });
  return messages.map(({ payload }) => z.unknown().parse(JSON.parse(payload ?? 'null')));
}

function aConfiguration(at: { version: number; publicKey: string; fleetId?: string; servers?: readonly unknown[] }): { payload: string; contentType: string } {
  return { payload: JSON.stringify({ fleetId: at.fleetId ?? fleet.argo.fleetId, pluginShipId: plugin, version: at.version, publicKey: at.publicKey, servers: at.servers ?? [GRAPH], secrets: [] }), contentType: CONFIGURATION_TYPE };
}

describe.skipIf(isTodaysTrierarch)("the fleet's MCP configuration", () => {
  it("asks the trierarch plugin's ship for it, naming its fleet and that ship", async () => {
    await expect.poll(() => sentToPlugin(REQUEST_TYPE), { timeout: ANSWERED_WITHIN_MS }).toContainEqual({ fleetId: fleet.argo.fleetId, pluginShipId: plugin });
  });

  it('applies a configuration of its fleet sealed to its key, confirms it and offers its servers', async () => {
    const publicKey = await reportedKey();

    await fleet.sendToTrierarchAs(plugin, aConfiguration({ version: 1, publicKey }));

    await expect.poll(() => sentToPlugin(APPLIED_TYPE), { timeout: ANSWERED_WITHIN_MS }).toContainEqual({ fleetId: fleet.argo.fleetId, pluginShipId: plugin, version: 1, publicKey });
    await expect.poll(offeredByClaudeCode, { timeout: ANSWERED_WITHIN_MS }).toEqual(['company-graph']);
  });

  it('offers no server once an empty configuration of a later version is applied', async () => {
    const publicKey = await reportedKey();
    await fleet.sendToTrierarchAs(plugin, aConfiguration({ version: 1, publicKey }));
    await expect.poll(offeredByClaudeCode, { timeout: ANSWERED_WITHIN_MS }).toEqual(['company-graph']);

    await fleet.sendToTrierarchAs(plugin, aConfiguration({ version: 2, publicKey, servers: [] }));

    await expect.poll(offeredByClaudeCode, { timeout: ANSWERED_WITHIN_MS }).toEqual([]);
  });

  it('takes nothing of a configuration of another fleet and confirms none', async () => {
    const publicKey = await reportedKey();

    const messageId = await fleet.sendToTrierarchAs(plugin, aConfiguration({ version: 1, publicKey, fleetId: 'flt_01m3tb1zgr5h2ffee12xnch8sw' }));

    await expect.poll(() => fleet.deliveryStateOf(messageId), { timeout: ANSWERED_WITHIN_MS }).toBe('acknowledged');
    expect(await sentToPlugin(APPLIED_TYPE)).toEqual([]);
    expect(await offeredByClaudeCode()).toEqual([]);
  });

  it('takes nothing of a configuration from another ship', async () => {
    const publicKey = await reportedKey();
    const stranger = await fleet.commission('stranger');

    const messageId = await fleet.sendToTrierarchAs(stranger, aConfiguration({ version: 1, publicKey }));

    await expect.poll(() => fleet.deliveryStateOf(messageId), { timeout: ANSWERED_WITHIN_MS }).toBe('acknowledged');
    expect(await sentToPlugin(APPLIED_TYPE)).toEqual([]);
  });

  it('confirms the version it persisted again after a restart', async () => {
    const publicKey = await reportedKey();
    await fleet.sendToTrierarchAs(plugin, aConfiguration({ version: 1, publicKey }));
    await expect.poll(async () => (await sentToPlugin(APPLIED_TYPE)).length, { timeout: ANSWERED_WITHIN_MS }).toBe(1);

    const restarted = await machine.trierarch(['restart']);
    expect(restarted.status, restarted.stdout + restarted.stderr).toBe(0);

    await expect.poll(async () => (await sentToPlugin(APPLIED_TYPE)).length, { timeout: ANSWERED_WITHIN_MS }).toBe(2);
    await expect.poll(offeredByClaudeCode, { timeout: ANSWERED_WITHIN_MS }).toEqual(['company-graph']);
  });
});
