import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "jp.example.streamdeckai.sdPlugin";

/** @type {import('rollup').RollupOptions} */
export default {
	input: "src/plugin.ts",
	output: {
		file: `${sdPlugin}/bin/sdai-plugin.js`,
		sourcemap: isWatching,
		sourcemapPathTransform: (relativeSourcePath, sourcemapPath) =>
			new URL(relativeSourcePath, new URL(`file:///${sourcemapPath}`)).href,
	},
	plugins: [
		{
			name: "watch-externals",
			buildStart() {
				this.addWatchFile(`${sdPlugin}/manifest.json`);
			},
		},
		typescript({ tsconfig: "./tsconfig.json", noEmit: false, outDir: `${sdPlugin}/bin`, declaration: false }),
		nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
		commonjs(),
		!isWatching && terser(),
		{
			name: "emit-module-package-file",
			generateBundle() {
				this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
			},
		},
	],
};
