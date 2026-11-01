import { generateSecureToken, sha256Hex } from '../crypto';
import { DatabaseClient, SqlExecutor } from '../db/client';
import { NotFoundError } from '../errors';
import { Env } from '../types';

export interface EmailPreferencesDto {
  email: string;
  table: boolean;
  atmosphere: boolean;
  newCollections: boolean;
  productUpdates: boolean;
  promotionalCampaigns: boolean;
  isSuppressed: boolean;
  policyVersion: string;
  updatedAt: string;
}

export async function recordMarketingConsentInTx(
  tx: SqlExecutor,
  params: {
    customerId: string | null;
    email: string;
    segments: {
      table?: boolean;
      atmosphere?: boolean;
      newCollections?: boolean;
      productUpdates?: boolean;
      promotionalCampaigns?: boolean;
    };
    source: string;
    policyVersion: string;
    ipHash: string;
  }
): Promise<void> {
  const normalizedEmail = params.email.trim().toLowerCase();
  const unsubscribeToken = generateSecureToken(32);
  const unsubscribeTokenHash = await sha256Hex(unsubscribeToken);

  await tx.query(
    `INSERT INTO email_preferences (
       email, customer_id,
       sub_table, sub_atmosphere, sub_new_collections,
       sub_product_updates, sub_promotional_campaigns,
       is_suppressed, suppression_reason, unsubscribe_token_hash, policy_version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NULL, $8, $9)
     ON CONFLICT (email) DO UPDATE SET
       customer_id = COALESCE(email_preferences.customer_id, EXCLUDED.customer_id),
       sub_table = CASE WHEN $3 THEN TRUE ELSE email_preferences.sub_table END,
       sub_atmosphere = CASE WHEN $4 THEN TRUE ELSE email_preferences.sub_atmosphere END,
       sub_new_collections = CASE WHEN $5 THEN TRUE ELSE email_preferences.sub_new_collections END,
       sub_product_updates = CASE WHEN $6 THEN TRUE ELSE email_preferences.sub_product_updates END,
       sub_promotional_campaigns = CASE WHEN $7 THEN TRUE ELSE email_preferences.sub_promotional_campaigns END,
       is_suppressed = FALSE,
       suppression_reason = NULL,
       policy_version = EXCLUDED.policy_version,
       updated_at = NOW()`,
    [
      normalizedEmail,
      params.customerId,
      Boolean(params.segments.table),
      Boolean(params.segments.atmosphere),
      Boolean(params.segments.newCollections),
      Boolean(params.segments.productUpdates),
      Boolean(params.segments.promotionalCampaigns),
      unsubscribeTokenHash,
      params.policyVersion
    ]
  );

  const categoryMap: Array<{ key: keyof typeof params.segments; dbName: string }> = [
    { key: 'table', dbName: 'TABLE' },
    { key: 'atmosphere', dbName: 'ATMOSPHERE' },
    { key: 'newCollections', dbName: 'NEW_COLLECTIONS' },
    { key: 'productUpdates', dbName: 'PRODUCT_UPDATES' },
    { key: 'promotionalCampaigns', dbName: 'PROMOTIONAL_CAMPAIGNS' }
  ];

  for (const item of categoryMap) {
    if (params.segments[item.key] === true) {
      await tx.query(
        `INSERT INTO marketing_consent (
           customer_id, email, consent_category, consent_state,
           policy_version, consent_source, ip_hash
         ) VALUES ($1, $2, $3, 'OPTED_IN', $4, $5, $6)`,
        [
          params.customerId,
          normalizedEmail,
          item.dbName,
          params.policyVersion,
          params.source,
          params.ipHash
        ]
      );
    }
  }
}

export async function subscribeMarketing(
  db: DatabaseClient,
  env: Env,
  input: {
    customerId: string | null;
    email: string;
    segments: {
      table: boolean;
      atmosphere: boolean;
      newCollections: boolean;
      productUpdates: boolean;
      promotionalCampaigns: boolean;
    };
    ipHash: string;
  }
): Promise<{ subscribed: true; email: string; segments: typeof input.segments }> {
  const policyVersion = env.PRIVACY_POLICY_VERSION || '2026.11';
  await db.withTransaction(async (tx) => {
    await recordMarketingConsentInTx(tx, {
      customerId: input.customerId,
      email: input.email,
      segments: input.segments,
      source: 'explicit_web_opt_in',
      policyVersion,
      ipHash: input.ipHash
    });
  });

  return {
    subscribed: true,
    email: input.email.trim().toLowerCase(),
    segments: input.segments
  };
}

export async function unsubscribeMarketing(
  db: DatabaseClient,
  env: Env,
  input: { email?: string; token?: string; reason?: string; ipHash: string }
): Promise<{ unsubscribed: true; email: string }> {
  const policyVersion = env.PRIVACY_POLICY_VERSION || '2026.11';

  return db.withTransaction(async (tx) => {
    let targetEmail = input.email?.trim().toLowerCase() ?? '';
    let customerId: string | null = null;

    if (input.token) {
      const tokenHash = await sha256Hex(input.token.trim());
      const res = await tx.query<{ email: string; customer_id: string | null }>(
        `SELECT email, customer_id FROM email_preferences WHERE unsubscribe_token_hash = $1 LIMIT 1`,
        [tokenHash]
      );
      if (res.rows[0]) {
        targetEmail = res.rows[0].email;
        customerId = res.rows[0].customer_id;
      }
    }

    if (!targetEmail) {
      throw new NotFoundError('Subscription record not found for unsubscribe request.');
    }

    await tx.query(
      `UPDATE email_preferences SET
         sub_table = FALSE,
         sub_atmosphere = FALSE,
         sub_new_collections = FALSE,
         sub_product_updates = FALSE,
         sub_promotional_campaigns = FALSE,
         is_suppressed = TRUE,
         suppression_reason = $1,
         updated_at = NOW()
       WHERE email = $2`,
      [input.reason || 'Customer requested unsubscribe', targetEmail]
    );

    const categories = [
      'TABLE',
      'ATMOSPHERE',
      'NEW_COLLECTIONS',
      'PRODUCT_UPDATES',
      'PROMOTIONAL_CAMPAIGNS'
    ];
    for (const cat of categories) {
      await tx.query(
        `INSERT INTO marketing_consent (
           customer_id, email, consent_category, consent_state,
           policy_version, consent_source, ip_hash, withdrawn_at
         ) VALUES ($1, $2, $3, 'OPTED_OUT', $4, 'unsubscribe_endpoint', $5, NOW())`,
        [customerId, targetEmail, cat, policyVersion, input.ipHash]
      );
    }

    return { unsubscribed: true, email: targetEmail };
  });
}

export async function getCustomerMarketingPreferences(
  db: DatabaseClient,
  customerId: string,
  email: string
): Promise<EmailPreferencesDto> {
  const res = await db.query<{
    email: string;
    sub_table: boolean;
    sub_atmosphere: boolean;
    sub_new_collections: boolean;
    sub_product_updates: boolean;
    sub_promotional_campaigns: boolean;
    is_suppressed: boolean;
    policy_version: string;
    updated_at: string;
  }>(
    `SELECT email, sub_table, sub_atmosphere, sub_new_collections,
            sub_product_updates, sub_promotional_campaigns,
            is_suppressed, policy_version, updated_at
     FROM email_preferences
     WHERE customer_id = $1 OR email = $2
     LIMIT 1`,
    [customerId, email.toLowerCase()]
  );

  const row = res.rows[0];
  if (!row) {
    return {
      email: email.toLowerCase(),
      table: false,
      atmosphere: false,
      newCollections: false,
      productUpdates: false,
      promotionalCampaigns: false,
      isSuppressed: false,
      policyVersion: '2026.11',
      updatedAt: new Date().toISOString()
    };
  }

  return {
    email: row.email,
    table: Boolean(row.sub_table),
    atmosphere: Boolean(row.sub_atmosphere),
    newCollections: Boolean(row.sub_new_collections),
    productUpdates: Boolean(row.sub_product_updates),
    promotionalCampaigns: Boolean(row.sub_promotional_campaigns),
    isSuppressed: Boolean(row.is_suppressed),
    policyVersion: row.policy_version,
    updatedAt: String(row.updated_at)
  };
}

export async function updateCustomerMarketingPreferences(
  db: DatabaseClient,
  env: Env,
  customerId: string,
  email: string,
  prefs: {
    table: boolean;
    atmosphere: boolean;
    newCollections: boolean;
    productUpdates: boolean;
    promotionalCampaigns: boolean;
  },
  ipHash: string
): Promise<EmailPreferencesDto> {
  const policyVersion = env.PRIVACY_POLICY_VERSION || '2026.11';
  const normalizedEmail = email.toLowerCase();
  const anyEnabled =
    prefs.table ||
    prefs.atmosphere ||
    prefs.newCollections ||
    prefs.productUpdates ||
    prefs.promotionalCampaigns;

  await db.withTransaction(async (tx) => {
    const unsubTokenHash = await sha256Hex(generateSecureToken(32));
    await tx.query(
      `INSERT INTO email_preferences (
         email, customer_id, sub_table, sub_atmosphere, sub_new_collections,
         sub_product_updates, sub_promotional_campaigns, is_suppressed,
         unsubscribe_token_hash, policy_version
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (email) DO UPDATE SET
         customer_id = EXCLUDED.customer_id,
         sub_table = EXCLUDED.sub_table,
         sub_atmosphere = EXCLUDED.sub_atmosphere,
         sub_new_collections = EXCLUDED.sub_new_collections,
         sub_product_updates = EXCLUDED.sub_product_updates,
         sub_promotional_campaigns = EXCLUDED.sub_promotional_campaigns,
         is_suppressed = EXCLUDED.is_suppressed,
         policy_version = EXCLUDED.policy_version,
         updated_at = NOW()`,
      [
        normalizedEmail,
        customerId,
        prefs.table,
        prefs.atmosphere,
        prefs.newCollections,
        prefs.productUpdates,
        prefs.promotionalCampaigns,
        !anyEnabled,
        unsubTokenHash,
        policyVersion
      ]
    );

    const categories: Array<{ val: boolean; name: string }> = [
      { val: prefs.table, name: 'TABLE' },
      { val: prefs.atmosphere, name: 'ATMOSPHERE' },
      { val: prefs.newCollections, name: 'NEW_COLLECTIONS' },
      { val: prefs.productUpdates, name: 'PRODUCT_UPDATES' },
      { val: prefs.promotionalCampaigns, name: 'PROMOTIONAL_CAMPAIGNS' }
    ];

    for (const c of categories) {
      await tx.query(
        `INSERT INTO marketing_consent (
           customer_id, email, consent_category, consent_state,
           policy_version, consent_source, ip_hash, withdrawn_at
         ) VALUES ($1, $2, $3, $4, $5, 'account_preference_center', $6, $7)`,
        [
          customerId,
          normalizedEmail,
          c.name,
          c.val ? 'OPTED_IN' : 'OPTED_OUT',
          policyVersion,
          ipHash,
          c.val ? null : new Date().toISOString()
        ]
      );
    }
  });

  return getCustomerMarketingPreferences(db, customerId, normalizedEmail);
}

export interface RenderedEmailMessage {
  subject: string;
  html: string;
  text: string;
}

export function renderNotificationEmail(
  templateName: string,
  rawPayload: Record<string, unknown> | string
): RenderedEmailMessage {
  const payload: Record<string, unknown> =
    typeof rawPayload === 'string'
      ? (() => {
          try {
            return JSON.parse(rawPayload) as Record<string, unknown>;
          } catch {
            return {};
          }
        })()
      : rawPayload || {};

  const orderRef = String(payload.publicOrderRef || 'VTS-ARCHIVE');
  const amountPaise = Number(payload.finalAmountPaise ?? 0);
  const formattedAmount = `$${(amountPaise / 100).toFixed(2)}`;

  switch (templateName) {
    case 'ORDER_CONFIRMATION':
      return {
        subject: `VATSOM Atelier — COD Order ${orderRef} Sealed`,
        text: `Greetings ${payload.recipientName || 'Patron'},\n\nYour Cash on Delivery allocation (${orderRef}) for ${ payload.itemCount || 1 } vessel(s) totaling ${formattedAmount} has been inscribed in the VATSOM Ledger.\n\nPayment Method: Cash on Delivery (COD).\n\nVATSOM Botanical Atelier`,
        html: `<div style="background:#121212;color:#f4f1ea;padding:32px;font-family:Georgia,serif;">
          <h2 style="color:#c5a059;letter-spacing:0.15em;">VATSOM BOTANICAL ATELIER</h2>
          <p>Greetings ${String(payload.recipientName || 'Patron')},</p>
          <p>Your Cash on Delivery allocation <strong>${orderRef}</strong> (${Number(payload.itemCount || 1)} vessel(s)) has been sealed.</p>
          <p><strong>COD Amount Collectible on Delivery:</strong> ${formattedAmount}</p>
        </div>`
      };
    case 'ORDER_DISPATCHED':
      return {
        subject: `VATSOM Atelier — Order ${orderRef} Dispatched`,
        text: `Your VATSOM allocation (${orderRef}) has been dispatched from our cold-press vault. Please keep your Cash on Delivery amount ready upon arrival.`,
        html: `<div style="background:#121212;color:#f4f1ea;padding:32px;font-family:Georgia,serif;">
          <h2 style="color:#c5a059;letter-spacing:0.15em;">VATSOM DISPATCH NOTICE</h2>
          <p>Your allocation <strong>${orderRef}</strong> has been dispatched.</p>
        </div>`
      };
    case 'ORDER_DELIVERED':
      return {
        subject: `VATSOM Atelier — Order ${orderRef} Delivered`,
        text: `Your VATSOM allocation (${orderRef}) has been delivered. Thank you for your patronage.`,
        html: `<div style="background:#121212;color:#f4f1ea;padding:32px;font-family:Georgia,serif;">
          <h2 style="color:#c5a059;letter-spacing:0.15em;">VATSOM DELIVERY CONFIRMATION</h2>
          <p>Your allocation <strong>${orderRef}</strong> has been delivered.</p>
        </div>`
      };
    case 'SHIPMENT_TRACKING_UPDATE':
      return {
        subject: `VATSOM Atelier — Tracking Update for ${orderRef} (AWB: ${String(payload.awbNumber || '')})`,
        text: `Order ${orderRef} courier update: ${String(payload.courierName || 'Courier')} AWB ${String(payload.awbNumber || '')} is currently ${String(payload.currentShipmentState || 'IN_TRANSIT')}.`,
        html: `<div style="background:#121212;color:#f4f1ea;padding:32px;font-family:Georgia,serif;">
          <h2 style="color:#c5a059;letter-spacing:0.15em;">VATSOM COURIER AWB UPDATE</h2>
          <p>Order <strong>${orderRef}</strong> via <strong>${String(payload.courierName || '')}</strong></p>
          <p>AWB: <strong>${String(payload.awbNumber || '')}</strong> &bull; Status: <strong>${String(payload.currentShipmentState || '')}</strong></p>
        </div>`
      };
    default:
      return {
        subject: `VATSOM Botanical Atelier — Notification`,
        text: `Notification from VATSOM Botanical Atelier regarding your account.`,
        html: `<div style="background:#121212;color:#f4f1ea;padding:32px;font-family:Georgia,serif;"><p>VATSOM Botanical Atelier Notification</p></div>`
      };
  }
}

export async function dispatchEmailViaProvider(
  env: Env,
  message: {
    to: string;
    from: string;
    subject: string;
    html: string;
    text: string;
    dedupeKey: string;
  }
): Promise<{ providerMessageId: string }> {
  const provider = (env.EMAIL_PROVIDER || 'none').toLowerCase();
  const apiKey = env.EMAIL_PROVIDER_API_KEY || '';

  if (provider === 'resend') {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': message.dedupeKey
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text
      })
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Resend HTTP ${res.status}: ${errBody.slice(0, 180)}`);
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { providerMessageId: data.id || `resend-${message.dedupeKey}` };
  }

  if (provider === 'postmark') {
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'X-Postmark-Server-Token': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        From: message.from,
        To: message.to,
        Subject: message.subject,
        HtmlBody: message.html,
        TextBody: message.text,
        MessageStream: 'outbound'
      })
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Postmark HTTP ${res.status}: ${errBody.slice(0, 180)}`);
    }
    const data = (await res.json().catch(() => ({}))) as { MessageID?: string };
    return { providerMessageId: data.MessageID || `postmark-${message.dedupeKey}` };
  }

  // Fallback for custom test/mock provider (`provider === 'mock'` or custom adapter)
  if (apiKey === 'SIMULATE_PROVIDER_FAILURE') {
    throw new Error('Simulated upstream email provider 503 Service Unavailable');
  }
  return { providerMessageId: `provider-${provider}-${message.dedupeKey}` };
}

/**
 * Processes pending jobs in `notification_outbox` with:
 * - Atomic job claiming (`PROCESSING`) & duplicate-delivery protection (`sent_at IS NULL` & `Idempotency-Key`)
 * - Bounded exponential backoff retries (`attempt_count < max_attempts`, `next_attempt_at`)
 * - Structured failure monitoring logs when retries are scheduled or permanently exhausted
 * - Honest reporting: if no email provider is configured (`EMAIL_PROVIDER=none` or missing API key),
 *   marks jobs as `PROVIDER_NOT_CONFIGURED` rather than falsely claiming an email was sent.
 * - Separates TRANSACTIONAL messages (always delivered) from PROMOTIONAL messages (checked against suppression list).
 */
export async function processNotificationOutboxBatch(
  db: DatabaseClient,
  env: Env,
  batchSize = 10,
  options?: { recoverExhausted?: boolean; staleLeaseMs?: number }
): Promise<{
  processed: number;
  sent: number;
  deferred: number;
  suppressed: number;
  exhausted: number;
  recoveredStale: number;
  recoveredExhausted: number;
}> {
  // 0A. Recover any stale PROCESSING jobs whose worker lease expired (default 5 minutes)
  const staleLeaseMs = Math.max(1000, options?.staleLeaseMs ?? 5 * 60 * 1000);
  const staleCutoffIso = new Date(Date.now() - staleLeaseMs).toISOString();
  const staleRecoverRes = await db.query<{ id: string }>(
    `UPDATE notification_outbox
     SET status = 'FAILED',
         attempt_count = attempt_count + 1,
         next_attempt_at = NOW(),
         last_error = 'Recovered from stale PROCESSING lease timeout',
         updated_at = NOW()
     WHERE status = 'PROCESSING'
       AND sent_at IS NULL
       AND provider_message_id IS NULL
       AND updated_at <= $1
     RETURNING id`,
    [staleCutoffIso]
  );
  const recoveredStale = staleRecoverRes.rowCount;
  if (recoveredStale > 0) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'NOTIFICATION_OUTBOX_STALE_LEASE_RECOVERED',
        recoveredCount: recoveredStale,
        staleCutoffIso
      })
    );
  }

  // 0B. Optional manual recovery of permanently exhausted FAILED jobs after an upstream provider outage
  let recoveredExhausted = 0;
  if (options?.recoverExhausted) {
    const exhRecoverRes = await db.query<{ id: string }>(
      `UPDATE notification_outbox
       SET max_attempts = attempt_count + 3,
           next_attempt_at = NOW(),
           last_error = 'Re-queued by Administrator after provider recovery',
           updated_at = NOW()
       WHERE status = 'FAILED'
         AND attempt_count >= max_attempts
         AND sent_at IS NULL
         AND provider_message_id IS NULL
       RETURNING id`
    );
    recoveredExhausted = exhRecoverRes.rowCount;
  }

  const pendingRes = await db.query<{
    id: string;
    message_category: 'TRANSACTIONAL' | 'PROMOTIONAL';
    template_name: string;
    recipient_email: string;
    dedupe_key: string;
    payload: Record<string, unknown> | string;
    attempt_count: number;
    max_attempts: number;
    status: string;
    provider_message_id: string | null;
    sent_at: string | null;
  }>(
    `SELECT id, message_category, template_name, recipient_email, dedupe_key, payload,
            attempt_count, max_attempts, status, provider_message_id, sent_at
     FROM notification_outbox
     WHERE status IN ('PENDING', 'FAILED', 'PROVIDER_NOT_CONFIGURED')
       AND sent_at IS NULL
       AND provider_message_id IS NULL
       AND attempt_count < max_attempts
       AND next_attempt_at <= NOW()
     ORDER BY created_at ASC
     LIMIT $1`,
    [batchSize]
  );

  let sent = 0;
  let deferred = 0;
  let suppressed = 0;
  let exhausted = 0;

  for (const job of pendingRes.rows) {
    // 1. Duplicate-delivery protection: skip if already sent or missing id
    if (job.sent_at || job.provider_message_id || job.status === 'SENT') {
      continue;
    }

    // Atomically claim the job to prevent concurrent workers from double-sending
    const claimRes = await db.query<{ id: string }>(
      `UPDATE notification_outbox
       SET status = 'PROCESSING', updated_at = NOW()
       WHERE id = $1
         AND status IN ('PENDING', 'FAILED', 'PROVIDER_NOT_CONFIGURED')
         AND sent_at IS NULL
         AND provider_message_id IS NULL
       RETURNING id`,
      [job.id]
    );
    if (claimRes.rowCount === 0) {
      continue;
    }

    // 2. Check suppression list for PROMOTIONAL messages
    if (job.message_category === 'PROMOTIONAL') {
      const prefRes = await db.query<{ is_suppressed: boolean }>(
        `SELECT is_suppressed FROM email_preferences WHERE email = $1 LIMIT 1`,
        [job.recipient_email.toLowerCase()]
      );
      if (!prefRes.rows[0] || prefRes.rows[0].is_suppressed) {
        await db.query(
          `UPDATE notification_outbox
           SET status = 'SUPPRESSED', last_error = 'Recipient is suppressed or unsubscribed', updated_at = NOW()
           WHERE id = $1`,
          [job.id]
        );
        suppressed++;
        continue;
      }
    }

    const provider = (env.EMAIL_PROVIDER || 'none').toLowerCase();
    const apiKey = env.EMAIL_PROVIDER_API_KEY || '';

    if (provider === 'none' || !apiKey) {
      // Honest status: never falsely claim an email was sent when no provider is configured
      await db.query(
        `UPDATE notification_outbox
         SET status = 'PROVIDER_NOT_CONFIGURED',
             last_error = 'Email provider not yet configured; notification safely persisted in outbox.',
             updated_at = NOW()
         WHERE id = $1`,
        [job.id]
      );
      deferred++;
      continue;
    }

    // 3. Render & execute provider delivery with bounded exponential backoff on failure
    try {
      const nextAttempt = Number(job.attempt_count) + 1;
      const rendered = renderNotificationEmail(job.template_name, job.payload);
      const dispatchResult = await dispatchEmailViaProvider(env, {
        to: job.recipient_email,
        from: env.EMAIL_FROM_ADDRESS || 'atelier@vatsom.com',
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        dedupeKey: job.dedupe_key || `notif:${job.id}`
      });

      await db.query(
        `UPDATE notification_outbox
         SET status = 'SENT',
             attempt_count = $1,
             provider_message_id = $2,
             sent_at = NOW(),
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $3`,
        [nextAttempt, dispatchResult.providerMessageId, job.id]
      );
      sent++;
    } catch (err) {
      const nextAttempt = Number(job.attempt_count) + 1;
      const maxAttempts = Number(job.max_attempts || 5);
      const backoffSeconds = Math.min(3600, Math.pow(2, nextAttempt) * 30);
      const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
      const errMsg = err instanceof Error ? err.message.slice(0, 250) : 'Transient dispatch error';

      await db.query(
        `UPDATE notification_outbox
         SET status = 'FAILED',
             attempt_count = $1,
             next_attempt_at = $2,
             last_error = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [nextAttempt, nextAttemptAt, errMsg, job.id]
      );

      if (nextAttempt >= maxAttempts) {
        exhausted++;
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'NOTIFICATION_OUTBOX_PERMANENT_FAILURE',
            jobId: job.id,
            dedupeKey: job.dedupe_key,
            templateName: job.template_name,
            recipientEmail: job.recipient_email,
            attempts: nextAttempt,
            maxAttempts,
            lastError: errMsg
          })
        );
      } else {
        deferred++;
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'NOTIFICATION_OUTBOX_RETRY_SCHEDULED',
            jobId: job.id,
            dedupeKey: job.dedupe_key,
            attempt: nextAttempt,
            maxAttempts,
            nextAttemptAt,
            lastError: errMsg
          })
        );
      }
    }
  }

  return {
    processed: pendingRes.rowCount,
    sent,
    deferred,
    suppressed,
    exhausted,
    recoveredStale,
    recoveredExhausted
  };
}

/**
 * Returns outbox health metrics and recent notification records for Admin failure monitoring.
 */
export async function getNotificationOutboxMonitoring(
  db: DatabaseClient,
  limit = 50
): Promise<{
  counts: {
    pending: number;
    processing: number;
    sent: number;
    failedRetryable: number;
    failedExhausted: number;
    providerNotConfigured: number;
    suppressed: number;
  };
  recentJobs: Array<Record<string, unknown>>;
}> {
  const recentRes = await db.query<Record<string, unknown>>(
    `SELECT id, channel, message_category, template_name, recipient_email,
            order_id, dedupe_key, status, attempt_count, max_attempts,
            next_attempt_at, provider_message_id, last_error, sent_at, created_at
     FROM notification_outbox
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.min(100, Math.max(1, limit))]
  );

  const counts = {
    pending: 0,
    processing: 0,
    sent: 0,
    failedRetryable: 0,
    failedExhausted: 0,
    providerNotConfigured: 0,
    suppressed: 0
  };

  for (const row of recentRes.rows) {
    const st = String(row.status);
    const attempts = Number(row.attempt_count ?? 0);
    const maxAttempts = Number(row.max_attempts ?? 5);
    if (st === 'PENDING') counts.pending++;
    else if (st === 'PROCESSING') counts.processing++;
    else if (st === 'SENT') counts.sent++;
    else if (st === 'PROVIDER_NOT_CONFIGURED') counts.providerNotConfigured++;
    else if (st === 'SUPPRESSED') counts.suppressed++;
    else if (st === 'FAILED') {
      if (attempts >= maxAttempts) counts.failedExhausted++;
      else counts.failedRetryable++;
    }
  }

  return {
    counts,
    recentJobs: recentRes.rows
  };
}

