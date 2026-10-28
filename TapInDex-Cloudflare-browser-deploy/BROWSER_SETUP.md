# TapInDex — browser deployment walkthrough

This package prepares the Cloudflare service used by TapInDex 0.9.63. You do not need a local terminal or Node installation for the browser route. Cloudflare runs the deployment commands for you. No repository, Cloudflare service or Android APK was created by preparing this package.

## Before you start

You need your Cloudflare account, a GitHub account, and access to your existing Supabase project. Enable R2 in Cloudflare if prompted and review any billing terms. Do not assume deployment is free at every usage level.

This route is for a new service. If you already deployed the previous backend, keep its existing database, R2 bucket and encryption keys; use its connected repository to update it. Do not generate new keys, replace resources, or point the app at an empty service unless you intend a fresh installation.

## 1. Extract the small deployment ZIP

Extract `TapInDex-Cloudflare-browser-deploy.zip` on your computer. Open the extracted folder, then double-click **START_HERE.html** to open it in your browser. Keep it open alongside this walkthrough.

The ZIP contains only the backend, setup page, instructions and tests. It does not contain your Android project, signing key or actual credentials. Your Android source remains version 0.9.63; deployment setup does not require a new application version number.

## 2. Create and upload a backend-only repository

1. Open [GitHub's new repository page](https://github.com/new).
2. Name it **tapindex-cloud-template** and choose **Public** for the Deploy to Cloudflare template route. Add a README if GitHub requires an initial file, then create the repository.
3. Choose **Add file → Upload files**. Drag the **contents** of the extracted deployment folder into GitHub. Upload files and folders, not the ZIP and not a folder wrapping the whole project.
4. Commit the upload.
5. Check that `worker.mjs`, `package.json`, `package-lock.json`, `wrangler.jsonc`, `bootstrap.mjs`, `.env.example`, `tools/` and `migrations/` appear directly in the repository root. Your file manager may hide `.env.example` and `.gitignore`; enable “Show hidden files” to include them. The example is safe to upload because its secret values are empty.
6. Copy the repository home URL, such as `https://github.com/YOUR-NAME/tapindex-cloud-template`.

Only this backend bundle belongs in the public repository. Never upload the full Android project, personal backup files, signing files, generated private key file, or actual secret values. If you want to keep even the backend source private, use the alternative near the end of this guide.

## 3. Generate the Cloudflare deployment link

In the local **START_HERE.html** page:

1. Paste your public repository URL.
2. Choose **Prepare deployment link**.
3. Choose **Open Cloudflare deployment**.
4. Sign in to Cloudflare and connect GitHub when requested. Cloudflare will create a deployment repository in your Git account and prepare the service resources.

Keep the Worker name **tapindex-sharing**. For this package, use the provided database and bucket names; if there is a conflict with an existing service, stop and identify that service rather than deleting it or resetting its keys.

The deployment form should detect:

| Setting | Value |
| --- | --- |
| Root directory | Repository root (`/`) |
| Node version | 24 or newer; use `NODE_VERSION=24` in build variables if needed |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |
| Worker | `tapindex-sharing` |
| D1 binding | `DB` |
| R2 binding | `FILES` |

If Cloudflare displays only `npx wrangler deploy` as the deploy command, change it to **npm run deploy**. The supplied helper must run so database migrations are applied. Do not replace it with the default.

## 4. Fill the three secret prompts

Cloudflare reads `.env.example` to identify the secret names. Enter real values in **Cloudflare**, not GitHub.

| Secret | What to enter |
| --- | --- |
| `SUPABASE_PUBLISHABLE_KEY` | Your existing Supabase project's publishable client key |
| `BACKUP_KEY_ID` | `v1` for a new service |
| `BACKUP_KEYS_JSON` | The complete private JSON generated below |

In Supabase, open your existing project and find its API keys under project settings. Copy the **publishable** client key. Never use the service-role/admin/secret key. Confirm the public project URL in `wrangler.jsonc` matches the project your Android app uses. The supplied URL is `https://lpxejvltwbhzlptdwxog.supabase.co`; it is public configuration, not a credential.

For a new service's backup key:

1. In **START_HERE.html**, check **This is a new service with no existing cloud backups**.
2. Choose **Generate backup key locally**.
3. Save `BACKUP_KEYS_JSON` securely in a password manager or use **Save private key file** and move that file to a secure location.
4. Copy the entire JSON into Cloudflare's `BACKUP_KEYS_JSON` prompt. Set `BACKUP_KEY_ID` to `v1`.

Key generation happens in your browser. The setup page does not send the key to us, GitHub or any server. Only you paste it into Cloudflare. Reloading the page clears the generated value. Do not upload the generated private key file to the repository. Losing the required encryption key makes its backups unreadable. This is operator-managed encryption, not end-to-end encryption.

If the form does not show these prompts, check that `.env.example` was uploaded. On an existing Worker you can also add secrets under **Workers & Pages → tapindex-sharing → Settings → Variables and Secrets → Add → Secret**, then deploy the changes. Add all three as secrets, not as committed config values.

## 5. Deploy and check the build log

Choose **Deploy** in Cloudflare. Accept resource provisioning for the dedicated D1 database and private R2 bucket.

The package:

1. Runs the backend and deployment tests through the build command.
2. Uses the provided database ID, or resolves the dedicated database by name on subsequent builds.
3. For an entirely new service only, uses a maintenance Worker while Cloudflare provisions missing resources. It returns HTTP 503 and exposes no app data routes.
4. Applies both SQL migrations using the **DB binding**, then publishes the real Worker.

If setup stops, read the build error. Do not interpret an intermediate Worker URL as a successful deployment. Never delete a database to fix a migration error. A database created manually without Wrangler's migration history needs that history reconciled first.

After the final deployment succeeds:

- Copy its actual HTTPS origin, such as `https://tapindex-sharing.YOUR-SUBDOMAIN.workers.dev`.
- Open `https://YOUR-ACTUAL-ORIGIN/health`. You should receive JSON naming TapInDex sharing, not “setup is in progress”. This tests routing, not recovery.
- Check Worker **Bindings** for `DB` and `FILES`.
- Open the R2 bucket settings. Keep the public development URL disabled and do not attach a public custom domain.
- Check that the hourly cron trigger is present (`17 * * * *`).
- Keep automatic preview builds OFF until you have a separate staging database/bucket. Production data must not be used for experimental branch deployments.

Cloudflare may update resource IDs in its deployment configuration without committing those IDs to your repository. The helper handles repeat builds by resolving the same dedicated database name; it does not wipe or replace your data. Record the actual resource names/IDs and preserve them for later updates.

## 6. Connect and build Android

In your existing Android project's root `gradle.properties`, add:

```properties
tapindexSharingUrl=https://YOUR-ACTUAL-WORKER-ORIGIN
```

Use an HTTPS origin with no trailing slash, path, query or key. This URL is not secret. The browser setup does not build or sign Android for you.

Open/sync the project in Android Studio and build your normal beta APK. Use the same signing key as the existing installed app for an in-place update. Save a manual file backup before testing.

If the app still says **Cloud service not connected**, check the installed APK was rebuilt with this property. Setting it after building does not change that APK.

## 7. Prove sharing and recovery before distribution

Use test data and retain a separate file backup.

1. **Two different accounts:** both sign in and open Trade → Friends once. Owner publishes a few offered copies through My Binder → Sync binder. Friend requests access; confirm no cards appear before approval. Approve and browse. Revoke and confirm new reads are denied.
2. **Automatic binder:** enable Keep my trade binder updated in Profile & Account → Backup & restore. Change offered copies and use Sync now. Confirm the approved friend sees the update. Removing a published collection snapshot should pause automatic binder sharing.
3. **Backup on phone A:** enable Automatic recovery backup, accept consent, use Sync now, and wait for a last-backup timestamp. Include quantities, purchase metadata, a deck, wishlist and binder allocations.
4. **Restore on phone B, same account:** download the catalog, leave automatic uploads off, then choose Restore from cloud. Cancel the review once and confirm local cards stay unchanged. Repeat, review the existing import choices and apply the intended one. Compare your test data.
5. **Takeover:** after restoring, enable uploads on B and explicitly choose Use this phone. A's automatic uploads must not overwrite B's backup.
6. **Isolation and interruption:** a different account, including an approved friend, must not access recovery data. Interrupted uploads must leave the last completed backup available. Sign-out pauses automatic uploads.

Background uploads use unmetered internet when battery allows. WorkManager checks approximately every 15 minutes; recovery backups run about every six hours. Android may delay them. Sync now can use mobile data. Cloud backups are limited to 10 MiB compressed and 50 MiB expanded; larger backups still use Files.

The service retains the newest three completed backups, with older versions eligible for cleanup after a minimum 24-hour grace period. The app restores the latest only. Pausing does not delete stored backups. Verified account deletion across Supabase, D1 and R2 remains an operator task.

## Common setup problems

| Symptom | Action |
| --- | --- |
| Repository cannot be used by the deployment link | Make the backend template public and use its home URL, not a branch/file URL |
| No secret prompts | Confirm `.env.example` exists at repository root; add missing secrets in Worker settings |
| Wrong Node version / `node:sqlite` missing | Set build variable `NODE_VERSION=24` and retry |
| Database ID missing | Use `npm run deploy`; inspect resource provisioning/permissions, names and DB binding |
| Setup is in progress / HTTP 503 | Initial setup has not completed; read deployment log and fix the failed step |
| Encryption unavailable / backup HTTP 503 | Verify all three secrets and 32-byte generated key; retain prior keys if updating |
| HTTP 401 | Verify app and Worker use the same Supabase project/key; sign in again |
| Another phone is primary / HTTP 409 | Restore first, then explicitly choose Use this phone |
| Backup slots busy / HTTP 429 | Avoid repeated uploads and let hourly cleanup free staging/retention slots |

## Private-repository alternative

A public template is needed for the shared **Deploy to Cloudflare** button. You can instead create a **private** backend repository, upload the same files, and connect it directly through **Cloudflare Workers & Pages → Create application → Import a repository / Connect to Git**. Choose that repository, keep the Worker name `tapindex-sharing`, and set the build/deploy commands listed above. Add the three secrets through Worker settings if they are not prompted during import. This also runs in your browser, but it is not the shared deploy-button flow.

## Updates and remaining operator work

Cloudflare connects a deployment repository to its production branch. Updates to that connected branch can automatically deploy. Check which repository it created/connected; updating only the original template repository does not necessarily update your running service.

Use the same database, bucket and encryption keys for updates. Test in a separate staging service before production. Configure usage alerts and abuse protection. Exercise cleanup, account deletion and an operator disaster-recovery procedure that preserves D1, R2 and keys together. Publish the updated app privacy notice through your existing support-site host. Old Supabase card snapshots, if any, are not migrated/deleted by this package.

## Validation boundary and references

Tests here run production backend code against real SQLite with an in-memory R2 adapter and mocked account HTTP. Deployment tests use fake CLI responses; they verify ordering and failure handling, not a live Cloudflare account. The setup page's URL validation and local key generation are exercised in a host JavaScript fixture. No live deployment, Android compilation, browser rendering or phone testing was performed here.

- [Cloudflare deployment templates and secret prompts](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Wrangler automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)
- [Cloudflare build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
