// Test-only stub for `@electric-sql/pglite`.
// PGlite's published d.ts references DOM/Emscripten/WebAssembly ambient globals
// that aren't in this project's TS lib (`["ES2023"]`). Path-mapped to this stub
// from `tests/tsconfig.json` so `tsc --project tests/tsconfig.json` can validate
// without `skipLibCheck`. The shape mirrors kysely's structural `PGlite`
// interface (`kysely/dist/dialect/pglite/pglite-dialect-config`); real types
// are exercised at runtime.

declare module '@electric-sql/pglite' {
  export interface PGliteOptions {
    dataDir?: string;
    parsers?: Record<number, (value: string) => unknown>;
    [key: string]: unknown;
  }

  export class PGlite {
    static create(options?: PGliteOptions): Promise<PGlite>;
    close(): Promise<void>;
    closed: boolean;
    exec(query: string): Promise<unknown>;
    query<T = unknown>(
      query: string,
      params?: unknown[],
      options?: unknown,
    ): Promise<{ rows: T[]; fields: { dataTypeID: number; name: string }[]; affectedRows?: number }>;
    ready: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
    waitReady: Promise<void>;
  }
}
