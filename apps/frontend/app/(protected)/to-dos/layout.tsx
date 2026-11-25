// The protected layout can omit this subtree while checking the session.
export const instant = false

export default function ToDosLayout({
  children,
  modal,
}: {
  children: React.ReactNode
  modal: React.ReactNode
}) {
  return (
    <>
      {children}
      {modal}
    </>
  )
}
