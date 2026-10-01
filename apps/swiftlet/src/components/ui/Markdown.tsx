import { lazy, Suspense, type ComponentPropsWithRef } from "react";
import { cn } from "./cn";

const MarkdownRenderer = lazy(() => import("./MarkdownRenderer"));

const markdown = cn(
  "min-w-0 break-words text-body text-ink",
  "[&>*]:my-2 [&>:first-child]:mt-0 [&>:last-child]:mb-0",
  "[&_h1]:text-title [&_h1]:font-bold [&_h2]:text-body [&_h2]:font-bold [&_h2]:tracking-label [&_h2]:uppercase",
  "[&_h3]:font-bold [&_h4]:font-bold [&_h5]:font-bold [&_h6]:font-bold",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mt-0 [&_li]:border-t-0 [&_li]:pt-0",
  "[&_a]:text-ink [&_a]:underline",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-muted [&_blockquote]:pl-3 [&_blockquote]:text-muted",
  "[&_code]:rounded-tag [&_code]:border [&_code]:border-rule [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:border [&_pre]:border-rule [&_pre]:p-2 [&_pre_code]:border-0 [&_pre_code]:p-0",
  "[&_hr]:border-dashed [&_hr]:border-rule",
);

export function Markdown({ children, className, ...rest }: { children: string } & Omit<ComponentPropsWithRef<"div">, "children">) {
  return (
    <div className={cn(markdown, className)} {...rest}>
      <Suspense fallback={<p data-testid="markdown-loading" className="text-muted">Loading…</p>}>
        <MarkdownRenderer>{children}</MarkdownRenderer>
      </Suspense>
    </div>
  );
}
