// The authenticated shell can omit this subtree before a session is ready.
export const instant = false

export default function ListsLayout({
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
