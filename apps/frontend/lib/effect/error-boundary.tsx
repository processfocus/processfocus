"use client"

import React from "react"

interface ErrorBoundaryProps {
  children: React.ReactNode
  fallback?: (error: Error) => React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * Error boundary component for catching Effect errors in React components.
 * Provides a fallback UI when an error occurs.
 *
 * @example
 * ```tsx
 * <EffectErrorBoundary fallback={(error) => <div>Error: {error.message}</div>}>
 *   <MyComponent />
 * </EffectErrorBoundary>
 * ```
 */
export class EffectErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Effect Error Boundary caught an error:", error, errorInfo)
  }

  override render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error)
      }

      return (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <h2 className="text-lg font-semibold text-red-900">
            Something went wrong
          </h2>
          <p className="mt-2 text-sm text-red-700">
            {this.state.error.message}
          </p>
        </div>
      )
    }

    return this.props.children
  }
}

/**
 * Default error fallback component with a clean UI.
 */
export const DefaultErrorFallback = ({ error }: { error: Error }) => (
  <div className="flex min-h-[400px] items-center justify-center">
    <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-6">
      <h2 className="mb-2 text-xl font-semibold text-red-900">
        Something went wrong
      </h2>
      <p className="mb-4 text-sm text-red-700">{error.message}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
      >
        Reload page
      </button>
    </div>
  </div>
)
