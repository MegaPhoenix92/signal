import { lazy, Suspense } from 'react';

const AppSurface = lazy(() => import('./pages/AppSurface'));

export default function App() {
  return (
    <Suspense fallback={<div className="app-loading">Loading Signal...</div>}>
      <AppSurface />
    </Suspense>
  );
}
