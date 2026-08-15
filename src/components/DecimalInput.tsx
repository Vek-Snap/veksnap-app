"use client";

import { useEffect, useState } from "react";

/**
 * DecimalInput: a decimal-safe numeric text input.
 *
 * Fixes the "can only type a single digit" bug caused by binding a controlled
 * input's value directly to a number while coercing every keystroke with
 * `parseFloat(e.target.value) || 0`. Typing an intermediate string like "1.",
 * "-", "0.0" or "" would immediately re-render back to the parsed number,
 * erasing the character being typed (so decimals were impossible).
 *
 * This component keeps a local string buffer while the field is focused,
 * commits the parsed value to the parent on each valid keystroke, and clamps +
 * formats only on blur. It never fights the user mid-edit.
 */
interface DecimalInputProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  className?: string;
  title?: string;
  /** Fixed decimal places to display when NOT actively editing (e.g. 2 → "1.00"). */
  decimals?: number;
  placeholder?: string;
}

export default function DecimalInput({
  value,
  onChange,
  min,
  max,
  disabled,
  className,
  title,
  decimals,
  placeholder,
}: DecimalInputProps) {
  const format = (n: number) => (decimals != null ? n.toFixed(decimals) : String(n));

  const [text, setText] = useState<string>(format(value));
  const [focused, setFocused] = useState(false);

  // Re-sync the buffer from the prop only when the user isn't actively editing,
  // so external updates (slider, reset) are reflected without disrupting typing.
  useEffect(() => {
    if (!focused) setText(decimals != null ? value.toFixed(decimals) : String(value));
  }, [value, focused, decimals]);

  const clamp = (n: number) => {
    let out = n;
    if (min != null && out < min) out = min;
    if (max != null && out > max) out = max;
    return out;
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      disabled={disabled}
      title={title}
      placeholder={placeholder}
      className={className}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        const raw = e.target.value;
        // Permit only number-ish transient strings ("", "-", "1.", ".5", "-1.25").
        if (!/^-?\d*\.?\d*$/.test(raw)) return;
        setText(raw);
        const n = parseFloat(raw);
        if (!Number.isNaN(n)) onChange(n);
      }}
      onBlur={() => {
        setFocused(false);
        let n = parseFloat(text);
        if (Number.isNaN(n)) n = 0;
        n = clamp(n);
        onChange(n);
        setText(format(n));
      }}
    />
  );
}
