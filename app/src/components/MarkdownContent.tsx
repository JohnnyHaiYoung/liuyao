'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * 助手内容的 Markdown 渲染。
 *
 * 安全取舍：
 * - react-markdown 默认不渲染原始 HTML（不开启 rehype-raw），因此模型返回的
 *   <script>/<img onerror> 之类内容只会当作文本，不会执行。
 * - 链接只允许 http/https 且强制 target=_blank + rel="noopener noreferrer"，
 *   阻止 javascript: 等协议和 window.opener 劫持。
 * - 图片不直接加载（避免模型插入的任意远程地址被自动请求），显示为可点击链接。
 */
export function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            const safe = typeof href === 'string' && /^https?:\/\//i.test(href);
            if (!safe) {
              return <span>{children}</span>;
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                {children}
              </a>
            );
          },
          img({ src, alt }) {
            const label = typeof alt === 'string' && alt !== '' ? alt : '图片';
            const safe = typeof src === 'string' && /^https?:\/\//i.test(src);
            if (!safe) return <span>[{label}]</span>;
            return (
              <a href={src} target="_blank" rel="noopener noreferrer nofollow">
                [{label}]
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
