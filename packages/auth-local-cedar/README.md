# @pf/auth-local-cedar

Evaluates Cedar authorization policies in the application process, implementing
the service defined by [`@pf/auth-policy`](../auth-policy/README.md).
“Local” refers to where policy evaluation runs; this package also serves hosted
runtimes.

It combines the shared policy/schema with organisation-specific policies.
Static configuration suits deployed applications; file watching supports policy
reloads during local development.

See the [configuration layers](./src/lib/config-base.ts) for composition options.
