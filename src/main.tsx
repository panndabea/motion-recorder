import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { App } from './App';
import './styles.css';

const DirectorStudio = lazy(() => import('./director/DirectorStudioPage'));

function RootRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/recorder${search}`} replace />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/recorder" element={<App />} />
        <Route
          path="/director"
          element={
            <Suspense fallback={<div className="placeholder">Loading AI Director Studio…</div>}>
              <DirectorStudio />
            </Suspense>
          }
        />
        <Route path="*" element={<RootRedirect />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
