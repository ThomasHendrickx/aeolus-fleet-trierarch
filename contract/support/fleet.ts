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
  /** Commissions a ship argo can request a crew for; with `owner`, a ship of that name answers for it instead of argo. */
  commission(name: string, at?: { owner?: ShipId }): Promise<ShipId>;
  /** Requests a crew for the ship in a worktree of the repository, with the harness and the options given, and assigns it to the machine's trierarch. */
  crewInWorktree(shipId: ShipId, at: { repository: string; harness: string; options?: Readonly<Record<string, string>> }): Promise<void>;
  /** Removes the ship's crew request: its lease ends. */
  removeCrewRequest(shipId: ShipId): Promise<void>;
  /** Ends the ship's lease under its session while its crew request stands, as the console's Re-crew does. */
  releaseElsewhere(shipId: ShipId): Promise<void>;
  /** Sends the ship a message from argo: its id. */
  send(shipName: string, payload: string): Promise<string>;
  /** How many of the ship's leases are held. */
  leasesOf(shipId: ShipId): Promise<number>;
  /** The harness the ship's held lease was registered with. */
  leaseHarnessOf(shipId: ShipId): Promise<string | undefined>;
  /** Applies network rules that allow nothing: ships reach only what the fixed rules let them, such as argo. */
  closeTheNetwork(): Promise<void>;
  /** What the machine's trierarch sent, oldest first: the recipient's name and the text. */
  toldByTrierarch(): Promise<readonly Told[]>;
  /** The delivery's state, as core keeps it. */
  deliveryStateOf(messageId: string): Promise<string>;
  /** Why the machine's trierarch gave the ship's crew request back; none while it gave none back. */
  givenBackReasonOf(shipId: ShipId): Promise<string | undefined>;
  close(): Promise<void>;
}

/** A message the trierarch sent: who it went to, and its text. */
export interface Told {
  readonly to: string;
  readonly text: string;
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
    commission: async (name, at = {}) => {
      const { shipId } = unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name, type: 'reviewer' }));
      if (at.owner !== undefined) {
        await database.ship.update({ where: { id: shipId }, data: { ownerShipId: at.owner } });
      }
      return shipId;
    },
    crewInWorktree: async (shipId, { repository, harness, options = {} }) => {
      unwrap(await useCases.requestCrew(argo, { shipId, settings: { harness, workspace: { kind: 'worktree', repository }, options } }));
      unwrap(await useCases.assignCrew(argo, { shipId, trierarchShipId: trierarchShip.shipId }));
    },
    removeCrewRequest: async (shipId) => {
      unwrap(await useCases.removeCrewRequest(argo, { shipId }));
    },
    releaseElsewhere: async (shipId) => {
      unwrap(await useCases.recrewShip(argo, { shipId }));
    },
    send: async (shipName, payload) => unwrap(await useCases.sendMessage(argo, { selector: { kind: 'ship', name: shipName }, payload, idempotencyKey: newKey() })).messageId,
    leasesOf: (shipId) => database.lease.count({ where: { shipId, endedAt: null } }),
    leaseHarnessOf: async (shipId) => (await database.lease.findFirst({ where: { shipId, endedAt: null }, select: { harness: true } }))?.harness ?? undefined,
    closeTheNetwork: async () => {
      const { savedAgainstVersion } = unwrap(await useCases.saveNetworkRulesDraft(argo, { rules: [] }));
      unwrap(await useCases.applyNetworkRules(argo, { version: savedAgainstVersion }));
    },
    toldByTrierarch: async () => {
      const messages = await database.message.findMany({ where: { senderShipId: trierarchShip.shipId }, orderBy: { createdAt: 'asc' }, select: { id: true, payload: true } });
      const told: Told[] = [];
      for (const message of messages) {
        const delivery = await database.delivery.findFirst({ where: { messageId: message.id }, select: { recipientShipId: true } });
        const recipient = delivery?.recipientShipId == null ? undefined : await database.ship.findUnique({ where: { id: delivery.recipientShipId }, select: { name: true } });
        told.push({ to: recipient?.name ?? '', text: message.payload ?? '' });
      }
      return told;
    },
    deliveryStateOf: async (messageId) => (await database.delivery.findFirstOrThrow({ where: { messageId }, select: { state: true } })).state,
    givenBackReasonOf: async (shipId) => (await database.crewRequestGiveBack.findFirst({ where: { shipId, trierarchShipId: trierarchShip.shipId }, select: { reason: true } }))?.reason,
    close: async () => {
      await server.close();
      await database.$disconnect();
    },
  };
}
