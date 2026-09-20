# DockerStep

`@processfocus/plugin-docker` provides the `DockerStep` authoring API. Import
the provider-neutral `ExecutorHost` and `FileResolutionHost` contracts from
`@processfocus/runtime` when implementing a runtime adapter.

## Runtime contract

The organisation-bundled Docker plugin resolves typed step input and delegates
execution and file handoff to those host contracts before the host launches the
container.

The container then receives:

- `PF_INPUT_URL`
- `PF_RESULT_URL`
- `PF_STEP_INPUT_PATH`
- `PF_STEP_OUTPUT_PATH`

The generic runner in `assets/pf-docker-step-runner.mjs`:

- downloads `input.json`
- runs the image command
- forwards stdout/stderr unchanged
- reads `output.json` on success
- writes a terminal result envelope to `PF_RESULT_URL`

Step-specific images can wrap this runner when they need extra behavior,
but the asset itself stays generic to the DockerStep contract.

The fetch helper in [assets/pf-fetch-url.mjs](assets/pf-fetch-url.mjs) supports both `https://` and `file://` URLs so the same image contract works in AWS and local runtime.

These files are generic DockerStep assets. Step-specific images, such as `deploy-project`, should copy them from `plugins/docker/assets` instead of defining local copies.
