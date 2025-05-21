// src/components/ui/Modal.tsx
import { cn } from "@/lib/utils";
import * as React from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogClose, // Import DialogClose
} from "@/components/ui/dialog" // Uses the dialog component above
import { Button } from "@/components/ui/button" // Assuming button exists

interface ModalProps {
  trigger?: React.ReactNode; // Make trigger optional for controlled modals
  title: string;
  children: React.ReactNode; // Content of the modal
  description?: string;
  isOpen?: boolean; // Controlled open state
  onOpenChange?: (open: boolean) => void; // Handler for controlled state
  className?: string; // Allow passing className to DialogContent
}

export function Modal({
  trigger,
  title,
  description,
  children,
  isOpen,
  onOpenChange,
  className
}: ModalProps) {
  // If trigger is provided, wrap it
  const TriggerWrapper = trigger ? DialogTrigger : React.Fragment;
  const triggerProps = trigger ? { asChild: true } : {};


  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <TriggerWrapper {...triggerProps}>{trigger}</TriggerWrapper>
      <DialogContent className={cn("sm:max-w-[625px]", className)}> {/* Adjust width, allow override */}
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {/* Make content area scrollable */}
        <div className="py-4 max-h-[60vh] overflow-y-auto pr-2">
          {children}
        </div>
         <DialogFooter>
           {/* Simple close button in footer */}
           <DialogClose asChild>
              <Button variant="outline">Close</Button>
           </DialogClose>
         </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}