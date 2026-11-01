import { generateSecureToken, sha256Hex } from '../crypto';
import { DatabaseClient } from '../db/client';
import { AuthorizationError, NotFoundError, ValidationError } from '../errors';
import { isEmailOrSubInAdminAllowlist, VerifiedGoogleIdentity } from '../security/google-auth';
import { AuthenticatedUser, Env, UserRole } from '../types';

export interface AddressDto {
  id: string;
  recipientName: string;
  phoneNumber: string;
  addressLine1: string;
  addressLine2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  pinCode: string;
  addressType: 'home' | 'atelier' | 'office' | 'other';
  isDefault: boolean;
  createdAt: string;
}

export async function upsertCustomerFromGoogle(
  db: DatabaseClient,
  env: Env,
  identity: VerifiedGoogleIdentity
): Promise<{ user: AuthenticatedUser; isNewCustomer: boolean }> {
  return db.withTransaction(async (tx) => {
    const existingRes = await tx.query<{
      id: string;
      google_sub: string;
      name: string;
      email: string;
      email_verified: boolean;
      mobile_number: string | null;
      role: UserRole;
      account_status: 'active' | 'suspended' | 'deleted';
    }>(
      `SELECT id, google_sub, name, email, email_verified, mobile_number, role, account_status
       FROM customers
       WHERE google_sub = $1
       FOR UPDATE`,
      [identity.sub]
    );

    const allowlistedAdmin = isEmailOrSubInAdminAllowlist(env, identity.email, identity.sub);

    const existing = existingRes.rows[0];
    if (existing) {
      if (existing.account_status !== 'active') {
        throw new AuthorizationError('This customer account has been suspended or deactivated.');
      }

      const nextRole: UserRole = allowlistedAdmin ? 'admin' : existing.role;
      const updateRes = await tx.query<{
        id: string;
        google_sub: string;
        name: string;
        email: string;
        email_verified: boolean;
        mobile_number: string | null;
        role: UserRole;
        account_status: 'active' | 'suspended' | 'deleted';
      }>(
        `UPDATE customers
         SET email = $1,
             email_verified = $2,
             role = $3,
             last_login_at = NOW(),
             updated_at = NOW()
         WHERE id = $4
         RETURNING id, google_sub, name, email, email_verified, mobile_number, role, account_status`,
        [identity.email, identity.emailVerified, nextRole, existing.id]
      );

      const updated = updateRes.rows[0]!;
      return {
        user: {
          id: updated.id,
          googleSub: updated.google_sub,
          name: updated.name,
          email: updated.email,
          emailVerified: updated.email_verified,
          mobileNumber: updated.mobile_number,
          role: updated.role,
          accountStatus: updated.account_status
        },
        isNewCustomer: false
      };
    }

    // Create new customer account
    // CRITICAL: A Google login does NOT constitute marketing consent — preferences default to all FALSE
    const initialRole: UserRole = allowlistedAdmin ? 'admin' : 'customer';
    const insertRes = await tx.query<{
      id: string;
      google_sub: string;
      name: string;
      email: string;
      email_verified: boolean;
      mobile_number: string | null;
      role: UserRole;
      account_status: 'active' | 'suspended' | 'deleted';
    }>(
      `INSERT INTO customers (
         google_sub, name, email, email_verified, role, account_status, last_login_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', NOW())
       RETURNING id, google_sub, name, email, email_verified, mobile_number, role, account_status`,
      [identity.sub, identity.name, identity.email, identity.emailVerified, initialRole]
    );

    const created = insertRes.rows[0]!;
    const unsubscribeTokenHash = await sha256Hex(generateSecureToken(32));

    await tx.query(
      `INSERT INTO email_preferences (
         email, customer_id, sub_table, sub_atmosphere, sub_new_collections,
         sub_product_updates, sub_promotional_campaigns, is_suppressed, unsubscribe_token_hash, policy_version
       ) VALUES ($1, $2, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, $3, $4)
       ON CONFLICT (email) DO UPDATE SET customer_id = EXCLUDED.customer_id`,
      [created.email, created.id, unsubscribeTokenHash, env.PRIVACY_POLICY_VERSION || '2026.11']
    );

    // Enqueue transactional Welcome Email in notification_outbox
    await tx.query(
      `INSERT INTO notification_outbox (
         channel, message_category, template_name, recipient_email,
         customer_id, dedupe_key, payload
       ) VALUES (
         'EMAIL', 'TRANSACTIONAL', 'WELCOME_PATRON', $1,
         $2, $3, $4
       ) ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        created.email,
        created.id,
        `welcome:${created.id}`,
        JSON.stringify({ name: created.name, email: created.email })
      ]
    );

    return {
      user: {
        id: created.id,
        googleSub: created.google_sub,
        name: created.name,
        email: created.email,
        emailVerified: created.email_verified,
        mobileNumber: created.mobile_number,
        role: created.role,
        accountStatus: created.account_status
      },
      isNewCustomer: true
    };
  });
}

export async function updateCustomerProfile(
  db: DatabaseClient,
  customer: AuthenticatedUser,
  input: { name?: string; mobileNumber?: string }
): Promise<AuthenticatedUser> {
  const nextName = input.name ?? customer.name;
  const nextMobile = input.mobileNumber !== undefined ? input.mobileNumber : customer.mobileNumber;

  const res = await db.query<{
    id: string;
    google_sub: string;
    name: string;
    email: string;
    email_verified: boolean;
    mobile_number: string | null;
    role: UserRole;
    account_status: 'active' | 'suspended' | 'deleted';
  }>(
    `UPDATE customers
     SET name = $1, mobile_number = $2, updated_at = NOW()
     WHERE id = $3
     RETURNING id, google_sub, name, email, email_verified, mobile_number, role, account_status`,
    [nextName, nextMobile, customer.id]
  );

  const row = res.rows[0];
  if (!row) {
    throw new NotFoundError('Customer profile not found.');
  }

  return {
    id: row.id,
    googleSub: row.google_sub,
    name: row.name,
    email: row.email,
    emailVerified: row.email_verified,
    mobileNumber: row.mobile_number,
    role: row.role,
    accountStatus: row.account_status
  };
}

function mapAddressRow(row: Record<string, unknown>): AddressDto {
  return {
    id: String(row.id),
    recipientName: String(row.recipient_name),
    phoneNumber: String(row.phone_number),
    addressLine1: String(row.address_line1),
    addressLine2: row.address_line2 ? String(row.address_line2) : null,
    landmark: row.landmark ? String(row.landmark) : null,
    city: String(row.city),
    state: String(row.state),
    pinCode: String(row.pin_code).trim(),
    addressType: (row.address_type as AddressDto['addressType']) || 'home',
    isDefault: Boolean(row.is_default),
    createdAt: String(row.created_at)
  };
}

export async function listCustomerAddresses(
  db: DatabaseClient,
  customerId: string
): Promise<AddressDto[]> {
  const res = await db.query<Record<string, unknown>>(
    `SELECT id, recipient_name, phone_number, address_line1, address_line2,
            landmark, city, state, pin_code, address_type, is_default, created_at
     FROM addresses
     WHERE customer_id = $1
     ORDER BY is_default DESC, created_at DESC`,
    [customerId]
  );
  return res.rows.map(mapAddressRow);
}

export async function createCustomerAddress(
  db: DatabaseClient,
  customerId: string,
  input: {
    recipientName: string;
    phoneNumber: string;
    addressLine1: string;
    addressLine2?: string | null;
    landmark?: string | null;
    city: string;
    state: string;
    pinCode: string;
    addressType?: 'home' | 'atelier' | 'office' | 'other';
    isDefault?: boolean;
  }
): Promise<AddressDto> {
  return db.withTransaction(async (tx) => {
    const existingCountRes = await tx.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM addresses WHERE customer_id = $1`,
      [customerId]
    );
    const count = Number(existingCountRes.rows[0]?.cnt ?? 0);
    if (count >= 10) {
      throw new ValidationError('Maximum 10 saved addresses permitted per account.');
    }

    const shouldBeDefault = input.isDefault === true || count === 0;
    if (shouldBeDefault) {
      await tx.query(
        `UPDATE addresses SET is_default = FALSE, updated_at = NOW() WHERE customer_id = $1`,
        [customerId]
      );
    }

    const res = await tx.query<Record<string, unknown>>(
      `INSERT INTO addresses (
         customer_id, recipient_name, phone_number, address_line1,
         address_line2, landmark, city, state, pin_code, address_type, is_default
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, recipient_name, phone_number, address_line1, address_line2,
                 landmark, city, state, pin_code, address_type, is_default, created_at`,
      [
        customerId,
        input.recipientName,
        input.phoneNumber,
        input.addressLine1,
        input.addressLine2 ?? null,
        input.landmark ?? null,
        input.city,
        input.state,
        input.pinCode,
        input.addressType ?? 'home',
        shouldBeDefault
      ]
    );

    return mapAddressRow(res.rows[0]!);
  });
}

export async function updateCustomerAddress(
  db: DatabaseClient,
  customerId: string,
  addressId: string,
  input: Record<string, unknown>
): Promise<AddressDto> {
  return db.withTransaction(async (tx) => {
    // Strict ownership verification to prevent IDOR
    const existingRes = await tx.query<Record<string, unknown>>(
      `SELECT * FROM addresses WHERE id = $1 AND customer_id = $2 FOR UPDATE`,
      [addressId, customerId]
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      throw new NotFoundError('Address not found in your account.');
    }

    const makeDefault =
      typeof input.isDefault === 'boolean' ? input.isDefault : Boolean(existing.is_default);
    if (makeDefault) {
      await tx.query(
        `UPDATE addresses SET is_default = FALSE WHERE customer_id = $1 AND id <> $2`,
        [customerId, addressId]
      );
    }

    const res = await tx.query<Record<string, unknown>>(
      `UPDATE addresses SET
         recipient_name = $1,
         phone_number = $2,
         address_line1 = $3,
         address_line2 = $4,
         landmark = $5,
         city = $6,
         state = $7,
         pin_code = $8,
         address_type = $9,
         is_default = $10,
         updated_at = NOW()
       WHERE id = $11 AND customer_id = $12
       RETURNING id, recipient_name, phone_number, address_line1, address_line2,
                 landmark, city, state, pin_code, address_type, is_default, created_at`,
      [
        typeof input.recipientName === 'string' ? input.recipientName : existing.recipient_name,
        typeof input.phoneNumber === 'string' ? input.phoneNumber : existing.phone_number,
        typeof input.addressLine1 === 'string' ? input.addressLine1 : existing.address_line1,
        input.addressLine2 !== undefined ? input.addressLine2 : existing.address_line2,
        input.landmark !== undefined ? input.landmark : existing.landmark,
        typeof input.city === 'string' ? input.city : existing.city,
        typeof input.state === 'string' ? input.state : existing.state,
        typeof input.pinCode === 'string' ? input.pinCode : existing.pin_code,
        typeof input.addressType === 'string' ? input.addressType : existing.address_type,
        makeDefault,
        addressId,
        customerId
      ]
    );

    return mapAddressRow(res.rows[0]!);
  });
}

export async function deleteCustomerAddress(
  db: DatabaseClient,
  customerId: string,
  addressId: string
): Promise<void> {
  const res = await db.query(
    `DELETE FROM addresses WHERE id = $1 AND customer_id = $2 RETURNING id`,
    [addressId, customerId]
  );
  if (res.rowCount === 0) {
    throw new NotFoundError('Address not found in your account.');
  }
}

