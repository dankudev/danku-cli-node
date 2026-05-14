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
