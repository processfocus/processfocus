export * from "../../form-rule/src/index.js"

export const validateOrganisation = (organisation: {
  readonly processes: () => ReadonlyArray<{
    readonly node: { readonly path: string }
    validateFlows(): Readonly<Record<string, readonly string[]>>
  }>
}): readonly string[] =>
  organisation.processes().flatMap((process) =>
    Object.values(process.validateFlows())
      .flat()
      .map((message) => `${process.node.path}: ${message}`),
  )
