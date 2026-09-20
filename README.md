# Process Focus

Source-available tools for modelling and executing business processes. See
[LICENSE.md](LICENSE.md) for the O'Saasy license.

## Development

Install the Bun and Node versions in mise.toml, then run:

```sh
bun install --frozen-lockfile
bun run lint
bun run lint:project-boundaries
bun scripts/nx-quiet.ts run @pf/demo:build
```

The examples are examples/demo and examples/on-boarding. Set MY_EMAIL for
your own invitation when using the on-boarding example. Hosted CLI commands
communicate with the hosting API; the hosted service implementation is separate.

To build the generic Dashboard with a temporary local backend:

```sh
bun scripts/nx-quiet.ts run @processfocus/runtime-local:dashboard-build
```

The Dashboard build requires Linux, Git, curl, flock, and setsid. It supervises
its own temporary database and local servers.
