import { Effect } from "effect"
import type { NonEmptyReadonlyArray } from "@pf/auth-policy"
import { normalizePath } from "@pf/process"
import { canModifyField } from "./authorization"
import type { UserContext } from "./types"

// Keep this helper decoupled from the concrete Role class; list roles only need
// construct paths for authorization resources.
interface ListRolePathSource {
  readonly node: {
    readonly path: string
  }
}

export const rolePathsForList = (
  roles: NonEmptyReadonlyArray<ListRolePathSource>,
): NonEmptyReadonlyArray<string> => {
  const [firstRole, ...otherRoles] = roles
  return [
    normalizePath(firstRole.node.path),
    ...otherRoles.map((role) => normalizePath(role.node.path)),
  ]
}

export const canModifyListFieldForAnyRole = (
  context: UserContext,
  props: {
    readonly listPath: string
    readonly fieldName: string
    readonly rolePath: string
    readonly listRolePaths: NonEmptyReadonlyArray<string>
    readonly orgUnitId: string
    readonly logMessage: string
  },
) =>
  Effect.gen(function* () {
    // Permit if any configured list role allows this field mutation.
    for (const listRolePath of props.listRolePaths) {
      const allowed = yield* canModifyField(context, {
        // List edit forms reuse FormField authorization with the list path as
        // the form resource path because they do not belong to a Process.
        stepPath: props.listPath,
        fieldName: props.fieldName,
        rolePath: props.rolePath,
        stepRolePath: listRolePath,
        processPath: props.listPath,
        orgUnitId: props.orgUnitId,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(props.logMessage, {
            error,
            fieldName: props.fieldName,
            listPath: props.listPath,
            listRolePath,
          }),
        ),
        Effect.catchAll(() => Effect.succeed(false)),
      )

      if (allowed) return true
    }

    return false
  })
