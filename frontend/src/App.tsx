import { lazy, ReactNode, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { PrefsProvider } from './lib/prefs';
import { SessionProvider, useSession } from './lib/session';
import { LoginPage } from './pages/LoginPage';
import { TrackPage, VerifyPage } from './pages/PublicPages';
import { AssistantProvider } from './shell/context';
import { Layout } from './shell/Layout';
import { Loading, Mark, ToastProvider } from './ui';

const MyWorkPage = lazy(() => import('./pages/MyWorkPage'));
const PostListPage = lazy(() => import('./pages/PostListPage'));
const PostDetailPage = lazy(() => import('./pages/PostDetailPage'));
const DossierListPage = lazy(() => import('./pages/DossierListPage'));
const DossierDetailPage = lazy(() => import('./pages/DossierDetailPage'));
const TasksPage = lazy(() => import('./pages/TasksPage'));
const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage'));
const ReviewPage = lazy(() => import('./pages/ReviewPage'));
const SearchPage = lazy(() => import('./pages/SearchPage'));
const OverviewPage = lazy(() => import('./pages/OverviewPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const AssistantPage = lazy(() => import('./pages/AssistantPage'));
const ArchivePage = lazy(() => import('./pages/ArchivePage'));
const AuditPage = lazy(() => import('./pages/AuditPage'));
const ExchangePage = lazy(() => import('./pages/ExchangePage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const DelegationsPage = lazy(() => import('./pages/DelegationsPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'));
const HelpPage = lazy(() => import('./pages/HelpPage'));

export function App() {
  return (
    <PrefsProvider>
      <SessionProvider>
        <ToastProvider>
          <AssistantProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/volgen" element={<TrackPage />} />
                <Route path="/verifieren" element={<VerifyPage />} />
                <Route path="/verifieren/:id" element={<VerifyPage />} />
                <Route path="*" element={<Private />} />
              </Routes>
            </BrowserRouter>
          </AssistantProvider>
        </ToastProvider>
      </SessionProvider>
    </PrefsProvider>
  );
}

function Splash() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
      <Mark size={56} />
    </div>
  );
}

function Private() {
  const session = useSession();
  if (session.status === 'loading') return <Splash />;
  if (session.status === 'out') return <LoginPage />;
  const home = session.business ? <MyWorkPage /> : session.has('AUDITOR') ? <Navigate to="/logboek" replace /> : <Navigate to="/beheer" replace />;
  const page = (el: ReactNode) => <Suspense fallback={<Loading lines={5} />}>{el}</Suspense>;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={page(home)} />
        <Route path="/post" element={page(<PostListPage />)} />
        <Route path="/post/:id" element={page(<PostDetailPage />)} />
        <Route path="/zaken" element={page(<DossierListPage />)} />
        <Route path="/zaken/:id" element={page(<DossierDetailPage />)} />
        <Route path="/taken" element={page(<TasksPage />)} />
        <Route path="/taken/:id" element={page(<TaskDetailPage />)} />
        <Route path="/goedkeuringen" element={page(<ReviewPage />)} />
        <Route path="/zoeken" element={page(<SearchPage />)} />
        <Route path="/overzicht" element={page(<OverviewPage />)} />
        <Route path="/rapporten" element={page(<ReportsPage />)} />
        <Route path="/assistent" element={page(<AssistantPage />)} />
        <Route path="/archief" element={page(<ArchivePage />)} />
        <Route path="/logboek" element={page(<AuditPage />)} />
        <Route path="/uitwisseling" element={page(<ExchangePage />)} />
        <Route path="/beheer" element={page(<AdminPage />)} />
        <Route path="/delegaties" element={page(<DelegationsPage />)} />
        <Route path="/profiel" element={page(<ProfilePage />)} />
        <Route path="/meldingen" element={page(<NotificationsPage />)} />
        <Route path="/help" element={page(<HelpPage />)} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Layout>
  );
}

function NotFound() {
  return (
    <div className="empty">
      <h3>Deze pagina bestaat niet</h3>
      <p>
        <a href="/">Terug naar Mijn werk</a>
      </p>
    </div>
  );
}
