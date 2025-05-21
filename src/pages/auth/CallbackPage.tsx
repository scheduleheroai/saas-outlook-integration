import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export default function CallbackPage() {
  const navigate = useNavigate();

  useEffect(() => {
    // Add a small delay to allow the auth state to update
    const timer = setTimeout(() => {
      navigate('/dashboard');
    }, 1500);

    return () => clearTimeout(timer);
  }, [navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-soft-light-gray">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hero-blue mx-auto mb-4"></div>
        <p className="text-slate-gray">Logging you in...</p>
      </div>
    </div>
  );
}