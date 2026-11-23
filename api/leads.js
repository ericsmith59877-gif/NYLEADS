// Vercel serverless function: builds the lead list from public government data.
//  1) CMS NPPES weekly files  -> new NY providers / practices / labs
//  2) NYS DOH facility registry -> newly opened NY facilities
// No npm packages needed. Result is cached by Vercel's CDN for 6 hours.
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), readline = require('readline');
const { pipeline } = require('stream/promises'), { Readable } = require('stream');

const PAGE = 'https://download.cms.gov/nppes/NPI_Files.html';
const DOH = 'https://health.data.ny.gov/resource/vn5v-hh5r.json';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; xybermed-lead-finder/1.0)' };
const WINDOW_DAYS = 90;

const TAX = {'207Q00000X':'Family Medicine','207R00000X':'Internal Medicine','208000000X':'Pediatrics','208D00000X':'General Practice','207RC0000X':'Cardiology','207RG0100X':'Gastroenterology','207RI0008X':'Hepatology','207RN0300X':'Nephrology','207RX0202X':'Medical Oncology','208800000X':'Urology','2084P0800X':'Psychiatry','2084N0400X':'Neurology','207N00000X':'Dermatology','207X00000X':'Orthopaedic Surgery','207V00000X':'OB/GYN','208100000X':'Physical Medicine & Rehab','207L00000X':'Anesthesiology','207P00000X':'Emergency Medicine','207RE0101X':'Endocrinology','207RP1001X':'Pulmonary Disease','207RR0500X':'Rheumatology','207W00000X':'Ophthalmology','208VP0000X':'Pain Medicine','208600000X':'Surgery','363L00000X':'Nurse Practitioner','363LF0000X':'NP - Family','363LP0808X':'NP - Psychiatric/Mental Health','363A00000X':'Physician Assistant','103T00000X':'Psychologist','104100000X':'Social Worker','1041C0700X':'Clinical Social Worker','106H00000X':'Marriage & Family Therapist','101YM0800X':'Mental Health Counselor','101YP2500X':'Professional Counselor','213E00000X':'Podiatrist','111N00000X':'Chiropractor','225100000X':'Physical Therapist','152W00000X':'Optometrist','291U00000X':'Clinical Medical Laboratory','293D00000X':'Physiological Laboratory','261Q00000X':'Clinic/Center','261QP2300X':'Primary Care Clinic','261QU0200X':'Urgent Care Clinic','261QM0801X':'Mental Health Clinic','261QR0200X':'Radiology Clinic','261QE0700X':'ESRD Treatment Clinic','261QA1903X':'Ambulatory Surgical Clinic','261QF0400X':'FQHC','261QM1300X':'Multi-Specialty Clinic','261QP3300X':'Pain Clinic','261QX0200X':'Oncology Clinic','193200000X':'Multi-Specialty Group','193400000X':'Single Specialty Group','251E00000X':'Home Health Agency','282N00000X':'General Acute Care Hospital'};
const FAMILY = {'207':'Physician','208':'Physician','204':'Physician','363':'Nurse Practitioner/PA','364':'Clinical Nurse Specialist','103':'Psychologist','104':'Social Worker','106':'Therapist','101':'Counselor','213':'Podiatrist','111':'Chiropractor','225':'Therapist','152':'Optometrist','122':'Dentist','261':'Clinic/Center','193':'Medical Group','291':'Clinical Medical Laboratory','293':'Laboratory','282':'Hospital','251':'Home Health Agency'};
const KEEP_IND = ['207','208','204','363','364','103','104','106','101','213','111','225','152','122'];
const SKIP_ORG = ['332','333','335','341','343','344','347','349'];
const LAB = ['291U', '293D', '292'];

const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const title = s => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const phone = s => { const d = String(s || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : ''; };
const label = c => TAX[c] || FAMILY[c.slice(0, 3)] || (c ? `Other (${c})` : 'Unspecified');
const startsAny = (s, list) => list.some(p => s.startsWith(p));
const pdate = s => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : ''; };

function splitCsv(line) {
  const out = []; let i = 0; const n = line.length;
  while (i <= n) {
    if (line[i] === '"') {
      let v = ''; i++;
      while (i < n) { if (line[i] === '"') { if (line[i + 1] === '"') { v += '"'; i += 2; continue; } i++; break; } v += line[i++]; }
      out.push(v); if (line[i] === ',') i++; else break;
    } else { const j = line.indexOf(',', i); if (j < 0) { out.push(line.slice(i)); break; } out.push(line.slice(i, j)); i = j + 1; }
  }
  return out;
}

// Locate the main CSV inside a zip without any library (reads the central directory).
function zipEntry(file) {
  const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size;
  const tail = Buffer.alloc(Math.min(size, 70000)); fs.readSync(fd, tail, 0, tail.length, size - tail.length);
  const e = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); if (e < 0) throw new Error('Download was not a valid zip file');
  const cnt = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
  const cd = Buffer.alloc(cdSize); fs.readSync(fd, cd, 0, cdSize, cdOff);
  let p = 0, found = null;
  for (let i = 0; i < cnt && cd.readUInt32LE(p) === 0x02014b50; i++) {
    const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32), lho = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nl);
    if (/(^|\/)npidata_pfile_.*\.csv$/i.test(name) && !/fileheader/i.test(name)) found = { method, csize, lho };
    p += 46 + nl + xl + cl;
  }
  if (!found) throw new Error('npidata CSV not found inside zip');
  const lh = Buffer.alloc(30); fs.readSync(fd, lh, 0, 30, found.lho); fs.closeSync(fd);
  const start = found.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  return { start, end: start + found.csize - 1, method: found.method };
}

const NEED = ['NPI','Entity Type Code','Provider Organization Name (Legal Business Name)','Provider Last Name (Legal Name)','Provider First Name','Provider Credential Text','Provider Enumeration Date','NPI Deactivation Date','Is Sole Proprietor','Authorized Official First Name','Authorized Official Last Name','Authorized Official Title or Position','Authorized Official Telephone Number'];
const ADDR = ['First Line','Second Line','City Name','State Name','Postal Code','Telephone Number'];

async function parseFile(file, cutoff, out) {
  const { start, end, method } = zipEntry(file);
  const raw = fs.createReadStream(file, { start, end });
  let src = raw; if (method === 8) { src = zlib.createInflateRaw(); raw.on('error', e => src.destroy(e)); raw.pipe(src); }
  const rl = readline.createInterface({ input: src, crlfDelay: Infinity });
  let I = null, kept = 0;
  for await (const line of rl) {
    if (!I) {
      const h = splitCsv(line).map(norm), ix = n => { const k = h.indexOf(norm(n)); return k < 0 ? null : k; };
      I = { f: {}, p: {}, m: {}, t: [] };
      NEED.forEach(n => I.f[n] = ix(n));
      ADDR.forEach(a => { I.p[a] = ix(`Provider Business Practice Location Address ${a}`) ?? ix(`Provider Business Practice Location ${a}`); I.m[a] = ix(`Provider Business Mailing Address ${a}`); });
      for (let k = 1; k <= 15; k++) I.t.push([ix(`Healthcare Provider Taxonomy Code_${k}`), ix(`Healthcare Provider Primary Taxonomy Switch_${k}`), ix(`Provider License Number_${k}`)]);
      const miss = ['NPI','Entity Type Code','Provider Enumeration Date'].filter(n => I.f[n] == null);
      if (I.p['State Name'] == null) miss.push('Practice State');
      if (miss.length) throw new Error('NPPES file layout changed; missing columns: ' + miss.join(', '));
      continue;
    }
    if (line.indexOf('NY') < 0) continue;
    const f = splitCsv(line); const g = n => (I.f[n] == null ? '' : (f[I.f[n]] || '').trim());
    const en = pdate(g('Provider Enumeration Date'));
    if (!en || en < cutoff || g('NPI Deactivation Date')) continue;
    const ps = (f[I.p['State Name']] || '').trim(), ms = I.m['State Name'] == null ? '' : (f[I.m['State Name']] || '').trim();
    if (!(ps === 'NY' || (!ps && ms === 'NY'))) continue;
    const A = ps === 'NY' ? I.p : I.m, a = k => (A[k] == null ? '' : (f[A[k]] || '').trim());
    const tx = I.t.map(([c, s, l]) => [c == null ? '' : (f[c] || '').trim(), s == null ? '' : (f[s] || '').trim(), l == null ? '' : (f[l] || '').trim()]);
    const pr = tx.find(t => t[1] === 'Y' && t[0]) || tx.find(t => t[0]) || ['', '', ''];
    const code = pr[0], org = g('Entity Type Code') === '2';
    if (org && startsAny(code, SKIP_ORG)) continue;
    if (!org && !startsAny(code, KEEP_IND)) continue;
    const npi = g('NPI');
    const r = { id: npi, src: 'NPPES', date: en, tcode: code, tax: label(code), addr: [a('First Line'), a('Second Line')].filter(Boolean).map(title).join(', '), city: title(a('City Name')), zip: a('Postal Code').slice(0, 5), phone: phone(a('Telephone Number')), solo: g('Is Sole Proprietor') === 'Y', lic: pr[2], url: 'https://npiregistry.cms.hhs.gov/provider-view/' + npi };
    if (org) {
      r.kind = LAB.some(p => code.startsWith(p)) ? 'lab' : 'practice';
      r.name = title(g('Provider Organization Name (Legal Business Name)'));
      const off = title([g('Authorized Official First Name'), g('Authorized Official Last Name')].filter(Boolean).join(' '));
      r.official = off ? { name: off, title: title(g('Authorized Official Title or Position')), phone: phone(g('Authorized Official Telephone Number')) } : null;
    } else {
      r.kind = 'provider'; r.cred = g('Provider Credential Text');
      r.name = title([g('Provider First Name'), g('Provider Last Name (Legal Name)')].filter(Boolean).join(' '));
    }
    out.set(npi, r); kept++;
  }
  return kept;
}

const endKey = u => { const m = /_(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(u); return m ? +(m[6] + m[4] + m[5]) : 0; };
function pickFiles(html) {
  const urls = [...new Set([...html.matchAll(/href=["']?([^"'\s>]*NPPES_Data_Dissemination[^"'\s>]*\.zip)/gi)].map(m => new URL(m[1], PAGE).href))].filter(u => !/deactiv/i.test(u));
  const weekly = urls.filter(u => /weekly|_\d{6}_\d{6}/i.test(u));
  if (!weekly.length) throw new Error('No weekly NPPES files found on the CMS download page (' + urls.length + ' zip links seen)');
  const v2 = weekly.filter(u => /[_.\-]v\.?2/i.test(u)), v1 = weekly.filter(u => !/[_.\-]v\.?2/i.test(u));
  const best = l => Math.max(0, ...l.map(endKey));
  const use = v2.length && best(v2) > best(v1) ? v2 : (v1.length ? v1 : v2);
  return use.sort((a, b) => endKey(b) - endKey(a)).slice(0, 6);
}

async function download(url, dst) {
  const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(`HTTP ${r.status} downloading ${url.split('/').pop()}`);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dst));
}

async function nppes(cutoff, out) {
  const r = await fetch(PAGE, { headers: UA }); if (!r.ok) throw new Error(`CMS download page returned HTTP ${r.status}`);
  const files = pickFiles(await r.text());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npi-'));
  try {
    const counts = await Promise.all(files.map(async (u, i) => { const d = path.join(dir, `f${i}.zip`); await download(u, d); const n = await parseFile(d, cutoff, out); fs.unlinkSync(d); return n; }));
    return { files: files.length, kept: counts.reduce((a, b) => a + b, 0) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function facilities(cutoff, out) {
  const q = new URLSearchParams({ $where: `fac_opn_dat >= '${cutoff}T00:00:00'`, $order: 'fac_opn_dat DESC', $limit: '5000' });
  const r = await fetch(DOH + '?' + q, { headers: UA }); if (!r.ok) throw new Error(`NYS DOH returned HTTP ${r.status}`);
  const rows = await r.json();
  for (const x of rows) {
    const id = 'F' + x.fac_id;
    out.set(id, { id, kind: 'facility', src: 'NYS DOH', name: x.facility_name || '', tax: x.description || '', tcode: '', date: String(x.fac_opn_dat).slice(0, 10), addr: [x.address1, x.address2].filter(Boolean).join(', '), city: x.city || '', zip: String(x.fac_zip || '').slice(0, 5), phone: phone(x.fac_phone), solo: false, main: x.main_site_name || '', url: x.web_site || '', official: { name: x.operator_name || '', title: 'Operator', phone: '' } });
  }
  return rows.length;
}


// ---- Intelligence: separate real private-practice prospects from records we could never win ----
const BIG = /hospital|health system|medical center|university|langone|northwell|mount sinai|montefiore|nyc health|columbia|cornell|presbyterian|rochester regional|kaleida|catholic health|upstate|stony brook|suny|veterans|department of|county of|city of|state of|school|college|cvs|walgreens|rite aid|walmart|minuteclinic|citymd|fresenius|davita|labcorp|quest diagnostics|one medical|carbon health|teladoc/i;
const PRIV = /(^|[^a-z])(pllc|p\.?c\.?|llc|l\.l\.c|associates|group|medicine|medical|clinic|care|center|practice|specialists?)([^a-z]|$)/i;
const NOTFIT = /nursing|adult home|enriched|hospice|residential|assisted|adult day|^hospital|school|camp/i;
const addrKey = l => (l.addr ? l.addr.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16) + l.zip : '');
function classify(list) {
  const cnt = {};
  list.forEach(l => { if (l.kind === 'provider') { const k = addrKey(l); if (k) cnt[k] = (cnt[k] || 0) + 1; } });
  for (const l of list) {
    const k = addrKey(l); l.cluster = l.kind === 'provider' && k ? cnt[k] : 0;
    l.priv = l.kind !== 'provider' && l.kind !== 'facility' && PRIV.test(l.name);
    const txt = l.kind === 'provider' ? l.addr : [l.name, l.addr, l.main].join(' ');
    let ex = '';
    if (BIG.test(txt || '')) ex = 'Hospital, university, government or national chain';
    else if (l.kind === 'facility' && NOTFIT.test(l.tax)) ex = 'Care facility type outside our services';
    else if (l.kind === 'facility' && /extension/i.test(l.tax) && /hospital/i.test(l.tax + ' ' + (l.main || ''))) ex = 'Hospital-run clinic';
    else if (/^282/.test(l.tcode)) ex = 'Hospital';
    else if (/^261QF/.test(l.tcode)) ex = 'FQHC (in-house billing)';
    else if (l.kind === 'provider' && l.cluster >= 6) ex = 'Large-employer address (likely hospital or big group)';
    else if (/^122/.test(l.tcode)) ex = 'Dental (outside target specialties)';
    if (ex) l.excl = ex; else delete l.excl;
  }
}

async function build() {
  const cutoff = iso(Date.now() - WINDOW_DAYS * 864e5), leads = new Map(), warnings = [];
  const [a, b] = await Promise.allSettled([nppes(cutoff, leads), facilities(cutoff, leads)]);
  if (a.status === 'rejected') warnings.push('Provider data (NPPES): ' + a.reason.message);
  if (b.status === 'rejected') warnings.push('Facility data (NYS DOH): ' + b.reason.message);
  if (!leads.size) throw new Error(warnings.join(' | ') || 'No records found');
  const list = [...leads.values()].sort((x, y) => (x.date < y.date ? 1 : -1));
  classify(list);
  return { meta: { filtered_out: list.filter(l => l.excl).length, generated: new Date().toISOString(), window_days: WINDOW_DAYS, count: list.length, demo: false, warnings, sources: ['CMS NPPES weekly files', 'NYS DOH facility registry'] }, leads: list };
}

let cache = null;
module.exports = async (req, res) => {
  try {
    if (!cache || Date.now() - cache.t > 6 * 3600e3 || (req.query && req.query.refresh)) cache = { t: Date.now(), data: await build() };
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    res.status(200).json(cache.data);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e && e.message || e) });
  }
};
module.exports._t = { parseFile, pickFiles, splitCsv, classify };
