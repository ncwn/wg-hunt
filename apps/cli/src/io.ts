export type Io = {
  env: Record<string, string | undefined>;
  fetch: (request: Request) => Promise<Response>;
  stdout: { write(text: string): void; isTTY?: boolean };
  stderr: { write(text: string): void };
  stdin: {
    isTTY?: boolean;
    read(): Promise<string>;
  };
  /** Only called when stdin is a terminal. */
  promptSecret(label: string): Promise<string>;
  homeDir: string;
  cwd: string;
  now(): number;
  signal?: AbortSignal;
};
