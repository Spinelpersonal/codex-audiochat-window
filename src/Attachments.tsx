import { useState } from 'react';
import { FileCode2, FileText, Image as ImageIcon, X } from 'lucide-react';
import type { Attachment } from '../shared/types';
import type { Translator } from './i18n';
import { formatBytes, safeImageSource } from './model';
import { IconButton, Modal } from './ui';

export function Attachments({ attachments, onRemove, t }: { attachments: Attachment[]; onRemove?: (id: string) => void; t: Translator }) {
  const [preview, setPreview] = useState<Attachment | null>(null);
  if (!attachments.length) return null;
  return <>
    <ul className="attachments" aria-label={t('attachments')}>
      {attachments.map((attachment) => {
        const src = safeImageSource(attachment.preview);
        const Icon = attachment.kind === 'image' ? ImageIcon : attachment.kind === 'pdf' ? FileText : FileCode2;
        return <li key={attachment.id} className="attachment">
          <button type="button" className="attachment-preview" title={`${t('attachmentPreview')}: ${attachment.name}`} onClick={() => setPreview(attachment)}>
            {src ? <img src={src} alt="" /> : <span className="attachment-icon"><Icon size={19} /></span>}
            <span className="attachment-info"><span>{attachment.name}</span><small>{attachment.kind.toUpperCase()} · {formatBytes(attachment.size)}</small></span>
          </button>
          {onRemove && <IconButton label={`${t('removeAttachment')}: ${attachment.name}`} onClick={() => onRemove(attachment.id)}><X size={13} /></IconButton>}
        </li>;
      })}
    </ul>
    {preview && <Modal title={preview.name} onClose={() => setPreview(null)} t={t} className="preview-modal">
      {safeImageSource(preview.preview) ? <img className="large-preview" src={safeImageSource(preview.preview)} alt={preview.name} />
        : preview.kind !== 'image' && preview.preview ? <pre className="text-preview">{preview.preview}</pre>
          : <div className="file-preview"><FileText size={38} /><strong>{preview.name}</strong><span>{preview.kind.toUpperCase()} · {formatBytes(preview.size)}</span>{preview.kind === 'image' && <p>{t('imageUnavailable')}</p>}</div>}
    </Modal>}
  </>;
}
