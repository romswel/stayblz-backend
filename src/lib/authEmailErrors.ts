import type { Response } from 'express';

// Public, allowlisted messages only. Never echo a provider response or recipient.
export function sendAuthEmailError(
  res: Response,
  error: unknown,
  fallback: string,
) {
  const failure =
    error && typeof error === 'object'
      ? (error as { code?: string; status?: number })
      : {};
  if (failure.code === 'email_address_not_authorized') {
    res
      .status(403)
      .json({
        code: 'email_address_not_authorized',
        error:
          'Supabase’s built-in email service can only send to authorized organization email addresses. Use an authorized test email address.',
      });
    return;
  }
  if (
    failure.status === 429 ||
    ['over_email_send_rate_limit', 'over_request_rate_limit'].includes(
      failure.code ?? '',
    )
  ) {
    res.setHeader('Retry-After', '60');
    res
      .status(429)
      .json({
        code:
          failure.code === 'over_email_send_rate_limit'
            ? 'over_email_send_rate_limit'
            : 'over_request_rate_limit',
        retryAfterSeconds: 60,
        error:
          'Supabase’s email or request limit has been reached. Wait at least 60 seconds before trying again. The project email quota may take longer to reset.',
      });
    return;
  }
  res.status(503).json({ code: 'auth_email_unavailable', error: fallback });
}

export function isUnknownRecipient(error: unknown) {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: string }).code === 'user_not_found'
  );
}
