/**
 * Regression test for the hermes-local adapter's skill reconciliation.
 *
 * When the Paperclip-managed skills cannot be reconciled, the adapter fails
 * before it reaches the provider: no model call happened, so there is nothing
 * to account for. Throwing at that point leaves the run unsettled, and the
 * budget gate then blocks the agent from ever running again - one failed
 * bootstrap wedges the agent permanently.
 *
 * The adapter therefore reports the failure with the "no provider work" proof
 * the server already understands, so the run can be settled.
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The provider is never reached in this test, but the adapter must not spawn it
// either; mocking keeps the test hermetic.
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

import { execute } from "./execute.js";

function makeCtx(config: Record<string, unknown>, onLog: (stream: string, chunk: string) => void) {
  return {
    runId: "test-run-skills",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "/usr/bin/hermes",
      timeoutSec: 60,
      graceSec: 5,
      ...config,
    },
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: null,
    },
    onLog: vi.fn(async (stream: string, chunk: string) => onLog(stream, chunk)),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  } as unknown as Parameters<typeof execute>[0];
}

describe("hermes-local adapter: the skills cannot be reconciled", () => {
  it("reports the failure with the no-provider-work proof instead of throwing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-skills-"));
    try {
      const source = path.join(home, "materialised", "demo");
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: demo\n---\n", "utf8");
      // The runtime name is taken by a real directory, so the reconciliation
      // cannot replace it and fails.
      await fs.mkdir(path.join(home, "skills", "demo--1234"), { recursive: true });

      const logs: string[] = [];
      const result = await execute(
        makeCtx(
          {
            env: { HERMES_HOME: home },
            paperclipRuntimeSkills: [
              { key: "company-1/demo", runtimeName: "demo--1234", source },
            ],
            paperclipSkillSync: { desiredSkills: ["company-1/demo"] },
          },
          (stream, chunk) => logs.push(`${stream}: ${chunk}`),
        ),
      );

      expect(result.executionRecovery).toEqual({
        kind: "bootstrap",
        providerWorkStarted: false,
      });
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("Hermes cannot start");
      expect(logs.join("\n")).toContain("Cannot start without the required Paperclip-managed skills");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
