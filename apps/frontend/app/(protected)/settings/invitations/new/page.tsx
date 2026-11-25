import { InvitationDetailClient } from "../invitation-detail-client"
import { getLoginAuthProviders } from "@/lib/auth/providers"

export const instant = false

export default async function NewInvitationPage() {
  const { invitationMethods } = await getLoginAuthProviders().catch(() => ({
    invitationMethods: { sso: false, passkey: false },
  }))
  return <InvitationDetailClient invitationMethods={invitationMethods} />
}
