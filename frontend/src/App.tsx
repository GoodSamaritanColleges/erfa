import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Layout, Spinner } from './components';
import { LoginPage } from './pages/LoginPage';

// Route-level code splitting: each page downloads only when it is first needed,
// so sign-in and the dashboard open faster.
const loadDashboard = () => import('./pages/DashboardPage');
const loadList = () => import('./pages/RfaListPage');
const loadForm = () => import('./pages/RfaFormPage');
const loadDetail = () => import('./pages/RfaDetailPage');
const loadAdmin = () => import('./pages/AdminPage');
const loadBudget = () => import('./pages/BudgetPages');
const loadReport = () => import('./pages/DepartmentExpenseReportPage');

const DashboardPage = lazy(() => loadDashboard().then((m) => ({ default: m.DashboardPage })));
const RfaListPage = lazy(() => loadList().then((m) => ({ default: m.RfaListPage })));
const RfaFormPage = lazy(() => loadForm().then((m) => ({ default: m.RfaFormPage })));
const RfaDetailPage = lazy(() => loadDetail().then((m) => ({ default: m.RfaDetailPage })));
const AdminPage = lazy(() => loadAdmin().then((m) => ({ default: m.AdminPage })));
const BudgetManagementPage = lazy(() => loadBudget().then((m) => ({ default: m.BudgetManagementPage })));
const DepartmentExpenseReportPage = lazy(() => loadReport().then((m) => ({ default: m.DepartmentExpenseReportPage })));

export default function App() {
  const { user, loading } = useAuth();

  // After sign-in, warm up the remaining pages in the background so later navigation is instant.
  useEffect(() => {
    if (!user) return;
    const warm = () => {
      void loadList(); void loadDetail();
      if (user.CAN_CREATE_RFA) void loadForm();
      if (user.IS_ADMIN) { void loadAdmin(); void loadBudget(); void loadReport(); }
    };
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    const handle = idle ? idle(warm) : window.setTimeout(warm, 1200);
    return () => { if (!idle) window.clearTimeout(handle); };
  }, [user]);

  if (loading) return <div className="full-loader"><Spinner label="Opening eRFA" /></div>;
  return <Suspense fallback={<div className="full-loader"><Spinner label="Opening eRFA" /></div>}><Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route element={user ? <Layout /> : <Navigate to="/login" replace />}>
      <Route index element={<DashboardPage />} />
      <Route path="rfas" element={<RfaListPage key="mine" />} />
      <Route path="all-rfas" element={user?.ALL_RFAS_SCOPE === 'all' || user?.ALL_RFAS_SCOPE === 'approved' ? <RfaListPage key="all" mode="all" /> : <Navigate to="/" replace />} />
      <Route path="approvals" element={user?.CAN_APPROVE_RFA ? <RfaListPage key="approvals" mode="approvals" /> : <Navigate to="/" replace />} />
      <Route path="rfa/new" element={user?.CAN_CREATE_RFA ? <RfaFormPage /> : <Navigate to="/" replace />} />
      <Route path="rfa/:id/edit" element={<RfaFormPage />} />
      <Route path="rfa/:id" element={<RfaDetailPage />} />
      <Route path="admin" element={user?.IS_ADMIN ? <AdminPage /> : <Navigate to="/" replace />} />
      <Route path="admin/expense-monitoring" element={user?.IS_ADMIN ? <BudgetManagementPage /> : <Navigate to="/" replace />} />
      <Route path="admin/budgets" element={user?.IS_ADMIN ? <BudgetManagementPage /> : <Navigate to="/" replace />} />
      <Route path="admin/budget-reports" element={user?.IS_ADMIN ? <DepartmentExpenseReportPage /> : <Navigate to="/" replace />} />
      <Route path="admin/expense-reports" element={user?.IS_ADMIN ? <DepartmentExpenseReportPage /> : <Navigate to="/" replace />} />
    </Route>
    <Route path="*" element={<Navigate to={user ? '/' : '/login'} replace />} />
  </Routes></Suspense>;
}
