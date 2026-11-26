import { Effect } from "effect"

export const returnedRow = <Row>(rows: readonly Row[]) => {
  const row = rows[0]
  return row === undefined
    ? Effect.die("Database write returned no row")
    : Effect.succeed(row)
}
