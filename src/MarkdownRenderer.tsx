import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function MarkdownRenderer({
  value,
  transformUrl,
}: {
  value: string;
  transformUrl: (url: string) => string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={transformUrl}
      components={{
        a({ href, children }) {
          if (!href) return <span>{children}</span>;
          const external = /^https?:/i.test(href);
          return (
            <a
              href={href}
              {...(external
                ? { target: "_blank", rel: "noreferrer noopener" }
                : {})}
            >
              {children}
            </a>
          );
        },
      }}
    >
      {value}
    </ReactMarkdown>
  );
}
