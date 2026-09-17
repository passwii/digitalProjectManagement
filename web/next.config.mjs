import nextEnv from "@next/env";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { loadEnvConfig } = nextEnv;
const currentDir = path.dirname(fileURLToPath(import.meta.url));
loadEnvConfig(path.resolve(currentDir, ".."));

/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
