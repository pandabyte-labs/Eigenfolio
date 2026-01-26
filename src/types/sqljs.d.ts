declare module "sql.js" {
  export type SqlJsConfig = {
    locateFile?: (file: string) => string;
  };

  export type QueryExecResult = {
    columns: string[];
    values: unknown[][];
  };

  export interface Database {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string, params?: unknown[]): QueryExecResult[];
    export(): Uint8Array;
    close(): void;
  }

  export type SqlJsStatic = {
    Database: {
      new (data?: Uint8Array): Database;
    };
  };

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
