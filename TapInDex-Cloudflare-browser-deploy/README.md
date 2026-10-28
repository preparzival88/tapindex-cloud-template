# TapInDex sharing and recovery service

Start with **START_HERE.html** and **BROWSER_SETUP.md** for browser deployment. Cloudflare runs the setup commands; you do not need a local terminal. The repository must contain only this backend bundle, never your Android project, real keys or personal backups.

The service uses Supabase for account verification and private Cloudflare D1/R2 for approved sharing and recovery. Deployment is prepared here, not live. The app and runtime API remain 0.9.63-compatible.


Cloudflare Worker + D1 permissions/metadata + private R2 snapshot chunks. Supabase is called only at `/auth/v1/user` to authenticate the account bearer. No passwords, refresh tokens, or card data are written to Supabase. This is source ready for deployment review; nothing has been deployed from this workspace.

## Scope

Implements the Android client's list/request/grant/revoke/begin/stage/publish/discard/page/unpublish protocol. Owners and viewers must open configured Friends once to register their public identity with this service. Requests do not grant access. Permissions are directional; collection and wishlist are separate. Display names supplied in client request bodies are ignored.

Private snapshot chunks are immutable. Retry identical chunks safely; a changed chunk requires a new upload. Complete row counts, exact contiguous chunk sizes, ownership and quota are checked before publication. Publication is atomic at the D1 pointer: incomplete or older uploads cannot replace the current snapshot. Unpublish advances a generation so a previously begun upload cannot resurrect removed sharing. Failed uploads keep the previous published version available.

Every page checks approval before and after R2 reads. Pages examine at most four 250-row chunks. `next_after` and `has_more` advance even when a search has no matches in the current page. Android 0.9.62 understands these fields; do not pair this server with older paging clients.

Limits: 100,000 rows/snapshot; 250 rows/chunk; 512 KiB request; 50 MiB of reserved/uploaded snapshot chunks/account; four staging uploads/account; 20 access requests/minute and 600 other operations/minute/account. Requests are rejected before parsing oversized JSON. Auth verification has an 8-second deadline and does not follow redirects. Verify pricing/runtime limits for expected use; large snapshots need enough R2/D1 request allowance.

Hourly cleanup retires staging and superseded snapshots older than one day, removes discarded objects in bounded batches, and expires request counters. Current published snapshots remain. Uploads count against quota until cleaned. Deleted access never implicitly returns when a new request is sent.

## Configure and deploy (operator only)

1. In your Cloudflare account, create D1 database `tapindex-sharing` and a private R2 bucket `tapindex-private-sharing`. Do not enable public bucket access.
2. Replace `database_id` in `wrangler.jsonc` with the actual created ID. Verify the Supabase project URL matches your account environment.
3. Use Wrangler to set `SUPABASE_PUBLISHABLE_KEY` as a secret. Use the project's publishable client key, **not** a service-role/admin key. No credential values are supplied in this package.
4. Apply both migrations (`0001.sql` and `0002.sql`) to the new D1 database using Wrangler migrations. Do not apply it over an unrelated database.
5. Run `node --test test.mjs` with Node supporting `node:sqlite`. Tests do not call real Supabase or Cloudflare services.
6. Deploy the Worker using Wrangler and record its actual HTTPS origin.
7. Add edge request limits, monitoring/alerts and operational access controls. Validate quotas, cron cleanup, database export/restore and deletion procedures in a staging environment.
8. Build Android with `-PtapindexSharingUrl=https://ACTUAL-WORKER-ORIGIN`. Without that property the UI correctly remains disconnected.
9. Test two real accounts: register both through Friends, request access, approve, publish via My Binder → Sync binder, browse, revoke, and verify access denial. Repeat with network interruption and changed snapshots.

No token or storage credentials belong in query strings, logs, QR codes or the APK. The Worker receives the user's existing account bearer and verifies it server-side. Unexpected server failures return a generic 503, without leaking SQL or private data.

## Recovery and automatic sync

Android 0.9.63 adds opt-in WorkManager binder sync and owner-only recovery backups. See `../CLOUDFLARE_SETUP.md` for full deployment, encryption secrets, primary-phone takeover and recovery testing. Cloud copies are compressed, split into 256 KiB packets, AES-GCM encrypted with operator-managed keys, verified before publication, and retained with a newest-three policy plus a 24-hour cleanup grace period. Restore downloads only the latest backup and opens the existing review workflow. This is not multi-device merge sync or end-to-end encryption.

## Not yet included

Offline friend download cache, client-held recovery keys, QR pairing, full device session management, account deletion automation, block lists, push notifications and the hosted two-party trade API. `trade_requests` is a persisted permission only; this sharing service does not finalize trades or mutate phone inventory. The older reference trade server remains separate.

Sync binder is an explicit upload of offered copies to the collection feed, not a full private recovery backup. Friends can read only after approval. No automatic migration/deletion of old Supabase snapshots is attempted. Review and migrate/remove those separately before asserting Supabase contains only identity data.

## Test boundary

Tests execute the production Worker logic and SQL against real SQLite using a D1 adapter and in-memory R2. Auth HTTP responses are mocked. This exercises invariants and failure paths but does not prove live D1/R2 behavior, deployed permissions, network latency or Android rendering. Deploy to staging and run the two-account checks before production.
