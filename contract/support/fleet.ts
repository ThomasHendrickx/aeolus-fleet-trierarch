import type { ShipId } from '@aeolus-fleet/common';
import { createApp, createMigratedDatabase, createPrismaClient, createUseCases, FLEET_URL, newKey, OPERATOR, operatorCaller, secretOf, unwrap, type PrismaClient, type ShipCaller, type UseCases } from '@aeolus-fleet/core/testing';

/**
 * A fleet in this process on its own database, as the trierarch reaches one
 * over `/api/v1`: argo commissions the machine's trierarch ship and the ships
 * it crews, and reads what core keeps. Only core is in process; the
 * trierarch under test reaches it at `url`, as any other program does.
 */
export interface Fleet {
  readonly url: string;
  readonly useCases: UseCases;
  readonly argo: ShipCaller;
  readonly database: PrismaClient;
  /** The trierarch ship's id and the secret its setup line carries. */
  readonly trierarchShip: { readonly shipId: ShipId; readonly secret: string };
  /** Commissions a ship argo can request a crew for. */
  commission(name: string): Promise<ShipId>;
  /** Requests a crew for the ship in a worktree of the repository, with the harness, and assigns it to the machine's trierarch. */
  crewInWorktree(shipId: ShipId, at: { repository: string; harness: string }): Promise<void>;
  /** Removes the ship's crew request: its lease ends. */
  removeCrewRequest(shipId: ShipId): Promise<void>;
  /** Sends the ship a message from argo: its id. */
  send(shipName: string, payload: string): Promise<string>;
  /** How many of the ship's leases are held. */
  leasesOf(shipId: ShipId): Promise<number>;
  /** The harness the ship's held lease was registered with. */
  leaseHarnessOf(shipId: ShipId): Promise<string | undefined>;
  /** The delivery's state, as core keeps it. */
  deliveryStateOf(messageId: string): Promise<string>;
  close(): Promise<void>;
}

export async function aFleet(): Promise<Fleet> {
  const databaseUrl = await createMigratedDatabase();
  const database = createPrismaClient(databaseUrl);
  const server = createApp({ databaseUrl, publicUrl: FLEET_URL, logger: false, receiveWaitMs: 100 });
  const url = await server.listen({ host: '127.0.0.1', port: 0 });
  const useCases = createUseCases({ prisma: database });
  const argo = operatorCaller(unwrap(await useCases.initialiseFleet({ name: 'home fleet', ...OPERATOR })));
  const commissioned = unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name: 'mac-mini', type: 'trierarch', scopes: ['crew:run'] }));
  const trierarchShip = { shipId: commissioned.shipId, secret: secretOf(commissioned.secret) };
  return {
    url,
    useCases,
    argo,
    database,
    trierarchShip,
    commission: async (name) => unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name, type: 'reviewer' })).shipId,
    crewInWorktree: async (shipId, { repository, harness }) => {
      unwrap(await useCases.requestCrew(argo, { shipId, settings: { harness, workspace: { kind: 'worktree', repository }, options: {} } }));
      unwrap(await useCases.assignCrew(argo, { shipId, trierarchShipId: trierarchShip.shipId }));
    },
    removeCrewRequest: async (shipId) => {
      unwrap(await useCases.removeCrewRequest(argo, { shipId }));
    },
    send: async (shipName, payload) => unwrap(await useCases.sendMessage(argo, { selector: { kind: 'ship', name: shipName }, payload, idempotencyKey: newKey() })).messageId,
    leasesOf: (shipId) => database.lease.count({ where: { shipId, endedAt: null } }),
    leaseHarnessOf: async (shipId) => (await database.lease.findFirst({ where: { shipId, endedAt: null }, select: { harness: true } }))?.harness ?? undefined,
    deliveryStateOf: async (messageId) => (await database.delivery.findFirstOrThrow({ where: { messageId }, select: { state: true } })).state,
    close: async () => {
      await server.close();
      await database.$disconnect();
    },
  };
}
