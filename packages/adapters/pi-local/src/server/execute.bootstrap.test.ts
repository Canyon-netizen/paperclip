import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, testHome } = await vi.hoisted(async () => {
  const [{ default: os }, { default: nodePath }] = await Promise.all([
    import("node:os"),
    import("node:path"),
  ]);
  const home = nodePath.join(os.tmpdir(), `paperclip-pi-bootstrap-${process.pid}-${Date.now()}`);
  process.env.HOME = home;
  return {
    testHome: home,
    mocks: {
      ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
      ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
      ensurePiModelConfiguredAndAvailable: vi.fn(async () => [
        { id: "openai/gpt-5.4-mini", label: "openai/gpt-5.4-mini" },
      ]),
      runAdapterExecutionTargetProcess: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({
          type: "turn_end",
          message: {
            role: "assistant",
            content: "done",
            usage: { input: 10, output: 20, cacheRead: 0, cost: { total: 0.01 } },
          },
          toolResults: [],
        }),
        stderr: "",
        pid: 4242,
        startedAt: new Date().toISOString(),
      })),
    },
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: mocks.ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled: mocks.ensureAdapterExecutionTargetRuntimeCommandInstalled,
    runAdapterExecutionTargetProcess: mocks.runAdapterExecutionTargetProcess,
  };
});

vi.mock("./models.js", async () => {
  const actual = await vi.importActual<typeof import("./models.js")>("./models.js");
  return { ...actual, ensurePiModelConfiguredAndAvailable: mocks.ensurePiModelConfiguredAndAvailable };
});

import { execute } from "./execute.js";

describe("pi pre-provider failure accounting", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-pi-bootstrap-workspace-"));
    mocks.ensureAdapterExecutionTargetCommandResolvable.mockResolvedValue(undefined);
    mocks.ensureAdapterExecutionTargetRuntimeCommandInstalled.mockResolvedValue(undefined);
    mocks.ensurePiModelConfiguredAndAvailable.mockResolvedValue([
      { id: "openai/gpt-5.4-mini", label: "openai/gpt-5.4-mini" },
    ]);
    mocks.runAdapterExecutionTargetProcess.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "done",
          usage: { input: 10, output: 20, cacheRead: 0, cost: { total: 0.01 } },
        },
        toolResults: [],
      }),
      stderr: "",
      pid: 4242,
      startedAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  });

  const context = () => ({
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Pi Builder",
      adapterType: "pi_local" as const,
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "pi", model: "openai/gpt-5.4-mini", env: { HOME: testHome } },
    context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
    onLog: async () => {},
  });

  it("reports a model discovery failure as a pre-provider failure instead of throwing", async () => {
    mocks.ensurePiModelConfiguredAndAvailable.mockRejectedValueOnce(
      new Error("`pi --list-models` timed out."),
    );

    const result = await execute(context());

    expect(result).toMatchObject({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "pi_bootstrap_failed",
      errorFamily: "transient_upstream",
      usageComplete: false,
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    });
    expect(result.errorMessage).toContain("`pi --list-models` timed out.");
    expect(mocks.runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("classifies a configuration failure as a configuration error family", async () => {
    mocks.ensurePiModelConfiguredAndAvailable.mockRejectedValueOnce(
      new Error("Configured Pi model is unavailable: openai/gpt-5.4-mini."),
    );

    const result = await execute(context());

    expect(result).toMatchObject({
      errorCode: "pi_bootstrap_failed",
      errorFamily: "configuration",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    });
  });

  it("keeps a provider-side failure unproven so accounting never invents a free run", async () => {
    mocks.runAdapterExecutionTargetProcess.mockRejectedValueOnce(new Error("provider process crashed"));

    await expect(execute(context())).rejects.toThrow("provider process crashed");
  });

  it("never labels a completed provider run as a pre-provider failure", async () => {
    const result = await execute(context());

    expect(result.errorCode ?? null).toBeNull();
    expect(result.executionRecovery).toBeUndefined();
    expect(mocks.runAdapterExecutionTargetProcess).toHaveBeenCalledOnce();
  });
});
