import { collections, getDb } from '../../lib/firestore.js';
import { clerkCoreIds, type ClerkCoreIds } from './clerk-core.js';
import {
  buildClerkEvidencePolicy,
  buildClerkProject,
  buildClerkRepository,
} from './clerk-core-documents.js';

export type ClerkCoreDocumentKind = 'project' | 'repository' | 'evidence_policy';
export type ClerkCoreProvisionStatus = 'created' | 'already_provisioned';

export interface ClerkCoreProvisionItem {
  kind: ClerkCoreDocumentKind;
  /** Deterministic document id, from `clerkCoreIds`. */
  id: string;
  status: ClerkCoreProvisionStatus;
}

export interface ClerkCoreProvisionResult {
  user_id: string;
  ids: ClerkCoreIds;
  items: ClerkCoreProvisionItem[];
}

/**
 * Provisions the private `Clerk` project, its placeholder repository, and
 * its evidence policy for one user — the same three documents
 * `scripts/setup-clerk-core.ts` creates, built from the same shared shape
 * (`clerk-core-documents.ts`) and keyed by the same ids (`clerkCoreIds`) so
 * `AssistantIntakeService` resolves them either way.
 *
 * ## Idempotent, and non-clobbering
 *
 * Calling this twice — or concurrently — must be safe. "Already provisioned"
 * means the same thing for all three documents: a document already exists at
 * the deterministic id. That is the ENTIRE check. An existing document's
 * fields are never inspected and never patched, even if they no longer match
 * what a fresh build would write: that drift may be exactly a customization
 * a user or admin made on purpose (a renamed project, a hand-edited
 * evidence policy through the policy editor), and this service has no way
 * to tell "drifted" from "customized" apart from "someone changed it since
 * creation" — so it leaves it alone rather than guess. Contrast
 * `scripts/setup-clerk-core.ts`, whose dry-run/apply plan is an
 * administrator explicitly asking "does this match the canonical shape, and
 * if not, correct it" — a different, opt-in operation this service does not
 * perform.
 *
 * Each of the three reads and conditional creates happens inside one
 * Firestore transaction, so two concurrent calls for the same user cannot
 * race into creating the same document twice: whichever transaction commits
 * second observes the first transaction's writes and reports every document
 * as `already_provisioned`.
 */
export class ProvisionClerkCoreService {
  async provision(userId: string): Promise<ClerkCoreProvisionResult> {
    const ids = clerkCoreIds(userId);
    const now = new Date().toISOString();

    const projectRef = collections.projects().doc(ids.projectId);
    const repositoryRef = collections.repositories().doc(ids.repositoryId);
    const policyRef = collections.evidencePolicies().doc(ids.policyId);

    const items = await getDb().runTransaction(async (tx): Promise<ClerkCoreProvisionItem[]> => {
      const [projectSnap, repositorySnap, policySnap] = await Promise.all([
        tx.get(projectRef),
        tx.get(repositoryRef),
        tx.get(policyRef),
      ]);

      const results: ClerkCoreProvisionItem[] = [];

      if (projectSnap.exists) {
        results.push({ kind: 'project', id: ids.projectId, status: 'already_provisioned' });
      } else {
        tx.create(projectRef, buildClerkProject(ids, userId, now));
        results.push({ kind: 'project', id: ids.projectId, status: 'created' });
      }

      if (repositorySnap.exists) {
        results.push({ kind: 'repository', id: ids.repositoryId, status: 'already_provisioned' });
      } else {
        tx.create(repositoryRef, buildClerkRepository(ids, now));
        results.push({ kind: 'repository', id: ids.repositoryId, status: 'created' });
      }

      if (policySnap.exists) {
        results.push({ kind: 'evidence_policy', id: ids.policyId, status: 'already_provisioned' });
      } else {
        tx.create(policyRef, buildClerkEvidencePolicy(ids, now));
        results.push({ kind: 'evidence_policy', id: ids.policyId, status: 'created' });
      }

      return results;
    });

    return { user_id: userId, ids, items };
  }
}
