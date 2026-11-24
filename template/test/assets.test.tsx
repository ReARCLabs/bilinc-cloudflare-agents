import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_LINE, Lockup } from "../src/client/brand";
import { Icon, Spinner } from "../src/client/icons";

// Tests run from the template directory (npm test).
const path = (p: string) => resolve(process.cwd(), p);
const read = (p: string) => readFileSync(path(p), "utf8");
const FONTS = ["src/client/assets/fonts/archivo-latin.woff2", "src/client/assets/fonts/azeret-mono-latin.woff2"];

afterEach(cleanup);

describe("vendored assets", () => {
  it("keeps both fonts within the 70 KB budget, each with its OFL text", () => {
    const total = FONTS.reduce((sum, file) => sum + statSync(path(file)).size, 0);
    expect(total).toBeGreaterThan(20_000);
    expect(total).toBeLessThanOrEqual(70_000);
    expect(read("src/client/assets/fonts/OFL-Archivo.txt")).toContain("SIL Open Font License, Version 1.1");
    expect(read("src/client/assets/fonts/OFL-AzeretMono.txt")).toContain("SIL Open Font License, Version 1.1");
  });

  it("names every third-party source in NOTICE", () => {
    const notice = read("NOTICE");
    for (const phrase of [
      "Archivo",
      "Azeret Mono",
      "SIL Open Font License 1.1",
      "Copyright (c) 2020 Phosphor Icons",
      "Kokonut UI",
      "rebuilt from scratch",
      "trademarks of Cloudflare, Inc.",
      "not affiliated with or endorsed by Cloudflare",
    ]) {
      expect(notice).toContain(phrase);
    }
  });

  it("defines the spec tokens, background A and reduced motion", () => {
    const css = read("src/client/styles/base.css");
    for (const token of [
      "--bg: #070b14;",
      "--glass: #e8eef2;",
      "--added: #5ce1e6;",
      "--changed: #e9b45f;",
      "--removed: #ff6b57;",
      "--g3: rgba(232, 238, 242, 0.55);",
      "#e98a3a 100%",
      "prefers-reduced-motion: reduce",
    ]) {
      expect(css).toContain(token);
    }
    expect(read("src/client/styles.css")).toContain('@import "./styles/base.css";');
  });

  it("titles the page Bilinc Memory and keeps the app root", () => {
    const html = read("index.html");
    expect(html).toContain("<title>Bilinc Memory</title>");
    expect(html).toContain('<div id="root"></div>');
  });
});

describe("Lockup", () => {
  it("shows the symbol, the name and the Cloudflare logo line", () => {
    render(<Lockup as="h1" />);
    expect(screen.getByRole("heading", { level: 1, name: "Bilinc Memory" })).toBeTruthy();
    expect(screen.getByAltText("Bilinc")).toBeTruthy();
    expect(screen.getByAltText("Cloudflare")).toBeTruthy();
    expect(AGENT_LINE.kind).toBe("logo");
  });

  it("swaps the logo for text with one constant", () => {
    render(<Lockup line={{ kind: "text", text: "for Cloudflare Agents" }} />);
    expect(screen.getByText("for Cloudflare Agents")).toBeTruthy();
    expect(screen.queryByAltText("Cloudflare")).toBeNull();
  });
});

describe("icons", () => {
  it("draws hidden Phosphor paths on a 256 grid and a hidden spinner", () => {
    const { container } = render(
      <>
        <Icon name="history" />
        <Spinner tone="wait" />
      </>,
    );
    const svgs = [...container.querySelectorAll("svg")];
    expect(svgs).toHaveLength(2);
    expect(svgs[0]!.getAttribute("viewBox")).toBe("0 0 256 256");
    for (const svg of svgs) expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".spin")).toBeTruthy();
  });
});
