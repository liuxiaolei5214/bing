#!/usr/bin/env node
// bing_wallpaper.js
// Bing 壁纸 + 百科抓取（GitHub Actions 版）
// 纯 HTTP + 随机 MUID/GUID

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

  // 输出目录（相对仓库根）
  JSON_DIR: path.join(__dirname, '..', 'docs', 'json'),
  FULL_JSON_NAME: "bing_wallpaper.json",
  TODAY_JSON_NAME: "today.json",
  LATER_JSON_NAME: "later.json",
};

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

function dateOffset(dateStr, offset) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

// ===================== 主函数 =====================
(async function main() {
  try {
    ensureDirectoryExists(CONFIG.JSON_DIR);

    writeLog(`==================== 必应壁纸+百科（GitHub Actions 版）启动 ====================`);
    const wallBaseData = await crawlBingWallpaperBase();
    if (!wallBaseData.length) {
      writeLog("❌ 未采集到任何数据，退出");
      process.exit(1);
    }

    const fullJsonOutputPath = path.join(CONFIG.JSON_DIR, CONFIG.FULL_JSON_NAME);

    let oldData = [];
    if (fs.existsSync(fullJsonOutputPath)) {
      try {
        const text = fs.readFileSync(fullJsonOutputPath, "utf8");
        oldData = JSON.parse(text);
      } catch (e) {
        writeLog(`⚠️ 旧JSON损坏，清空历史: ${e.message}`);
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

    // 裁剪
    const limitedData = finalData.slice(0, CONFIG.KEEP_DAYS);
    const cleanedData = cleanBackstageUrl(limitedData);

    fs.writeFileSync(fullJsonOutputPath, JSON.stringify(cleanedData, null, 4), { encoding: "utf8" });
    writeLog(`✅ 全量文件已输出至：${fullJsonOutputPath} (${cleanedData.length} 条)`);

    // today.json
    const beijingNow = getBeijingDate();
    const todayDateStr = formatBeijingDate(beijingNow);
    let todayFilterData = cleanedData.filter(item => item.date === todayDateStr);
    if (todayFilterData.length === 0) {
      writeLog(`⚠️ 未找到今日数据 ${todayDateStr}，使用最新数据`);
      todayFilterData = cleanedData.slice(0, 1);
    }
    const todayJsonOutputPath = path.join(CONFIG.JSON_DIR, CONFIG.TODAY_JSON_NAME);
    fs.writeFileSync(todayJsonOutputPath, JSON.stringify(todayFilterData, null, 4), "utf8");
    writeLog(`✅ today.json 已输出 (${todayFilterData.length} 条)`);

    // later.json
    let laterFilterData = [];
    if (cleanedData.length > 0) {
      laterFilterData = [cleanedData[0]];
    }
    const laterJsonOutputPath = path.join(CONFIG.JSON_DIR, CONFIG.LATER_JSON_NAME);
    fs.writeFileSync(laterJsonOutputPath, JSON.stringify(laterFilterData, null, 4), "utf8");
    writeLog(`✅ later.json 已输出 (${laterFilterData.length} 条)`);

    writeLog(`==================== 全部任务执行完毕 ====================`);
  } catch (globalErr) {
    writeLog(`❌ 脚本全局异常：${globalErr.message}\n${globalErr.stack}`);
    process.exit(1);
  }
})();
