import { Clock, Effect } from "effect"

/** Fresh facade: the default Clock is shared and must never be mutated by tests. */
export const makeClock = (): Clock.Clock => {
  const clock = Effect.runSync(Clock.Clock)
  return {
    currentTimeMillis: clock.currentTimeMillis,
    currentTimeNanos: clock.currentTimeNanos,
    monotonicTimeNanos: clock.monotonicTimeNanos,
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    sleep: (duration) => clock.sleep(duration),
  }
}
