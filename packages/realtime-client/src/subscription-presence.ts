// This module is also consumed by Node E2E and CLI clients.
const runtimeGlobals: object = globalThis
const browserWindow =
  "window" in runtimeGlobals && runtimeGlobals.window instanceof EventTarget
    ? runtimeGlobals.window
    : undefined
const browserDocument =
  "document" in runtimeGlobals && runtimeGlobals.document instanceof EventTarget
    ? runtimeGlobals.document
    : undefined

/** One credential-bound presence lease per acknowledged RxDB subscription. */
export class SubscriptionPresenceLease {
  private readonly id = crypto.randomUUID()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped: Promise<void> | undefined
  private catchUpRequested = false
  private active = false
  private pending = false
  private lastRenewalStartedAt = 0
  private readonly heartbeatMs: number
  private readonly presenceChannel: string | undefined

  constructor(
    private readonly config: {
      token: string
      httpHost: string
      channel: string
      heartbeatMs?: number
      onReady: () => void
      onLost: () => void
    },
  ) {
    this.heartbeatMs = config.heartbeatMs ?? 30_000
    if (!Number.isFinite(this.heartbeatMs) || this.heartbeatMs < 100)
      throw new Error("Invalid presence heartbeat interval")
    const match = /^\/rxdb\/collection\/([^/]+)\/user\/([^/]+)$/.exec(
      config.channel,
    )
    this.presenceChannel = match
      ? `/presence/${match[1]}/${match[2]}`
      : undefined
  }

  get authorization(): string {
    return this.presenceChannel
      ? this.credential("subscribe")
      : this.config.token
  }

  private credential(
    action: "subscribe" | "open" | "renew" | "remove",
  ): string {
    return JSON.stringify({
      v: 1,
      token: this.config.token,
      id: this.id,
      action,
    })
  }

  private async request(action: "open" | "renew" | "remove"): Promise<void> {
    if (!this.presenceChannel) return
    const scheme = /^(localhost|127\.0\.0\.1)(:|$)/.test(this.config.httpHost)
      ? "http"
      : "https"
    const response = await fetch(`${scheme}://${this.config.httpHost}/event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.credential(action),
      },
      body: JSON.stringify({ channel: this.presenceChannel, events: ["{}"] }),
      keepalive: action === "remove",
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error("Subscription presence request failed")
    const result: unknown = await response.json()
    if (
      typeof result !== "object" ||
      result === null ||
      ("failed" in result &&
        Array.isArray(result.failed) &&
        result.failed.length > 0)
    )
      throw new Error("Subscription presence rejected")
  }

  async start(): Promise<void> {
    if (this.active || this.stopped) return
    this.active = true
    const requestedAt = Date.now()
    try {
      await this.request("open")
      if (!this.active) return
      this.lastRenewalStartedAt = requestedAt
      this.config.onReady()
      if (!this.presenceChannel) return
      browserDocument?.addEventListener("visibilitychange", this.resume)
      browserWindow?.addEventListener("pageshow", this.resume)
      browserWindow?.addEventListener("pagehide", this.pagehide)
      this.schedule()
    } catch {
      if (this.active) this.config.onLost()
    }
  }

  private readonly resume = (): void => {
    if (
      !browserDocument ||
      !("visibilityState" in browserDocument) ||
      browserDocument.visibilityState !== "hidden"
    )
      void this.renew(true)
  }
  private readonly pagehide = (): void => {
    void this.stop()
    this.config.onLost()
  }

  private schedule(): void {
    if (this.active)
      this.timer = setTimeout(() => void this.renew(false), this.heartbeatMs)
  }

  private async renew(resumed: boolean): Promise<void> {
    this.catchUpRequested ||= resumed
    if (!this.active || this.pending) return
    this.pending = true
    if (this.timer) clearTimeout(this.timer)
    const requestedAt = Date.now()
    const catchUp =
      this.catchUpRequested ||
      requestedAt - this.lastRenewalStartedAt > this.heartbeatMs * 1.5
    try {
      await this.request("renew")
      if (!this.active) return
      // The server starts the lease while processing the request. Measuring
      // from response completion would hide gaps caused by response latency.
      this.lastRenewalStartedAt = requestedAt
      // Renewal can restore an expired lease; pull after the lease is visible.
      if (catchUp || this.catchUpRequested) this.config.onReady()
      this.catchUpRequested = false
      this.schedule()
    } catch {
      if (this.active) this.config.onLost()
    } finally {
      this.pending = false
    }
  }

  stop(): Promise<void> {
    if (this.stopped) return this.stopped
    this.active = false
    if (this.timer) clearTimeout(this.timer)
    browserDocument?.removeEventListener("visibilitychange", this.resume)
    browserWindow?.removeEventListener("pageshow", this.resume)
    browserWindow?.removeEventListener("pagehide", this.pagehide)
    // Best effort on page unload; hard loss is bounded by the server lease.
    this.stopped = this.request("remove").catch(() => undefined)
    return this.stopped
  }
}
