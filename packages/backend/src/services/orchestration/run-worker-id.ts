import { randomBytes } from 'node:crypto';

/**
 * Mint a worker identity for a run lease.
 *
 * Shared by everything that can become the owner of a run: the Firestore
 * adapter (`createRun` stamps one at creation time), `RunExecutor` (claims a
 * run dispatched to it unclaimed), and `RunSweepService`'s assistant
 * sub-sweep (claims a run nobody picked up). The value only has to be unique
 * per claim attempt — it is compared for equality when releasing a lease, never
 * parsed or resolved back to a process.
 */
export function newWorkerId(): string {
  return randomBytes(8).toString('hex');
}
