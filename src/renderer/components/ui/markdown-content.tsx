import { useMemo, type AnchorHTMLAttributes, type CSSProperties, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../lib/utils';

/** Link that only follows http(s) and in-app links; external ones open in a new window */
function createSafeLink(opensInNewWindowText: string) {
  return function SafeLink({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
    const isValidUrl = href && (
      href.startsWith('http://') ||
      href.startsWith('https://') ||
      href.startsWith('/') ||
      href.startsWith('#')
    );

    if (!isValidUrl) {
      // For invalid or potentially malicious URLs, render as plain text
      return <span className="text-muted-foreground">{children}</span>;
    }

    const isExternal = href.startsWith('http://') || href.startsWith('https://');
    return (
      <a
        href={href}
        {...props}
        {...(isExternal && {
          target: '_blank',
          rel: 'noopener noreferrer',
        })}
        className="text-primary hover:underline"
      >
        {children}
        {isExternal && <span className="sr-only"> {opensInNewWindowText}</span>}
      </a>
    );
  };
}

interface MarkdownContentProps {
  children: string;
  className?: string;
  id?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
}

/** Markdown as the Claude chat shows it (replies, task descriptions) */
export function MarkdownContent({ children, className, id, style, ref }: MarkdownContentProps) {
  const { t } = useTranslation('common');
  const components = useMemo<Components>(() => ({ a: createSafeLink(t('accessibility.opensInNewWindow')) }), [t]);

  return (
    <div
      ref={ref}
      id={id}
      style={style}
      className={cn('prose prose-sm dark:prose-invert max-w-none text-[0.9375rem] leading-relaxed text-foreground', className)}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
