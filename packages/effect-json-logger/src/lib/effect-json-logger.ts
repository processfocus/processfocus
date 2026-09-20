import { Inspectable, Logger } from "effect"

/**
 * Process message to handle the common pattern of [string, object].
 * If message is [string, plainObject], extracts the string as message
 * and the object as extra fields.
 */
const processMessage = (
  message: unknown,
): { message: unknown; extra?: Record<string, unknown> } => {
  if (
    Array.isArray(message) &&
    message.length === 2 &&
    typeof message[0] === "string" &&
    typeof message[1] === "object" &&
    message[1] !== null &&
    !Array.isArray(message[1])
  ) {
    return { message: message[0], extra: message[1] as Record<string, unknown> }
  }
  return { message }
}

/**
 * Custom JSON logger that writes directly to stdout.
 * This avoids AWS Lambda's console.log wrapper which would nest our JSON.
 *
 * Use this logger in AWS Lambda environments to get clean JSON logs
 * that work well with CloudWatch and other log aggregation tools.
 *
 * Composes with Effect's built-in structuredLogger to ensure consistent
 * output format with Effect's standard JSON logger.
 *
 * Special handling: if message is [string, object], the string becomes
 * the message and the object fields are merged into the root JSON
 * (standard fields like level, timestamp, etc. take precedence).
 */
export const stdoutJsonLogger: Logger.Logger<unknown, void> = Logger.map(
  Logger.structuredLogger,
  ({ logLevel, message, ...rest }) => {
    const { message: processedMessage, extra } = processMessage(message)
    // Spread extra first so standard fields take precedence. However,
    // structuredLogger always emits `cause` (undefined when absent), which
    // must not clobber an extra `cause` field such as the payload passed to
    // `Effect.logError("...", { cause })`.
    const { cause, ...restWithoutCause } = rest
    const output = {
      ...extra,
      level: logLevel,
      message: processedMessage,
      ...restWithoutCause,
      ...(cause === undefined ? {} : { cause }),
    }
    process.stdout.write(`${Inspectable.stringifyCircular(output)}\n`)
  },
)

/**
 * Logger layer that replaces the default logger with stdoutJsonLogger.
 * Use this in production AWS environments.
 */
export const StdoutJsonLoggerLive = Logger.replace(
  Logger.defaultLogger,
  stdoutJsonLogger,
)
