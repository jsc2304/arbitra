'use client';

import { forwardRef, useId } from 'react';
import type {
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  SelectHTMLAttributes,
  ReactNode,
} from 'react';

/**
 * `<Input>` — the shared form-field primitive for the Arbitra frontend
 * (issue #655).
 *
 * Centralises the border / input-bg / accent-focus colour discipline that was
 * previously hand-rolled at every text field, textarea, and native `<select>`
 * call site (several of which shipped with NO focus styling — a real a11y bug).
 * Prefer this over a raw `<input className="...">` so the design tokens
 * (`border-border-default`, `bg-input-bg`, the `accent` focus ring) and the
 * label/error/hint wiring (`htmlFor`↔`id`, `aria-invalid`, `aria-describedby`)
 * stay in one place.
 *
 * Polymorphic via `as` (`'input' | 'textarea' | 'select'`). All native props
 * for the chosen element pass through. `className` is merged LAST so a call
 * site can still override or extend the computed classes. Sibling of the
 * `<Button>` primitive — same `cn()` helper, forwardRef, native-prop spread.
 */

export type InputAs = 'input' | 'textarea' | 'select';
export type InputSize = 'sm' | 'md';

/** Props shared by every field variant (the wrapper + label/error/hint chrome). */
interface InputOwnProps {
  /** Which underlying element to render. Defaults to `'input'`. */
  as?: InputAs;
  /** Renders a `<label>` wired to the control via a generated `id`/`htmlFor`. */
  label?: string;
  /**
   * Error message. Renders below the control in red, sets a red border,
   * `aria-invalid="true"`, and wires `aria-describedby` to the message.
   */
  error?: string;
  /** Helper text rendered below the control (suppressed when `error` is set). */
  hint?: string;
  /** Padding/text scale. Defaults to `'md'`. */
  size?: InputSize;
  /** Icon rendered inside the control on the left (absolutely positioned). */
  leftIcon?: ReactNode;
  /** Node rendered after the control inside the field wrapper (e.g. a unit). */
  rightAddon?: ReactNode;
  /** Extra classes for the outer wrapper (label + control + messages). */
  wrapperClassName?: string;
}

/**
 * Native attributes for every supported element, merged into a single bag.
 *
 * The intersection drops the keys whose types differ across `<input>` /
 * `<textarea>` / `<select>` (notably the native `size`, which is a number on
 * `<input>`/`<select>` but collides with our `InputSize`), and re-declares the
 * shared form props (`value`, `defaultValue`, `onChange`) with the widest
 * usable types so a controlled text/number field type-checks at the call site.
 */
type ConflictingNativeKeys = 'size' | 'value' | 'defaultValue' | 'onChange';

type SharedNativeProps = Omit<InputHTMLAttributes<HTMLInputElement>, ConflictingNativeKeys> &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, ConflictingNativeKeys | keyof InputHTMLAttributes<HTMLInputElement>> &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, ConflictingNativeKeys | keyof InputHTMLAttributes<HTMLInputElement>>;

export type InputProps = InputOwnProps &
  SharedNativeProps & {
    /** Controlled value — accepted by every variant. */
    value?: string | number | readonly string[];
    /** Uncontrolled initial value. */
    defaultValue?: string | number | readonly string[];
    /** Change handler for the rendered control. */
    onChange?: React.ChangeEventHandler<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >;
  };

/** Minimal class-join helper — mirrors `<Button>` (no `cn`/clsx dependency). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

const baseControlClasses =
  'w-full rounded-md border border-border-default bg-input-bg ' +
  'text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 ' +
  'focus-visible:outline-none focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent ' +
  'disabled:opacity-60 disabled:cursor-not-allowed transition-colors';

// Font-size MUST stay >=16px (`text-base`) on the actual control below the
// `md` breakpoint: iOS Safari auto-zooms the page on focus whenever a form
// control's computed font-size is under 16px, and that zoom persists after
// blur until the user manually pinches back out. `md:text-sm` restores the
// original 14px on desktop, where no zoom is triggered — do not drop the
// `text-base` fallback or widen the `md:` prefix to something narrower.
// This single primitive renders `<input>`, `<textarea>`, and `<select>`
// (via the `as` prop), so this one change covers all three controls.
const sizeClasses: Record<InputSize, string> = {
  sm: 'px-3 py-1.5 text-base md:text-sm',
  md: 'px-3 py-2 text-base md:text-sm',
};

const errorControlClasses =
  'border-red-500 focus-visible:border-red-500 focus-visible:ring-red-500';

export const Input = forwardRef<
  HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  InputProps
>(function Input(
  {
    as = 'input',
    label,
    error,
    hint,
    size = 'md',
    leftIcon,
    rightAddon,
    wrapperClassName,
    className,
    id: idProp,
    ...rest
  },
  ref,
) {
  // Stable generated id so a `<label htmlFor>` and `aria-describedby` can point
  // at the control / message even when the call site doesn't pass an `id`.
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const describedbyId = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  const controlClasses = cn(
    baseControlClasses,
    sizeClasses[size],
    as === 'textarea' && 'resize-y min-h-[80px]',
    // Native select keeps its browser chevron; tint it with the brand accent.
    as === 'select' && 'accent-accent',
    leftIcon != null && leftIcon !== false && 'pl-9',
    error && errorControlClasses,
    className,
  );

  const commonProps = {
    id,
    className: controlClasses,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedbyId,
    ...rest,
  } as Record<string, unknown>;

  let control: ReactNode;
  if (as === 'textarea') {
    control = (
      <textarea
        ref={ref as React.Ref<HTMLTextAreaElement>}
        {...(commonProps as TextareaHTMLAttributes<HTMLTextAreaElement>)}
      />
    );
  } else if (as === 'select') {
    control = (
      <select
        ref={ref as React.Ref<HTMLSelectElement>}
        {...(commonProps as SelectHTMLAttributes<HTMLSelectElement>)}
      />
    );
  } else {
    control = (
      <input
        ref={ref as React.Ref<HTMLInputElement>}
        {...(commonProps as InputHTMLAttributes<HTMLInputElement>)}
      />
    );
  }

  return (
    <div className={cn('w-full', wrapperClassName)}>
      {label && (
        <label
          htmlFor={id}
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          {label}
        </label>
      )}
      <div className={leftIcon || rightAddon ? 'relative flex items-center' : undefined}>
        {leftIcon && (
          <span
            className="pointer-events-none absolute left-3 flex items-center text-gray-400 dark:text-gray-500"
            aria-hidden="true"
          >
            {leftIcon}
          </span>
        )}
        {control}
        {rightAddon && <span className="ml-2 flex-shrink-0">{rightAddon}</span>}
      </div>
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
