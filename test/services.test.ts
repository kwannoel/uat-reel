import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answers, startServices } from "../src/services.js";
import { ServiceSchema } from "../src/schema.js";

const freePort = () =>
  new Promise<number>((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

const httpServer = (port: number, extra = "") =>
  `${extra}require("node:http").createServer((q, r) => r.end("ok")).listen(${port}, "127.0.0.1")`;

const service = (fields: Record<string, unknown>) => ServiceSchema.parse({ name: "app", ...fields });

describe("services", () => {
  it("runs before commands, waits until ready, logs output, and stops the whole process group", { timeout: 30_000 }, async () => {
    const out = await mkdtemp(join(tmpdir(), "uat-reel-svc-"));
    const port = await freePort();
    const marker = join(out, "before-ran");
    // The service forks a grandchild that holds the port: stopping must reach it too.
    const grandchild = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(httpServer(port, 'console.log("serving");'))}], { stdio: "inherit" });`;
    const log: string[] = [];
    const running = await startServices(
      [
        service({
          run: [process.execPath, "-e", `${grandchild} setInterval(() => {}, 1000);`],
          ready: `http://127.0.0.1:${port}/`,
          before: [[process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`]],
        }),
      ],
      { root: out, out, log: (l) => log.push(l) },
    );
    expect(existsSync(marker)).toBe(true);
    expect(await answers(`http://127.0.0.1:${port}/`)).toBe(true);
    expect(log.some((l) => l.includes("ready at"))).toBe(true);
    await running.stop();
    expect(await answers(`http://127.0.0.1:${port}/`)).toBe(false);
    expect(readFileSync(join(out, "services", "app.log"), "utf8")).toContain("serving");
  });

  it("refuses to start when something already answers at ready", async () => {
    const out = await mkdtemp(join(tmpdir(), "uat-reel-svc-"));
    const { createServer: http } = await import("node:http");
    const taken = http((q, r) => r.end("someone else")).listen(0, "127.0.0.1");
    await new Promise((r) => taken.once("listening", r));
    const { port } = taken.address() as { port: number };
    try {
      await expect(
        startServices([service({ run: [process.execPath, "-e", httpServer(port)], ready: `http://127.0.0.1:${port}/` })], { root: out, out, log: () => {} }),
      ).rejects.toThrow(/already answers before it started.*--no-services/);
    } finally {
      taken.close();
    }
  });

  it("fails with the end of the log when a service exits before it is ready", async () => {
    const out = await mkdtemp(join(tmpdir(), "uat-reel-svc-"));
    const port = await freePort();
    await expect(
      startServices(
        [service({ run: [process.execPath, "-e", 'console.error("no database"); process.exit(3)'], ready: `http://127.0.0.1:${port}/` })],
        { root: out, out, log: () => {} },
      ),
    ).rejects.toThrow(/stopped \(exit 3\)[^]*no database/);
  });

  it("stops earlier services when a later one fails", { timeout: 30_000 }, async () => {
    const out = await mkdtemp(join(tmpdir(), "uat-reel-svc-"));
    const [a, b] = [await freePort(), await freePort()];
    await expect(
      startServices(
        [
          service({ name: "first", run: [process.execPath, "-e", httpServer(a)], ready: `http://127.0.0.1:${a}/` }),
          service({ name: "second", run: [process.execPath, "-e", "process.exit(1)"], ready: `http://127.0.0.1:${b}/` }),
        ],
        { root: out, out, log: () => {} },
      ),
    ).rejects.toThrow(/second stopped/);
    expect(await answers(`http://127.0.0.1:${a}/`)).toBe(false);
  });
});
