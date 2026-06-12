import { Resource, Secret, type Context } from "alchemy";

type JsonObject = Record<string, unknown>;

export type GitHubRepositoryProps = {
	adopt?: boolean;
	autoInit?: boolean;
	delete?: boolean;
	description?: string;
	hasIssues?: boolean;
	hasProjects?: boolean;
	hasWiki?: boolean;
	name: string;
	owner: string;
	token: Secret | string;
	visibility?: "internal" | "private" | "public";
};

export type GitHubRepository = GitHubRepositoryProps & {
	cloneUrl: string;
	fullName: string;
	htmlUrl: string;
	id: string;
	nodeId: string;
};

export const GitHubRepository = Resource(
	"danku::GitHubRepository",
	async function(
		this: Context<GitHubRepository, GitHubRepositoryProps>,
		_id: string,
		props: GitHubRepositoryProps
	): Promise<GitHubRepository> {
		const token = unwrapToken(props.token);

		if (this.phase === "delete") {
			if (props.delete) {
				await githubRequest<void>(
					token,
					`/repos/${encodePath(props.owner)}/${encodePath(this.output.name)}`,
					{ method: "DELETE" },
					[204, 404]
				);
			}
			return this.destroy();
		}

		const existing =
			this.phase === "create"
				? await getRepository(token, props.owner, props.name)
				: await getRepository(token, props.owner, this.output.name);
		if (this.phase === "create" && existing && !props.adopt) {
			throw new Error(`GitHub repository ${props.owner}/${props.name} already exists`);
		}

		const repository = existing
			? await updateRepository(token, props.owner, existing.name, props)
			: await createRepository(token, props);

		return toRepository(props, repository);
	}
);

export type GitHubActionsVariableProps = {
	environment?: string;
	name: string;
	owner: string;
	repository: string;
	token: Secret | string;
	value: string;
};

export type GitHubActionsVariable = GitHubActionsVariableProps & {
	id: string;
	updatedAt: string;
};

export const GitHubActionsVariable = Resource(
	"danku::GitHubActionsVariable",
	async function(
		this: Context<GitHubActionsVariable, GitHubActionsVariableProps>,
		_id: string,
		props: GitHubActionsVariableProps
	): Promise<GitHubActionsVariable> {
		const token = unwrapToken(props.token);
		const endpoint = await variableEndpoint(token, props);

		if (this.phase === "delete") {
			await githubRequest<void>(token, `${endpoint}/${encodePath(this.output.name)}`, { method: "DELETE" }, [
				204,
				404
			]);
			return this.destroy();
		}

		const existing = await githubRequest<JsonObject>(
			token,
			`${endpoint}/${encodePath(props.name)}`,
			{ method: "GET" },
			[200, 404]
		);
		if (existing) {
			await githubRequest<void>(
				token,
				`${endpoint}/${encodePath(props.name)}`,
				{
					body: JSON.stringify({ name: props.name, value: props.value }),
					method: "PATCH"
				},
				[204]
			);
		} else {
			await githubRequest<void>(
				token,
				endpoint,
				{
					body: JSON.stringify({ name: props.name, value: props.value }),
					method: "POST"
				},
				[201]
			);
		}

		return {
			...props,
			id: props.environment
				? `${props.owner}/${props.repository}/environments/${props.environment}/variables/${props.name}`
				: `${props.owner}/${props.repository}/variables/${props.name}`,
			updatedAt: new Date().toISOString()
		};
	}
);

type GitHubRepositoryResponse = {
	clone_url: string;
	full_name: string;
	html_url: string;
	id: number;
	name: string;
	node_id: string;
};

async function createRepository(
	token: string,
	props: GitHubRepositoryProps
): Promise<GitHubRepositoryResponse> {
	const viewer = await githubRequest<{ login: string }>(token, "/user", { method: "GET" });
	const endpoint =
		viewer.login.toLowerCase() === props.owner.toLowerCase()
			? "/user/repos"
			: `/orgs/${encodePath(props.owner)}/repos`;
	return githubRequest<GitHubRepositoryResponse>(
		token,
		endpoint,
		{
			body: JSON.stringify(repositoryBody(props)),
			method: "POST"
		},
		[201]
	);
}

async function updateRepository(
	token: string,
	owner: string,
	currentName: string,
	props: GitHubRepositoryProps
): Promise<GitHubRepositoryResponse> {
	return githubRequest<GitHubRepositoryResponse>(
		token,
		`/repos/${encodePath(owner)}/${encodePath(currentName)}`,
		{
			body: JSON.stringify(repositoryBody(props)),
			method: "PATCH"
		}
	);
}

async function getRepository(
	token: string,
	owner: string,
	name: string
): Promise<GitHubRepositoryResponse | undefined> {
	return githubRequest<GitHubRepositoryResponse>(
		token,
		`/repos/${encodePath(owner)}/${encodePath(name)}`,
		{ method: "GET" },
		[200, 404]
	);
}

function repositoryBody(props: GitHubRepositoryProps): JsonObject {
	return {
		auto_init: props.autoInit ?? false,
		description: props.description,
		has_issues: props.hasIssues ?? true,
		has_projects: props.hasProjects ?? true,
		has_wiki: props.hasWiki ?? false,
		name: props.name,
		private: (props.visibility ?? "private") === "private",
		visibility: props.visibility ?? "private"
	};
}

function toRepository(
	props: GitHubRepositoryProps,
	repository: GitHubRepositoryResponse
): GitHubRepository {
	return {
		...props,
		cloneUrl: repository.clone_url,
		fullName: repository.full_name,
		htmlUrl: repository.html_url,
		id: String(repository.id),
		name: repository.name,
		nodeId: repository.node_id
	};
}

async function variableEndpoint(token: string, props: GitHubActionsVariableProps): Promise<string> {
	if (!props.environment) {
		return `/repos/${encodePath(props.owner)}/${encodePath(props.repository)}/actions/variables`;
	}

	const repository = await githubRequest<GitHubRepositoryResponse>(
		token,
		`/repos/${encodePath(props.owner)}/${encodePath(props.repository)}`,
		{ method: "GET" }
	);
	return `/repositories/${repository.id}/environments/${encodePath(props.environment)}/variables`;
}

async function githubRequest<T>(
	token: string,
	path: string,
	init: RequestInit,
	expectedStatuses: number[] = [200]
): Promise<T> {
	const response = await fetch(`https://api.github.com${path}`, {
		...init,
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"X-GitHub-Api-Version": "2022-11-28",
			...init.headers
		}
	});

	if (expectedStatuses.includes(response.status)) {
		if (response.status === 204 || response.status === 404) {
			return undefined as T;
		}
		return (await response.json()) as T;
	}

	throw new Error(`GitHub API request failed: ${response.status} ${await response.text()}`);
}

function unwrapToken(token: Secret | string): string {
	return Secret.unwrap(token);
}

function encodePath(value: string): string {
	return encodeURIComponent(value);
}
