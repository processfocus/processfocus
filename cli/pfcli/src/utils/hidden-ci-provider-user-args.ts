export const HIDDEN_CI_PROVIDER_USER_ENV = "PFCLI_CI_PROVIDER_USER"

const HIDDEN_CI_PROVIDER_USER_OPTION = "--ci-provider-user"
const ARGV_COMMAND_OFFSET = 2

type HiddenCiProviderUserArgs =
  | {
      readonly argv: string[]
      readonly providerUser?: string
      readonly error?: never
    }
  | {
      readonly argv: string[]
      readonly error: string
      readonly providerUser?: never
    }

export const extractHiddenCiProviderUserArgs = (
  argv: readonly (string | undefined)[],
): HiddenCiProviderUserArgs => {
  const strippedArgv: string[] = []
  let providerUser: string | undefined

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === undefined) {
      continue
    }

    if (arg === HIDDEN_CI_PROVIDER_USER_OPTION) {
      if (providerUser !== undefined) {
        return {
          argv: strippedArgv,
          error: `${HIDDEN_CI_PROVIDER_USER_OPTION} must only be provided once`,
        }
      }

      const nextArg = argv[index + 1]
      if (!nextArg || nextArg.startsWith("-")) {
        return {
          argv: strippedArgv,
          error: `${HIDDEN_CI_PROVIDER_USER_OPTION} requires an email address`,
        }
      }

      providerUser = nextArg
      index++
      continue
    }

    if (arg.startsWith(`${HIDDEN_CI_PROVIDER_USER_OPTION}=`)) {
      if (providerUser !== undefined) {
        return {
          argv: strippedArgv,
          error: `${HIDDEN_CI_PROVIDER_USER_OPTION} must only be provided once`,
        }
      }

      providerUser = arg.slice(`${HIDDEN_CI_PROVIDER_USER_OPTION}=`.length)
      continue
    }

    strippedArgv.push(arg)
  }

  if (providerUser !== undefined) {
    const commandArgs = strippedArgv.slice(ARGV_COMMAND_OFFSET)
    if (commandArgs[0] !== "auth" || commandArgs[1] !== "login") {
      return {
        argv: strippedArgv,
        error: `${HIDDEN_CI_PROVIDER_USER_OPTION} is only supported by auth login`,
      }
    }
  }

  return providerUser === undefined
    ? { argv: strippedArgv }
    : { argv: strippedArgv, providerUser }
}
