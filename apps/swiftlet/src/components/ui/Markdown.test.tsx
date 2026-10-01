import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Markdown } from "./Markdown";

afterEach(cleanup);

async function renderReport(body: string) {
  const { container } = render(<Markdown data-testid="report">{body}</Markdown>);
  await waitFor(() => expect(screen.queryByTestId("markdown-loading")).toBeNull());
  return container;
}

const unsafeLinks = [
  ["javascript:", "[click](javascript:alert(1))"],
  ["upper-case JavaScript:", "[click](JavaScript:alert(1))"],
  ["entity-encoded javascript:", "[click](&#106;avascript:alert(1))"],
  ["vbscript:", "[click](vbscript:msgbox(1))"],
  ["data:", "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)"],
  ["reference-style javascript:", "[click][x]\n\n[x]: javascript:alert(1)"],
];

describe("Markdown", () => {
  // First in the file, so the lazy renderer has not loaded yet.
  it("shows a fallback until the renderer loads, inside the same container", async () => {
    render(<Markdown data-testid="report">{"# Result\n"}</Markdown>);
    expect(screen.getByTestId("report")).toContainElement(screen.getByTestId("markdown-loading"));
    expect(await screen.findByRole("heading", { level: 1, name: "Result" })).toBeInTheDocument();
    expect(screen.queryByTestId("markdown-loading")).toBeNull();
  });

  it("renders headings, lists, emphasis, code and safe links", async () => {
    await renderReport("# Result\n\n## Findings\n\n- **one**\n- `two`\n\n1. first\n\n> quoted\n\n[docs](https://example.com/a) and [mail](mailto:a@example.com)\n");
    expect(screen.getByRole("heading", { level: 1, name: "Result" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Findings" })).toBeInTheDocument();
    expect(screen.getAllByRole("list")).toHaveLength(2);
    expect(screen.getByText("one").tagName).toBe("STRONG");
    expect(screen.getByText("two").tagName).toBe("CODE");
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("href", "https://example.com/a");
    expect(screen.getByRole("link", { name: "mail" })).toHaveAttribute("href", "mailto:a@example.com");
  });

  it("opens every link in a new browsing context with no opener, Referer or endorsement", async () => {
    const container = await renderReport("[docs](https://example.com/a), <https://example.com/auto>, [ref][r] and ![chart](https://example.com/c.png)\n\n[r]: https://example.com/ref\n");
    const links = [...container.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://example.com/a", "https://example.com/auto", "https://example.com/ref", "https://example.com/c.png"]);
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
    }
  });

  it("never renders raw HTML, inline or as a block", async () => {
    const container = await renderReport('Before <b>bold</b> after\n\n<script>window.pwned = true</script>\n\n<img src="x" onerror="window.pwned = true">\n\n<div onclick="x()">block</div>\n\n<iframe src="https://example.com"></iframe>\n');
    for (const tag of ["script", "img", "iframe", "b", "div div"]) {
      expect(screen.getByTestId("report").querySelector(tag)).toBeNull();
    }
    expect(container.innerHTML).not.toMatch(/onerror|onclick/);
    expect((window as { pwned?: boolean }).pwned).toBeUndefined();
    expect(screen.getByTestId("report")).toHaveTextContent("Before bold after");
  });

  it.each(unsafeLinks)("renders a link using %s as its text alone", async (_name, body) => {
    const container = await renderReport(body);
    expect(screen.getByText("click")).toBeInTheDocument();
    expect(container.querySelector("a")).toBeNull();
    expect(container.innerHTML).not.toMatch(/(javascript|vbscript|data):/i);
  });

  it("never fetches an image: it shows the alt text and the source as a link", async () => {
    const container = await renderReport("![tracking chart](https://tracker.example/x.png)\n\n![](https://example.com/y.png)\n");
    expect(container.querySelector("img, picture, source, [src], [srcset]")).toBeNull();
    const [first, second] = [...container.querySelectorAll("[data-markdown-image]")];
    expect(first).toHaveTextContent("tracking chart (https://tracker.example/x.png)");
    expect(first!.querySelector("a")).toHaveAttribute("href", "https://tracker.example/x.png");
    expect(second).toHaveTextContent("Image (https://example.com/y.png)");
  });

  it("shows an image with an unsafe source as its alt text alone", async () => {
    const container = await renderReport("![pic](javascript:alert(1))\n\n<javascript:alert(1)>\n");
    expect(container.querySelector("img, [src]")).toBeNull();
    expect(container.querySelector("[data-markdown-image]")).toHaveTextContent(/^pic$/);
    for (const element of container.querySelectorAll("[href]")) {
      expect(element.getAttribute("href")).not.toMatch(/^\s*javascript:/i);
    }
  });
});
