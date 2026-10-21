/**
 * Green/red pill indicating whether the case's evidence requirements are
 * satisfied. Rendered in the Proof accordion header; not rendered inside
 * EvidencePanel itself anymore (the header owns it).
 */

interface EvidenceSatisfiedPillProps {
  satisfied: boolean;
  /** Slightly smaller text in accordion-header context. Defaults to 'sm'. */
  size?: 'sm' | 'md';
}

export function EvidenceSatisfiedPill({ satisfied, size = 'sm' }: EvidenceSatisfiedPillProps) {
  const sizeClasses = size === 'md' ? 'px-2.5 py-0.5 text-xs' : 'px-2 py-0.5 text-xs';
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium cursor-help ${sizeClasses} ${
        satisfied
          ? 'bg-green-100 dark:bg-green-950/50 text-green-700 dark:text-green-400'
          : 'bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-400'
      }`}
      title={
        satisfied
          ? 'All required evidence types for this risk level and validation track have been registered.'
          : 'Some required evidence is still missing. Check the evidence policy for this project to see what is needed. The case cannot progress to review until all requirements are met.'
      }
    >
      {satisfied ? 'Requirements Satisfied' : 'Requirements Not Satisfied'}
    </span>
  );
}
