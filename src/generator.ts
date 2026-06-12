import { transforms, type AstTypes } from "@sveltejs/sv-utils";
import { spawn, type SpawnOptions } from "node:child_process";
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };

type JsonPath = Array<number | string>;

type JsonEdit = {
	path: JsonPath;
	value: JsonValue;
};

type WorkflowStep = {
	env?: Record<string, string>;
	name: string;
	run?: string;
	uses?: string;
	with?: Record<string, number | string>;
	"working-directory"?: string;
};

type ObjectPropertyNode = AstTypes.BaseNode & {
	key: AstTypes.BaseNode & {
		name?: string;
		type: string;
	};
	value: AstTypes.BaseNode;
};

class GenerationError extends Error {
	override name = "GenerationError";
}

class DankuGenerator {
	private domain = new URL("https://danku.dev");

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

		this.configureTarget(config);

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
		console.log(`DANKU✅ Successfully created SvelteKit project "${projectName}"`);
	}

	private async addCloudflareDeployment(config: Config, projectName: string): Promise<void> {
		const cloudflareConfig = config.deploymentTarget.cloudflare;
		if (!cloudflareConfig) return;

		await this.copyTemplateFiles("boilerplate/cloudflare", projectName);
		await this.executeCommand("pnpm", [
			"dlx",
			"sv",
			"add",
			"--no-git-check",
			"--no-download-check",
			"sveltekit-adapter=adapter:cloudflare+cfTarget:workers",
			"--install",
			"pnpm",
			"--cwd",
			projectName
		]);
		const wranglerJsonEdits: JsonEdit[] = [
			{ path: ["name"], value: projectName },
			{ path: ["compatibility_date"], value: new Date().toISOString().slice(0, 10) },
			{ path: ["compatibility_flags"], value: ["nodejs_compat"] },
			{ path: ["workers_dev"], value: false }
		];
		if (config.boilerplate.saasFs) {
			wranglerJsonEdits.push({
				path: ["d1_databases"],
				value: [
					{
						binding: "DB",
						database_id: "local-main-database",
						database_name: projectName
					},
					{
						binding: "DB_S00",
						database_id: "local-first-shard-database",
						database_name: `${projectName}-s00`
					},
					{
						binding: "DB_S01",
						database_id: "local-second-shard-database",
						database_name: `${projectName}-s01`
					}
				]
			});
		}
		await this.modifyJsonFile("wrangler.jsonc", wranglerJsonEdits, 2, projectName);
		await this.modifyJsonFile(
			"package.json",
			[
				{ path: ["scripts", "build"], value: "vite build" },
				{
					path: ["scripts", "check"],
					value: "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json"
				},
				{ path: ["scripts", "types:cloudflare"], value: "wrangler types" }
			],
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

		if (config.gitProvider.gitHub) {
			await this.writeAlchemyDeployWorkflow(config, projectName);
		}

		await this.executeCommand(
			"pnpm",
			["add", "-D", "@sveltejs/adapter-cloudflare", "alchemy", "wrangler"],
			{
				cwd: projectName
			}
		);
		await this.useAlchemySvelteKitAdapter(projectName);
		await this.generateAlchemyProject(config, projectName);
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
		await this.updateEnvFile(projectName, "PUBLIC_ORIGIN", "http://localhost:5173");
		await this.updateEnvFile(projectName, "PUBLIC_POSTHOG_API_KEY", "");
		await this.copyTemplateFiles("boilerplate/marketing", projectName);
		await fs.rm(join(process.cwd(), projectName, "static", "robots.txt"), { force: true });
		await this.updatePostHogHost(
			join(process.cwd(), projectName, "src", "routes", "+layout.ts"),
			`https://a.${this.domain.hostname}`
		);
		await this.disableRelativeSvelteKitPaths(projectName);
		await this.executeCommand("pnpm", ["add", "-D", "posthog-js"], { cwd: projectName });
	}

	private async addSaasFullStackBoilerplate(config: Config, projectName: string): Promise<void> {
		const saasConfig = config.boilerplate.saasFs;
		if (!saasConfig) return;

		await this.updateEnvFile(projectName, "AUTH_SECRET", crypto.randomBytes(32).toString("hex"));
		await this.updateEnvFile(
			projectName,
			"PUBLIC_STRIPE_PUBLISHABLE_KEY",
			saasConfig.stripePublishableKeyDev
		);
		await this.updateEnvFile(projectName, "STRIPE_SECRET_KEY", saasConfig.stripeSecretKeyDev);
		await this.updateEnvFile(projectName, "STRIPE_WEBHOOK_SECRET", "");
		await this.copyTemplateFiles("boilerplate/saasFs", projectName);
		await this.addAppLocalType(
			join(process.cwd(), projectName, "src", "app.d.ts"),
			"Locals",
			"user",
			"User"
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
					value: "drizzle-kit migrate --config=./src/lib/server/db/config.ts"
				},
				{
					path: ["scripts", "db:migrate:shards"],
					value: "drizzle-kit migrate --config=./src/lib/server/db/shards/config.ts"
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
		const entryDirectory = dirname(fileURLToPath(import.meta.url));
		const sourceTemplateRoot = join(process.cwd(), "templates");
		const distributionTemplateRoot = join(entryDirectory, "templates");
		const templateRoot = (await pathExists(sourceTemplateRoot))
			? sourceTemplateRoot
			: distributionTemplateRoot;
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
			"playwright",
			"prettier",
			"tailwindcss=plugins:typography,forms",
			"vitest=usages:unit,component",
			"--no-git-check",
			"--no-download-check",
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

	private async modifyJsonFile(
		filePath: string,
		edits: JsonEdit[],
		tabSize: number,
		projectName: string
	): Promise<void> {
		const fullPath = join(process.cwd(), projectName, filePath);
		const fileContent = await fs.readFile(fullPath, "utf8");
		const transformJson = transforms.json<Record<string, unknown>>(({ data }) => {
			for (const edit of edits) {
				setJsonPath(data, edit.path, edit.value);
			}
		});
		const indentedContent = normalizeJsonIndent(fileContent, tabSize);
		await fs.writeFile(fullPath, transformJson(indentedContent), "utf8");
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
		console.log("Would run one sv add call for: eslint, playwright, prettier, tailwindcss, vitest");
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
		const transformText = transforms.text(({ content }) =>
			content.replace(searchValue, replacement)
		);
		await fs.writeFile(filePath, transformText(fileData), "utf8");
	}

	private async updatePostHogHost(filePath: string, apiHost: string): Promise<void> {
		const fileData = await fs.readFile(filePath, "utf8");
		const transformScript = transforms.script(({ ast, js }) => {
			let updated = false;

			walkAst(ast, (node) => {
				if (isObjectPropertyNode(node) && node.key.name === "api_host") {
					node.value = js.common.parseExpression(JSON.stringify(apiHost));
					updated = true;
				}
			});

			if (!updated) return false;
		});

		await fs.writeFile(filePath, transformScript(fileData), "utf8");
	}

	private async addAppLocalType(
		filePath: string,
		interfaceName: "Locals",
		propertyName: string,
		typeName: string
	): Promise<void> {
		const fileData = await fs.readFile(filePath, "utf8");
		const transformScript = transforms.script(({ ast, js }) => {
			js.imports.addNamed(ast, {
				from: "$lib/server/auth",
				imports: { [typeName]: typeName },
				isType: true
			});
			const appInterface = js.kit.addGlobalAppInterface(ast, { name: interfaceName });
			const hasProperty = appInterface.body.body.some(
				(member) =>
					member.type === "TSPropertySignature" &&
					member.key.type === "Identifier" &&
					member.key.name === propertyName
			);

			if (!hasProperty) {
				appInterface.body.body.push(js.common.createTypeProperty(propertyName, typeName, true));
			}
		});

		await fs.writeFile(filePath, transformScript(fileData), "utf8");
	}

	private configureTarget(config: Config): void {
		const cloudflareConfig = config.deploymentTarget.cloudflare;
		if (cloudflareConfig) {
			this.domain = new URL(`https://${cloudflareConfig.domain}`);
		}
	}

	private async svelteKitConfigPath(projectName: string): Promise<string> {
		const projectPath = join(process.cwd(), projectName);
		const svelteConfigPath = join(projectPath, "svelte.config.js");
		return (await pathExists(svelteConfigPath))
			? svelteConfigPath
			: join(projectPath, "vite.config.ts");
	}

	private async disableRelativeSvelteKitPaths(projectName: string): Promise<void> {
		const configPath = await this.svelteKitConfigPath(projectName);
		const config = await fs.readFile(configPath, "utf8");
		const transformConfig = transforms.text(({ content }) =>
			content.replace(
				"adapter: adapter()",
				`adapter: adapter(),
			paths: {
				relative: false
			}`
			)
		);
		await fs.writeFile(configPath, transformConfig(config), "utf8");
	}

	private async useAlchemySvelteKitAdapter(projectName: string): Promise<void> {
		const svelteConfigPath = await this.svelteKitConfigPath(projectName);
		const svelteConfig = await fs.readFile(svelteConfigPath, "utf8");
		const transformConfig = transforms.text(({ content }) =>
			content
				.replace(
					/from ['"]@sveltejs\/adapter-(auto|cloudflare)['"];/,
					'from "alchemy/cloudflare/sveltekit";'
				)
				.replace(
					"adapter: adapter()",
					`adapter: adapter({
				platformProxy: {
					configPath: "wrangler.jsonc"
				}
			})`
				)
		);
		await fs.writeFile(svelteConfigPath, transformConfig(svelteConfig), "utf8");
	}

	private async generateAlchemyProject(config: Config, projectName: string): Promise<void> {
		const cloudflareConfig = config.deploymentTarget.cloudflare;
		if (!cloudflareConfig) return;

		const alchemyPath = join(process.cwd(), projectName, "infra", "alchemy");
		await this.copyTemplateFiles("infra/alchemy", projectName);

		await Promise.all([
			fs.writeFile(
				join(process.cwd(), projectName, "alchemy.run.ts"),
				alchemyRunTs(config, projectName),
				"utf8"
			),
			fs.writeFile(join(alchemyPath, "README.md"), alchemyReadme(projectName), "utf8"),
			fs.writeFile(
				join(process.cwd(), projectName, "tsconfig.alchemy.json"),
				alchemyTsConfig(),
				"utf8"
			),
			this.modifyJsonFile(
				"package.json",
				[
					{ path: ["scripts", "dev"], value: "alchemy dev" },
					{ path: ["scripts", "dev:vite"], value: "vite dev" },
					{ path: ["scripts", "infra:check"], value: "tsc --noEmit -p tsconfig.alchemy.json" },
					{ path: ["scripts", "infra:read"], value: "alchemy run --read --stage prod" },
					{ path: ["scripts", "infra:deploy"], value: "alchemy deploy --stage prod" },
					{ path: ["scripts", "infra:destroy"], value: "alchemy destroy" }
				],
				4,
				projectName
			),
			this.replaceInFile(
				join(process.cwd(), projectName, ".gitignore"),
				"node_modules",
				`node_modules

.alchemy`
			)
		]);
	}

	private async writeAlchemyDeployWorkflow(config: Config, projectName: string): Promise<void> {
		const buildStep: WorkflowStep = {
			name: "Build project",
			run: "pnpm run build"
		};

		if (config.boilerplate.marketing) {
			buildStep.env = {
				PUBLIC_ORIGIN: "${{ vars.ORIGIN }}",
				PUBLIC_POSTHOG_API_KEY: "${{ vars.POSTHOG_API_KEY }}"
			};
		}

		if (config.boilerplate.saasFs) {
			buildStep.env = {
				AUTH_SECRET: "${{ secrets.AUTH_SECRET }}",
				PUBLIC_ORIGIN: "${{ vars.ORIGIN }}",
				PUBLIC_POSTHOG_API_KEY: "${{ vars.POSTHOG_API_KEY }}",
				PUBLIC_STRIPE_PUBLISHABLE_KEY: "${{ vars.STRIPE_PUBLISHABLE_KEY }}",
				STRIPE_SECRET_KEY: "${{ secrets.STRIPE_SECRET_KEY }}",
				STRIPE_WEBHOOK_SECRET: "${{ secrets.STRIPE_WEBHOOK_SECRET }}"
			};
		}

		const steps: WorkflowStep[] = [
			{ name: "Checkout", uses: "actions/checkout@v6" },
			{
				name: "Setup pnpm",
				uses: "pnpm/action-setup@v4",
				with: { version: 10 }
			},
			{
				name: "Setup Node.js environment",
				uses: "actions/setup-node@v6",
				with: {
					cache: "pnpm",
					"node-version": 24
				}
			},
			{ name: "Install dependencies", run: "pnpm install" },
			{
				name: "Check Alchemy program",
				run: "pnpm run infra:check"
			},
			buildStep,
			{
				name: "Alchemy read",
				run: "pnpm run infra:read",
				env: {
					ALCHEMY_PASSWORD: "${{ secrets.ALCHEMY_PASSWORD }}"
				}
			},
			{
				name: "Alchemy deploy",
				run: "pnpm run infra:deploy",
				env: {
					ALCHEMY_PASSWORD: "${{ secrets.ALCHEMY_PASSWORD }}"
				}
			}
		];

		const workflow = {
			name: "Deploy with Alchemy",
			on: { push: { branches: ["main"] } },
			jobs: {
				"preview-provision-and-deploy": {
					environment: "Production",
					name: "Preview, Provision, and Deploy",
					"runs-on": "ubuntu-latest",
					steps
				}
			}
		};
		const yamlString = stringify(workflow, { lineWidth: -1 });
		const gitHubWorkflowsPath = join(process.cwd(), projectName, ".github", "workflows");
		await fs.mkdir(gitHubWorkflowsPath, { recursive: true });
		await fs.writeFile(join(gitHubWorkflowsPath, "deploy-with-alchemy.yml"), yamlString, "utf8");
	}

	private async updateEnvFile(repositoryName: string, key: string, value: string): Promise<void> {
		const envPath = join(process.cwd(), repositoryName, ".env");
		let envContent = "";

		try {
			envContent = await fs.readFile(envPath, "utf8");
		} catch {}

		if (envContent.includes(`${key}=`)) {
			const transformEnv = transforms.text(({ content }) =>
				content
					.split(/\r?\n/)
					.map((line) => {
						const [currentKey] = line.split("=");
						return currentKey === key ? `${key}=${value}` : line;
					})
					.join("\n")
			);
			envContent = transformEnv(envContent);
		} else {
			const transformEnv = transforms.text(({ content, text }) =>
				text.upsert(content, key, { value })
			);
			envContent = transformEnv(envContent);
		}

		await fs.writeFile(envPath, envContent, "utf8");
	}
}

function alchemyTsConfig(): string {
	return `${JSON.stringify(
		{
			compilerOptions: {
				strict: true,
				target: "ES2022",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				esModuleInterop: true,
				skipLibCheck: true,
				forceConsistentCasingInFileNames: true
			},
			include: ["alchemy.run.ts", "infra/alchemy/**/*.ts"]
		},
		null,
		2
	)}
`;
}

function alchemyReadme(projectName: string): string {
	return `# ${projectName} infrastructure

Alchemy owns durable infrastructure for this Danku project:

- Cloudflare zone, DNS records, SvelteKit Worker deployment, and D1 databases
- GitHub repository, Actions variables, Actions secrets, and production environment secrets
- PostHog project and feature flag through a generated custom Alchemy resource
- Creem product through a generated custom Alchemy resource

## First run

\`\`\`sh
pnpm install
export ALCHEMY_PASSWORD=<state-secret-password>
export CLOUDFLARE_ACCOUNT_ID=<cloudflare-account-id>
export CLOUDFLARE_API_TOKEN=<cloudflare-api-token>
export GITHUB_OWNER=<github-owner>
export GITHUB_TOKEN=<github-token>
export POSTHOG_API_KEY=<posthog-personal-api-key>
export POSTHOG_ORGANIZATION_ID=<posthog-org-id>
export CREEM_API_KEY=...
pnpm run infra:read
pnpm run infra:deploy
\`\`\`

Use \`pnpm run dev\` to run \`alchemy dev\` with Miniflare-backed local Cloudflare bindings.
Cloudflare zone creation outputs assigned nameservers. Point the domain at those nameservers at your registrar before relying on DNS routing.
`;
}

function alchemyRunTs(config: Config, projectName: string): string {
	const cloudflareConfig = config.deploymentTarget.cloudflare;
	if (!cloudflareConfig) return "";

	const hasGitHub = config.gitProvider.gitHub !== undefined;
	const hasPostHog =
		config.boilerplate.marketing !== undefined || config.boilerplate.saasFs !== undefined;
	const hasSaas = config.boilerplate.saasFs !== undefined;
	const postHogOrganizationId =
		config.boilerplate.marketing?.postHogOrganizationId ??
		config.boilerplate.saasFs?.postHogOrganizationId ??
		"REPLACE_WITH_POSTHOG_ORGANIZATION_ID";
	const stripePublishableKey = config.boilerplate.saasFs?.stripePublishableKey ?? "";

	const extraImports = [
		hasGitHub
			? 'import { GitHubSecret, RepositoryEnvironment } from "alchemy/github";\nimport { GitHubActionsVariable, GitHubRepository } from "./infra/alchemy/resources/github.js";'
			: "",
		hasPostHog
			? 'import { PostHogFeatureFlag, PostHogProject } from "./infra/alchemy/resources/posthog.js";'
			: "",
		hasSaas ? 'import { CreemProduct } from "./infra/alchemy/resources/creem.js";' : ""
	]
		.filter(Boolean)
		.join("\n");

	const d1Resources = hasSaas
		? `
const mainDatabase = await D1Database("main-database", {
	...cloudflare,
	adopt: true,
	name: resourceName(appName)
});
const firstShardDatabase = await D1Database("first-shard-database", {
	...cloudflare,
	adopt: true,
	name: resourceName(\`\${appName}-s00\`)
});
const secondShardDatabase = await D1Database("second-shard-database", {
	...cloudflare,
	adopt: true,
	name: resourceName(\`\${appName}-s01\`)
});
`
		: "";

	const d1Bindings = hasSaas
		? `
	DB: mainDatabase,
	DB_S00: firstShardDatabase,
	DB_S01: secondShardDatabase`
		: "";

	const buildEnv = [
		"PUBLIC_ORIGIN: origin",
		hasPostHog ? 'PUBLIC_POSTHOG_API_KEY: posthogProjectApiToken ?? ""' : "",
		hasSaas
			? `PUBLIC_STRIPE_PUBLISHABLE_KEY: env("STRIPE_PUBLISHABLE_KEY", "DANKU_STRIPE_PUBLISHABLE_KEY", "${stripePublishableKey}")`
			: ""
	]
		.filter(Boolean)
		.join(",\n\t");

	const githubResources = hasGitHub
		? `
if (provisionExternalServices) {
	const githubOwner = requiredEnv("GITHUB_OWNER", "DANKU_GITHUB_OWNER");
	const githubToken = secretEnv("GITHUB_TOKEN", "DANKU_GITHUB_TOKEN");
	process.env.GITHUB_TOKEN ??= process.env.DANKU_GITHUB_TOKEN;

	const repository = await GitHubRepository("repository", {
		adopt: true,
		autoInit: false,
		delete: false,
		hasIssues: true,
		hasProjects: true,
		hasWiki: false,
		name: "${projectName}",
		owner: githubOwner,
		token: githubToken,
		visibility: "private"
	});

	await RepositoryEnvironment("production-environment", {
		name: "Production",
		owner: githubOwner,
		repository: repository.name
	});

	await Promise.all([
		GitHubSecret("cloudflare-api-token", {
			owner: githubOwner,
			repository: repository.name,
			name: "CLOUDFLARE_API_TOKEN",
			value: cloudflareApiToken,
			token: githubToken
		}),
		GitHubSecret("production-cloudflare-api-token", {
			owner: githubOwner,
			repository: repository.name,
			environment: "Production",
			name: "CLOUDFLARE_API_TOKEN",
			value: cloudflareApiToken,
			token: githubToken
		}),
		GitHubActionsVariable("cloudflare-account-id", {
			owner: githubOwner,
			repository: repository.name,
			name: "CLOUDFLARE_ACCOUNT_ID",
			value: cloudflareAccountId,
			token: githubToken
		}),
		GitHubActionsVariable("origin", {
			owner: githubOwner,
			repository: repository.name,
			environment: "Production",
			name: "ORIGIN",
			value: origin,
			token: githubToken
		})${
			hasPostHog
				? `,
		GitHubActionsVariable("posthog-api-key", {
			owner: githubOwner,
			repository: repository.name,
			environment: "Production",
			name: "POSTHOG_API_KEY",
			value: posthogProjectApiToken ?? "",
			token: githubToken
		})`
				: ""
		}${
			hasSaas
				? `,
		GitHubActionsVariable("stripe-publishable-key", {
			owner: githubOwner,
			repository: repository.name,
			environment: "Production",
			name: "STRIPE_PUBLISHABLE_KEY",
			value: env("STRIPE_PUBLISHABLE_KEY", "DANKU_STRIPE_PUBLISHABLE_KEY", "${stripePublishableKey}"),
			token: githubToken
		}),
		GitHubSecret("auth-secret", {
			owner: githubOwner,
			repository: repository.name,
			environment: "Production",
			name: "AUTH_SECRET",
			value: secretEnv("AUTH_SECRET", "DANKU_AUTH_SECRET"),
			token: githubToken
		}),
		GitHubSecret("stripe-secret-key", {
			owner: githubOwner,
			repository: repository.name,
			environment: "Production",
			name: "STRIPE_SECRET_KEY",
			value: secretEnv("STRIPE_SECRET_KEY", "DANKU_STRIPE_SECRET_KEY"),
			token: githubToken
		}),
		GitHubSecret("stripe-webhook-secret", {
			owner: githubOwner,
			repository: repository.name,
			environment: "Production",
			name: "STRIPE_WEBHOOK_SECRET",
			value: secretEnv("STRIPE_WEBHOOK_SECRET", "DANKU_STRIPE_WEBHOOK_SECRET"),
			token: githubToken
		})`
				: ""
		}
	]);

	console.log({
		repositoryCloneUrl: repository.cloneUrl,
		repositoryName: repository.name
	});
}
`
		: "";

	const posthogResources = hasPostHog
		? `
let posthogProjectApiToken: string | undefined;
let posthogProjectId: string | undefined;

if (provisionExternalServices) {
	const posthogProject = await PostHogProject("posthog-project", {
		apiKey: secretEnv("POSTHOG_API_KEY", "DANKU_POSTHOG_PERSONAL_API_KEY"),
		host: env("POSTHOG_HOST", "DANKU_POSTHOG_HOST", "https://us.posthog.com"),
		name: resourceName(appName),
		organizationId: env("POSTHOG_ORGANIZATION_ID", "DANKU_POSTHOG_ORGANIZATION_ID", "${postHogOrganizationId}"),
		timezone: "UTC"
	});

	await PostHogFeatureFlag("new-onboarding", {
		active: false,
		apiKey: secretEnv("POSTHOG_API_KEY", "DANKU_POSTHOG_PERSONAL_API_KEY"),
		host: env("POSTHOG_HOST", "DANKU_POSTHOG_HOST", "https://us.posthog.com"),
		key: "new-onboarding",
		name: "New onboarding",
		projectId: posthogProject.projectId,
		rolloutPercentage: 0
	});

	posthogProjectApiToken = posthogProject.apiToken;
	posthogProjectId = posthogProject.projectId;
}
`
		: `const posthogProjectApiToken = undefined;
const posthogProjectId = undefined;
`;

	const creemResources = hasSaas
		? `
let creemProMonthlyProductId: string | undefined;

if (provisionExternalServices) {
	const proMonthly = await CreemProduct("pro-monthly-product", {
		apiKey: secretEnv("CREEM_API_KEY", "DANKU_CREEM_API_KEY"),
		billingPeriod: "monthly",
		billingType: "recurring",
		currency: "USD",
		name: "${projectName} Pro Monthly",
		price: 1900,
		testMode: app.stage !== "prod"
	});

	creemProMonthlyProductId = proMonthly.productId;
}
`
		: "const creemProMonthlyProductId = undefined;\n";

	return `import alchemy from "alchemy";
import { D1Database, DnsRecords, SvelteKit, Zone } from "alchemy/cloudflare";
${extraImports}

const app = await alchemy("${projectName}", {
	password: process.env.ALCHEMY_PASSWORD ?? process.env.PASSWORD
});

const appName = env("DANKU_APP_NAME", undefined, "${projectName}");
const cloudflareAccountId = env("CLOUDFLARE_ACCOUNT_ID", "DANKU_CLOUDFLARE_ACCOUNT_ID", "${cloudflareConfig.accountId}");
const cloudflareApiToken = secretEnv("CLOUDFLARE_API_TOKEN", "DANKU_CLOUDFLARE_API_TOKEN");
const cloudflare = {
	accountId: cloudflareAccountId,
	apiToken: cloudflareApiToken
};
const domain = env("DOMAIN", "DANKU_DOMAIN", "${cloudflareConfig.domain}");
const origin = \`https://\${domain}\`;
const provisionExternalServices = !app.local;

const zone = await Zone("zone", {
	...cloudflare,
	delete: false,
	jumpStart: true,
	name: domain,
	type: "full"
});
${d1Resources}
await DnsRecords("posthog-ingestion-records", {
	...cloudflare,
	delete: false,
	records: [{
		content: "us.i.posthog.com",
		name: \`a.\${domain}\`,
		proxied: true,
		ttl: 1,
		type: "CNAME"
	}],
	zoneId: zone.id
});
${posthogResources}${creemResources}
const website = await SvelteKit("website", {
	...cloudflare,
	adopt: true,
	bindings: {${d1Bindings}
	},
	build: {
		command: "pnpm run build",
		env: {
			${buildEnv}
		},
		memoize: process.env.CI ? false : {
			patterns: ["src/**", "static/**", "svelte.config.js", "vite.config.ts", "package.json", "pnpm-lock.yaml"]
		}
	},
	compatibility: "node",
	compatibilityDate: "${new Date().toISOString().slice(0, 10)}",
	domains: [{
		adopt: true,
		domainName: domain,
		zoneId: zone.id
	}],
	name: resourceName(appName),
	observability: { enabled: true },
	routes: [{
		adopt: true,
		pattern: \`\${domain}/*\`,
		zoneId: zone.id
	}],
	url: true
});
${githubResources}
console.log({
	cloudflareZoneId: zone.id,
	cloudflareZoneNameServers: zone.nameservers,
	creemProMonthlyProductId,
	environment: app.stage,
	mainDatabaseId: ${hasSaas ? "mainDatabase.id" : "undefined"},
	firstShardDatabaseId: ${hasSaas ? "firstShardDatabase.id" : "undefined"},
	posthogProjectApiToken,
	posthogProjectId,
	secondShardDatabaseId: ${hasSaas ? "secondShardDatabase.id" : "undefined"},
	workerName: website.name,
	workerUrl: website.url ?? origin
});

await app.finalize();

function env(name: string, fallbackName?: string, defaultValue?: string): string {
	const value = process.env[name] ?? (fallbackName ? process.env[fallbackName] : undefined) ?? defaultValue;
	if (!value || value.startsWith("REPLACE_WITH_")) {
		throw new Error(\`Missing \${fallbackName ? \`\${name} or \${fallbackName}\` : name}\`);
	}
	return value;
}

function requiredEnv(name: string, fallbackName?: string): string {
	return env(name, fallbackName);
}

function secretEnv(name: string, fallbackName?: string) {
	return alchemy.secret.env(
		name,
		process.env[name] ?? (fallbackName ? process.env[fallbackName] : undefined),
		\`Missing \${fallbackName ? \`\${name} or \${fallbackName}\` : name}\`
	);
}

function resourceName(name: string): string {
	return app.stage === "prod" ? name : \`\${name}-\${app.stage}\`;
}
`;
}

function walkAst(node: AstTypes.BaseNode, visit: (node: AstTypes.BaseNode) => void): void {
	visit(node);

	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const child of value) {
				if (isAstNode(child)) walkAst(child, visit);
			}
		} else if (isAstNode(value)) {
			walkAst(value, visit);
		}
	}
}

function isAstNode(value: unknown): value is AstTypes.BaseNode {
	return typeof value === "object" && value !== null && "type" in value;
}

function isObjectPropertyNode(node: AstTypes.BaseNode): node is ObjectPropertyNode {
	return node.type === "Property" && "key" in node && "value" in node;
}

function normalizeJsonIndent(content: string, tabSize: number): string {
	if (tabSize === 0) return content;
	const parsedJson = JSON.parse(content) as unknown;
	return `${JSON.stringify(parsedJson, null, tabSize)}\n`;
}

function setJsonPath(root: Record<string, unknown>, path: JsonPath, value: JsonValue): void {
	let current: Record<string, unknown> | unknown[] = root;

	for (const [index, segment] of path.entries()) {
		const isLast = index === path.length - 1;

		if (isLast) {
			setJsonContainerValue(current, segment, value);
			return;
		}

		const nextSegment = path[index + 1];
		let nextValue: unknown = getJsonContainerValue(current, segment);

		if (nextValue === undefined) {
			nextValue = typeof nextSegment === "number" ? [] : {};
			setJsonContainerValue(current, segment, nextValue);
		}

		if (!isJsonContainer(nextValue)) {
			throw new GenerationError(`Cannot set JSON path ${path.join(".")}`);
		}

		current = nextValue;
	}
}

function getJsonContainerValue(
	container: Record<string, unknown> | unknown[],
	key: number | string
): unknown {
	if (Array.isArray(container)) {
		return typeof key === "number" ? container[key] : undefined;
	}

	return container[String(key)];
}

function setJsonContainerValue(
	container: Record<string, unknown> | unknown[],
	key: number | string,
	value: unknown
): void {
	if (Array.isArray(container) && typeof key === "number") {
		container[key] = value;
		return;
	}

	if (!Array.isArray(container)) {
		container[String(key)] = value;
	}
}

function isJsonContainer(value: unknown): value is Record<string, unknown> | unknown[] {
	return typeof value === "object" && value !== null;
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
