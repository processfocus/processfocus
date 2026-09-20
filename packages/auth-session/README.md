# About

Shared type of what details of a user are available in the JWT token.

Used by both the `auth-api` package and the frontend.

Also includes shared issuer/client/audience helpers used by backend services.

Frontend runtime issuer resolution lives in `apps/frontend/lib/auth/issuer.ts`
and prefers `FRONTEND_JWT_TOKEN`.
