// src/components/ui/skeleton.tsx
import { cn } from "@/lib/utils" // Assuming utils.ts exists

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-muted", // Uses themed muted color (Soft Light Gray)
        className
        )}
      {...props}
    />
  )
}

export { Skeleton }