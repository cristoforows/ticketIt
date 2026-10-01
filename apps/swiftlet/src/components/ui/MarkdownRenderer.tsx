import ReactMarkdown, { type Components } from "react-markdown";

const linkProps = { target: "_blank", rel: "noopener noreferrer nofollow" } as const;

// A Report is runner output: an image is never fetched, since fetching a runner-chosen URL tells its host the Owner opened the Report.
const components: Components = {
  a: ({ node: _node, href, children }) => (href ? <a href={href} {...linkProps}>{children}</a> : <span>{children}</span>),
  img: ({ node: _node, src, alt }) => (
    <span data-markdown-image="">
      {alt || "Image"}
      {typeof src === "string" && src !== "" && <> (<a href={src} {...linkProps}>{src}</a>)</>}
    </span>
  ),
};

export default function MarkdownRenderer({ children }: { children: string }) {
  return <ReactMarkdown skipHtml components={components}>{children}</ReactMarkdown>;
}
