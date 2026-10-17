import type { JSX } from 'preact';

export interface SegmentedProps<T extends string> {
  value: T;
  options: readonly { value: T; label: string }[];
  label: string;
  disabled?: boolean;
  onChange(value: T): void;
  'data-testid'?: string;
}

export function Segmented<T extends string>({ value, options, label, disabled, onChange, 'data-testid': id = 'segmented' }: SegmentedProps<T>): JSX.Element {
  return (
    <div class="ui-segmented" role="radiogroup" aria-label={label} data-testid={id}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value ? 'true' : 'false'}
          class={option.value === value ? 'ui-segment ui-segment-on' : 'ui-segment'}
          data-testid={`${id}-${option.value}`}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
