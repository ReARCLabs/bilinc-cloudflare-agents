// Screenshots of every state at 1440 px and 390 px, axe (0 serious or critical) on each, and a
// keyboard-only pass through every control. Runs against the fixture page; no Worker, no network.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    __calls: unknown[][];
  }
}

const OUT = process.env.BCA_SCREENS ?? join(import.meta.dirname, "out");
mkdirSync(OUT, { recursive: true });

const WIDTHS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const;

interface Shot {
  name: string;
  state: string;
  act?: (page: Page) => Promise<void>;
  reducedMotion?: boolean;
}

const SHOTS: Shot[] = [
  { name: "unlock", state: "unlock" },
  {
    name: "unlock-error",
    state: "unlock-error",
    act: async (page) => {
      await page.getByLabel("Passphrase").fill("wrong-passphrase-0000");
      await page.getByRole("button", { name: "Unlock" }).click();
      await expect(page.getByText("That passphrase is not right.")).toBeVisible();
    },
  },
  { name: "empty", state: "empty" },
  { name: "thinking", state: "thinking" },
  { name: "steps-running", state: "steps-running" },
  { name: "approval-waiting", state: "approval-waiting" },
  { name: "turn-done", state: "turn-done" },
  { name: "error-step", state: "error-step" },
  { name: "banner", state: "banner" },
  { name: "history-open", state: "turn-done", act: (page) => page.getByRole("button", { name: "History" }).click() },
  { name: "memory-menu-open", state: "empty", act: (page) => page.getByRole("button", { name: "Memory" }).click() },
  { name: "model-panel-open", state: "empty", act: (page) => page.getByRole("button", { name: /^Model:/ }).click() },
  { name: "reduced-motion", state: "approval-waiting", reducedMotion: true },
];

async function open(page: Page, state: string, reducedMotion = false): Promise<void> {
  await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  await page.goto(`/fixtures.html?state=${state}`);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

for (const size of WIDTHS) {
  test.describe(`${size.name} px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    for (const shot of SHOTS) {
      test(shot.name, async ({ page }) => {
        await open(page, shot.state, shot.reducedMotion);
        if (shot.act) await shot.act(page);
        await page.screenshot({ path: join(OUT, `${shot.name}-${size.name}.png`) });
        expect(await seriousViolations(page)).toEqual([]);
        if (shot.reducedMotion) {
          const spin = page.locator(".spin").first();
          expect(await spin.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
          const timer = page.locator(".sh .el").first();
          const before = await timer.textContent();
          await page.waitForTimeout(400);
          expect(await timer.textContent()).not.toBe(before);
        }
        if (size.name === "390" && shot.state !== "unlock" && shot.state !== "unlock-error") {
          await expect(page.locator(".app")).toHaveClass(/is-phone/);
        }
      });
    }
  });
}

test.describe("keyboard only", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const calls = (page: Page) => page.evaluate(() => window.__calls);
  const focusedName = (page: Page) =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.getAttribute("aria-label") ?? el?.textContent?.trim() ?? "";
    });

  test("Tab reaches every control in order", async ({ page }) => {
    await open(page, "empty");
    const names: string[] = [];
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press("Tab");
      names.push(await focusedName(page));
    }
    expect(names).toEqual([
      "History",
      "New chat",
      "Remember that my favourite tea is Earl Grey.",
      "What do you remember about me?",
      "Checkpoint now.",
      "Message",
      "Memory",
      "Model: gpt-oss-120b, Medium reasoning. Change",
      "Ask",
    ]);
  });

  test("History fills the composer and never sends; Escape closes it", async ({ page }) => {
    await open(page, "turn-done");
    await page.getByRole("button", { name: "History" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Checkpoints" })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Message")).toHaveValue('Diff against the checkpoint "Before tea change".');
    await expect(page.getByLabel("Message")).toBeFocused();
    await page.getByRole("button", { name: "History" }).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Checkpoints" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "History" })).toBeFocused();
    expect((await calls(page)).filter((c) => c[0] === "send")).toEqual([]);
  });

  test("the Memory menu opens with / and picks with a number key", async ({ page }) => {
    await open(page, "empty");
    await page.getByLabel("Message").focus();
    await page.keyboard.press("/");
    await expect(page.getByRole("menu", { name: "Memory actions" })).toBeVisible();
    await page.keyboard.press("3");
    await expect(page.getByLabel("Message")).toHaveValue("Checkpoint now.");
    await expect(page.getByText("Checkpoint: a point you can return to · 2 credits")).toBeVisible();
    expect((await calls(page)).filter((c) => c[0] === "send")).toEqual([]);
  });

  test("the model panel works with arrows and Escape", async ({ page }) => {
    await open(page, "empty");
    const trigger = page.getByRole("button", { name: /^Model:/ });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("radio", { name: /gpt-oss-120b/ })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("radio", { name: /gpt-oss-20b/ })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("slider", { name: "Reasoning" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("slider", { name: "Reasoning" })).toHaveAttribute("aria-valuetext", "High");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Model" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Model: gpt-oss-20b, High reasoning. Change" })).toBeFocused();
    expect(await calls(page)).toContainEqual(["choice", "@cf/openai/gpt-oss-20b", "high"]);
  });

  test("the approval step works from the keyboard", async ({ page }) => {
    await open(page, "approval-waiting");
    await page.getByRole("button", { name: "Roll back" }).focus();
    await page.keyboard.press("Enter");
    await page.getByLabel("Reason for rejecting (optional)").focus();
    await page.keyboard.type("keep it");
    await page.keyboard.press("Enter");
    expect(await calls(page)).toEqual(expect.arrayContaining([["approve", "ap1"], ["reject", "r1", "keep it"]]));
  });

  test("Enter sends and Shift+Enter adds a line", async ({ page }) => {
    await open(page, "empty");
    await page.getByLabel("Message").focus();
    await page.keyboard.type("first line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second line");
    await page.keyboard.press("Enter");
    expect((await calls(page)).filter((c) => c[0] === "send")).toEqual([["send", "first line\nsecond line"]]);
  });
});
