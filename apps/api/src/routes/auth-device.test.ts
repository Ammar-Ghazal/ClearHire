import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../env.js")>();
  return {
    ...actual,
    env: { ...actual.env, GITHUB_CLIENT_ID: "public-client-id" },
  };
});

const { authRoutes } = await import("./auth.js");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("keeps the GitHub device code server-side and enforces polling and slow-down intervals", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const github = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        device_code: "server-only-code",
        user_code: "TEST-CODE",
        interval: 5,
        expires_in: 60,
      }),
    )
    .mockResolvedValueOnce(Response.json({ error: "slow_down" }))
    .mockResolvedValueOnce(Response.json({ error: "access_denied" }));
  vi.stubGlobal("fetch", github);

  const app = Fastify();
  await app.register(cookie, { secret: "test-cookie-secret" });
  await app.register(authRoutes);
  try {
    const start = await app.inject({
      method: "POST",
      url: "/auth/github/device",
    });
    expect(start.json()).toEqual({ code: "TEST-CODE", intervalMs: 5000 });
    expect(start.headers["set-cookie"]).not.toContain("server-only-code");
    const poll = (cookies?: Record<string, string>) =>
      app.inject({ method: "POST", url: "/auth/github/device/poll", cookies });
    expect((await poll()).json()).toEqual({ status: "expired" });

    const { name, value } = start.cookies[0]!;
    const cookies = { [name]: value };
    expect((await poll(cookies)).json()).toEqual({
      status: "pending",
      intervalMs: 5000,
    });
    expect(github).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 5000);
    expect((await poll(cookies)).json()).toEqual({
      status: "pending",
      intervalMs: 10000,
    });
    const body = github.mock.calls[1]![1].body as URLSearchParams;
    expect(body.get("device_code")).toBe("server-only-code");
    expect(body.has("client_secret")).toBe(false);
    expect((await poll(cookies)).json()).toEqual({
      status: "pending",
      intervalMs: 10000,
    });
    expect(github).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + 10000);
    expect((await poll(cookies)).json()).toEqual({ status: "denied" });
    expect((await poll(cookies)).json()).toEqual({ status: "expired" });
  } finally {
    await app.close();
  }
});
