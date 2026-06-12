#!/usr/bin/env node
import { Args, Command, Options } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Config, ConfigProvider, Console, Effect, Option, Redacted } from "effect";

import { createProject } from "./generator.js";
import type { Config as GeneratorConfig } from "./types.js";

const packageName = "@dankudev/cli";
const version = "0.1.0";

const templateArg = Args.text({ name: "template" }).pipe(
	Args.withDescription("Template to generate, for example: sveltekit")
);

const projectNameArg = Args.text({ name: "name" }).pipe(
	Args.withDescription("Name of the project to create")
);

const packageManagerOption = Options.choice("package-manager", ["pnpm", "npm", "yarn"]).pipe(
	Options.withDefault("pnpm"),
	Options.withDescription("Package manager to configure for the generated project")
);

const dryRunOption = Options.boolean("dry-run").pipe(
	Options.withDescription("Print what would be generated without writing files")
);

const gitProviderOption = Options.choice("git-provider", ["github", "none"]).pipe(
	Options.withDefault("github"),
	Options.withDescription("Git provider to configure")
);

const deploymentTargetOption = Options.choice("deployment-target", ["cloudflare", "none"]).pipe(
	Options.withDefault("cloudflare"),
	Options.withDescription("Deployment target to configure")
);

const boilerplateOption = Options.choice("boilerplate", ["default", "marketing", "saas-fs"]).pipe(
	Options.withDefault("default"),
	Options.withDescription("Danku boilerplate layer to apply")
);

const cloudflareAccountIdOption = Options.text("cloudflare-account-id").pipe(
	Options.withFallbackConfig(Config.string("DANKU_CLOUDFLARE_ACCOUNT_ID")),
	Options.optional,
	Options.withDescription("Cloudflare account ID. Falls back to DANKU_CLOUDFLARE_ACCOUNT_ID.")
);

const domainOption = Options.text("domain").pipe(
	Options.withFallbackConfig(Config.string("DANKU_DOMAIN")),
	Options.optional,
	Options.withDescription(
		"Root domain Alchemy will manage in Cloudflare. Falls back to DANKU_DOMAIN."
	)
);

const postHogOrganizationIdOption = Options.text("posthog-organization-id").pipe(
	Options.withFallbackConfig(Config.string("DANKU_POSTHOG_ORGANIZATION_ID")),
	Options.optional,
	Options.withDescription("PostHog organization ID. Falls back to DANKU_POSTHOG_ORGANIZATION_ID.")
);

const stripePublishableKeyOption = Options.text("stripe-publishable-key").pipe(
	Options.withFallbackConfig(Config.string("DANKU_STRIPE_PUBLISHABLE_KEY")),
	Options.optional,
	Options.withDescription(
		"Stripe production publishable key. Falls back to DANKU_STRIPE_PUBLISHABLE_KEY."
	)
);

const stripePublishableKeyDevOption = Options.text("stripe-publishable-key-dev").pipe(
	Options.withFallbackConfig(Config.string("DANKU_STRIPE_PUBLISHABLE_KEY_DEV")),
	Options.optional,
	Options.withDescription(
		"Stripe development publishable key. Falls back to DANKU_STRIPE_PUBLISHABLE_KEY_DEV."
	)
);

type NewCommandInput = {
	boilerplate: "default" | "marketing" | "saas-fs";
	cloudflareAccountId: Option.Option<string>;
	deploymentTarget: "cloudflare" | "none";
	domain: Option.Option<string>;
	dryRun: boolean;
	gitProvider: "github" | "none";
	packageManager: "pnpm" | "npm" | "yarn";
	postHogOrganizationId: Option.Option<string>;
	projectName: string;
	stripePublishableKey: Option.Option<string>;
	stripePublishableKeyDev: Option.Option<string>;
	template: string;
};

type EnvSecrets = {
	stripeSecretKey: string | undefined;
	stripeSecretKeyDev: string | undefined;
	stripeWebhookSecret: string | undefined;
};

const runGenerator = (
	template: string,
	projectName: string,
	dryRun: boolean,
	config: GeneratorConfig
) =>
	Effect.tryPromise({
		try: () => createProject({ config, dryRun, projectName, template }),
		catch: (error) => (error instanceof Error ? error.message : "Unknown generation error")
	}).pipe(
		Effect.catchAll((message) =>
			Effect.gen(function* () {
				yield* Console.error(`DANKU❌ ${message}`);
				yield* Effect.sync(() => {
					process.exitCode = 1;
				});
			})
		)
	);

const unwrapText = (value: Option.Option<string>) =>
	Option.isSome(value) ? value.value : undefined;

const requireOption = (value: string | undefined, description: string) => {
	if (!value) {
		throw new Error(description);
	}

	return value;
};

const optionalSecret = (envName: string) =>
	Config.redacted(envName).pipe(
		Config.option,
		Effect.map((value) => (Option.isSome(value) ? Redacted.value(value.value) : undefined))
	);

const readEnvSecrets = Effect.all({
	stripeSecretKey: optionalSecret("DANKU_STRIPE_SECRET_KEY"),
	stripeSecretKeyDev: optionalSecret("DANKU_STRIPE_SECRET_KEY_DEV"),
	stripeWebhookSecret: optionalSecret("DANKU_STRIPE_WEBHOOK_SECRET")
});

const buildGeneratorConfig = (input: NewCommandInput, secrets: EnvSecrets): GeneratorConfig => {
	const generatorConfig: GeneratorConfig = {
		boilerplate: {},
		deploymentTarget: {},
		gitProvider: {}
	};
	const cloudflareAccountId = unwrapText(input.cloudflareAccountId);
	const domain = unwrapText(input.domain);

	if (input.gitProvider === "github") {
		generatorConfig.gitProvider.gitHub = {};
	}

	if (input.deploymentTarget === "cloudflare") {
		generatorConfig.deploymentTarget.cloudflare = {
			accountId: requireOption(
				cloudflareAccountId,
				"Missing Cloudflare account ID. Pass --cloudflare-account-id or set DANKU_CLOUDFLARE_ACCOUNT_ID."
			),
			domain: requireOption(domain, "Missing domain. Pass --domain or set DANKU_DOMAIN.")
		};
	}

	if (input.boilerplate === "marketing") {
		generatorConfig.boilerplate.marketing = {
			postHogOrganizationId: requireOption(
				unwrapText(input.postHogOrganizationId),
				"Missing PostHog organization ID. Pass --posthog-organization-id or set DANKU_POSTHOG_ORGANIZATION_ID."
			)
		};
	}

	if (input.boilerplate === "saas-fs") {
		generatorConfig.boilerplate.saasFs = {
			postHogOrganizationId: requireOption(
				unwrapText(input.postHogOrganizationId),
				"Missing PostHog organization ID. Pass --posthog-organization-id or set DANKU_POSTHOG_ORGANIZATION_ID."
			),
			stripePublishableKey: requireOption(
				unwrapText(input.stripePublishableKey),
				"Missing Stripe publishable key. Pass --stripe-publishable-key or set DANKU_STRIPE_PUBLISHABLE_KEY."
			),
			stripePublishableKeyDev: requireOption(
				unwrapText(input.stripePublishableKeyDev),
				"Missing Stripe development publishable key. Pass --stripe-publishable-key-dev or set DANKU_STRIPE_PUBLISHABLE_KEY_DEV."
			),
			stripeSecretKey: requireOption(
				secrets.stripeSecretKey,
				"Missing Stripe secret key. Set DANKU_STRIPE_SECRET_KEY."
			),
			stripeSecretKeyDev: requireOption(
				secrets.stripeSecretKeyDev,
				"Missing Stripe development secret key. Set DANKU_STRIPE_SECRET_KEY_DEV."
			),
			stripeWebhookSecret: requireOption(
				secrets.stripeWebhookSecret,
				"Missing Stripe webhook secret. Set DANKU_STRIPE_WEBHOOK_SECRET."
			)
		};
	}

	if (input.gitProvider === "none" && input.deploymentTarget === "none") {
		throw new Error("At least one of --git-provider or --deployment-target must be enabled.");
	}

	return generatorConfig;
};

const newCommand = Command.make(
	"new",
	{
		boilerplate: boilerplateOption,
		cloudflareAccountId: cloudflareAccountIdOption,
		deploymentTarget: deploymentTargetOption,
		domain: domainOption,
		template: templateArg,
		projectName: projectNameArg,
		gitProvider: gitProviderOption,
		packageManager: packageManagerOption,
		postHogOrganizationId: postHogOrganizationIdOption,
		dryRun: dryRunOption,
		stripePublishableKey: stripePublishableKeyOption,
		stripePublishableKeyDev: stripePublishableKeyDevOption
	},
	(input) =>
		Effect.gen(function* () {
			if (input.packageManager !== "pnpm") {
				yield* Console.error("DANKU❌ The SvelteKit generator currently supports pnpm only.");
				yield* Effect.sync(() => {
					process.exitCode = 1;
				});
				return;
			}

			let config: GeneratorConfig;

			try {
				const secrets = yield* readEnvSecrets;
				config = buildGeneratorConfig(input, secrets);
			} catch (error) {
				yield* Console.error(
					`DANKU❌ ${error instanceof Error ? error.message : "Invalid generator options"}`
				);
				yield* Effect.sync(() => {
					process.exitCode = 1;
				});
				return;
			}

			yield* runGenerator(input.template, input.projectName, input.dryRun, config);
		}).pipe(Effect.withConfigProvider(ConfigProvider.fromEnv()))
).pipe(Command.withDescription("Generate a new Danku project from a template"));

const rootCommand = Command.make("danku", {}, () =>
	Console.log(`Danku CLI (${packageName})\n\nRun danku --help to see available commands.`)
).pipe(
	Command.withDescription("Generate and manage Danku application boilerplate"),
	Command.withSubcommands([newCommand])
);

const cli = Command.run(rootCommand, {
	name: "Danku CLI",
	version
});

Effect.suspend(() => cli(process.argv)).pipe(
	Effect.provide(NodeContext.layer),
	NodeRuntime.runMain
);
