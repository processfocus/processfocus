import type { OrganisationFrontendManifestFormComponentPluginDeclaration } from "@pf/frontend-manifest"

export type FormComponentPluginTypeDeclaration =
  OrganisationFrontendManifestFormComponentPluginDeclaration

export const FormLabel = Symbol.for("pf/form/annotation/Label")

export const FormDescription = Symbol.for("pf/form/annotation/Description")

export const FormReadOnly = Symbol.for("pf/form/annotation/ReadOnly")

export const FormDefault = Symbol.for("pf/form/annotation/Default")

export const FormPermission = Symbol.for("pf/form/annotation/Permission")

export const FormRequired = Symbol.for("pf/form/annotation/Required")

export const FormMessage = Symbol.for("pf/form/annotation/Message")

export const FormAutoComplete = Symbol.for("pf/form/annotation/AutoComplete")

export const FormNumberInput = Symbol.for("pf/form/annotation/NumberInput")

export const FormDateInput = Symbol.for("pf/form/annotation/DateInput")

export const FormEmailInput = Symbol.for("pf/form/annotation/EmailInput")

export const FormPhoneInput = Symbol.for("pf/form/annotation/PhoneInput")

export const FormTextAreaInput = Symbol.for("pf/form/annotation/TextAreaInput")

export const FormTableInput = Symbol.for("pf/form/annotation/TableInput")

export const FormListInput = Symbol.for("pf/form/annotation/ListInput")

export const FormFileInput = Symbol.for("pf/form/annotation/FileInput")

export const FormLookupInput = Symbol.for("pf/form/annotation/LookupInput")

export const FormRadioInput = Symbol.for("pf/form/annotation/RadioInput")

export const FormSuggestionInput = Symbol.for(
  "pf/form/annotation/SuggestionInput",
)

export const FormCalendarSlotInput = Symbol.for(
  "pf/form/annotation/CalendarSlotInput",
)

export const FormProviderUserInput = Symbol.for(
  "pf/form/annotation/ProviderUserInput",
)

export const FormStaticText = Symbol.for("pf/form/annotation/StaticText")

export const FormComponentPluginType = Symbol.for(
  "pf/form/annotation/ComponentPluginType",
)
