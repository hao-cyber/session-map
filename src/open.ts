import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const OPEN_TICKET_TTL_MS = 30_000;
export const OPEN_ACK_TIMEOUT_MS = 6_000;
export const OPEN_POLL_MS = 150;

const TICKET_CONTEXT = "sessionmap-open-v1";
const TICKET_PATTERN = /^[A-Za-z0-9_-]{20,512}\.[A-Za-z0-9_-]{43}$/;

export interface OpenTicket {
  id: string;
  expiresAt: number;
  ticket: string;
}

export interface OpenSessionOptions {
  baseUrl: string;
  token: string;
  browser?: string;
}

export interface OpenSessionDependencies {
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  launch?: (url: string, browser?: string) => Promise<void>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function signature(token: string, payload: string): string {
  return createHmac("sha256", token).update(`${TICKET_CONTEXT}:${payload}`).digest("base64url");
}

export function createOpenTicket(token: string, now = Date.now()): OpenTicket {
  const id = randomBytes(18).toString("base64url");
  const expiresAt = now + OPEN_TICKET_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ id, expiresAt })).toString("base64url");
  return { id, expiresAt, ticket: `${payload}.${signature(token, payload)}` };
}

export function verifyOpenTicket(token: string, ticket: string, now = Date.now()): Omit<OpenTicket, "ticket"> | null {
  if (!TICKET_PATTERN.test(ticket)) return null;
  const [payload, suppliedSignature] = ticket.split(".");
  if (!payload || !suppliedSignature) return null;
  const expectedSignature = signature(token, payload);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const { id, expiresAt } = parsed as Record<string, unknown>;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(id)) return null;
    if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)) return null;
    if (expiresAt < now || expiresAt > now + OPEN_TICKET_TTL_MS) return null;
    return { id, expiresAt };
  } catch {
    return null;
  }
}

export function browserApplicationName(browser: string): string {
  const aliases: Record<string, string> = {
    chrome: "Google Chrome",
    safari: "Safari",
    firefox: "Firefox",
    edge: "Microsoft Edge",
    brave: "Brave Browser",
    arc: "Arc",
  };
  return aliases[browser.toLowerCase()] || browser;
}

export async function launchBrowser(url: string, browser?: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("opening a browser is currently supported on macOS only");
  const application = browser ? browserApplicationName(browser) : null;
  const command = application ? ["/usr/bin/open", "-a", application, url] : ["/usr/bin/open", url];
  const processHandle = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `browser handoff failed (${exitCode})`);
}

async function readOpenStatus(
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  baseUrl: string,
  token: string,
  ticket: string,
): Promise<boolean> {
  const response = await fetcher(`${baseUrl}/api/open/status`, {
    cache: "no-store",
    headers: {
      "X-SessionMap-Token": token,
      "X-SessionMap-Open-Ticket": ticket,
    },
  });
  const payload = await response.json().catch(() => null) as { ready?: boolean; error?: string } | null;
  if (!response.ok) throw new Error(payload?.error || `open status failed (${response.status})`);
  return payload?.ready === true;
}

export async function openSessionMap(
  options: OpenSessionOptions,
  dependencies: OpenSessionDependencies = {},
): Promise<void> {
  const fetcher = dependencies.fetch ?? fetch;
  const launch = dependencies.launch ?? launchBrowser;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  const openTicket = createOpenTicket(options.token, now());

  // Register before handing off so a fast page can acknowledge immediately.
  try {
    await readOpenStatus(fetcher, options.baseUrl, options.token, openTicket.ticket);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`SessionMap service could not register a browser open request${detail}`);
  }
  await launch(`${options.baseUrl}/#open=${encodeURIComponent(openTicket.ticket)}`, options.browser);

  const deadline = now() + OPEN_ACK_TIMEOUT_MS;
  let lastError: unknown;
  while (now() < deadline) {
    try {
      if (await readOpenStatus(fetcher, options.baseUrl, options.token, openTicket.ticket)) return;
      lastError = undefined;
    } catch (error) {
      // The launch agent may restart while the browser is loading. The signed
      // ticket can register itself again after the service returns.
      lastError = error;
    }
    await sleep(OPEN_POLL_MS);
  }
  const detail = lastError instanceof Error ? ` Last status: ${lastError.message}.` : "";
  throw new Error(
    `browser accepted the URL but SessionMap did not become visible.${detail} Retry with sessionmap open --browser BROWSER`,
  );
}
