## Goal

Move the Store UI fully into the frontend app, remove all Next.js store pages/components, and keep only API endpoints under `src/packages/next/pages/api/v2`. The new store sells only:

- Membership (purchase/upgrade)
- Credit vouchers
- Course package (placeholder)
- Organization site license (placeholder)

Also add admin-only purchase controls (target user + discount/custom price + funding + notes) for manual/admin-assisted purchases.

## Decisions

- **Store location:** frontend account/settings page (`/settings/store`) with a new Store tab. This keeps the store inside the logged-in app and avoids new top-nav tabs.
- **Membership purchase (self):** reuse existing in-app membership modal (already handles Stripe vs credit and upgrades/downgrades).
- **Voucher purchase (self):** new in-app flow using Stripe payment when needed, and direct purchase when credit covers the cost.
- **Admin purchases:** admin-only flow with extra fields; no Stripe checkout. Supports “use user credit” or “free” (free creates an offsetting credit purchase so balance remains unchanged).
- **Membership admin purchases:** use admin-assigned membership with expiry derived from the selected interval, plus a purchase record marked as admin.
- **Placeholders:** course packages and org licenses show “Coming soon” and no purchase action yet.

## Checklist

### 1) Frontend Store Page (app)

- [x] Create `src/packages/frontend/store/` with `StorePage` and product cards.
- [x] Add Store tab to account settings nav + route handling (`AccountPage` / `actions.push_state`).
- [x] Update existing store links in the app (e.g., balance modal, LLM cost estimation) to open the new Store tab.

### 2) Voucher Purchase (self-service)

- [x] Add a small voucher purchase panel in Store (amount, quantity, title).
- [x] New API endpoint to create vouchers when fully paid by credit (no Stripe).
- [x] New Stripe “purpose” for voucher purchase, with metadata for voucher config; process in payment-intent handler to create vouchers after payment settles.
- [x] UI status for “processing” and link to voucher center (existing `/vouchers`).

### 3) Admin Purchase Flow

- [x] UI (admin only): target user (account_id/email), discount (%/$), custom price, funding source (credit/free), comment.
- [x] Backend admin endpoint to create purchases for:
  - membership (admin assignment + purchase record + optional free credit)
  - vouchers (create voucher codes + purchase record + optional free credit)
- [x] Ensure purchase notes/tag include admin account_id and comment for audit.

### 4) Remove Next.js Store UI

- [x] Delete `src/packages/next/components/store/*`.
- [x] Delete `src/packages/next/pages/store/[[...page]].tsx`.
- [x] Remove “Store” links in Next landing header/footer and marketing pages.

### 5) Polishing

- [x] Ensure Store tab copy is simple and matches current membership language.
- [x] Add lightweight empty/placeholder text for course package + org license.
- [x] Sanity check TypeScript + basic navigation.

### 6) Cleanup

- [ ] Delete all backup code and api routes related to shopping carts, buy it again, etc.
