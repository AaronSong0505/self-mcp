import fs from "node:fs";
import { createRequire } from "node:module";
import initSqlJs, { type Database } from "sql.js";

type BindParams = Record<string, unknown> | unknown[];

const require = createRequire(import.meta.url);

export class SqliteStateStore {
  private constructor(
    private readonly db: Database,
    private readonly filePath: string,
  ) {}

  static async open(filePath: string): Promise<SqliteStateStore> {
    const sql = await initSqlJs({
      locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
    });
    const db = fs.existsSync(filePath)
      ? new sql.Database(fs.readFileSync(filePath))
      : new sql.Database();
    const store = new SqliteStateStore(db, filePath);
    store.migrate();
    store.persist();
    return store;
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        discovery_type TEXT NOT NULL,
        discovery_url TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS discoveries (
        id TEXT PRIMARY KEY,
        source_id TEXT,
        title TEXT NOT NULL,
        blurb TEXT,
        canonical_url TEXT NOT NULL UNIQUE,
        article_url TEXT NOT NULL,
        published_at TEXT,
        discovered_at TEXT NOT NULL,
        discovered_date TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY,
        source_id TEXT,
        discovery_id TEXT,
        canonical_url TEXT NOT NULL UNIQUE,
        article_url TEXT NOT NULL,
        title TEXT NOT NULL,
        blurb TEXT,
        author TEXT,
        published_at TEXT,
        discovered_date TEXT,
        content_text TEXT,
        content_html TEXT,
        summary TEXT,
        why_relevant TEXT,
        key_takeaways_json TEXT,
        content_labels_json TEXT,
        list_label TEXT,
        relevance_score REAL,
        digest_eligible INTEGER NOT NULL DEFAULT 0,
        analysis_status TEXT NOT NULL DEFAULT 'pending',
        analyzed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS article_images (
        id TEXT PRIMARY KEY,
        article_id TEXT NOT NULL,
        image_url TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        vision_insight TEXT,
        width INTEGER,
        height INTEGER
      );

      CREATE TABLE IF NOT EXISTS digests (
        id TEXT PRIMARY KEY,
        digest_date TEXT NOT NULL,
        target_id TEXT NOT NULL,
        overview_text TEXT NOT NULL,
        detail_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        digest_id TEXT NOT NULL,
        article_id TEXT,
        target_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        account_id TEXT,
        to_recipient TEXT NOT NULL,
        message_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        sent_at TEXT,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_articles_discovered_date ON articles(discovered_date);
      CREATE INDEX IF NOT EXISTS idx_articles_analysis_status ON articles(analysis_status);
      CREATE INDEX IF NOT EXISTS idx_deliveries_target ON deliveries(target_id, status);
    `);
  }

  run(sqlText: string, params: BindParams = []): void {
    this.db.run(sqlText, params as never);
    this.persist();
  }

  get<T>(sqlText: string, params: BindParams = []): T | undefined {
    const rows = this.all<T>(sqlText, params);
    return rows[0];
  }

  all<T>(sqlText: string, params: BindParams = []): T[] {
    const stmt = this.db.prepare(sqlText);
    stmt.bind(params as never);
    const rows: T[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return rows;
  }

  persist(): void {
    const bytes = this.db.export();
    fs.writeFileSync(this.filePath, Buffer.from(bytes));
  }

  close(): void {
    this.persist();
    this.db.close();
  }
}
