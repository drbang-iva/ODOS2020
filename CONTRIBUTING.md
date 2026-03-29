# Contributing to Open Source OD

We welcome contributions from everyone — whether you're an O.D. learning to code, an experienced developer, or just someone who believes independent practice deserves better tools.

## Getting Started

1. Fork the repo
2. Clone your fork
3. Install dependencies: `npm install`
4. Start PostgreSQL: `docker compose -f docker/docker-compose.yml up -d`
5. Run migrations: `npm run db:migrate`
6. Start dev server: `npm run dev`

## Guidelines

- **Keep it simple.** Independent O.D.s will contribute. Readable code wins.
- **Test at a real practice.** If you can, validate your feature against actual optometry workflows.
- **Local-first always.** No feature should require cloud connectivity.
- **TypeScript strict mode.** No `any` types without justification.

## License

By contributing, you agree that your contributions will be licensed under AGPL v3.
