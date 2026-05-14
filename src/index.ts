#!/usr/bin/env node
import { Args, Command, Options } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";

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

const newCommand = Command.make(
	"new",
	{
		template: templateArg,
		projectName: projectNameArg,
		packageManager: packageManagerOption,
		dryRun: dryRunOption
	},
	({ template, projectName, packageManager, dryRun }) =>
		Effect.gen(function* () {
			yield* Console.log(`Preparing ${template} project "${projectName}" with ${packageManager}.`);

			if (dryRun) {
				yield* Console.log("Dry run enabled; no files were written.");
				return;
			}

			yield* Console.log("Project generation is not implemented yet.");
		})
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
