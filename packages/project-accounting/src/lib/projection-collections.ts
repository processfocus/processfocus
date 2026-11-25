const DEPLOYMENT_COLLECTION_PREFIX = "deploys-"

export const deploymentCollection = (environmentId: string): string =>
  `${DEPLOYMENT_COLLECTION_PREFIX}${environmentId}`

export const DEPLOYMENT_VISIBILITY_COLLECTION = "deployment-visibility"

// Environment IDs are at most 41 characters. The prefix leaves room in the
// 50-character AppSync segment, which must end in an alphanumeric character.
export const isConsoleProjectionCollection = (collection: string): boolean =>
  collection === "projects" ||
  collection === DEPLOYMENT_VISIBILITY_COLLECTION ||
  (collection.startsWith(DEPLOYMENT_COLLECTION_PREFIX) &&
    /^[A-Za-z0-9-]{0,40}[A-Za-z0-9]$/.test(
      collection.slice(DEPLOYMENT_COLLECTION_PREFIX.length),
    ))
