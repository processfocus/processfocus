import { GraphQLClient } from "graphql-request"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { subjects } from "@pf/auth-session"
import { getAuthClient } from "@/lib/auth/client"
import { getCookieNames, setTokenCookies } from "@/lib/auth/session"
import { acceptVerifiedSession } from "@/lib/auth/ssr-session"
import { getGraphqlEndpoint } from "@/lib/graphql/endpoint"
import { requestRole } from "@/lib/graphql/provider-user-queries"

interface SwitchRoleSuccessResponse {
  success: true
  /** Unix timestamp in seconds when the access token expires */
  expiresAt: number
}

interface SwitchRoleFailureResponse {
  success: false
  error: string
}

type SwitchRoleResponse = SwitchRoleSuccessResponse | SwitchRoleFailureResponse

/**
 * POST /api/auth/switch-role
 *
 * Requests a specific role for the current user by:
 * 1. Calling the GraphQL requestRole mutation to validate via Cedar and store in permitted_role table
 * 2. Requesting a new access token with the role scope from the auth server
 *
 * Request body:
 * - rolePath: The path of the role to request
 *
 * Returns:
 * - { success: true, expiresAt: number } on successful switch
 * - { success: false, error: string } when switch fails
 */
export async function POST(
  request: Request,
): Promise<NextResponse<SwitchRoleResponse>> {
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin) {
      return NextResponse.json(
        { success: false, error: "Invalid request origin" },
        { status: 403 },
      )
    }
    const body: unknown = await request.json()
    if (
      typeof body !== "object" ||
      body === null ||
      !("rolePath" in body) ||
      typeof body.rolePath !== "string" ||
      !body.rolePath ||
      body.rolePath.length > 2048
    ) {
      return NextResponse.json({
        success: false,
        error: "Missing rolePath in request body",
      })
    }
    const { rolePath } = body

    const cookieStore = await cookies()
    const cookieNames = await getCookieNames()
    const { accessToken: accessTokenCookie, refreshToken: refreshTokenCookie } =
      cookieNames
    const accessToken = cookieStore.get(accessTokenCookie)?.value
    const refreshToken = cookieStore.get(refreshTokenCookie)?.value

    if (!accessToken || !refreshToken) {
      return NextResponse.json({
        success: false,
        error: "Not authenticated",
      })
    }

    const authClient = getAuthClient()
    const verified = await authClient.verify(subjects, accessToken, undefined)
    if (verified.err)
      return NextResponse.json({ success: false, error: "Not authenticated" })
    const session = await acceptVerifiedSession(
      verified.subject.properties,
      accessToken,
    )
    if (!session)
      return NextResponse.json({ success: false, error: "Not authenticated" })

    // Delegates switch only assigned roles through the issuer's live check;
    // never create a human permitted_role grant as part of the transition.
    if (!("delegation" in session)) {
      // Step 1: Call GraphQL mutation to validate and store permitted role
      const graphqlClient = new GraphQLClient(getGraphqlEndpoint(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })

      const mutationResult = await requestRole(graphqlClient, rolePath)

      if (!mutationResult.success) {
        return NextResponse.json({
          success: false,
          error: mutationResult.error ?? "Failed to switch role",
        })
      }
    }

    // Step 2: Request new tokens with the role scope from auth server
    // URL-encode the rolePath to handle spaces (OAuth2 uses space as scope delimiter)
    const scope = `role:${encodeURIComponent(rolePath)}`
    const result = await authClient.refresh(refreshToken, { scope })

    if (result.err) {
      return NextResponse.json({
        success: false,
        error: "Failed to refresh tokens with role scope",
      })
    }

    if (!result.tokens) {
      return NextResponse.json({
        success: false,
        error: "No tokens returned from refresh",
      })
    }

    const scoped = await authClient.verify(
      subjects,
      result.tokens.access,
      undefined,
    )
    if (
      scoped.err ||
      !(await acceptVerifiedSession(
        scoped.subject.properties,
        result.tokens.access,
      ))
    ) {
      return NextResponse.json({
        success: false,
        error: "Invalid refreshed session",
      })
    }

    // Update cookies with new tokens
    await setTokenCookies(
      cookieStore,
      {
        access: result.tokens.access,
        refresh: result.tokens.refresh,
        expiresIn: result.tokens.expiresIn,
        ...(result.tokens.refreshExpiresIn !== undefined && {
          refreshExpiresIn: result.tokens.refreshExpiresIn,
        }),
      },
      cookieNames,
    )

    // Calculate expiry timestamp
    const expiresAt = Math.floor(Date.now() / 1000) + result.tokens.expiresIn

    return NextResponse.json(
      { success: true, expiresAt },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    )
  } catch {
    return NextResponse.json({
      success: false,
      error: "Unable to switch role",
    })
  }
}
