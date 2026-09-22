import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pdfjsRoot = path.join(webRoot, "node_modules", "pdfjs-dist");

function copyPdfAssetDirectory(sourceDirectory, targetDirectory) {
  const source = path.join(pdfjsRoot, sourceDirectory);
  const target = path.join(webRoot, "public", targetDirectory);
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
}

copyPdfAssetDirectory("cmaps", "pdf-cmaps");
copyPdfAssetDirectory("standard_fonts", "pdf-standard-fonts");
