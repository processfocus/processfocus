import { CloudAssembly } from "aws-cdk-lib/cx-api"
import { afterAll } from "bun:test"

// Bun does not reliably run CDK's process exit hook.
afterAll(CloudAssembly.cleanupTemporaryDirectories)
