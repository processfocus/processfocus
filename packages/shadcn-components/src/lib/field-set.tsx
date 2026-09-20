import type React from "react"
import { FieldGroup, FieldLegend, FieldSet } from "./ui/field"

export function FieldSetField({
  label,
  children,
}: React.PropsWithChildren<{ label: string }>) {
  return (
    <FieldSet>
      <FieldLegend>{label}</FieldLegend>
      <FieldGroup className="[&>*]:w-full">{children}</FieldGroup>
    </FieldSet>
  )
}
