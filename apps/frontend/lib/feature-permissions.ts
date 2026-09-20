export interface FeaturePermissions {
  readonly administerUsers: boolean
  readonly administerOAuthProviders: boolean
  readonly showProcessState: boolean
  readonly viewAuthorization: boolean
}

export const noFeaturePermissions: FeaturePermissions = {
  administerUsers: false,
  administerOAuthProviders: false,
  showProcessState: false,
  viewAuthorization: false,
}
