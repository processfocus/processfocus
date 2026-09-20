export function canOpenPasskeysMenu(
  listing:
    | { kind: "success" }
    | { kind: "denied" }
    | { kind: "error" }
    | undefined,
): boolean {
  return listing?.kind === "success"
}
