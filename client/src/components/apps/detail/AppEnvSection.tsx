import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { FileDown, Rocket } from 'lucide-react';
import type { AppDeployment, AppEnvTemplate, AppStackDetail } from '@oblimint/shared';
import { envKeyLooksSecret } from '@oblimint/shared';
import { appsApi } from '@/api/apps.api';
import { isStepUpHandled } from '@/api/client';
import { Button } from '@/components/common/Button';
import { EnvVarsEditor } from '@/components/envVars/EnvVarsEditor';
import { addMissingRows, parseDotEnv, type EnvVarSave, type EnvVarView } from '@/components/envVars/envVarsLogic';
import { MissingEnvKeys } from '../EnvExampleImport';
import { toastAppsError } from '../appsErrors';

/**
 * .env of an application in its Settings, with the editor of the site
 * variables (one row per variable, Secret write-only, Import a .env, Add,
 * Save) + Save and deploy, and for a git / ZIP source the .env example:
 * expected variables missing, import of the missing ones (never a value
 * overwritten, Secret proposed from the name, comments ignored).
 * OWNED BY MODULE `ui-apps`.
 */
export function AppEnvSection({ stack, onSaved, onStarted }: {
  stack: AppStackDetail;
  onSaved: (s: AppStackDetail) => void;
  onStarted: (d: AppDeployment) => void;
}) {
  const { t } = useTranslation();
  const [vars, setVars] = useState<EnvVarView[] | null>(null);
  const [template, setTemplate] = useState<AppEnvTemplate | null>(null);
  const [deploying, setDeploying] = useState(false);
  const exampleSource = stack.sourceType === 'git' || stack.sourceType === 'zip';

  useEffect(() => {
    let cancelled = false;
    appsApi.getEnv(stack.id)
      .then((r) => { if (!cancelled) setVars(r.vars); })
      .catch((err) => { if (!cancelled) { toastAppsError(t, err, t('apps.env.loadFailed') || 'Failed to load the .env'); setVars([]); } });
    return () => { cancelled = true; };
  }, [stack.id, t]);

  useEffect(() => {
    if (!exampleSource) return;
    let cancelled = false;
    appsApi.envTemplate(stack.id)
      .then((tpl) => { if (!cancelled) setTemplate(tpl); })
      .catch(() => { if (!cancelled) setTemplate(null); });
    return () => { cancelled = true; };
  }, [stack.id, exampleSource]);

  const save = async (body: EnvVarSave[]): Promise<EnvVarView[] | null> => {
    try {
      const r = await appsApi.saveEnv(stack.id, body);
      onSaved(r.stack);
      toast.success(r.changed ? (t('apps.env.savedDeploy') || 'Saved: deploy the application to apply it') : (t('siteEnv.unchanged') || 'Nothing changed'));
      return r.vars;
    } catch (err) {
      if (!isStepUpHandled(err)) toastAppsError(t, err, t('siteEnv.saveFailed') || 'The variables could not be saved');
      return null;
    }
  };

  const deploy = async () => {
    setDeploying(true);
    try {
      onStarted(await appsApi.action(stack.id, { action: stack.status === 'draft' ? 'deploy' : 'redeploy' }));
      toast.success(t('apps.editor.deployed') || 'Saved, deployment started');
    } catch (err) {
      if (!isStepUpHandled(err)) toastAppsError(t, err, t('apps.actions.failed') || 'The action failed');
    } finally {
      setDeploying(false);
    }
  };

  return (
    <EnvVarsEditor
      vars={vars}
      onSave={save}
      title={t('apps.env.title') || 'Environment (.env)'}
      guessSecret={envKeyLooksSecret}
      intro={t('apps.env.varsIntro') || 'Variables of the application .env: interpolated in the compose file (${NAME}) and given to the containers that use env_file: .env. Stored encrypted; a secret is never shown again (left empty = unchanged). Deploy to apply a change.'}
      extraActions={(api) => (template?.file && template.content !== null ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            const r = addMissingRows(api.rows, parseDotEnv(template.content ?? ''), envKeyLooksSecret);
            if (!r.added.length) { toast(t('apps.env.exampleNothing', { file: template.file, defaultValue: 'Every variable of {{file}} is already set.' })); return; }
            api.setRows(r.rows);
            toast.success(t('apps.env.exampleImported', { count: r.added.length, file: template.file, defaultValue: '{{count}} variable(s) added from {{file}}: check their values.' }));
          }}
        >
          <FileDown className="mr-1 h-3.5 w-3.5" />{t('apps.env.exampleImport', { file: template.file, defaultValue: 'Import from {{file}}' })}
        </Button>
      ) : null)}
      renderNotice={(names) => (template?.file ? (
        <div className="mt-3">
          <MissingEnvKeys file={template.file} keys={template.keys.filter((k) => !names.includes(k))} />
        </div>
      ) : null)}
      saveExtra={(saveForm, s) => (
        <Button
          size="sm"
          variant="secondary"
          loading={deploying}
          disabled={s.invalid || s.saving || stack.status === 'deploying'}
          onClick={() => { void (async () => { if (s.dirty && !(await saveForm())) return; await deploy(); })(); }}
        >
          <Rocket className="mr-1 h-3.5 w-3.5" />{t('apps.editor.saveDeploy') || 'Save and deploy'}
        </Button>
      )}
    />
  );
}
