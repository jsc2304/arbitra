'use client';

import { useState } from 'react';
import { useAuth } from '../../providers/auth-provider';
import { ClerkAskPanel } from '../clerk/clerk-ask-panel';
import { HelperBotDrawer } from '../helper-bot/helper-bot-drawer';
import Card from '../shared/card';
import { SideDrawer } from '../shared/side-drawer';
import { Button } from '../ui/button';

type AssistantSurface = 'closed' | 'choice' | 'clerk' | 'helper';

interface AssistantChoicePanelProps {
  onChooseClerk: () => void;
  onChooseHelper: () => void;
}

/**
 * The explicit Clerk/Helper decision shown after opening the one global
 * assistant launcher. Routing by request text is deliberately absent: Clerk's
 * classifier is telemetry, not a reliable way to decide which product the
 * requester intended to use.
 */
export function AssistantChoicePanel({
  onChooseClerk,
  onChooseHelper,
}: AssistantChoicePanelProps) {
  return (
    <div className="space-y-4" data-testid="assistant-choice-panel">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Choose the kind of help you need. Clerk performs a governed read task;
        the Helper answers questions about using Arbitra.
      </p>

      <Card padding="compact">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Start a task with Clerk
        </h4>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Clerk reads your Arbitra data asynchronously. The request, method,
          answer, and evidence are recorded in a case.
        </p>
        <Button
          variant="primary"
          size="sm"
          className="mt-3"
          onClick={onChooseClerk}
          data-testid="assistant-choice-clerk"
        >
          Start Clerk task
        </Button>
      </Card>

      <Card padding="compact">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Ask the Arbitra Helper
        </h4>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Get an immediate conversational answer about Arbitra setup,
          concepts, rules, and integrations. No case is created.
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={onChooseHelper}
          data-testid="assistant-choice-helper"
        >
          Ask Helper
        </Button>
      </Card>
    </div>
  );
}

interface ClerkTaskDrawerProps {
  open: boolean;
  onClose: () => void;
}

/** Clerk is a task drawer, never a chat transcript. */
export function ClerkTaskDrawer({ open, onClose }: ClerkTaskDrawerProps) {
  return (
    <SideDrawer open={open} onClose={onClose} title="Clerk" width="lg">
      <ClerkAskPanel onTaskCreated={onClose} />
    </SideDrawer>
  );
}

/**
 * The only floating assistant affordance in the authenticated application.
 * Opening it asks the user to choose explicitly; each choice reaches the
 * selected assistant in that one further click.
 */
export function AssistantLauncher() {
  const { user } = useAuth();
  const [surface, setSurface] = useState<AssistantSurface>('closed');

  if (!user) return null;

  const close = () => setSurface('closed');

  return (
    <>
      <Button
        variant="primary"
        size="md"
        shape="circle"
        iconOnly
        onClick={() => setSurface('choice')}
        aria-label="Open Arbitra assistants"
        title="Open Arbitra assistants"
        className="fixed bottom-6 right-6 z-40 h-12 w-12"
        data-testid="assistant-launcher"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-6 w-6"
          aria-hidden
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </Button>

      <SideDrawer
        open={surface === 'choice'}
        onClose={close}
        title="How can Arbitra help?"
        width="md"
      >
        <AssistantChoicePanel
          onChooseClerk={() => setSurface('clerk')}
          onChooseHelper={() => setSurface('helper')}
        />
      </SideDrawer>

      <ClerkTaskDrawer open={surface === 'clerk'} onClose={close} />
      <HelperBotDrawer open={surface === 'helper'} onClose={close} />
    </>
  );
}
