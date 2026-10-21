import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { Translator } from './i18n';
import { IconButton } from './ui';

export function CopyButton({ text, onCopy, t }: { text: string; onCopy: (text: string) => Promise<void>; t: Translator }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <IconButton label={t(copied ? 'copied' : 'copy')} onClick={() => {
    void onCopy(text).then(() => { setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800); }).catch(() => {});
  }}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconButton>;
}
