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

type JsonValue = boolean | null | number | Record<string, unknown> | string | string[];

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
		await this.modifyJsonFile(
			"wrangler.jsonc",
			[
				{ path: ["name"], value: projectName },
				{ path: ["compatibility_date"], value: new Date().toISOString().slice(0, 10) },
				{ path: ["compatibility_flags"], value: ["nodejs_compat"] },
				{ path: ["workers_dev"], value: false }
			],
			2,
			projectName
		);
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
			await this.writePulumiDeployWorkflow(config, projectName);
		}

		await this.executeCommand("pnpm", ["add", "-D", "wrangler"], { cwd: projectName });
		await this.generatePulumiProject(config, projectName);
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

	private async generatePulumiProject(config: Config, projectName: string): Promise<void> {
		const cloudflareConfig = config.deploymentTarget.cloudflare;
		if (!cloudflareConfig) return;

		const pulumiPath = join(process.cwd(), projectName, "infra", "pulumi");
		const sourcePath = join(pulumiPath, "src");
		await fs.mkdir(sourcePath, { recursive: true });

		await Promise.all([
			fs.writeFile(
				join(pulumiPath, "Pulumi.yaml"),
				`name: ${projectName}
description: Pulumi-managed Danku infrastructure
runtime:
  name: nodejs
  options:
    packagemanager: pnpm
config:
  pulumi:tags:
    value:
      pulumi:template: typescript
`,
				"utf8"
			),
			fs.writeFile(join(pulumiPath, "package.json"), pulumiPackageJson(projectName), "utf8"),
			fs.writeFile(join(pulumiPath, "tsconfig.json"), pulumiTsConfig(), "utf8"),
			fs.writeFile(join(pulumiPath, "README.md"), pulumiReadme(projectName), "utf8"),
			fs.writeFile(join(sourcePath, "config.ts"), pulumiConfigTs(), "utf8"),
			fs.writeFile(join(sourcePath, "cloudflare.ts"), pulumiCloudflareTs(config), "utf8"),
			fs.writeFile(join(sourcePath, "github.ts"), pulumiGithubTs(config, projectName), "utf8"),
			fs.writeFile(join(sourcePath, "posthog.ts"), pulumiPostHogTs(config, projectName), "utf8"),
			fs.writeFile(join(sourcePath, "creem.ts"), pulumiCreemTs(projectName), "utf8"),
			fs.writeFile(join(sourcePath, "index.ts"), pulumiIndexTs(config), "utf8")
		]);
	}

	private async writePulumiDeployWorkflow(config: Config, projectName: string): Promise<void> {
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
				name: "Install Pulumi dependencies",
				run: "pnpm install",
				"working-directory": "infra/pulumi"
			},
			{
				name: "Pulumi preview",
				run: "pnpm --dir infra/pulumi exec pulumi preview --stack prod --non-interactive",
				env: {
					PULUMI_ACCESS_TOKEN: "${{ secrets.PULUMI_ACCESS_TOKEN }}"
				}
			},
			{
				name: "Pulumi up",
				run: "pnpm --dir infra/pulumi exec pulumi up --stack prod --yes --non-interactive",
				env: {
					PULUMI_ACCESS_TOKEN: "${{ secrets.PULUMI_ACCESS_TOKEN }}"
				}
			},
			{ name: "Build project", run: "pnpm run build" }
		];

		if (config.boilerplate.marketing) {
			steps[7] = {
				env: {
					PUBLIC_ORIGIN: "${{ vars.ORIGIN }}",
					PUBLIC_POSTHOG_API_KEY: "${{ vars.POSTHOG_API_KEY }}"
				},
				name: "Build project",
				run: "pnpm run build"
			};
		}

		if (config.boilerplate.saasFs) {
			steps[7] = {
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
		}

		const workflow = {
			name: "Deploy with Pulumi",
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
		await fs.writeFile(join(gitHubWorkflowsPath, "deploy-with-pulumi.yml"), yamlString, "utf8");
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

function pulumiPackageJson(projectName: string): string {
	return `${JSON.stringify(
		{
			name: `${projectName}-infra`,
			private: true,
			type: "module",
			scripts: {
				preview: "pulumi preview",
				up: "pulumi up",
				check: "tsc --noEmit"
			},
			dependencies: {
				"@pulumi/cloudflare": "^6.15.0",
				"@pulumi/github": "^6.13.1",
				"@pulumi/pulumi": "^3.207.0",
				"pulumi-posthog": "^1.0.6"
			},
			devDependencies: {
				"@types/node": "^24.12.0",
				typescript: "^5.9.3"
			}
		},
		null,
		2
	)}
`;
}

function pulumiTsConfig(): string {
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
			include: ["src/**/*.ts"]
		},
		null,
		2
	)}
`;
}

function pulumiReadme(projectName: string): string {
	return `# ${projectName} infrastructure

Pulumi owns durable infrastructure for this Danku project:

- Cloudflare zone, DNS, Worker routing, and D1 databases
- GitHub repository, Actions variables, Actions secrets, and production environment secrets
- PostHog projects via the Terraform-bridged \`pulumi-posthog\` provider
- Creem products via a Pulumi dynamic provider skeleton

## First run

\`\`\`sh
cd infra/pulumi
pnpm install
pulumi stack init dev
pulumi config set danku:appName ${projectName}
pulumi config set danku:cloudflareAccountId <cloudflare-account-id>
pulumi config set danku:domain ${projectName}.example.com
pulumi config set danku:githubOwner <github-owner>
pulumi config set danku:posthogOrganizationId <posthog-org-id>
pulumi config set cloudflare:apiToken --secret
pulumi config set github:token --secret
pulumi config set posthog:apiKey --secret
export CREEM_API_KEY=...
pulumi preview
pulumi up
\`\`\`

Cloudflare zone creation outputs assigned nameservers. Point the domain at those nameservers at your registrar before relying on DNS routing.
`;
}

function pulumiConfigTs(): string {
	return `import * as pulumi from "@pulumi/pulumi";

const danku = new pulumi.Config("danku");
const cloudflare = new pulumi.Config("cloudflare");
const github = new pulumi.Config("github");
const posthog = new pulumi.Config("posthog");

export const appName = danku.get("appName") ?? pulumi.getProject();
export const cloudflareAccountId = danku.get("cloudflareAccountId") ?? "REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID";
export const cloudflareApiToken = cloudflare.requireSecret("apiToken");
export const domain = danku.get("domain") ?? "REPLACE_WITH_DOMAIN";
export const githubOwner = danku.get("githubOwner");
export const githubToken = github.getSecret("token");
export const posthogApiKey = posthog.getSecret("apiKey");
export const posthogHost = posthog.get("host") ?? "https://us.posthog.com";
export const posthogOrganizationId = danku.get("posthogOrganizationId") ?? "REPLACE_WITH_POSTHOG_ORGANIZATION_ID";
export const stack = pulumi.getStack();
`;
}

function pulumiCloudflareTs(config: Config): string {
	const d1Resources = config.boilerplate.saasFs
		? `
const mainDatabase = new cloudflare.D1Database("main-database", {
	accountId: cloudflareAccountId,
	name: appName
});
const firstShardDatabase = new cloudflare.D1Database("first-shard-database", {
	accountId: cloudflareAccountId,
	name: \`\${appName}-s00\`
});
const secondShardDatabase = new cloudflare.D1Database("second-shard-database", {
	accountId: cloudflareAccountId,
	name: \`\${appName}-s01\`
});
`
		: "";

	const d1Bindings = config.boilerplate.saasFs
		? `,
	{
		name: "DB",
		type: "d1",
		id: mainDatabase.uuid
	},
	{
		name: "DB_S00",
		type: "d1",
		id: firstShardDatabase.uuid
	},
	{
		name: "DB_S01",
		type: "d1",
		id: secondShardDatabase.uuid
	}`
		: "";

	return `import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

import {
	appName,
	cloudflareAccountId,
	cloudflareApiToken,
	domain,
	stack
} from "./config.js";

const provider = new cloudflare.Provider("cloudflare-provider", {
	apiToken: cloudflareApiToken
});

const zone = new cloudflare.Zone("zone", {
	account: { id: cloudflareAccountId },
	name: domain,
	type: "full"
}, { provider });

const worker = new cloudflare.Worker("worker", {
	accountId: cloudflareAccountId,
	name: appName,
	observability: { enabled: true }
}, { provider });
${d1Resources}
const workerVersion = new cloudflare.WorkerVersion("worker-version", {
	accountId: cloudflareAccountId,
	workerId: worker.id,
	assets: {
		directory: "../../.svelte-kit/cloudflare",
		config: {
			htmlHandling: "auto-trailing-slash",
			notFoundHandling: "single-page-application",
			runWorkerFirst: true
		}
	},
	bindings: [{
		name: "ASSETS",
		type: "assets"
	}${d1Bindings}],
	compatibilityDate: "${new Date().toISOString().slice(0, 10)}",
	compatibilityFlags: ["nodejs_compat"],
	mainModule: "_worker.js",
	modules: [{
		contentFile: "../../.svelte-kit/cloudflare/_worker.js",
		contentType: "application/javascript+module",
		name: "_worker.js"
	}]
}, { provider });

new cloudflare.WorkersDeployment("worker-deployment", {
	accountId: cloudflareAccountId,
	scriptName: worker.name,
	strategy: "percentage",
	versions: [{
		percentage: 100,
		versionId: workerVersion.id
	}]
}, { provider });

new cloudflare.WorkersRoute("apex-worker-route", {
	zoneId: zone.id,
	pattern: domain,
	script: worker.name
}, { provider });

new cloudflare.WorkersCustomDomain("apex-worker-domain", {
	accountId: cloudflareAccountId,
	hostname: domain,
	service: worker.name,
	zoneId: zone.id
}, { provider });

new cloudflare.DnsRecord("posthog-ingestion-cname", {
	zoneId: zone.id,
	name: \`a.\${domain}\`,
	type: "CNAME",
	content: "us.i.posthog.com",
	proxied: true,
	ttl: 1
}, { provider });

export const cloudflareZoneId = zone.id;
export const cloudflareZoneNameServers = zone.nameServers;
export const workerName = worker.name;
export const workerUrl = pulumi.interpolate\`https://\${domain}\`;
${
	config.boilerplate.saasFs
		? `export const mainDatabaseId = mainDatabase.uuid;
export const firstShardDatabaseId = firstShardDatabase.uuid;
export const secondShardDatabaseId = secondShardDatabase.uuid;`
		: `export const mainDatabaseId = undefined;
export const firstShardDatabaseId = undefined;
export const secondShardDatabaseId = undefined;`
}
export const environment = stack;
`;
}

function pulumiGithubTs(config: Config, projectName: string): string {
	if (!config.gitProvider.gitHub) {
		return `export const repositoryName = undefined;
`;
	}

	const envSecrets: Array<[string, string]> = [["CLOUDFLARE_API_TOKEN", "cloudflareApiToken"]];
	const envVariables: Array<[string, string]> = [["ORIGIN", "domain"]];

	if (config.boilerplate.saasFs) {
		envSecrets.push(
			["AUTH_SECRET", 'danku.requireSecret("authSecret")'],
			["STRIPE_SECRET_KEY", 'danku.requireSecret("stripeSecretKey")'],
			["STRIPE_WEBHOOK_SECRET", 'danku.requireSecret("stripeWebhookSecret")']
		);
		envVariables.push(["STRIPE_PUBLISHABLE_KEY", 'danku.require("stripePublishableKey")']);
	}

	if (config.boilerplate.marketing || config.boilerplate.saasFs) {
		envVariables.push(["POSTHOG_API_KEY", "posthogProjectApiToken"]);
	}

	return `import * as github from "@pulumi/github";
import * as pulumi from "@pulumi/pulumi";

import { cloudflareApiToken, domain, githubOwner, githubToken } from "./config.js";
import { posthogProjectApiToken } from "./posthog.js";

const danku = new pulumi.Config("danku");

const provider = new github.Provider("github-provider", {
	owner: githubOwner,
	token: githubToken
});

const repository = new github.Repository("repository", {
	name: "${projectName}",
	visibility: "private",
	hasIssues: true,
	hasProjects: true,
	hasWiki: false,
	autoInit: false
}, { provider });

new github.RepositoryEnvironment("production-environment", {
	repository: repository.name,
	environment: "Production"
}, { provider });

${envSecrets
	.map(
		([
			name,
			value
		]) => `new github.ActionsEnvironmentSecret("${name.toLowerCase().replaceAll("_", "-")}", {
	repository: repository.name,
	environment: "Production",
	secretName: "${name}",
	value: ${value}
}, { provider });`
	)
	.join("\n\n")}

${envVariables
	.map(
		([
			name,
			value
		]) => `new github.ActionsEnvironmentVariable("${name.toLowerCase().replaceAll("_", "-")}", {
	repository: repository.name,
	environment: "Production",
	variableName: "${name}",
	value: ${value}
}, { provider });`
	)
	.join("\n\n")}

new github.ActionsVariable("cloudflare-account-id", {
	repository: repository.name,
	variableName: "CLOUDFLARE_ACCOUNT_ID",
	value: danku.get("cloudflareAccountId") ?? "REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID"
}, { provider });

new github.ActionsSecret("cloudflare-api-token", {
	repository: repository.name,
	secretName: "CLOUDFLARE_API_TOKEN",
	value: cloudflareApiToken
}, { provider });

export const repositoryName = repository.name;
export const repositoryCloneUrl = repository.httpCloneUrl;
`;
}

function pulumiPostHogTs(config: Config, projectName: string): string {
	if (!config.boilerplate.marketing && !config.boilerplate.saasFs) {
		return `export const posthogProjectApiToken = undefined;
export const posthogProjectId = undefined;
`;
	}

	return `import * as posthog from "pulumi-posthog";

import { posthogApiKey, posthogHost, posthogOrganizationId, stack } from "./config.js";

const provider = new posthog.Provider("posthog-provider", {
	apiKey: posthogApiKey,
	host: posthogHost,
	organizationId: posthogOrganizationId
});

const project = new posthog.Project("posthog-project", {
	name: "${projectName}-\${stack}",
	organizationId: posthogOrganizationId,
	timezone: "UTC"
}, { provider });

new posthog.FeatureFlag("new-onboarding", {
	key: "new-onboarding",
	name: "New onboarding",
	active: false,
	projectId: project.projectId.apply(String),
	rolloutPercentage: 0
}, { provider });

export const posthogProjectApiToken = project.apiToken;
export const posthogProjectId = project.projectId;
`;
}

function pulumiCreemTs(projectName: string): string {
	return `import * as pulumi from "@pulumi/pulumi";

import { stack } from "./config.js";

type CreemProductInputs = {
	name: string;
	price: number;
	currency: string;
	billingType: "recurring" | "one_time";
	billingPeriod?: "monthly" | "yearly";
	testMode?: boolean;
};

class CreemProductProvider implements pulumi.dynamic.ResourceProvider {
	async create(inputs: CreemProductInputs) {
		const apiKey = process.env.CREEM_API_KEY;
		if (!apiKey) {
			throw new Error("Missing CREEM_API_KEY environment variable");
		}

		const response = await fetch(creemBaseUrl(inputs.testMode), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey
			},
			body: JSON.stringify({
				name: inputs.name,
				price: inputs.price,
				currency: inputs.currency,
				billing_type: inputs.billingType,
				billing_period: inputs.billingPeriod
			})
		});

		if (!response.ok) {
			throw new Error(\`Creem product create failed: \${response.status} \${await response.text()}\`);
		}

		const product = await response.json() as { id: string };
		return { id: product.id, outs: { ...inputs, id: product.id } };
	}
}

class CreemProduct extends pulumi.dynamic.Resource {
	declare id: pulumi.Output<string>;

	constructor(name: string, args: CreemProductInputs, opts?: pulumi.CustomResourceOptions) {
		super(new CreemProductProvider(), name, args, opts);
	}
}

function creemBaseUrl(testMode = stack !== "prod") {
	return testMode ? "https://test-api.creem.io/v1/products" : "https://api.creem.io/v1/products";
}

const proMonthly = new CreemProduct("pro-monthly-product", {
	name: "${projectName} Pro Monthly",
	price: 1900,
	currency: "USD",
	billingType: "recurring",
	billingPeriod: "monthly"
});

export const creemProMonthlyProductId = proMonthly.id;
`;
}

function pulumiIndexTs(config: Config): string {
	const githubExport = config.gitProvider.gitHub
		? 'export { repositoryCloneUrl, repositoryName } from "./github.js";\n'
		: "";
	const postHogExport =
		config.boilerplate.marketing || config.boilerplate.saasFs
			? 'export { posthogProjectApiToken, posthogProjectId } from "./posthog.js";\n'
			: "";
	const creemExport = config.boilerplate.saasFs
		? 'export { creemProMonthlyProductId } from "./creem.js";\n'
		: "";

	return `export {
	cloudflareZoneId,
	cloudflareZoneNameServers,
	firstShardDatabaseId,
	mainDatabaseId,
	secondShardDatabaseId,
	workerName,
	workerUrl
} from "./cloudflare.js";
${githubExport}${postHogExport}${creemExport}`;
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
