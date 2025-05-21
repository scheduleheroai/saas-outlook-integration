

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";






CREATE SCHEMA IF NOT EXISTS "private";


ALTER SCHEMA "private" OWNER TO "postgres";


CREATE EXTENSION IF NOT EXISTS "http" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgjwt" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."call_outcome_enum" AS ENUM (
    'Appointment Scheduled',
    'Appointment Rescheduled',
    'Appointment Confirmed',
    'Appointment Cancelled',
    'Left Voicemail',
    'No Answer',
    'Call Failed',
    'Information Provided',
    'Transferred',
    'Hung Up',
    'Other'
);


ALTER TYPE "public"."call_outcome_enum" OWNER TO "postgres";


CREATE TYPE "public"."call_started_reason_enum" AS ENUM (
    'Inbound Call',
    'Appointment Confirmation',
    'Cancelled Appointment Recovery',
    'No-Show Follow-up',
    'Manual Upload',
    'Unknown'
);


ALTER TYPE "public"."call_started_reason_enum" OWNER TO "postgres";


CREATE TYPE "public"."outbound_call_status" AS ENUM (
    'pending',
    'processing',
    'completed',
    'failed',
    'skipped'
);


ALTER TYPE "public"."outbound_call_status" OWNER TO "postgres";


CREATE TYPE "public"."outbound_call_type" AS ENUM (
    'confirm_appointment',
    'recover_cancellation',
    'reschedule_noshow',
    'manual_upload'
);


ALTER TYPE "public"."outbound_call_type" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."notify_scrape_site_link"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  url text := 'https://cddesenzusrcjoecvicv.supabase.co/functions/v1/scrape-site-link';
  -- IMPORTANT: Consider using a more secure way to handle secrets,
  -- like environment variables or a secrets manager, instead of hardcoding.
  service_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNkZGVzZW56dXNyY2pvZWN2aWN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0NDkwNTM5NSwiZXhwIjoyMDYwNDgxMzk1fQ.UClc6Uislo02_ripmLzTwyhHvUtYgFAdCDnA2ap1EdM';
  payload jsonb;
BEGIN
  -- Build the JSON payload using the NEW record data
  payload := jsonb_build_object(
    'type', TG_OP,       -- Operation type (INSERT, UPDATE, DELETE)
    'table', TG_TABLE_NAME, -- Table name where the trigger occurred
    'schema', TG_TABLE_SCHEMA, -- Schema of the table
    'record', row_to_json(NEW)::jsonb -- The newly inserted row data
  );

  -- Perform the HTTP POST request to the specified URL
  -- Ensure the 'net' extension is enabled: CREATE EXTENSION IF NOT EXISTS net;
  PERFORM net.http_post(
    url := url,
    body := payload,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key -- Authorization header
    ),
    timeout_milliseconds := 500 -- Set a short timeout (500ms)
  );

  -- Return the NEW record for INSERT/UPDATE triggers
  -- For AFTER triggers, the return value is ignored, but it's good practice.
  -- Use RETURN NULL; if this were an AFTER trigger where you don't need the row.
  RETURN NEW;
END;
$$;


ALTER FUNCTION "private"."notify_scrape_site_link"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_profile_for_user"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email)
  VALUES (
    NEW.id,
    NEW.email
  );
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."create_profile_for_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_user_settings_and_vapi_assistant"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Create user settings with default values
  INSERT INTO public.user_settings (
    user_id,
    ai_greeting_message,
    ai_recording_preference,
    ai_forwarding_number
  ) VALUES (
    NEW.id,
    'Hello! I am your AI receptionist. How may I assist you today?',
    true,
    NULL
  );

  -- Note: VAPI assistant will be created on first settings save
  -- This ensures we have user input for greeting message and other preferences
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."create_user_settings_and_vapi_assistant"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_daily_call_counts"("p_user_id" "uuid", "p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone) RETURNS TABLE("day" "date", "count" bigint)
    LANGUAGE "sql" STABLE
    AS $$
  -- The actual query performed by the function
  SELECT
    -- Truncate the start_time to the beginning of the day (in UTC) and cast to date
    DATE_TRUNC('day', start_time AT TIME ZONE 'UTC')::date AS day,
    -- Count the number of calls (using the 'id' column) for that day
    COUNT(id) AS count
  FROM public.call_logs -- Specify the table to query
  WHERE
    user_id = p_user_id AND -- Filter by the provided user ID
    start_time >= p_start_date AND -- Filter by start date (inclusive)
    start_time < p_end_date -- Filter by end date (exclusive)
  GROUP BY day -- Group the counts by the truncated day
  ORDER BY day; -- Order the results by date
$$;


ALTER FUNCTION "public"."get_daily_call_counts"("p_user_id" "uuid", "p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_lead_call_completion_for_sheet"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  payload jsonb;
  req_id  bigint;
BEGIN
  -- Build the JSON payload
  payload := jsonb_build_object(
    'lead_call_id',       NEW.id,
    'lead_id',            NEW.lead_id,
    'vapi_call_id',       NEW.vapi_call_id,
    'ghl_opportunity_id', NEW.ghl_opportunity_id,
    'status',             NEW.status,
    'structured_data',    NEW.structured_data,
    'call_time',          NEW.updated_at
  );

  -- Asynchronously POST to your Edge Function
  req_id := net.http_post(
    url     := 'https://cddesenzusrcjoecvicv.functions.supabase.co/log-call-to-sheet',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNkZGVzZW56dXNyY2pvZWN2aWN2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQ5MDUzOTUsImV4cCI6MjA2MDQ4MTM5NX0.OlKrzsj-f5alAISM5lFYIAZCC2Asqyasu9_-J5GGzKA'
    ),
    body    := payload
  );

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_lead_call_completion_for_sheet"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, manage_url, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data ->> 'manage_url', -- Assuming full_name might come from sign-up metadata
    NEW.created_at,
    NEW.updated_at
  );
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."moddatetime"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."moddatetime"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_usage_and_check_limit"("p_user_id" "uuid", "p_metric_type" "text", "p_quantity_to_add" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_subscription_id uuid;
    v_plan_id uuid;
    v_current_period_start timestamptz;
    v_current_period_end timestamptz;
    v_usage_limits jsonb;
    v_limit_value integer;
    v_current_usage integer;
    v_user_account_status text;
    v_result jsonb;
BEGIN
    -- Get current user account status
    SELECT account_status INTO v_user_account_status
    FROM public.user_settings
    WHERE user_id = p_user_id;

    IF v_user_account_status IS NULL THEN
        -- This case should ideally not happen if handle_new_user trigger works
        -- Or if user_settings are created upon subscription.
        -- However, as a safeguard:
        INSERT INTO public.user_settings (user_id, account_status)
        VALUES (p_user_id, 'pending_activation')
        ON CONFLICT (user_id) DO UPDATE SET account_status = public.user_settings.account_status -- no change if conflict
        RETURNING account_status INTO v_user_account_status;
    END IF;

    IF v_user_account_status NOT IN ('active', 'trialing') THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'account_not_active', 'current_status', v_user_account_status);
    END IF;

    -- Find active/trialing subscription and its plan details
    SELECT s.id, s.plan_id, s.current_period_start, s.current_period_end, pl.usage_limits
    INTO v_subscription_id, v_plan_id, v_current_period_start, v_current_period_end, v_usage_limits
    FROM public.subscriptions s
    JOIN public.plans pl ON s.plan_id = pl.id
    WHERE s.user_id = p_user_id AND s.status IN ('active', 'trialing')
    ORDER BY s.created_at DESC LIMIT 1;

    IF v_subscription_id IS NULL THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'no_active_subscription');
    END IF;

    -- Ensure current_period_start and current_period_end are set
    IF v_current_period_start IS NULL OR v_current_period_end IS NULL THEN
        -- This could happen if a subscription is active but billing cycle dates are missing
        -- Log this as an anomaly. For now, we might deny usage or use subscription creation date as a fallback for start.
        -- For simplicity here, we'll deny.
        RAISE WARNING 'Subscription % for user % has null period start/end.', v_subscription_id, p_user_id;
        RETURN jsonb_build_object('allowed', false, 'reason', 'subscription_billing_period_not_set');
    END IF;


    -- Extract the specific limit for the metric_type (e.g., "calls_monthly")
    v_limit_value := (v_usage_limits ->> p_metric_type)::integer;

    IF v_limit_value IS NULL OR v_limit_value <= 0 THEN -- 0 means unlimited or feature not available/tracked
        -- If limit is 0 or not defined for this metric, consider it allowed (or interpret 0 as not allowed based on business logic)
        -- For this example, 0 or null limit means "not restricted by this metric" or "unlimited for this metric"
        INSERT INTO public.usage_records (subscription_id, user_id, metric_type, quantity, recorded_at, billing_period_start, billing_period_end)
        VALUES (v_subscription_id, p_user_id, p_metric_type, p_quantity_to_add, now(), v_current_period_start, v_current_period_end);
        RETURN jsonb_build_object('allowed', true, 'reason', 'usage_recorded_unlimited_or_not_tracked');
    END IF;

    -- Calculate current usage for the metric within the current billing period
    SELECT COALESCE(SUM(quantity), 0)
    INTO v_current_usage
    FROM public.usage_records ur
    WHERE ur.user_id = p_user_id
      AND ur.metric_type = p_metric_type
      AND ur.recorded_at >= v_current_period_start
      AND ur.recorded_at < v_current_period_end;

    IF v_current_usage + p_quantity_to_add > v_limit_value THEN
        -- Usage limit exceeded, update account status
        UPDATE public.user_settings us
        SET account_status = 'delinquent_usage',
            delinquency_reason = 'Exceeded ' || p_metric_type || ' limit. Used ' || (v_current_usage + p_quantity_to_add)::text || ' of ' || v_limit_value::text || '.'
        WHERE us.user_id = p_user_id;

        -- Optionally, still record the usage that pushed them over, or don't.
        -- For this example, we will record it so it's clear they went over.
        INSERT INTO public.usage_records (subscription_id, user_id, metric_type, quantity, recorded_at, billing_period_start, billing_period_end, metadata)
        VALUES (v_subscription_id, p_user_id, p_metric_type, p_quantity_to_add, now(), v_current_period_start, v_current_period_end, jsonb_build_object('limit_exceeded_flag', true));

        RETURN jsonb_build_object('allowed', false, 'reason', 'limit_exceeded', 'current_usage', v_current_usage, 'limit', v_limit_value);
    ELSE
        -- Usage within limits, record it
        INSERT INTO public.usage_records (subscription_id, user_id, metric_type, quantity, recorded_at, billing_period_start, billing_period_end)
        VALUES (v_subscription_id, p_user_id, p_metric_type, p_quantity_to_add, now(), v_current_period_start, v_current_period_end);
        RETURN jsonb_build_object('allowed', true, 'reason', 'usage_recorded', 'current_usage', v_current_usage + p_quantity_to_add, 'limit', v_limit_value);
    END IF;

EXCEPTION
    WHEN others THEN
        RAISE WARNING 'Error in record_usage_and_check_limit for user %: %', p_user_id, SQLERRM;
        RETURN jsonb_build_object('allowed', false, 'reason', 'internal_error', 'detail', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."record_usage_and_check_limit"("p_user_id" "uuid", "p_metric_type" "text", "p_quantity_to_add" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_set_last_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Use the CORRECT column name for the leads table
  NEW.last_updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_set_last_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_set_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Set the updated_at field for the row being modified (the NEW record)
  NEW.updated_at = NOW();
  -- Return the modified row so the UPDATE operation can proceed
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_set_timestamp"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Use the column name for the lead_calls table
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."billing_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "subscription_id" "uuid",
    "whop_invoice_id" "text",
    "whop_charge_id" "text",
    "event_type" "text" NOT NULL,
    "amount_total_cents" integer,
    "amount_paid_cents" integer,
    "amount_due_cents" integer,
    "currency" "text",
    "status" "text" NOT NULL,
    "description" "text",
    "invoice_pdf_url" "text",
    "period_start" timestamp with time zone,
    "period_end" timestamp with time zone,
    "created_at_whop" timestamp with time zone NOT NULL,
    "recorded_at_saas" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb"
);


ALTER TABLE "public"."billing_history" OWNER TO "postgres";


COMMENT ON TABLE "public"."billing_history" IS 'Stores billing-related events like invoices and payments from Whop.';



CREATE TABLE IF NOT EXISTS "public"."business_qa" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "question" "text" NOT NULL,
    "answer" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "type" "text" DEFAULT 'business_qa'::"text" NOT NULL,
    CONSTRAINT "business_qa_type_check" CHECK (("type" = ANY (ARRAY['business_qa'::"text", 'business_info'::"text", 'site_link'::"text"])))
);


ALTER TABLE "public"."business_qa" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."business_services" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "service_name" "text" NOT NULL,
    "duration_minutes" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "positive_duration" CHECK (("duration_minutes" > 0))
);


ALTER TABLE "public"."business_services" OWNER TO "postgres";


COMMENT ON TABLE "public"."business_services" IS 'Stores services offered by a business and their standard duration.';



COMMENT ON COLUMN "public"."business_services"."user_id" IS 'Foreign key linking to the user (auth.users) who owns this service.';



COMMENT ON COLUMN "public"."business_services"."service_name" IS 'The name of the service offered (e.g., Initial Consultation, 60 Minute Massage).';



COMMENT ON COLUMN "public"."business_services"."duration_minutes" IS 'The standard duration of the service in minutes.';



CREATE TABLE IF NOT EXISTS "public"."calendar_integrations" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "account_email" "text" NOT NULL,
    "encrypted_credentials" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "last_synced_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "google_watch_channel_id" "text",
    "google_watch_resource_id" "text",
    "google_watch_expiration" timestamp with time zone,
    "google_calendar_id" "text",
    "last_webhook_at" timestamp with time zone,
    "last_sync_token" "text",
    "has_refresh_token" boolean DEFAULT false,
    "acuity_webhook_id" "text",
    "calendly_webhook_id" "text",
    "square_merchant_id" "text",
    "acuity_calendar_id" "text"
);


ALTER TABLE "public"."calendar_integrations" OWNER TO "postgres";


COMMENT ON COLUMN "public"."calendar_integrations"."google_watch_channel_id" IS 'Unique ID for the Google Calendar push notification channel.';



COMMENT ON COLUMN "public"."calendar_integrations"."google_watch_resource_id" IS 'Resource ID associated with the Google Calendar watch channel.';



COMMENT ON COLUMN "public"."calendar_integrations"."google_watch_expiration" IS 'Timestamp indicating when the Google Calendar watch channel expires.';



COMMENT ON COLUMN "public"."calendar_integrations"."google_calendar_id" IS 'The specific Google Calendar ID being watched (e.g., "primary" or an email address).';



COMMENT ON COLUMN "public"."calendar_integrations"."last_webhook_at" IS 'Timestamp of the last webhook notification received for this integration.';



COMMENT ON COLUMN "public"."calendar_integrations"."last_sync_token" IS 'Stores the nextSyncToken provided by the Google Calendar API for incremental synchronization.';



COMMENT ON COLUMN "public"."calendar_integrations"."has_refresh_token" IS 'has_refresh_token';



CREATE TABLE IF NOT EXISTS "public"."call_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "vapi_call_id" "text" NOT NULL,
    "customer_phone_number" "text",
    "call_started_reason" "public"."call_started_reason_enum" DEFAULT 'Unknown'::"public"."call_started_reason_enum",
    "vapi_ended_reason" "text",
    "call_outcome" "public"."call_outcome_enum" DEFAULT 'Other'::"public"."call_outcome_enum",
    "start_time" timestamp with time zone,
    "end_time" timestamp with time zone,
    "duration_seconds" integer,
    "summary" "text",
    "transcript" "text",
    "recording_url" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "appointment_datetime_iso" timestamp with time zone,
    "booking_status" "text",
    "appointment_type" "text",
    "customer_full_name" "text",
    "customer_email" "text",
    "customer_phone_from_analysis" "text",
    "customer_sentiment" "text",
    "key_topics_discussed" "jsonb",
    "next_action_required_by_staff" "text",
    "raw_structured_data" "jsonb"
);


ALTER TABLE "public"."call_logs" OWNER TO "postgres";


COMMENT ON COLUMN "public"."call_logs"."appointment_datetime_iso" IS 'The ISO 8601 date and time for the appointment, from structured analysis.';



COMMENT ON COLUMN "public"."call_logs"."booking_status" IS 'Indicates if a newly scheduled appointment is Confirmed or Tentative, from structured analysis.';



COMMENT ON COLUMN "public"."call_logs"."appointment_type" IS 'The type or category of the appointment, from structured analysis.';



COMMENT ON COLUMN "public"."call_logs"."customer_full_name" IS 'Full name of the customer, from structured analysis.';



COMMENT ON COLUMN "public"."call_logs"."customer_email" IS 'Email address of the customer, from structured analysis.';



COMMENT ON COLUMN "public"."call_logs"."customer_phone_from_analysis" IS 'Phone number of the customer as captured in structured analysis (might differ from dialed/callerId).';



COMMENT ON COLUMN "public"."call_logs"."customer_sentiment" IS 'Overall sentiment of the customer during the call, from structured analysis.';



COMMENT ON COLUMN "public"."call_logs"."key_topics_discussed" IS 'List of key topics or services discussed, from structured analysis.';



COMMENT ON COLUMN "public"."call_logs"."next_action_required_by_staff" IS 'Follow-up action required by human staff, from structured analysis.';



COMMENT ON COLUMN "public"."call_logs"."raw_structured_data" IS 'The complete raw JSON object from VAPI''s call analysis structuredData field.';



CREATE TABLE IF NOT EXISTS "public"."lead_calls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "vapi_assistant_id" "text",
    "vapi_call_id" "text",
    "status" "text" DEFAULT 'pending_initial'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "last_attempt_time" timestamp with time zone,
    "transcript" "text",
    "structured_data" "jsonb",
    "ghl_contact_id" "text",
    "ghl_opportunity_id" "text",
    "last_error" "text",
    "requested_callback_time" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lead_calls" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text",
    "phone" "text" NOT NULL,
    "email" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."leads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."outbound_call_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "calendar_integration_id" "uuid",
    "calendar_event_id" "text",
    "event_start_time" timestamp with time zone,
    "event_end_time" timestamp with time zone,
    "event_summary" "text",
    "customer_name" "text",
    "customer_phone" "text" NOT NULL,
    "call_type" "public"."outbound_call_type" NOT NULL,
    "status" "public"."outbound_call_status" DEFAULT 'pending'::"public"."outbound_call_status" NOT NULL,
    "last_attempt_time" timestamp with time zone,
    "attempts" integer DEFAULT 0,
    "last_error" "text",
    "vapi_call_id" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "manual_upload_instruction" "text"
);


ALTER TABLE "public"."outbound_call_queue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "whop_plan_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "price_cents" integer DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'usd'::"text" NOT NULL,
    "interval" "text" DEFAULT 'month'::"text" NOT NULL,
    "interval_count" integer DEFAULT 1 NOT NULL,
    "usage_limits" "jsonb" DEFAULT "jsonb_build_object"('calls_monthly', 0),
    "features" "jsonb",
    "is_active" boolean DEFAULT true NOT NULL,
    "display_order" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."plans" OWNER TO "postgres";


COMMENT ON TABLE "public"."plans" IS 'Stores details about available subscription plans.';



COMMENT ON COLUMN "public"."plans"."whop_plan_id" IS 'The unique identifier for this plan on Whop.';



COMMENT ON COLUMN "public"."plans"."usage_limits" IS 'JSON object defining usage limits, e.g., {"calls_monthly": 100}.';



CREATE TABLE IF NOT EXISTS "public"."processed_whop_events" (
    "whop_event_id" "text" NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    "status" "text" DEFAULT 'received'::"text"
);


ALTER TABLE "public"."processed_whop_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."processed_whop_events" IS 'Tracks Whop webhook events to ensure idempotency.';



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "user_id" "uuid" NOT NULL,
    "full_name" "text",
    "email" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "manage_url" "text"
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON COLUMN "public"."profiles"."manage_url" IS 'manage_url';



CREATE TABLE IF NOT EXISTS "public"."subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "plan_id" "uuid" NOT NULL,
    "whop_customer_id" "text",
    "whop_subscription_id" "text" NOT NULL,
    "status" "text" NOT NULL,
    "current_period_start" timestamp with time zone,
    "current_period_end" timestamp with time zone,
    "cancel_at_period_end" boolean DEFAULT false NOT NULL,
    "canceled_at" timestamp with time zone,
    "trial_start_at" timestamp with time zone,
    "trial_end_at" timestamp with time zone,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."subscriptions" OWNER TO "postgres";


COMMENT ON TABLE "public"."subscriptions" IS 'Stores user subscription information, synced from Whop.';



COMMENT ON COLUMN "public"."subscriptions"."status" IS 'Current status of the subscription from Whop.';



CREATE TABLE IF NOT EXISTS "public"."usage_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "metric_type" "text" NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "billing_period_start" timestamp with time zone NOT NULL,
    "billing_period_end" timestamp with time zone NOT NULL,
    "metadata" "jsonb",
    CONSTRAINT "positive_quantity" CHECK (("quantity" > 0))
);


ALTER TABLE "public"."usage_records" OWNER TO "postgres";


COMMENT ON TABLE "public"."usage_records" IS 'Tracks usage of billable metrics for subscriptions.';



COMMENT ON COLUMN "public"."usage_records"."metric_type" IS 'The type of metric being recorded, e.g., "call_initiated".';



CREATE TABLE IF NOT EXISTS "public"."user_settings" (
    "user_id" "uuid" NOT NULL,
    "ai_greeting_message" "text",
    "ai_recording_preference" boolean DEFAULT true,
    "ai_forwarding_number" "text",
    "vapi_phone_number" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "vapi_assistant_id" "text",
    "vapi_file_id" "text",
    "vapi_tool_id" "text",
    "business_website" "text",
    "ai_voice_id" "text" DEFAULT 'Elliot'::"text",
    "ai_voice_provider" "text" DEFAULT 'vapi'::"text",
    "call_activation_settings" "jsonb",
    "ai_calling_hours" "jsonb",
    "business_phone" "text",
    "ai_name" "text" DEFAULT 'AI Employee'::"text",
    "vapi_phone_number_id" "text",
    "business_name" "text",
    "onboarding_completed" boolean DEFAULT false,
    "business_hours_raw" "text",
    "ai_bookable_services" "text"[],
    "business_address" "text",
    "knowledge_base_urls" "text"[],
    "chosen_area_code" "text",
    "twilio_phone_number" "text",
    "twilio_phone_number_sid" "text",
    "phone_provisioning_status" "text" DEFAULT 'idle'::"text" NOT NULL,
    "last_provisioning_error" "text",
    "hipaa_enabled" boolean DEFAULT false NOT NULL,
    "default_appointment_duration_minutes" integer,
    "account_status" "text" DEFAULT 'pending_activation'::"text" NOT NULL,
    "delinquency_reason" "text",
    CONSTRAINT "check_default_duration_positive" CHECK ((("default_appointment_duration_minutes" IS NULL) OR ("default_appointment_duration_minutes" > 0)))
);


ALTER TABLE "public"."user_settings" OWNER TO "postgres";


COMMENT ON COLUMN "public"."user_settings"."business_phone" IS 'business_phone';



COMMENT ON COLUMN "public"."user_settings"."ai_name" IS 'ai_name';



COMMENT ON COLUMN "public"."user_settings"."vapi_phone_number_id" IS 'Stores any identifier VAPI returns for the linkage between the assistant and the external number.';



COMMENT ON COLUMN "public"."user_settings"."business_name" IS 'business_name';



COMMENT ON COLUMN "public"."user_settings"."business_hours_raw" IS 'Raw text input for business operating hours provided by the user during onboarding or settings.';



COMMENT ON COLUMN "public"."user_settings"."business_address" IS 'The physical address of the business, if provided.';



COMMENT ON COLUMN "public"."user_settings"."chosen_area_code" IS 'Stores the validated 3-digit area code chosen by the user.';



COMMENT ON COLUMN "public"."user_settings"."twilio_phone_number" IS 'Stores the purchased E.164 number from Twilio (e.g., +15551234567).';



COMMENT ON COLUMN "public"."user_settings"."twilio_phone_number_sid" IS 'Stores the Twilio Phone Number SID (PNxxxxxxxx...).';



COMMENT ON COLUMN "public"."user_settings"."phone_provisioning_status" IS 'Tracks state of phone number provisioning: idle, checking_availability, availability_checked, provisioning_started, searching_twilio, purchasing_twilio, attaching_vapi, releasing_twilio, success, failed.';



COMMENT ON COLUMN "public"."user_settings"."last_provisioning_error" IS 'Stores error details if phone provisioning fails.';



COMMENT ON COLUMN "public"."user_settings"."hipaa_enabled" IS 'hipaa_enabled';



COMMENT ON COLUMN "public"."user_settings"."default_appointment_duration_minutes" IS 'A fallback appointment duration in minutes if a specific service duration is not found or applicable.';



COMMENT ON COLUMN "public"."user_settings"."account_status" IS 'Internal account status determining feature access.';



COMMENT ON COLUMN "public"."user_settings"."delinquency_reason" IS 'Reason for delinquency, if applicable.';



ALTER TABLE ONLY "public"."billing_history"
    ADD CONSTRAINT "billing_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."billing_history"
    ADD CONSTRAINT "billing_history_whop_invoice_id_key" UNIQUE ("whop_invoice_id");



ALTER TABLE ONLY "public"."business_qa"
    ADD CONSTRAINT "business_qa_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."business_services"
    ADD CONSTRAINT "business_services_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."business_services"
    ADD CONSTRAINT "business_services_user_id_service_name_key" UNIQUE ("user_id", "service_name");



ALTER TABLE ONLY "public"."calendar_integrations"
    ADD CONSTRAINT "calendar_integrations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_integrations"
    ADD CONSTRAINT "calendar_integrations_user_id_provider_account_email_key" UNIQUE ("user_id", "provider", "account_email");



ALTER TABLE ONLY "public"."calendar_integrations"
    ADD CONSTRAINT "calendar_integrations_user_provider_key" UNIQUE ("user_id", "provider");



ALTER TABLE ONLY "public"."call_logs"
    ADD CONSTRAINT "call_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."call_logs"
    ADD CONSTRAINT "call_logs_vapi_call_id_key" UNIQUE ("vapi_call_id");



ALTER TABLE ONLY "public"."lead_calls"
    ADD CONSTRAINT "lead_calls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lead_calls"
    ADD CONSTRAINT "lead_calls_vapi_call_id_key" UNIQUE ("vapi_call_id");



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_phone_key" UNIQUE ("phone");



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."outbound_call_queue"
    ADD CONSTRAINT "outbound_call_queue_event_id_type_unique" UNIQUE ("calendar_event_id", "call_type");



COMMENT ON CONSTRAINT "outbound_call_queue_event_id_type_unique" ON "public"."outbound_call_queue" IS 'Ensures that only one task of a specific call_type exists for each unique calendar_event_id.';



ALTER TABLE ONLY "public"."outbound_call_queue"
    ADD CONSTRAINT "outbound_call_queue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."plans"
    ADD CONSTRAINT "plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."plans"
    ADD CONSTRAINT "plans_whop_plan_id_key" UNIQUE ("whop_plan_id");



ALTER TABLE ONLY "public"."processed_whop_events"
    ADD CONSTRAINT "processed_whop_events_pkey" PRIMARY KEY ("whop_event_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_whop_subscription_id_key" UNIQUE ("whop_subscription_id");



ALTER TABLE ONLY "public"."outbound_call_queue"
    ADD CONSTRAINT "unique_calendar_event_id" UNIQUE ("calendar_event_id");



ALTER TABLE ONLY "public"."usage_records"
    ADD CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_settings"
    ADD CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id");



CREATE INDEX "idx_billing_history_user_id" ON "public"."billing_history" USING "btree" ("user_id");



CREATE INDEX "idx_business_qa_user_id" ON "public"."business_qa" USING "btree" ("user_id");



CREATE INDEX "idx_business_qa_user_id_type" ON "public"."business_qa" USING "btree" ("user_id", "type");



CREATE INDEX "idx_business_services_user_id" ON "public"."business_services" USING "btree" ("user_id");



CREATE INDEX "idx_calendar_integrations_user_id" ON "public"."calendar_integrations" USING "btree" ("user_id");



CREATE INDEX "idx_call_logs_customer_phone_number" ON "public"."call_logs" USING "btree" ("customer_phone_number");



CREATE INDEX "idx_call_logs_start_time" ON "public"."call_logs" USING "btree" ("start_time");



CREATE INDEX "idx_call_logs_user_id" ON "public"."call_logs" USING "btree" ("user_id");



CREATE INDEX "idx_call_logs_vapi_call_id" ON "public"."call_logs" USING "btree" ("vapi_call_id");



CREATE INDEX "idx_lead_calls_lead_id" ON "public"."lead_calls" USING "btree" ("lead_id");



CREATE INDEX "idx_lead_calls_status" ON "public"."lead_calls" USING "btree" ("status");



CREATE INDEX "idx_lead_calls_vapi_call_id" ON "public"."lead_calls" USING "btree" ("vapi_call_id");



CREATE INDEX "idx_outbound_call_queue_event_id" ON "public"."outbound_call_queue" USING "btree" ("calendar_event_id");



CREATE INDEX "idx_outbound_call_queue_user_id" ON "public"."outbound_call_queue" USING "btree" ("user_id");



CREATE INDEX "idx_subscriptions_user_id" ON "public"."subscriptions" USING "btree" ("user_id");



CREATE INDEX "idx_subscriptions_whop_subscription_id" ON "public"."subscriptions" USING "btree" ("whop_subscription_id");



CREATE INDEX "idx_usage_records_user_metric_period" ON "public"."usage_records" USING "btree" ("user_id", "metric_type", "recorded_at");



CREATE OR REPLACE TRIGGER "handle_updated_at" BEFORE UPDATE ON "public"."business_services" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "handle_updated_at" BEFORE UPDATE ON "public"."plans" FOR EACH ROW EXECUTE FUNCTION "public"."moddatetime"();



CREATE OR REPLACE TRIGGER "handle_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."moddatetime"();



CREATE OR REPLACE TRIGGER "handle_updated_at" BEFORE UPDATE ON "public"."subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."moddatetime"();



CREATE OR REPLACE TRIGGER "handle_updated_at" BEFORE UPDATE ON "public"."user_settings" FOR EACH ROW EXECUTE FUNCTION "public"."moddatetime"();



CREATE OR REPLACE TRIGGER "log_completed_lead_call_to_sheet_trigger" AFTER UPDATE ON "public"."lead_calls" FOR EACH ROW WHEN ((("new"."status" = ANY (ARRAY['completed'::"text", 'completed_not_interested'::"text", 'completed_inconclusive'::"text"])) AND (("new"."ghl_contact_id" IS NOT NULL) OR ("new"."ghl_opportunity_id" IS NOT NULL)) AND ("new"."status" IS DISTINCT FROM "old"."status"))) EXECUTE FUNCTION "public"."handle_lead_call_completion_for_sheet"();



CREATE OR REPLACE TRIGGER "on_call_logs_updated" BEFORE UPDATE ON "public"."call_logs" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "on_outbound_call_queue_updated" BEFORE UPDATE ON "public"."outbound_call_queue" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_lead_calls_timestamp" BEFORE UPDATE ON "public"."lead_calls" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_leads_timestamp" BEFORE UPDATE ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_last_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_scrape_on_site_link_insert" AFTER INSERT ON "public"."business_qa" FOR EACH ROW WHEN (("new"."type" = 'site_link'::"text")) EXECUTE FUNCTION "private"."notify_scrape_site_link"();



CREATE OR REPLACE TRIGGER "update_calendar_integrations_updated_at" BEFORE UPDATE ON "public"."calendar_integrations" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_user_settings_updated_at" BEFORE UPDATE ON "public"."user_settings" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



ALTER TABLE ONLY "public"."billing_history"
    ADD CONSTRAINT "billing_history_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."billing_history"
    ADD CONSTRAINT "billing_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."business_qa"
    ADD CONSTRAINT "business_qa_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."business_services"
    ADD CONSTRAINT "business_services_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_integrations"
    ADD CONSTRAINT "calendar_integrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."call_logs"
    ADD CONSTRAINT "call_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_calls"
    ADD CONSTRAINT "lead_calls_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."outbound_call_queue"
    ADD CONSTRAINT "outbound_call_queue_calendar_integration_id_fkey" FOREIGN KEY ("calendar_integration_id") REFERENCES "public"."calendar_integrations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."outbound_call_queue"
    ADD CONSTRAINT "outbound_call_queue_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."usage_records"
    ADD CONSTRAINT "usage_records_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."usage_records"
    ADD CONSTRAINT "usage_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_settings"
    ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Allow authenticated users to delete own services" ON "public"."business_services" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow authenticated users to insert own services" ON "public"."business_services" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow authenticated users to select own services" ON "public"."business_services" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow authenticated users to select own settings" ON "public"."user_settings" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow authenticated users to update own services" ON "public"."business_services" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow authenticated users to update own settings" ON "public"."user_settings" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow insert for service_role" ON "public"."call_logs" FOR INSERT WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Allow profile creation during signup" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Allow public read access to plans" ON "public"."plans" FOR SELECT USING (true);



CREATE POLICY "Allow service_role access" ON "public"."lead_calls" USING (true) WITH CHECK (true);



CREATE POLICY "Allow service_role access" ON "public"."leads" USING (true) WITH CHECK (true);



CREATE POLICY "Allow service_role full access to billing_history" ON "public"."billing_history" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Allow service_role full access to processed_whop_events" ON "public"."processed_whop_events" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Allow service_role full access to profiles" ON "public"."profiles" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Allow service_role full access to subscriptions" ON "public"."subscriptions" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Allow service_role full access to usage_records" ON "public"."usage_records" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Allow service_role full access to user_settings" ON "public"."user_settings" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Allow user insert access to their queue items" ON "public"."outbound_call_queue" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow user select access to their queue items" ON "public"."outbound_call_queue" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow user update access to their queue items" ON "public"."outbound_call_queue" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow users to view their own call logs" ON "public"."call_logs" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Delete own QAs" ON "public"."business_qa" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Insert own QAs" ON "public"."business_qa" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Select own QAs" ON "public"."business_qa" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Update own QAs" ON "public"."business_qa" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own Q&A" ON "public"."business_qa" TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own calendar integrations" ON "public"."calendar_integrations" TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own settings" ON "public"."user_settings" TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can see their own billing history" ON "public"."billing_history" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can see their own subscriptions" ON "public"."subscriptions" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can see their own usage records" ON "public"."usage_records" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their own settings" ON "public"."user_settings" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own profile" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own settings" ON "public"."user_settings" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."billing_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."business_qa" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."business_services" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_integrations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."call_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lead_calls" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."leads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."outbound_call_queue" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."plans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."processed_whop_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_insert_own" ON "public"."profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "profiles_select_own" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "profiles_update_own" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."subscriptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."usage_records" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_settings_insert_own" ON "public"."user_settings" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "user_settings_select_own" ON "public"."user_settings" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "user_settings_update_own" ON "public"."user_settings" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";





GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






GRANT ALL ON TYPE "public"."call_outcome_enum" TO "anon";
GRANT ALL ON TYPE "public"."call_outcome_enum" TO "authenticated";
GRANT ALL ON TYPE "public"."call_outcome_enum" TO "service_role";



GRANT ALL ON TYPE "public"."call_started_reason_enum" TO "anon";
GRANT ALL ON TYPE "public"."call_started_reason_enum" TO "authenticated";
GRANT ALL ON TYPE "public"."call_started_reason_enum" TO "service_role";

























































































































































































































































GRANT ALL ON FUNCTION "public"."create_profile_for_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."create_profile_for_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_profile_for_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."create_user_settings_and_vapi_assistant"() TO "anon";
GRANT ALL ON FUNCTION "public"."create_user_settings_and_vapi_assistant"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_user_settings_and_vapi_assistant"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_daily_call_counts"("p_user_id" "uuid", "p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."get_daily_call_counts"("p_user_id" "uuid", "p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_daily_call_counts"("p_user_id" "uuid", "p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_lead_call_completion_for_sheet"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_lead_call_completion_for_sheet"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_lead_call_completion_for_sheet"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."moddatetime"() TO "anon";
GRANT ALL ON FUNCTION "public"."moddatetime"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."moddatetime"() TO "service_role";



GRANT ALL ON FUNCTION "public"."record_usage_and_check_limit"("p_user_id" "uuid", "p_metric_type" "text", "p_quantity_to_add" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."record_usage_and_check_limit"("p_user_id" "uuid", "p_metric_type" "text", "p_quantity_to_add" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_usage_and_check_limit"("p_user_id" "uuid", "p_metric_type" "text", "p_quantity_to_add" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_set_last_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_set_last_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_set_last_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_set_timestamp"() TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_set_timestamp"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_set_timestamp"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";
























GRANT ALL ON TABLE "public"."billing_history" TO "anon";
GRANT ALL ON TABLE "public"."billing_history" TO "authenticated";
GRANT ALL ON TABLE "public"."billing_history" TO "service_role";



GRANT ALL ON TABLE "public"."business_qa" TO "anon";
GRANT ALL ON TABLE "public"."business_qa" TO "authenticated";
GRANT ALL ON TABLE "public"."business_qa" TO "service_role";



GRANT ALL ON TABLE "public"."business_services" TO "anon";
GRANT ALL ON TABLE "public"."business_services" TO "authenticated";
GRANT ALL ON TABLE "public"."business_services" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_integrations" TO "anon";
GRANT ALL ON TABLE "public"."calendar_integrations" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_integrations" TO "service_role";



GRANT ALL ON TABLE "public"."call_logs" TO "anon";
GRANT ALL ON TABLE "public"."call_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."call_logs" TO "service_role";



GRANT ALL ON TABLE "public"."lead_calls" TO "anon";
GRANT ALL ON TABLE "public"."lead_calls" TO "authenticated";
GRANT ALL ON TABLE "public"."lead_calls" TO "service_role";



GRANT ALL ON TABLE "public"."leads" TO "anon";
GRANT ALL ON TABLE "public"."leads" TO "authenticated";
GRANT ALL ON TABLE "public"."leads" TO "service_role";



GRANT ALL ON TABLE "public"."outbound_call_queue" TO "anon";
GRANT ALL ON TABLE "public"."outbound_call_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."outbound_call_queue" TO "service_role";



GRANT ALL ON TABLE "public"."plans" TO "anon";
GRANT ALL ON TABLE "public"."plans" TO "authenticated";
GRANT ALL ON TABLE "public"."plans" TO "service_role";



GRANT ALL ON TABLE "public"."processed_whop_events" TO "anon";
GRANT ALL ON TABLE "public"."processed_whop_events" TO "authenticated";
GRANT ALL ON TABLE "public"."processed_whop_events" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."usage_records" TO "anon";
GRANT ALL ON TABLE "public"."usage_records" TO "authenticated";
GRANT ALL ON TABLE "public"."usage_records" TO "service_role";



GRANT ALL ON TABLE "public"."user_settings" TO "anon";
GRANT ALL ON TABLE "public"."user_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."user_settings" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "service_role";






























RESET ALL;
