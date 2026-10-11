#!/usr/bin/env node
// bing_wallpaper.js
// Bing 壁纸 + 百科抓取（GitHub Actions 版）
// 纯 HTTP + 随机 MUID/GUID
// 输出：today.json / later.json / bing_wallpaper.json / year/zh.YYYY.json / month/YYYY/YYYY-MM.json / history.json / index.json

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
  ENC_RETRY_DELAY: 2000,
  ENC_MIN_BYTES: 100000,

  // 输出根目录（相对仓库根）
  JSON_DIR: path.join(__dirname, '..', 'docs', 'json'),
  FULL_JSON_NAME: "bing_wallpaper.json",
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

// ===================== 抓单条百科 =====================
async function fetchEncyclopedia(backstageUrl) {
  if (!backstageUrl) return { subtitle: '', description: '' };

  for (let i = 1; i <= CONFIG.ENC_RETRIES; i++) {
    try {
      const muid = randomMuid();
      const guid = randomGuid();

      const headers = {
        ...CONFIG.SEARCH_HEADERS,
        'Cookie': `MUID=${muid}; MUIDB=${muid}; SRCHUID=V=2&GUID=${guid}&dmnchg=1`,
      };

      writeLog(`  🍪 第 ${i}/${CONFIG.ENC_RETRIES} 次：MUID=${muid.slice(0,8)}... GUID=${guid.slice(0,8)}...`);

      const res = await requestGet(backstageUrl, headers, 20000);
      writeLog(`  📦 响应：${res.status}, ${res.bytes} 字节`);

      if (res.status !== 200 || res.bytes < CONFIG.ENC_MIN_BYTES) {
        writeLog(`  ⚠️ 第 ${i}/${CONFIG.ENC_RETRIES} 次响应异常（${res.status}, ${res.bytes}字节）`);
        if (i < CONFIG.ENC_RETRIES) await sleep(CONFIG.ENC_RETRY_DELAY);
        continue;
      }

      const enc = extractEncyclopediaFromHtml(res.body);
      if (enc && enc.length > 50) {
        writeLog(`  ✅ 百科抓取成功：${enc.paragraphs.length} 段，${enc.length} 字符`);
        return enc;
      }

      writeLog(`  ⚠️ 第 ${i}/${CONFIG.ENC_RETRIES} 次未解析到有效百科`);
      if (i < CONFIG.ENC_RETRIES) await sleep(CONFIG.ENC_RETRY_DELAY);
    } catch (e) {
      writeLog(`  ❌ 第 ${i}/${CONFIG.ENC_RETRIES} 次异常：${e.message}`);
      if (i < CONFIG.ENC_RETRIES) await sleep(CONFIG.ENC_RETRY_DELAY);
    }
  }

  writeLog(`  ❌ 重试 ${CONFIG.ENC_RETRIES} 次均失败，本条 description 留空`);
  return { subtitle: '', description: '' };
}

// ===================== 批量处理百科 =====================
async function attachEncyclopedia(baseList, existDateSet) {
  const needFetchList = baseList.filter(item => !existDateSet.has(item.date));
  const skipList = baseList.filter(item => existDateSet.has(item.date));
  writeLog(`📊 本次待处理统计：`);
  writeLog(`已有数据跳过: ${skipList.length} 条`);
  writeLog(`需要抓取百科: ${needFetchList.length} 条`);

  if (needFetchList.length === 0) {
    writeLog(`✅ 无新增条目，跳过抓取`);
    return baseList;
  }

  const resultList = [];
  for (let idx = 0; idx < needFetchList.length; idx++) {
    const item = needFetchList[idx];
    writeLog(`===== [${idx+1}/${needFetchList.length}] 处理日期【${item.date}】 =====`);
    writeLog(`  标题: ${item.title}`);
    writeLog(`  搜索页: ${item.BackstageUrl}`);

    if (!item.BackstageUrl) {
      writeLog(`  ⚠️ 无搜索页地址，跳过`);
      item.description = '';
      resultList.push(item);
      continue;
    }

    const enc = await fetchEncyclopedia(item.BackstageUrl);
    item.description = enc.description;
    if (enc.subtitle && !item.subtitle) {
      item.subtitle = enc.subtitle;
    }
    resultList.push(item);

    if (idx < needFetchList.length - 1) await sleep(1000);
  }

  return [...skipList, ...resultList];
}

// ===================== 年份文件 upsert =====================
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
    existing[idx] = newItem;
    logs.push(`🔁 ${yearFile} 更新已有日期 ${newItem.date}`);
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

    // 1. 拉取 API 基础列表
    const wallBaseData = await crawlBingWallpaperBase();
    if (!wallBaseData.length) {
      log("❌ 未采集到任何数据，退出");
      process.exit(1);
    }

    // 2. 全量文件（近 KEEP_DAYS 天）
    const fullJsonOutputPath = path.join(JSON_DIR, CONFIG.FULL_JSON_NAME);

    let oldData = [];
    if (fs.existsSync(fullJsonOutputPath)) {
      try {
        oldData = JSON.parse(fs.readFileSync(fullJsonOutputPath, 'utf8'));
        if (!Array.isArray(oldData)) oldData = [];
      } catch (e) {
        log(`⚠️ 旧JSON损坏，清空历史: ${e.message}`);
        oldData = [];
      }
    }

    const existDateSet = new Set(oldData.map(x => x.date));
    const fullNewList = await attachEncyclopedia(wallBaseData, existDateSet);
    const appendList = fullNewList.filter(item => !existDateSet.has(item.date));

    // 合并：新数据优先
    const dateMap = new Map();
    oldData.forEach(item => dateMap.set(item.date, item));
    appendList.forEach(item => dateMap.set(item.date, item));
    let finalData = Array.from(dateMap.values());
    finalData.sort((a, b) => b.date.localeCompare(a.date));

    const limitedData = finalData.slice(0, CONFIG.KEEP_DAYS);
    const cleanedData = cleanBackstageUrl(limitedData);

    fs.writeFileSync(fullJsonOutputPath, JSON.stringify(cleanedData, null, 2), 'utf8');
    log(`✅ 全量文件已输出：${fullJsonOutputPath} (${cleanedData.length} 条)`);

    // 3. today.json
    const beijingNow = getBeijingDate();
    const todayDateStr = formatBeijingDate(beijingNow);
    let todayFilterData = cleanedData.filter(item => item.date === todayDateStr);
    if (todayFilterData.length === 0) {
      log(`⚠️ 未找到今日数据 ${todayDateStr}，使用最新数据`);
      todayFilterData = cleanedData.slice(0, 1);
    }
    const todayJsonOutputPath = path.join(JSON_DIR, CONFIG.TODAY_JSON_NAME);
    fs.writeFileSync(todayJsonOutputPath, JSON.stringify(todayFilterData, null, 2), 'utf8');
    log(`✅ today.json 已输出 (${todayFilterData.length} 条)`);

    // 4. later.json
    const laterFilterData = cleanedData.length > 0 ? [cleanedData[0]] : [];
    const laterJsonOutputPath = path.join(JSON_DIR, CONFIG.LATER_JSON_NAME);
    fs.writeFileSync(laterJsonOutputPath, JSON.stringify(laterFilterData, null, 2), 'utf8');
    log(`✅ later.json 已输出 (${laterFilterData.length} 条)`);

    // 5. 年份文件（本次抓到的所有新数据都写入对应年份）
    log(`\n==================== 写入年份文件 ====================`);
    for (const item of fullNewList) {
      const year = item.date.slice(0, 4);
      const { BackstageUrl, ...cleanItem } = item;
      upsertYearFile(YEAR_DIR, year, cleanItem, logs);
    }

    // 6. 按月拆分
    log(`\n==================== 拆分月份文件 ====================`);
    splitIntoMonthFiles(YEAR_DIR, MONTH_DIR, logs);

    // 7. history.json
    log(`\n==================== 生成 history.json ====================`);
    const historyCount = generateHistory(YEAR_DIR, JSON_DIR, logs);

    // 8. index.json
    log(`\n==================== 生成 index.json ====================`);
    generateIndex(YEAR_DIR, JSON_DIR, logs);

    // 9. 日志展示
    log(`\n===今日数据展示===`);
    log(JSON.stringify(todayFilterData[0] || {}, null, 2));
    log(`===未来数据展示===`);
    log(JSON.stringify(laterFilterData[0] || {}, null, 2));

    // 10. 写入 GITHUB_ENV（供 workflow 后续步骤读取）
    const latestItem = todayFilterData[0] || cleanedData[0] || {};
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
