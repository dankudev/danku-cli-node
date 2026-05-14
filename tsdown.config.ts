import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	platform: "node",
	format: "esm",
	fixedExtension: false,
	dts: true,
	sourcemap: true,
	clean: true,
	failOnWarn: true
});
