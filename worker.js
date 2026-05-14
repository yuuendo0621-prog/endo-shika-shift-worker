// 遠藤歯科クリニック - シフト同期ワーカー
import { chromium } from 'playwright';
import fs from 'fs';

const DENTIS_USERNAME = process.env.DENTIS_USERNAME;
const DENTIS_PASSWORD = process.env.DENTIS_PASSWORD;
const DENTIS_SLUG = process.env.DENTIS_SLUG || 'JvbrMX';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!DENTIS_USERNAME || !DENTIS_PASSWORD || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('必須環境変数が不足しています');
  process.exit(1);
}

const ROLE_TO_GROUP = {
  '歯科医師': '歯科医師',
  '衛生士': '歯科衛生士',
  '歯科助手': '歯科助手',
  'その他': 'その他'
};

const ORDER_MAP = {
  '院長': 1, '山口': 2, '熊田': 3,
  '伊藤': 10, '永井': 11, '倉嶋': 12, '黒崎': 13, '横井': 14, '沢田': 15, '大倉': 16,
  '本間': 17, '野口': 18, '中川': 19, '佐藤': 20, '髙橋': 21, '黒田': 22, '小見': 23, '大徳': 24,
  'まなか': 30, 'あつみ': 31, 'めい': 32, 'かの': 33,
  '遠藤歯科': 90
};

async function sb(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const r = await fetch(url, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text}`);
  return body;
}

async function getPendingRequest() {
  const rows = await sb('shift_sync_requests?status=eq.pending&order=requested_at.asc&limit=1');
  return (rows && rows[0]) || null;
}

async function updateRequest(id, fields) {
  await sb(`shift_sync_requests?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(fields)
  });
}

async function dumpDebug(page, label) {
  try {
    fs.mkdirSync('debug', { recursive: true });
    await page.screenshot({ path: `debug/${label}.png`, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(`debug/${label}.html`, html);
    console.log(`デバッグ情報を debug/${label}.{png,html} に保存`);
  } catch (e) {
    console.log('デバッグ情報保存失敗:', e.message);
  }
}

async function loginDentis(page) {
  await page.goto('https://d.dentis-cloud.com/dental/signin', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="username"]', { timeout: 30000 });
  await page.fill('input[name="username"]', DENTIS_USERNAME);
  await page.fill('input[name="password"]', DENTIS_PASSWORD);
  await page.getByRole('button', { name: 'サインイン' }).click();
  await page.waitForURL((url) => !url.toString().includes('signin'), { timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  console.log(`Dentis ログイン成功 - 現在URL: ${page.url()}`);
}

const PAGE_HELPERS = `
  function getAttendees() {
    const pane = document.querySelector('[class*="WorkingPractitionerPane__Root"]');
    if (!pane) return null;
    const result = { roles: {}, names: [] };
    let currentRole = '';
    for (const node of pane.querySelectorAll('[class*="WorkingPractitionerPane__JobType"], [class*="Practitioner__Root"]')) {
      const cls = (node.className || '').toString();
      const t = node.textContent.trim();
      if (cls.includes('JobType')) currentRole = t;
      else if (cls.includes('Practitioner__Root') && currentRole) {
        if (!result.roles[t]) {
          result.roles[t] = currentRole;
          result.names.push(t);
        }
      }
    }
    return result;
  }
  function getVisits() {
    const slots = [];
    const seen = new Set();
    const roots = document.querySelectorAll('[class*="InstitutionVisitingEventSlot__Root"]');
    for (const root of roots) {
      const inst = root.querySelector('[class*="InstitutionLabel__InstitutionName"]')?.textContent.trim() || '';
      const time = root.querySelector('[class*="InstitutionVisitingEventSlot__TimeLabel"]')?.textContent.trim() || '';
      const key = inst + '|' + time;
      if (seen.has(key)) continue;
      seen.add(key);
      const staff = [...new Set(Array.from(root.querySelectorAll('[class*="InstitutionVisitingEventSlot__PractitionerLabel"]')).map(el => el.textContent.trim()).filter(t => t))];
      slots.push({ inst, time, staff });
    }
    return slots;
  }
  function getCurrentDate() { return new URL(location.href).searchParams.get('date'); }
  function getNextBtn() {
    const m = document.querySelector('[class*="Navi__Month"]');
    const nav = m?.parentElement?.querySelector('[class*="Navi__Nav"]');
    const btns = nav ? Array.from(nav.querySelectorAll('button')) : [];
    return btns[2];
  }
`;

async function waitForAttendeesPane(page, maxRetries = 4) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await page.waitForSelector('[class*="WorkingPractitionerPane__Root"]', { timeout: 20000 });
      return true;
    } catch {
      console.log(`  WorkingPractitionerPane が見つからない (試行${i+1}/${maxRetries})`);
      if (i === 0) await dumpDebug(page, `no_pane_attempt1`);
      const diag = await page.evaluate(`
        ({
          url: location.href,
          title: document.title,
          h1: document.querySelector('h1')?.textContent || '',
          buttons: Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).filter(t => t).slice(0, 30),
          hasMonth: !!document.querySelector('[class*="Navi__Month"]'),
          hasSchedule: !!document.querySelector('[class*="Schedule__"]'),
          paneClasses: Array.from(document.querySelectorAll('[class*="Pane"]')).map(el => (el.className||'').toString().split(' ')[0]).filter((v,i,a) => a.indexOf(v)===i)
        })
      `);
      console.log('  診断情報:', JSON.stringify(diag).slice(0, 600));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
    }
  }
  return false;
}

async function scrapeMonth(page, year, month, isVisit) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
  const endDate = `${year}-${String(month).padStart(2,'0')}-${String(daysInMonth).padStart(2,'0')}`;
  const baseUrl = isVisit
    ? `https://d.dentis-cloud.com/dental/visiting_schedule?date=${startDate}`
    : `https://d.dentis-cloud.com/dental/schedule?date=${startDate}`;

  console.log(`→ ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[class*="Navi__Month"]', { timeout: 60000 });

  if (!isVisit) {
    const ok = await waitForAttendeesPane(page);
    if (!ok) {
      await dumpDebug(page, `pane_final_fail_${year}${month}`);
      throw new Error(`出勤者ペインが描画されませんでした (URL: ${page.url()})`);
    }
  }
  await page.waitForTimeout(2500);

  const data = {};
  let roleMapAcc = {};
  let emptyStreak = 0;

  for (let i = 0; i < daysInMonth + 5; i++) {
    const currentDate = await page.evaluate(`(function(){${PAGE_HELPERS}; return getCurrentDate();})()`);
    if (!currentDate || currentDate > endDate) break;

    if (isVisit) {
      data[currentDate] = await page.evaluate(`(function(){${PAGE_HELPERS}; return getVisits();})()`);
    } else {
      const attRes = await page.evaluate(`(function(){${PAGE_HELPERS}; return getAttendees();})()`);
      if (attRes && attRes.names.length > 0) {
        data[currentDate] = attRes.names;
        Object.assign(roleMapAcc, attRes.roles);
        emptyStreak = 0;
      } else if (attRes) {
        data[currentDate] = [];
        emptyStreak++;
      } else {
        await page.waitForTimeout(2000);
        const retry = await page.evaluate(`(function(){${PAGE_HELPERS}; return getAttendees();})()`);
        if (retry && retry.names.length > 0) {
          data[currentDate] = retry.names;
          Object.assign(roleMapAcc, retry.roles);
          emptyStreak = 0;
        } else {
          data[currentDate] = [];
          emptyStreak++;
        }
      }
      if (emptyStreak >= 8) {
        await dumpDebug(page, `empty_streak_${year}${month}_${currentDate}`);
        throw new Error(`8日連続で出勤者ゼロ — スクレイピング失敗`);
      }
    }

    if (currentDate >= endDate) break;
    const hasNext = await page.evaluate(`(function(){${PAGE_HELPERS}; const b = getNextBtn(); if (!b) return false; b.click(); return true;})()`);
    if (!hasNext) break;
    await page.waitForTimeout(1800);
  }
  console.log(`  → ${Object.keys(data).length}日分取得${isVisit ? '' : `, ${Object.keys(roleMapAcc).length}人の役職判定`}`);
  return { data, roleMap: roleMapAcc };
}

function aggregate(year, month, attendees, visits, roleMap) {
  const staffMap = {};
  function ensure(name) {
    if (!staffMap[name]) {
      const role = roleMap[name] || 'その他';
      staffMap[name] = { days: new Set(), hcd: new Set(), role };
    }
    return staffMap[name];
  }
  for (const [date, names] of Object.entries(attendees)) {
    const m = parseInt(date.slice(5,7));
    if (m !== month) continue;
    const day = parseInt(date.slice(8,10));
    for (const n of names) ensure(n).days.add(day);
  }
  for (const [date, slots] of Object.entries(visits)) {
    const m = parseInt(date.slice(5,7));
    if (m !== month) continue;
    const day = parseInt(date.slice(8,10));
    const ouStaff = new Set();
    for (const slot of slots) {
      const vs = slot.staff || [];
      if (vs.length >= 4) vs.forEach(s => ouStaff.add(s));
      else if (vs.length >= 1 && vs.includes('院長')) ouStaff.add('院長');
    }
    for (const n of ouStaff) {
      const ent = ensure(n);
      ent.days.delete(day);
      ent.hcd.add(day);
    }
    for (const slot of slots) {
      for (const n of slot.staff || []) {
        if (!ouStaff.has(n)) ensure(n).days.add(day);
      }
    }
  }
  return Object.entries(staffMap).map(([name, ent]) => ({
    year,
    month,
    staff_name: name,
    staff_role: ROLE_TO_GROUP[ent.role] || ent.role,
    staff_group: ROLE_TO_GROUP[ent.role] || ent.role,
    display_order: ORDER_MAP[name] || 99,
    days: [...ent.days].sort((a,b) => a - b),
    house_call_days: [...ent.hcd].sort((a,b) => a - b)
  })).sort((a,b) => a.display_order - b.display_order);
}

async function writeShifts(year, month, records) {
  if (records.length === 0) throw new Error('レコード0件のため書き込みをスキップ');
  const goodStaff = records.filter(r => r.staff_role !== 'その他' || r.staff_name === '遠藤歯科').length;
  if (goodStaff < 5) {
    throw new Error(`役職判定できたスタッフが ${goodStaff} 名と少なすぎます — 書き込みを中止`);
  }
  await sb(`shifts?year=eq.${year}&month=eq.${month}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' }
  });
  await sb('shifts', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(records)
  });
}

async function processOneRequest(req) {
  console.log(`\n=== 処理開始: ${req.target_year}年${req.target_month}月 (request_id=${req.id}) ===`);
  await updateRequest(req.id, { status: 'processing', started_at: new Date().toISOString() });

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });
  let page;
  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    });
    await context.addInitScript((slug) => {
      try { localStorage.setItem('slug', slug); } catch (e) {}
      try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
    }, DENTIS_SLUG);

    page = await context.newPage();
    await loginDentis(page);

    console.log('出勤者をスクレイピング中…');
    const att = await scrapeMonth(page, req.target_year, req.target_month, false);
    console.log('訪問をスクレイピング中…');
    const vis = await scrapeMonth(page, req.target_year, req.target_month, true);

    const records = aggregate(req.target_year, req.target_month, att.data, vis.data, att.roleMap);
    console.log(`集計完了: ${records.length}件のスタッフ`);
    await writeShifts(req.target_year, req.target_month, records);

    await updateRequest(req.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      result_message: `${records.length}名のシフトを更新`
    });
    console.log('=== 処理完了 ===');
  } catch (e) {
    console.error('=== エラー ===', e);
    if (page) await dumpDebug(page, `error_${req.target_year}${req.target_month}`).catch(() => {});
    await updateRequest(req.id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      result_message: String(e.message || e).slice(0, 500)
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  for (let i = 0; i < 5; i++) {
    const req = await getPendingRequest();
    if (!req) {
      if (i === 0) console.log('待機中の依頼なし');
      break;
    }
    await processOneRequest(req);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
