import { Effect } from "effect"
import { browserCommand, openBrowserWith } from "../src/utils/open-browser"
import { describe, expect, it } from "bun:test"

const hostileUrl =
  'https://user@example.com/cli-auth?characters=&|"()$(test)&literal=a&b|c"d(e)$(f)'

describe("openBrowser", () => {
  it.each([
    ["darwin", ["open", hostileUrl]],
    ["linux", ["xdg-open", hostileUrl]],
    ["win32", ["rundll32.exe", "url.dll,FileProtocolHandler", hostileUrl]],
  ] as const)(
    "selects the %s opener without changing the URL",
    (platform, expected) => {
      expect(browserCommand(hostileUrl, platform)).toEqual([...expected])
    },
  )

  it("passes the Windows URL as one literal child-process argument", async () => {
    const spawnedCommands: string[][] = []

    await Effect.runPromise(
      openBrowserWith(
        hostileUrl,
        "win32",
        (args) => {
          spawnedCommands.push([...args])
          return Promise.resolve(0)
        },
        () => Effect.void,
      ),
    )

    expect(spawnedCommands).toEqual([
      ["rundll32.exe", "url.dll,FileProtocolHandler", hostileUrl],
    ])
  })

  it.each([
    "ftp://example.com/file",
    "file:///tmp/login.html",
    "javascript:alert(1)",
  ])("rejects the non-HTTP(S) URL %s", (url) => {
    expect(() => browserCommand(url, "win32")).toThrow(
      "Unsupported browser URL protocol",
    )
  })

  it("prints the fallback URL and succeeds when the opener fails", async () => {
    const url = "http://localhost:3000/cli-auth"
    const messages: string[] = []

    await expect(
      Effect.runPromise(
        openBrowserWith(
          url,
          "linux",
          () => Promise.reject(new Error("xdg-open failed")),
          (message) => Effect.sync(() => messages.push(message)),
        ),
      ),
    ).resolves.toBeUndefined()

    expect(messages.join("\n")).toContain(url)
    expect(messages.join("\n")).toContain(
      "If the browser does not open, visit the URL above.",
    )
  })
})
