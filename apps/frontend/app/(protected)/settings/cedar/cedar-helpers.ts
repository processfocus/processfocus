export const genericPrincipalId = (rolePath: string): string => {
  const slug =
    rolePath
      .split("/")
      .filter(Boolean)
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-") || "role"
  return `${slug}@prototype.local`
}

export const orgUnitFromRole = (rolePath: string): string => {
  const parts = rolePath.split("/").filter(Boolean)
  if (parts.length <= 1) return "/"
  return `/${parts.slice(0, -1).join("/")}`
}
