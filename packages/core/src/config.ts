import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { DigestRulesConfig, LoadedServiceConfig, ServicePaths, SourceConfig } from "./types.js";

function readYamlFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = YAML.parse(raw);
  return (parsed ?? fallback) as T;
}

function resolveRootDir(): string {
  return process.env.WECHAT_DIGEST_ROOT
    ? path.resolve(process.env.WECHAT_DIGEST_ROOT)
    : process.cwd();
}

export function resolveServicePaths(): ServicePaths {
  const rootDir = resolveRootDir();
  const configDir = process.env.WECHAT_DIGEST_CONFIG_DIR
    ? path.resolve(process.env.WECHAT_DIGEST_CONFIG_DIR)
    : path.join(rootDir, "config");
  const dataDir = process.env.WECHAT_DIGEST_DATA_DIR
    ? path.resolve(process.env.WECHAT_DIGEST_DATA_DIR)
    : path.join(rootDir, "data");
  const articleCacheDir = path.join(dataDir, "cache", "articles");
  const imageCacheDir = path.join(dataDir, "cache", "images");
  const stateFile = path.join(dataDir, "state.sqlite");

  for (const dir of [configDir, dataDir, articleCacheDir, imageCacheDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return {
    rootDir,
    configDir,
    dataDir,
    stateFile,
    articleCacheDir,
    imageCacheDir,
  };
}

export function loadServiceConfig(): LoadedServiceConfig {
  const paths = resolveServicePaths();
  const sourcesDoc = readYamlFile<{ sources?: SourceConfig[] }>(
    path.join(paths.configDir, "wechat_sources.yaml"),
    { sources: [] },
  );
  const rules = readYamlFile<DigestRulesConfig>(
    path.join(paths.configDir, "wechat_digest_rules.yaml"),
    {},
  );

  return {
    paths,
    sources: (sourcesDoc.sources ?? []).filter((entry) => Boolean(entry?.id) && Boolean(entry?.discovery)),
    rules,
  };
}
