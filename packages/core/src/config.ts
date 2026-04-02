import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { DigestRulesConfig, LoadedServiceConfig, ServicePaths, SourceConfig } from "./types.js";
import { mergeDigestRules, readOverlayRules } from "./rules.js";

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
  const overlayRulesFile = path.join(dataDir, "rules.overlay.yaml");

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
    overlayRulesFile,
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
  const overlayRules = readOverlayRules(paths.overlayRulesFile);

  return {
    paths,
    sources: (sourcesDoc.sources ?? []).filter((entry) => Boolean(entry?.id) && Boolean(entry?.discovery)),
    rules: mergeDigestRules(rules, overlayRules),
  };
}
