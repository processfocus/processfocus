import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm"
import { type OtlpExportConfig, resolveOtlpSsmConfig } from "@pf/aws-common"

export function resolveOtlpConfig(): Promise<OtlpExportConfig | undefined> {
  const client = new SSMClient({})
  return resolveOtlpSsmConfig({
    env: process.env,
    getParameter: async (name) => {
      const response = await client.send(
        new GetParameterCommand({ Name: name, WithDecryption: true }),
      )
      return response.Parameter?.Value
    },
    warn: console.warn,
  }).finally(() => client.destroy())
}
