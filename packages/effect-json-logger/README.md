# @pf/effect-json-logger

Structured JSON logging for Effect applications running in AWS Lambda.

It writes directly to stdout so Lambda does not wrap each JSON record in
additional console formatting. This keeps logs readable by CloudWatch and
downstream log tools.

Provide `StdoutJsonLoggerLive` when composing the runtime's logging layer.
