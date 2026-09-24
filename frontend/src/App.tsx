import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Layout, Spinner } from './components';
import { AdminPage } from './pages/AdminPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { RfaDetailPage } from './pages/RfaDetailPage';
import { RfaFormPage } from './pages/RfaFormPage';
import { RfaListPage } from './pages/RfaListPage';
import { BudgetManagementPage, BudgetReportsPage } from './pages/BudgetPages';

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="full-loader"><Spinner label="Opening eRFA" /></div>;
  return <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route element={user ? <Layout /> : <Navigate to="/login" replace />}>
      <Route index element={<DashboardPage />} />
      <Route path="rfas" element={<RfaListPage />} />
      <Route path="approvals" element={user?.CAN_APPROVE_RFA ? <RfaListPage approvalsOnly /> : <Navigate to="/" replace />} />
      <Route path="rfa/new" element={user?.CAN_CREATE_RFA ? <RfaFormPage /> : <Navigate to="/" replace />} />
      <Route path="rfa/:id/edit" element={<RfaFormPage />} />
      <Route path="rfa/:id" element={<RfaDetailPage />} />
      <Route path="admin" element={user?.IS_ADMIN ? <AdminPage /> : <Navigate to="/" replace />} />
      <Route path="admin/budgets" element={user?.IS_ADMIN ? <BudgetManagementPage /> : <Navigate to="/" replace />} />
      <Route path="admin/budget-reports" element={user?.IS_ADMIN ? <BudgetReportsPage /> : <Navigate to="/" replace />} />
    </Route>
    <Route path="*" element={<Navigate to={user ? '/' : '/login'} replace />} />
  </Routes>;
}
