// src/router.tsx
import { createBrowserRouter, Navigate } from 'react-router-dom';
import LoginPage from '@/pages/auth/LoginPage';
// import SignupPage from '@/pages/auth/SignupPage';
import PasswordResetPage from '@/pages/auth/PasswordResetPage';
import UpdatePasswordPage from '@/pages/auth/UpdatePasswordPage';
import CallbackPage from '@/pages/auth/CallbackPage';
import ProtectedRoute from '@/components/auth/ProtectedRoute'; 
import DashboardLayout from '@/components/layouts/DashboardLayout';

// Import Dashboard pages
import IntegrationsPage from '@/pages/dashboard/IntegrationsPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <ProtectedRoute />,
    children: [
      {
        index: true,
        element: <Navigate to="/dashboard/integrations" replace />,
      },
      {
        path: 'dashboard',
        element: <DashboardLayout />, 
        children: [
          {
            index: true,
            element: <Navigate to="/dashboard/integrations" replace />,
          },
          { path: 'integrations', element: <IntegrationsPage /> },
        ],
      },
    ],
  },
  { path: '/login', element: <LoginPage /> },
  // { path: '/signup', element: <SignupPage /> },
  { path: '/password-reset', element: <PasswordResetPage /> },
  { path: '/update-password', element: <UpdatePasswordPage /> },
  { path: '/auth/callback', element: <CallbackPage /> }, 
  {
      path: '*',
      element: <Navigate to="/login" replace />,
  }
]);