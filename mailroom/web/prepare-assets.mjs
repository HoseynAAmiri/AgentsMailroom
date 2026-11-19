import { copyFile } from "node:fs/promises";

// Serve the worker from the same PDF.js release as the bundled viewer.
await copyFile(
  new URL("./node_modules/pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url),
  new URL("./public/pdf.worker.min.mjs", import.meta.url),
);
