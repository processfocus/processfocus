# DockerStep

`@processfocus/plugin-docker` provides container-backed process steps.
The organisation defines the step; a runtime executor launches the container
and handles input, output and files.

## Availability

In Process Focus cloud hosting, Docker steps are reserved for the Cloud Backend.
Customer projects containing `DockerStep` cannot be deployed. The plugin is
also available for runtime adapter development.

## Container integration

The shared [runner](assets/pf-docker-step-runner.mjs) handles input download and
result upload around the image's command. Step images should reuse it and the
[URL helper](assets/pf-fetch-url.mjs), which supports local files and HTTPS.

Runtime adapters use the `ExecutorHost` and `FileResolutionHost` contracts from
`@processfocus/runtime`.
