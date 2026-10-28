const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const toml = require('smol-toml');

const INDEX = 'index.json';
const errors = [];

async function sha256OfUrl(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.toml')) out.push(p);
  }
  return out;
}

(async () => {
  const manifests = walk('packages');
  if (!manifests.length) { console.error('no manifests found'); process.exit(1); }

  const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  index.packages = index.packages || {};

  for (const file of manifests) {
    const rel = path.relative('packages', file).replace(/\\/g, '/');
    const [pkgDir, fileBase] = rel.split('/');
    const expectedVersion = fileBase.replace(/\.toml$/, '');

    let m;
    try { m = toml.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { errors.push(`${rel}: parse error: ${e.message}`); continue; }

    // required fields
    for (const f of ['name', 'version', 'description', 'homepage', 'artifacts']) {
      if (!m[f]) errors.push(`${rel}: missing "${f}"`);
    }
    if (m.name !== pkgDir) errors.push(`${rel}: name "${m.name}" != folder "${pkgDir}"`);
    if (m.version !== expectedVersion) errors.push(`${rel}: version "${m.version}" != filename "${expectedVersion}"`);
    if (!Array.isArray(m.artifacts) || !m.artifacts.length) { errors.push(`${rel}: no artifacts`); continue; }

    for (const [i, a] of m.artifacts.entries()) {
      for (const f of ['os', 'arch', 'url', 'sha256', 'extract']) {
        if (!a[f]) errors.push(`${rel}: artifacts[${i}].${f} missing`);
      }
      if (a.sha256 && !/^[a-f0-9]{64}$/i.test(a.sha256)) {
        errors.push(`${rel}: artifacts[${i}].sha256 not a valid hex digest`);
        continue;
      }
      if (a.url && a.sha256) {
        try {
          process.stdout.write(`verifying ${a.url} ... `);
          const actual = await sha256OfUrl(a.url);
          if (actual.toLowerCase() !== a.sha256.toLowerCase()) {
            errors.push(`${rel}: sha256 mismatch\n  expected ${a.sha256}\n  actual   ${actual}`);
            console.log('MISMATCH');
          } else console.log('ok');
        } catch (e) {
          errors.push(`${rel}: download failed: ${e.message}`);
        }
      }
      if (a.extract === 'zip' && (!a.bins || !a.bins.length)) {
        errors.push(`${rel}: zip artifact must declare at least one [[artifacts.bins]]`);
      }
    }

    // update index
    const p = index.packages[m.name] || { versions: [] };
    p.description = m.description;
    if (!p.versions.includes(m.version)) p.versions.push(m.version);
    p.versions.sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
    p.latest = p.versions[p.versions.length - 1];
    index.packages[m.name] = p;
  }

  if (errors.length) {
    console.error('\n❌ validation failed:\n');
    for (const e of errors) console.error(' - ' + e);
    process.exit(1);
  }

  // rewrite index deterministically
  const sorted = {};
  for (const k of Object.keys(index.packages).sort()) sorted[k] = index.packages[k];
  index.packages = sorted;
  fs.writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n');
  console.log('\n✅ all manifests valid, index updated');
})();
