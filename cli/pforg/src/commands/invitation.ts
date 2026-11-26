import { Console, Effect, Schema } from "effect"
import { CliError } from "../errors"
import { graphqlRequest } from "../utils/graphql-client"

const Role = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  path: Schema.String,
})
const Invitation = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  roles: Schema.Array(Role),
  registrationLinkStatus: Schema.String,
})
const selection = "id email roles { id name path } registrationLinkStatus"
const Result = Schema.Union([
  Schema.Struct({ error: Schema.String }),
  Schema.Struct({
    invitation: Invitation,
    registrationLinkUrl: Schema.optional(Schema.NullOr(Schema.String)),
    expiresAt: Schema.optional(Schema.NullOr(Schema.String)),
  }),
])

const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      () =>
        new CliError({
          code: "INVALID_RESPONSE",
          message:
            "Invalid invitation API response. Check the organisation API version.",
        }),
    ),
  )

const printResult = (value: unknown) =>
  Effect.gen(function* () {
    const result = yield* decode(Result, value)
    if ("error" in result) return yield* new CliError({ message: result.error })
    yield* Console.log(JSON.stringify(result))
  })

const ListedInvitation = Schema.Struct({
  ...Invitation.fields,
  status: Schema.String,
})

export const runInvitationList = Effect.gen(function* () {
  const invitations: (typeof ListedInvitation.Type)[] = []
  for (const status of ["PENDING", "ACCEPTED", "LEGACY_CLOSED"]) {
    let page = 1
    while (true) {
      const data = yield* graphqlRequest(
        `query($page: Int!, $status: InvitationLifecycleStatus!) {
          allInvitations(page: $page, limit: 100, status: $status) {
            items { ${selection} status } hasNextPage
          }
        }`,
        { variables: { page, status } },
      )
      const result = yield* decode(
        Schema.Struct({
          items: Schema.Array(ListedInvitation),
          hasNextPage: Schema.Boolean,
        }),
        data["allInvitations"],
      )
      invitations.push(...result.items)
      if (!result.hasNextPage) break
      page++
    }
  }
  yield* Console.log(JSON.stringify(invitations))
})

export const runInvitationDelete = (invitationId: string) =>
  Effect.gen(function* () {
    const data = yield* graphqlRequest(
      `mutation($invitationId: ID!) {
        deleteInvitation(invitationId: $invitationId) { success error }
      }`,
      {
        variables: { invitationId },
        errorMessagePrefix:
          "Could not delete Invitation. Check your organisation user-administration permission. ",
      },
    )
    const result = yield* decode(
      Schema.Struct({
        success: Schema.Boolean,
        error: Schema.NullOr(Schema.String),
      }),
      data["deleteInvitation"],
    )
    if (!result.success)
      return yield* new CliError({
        message: `${result.error ?? "Could not delete Invitation."} Run pforg invitation list to check the ID and lifecycle status in this environment. Only pending Invitations can be deleted.`,
      })
    yield* Console.log(JSON.stringify({ id: invitationId, success: true }))
  })

export const runInvitationCreate = (input: {
  readonly email: string
  readonly roles: readonly string[]
  readonly registrationLink: boolean
}) =>
  Effect.gen(function* () {
    if (input.roles.length === 0)
      return yield* new CliError({
        message: "Supply at least one explicit --role path.",
      })
    const roles = new Map<string, string>()
    let page = 1
    while (true) {
      const data = yield* graphqlRequest(
        `query($page: Int!) { allRoles(page: $page, limit: 100) { items { id name path } hasNextPage } }`,
        { variables: { page } },
      )
      const result = yield* decode(
        Schema.Struct({
          items: Schema.Array(Role),
          hasNextPage: Schema.Boolean,
        }),
        data["allRoles"],
      )
      for (const role of result.items) roles.set(role.path, role.id)
      if (!result.hasNextPage) break
      page++
    }
    const roleIds: string[] = []
    for (const path of new Set(input.roles)) {
      const id = roles.get(path)
      if (!id)
        return yield* new CliError({
          message: `Unknown role path: ${path}. Use an exact role path from the organisation Dashboard.`,
        })
      roleIds.push(id)
    }
    const data = yield* graphqlRequest(
      `mutation($input: SaveInvitationInput!, $link: Boolean!) {
    createInvitation(input: $input, registrationLink: $link) {
      ... on SaveInvitationSuccess { invitation { ${selection} } registrationLinkUrl expiresAt }
      ... on SaveInvitationFailure { error }
    }
  }`,
      {
        variables: {
          input: { email: input.email, roleIds },
          link: input.registrationLink,
        },
      },
    )
    yield* printResult(data["createInvitation"])
  })

export const runInvitationRegistrationLink = (email: string, rotate: boolean) =>
  Effect.gen(function* () {
    const normalizedEmail = email.trim().toLowerCase()
    let page = 1
    while (true) {
      const data = yield* graphqlRequest(
        `query($page: Int!) { allInvitations(page: $page, limit: 100) { items { ${selection} } hasNextPage } }`,
        { variables: { page } },
      )
      const result = yield* decode(
        Schema.Struct({
          items: Schema.Array(Invitation),
          hasNextPage: Schema.Boolean,
        }),
        data["allInvitations"],
      )
      const invitation = result.items.find(
        (item) => item.email === normalizedEmail,
      )
      if (invitation) {
        if (
          !rotate &&
          ["ACTIVE", "EXPIRED"].includes(invitation.registrationLinkStatus)
        ) {
          return yield* new CliError({
            message:
              "A Registration Link already exists. Pass --rotate to replace it.",
          })
        }
        const operation = rotate
          ? "rotateRegistrationLink"
          : "generateRegistrationLink"
        const response = yield* graphqlRequest(
          `mutation($id: ID!) {
        ${operation}(invitationId: $id) {
          ... on RegistrationLinkActionSuccess { invitation { ${selection} } registrationLinkUrl expiresAt }
          ... on RegistrationLinkActionFailure { error }
        }
      }`,
          { variables: { id: invitation.id } },
        )
        yield* printResult(response[operation])
        return
      }
      if (!result.hasNextPage) break
      page++
    }
    return yield* new CliError({
      message:
        "Pending Invitation not found. Run pforg invitation create --email <email> --role <path> first. Accepted Invitations cannot be used for account recovery here.",
    })
  })
