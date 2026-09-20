interface ListDetailTitleInput {
  readonly name: string
  readonly detailName?: string | null
}

export function listDetailTitle(
  list: ListDetailTitleInput | null | undefined,
): string | undefined {
  if (!list) return undefined

  const explicitTitle = list.detailName?.trim()
  if (explicitTitle) return explicitTitle

  // Fallback only covers generic "All X enquiries" list names; orgs can pass
  // detailName for irregular nouns or domain-specific item titles.
  const title = list.name.trim().replace(/^All\s+/i, "")
  const singularTitle = title.replace(/enquiries$/i, "enquiry")

  return singularTitle.charAt(0).toUpperCase() + singularTitle.slice(1)
}
