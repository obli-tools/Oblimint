import type { AppTemplateCategory, AppTemplateField } from '@oblimint/shared';

// A built-in catalog template (docs/P4b-PLAN.md §5.4): versioned with the panel, upserted at start
// (catalogService.seedBuiltins), read-only for everyone. Images pinned by tag; every template passes
// the compose validator (catalog.test.ts) with the default platform settings.

export interface BuiltinTemplate {
  slug: string;
  name: string;
  icon: string;
  category: AppTemplateCategory;
  description: string;
  docsUrl: string | null;
  version: string;
  composeYaml: string;
  fields: AppTemplateField[];
  defaultProxy: { service: string; port: number } | null;
  minMemoryMb: number | null;
  /** false when the image is not publicly available yet (Obli apps). */
  enabled: boolean;
}

/** Field helper: every AppTemplateField key present. */
export function field(f: Partial<AppTemplateField> & Pick<AppTemplateField, 'key' | 'label' | 'type'>): AppTemplateField {
  return {
    labelKey: null, description: null, required: false, default: null, options: null, generate: null, secret: false, pattern: null, ...f,
  };
}

/** A generated secret (password) field. */
export function secretField(key: string, label: string, generate: AppTemplateField['generate'] = 'password'): AppTemplateField {
  return field({ key, label, type: 'password', required: true, generate, secret: true });
}
