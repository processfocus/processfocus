import { Effect, Option, Schema } from "effect"
import { FormLookupInput, type FormRequestData } from "@pf/form-schema"
import { InputValidationError, NotAuthorized } from "@pf/graphql-schema"
import {
  type Form,
  OrganisationProvider,
  isForm,
  normalizePath,
} from "@pf/process"
import { submitAnonymousPage as executeAnonymousPage } from "@pf/process-execution"
import { getSchemaAnnotationDeep, getSubmissionFields } from "./resolver-utils"
import { startFormContext } from "./start-form-context"
import type { UserContext } from "./types"

/** Capability validation is shared by metadata, lookups, and submission. */
const resolveAnonymousPage = (address: string) =>
  Effect.gen(function* () {
    const { organisation } = yield* OrganisationProvider
    for (const process of organisation.processes()) {
      const starts = process.startNodes()
      const form = starts[0]
      if (
        starts.length === 1 &&
        isForm(form) &&
        form.anonymousPage?.address === address
      ) {
        return { form, config: form.anonymousPage }
      }
    }
    return yield* new NotAuthorized({
      action: "anonymousPage",
      resource: "Anonymous Page",
      message: "This page is not available.",
    })
  })

export const anonymousPage = (
  address: string,
  context: UserContext,
): Effect.Effect<
  {
    name: string
    stepPath: string
    afterSubmit: "restart" | "thank-you"
    formPath: string
    requestData: FormRequestData
    pluginConfiguration: Readonly<Record<string, unknown>>
    defaultValues: Record<string, unknown>
  },
  NotAuthorized,
  unknown
> =>
  Effect.gen(function* () {
    const { form, config } = yield* resolveAnonymousPage(address)
    const ctx = startFormContext({
      ...context,
      jwt: undefined,
      userId: undefined,
    })
    if (!form.browser)
      return yield* new NotAuthorized({
        action: "anonymousPage",
        resource: "Anonymous Page",
        message: "This page has no executable form artifact.",
      })
    return {
      name: form.process.props.name,
      stepPath: normalizePath(form.node.path),
      afterSubmit: config.afterSubmit,
      formPath: normalizePath(form.node.path),
      defaultValues: yield* form.resolveDefaults({}, ctx, undefined),
      pluginConfiguration: form.browser.resolvePluginConfiguration
        ? yield* form.browser.resolvePluginConfiguration()
        : {},
      requestData: {
        presentation: form.resolvePresentation({}, ctx, undefined),
        originalValues: yield* form.resolveOriginalValues({}, ctx, undefined),
        inaccessible: [],
      },
    }
  })

export const anonymousPageLookup = (args: {
  readonly address: string
  readonly field: string
  readonly filter?: string | null
  readonly limit?: number | null
  readonly selectedValue?: string | null
}): ReturnType<Form["executeLookup"]> =>
  Effect.gen(function* () {
    const { form } = yield* resolveAnonymousPage(args.address)
    if (args.selectedValue != null) {
      const item = yield* form.resolveLookupSelection(
        args.field,
        args.selectedValue,
      )
      return item ? [item] : []
    }
    const field = getSubmissionFields(form.output)[args.field]
    const metadata = field
      ? Option.getOrUndefined(getSchemaAnnotationDeep(field, FormLookupInput))
      : undefined
    const local =
      typeof metadata === "object" &&
      metadata !== null &&
      "mode" in metadata &&
      metadata.mode === "local" &&
      "maxItems" in metadata &&
      typeof metadata.maxItems === "number"
        ? metadata.maxItems
        : undefined
    // Fetch a sentinel beyond the authored bound: never confuse endpoint clipping
    // with a complete local dataset. The client rejects the entire overflow response.
    return yield* form
      .executeLookup(
        args.field,
        local === undefined ? (args.filter ?? "") : "",
        local === undefined
          ? Math.max(1, Math.min(args.limit ?? 20, 100))
          : local + 1,
      )
      .pipe(
        Effect.tap((items) =>
          local !== undefined && items.length > local
            ? Effect.logWarning("Local lookup exceeds authored maximum", {
                field: args.field,
                maxItems: local,
                stepPath: form.node.path,
              })
            : Effect.void,
        ),
      )
  })

export const submitAnonymousPage = (
  args: { readonly address: string; readonly input: unknown },
  _context: UserContext,
) =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(
      Schema.Record(Schema.String, Schema.Unknown),
    )(args.input).pipe(
      Effect.mapError(
        () =>
          new InputValidationError({
            errors: [{ field: "", message: "Invalid form submission." }],
          }),
      ),
    )
    return yield* executeAnonymousPage({ address: args.address, input })
  })
