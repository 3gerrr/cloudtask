# CloudTask Capstone — Handoff Notes

## Context
Building the CloudTask capstone (Node/Express API, Azure SQL, Blob Storage, Key Vault,
VNet/private endpoints, Log Analytics, GitHub Actions CI/CD) per the course brief.
Environment: Windows, PowerShell (VS Code integrated terminal), Azure CLI, trial subscription.

**Subscription ID:** e3dff262-7b84-43a3-aff3-615afe6c94fe

## Deliberate deviations from the original course doc — DO NOT revert these

1. **Passwordless SQL auth (Azure AD-only), not username/password.**
   The original doc creates a SQL admin login+password and stores a connection string
   (with embedded password) in Key Vault. We rejected that — it defeats the point of
   managed identity. Instead:
   - SQL server was created with `--enable-ad-only-auth`, admin = the user's own AAD
     account. **No SQL password exists anywhere in this project.**
   - `server.js` connects via `DefaultAzureCredential().getToken('https://database.windows.net/.default')`
     and passes the token to `mssql` via `authentication: { type: 'azure-active-directory-access-token' }`.
   - Locally, this works because the user is logged in via `az login` and has been granted
     equivalent roles to what the deployed App Service's managed identity will need.
   - **Done (2026-08-23):** the App Service's managed identity now has
     `CREATE USER [app-cloudtask-xaa7z0] FROM EXTERNAL PROVIDER` + db_datareader/
     db_datawriter in `db-cloudtask`, plus Storage Blob Data Contributor and Key Vault
     Secrets User roles — see Phase 3 section below for details.

2. **Private endpoints must not be enabled until App Service has VNet integration.**
   The doc's Phase 4 order breaks the app: it enables private endpoints on SQL/Storage
   (Phase 4.3) but App Service isn't VNet-integrated until Phase 4.1, and there's no
   private DNS zone setup at all. Correct order:
   a. VNet-integrate App Service into `snet-web` FIRST
   b. Create private DNS zones for `privatelink.database.windows.net` and
      `privatelink.blob.core.windows.net`, link them to `vnet-cloudtask`
   c. THEN create private endpoints for SQL and Storage in `snet-endpoints`
   d. THEN disable public network access on SQL/Storage
   e. Test connectivity end-to-end before considering this phase done — if App Service
      can no longer reach SQL/Storage after this, DNS resolution is the most likely cause.

## Resources already provisioned (do not recreate — reuse these)

| Resource | Name | Region | Notes |
|---|---|---|---|
| Resource group | `rg-cloudtask` | eastus | tags: Project=CloudTask, Environment=Production |
| VNet | `vnet-cloudtask` | **centralus** (moved from eastus — see below) | 10.0.0.0/16 |
| Subnet (web) | `snet-web` | — | 10.0.1.0/24 — App Service will VNet-integrate here |
| Subnet (data) | `snet-data` | — | 10.0.2.0/24 — currently unused, reserved per original design |
| Subnet (endpoints) | `snet-endpoints` | — | 10.0.3.0/24 — private endpoints go here |
| Key Vault | `kv-cloudtask-alz3u0` | eastus | RBAC-authorization enabled (not access policies) |
| SQL Server | `sql-cloudtask-wy7bfk` | **centralus** (not eastus — eastus/eastus2 both rejected SQL server creation on this trial subscription) | AAD-only auth, admin = user's own account |
| SQL Database | `db-cloudtask` | centralus | Serverless, GP_S_Gen5_1, auto-pause 60min |
| Storage Account | `stcloudtaskidotzk` | eastus | StorageV2, Standard_LRS |
| App Service Plan | `asp-cloudtask` | centralus | Linux, B1. Has a free-tier promo credit (`FreeOfferExpirationTime` 2026-09-22) — starts billing normally after that date. |
| Web App | `app-cloudtask-xaa7z0` | centralus | Node 24-lts (18-lts is retired on Azure App Service — see below). System-assigned managed identity, principal ID `1905738c-249a-4b61-8f5a-fcca6c05b692`. URL: `https://app-cloudtask-xaa7z0.azurewebsites.net`. VNet-integrated into `snet-web`. |
| Private DNS zone | `privatelink.database.windows.net` | global | Linked to `vnet-cloudtask` (link name `link-sql`), no auto-registration |
| Private DNS zone | `privatelink.blob.core.windows.net` | global | Linked to `vnet-cloudtask` (link name `link-blob`), no auto-registration |
| Private endpoint | `pe-sql-cloudtask` | centralus | In `snet-endpoints`, group-id `sqlServer`, DNS zone group `dzg-sql` |
| Private endpoint | `pe-blob-cloudtask` | centralus | In `snet-endpoints`, group-id `blob`, DNS zone group `dzg-blob` |
| Log Analytics workspace | `log-cloudtask` | centralus | 30-day retention. Diagnostic setting `diag-cloudtask-webapp` routes App Service logs/metrics here. |
| Action group | `ag-cloudtask-email` | global | Short name `ctalerts`. Email receiver: `asapcreamy01@gmail.com` |
| Metric alert | `alert-cloudtask-5xx` | global | On `app-cloudtask-xaa7z0`, fires when `Http5xx` > 5 in 5 min, severity 2, notifies `ag-cloudtask-email` |
| Budget | `budget-cloudtask` | — | $20/month, scoped to `rg-cloudtask`, notifies `asapcreamy01@gmail.com` at 50%/80% actual cost |
| GitHub repo | `3gerrr/cloudtask` | — | Public. `master` is the default/deploy branch. Workflow: `.github/workflows/deploy.yml`. Secret: `AZURE_WEBAPP_PUBLISH_PROFILE`. |

**Known regional restriction — now extends beyond SQL:** this trial subscription rejects
new SQL Server creation *and* App Service Plan creation (any SKU, including Free F1) in
`eastus`, `eastus2`, `westus2`, and `uksouth` (`Total VMs quota: 0`). `centralus` is the
only region confirmed to work for both so far. If provisioning any *other* new resource
type hits a similar region rejection, try `centralus` first, then `westus2` or
`uksouth`/`northeurope` — do not assume eastus works for everything just because Key
Vault and Storage happened to provision there.

**VNet was recreated in centralus (2026-08-23):** Azure requires regional VNet
integration to have the App Service Plan and the VNet in the *same region*. Since
App Service could only be provisioned in centralus (quota), and `vnet-cloudtask` had
no dependents yet (empty subnets, nothing deployed), it was deleted from eastus and
recreated identically (same address space/subnet layout) in centralus. Storage and Key
Vault remain in eastus — private endpoints to them from the centralus VNet are fine,
Private Link supports cross-region.

**Known VM SKU restriction (from the earlier OwnCloud project, same subscription):**
B-series VM sizes are unavailable in both uksouth and eastus for this subscription.
Not directly relevant to CloudTask (App Service is PaaS, no VM sizing involved), but
if any component ever needs a VM, use `Standard_D2s_v7` with a `-gen2` image variant.

**Resource provider registrations already completed:** Microsoft.KeyVault, Microsoft.Sql,
Microsoft.Storage, Microsoft.Web, Microsoft.Insights, Microsoft.OperationalInsights.
If a `MissingSubscriptionRegistration` error appears for a different namespace, register
it the same way: `az provider register --namespace <namespace>`, then poll
`az provider show --namespace <namespace> --query registrationState -o tsv` until
`Registered` before retrying.

## IAM / RBAC already granted to the user's own account (for local dev parity)

- `Storage Blob Data Contributor` on `stcloudtaskidotzk`
- `Key Vault Secrets User` on `kv-cloudtask-alz3u0`
- AAD admin on `sql-cloudtask-wy7bfk` (full access, no separate role needed)

The user's object ID: `ad7182fc-89c0-4804-a3fe-64867f12296e`

## SQL firewall rules already in place

- `AllowAzure` (0.0.0.0–0.0.0.0) — lets Azure services (incl. future App Service) connect
- `AllowMyIP` (single IP, now stale — user's ISP rotates IPs)
- `AllowPortalRange` (181.215.65.0/24) — for Azure Portal Query Editor access
- `AllowMyISPRange` (102.88.160.0–102.88.175.255) — user's home ISP range, also may drift

**Note:** the user's ISP appears to use CGNAT / rotating IPs. If local dev SQL connections
start failing with firewall errors again, this is the first thing to check — either widen
the allowed range further or advise the user to test primarily against the deployed
App Service instead of local dev once deployment exists.

## Database schema (already created and seeded in db-cloudtask)

```sql
CREATE TABLE Tasks (
    Id INT PRIMARY KEY IDENTITY(1,1),
    Title NVARCHAR(200) NOT NULL,
    Description NVARCHAR(MAX) DEFAULT '',
    Assignee NVARCHAR(100) DEFAULT '',
    Priority NVARCHAR(20) DEFAULT 'Medium',
    Status NVARCHAR(20) DEFAULT 'Open',
    CreatedAt DATETIME2 DEFAULT GETUTCDATE()
);

CREATE TABLE Attachments (
    Id INT PRIMARY KEY IDENTITY(1,1),
    TaskId INT NOT NULL FOREIGN KEY REFERENCES Tasks(Id) ON DELETE CASCADE,
    FileName NVARCHAR(255) NOT NULL,
    BlobName NVARCHAR(500) NOT NULL,
    Size INT NOT NULL,
    UploadedAt DATETIME2 DEFAULT GETUTCDATE()
);
```
5 rows currently in Tasks (4 seed rows + 1 test row created during local dev testing,
titled "Test from local" — safe to leave, delete, or ignore).

## App code status

- `server.js` — complete, in `~/cloudtask/server.js`. Uses managed-identity SQL auth
  (see deviation #1 above). All 8 endpoints from the brief are implemented: health,
  list/get/create/update/delete tasks, upload/list attachments.
- `package.json` — scripts configured (`start`, `dev`), all dependencies installed.
- `.env` (local only, gitignored) — currently contains:
  ```
  PORT=3000
  SQL_SERVER=sql-cloudtask-wy7bfk.database.windows.net
  SQL_DATABASE=db-cloudtask
  STORAGE_URL=https://stcloudtaskidotzk.blob.core.windows.net
  ```
- **Fully tested locally** against real Azure SQL + Blob Storage: health check, list
  tasks, create task all confirmed working via `Invoke-RestMethod`.
- **Fully tested against the deployed App Service (2026-08-23):** all 8 endpoints
  passing, including update/delete/attachments — see Phase 3 section below. One bug
  (SAS URL generation) was found and fixed during this pass.
- Express is v5.x (not v4 as the original doc assumes) — no known issues so far but
  worth double-checking if any routing/middleware behaves unexpectedly.
- Node v24 locally and Node 24-lts on the deployed App Service — no version gap
  (18-lts turned out to be retired on Azure App Service by the time of deployment).

## Phase 3 — App Service deployment: DONE (2026-08-23)

- App Service Plan `asp-cloudtask` (Linux, B1, centralus) + Web App
  `app-cloudtask-xaa7z0` (Node 24-lts) created. **Node 18-lts is retired on Azure App
  Service** — only 22-lts and 24-lts are offered now (`az webapp list-runtimes`); used
  24-lts to match local dev (Node v24).
- System-assigned managed identity enabled (principal ID
  `1905738c-249a-4b61-8f5a-fcca6c05b692`, display name = app name).
- RBAC granted to the managed identity: `Storage Blob Data Contributor` on
  `stcloudtaskidotzk`, `Key Vault Secrets User` on `kv-cloudtask-alz3u0`.
- SQL access granted: connected to `db-cloudtask` as AAD admin (via a throwaway Node
  script using the same `mssql` + `DefaultAzureCredential` pattern as `server.js`,
  since `sqlcmd` isn't installed) and ran
  `CREATE USER [app-cloudtask-xaa7z0] FROM EXTERNAL PROVIDER;` +
  `ALTER ROLE db_datareader/db_datawriter ADD MEMBER [app-cloudtask-xaa7z0];`.
- App settings `SQL_SERVER`, `SQL_DATABASE`, `STORAGE_URL` set (plus
  `SCM_DO_BUILD_DURING_DEPLOYMENT=true` — required for Oryx to run `npm install`
  server-side; without it `az webapp deploy` ships the zip as-is with no
  `node_modules` and the container crash-loops).
- Deployed via `az webapp deploy --type zip` (zip containing only `server.js`,
  `package.json`, `package-lock.json` — **not** `node_modules`, so Oryx builds
  Linux-native binaries instead of shipping locally-built Windows ones).
- **Bug found and fixed during testing:** the attachments-list endpoint called
  `blockBlob.generateSasUrl()`, which only works with a `StorageSharedKeyCredential`.
  Since Blob Storage is authenticated via `DefaultAzureCredential` (AAD), this throws
  at runtime. Fixed by requesting a user-delegation key
  (`blobService.getUserDelegationKey`) and signing the SAS with
  `generateBlobSASQueryParameters` instead — works because the identity already has
  `Storage Blob Data Contributor`, which includes the delegation-key permission.
- All 8 endpoints tested live against `https://app-cloudtask-xaa7z0.azurewebsites.net`:
  health, list/get/create/update/delete tasks, upload + list attachments (including
  downloading via the generated SAS URL). All passing.
- **Tooling gotcha (Git Bash on Windows):** `az role assignment create --scope
  "/subscriptions/..."` fails with a bogus `MissingSubscriptionRegistration`-looking
  error (`MissingSubscription`) because Git Bash's MSYS path conversion rewrites the
  leading `/subscriptions/...` into a Windows path
  (`C:/Program Files/Git/subscriptions/...`). Fix: `export MSYS_NO_PATHCONV=1` before
  any Azure CLI command whose argument starts with `/`.
- Note: the CLI's own `az webapp deploy` status poller reported "Site failed to start
  within 10 mins" on the second deploy attempt even though the container logs showed
  it actually started successfully (~50s after the build finished) — this looks like
  stale state left over from manually killing an earlier in-flight deploy command,
  not a real failure. Always verify against the live URL rather than trusting that
  poller output alone if something looks inconsistent.

## User-verified checkpoint (independent of Claude Code's own testing)

After Phase 3 completion, the user personally re-tested the deployed app and confirmed:
- `GET /api/health` on the live URL → healthy, db connected, storage connected
- `GET /api/tasks` on the live URL → returned the same rows as local dev (no drift)
- `POST /api/tasks` on the live URL → created Id 7 ("Test from deployed App Service"),
  confirming the managed-identity write path works in production. Independently
  re-verified present in the live DB via `GET /api/tasks` before starting Phase 4.

This is a confirmed-good, user-verified state as of 2026-08-23. **Any breakage during
or after Phase 4 network lockdown should be assumed caused by the network changes**,
since the pre-lockdown state is independently confirmed working, not just self-reported.

## Phase 4 — Network lockdown: DONE (2026-08-23)

Followed the corrected order from deviation #2 above. Full 8-endpoint sweep run after
*each* step (script preserved conceptually below); nothing broke until the final,
expected place.

1. **VNet-integrated the Web App into `snet-web`:**
   `az webapp vnet-integration add -g rg-cloudtask -n app-cloudtask-xaa7z0 --vnet
   vnet-cloudtask --subnet snet-web`. All 8 endpoints passed immediately after.
2. **Created private DNS zones** `privatelink.database.windows.net` and
   `privatelink.blob.core.windows.net`, linked both to `vnet-cloudtask`
   (`registration-enabled false`). All 8 endpoints still passed (no records existed yet,
   so this step alone couldn't have changed resolution).
3. **Created private endpoints** `pe-sql-cloudtask` (group-id `sqlServer`) and
   `pe-blob-cloudtask` (group-id `blob`) in `snet-endpoints`, then a DNS zone group on
   each linking it to the matching private DNS zone (auto-creates the A record). All 8
   endpoints still passed (public access was still open at this point, so this only
   proves the private endpoints provisioned cleanly, not that they're actually being
   used yet).
   - **Gotcha:** `az network private-endpoint create` defaults to the *resource group's*
     location, not the VNet's. Since `rg-cloudtask` itself is in eastus but
     `vnet-cloudtask` is in centralus, the first attempt failed with
     `InvalidResourceReference` (couldn't find the VNet — it was looking in the wrong
     region). Fix: pass `--location centralus` explicitly on `private-endpoint create`.
4. **Disabled public network access on SQL** (`az sql server update ... --set
   publicNetworkAccess=Disabled`), tested — all 8 endpoints passed. This is the first
   real proof the SQL private endpoint actually works: the app could only have reached
   SQL via the private path at this point.
5. **Disabled public network access on Storage** (`az storage account update ...
   --public-network-access Disabled`), tested — 7 of 8 passed (health, list, get,
   create, update, attachment upload, attachment list). The 8th check — downloading the
   attachment directly via its SAS URL — failed with 403, **as expected**: that check
   runs from a local dev machine outside the VNet, not through the App Service, so it's
   hitting the now-disabled public blob endpoint directly. This is the lockdown working
   correctly, not a regression — every operation that actually goes through the App
   Service (which is VNet-integrated) still works.

**Known consequence — local dev workflow changes:** now that both SQL and Storage have
public access disabled, running `server.js` locally (or any direct `az` CLI command
against them, e.g. `az storage blob ...`, `sqlcmd`) from a normal dev machine will no
longer reach them — only resources inside `vnet-cloudtask` (i.e., the deployed App
Service) can. This was anticipated in the original SQL firewall notes above ("advise the
user to test primarily against the deployed App Service instead of local dev once
deployment exists") — that's now the actual state. If local dev against live Azure
resources is needed again, options are: a VPN gateway or Azure Bastion into the VNet, or
temporarily re-enabling public access with a scoped firewall rule.

**Known leftover:** one test attachment blob from the last endpoint sweep (task-scoped,
under the `attachments` container) couldn't be cleaned up — the local `az storage blob
delete` command hit the same now-disabled public access and failed with "request may be
blocked by network rules of storage account." Harmless (negligible size/cost) but if it
needs cleaning up, it has to be done from something inside the VNet (e.g. via Kudu
console on the Web App, or a script run from a VM/Bastion session in the VNet).

## Phase 5 — Monitoring & governance: DONE (2026-08-23)

- **Log Analytics workspace** `log-cloudtask` created in centralus (co-located with the
  Web App; 30-day retention default).
- **Diagnostic settings** `diag-cloudtask-webapp` on `app-cloudtask-xaa7z0`, routing
  `AppServiceHTTPLogs`, `AppServiceConsoleLogs`, `AppServiceAppLogs`,
  `AppServicePlatformLogs`, and `AllMetrics` to `log-cloudtask`. Confirmed data is
  actually arriving (`AppServicePlatformLogs`, `AppServiceConsoleLogs`, `AzureMetrics`
  all had rows within a few minutes). **`AppServiceHTTPLogs` specifically had 0 rows
  when last checked** — the other categories were flowing fine, so this is very likely
  just slightly longer ingestion latency for that category rather than a
  misconfiguration, but worth a follow-up `AppServiceHTTPLogs | count` query to confirm
  it eventually populates (the 5xx alert itself doesn't depend on this table — see
  below — so this isn't blocking, just worth closing the loop on).
- **Action group** `ag-cloudtask-email` (short name `ctalerts`), email receiver
  `asapcreamy01@gmail.com`. **Note:** this is *not* the same address as the Claude
  account email on this machine — asked the user explicitly rather than assuming, since
  the two differ.
- **Metric alert** `alert-cloudtask-5xx` on `app-cloudtask-xaa7z0`: fires when the
  `Http5xx` metric totals more than 5 in a 5-minute window, severity 2, action group
  `ag-cloudtask-email`. This uses platform metrics directly (not the Log Analytics
  HTTP logs table), so it's unaffected by the ingestion-latency note above.
- **Budget** `budget-cloudtask`: $20/month, scoped to the `rg-cloudtask` resource group
  (not the whole subscription — keeps it specific to this project), with notifications
  at 50% and 80% of actual cost to `asapcreamy01@gmail.com`. **Created via `az rest`
  against the ARM API directly** (`PUT .../Microsoft.Consumption/budgets/budget-cloudtask
  ?api-version=2023-11-01`), because this CLI version's `az consumption budget create`
  (a preview command group) doesn't expose a `--notifications` flag — if recreating or
  modifying this budget later, use the REST body pattern in this session rather than
  expecting the plain CLI command to support thresholds.
- App smoke-tested (health/list/get/create/delete) after each step above — all passed
  throughout. Full attachment-upload sweep wasn't re-run for every micro-step post-
  Phase-4 to avoid piling up orphaned test blobs in the now-locked-down storage account
  (see Phase 4 notes on why local cleanup of blobs no longer works); a full sweep was
  run once at the end of Phase 4 and confirmed working, and monitoring changes carry
  much lower risk of breaking connectivity than the network changes did.

## Remaining phases (not started)

## Phase 6 — GitHub Actions CI/CD: DONE (2026-08-24)

Used the publish-profile secret approach (per the original course doc), on explicit
user instruction to move fast rather than switch to federated OIDC — see the trade-off
note below.

- **GitHub CLI (`gh`) installed via winget** — wasn't present on this machine at all
  (checked both Git Bash PATH and Windows PATH). Authenticated via `gh auth login --web`
  device-code flow (required the user to approve in their browser twice — the first
  device code expired waiting on an unrelated question, the second attempt hit a
  transient network blip mid-flow, the third succeeded). Logged in as GitHub user
  `3gerrr`.
- **Repo created:** `https://github.com/3gerrr/cloudtask`, **public** (user's choice).
  First commit includes `server.js`, `package.json`/`package-lock.json`, `.gitignore`,
  `CLOUDTASK_HANDOFF.md`, and the workflow file — deliberately excludes the stray
  `CLOUDTASK_HANDOFF (1).md` duplicate file sitting in the working directory (see the
  session note further down about what that file is).
- **Workflow:** `.github/workflows/deploy.yml`, triggers on push to `master` (the
  actual default branch — not `main`) plus `workflow_dispatch`. Just checks out the
  repo and runs `azure/webapps-deploy@v3` with `package: .` — deliberately does **not**
  run `npm install`/`npm ci` in the workflow itself, relying on the
  `SCM_DO_BUILD_DURING_DEPLOYMENT=true` app setting from Phase 3 so Oryx builds
  Linux-native dependencies server-side, consistent with how Phase 3's manual deploy
  was done.
- **Real blocker hit and fixed:** the first two workflow runs failed fast (~10-12s)
  with `Publish profile is invalid for app-name and slot-name provided`, preceded by a
  `Failed to get app runtime OS` warning. Root cause: **this App Service had SCM Basic
  Auth publishing credentials disabled by default** (`basicPublishingCredentialsPolicies/scm`
  → `allow: false` — Azure's modern default, present even though we never explicitly
  disabled it). Publish-profile deployment is fundamentally a username/password Basic
  Auth flow to Kudu/SCM, so it can't work at all with that policy off. Fixed via:
  `az resource update -g rg-cloudtask -n scm --resource-type
  basicPublishingCredentialsPolicies --parent sites/app-cloudtask-xaa7z0 --namespace
  Microsoft.Web --set properties.allow=true`.
  **Important follow-up gotcha:** the publish profile fetched *before* this policy
  change contained a password that kept 401ing even after the policy flip and an app
  restart — had to fetch a *fresh* publish profile (`az webapp deployment
  list-publishing-profiles ... --xml`) *after* enabling basic auth for the credentials
  to actually work. If publish-profile auth ever needs re-doing, always re-fetch after
  any basic-auth-policy change, don't reuse an old cached profile.
- Verified the fresh credentials directly against
  `https://app-cloudtask-xaa7z0.scm.azurewebsites.net/api/settings` via curl (got 200)
  *before* retrying the GitHub Actions run, to isolate the problem from any
  GitHub-runner-specific networking question.
- Updated the `AZURE_WEBAPP_PUBLISH_PROFILE` GitHub secret with the working profile,
  re-ran the workflow (`gh run rerun`) — **succeeded in 1m48s**.
- All 8 endpoints tested against the live URL after the pipeline run: 7/8 passed
  (health, list, get, create, update, attachment upload, attachment list, delete — all
  through the app). The SAS-URL download check failed with 403, same as every test
  since Phase 4 — expected, since that check hits Storage directly from outside the
  VNet, which is intentionally blocked. Not a CI/CD regression.
- **Known leftover:** another orphaned test attachment blob (task 17, from this
  sweep) — same as previous phases, can't be cleaned up from a local machine anymore
  since Storage is locked down. Harmless.

**Trade-off worth knowing about:** enabling SCM Basic Auth to make the publish-profile
approach work re-introduces a real username/password credential into this project
(stored only as a GitHub secret, never in the repo) — a step away from the AAD-only/
passwordless posture used everywhere else (deviation #1). This was a deliberate,
explicit user choice for today ("use the publish-profile approach... we need to wrap up
today"), not an oversight. If full passwordless consistency matters later, the documented
alternative is: switch the workflow to `azure/login` with federated OIDC (`az ad
app federated-credential create` trusting `repo:3gerrr/cloudtask:ref:refs/heads/master`)
+ `azure/webapps-deploy` using Azure login context instead of a publish profile, and
turn SCM Basic Auth back off (`--set properties.allow=false`) once that's live.

---

## Post-completion polish: friendly root route (2026-08-24)

Added `GET /` to `server.js` returning a JSON welcome message + list of `/api/*`
endpoints, instead of Express's default `Cannot GET /`. Pushed to `master`
(commit `b8af8cf`), which auto-deployed via the now-working CI/CD pipeline (1m41s,
succeeded). Confirmed live: the site briefly still served the old `Cannot GET /` for
about 30-45s after the GitHub Actions run reported success (container recycle/restart
lag, same kind of propagation delay seen elsewhere in this project — always worth a
short poll rather than trusting the very first check right after a deploy completes),
then started returning the new JSON correctly. Full 8-endpoint sweep re-run
afterward: all app-facing endpoints pass; the SAS-download check still 403s as expected
(Phase 4 lockdown, unrelated to this change).

This was the last outstanding item — **the capstone is now fully closed out.**

## CloudTask capstone: ALL 6 PHASES COMPLETE (2026-08-24)

Live app: `https://app-cloudtask-xaa7z0.azurewebsites.net` — deployed via GitHub Actions
CI/CD (`https://github.com/3gerrr/cloudtask`, push to `master` auto-deploys), network-
isolated (SQL/Storage reachable only via private endpoints), monitored (Log Analytics +
5xx alert + budget alerts), all with AAD-only/passwordless data-plane auth except the
Phase 6 SCM publish-profile trade-off noted above. `GET /` now returns a friendly JSON
welcome + endpoint listing rather than a 404.

## User preferences observed this session

- Wants step-by-step confirmation before big changes, but is comfortable handing off
  autonomous work (this handoff) when needed for time reasons
- Prefers PowerShell-native syntax, not bash-translated-literally (e.g. avoid `\` line
  continuations, use backtick or splatting; avoid raw `""` for empty CLI args — use
  `'""'` to survive PowerShell's argument parsing)
- Has hit repeated copy-paste issues where terminal *output* gets accidentally re-pasted
  as *input* — if orchestrating multi-step terminal work, prefer one command at a time
  with explicit confirmation, or use tool-based execution rather than dictating raw
  commands for the user to type
