declare module "sql.js" {
  export type Database = {
    exec(sql: string): void;
    run(sql: string, params?: unknown): void;
    prepare(sql: string): {
      bind(params?: unknown): void;
      step(): boolean;
      getAsObject(): Record<string, unknown>;
      free(): void;
    };
    export(): Uint8Array;
    close(): void;
  };

  const initSqlJs: (options?: { locateFile?: (file: string) => string }) => Promise<{
    Database: new (data?: Uint8Array | Buffer) => Database;
  }>;

  export default initSqlJs;
}
