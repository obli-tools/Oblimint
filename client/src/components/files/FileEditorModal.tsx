import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import axios from 'axios';
import { Download, FileCode, Save } from 'lucide-react';
import type { FileText } from '@oblimint/shared';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { CodeEditor } from '@/components/apps/CodeEditor';
import { filesApi, writeFileContent } from '@/api/files.api';
import { formatBytes } from '@/components/usage/usageFormat';
import { baseName, languageOf, parentPath } from './fileFormat';

function apiError(err: unknown): { code?: string; message: string } {
  if (axios.isAxiosError(err)) {
    const d = err.response?.data as { code?: string; error?: string } | undefined;
    return { code: d?.code, message: d?.error || err.message };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

/**
 * Integrated text editor (CodeMirror, language from the extension): Ctrl/⌘+S
 * saves, a save is refused when the file changed since it was opened (the
 * user can reload or overwrite), closing with unsaved changes asks first.
 */
export function FileEditorModal({ accountId, path, readOnly, onClose, onSaved }: {
  accountId: number;
  path: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [file, setFile] = useState<FileText | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = file?.content != null && value !== file.content;

  const load = useCallback(async () => {
    setError(null);
    try {
      const f = await filesApi.readText(accountId, path);
      setFile(f);
      setValue(f.content ?? '');
    } catch (err) {
      setError(apiError(err).message);
    }
  }, [accountId, path]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (force = false) => {
    if (!file || readOnly || saving) return;
    setSaving(true);
    try {
      const blob = new Blob([value], { type: 'text/plain' });
      await writeFileContent(accountId, path, blob, force ? { overwrite: true } : { expectedMtime: file.mtime });
      // New mtime / size: re-read the entry from its folder.
      const listing = await filesApi.list(accountId, parentPath(path));
      const e = listing.entries.find((x) => x.name === baseName(path));
      setFile({ ...file, content: value, size: blob.size, mtime: e?.mtime ?? Date.now() });
      toast.success(t('files.editor.saved') || 'Saved');
      onSaved?.();
    } catch (err) {
      const e = apiError(err);
      if (e.code === 'fileChanged') {
        const overwrite = await confirm({
          title: t('files.editor.changedTitle') || 'File changed on the server',
          message: t('files.editor.changedMessage') || 'The file was modified since you opened it (SFTP, another tab…). Overwrite it with your version?',
          confirmLabel: t('files.editor.overwrite') || 'Overwrite',
          danger: true,
        });
        setSaving(false);
        if (overwrite) void save(true);
        return;
      }
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }, [accountId, confirm, file, onSaved, path, readOnly, saving, t, value]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const close = async () => {
    if (dirty && !(await confirm({
      title: t('files.editor.unsavedTitle') || 'Unsaved changes',
      message: t('files.editor.unsavedMessage') || 'Close the editor and lose your changes?',
      confirmLabel: t('files.editor.discard') || 'Discard',
      danger: true,
    }))) return;
    onClose();
  };

  const body = () => {
    if (error) return <p className="p-6 text-sm text-status-down">{error}</p>;
    if (!file) return <div className="flex h-full items-center justify-center"><LoadingSpinner /></div>;
    if (file.content == null) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-text-secondary">
          <FileCode className="h-8 w-8 text-text-muted" />
          <p>{file.binary
            ? (t('files.editor.binary') || 'This file looks binary: it cannot be edited here.')
            : t('files.editor.tooLarge', { size: formatBytes(file.size), defaultValue: 'This file is too large for the editor ({{size}}, 2 MB max).' })}</p>
          <Button variant="secondary" size="sm" onClick={() => void filesApi.download(accountId, path)}>
            <Download className="mr-1.5 h-4 w-4" />{t('files.actions.download') || 'Download'}
          </Button>
        </div>
      );
    }
    return (
      <CodeEditor
        value={value}
        onChange={setValue}
        readOnly={readOnly}
        language={languageOf(baseName(path))}
        height="100%"
        minHeight="100%"
        className="h-full rounded-none [&_.cm-theme]:h-full [&_.cm-editor]:h-full"
        ariaLabel={baseName(path)}
      />
    );
  };

  return (
    <Modal
      open
      onClose={() => void close()}
      size="full"
      closeOnBackdrop={false}
      icon={<FileCode className="h-4 w-4 text-accent" />}
      title={<span className="font-mono text-sm">{path}{dirty && <span className="ml-1 text-accent">●</span>}</span>}
      headerExtra={file && (
        <span className="hidden font-mono text-[11px] text-text-muted sm:inline">
          {formatBytes(file.size)} · {languageOf(baseName(path))}{readOnly ? ` · ${t('files.readOnly') || 'read-only'}` : ''}
        </span>
      )}
      bodyClassName="p-0 flex-1 min-h-0 overflow-hidden"
      footer={(
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-xs text-text-muted">{readOnly ? '' : (t('files.editor.hint') || 'Ctrl+S to save')}</span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => void close()}>{t('common.close') || 'Close'}</Button>
            {!readOnly && file?.content != null && (
              <Button onClick={() => void save()} loading={saving} disabled={!dirty}>
                <Save className="mr-1.5 h-4 w-4" />{t('common.save') || 'Save'}
              </Button>
            )}
          </div>
        </div>
      )}
    >
      <div className="h-[calc(100dvh-10rem)] min-h-[300px]">{body()}</div>
    </Modal>
  );
}
