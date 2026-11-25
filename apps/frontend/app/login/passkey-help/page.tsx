import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Signing in with passkeys",
}

export default function PasskeyHelpPage() {
  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 px-4 py-10 sm:py-16">
      <h1 className="text-3xl font-bold">Signing in with passkeys</h1>
      <p className="text-muted-foreground">
        A passkey saved on your phone may also be available on your computer
        through your password manager. Use the browser that can access it, then
        choose Sign in with Passkey on the login page.
      </p>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Google Password Manager</h2>
        <p>
          Use Chrome signed into the same Google account, with access to your
          synced passkey. Follow the browser’s prompts; you may be asked for
          your Google Password Manager PIN or your device’s screen lock.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">
          Apple Passwords / iCloud Keychain
        </h2>
        <p>
          Use Safari on your Mac, iPhone or iPad with the same Apple Account and
          password syncing enabled in iCloud Passwords &amp; Keychain. Follow
          the browser’s prompts to use your saved passkey.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Passkey missing in Firefox?</h2>
        <p>
          Try the browser associated with your password manager. Hardware
          security keys such as YubiKeys can still work in Firefox.
        </p>
      </section>

      <p className="text-sm text-muted-foreground">
        Availability varies with your operating system, browser version and
        password-manager settings. A synced passkey can work directly on your
        computer; a QR code or nearby phone is not always needed.
      </p>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Register once, then sign in</h2>
        <p>
          If you were invited, use your Registration Link to set up your account
          and first passkey. After that, use the normal login page. Creating
          your passkey on a phone does not mean you need to register your
          account again on desktop.
        </p>
      </section>

      <Link href="/login" className="inline-block underline underline-offset-4">
        Back to login
      </Link>
    </main>
  )
}
