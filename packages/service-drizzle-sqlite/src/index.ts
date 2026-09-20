// Keep @effect/sql-drizzle/Sqlite in the package's public declaration graph so
// project-reference dependents receive QueryPromise's Effect augmentation.
// (Previously pulled in transitively by the unused makeDrizzleLive export.)
import "@effect/sql-drizzle/Sqlite"

export * from "./lib/typed-drizzle"
