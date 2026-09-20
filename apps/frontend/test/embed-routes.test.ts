import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { FormComponentType } from "@pf/form-client-representation/types"
import { buildEmbedScriptSrc } from "../app/api/embed/test-host/route"
import EmbedLayout from "../app/embed/layout"
import { isPublicPath } from "../lib/auth/config"
import {
  type EmbedManifestEntry,
  buildEmbedFrameAncestorsPolicy,
  collectEmbedLookupDefinitions,
  findEmbedLookupDefinitionByField,
  findEmbedLookupDefinitionByQueryName,
  findEmbedManifestEntryForPath,
  getEmbedRoutePath,
  stepPathFromEmbedSegments,
} from "../lib/embed-manifest"
import { isAllowedEmbedOrigin } from "../lib/embed-request-origin"
import type { FrontendManifest } from "../lib/frontend-manifest"
import { parseFrontendManifest } from "../lib/frontend-manifest"
import { clearFrontendManifestCache } from "../lib/frontend-manifest-store"

const entry: EmbedManifestEntry = {
  stepPath: "/enrolment-enquiry/Submit enquiry",
  processName: "Enrolment Enquiry",
  processPath: "/enrolment-enquiry",
  mutationName: "startEnrolmentEnquiry",
  inputTypeName: "EnrolmentEnquirySubmitEnquiry",
  totalFields: 2,
  formDefinition: null,
  defaultValues: null,
  jsonSchema: null,
  sites: ["https://school.example.com", "https://www.school.example.com"],
  thankYou: "Thanks",
}

describe("embed routes", () => {
  test("waits for frontend form plugins around embedded forms", async () => {
    const originalPfOrg = process.env["PF_ORG"]
    const orgPath = mkdtempSync(join(tmpdir(), "pf-embed-manifest-"))
    const distPath = join(orgPath, "dist")
    const manifest: FrontendManifest = {
      version: 3,
      organisation: {
        name: "Test Org",
      },
      appIcons: {
        metadata: [],
        manifest: [],
      },
      publicFormBranding: null,
      embed: {
        entries: [],
      },
      processes: {
        documentation: [],
      },
      plugins: {
        analytics: [],
        formComponents: [
          {
            module: "@processfocus/plugin-google-drive/register-client",
            type: "google-drive",
          },
        ],
      },
    }

    try {
      mkdirSync(distPath, { recursive: true })
      writeFileSync(
        join(distPath, "frontend-manifest.json"),
        JSON.stringify(manifest),
      )
      process.env["PF_ORG"] = orgPath
      clearFrontendManifestCache()

      const markup = renderToStaticMarkup(
        createElement(
          EmbedLayout,
          null,
          createElement("span", null, "Embed form"),
        ),
      )

      expect(markup).toBe("")
    } finally {
      if (originalPfOrg === undefined) {
        delete process.env["PF_ORG"]
      } else {
        process.env["PF_ORG"] = originalPfOrg
      }
      clearFrontendManifestCache()
      rmSync(orgPath, { recursive: true, force: true })
    }
  })

  test("treats embed page and api routes as public", () => {
    expect(isPublicPath("/embed/enrolment-enquiry/Submit%20enquiry")).toBe(true)
    expect(isPublicPath("/api/embed/submit")).toBe(true)
  })

  test("reconstructs embed paths and frame-ancestors policy", () => {
    expect(
      stepPathFromEmbedSegments(["enrolment-enquiry", "Submit enquiry"]),
    ).toBe("/enrolment-enquiry/Submit enquiry")
    expect(stepPathFromEmbedSegments(["enrolment-enquiry"])).toBe(
      "/enrolment-enquiry",
    )
    expect(getEmbedRoutePath(entry.processPath)).toBe(
      "/embed/enrolment-enquiry",
    )
    expect(getEmbedRoutePath(entry.stepPath)).toBe(
      "/embed/enrolment-enquiry/Submit%20enquiry",
    )
    expect(buildEmbedFrameAncestorsPolicy(entry)).toBe(
      "frame-ancestors 'self' https://school.example.com https://www.school.example.com",
    )
  })

  test("resolves embed entries from process or step paths", () => {
    expect(findEmbedManifestEntryForPath([entry], entry.processPath)).toEqual(
      entry,
    )
    expect(findEmbedManifestEntryForPath([entry], entry.stepPath)).toEqual(
      entry,
    )
    expect(findEmbedManifestEntryForPath([entry], "/missing")).toBeUndefined()
  })

  test("parses only the structured form definition into the embed consumer", () => {
    const structuredRule = {
      condition: {
        _tag: "blank",
        value: { _tag: "field", path: ["name"] },
      },
      effects: [{ target: ["details"], state: { disabled: true } }],
    }
    const parsed = parseFrontendManifest({
      version: 3,
      embed: {
        entries: [
          {
            ...entry,
            formDefinition: {
              components: {
                name: { _tag: "text", field: "name", label: "Name" },
                details: {
                  _tag: "text",
                  field: "details",
                  label: "Details",
                },
              },
              rules: [structuredRule],
            },
          },
        ],
      },
      plugins: { analytics: [], formComponents: [] },
    })
    const parsedEntry = parsed.embed.entries[0]

    expect(parsedEntry?.formDefinition?.rules).toEqual([structuredRule])
    expect(parsedEntry?.formDefinition?.components["name"]).toMatchObject({
      label: "Name",
    })
  })

  test("rejects malformed structured definitions before iframe rendering", () => {
    expect(() =>
      parseFrontendManifest({
        version: 3,
        embed: {
          entries: [
            {
              ...entry,
              formDefinition: { components: { name: [] }, rules: [] },
            },
          ],
        },
        plugins: { analytics: [], formComponents: [] },
      }),
    ).toThrow(
      "embed.entries[0].formDefinition must be a valid client form definition",
    )
  })

  test("builds an encoded embed helper src", () => {
    const url = new URL(
      buildEmbedScriptSrc({
        align: "center",
        form: "/school enrolment/Apply now",
        minHeight: 640,
        mode: "light",
        title: "School & Enrolment",
      }),
      "http://localhost:3001",
    )

    expect(url.pathname).toBe("/processfocus-embed.js")
    expect(url.searchParams.get("form")).toBe("/school enrolment/Apply now")
    expect(url.searchParams.get("title")).toBe("School & Enrolment")
    expect(url.searchParams.get("minHeight")).toBe("640")
    expect(url.searchParams.get("mode")).toBe("light")
    expect(url.searchParams.get("align")).toBe("center")
  })

  test("allows embed submits from an allowed Origin header", () => {
    const headers = new Headers({ origin: "https://school.example.com" })

    expect(
      isAllowedEmbedOrigin(
        headers,
        ["https://school.example.com"],
        "http://localhost:3001",
      ),
    ).toBe(true)
  })

  test("allows embed submits from the frontend origin", () => {
    const headers = new Headers({ origin: "http://localhost:3001" })

    expect(
      isAllowedEmbedOrigin(
        headers,
        ["https://school.example.com"],
        "http://localhost:3001",
      ),
    ).toBe(true)
  })

  test("rejects embed submits from a disallowed Origin header", () => {
    const headers = new Headers({ origin: "https://evil.example.com" })

    expect(
      isAllowedEmbedOrigin(
        headers,
        ["https://school.example.com"],
        "http://localhost:3001",
      ),
    ).toBe(false)
  })

  test("rejects embed submits when Origin and Referer are missing", () => {
    expect(
      isAllowedEmbedOrigin(
        new Headers(),
        ["https://school.example.com"],
        "http://localhost:3001",
      ),
    ).toBe(false)
  })

  test("rejects embed submits with a malformed Referer header", () => {
    const headers = new Headers({ referer: "not a url" })

    expect(
      isAllowedEmbedOrigin(
        headers,
        ["https://school.example.com"],
        "http://localhost:3001",
      ),
    ).toBe(false)
  })

  test("collects allowed embed lookup operations from definition components", () => {
    const formDefinition = {
      components: {
        campusId: {
          _tag: FormComponentType.Lookup,
          field: "campusId",
          label: "Campus",
        },
        details: {
          _tag: FormComponentType.FieldSet,
          label: "Details",
          children: {
            classId: {
              _tag: FormComponentType.Lookup,
              field: "details.classId",
              label: "Class",
              dependencies: ["campusId"],
              queryName: "lookupSchoolEnrolmentSubmitEnquiryClassId",
            },
          },
        },
      },
      rules: [],
    } as const

    expect(collectEmbedLookupDefinitions(formDefinition)).toEqual([
      {
        type: FormComponentType.Lookup,
        field: "campusId",
        normalizedField: "campusId",
        dependencies: [],
      },
      {
        type: FormComponentType.Lookup,
        field: "details.classId",
        normalizedField: "classId",
        dependencies: ["campusId"],
        queryName: "lookupSchoolEnrolmentSubmitEnquiryClassId",
      },
    ])

    expect(
      findEmbedLookupDefinitionByField(formDefinition, "campusId"),
    ).toEqual({
      type: FormComponentType.Lookup,
      field: "campusId",
      normalizedField: "campusId",
      dependencies: [],
    })
    expect(
      findEmbedLookupDefinitionByField(formDefinition, "classId"),
    ).toBeUndefined()
    expect(
      findEmbedLookupDefinitionByQueryName(
        formDefinition,
        "lookupSchoolEnrolmentSubmitEnquiryClassId",
      ),
    ).toEqual({
      type: FormComponentType.Lookup,
      field: "details.classId",
      normalizedField: "classId",
      dependencies: ["campusId"],
      queryName: "lookupSchoolEnrolmentSubmitEnquiryClassId",
    })
  })
})
