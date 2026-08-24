# CloudTask

A production-grade task management API built on Azure, developed as a cloud engineering capstone project. CloudTask demonstrates a fully passwordless, network-isolated, monitored, and CI/CD-deployed architecture using Node.js, Azure SQL, Blob Storage, and Azure App Service.

**Live API:** https://app-cloudtask-xaa7z0.azurewebsites.net
**Repo:** https://github.com/3gerrr/cloudtask

---

## What it does

CloudTask is a REST API for creating, assigning, and tracking tasks, with file attachment support. Employees can create tasks, assign them to teammates, attach files (stored in Blob Storage), and track progress through a status lifecycle.

### Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | Health check (DB + Storage connectivity) |
| GET | `/api/tasks` | List all tasks (optional `?status=` filter) |
| POST | `/api/tasks` | Create a new task |
| GET | `/api/tasks/:id` | Get a single task |
| PUT | `/api/tasks/:id` | Update a task |
| DELETE | `/api/tasks/:id` | Delete a task |
| POST | `/api/tasks/:id/attachments` | Upload a file attachment |
| GET | `/api/tasks/:id/attachments` | List attachments with SAS download URLs |

---

## Architecture

```
Internet
   |
[App Service]  <-- GitHub Actions CI/CD
(Node.js API)
   |
[System-Assigned Managed Identity]
   |            |             |
[Key Vault]  [SQL DB]   [Blob Storage]
   |            |             |
   +--- Private Endpoints (VNet) ---+
   |  VNet: 10.0.0.0/16              |
   |   snet-web       10.0.1.0/24    |
   |   snet-data       10.0.2.0/24   |
   |   snet-endpoints  10.0.3.0/24   |
   +----------------------------------+
   |
[Log Analytics] <-- diagnostic logs, metrics
[Azure Monitor] <-- HTTP 5xx alert
[Budget]        <-- $20/mo, 50%/80% alerts
```

SQL Server and Storage Account both sit fully behind private endpoints, with public network access disabled. App Service reaches them exclusively over the VNet via private DNS zones. No component of this system is reachable from the public internet except the App Service's own HTTPS endpoint.

---

## Design decisions and deviations from the course brief

This project deliberately diverges from the original course document in several places. Each deviation was a considered trade-off, not an oversight — documented here for transparency.

### 1. Fully passwordless SQL authentication

The course brief's reference implementation stores a SQL admin password in Key Vault and builds a connection string from it. That undermines the point of using managed identity in the first place — a password still exists, just moved one layer away.

**What was built instead:** the SQL Server was created with Azure AD-only authentication (`--enable-ad-only-auth`) — no SQL login or password exists on the server at all. The API authenticates using `DefaultAzureCredential`, requesting an Azure AD access token scoped to `https://database.windows.net/.default` and passing it directly to the `mssql` driver. In production, this token comes from the App Service's system-assigned managed identity; in local development, it comes from the developer's own `az login` session — the same code path runs unmodified in both environments.

Blob Storage access follows the same pattern: no connection strings, no shared keys for reads/writes, just role-based access via managed identity.

### 2. Correct ordering for network lockdown

The brief's phase ordering enables private endpoints on SQL and Storage before App Service has VNet integration configured, and never mentions private DNS zones at all. Followed as written, this would have broken connectivity between the app and its data layer the moment public access was disabled.

**Order actually used:**
1. VNet-integrate App Service into `snet-web`
2. Create private DNS zones for `privatelink.database.windows.net` and `privatelink.blob.core.windows.net`, linked to the VNet
3. Create private endpoints for SQL and Storage in `snet-endpoints`
4. Disable public network access on both

Verified working end-to-end after each step, not just at the end.

### 3. SCM Basic Auth re-enabled for CI/CD (time-boxed trade-off)

Azure now disables SCM Basic Auth publishing credentials by default on new App Services, which is incompatible with the classic GitHub Actions publish-profile deployment method used here. To meet a submission deadline, Basic Auth was re-enabled specifically to allow publish-profile deployment.

This reintroduces a real, long-lived credential into an otherwise fully passwordless project — but it is stored only as an encrypted GitHub Actions secret, never committed to the repository or exposed elsewhere. **A cleaner alternative — federated OIDC (workload identity federation), where GitHub proves its identity per workflow run with no stored secret at all — was considered and is the recommended next step** if this project is extended further.

### 4. Region placement driven by subscription quota, not preference

Several resource types could not be provisioned in the subscription's default/expected region due to trial-subscription capacity restrictions (`RegionDoesNotAllowProvisioning` for SQL Server in `eastus`/`eastus2`; App Service Plan quota similarly limited). Both SQL Server and the App Service Plan ended up in `centralus`, with the VNet relocated there to match (VNet integration requires the App Service and VNet to share a region). Storage and Key Vault remain in `eastus`. Cross-region placement within a single resource group is normal and doesn't affect the private-endpoint connectivity model.

---

## Resources

| Resource | Purpose |
|---|---|
| `rg-cloudtask` | Resource group |
| `vnet-cloudtask` | VNet with 3 subnets (web, data, endpoints) |
| `sql-cloudtask-wy7bfk` / `db-cloudtask` | Azure SQL Server (AAD-only auth) + serverless database |
| `stcloudtaskidotzk` | Blob Storage account (attachments) |
| `kv-cloudtask-alz3u0` | Key Vault (RBAC-authorized) |
| `asp-cloudtask` / `app-cloudtask-xaa7z0` | App Service Plan + Web App |
| `log-cloudtask` | Log Analytics workspace |

---

## Local development

Local development uses your own `az login` session in place of the managed identity — no `.env` secrets, no local database required.

```bash
npm install
npm run dev
```

**Note:** since network lockdown (private endpoints, public access disabled) was applied to SQL and Storage, direct local access to the live Azure resources is no longer possible from outside the VNet. Local development against the live backend is not supported post-lockdown; the deployed App Service is the only client that can reach them. This is intentional and mirrors production security posture.

---

## CI/CD

Pushes to `master` trigger `.github/workflows/deploy.yml`, which installs dependencies, runs tests, and deploys to App Service via publish profile. Deployment typically completes in 1–2 minutes.

---

## Skills demonstrated

Compute (App Service) · Networking (VNet, subnets, private endpoints, private DNS) · Storage (Blob Storage, SAS URLs) · Identity (managed identity, RBAC, AAD-only SQL auth) · Databases (Azure SQL serverless) · Security (Key Vault, network isolation, zero standing SQL credentials) · Monitoring (Log Analytics, Azure Monitor alerts, budget governance) · DevOps (GitHub Actions CI/CD) · Cost optimization (serverless compute tier, auto-pause, budget alerts)
