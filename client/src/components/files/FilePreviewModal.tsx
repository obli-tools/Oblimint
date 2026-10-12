import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Download, Eye } from 'lucide-react';
import { Modal } from '@/components/common/Modal';
import { IconButton } from '@/components/common/IconButton';
import { fileContentUrl, filesApi } from '@/api/files.api';
import { baseName, previewKind } from './fileFormat';

/**
 * Media preview (image / video / audio / PDF) served inline by the panel
 * (sandboxed, never HTML or SVG). ←/→ go through the previewable files of the
 * folder.
 */
export function FilePreviewModal({ accountId, path, siblings, onNavigate, onClose }: {
  accountId: number;
  path: string;
  /** Previewable files of the folder (paths), for ←/→. */
  siblings: string[];
  onNavigate: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const kind = previewKind(baseName(path));
  const url = fileContentUrl(accountId, path, true);
  const i = siblings.indexOf(path);
  const prev = i > 0 ? siblings[i - 1] : null;
  const next = i >= 0 && i < siblings.length - 1 ? siblings[i + 1] : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && prev) { e.preventDefault(); onNavigate(prev); }
      if (e.key === 'ArrowRight' && next) { e.preventDefault(); onNavigate(next); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, onNavigate, prev]);

  return (
    <Modal
      open
      onClose={onClose}
      size="2xl"
      icon={<Eye className="h-4 w-4 text-accent" />}
      title={<span className="font-mono text-sm">{baseName(path)}</span>}
      headerExtra={(
        <div className="flex items-center gap-1">
          {siblings.length > 1 && <span className="mr-1 font-mono text-[11px] text-text-muted">{i + 1} / {siblings.length}</span>}
          <IconButton label={t('files.preview.previous') || 'Previous'} icon={<ChevronLeft className="h-4 w-4" />} disabled={!prev} onClick={() => prev && onNavigate(prev)} />
          <IconButton label={t('files.preview.next') || 'Next'} icon={<ChevronRight className="h-4 w-4" />} disabled={!next} onClick={() => next && onNavigate(next)} />
          <IconButton label={t('files.actions.download') || 'Download'} icon={<Download className="h-4 w-4" />} onClick={() => void filesApi.download(accountId, path)} />
        </div>
      )}
      bodyClassName="p-0"
    >
      <div className="flex min-h-[40vh] items-center justify-center bg-bg-primary/60 p-3">
        {kind === 'image' && <img key={url} src={url} alt={baseName(path)} className="max-h-[75vh] max-w-full rounded-lg object-contain" />}
        {kind === 'video' && <video key={url} src={url} controls autoPlay className="max-h-[75vh] max-w-full rounded-lg" />}
        {kind === 'audio' && <audio key={url} src={url} controls autoPlay className="w-full max-w-xl" />}
        {kind === 'pdf' && <iframe key={url} src={url} title={baseName(path)} className="h-[75vh] w-full rounded-lg bg-white" />}
      </div>
    </Modal>
  );
}
