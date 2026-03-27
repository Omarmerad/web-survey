const express = require('express');
const fs = require('fs').promises;
const path = require('path');
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
function convertToCSV(responses) {
    if (!responses || responses.length === 0) return '';

    // Collect all unique headers (questions) from all responses
    const headers = new Set(['ID', 'Date']);
    responses.forEach(r => {
        if (r.data) Object.keys(r.data).forEach(k => headers.add(k));
    });
    const headerArray = Array.from(headers);

    // Create CSV rows
    const rows = responses.map(r => {
        return headerArray.map(header => {
            let val;
            if (header === 'ID') val = r.id;
            else if (header === 'Date') val = r.date;
            else val = (r.data || {})[header] || '';

            // Clean up value: replace quotes and newlines so Excel doesn't break
            const stringVal = String(val).replace(/"/g, '""').replace(/\n/g, ' ');
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

// 6. Auth Middleware
const checkAuth = (req, res, next) => {
    if (req.query.pwd === 'Omar2020') next();
    else res.status(401).send('<h1>401 Unauthorized</h1><p>Incorrect password.</p>');
};

// ================= ROUTES =================

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/doctors', (req, res) => res.sendFile(path.join(__dirname, 'doctors.html')));
app.get('/patients', (req, res) => res.sendFile(path.join(__dirname, 'patients.html')));

app.post('/api/submit-doctor', async (req, res) => {
    try {
        const data = await loadDataSafe(DOCTORS_FILE);
        data.responses.push({ id: Date.now(), date: new Date().toLocaleString(), data: req.body });
        await fs.writeFile(DOCTORS_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/submit-patient', async (req, res) => {
    try {
        const data = await loadDataSafe(PATIENTS_FILE);
        data.responses.push({ id: Date.now(), date: new Date().toLocaleString(), data: req.body });
        await fs.writeFile(PATIENTS_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// === NEW: Download CSV Route ===
app.get('/:type/download-csv', checkAuth, async (req, res) => {
    const type = req.params.type;
    const file = type === 'doctors' ? DOCTORS_FILE : PATIENTS_FILE;
    
    const data = await loadDataSafe(file);
    const csvContent = convertToCSV(data.responses);

    res.header('Content-Type', 'text/csv');
    res.header('Content-Disposition', `attachment; filename="${type}_results.csv"`);
    res.send(csvContent);
});

// View Results
app.get('/:type/results', checkAuth, async (req, res) => {
    const type = req.params.type;
    // Security check to ensure type is valid
    if (type !== 'doctors' && type !== 'patients') return res.status(404).send('Not Found');

    const file = type === 'doctors' ? DOCTORS_FILE : PATIENTS_FILE;
    const data = await loadDataSafe(file);
    res.send(generateResultsHTML(`Résultats ${type}`, data.responses, type));
});

// Clear Data
app.get('/:type/clear-results', checkAuth, async (req, res) => {
    const file = req.params.type === 'doctors' ? DOCTORS_FILE : PATIENTS_FILE;
    await fs.writeFile(file, JSON.stringify({ responses: [] }, null, 2));
    res.redirect(`/${req.params.type}/results?pwd=${req.query.pwd}`);
});

function generateResultsHTML(title, responses, type) {
    const rows = responses.map((r, i) => {
        const safeData = r.data || {}; 
        let answers = '';
        for (const [k, v] of Object.entries(safeData)) {
            answers += `<div style="margin:5px 0"><strong>${k}:</strong> <span style="color:#007bff">${v}</span></div>`;
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
    module.exports = app;
} else {
    // Start locally
    app.listen(PORT, async () => {
        await initFiles();
        console.log(`\n✅ Server Started!`);
        console.log(`🏠 Home:      http://localhost:${PORT}`);
        console.log(`👨‍⚕️ Doctors:   http://localhost:${PORT}/doctors`);
        console.log(`👥 Patients:  http://localhost:${PORT}/patients`);
        console.log(`📊 Doc-Results: http://localhost:${PORT}/doctors/results?pwd=Omar2020`);
        console.log(`📊 Pat-Results: http://localhost:${PORT}/patients/results?pwd=Omar2020`); 
    });
}

