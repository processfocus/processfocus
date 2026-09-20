import { Effect } from "effect"
import { graphqlRequestWithCredentials } from "../../../cli/pfcli/src/utils/graphql-client"

// A separate process reads pfcli's actual persisted credential and HTTP client.
const query = await Bun.stdin.text()
await Effect.runPromise(
  graphqlRequestWithCredentials(query).pipe(
    Effect.match({
      onFailure: (error) =>
        console.info(JSON.stringify({ error: error.message })),
      onSuccess: (data) => console.info(JSON.stringify({ data })),
    }),
  ),
)
