export default function EmbedLoading() {
  return (
    <div className="mx-auto flex min-h-40 w-full max-w-3xl items-center justify-center px-4 py-10 sm:px-6">
      <output className="block text-center" aria-live="polite">
        <span
          className="border-primary/30 border-t-primary inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid motion-reduce:animate-[spin_1.5s_linear_infinite]"
          aria-hidden="true"
        />
        <p className="text-muted-foreground mt-4 text-sm">Loading form...</p>
      </output>
    </div>
  )
}
