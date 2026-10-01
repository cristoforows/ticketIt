import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown";

afterEach(cleanup);

function renderReport(body: string) {
  const { container } = render(<Markdown data-testid="report">{body}</Markdown>);
  return container;
}

describe("Markdown", () => {
  it("renders headings, lists, emphasis, code and safe links", () => {
    renderReport("# Result\n\n## Findings\n\n- **one**\n- `two`\n\n1. first\n\n> quoted\n\n[docs](https://example.com/a) and [mail](mailto:a@example.com)\n");
    expect(screen.getByRole("heading", { level: 1, name: "Result" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Findings" })).toBeInTheDocument();
    expect(screen.getAllByRole("list")).toHaveLength(2);
    expect(screen.getByText("one").tagName).toBe("STRONG");
    expect(screen.getByText("two").tagName).toBe("CODE");
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("href", "https://example.com/a");
    expect(screen.getByRole("link", { name: "mail" })).toHaveAttribute("href", "mailto:a@example.com");
  });

  it("never renders raw HTML, inline or as a block", () => {
    const container = renderReport('Before <b>bold</b> after\n\n<script>window.pwned = true</script>\n\n<img src="x" onerror="window.pwned = true">\n\n<div onclick="x()">block</div>\n\n<iframe src="https://example.com"></iframe>\n');
    for (const tag of ["script", "img", "iframe", "b", "div div"]) {
      expect(screen.getByTestId("report").querySelector(tag)).toBeNull();
    }
    expect(container.innerHTML).not.toMatch(/onerror|onclick/);
    expect((window as { pwned?: boolean }).pwned).toBeUndefined();
    expect(screen.getByTestId("report")).toHaveTextContent("Before bold after");
  });

  it.each([
    ["javascript:", "[click](javascript:alert(1))"],
    ["upper-case JavaScript:", "[click](JavaScript:alert(1))"],
    ["entity-encoded javascript:", "[click](&#106;avascript:alert(1))"],
    ["vbscript:", "[click](vbscript:msgbox(1))"],
    ["data:", "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)"],
    ["reference-style javascript:", "[click][x]\n\n[x]: javascript:alert(1)"],
  ])("neutralises a link using %s", (_name, body) => {
    renderReport(body);
    const link = screen.getByText("click").closest("a");
    expect(link?.getAttribute("href") ?? "").not.toMatch(/^\s*(javascript|vbscript|data):/i);
  });

  it("keeps an image with a safe source", () => {
    const container = renderReport("![chart](https://example.com/chart.png)\n");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/chart.png");
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("chart");
  });

  it("neutralises a javascript: image source and autolink", () => {
    const container = renderReport("![pic](javascript:alert(1))\n\n<javascript:alert(1)>\n");
    expect(container.querySelector("img")).toBeNull();
    for (const element of container.querySelectorAll("[src], [href]")) {
      expect(element.getAttribute("src") ?? element.getAttribute("href")).not.toMatch(/^\s*javascript:/i);
    }
  });
});
