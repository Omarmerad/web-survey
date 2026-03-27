const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const mongoose = require('mongoose');
const app = express();
const PORT = process.env.PORT || 3000;

// 1. Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname)); 

// 2. File Paths
// On Vercel, the root file system is read-only, so we must use /tmp for temporary storage.
// WARNING: Data saved in /tmp is EPHEMERAL and will be lost every time Vercel restarts the function.
// For a production survey on Vercel, you *must* use a real Database (like MongoDB, Postgres, or Supabase).
const isVercel = process.env.VERCEL || process.env.VERCEL_ENV;
// On Render, we can use a Persistent Disk mounted at a specific directory (e.g. /data)
const dataDir = process.env.DATA_DIR || (isVercel ? '/tmp' : __dirname);
const DOCTORS_FILE = path.join(dataDir, 'survey_responses_doctors.json');
const PATIENTS_FILE = path.join(dataDir, 'survey_responses_patients.json');
const   MONGODB_URI = process.env.MONGODB_URI;
const useMongo = Boolean(MONGODB_URI);

let mongoConnectPromise = null;

const surveyResponseSchema = new mongoose.Schema({
    type: { type: String, enum: ['doctors', 'patients'], required: true, index: true },
    date: { type: String, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} }
});

const SurveyResponse = mongoose.model('SurveyResponse', surveyResponseSchema);

async function ensureMongoConnected() {
    if (!useMongo) return false;
    if (mongoose.connection.readyState === 1) return true;

    if (!mongoConnectPromise) {
        mongoConnectPromise = mongoose.connect(MONGODB_URI, {
            serverSelectionTimeoutMS: 5000
        }).catch((err) => {
            mongoConnectPromise = null;
            throw err;
        });
    }

    await mongoConnectPromise;
    return true;
}

// 3. Helper: Safely Load Data
async function loadDataSafe(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        return { responses: [] };
    }
}

// 4. Helper: Convert JSON to CSV (For Excel)
function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function serializeValue(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.join(' | ');
    if (isPlainObject(value)) {
        return Object.entries(value)
            .map(([k, v]) => `${k}: ${v}`)
            .join(' | ');
    }
    return String(value);
}

function convertToCSV(responses) {
    if (!responses || responses.length === 0) return '';

    // Collect all unique headers (questions) from all responses
    const headers = new Set(['ID', 'Date']);
    responses.forEach(r => {
        if (!r.data) return;

        Object.entries(r.data).forEach(([key, value]) => {
            if (isPlainObject(value)) {
                const nestedKeys = Object.keys(value);
                if (nestedKeys.length === 0) {
                    headers.add(key);
                } else {
                    nestedKeys.forEach(nestedKey => headers.add(`${key}.${nestedKey}`));
                }
            } else {
                headers.add(key);
            }
        });
    });
    const headerArray = Array.from(headers);

    // Create CSV rows
    const rows = responses.map(r => {
        return headerArray.map(header => {
            let val;
            if (header === 'ID') val = r.id;
            else if (header === 'Date') val = r.date;
            else if (header.includes('.')) {
                const [parentKey, childKey] = header.split('.');
                const parentVal = (r.data || {})[parentKey];
                val = isPlainObject(parentVal) ? parentVal[childKey] : '';
            } else {
                val = (r.data || {})[header] || '';
            }

            // Clean up value: replace quotes and newlines so Excel doesn't break
            const stringVal = serializeValue(val).replace(/"/g, '""').replace(/\n/g, ' ');
            return `"${stringVal}"`;
        }).join(',');
    });

    // Combine headers and rows with a "BOM" (\ufeff) so Excel reads accents (é, à) correctly
    return '\ufeff' + headerArray.join(',') + '\n' + rows.join('\n');
}

// 5. Initialization
async function initFiles() {
    const emptyData = JSON.stringify({ responses: [] }, null, 2);
    try { await fs.access(DOCTORS_FILE); } catch { await fs.writeFile(DOCTORS_FILE, emptyData); }
    try { await fs.access(PATIENTS_FILE); } catch { await fs.writeFile(PATIENTS_FILE, emptyData); }
}

function getTypeFile(type) {
    return type === 'doctors' ? DOCTORS_FILE : PATIENTS_FILE;
}

async function saveResponse(type, body) {
    const payload = { id: Date.now(), date: new Date().toLocaleString(), data: body };

    if (useMongo) {
        await ensureMongoConnected();
        await SurveyResponse.create({ type, date: payload.date, data: payload.data });
        return;
    }

    const file = getTypeFile(type);
    const data = await loadDataSafe(file);
    data.responses.push(payload);
    await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function getResponses(type) {
    if (useMongo) {
        await ensureMongoConnected();
        const docs = await SurveyResponse.find({ type }).sort({ _id: 1 }).lean();
        return docs.map((doc, i) => ({
            id: i + 1,
            date: doc.date,
            data: doc.data || {}
        }));
    }

    const file = getTypeFile(type);
    const data = await loadDataSafe(file);
    return data.responses || [];
}

async function clearResponses(type) {
    if (useMongo) {
        await ensureMongoConnected();
        await SurveyResponse.deleteMany({ type });
        return;
    }

    const file = getTypeFile(type);
    await fs.writeFile(file, JSON.stringify({ responses: [] }, null, 2));
}

// 6. Auth Middleware
const checkAuth = (req, res, next) => {
    if (req.query.pwd === 'Omar2020') next();
    else res.status(401).send('<h1>401 Unauthorized</h1><p>Incorrect password.</p>');
};

// ================= ROUTES =================

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/doctors', (req, res) => res.sendFile(path.join(__dirname, 'doctors.html')));
app.get('/patients', (req, res) => res.sendFile(path.join(__dirname, 'patients.html')));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.post('/api/submit-doctor', async (req, res) => {
    try {
        await saveResponse('doctors', req.body);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/submit-patient', async (req, res) => {
    try {
        await saveResponse('patients', req.body);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// === NEW: Download CSV Route ===
app.get('/:type/download-csv', checkAuth, async (req, res) => {
    const type = req.params.type;
    if (type !== 'doctors' && type !== 'patients') return res.status(404).send('Not Found');
    
    const responses = await getResponses(type);
    const csvContent = convertToCSV(responses);

    res.header('Content-Type', 'text/csv');
    res.header('Content-Disposition', `attachment; filename="${type}_results.csv"`);
    res.send(csvContent);
});

// View Results
app.get('/:type/results', checkAuth, async (req, res) => {
    const type = req.params.type;
    // Security check to ensure type is valid
    if (type !== 'doctors' && type !== 'patients') return res.status(404).send('Not Found');

    const responses = await getResponses(type);
    res.send(generateResultsHTML(`Résultats ${type}`, responses, type));
});

// Clear Data
app.get('/:type/clear-results', checkAuth, async (req, res) => {
    const type = req.params.type;
    if (type !== 'doctors' && type !== 'patients') return res.status(404).send('Not Found');

    await clearResponses(type);
    res.redirect(`/${req.params.type}/results?pwd=${req.query.pwd}`);
});

function generateResultsHTML(title, responses, type) {
    const rows = responses.map((r, i) => {
        const safeData = r.data || {}; 
        let answers = '';
        for (const [k, v] of Object.entries(safeData)) {
            let displayValue;
            if (Array.isArray(v)) {
                displayValue = v.join(', ');
            } else if (isPlainObject(v)) {
                displayValue = Object.entries(v).map(([subKey, subVal]) => `${subKey}: ${subVal}`).join(' | ');
            } else {
                displayValue = v;
            }

            answers += `<div style="margin:5px 0"><strong>${k}:</strong> <span style="color:#007bff">${displayValue}</span></div>`;
        }
        return `<div style="background:white; padding:15px; margin-bottom:15px; border-radius:8px; border:1px solid #ddd">
            <div style="border-bottom:1px solid #eee; padding-bottom:5px; margin-bottom:10px; color:#666">#${i + 1} - ${r.date}</div>
            ${answers || '<span style="color:red">Empty Data</span>'}
        </div>`;
    }).join('') || '<div style="padding:20px; text-align:center; color:#666">Aucune réponse.</div>';

    return `
    <html><head><title>${title}</title><style>body{font-family:sans-serif;background:#f4f4f9;padding:20px}.btn{display:inline-block;padding:10px 15px;text-decoration:none;border-radius:5px;margin-right:10px;font-weight:bold}.btn-green{background:#28a745;color:white}.btn-red{background:#dc3545;color:white}</style></head>
    <body>
        <div style="max-width:800px; margin:0 auto">
            <h1>${title} (${responses.length})</h1>
            <div style="margin-bottom:20px">
                <a href="/" style="color:#007bff; text-decoration:none">← Accueil</a>
            </div>
            
            <div style="margin-bottom:20px; padding:15px; background:#e9ecef; border-radius:8px;">
                 <strong>Actions:</strong><br><br>
                 <!-- THE NEW CSV BUTTON -->
                 <a href="/${type}/download-csv?pwd=Omar2020" class="btn btn-green">📥 Télécharger CSV (Excel)</a>
                 <a href="/${type}/clear-results?pwd=Omar2020" class="btn btn-red" onclick="return confirm('Attention: Cela supprimera tout définitivement.')">🗑️ Effacer tout</a>
            </div>

            ${rows}
        </div>
    </body></html>`;
}

if (process.env.VERCEL) {
    // Export the express app for Vercel Serverless Function
    if (useMongo) {
        ensureMongoConnected().catch(err => console.error('MongoDB connection failed:', err.message));
    }
    module.exports = app;
} else {
    // Start locally
    app.listen(PORT, async () => {
        if (useMongo) {
            await ensureMongoConnected();
        } else {
            await initFiles();
        }
        console.log(`\n✅ Server Started!`);
        console.log(`🏠 Home:      http://localhost:${PORT}`);
        console.log(`👨‍⚕️ Doctors:   http://localhost:${PORT}/doctors`);
        console.log(`👥 Patients:  http://localhost:${PORT}/patients`);
        console.log(`📊 Doc-Results: http://localhost:${PORT}/doctors/results?pwd=Omar2020`);
        console.log(`📊 Pat-Results: http://localhost:${PORT}/patients/results?pwd=Omar2020`); 
    });
}

