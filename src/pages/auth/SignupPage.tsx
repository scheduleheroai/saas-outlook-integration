import { useState } from 'react'; // Import React
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/lib/supabaseClient';
import { Loader2, CheckCircle } from 'lucide-react'; // Added CheckCircle icon

// Schema remains the same
const signupSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

type SignupFormData = z.infer<typeof signupSchema>;

export default function SignupPage() {
  // Removed navigate as we won't navigate away immediately on success anymore
  // const navigate = useNavigate();
  const [apiError, setApiError] = useState<string | null>(null); // Renamed state for clarity
  // --- Add State for the success message ---
  const [signupMessage, setSignupMessage] = useState<string | null>(null);

  const {
      register,
      handleSubmit,
      formState: { errors, isSubmitting },
      reset // <<<--- Get reset function from useForm
    } = useForm<SignupFormData>({
    resolver: zodResolver(signupSchema),
  });

  const onSubmit = async (formData: SignupFormData) => {
    setApiError(null); // Clear previous API error
    setSignupMessage(null); // Clear previous success message

    try {
      // --- Capture data AND error from Supabase ---
      const { data, error } = await supabase.auth.signUp({
        email: formData.email,
        password: formData.password,
         options: {
           // Set the redirect URL for the confirmation email link
           // Adjust the path if necessary, often points to root or login
           emailRedirectTo: window.location.origin,
         }
      });

      if (error) {
        console.error("Supabase Sign Up Error:", error);
        throw error; // Throw error to be caught below
      }

      // --- Check response data ---
      if (data.user && !data.session) {
        // SUCCESS: User created, needs verification
        setSignupMessage("Account created! Please check your email for a verification link to log in.");
        reset(); // Clear the form fields
      } else if (data.user && data.session) {
        // SUCCESS: User created AND logged in (email verification likely disabled)
        setSignupMessage("Account created successfully! You are now logged in."); // Or navigate immediately
        reset();
        // Consider navigation if needed: navigate('/dashboard');
      } else {
        // Unexpected response
        console.warn("Unexpected Supabase signup response:", data);
        throw new Error("An unexpected error occurred during sign up. Please try again.");
      }

    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
        console.error('Sign up process error:', errorMessage);
        setApiError(errorMessage); // Use the specific API error state
        setSignupMessage(null); // Ensure success message is clear
    }
    // No finally block needed as isSubmitting handles loading state from react-hook-form
  };

  return (
    // Using bg-muted based on updated theme
    <div className="min-h-screen bg-muted flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6"> {/* Reduced space-y-8 */}
        <div className="text-center">
          {/* You can add your logo here if desired */}
          <h2 className="text-3xl font-bold text-foreground">Create an account</h2>
          <p className="mt-2 text-sm text-muted-foreground">Start managing your AI Employee</p>
        </div>

        {/* Use background (Cloud White) for the form card */}
        <div className="bg-background p-8 rounded-lg shadow-md">
          {/* --- Conditionally render Success Message OR Form --- */}
          {signupMessage ? (
            <div className="p-4 text-center border border-success/30 rounded-md text-success space-y-3">
               <CheckCircle className="h-8 w-8 mx-auto text-success" />
              <p className="font-medium">{signupMessage}</p>
               <p className="text-sm text-muted-foreground">
                  Once verified, you can{' '}
                  <Link to="/login" className="font-medium text-primary hover:underline">
                   log in
                  </Link>.
               </p>
            </div>
          ) : (
            // Render the form if no success message
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
              {/* Display API errors */}
              {apiError && (
                <div className="bg-destructive/10 text-destructive p-3 rounded-md text-sm border border-destructive/20">
                  {apiError}
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <Label htmlFor="email">Email address</Label>
                  <Input
                    id="email"
                    type="email"
                    {...register('email')}
                    // Use border-destructive CSS variable via Tailwind config
                    className={errors.email ? 'border-destructive' : ''}
                    disabled={isSubmitting}
                    placeholder="you@example.com"
                  />
                  {errors.email && (
                    // Use text-destructive CSS variable
                    <p className="text-xs text-destructive mt-1">{errors.email.message}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    {...register('password')}
                    className={errors.password ? 'border-destructive' : ''}
                    disabled={isSubmitting}
                    placeholder="••••••••"
                  />
                  {errors.password && (
                    <p className="text-xs text-destructive mt-1">{errors.password.message}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="confirmPassword">Confirm Password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    {...register('confirmPassword')}
                    className={errors.confirmPassword ? 'border-destructive' : ''}
                    disabled={isSubmitting}
                    placeholder="••••••••"
                  />
                  {errors.confirmPassword && (
                    <p className="text-xs text-destructive mt-1">{errors.confirmPassword.message}</p>
                  )}
                </div>
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={isSubmitting}
              >
                {isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating account...</> : 'Create account'}
              </Button>

               <p className="text-center text-sm text-muted-foreground">
                  Already have an account?{' '}
                  <Link
                    to="/login"
                    // Use primary color CSS variable
                    className="font-medium text-primary hover:underline"
                  >
                    Sign in
                  </Link>
                </p>
            </form>
          )}
           {/* --- End Conditional Rendering --- */}
        </div>

        <div className="text-center text-xs text-muted-foreground">
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