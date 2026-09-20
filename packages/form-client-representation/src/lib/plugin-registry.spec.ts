import { Schema as ES, Effect } from "effect"
import { FormLabel } from "@pf/form-schema"
import { asClientRepresentation } from "./as-client-representation"
import {
  getMatchingPlugin,
  registerWalkerPlugin,
  unregisterWalkerPlugin,
} from "./plugin-registry"
import { FormComponentType, type PluginField } from "./types"
import { afterEach, describe, expect, it } from "bun:test"

const TestAnnotation = Symbol.for("test/plugin-annotation")
const PLUGIN_TYPE = "test-plugin"

afterEach(() => {
  unregisterWalkerPlugin(PLUGIN_TYPE)
})

describe("walker plugin registry", () => {
  it("returns undefined when no plugins are registered", () => {
    const result = getMatchingPlugin({ [TestAnnotation]: true })
    expect(result).toBeUndefined()
  })

  it("returns matching plugin when annotation is present", () => {
    registerWalkerPlugin({
      type: PLUGIN_TYPE,
      matchAnnotation: (a) => a[TestAnnotation] === true,
    })

    const result = getMatchingPlugin({ [TestAnnotation]: true })
    expect(result?.type).toBe(PLUGIN_TYPE)
  })

  it("returns undefined when annotation does not match", () => {
    registerWalkerPlugin({
      type: PLUGIN_TYPE,
      matchAnnotation: (a) => a[TestAnnotation] === true,
    })

    const other = Symbol.for("test/other")
    const result = getMatchingPlugin({ [other]: true })
    expect(result).toBeUndefined()
  })

  it("unregisters a plugin", () => {
    registerWalkerPlugin({
      type: PLUGIN_TYPE,
      matchAnnotation: (a) => a[TestAnnotation] === true,
    })
    unregisterWalkerPlugin(PLUGIN_TYPE)

    const result = getMatchingPlugin({ [TestAnnotation]: true })
    expect(result).toBeUndefined()
  })
})

describe("walker plugin integration with asClientRepresentation", () => {
  it("emits a PluginField for an annotated field", () => {
    registerWalkerPlugin({
      type: PLUGIN_TYPE,
      matchAnnotation: (a) => a[TestAnnotation] === true,
    })

    const schema = ES.Struct({
      document: ES.String.annotations({ [TestAnnotation]: true }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))
    const field = result.document as unknown as PluginField

    expect(field._tag).toBe(FormComponentType.Plugin)
    expect(field.pluginType).toBe(PLUGIN_TYPE)
    expect(field.field).toBe("document")
    expect(field.label).toBe("Document")
  })

  it("passes pluginData from extractData callback", () => {
    registerWalkerPlugin({
      type: PLUGIN_TYPE,
      matchAnnotation: (a) => a[TestAnnotation] === true,
      extractData: () => ({ mimeFilter: "application/pdf" }),
    })

    const schema = ES.Struct({
      file: ES.String.annotations({ [TestAnnotation]: true }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))
    const field = result.file as unknown as PluginField

    expect(field.pluginData).toEqual({ mimeFilter: "application/pdf" })
  })

  it("preserves FormLabel annotation on plugin fields", () => {
    registerWalkerPlugin({
      type: PLUGIN_TYPE,
      matchAnnotation: (a) => a[TestAnnotation] === true,
    })

    const schema = ES.Struct({
      doc: ES.String.annotations({
        [TestAnnotation]: true,
        [FormLabel]: "Select a document",
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))
    const field = result.doc as unknown as PluginField

    expect(field._tag).toBe(FormComponentType.Plugin)
    expect(field.label).toBe("Select a document")
  })

  it("does not emit PluginField for non-matching annotations", () => {
    registerWalkerPlugin({
      type: PLUGIN_TYPE,
      matchAnnotation: (a) => a[TestAnnotation] === true,
    })

    const schema = ES.Struct({
      name: ES.String,
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.name._tag).toBe(FormComponentType.Text)
  })

  it("works alongside regular fields in the same schema", () => {
    registerWalkerPlugin({
      type: PLUGIN_TYPE,
      matchAnnotation: (a) => a[TestAnnotation] === true,
    })

    const schema = ES.Struct({
      name: ES.String,
      age: ES.Number,
      attachment: ES.String.annotations({ [TestAnnotation]: true }),
      active: ES.Boolean,
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.name._tag).toBe(FormComponentType.Text)
    expect(result.age._tag).toBe(FormComponentType.Number)
    expect((result.attachment as unknown as PluginField)._tag).toBe(
      FormComponentType.Plugin,
    )
    expect(result.active._tag).toBe(FormComponentType.Boolean)
  })
})
