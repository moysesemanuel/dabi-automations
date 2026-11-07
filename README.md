# DaBi Automations

Plataforma de automações para Instagram (MVP 1.0: comentário → DM). Monólito modular em monorepo.

```
pnpm install
cp .env.example .env      # preencha os segredos
pnpm infra:up             # Postgres + Redis
pnpm db:generate && pnpm db:migrate
pnpm dev:api | dev:worker | dev:web
```
Docs em `docs/` (architecture, security, meta-integration).
