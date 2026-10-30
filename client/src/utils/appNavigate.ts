// In-app navigation for code outside the React tree (toasts raised by the
// API client): the router's navigate, registered by a component mounted
// inside <BrowserRouter> (PendingApprovalGate). Falls back to a full load.

type Navigate = (to: string) => void;

let navigateFn: Navigate | null = null;

export function setAppNavigate(fn: Navigate | null): void {
  navigateFn = fn;
}

/** Internal paths only ('/x', never '//host'). */
export function appNavigate(to: string): void {
  if (!to.startsWith('/') || to.startsWith('//')) return;
  if (navigateFn) navigateFn(to);
  else window.location.assign(to);
}
