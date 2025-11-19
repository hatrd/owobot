'use strict'

const DEFAULT_TIMEZONE = process.env.MC_TIMEZONE || process.env.TZ || 'Asia/Shanghai'
const FALLBACK_OFFSET = '+08:00'

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

function getTimeZone () {
  return DEFAULT_TIMEZONE
}

module.exports = {
  formatDateTz,
  formatDateTimeTz,
  formatReadableDateTime,
  getTimeZone
}

