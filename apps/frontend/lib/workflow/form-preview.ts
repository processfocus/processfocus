import type { WorkflowStepData } from "./types"

export function canPreviewWorkflowStepForm(
  step: Pick<WorkflowStepData, "isSystemStep">,
): boolean {
  // Start and embedded steps are still process forms; system steps are not.
  return !step.isSystemStep
}
