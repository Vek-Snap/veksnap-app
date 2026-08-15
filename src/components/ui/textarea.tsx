import * as React from "react"

import { cn } from "@/lib/utils"
import { usePersistentTextareaHeight } from "@/lib/prompt-heights"

// `persistId`: opt-in. When set, the field's drag-resized height is remembered
// and restored (and travels with the save-state). Omit it for non-prompt fields.
function Textarea({ className, persistId, ...props }: React.ComponentProps<"textarea"> & { persistId?: string }) {
  const heightRef = usePersistentTextareaHeight(persistId)
  return (
    <textarea
      ref={heightRef}
      data-slot="textarea"
      className={cn(
        "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
