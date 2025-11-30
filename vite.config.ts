import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig(() => {
  // Configure allowed hosts via environment variable:
  // TRAEKY_ALLOWED_HOSTS
  //
  // Examples:
  //   TRAEKY_ALLOWED_HOSTS=example.com
  //   TRAEKY_ALLOWED_HOSTS=example.net,example.com
  //   TRAEKY_ALLOWED_HOSTS=true      # allow all
  const rawAllowedHosts = process.env.TRAEKY_ALLOWED_HOSTS;

  let allowedHosts: string[] | true;

  if (!rawAllowedHosts) {
    // Fallback: allow all hosts.
    // In production you SHOULD override this with TRAEKY_ALLOWED_HOSTS.
    allowedHosts = true;
  } else if (
    rawAllowedHosts === "true" ||
    rawAllowedHosts === "all" ||
    rawAllowedHosts === "*"
  ) {
    allowedHosts = true;
  } else {
    allowedHosts = rawAllowedHosts
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
  }

  return {
    envPrefix: ["VITE_", "DISABLE_", "TRAEKY_"],
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      allowedHosts,
    },
  };
});