"use client";

import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface SearchOption<Value extends string = string> {
  value: Value;
  label: string;
  triggerLabel?: string;
}

export function SearchableSelect<Value extends string>({
  label,
  value,
  onChange,
  options,
  placeholder = "Choose…",
  searchPlaceholder = "Search options…",
  className,
  disabled,
  compact,
}: {
  label: string;
  value: Value | null;
  onChange: (value: Value) => void;
  options: readonly SearchOption<Value>[];
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const selected = options.find((option) => option.value === value);
  const display = selected?.triggerLabel ?? selected?.label ?? placeholder;

  return (
    <Combobox.Root
      items={options}
      value={selected ?? null}
      onValueChange={(option) => { if (option !== null) onChange(option.value); }}
      disabled={disabled}
      autoHighlight
    >
      <Combobox.Trigger
        aria-label={label}
        render={<Button
          type="button"
          size={compact ? "sm" : "lg"}
          variant="outline"
          className={cn("min-w-0 justify-between", compact ? "max-w-44 touch:min-h-9" : "w-full touch:min-h-10", className)}
        />}
      >
        <span className="truncate">{display}</span>
        <Combobox.Icon render={<ChevronDown className="size-3.5 text-muted-foreground" />} />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={5} align={compact ? "end" : "start"} className="z-50">
          <Combobox.Popup className="flex max-h-(--available-height) w-[max(15rem,var(--anchor-width))] max-w-[min(var(--available-width),calc(100dvw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md">
            <div className="flex shrink-0 items-center gap-2 border-b px-3">
              <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <Combobox.Input
                aria-label={`Search ${label.toLowerCase()} options`}
                placeholder={searchPlaceholder}
                className="h-10 w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
              />
            </div>
            <Combobox.Empty className="px-3 py-4 text-center text-sm text-muted-foreground empty:hidden">No matching options.</Combobox.Empty>
            <Combobox.List className="min-h-0 max-h-60 overflow-y-auto overscroll-contain p-1 empty:hidden">
              {(option: SearchOption<Value>) => (
                <Combobox.Item
                  key={option.value}
                  value={option}
                  className="flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground touch:min-h-11"
                >
                  <span className="w-4 shrink-0">
                    <Combobox.ItemIndicator><Check className="size-4" /></Combobox.ItemIndicator>
                  </span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">{option.label}</span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
