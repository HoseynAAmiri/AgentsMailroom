import { cn } from "@/lib/utils";
import type { View } from "./context";

export function Bone({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-muted", className)} />;
}

function ThreadRowSkeleton() {
  return (
    <div className="flex items-start gap-3 border-b px-3 py-2.5">
      <Bone className="size-8 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <div className="flex gap-3">
          <Bone className="h-3 w-28" />
          <Bone className="ml-auto h-3 w-10" />
        </div>
        <Bone className="h-3 w-4/5" />
        <Bone className="h-2.5 w-2/3" />
      </div>
    </div>
  );
}

function MailSkeleton() {
  return (
    <div className="flex h-full min-h-0" aria-busy="true" aria-label="Loading mail">
      <div className="hidden w-[17%] min-w-[180px] max-w-[28%] flex-col gap-2 border-r p-3 md:flex">
        <Bone className="mb-1 h-3 w-16" />
        {Array.from({ length: 8 }, (_, i) => <Bone key={i} className="h-7 w-full" />)}
      </div>
      <div className="flex w-full min-w-0 flex-col border-r md:w-[30%]">
        <div className="flex items-center gap-2 border-b px-3 py-3">
          <Bone className="h-4 w-32" />
        </div>
        {Array.from({ length: 7 }, (_, i) => <ThreadRowSkeleton key={i} />)}
      </div>
      <div className="hidden min-w-0 flex-1 flex-col gap-3 p-5 md:flex">
        <Bone className="h-5 w-2/3" />
        <Bone className="h-3 w-1/3" />
        <Bone className="mt-4 h-3 w-full" />
        <Bone className="h-3 w-11/12" />
        <Bone className="h-3 w-4/5" />
        <Bone className="mt-6 h-3 w-full" />
        <Bone className="h-3 w-10/12" />
        <Bone className="h-3 w-3/5" />
      </div>
    </div>
  );
}

export function GoalsSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-3 py-4 sm:px-5" aria-busy="true" aria-label="Loading goals">
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 5 }, (_, i) => <Bone key={i} className="h-7 w-20 rounded-md" />)}
      </div>
      <div className="grid grid-cols-5 gap-2">
        {Array.from({ length: 5 }, (_, i) => <Bone key={i} className="h-8 w-full rounded-md" />)}
      </div>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="space-y-2 rounded-xl border px-3 py-3">
          <div className="flex items-center gap-2">
            <Bone className="h-5 w-10" />
            <Bone className="h-3.5 w-48" />
            <Bone className="ml-auto h-5 w-8" />
          </div>
          <Bone className="h-2 w-full" />
        </div>
      ))}
    </div>
  );
}

function TeamSkeleton() {
  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 p-3 sm:p-6" aria-busy="true" aria-label="Loading team">
      <Bone className="h-5 w-24" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="space-y-3 rounded-xl border p-4">
            <div className="flex items-center gap-3">
              <Bone className="size-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <Bone className="h-3.5 w-24" />
                <Bone className="h-2.5 w-16" />
              </div>
            </div>
            <Bone className="h-2.5 w-full" />
            <Bone className="h-2.5 w-4/5" />
          </div>
        ))}
      </div>
    </div>
  );
}

function MachineSkeleton() {
  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-6 p-3 sm:p-6" aria-busy="true" aria-label="Loading machines">
      <Bone className="h-5 w-32" />
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="space-y-3">
          <Bone className="h-4 w-40" />
          <Bone className="h-3 w-full" />
          <Bone className="h-3 w-11/12" />
          <Bone className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

export function FilesSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true" aria-label="Loading files">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b px-3 py-3 sm:px-4">
          <Bone className="size-4 shrink-0" />
          <Bone className="h-3 w-2/3" />
          <Bone className="ml-auto h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

export function PageSkeleton({ view }: { view: View }) {
  if (view === "goals") return <GoalsSkeleton />;
  if (view === "team") return <TeamSkeleton />;
  if (view === "machine") return <MachineSkeleton />;
  if (view === "files") return <FilesSkeleton />;
  return <MailSkeleton />;
}
