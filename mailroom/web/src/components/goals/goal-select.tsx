"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface GoalOption { value: string; label: string }

export function GoalSelect({ label, value, onChange, options, className, disabled }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: GoalOption[];
  className?: string;
  disabled?: boolean;
}) {
  const items = options.map((option) => ({ value: option.value, label: option.label }));
  return (
    <Select value={value} items={items} disabled={disabled} onValueChange={(next) => { if (next !== null) onChange(next); }}>
      <SelectTrigger aria-label={label} className={cn("h-11 w-full min-w-0 justify-between sm:h-9", className)}>
        <SelectValue className="min-w-0 truncate" />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="max-w-[calc(100vw-1.5rem)]">
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value} className="min-h-10 min-w-0 touch:min-h-11">
            <span className="min-w-0 truncate">{item.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
