import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { API_URL, BASE_URL } from "./support/env";

/**
 * The README's animated image: a real execution of the demo's "Support triage" agent (DeepSeek),
 * from the Run button to its last step, recorded frame by frame with Chrome's screencast and
 * encoded with ffmpeg. Needs DEMO_PASSWORD, a demo seeded with a DeepSeek key, and ffmpeg;
 * skipped otherwise. Writes ../docs/images/execution-live.gif.
 */
const OUT = "../docs/images/execution-live.gif";
const FRAMES = "e2e/tmp/execution-gif";
const VIEWPORT = { width: 1440, height: 960 };
const GIF_WIDTH = 1100;
const HOLD_SECONDS = 3;
const TICKET =
  "Ticket #5102: “I was charged 49 USD twice, on Oct 3 and Oct 5.” Classify it, then work out the refund and the days between the two charges.";
const password = process.env.DEMO_PASSWORD;

type Agent = { id: string; name: string; version: { provider_kind: string | null } | null };

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Headless Chrome draws no pointer: this one follows the mouse, so the clicks can be seen. */
function drawPointer() {
  const pointer = document.createElement("div");
  pointer.setAttribute("aria-hidden", "true");
  pointer.style.cssText =
    "position:fixed;left:-3px;top:-2px;z-index:2147483647;pointer-events:none;transition:transform 50ms linear";
  pointer.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M3 2v17l4.5-4 3 7 2.5-1-3-7h6.5z" fill="#fff" stroke="#0b0d12" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.addEventListener(
    "mousemove",
    (event) => {
      pointer.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
    },
    true,
  );
  document.addEventListener(
    "mousedown",
    (event) => {
      const ring = document.createElement("div");
      ring.style.cssText = `position:fixed;left:${event.clientX - 14}px;top:${event.clientY - 14}px;width:28px;height:28px;border-radius:50%;border:2px solid #fff;z-index:2147483646;pointer-events:none`;
      document.body.append(ring);
      ring.animate(
        [
          { transform: "scale(0.5)", opacity: 0.9 },
          { transform: "scale(1.5)", opacity: 0 },
        ],
        { duration: 450, easing: "ease-out" },
      ).onfinish = () => ring.remove();
    },
    true,
  );
  const attach = () => document.body.append(pointer);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach);
  else attach();
}

/** Glides the pointer to the middle of an element, then clicks it. */
async function clickSlowly(page: Page, target: ReturnType<Page["locator"]>): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("Nothing to click");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.mouse.up();
}

test("record the README execution GIF", async ({ browser }) => {
  test.skip(!password, "DEMO_PASSWORD is not set");
  test.skip(!hasFfmpeg(), "ffmpeg is not installed");
  test.setTimeout(240_000);

  const login = await fetch(`${API_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ email: "demo@gouvra.dev", password }),
  });
  expect(login.ok).toBe(true);
  const cookies = login.headers.getSetCookie().map((header) => {
    const [pair = ""] = header.split(";");
    const index = pair.indexOf("=");
    return { name: pair.slice(0, index), value: pair.slice(index + 1) };
  });
  const auth = { headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") } };
  const session = (await (await fetch(`${API_URL}/api/v1/auth/session`, auth)).json()) as {
    workspaces: { id: string; slug: string }[];
  };
  const workspace = session.workspaces.find((w) => w.slug === "demo")?.id ?? "";
  const agents = (await (
    await fetch(`${API_URL}/api/v1/workspaces/${workspace}/agents?limit=100`, auth)
  ).json()) as { data: Agent[] };
  const triage = agents.data.find((agent) => agent.name === "Support triage");
  test.skip(triage?.version?.provider_kind !== "deepseek", "the demo has no DeepSeek agent");

  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: "dark",
    deviceScaleFactor: 1,
    locale: "en-US",
  });
  const { hostname } = new URL(BASE_URL);
  await context.addCookies(
    cookies.map((c) => ({
      ...c,
      domain: hostname,
      path: "/",
      secure: c.name.startsWith("__Host-"),
      httpOnly: !c.name.endsWith("csrf"),
      sameSite: "Lax" as const,
    })),
  );
  await context.addInitScript(drawPointer);
  const page = await context.newPage();
  await page.goto(`/w/demo/agents/${triage?.id ?? ""}`);
  await expect(page.getByRole("heading", { level: 1, name: "Support triage" })).toBeVisible();
  await page.mouse.move(VIEWPORT.width * 0.62, VIEWPORT.height * 0.55);
  await page.waitForTimeout(1500);

  // Frames arrive only when the page repaints: each keeps its timestamp, for its duration.
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  const stamps: number[] = [];
  const cdp = await context.newCDPSession(page);
  cdp.on("Page.screencastFrame", (frame) => {
    const name = `${FRAMES}/f-${String(stamps.length).padStart(5, "0")}.png`;
    writeFileSync(name, Buffer.from(frame.data, "base64"));
    stamps.push(frame.metadata.timestamp ?? Date.now() / 1000);
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  await page.waitForTimeout(800);

  await clickSlowly(page, page.getByRole("button", { name: "Run", exact: true }));
  const dialog = page.getByRole("dialog");
  const input = dialog.getByRole("textbox", { name: "Input" });
  await expect(input).toBeVisible();
  await page.waitForTimeout(200);
  // Pasted, as a ticket would be: typed, it would take most of the GIF.
  await clickSlowly(page, input);
  await input.fill(TICKET);
  await page.waitForTimeout(700);
  await clickSlowly(page, dialog.getByRole("button", { name: "Run", exact: true }));

  await page.waitForURL(/\/executions\/[0-9a-f-]{36}$/);
  const executionId = page.url().split("/").pop() ?? "";
  // The pointer rests in the header's empty corner: clear of the trace, and of the toast
  // (hovering a toast keeps it open).
  await page.mouse.move(VIEWPORT.width - 140, 116, { steps: 10 });
  await expect
    .poll(
      async () =>
        (
          (await (await fetch(`${API_URL}/api/v1/executions/${executionId}`, auth)).json()) as {
            status: string;
          }
        ).status,
      { timeout: 150_000, intervals: [500] },
    )
    .toBe("succeeded");
  await expect(page.getByText("Succeeded", { exact: true }).first()).toBeVisible();
  await page.waitForTimeout(300);
  await cdp.send("Page.stopScreencast");
  await context.close();
  expect(stamps.length).toBeGreaterThan(20);

  // A variable frame rate (concat durations), the last frame held, then a palette drawn from
  // what changes.
  const lines = ["ffconcat version 1.0"];
  stamps.forEach((stamp, index) => {
    lines.push(`file 'f-${String(index).padStart(5, "0")}.png'`);
    if (index < stamps.length - 1) lines.push(`duration ${(stamps[index + 1] - stamp).toFixed(3)}`);
  });
  writeFileSync(`${FRAMES}/frames.txt`, lines.join("\n") + "\n");
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-i",
    `${FRAMES}/frames.txt`,
    "-vf",
    `fps=12,tpad=stop_mode=clone:stop_duration=${HOLD_SECONDS},scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    "-loop",
    "0",
    OUT,
  ]);
});
