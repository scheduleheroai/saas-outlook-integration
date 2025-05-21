import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/lib/supabaseClient';
// import { usePostHog } from 'posthog-js/react'

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

type LoginFormData = z.infer<typeof loginSchema>;

export default function LoginPage() {
  // const posthog = usePostHog()
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = async (data: LoginFormData) => {
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: data.email,
        password: data.password,
      });

      if (error) {
        if (error.message === 'Invalid login credentials') {
          throw new Error(
            'The email or password you entered is incorrect. Please check your credentials and try again.'
          );
        }
        throw error;
      }
    //   // identify & fire account_created
    //   posthog.identify(sessionData?.user.id)
    //   posthog.capture('account_created', {
    //   plan: sessionData?.user.app_metadata?.plan || 'paid',
    //   source: 'whop_webhook'
    // })

      navigate('/dashboard');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'An error occurred');
    }
  };

  return (
    <div className="min-h-screen bg-soft-light-gray flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h2 className="text-3xl font-bold text-slate-gray">Welcome back</h2>
          <p className="mt-2 text-sm text-slate-gray">Sign in to your account</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-6 bg-white p-8 rounded-lg shadow">
          {error && (
            <div className="bg-red-50 text-red-500 p-3 rounded-md text-sm">
              {error}
              {error.includes('incorrect') && (
                <div className="mt-2 text-sm">
                  <p>Please make sure:</p>
                  <ul className="list-disc list-inside mt-1">
                    <li>Your email address is spelled correctly</li>
                    <li>Your password is correct (check if caps lock is on)</li>
                    <li>You're using the email address you registered with</li>
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                {...register('email')}
                className={errors.email ? 'border-red-500' : ''}
              />
              {errors.email && (
                <p className="text-red-500 text-sm mt-1">{errors.email.message}</p>
              )}
            </div>

            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                {...register('password')}
                className={errors.password ? 'border-red-500' : ''}
              />
              {errors.password && (
                <p className="text-red-500 text-sm mt-1">{errors.password.message}</p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <Link
              to="/password-reset"
              className="text-sm text-hero-blue hover:text-hero-blue/80"
            >
              Forgot your password?
            </Link>
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Signing in...' : 'Sign in'}
          </Button>

          {/* <p className="text-center text-sm text-slate-gray">
            Don't have an account?{' '}
            <Link
              to="/signup"
              className="font-medium text-hero-blue hover:text-hero-blue/80"
            >
              Sign up
            </Link>
          </p> */}
        </form>

        <div className="text-center text-xs text-slate-gray">
          <a href="https://scheduleheroai.com/privacy-policy" target="_blank" rel="noopener noreferrer" className="hover:underline">
            Privacy Policy
          </a>
          <span className="mx-2">|</span>
          <a href="https://scheduleheroai.com/terms-of-service" target="_blank" rel="noopener noreferrer" className="hover:underline">
            Terms of Service
          </a>
        </div>
      </div>
    </div>
  );
}