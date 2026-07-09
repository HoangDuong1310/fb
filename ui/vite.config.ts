import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Build cho trang extension MV3:
//  - base "./"  : Chrome nạp dashboard qua chrome-extension://<id>/dist/ui/index.html,
//                 nên mọi asset phải tham chiếu TƯƠNG ĐỐI (không phải "/assets/...").
//  - outDir     : ghi thẳng ra ../dist/ui để manifest/openDashboard trỏ tới sau này.
//  - emptyOutDir: dọn sạch dist/ui mỗi lần build cho khỏi lẫn file cũ.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
    sourcemap: false,
    // Trang extension chỉ có 1 entry (index.html) nên gộp gọn, không cần chia nhỏ.
    chunkSizeWarningLimit: 1500,
  },
});
