const express = require('express');
const sql = require('mssql');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');
const { BlobServiceClient, BlobSASPermissions, generateBlobSASQueryParameters } = require('@azure/storage-blob');
const multer = require('multer');
require('dotenv').config();

const app = express();
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

let pool; // SQL connection pool
let blobService; // Blob service client
let blobContainer; // Blob container client

async function initServices() {
  const credential = new DefaultAzureCredential();

  // ---- SQL: passwordless via managed identity ----
  // Instead of pulling a connection string with a password out of Key Vault,
  // we request an Azure AD access token scoped to Azure SQL, and hand that
  // token to mssql directly. No SQL password exists anywhere in this app.
  const sqlServer = process.env.SQL_SERVER;   // e.g. sql-cloudtask-xxxx.database.windows.net
  const sqlDatabase = process.env.SQL_DATABASE; // e.g. db-cloudtask

  async function getSqlPool() {
    const tokenResponse = await credential.getToken('https://database.windows.net/.default');
    const config = {
      server: sqlServer,
      database: sqlDatabase,
      options: { encrypt: true },
      authentication: {
        type: 'azure-active-directory-access-token',
        options: { token: tokenResponse.token }
      }
    };
    return sql.connect(config);
  }

  pool = await getSqlPool();
  console.log('Connected to Azure SQL via managed identity');

  // ---- Blob Storage: managed identity (unchanged from original pattern) ----
  const storageUrl = process.env.STORAGE_URL;
  blobService = new BlobServiceClient(storageUrl, credential);
  blobContainer = blobService.getContainerClient('attachments');
  await blobContainer.createIfNotExists();
  console.log('Connected to Blob Storage');
}

// ---------- ROOT ----------
app.get('/', (req, res) => {
  res.json({
    message: 'CloudTask API',
    status: 'running',
    endpoints: [
      'GET /api/health',
      'GET /api/tasks',
      'POST /api/tasks',
      'GET /api/tasks/:id',
      'PUT /api/tasks/:id',
      'DELETE /api/tasks/:id',
      'POST /api/tasks/:id/attachments',
      'GET /api/tasks/:id/attachments'
    ]
  });
});

// ---------- HEALTH CHECK ----------
app.get('/api/health', async (req, res) => {
  try {
    await pool.request().query('SELECT 1');
    res.json({ status: 'healthy', db: 'connected', storage: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

// ---------- LIST TASKS ----------
app.get('/api/tasks', async (req, res) => {
  const { status } = req.query;
  let query = 'SELECT * FROM Tasks';
  const request = pool.request();
  if (status) {
    query += ' WHERE Status = @status';
    request.input('status', sql.NVarChar, status);
  }
  query += ' ORDER BY CreatedAt DESC';
  const result = await request.query(query);
  res.json(result.recordset);
});

// ---------- GET SINGLE TASK ----------
app.get('/api/tasks/:id', async (req, res) => {
  const result = await pool.request()
    .input('id', sql.Int, req.params.id)
    .query('SELECT * FROM Tasks WHERE Id = @id');
  if (!result.recordset.length) return res.status(404).json({ error: 'Task not found' });
  res.json(result.recordset[0]);
});

// ---------- CREATE TASK ----------
app.post('/api/tasks', async (req, res) => {
  const { title, description, assignee, priority } = req.body;
  const result = await pool.request()
    .input('title', sql.NVarChar, title)
    .input('description', sql.NVarChar, description || '')
    .input('assignee', sql.NVarChar, assignee || '')
    .input('priority', sql.NVarChar, priority || 'Medium')
    .query(`INSERT INTO Tasks (Title, Description, Assignee, Priority, Status, CreatedAt)
            OUTPUT INSERTED.*
            VALUES (@title, @description, @assignee, @priority, 'Open', GETUTCDATE())`);
  res.status(201).json(result.recordset[0]);
});

// ---------- UPDATE TASK ----------
app.put('/api/tasks/:id', async (req, res) => {
  const { title, description, assignee, priority, status } = req.body;
  const result = await pool.request()
    .input('id', sql.Int, req.params.id)
    .input('title', sql.NVarChar, title)
    .input('description', sql.NVarChar, description)
    .input('assignee', sql.NVarChar, assignee)
    .input('priority', sql.NVarChar, priority)
    .input('status', sql.NVarChar, status)
    .query(`UPDATE Tasks SET Title=@title, Description=@description,
            Assignee=@assignee, Priority=@priority, Status=@status
            OUTPUT INSERTED.*
            WHERE Id = @id`);
  if (!result.recordset.length) return res.status(404).json({ error: 'Task not found' });
  res.json(result.recordset[0]);
});

// ---------- DELETE TASK ----------
app.delete('/api/tasks/:id', async (req, res) => {
  await pool.request()
    .input('id', sql.Int, req.params.id)
    .query('DELETE FROM Tasks WHERE Id = @id');
  res.status(204).send();
});

// ---------- UPLOAD ATTACHMENT ----------
app.post('/api/tasks/:id/attachments', upload.single('file'), async (req, res) => {
  const taskId = req.params.id;
  const file = req.file;
  const blobName = `${taskId}/${Date.now()}-${file.originalname}`;
  const blockBlob = blobContainer.getBlockBlobClient(blobName);
  await blockBlob.upload(file.buffer, file.size, {
    blobHTTPHeaders: { blobContentType: file.mimetype }
  });
  await pool.request()
    .input('taskId', sql.Int, taskId)
    .input('fileName', sql.NVarChar, file.originalname)
    .input('blobName', sql.NVarChar, blobName)
    .input('size', sql.Int, file.size)
    .query(`INSERT INTO Attachments (TaskId, FileName, BlobName, Size, UploadedAt)
            VALUES (@taskId, @fileName, @blobName, @size, GETUTCDATE())`);
  res.status(201).json({ message: 'Uploaded', blobName });
});

// ---------- LIST ATTACHMENTS ----------
app.get('/api/tasks/:id/attachments', async (req, res) => {
  const result = await pool.request()
    .input('taskId', sql.Int, req.params.id)
    .query('SELECT * FROM Attachments WHERE TaskId = @taskId ORDER BY UploadedAt DESC');

  // AAD-authenticated clients can't sign a SAS with generateSasUrl() (that needs a
  // shared-key credential); instead request a short-lived user delegation key from
  // Storage and use it to sign the SAS ourselves.
  const startsOn = new Date();
  const expiresOn = new Date(Date.now() + 3600000);
  const delegationKey = await blobService.getUserDelegationKey(startsOn, expiresOn);

  const attachments = await Promise.all(result.recordset.map(async (att) => {
    const blockBlob = blobContainer.getBlockBlobClient(att.BlobName);
    const sasToken = generateBlobSASQueryParameters({
      containerName: blobContainer.containerName,
      blobName: att.BlobName,
      permissions: BlobSASPermissions.parse('r'),
      startsOn,
      expiresOn
    }, delegationKey, blobService.accountName).toString();
    return { ...att, downloadUrl: `${blockBlob.url}?${sasToken}` };
  }));
  res.json(attachments);
});

// ---------- START ----------
const PORT = process.env.PORT || 3000;
initServices().then(() => {
  app.listen(PORT, () => console.log(`CloudTask API running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});