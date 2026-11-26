import type { OrganisationFrontendPlugin } from "processfocus/plugin"

export const shouldActivate = (): true => true
export const plugin = {
  id: "fixture-custom-field",
  activate(host) {
    host.formRenderers.register({
      type: "fixture-custom-field",
      renderer(form, component) {
        return (
          <form.AppField name={component.field}>
            {(field) => (
              <label>
                {component.label}
                <input
                  name={component.field}
                  value={
                    typeof field.state.value === "string"
                      ? field.state.value
                      : ""
                  }
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                />
                <span>
                  {typeof component.pluginData === "object" &&
                  component.pluginData !== null &&
                  "hint" in component.pluginData &&
                  typeof component.pluginData.hint === "string"
                    ? component.pluginData.hint
                    : ""}
                </span>
              </label>
            )}
          </form.AppField>
        )
      },
    })
  },
} satisfies OrganisationFrontendPlugin
