import type { PublicUser } from "./auth";
import type { Db } from "./db";

export type BillingAccountRow = {
  user_id: string;
  provider: string;
  plan_key: string;
  status: string;
  billing_email: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_price_id: string | null;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
};

export type BillingInvoiceRow = {
  id: number;
  provider: string;
  external_id: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  hosted_url: string | null;
  invoice_pdf: string | null;
  period_start: string | null;
  period_end: string | null;
  created_at: string;
};

export function ensureBillingAccount(db: Db, user: PublicUser) {
  db.prepare(
    `insert into billing_accounts(
       user_id,
       billing_email,
       created_at,
       updated_at
     )
     values (?, ?, datetime('now'), datetime('now'))
     on conflict(user_id) do update set
       billing_email=excluded.billing_email,
       updated_at=datetime('now')`
  ).run(user.id, user.email);
}

export function getBillingAccount(db: Db, userId: string): BillingAccountRow | null {
  return (
    (db
      .prepare(
        `select user_id, provider, plan_key, status, billing_email, stripe_customer_id, stripe_subscription_id,
                stripe_checkout_session_id, stripe_price_id, current_period_end, created_at, updated_at
         from billing_accounts
         where user_id=?
         limit 1`
      )
      .get(userId) as BillingAccountRow | undefined) ?? null
  );
}

export function upsertBillingAccount(
  db: Db,
  userId: string,
  patch: {
    provider?: string;
    planKey?: string;
    status?: string;
    billingEmail?: string | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    stripeCheckoutSessionId?: string | null;
    stripePriceId?: string | null;
    currentPeriodEnd?: string | null;
  }
) {
  const current =
    getBillingAccount(db, userId) ?? ({
      user_id: userId,
      provider: "stripe",
      plan_key: "growth",
      status: "inactive",
      billing_email: null,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      stripe_checkout_session_id: null,
      stripe_price_id: null,
      current_period_end: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } satisfies BillingAccountRow);

  db.prepare(
    `insert into billing_accounts(
       user_id,
       provider,
       plan_key,
       status,
       billing_email,
       stripe_customer_id,
       stripe_subscription_id,
       stripe_checkout_session_id,
       stripe_price_id,
       current_period_end,
       created_at,
       updated_at
     )
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, coalesce((select created_at from billing_accounts where user_id=?), datetime('now')), datetime('now'))
     on conflict(user_id) do update set
       provider=excluded.provider,
       plan_key=excluded.plan_key,
       status=excluded.status,
       billing_email=excluded.billing_email,
       stripe_customer_id=excluded.stripe_customer_id,
       stripe_subscription_id=excluded.stripe_subscription_id,
       stripe_checkout_session_id=excluded.stripe_checkout_session_id,
       stripe_price_id=excluded.stripe_price_id,
       current_period_end=excluded.current_period_end,
       updated_at=datetime('now')`
  ).run(
    userId,
    patch.provider ?? current.provider,
    patch.planKey ?? current.plan_key,
    patch.status ?? current.status,
    patch.billingEmail ?? current.billing_email,
    patch.stripeCustomerId ?? current.stripe_customer_id,
    patch.stripeSubscriptionId ?? current.stripe_subscription_id,
    patch.stripeCheckoutSessionId ?? current.stripe_checkout_session_id,
    patch.stripePriceId ?? current.stripe_price_id,
    patch.currentPeriodEnd ?? current.current_period_end,
    userId
  );
}

export function listBillingInvoices(db: Db, userId: string): BillingInvoiceRow[] {
  return db
    .prepare(
      `select id, provider, external_id, amount_cents, currency, status, hosted_url, invoice_pdf, period_start,
              period_end, created_at
       from billing_invoices
       where user_id=?
       order by created_at desc
       limit 12`
    )
    .all(userId) as BillingInvoiceRow[];
}

export function upsertBillingInvoice(
  db: Db,
  userId: string,
  invoice: {
    provider?: string;
    externalId?: string | null;
    amountCents?: number;
    currency?: string;
    status: string;
    hostedUrl?: string | null;
    invoicePdf?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
  }
) {
  if (!invoice.externalId) {
    db.prepare(
      `insert into billing_invoices(
         user_id, provider, external_id, amount_cents, currency, status, hosted_url, invoice_pdf, period_start,
         period_end, created_at
       )
       values (?, ?, null, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(
      userId,
      invoice.provider ?? "stripe",
      invoice.amountCents ?? 0,
      invoice.currency ?? "usd",
      invoice.status,
      invoice.hostedUrl ?? null,
      invoice.invoicePdf ?? null,
      invoice.periodStart ?? null,
      invoice.periodEnd ?? null
    );
    return;
  }

  db.prepare(
    `insert into billing_invoices(
       user_id, provider, external_id, amount_cents, currency, status, hosted_url, invoice_pdf, period_start,
       period_end, created_at
     )
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     on conflict(provider, external_id) do update set
       amount_cents=excluded.amount_cents,
       currency=excluded.currency,
       status=excluded.status,
       hosted_url=excluded.hosted_url,
       invoice_pdf=excluded.invoice_pdf,
       period_start=excluded.period_start,
       period_end=excluded.period_end`
  ).run(
    userId,
    invoice.provider ?? "stripe",
    invoice.externalId,
    invoice.amountCents ?? 0,
    invoice.currency ?? "usd",
    invoice.status,
    invoice.hostedUrl ?? null,
    invoice.invoicePdf ?? null,
    invoice.periodStart ?? null,
    invoice.periodEnd ?? null
  );
}

export function summarizeUsage(db: Db, userId: string) {
  const row = db
    .prepare(
      `select
         count(*) as total,
         sum(case when status in ('Provisioning', 'Ready') then 1 else 0 end) as active,
         sum(case when status='Ready' then 1 else 0 end) as ready,
         sum(case when status='Failed' then 1 else 0 end) as failed
       from stores
       where user_id=?`
    )
    .get(userId) as
    | {
        total: number;
        active: number | null;
        ready: number | null;
        failed: number | null;
      }
    | undefined;

  return {
    totalStores: row?.total ?? 0,
    activeStores: row?.active ?? 0,
    readyStores: row?.ready ?? 0,
    failedStores: row?.failed ?? 0,
  };
}
