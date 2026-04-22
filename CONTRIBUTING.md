# Contributing to PMAOS

## Getting Started

1. Fork the repository
2. Clone your fork
3. Run `npm install` and `npx tsc` to verify the build
4. Create a branch for your change

## Development Setup

```bash
git clone https://github.com/YOUR_USERNAME/pmaos.git
cd pmaos
npm install
cp .env.example .env  # fill in your API keys
npx tsc               # verify clean compile
npm test              # run test suite
```

## What We Need Help With

- **Provider implementations** -- Gemini, Groq chat, Mistral, or any LLM provider
- **Messaging adapters** -- new platforms beyond Telegram, Discord, Matrix, Signal, Slack
- **Workflow action types** -- expand the action registry with new capabilities
- **Memory retrieval** -- better search, ranking, and context selection strategies
- **Dashboard UI** -- improvements to the web dashboard
- **Documentation** -- guides, examples, and tutorials
- **Security modules** -- new AI Defense Scan attack modules

## Code Standards

- TypeScript strict mode. Every file must compile with `npx tsc --noEmit`
- ES modules (`import`/`export`), not CommonJS
- Use the existing logger (`src/logger.ts`) for all output
- Follow existing patterns: read a similar file before writing a new one
- No hardcoded paths, bot names, or owner names. Use environment variables and templates
- Test coverage for new modules (vitest)

## Pull Request Process

1. One feature or fix per PR
2. Clean compile (`npx tsc --noEmit` with zero errors)
3. Tests pass (`npm test`)
4. Brief description of what changed and why
5. Link related issues if applicable

## Adding a New Provider

Providers live in `src/providers/`. Each implements the provider interface:

1. Create `src/providers/your-provider.ts`
2. Implement the required interface (see existing providers for reference)
3. Register in the provider factory
4. Add any new dependencies to `package.json`
5. Document configuration in `.env.example`

## Adding a New Messaging Platform

Adapters live in `src/` with the naming pattern `*-bot.ts`:

1. Create `src/your-platform-bot.ts`
2. Implement message receive/send, command handling, and voice support (if applicable)
3. Add platform entry to `ecosystem.config.cjs`
4. Document setup in the README

## Adding an AI Defense Scan Module

Attack modules live in `src/wraith/`:

1. Create `src/wraith/your-module.ts` implementing the `AttackModule` interface
2. Register in the module registry (`src/wraith/scanner.ts`)
3. Export from `src/wraith/index.ts`
4. Findings must use the standard `Finding` type with proper severity levels

## Security

- Never commit secrets, API keys, or credentials
- Run `scripts/scan-skill.sh` on any new skill before installing
- Report vulnerabilities privately (see SECURITY.md)
- All bash execution must go through the Paladin policy engine

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
