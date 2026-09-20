import { AlertCircle } from "lucide-react"

export default function StatsNotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <AlertCircle className="h-12 w-12 text-red-500" />
      <h1 className="text-xl font-semibold">Stats View Not Found</h1>
      <p className="text-slate-500">
        This stats view does not exist or you don&apos;t have access to it.
      </p>
    </div>
  )
}
