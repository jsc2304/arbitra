import type { ComponentType } from 'react';
import type { WorkspaceEvent } from '@arbitra/shared';
import { WebhookMisconfiguredBlock } from './webhook-misconfigured-block';
import { IntelligenceRunBlock } from './intelligence-run-block';
import { DefaultBlock } from './default-block';

export type WorkspaceEventBlockProps = { event: WorkspaceEvent };
export type WorkspaceEventBlock = ComponentType<WorkspaceEventBlockProps>;

/**
 * Registry of type-specific renderers for the workspace-event detail drawer.
 * Add new entries here when a new event type wants a dedicated body — unknown
 * types fall back to `DefaultBlock`, which pretty-prints the raw evidence so
 * operators can still read the payload while a proper renderer ships.
 */
export const WORKSPACE_EVENT_BLOCKS: Record<string, WorkspaceEventBlock> = {
  webhook_misconfigured: WebhookMisconfiguredBlock,
  intelligence_run: IntelligenceRunBlock,
};

export function pickBlock(type: string): WorkspaceEventBlock {
  return WORKSPACE_EVENT_BLOCKS[type] ?? DefaultBlock;
}

export { WebhookMisconfiguredBlock, IntelligenceRunBlock, DefaultBlock };
