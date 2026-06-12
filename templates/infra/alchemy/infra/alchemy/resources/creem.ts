import { Resource, Secret, type Context } from "alchemy";

type JsonObject = Record<string, unknown>;

export type CreemProductProps = {
	apiKey: Secret | string;
	billingPeriod?: "monthly" | "yearly";
	billingType: "one_time" | "recurring";
	currency: string;
	name: string;
	price: number;
	testMode?: boolean;
};

export type CreemProduct = CreemProductProps & {
	id: string;
	productId: string;
};

export const CreemProduct = Resource(
	"danku::CreemProduct",
	async function(
		this: Context<CreemProduct, CreemProductProps>,
		_id: string,
		props: CreemProductProps
	): Promise<CreemProduct> {
		if (this.phase === "delete") {
			return this.destroy();
		}

		if (this.phase === "update") {
			return {
				...props,
				id: this.output.productId,
				productId: this.output.productId
			};
		}

		const response = await fetch(creemBaseUrl(props.testMode), {
			body: JSON.stringify({
				billing_period: props.billingPeriod,
				billing_type: props.billingType,
				currency: props.currency,
				name: props.name,
				price: props.price
			}),
			headers: {
				"content-type": "application/json",
				"x-api-key": Secret.unwrap(props.apiKey)
			},
			method: "POST"
		});

		if (!response.ok) {
			throw new Error(`Creem product create failed: ${response.status} ${await response.text()}`);
		}

		const product = (await response.json()) as JsonObject;
		const productId = readString(product, "id");
		return {
			...props,
			id: productId,
			productId
		};
	}
);

function creemBaseUrl(testMode = true): string {
	return testMode ? "https://test-api.creem.io/v1/products" : "https://api.creem.io/v1/products";
}

function readString(object: JsonObject, key: string): string {
	const value = object[key];
	if (typeof value === "string" || typeof value === "number") {
		return String(value);
	}
	throw new Error(`Creem response is missing ${key}`);
}
