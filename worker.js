// 遠藤歯科クリニック - シフト同期ワーカー
// shift_sync_requests テーブルの pending 行を拾い、Dentis をスクレイピングして shifts を更新する

import { chromium } from 'playwright';

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

async function loginDentis(page) {
  await page.goto('https://d.dentis-cloud.com/dental/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((slug) => localStorage.setItem('slug', slug), DENTIS_SLUG);
  await page.goto('https://d.dentis-cloud.com/dental/signin', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="username"]', { timeout: 20000 });
  await page.fill('input[name="username"]', DENTIS_USERNAME);
  await page.fill('input[name="password"]', DENTIS_PASSWORD);
  await page.getByRole('button', { name: 'サインイン' }).click();
  await page.waitForURL(/\/dental(\/schedule)?$/, { timeout: 30000 });
  await page.waitForSelector('[class*="Navi__Month"]', { timeout: 30000 });
  console.log('Dentis ログイン成功');
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

async function scrapeMonth(page, year, month, isVisit) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
  const endDate = `${year}-${String(month).padStart(2,'0')}-${String(daysInMonth).padStart(2,'0')}`;
  const baseUrl = isVisit
    ? `https://d.dentis-cloud.com/dental/visiting_schedule?date=${startDate}`
    : `https://d.dentis-cloud.com/dental/schedule?date=${startDate}`;

  console.log(`→ ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[class*="Navi__Month"]', { timeout: 30000 });
  await page.waitForTimeout(2500);

  const data = {};
  let roleMapAcc = {};

  for (let i = 0; i < daysInMonth + 5; i++) {
    const currentDate = await page.evaluate(`(function(){${PAGE_HELPERS}; return getCurrentDate();})()`);
    if (!currentDate || currentDate > endDate) break;
    if (isVisit) {
      data[currentDate] = await page.evaluate(`(function(){${PAGE_HELPERS}; return getVisits();})()`);
    } else {
      const attRes = await page.evaluate(`(function(){${PAGE_HELPERS}; return getAttendees();})()`);
      if (attRes) {
        data[currentDate] = attRes.names;
        Object.assign(roleMapAcc, attRes.roles);
      } else {
        data[currentDate] = [];
      }
    }
    if (currentDate >= endDate) break;
    const hasNext = await page.evaluate(`(function(){${PAGE_HELPERS}; const b = getNextBtn(); if (!b) return false; b.click(); return true;})()`);
    if (!hasNext) break;
    await page.waitForTimeout(1800);
  }
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
      if (vs.length >= 4) vs.forEach(s =>
