import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, ArrowLeft, Boxes, Eye, Info, Lock, Rocket, Save, Settings2, ShieldCheck } from 'lucide-react';
import type { AppEnvTemplate, AppStackDetail, ComposeIssue, ComposeValidationResult } from '@oblimint/shared';
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
import { appsErrorMessage, composeIssuesOf, isNotFound } from '@/components/apps/appsErrors';
import { AppStatusBadge } from '@/components/apps/AppBadges';
import { CodeEditor, revealLine } from '@/components/apps/CodeEditor';
import { ComposeIssueList } from '@/components/apps/ComposeIssues';
import { EffectivePreview } from '@/components/apps/EffectivePreview';
import { MissingEnvKeys } from '@/components/apps/EnvExampleImport';

type Side = 'issues' | 'effective';

/**
 * /apps/:id/edit — compose editor (CodeMirror YAML), names of the .env (the
 * variables are edited in the Settings tab, AppEnvSection), .env example of a git / ZIP source (expected
 * variables missing, import without overwriting a value), live validation (POST /apps/validate, issues
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
  const [validation, setValidation] = useState<ComposeValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [serverIssues, setServerIssues] = useState<ComposeIssue[]>([]);
  const [side, setSide] = useState<Side>('issues');
  const [saving, setSaving] = useState<'save' | 'deploy' | null>(null);
  const [template, setTemplate] = useState<AppEnvTemplate | null>(null);
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
  // The .env belongs to the application whatever its source (git, catalog): only the compose follows the source.
  const envEditable = !!stack && can('apps.manage', stack.accountId);
  const exampleSource = !!stack && (stack.sourceType === 'git' || stack.sourceType === 'zip');
  const composeDirty = !!stack && compose !== stack.composeYaml;
  const dirty = composeDirty;

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Live validation (debounced) with the stack's own sealed .env.
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
    const timer = window.setTimeout(() => { void runValidation(compose, null); }, 900);
    return () => window.clearTimeout(timer);
  }, [compose, stack, editable, dirty, runValidation]);

  // .env example of a git / ZIP source (not secret; read in the source tree, not audited).
  const stackKey = stack?.id ?? null;
  useEffect(() => {
    if (stackKey === null || !envEditable || !exampleSource) return;
    let cancelled = false;
    appsApi.envTemplate(stackKey)
      .then((tpl) => { if (!cancelled) setTemplate(tpl); })
      .catch(() => { if (!cancelled) setTemplate(null); });
    return () => { cancelled = true; };
  }, [stackKey, envEditable, exampleSource]);

  const save = async (andDeploy: boolean) => {
    if (!stack) return;
    setSaving(andDeploy ? 'deploy' : 'save');
    setServerIssues([]);
    try {
      let next = stack;
      if (dirty) {
        next = await appsApi.updateStack(stack.id, { composeYaml: compose });
        setStack(next);
        setCompose(next.composeYaml);
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
  const missingKeys = (template?.keys ?? []).filter((k) => !stack.envKeys.includes(k));
  const secretKeys = new Set(stack.envSecretKeys ?? []);
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
            <Button size="sm" variant="secondary" loading={validating} onClick={() => { void runValidation(compose, null); }}><ShieldCheck size={14} className="mr-1.5" />{t('apps.compose.validate') || 'Validate'}</Button>
            <Button size="sm" variant="secondary" loading={saving === 'save'} disabled={!dirty || saving !== null} onClick={() => { void save(false); }}><Save size={14} className="mr-1.5" />{t('common.save') || 'Save'}</Button>
            <Button size="sm" loading={saving === 'deploy'} disabled={saving !== null || stack.status === 'deploying'} onClick={() => { void save(true); }}><Rocket size={14} className="mr-1.5" />{t('apps.editor.saveDeploy') || 'Save and deploy'}</Button>
          </div>
        )}
      </div>

      {!editable && (
        <p className="flex items-start gap-2 rounded-lg bg-bg-secondary px-3 py-2 text-sm text-text-muted">
          <Info size={15} className="mt-0.5 shrink-0" />
          {stack.sourceType === 'git'
            ? (t('apps.editor.readOnlyGit') || 'The compose file comes from the git repository: change it in the repository, then pull. The .env of the application is edited in its Settings.')
            : stack.sourceType === 'catalog'
              ? (t('apps.editor.readOnlyCatalog') || 'The compose file comes from the catalog template: change its settings in the application settings, where its .env is edited too.')
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
            actions={envEditable ? (
              <Link to={`/apps/${stack.id}?tab=settings`} className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
                <Settings2 size={14} />{t('apps.env.manageInSettings') || 'Manage in Settings'}
              </Link>
            ) : undefined}
          >
            {template?.file && <MissingEnvKeys file={template.file} keys={missingKeys} />}
            <div className="space-y-2">
              <p className="text-sm text-text-muted">{t('apps.env.namesOnly') || 'Names only: the values are stored encrypted and edited in the application Settings (a secret is never shown again).'}</p>
              {stack.envKeys.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {stack.envKeys.map((k) => (
                    <span key={k} className={cn('inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-xs', secretKeys.has(k) ? 'bg-amber-400/10 text-amber-400' : 'bg-bg-tertiary text-text-secondary')}>
                      {secretKeys.has(k) && <Lock size={11} />}{k}
                    </span>
                  ))}
                </div>
              ) : <p className="text-xs text-text-muted">{t('apps.env.empty') || 'No variable.'}</p>}
            </div>
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
