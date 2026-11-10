import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createUndiciTransport } from "../src/crawl/fetcher.js";

describe("undici transport", () => {
  it("reads a gzip body and passes headers through, against a local server only", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(String(req.headers["user-agent"]));
      res.writeHead(200, {
        "content-encoding": "gzip",
        "set-cookie": ["a=1", "b=2"],
        "content-type": "text/html",
      });
      res.end(gzipSync("Überprüfung"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await createUndiciTransport()({
        url: `http://127.0.0.1:${port}/x.html`,
        headers: { "user-agent": "test-agent" },
      });
      expect(res.status).toBe(200);
      expect(res.body).toBe("Überprüfung");
      expect(res.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
      expect(seen).toEqual(["test-agent"]);
    } finally {
      server.close();
    }
  });

  it("gives up on a response body over 5 MB", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(6 * 1024 * 1024, "a"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      await expect(
        createUndiciTransport()({ url: `http://127.0.0.1:${port}/big.html`, headers: {} }),
      ).rejects.toThrow(/too large/);
    } finally {
      server.close();
    }
  });
});
