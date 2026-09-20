export const getNoSchemaStartActionLabels = (totalFields: number) => {
  if (totalFields === 0) {
    return {
      cancelLabel: "Cancel",
      submitLabel: "Start",
    }
  }

  return {
    cancelLabel: "Discard",
    submitLabel: "Done",
  }
}
