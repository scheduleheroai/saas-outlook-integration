// src/components/ui/InfoModal.tsx
import React from 'react';
import { HelpCircle} from 'lucide-react'; // Keep X import if DialogContent uses it internally, or remove if not needed elsewhere
import {
  Dialog,
  DialogContent,  
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  // Removed DialogClose import as we'll use the default one from DialogContent
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface InfoModalProps {
  title: string;
  description: React.ReactNode; // Allow rich text or components
  videoUrl?: string; // Optional URL for embeddable video (e.g., YouTube, Vimeo)
  triggerClassName?: string; // Optional class for positioning/styling the trigger
  modalContentClassName?: string; // Optional class for modal content styling
}

export const InfoModal: React.FC<InfoModalProps> = ({
  title,
  description,
  videoUrl,
  triggerClassName,
  modalContentClassName,
}) => {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button" // Prevent form submission if inside a form
          variant="ghost"
          size="icon"
          className={cn('h-5 w-5 text-muted-foreground hover:text-foreground cursor-help p-0', triggerClassName)}
          aria-label={`More info about ${title}`}
        >
          <HelpCircle className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent
        className={cn("sm:max-w-[525px]", modalContentClassName)}
        onOpenAutoFocus={(e) => e.preventDefault()} // Prevent auto-focusing first element
      >
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
          {/* The default X close button is rendered by DialogContent automatically */}
          {/* === REMOVED MANUAL CLOSE BUTTON START === */}
          {/*
          <DialogClose asChild>
              <Button
              variant="ghost"
              size="icon"
              className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground"
              aria-label="Close"
              >
              <X className="h-4 w-4" />
              </Button>
          </DialogClose>
          */}
          {/* === REMOVED MANUAL CLOSE BUTTON END === */}
        </DialogHeader>
        <div className="mt-4 space-y-4 text-sm text-muted-foreground">
          {typeof description === 'string' ? <p>{description}</p> : description}

          {videoUrl && (
            <div className="aspect-video w-full overflow-hidden rounded-md border">
              <iframe
                width="100%"
                height="100%"
                src={videoUrl} // Basic embed, might need adjustments based on video provider for autoplay, controls etc.
                title={`${title} Video Tutorial`}
                frameBorder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              ></iframe>
            </div>
          )}
        </div>
        {/* No explicit footer needed unless required later */}
      </DialogContent>
    </Dialog>
  );
};

export default InfoModal;