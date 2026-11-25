// Cucumber has already resolved --name, --tags, outlines and ordering here.
// Load the same support bundle as the serial runner after it has registered.
export default {
  type: "plugin",
  coordinator({ transform }) {
    transform("pickles:order", async (scenarios) => {
      const { planProviderUsers } = await import("../dist/index.js")
      planProviderUsers(scenarios.map(({ pickle }) => pickle))
    })
  },
}
