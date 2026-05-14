# Danku CLI

Danku CLI is a command-line tool for generating and managing Danku application boilerplate.

- npm package: `@danku/cli`
- executable command: `dnk`
- package manager: pnpm
- CLI framework: [`@effect/cli`](https://www.npmjs.com/package/@effect/cli)

## Usage

Run without installing globally:

```bash
pnpm dlx @danku/cli --help
pnpm dlx @danku/cli new sveltekit my-app
```

Install globally if you want the `dnk` command available everywhere:

```bash
pnpm add -g @danku/cli
dnk --help
dnk new sveltekit my-app
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

This package is configured for public npm publishing under the `@danku` scope.

Before publishing, make sure you are logged into an npm account with access to the `@danku` organization:

```bash
npm whoami
```

Publish:

```bash
pnpm publish --access public
```
