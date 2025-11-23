import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig(() => {
  // Configure allowed hosts via environment variable:
  // TRAKKY_ALLOWED_HOSTS
  //
  // Examples:
  //   TRAKKY_ALLOWED_HOSTS=example.com
  //   TRAKKY_ALLOWED_HOSTS=example.net,example.com
  //   TRAKKY_ALLOWED_HOSTS=true      # allow all
  const rawAllowedHosts = process.env.TRAKKY_ALLOWED_HOSTS;

  let allowedHosts: string[] | true;

  if (!rawAllowedHosts) {
    // Fallback: allow all hosts.
    // In production you SHOULD override this with TRAKKY_ALLOWED_HOSTS.
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
    envPrefix: ["VITE_", "DISABLE_"],
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      allowedHosts,
    },
  };
});
