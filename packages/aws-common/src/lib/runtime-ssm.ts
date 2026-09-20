export const runtimeEnvSsmPrefix = (project: string, envName: string): string =>
  `/pf-${project}/env/${envName}`

export const stageConfigSsmPrefix = (
  project: string,
  stageName: string,
): string => `/pf-${project}/stage/${stageName}/config`

export const stageConfigParameterName = (
  project: string,
  stageName: string,
  key: string,
): string => `${stageConfigSsmPrefix(project, stageName)}/${key}`

export const STAGE_CONFIG_SSM_MARKER_PREFIX = "pf-ssm:"

export const legacyRuntimeEnvSsmPrefix = (
  project: string,
  envName: string,
): string => `/pf-${project}/${envName}`

export const runtimeEnvSsmPrefixes = (
  project: string,
  envName: string,
): readonly [string, string] => [
  runtimeEnvSsmPrefix(project, envName),
  legacyRuntimeEnvSsmPrefix(project, envName),
]
