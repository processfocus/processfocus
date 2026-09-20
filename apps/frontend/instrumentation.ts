export async function register() {
  // Register OTEL TracerProvider and MeterProvider globally.
  // Dynamic import keeps the code split for tree-shaking.
  const { registerOtel } = await import("./lib/telemetry/register-otel")
  try {
    await registerOtel()
  } catch (error) {
    console.error("Failed to initialize OpenTelemetry:", error)
    // Continue without tracing rather than crash the server
  }

  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { register: registerNodeInstrumentation } = await import(
      "./instrumentation.node"
    )

    await registerNodeInstrumentation()
  }
}
