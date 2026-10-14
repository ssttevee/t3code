import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CommandAvailability, WindowsShellEnvironment } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Observe the existing synchronous shell probe without launching the user's login shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import { assert, it, vi } from "vite-plus/test";

import { fixPath, hydratePosixHome } from "./os-jank.ts";

vi.mock("node:child_process", { spy: true });

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});

effectIt.effect.each(["darwin", "linux"] as const)(
  "keeps the prepared PATH and still hydrates HOME on %s",
  (platform) =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.spyOn(NodeChildProcess, "execFileSync")),
      (probe) =>
        Effect.gen(function* () {
          probe.mockImplementation(() => {
            throw new Error("The prepared environment must not launch another shell");
          });
          const env: NodeJS.ProcessEnv = { PATH: "/prepared/bin:/usr/bin" };

          yield* fixPath({ shellEnvironmentPrepared: true }).pipe(
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(HostProcess.Environment, env),
            Effect.provide(NodeServices.layer),
          );

          assert.equal(probe.mock.calls.length, 0);
          assert.equal(env.PATH, "/prepared/bin:/usr/bin");
          assert.equal(env.HOME, NodeOS.userInfo().homedir);
        }),
      (probe) => Effect.sync(() => probe.mockRestore()),
    ),
);

effectIt.effect("hydrates PATH when the desktop handoff is absent", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue("__T3CODE_ENV_PATH_START__\n/opt/tools/bin\n__T3CODE_ENV_PATH_END__\n"),
    ),
    (probe) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(probe.mock.calls.length, 1);
        assert.equal(env.PATH, "/opt/tools/bin:/usr/bin");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect.each([
  { platform: "darwin", inheritedSocket: undefined, expectedSocket: "/tmp/agent.1299" },
  { platform: "linux", inheritedSocket: undefined, expectedSocket: "/tmp/agent.1299" },
  {
    platform: "darwin",
    inheritedSocket: "/var/run/com.apple.launchd.example/Listeners",
    expectedSocket: "/tmp/agent.1299",
  },
  {
    platform: "darwin",
    inheritedSocket: "/tmp/forwarded.sock",
    expectedSocket: "/tmp/forwarded.sock",
  },
  {
    platform: "linux",
    inheritedSocket: "/tmp/forwarded.sock",
    expectedSocket: "/tmp/forwarded.sock",
  },
] as const)(
  "hydrates the server agent on $platform with inherited socket $inheritedSocket",
  ({ platform, inheritedSocket, expectedSocket }) =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        vi
          .spyOn(NodeChildProcess, "execFileSync")
          .mockReturnValue(
            [
              "__T3CODE_ENV_PATH_START__",
              "/usr/bin",
              "__T3CODE_ENV_PATH_END__",
              "__T3CODE_ENV_SSH_AUTH_SOCK_START__",
              "/tmp/agent.1299",
              "__T3CODE_ENV_SSH_AUTH_SOCK_END__",
              "__T3CODE_ENV_SSH_AGENT_PID_START__",
              "1299",
              "__T3CODE_ENV_SSH_AGENT_PID_END__",
            ].join("\n"),
          ),
      ),
      () =>
        Effect.gen(function* () {
          const env: NodeJS.ProcessEnv = {
            SHELL: "/bin/zsh",
            PATH: "/usr/bin",
            ...(inheritedSocket ? { SSH_AUTH_SOCK: inheritedSocket, SSH_AGENT_PID: "42" } : {}),
          };

          yield* fixPath().pipe(
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(HostProcess.Environment, env),
            Effect.provide(NodeServices.layer),
          );

          assert.equal(env.SSH_AUTH_SOCK, expectedSocket);
          assert.equal(env.SSH_AGENT_PID, expectedSocket === "/tmp/agent.1299" ? "1299" : "42");
        }),
      (probe) => Effect.sync(() => probe.mockRestore()),
    ),
);

effectIt.effect("keeps mise's PATH record with the login shell PATH", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue(
          [
            "__T3CODE_ENV_PATH_START__",
            "/home/me/.local/bin:/mise/installs/claude/latest:/mise/shims",
            "__T3CODE_ENV_PATH_END__",
            "__T3CODE_ENV___MISE_DIFF_START__",
            "mise-diff",
            "__T3CODE_ENV___MISE_DIFF_END__",
          ].join("\n"),
        ),
    ),
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(env.__MISE_DIFF, "mise-diff");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("repairs Windows PATH even when the desktop marks it prepared", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
    const commands: string[] = [];

    yield* fixPath({ shellEnvironmentPrepared: true }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () => ({ PATH: "C:\\Tools" })),
      Effect.provideService(CommandAvailability, (command) =>
        Effect.sync(() => {
          commands.push(command);
          return true;
        }),
      ),
      Effect.provide(NodeServices.layer),
    );

    assert.deepEqual(commands, ["node"]);
    assert.equal(env.PATH, "C:\\Tools;C:\\Windows");
  }),
);
