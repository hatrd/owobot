'use strict'

const DEFAULT_TIMEZONE = process.env.MC_TIMEZONE || process.env.TZ || 'Asia/Shanghai'
const FALLBACK_OFFSET = '+08:00'

const WEEKDAY_LABELS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DEFAULT_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DEFAULT_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZoneName: 'shortOffset'
})

const readableFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: DEFAULT_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})

function partsFromFormatter (formatter, date) {
  const map = {}
  for (const part of formatter.formatToParts(date)) {
    if (part.type === 'literal') continue
    map[part.type] = part.value
  }
  return map
}

function normalizeOffset (raw) {
  if (!raw) return FALLBACK_OFFSET
  const match = raw.match(/([+-])(\d{1,2})(?::?(\d{2}))?/)
  if (!match) return FALLBACK_OFFSET
  const [, sign, hourRaw, minuteRaw] = match
  const hour = hourRaw.padStart(2, '0')
  const minute = (minuteRaw || '00').padStart(2, '0')
  return `${sign}${hour}:${minute}`
}

function formatDateTz (date = new Date()) {
  const parts = partsFromFormatter(dateFormatter, date)
  return `${parts.year}-${parts.month}-${parts.day}`
}

function formatDateTimeTz (date = new Date()) {
  const parts = partsFromFormatter(dateTimeFormatter, date)
  const offset = normalizeOffset(parts.timeZoneName)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`
}

function formatReadableDateTime (date = new Date()) {
  return readableFormatter.format(date)
}

function getWeekdayLabel (date = new Date()) {
  try {
    const d = new Date(date)
    if (Number.isNaN(d.getTime())) return ''
    const idx = d.getDay()
    return WEEKDAY_LABELS[idx] || ''
  } catch {
    return ''
  }
}

// Lunar calendar helpers adapted for holiday detection; years 1900-2099 supported.
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0,
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04bd7, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  0x14b63
]

function lunarYearDays (y) {
  let sum = 348
  let info = LUNAR_INFO[y - 1900]
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += (info & i) ? 1 : 0
  return sum + leapDays(y)
}

function leapMonth (y) {
  return LUNAR_INFO[y - 1900] & 0xf
}

function leapDays (y) {
  const lm = leapMonth(y)
  if (!lm) return 0
  return (LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29
}

function monthDays (y, m) {
  return (LUNAR_INFO[y - 1900] & (0x10000 >> m)) ? 30 : 29
}

function solarToLunar (date = new Date()) {
  const baseDate = new Date(1900, 0, 31)
  const target = new Date(date)
  if (Number.isNaN(target.getTime())) return null
  let offset = Math.floor((target - baseDate) / 86400000)
  let year = 1900
  let temp
  while (year < 2100 && offset > 0) {
    temp = lunarYearDays(year)
    offset -= temp
    year++
  }
  if (offset < 0) { offset += temp; year-- }
  const leap = leapMonth(year)
  let isLeap = false
  let month = 1
  while (month <= 12 && offset > 0) {
    temp = (leap > 0 && month === (leap + 1) && !isLeap) ? leapDays(year) : monthDays(year, month)
    if (isLeap) {
      isLeap = false
    } else if (leap > 0 && month === leap + 1) {
      isLeap = true
    }
    offset -= temp
    if (!isLeap) month++
  }
  if (offset < 0) {
    offset += temp
    month--
  }
  const day = offset + 1
  return { year, month, day, isLeap }
}

const SOLAR_HOLIDAYS = {
  '01-01': '元旦',
  '02-14': '情人节',
  '03-08': '妇女节',
  '03-12': '植树节',
  '04-01': '愚人节',
  '05-01': '劳动节',
  '05-04': '青年节',
  '06-01': '儿童节',
  '07-01': '建党节',
  '08-01': '建军节',
  '09-10': '教师节',
  '10-01': '国庆节',
  '10-31': '万圣节',
  '11-11': '光棍节',
  '12-24': '平安夜',
  '12-25': '圣诞节'
}

const LUNAR_HOLIDAYS = {
  '1-1': '春节',
  '1-15': '元宵节',
  '5-5': '端午节',
  '7-7': '七夕节',
  '7-15': '中元节',
  '8-15': '中秋节',
  '9-9': '重阳节',
  '12-8': '腊八节',
  '12-23': '小年(北方)',
  '12-24': '小年(南方)'
}

function detectHolidays (date = new Date()) {
  try {
    const d = new Date(date)
    if (Number.isNaN(d.getTime())) return []
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hits = []
    const solarKey = `${mm}-${dd}`
    if (SOLAR_HOLIDAYS[solarKey]) hits.push(SOLAR_HOLIDAYS[solarKey])
    // Qingming roughly falls on Apr 4-6.
    if (d.getMonth() + 1 === 4 && d.getDate() >= 4 && d.getDate() <= 6) hits.push('清明节')
    const lunar = solarToLunar(d)
    if (lunar) {
      const lunarKey = `${lunar.month}-${lunar.day}`
      if (LUNAR_HOLIDAYS[lunarKey]) hits.push(LUNAR_HOLIDAYS[lunarKey])
      const isLunarYearEnd = lunar.month === 12 && lunar.day === monthDays(lunar.year, 12)
      if (isLunarYearEnd) hits.push('除夕')
    }
    return Array.from(new Set(hits))
  } catch {
    return []
  }
}

function getTimeZone () {
  return DEFAULT_TIMEZONE
}

module.exports = {
  formatDateTz,
  formatDateTimeTz,
  formatReadableDateTime,
  getWeekdayLabel,
  detectHolidays,
  getTimeZone
}
