#!/usr/bin/env node
// bing_wallpaper.js
// Bing 壁纸 + 百科抓取（GitHub Actions 版）
// 纯 HTTP + 随机 MUID/GUID
//
// 数据流：
//   bing_wallpaper.json = 青龙推送（Actions 只读 + 补缺，不覆盖已有字段）
//   github.json         = Actions 自抓对照（每次覆盖为最新 14 天）
//
// 输出：
//   docs/json/today.json
//   docs/json/later.json
//   docs/json/bing_wallpaper.json
//   docs/json/github.json
//   docs/json/history.json
//   docs/json/index.json
//   docs/json/year/zh.YYYY.json
//   docs/json/month/YYYY/YYYY-MM.json

const fs = require('fs');
const path = require('path');
const https = require('https');

// ===================== 配置区 =====================
const CONFIG = {
  HEADERS: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://cn.bing.com/"
  },
  API_URL: "https://cn.bing.com/hp/api/model",

  SEARCH_HEADERS: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://cn.bing.com/',
    'Cache-Control': 'no-cache',
  },

  KEEP_DAYS: 14,
  ENC_RETRIES: 3,
  ENC_RETRY_DELAY: 20000,
  DOMAIN_SWITCH_DELAY: 60000,
  ENC_MIN_BYTES: 100000,

  JSON_DIR: path.join(__dirname, '..', 'docs', 'json'),
  FULL_JSON_NAME: "bing_wallpaper.json",
  GITHUB_JSON_NAME: "github.json",
  TODAY_JSON_NAME: "today.json",
  LATER_JSON_NAME: "later.json",
};

const JSON_DIR  = CONFIG.JSON_DIR;
const YEAR_DIR  = path.join(JSON_DIR, 'year');
const MONTH_DIR = path.join(JSON_DIR, 'month');

// ===================== 时间工具 =====================
function getBeijingDate() {
  const now = new Date();
  const beijingOffset = 8 * 60;
  const localOffset = now.getTimezoneOffset();
  return new Date(now.getTime() + (beijingOffset + localOffset) * 60000);
}

function formatBeijingDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatBeijingTime(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function writeLog(msg) {
  const beijingNow = getBeijingDate();
  const timestamp = formatBeijingTime(beijingNow);
  console.log(`[${timestamp}] ${msg}`);
}

// ===================== 工具函数 =====================
function ensureDirectoryExists(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function hasDescription(item) {
  return !!(item && item.description && String(item.description).trim().length > 0);
}

function cleanBingBackstageUrl(rawUrl) {
  if (!rawUrl) return "";
  return rawUrl.replace(/\\/g, "");
}

function getUhdUrl(wallpaperRaw) {
  if (!wallpaperRaw) return "";
  let full = wallpaperRaw;
  if (full.startsWith("/")) {
    full = `https://cn.bing.com${full}`;
  }
  const match = full.match(/th\?id=([^&]+)/);
  if (match) {
    let baseId = match[1];
    baseId = baseId.replace(/_\d+x\d+\.jpg$/, '');
    return `https://cn.bing.com/th?id=${baseId}_UHD.jpg`;
  }
  return full;
}

function randomMuid() {
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += Math.floor(Math.random() * 16).toString(16).toUpperCase();
  }
  return s;
}

function randomGuid() {
  return randomMuid();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ===================== 安全读取 JSON 数组 =====================
function readJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    writeLog(`⚠️ 读取失败（视为空）: ${filePath} — ${e.message}`);
    return [];
  }
}

// ===================== HTTP 请求封装 =====================
function requestGet(url, headers, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let location = res.headers.location;
        if (location.startsWith('/')) {
          const u = new URL(url);
          location = `${u.protocol}//${u.host}${location}`;
        }
        return resolve(requestGet(location, headers, timeout));
      }
      let chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: buf.toString('utf8'),
          bytes: buf.length
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

function requestGetJson(url, headers) {
  return requestGet(url, headers).then(res => {
    try {
      return JSON.parse(res.body);
    } catch (err) {
      throw new Error('JSON解析失败: ' + err.message);
    }
  });
}

// ===================== 清理 BackstageUrl =====================
function cleanBackstageUrl(data) {
  if (Array.isArray(data)) {
    return data.map(item => {
      const { BackstageUrl, ...rest } = item;
      return rest;
    });
  }
  const { BackstageUrl, ...rest } = data;
  return rest;
}

// ===================== API 拉取壁纸基础列表 =====================
async function crawlBingWallpaperBase() {
  let rawData;
  try {
    rawData = await requestGetJson(CONFIG.API_URL, CONFIG.HEADERS);
  } catch (e) {
    writeLog(`【请求API失败】${e.message}`);
    return [];
  }

  const mediaList = [];
  if (rawData.PreloadMediaContents) {
    mediaList.push(...rawData.PreloadMediaContents);
  }
  if (rawData.MediaContents) {
    mediaList.push(...rawData.MediaContents);
  }

  const resultArr = [];
  const seenDates = new Set();

  for (const item of mediaList) {
    const ssd = item.Ssd || "";
    const imgContent = item.ImageContent || {};

    const headline = imgContent.Headline || "";
    const titleText = imgContent.Title || "";
    const wallpaper = imgContent.Image?.Wallpaper || "";
    let backstageUrlRaw = imgContent.BackstageUrl || "";

    const bingUrl = getUhdUrl(wallpaper);

    if (backstageUrlRaw.startsWith("/")) {
      backstageUrlRaw = `https://cn.bing.com${backstageUrlRaw}`;
    }
    const backstageUrl = cleanBingBackstageUrl(backstageUrlRaw);

    let dateStr, fullTitle;
    if (ssd.length === 8) {
      dateStr = `${ssd.slice(0,4)}-${ssd.slice(4,6)}-${ssd.slice(6,8)}`;
      fullTitle = `${titleText} - ${ssd.slice(0,4)}/${ssd.slice(4,6)}/${ssd.slice(6,8)}`;
    } else {
      dateStr = ssd;
      fullTitle = `${titleText} - ${ssd}`;
    }

    if (seenDates.has(dateStr)) continue;
    seenDates.add(dateStr);

    resultArr.push({
      title: fullTitle,
      subtitle: headline,
      description: "",
      date: dateStr,
      bing_url: bingUrl,
      BackstageUrl: backstageUrl
    });
  }
  return resultArr;
}

// ===================== 读取两个数据源 =====================
// 返回 { bingMap, githubMap }
function loadDataSources(fullJsonPath, githubJsonPath) {
  const bingArr = readJsonArray(fullJsonPath);
  const githubArr = readJsonArray(githubJsonPath);

  const bingMap = new Map();
  bingArr.forEach(it => { if (it && it.date) bingMap.set(it.date, it); });

  const githubMap = new Map();
  githubArr.forEach(it => { if (it && it.date) githubMap.set(it.date, it); });

  return { bingMap, githubMap };
}

// ===================== 判断需要抓百科的日期 =====================
// 规则：API 14天中，bing_wallpaper.json 和 github.json 都没有 description 的日期才需要抓
function computeNeedFetchDates(apiList, bingMap, githubMap) {
  const needFetch = [];
  const skippedByBing = [];
  const skippedByGithub = [];

  for (const apiItem of apiList) {
    const bingItem = bingMap.get(apiItem.date);
    const ghItem = githubMap.get(apiItem.date);

    if (hasDescription(bingItem)) {
      skippedByBing.push(apiItem.date);
      continue;
    }
    if (hasDescription(ghItem)) {
      skippedByGithub.push(apiItem.date);
      continue;
    }
    needFetch.push(apiItem.date);
  }

  return { needFetch, skippedByBing, skippedByGithub };
}

// ===================== 全字段对比 github vs bing =====================
// 返回 { same, onlyGithub, onlyBing, changed }
function compareGithubVsBing(githubArr, bingArr) {
  const FIELDS = ['title', 'subtitle', 'description', 'bing_url'];

  const githubMap = new Map();
  githubArr.forEach(it => { if (it && it.date) githubMap.set(it.date, it); });

  const bingMap = new Map();
  bingArr.forEach(it => { if (it && it.date) bingMap.set(it.date, it); });

  const same = [];
  const onlyGithub = [];
  const onlyBing = [];
  const changed = [];

  for (const [date, ghItem] of githubMap.entries()) {
    const bingItem = bingMap.get(date);
    if (!bingItem) {
      onlyGithub.push(date);
      continue;
    }

    let isSame = true;
    const diffFields = [];
    for (const f of FIELDS) {
      const a = (ghItem[f] || '').toString().trim();
      const b = (bingItem[f] || '').toString().trim();
      if (a !== b) {
        isSame = false;
        diffFields.push(f);
      }
    }

    if (isSame) {
      same.push(date);
    } else {
      changed.push({
        date,
        fields: diffFields,
        github: ghItem,
        bing: bingItem
      });
    }
  }

  for (const date of bingMap.keys()) {
    if (!githubMap.has(date)) onlyBing.push(date);
  }

  same.sort();
  onlyGithub.sort();
  onlyBing.sort();
  changed.sort((a, b) => b.date.localeCompare(a.date));

  return { same, onlyGithub, onlyBing, changed };
}

// ===================== 百科 HTML 解析 =====================
function extractEncyclopediaFromHtml(html) {
  const cardMatch = html.match(/<div[^>]*class="[^"]*encyclopedia-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i);

  let block = null;
  const expandedMatch = html.match(/<div[^>]*class="[^"]*encyclopedia-expanded[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (expandedMatch) block = expandedMatch[1];
  else if (cardMatch) block = cardMatch[1];

  if (!block) return null;

  const subMatch = block.match(/<div[^>]*class="[^"]*encyclopedia-subtitle[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const subtitle = subMatch ? subMatch[1].replace(/<[^>]+>/g, '').trim() : '';

  const descMatch = block.match(/<div[^>]*class="[^"]*encyclopedia-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  let rawDesc = descMatch ? descMatch[1] : block;

  rawDesc = rawDesc
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/br>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/&lt;br\s*\/?&gt;/gi, '\n')
    .replace(/&lt;\/br&gt;/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, '\n');

  const finalParagraphs = rawDesc
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (finalParagraphs.length === 0) return null;

  return {
    subtitle,
    description: finalParagraphs.join('\n'),
    paragraphs: finalParagraphs,
    length: finalParagraphs.join('').length,
  };
}

// ===================== 抓单条百科（cn + www 双域名，各 3 次重试） =====================
async function fetchEncyclopedia(backstageUrl) {
  if (!backstageUrl) return { subtitle: '', description: '' };

  let wwwUrl = backstageUrl;
  try {
    const u = new URL(backstageUrl);
    if (u.hostname === 'cn.bing.com') {
      u.hostname = 'www.bing.com';
      wwwUrl = u.toString();
    }
  } catch (e) {}

  const domains = [
    { name: 'cn.bing.com', url: backstageUrl },
    { name: 'www.bing.com', url: wwwUrl }
  ];

  for (let d = 0; d < domains.length; d++) {
    const { name: domainName, url } = domains[d];

    const muid = randomMuid();
    const guid = randomGuid();
    const cookie = `MUID=${muid}; MUIDB=${muid}; SRCHUID=V=2&GUID=${guid}&dmnchg=1`;

    writeLog(`  🌐 [${d + 1}/${domains.length}] 使用域名：${domainName}`);
    writeLog(`  🍪 本域名标识：MUID=${muid.slice(0, 8)}... GUID=${guid.slice(0, 8)}...`);

    for (let i = 1; i <= CONFIG.ENC_RETRIES; i++) {
      try {
        const headers = {
          ...CONFIG.SEARCH_HEADERS,
          'Cookie': cookie,
        };

        writeLog(`  📡 第 ${i}/${CONFIG.ENC_RETRIES} 次请求...`);

        const res = await requestGet(url, headers, 20000);
        writeLog(`  📦 响应：${res.status}, ${res.bytes} 字节`);

        if (res.status !== 200) {
          writeLog(`  ⚠️ HTTP ${res.status}`);
          if (i < CONFIG.ENC_RETRIES) {
            writeLog(`  ⏳ 等待 ${CONFIG.ENC_RETRY_DELAY / 1000}s 后重试...`);
            await sleep(CONFIG.ENC_RETRY_DELAY);
          }
          continue;
        }

        if (res.bytes < CONFIG.ENC_MIN_BYTES) {
          writeLog(`  🚫 疑似限流（${res.bytes} < ${CONFIG.ENC_MIN_BYTES}）`);
          if (i < CONFIG.ENC_RETRIES) {
            writeLog(`  ⏳ 等待 ${CONFIG.ENC_RETRY_DELAY / 1000}s 后重试...`);
            await sleep(CONFIG.ENC_RETRY_DELAY);
          }
          continue;
        }

        const enc = extractEncyclopediaFromHtml(res.body);
        if (enc && enc.length > 50) {
          writeLog(`  ✅ 百科抓取成功（${domainName}）：${enc.paragraphs.length} 段，${enc.length} 字符`);
          return enc;
        }

        writeLog(`  ⚠️ 未解析到有效百科`);
        if (i < CONFIG.ENC_RETRIES) {
          writeLog(`  ⏳ 等待 ${CONFIG.ENC_RETRY_DELAY / 1000}s 后重试...`);
          await sleep(CONFIG.ENC_RETRY_DELAY);
        }

      } catch (e) {
        writeLog(`  ❌ 异常：${e.message}`);
        if (i < CONFIG.ENC_RETRIES) {
          writeLog(`  ⏳ 等待 ${CONFIG.ENC_RETRY_DELAY / 1000}s 后重试...`);
          await sleep(CONFIG.ENC_RETRY_DELAY);
        }
      }
    }

    writeLog(`  ❌ ${domainName} 重试 ${CONFIG.ENC_RETRIES} 次均失败`);

    if (d < domains.length - 1) {
      const cooldown = CONFIG.DOMAIN_SWITCH_DELAY || 60000;
      writeLog(`  🧊 冷却 ${cooldown / 1000}s，准备切换域名...`);
      await sleep(cooldown);
      writeLog(`  🔄 切换到下一个域名，将生成新的 MUID/GUID...`);
    }
  }

  writeLog(`  ❌ cn.bing.com + www.bing.com 全部失败，本条 description 留空`);
  return { subtitle: '', description: '' };
}

// ===================== 按 needFetch 列表抓百科，填充到 apiList =====================
async function attachEncyclopedia(apiList, needFetchDates) {
  const needSet = new Set(needFetchDates);
  const needFetchList = apiList.filter(item => needSet.has(item.date));
  writeLog(`📊 本次待抓百科：${needFetchList.length} 条`);

  if (needFetchList.length === 0) {
    writeLog(`✅ 无需抓取百科`);
    return apiList;
  }

  for (let idx = 0; idx < needFetchList.length; idx++) {
    const item = needFetchList[idx];
    writeLog(`===== [${idx+1}/${needFetchList.length}] 处理日期【${item.date}】 =====`);
    writeLog(`  标题: ${item.title}`);
    writeLog(`  搜索页: ${item.BackstageUrl}`);

    if (!item.BackstageUrl) {
      writeLog(`  ⚠️ 无搜索页地址，跳过`);
      item.description = '';
      continue;
    }

    const enc = await fetchEncyclopedia(item.BackstageUrl);
    item.description = enc.description;
    if (enc.subtitle && !item.subtitle) {
      item.subtitle = enc.subtitle;
    }

    if (idx < needFetchList.length - 1) await sleep(1000);
  }

  return apiList;
}

// ===================== 年份文件 upsert（带保护） =====================
function upsertYearFile(yearDir, year, newItem, logs) {
  ensureDirectoryExists(yearDir);
  const yearFile = path.join(yearDir, `zh.${year}.json`);

  let existing = [];
  if (fs.existsSync(yearFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(yearFile, 'utf8'));
      if (!Array.isArray(existing)) existing = [];
    } catch (e) {
      logs.push(`⚠️ 年份文件损坏，重建: ${e.message}`);
      existing = [];
    }
  }

  const idx = existing.findIndex(x => x.date === newItem.date);

  if (idx >= 0) {
    const oldItem = existing[idx];
    const oldHasDesc = hasDescription(oldItem);
    const newHasDesc = hasDescription(newItem);

    if (oldHasDesc && !newHasDesc) {
      logs.push(`🛡️ ${yearFile} 保留已有 description（新数据为空）: ${newItem.date}`);
      return existing;
    }

    if (!oldHasDesc && newHasDesc) {
      existing[idx] = newItem;
      logs.push(`🔁 ${yearFile} 补充 description: ${newItem.date}`);
    }
    else if (oldHasDesc && newHasDesc) {
      if (newItem.description.length >= oldItem.description.length) {
        existing[idx] = newItem;
        logs.push(`🔁 ${yearFile} 更新（更长 description）: ${newItem.date}`);
      } else {
        logs.push(`⏭️ ${yearFile} 保留更长 description: ${newItem.date}`);
        return existing;
      }
    }
    else {
      logs.push(`⏭️ ${yearFile} 无实质变化: ${newItem.date}`);
      return existing;
    }
  } else {
    existing.push(newItem);
    logs.push(`➕ ${yearFile} 追加日期 ${newItem.date}`);
  }

  existing.sort((a, b) => b.date.localeCompare(a.date));
  fs.writeFileSync(yearFile, JSON.stringify(existing, null, 2), 'utf8');
  logs.push(`✅ ${yearFile} 共 ${existing.length} 条`);
  return existing;
}

// ===================== 按月拆分 =====================
function splitIntoMonthFiles(yearDir, monthDir, logs) {
  ensureDirectoryExists(monthDir);

  const nowBeijing = getBeijingDate();
  const currentYear = nowBeijing.getFullYear();
  const nextYear = currentYear + 1;

  const targetYears = [String(currentYear)];
  const nextYearFile = path.join(yearDir, `zh.${nextYear}.json`);
  if (fs.existsSync(nextYearFile)) {
    targetYears.push(String(nextYear));
    logs.push(`📅 发现下一年文件 zh.${nextYear}.json，一并处理`);
  }

  logs.push(`🎯 本次处理年份: ${targetYears.join(', ')}`);

  for (const year of targetYears) {
    const yearFile = path.join(yearDir, `zh.${year}.json`);
    if (!fs.existsSync(yearFile)) {
      logs.push(`⚠️ 年份文件不存在，跳过: ${yearFile}`);
      continue;
    }

    let data;
    try {
      data = JSON.parse(fs.readFileSync(yearFile, 'utf8'));
    } catch (e) {
      logs.push(`⚠️ 跳过 ${yearFile}: ${e.message}`);
      continue;
    }
    if (!Array.isArray(data)) {
      logs.push(`⚠️ 跳过 ${yearFile}: 不是数组`);
      continue;
    }

    const byMonth = {};
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const d = item.date || '';
      if (d.length < 7) continue;
      const month = d.slice(5, 7);
      if (!byMonth[month]) byMonth[month] = [];
      byMonth[month].push(item);
    }

    const outDir = path.join(monthDir, year);
    ensureDirectoryExists(outDir);

    for (const month of Object.keys(byMonth)) {
      const items = byMonth[month].sort((a, b) => b.date.localeCompare(a.date));
      const outFile = path.join(outDir, `${year}-${month}.json`);
      fs.writeFileSync(outFile, JSON.stringify(items, null, 2), 'utf8');
      logs.push(`  写入 ${outFile} (${items.length} 条)`);
    }
  }
  logs.push(`✅ 月份拆分完成`);
}

// ===================== history.json =====================
function generateHistory(yearDir, jsonDir, logs) {
  ensureDirectoryExists(jsonDir);

  const nowBeijing = getBeijingDate();
  const currentYear = nowBeijing.getFullYear();

  const all = [];
  for (let y = 2010; y <= currentYear; y++) {
    const file = path.join(yearDir, `zh.${y}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(arr)) {
        all.push(...arr);
        logs.push(`📄 合并: ${file} (${arr.length} 条)`);
      }
    } catch (e) {
      logs.push(`⚠️ 跳过无效 JSON: ${file} — ${e.message}`);
    }
  }

  const map = new Map();
  for (const item of all) {
    if (item && item.date) map.set(item.date, item);
  }
  const merged = Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));

  const historyFile = path.join(jsonDir, 'history.json');
  fs.writeFileSync(historyFile, JSON.stringify(merged, null, 2), 'utf8');
  logs.push(`✅ history.json 生成，共 ${merged.length} 张`);
  return merged.length;
}

// ===================== index.json =====================
function generateIndex(yearDir, jsonDir, logs) {
  ensureDirectoryExists(jsonDir);

  const nowBeijing = getBeijingDate();
  const currentYear = nowBeijing.getFullYear();

  const index = { years: [] };
  for (let y = 2010; y <= currentYear; y++) {
    const file = path.join(yearDir, `zh.${y}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const count = Array.isArray(data) ? data.length : 0;
      if (count > 0) {
        index.years.push({ year: String(y), count });
        logs.push(`✅ 发现 ${y} 年数据，共 ${count} 条`);
      }
    } catch (e) {
      logs.push(`⚠️ 读取 ${y} 年数据失败: ${e.message}`);
    }
  }
  index.years.sort((a, b) => parseInt(b.year) - parseInt(a.year));

  const indexPath = path.join(jsonDir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
  logs.push(`✅ index.json 生成，共 ${index.years.length} 个年份`);
}

// ===================== 主函数 =====================
(async function main() {
  const logs = [];
  const log = (msg) => { logs.push(msg); writeLog(msg); };

  try {
    ensureDirectoryExists(JSON_DIR);
    ensureDirectoryExists(YEAR_DIR);
    ensureDirectoryExists(MONTH_DIR);

    log(`==================== 必应壁纸+百科（GitHub Actions 版）启动 ====================`);

    const fullJsonPath   = path.join(JSON_DIR, CONFIG.FULL_JSON_NAME);   // 青龙推的
    const githubJsonPath = path.join(JSON_DIR, CONFIG.GITHUB_JSON_NAME); // Actions 抓的

    // ========== 1. 拉取 API 14 天列表 ==========
    const apiList = await crawlBingWallpaperBase();
    if (!apiList.length) {
      log("❌ 未采集到任何数据，退出");
      process.exit(1);
    }
    log(`📊 API 返回: ${apiList.length} 条（${apiList[apiList.length-1].date} ~ ${apiList[0].date}）`);

    // ========== 2. 读取全量文件 github.json ==========
    const githubArrOld = readJsonArray(githubJsonPath);
    const githubMapOld = new Map();
    githubArrOld.forEach(it => { if (it && it.date) githubMapOld.set(it.date, it); });
    log(`📊 github.json（旧）: ${githubMapOld.size} 条`);

    // ========== 3. 判断需要抓百科的日期 ==========
    // 规则：API 14天中，github.json 没有 description 的日期 → 需要抓
    const needFetch = [];
    const skippedByGithub = [];
    for (const apiItem of apiList) {
      const ghItem = githubMapOld.get(apiItem.date);
      if (hasDescription(ghItem)) {
        skippedByGithub.push(apiItem.date);
      } else {
        needFetch.push(apiItem.date);
      }
    }

    log(`\n==================== 抓取计划 ====================`);
    log(`✅ github 已有描述（跳过）: ${skippedByGithub.length} 条`);
    log(`🔍 需要抓百科: ${needFetch.length} 条 ${needFetch.length > 0 ? '→ ' + needFetch.join(', ') : ''}`);

    // ========== 4. 抓百科 → 填充到 apiList ==========
    // 注意：如果 github 已有描述但本次没抓（如跳过），从 github 复用 description
    // 避免 github.json 写入时丢失已有描述
    for (const apiItem of apiList) {
      const ghItem = githubMapOld.get(apiItem.date);
      if (hasDescription(ghItem) && !apiItem.description) {
        apiItem.description = ghItem.description;
        if (!apiItem.subtitle && ghItem.subtitle) {
          apiItem.subtitle = ghItem.subtitle;
        }
      }
    }

    // 抓需要抓的日期
    await attachEncyclopedia(apiList, needFetch);

    // ========== 5. 写 github.json（14 天滚动覆盖，完整 14 天） ==========
    const githubLimited = apiList
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, CONFIG.KEEP_DAYS);

    const githubCleaned = cleanBackstageUrl(githubLimited);
    fs.writeFileSync(githubJsonPath, JSON.stringify(githubCleaned, null, 2), 'utf8');
    log(`\n✅ github.json 已写入: ${githubJsonPath} (${githubCleaned.length} 条)`);

    // ========== 6. 对比 github.json vs bing_wallpaper.json（全字段） ==========
    const githubArrForCompare = readJsonArray(githubJsonPath);
    const bingArrForCompare   = readJsonArray(fullJsonPath);

    const { same, onlyGithub, onlyBing, changed } =
      compareGithubVsBing(githubArrForCompare, bingArrForCompare);

    log(`\n==================== 一致性对比（github.json vs bing_wallpaper.json） ====================`);
    log(`📊 github.json:         ${githubArrForCompare.length} 条`);
    log(`📊 bing_wallpaper.json: ${bingArrForCompare.length} 条`);
    log(`✅ 完全一致:   ${same.length} 条`);
    log(`🆕 仅 github:  ${onlyGithub.length} 条`);
    log(`🗑️ 仅 bing:    ${onlyBing.length} 条`);
    log(`🔀 有差异:     ${changed.length} 条`);

    if (onlyGithub.length > 0) {
      log(`\n🆕 仅 github 有的日期（bing 缺这天）: ${onlyGithub.join(', ')}`);
    }
    if (onlyBing.length > 0) {
      log(`\n🗑️ 仅 bing 有的日期（github 缺这天）: ${onlyBing.join(', ')}`);
    }

    if (changed.length > 0) {
      log(`\n----- 差异明细（前 20 条） -----`);
      changed.slice(0, 20).forEach(c => {
        log(`  [${c.date}] 差异字段: ${c.fields.join(', ')}`);
        for (const f of c.fields) {
          const bv = (c.bing[f] || '').toString().slice(0, 50);
          const gv = (c.github[f] || '').toString().slice(0, 50);
          log(`    ${f}:`);
          log(`      bing  ="${bv}${bv.length >= 50 ? '...' : ''}"`);
          log(`      github="${gv}${gv.length >= 50 ? '...' : ''}"`);
        }
      });
      if (changed.length > 20) {
        log(`  ... 还有 ${changed.length - 20} 条差异未显示`);
      }
    }

    // ========== 7. 补缺：github.json 补进 bing_wallpaper.json ==========
    // 规则：
    //   - bing 已有的日期：完全不覆盖（青龙绝对权威，哪怕短）
    //   - bing 缺的日期：用 github 的数据补进去
    log(`\n==================== 补缺到 bing_wallpaper.json ====================`);
    const bingFinalMap = new Map();
    bingArrForCompare.forEach(it => { if (it && it.date) bingFinalMap.set(it.date, it); });

    let addedFromGithub = 0;
    for (const ghItem of githubArrForCompare) {
      if (!bingFinalMap.has(ghItem.date)) {
        bingFinalMap.set(ghItem.date, ghItem);
        addedFromGithub++;
        log(`  ➕ 补入日期: ${ghItem.date}（来自 github.json）`);
      }
    }

    let bingFinalArr = Array.from(bingFinalMap.values());
    bingFinalArr.sort((a, b) => b.date.localeCompare(a.date));

    const bingLimited = bingFinalArr.slice(0, CONFIG.KEEP_DAYS);
    const bingCleaned = cleanBackstageUrl(bingLimited);

    fs.writeFileSync(fullJsonPath, JSON.stringify(bingCleaned, null, 2), 'utf8');
    log(`✅ bing_wallpaper.json 已更新: ${fullJsonPath} (${bingCleaned.length} 条)`);
    log(`   本次从 github 补入: ${addedFromGithub} 条`);

    // ========== 8. 生成 today / later / year / month / history / index ==========
    // 全部基于更新后的 bing_wallpaper.json

    // 8.1 today.json
    const beijingNow = getBeijingDate();
    const todayDateStr = formatBeijingDate(beijingNow);
    let todayFilterData = bingCleaned.filter(item => item.date === todayDateStr);
    if (todayFilterData.length === 0) {
      log(`⚠️ 未找到今日数据 ${todayDateStr}，使用最新数据`);
      todayFilterData = bingCleaned.slice(0, 1);
    }
    const todayJsonOutputPath = path.join(JSON_DIR, CONFIG.TODAY_JSON_NAME);
    fs.writeFileSync(todayJsonOutputPath, JSON.stringify(todayFilterData, null, 2), 'utf8');
    log(`✅ today.json 已输出 (${todayFilterData.length} 条)`);

    // 8.2 later.json
    const laterFilterData = bingCleaned.length > 0 ? [bingCleaned[0]] : [];
    const laterJsonOutputPath = path.join(JSON_DIR, CONFIG.LATER_JSON_NAME);
    fs.writeFileSync(laterJsonOutputPath, JSON.stringify(laterFilterData, null, 2), 'utf8');
    log(`✅ later.json 已输出 (${laterFilterData.length} 条)`);

    // 8.3 年份文件
    log(`\n==================== 写入年份文件 ====================`);
    for (const item of bingCleaned) {
      const year = item.date.slice(0, 4);
      upsertYearFile(YEAR_DIR, year, item, logs);
    }

    // 8.4 按月拆分
    log(`\n==================== 拆分月份文件 ====================`);
    splitIntoMonthFiles(YEAR_DIR, MONTH_DIR, logs);

    // 8.5 history.json
    log(`\n==================== 生成 history.json ====================`);
    const historyCount = generateHistory(YEAR_DIR, JSON_DIR, logs);

    // 8.6 index.json
    log(`\n==================== 生成 index.json ====================`);
    generateIndex(YEAR_DIR, JSON_DIR, logs);

    // ========== 9. 日志展示 ==========
    log(`\n===今日数据展示===`);
    log(JSON.stringify(todayFilterData[0] || {}, null, 2));
    log(`===未来数据展示===`);
    log(JSON.stringify(laterFilterData[0] || {}, null, 2));

    // ========== 10. 写入 GITHUB_ENV ==========
    const latestItem = todayFilterData[0] || bingCleaned[0] || {};
    const envFile = process.env.GITHUB_ENV;
    if (envFile) {
      const safe = (s) => String(s || '').replace(/\n/g, ' ').replace(/\r/g, ' ').trim();
      fs.appendFileSync(envFile, [
        `TITLE=${safe(latestItem.title)}`,
        `SUBTITLE=${safe(latestItem.subtitle)}`,
        `DATE=${safe(latestItem.date)}`,
        `BING_URL=${safe(latestItem.bing_url)}`,
        `DESC_LEN=${(latestItem.description || '').length}`,
        `HISTORY_COUNT=${historyCount}`,
        `NEED_WRITE=True`
      ].join('\n') + '\n', 'utf8');
      log(`✅ GITHUB_ENV 已写入`);
    }

    log(`\n==================== 全部任务执行完毕 ====================`);
    log(`📊 汇总: today=${todayFilterData.length} later=${laterFilterData.length} history=${historyCount}`);

  } catch (globalErr) {
    writeLog(`❌ 脚本全局异常：${globalErr.message}\n${globalErr.stack}`);
    process.exit(1);
  }
})();
