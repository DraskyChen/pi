import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@earendil-works/pi-client/websocket": new URL("../client/src/websocket.ts", import.meta.url).pathname,
			"@earendil-works/pi-client": new URL("../client/src/index.ts", import.meta.url).pathname,
			"@earendil-works/pi-protocol": new URL("../protocol/src/index.ts", import.meta.url).pathname,
		},
	},
	build: {
		target: "es2022",
		outDir: "dist",
		emptyOutDir: true,
	},
});
