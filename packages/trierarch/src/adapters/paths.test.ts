import { relative, isAbsolute } from 'node:path';

import { describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { longestSocket, shipHome, shipSockets, socketPathLimit, trierarchPaths } from './paths.js';

const paths = trierarchPaths({ homeDirectory: '/home/me' });

describe("the trierarch's files", () => {
  it("keep every ship's files under ships/, beside the trierarch's own files, its tokens and the hold's files among them", () => {
    const own = [paths.config, paths.crewToken, paths.modelToken, paths.keys, paths.state, paths.sessions, paths.proxy];

    const underShips = own.filter((path) => {
      const inShips = relative(paths.ships, path);
      return inShips === '' || (!inShips.startsWith('..') && !isAbsolute(inShips));
    });

    expect(paths.ships).toBe('/home/me/.aeolus/trierarch/ships');
    expect(underShips).toEqual([]);
  });
});

describe("a ship's home and sockets folder", () => {
  const shipId = newId('ship');

  it("are in its ship's folder", () => {
    const shipFolder = `/home/me/.aeolus/trierarch/ships/${shipId}`;

    expect([shipHome(paths.homes, { shipId, shipFolder }), shipSockets(paths.sockets, { shipId, shipFolder })]).toEqual([`${shipFolder}/home`, `${shipFolder}/sockets`]);
  });

  it('are where they were made for a ship crewed before the ship folders', () => {
    expect([shipHome(paths.homes, { shipId }), shipSockets(paths.sockets, { shipId })]).toEqual([`/home/me/.aeolus/trierarch/homes/${shipId}`, `/home/me/.aeolus/trierarch/sockets/${shipId}`]);
  });
});

describe("a ship's socket path", () => {
  it('is at its longest the fleet socket of the longest ship id under the place of ships/', () => {
    expect(longestSocket('/home/me/.aeolus/trierarch/ships')).toBe('/home/me/.aeolus/trierarch/ships/shp_00000000000000000000000000/sockets/fleet.sock');
  });

  it("takes the system's limit: 104 bytes on macOS, 108 elsewhere", () => {
    expect([socketPathLimit('darwin'), socketPathLimit('linux')]).toEqual([104, 108]);
  });
});
