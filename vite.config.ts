import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig({
  envPrefix: ["VITE_", "DISABLE_"],
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: ["all"],
  },
});
