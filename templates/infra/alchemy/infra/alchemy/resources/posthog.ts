import { Resource, Secret, type Context } from "alchemy";

type JsonObject = Record<string, unknown>;

export type PostHogProjectProps = {
	apiKey: Secret | string;
	host?: string;
	name: string;
	organizationId: string;
	timezone?: string;
};

export type PostHogProject = PostHogProjectProps & {
	apiToken: string;
	id: string;
	projectId: string;
};

export const PostHogProject = Resource(
	"danku::PostHogProject",
	async function(
		this: Context<PostHogProject, PostHogProjectProps>,
		_id: string,
		props: PostHogProjectProps
	): Promise<PostHogProject> {
		if (this.phase === "delete") {
			return this.destroy();
		}

		const token = Secret.unwrap(props.apiKey);
		const host = posthogHost(props.host);
		const existing =
			this.phase === "create"
				? await findProject(host, token, props.organizationId, props.name)
				: await getProject(host, token, this.output.projectId);
		const project = existing
			? await updateProject(host, token, readString(existing, "id"), props)
			: await createProject(host, token, props);

		return {
			...props,
			apiToken: readString(project, "api_token"),
			host,
			id: readString(project, "id"),
			projectId: readString(project, "id")
		};
	}
);

export type PostHogFeatureFlagProps = {
	active?: boolean;
	apiKey: Secret | string;
	host?: string;
	key: string;
	name: string;
	projectId: string;
	rolloutPercentage?: number;
};

export type PostHogFeatureFlag = PostHogFeatureFlagProps & {
	featureFlagId: string;
	id: string;
};

export const PostHogFeatureFlag = Resource(
	"danku::PostHogFeatureFlag",
	async function(
		this: Context<PostHogFeatureFlag, PostHogFeatureFlagProps>,
		_id: string,
		props: PostHogFeatureFlagProps
	): Promise<PostHogFeatureFlag> {
		if (this.phase === "delete") {
			return this.destroy();
		}

		const token = Secret.unwrap(props.apiKey);
		const host = posthogHost(props.host);
		const existing =
			this.phase === "create"
				? await findFeatureFlag(host, token, props.projectId, props.key)
				: await getFeatureFlag(host, token, props.projectId, this.output.featureFlagId);
		const flag = existing
			? await updateFeatureFlag(host, token, props.projectId, readString(existing, "id"), props)
			: await createFeatureFlag(host, token, props);
		const featureFlagId = readString(flag, "id");

		return {
			...props,
			featureFlagId,
			host,
			id: featureFlagId
		};
	}
);

async function createProject(
	host: string,
	token: string,
	props: PostHogProjectProps
): Promise<JsonObject> {
	return posthogRequest<JsonObject>(
		host,
		token,
		`/api/organizations/${encodePath(props.organizationId)}/projects/`,
		{
			body: JSON.stringify({
				name: props.name,
				timezone: props.timezone ?? "UTC"
			}),
			method: "POST"
		},
		[200, 201]
	);
}

async function updateProject(
	host: string,
	token: string,
	projectId: string,
	props: PostHogProjectProps
): Promise<JsonObject> {
	return posthogRequest<JsonObject>(
		host,
		token,
		`/api/projects/${encodePath(projectId)}/`,
		{
			body: JSON.stringify({
				name: props.name,
				timezone: props.timezone ?? "UTC"
			}),
			method: "PATCH"
		}
	);
}

async function getProject(host: string, token: string, projectId: string): Promise<JsonObject> {
	return posthogRequest<JsonObject>(host, token, `/api/projects/${encodePath(projectId)}/`, {
		method: "GET"
	});
}

async function findProject(
	host: string,
	token: string,
	organizationId: string,
	name: string
): Promise<JsonObject | undefined> {
	const projects = await posthogRequest<{ results?: JsonObject[] }>(
		host,
		token,
		`/api/organizations/${encodePath(organizationId)}/projects/?search=${encodeURIComponent(name)}`,
		{ method: "GET" }
	);
	return projects.results?.find((project) => readString(project, "name") === name);
}

async function createFeatureFlag(
	host: string,
	token: string,
	props: PostHogFeatureFlagProps
): Promise<JsonObject> {
	return posthogRequest<JsonObject>(
		host,
		token,
		`/api/projects/${encodePath(props.projectId)}/feature_flags/`,
		{
			body: JSON.stringify(featureFlagBody(props)),
			method: "POST"
		},
		[200, 201]
	);
}

async function updateFeatureFlag(
	host: string,
	token: string,
	projectId: string,
	featureFlagId: string,
	props: PostHogFeatureFlagProps
): Promise<JsonObject> {
	return posthogRequest<JsonObject>(
		host,
		token,
		`/api/projects/${encodePath(projectId)}/feature_flags/${encodePath(featureFlagId)}/`,
		{
			body: JSON.stringify(featureFlagBody(props)),
			method: "PATCH"
		}
	);
}

async function getFeatureFlag(
	host: string,
	token: string,
	projectId: string,
	featureFlagId: string
): Promise<JsonObject> {
	return posthogRequest<JsonObject>(
		host,
		token,
		`/api/projects/${encodePath(projectId)}/feature_flags/${encodePath(featureFlagId)}/`,
		{ method: "GET" }
	);
}

async function findFeatureFlag(
	host: string,
	token: string,
	projectId: string,
	key: string
): Promise<JsonObject | undefined> {
	const flags = await posthogRequest<{ results?: JsonObject[] }>(
		host,
		token,
		`/api/projects/${encodePath(projectId)}/feature_flags/?search=${encodeURIComponent(key)}`,
		{ method: "GET" }
	);
	return flags.results?.find((flag) => readString(flag, "key") === key);
}

function featureFlagBody(props: PostHogFeatureFlagProps): JsonObject {
	return {
		active: props.active ?? false,
		filters: {
			groups: [{
				properties: [],
				rollout_percentage: props.rolloutPercentage ?? 0
			}]
		},
		key: props.key,
		name: props.name
	};
}

async function posthogRequest<T>(
	host: string,
	token: string,
	path: string,
	init: RequestInit,
	expectedStatuses: number[] = [200]
): Promise<T> {
	const response = await fetch(`${host}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			...init.headers
		}
	});

	if (expectedStatuses.includes(response.status)) {
		return (await response.json()) as T;
	}

	throw new Error(`PostHog API request failed: ${response.status} ${await response.text()}`);
}

function posthogHost(host = "https://us.posthog.com"): string {
	return host.replace(/\/$/, "");
}

function readString(object: JsonObject, key: string): string {
	const value = object[key];
	if (typeof value === "string" || typeof value === "number") {
		return String(value);
	}
	throw new Error(`PostHog response is missing ${key}`);
}

function encodePath(value: string): string {
	return encodeURIComponent(value);
}
