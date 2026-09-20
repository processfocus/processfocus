import { Suspense } from "react"
import { InvitationDetailClient } from "../invitation-detail-client"
import { InvitationDetailSkeleton } from "../invitation-detail-skeleton"

interface InvitationDetailPageProps {
  params: Promise<{
    invitationId: string
  }>
}

async function Content({ params }: InvitationDetailPageProps) {
  const { invitationId } = await params
  return <InvitationDetailClient invitationId={invitationId} />
}

export default function InvitationDetailPage(props: InvitationDetailPageProps) {
  return (
    <Suspense fallback={<InvitationDetailSkeleton />}>
      <Content {...props} />
    </Suspense>
  )
}
