export function canOpenActOnBehalfMenu(
  listing:
    | { kind: "success" }
    | { kind: "denied" }
    | { kind: "error" }
    | undefined,
): boolean {
  return listing?.kind === "success"
}
