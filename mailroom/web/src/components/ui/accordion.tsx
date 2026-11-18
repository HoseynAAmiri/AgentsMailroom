"use client";

import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const Accordion = AccordionPrimitive.Root;
const AccordionItem = AccordionPrimitive.Item;

function AccordionTrigger({ children, className, ...props }: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Header className="min-w-0 flex-1">
      <AccordionPrimitive.Trigger {...props} data-slot="accordion-trigger"
        className={cn("group/accordion-trigger flex min-h-12 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50 touch:min-h-14", className)}>
        {children}
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open/accordion-trigger:rotate-180 motion-reduce:transition-none" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({ className, ...props }: AccordionPrimitive.Panel.Props) {
  return <AccordionPrimitive.Panel {...props} data-slot="accordion-content" className={cn("px-2 pb-2", className)} />;
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
