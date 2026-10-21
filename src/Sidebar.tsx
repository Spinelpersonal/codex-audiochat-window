import { useState } from 'react';
import { Download, Pencil, Plus, Search, Settings2, Trash2 } from 'lucide-react';
import type { Conversation } from '../shared/types';
import type { OverlayController } from './useOverlay';
import { isRunning, errorMessage } from './model';
import { IconButton, Modal, ModeIcon, Spinner } from './ui';

export function Sidebar({ controller: c, onSettings, onSelect }: { controller: OverlayController; onSettings: () => void; onSelect: () => void }) {
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<{ type: 'rename' | 'delete'; conversation: Conversation } | null>(null);
  const [title, setTitle] = useState('');
  const [pending, setPending] = useState(false);
  const { t } = c;
  const filtered = c.conversations.filter((item) => item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const submit = async () => {
    if (!dialog || pending || (dialog.type === 'rename' && !title.trim())) return;
    setPending(true);
    try {
      if (dialog.type === 'rename') await c.renameConversation(dialog.conversation.id, title.trim());
      else await c.deleteConversation(dialog.conversation.id);
      setDialog(null);
    } catch (error) { c.notify(errorMessage(error)); }
    finally { setPending(false); }
  };
  const closeDialog = () => { if (!pending) setDialog(null); };
  return <aside className="sidebar" aria-label={t('conversations')}>
    <div className="sidebar-top"><button type="button" className="button new-conversation" onClick={() => void c.run(async () => { await c.newConversation(); onSelect(); })}><Plus size={16} />{t('newChat')}<kbd>Ctrl N</kbd></button>
      <div className="conversation-search"><Search size={14} /><input type="search" aria-label={t('searchConversations')} placeholder={t('searchConversations')} value={search} onChange={(event) => setSearch(event.target.value)} /></div>
    </div>
    <div className="sidebar-heading">{t('conversations')}<span>{c.conversations.length}</span></div>
    <div className="conversation-list">
      {filtered.length ? filtered.map((conversation) => {
        const running = isRunning(c.requests[conversation.id]?.status);
        return <div key={conversation.id} className={`conversation-item ${c.activeId === conversation.id ? 'is-active' : ''}`}>
          <button type="button" className="conversation-select" aria-current={c.activeId === conversation.id ? 'true' : undefined} onClick={() => { c.selectConversation(conversation); onSelect(); }} title={conversation.title || t('untitled')}>
            {running ? <Spinner size={14} /> : <ModeIcon mode={conversation.mode} size={14} />}<span>{conversation.title || t('untitled')}</span>
          </button>
          <div className="conversation-meta"><time dateTime={conversation.updatedAt}>{new Date(conversation.updatedAt).toLocaleDateString(c.bootstrap?.settings.general.language === 'de' ? 'de-DE' : 'en-US', { month: 'short', day: 'numeric' })}</time>
            <div className="conversation-actions"><IconButton label={t('rename')} onClick={() => { setTitle(conversation.title); setDialog({ type: 'rename', conversation }); }}><Pencil size={12} /></IconButton><IconButton label={t('export')} onClick={() => void c.run(() => c.api!.exportConversation(conversation.id))}><Download size={12} /></IconButton><IconButton label={t('delete')} disabled={running} onClick={() => setDialog({ type: 'delete', conversation })}><Trash2 size={12} /></IconButton></div>
          </div>
        </div>;
      }) : <p className="sidebar-empty">{t(search ? 'noResults' : 'noConversations')}</p>}
    </div>
    <footer className="sidebar-footer"><button type="button" onClick={onSettings}><Settings2 size={16} />{t('settings')}</button><div className="sidebar-brand"><span className="brand-mark small">⌘</span><span>Codex Overlay<small>{t('privacy')}</small></span></div></footer>
    {dialog && <Modal title={t(dialog.type === 'rename' ? 'renameTitle' : 'deleteTitle')} t={t} onClose={closeDialog}>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {dialog.type === 'rename' ? <div className="modal-field"><label htmlFor="conversation-title">{t('conversationTitle')}</label><input id="conversation-title" value={title} maxLength={160} autoFocus onChange={(event) => setTitle(event.target.value)} disabled={pending} /></div> : <p className="modal-copy">{t('deleteBody')}<strong className="delete-conversation-name">{dialog.conversation.title}</strong></p>}
        <div className="modal-actions"><button type="button" className="button secondary" disabled={pending} onClick={closeDialog}>{t('cancel')}</button><button type="submit" className={`button ${dialog.type === 'delete' ? 'danger' : 'primary'}`} disabled={pending || (dialog.type === 'rename' && !title.trim())}>{pending && <Spinner size={14} />}{t(dialog.type === 'rename' ? 'rename' : 'delete')}</button></div>
      </form>
    </Modal>}
  </aside>;
}
