import { readFileSync } from "node:fs";

interface PackageMetadata {
  version?: string;
}

function loadPackageVersion(): string {
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const raw = readFileSync(packageJsonUrl, "utf8");
    const metadata = JSON.parse(raw) as PackageMetadata;

    return metadata.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const SERVER_VERSION = loadPackageVersion();
