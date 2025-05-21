// src/components/ui/sonner.tsx
"use client" // Often used with shadcn/ui components for client-side interactivity

import { Toaster as SonnerToaster } from "sonner"

type ToasterProps = React.ComponentProps<typeof SonnerToaster>

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <SonnerToaster
      // theme prop removed, sonner defaults to light theme. 
      // Alternatively, you could explicitly set theme="light"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          success: 
            "group-[.toast]:bg-green-100 group-[.toaster]:text-green-800 group-[.toaster]:border-green-300",
          error: 
            "group-[.toast]:bg-red-100 group-[.toaster]:text-red-800 group-[.toaster]:border-red-300",
          info: 
            "group-[.toast]:bg-blue-100 group-[.toaster]:text-blue-800 group-[.toaster]:border-blue-300",
          warning: 
            "group-[.toast]:bg-yellow-100 group-[.toaster]:text-yellow-800 group-[.toaster]:border-yellow-300",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }