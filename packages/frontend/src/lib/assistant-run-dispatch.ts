import type { Case, Run } from '@arbitra/shared';

/** Fast-path dispatch; the durable assistant sweep remains the recovery path. */
export function scheduleAssistantRunDispatch(case_: Case, run: Run): void {
  void Promise.resolve().then(async () => {
    try {
      const { FirestorePipelineAdapter, RunCompletionHandler, RunExecutor } = await import(
        '@arbitra/backend'
      );
      const adapter = new FirestorePipelineAdapter();
      const executor = new RunExecutor(adapter, new RunCompletionHandler(adapter));
      executor.dispatch(run, case_);
    } catch (err) {
      console.warn(
        `[assistant-intake] dispatch of run ${run.run_id} for case ${case_.case_id} failed; `
          + 'leaving it to the assistant sweep:',
        err,
      );
    }
  });
}
