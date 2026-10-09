import { useTranslation } from 'react-i18next';
import { Hand, ShieldCheck, Zap } from 'lucide-react';
import type { PublishMode } from '@oblimint/shared';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { fieldCls, labelCls, sectionLabelCls } from './styles';

export interface PublishModeFieldProps {
  mode: PublishMode;
  onModeChange: (m: PublishMode) => void;
  /** Debounce seconds as typed (auto mode). */
  debounce: string;
  onDebounceChange: (v: string) => void;
  disabled?: boolean;
}

/** Publish mode picker (auto + debounce / manual / approval), each mode explained. */
export function PublishModeField({ mode, onModeChange, debounce, onDebounceChange, disabled = false }: PublishModeFieldProps) {
  const { t } = useTranslation();
  const help: Record<PublishMode, string> = {
    auto: t('sites.publishMode.autoHint') || 'A release is published automatically once uploads to the staging folder have stopped for the delay below.',
    manual: t('sites.publishMode.manualHint') || 'Nothing is published until someone clicks "Publish" (or calls the API).',
    approval: t('sites.publishMode.approvalHint') || 'Every release waits for the approval of a user allowed to approve before going live.',
  };
  return (
    <div>
      <div className={sectionLabelCls}>{t('sites.fields.publishMode') || 'Publication'}</div>
      <SegmentedTabs<PublishMode>
        size="sm"
        value={mode}
        onChange={(m) => { if (!disabled) onModeChange(m); }}
        ariaLabel={t('sites.fields.publishMode') || 'Publication'}
        tabs={[
          { id: 'auto', label: t('sites.publishMode.auto') || 'Automatic', icon: <Zap size={14} />, disabled },
          { id: 'manual', label: t('sites.publishMode.manual') || 'Manual', icon: <Hand size={14} />, disabled },
          { id: 'approval', label: t('sites.publishMode.approval') || 'With approval', icon: <ShieldCheck size={14} />, disabled },
        ]}
      />
      <p className="mt-2 text-xs text-text-muted">{help[mode]}</p>
      {mode === 'auto' && (
        <div className="mt-2 max-w-[14rem]">
          <label className={labelCls} htmlFor="site-debounce">{t('sites.fields.debounce') || 'Delay after the last upload (s)'}</label>
          <input
            id="site-debounce"
            type="number"
            min={5}
            max={3600}
            inputMode="numeric"
            value={debounce}
            onChange={(e) => onDebounceChange(e.target.value)}
            className={`${fieldCls} font-mono`}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}
