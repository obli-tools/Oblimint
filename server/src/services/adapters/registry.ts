import type { AdapterId } from '@oblimint/shared';
import type { ToolsAdapter } from './common';
import { composerAdapter } from './composer';
import { drupalAdapter } from './drupal';
import { nextcloudAdapter } from './nextcloud';
import { wordpressAdapter } from './wordpress';

/** The application adapters of the module, by id (ADAPTER_IDS order). */
export const ADAPTERS: Readonly<Record<AdapterId, ToolsAdapter>> = {
  wordpress: wordpressAdapter,
  composer: composerAdapter,
  drupal: drupalAdapter,
  nextcloud: nextcloudAdapter,
};

export function adapterFor(id: AdapterId): ToolsAdapter {
  return ADAPTERS[id];
}
