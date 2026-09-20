"use client"

import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { ExecutionsPageContent } from "../../page"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

interface ExecutionDetailModalClientProps {
  executionId: string
}

export default function ExecutionDetailModalClient({
  executionId,
}: ExecutionDetailModalClientProps) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const [isVisible, setIsVisible] = useState(false)
  const closeTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!isMobile) return

    const animationFrame = window.requestAnimationFrame(() => {
      setIsVisible(true)
    })

    return () => {
      window.cancelAnimationFrame(animationFrame)
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
    }
  }, [isMobile])

  const handleClose = () => {
    if (closeTimerRef.current !== null) {
      return
    }

    setIsVisible(false)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      router.back()
    }, 220)
  }

  if (!isMobile) {
    return null
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Execution detail"
      className="fixed inset-x-0 top-16 bottom-0 z-50 overflow-hidden"
    >
      <div
        className={cn(
          "flex h-full w-full flex-col overflow-hidden bg-background px-4 pt-4 pb-10 shadow-2xl transition-transform duration-300 ease-out will-change-transform motion-reduce:transition-none",
          isVisible ? "translate-x-0" : "translate-x-full",
        )}
      >
        <ExecutionsPageContent
          initialSelectedExecutionId={executionId}
          onMobileBack={handleClose}
        />
      </div>
    </div>
  )
}
