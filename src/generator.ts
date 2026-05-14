import { applyEdits, modify } from "jsonc-parser";
import { Cloudflare, CloudflareError } from "cloudflare";
import sodium from "libsodium-wrappers";
import { spawn, type SpawnOptions } from "node:child_process";
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { EOL, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Octokit, RequestError } from "octokit";
import { stringify } from "yaml";

import type { Config } from "./types.js";

type NewProjectOptions = {
	config: Config;
	dryRun: boolean;
	projectName: string;
	template: string;
};

type CommandOptions = SpawnOptions & {
	dryRun?: boolean;
	optional?: boolean;
};

type JsonEdit = {
	path: (number | string)[];
	value: boolean | object | string | string[];
};

type WorkflowStep = {
	env?: Record<string, string>;
	name: string;
	run?: string;
	uses?: string;
	with?: Record<string, number | string>;
};

const uuidRegex = /^[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

class GenerationError extends Error {
	override name = "GenerationError";
}

class DankuGenerator {
	private cloudflare = new Cloudflare();
	private domain = new URL("https://danku.dev");
	private octokit = new Octokit();
	private owner = "";

	async createProject({ config, dryRun, projectName, template }: NewProjectOptions): Promise<void> {
		if (template !== "sveltekit") {
			throw new GenerationError(
				`Unsupported template "${template}". Supported templates: sveltekit`
			);
		}

		const projectPath = join(process.cwd(), projectName);
		if (await pathExists(projectPath)) {
			throw new GenerationError(`Directory ${projectName} already exists`);
		}

		console.log(`DANKU🧊 Creating a new SvelteKit project "${projectName}"`);

		if (dryRun) {
			await this.printDryRun(config, projectName);
			return;
		}

		await this.validateTarget(config, projectName);

		const createRepository = config.gitProvider.gitHub
			? await this.gitCreateRepository(config, projectName)
			: undefined;
		await this.createSvelteKitProject(projectName);
		await this.addDefaultBoilerplate(projectName);

		if (config.boilerplate.marketing) {
			await this.addMarketingBoilerplate(config, projectName);
		}

		if (config.boilerplate.saasFs) {
			await this.addMarketingBoilerplate(config, projectName);
			await this.addSaasFullStackBoilerplate(config, projectName);
		}

		if (config.deploymentTarget.cloudflare) {
			await this.addCloudflareDeployment(config, projectName);
		}

		await this.executeCommand("pnpm", ["run", "format"], { cwd: projectName });
		await this.executeCommand("git", ["init"], { cwd: projectName });
		await this.executeCommand("git", ["add", "."], { cwd: projectName });
		await this.executeCommand("git", ["commit", "-m", "Initial commit"], { cwd: projectName });
		if (createRepository) {
			await this.executeCommand("git", ["remote", "add", "origin", createRepository], {
				cwd: projectName
			});
			await this.executeCommand("git", ["push", "-u", "origin", "main"], { cwd: projectName });
		}

		console.log(`DANKU✅ Successfully created SvelteKit project "${projectName}"`);
	}

	private async addCloudflareDeployment(config: Config, projectName: string): Promise<void> {
		const cloudflareConfig = config.deploymentTarget.cloudflare;
		if (!cloudflareConfig) return;

		await this.gitAddOrUpdateVariable(
			config,
			projectName,
			"CLOUDFLARE_ACCOUNT_ID",
			cloudflareConfig.accountId
		);
		await this.gitAddOrUpdateSecret(
			config,
			projectName,
			"CLOUDFLARE_API_TOKEN",
			cloudflareConfig.token
		);
		await this.copyTemplateFiles("boilerplate/cloudflare", projectName);
		await this.executeCommand("pnpm", [
			"dlx",
			"sv",
			"add",
			"sveltekit-adapter=adapter:cloudflare+cfTarget:workers",
			"--install",
			"pnpm",
			"--cwd",
			projectName
		]);
		await this.modifyJsonFile(
			"wrangler.jsonc",
			[
				{ path: ["name"], value: projectName },
				{ path: ["compatibility_date"], value: new Date().toISOString().slice(0, 10) },
				{ path: ["compatibility_flags"], value: ["nodejs_compat"] },
				{ path: ["workers_dev"], value: false },
				{ path: ["routes", 0, "pattern"], value: this.domain.hostname }
			],
			2,
			projectName
		);
		await this.modifyJsonFile(
			"package.json",
			[{ path: ["scripts", "build"], value: "wrangler types && vite build" }],
			4,
			projectName
		);
		await this.modifyJsonFile(
			"tsconfig.json",
			[{ path: ["compilerOptions", "types"], value: ["./worker-configuration.d.ts", "node"] }],
			4,
			projectName
		);
		await this.replaceInFile(
			join(process.cwd(), projectName, ".gitignore"),
			"node_modules",
			`node_modules

worker-configuration.d.ts`
		);

		if (config.boilerplate.saasFs) {
			await this.addCloudflareD1Bindings(config, projectName);
		}

		if (config.gitProvider.gitHub) {
			await this.writeCloudflareDeployWorkflow(config, projectName);
		}

		await this.executeCommand("pnpm", ["add", "-D", "wrangler"], { cwd: projectName });
		await this.executeCommand("pnpm", ["run", "gen"], { cwd: projectName });
		await this.executeCommand("pnpm", ["run", "db:migrate"], {
			cwd: projectName,
			optional: !config.boilerplate.saasFs
		});
		await this.executeCommand("pnpm", ["run", "db:migrate:shards"], {
			cwd: projectName,
			optional: !config.boilerplate.saasFs
		});
	}

	private async addCloudflareD1Bindings(config: Config, projectName: string): Promise<void> {
		const mainDatabaseId = await this.targetCreateResource(config, projectName);
		const firstShardDatabaseId = await this.targetCreateResource(config, `${projectName}-s00`);
		const secondShardDatabaseId = await this.targetCreateResource(config, `${projectName}-s01`);

		await this.modifyJsonFile(
			"wrangler.jsonc",
			[
				{ path: ["d1_databases", 0, "binding"], value: "DB" },
				{ path: ["d1_databases", 0, "database_name"], value: projectName },
				{ path: ["d1_databases", 0, "database_id"], value: mainDatabaseId },
				{ path: ["d1_databases", 0, "migrations_dir"], value: "./src/lib/server/db/migrations" },
				{ path: ["d1_databases", 1, "binding"], value: "DB_S00" },
				{ path: ["d1_databases", 1, "database_name"], value: `${projectName}-s00` },
				{ path: ["d1_databases", 1, "database_id"], value: firstShardDatabaseId },
				{
					path: ["d1_databases", 1, "migrations_dir"],
					value: "./src/lib/server/db/shards/migrations"
				},
				{ path: ["d1_databases", 2, "binding"], value: "DB_S01" },
				{ path: ["d1_databases", 2, "database_name"], value: `${projectName}-s01` },
				{ path: ["d1_databases", 2, "database_id"], value: secondShardDatabaseId },
				{
					path: ["d1_databases", 2, "migrations_dir"],
					value: "./src/lib/server/db/shards/migrations"
				}
			],
			2,
			projectName
		);
	}

	private async addDefaultBoilerplate(projectName: string): Promise<void> {
		await this.copyTemplateFiles("boilerplate/default", projectName);
		await this.executeCommand("pnpm", ["add", "-D", "@iconify/json"], { cwd: projectName });
		await this.executeCommand("pnpm", ["add", "-D", "@iconify/tailwind4"], { cwd: projectName });
		await this.modifyJsonFile(
			".prettierrc",
			[{ path: ["singleQuote"], value: false }],
			4,
			projectName
		);
		await fs.rm(join(process.cwd(), projectName, "src", "lib", "vitest-examples"), {
			force: true,
			recursive: true
		});
		await fs.rm(join(process.cwd(), projectName, "src", "routes", "demo"), {
			force: true,
			recursive: true
		});
	}

	private async addMarketingBoilerplate(config: Config, projectName: string): Promise<void> {
		const postHogApiKey =
			config.boilerplate.marketing?.postHogApiKey ?? config.boilerplate.saasFs?.postHogApiKey ?? "";

		await this.gitAddOrUpdateEnvVariable(
			config,
			projectName,
			"ORIGIN",
			"http://localhost:5173",
			this.domain.origin
		);
		await this.gitAddOrUpdateEnvVariable(config, projectName, "POSTHOG_API_KEY", "", postHogApiKey);
		await this.copyTemplateFiles("boilerplate/marketing", projectName);
		await fs.rm(join(process.cwd(), projectName, "static", "robots.txt"), { force: true });
		await this.replaceInFile(
			join(process.cwd(), projectName, "src", "routes", "+layout.ts"),
			'api_host: "https://us.i.posthog.com",',
			`api_host: "https://a.${this.domain.hostname}",`
		);
		await this.replaceInFile(
			join(process.cwd(), projectName, "svelte.config.js"),
			"adapter: adapter()",
			`adapter: adapter(),
		paths: {
			relative: false
		}`
		);
		await this.executeCommand("pnpm", ["add", "-D", "posthog-js"], { cwd: projectName });
	}

	private async addSaasFullStackBoilerplate(config: Config, projectName: string): Promise<void> {
		const saasConfig = config.boilerplate.saasFs;
		if (!saasConfig) return;

		await this.gitAddOrUpdateEnvSecret(
			config,
			projectName,
			"AUTH_SECRET",
			crypto.randomBytes(32).toString("hex"),
			crypto.randomBytes(32).toString("hex")
		);
		await this.gitAddOrUpdateEnvVariable(
			config,
			projectName,
			"STRIPE_PUBLISHABLE_KEY",
			saasConfig.stripePublishableKeyDev,
			saasConfig.stripePublishableKey
		);
		await this.gitAddOrUpdateEnvSecret(
			config,
			projectName,
			"STRIPE_SECRET_KEY",
			saasConfig.stripeSecretKeyDev,
			saasConfig.stripeSecretKey
		);
		await this.gitAddOrUpdateEnvSecret(
			config,
			projectName,
			"STRIPE_WEBHOOK_SECRET",
			"",
			saasConfig.stripeWebhookSecret
		);
		await this.copyTemplateFiles("boilerplate/saasFs", projectName);
		await this.replaceInFile(
			join(process.cwd(), projectName, "src", "app.d.ts"),
			"// interface Locals {}",
			`interface Locals {
			user?: User;
		}`
		);
		await this.replaceInFile(
			join(process.cwd(), projectName, "src", "app.d.ts"),
			"// for information about these interfaces",
			`// for information about these interfaces
import type { User } from "$lib/server/auth";
`
		);
		await this.modifyJsonFile(
			"package.json",
			[
				{
					path: ["scripts", "db:generate"],
					value: "drizzle-kit generate --config=./src/lib/server/db/config.ts"
				},
				{
					path: ["scripts", "db:generate:shards"],
					value: "drizzle-kit generate --config=./src/lib/server/db/shards/config.ts"
				},
				{
					path: ["scripts", "db:migrate"],
					value: `${platform() === "win32" ? "echo y |" : "yes |"} wrangler d1 migrations apply ${projectName} --local`
				},
				{
					path: ["scripts", "db:migrate:shards"],
					value: `${platform() === "win32" ? "echo y |" : "yes |"} wrangler d1 migrations apply ${projectName}-s00 --local && ${platform() === "win32" ? "echo y |" : "yes |"} wrangler d1 migrations apply ${projectName}-s01 --local`
				}
			],
			4,
			projectName
		);
		await this.executeCommand("pnpm", ["add", "-D", "drizzle-kit"], { cwd: projectName });
		await this.executeCommand("pnpm", ["add", "-D", "drizzle-orm"], { cwd: projectName });
		await this.executeCommand("pnpm", ["add", "-D", "better-auth"], { cwd: projectName });
		await this.executeCommand("pnpm", ["add", "-D", "@better-auth/stripe"], { cwd: projectName });
		await this.executeCommand("pnpm", ["add", "-D", "@better-auth/drizzle-adapter"], {
			cwd: projectName
		});
		await this.executeCommand("pnpm", ["add", "-D", "stripe"], { cwd: projectName });
		await this.executeCommand("pnpm", ["add", "-D", "posthog-node"], { cwd: projectName });
		await this.executeCommand("pnpm", ["run", "db:generate"], { cwd: projectName });
		await this.executeCommand("pnpm", ["run", "db:generate:shards"], { cwd: projectName });
	}

	private async copyTemplateFiles(templatePath: string, projectName: string): Promise<void> {
		const templateRoot = join(dirname(fileURLToPath(import.meta.url)), "templates");
		const templateSourceDirectory = join(templateRoot, ...templatePath.split("/"));
		const projectDirectory = join(process.cwd(), projectName);
		await fs.cp(templateSourceDirectory, projectDirectory, { force: true, recursive: true });
	}

	private async createSvelteKitProject(projectName: string): Promise<void> {
		await this.executeCommand("pnpm", [
			"dlx",
			"sv",
			"create",
			"--template",
			"minimal",
			"--types",
			"ts",
			"--no-add-ons",
			"--install",
			"pnpm",
			projectName
		]);
		await this.executeCommand("pnpm", [
			"dlx",
			"sv",
			"add",
			"eslint",
			"--install",
			"pnpm",
			"--cwd",
			projectName
		]);
		await this.executeCommand("pnpm", [
			"dlx",
			"sv",
			"add",
			"playwright",
			"--install",
			"pnpm",
			"--cwd",
			projectName
		]);
		await this.executeCommand("pnpm", [
			"dlx",
			"sv",
			"add",
			"prettier",
			"--install",
			"pnpm",
			"--cwd",
			projectName
		]);
		await this.executeCommand("pnpm", [
			"dlx",
			"sv",
			"add",
			"tailwindcss=plugins:typography,forms",
			"--install",
			"pnpm",
			"--cwd",
			projectName
		]);
		await this.executeCommand("pnpm", [
			"dlx",
			"sv",
			"add",
			"vitest=usages:unit,component",
			"--install",
			"pnpm",
			"--cwd",
			projectName
		]);
	}

	private async executeCommand(
		command: string,
		args: string[],
		options: CommandOptions = {}
	): Promise<void> {
		if (options.dryRun) {
			console.log(`[dry-run] ${command} ${args.join(" ")}`);
			return;
		}

		return new Promise((resolve, reject) => {
			const child = spawn(command, args, {
				stdio: "inherit",
				...options
			});

			child.on("close", (code) => {
				if (code === 0 || options.optional) {
					resolve();
				} else {
					reject(
						new GenerationError(
							`Command failed with exit code ${code}: ${command} ${args.join(" ")}`
						)
					);
				}
			});

			child.on("error", (error) => {
				if (options.optional) {
					resolve();
				} else {
					reject(new GenerationError(`Failed to execute command: ${error.message}`));
				}
			});
		});
	}

	private async gitAddOrUpdateEnvSecret(
		config: Config,
		repositoryName: string,
		key: string,
		devValue: string,
		prodValue: string
	): Promise<void> {
		if (config.gitProvider.gitHub) {
			await this.gitEnsureEnvironment(repositoryName);
			try {
				const {
					data: { key: publicKey, key_id: keyId }
				} = await this.octokit.request(
					"GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key",
					{
						environment_name: "Production",
						owner: this.owner,
						repo: repositoryName
					}
				);

				await sodium.ready;
				const keyBytes = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
				const secretBytes = sodium.from_string(prodValue);
				const encryptedBytes = sodium.crypto_box_seal(secretBytes, keyBytes);
				const encryptedValue = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);

				await this.octokit.request(
					"PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}",
					{
						encrypted_value: encryptedValue,
						environment_name: "Production",
						key_id: keyId,
						owner: this.owner,
						repo: repositoryName,
						secret_name: key
					}
				);
			} catch (error) {
				throw new GenerationError(
					`Failed to add/update environment secret: ${toErrorMessage(error)}`
				);
			}
		}

		await this.updateEnvFile(repositoryName, key, devValue);
	}

	private async gitAddOrUpdateEnvVariable(
		config: Config,
		repositoryName: string,
		key: string,
		devValue: string,
		prodValue: string
	): Promise<void> {
		if (config.gitProvider.gitHub) {
			await this.gitEnsureEnvironment(repositoryName);
			let variableExists = true;

			try {
				await this.octokit.request(
					"GET /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}",
					{
						environment_name: "Production",
						name: key,
						owner: this.owner,
						repo: repositoryName
					}
				);
			} catch (error) {
				if (error instanceof RequestError && error.status === 404) {
					variableExists = false;
				} else {
					throw new GenerationError(
						`Failed to check environment variable: ${toErrorMessage(error)}`
					);
				}
			}

			try {
				if (variableExists) {
					await this.octokit.request(
						"PATCH /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}",
						{
							environment_name: "Production",
							name: key,
							owner: this.owner,
							repo: repositoryName,
							value: prodValue
						}
					);
				} else {
					await this.octokit.request(
						"POST /repos/{owner}/{repo}/environments/{environment_name}/variables",
						{
							environment_name: "Production",
							name: key,
							owner: this.owner,
							repo: repositoryName,
							value: prodValue
						}
					);
				}
			} catch (error) {
				throw new GenerationError(
					`Failed to create environment variable: ${toErrorMessage(error)}`
				);
			}
		}

		await this.updateEnvFile(repositoryName, `PUBLIC_${key}`, devValue);
	}

	private async gitAddOrUpdateSecret(
		config: Config,
		repositoryName: string,
		key: string,
		value: string
	): Promise<void> {
		if (!config.gitProvider.gitHub) return;

		try {
			const {
				data: { key: publicKey, key_id: keyId }
			} = await this.octokit.request("GET /repos/{owner}/{repo}/actions/secrets/public-key", {
				owner: this.owner,
				repo: repositoryName
			});

			await sodium.ready;
			const keyBytes = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
			const secretBytes = sodium.from_string(value);
			const encryptedBytes = sodium.crypto_box_seal(secretBytes, keyBytes);
			const encryptedValue = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);

			await this.octokit.request("PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}", {
				encrypted_value: encryptedValue,
				key_id: keyId,
				owner: this.owner,
				repo: repositoryName,
				secret_name: key
			});
		} catch (error) {
			throw new GenerationError(`Failed to add/update secret: ${toErrorMessage(error)}`);
		}
	}

	private async gitAddOrUpdateVariable(
		config: Config,
		repositoryName: string,
		key: string,
		value: string
	): Promise<void> {
		if (!config.gitProvider.gitHub) return;

		let variableExists = true;
		try {
			await this.octokit.request("GET /repos/{owner}/{repo}/actions/variables/{name}", {
				name: key,
				owner: this.owner,
				repo: repositoryName
			});
		} catch (error) {
			if (error instanceof RequestError && error.status === 404) {
				variableExists = false;
			} else {
				throw new GenerationError(`Failed to check variable: ${toErrorMessage(error)}`);
			}
		}

		try {
			if (variableExists) {
				await this.octokit.request("PATCH /repos/{owner}/{repo}/actions/variables/{name}", {
					name: key,
					owner: this.owner,
					repo: repositoryName,
					value
				});
			} else {
				await this.octokit.request("POST /repos/{owner}/{repo}/actions/variables", {
					name: key,
					owner: this.owner,
					repo: repositoryName,
					value
				});
			}
		} catch (error) {
			throw new GenerationError(`Failed to add/update variable: ${toErrorMessage(error)}`);
		}
	}

	private async gitCreateRepository(config: Config, repositoryName: string): Promise<string> {
		if (!config.gitProvider.gitHub) {
			throw new GenerationError("No GitHub provider is configured");
		}

		try {
			await this.octokit.request("POST /orgs/{org}/repos", {
				name: repositoryName,
				org: this.owner,
				private: true
			});
		} catch (error) {
			throw new GenerationError(`Failed to create repository: ${toErrorMessage(error)}`);
		}

		return `https://github.com/${this.owner}/${repositoryName}.git`;
	}

	private async gitEnsureEnvironment(repositoryName: string): Promise<void> {
		try {
			await this.octokit.request("PUT /repos/{owner}/{repo}/environments/{environment_name}", {
				environment_name: "Production",
				owner: this.owner,
				repo: repositoryName
			});
		} catch (error) {
			throw new GenerationError(`Failed to create or update environment: ${toErrorMessage(error)}`);
		}
	}

	private async modifyJsonFile(
		filePath: string,
		edits: JsonEdit[],
		tabSize: number,
		projectName: string
	): Promise<void> {
		const fullPath = join(process.cwd(), projectName, filePath);
		let fileContent = await fs.readFile(fullPath, "utf8");

		for (const edit of edits) {
			const jsonEdits = modify(fileContent, edit.path, edit.value, {
				formattingOptions: {
					eol: EOL,
					insertSpaces: true,
					tabSize
				}
			});
			fileContent = applyEdits(fileContent, jsonEdits);
		}

		await fs.writeFile(fullPath, fileContent, "utf8");
	}

	private async printDryRun(config: Config, projectName: string): Promise<void> {
		const boilerplateName = config.boilerplate.saasFs
			? "saasFs"
			: config.boilerplate.marketing
				? "marketing"
				: "default";

		const hasGitHub = config.gitProvider.gitHub !== undefined;

		console.log("Dry run enabled; no files were written.");
		if (hasGitHub) {
			console.log(`Would create private GitHub repository: ${projectName}`);
		}
		console.log(
			"Would run: pnpm dlx sv create --template minimal --types ts --no-add-ons --install pnpm"
		);
		console.log("Would add: eslint, playwright, prettier, tailwindcss, vitest");
		console.log(
			`Would copy Danku boilerplate: default${boilerplateName === "default" ? "" : ` + ${boilerplateName}`}`
		);

		if (config.deploymentTarget.cloudflare) {
			console.log(
				`Would configure Cloudflare Workers deployment${hasGitHub ? " and GitHub Actions" : ""}`
			);
		}
	}

	private async replaceInFile(
		filePath: string,
		searchValue: string,
		replacement: string
	): Promise<void> {
		const fileData = await fs.readFile(filePath, "utf8");
		await fs.writeFile(filePath, fileData.replace(searchValue, replacement), "utf8");
	}

	private async targetCreateResource(config: Config, resourceName: string): Promise<string> {
		const cloudflareConfig = config.deploymentTarget.cloudflare;
		if (!cloudflareConfig) {
			throw new GenerationError("No Cloudflare deployment target is configured");
		}

		try {
			const d1 = await this.cloudflare.d1.database.create({
				account_id: cloudflareConfig.accountId,
				name: resourceName
			});

			if (!d1.uuid || !uuidRegex.test(d1.uuid)) {
				throw new GenerationError(
					`Cloudflare returned an invalid D1 database id for ${resourceName}`
				);
			}

			return d1.uuid;
		} catch (error) {
			if (error instanceof GenerationError) throw error;
			throw new GenerationError(`Failed to create resources: ${toErrorMessage(error)}`);
		}
	}

	private async validateTarget(config: Config, repositoryName: string): Promise<void> {
		await this.validateGitHubTarget(config, repositoryName);
		await this.validateCloudflareTarget(config, repositoryName);
	}

	private async validateCloudflareTarget(config: Config, resourceName: string): Promise<void> {
		const cloudflareConfig = config.deploymentTarget.cloudflare;
		if (!cloudflareConfig) return;

		this.cloudflare = new Cloudflare({ apiToken: cloudflareConfig.token });
		try {
			const verification = await this.cloudflare.accounts.tokens.verify({
				account_id: cloudflareConfig.accountId
			});
			if (verification.status !== "active") {
				throw new GenerationError("Cloudflare API token is not active");
			}

			const zone = await this.cloudflare.zones.get({
				zone_id: cloudflareConfig.zoneId
			});
			this.domain = new URL(`https://${zone.name}`);
		} catch (error) {
			if (error instanceof GenerationError) throw error;
			throw new GenerationError("Invalid Cloudflare account ID, API token, or zone ID");
		}

		try {
			for await (const script of this.cloudflare.workers.scripts.list({
				account_id: cloudflareConfig.accountId
			})) {
				if (script.id === resourceName) {
					throw new GenerationError(`Resource ${resourceName} already exists`);
				}
			}

			for await (const databaseListResponse of this.cloudflare.d1.database.list({
				account_id: cloudflareConfig.accountId
			})) {
				if (databaseListResponse.name === resourceName) {
					throw new GenerationError(`Resource ${resourceName} already exists`);
				}
			}
		} catch (error) {
			if (error instanceof GenerationError) throw error;
			throw new GenerationError(`Failed to check resources: ${toErrorMessage(error)}`);
		}
	}

	private async validateGitHubTarget(config: Config, repositoryName: string): Promise<void> {
		const gitHubConfig = config.gitProvider.gitHub;
		if (!gitHubConfig) return;

		this.octokit = new Octokit({ auth: gitHubConfig.token });
		try {
			const { data: memberships } = await this.octokit.request("GET /user/memberships/orgs");
			if (memberships.length === 0) {
				throw new GenerationError(
					"You do not have access to any organizations. Please try again with a different token."
				);
			}

			this.owner = memberships[0]!.organization.login;
		} catch (error) {
			if (error instanceof GenerationError) throw error;
			if (error instanceof RequestError && error.status === 401)
				throw new GenerationError("Invalid GitHub token");
			if (error instanceof RequestError && error.status === 403) {
				throw new GenerationError("GitHub token has insufficient permissions");
			}

			throw new GenerationError(
				`Failed to read GitHub organization membership: ${toErrorMessage(error)}`
			);
		}

		try {
			await this.octokit.request("GET /repos/{owner}/{repo}", {
				owner: this.owner,
				repo: repositoryName
			});
			throw new GenerationError(`Repository ${repositoryName} already exists`);
		} catch (error) {
			if (error instanceof RequestError && error.status === 404) return;
			if (error instanceof GenerationError) throw error;
			if (error instanceof RequestError && error.status === 403) {
				throw new GenerationError("GitHub token has insufficient permissions");
			}

			throw new GenerationError(`Failed to check repository: ${toErrorMessage(error)}`);
		}
	}

	private async writeCloudflareDeployWorkflow(config: Config, projectName: string): Promise<void> {
		const steps: WorkflowStep[] = [
			{
				name: "Checkout",
				uses: "actions/checkout@v6"
			},
			{
				name: "Setup pnpm",
				uses: "pnpm/action-setup@v4",
				with: {
					version: 10
				}
			},
			{
				name: "Setup Node.js environment",
				uses: "actions/setup-node@v6",
				with: {
					cache: "pnpm",
					"node-version": 24
				}
			},
			{
				name: "Install dependencies",
				run: "pnpm install"
			},
			{
				name: "Build project",
				run: "pnpm run build"
			},
			{
				name: "Deploy to Cloudflare Workers with Wrangler",
				uses: "cloudflare/wrangler-action@v3",
				with: {
					accountId: "${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
					apiToken: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
					packageManager: "pnpm"
				}
			}
		];

		if (config.boilerplate.marketing) {
			steps[4] = {
				env: {
					PUBLIC_ORIGIN: "${{ vars.ORIGIN }}",
					PUBLIC_POSTHOG_API_KEY: "${{ vars.POSTHOG_API_KEY }}"
				},
				name: "Build project",
				run: "pnpm run build"
			};
		}

		if (config.boilerplate.saasFs) {
			steps[4] = {
				env: {
					AUTH_SECRET: "${{ secrets.AUTH_SECRET }}",
					PUBLIC_ORIGIN: "${{ vars.ORIGIN }}",
					PUBLIC_POSTHOG_API_KEY: "${{ vars.POSTHOG_API_KEY }}",
					PUBLIC_STRIPE_PUBLISHABLE_KEY: "${{ vars.STRIPE_PUBLISHABLE_KEY }}",
					STRIPE_SECRET_KEY: "${{ secrets.STRIPE_SECRET_KEY }}",
					STRIPE_WEBHOOK_SECRET: "${{ secrets.STRIPE_WEBHOOK_SECRET }}"
				},
				name: "Build project",
				run: "pnpm run build"
			};
			steps.splice(
				5,
				0,
				{
					name: "Run D1 Migrations with Wrangler for main DB",
					uses: "cloudflare/wrangler-action@v3",
					with: {
						accountId: "${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
						apiToken: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
						command: `d1 migrations apply ${projectName} --remote`
					}
				},
				{
					name: "Run D1 Migrations with Wrangler for first shard",
					uses: "cloudflare/wrangler-action@v3",
					with: {
						accountId: "${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
						apiToken: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
						command: `d1 migrations apply ${projectName}-s00 --remote`
					}
				},
				{
					name: "Run D1 Migrations with Wrangler for second shard",
					uses: "cloudflare/wrangler-action@v3",
					with: {
						accountId: "${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
						apiToken: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
						command: `d1 migrations apply ${projectName}-s01 --remote`
					}
				}
			);
		}

		const yamlString = stringify(
			{
				name: "Deploy to Cloudflare Workers",
				on: {
					push: {
						branches: ["main"]
					}
				},
				jobs: {
					"build-and-deploy": {
						environment: "Production",
						name: "Build and Deploy to Production",
						"runs-on": "ubuntu-latest",
						steps
					}
				}
			},
			{
				lineWidth: -1
			}
		);
		const gitHubWorkflowsPath = join(process.cwd(), projectName, ".github", "workflows");
		await fs.mkdir(gitHubWorkflowsPath, {
			recursive: true
		});
		await fs.writeFile(join(gitHubWorkflowsPath, "deploy-to-cloudflare.yml"), yamlString, "utf8");
	}

	private async updateEnvFile(repositoryName: string, key: string, value: string): Promise<void> {
		const envPath = join(process.cwd(), repositoryName, ".env");
		let envContent = "";

		try {
			envContent = await fs.readFile(envPath, "utf8");
		} catch {}

		if (envContent.includes(`${key}=`)) {
			const lines = envContent.split(/\r?\n/);
			const updatedLines = lines.map((line) => {
				const [currentKey] = line.split("=");

				if (currentKey === key) {
					return `${key}=${value}`;
				}

				return line;
			});

			envContent = updatedLines.join("\n");
		} else {
			if (envContent && !envContent.endsWith("\n")) {
				envContent += "\n";
			}

			envContent += `${key}=${value}\n`;
		}

		await fs.writeFile(envPath, envContent, "utf8");
	}
}

export async function createProject(options: NewProjectOptions): Promise<void> {
	const generator = new DankuGenerator();
	await generator.createProject(options);
}

function pathExists(path: string): Promise<boolean> {
	return fs
		.access(path)
		.then(() => true)
		.catch(() => false);
}

function toErrorMessage(error: unknown): string {
	if (error instanceof CloudflareError || error instanceof RequestError || error instanceof Error) {
		return error.message;
	}

	return "Unknown error";
}
