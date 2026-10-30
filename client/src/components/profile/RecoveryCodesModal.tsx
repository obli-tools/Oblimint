import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Download, KeyRound, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';

/**
 * The plain recovery codes, shown ONCE (the server only keeps their hash):
 * copy, download as a text file, and an explicit "I saved them" to close.
 */
export function RecoveryCodesModal({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  const asText = codes.join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(asText);
      toast.success(t('identity.recovery.copied') || 'Codes copied');
    } catch {
      toast.error(t('identity.recovery.copyFailed') || 'Copy failed: select the codes and copy them by hand');
    }
  };

  const download = () => {
    const header = t('identity.recovery.fileHeader', { host: window.location.host }) || `Oblimint recovery codes (${window.location.host}): each code works once.`;
    const blob = new Blob([`${header}\n\n${asText}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'oblimint-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  };

  return (
    <Modal
      open
      onClose={() => { if (saved) onClose(); }}
      dismissible={saved}
      title={t('identity.recovery.modalTitle') || 'Your recovery codes'}
      icon={<KeyRound className="w-4 h-4 text-accent" />}
      size="sm"
      phoneLayout="center"
      bodyClassName="py-4 space-y-3"
      footer={
        <Button onClick={onClose} disabled={!saved}>
          <Check size={14} className="mr-1.5" />
          {t('identity.recovery.done') || 'Done'}
        </Button>
      }
    >
      <p className="text-xs text-text-muted">
        {t('identity.recovery.modalHint') || 'Keep them somewhere safe (a password manager). Each code signs you in once if you lose your authenticator. They are shown only now; generating new codes cancels these.'}
      </p>
      <div className="grid grid-cols-2 gap-2 rounded-lg bg-bg-tertiary p-3 font-mono text-sm text-text-primary select-all" data-testid="recovery-codes">
        {codes.map((c) => <span key={c} className="text-center">{c}</span>)}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => { void copy(); setSaved(true); }}>
          <Copy size={14} className="mr-1.5" />{t('identity.recovery.copy') || 'Copy'}
        </Button>
        <Button size="sm" variant="secondary" onClick={download}>
          <Download size={14} className="mr-1.5" />{t('identity.recovery.download') || 'Download'}
        </Button>
      </div>
      <label className="flex items-start gap-2 cursor-pointer select-none coarse:py-1">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-0.5 accent-accent" />
        <span className="text-xs text-text-muted">{t('identity.recovery.savedCheck') || 'I have saved these codes'}</span>
      </label>
    </Modal>
  );
}
