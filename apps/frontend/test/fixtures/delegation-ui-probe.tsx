import { createRoot } from "react-dom/client"
import { SecretLoginForm } from "../../app/login/secret-login-form"
import { DelegationExpiry } from "../../components/delegation-expiry"

const root = document.getElementById("root")
if (!root) throw new Error("Missing probe root")
createRoot(root).render(
  <main>
    <h1>Delegated access component probe</h1>
    <p>Isolated UI only. Authentication is deliberately unavailable.</p>
    <SecretLoginForm enabled />
    <h2>Profile expiry</h2>
    <DelegationExpiry expiresAt={Date.UTC(2030, 0, 1, 12)} />
  </main>,
)
