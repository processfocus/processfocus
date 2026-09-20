import { renderToStaticMarkup } from "react-dom/server"
import { ProcessWorkflowLink } from "../components/process-workflow-link"
import { describe, expect, test } from "bun:test"

describe("ProcessWorkflowLink", () => {
  test("links to the workflow with an accessible process-specific name", () => {
    const markup = renderToStaticMarkup(
      <ProcessWorkflowLink
        processName="Purchase Request"
        processPath="/operations/purchase-request"
      />,
    )

    expect(markup).toContain(
      'href="/processes/workflow/operations/purchase-request"',
    )
    expect(markup).toContain(
      'aria-label="View workflow information for Purchase Request"',
    )
  })

  test("hides the control when the process path cannot be resolved", () => {
    expect(
      renderToStaticMarkup(
        <ProcessWorkflowLink
          processName="Unknown process"
          processPath={undefined}
        />,
      ),
    ).toBe("")
  })
})
