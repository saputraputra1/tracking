const { minify } = require('terser');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const FILES = ['tracker.js', 'config.js', 'firebase-config.js'];

async function main() {
    for (const file of FILES) {
        const fp = path.join(PUBLIC, file);
        if (!fs.existsSync(fp)) {
            console.log(`Skipping ${file} (not found)`);
            continue;
        }
        const code = fs.readFileSync(fp, 'utf8');
        const result = await minify(code, {
            compress: { passes: 2, drop_console: false, drop_debugger: true },
            mangle: { toplevel: true, properties: { regex: /^_/ } },
            output: { beautify: false, comments: false }
        });
        if (result.error) {
            console.error(`Error minifying ${file}:`, result.error);
            continue;
        }
        fs.writeFileSync(fp, result.code);
        console.log(`Minified ${file}: ${code.length} -> ${result.code.length} bytes (${Math.round((1 - result.code.length / code.length) * 100)}% reduction)`);
    }
    console.log('Done.');
}

main().catch(console.error);
