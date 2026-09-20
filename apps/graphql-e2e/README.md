# About

End-to-end test of a graphql server.

## Running Tests

```bash
# Run all features
npx nx run @pf/graphql-e2e:e2e

# Run single feature file
npx nx run @pf/graphql-e2e:e2e features/authentication.feature

# Run single scenario by line number
npx nx run @pf/graphql-e2e:e2e features/authentication.feature:37

# Run scenarios by tag
npx nx run @pf/graphql-e2e:e2e -- --tags "@smoke"

# Run against deployed AWS environment
BASE_URL=https://example.cloudfront.net APPSYNC_EVENTS_HTTP_HOST=example.appsync-api.ap-southeast-2.amazonaws.com npx nx run @pf/graphql-e2e:e2e

# Run against already-running local servers (reads ports from .graphql-port/.auth-port)
BASE_URL=http://localhost npx nx run @pf/graphql-e2e:e2e
```
