import { describe, expect, test } from "bun:test";
import {
  createOpenTicket,
  browserApplicationName,
  OPEN_ACK_TIMEOUT_MS,
  openSessionMap,
  verifyOpenTicket,
} from "@sessionmap/cli/open.ts";

const TOKEN = "a".repeat(43);

describe("browser open handshake", () => {
  test("supports the default browser, common aliases, and arbitrary installed browsers", () => {
    expect(browserApplicationName("chrome")).toBe("Google Chrome");
    expect(browserApplicationName("firefox")).toBe("Firefox");
    expect(browserApplicationName("Vivaldi")).toBe("Vivaldi");
  });
  test("signs short-lived tickets and rejects tampering or expiry", () => {
    const now = 1_800_000_000_000;
    const created = createOpenTicket(TOKEN, now);
    expect(verifyOpenTicket(TOKEN, created.ticket, now)).toEqual({ id: created.id, expiresAt: created.expiresAt });
    expect(verifyOpenTicket("b".repeat(43), created.ticket, now)).toBeNull();
    expect(verifyOpenTicket(TOKEN, `${created.ticket.slice(0, -1)}x`, now)).toBeNull();
    expect(verifyOpenTicket(TOKEN, created.ticket, created.expiresAt + 1)).toBeNull();
  });

  test("reports success only after the page acknowledges its first render", async () => {
    let launchedUrl = "";
    let launchedBrowser = "";
    let launched = false;
    const fetcher = async () => Response.json({ ready: launched });

    await openSessionMap({ baseUrl: "http://127.0.0.1:4317", token: TOKEN, browser: "chrome" }, {
      fetch: fetcher,
      launch: async (url, browser) => {
        launchedUrl = url;
        launchedBrowser = browser || "";
        launched = true;
      },
    });

    expect(launchedUrl).toStartWith("http://127.0.0.1:4317/#open=");
    expect(launchedUrl).not.toContain(TOKEN);
    expect(launchedBrowser).toBe("chrome");
  });

  test("fails when browser handoff succeeds without a page acknowledgement", async () => {
    let now = 1_800_000_000_000;
    await expect(openSessionMap({ baseUrl: "http://127.0.0.1:4317", token: TOKEN }, {
      fetch: async () => Response.json({ ready: false }),
      launch: async () => {},
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    })).rejects.toThrow("did not become visible");
    expect(now).toBeGreaterThanOrEqual(1_800_000_000_000 + OPEN_ACK_TIMEOUT_MS);
  });

  test("survives a transient service restart while waiting for acknowledgement", async () => {
    let launched = false;
    let polls = 0;
    await openSessionMap({ baseUrl: "http://127.0.0.1:4317", token: TOKEN }, {
      fetch: async () => {
        polls += 1;
        if (launched && polls === 2) throw new TypeError("connection reset");
        return Response.json({ ready: launched && polls >= 3 });
      },
      launch: async () => { launched = true; },
      sleep: async () => {},
    });
    expect(polls).toBe(3);
  });
});
