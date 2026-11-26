/** File assets for both frontend colors share an environment-scoped namespace. */
export const frontendArtifactPrefix = (
  project: string,
  environment: string,
): string => `pf/${project}/${environment}/frontend/`

/** Capabilities shared by ordinary and controller-managed build identities. */
export const dockerBuildActions = {
  logs: ["logs:CreateLogStream", "logs:PutLogEvents"],
  image: [
    "ecr:BatchCheckLayerAvailability",
    "ecr:GetDownloadUrlForLayer",
    "ecr:BatchGetImage",
  ],
  imageToken: ["ecr:GetAuthorizationToken"],
  reports: [
    "codebuild:CreateReportGroup",
    "codebuild:CreateReport",
    "codebuild:UpdateReport",
    "codebuild:BatchPutTestCases",
    "codebuild:BatchPutCodeCoverages",
  ],
  telemetry: ["ssm:GetParameter", "ssm:GetParameters"],
  progress: ["appsync:EventConnect", "appsync:EventPublish"],
}

export const deploymentProgressRegistryGrant = (tableArn: string) => ({
  actions: ["dynamodb:Query"],
  resources: [tableArn],
  conditions: {
    "ForAllValues:StringLike": {
      "dynamodb:LeadingKeys": ["DEPLOY_PROGRESS#*"],
    },
  },
})

/** Stable IAM names shared by project-policy provisioning and validation. */
export const projectDeploymentPolicyNames = ({
  project,
  environment,
}: {
  readonly project: string
  readonly environment: string
}): {
  readonly deployRoleName: string
  readonly executionRoleName: string
  readonly permissionsBoundaryName: string
  readonly backendRuntimeRoleName: string
  readonly frontendRuntimeRoleName: string
} => {
  const target = `${project}-${environment}`
  return {
    deployRoleName: `pf-project-deployment-${target}`,
    executionRoleName: `pf-project-execution-${target}`,
    permissionsBoundaryName: `pf-project-boundary-${target}`,
    // Preserve the deployed identity for backend/store and unmigrated colors.
    backendRuntimeRoleName: `pf-${target}-runtime`,
    frontendRuntimeRoleName: `pf-${target}-frontend-runtime`,
  }
}
