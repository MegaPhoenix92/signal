import type { AppMode } from './appTypes';

export type AppRouteId = 'marketing' | 'register' | 'workspace' | 'admin';

export type AppRoute = {
  hash: string;
  id: AppRouteId;
  legacyHashes?: readonly string[];
  mode: AppMode;
};

export const appRoutes: readonly AppRoute[] = [
  { hash: '#top', id: 'marketing', mode: 'marketing' },
  { hash: '#register', id: 'register', legacyHashes: ['#onboarding'], mode: 'register' },
  { hash: '#workspace', id: 'workspace', mode: 'workspace' },
  { hash: '#admin', id: 'admin', mode: 'admin' },
];

export function appRouteForMode(mode: AppMode) {
  return appRoutes.find((route) => route.mode === mode) ?? appRoutes[0];
}

export function resolveAppRoute(hash = window.location.hash): AppRoute {
  const normalizedHash = hash || '#top';
  const exactRoute = appRoutes.find((route) =>
    route.hash === normalizedHash ||
    route.legacyHashes?.includes(normalizedHash));
  if (exactRoute) {
    return exactRoute;
  }
  if (normalizedHash.startsWith('#admin/')) {
    return appRouteForMode('admin');
  }
  return appRouteForMode('marketing');
}
