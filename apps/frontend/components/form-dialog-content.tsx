"use client"

import { XIcon } from "lucide-react"
import type * as React from "react"
import { buttonVariants } from "@pf/shadcn-components"
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

interface FormDialogContentProps {
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}

export function FormDialogContent({
  title,
  description,
  children,
  className,
  bodyClassName,
}: FormDialogContentProps) {
  return (
    <DialogContent
      showCloseButton={false}
      className={cn(
        "flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-md",
        className,
      )}
    >
      <div className="relative shrink-0 border-b bg-background px-6 py-6 pr-14">
        <DialogHeader className="text-left">
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogClose
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-sm" }),
            "absolute top-4 right-4 opacity-70 ring-offset-background",
            "focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden",
          )}
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </DialogClose>
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto px-6 py-4",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </DialogContent>
  )
}
