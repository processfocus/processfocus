import {
  type AppSyncEventsClientConfig,
  AppSyncEventsClient as Transport,
} from "@pf/realtime-client"

/**
 * Get a cookie value by name from document.cookie
 */
export const getCookie = (name: string): string | undefined => {
  const value = `; ${document.cookie}`
  const parts = value.split(`; ${name}=`)
  if (parts.length === 2) {
    return parts.pop()?.split(";").shift()
  }
  return undefined
}

export class AppSyncEventsClient extends Transport {
  constructor(config: Omit<AppSyncEventsClientConfig, "getToken">) {
    super({ ...config, getToken: () => getCookie("access_token") })
  }
}
