import { Children, isValidElement, memo, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy, Image as ImageIcon } from 'lucide-react';
import type { Translator } from './i18n';

function textContent(children: ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    return isValidElement<{ children?: ReactNode }>(child) ? textContent(child.props.children) : '';
  }).join('');
}
function CodeBlock({ children, onCopy, t }: { children: ReactNode; onCopy: (text: string) => Promise<void>; t: Translator }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const code = Children.toArray(children).find((child) => isValidElement(child));
  const className = isValidElement<{ className?: string }>(code) ? code.props.className : '';
  const language = className?.match(/language-([^\s]+)/)?.[1];
  return <div className="code-block">
    <div className="code-toolbar"><span>{language ?? t('code')}</span><button type="button" onClick={() => {
      void onCopy(textContent(children).replace(/\n$/, '')).then(() => {
        setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800);
      }).catch(() => { /* The bridge caller reports copy errors. */ });
    }} aria-label={t('copyCode')} title={t('copyCode')}>{copied ? <Check size={13} /> : <Copy size={13} />}{t(copied ? 'copied' : 'copy')}</button></div>
    <pre>{children}</pre>
  </div>;
}

export const Markdown = memo(function Markdown({ text, onCopy, t }: { text: string; onCopy: (text: string) => Promise<void>; t: Translator }) {
  return <div className="markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false }]]}
    components={{
      pre: ({ children }) => <CodeBlock onCopy={onCopy} t={t}>{children}</CodeBlock>,
      a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      img: ({ alt }) => <span className="markdown-image"><ImageIcon size={14} aria-hidden="true" />{alt || t('attachmentPreview')}</span>,
      table: ({ children }) => <div className="table-scroll" tabIndex={0}><table>{children}</table></div>,
    }}>{text}</ReactMarkdown></div>;
});

