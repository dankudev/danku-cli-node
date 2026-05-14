import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import ts from "typescript-eslint";

export default defineConfig(
	{
		ignores: ["dist", "node_modules"]
	},
	js.configs.recommended,
	...ts.configs.strictTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.js", "tsdown.config.ts"]
				},
				tsconfigRootDir: import.meta.dirname
			}
		}
	}
);
