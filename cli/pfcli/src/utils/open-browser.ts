import { Console, Effect } from "effect"
import { AuthLoginError } from "../errors"

type BrowserPlatform = NodeJS.Platform

type SpawnBrowser = (args: readonly string[]) => Promise<unknown>

type LogBrowserMessage = (message: string) => Effect.Effect<void>

export const validateBrowserUrl = (url: string): URL => {
  const parsedUrl = new URL(url)

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(
      `Unsupported browser URL protocol: ${parsedUrl.protocol || "unknown"}`,
    )
  }

  return parsedUrl
}

export const browserCommand = (
  url: string,
  platform: BrowserPlatform,
): string[] => {
  validateBrowserUrl(url)

  if (platform === "darwin") {
    return ["open", url]
  }

  if (platform === "win32") {
    return ["rundll32.exe", "url.dll,FileProtocolHandler", url]
  }

  return ["xdg-open", url]
}

/**
 * Open a URL in the user's default browser.
 *
 * Uses `open` on macOS, `xdg-open` on Linux, and `rundll32.exe` on Windows.
 * Failures are swallowed — the URL is always printed to the terminal
 * as a fallback so the user can open it manually.
 */
export const openBrowserWith = (
  url: string,
  platform: BrowserPlatform,
  spawn: SpawnBrowser,
  log: LogBrowserMessage = Console.log,
): Effect.Effect<void, AuthLoginError> =>
  Effect.gen(function* () {
    const args = yield* Effect.try({
      try: () => browserCommand(url, platform),
      catch: (cause) =>
        new AuthLoginError({
          message:
            cause instanceof Error ? cause.message : "Invalid browser URL",
          cause,
        }),
    })

    yield* log(`\nOpening browser: ${url}`)
    yield* log("If the browser does not open, visit the URL above.\n")

    yield* Effect.tryPromise({
      try: () => spawn(args),
      catch: () => "browser-open-failed" as const,
    }).pipe(Effect.ignore)
  })

export const openBrowser = (url: string) =>
  openBrowserWith(url, process.platform, (args) => {
    const proc = Bun.spawn([...args], {
      stdout: "ignore",
      stderr: "ignore",
    })
    return proc.exited
  })
