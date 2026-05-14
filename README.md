# Danku CLI Node

Danku CLI Node is a pnpm-managed TypeScript command-line tool for generating and managing Danku application boilerplate.

- npm package: `@dankudev/cli`
- executable command: `danku`
- package manager: pnpm
- CLI framework: [`@effect/cli`](https://www.npmjs.com/package/@effect/cli)

## Usage

Run without installing globally:

```bash
pnpm dlx @dankudev/cli --help
pnpm dlx @dankudev/cli new sveltekit my-app
```

Install globally if you want the `danku` command available everywhere:

```bash
pnpm add -g @dankudev/cli
danku --help
danku new sveltekit my-app
```

## Project generation

The `new sveltekit` command mirrors the original Danku CLI flow, but uses CLI options with
environment-variable fallbacks instead of a `.danku` config file:

- creates a private GitHub repository
- runs `pnpm dlx sv create` with Danku's SvelteKit defaults
- adds ESLint, Playwright, Prettier, Tailwind CSS, and Vitest via `sv add`
- copies Danku boilerplate from this package's `templates` directory
- optionally applies `marketing` or `saas-fs` boilerplate
- configures Cloudflare Workers, D1, GitHub variables/secrets, and deploy workflow when configured

Provider and target selection:

```bash
danku new sveltekit my-app \
  --git-provider github \
  --deployment-target cloudflare \
  --boilerplate default
```

`github` and `cloudflare` are the defaults. Use `none` to disable either one explicitly.

Non-secret IDs can be passed as options or read from env:

| Option                         | Environment fallback               |
| ------------------------------ | ---------------------------------- |
| `--cloudflare-account-id`      | `DANKU_CLOUDFLARE_ACCOUNT_ID`      |
| `--cloudflare-zone-id`         | `DANKU_CLOUDFLARE_ZONE_ID`         |
| `--posthog-api-key`            | `DANKU_POSTHOG_API_KEY`            |
| `--stripe-publishable-key`     | `DANKU_STRIPE_PUBLISHABLE_KEY`     |
| `--stripe-publishable-key-dev` | `DANKU_STRIPE_PUBLISHABLE_KEY_DEV` |

Secrets are env-only:

| Secret                        | Environment variable          |
| ----------------------------- | ----------------------------- |
| GitHub token                  | `DANKU_GITHUB_TOKEN`          |
| Cloudflare API token          | `DANKU_CLOUDFLARE_API_TOKEN`  |
| Stripe production secret key  | `DANKU_STRIPE_SECRET_KEY`     |
| Stripe development secret key | `DANKU_STRIPE_SECRET_KEY_DEV` |
| Stripe webhook secret         | `DANKU_STRIPE_WEBHOOK_SECRET` |

Example:

```bash
DANKU_GITHUB_TOKEN=... \
DANKU_CLOUDFLARE_ACCOUNT_ID=... \
DANKU_CLOUDFLARE_API_TOKEN=... \
DANKU_CLOUDFLARE_ZONE_ID=... \
danku new sveltekit my-app
```

## Development

Install dependencies:

```bash
pnpm install
```

Run the CLI from source:

```bash
pnpm run dev -- --help
pnpm run dev -- new sveltekit my-app --dry-run
```

Build the package:

```bash
pnpm run build
```

Validate the package:

```bash
pnpm run lint
pnpm run check
pnpm pack --pack-destination /tmp
```

## Publishing

This package is configured for public npm publishing under the `@dankudev` scope.

Before publishing, make sure you are logged into an npm account with access to the `@dankudev` organization:

```bash
npm whoami
```

Publish:

```bash
pnpm publish --access public
```
