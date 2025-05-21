import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/lib/supabaseClient'; // For invoking the function

const resetSchema = z.object({
  email: z.string().email('Invalid email address'),
});

type ResetFormData = z.infer<typeof resetSchema>;

export default function PasswordResetPage() {
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<ResetFormData>({
    resolver: zodResolver(resetSchema),
  });

  const onSubmit = async (data: ResetFormData) => {
    setError(null);
    setSuccessMessage(null);
    try {
      // Invoke the Supabase Edge Function
      const { data: functionResponse, error: functionError } = await supabase.functions.invoke('generate-password-reset-webhook', {
        body: { email: data.email },
      });

      if (functionError) {
        // Handle potential errors from the function invocation itself (e.g., network issues, function not found)
        console.error("Function invocation error:", functionError);
        throw new Error(functionError.message || 'Failed to call password reset service.');
      }

      // The function should return a JSON response. Check if it contains an error property.
      if (functionResponse?.error) {
        console.error("Function returned an error:", functionResponse.error);
        throw new Error(functionResponse.error);
      }
      
      // Assuming the function returns a message on success
      setSuccessMessage(functionResponse?.message || 'If an account with that email exists, we have sent a password reset link. Please check your email.');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred. Please try again.';
      setError(errorMessage);
      console.error("Password reset submission error:", error);
    }
  };

  if (successMessage) {
    return (
      <div className="min-h-screen bg-soft-light-gray flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white p-8 rounded-lg shadow text-center">
          <h2 className="text-2xl font-bold text-success-green mb-4">Check your email</h2>
          <p className="text-slate-gray mb-6">
            {successMessage}
          </p>
          <Link
            to="/login"
            className="text-hero-blue hover:text-hero-blue/80"
          >
            Return to login
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-soft-light-gray flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h2 className="text-3xl font-bold text-slate-gray">Reset your password</h2>
          <p className="mt-2 text-sm text-slate-gray">
            Enter your email address and we'll coordinate sending you a link to reset your password.
          </p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-6 bg-white p-8 rounded-lg shadow">
          {error && (
            <div className="bg-red-50 text-red-500 p-3 rounded-md text-sm">
              {error}
            </div>
          )}

          <div>
            <Label htmlFor="email">Email address</Label>
            <Input
              id="email"
              type="email"
              {...register('email')}
              className={errors.email ? 'border-red-500' : ''}
              placeholder="you@example.com"
            />
            {errors.email && (
              <p className="text-red-500 text-sm mt-1">{errors.email.message}</p>
            )}
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Processing...' : 'Send reset link'}
          </Button>

          <p className="text-center text-sm text-slate-gray">
            Remember your password?{' '}
            <Link
              to="/login"
              className="font-medium text-hero-blue hover:text-hero-blue/80"
            >
              Sign in
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}