import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, ArrowLeft, Boxes, Eye, Info, Rocket, Save, ShieldCheck } from 'lucide-react';
import type { AppStackDetail, ComposeIssue, ComposeValidationResult } from '@oblimint/shared';
import type { EditorView } from '@uiw/react-codemirror';
import { appsApi } from '@/api/apps.api';
import { isStepUpHandled } from '@/api/client';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { Card } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { appsErrorMessage, composeIssuesOf, isNotFound, toastAppsError } from '@/components/apps/appsErrors';
import { dotenvBadLines, dotenvKeys } from '@/components/apps/appsFormat';
import { AppStatusBadge } from '@/components/apps/AppBadges';
import { CodeEditor, revealLine } from '@/components/apps/CodeEditor';
import { ComposeIssueList } from '@/components/apps/ComposeIssues';
import { EffectivePreview } from '@/components/apps/EffectivePreview';

type Side = 'issues' | 'effective';

/**
 * /apps/:id/edit — compose editor (CodeMirror YAML), .env editor (fetched on
 * demand: GET /env is audited), live validation (POST /apps/validate, issues
 * with line markers), effective config preview, save / save + deploy
 * (docs/P4b-PLAN.md §13). OWNED BY MODULE `ui-apps`.
 */
export function AppEditorPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams();
  const stackId = Number(id);
  const { can } = useP4bAccess();
  const [stack, setStack] = useState<AppStackDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [compose, setCompose] = useState('');
  const [env, setEnv] = useState<string | null>(null);
  const [envBase, setEnvBase] = useState<string | null>(null);
  const [envLoading, setEnvLoading] = useState(false);
  const [validation, setValidation] = useState<ComposeValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [serverIssues, setServerIssues] = useState<ComposeIssue[]>([]);
  const [side, setSide] = useState<Side>('issues');
  const [saving, setSaving] = useState<'save' | 'deploy' | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    let cancelled = false;
    appsApi.getStack(stackId)
      .then((s) => {
        if (cancelled) return;
        setStack(s);
        setCompose(s.composeYaml);
        setValidation(s.validation);
      })
      .catch((err) => {
        if (cancelled) return;
        if (isNotFound(err)) setNotFound(true);
        else setLoadError(appsErrorMessage(t, err, t('apps.detail.loadFailed') || 'Failed to load the application'));
      });
    return () => { cancelled = true; };
  }, [stackId, t]);

  const editable = !!stack && (stack.sourceType === 'editor' || stack.sourceType === 'zip') && can('apps.manage', stack.accountId);
  const composeDirty = !!stack && compose !== stack.composeYaml;
  const envDirty = env !== null && env !== envBase;
  const dirty = composeDirty || envDirty;

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Live validation (debounced): the stack's own sealed .env is used while the .env is not loaded.
  const seq = useRef(0);
  const runValidation = useCallback(async (yaml: string, envText: string | null) => {
    if (!stack) return;
    const n = ++seq.current;
    setValidating(true);
    try {
      const r = await appsApi.validate({ accountId: stack.accountId, composeYaml: yaml, ...(envText !== null ? { env: envText } : {}), stackId: stack.id });
      if (n !== seq.current) return;
      setValidation(r);
      setServerIssues([]);
    } catch (err) {
      if (n !== seq.current) return;
      if (!isStepUpHandled(err)) toast.error(appsErrorMessage(t, err, t('apps.compose.validateFailed') || 'The validation failed'), { id: 'apps-validate' });
    } finally {
      if (n === seq.current) setValidating(false);
    }
  }, [stack, t]);
  useEffect(() => {
    if (!stack || !editable || !dirty) return;
    const timer = window.setTimeout(() => { void runValidation(compose, env); }, 900);
    return () => window.clearTimeout(timer);
  }, [compose, env, stack, editable, dirty, runValidation]);

  const loadEnv = async () => {
    if (!stack) return;
    setEnvLoading(true);
    try {
      const r = await appsApi.getEnv(stack.id);
      setEnv(r.env);
      setEnvBase(r.env);
    } catch (err) {
      toastAppsError(t, err, t('apps.env.loadFailed') || 'Failed to load the .env');
    } finally {
      setEnvLoading(false);
    }
  };

  const save = async (andDeploy: boolean) => {
    if (!stack) return;
    if (env !== null) {
      const bad = dotenvBadLines(env);
      if (bad.length) { toast.error(t('apps.env.badLines', { lines: bad.join(', '), defaultValue: '.env: invalid line(s) {{lines}} (KEY=value expected).' })); return; }
    }
    setSaving(andDeploy ? 'deploy' : 'save');
    setServerIssues([]);
    try {
      let next = stack;
      if (dirty) {
        next = await appsApi.updateStack(stack.id, { ...(composeDirty ? { composeYaml: compose } : {}), ...(envDirty ? { env: env! } : {}) });
        setStack(next);
        setCompose(next.composeYaml);
        if (env !== null) setEnvBase(env);
        if (next.validation) setValidation(next.validation);
      }
      if (andDeploy) {
        await appsApi.action(stack.id, { action: next.status === 'draft' ? 'deploy' : 'redeploy' });
        toast.success(t('apps.editor.deployed') || 'Saved, deployment started');
        navigate(`/apps/${stack.id}`);
      } else {
        toast.success(t('apps.editor.saved') || 'Saved');
      }
    } catch (err) {
      if (isStepUpHandled(err)) return;
      const issues = composeIssuesOf(err);
      if (issues.length) { setServerIssues(issues); setSide('issues'); }
      toast.error(appsErrorMessage(t, err, t('apps.editor.saveFailed') || 'Failed to save'), { duration: 7000 });
    } finally {
      setSaving(null);
    }
  };

  if (notFound || loadError) {
    return (
      <PageContainer className="flex flex-col items-center gap-3 py-16 text-center">
        <Boxes className="h-8 w-8 text-text-muted" />
        <p className="text-sm text-text-secondary">{notFound ? (t('apps.detail.notFound') || 'This application does not exist or is not visible to you.') : loadError}</p>
        <Link to="/apps" className="text-sm text-accent hover:underline">{t('apps.backToList') || 'Back to the applications'}</Link>
      </PageContainer>
    );
  }
  if (!stack) return <PageContainer className="flex justify-center py-16"><LoadingSpinner /></PageContainer>;

  const issues = serverIssues.length ? serverIssues : (validation?.issues ?? []);
  const markers = issues.filter((i) => i.line != null).map((i) => ({ line: i.line!, severity: i.severity }));
  const errorCount = issues.filter((i) => i.severity === 'error').length;

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-start gap-3 max-lg:flex-wrap">
        <IconButton
          onClick={() => navigate(`/apps/${stack.id}`)}
          size="lg" variant="plain" className="mt-0.5 rounded-lg hover:bg-bg-secondary" label={t('common.back') || 'Back'} icon={<ArrowLeft className="h-4 w-4" />}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3 max-sm:gap-2">
            <h1 className="min-w-0 break-all font-display text-2xl font-semibold tracking-wide text-text-primary max-sm:text-xl">{stack.displayName}</h1>
            <AppStatusBadge status={stack.status} message={stack.statusMessage} />
            {dirty && <span className="font-mono text-[11px] text-amber-400">{t('apps.editor.unsaved') || 'unsaved changes'}</span>}
          </div>
          <p className="mt-1 font-mono text-xs text-text-muted">{stack.accountUsername} · {stack.name}</p>
        </div>
        {editable && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 max-lg:w-full">
            <Button size="sm" variant="secondary" loading={validating} onClick={() => { void runValidation(compose, env); }}><ShieldCheck size={14} className="mr-1.5" />{t('apps.compose.validate') || 'Validate'}</Button>
            <Button size="sm" variant="secondary" loading={saving === 'save'} disabled={!dirty || saving !== null} onClick={() => { void save(false); }}><Save size={14} className="mr-1.5" />{t('common.save') || 'Save'}</Button>
            <Button size="sm" loading={saving === 'deploy'} disabled={saving !== null || stack.status === 'deploying'} onClick={() => { void save(true); }}><Rocket size={14} className="mr-1.5" />{t('apps.editor.saveDeploy') || 'Save and deploy'}</Button>
          </div>
        )}
      </div>

      {!editable && (
        <p className="flex items-start gap-2 rounded-lg bg-bg-secondary px-3 py-2 text-sm text-text-muted">
          <Info size={15} className="mt-0.5 shrink-0" />
          {stack.sourceType === 'git'
            ? (t('apps.editor.readOnlyGit') || 'The compose file comes from the git repository: change it in the repository, then pull.')
            : stack.sourceType === 'catalog'
              ? (t('apps.editor.readOnlyCatalog') || 'The compose file comes from the catalog template: change its settings in the application settings.')
              : (t('apps.editor.readOnly') || 'Read only: you cannot change this application.')}
        </p>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="min-w-0 space-y-4">
          <Card title={t('apps.create.compose') || 'Compose file'}>
            <CodeEditor
              value={compose}
              onChange={editable ? setCompose : undefined}
              readOnly={!editable}
              markers={markers}
              minHeight="420px"
              maxHeight="70vh"
              onCreateEditor={(v) => { viewRef.current = v; }}
              ariaLabel={t('apps.create.compose') || 'Compose file'}
            />
          </Card>
          <Card
            title={t('apps.env.title') || 'Environment (.env)'}
            actions={env === null && editable ? (
              <Button size="sm" variant="secondary" loading={envLoading} onClick={() => { void loadEnv(); }}><Eye size={14} className="mr-1.5" />{t('apps.env.show') || 'Show and edit'}</Button>
            ) : undefined}
          >
            {env === null ? (
              <div className="space-y-2">
                <p className="text-sm text-text-muted">{t('apps.env.sealed') || 'The values are stored encrypted. Showing them is logged in the audit log.'}</p>
                {stack.envKeys.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {stack.envKeys.map((k) => <span key={k} className="rounded bg-bg-tertiary px-2 py-0.5 font-mono text-xs text-text-secondary">{k}</span>)}
                  </div>
                ) : <p className="text-xs text-text-muted">{t('apps.env.empty') || 'No variable.'}</p>}
              </div>
            ) : (
              <>
                <CodeEditor value={env} onChange={setEnv} language="text" minHeight="120px" maxHeight="320px" ariaLabel=".env" />
                <p className="mt-1 text-[11px] text-text-muted">
                  {t('apps.env.keysCount', { count: dotenvKeys(env).length, defaultValue: '{{count}} variable(s).' })} {t('apps.env.hint') || 'KEY=value lines, stored encrypted. Only these variables are interpolated in the compose file.'}
                </p>
              </>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-3 xl:sticky xl:top-4 xl:self-start">
          <SegmentedTabs<Side>
            value={side}
            onChange={setSide}
            size="sm"
            tabs={[
              {
                id: 'issues',
                label: t('apps.editor.issues') || 'Problems',
                icon: errorCount ? <AlertTriangle size={13} /> : <ShieldCheck size={13} />,
                badge: issues.length ? <span className={cn('ml-1 rounded-full px-1.5 font-mono text-[10px]', errorCount ? 'bg-status-down/20 text-status-down' : 'bg-amber-400/15 text-amber-400')}>{issues.length}</span> : null,
              },
              { id: 'effective', label: t('apps.editor.effective') || 'Effective config', icon: <Eye size={13} /> },
            ]}
          />
          <Card className="min-w-0">
            {validating && <div className="mb-2 flex items-center gap-2 text-xs text-text-muted"><LoadingSpinner size="sm" />{t('apps.compose.validating') || 'Validating…'}</div>}
            {side === 'issues'
              ? (validation || serverIssues.length
                ? <ComposeIssueList issues={issues} ok={serverIssues.length ? false : (validation?.ok ?? null)} onReveal={(line) => revealLine(viewRef.current, line)} />
                : <p className="py-4 text-center text-sm text-text-muted">{t('apps.compose.notValidated') || 'Not validated yet.'}</p>)
              : <EffectivePreview effective={validation?.effective ?? null} effectiveYaml={validation?.effectiveYaml ?? null} />}
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}
