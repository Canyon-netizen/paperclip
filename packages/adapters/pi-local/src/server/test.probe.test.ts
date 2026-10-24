import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const {
  runChildProcess,
  runAdapterExecutionTargetProcess,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  ensureAdapterExecutionTargetDirectory,
  prepareAdapterExecutionTargetRuntime,
  listModelsEnv,
  probeEnv,
  modelsJsonDuringProbe,
  stagedAgentConfigDir,
  stagingFailure,
} = vi.hoisted(() => {
  const listModelsEnv: { value: Record<string, string> | null } = { value: null };
  const probeEnv: { value: Record<string, string> | null } = { value: null };
  const modelsJsonDuringProbe: { value: string | null } = { value: null };
  const stagedAgentConfigDir: { value: string | null } = {
    value: "/remote/workspace/.paperclip-runtime/pi/agentConfig",
  };
  const stagingFailure: { value: Error | null } = { value: null };
  const captureModelsJson = (env: Record<string, string> | null | undefined) => {
    const dir = env?.PI_CODING_AGENT_DIR;
    if (!dir || modelsJsonDuringProbe.value !== null) return;
    try {
      modelsJsonDuringProbe.value = fs.readFileSync(path.join(dir, "models.json"), "utf8");
    } catch {
      modelsJsonDuringProbe.value = null;
    }
  };
  return {
    listModelsEnv,
    probeEnv,
    modelsJsonDuringProbe,
    stagedAgentConfigDir,
    stagingFailure,
    runChildProcess: vi.fn(async (_runId: string, _command: string, _args: string[], options: { env?: Record<string, string> }) => {
      listModelsEnv.value = options?.env ?? null;
      captureModelsJson(listModelsEnv.value);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          "provider   model                       context  max-out  thinking  images",
          "minimax    MiniMax-M3                  200K     64K      no        no",
        ].join("\n"),
        stderr: "",
        pid: 4242,
        startedAt: new Date().toISOString(),
      };
    }),
    runAdapterExecutionTargetProcess: vi.fn(async (_runId: string, _target: unknown, _command: string, _args: string[], options: { env?: Record<string, string> }) => {
      probeEnv.value = options?.env ?? null;
      captureModelsJson(probeEnv.value);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}',
        ].join("\n"),
        stderr: "",
        pid: 4243,
        startedAt: new Date().toISOString(),
      };
    }),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    prepareAdapterExecutionTargetRuntime: vi.fn(async (input: { assets?: { key: string; localDir: string }[] }) => {
      if (stagingFailure.value) throw stagingFailure.value;
      const agentConfig = (input.assets ?? []).find((asset) => asset.key === "agentConfig");
      return {
        target: { kind: "remote" as const, transport: "ssh" as const },
        workspaceRemoteDir: "/remote/workspace",
        runtimeRootDir: null,
        assetDirs: agentConfig && stagedAgentConfigDir.value
          ? { agentConfig: stagedAgentConfigDir.value }
          : {},
        additionalSourceDirs: {},
        additionalSourceFailures: [],
        workspaceSyncSnapshot: null,
        restoreWorkspace: async () => {},
      };
    }),
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, runChildProcess };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetDirectory,
    ensureAdapterExecutionTargetCommandResolvable,
    maybeRunSandboxInstallCommand,
    runAdapterExecutionTargetProcess,
    prepareAdapterExecutionTargetRuntime,
  };
});

import { testEnvironment } from "./test.js";

const PROVIDERS = {
  minimax: {
    baseUrl: "https://gateway.example.test/anthropic",
    api: "anthropic-messages",
    apiKey: "{env:ANTHROPIC_API_KEY}",
    models: [{ id: "MiniMax-M3", name: "MiniMax M3", contextWindow: 200000, maxTokens: 64000 }],
  },
};

const REMOTE_TARGET = {
  kind: "remote" as const,
  transport: "ssh" as const,
  remoteCwd: "/remote/workspace",
  spec: {
    host: "127.0.0.1",
    port: 2222,
    username: "fixture",
    remoteWorkspacePath: "/remote/workspace",
    remoteCwd: "/remote/workspace",
    privateKey: "PRIVATE KEY",
    knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
    strictHostKeyChecking: true,
  },
};

afterEach(() => {
  vi.clearAllMocks();
  listModelsEnv.value = null;
  probeEnv.value = null;
  modelsJsonDuringProbe.value = null;
  stagedAgentConfigDir.value = "/remote/workspace/.paperclip-runtime/pi/agentConfig";
  stagingFailure.value = null;
});

describe("pi configuration check", () => {
  it("resolves the configured providers for every probe", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      config: {
        command: "pi",
        model: "minimax/MiniMax-M3",
        env: {
          ANTHROPIC_API_KEY: "sk-test-key",
          PAPERCLIP_PI_PROVIDERS: JSON.stringify(PROVIDERS),
        },
      },
    });

    expect(result.status).not.toBe("fail");
    expect(result.checks.find((check) => check.code === "pi_models_discovered")?.level).toBe("info");
    expect(result.checks.find((check) => check.code === "pi_model_configured")?.level).toBe("info");
    expect(result.checks.find((check) => check.code === "pi_hello_probe_passed")?.level).toBe("info");

    const listEnv = listModelsEnv.value;
    const helloEnv = probeEnv.value;
    expect(listEnv?.PI_CODING_AGENT_DIR).toBeTruthy();
    expect(helloEnv?.PI_CODING_AGENT_DIR).toBeTruthy();

    const modelsJson = JSON.parse(String(modelsJsonDuringProbe.value)) as {
      providers: Record<string, { apiKey?: string }>;
    };
    expect(modelsJson.providers.minimax).toBeTruthy();
    expect(modelsJson.providers.minimax.apiKey).toBe("sk-test-key");
    expect(fs.existsSync(String(listEnv?.PI_CODING_AGENT_DIR))).toBe(false);
  });

  it("lists models once for the whole check", async () => {
    await testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      config: {
        command: "pi",
        model: "minimax/MiniMax-M3",
        env: {
          ANTHROPIC_API_KEY: "sk-test-key",
          PAPERCLIP_PI_PROVIDERS: JSON.stringify(PROVIDERS),
        },
      },
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(listModelsEnv.value?.PI_CODING_AGENT_DIR).toBeTruthy();
  });

  it("leaves the environment alone when no providers are configured", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      config: {
        command: "pi",
        model: "minimax/MiniMax-M3",
        env: { ANTHROPIC_API_KEY: "sk-test-key" },
      },
    });

    expect(result.status).not.toBe("fail");
    expect(listModelsEnv.value?.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(probeEnv.value?.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  it("points the remote probe at the provider config staged on the target", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      config: {
        command: "pi",
        model: "minimax/MiniMax-M3",
        env: {
          ANTHROPIC_API_KEY: "sk-test-key",
          PAPERCLIP_PI_PROVIDERS: JSON.stringify(PROVIDERS),
        },
      },
      executionTarget: REMOTE_TARGET,
      environmentName: "Remote build box",
    });

    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterKey: "pi",
        syncWorkspace: false,
        assets: [expect.objectContaining({ key: "agentConfig" })],
      }),
    );
    expect(probeEnv.value?.PI_CODING_AGENT_DIR).toBe(
      "/remote/workspace/.paperclip-runtime/pi/agentConfig",
    );
    expect(result.checks.find((check) => check.code === "pi_hello_probe_passed")?.level).toBe("info");
    expect(result.checks.find((check) => check.code === "pi_provider_config_not_staged")).toBeUndefined();
  });

  it("reports a provider config that could not be staged to the target", async () => {
    stagingFailure.value = new Error("staging refused");

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      config: {
        command: "pi",
        model: "minimax/MiniMax-M3",
        env: {
          ANTHROPIC_API_KEY: "sk-test-key",
          PAPERCLIP_PI_PROVIDERS: JSON.stringify(PROVIDERS),
        },
      },
      executionTarget: REMOTE_TARGET,
      environmentName: "Remote build box",
    });

    const check = result.checks.find((entry) => entry.code === "pi_provider_config_not_staged");
    expect(check?.level).toBe("error");
    expect(check?.detail).toContain("staging refused");
    expect(result.status).toBe("fail");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
