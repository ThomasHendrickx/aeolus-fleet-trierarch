import { claimFreePort } from './port-claims.js';

/** A port nothing listens on and no other test run on this host serves on (port-claims.ts). */
export function freePort(): Promise<number> {
  return claimFreePort();
}
