import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(root, ".."), "");
  return {
    plugins: [react()],
    server: { port: 5174 },
    define: {
      __AMIRA_SUPABASE_URL__: JSON.stringify("https://tmewbswbhnmuuomdfewq.supabase.co"),
      __AMIRA_SUPABASE_KEY__: JSON.stringify(env.SUPABASE_SERVICE_ROLE_KEY ?? ""),
    },
  };
});
