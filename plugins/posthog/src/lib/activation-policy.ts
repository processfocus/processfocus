export const shouldActivatePostHogFrontendClientPlugin = (
  config: unknown,
  environment: string | undefined,
): boolean => {
  if (
    typeof config === "object" &&
    config !== null &&
    !Array.isArray(config) &&
    "enabled" in config &&
    typeof config.enabled === "boolean"
  ) {
    return config.enabled
  }

  return environment !== "development"
}
