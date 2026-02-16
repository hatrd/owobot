import test from 'node:test'
import assert from 'node:assert/strict'
import timeUtils from '../bot_impl/time-utils.js'

test('detectHolidays marks Lunar New Year Eve as 除夕', () => {
  const holidays = timeUtils.detectHolidays(new Date('2026-02-16T12:00:00+08:00'))
  assert.ok(holidays.includes('除夕'))
})

test('detectHolidays keeps 春节 on Lunar New Year day', () => {
  const holidays = timeUtils.detectHolidays(new Date('2026-02-17T12:00:00+08:00'))
  assert.ok(holidays.includes('春节'))
  assert.ok(!holidays.includes('除夕'))
})
