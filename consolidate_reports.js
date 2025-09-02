const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const csv = require('csv-parser');
const fastcsv = require('fast-csv');

const downloadsDir = path.join(__dirname, 'downloads');
const outputDir = path.join(__dirname, 'analysis_output');

// A map to hold file paths grouped by their base filename
const reportGroups = new Map();

async function findCsvFiles(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await findCsvFiles(fullPath);
        } else if (path.extname(entry.name).toLowerCase() === '.csv') {
            const reportName = entry.name.replace(/ - .*/, '').trim();
            if (!reportGroups.has(reportName)) {
                reportGroups.set(reportName, []);
            }
            reportGroups.get(reportName).push(fullPath);
        }
    }
}

async function processReportGroup(reportName, files) {
    const allRows = [];
    let header = null;

    for (const file of files) {
        const date = path.basename(path.dirname(file));
        await new Promise((resolve, reject) => {
            fs.createReadStream(file)
                .pipe(csv({
                    mapHeaders: ({ header }) => header.trim(),
                    mapValues: ({ value }) => value.trim().replace(/,/g, '')
                }))
                .on('data', (row) => {
                    if (!header) {
                        header = Object.keys(row).concat('date');
                    }
                    row.date = date;
                    allRows.push(row);
                })
                .on('end', resolve)
                .on('error', reject);
        });
    }

    if (allRows.length > 0) {
        const outputFileName = `${reportName.replace(/[/\\?%*:|"<>]/g, '-')}.csv`;
        const outputPath = path.join(outputDir, outputFileName);
        const ws = fs.createWriteStream(outputPath);

        const csvStream = fastcsv.format({ headers: true });
        csvStream.pipe(ws).on('end', () => console.log(`  -> Successfully created ${outputFileName}`));
        
        allRows.forEach(row => {
            csvStream.write(row);
        });
        csvStream.end();
    }
}

async function main() {
    try {
        await fsp.access(downloadsDir);
    } catch (error) {
        console.error(`Error: The '${downloadsDir}' directory does not exist.`);
        return;
    }
    
    try {
        await fsp.access(outputDir);
    } catch (error) {
        console.log(`Creating output directory: '${outputDir}'`);
        await fsp.mkdir(outputDir, { recursive: true });
    }

    console.log('Scanning for CSV files...');
    await findCsvFiles(downloadsDir);

    console.log(`Found ${reportGroups.size} unique report types.`);

    for (const [reportName, files] of reportGroups.entries()) {
        console.log(`Processing report: "${reportName}" (${files.length} files)`);
        await processReportGroup(reportName, files);
    }

    console.log('\nAll reports have been processed.');
}

main().catch(console.error);