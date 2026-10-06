/** The trierarch package's entry: its core, for the command and for whoever tests it. */
export { createHandleDelivery, type HandleDelivery, type HandleDeliveryDeps } from './core/handle-delivery.js';
export { createRunPass, type RunPass, type RunPassDeps } from './core/run-pass.js';
export { createUninstall, type Uninstall } from './core/uninstall.js';
export { EMPTY_STATE, type Entry, type KeptWorktree, type Outgoing, type TrierarchState } from './core/entry.js';
export type * from './core/ports.js';
