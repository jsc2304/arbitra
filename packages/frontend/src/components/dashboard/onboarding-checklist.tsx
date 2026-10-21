'use client';

import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { ARBITRA_BUILD, ARBITRA_STAGE_LABEL } from '@arbitra/shared';
import { useOnboarding, type OnboardingStep } from '../../hooks/use-onboarding';

function CheckIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
  );
}

function CircleIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

export function OnboardingChecklist() {
  const { steps, completeStep, dismiss, isVisible } = useOnboarding();
  const router = useRouter();

  const completedCount = steps.filter((s) => s.completed).length;
  const progress = steps.length > 0 ? (completedCount / steps.length) * 100 : 0;

  function handleStepClick(step: OnboardingStep) {
    completeStep(step.id);
    router.push(step.href);
  }

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          className="mb-8 bg-surface-raised rounded-lg border border-gray-200 dark:border-border-subtle shadow-sm p-6"
          initial={{ opacity: 0, height: 0, marginBottom: 0 }}
          animate={{ opacity: 1, height: 'auto', marginBottom: 32 }}
          exit={{ opacity: 0, height: 0, marginBottom: 0 }}
          transition={{ duration: 0.4, ease: 'easeInOut' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                  {ARBITRA_STAGE_LABEL}
                </span>
                <span className="text-xs text-gray-400 dark:text-gray-500">Build {ARBITRA_BUILD} · dev environment only</span>
              </div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Get started with Arbitra</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">Connect your first project and start reviewing code with AI.</p>
            </div>
            <button
              onClick={dismiss}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-surface-base dark:hover:bg-border-subtle transition-colors"
              aria-label="Dismiss onboarding"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Progress bar */}
          <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden mb-5">
            <motion.div
              className="h-full bg-accent rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </div>

          {/* Steps */}
          <ul className="space-y-1">
            {steps.map((step) => (
              <li key={step.id}>
                <button
                  onClick={() => handleStepClick(step)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-base dark:hover:bg-border-subtle/50 transition-colors text-left group"
                >
                  <span className={step.completed ? 'text-green-500' : 'text-gray-300 dark:text-gray-600 group-hover:text-accent'}>
                    {step.completed ? <CheckIcon /> : <CircleIcon />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium ${step.completed ? 'text-gray-500 dark:text-gray-400 line-through' : 'text-gray-900 dark:text-gray-100'}`}>
                      {step.label}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{step.description}</p>
                  </div>
                  <svg className="h-4 w-4 text-gray-300 dark:text-gray-600 group-hover:text-gray-500 transition-colors" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>

          <p className="mt-4 text-xs text-gray-500 dark:text-gray-400 text-center">
            {completedCount} of {steps.length} completed
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
