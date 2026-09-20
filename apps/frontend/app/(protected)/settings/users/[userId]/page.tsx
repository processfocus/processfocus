import { Suspense } from "react"
import { UserEditClient } from "./client"

interface UserEditPageProps {
  params: Promise<{
    userId: string
  }>
}

async function Content({ params }: UserEditPageProps) {
  const { userId } = await params
  return <UserEditClient userId={userId} />
}

export default function UserEditPage(props: UserEditPageProps) {
  return (
    <Suspense fallback={null}>
      <Content {...props} />
    </Suspense>
  )
}
